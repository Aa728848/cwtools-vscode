/**
 * IndexService — Workspace Indexing Layer
 *
 * Provides a single, incremental index for workspace and vanilla cache files.
 * The first version indexes:
 *   - workspace file inventory
 *   - localisation keys
 *   - top-level PDXScript symbols and named .gfx/.asset/.gui assets
 *
 * Consumers (AI tools, editor features, previews) should query this service
 * instead of performing their own file scans.
 *
 * Phase 1 of the Incremental Index plan:
 *   - Build the service skeleton with lifecycle management
 *   - Add file watcher infrastructure with debounced updates
 *   - Add localisation key indexing (first consumer)
 *
 * Performance design:
 *   - Localisation index is built on startup (lightweight, powers hovers/definitions).
 *   - Workspace symbol index is built LAZILY — only when an AI tool or consumer calls
 *     ensureWorkspaceSymbolsReady(). This keeps the extension host free for CodeLens,
 *     semantic highlighting, and completions during startup.
 *   - File contents are NOT held in memory after parsing. Runtime indexing captures
 *     lightweight in-block asset references and deliberately skips cross-file scans.
 *   - Index building yields to the event loop between batches to avoid starving
 *     other extension host consumers.
 */

import * as vscode from 'vscode';
import { ErrorReporter } from '../ai/errorReporter';
import { matchesExt } from '../fileExtensions';
import { getAllProfiles, getLocalisationDirectoryGlob } from '../gameProfiles';
import { parseLocFile, addEntriesToIndex, removeFileFromIndex, queryLocIndex } from './locParser';
import {
	addSymbolsToIndex,
	isWorkspaceSymbolFile,
	parseWorkspaceSymbols,
	queryWorkspaceSymbolIndex,
	removeFileFromSymbolIndex,
	type WorkspaceSymbolEntry,
	type WorkspaceSymbolQuery,
} from './workspaceSymbolParser';

// ─── Index status ────────────────────────────────────────────────────────────

export type IndexStatus = 'idle' | 'indexing' | 'ready' | 'error';
export type RefreshReason = 'initial' | 'file-change' | 'manual' | 'rules-sync';

// ─── Query contracts ─────────────────────────────────────────────────────────

export interface LocEntry {
	key: string;
	value: string;
	file: string;
	line: number;
	language: string;
}

export interface LocQuery {
	key?: string;
	language?: string;
	/** If true, key is treated as a prefix match. */
	prefix?: boolean;
	/** If true, key is treated as a case-insensitive substring match. */
	contains?: boolean;
	caseSensitive?: boolean;
	limit?: number;
}

export type { WorkspaceSymbolEntry, WorkspaceSymbolQuery };

// ─── IndexService ────────────────────────────────────────────────────────────

export class IndexService implements vscode.Disposable {
	private _status: IndexStatus = 'idle';
	private _workspaceSymbolStatus: IndexStatus = 'idle';
	private _disposables: vscode.Disposable[] = [];
	private _locIndex: Map<string, LocEntry[]> = new Map();
	private _workspaceSymbolIndex: Map<string, WorkspaceSymbolEntry[]> = new Map();
	private _workspaceSymbolFileVersions: Map<string, number> = new Map();
	private _lastWorkspaceSymbolRefreshAt: number | undefined;
	private _workspaceSymbolsIncludeVanilla = false;
	private _workspaceSymbolBuildPromise: Promise<void> | undefined;
	private _lastSymbolQueryAt = 0;
	private _idleEvictionTimer: ReturnType<typeof setTimeout> | undefined;

	private _fileWatcher: vscode.FileSystemWatcher | undefined;
	private _symbolFileWatcher: vscode.FileSystemWatcher | undefined;
	private _pendingUpdateUris: Map<string, vscode.Uri> = new Map();
	private _locBuildPromise: Promise<void> | undefined;
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private static readonly DEBOUNCE_MS = 300;
	private static readonly WORKSPACE_SYMBOL_FILE_LIMIT = 4000;
	private static readonly VANILLA_SYMBOL_FILE_LIMIT = 1200;
	private static readonly MAX_SYMBOL_FILE_BYTES = 2 * 1024 * 1024;
	/** Number of files to parse between event-loop yields during bulk indexing. */
	private static readonly INDEX_BATCH_SIZE = 40;
	private static readonly UPDATE_BATCH_SIZE = 25;
	/** Evict workspace symbol index after this many ms of inactivity to reclaim memory. */
	private static readonly IDLE_EVICTION_MS = 10 * 60 * 1000; // 10 minutes
	private readonly _locDirectoryGlob = getLocalisationDirectoryGlob();

