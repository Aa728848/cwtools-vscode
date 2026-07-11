import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { WorkspaceSymbolEntry, WorkspaceSymbolOrigin } from './workspaceSymbolParser';

const SCHEMA_VERSION = 1;
const PARSER_VERSION = 2;
export const WORKSPACE_SYMBOL_CACHE_RELATIVE_PATH = path.join('.cwtools-ai', 'index', 'workspace-symbols.sqlite');

export function getWorkspaceSymbolCachePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, WORKSPACE_SYMBOL_CACHE_RELATIVE_PATH);
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

export class WorkspaceSymbolSqliteCache {
    private database: Database | undefined;

	constructor(
		private readonly databasePath: string,
		private readonly wasmDirectory: string,
		private readonly sourceRoot: string,
		private readonly sourceFingerprint = '',
	) {}

    async open(): Promise<void> {
        if (this.database) return;
        const SQL = await getSql(this.wasmDirectory);
        let bytes: Uint8Array | undefined;
        try {
            bytes = new Uint8Array(await fs.promises.readFile(this.databasePath));
        } catch {
            bytes = undefined;
        }
        try {
            this.database = bytes?.length ? new SQL.Database(bytes) : new SQL.Database();
            this.ensureSchema();
        } catch {
            this.database?.close();
            this.database = new SQL.Database();
            this.ensureSchema(true);
        }
    }

    load(): WorkspaceSymbolCacheSnapshot {
        const database = this.requireDatabase();
        const files = new Map<string, WorkspaceSymbolFileFact>();
        const entries: WorkspaceSymbolEntry[] = [];
        const rows = database.exec(`
            SELECT f.path, f.size, f.mtime_ms, f.origin, f.file_version,
                   s.name, s.kind, s.line, s.source, s.container, s.category,
                   s.updated_at
            FROM files f
            LEFT JOIN symbols s ON s.file_path = f.path
            ORDER BY f.path, s.id
        `);
        const result = rows[0];
        if (!result) return { files, entries };
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
            });
        }
        return { files, entries };
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
                    container, category, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    private ensureSchema(forceReset = false): void {
        const database = this.requireDatabase();
        database.run(`
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
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name_lower);
            CREATE INDEX IF NOT EXISTS idx_symbols_kind_name ON symbols(kind, name_lower);
            CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
        `);
        const expectedRoot = normalizePath(this.sourceRoot);
        const metadata = new Map<string, string>();
        const rows = database.exec('SELECT key, value FROM metadata');
        for (const row of rows[0]?.values ?? []) metadata.set(String(row[0]), String(row[1]));
		const invalid = forceReset
			|| metadata.get('schema_version') !== String(SCHEMA_VERSION)
			|| metadata.get('parser_version') !== String(PARSER_VERSION)
			|| metadata.get('source_root') !== expectedRoot
			|| metadata.get('source_fingerprint') !== this.sourceFingerprint;
		if (invalid) {
            database.run('DELETE FROM symbols; DELETE FROM files; DELETE FROM metadata;');
            const statement = database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
            statement.run(['schema_version', String(SCHEMA_VERSION)]);
			statement.run(['parser_version', String(PARSER_VERSION)]);
			statement.run(['source_root', expectedRoot]);
			statement.run(['source_fingerprint', this.sourceFingerprint]);
            statement.free();
        }
    }

    private requireDatabase(): Database {
        if (!this.database) throw new Error('Workspace symbol SQLite cache is not open.');
        return this.database;
    }
}
