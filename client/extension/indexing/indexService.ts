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
 */

import * as vscode from 'vscode';
import { ErrorReporter } from '../ai/errorReporter';
import { getAllProfiles, getLocalisationDirectoryGlob } from '../gameProfiles';
import { parseLocFile, addEntriesToIndex, removeFileFromIndex, queryLocIndex } from './locParser';
import {
	addSymbolsToIndex,
	isWorkspaceSymbolFile,
	parseWorkspaceSymbols,
	queryWorkspaceSymbolIndex,
	rebuildWorkspaceSymbolReferences,
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
	limit?: number;
}

export type { WorkspaceSymbolEntry, WorkspaceSymbolQuery };

// ─── IndexService ────────────────────────────────────────────────────────────

export class IndexService implements vscode.Disposable {
	private _status: IndexStatus = 'idle';
	private _disposables: vscode.Disposable[] = [];
	private _locIndex: Map<string, LocEntry[]> = new Map();
	private _workspaceSymbolIndex: Map<string, WorkspaceSymbolEntry[]> = new Map();
	private _workspaceSymbolFileContents: Map<string, string> = new Map();
	private _workspaceSymbolFileVersions: Map<string, number> = new Map();
	private _lastWorkspaceSymbolRefreshAt: number | undefined;
	private _fileWatcher: vscode.FileSystemWatcher | undefined;
	private _symbolFileWatcher: vscode.FileSystemWatcher | undefined;
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private static readonly DEBOUNCE_MS = 300;
	private readonly _locDirectoryGlob = getLocalisationDirectoryGlob();