	/** Current index status. */
	get status(): IndexStatus {
		return this._status;
	}

	/** Current status of the heavier PDX symbol/asset index. */
	get workspaceSymbolStatus(): IndexStatus {
		return this._workspaceSymbolStatus;
	}

	/** Number of indexed localisation keys. */
	get locKeyCount(): number {
		return this._locIndex.size;
	}

	/** Number of indexed workspace symbol names. */
	get workspaceSymbolCount(): number {
		return this._workspaceSymbolIndex.size;
	}

	/** Last successful workspace-symbol refresh/update timestamp. */
	get workspaceSymbolUpdatedAt(): number | undefined {
		return this._lastWorkspaceSymbolRefreshAt;
	}

	/**
	 * Start indexing. Should be called once during extension activation.
	 * Sets up file watchers and performs initial index.
	 */
	async start(): Promise<void> {
		if (this._status === 'indexing' || this._status === 'ready') return;
		this._status = 'indexing';

		try {
			// Set up file watcher for localisation files
			this._fileWatcher = vscode.workspace.createFileSystemWatcher(
				`**/${this._locDirectoryGlob}/**/*.yml`
			);

			this._fileWatcher.onDidChange(uri => this._onFileChanged(uri));
			this._fileWatcher.onDidCreate(uri => this._onFileChanged(uri));
			this._fileWatcher.onDidDelete(uri => this._onFileDeleted(uri));
			this._disposables.push(this._fileWatcher);

			this._symbolFileWatcher = vscode.workspace.createFileSystemWatcher(
				'**/*.{txt,gfx,asset,gui}'
			);
			this._symbolFileWatcher.onDidChange(uri => this._onFileChanged(uri));
			this._symbolFileWatcher.onDidCreate(uri => this._onFileChanged(uri));
			this._symbolFileWatcher.onDidDelete(uri => this._onFileDeleted(uri));
			this._disposables.push(this._symbolFileWatcher);

			// Keep activation lightweight. Localisation powers editor hovers/definitions,
			// while the heavier workspace/vanilla symbol index is built lazily by AI tools.
			this._locBuildPromise = this.refresh('initial');
			await this._locBuildPromise;
			this._locBuildPromise = undefined;
			this._status = 'ready';

			ErrorReporter.debug('IndexService', `Index ready: ${this._locIndex.size} localisation keys`);
		} catch (e) {
			this._locBuildPromise = undefined;
			this._status = 'error';
			ErrorReporter.warn('IndexService', 'Failed to start indexing', e);
		}
	}

	/**
	 * Full refresh of the index.
	 */
	async refresh(reason: RefreshReason): Promise<void> {
		const prevStatus = this._status;
		this._status = 'indexing';

		try {
			await this._indexLocalisationFiles();
			this._status = 'ready';
			ErrorReporter.debug('IndexService', `Refresh (${reason}): ${this._locIndex.size} loc keys`);
		} catch (e) {
			this._status = prevStatus === 'ready' ? 'ready' : 'error';
			ErrorReporter.warn('IndexService', `Refresh (${reason}) failed`, e);
		}
	}

	/**
	 * Build the heavier symbol/asset index only when a consumer needs it.
	 * This keeps VS Code's startup path free for CodeLens, semantic tokens, and completions.
	 */
	async ensureWorkspaceSymbolsReady(options: { includeVanilla?: boolean; force?: boolean } = {}): Promise<void> {
		const includeVanilla = options.includeVanilla ?? true;
		const force = !!options.force;
		if (!force && this._workspaceSymbolStatus === 'ready' && (!includeVanilla || this._workspaceSymbolsIncludeVanilla)) {
			return;
		}

		if (this._workspaceSymbolBuildPromise) {
			await this._workspaceSymbolBuildPromise;
			if (!force && this._workspaceSymbolStatus === 'ready' && (!includeVanilla || this._workspaceSymbolsIncludeVanilla)) {
				return;
			}
		}

		this._workspaceSymbolBuildPromise = this._buildWorkspaceSymbolIndex(includeVanilla);
		try {
			await this._workspaceSymbolBuildPromise;
		} finally {
			this._workspaceSymbolBuildPromise = undefined;
		}
	}

