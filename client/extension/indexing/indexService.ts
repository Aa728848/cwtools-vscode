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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ErrorReporter } from '../ai/errorReporter';
import { matchesExt } from '../fileExtensions';
import { getAllProfiles, getLocalisationDirectoryGlob, getVanillaCacheFileName } from '../gameProfiles';
import { parseLocFile, addEntriesToIndex, removeFileFromIndex, queryLocIndex } from './locParser';
import {
	WorkspaceSymbolSqliteCache,
	getWorkspaceSymbolCachePath,
	type WorkspaceSymbolCachedFile,
	type WorkspaceSymbolFileFact,
} from './workspaceSymbolCache';
import {
	addSymbolsToIndex,
	isWorkspaceSymbolFile,
	parseWorkspaceSymbols,
	populateWorkspaceSymbolReferences,
	queryWorkspaceSymbolIndex,
	sortedWorkspaceSymbolNames,
	type WorkspaceSymbolEntry,
	type WorkspaceSymbolOrigin,
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

export interface IndexServiceOptions {
	extensionPath?: string;
	globalStoragePath?: string;
}

interface VanillaSymbolSource {
	gameId: string;
	root: string;
	cacheFile?: string;
}

// ─── IndexService ────────────────────────────────────────────────────────────

export class IndexService implements vscode.Disposable {
	private _status: IndexStatus = 'idle';
	private _workspaceSymbolStatus: IndexStatus = 'idle';
	private _disposables: vscode.Disposable[] = [];
	private _locIndex: Map<string, LocEntry[]> = new Map();
	private _workspaceSymbolIndex: Map<string, WorkspaceSymbolEntry[]> = new Map();
	private _workspaceSymbolFiles: Map<string, Set<string>> = new Map();
	private _workspaceSymbolFileVersions: Map<string, number> = new Map();
	private _workspaceSymbolFileFacts: Map<string, WorkspaceSymbolFileFact> = new Map();
	private _vanillaSourceFiles: Map<string, Set<string>> = new Map();
	private _sortedWorkspaceSymbolNames: string[] = [];
	private _sortedWorkspaceSymbolNamesDirty = true;
	private _lastWorkspaceSymbolRefreshAt: number | undefined;
	private _workspaceSymbolsIncludeVanilla = false;
	private _workspaceSymbolBuildPromise: Promise<void> | undefined;
	private _vanillaSymbolBuildPromise: Promise<void> | undefined;
	private _workspaceSymbolPhaseReady = false;
	private _vanillaSymbolPhaseReady = false;
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
	private static readonly INDEX_BATCH_SIZE = 12;
	private static readonly UPDATE_BATCH_SIZE = 25;
	/** Evict workspace symbol index after this many ms of inactivity to reclaim memory. */
	private static readonly IDLE_EVICTION_MS = 10 * 60 * 1000; // 10 minutes
	private readonly _locDirectoryGlob = getLocalisationDirectoryGlob();

	constructor(private readonly _options: IndexServiceOptions = {}) {}

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

			// The broad symbol watcher (**/*.{txt,gfx,asset,gui}) is created lazily together
			// with the symbol index (see _ensureSymbolFileWatcher): while the index is not
			// built its events are no-ops anyway, and keeping the workspace-wide watcher
			// alive costs the file-watcher host on every save.

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
	async ensureWorkspaceSymbolsReady(options: { includeVanilla?: boolean; force?: boolean; forceVanilla?: boolean } = {}): Promise<void> {
		const includeVanilla = options.includeVanilla ?? true;
		const force = !!options.force;
		this._ensureSymbolFileWatcher();
		await this._ensureWorkspaceSymbolPhase(force);
		if (includeVanilla) {
			await this._ensureVanillaSymbolPhase(!!options.forceVanilla || force);
		}
	}

	/** Rebuild the shared vanilla symbol cache after a serialized .cwb update. */
	async refreshVanillaSymbols(gameIds?: readonly string[]): Promise<void> {
		this._ensureSymbolFileWatcher();
		await this._ensureWorkspaceSymbolPhase(false);
		await this._ensureVanillaSymbolPhase(true, gameIds);
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
				if (!this._workspaceSymbolPhaseReady) return;
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
		const normalized = IndexService._normalizeFilePath(uri.fsPath);
		const persistRemoval = this._workspaceSymbolFileFacts.get(normalized)?.origin === 'workspace';
		this._removeWorkspaceSymbolFile(uri.fsPath);
		if (persistRemoval) void this._persistWorkspaceSymbolChanges([], [uri.fsPath]);
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
		return queryWorkspaceSymbolIndex(this._workspaceSymbolIndex, query, this._getSortedWorkspaceSymbolNames());
	}

	/** Query symbols and populate references only for the small set of returned files. */
	async queryWorkspaceSymbolsAsync(query: WorkspaceSymbolQuery): Promise<WorkspaceSymbolEntry[]> {
		const entries = queryWorkspaceSymbolIndex(
			this._workspaceSymbolIndex,
			{ ...query, includeReferences: true },
			this._getSortedWorkspaceSymbolNames(),
		).map(entry => ({ ...entry, references: entry.references ? [...entry.references] : undefined }));
		this._touchSymbolQuery();
		if (!query.includeReferences || entries.length === 0) {
			return entries.map(entry => ({ ...entry, references: undefined }));
		}
		const fileContents = new Map<string, string>();
		for (const filePath of Array.from(new Set(entries.map(entry => entry.file))).slice(0, 24)) {
			try {
				const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
				if (raw.byteLength <= IndexService.MAX_SYMBOL_FILE_BYTES) {
					fileContents.set(filePath, Buffer.from(raw).toString('utf8'));
				}
			} catch {
				// A result may disappear between querying and reference loading.
			}
		}
		populateWorkspaceSymbolReferences(entries, fileContents, 20);
		return entries;
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

	private async _indexWorkspaceSymbolFiles(force: boolean): Promise<void> {
		this._removeOrigin('workspace');
		const cache = await this._openWorkspaceSymbolCache();
		let cachedFiles = new Map<string, WorkspaceSymbolFileFact>();
		if (cache) {
			const snapshot = cache.load();
			cachedFiles = snapshot.files;
			this._workspaceSymbolFileFacts = new Map(snapshot.files);
			for (const fact of snapshot.files.values()) {
				this._workspaceSymbolFileVersions.set(IndexService._normalizeFilePath(fact.path), fact.fileVersion);
			}
			this._addWorkspaceSymbolEntries(snapshot.entries);
		}

		const files = await vscode.workspace.findFiles(
			'**/*.{txt,gfx,asset,gui}',
			'**/{node_modules,.git,.cwtools,.cwtools-ai,release,artifacts,dist,coverage,out}/**',
			IndexService.WORKSPACE_SYMBOL_FILE_LIMIT,
		);
		const current = new Map<string, { uri: vscode.Uri; stat: vscode.FileStat }>();
		for (let i = 0; i < files.length; i += IndexService.INDEX_BATCH_SIZE) {
			const batch = files.slice(i, i + IndexService.INDEX_BATCH_SIZE);
			const facts = await Promise.all(batch.map(async uri => {
				try {
					return { uri, stat: await vscode.workspace.fs.stat(uri) };
				} catch {
					return undefined;
				}
			}));
			for (const fact of facts) {
				if (fact) current.set(IndexService._normalizeFilePath(fact.uri.fsPath), fact);
			}
			if (i + IndexService.INDEX_BATCH_SIZE < files.length) await IndexService._yieldToEventLoop();
		}

		const removed = Array.from(cachedFiles.keys()).filter(filePath => !current.has(IndexService._normalizeFilePath(filePath)));
		for (const filePath of removed) this._removeWorkspaceSymbolFile(filePath);
		const changedCandidates = Array.from(current.entries()).filter(([filePath, value]) => {
			const previous = cachedFiles.get(filePath);
			return force || !previous || previous.size !== value.stat.size || Math.floor(previous.mtimeMs) !== Math.floor(value.stat.mtime);
		});
		const changed: WorkspaceSymbolCachedFile[] = [];
		for (let i = 0; i < changedCandidates.length; i += IndexService.INDEX_BATCH_SIZE) {
			const batch = changedCandidates.slice(i, i + IndexService.INDEX_BATCH_SIZE);
			const parsed = await Promise.all(batch.map(async ([filePath, value]) =>
				this._parseWorkspaceSymbolFile(value.uri, value.stat, 'workspace', cachedFiles.get(filePath)?.fileVersion ?? 0)
			));
			for (const file of parsed) {
				if (!file) continue;
				this._replaceWorkspaceSymbolFile(file);
				changed.push(file);
			}
			if (i + IndexService.INDEX_BATCH_SIZE < changedCandidates.length) await IndexService._yieldToEventLoop();
		}
		if (cache) {
			cache.update(changed, removed);
			await cache.save();
			cache.close();
		}
		this._lastWorkspaceSymbolRefreshAt = Date.now();
		ErrorReporter.debug('IndexService', `Workspace symbol phase: ${files.length - changed.length} cached, ${changed.length} parsed, ${removed.length} removed`);
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
		try {
			const filePath = IndexService._normalizeFilePath(uri.fsPath);
			const stat = await vscode.workspace.fs.stat(uri);
			const previousVersion = this._workspaceSymbolFileVersions.get(filePath) ?? 0;
			const parsed = await this._parseWorkspaceSymbolFile(uri, stat, origin, previousVersion);
			if (!parsed) return;
			this._replaceWorkspaceSymbolFile(parsed);
			if (origin === 'workspace') await this._persistWorkspaceSymbolChanges([parsed], []);
			this._lastWorkspaceSymbolRefreshAt = Date.now();
		} catch {
			// File read error - skip
		}
	}

	private async _indexVanillaWorkspaceSymbolFiles(force: boolean, gameIds?: readonly string[]): Promise<void> {
		const requestedGames = gameIds?.length ? new Set(gameIds.map(value => value.toLowerCase())) : undefined;
		const sources = this._getConfiguredVanillaSources().filter(source => !requestedGames || requestedGames.has(source.gameId));
		if (!requestedGames) {
			this._removeOrigin('vanilla');
			this._vanillaSourceFiles.clear();
		}
		for (const source of sources) {
			const sourceKey = IndexService._normalizeFilePath(source.root);
			for (const filePath of this._vanillaSourceFiles.get(sourceKey) ?? []) this._removeWorkspaceSymbolFile(filePath);
			this._vanillaSourceFiles.set(sourceKey, new Set());
			const cache = await this._openVanillaSymbolCache(source);
			let cachedFiles = new Map<string, WorkspaceSymbolFileFact>();
			if (cache) {
				const snapshot = cache.load();
				cachedFiles = snapshot.files;
				this._addWorkspaceSymbolEntries(snapshot.entries);
				const sourceFiles = this._vanillaSourceFiles.get(sourceKey)!;
				for (const fact of snapshot.files.values()) {
					const normalized = IndexService._normalizeFilePath(fact.path);
					sourceFiles.add(normalized);
					this._workspaceSymbolFileVersions.set(normalized, fact.fileVersion);
				}
			}

			const uri = vscode.Uri.file(source.root);
			const pattern = new vscode.RelativePattern(uri, '**/*.{txt,gfx,asset,gui}');
			const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,.cwtools,.cwtools-ai,release,artifacts,dist,coverage,out}/**', IndexService.VANILLA_SYMBOL_FILE_LIMIT);
			const current = new Map<string, { uri: vscode.Uri; stat: vscode.FileStat }>();
			for (let i = 0; i < files.length; i += IndexService.INDEX_BATCH_SIZE) {
				const batch = files.slice(i, i + IndexService.INDEX_BATCH_SIZE);
				const facts = await Promise.all(batch.map(async fileUri => {
					try { return { uri: fileUri, stat: await vscode.workspace.fs.stat(fileUri) }; } catch { return undefined; }
				}));
				for (const fact of facts) if (fact) current.set(IndexService._normalizeFilePath(fact.uri.fsPath), fact);
				if (i + IndexService.INDEX_BATCH_SIZE < files.length) await IndexService._yieldToEventLoop();
			}
			const removed = Array.from(cachedFiles.keys()).filter(filePath => !current.has(IndexService._normalizeFilePath(filePath)));
			for (const filePath of removed) {
				this._removeWorkspaceSymbolFile(filePath);
				this._vanillaSourceFiles.get(sourceKey)!.delete(IndexService._normalizeFilePath(filePath));
			}
			const candidates = Array.from(current.entries()).filter(([filePath, value]) => {
				const previous = cachedFiles.get(filePath);
				return force || !previous || previous.size !== value.stat.size || Math.floor(previous.mtimeMs) !== Math.floor(value.stat.mtime);
			});
			const changed: WorkspaceSymbolCachedFile[] = [];
			for (let i = 0; i < candidates.length; i += IndexService.INDEX_BATCH_SIZE) {
				const batch = candidates.slice(i, i + IndexService.INDEX_BATCH_SIZE);
				const parsed = await Promise.all(batch.map(([filePath, value]) =>
					this._parseWorkspaceSymbolFile(value.uri, value.stat, 'vanilla', cachedFiles.get(filePath)?.fileVersion ?? 0)
				));
				for (const file of parsed) {
					if (!file) continue;
					this._replaceWorkspaceSymbolFile(file);
					this._vanillaSourceFiles.get(sourceKey)!.add(IndexService._normalizeFilePath(file.path));
					changed.push(file);
				}
				if (i + IndexService.INDEX_BATCH_SIZE < candidates.length) await IndexService._yieldToEventLoop();
			}
			if (cache) {
				cache.update(changed, removed);
				await cache.save();
				cache.close();
			}
			ErrorReporter.debug('IndexService', `Vanilla symbol phase (${source.gameId}): ${files.length - changed.length} cached, ${changed.length} parsed, ${removed.length} removed`);
		}
	}

	private _getConfiguredVanillaSources(): VanillaSymbolSource[] {
		const sources: VanillaSymbolSource[] = [];
		const roots = new Set<string>();
		const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
		for (const profile of getAllProfiles()) {
			const key = profile.cacheSettingKey.replace('stellarisLanguageServices.', '');
			const configured = config.get<string>(key);
			if (!configured?.trim()) continue;
			const root = path.resolve(configured.trim());
			const normalized = IndexService._normalizeFilePath(root);
			if (roots.has(normalized)) continue;
			roots.add(normalized);
			const cacheName = getVanillaCacheFileName(profile.id);
			sources.push({
				gameId: profile.id,
				root,
				cacheFile: cacheName && this._options.globalStoragePath
					? path.join(this._options.globalStoragePath, '.cwtools', cacheName)
					: undefined,
			});
		}
		return sources;
	}

	private async _ensureWorkspaceSymbolPhase(force: boolean): Promise<void> {
		if (!force && this._workspaceSymbolPhaseReady) return;
		if (this._workspaceSymbolBuildPromise) await this._workspaceSymbolBuildPromise;
		if (!force && this._workspaceSymbolPhaseReady) return;
		this._workspaceSymbolStatus = 'indexing';
		this._workspaceSymbolBuildPromise = this._indexWorkspaceSymbolFiles(force);
		try {
			await this._workspaceSymbolBuildPromise;
			this._workspaceSymbolPhaseReady = true;
			this._workspaceSymbolStatus = 'ready';
		} catch (e) {
			this._workspaceSymbolStatus = 'error';
			throw e;
		} finally {
			this._workspaceSymbolBuildPromise = undefined;
		}
	}

	private async _ensureVanillaSymbolPhase(force: boolean, gameIds?: readonly string[]): Promise<void> {
		if (!force && this._vanillaSymbolPhaseReady) return;
		if (this._vanillaSymbolBuildPromise) await this._vanillaSymbolBuildPromise;
		if (!force && this._vanillaSymbolPhaseReady) return;
		this._workspaceSymbolStatus = 'indexing';
		this._vanillaSymbolBuildPromise = this._indexVanillaWorkspaceSymbolFiles(force, gameIds);
		try {
			await this._vanillaSymbolBuildPromise;
			if (!gameIds?.length || this._vanillaSymbolPhaseReady) {
				this._vanillaSymbolPhaseReady = true;
				this._workspaceSymbolsIncludeVanilla = true;
			}
			this._lastWorkspaceSymbolRefreshAt = Date.now();
			this._workspaceSymbolStatus = 'ready';
			ErrorReporter.debug('IndexService', `Workspace symbol index ready: ${this._workspaceSymbolIndex.size} names` + (this._workspaceSymbolsIncludeVanilla ? ' (incl. vanilla)' : ''));
		} catch (e) {
			this._workspaceSymbolStatus = this._workspaceSymbolPhaseReady ? 'ready' : 'error';
			throw e;
		} finally {
			this._vanillaSymbolBuildPromise = undefined;
		}
	}

	private async _parseWorkspaceSymbolFile(
		uri: vscode.Uri,
		stat: vscode.FileStat,
		origin: WorkspaceSymbolOrigin,
		previousVersion: number,
	): Promise<WorkspaceSymbolCachedFile | undefined> {
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			const fileVersion = previousVersion + 1;
			const entries = raw.byteLength > IndexService.MAX_SYMBOL_FILE_BYTES
				? []
				: parseWorkspaceSymbols(Buffer.from(raw).toString('utf8'), uri.fsPath, {
					updatedAt: stat.mtime,
					fileVersion,
					origin,
					maxReferencesPerSymbol: 0,
				});
			return {
				path: IndexService._normalizeFilePath(uri.fsPath),
				size: stat.size,
				mtimeMs: stat.mtime,
				origin,
				fileVersion,
				entries,
			};
		} catch {
			return undefined;
		}
	}

	private _replaceWorkspaceSymbolFile(file: WorkspaceSymbolCachedFile): void {
		this._removeWorkspaceSymbolFile(file.path);
		const normalized = IndexService._normalizeFilePath(file.path);
		this._workspaceSymbolFileVersions.set(normalized, file.fileVersion);
		this._workspaceSymbolFileFacts.set(normalized, {
			path: normalized,
			size: file.size,
			mtimeMs: file.mtimeMs,
			origin: file.origin,
			fileVersion: file.fileVersion,
		});
		this._addWorkspaceSymbolEntries(file.entries);
	}

	private _addWorkspaceSymbolEntries(entries: WorkspaceSymbolEntry[]): void {
		addSymbolsToIndex(this._workspaceSymbolIndex, entries);
		for (const entry of entries) {
			const filePath = IndexService._normalizeFilePath(entry.file);
			const names = this._workspaceSymbolFiles.get(filePath) ?? new Set<string>();
			names.add(entry.name.toLowerCase());
			this._workspaceSymbolFiles.set(filePath, names);
		}
		if (entries.length > 0) this._sortedWorkspaceSymbolNamesDirty = true;
	}

	/**
	 * Remove a single file's symbols from the workspace symbol index.
	 */
	private _removeWorkspaceSymbolFile(filePath: string): void {
		const normalized = IndexService._normalizeFilePath(filePath);
		for (const name of this._workspaceSymbolFiles.get(normalized) ?? []) {
			const remaining = (this._workspaceSymbolIndex.get(name) ?? [])
				.filter(entry => IndexService._normalizeFilePath(entry.file) !== normalized);
			if (remaining.length > 0) this._workspaceSymbolIndex.set(name, remaining);
			else this._workspaceSymbolIndex.delete(name);
		}
		this._workspaceSymbolFiles.delete(normalized);
		this._workspaceSymbolFileVersions.delete(normalized);
		this._workspaceSymbolFileFacts.delete(normalized);
		this._sortedWorkspaceSymbolNamesDirty = true;
	}

	private _removeOrigin(origin: WorkspaceSymbolOrigin): void {
		const files = Array.from(this._workspaceSymbolFiles.keys()).filter(filePath => {
			for (const name of this._workspaceSymbolFiles.get(filePath) ?? []) {
				if ((this._workspaceSymbolIndex.get(name) ?? []).some(entry =>
					IndexService._normalizeFilePath(entry.file) === filePath && (entry.origin ?? 'workspace') === origin)) return true;
			}
			return false;
		});
		for (const filePath of files) this._removeWorkspaceSymbolFile(filePath);
	}

	private _getSortedWorkspaceSymbolNames(): readonly string[] {
		if (this._sortedWorkspaceSymbolNamesDirty) {
			this._sortedWorkspaceSymbolNames = sortedWorkspaceSymbolNames(this._workspaceSymbolIndex);
			this._sortedWorkspaceSymbolNamesDirty = false;
		}
		return this._sortedWorkspaceSymbolNames;
	}

	private async _openWorkspaceSymbolCache(): Promise<WorkspaceSymbolSqliteCache | undefined> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot || !this._options.extensionPath) return undefined;
		const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => IndexService._normalizeFilePath(folder.uri.fsPath)).sort();
		const cache = new WorkspaceSymbolSqliteCache(
			getWorkspaceSymbolCachePath(workspaceRoot),
			path.join(this._options.extensionPath, 'node_modules', 'sql.js', 'dist'),
			workspaceRoot,
			IndexService._hashParts(roots),
		);
		await cache.open();
		return cache;
	}

	private async _openVanillaSymbolCache(source: VanillaSymbolSource): Promise<WorkspaceSymbolSqliteCache | undefined> {
		if (!this._options.extensionPath || !this._options.globalStoragePath) return undefined;
		const rootHash = IndexService._hashParts([IndexService._normalizeFilePath(source.root)]).slice(0, 16);
		const cache = new WorkspaceSymbolSqliteCache(
			path.join(this._options.globalStoragePath, 'symbol-index', `vanilla-${source.gameId}-${rootHash}.sqlite`),
			path.join(this._options.extensionPath, 'node_modules', 'sql.js', 'dist'),
			source.root,
			IndexService._pathStatFact(source.cacheFile),
		);
		await cache.open();
		return cache;
	}

	private async _persistWorkspaceSymbolChanges(changed: WorkspaceSymbolCachedFile[], removed: string[]): Promise<void> {
		const cache = await this._openWorkspaceSymbolCache();
		if (!cache) return;
		try {
			cache.update(changed, removed);
			await cache.save();
		} finally {
			cache.close();
		}
	}

	private static _normalizeFilePath(value: string): string {
		return path.resolve(value).replace(/\\/g, '/');
	}

	private static _hashParts(parts: readonly string[]): string {
		return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
	}

	private static _pathStatFact(filePath: string | undefined): string {
		if (!filePath) return 'unconfigured';
		try {
			const stat = fs.statSync(filePath);
			return `${IndexService._normalizeFilePath(filePath)}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
		} catch {
			return `${IndexService._normalizeFilePath(filePath)}:missing`;
		}
	}

	// ─── File watcher handlers ───────────────────────────────────────────

	private _onFileChanged(uri: vscode.Uri): void {
		this._scheduleUpdate(uri);
	}

	private _onFileDeleted(uri: vscode.Uri): void {
		this.removeFile(uri);
	}

	/** Create the broad symbol watcher on demand; lives only while the symbol index does. */
	private _ensureSymbolFileWatcher(): void {
		if (this._symbolFileWatcher) return;
		this._symbolFileWatcher = vscode.workspace.createFileSystemWatcher(
			'**/*.{txt,gfx,asset,gui}'
		);
		this._symbolFileWatcher.onDidChange(uri => this._onFileChanged(uri));
		this._symbolFileWatcher.onDidCreate(uri => this._onFileChanged(uri));
		this._symbolFileWatcher.onDidDelete(uri => this._onFileDeleted(uri));
	}

	private _disposeSymbolFileWatcher(): void {
		this._symbolFileWatcher?.dispose();
		this._symbolFileWatcher = undefined;
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
		this._workspaceSymbolFiles.clear();
		this._workspaceSymbolFileVersions.clear();
		this._workspaceSymbolFileFacts.clear();
		this._vanillaSourceFiles.clear();
		this._sortedWorkspaceSymbolNames = [];
		this._sortedWorkspaceSymbolNamesDirty = true;
		this._workspaceSymbolStatus = 'idle';
		this._workspaceSymbolsIncludeVanilla = false;
		this._workspaceSymbolPhaseReady = false;
		this._vanillaSymbolPhaseReady = false;
		this._disposeSymbolFileWatcher();
		ErrorReporter.debug(
			'IndexService',
			`Evicted ${evictedSymbols} workspace symbols after ${Math.round(idleMs / 1000)}s idle`
		);
	}

	// ─── Disposal ────────────────────────────────────────────────────────

	dispose(): void {
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		if (this._idleEvictionTimer) clearTimeout(this._idleEvictionTimer);
		this._disposeSymbolFileWatcher();
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
		this._locIndex.clear();
		this._workspaceSymbolIndex.clear();
		this._workspaceSymbolFiles.clear();
		this._workspaceSymbolFileVersions.clear();
		this._workspaceSymbolFileFacts.clear();
		this._vanillaSourceFiles.clear();
		this._sortedWorkspaceSymbolNames = [];
		this._sortedWorkspaceSymbolNamesDirty = true;
		this._pendingUpdateUris.clear();
		this._status = 'idle';
		this._workspaceSymbolStatus = 'idle';
		this._workspaceSymbolsIncludeVanilla = false;
		this._workspaceSymbolPhaseReady = false;
		this._vanillaSymbolPhaseReady = false;
		this._workspaceSymbolBuildPromise = undefined;
		this._vanillaSymbolBuildPromise = undefined;
	}
}