	/** Current index status. */
	get status(): IndexStatus {
		return this._status;
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

			// Perform initial indexing
			await this.refresh('initial');
			this._status = 'ready';

			ErrorReporter.debug('IndexService', `Index ready: ${this._locIndex.size} localisation keys, ${this._workspaceSymbolIndex.size} workspace symbols`);
		} catch (e) {
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
			await this._indexWorkspaceSymbolFiles();
			this._status = 'ready';
			ErrorReporter.debug('IndexService', `Refresh (${reason}): ${this._locIndex.size} loc keys, ${this._workspaceSymbolIndex.size} workspace symbols`);
		} catch (e) {
			this._status = prevStatus === 'ready' ? 'ready' : 'error';
			ErrorReporter.warn('IndexService', `Refresh (${reason}) failed`, e);
		}
	}

	/**
	 * Incrementally update the index for a single file.
	 */
	async updateFile(uri: vscode.Uri): Promise<void> {
		try {
			const filePath = uri.fsPath;
			if (filePath.endsWith('.yml')) {
				await this._indexSingleLocFile(uri);
			} else if (isWorkspaceSymbolFile(filePath)) {
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
		const shouldRebuildReferences = isWorkspaceSymbolFile(uri.fsPath);
		removeFileFromIndex(this._locIndex, uri.fsPath);
		removeFileFromSymbolIndex(this._workspaceSymbolIndex, uri.fsPath);
		this._workspaceSymbolFileContents.delete(uri.fsPath);
		this._workspaceSymbolFileVersions.delete(uri.fsPath);
		if (shouldRebuildReferences) this._rebuildWorkspaceSymbolReferences();
	}

	/**
	 * Query localisation keys.
	 */
	queryLocalisation(query: LocQuery): LocEntry[] {
		return queryLocIndex(this._locIndex, query);
	}

	/**
	 * Query indexed PDXScript symbols and named asset/gui entries.
	 */
	queryWorkspaceSymbols(query: WorkspaceSymbolQuery): WorkspaceSymbolEntry[] {
		return queryWorkspaceSymbolIndex(this._workspaceSymbolIndex, query);
	}

	/** Check if a localisation key exists. */
	hasLocKey(key: string): boolean {
		return this._locIndex.has(key);
	}

	// ─── Private indexing methods ────────────────────────────────────────

	private async _indexLocalisationFiles(): Promise<void> {
		this._locIndex.clear();

		const files = await vscode.workspace.findFiles(
			`**/${this._locDirectoryGlob}/**/*.yml`,
			'**/node_modules/**',
			5000
		);

		for (const uri of files) {
			try {
				await this._indexSingleLocFile(uri);
			} catch {
				// Skip files that can't be parsed
			}
		}
	}

	private async _indexWorkspaceSymbolFiles(): Promise<void> {
		this._workspaceSymbolIndex.clear();
		this._workspaceSymbolFileContents.clear();
		this._workspaceSymbolFileVersions.clear();

		const files = await vscode.workspace.findFiles(
			'**/*.{txt,gfx,asset,gui}',
			'**/node_modules/**',
			10000
		);

		for (const uri of files) {
			try {
				await this._indexSingleWorkspaceSymbolFile(uri, 'workspace', false);
			} catch {
				// Skip files that can't be parsed
			}
		}
		await this._indexVanillaWorkspaceSymbolFiles();
		this._rebuildWorkspaceSymbolReferences();
		this._lastWorkspaceSymbolRefreshAt = Date.now();
	}

	private async _indexSingleLocFile(uri: vscode.Uri): Promise<void> {
		const filePath = uri.fsPath;

		// Remove existing entries for this file before re-indexing
		this.removeFile(uri);

		try {
			const content = (await vscode.workspace.fs.readFile(uri)).toString();
			const entries = parseLocFile(content, filePath);
			addEntriesToIndex(this._locIndex, entries);
		} catch {
			// File read error — skip
		}
	}

	private async _indexSingleWorkspaceSymbolFile(
		uri: vscode.Uri,
		origin: 'workspace' | 'vanilla' = 'workspace',
		rebuildReferences = true
	): Promise<void> {
		const filePath = uri.fsPath;
		const previousVersion = this._workspaceSymbolFileVersions.get(filePath) ?? 0;

		removeFileFromSymbolIndex(this._workspaceSymbolIndex, filePath);
		this._workspaceSymbolFileContents.delete(filePath);
		this._workspaceSymbolFileVersions.delete(filePath);

		try {
			const content = (await vscode.workspace.fs.readFile(uri)).toString();
			const fileVersion = previousVersion + 1;
			this._workspaceSymbolFileVersions.set(filePath, fileVersion);
			this._workspaceSymbolFileContents.set(filePath, content);
			const updatedAt = Date.now();
			const entries = parseWorkspaceSymbols(content, filePath, { updatedAt, fileVersion, origin, maxReferencesPerSymbol: 0 });
			addSymbolsToIndex(this._workspaceSymbolIndex, entries);
			if (rebuildReferences) this._rebuildWorkspaceSymbolReferences();
			this._lastWorkspaceSymbolRefreshAt = updatedAt;
		} catch {
			// File read error - skip
		}
	}

	private async _indexVanillaWorkspaceSymbolFiles(): Promise<void> {
		const roots = this._getConfiguredVanillaRoots();
		for (const root of roots) {
			const uri = vscode.Uri.file(root);
			const pattern = new vscode.RelativePattern(uri, '**/*.{txt,gfx,asset,gui}');
			const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,.cwtools}/**', 3000);
			for (const fileUri of files) {
				try {
					await this._indexSingleWorkspaceSymbolFile(fileUri, 'vanilla', false);
				} catch {
					// Skip unreadable vanilla files.
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

	private _rebuildWorkspaceSymbolReferences(): void {
		rebuildWorkspaceSymbolReferences(this._workspaceSymbolIndex, this._workspaceSymbolFileContents, 20);
	}

	// ─── File watcher handlers ───────────────────────────────────────────

	private _onFileChanged(uri: vscode.Uri): void {
		this._scheduleUpdate(uri);
	}

	private _onFileDeleted(uri: vscode.Uri): void {
		this.removeFile(uri);
	}

	private _scheduleUpdate(uri: vscode.Uri): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		this._debounceTimer = setTimeout(() => {
			void this.updateFile(uri);
		}, IndexService.DEBOUNCE_MS);
	}

	// ─── Disposal ────────────────────────────────────────────────────────

	dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
		this._locIndex.clear();
		this._workspaceSymbolIndex.clear();
		this._workspaceSymbolFileContents.clear();
		this._workspaceSymbolFileVersions.clear();
		this._status = 'idle';
	}
}
