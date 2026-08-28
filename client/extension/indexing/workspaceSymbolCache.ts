import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { getWorkspaceCacheRoot } from '../ai/workspacePaths';
import type { WorkspaceSymbolEntry, WorkspaceSymbolOrigin } from './workspaceSymbolParser';

const SCHEMA_VERSION = 5;
const PARSER_VERSION = 6;

const CURRENT_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files(
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        origin TEXT NOT NULL,
        file_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbols(
        id INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        source TEXT NOT NULL,
        container TEXT,
        category TEXT,
        updated_at REAL NOT NULL,
        gui_facts_json TEXT,
        script_facts_json TEXT,
        references_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name_lower);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind_name ON symbols(kind, name_lower);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
`;
export const WORKSPACE_SYMBOL_CACHE_RELATIVE_PATH = path.join('index', 'workspace-symbols.sqlite');

/** Primary cache location: per-workspace extension storage once configured. */
export function getWorkspaceSymbolCachePath(workspaceRoot: string): string {
    return path.join(getWorkspaceCacheRoot(workspaceRoot), WORKSPACE_SYMBOL_CACHE_RELATIVE_PATH);
}

export interface WorkspaceSymbolFileFact {
    path: string;
    size: number;
    mtimeMs: number;
    origin: WorkspaceSymbolOrigin;
    fileVersion: number;
}

export interface WorkspaceSymbolCachedFile extends WorkspaceSymbolFileFact {
    entries: WorkspaceSymbolEntry[];
}

export interface WorkspaceSymbolCacheSnapshot {
    files: Map<string, WorkspaceSymbolFileFact>;
    entries: WorkspaceSymbolEntry[];
    coverage?: WorkspaceSymbolCacheCoverage;
}

export type WorkspaceSymbolCacheOpenResult = 'created' | 'rebuilt' | 'reused';

export interface WorkspaceSymbolCacheCoverage {
    discoveredFiles: number;
    discoveredFilesExact: boolean;
    selectedFiles: number;
    indexedFiles: number;
    truncated: boolean;
}

let sqlPromise: Promise<SqlJsStatic> | undefined;

function getSql(wasmDirectory: string): Promise<SqlJsStatic> {
    if (!sqlPromise) {
        sqlPromise = initSqlJs({
            locateFile: file => path.join(wasmDirectory, file),
        });
    }
    return sqlPromise;
}

function normalizePath(value: string): string {
    return path.resolve(value).replace(/\\/g, '/');
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseGuiFacts(value: unknown): WorkspaceSymbolEntry['guiFacts'] {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        const record = parsed as Record<string, unknown>;
        const strings = (field: string): string[] => Array.isArray(record[field])
            ? record[field].filter((item): item is string => typeof item === 'string')
            : [];
        const positionRecord = record.position && typeof record.position === 'object' && !Array.isArray(record.position)
            ? record.position as Record<string, unknown>
            : undefined;
        return {
            offCanvas: record.offCanvas === true,
            position: positionRecord ? {
                x: typeof positionRecord.x === 'number' ? positionRecord.x : undefined,
                y: typeof positionRecord.y === 'number' ? positionRecord.y : undefined,
                expression: typeof positionRecord.expression === 'string' ? positionRecord.expression : undefined,
            } : undefined,
            localisationKeys: strings('localisationKeys'),
            customGuiReferences: strings('customGuiReferences'),
            effectReferences: strings('effectReferences'),
            spriteReferences: strings('spriteReferences'),
        };
    } catch {
        return undefined;
    }
}

function parseScriptFacts(value: unknown): WorkspaceSymbolEntry['scriptFacts'] {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        const record = parsed as Record<string, unknown>;
        const strings = (field: string): string[] => Array.isArray(record[field])
            ? record[field].filter((item): item is string => typeof item === 'string').slice(0, 60)
            : [];
        const stateAccesses = Array.isArray(record.stateAccesses)
            ? record.stateAccesses.flatMap(item => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
                const access = item as Record<string, unknown>;
                if (!['read', 'set', 'write', 'clear', 'save'].includes(String(access.operation))
                    || typeof access.subject !== 'string' || typeof access.scope !== 'string'
                    || typeof access.line !== 'number' || !Number.isFinite(access.line)) return [];
                return [{
                    operation: access.operation as 'read' | 'set' | 'write' | 'clear' | 'save',
                    subject: access.subject,
                    scope: access.scope,
                    line: Math.max(1, Math.trunc(access.line)),
                }];
            }).slice(0, 40)
            : [];
        return {
            stateAccesses,
            localisationKeys: strings('localisationKeys'),
            eventReferences: strings('eventReferences'),
            callCandidates: strings('callCandidates'),
        };
    } catch {
        return undefined;
    }
}

function parseReferences(value: unknown): WorkspaceSymbolEntry['references'] {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) return undefined;
        const references = parsed.flatMap(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
            const reference = item as Record<string, unknown>;
            if (typeof reference.file !== 'string' || typeof reference.line !== 'number' || typeof reference.context !== 'string') return [];
            return [{
                file: reference.file,
                line: Math.max(1, Math.trunc(reference.line)),
                context: reference.context.slice(0, 240),
                property: typeof reference.property === 'string' ? reference.property : undefined,
                target: typeof reference.target === 'string' ? reference.target : undefined,
            }];
        }).slice(0, 20);
        return references.length > 0 ? references : undefined;
    } catch {
        return undefined;
    }
}

export class WorkspaceSymbolSqliteCache {
    private database: Database | undefined;

	constructor(
		private readonly databasePath: string,
		private readonly wasmDirectory: string,
		private readonly sourceRoot: string,
		private readonly sourceFingerprint = '',
	) {}

    async open(): Promise<WorkspaceSymbolCacheOpenResult> {
        if (this.database) return 'reused';
        const SQL = await getSql(this.wasmDirectory);
        let bytes: Uint8Array | undefined;
        const sourceExists = fs.existsSync(this.databasePath);
        let rebuilt = false;
        try {
            bytes = new Uint8Array(await fs.promises.readFile(this.databasePath));
        } catch {
            bytes = undefined;
        }
        try {
            this.database = bytes?.length ? new SQL.Database(bytes) : new SQL.Database();
            rebuilt = this.ensureSchema();
        } catch {
            this.database?.close();
            this.database = new SQL.Database();
            rebuilt = this.ensureSchema(true);
        }
        // Persist an empty current-schema database immediately. A process crash
        // before indexing finishes must not leave the obsolete file in place.
        if (rebuilt) {
            await this.save();
        }
        if (!sourceExists) return 'created';
        return rebuilt ? 'rebuilt' : 'reused';
    }

    load(): WorkspaceSymbolCacheSnapshot {
        const database = this.requireDatabase();
        const files = new Map<string, WorkspaceSymbolFileFact>();
        const entries: WorkspaceSymbolEntry[] = [];
        const metadata = new Map<string, string>();
        for (const row of database.exec('SELECT key, value FROM metadata')[0]?.values ?? []) {
            metadata.set(String(row[0]), String(row[1]));
        }
        const coverage = metadata.get('coverage_format') === '1'
            ? {
                discoveredFiles: Number(metadata.get('coverage_discovered_files') ?? 0),
                discoveredFilesExact: metadata.get('coverage_discovered_exact') === 'true',
                selectedFiles: Number(metadata.get('coverage_selected_files') ?? 0),
                indexedFiles: Number(metadata.get('coverage_indexed_files') ?? 0),
                truncated: metadata.get('coverage_truncated') === 'true',
            }
            : undefined;
        const rows = database.exec(`
            SELECT f.path, f.size, f.mtime_ms, f.origin, f.file_version,
                   s.name, s.kind, s.line, s.source, s.container, s.category,
                   s.updated_at, s.gui_facts_json, s.script_facts_json, s.references_json
            FROM files f
            LEFT JOIN symbols s ON s.file_path = f.path
            ORDER BY f.path, s.id
        `);
        const result = rows[0];
        if (!result) return { files, entries, coverage };
        for (const row of result.values) {
            const filePath = String(row[0] ?? '');
            const origin = row[3] === 'vanilla' ? 'vanilla' : 'workspace';
            const fact: WorkspaceSymbolFileFact = {
                path: filePath,
                size: Number(row[1] ?? 0),
                mtimeMs: Number(row[2] ?? 0),
                origin,
                fileVersion: Number(row[4] ?? 1),
            };
            files.set(filePath, fact);
            if (row[5] === null || row[5] === undefined) continue;
            entries.push({
                name: String(row[5]),
                kind: String(row[6] ?? 'symbol'),
                file: filePath,
                line: Number(row[7] ?? 1),
                source: row[8] === 'asset' || row[8] === 'gui' ? row[8] : 'script',
                container: stringValue(row[9]),
                category: stringValue(row[10]),
                origin,
                updatedAt: Number(row[11] ?? fact.mtimeMs),
                fileVersion: fact.fileVersion,
                guiFacts: parseGuiFacts(row[12]),
                scriptFacts: parseScriptFacts(row[13]),
                references: parseReferences(row[14]),
            });
        }
        return { files, entries, coverage };
    }

    setCoverage(coverage: WorkspaceSymbolCacheCoverage): void {
        const database = this.requireDatabase();
        const statement = database.prepare(`
            INSERT INTO metadata(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        try {
            const values: Array<[string, string]> = [
                ['coverage_format', '1'],
                ['coverage_discovered_files', String(coverage.discoveredFiles)],
                ['coverage_discovered_exact', String(coverage.discoveredFilesExact)],
                ['coverage_selected_files', String(coverage.selectedFiles)],
                ['coverage_indexed_files', String(coverage.indexedFiles)],
                ['coverage_truncated', String(coverage.truncated)],
            ];
            for (const value of values) statement.run(value);
        } finally {
            statement.free();
        }
    }

    update(changedFiles: WorkspaceSymbolCachedFile[], removedFiles: string[]): void {
        if (changedFiles.length === 0 && removedFiles.length === 0) return;
        const database = this.requireDatabase();
        database.run('BEGIN IMMEDIATE');
        try {
            const deleteSymbols = database.prepare('DELETE FROM symbols WHERE file_path = ?');
            const deleteFile = database.prepare('DELETE FROM files WHERE path = ?');
            for (const filePath of removedFiles) {
                const normalized = normalizePath(filePath);
                deleteSymbols.run([normalized]);
                deleteFile.run([normalized]);
            }
            deleteSymbols.free();
            deleteFile.free();

            const upsertFile = database.prepare(`
                INSERT INTO files(path, size, mtime_ms, origin, file_version)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    size = excluded.size,
                    mtime_ms = excluded.mtime_ms,
                    origin = excluded.origin,
                    file_version = excluded.file_version
            `);
            const clearSymbols = database.prepare('DELETE FROM symbols WHERE file_path = ?');
            const insertSymbol = database.prepare(`
                INSERT INTO symbols(
                    file_path, name, name_lower, kind, line, source,
                    container, category, updated_at, gui_facts_json, script_facts_json, references_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const changed of changedFiles) {
                const normalized = normalizePath(changed.path);
                upsertFile.run([
                    normalized,
                    changed.size,
                    changed.mtimeMs,
                    changed.origin,
                    changed.fileVersion,
                ]);
                clearSymbols.run([normalized]);
                for (const entry of changed.entries) {
                    insertSymbol.run([
                        normalized,
                        entry.name,
                        entry.name.toLowerCase(),
                        entry.kind,
                        entry.line,
                        entry.source,
                        entry.container ?? null,
                        entry.category ?? null,
                        entry.updatedAt ?? changed.mtimeMs,
                        entry.guiFacts ? JSON.stringify(entry.guiFacts) : null,
                        entry.scriptFacts ? JSON.stringify(entry.scriptFacts) : null,
                        entry.references ? JSON.stringify(entry.references) : null,
                    ]);
                }
            }
            upsertFile.free();
            clearSymbols.free();
            insertSymbol.free();
            database.run('COMMIT');
        } catch (error) {
            database.run('ROLLBACK');
            throw error;
        }
    }

    async save(): Promise<void> {
        const database = this.requireDatabase();
        const bytes = database.export();
        await fs.promises.mkdir(path.dirname(this.databasePath), { recursive: true });
        const temporary = `${this.databasePath}.tmp-${process.pid}-${Date.now()}`;
        await fs.promises.writeFile(temporary, bytes);
        try {
            await fs.promises.rename(temporary, this.databasePath);
        } catch {
            await fs.promises.rm(this.databasePath, { force: true });
            await fs.promises.rename(temporary, this.databasePath);
        }
    }

    close(): void {
        this.database?.close();
        this.database = undefined;
    }

    private ensureSchema(forceReset = false): boolean {
        const database = this.requireDatabase();
        database.run(CURRENT_SCHEMA_SQL);
        const expectedRoot = normalizePath(this.sourceRoot);
        const metadata = new Map<string, string>();
        const rows = database.exec('SELECT key, value FROM metadata');
        for (const row of rows[0]?.values ?? []) metadata.set(String(row[0]), String(row[1]));
		const symbolColumns = new Set(
			(database.exec('PRAGMA table_info(symbols)')[0]?.values ?? [])
				.map(row => String(row[1] ?? '')),
		);
		const invalid = forceReset
			|| metadata.get('schema_version') !== String(SCHEMA_VERSION)
			|| metadata.get('parser_version') !== String(PARSER_VERSION)
			|| metadata.get('source_root') !== expectedRoot
			|| metadata.get('source_fingerprint') !== this.sourceFingerprint
			|| !symbolColumns.has('gui_facts_json')
			|| !symbolColumns.has('script_facts_json')
			|| !symbolColumns.has('references_json');
		if (invalid) {
			// Generated symbol caches have no compatibility path. Replace every
			// non-current layout so later SELECTs never depend on missing columns.
			database.run('DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS metadata;');
			database.run(CURRENT_SCHEMA_SQL);
            const statement = database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
            statement.run(['schema_version', String(SCHEMA_VERSION)]);
			statement.run(['parser_version', String(PARSER_VERSION)]);
			statement.run(['source_root', expectedRoot]);
            statement.run(['source_fingerprint', this.sourceFingerprint]);
            statement.free();
			return true;
        }
		return false;
    }

    private requireDatabase(): Database {
        if (!this.database) throw new Error('Workspace symbol SQLite cache is not open.');
        return this.database;
    }
}