	/**
	 * Incrementally update the index for a single file.
	 */
	async updateFile(uri: vscode.Uri): Promise<void> {
		try {
			const filePath = uri.fsPath;
			if (matchesExt(filePath, '.yml')) {
				await this._indexSingleLocFile(uri);
			} else if (isWorkspaceSymbolFile(filePath)) {
				if (this._workspaceSymbolStatus !== 'ready') return;
				await this._indexSingleWorkspaceSymbolFile(uri);
			}
		} catch (e) {
			ErrorReporter.debug('IndexService', `updateFile failed: ${uri.fsPath}`, e);
		}
	}

	/**
	 * Remove a file from the index.
	 */
	removeFile(uri: vscode.Uri): void {
		removeFileFromIndex(this._locIndex, uri.fsPath);
		this._removeWorkspaceSymbolFile(uri.fsPath);
	}

	/**
	 * Query localisation keys.
	 * Returns results from whatever has been indexed so far (non-blocking).
	 */
	queryLocalisation(query: LocQuery): LocEntry[] {
		return queryLocIndex(this._locIndex, query);
	}

	/**
	 * Query localisation keys, waiting for the index to be ready first.
	 * Use this from definition providers to avoid returning empty results
	 * while the initial index build is still in progress.
	 */
	async queryLocalisationAsync(query: LocQuery): Promise<LocEntry[]> {
		if (this._locBuildPromise) {
			await this._locBuildPromise;
		}
		return queryLocIndex(this._locIndex, query);
	}

	/**
	 * Query indexed PDXScript symbols and named asset/gui entries.
	 */
	queryWorkspaceSymbols(query: WorkspaceSymbolQuery): WorkspaceSymbolEntry[] {
		if (this._workspaceSymbolStatus === 'idle') {
			void this.ensureWorkspaceSymbolsReady({ includeVanilla: query.origin !== 'workspace' });
		}
		this._touchSymbolQuery();
		return queryWorkspaceSymbolIndex(this._workspaceSymbolIndex, query);
	}

	/** Check if a localisation key exists. */
	hasLocKey(key: string): boolean {
		return this._locIndex.has(key);
	}

	// ─── Private indexing methods ────────────────────────────────────────

	private async _indexLocalisationFiles(): Promise<void> {
		this._locIndex.clear();
		const t0 = Date.now();

		const files = await vscode.workspace.findFiles(
			`**/${this._locDirectoryGlob}/**/*.yml`,
			'**/node_modules/**',
			5000
		);

		// Process files in batches with concurrency and event-loop yields
		// to avoid starving other extension host tasks during startup.
		for (let i = 0; i < files.length; i += IndexService.INDEX_BATCH_SIZE) {
			const batch = files.slice(i, i + IndexService.INDEX_BATCH_SIZE);
			await Promise.all(batch.map(async (uri) => {
				try {
					await this._indexSingleLocFile(uri);
				} catch {
					// Skip files that can't be parsed
				}
			}));
			// Yield to the event loop between batches so CodeLens,
			// semantic tokens, and completions are not starved.
			if (i + IndexService.INDEX_BATCH_SIZE < files.length) {
				await IndexService._yieldToEventLoop();
			}
		}

		ErrorReporter.debug(
			'IndexService',
			`Loc index built: ${this._locIndex.size} keys from ${files.length} files in ${Date.now() - t0}ms`
		);
	}

	private async _indexWorkspaceSymbolFiles(): Promise<void> {
		const files = await vscode.workspace.findFiles(
			'**/*.{txt,gfx,asset,gui}',
			'**/node_modules/**',
			IndexService.WORKSPACE_SYMBOL_FILE_LIMIT
		);

		let batchCount = 0;
		for (const uri of files) {
			try {
				await this._indexSingleWorkspaceSymbolFile(uri, 'workspace');
			} catch {
				// Skip files that can't be parsed
			}
			// Yield to the event loop periodically so CodeLens / semantic tokens
			// / completions are not starved while we index.
			if (++batchCount % IndexService.INDEX_BATCH_SIZE === 0) {
				await IndexService._yieldToEventLoop();
			}
		}
		this._lastWorkspaceSymbolRefreshAt = Date.now();
	}

