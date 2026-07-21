/**
 * Initializer resolution for the Static Galaxy preview.
 *
 * Systems in setup_scenarios may reference a `solar_system_initializer`. This
 * index resolves only the initializers the current document actually uses:
 * workspace `solar_system_initializers` files are located once, then parsed
 * lazily until the requested initializer is found. Results and the file list
 * are cached with explicit bounds — no unbounded workspace scans.
 */
import * as vscode from 'vscode';
import { parseSolarSystemFile } from './solarSystemParser';
import { StaticGalaxyInitializerSummary, summarizeInitializer } from './staticGalaxyInitializerSummary';
import { ErrorReporter } from './ai/errorReporter';

const SOURCE = 'StaticGalaxyInitializers';
const MAX_INITIALIZER_FILES = 20;
const MAX_CACHE_ENTRIES = 500;

export class StaticGalaxyInitializerIndex {
    private _filesPromise: Thenable<vscode.Uri[]> | undefined;
    private readonly _parsedFiles = new Set<string>();
    private readonly _parsed = new Map<string, StaticGalaxyInitializerSummary>();
    private readonly _missing = new Set<string>();
    private readonly _pending = new Map<string, Promise<StaticGalaxyInitializerSummary | null>>();

    /** Bounded lazy resolution; null when the initializer is not in the workspace. */
    resolve(name: string): Promise<StaticGalaxyInitializerSummary | null> {
        const cached = this._parsed.get(name);
        if (cached) return Promise.resolve(cached);
        if (this._missing.has(name)) return Promise.resolve(null);
        const pending = this._pending.get(name);
        if (pending) return pending;

        const task = this._resolveUncached(name).finally(() => this._pending.delete(name));
        this._pending.set(name, task);
        return task;
    }

    private async _resolveUncached(name: string): Promise<StaticGalaxyInitializerSummary | null> {
        try {
            const files = await this._initializerFiles();
            for (const file of files) {
                const key = file.toString();
                if (this._parsedFiles.has(key)) continue;
                this._parsedFiles.add(key);
                try {
                    const bytes = await vscode.workspace.fs.readFile(file);
                    const systems = parseSolarSystemFile(Buffer.from(bytes).toString('utf8'));
                    for (const system of systems) {
                        if (this._parsed.size >= MAX_CACHE_ENTRIES) break;
                        this._parsed.set(system.key, summarizeInitializer(system));
                    }
                } catch (err) {
                    ErrorReporter.debug(SOURCE, `Failed to parse initializer file ${file.fsPath}`, err);
                }
                const hit = this._parsed.get(name);
                if (hit) return hit;
            }
            this._missing.add(name);
            return null;
        } catch (err) {
            ErrorReporter.debug(SOURCE, 'Initializer resolution failed', err);
            return null;
        }
    }

    private _initializerFiles(): Thenable<vscode.Uri[]> {
        this._filesPromise ??= vscode.workspace.findFiles(
            '**/solar_system_initializers/**/*.txt',
            '**/node_modules/**',
            MAX_INITIALIZER_FILES,
        );
        return this._filesPromise;
    }
}