	private async _indexSingleLocFile(uri: vscode.Uri): Promise<void> {
		const filePath = uri.fsPath;

		// Remove existing localisation entries for this file before re-indexing.
		removeFileFromIndex(this._locIndex, filePath);

		try {
			const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			const entries = parseLocFile(content, filePath);
			addEntriesToIndex(this._locIndex, entries);
		} catch {
			// File read error — skip
		}
	}

	private async _indexSingleWorkspaceSymbolFile(
		uri: vscode.Uri,
		origin: 'workspace' | 'vanilla' = 'workspace'
	): Promise<void> {
		const filePath = uri.fsPath;
		const previousVersion = this._workspaceSymbolFileVersions.get(filePath) ?? 0;

		this._removeWorkspaceSymbolFile(filePath);

		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			// Guard against oversized files that would bloat the extension host.
			if (raw.byteLength > IndexService.MAX_SYMBOL_FILE_BYTES) return;

			const content = Buffer.from(raw).toString('utf8');
			const fileVersion = previousVersion + 1;
			this._workspaceSymbolFileVersions.set(filePath, fileVersion);
			const updatedAt = Date.now();

			// Parse symbols with in-file references only (maxReferencesPerSymbol
			// controls single-file self-references; cross-file refs are separate).
			const entries = parseWorkspaceSymbols(content, filePath, {
				updatedAt,
				fileVersion,
				origin,
				maxReferencesPerSymbol: 8,
			});
			addSymbolsToIndex(this._workspaceSymbolIndex, entries);
			this._lastWorkspaceSymbolRefreshAt = updatedAt;
		} catch {
			// File read error - skip
		}
	}

	private async _indexVanillaWorkspaceSymbolFiles(): Promise<void> {
		const roots = this._getConfiguredVanillaRoots();
		let batchCount = 0;
		for (const root of roots) {
			const uri = vscode.Uri.file(root);
			const pattern = new vscode.RelativePattern(uri, '**/*.{txt,gfx,asset,gui}');
			const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,.cwtools}/**', IndexService.VANILLA_SYMBOL_FILE_LIMIT);
			for (const fileUri of files) {
				try {
					await this._indexSingleWorkspaceSymbolFile(fileUri, 'vanilla');
				} catch {
					// Skip unreadable vanilla files.
				}
				if (++batchCount % IndexService.INDEX_BATCH_SIZE === 0) {
					await IndexService._yieldToEventLoop();
				}
			}
		}
	}

	private _getConfiguredVanillaRoots(): string[] {
		const roots = new Set<string>();
		const config = vscode.workspace.getConfiguration('cwtools');
		for (const profile of getAllProfiles()) {
			const key = profile.cacheSettingKey.replace('cwtools.', '');
			const configured = config.get<string>(key);
			if (configured?.trim()) roots.add(configured.trim());
		}
		return Array.from(roots);
	}

	/**
	 * Build the full workspace symbol index. Called lazily by ensureWorkspaceSymbolsReady().
	 * Yields to the event loop between batches to avoid starving CodeLens, semantic tokens,
	 * and completions.
	 */
	private async _buildWorkspaceSymbolIndex(includeVanilla: boolean): Promise<void> {
		this._workspaceSymbolStatus = 'indexing';
		try {
			// Clear previous index
			this._workspaceSymbolIndex.clear();
			this._workspaceSymbolFileVersions.clear();
			this._workspaceSymbolsIncludeVanilla = false;

			await this._indexWorkspaceSymbolFiles();

			if (includeVanilla) {
				await this._indexVanillaWorkspaceSymbolFiles();
			}
			this._workspaceSymbolsIncludeVanilla = includeVanilla;

			// Cross-file reference rebuilding is deliberately skipped. The parser still
			// captures cheap in-block asset references, while avoiding the expensive
			// O(symbols x files) scan that caused editor responsiveness regressions.

			this._workspaceSymbolStatus = 'ready';
			ErrorReporter.debug(
				'IndexService',
				`Workspace symbol index ready: ${this._workspaceSymbolIndex.size} symbols` +
				(includeVanilla ? ' (incl. vanilla)' : '')
			);
		} catch (e) {
			this._workspaceSymbolStatus = 'error';
			ErrorReporter.warn('IndexService', 'Workspace symbol index build failed', e);
		}
	}

	/**
	 * Remove a single file's symbols from the workspace symbol index.
	 */
	private _removeWorkspaceSymbolFile(filePath: string): void {
		removeFileFromSymbolIndex(this._workspaceSymbolIndex, filePath);
		this._workspaceSymbolFileVersions.delete(filePath);
	}

	// ─── File watcher handlers ───────────────────────────────────────────

	private _onFileChanged(uri: vscode.Uri): void {
		this._scheduleUpdate(uri);
	}

	private _onFileDeleted(uri: vscode.Uri): void {
		this.removeFile(uri);
	}

	/**
	 * Batch pending file changes and process them after a debounce window.
	 * Multiple rapid saves/changes to different files are coalesced.
	 */
	private _scheduleUpdate(uri: vscode.Uri): void {
		this._pendingUpdateUris.set(uri.fsPath, uri);
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		this._debounceTimer = setTimeout(() => {
			this._flushPendingUpdates();
		}, IndexService.DEBOUNCE_MS);
	}

	/**
	 * Process all pending file updates in a single batch.
	 */
	private _flushPendingUpdates(): void {
		const pending = new Map(this._pendingUpdateUris);
		this._pendingUpdateUris.clear();

		if (pending.size === 0) return;

		// Process all pending URIs. We don't await here intentionally —
		// the debounce handler is fire-and-forget, and errors are caught
		// inside updateFile.
		const processAll = async () => {
			let count = 0;
			for (const [, uri] of pending) {
				await this.updateFile(uri);
				if (++count % IndexService.UPDATE_BATCH_SIZE === 0) {
					await IndexService._yieldToEventLoop();
				}
			}
		};
		void processAll();
	}

	/**
	 * Yield to the event loop so other extension host tasks (CodeLens,
	 * semantic highlighting, completions) get a chance to run.
	 */
	private static _yieldToEventLoop(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, 0));
	}

	/**
	 * Record that a symbol query just happened and (re-)schedule idle eviction.
	 * After IDLE_EVICTION_MS of silence the symbol index is released to reclaim
	 * memory — the next query will lazily rebuild it.
	 */
	private _touchSymbolQuery(): void {
		this._lastSymbolQueryAt = Date.now();
		if (this._idleEvictionTimer) clearTimeout(this._idleEvictionTimer);
		this._idleEvictionTimer = setTimeout(() => {
			this._evictWorkspaceSymbolsIfIdle();
		}, IndexService.IDLE_EVICTION_MS);
	}

	/**
	 * Release the workspace symbol index if it hasn't been queried recently.
	 * The index will be lazily rebuilt on the next queryWorkspaceSymbols() call.
	 */
	private _evictWorkspaceSymbolsIfIdle(): void {
		if (this._workspaceSymbolStatus !== 'ready') return;
		const idleMs = Date.now() - this._lastSymbolQueryAt;
		if (idleMs < IndexService.IDLE_EVICTION_MS) return;

		const evictedSymbols = this._workspaceSymbolIndex.size;
		this._workspaceSymbolIndex.clear();
		this._workspaceSymbolFileVersions.clear();
		this._workspaceSymbolStatus = 'idle';
		this._workspaceSymbolsIncludeVanilla = false;
		ErrorReporter.debug(
			'IndexService',
			`Evicted ${evictedSymbols} workspace symbols after ${Math.round(idleMs / 1000)}s idle`
		);
	}

	// ─── Disposal ────────────────────────────────────────────────────────

	dispose(): void {
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		if (this._idleEvictionTimer) clearTimeout(this._idleEvictionTimer);
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
		this._locIndex.clear();
		this._workspaceSymbolIndex.clear();
		this._workspaceSymbolFileVersions.clear();
		this._pendingUpdateUris.clear();
		this._status = 'idle';
		this._workspaceSymbolStatus = 'idle';
		this._workspaceSymbolsIncludeVanilla = false;
		this._workspaceSymbolBuildPromise = undefined;
	}
}
