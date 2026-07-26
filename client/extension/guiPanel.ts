/**
 * GUI Preview Panel - manages the webview for GUI visualization.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseGuiFile, buildSpriteIndex, serializePosition, serializeSize, serializeProperty, serializeNewElement, type GuiElement } from './guiParser';
import { decodeDds, decodeTga, type DdsResult } from './ddsDecoder';
import { matchesExt } from './fileExtensions';

// ── WebView message types ──────────────────────────────────────────────────────
type GuiPanelMessage =
    | { command: 'goToLine'; line: number }
    | { command: 'updateProperty'; line: number; property: string; value: unknown; propertyLine?: number }
    | { command: 'addElement'; parentEndLine: number; type: string; name: string; x: number; y: number; w: number; h: number }
    | { command: 'duplicateElement'; startLine: number; endLine: number; newName: string }
    | { command: 'removePropertyLine'; line: number; property: string }
    | { command: 'addBackground'; parentEndLine: number; sprite?: string }
    | { command: 'reparentElement'; startLine: number; endLine: number; newParentEndLine: number; positionAdjust?: { dx: number; dy: number } }
    | { command: 'unparentElement'; startLine: number; endLine: number; parentEndLine: number; positionAdjust?: { dx: number; dy: number } }
    | { command: 'vscodeUndo' }
    | { command: 'saveDocument' };

export class GuiPanel {
    public static currentPanel: GuiPanel | undefined;
    private static readonly viewType = 'cwtools-gui-preview';
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _webviewRootPath: string;
    private _textureCache: Map<string, DdsResult | null> = new Map();
    private _textureCacheBytes = 0;
    private static readonly MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50 MB limit
    private _document: vscode.TextDocument | undefined;
    private _searchRoots: string[] = [];
    private _skipNextReload = false;   // skip reload after programmatic edit
    private _contentSnapshots: string[] = [];  // content snapshots for structural undo
    private _lastSnapshotTime = 0;  // debounce: only save one snapshot per 500ms batch
    private static readonly MAX_SNAPSHOTS = 20;
    private _saveSnapshot(doc: vscode.TextDocument) {
        const now = Date.now();
        if (now - this._lastSnapshotTime < 500) return;
        this._lastSnapshotTime = now;
        this._contentSnapshots.push(doc.getText());
        if (this._contentSnapshots.length > GuiPanel.MAX_SNAPSHOTS) {
            this._contentSnapshots.shift();
        }
    }
    private _messageQueue: Promise<void> = Promise.resolve();  // serialize draft edits and explicit saves
    private _queueOperation(operation: () => Promise<void>): void {
        this._messageQueue = this._messageQueue
            .then(operation, operation)
            .catch(error => {
                const detail = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`${panelText('GUI edit failed', 'GUI 编辑失败')}: ${detail}`);
            });
    }
    private _spriteIndexCache: Map<string, import('./guiParser').SpriteInfo> | null = null;
    private _effectNamesCache: string[] | null = null;

    public static async create(extensionPath: string, document: vscode.TextDocument) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (GuiPanel.currentPanel) GuiPanel.currentPanel.dispose();

        const panel = new GuiPanel(extensionPath, column || vscode.ViewColumn.Beside, document);
        GuiPanel.currentPanel = panel;
        await panel._loadAndRender(document);
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, document: vscode.TextDocument) {
        this._webviewRootPath = path.join(extensionPath, 'bin/client/webview');
        this._document = document;

        // Build resource roots: webview assets + all workspace folders
        const localResourceRoots: vscode.Uri[] = [vscode.Uri.file(this._webviewRootPath)];
        for (const wf of vscode.workspace.workspaceFolders ?? []) {
            localResourceRoots.push(wf.uri);
        }
        // Add parent directory of the document (in case file is outside workspace)
        const docDir = path.dirname(document.uri.fsPath);
        const modRoot = this._findModRoot(docDir);
        if (modRoot) localResourceRoots.push(vscode.Uri.file(modRoot));

        // Add Stellaris game directory as resource root for vanilla textures
        const gamePath = this._getGamePath();
        if (gamePath) localResourceRoots.push(vscode.Uri.file(gamePath));

        this._panel = vscode.window.createWebviewPanel(
            GuiPanel.viewType,
            `GUI: ${path.basename(document.fileName)}`,
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots },
        );

        this._panel.webview.html = this._getHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(async (msg: GuiPanelMessage) => {
                if (!msg?.command) return;
                switch (msg.command) {
                    case 'goToLine': {
                        const ed = await vscode.window.showTextDocument(document.uri, { viewColumn: vscode.ViewColumn.One });
                        const range = new vscode.Range(msg.line - 1, 0, msg.line - 1, 0);
                        ed.selection = new vscode.Selection(range.start, range.start);
                        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        break;
                    }
                    case 'updateProperty':
                        this._queueOperation(() => this._handleUpdateProperty(msg));
                        break;
                    case 'addElement':
                        this._queueOperation(() => this._handleAddElement(msg));
                        break;
                    case 'duplicateElement':
                        this._queueOperation(() => this._handleDuplicateElement(msg));
                        break;
                    case 'removePropertyLine':
                        this._queueOperation(() => this._handleRemovePropertyLine(msg));
                        break;
                    case 'addBackground':
                        this._queueOperation(() => this._handleAddBackground(msg));
                        break;
                    case 'reparentElement':
                        this._queueOperation(() => this._handleReparentElement(msg));
                        break;
                    case 'unparentElement':
                        this._queueOperation(() => this._handleUnparentElement(msg));
                        break;
                    case 'vscodeUndo':
                        this._queueOperation(() => this._handleVscodeUndo());
                        break;
                    case 'saveDocument':
                        this._queueOperation(() => this._handleSaveDocument());
                        break;
                }
            }, null, this._disposables),
        );

        // Draft edits update the TextDocument buffer but remain off disk until an
        // explicit save. Keep the Webview's save affordance in sync with VS Code.
        this._disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.uri.fsPath === document.uri.fsPath) {
                    this._postDocumentState();
                }
            }),
        );

        // Watch for document saves to auto-refresh preview
        this._disposables.push(
            vscode.workspace.onDidSaveTextDocument(async savedDoc => {
                if (savedDoc.uri.fsPath === document.uri.fsPath) {
                    if (this._skipNextReload) {
                        this._skipNextReload = false;
                        this._postDocumentState(false, true);
                        return;
                    }
                    this._textureCache.clear();
                    this._textureCacheBytes = 0;
                    await this._loadAndRender(savedDoc);
                    this._postDocumentState(false, true);
                }
            }),
        );

        // Watch .gfx files for sprite index invalidation — incremental by directory
        const gfxWatcher = vscode.workspace.createFileSystemWatcher('**/*.gfx');
        const invalidateSpriteCache = (uri: vscode.Uri) => {
            if (!this._spriteIndexCache) return;
            const dir = path.dirname(uri.fsPath);
            for (const key of this._spriteIndexCache.keys()) {
                if (key.startsWith(dir)) this._spriteIndexCache.delete(key);
            }
        };
        gfxWatcher.onDidChange(invalidateSpriteCache);
        gfxWatcher.onDidCreate(invalidateSpriteCache);
        gfxWatcher.onDidDelete(invalidateSpriteCache);
        this._disposables.push(gfxWatcher);
    }

    /**
     * Get Stellaris game installation path from the plugin's existing configuration.
     * Uses `stellarisLanguageServices.cache.stellaris` which is set by the user via the "Select vanilla folder" prompt.
     */
    private _getGamePath(): string | null {
        const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
        const configPath = config.get<string>('cache.stellaris');
        if (configPath && fs.existsSync(configPath)) return configPath;
        return null;
    }

    /**
     * Find the mod root directory by looking for common markers (descriptor.mod, common/, interface/)
     */
    private _findModRoot(dir: string): string | null {
        let current = dir;
        for (let i = 0; i < 5; i++) {
            if (fs.existsSync(path.join(current, 'descriptor.mod')) ||
                fs.existsSync(path.join(current, 'common')) ||
                (fs.existsSync(path.join(current, 'interface')) && fs.existsSync(path.join(current, 'gfx')))) {
                return current;
            }
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return dir; // fallback to document directory
    }

    private async _loadAndRender(document: vscode.TextDocument) {
        const content = document.getText();
        const docDir = path.dirname(document.uri.fsPath);
        const modRoot = this._findModRoot(docDir);

        // Collect all search roots (mod root + workspace folders + game path)
        const searchRoots: string[] = [];
        if (modRoot) searchRoots.push(modRoot);
        for (const wf of vscode.workspace.workspaceFolders ?? []) {
            if (!searchRoots.includes(wf.uri.fsPath)) searchRoots.push(wf.uri.fsPath);
        }
        // Add Stellaris vanilla game path as fallback for GFX and textures
        const gamePath = this._getGamePath();
        if (gamePath && !searchRoots.includes(gamePath)) searchRoots.push(gamePath);

        this._searchRoots = searchRoots;

        // Build sprite index from .gfx files (cached)
        if (!this._spriteIndexCache) {
            this._spriteIndexCache = await this._buildSpriteIndex(searchRoots);
        }
        const spriteIndex = this._spriteIndexCache;

        // Parse the GUI file
        const elements = parseGuiFile(content, spriteIndex);

        // Resolve texture URIs for webview display
        const resolved = this._resolveTextures(elements, searchRoots);

        // Collect sprite names for the webview dropdown
        const spriteNames = Array.from(spriteIndex.keys()).sort();

        // Collect button effect names (cached)
        if (!this._effectNamesCache) {
            this._effectNamesCache = await this._collectButtonEffects(searchRoots);
        }
        const effectNames = this._effectNamesCache;

        this._panel.webview.postMessage({
            command: 'render',
            data: resolved,
            fileName: path.basename(document.fileName),
            spriteNames,
            effectNames,
            dirty: document.isDirty,
        });
    }

    private _postDocumentState(saving = false, saved = false): void {
        this._panel.webview.postMessage({
            command: 'documentState',
            dirty: this._document?.isDirty ?? false,
            saving,
            saved,
        });
    }

    private async _buildSpriteIndex(searchRoots: string[]): Promise<Map<string, import('./guiParser').SpriteInfo>> {
        const gfxContents: Array<{ path: string; content: string }> = [];
        const maxGfxFiles = 500;

        for (const root of searchRoots) {
            if (gfxContents.length >= maxGfxFiles) break;
            const searchDirs = [
                path.join(root, 'interface'),
                path.join(root, 'gfx'),
            ];

            for (const dir of searchDirs) {
                if (gfxContents.length >= maxGfxFiles) break;
                try { await fs.promises.access(dir); } catch { continue; }
                await this._findGfxFiles(dir, gfxContents, maxGfxFiles);
            }
        }

        return buildSpriteIndex(gfxContents);
    }

    private async _findGfxFiles(dir: string, result: Array<{ path: string; content: string }>, maxFiles: number) {
        try {
            if (result.length >= maxFiles) return;
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            await Promise.all(entries.map(async (entry) => {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await this._findGfxFiles(full, result, maxFiles);
                } else if (matchesExt(entry.name, '.gfx')) {
                    try {
                        const content = await fs.promises.readFile(full, 'utf-8');
                        result.push({ path: full, content });
                    } catch { /* skip unreadable */ }
                }
            }));
        } catch { /* skip inaccessible dirs */ }
    }

    /**
     * Collect button effect names from common/button_effects/*.txt in all search roots.
     * Extracts top-level keys (e.g. `my_effect = { ... }`) from these files.
     */
    private async _collectButtonEffects(searchRoots: string[]): Promise<string[]> {
        const names = new Set<string>();
        for (const root of searchRoots) {
            const dir = path.join(root, 'common', 'button_effects');
            try {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                await Promise.all(entries.map(async (entry) => {
                    if (!entry.isFile() || !matchesExt(entry.name, '.txt')) return;
                    try {
                        const content = await fs.promises.readFile(path.join(dir, entry.name), 'utf-8');
                        // Match only top-level keys: no leading whitespace
                        const regex = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*\{/gm;
                        let m;
                        while ((m = regex.exec(content)) !== null) {
                             
                            names.add(m[1]!);
                        }
                    } catch { /* skip unreadable */ }
                }));
            } catch { /* skip inaccessible dir */ }
        }
        return Array.from(names).sort();
    }

    /**
     * Resolve sprite texture paths to webview-accessible URIs.
     * Searches for .dds → .png fallback, and converts to webview URIs.
     */
    private _resolveTextures(elements: GuiElement[], searchRoots: string[]): GuiElement[] {
        const resolve = (el: GuiElement): GuiElement => {
            let textureUri: string | undefined;
            let texW: number | undefined;
            let texH: number | undefined;

            if (el.spriteTexture) {
                const relPath = el.spriteTexture.replace(/\//g, path.sep);

                for (const root of searchRoots) {
                    const fullDds = path.join(root, relPath);
                    const fullPng = fullDds.replace(/\.dds$/i, '.png');
                    const fullTga = fullDds.replace(/\.dds$/i, '.tga');

                    if (fs.existsSync(fullPng)) {
                        textureUri = this._panel.webview.asWebviewUri(vscode.Uri.file(fullPng)).toString();
                        break;
                    }

                    if (fs.existsSync(fullDds)) {
                        let result: DdsResult | null;
                        if (this._textureCache.has(fullDds)) {
                            result = this._textureCache.get(fullDds) ?? null;
                        } else {
                            result = decodeDds(fullDds);
                            const entrySize = result?.dataUri?.length ?? 0;
                            // Evict oldest entries if cache is too large
                            while (this._textureCacheBytes + entrySize > GuiPanel.MAX_CACHE_BYTES && this._textureCache.size > 0) {
                                const oldestKey = this._textureCache.keys().next().value;
                                if (oldestKey) {
                                    const old = this._textureCache.get(oldestKey);
                                    this._textureCacheBytes -= old?.dataUri?.length ?? 0;
                                    this._textureCache.delete(oldestKey);
                                }
                            }
                            this._textureCache.set(fullDds, result);
                            this._textureCacheBytes += entrySize;
                        }
                        if (result) {
                            textureUri = result.dataUri;
                            texW = result.width;
                            texH = result.height;
                        } else {
                            textureUri = `dds:${el.spriteTexture}`;
                        }
                        break;
                    }

                    // Try .tga
                    if (fs.existsSync(fullTga)) {
                        let result: DdsResult | null;
                        if (this._textureCache.has(fullTga)) {
                            result = this._textureCache.get(fullTga) ?? null;
                        } else {
                            result = decodeTga(fullTga);
                            const entrySize = result?.dataUri?.length ?? 0;
                            while (this._textureCacheBytes + entrySize > GuiPanel.MAX_CACHE_BYTES && this._textureCache.size > 0) {
                                const oldestKey = this._textureCache.keys().next().value;
                                if (oldestKey) {
                                    const old = this._textureCache.get(oldestKey);
                                    this._textureCacheBytes -= old?.dataUri?.length ?? 0;
                                    this._textureCache.delete(oldestKey);
                                }
                            }
                            this._textureCache.set(fullTga, result);
                            this._textureCacheBytes += entrySize;
                        }
                        if (result) {
                            textureUri = result.dataUri;
                            texW = result.width;
                            texH = result.height;
                        } else {
                            textureUri = `tga:${el.spriteTexture}`;
                        }
                        break;
                    }
                }
            }

            return {
                ...el,
                spriteTexture: textureUri ?? el.spriteTexture,
                textureWidth: texW ?? el.textureWidth,
                textureHeight: texH ?? el.textureHeight,
                children: el.children.map(resolve),
            };
        };
        return elements.map(resolve);
    }

    public dispose() {
        GuiPanel.currentPanel = undefined;
        // Release texture cache memory
        this._textureCache.clear();
        this._textureCacheBytes = 0;
        this._document = undefined;
        this._searchRoots = [];
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    // ── Visual Editor: Draft Buffer Editing ────────────────────────────────

    private async _handleSaveDocument(): Promise<void> {
        const doc = this._document;
        if (!doc) return;
        if (!doc.isDirty) {
            this._postDocumentState(false, true);
            return;
        }

        this._postDocumentState(true);
        this._skipNextReload = true;
        const saved = await doc.save();
        if (!saved) {
            this._skipNextReload = false;
            void vscode.window.showErrorMessage(panelText(
                'Unable to save the GUI document.',
                '无法保存 GUI 文档。',
            ));
        }
        this._postDocumentState(false, saved);
    }

    /**
     * Apply a line-level edit to the source file.
     * Replaces the entire content of a line with new content.
     */
    private async _editLine(lineNumber: number, newContent: string) {
        if (!this._document) return;
        const doc = this._document;
        const line = doc.lineAt(lineNumber - 1); // 1-indexed → 0-indexed
        const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, line.range, `${indent}${newContent.trimStart()}`);
        await vscode.workspace.applyEdit(edit);
    }

    /**
     * Replace a range of lines (1-indexed, inclusive) with new content.
     */
    private async _editLines(startLine: number, endLine: number, newContent: string) {
        if (!this._document) return;
        const doc = this._document;
        const range = new vscode.Range(
            new vscode.Position(startLine - 1, 0),
            new vscode.Position(endLine - 1, doc.lineAt(endLine - 1).text.length),
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, range, newContent);
        await vscode.workspace.applyEdit(edit);
    }

    /**
     * Insert content after a line (1-indexed).
     */
    private async _insertAfterLine(lineNumber: number, content: string) {
        if (!this._document) return;
        const doc = this._document;
        const line = doc.lineAt(lineNumber - 1);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(line.range.end.line, line.range.end.character), '\n' + content);
        await vscode.workspace.applyEdit(edit);
    }

    /**
     * Handle updateProperty message from webview.
     * msg: { command, line, property, value, propertyLine? }
     * If propertyLine is provided, replace that line.
     * If propertyLine is missing/undefined, INSERT the property after the element's opening line (msg.line).
     */
    private async _handleUpdateProperty(msg: { line: number; property: string; value: unknown; propertyLine?: number }) {
        if (!this._document) return;
        const doc = this._document;

        // Save snapshot for undo (debounce: only save if last snapshot was >500ms ago)
        const now = Date.now();
        if (now - this._lastSnapshotTime > 500) {
            this._saveSnapshot(doc);
            this._lastSnapshotTime = now;
        }

        const propLine = msg.propertyLine ?? msg.line;
        const hasOwnLine = propLine !== msg.line;

        if (msg.property === 'position') {
            const val = msg.value as { x: number; y: number };
            if (hasOwnLine) {
                const line = doc.lineAt(propLine - 1);
                const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                const newText = `${indent}${serializePosition(val.x, val.y)}`;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, line.range, newText);
                await vscode.workspace.applyEdit(edit);
            } else {
                // Check if position exists inline on the same line
                const line = doc.lineAt(msg.line - 1);
                const posRegex = /position\s*=\s*\{[^}]*\}/;
                if (posRegex.test(line.text)) {
                    const newText = line.text.replace(posRegex, `position = { x = ${val.x} y = ${val.y} }`);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(doc.uri, line.range, newText);
                    await vscode.workspace.applyEdit(edit);
                } else {
                    // Scan forward for existing position on nearby lines
                    const posRegexScan = /position\s*=\s*\{[^}]*\}/;
                    let foundLine = -1;
                    for (let i = msg.line; i < Math.min(msg.line + 20, doc.lineCount); i++) {
                        if (posRegexScan.test(doc.lineAt(i).text)) { foundLine = i; break; }
                        if (doc.lineAt(i).text.trim() === '}') break;
                    }
                    if (foundLine >= 0) {
                        const existingLine = doc.lineAt(foundLine);
                        const newText = existingLine.text.replace(posRegexScan, `position = { x = ${val.x} y = ${val.y} }`);
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(doc.uri, existingLine.range, newText);
                        await vscode.workspace.applyEdit(edit);
                    } else {
                        const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                        const childIndent = indent + '\t';
                        await this._insertAfterLine(msg.line, `${childIndent}${serializePosition(val.x, val.y)}`);
                        await this._loadAndRender(doc);
                    }
                }
            }
        } else if (msg.property === 'size') {
            const val = msg.value as { width: number; height: number; useXY?: boolean };
            if (hasOwnLine) {
                const line = doc.lineAt(propLine - 1);
                const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                const newText = `${indent}${serializeSize(val.width, val.height, val.useXY)}`;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, line.range, newText);
                await vscode.workspace.applyEdit(edit);
            } else {
                const line = doc.lineAt(msg.line - 1);
                const sizeRegex = /size\s*=\s*\{\s*(?:x\s*=\s*-?\d+\s+y\s*=\s*-?\d+|width\s*=\s*-?\d+\s+height\s*=\s*-?\d+)\s*\}/;
                if (sizeRegex.test(line.text)) {
                    const newText = line.text.replace(sizeRegex, (match) => {
                        const isXY = match.includes('x') && !match.includes('width');
                        return `size = { ${isXY ? 'x' : 'width'} = ${Math.round(val.width)} ${isXY ? 'y' : 'height'} = ${Math.round(val.height)} }`;
                    });
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(doc.uri, line.range, newText);
                    await vscode.workspace.applyEdit(edit);
                } else {
                    // Scan forward for existing size on nearby lines
                    const sizeRegexScan = /size\s*=\s*\{\s*(?:x\s*=\s*-?\d+\s+y\s*=\s*-?\d+|width\s*=\s*-?\d+\s+height\s*=\s*-?\d+)\s*\}/;
                    let foundLine = -1;
                    for (let i = msg.line; i < Math.min(msg.line + 20, doc.lineCount); i++) {
                        if (sizeRegexScan.test(doc.lineAt(i).text)) { foundLine = i; break; }
                        if (doc.lineAt(i).text.trim() === '}') break;
                    }
                    if (foundLine >= 0) {
                        const existingLine = doc.lineAt(foundLine);
                        const newText = existingLine.text.replace(sizeRegexScan, (match) => {
                            const isXY = match.includes('x') && !match.includes('width');
                            return `size = { ${isXY ? 'x' : 'width'} = ${Math.round(val.width)} ${isXY ? 'y' : 'height'} = ${Math.round(val.height)} }`;
                        });
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(doc.uri, existingLine.range, newText);
                        await vscode.workspace.applyEdit(edit);
                    } else {
                        const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                        const childIndent = indent + '\t';
                        await this._insertAfterLine(msg.line, `${childIndent}${serializeSize(val.width, val.height, val.useXY)}`);
                        await this._loadAndRender(doc);
                    }
                }
            }
        } else {
            // Generic property (frame, name, spriteType, etc.)
            const isSpriteChange = msg.property === 'spriteType' || msg.property === 'quadTextureSprite';
            if (hasOwnLine) {
                const line = doc.lineAt(propLine - 1);
                const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                const newText = `${indent}${serializeProperty(msg.property, msg.value)}`;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, line.range, newText);
                await vscode.workspace.applyEdit(edit);
                // Sprite changes need full re-render to resolve new texture
                if (isSpriteChange) {
                    this._textureCache.clear();
                    this._textureCacheBytes = 0;
                    await this._loadAndRender(doc);
                }
            } else {
                // Check if property exists inline on the element's line
                const line = doc.lineAt(msg.line - 1);
                const propVal = String(msg.value);
                // Match property = value patterns (quoted or unquoted)
                const inlineRegex = new RegExp(`(${msg.property}\\s*=\\s*)(?:"[^"]*"|\\S+)`);
                if (inlineRegex.test(line.text)) {
                    const serializedVal = typeof msg.value === 'number'
                        ? (Number.isInteger(msg.value) ? String(msg.value) : (msg.value as number).toFixed(3))
                        : (/\s/.test(propVal) || propVal.length === 0 ? `"${propVal}"` : propVal);
                    const newText = line.text.replace(inlineRegex, `$1${serializedVal}`);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(doc.uri, line.range, newText);
                    await vscode.workspace.applyEdit(edit);
                    if (isSpriteChange) {
                        this._textureCache.clear();
                        this._textureCacheBytes = 0;
                        await this._loadAndRender(doc);
                    }
                } else {
                    // Scan forward from element line to find existing property on nearby lines
                    const propRegex = new RegExp(`(${msg.property}\\s*=\\s*)(?:"[^"]*"|\\S+)`);
                    let foundLine = -1;
                    for (let i = msg.line; i < Math.min(msg.line + 20, doc.lineCount); i++) {
                        const scanLine = doc.lineAt(i);
                        if (propRegex.test(scanLine.text)) {
                            foundLine = i;
                            break;
                        }
                        // Stop at closing brace (end of element block)
                        if (scanLine.text.trim() === '}') break;
                    }
                    if (foundLine >= 0) {
                        // Property exists on a nearby line — replace it
                        const existingLine = doc.lineAt(foundLine);
                        const serializedVal = typeof msg.value === 'number'
                            ? (Number.isInteger(msg.value) ? String(msg.value) : (msg.value as number).toFixed(3))
                            : (/\s/.test(String(msg.value)) || String(msg.value).length === 0 ? `"${msg.value}"` : String(msg.value));
                        const newText = existingLine.text.replace(propRegex, `$1${serializedVal}`);
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(doc.uri, existingLine.range, newText);
                        await vscode.workspace.applyEdit(edit);
                        if (isSpriteChange) {
                            this._textureCache.clear();
                            this._textureCacheBytes = 0;
                            await this._loadAndRender(doc);
                        }
                    } else {
                        // Property truly doesn't exist — insert it
                        const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                        const childIndent = indent + '\t';
                        await this._insertAfterLine(msg.line, `${childIndent}${serializeProperty(msg.property, msg.value)}`);
                        await this._loadAndRender(doc);
                    }
                }
            }
        }
    }

    /**
     * Handle removePropertyLine message from webview.
     * Deletes a property line from the source file (used by undo when property didn't originally exist).
     * msg: { command, line, property, propertyLine }
     */
    private async _handleRemovePropertyLine(msg: { line: number; property: string; propertyLine?: number }) {
        if (!this._document || !msg.propertyLine) return;
        const doc = this._document;
        const edit = new vscode.WorkspaceEdit();
        // Delete the entire line (including trailing newline)
        const lineIdx = msg.propertyLine - 1;
        if (lineIdx < 0 || lineIdx >= doc.lineCount) return;
        const startPos = lineIdx > 0
            ? new vscode.Position(lineIdx - 1, doc.lineAt(lineIdx - 1).text.length)
            : new vscode.Position(0, 0);
        const endPos = new vscode.Position(lineIdx, doc.lineAt(lineIdx).text.length);
        edit.delete(doc.uri, new vscode.Range(startPos, endPos));
        await vscode.workspace.applyEdit(edit);
        // Re-render to refresh line numbers
        await this._loadAndRender(doc);
    }

    /**
     * Handle vscodeUndo message — restore content from snapshot to reverse structural changes.
     */
    private async _handleVscodeUndo() {
        if (!this._document) return;
        const snapshot = this._contentSnapshots.pop();
        if (!snapshot) return;
        const doc = this._document;
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end,
        );
        edit.replace(doc.uri, fullRange, snapshot);
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
    }

    /**
     * Handle addBackground message from webview.
     * Adds a background = { name = "background" quadTextureSprite = "GFX_xxx" } to a container.
     */
    private async _handleAddBackground(msg: { parentEndLine: number; sprite?: string }) {
        if (!this._document) return;
        const doc = this._document;
        this._saveSnapshot(doc);
        const closingLine = doc.lineAt(msg.parentEndLine - 1);
        const parentIndent = closingLine.text.match(/^(\s*)/)?.[1] ?? '';
        const childIndent = parentIndent + '\t';
        const spriteName = msg.sprite || 'GFX_tile_outliner_bg';
        const bgCode = [
            `${childIndent}background = {`,
            `${childIndent}\tname = "background"`,
            `${childIndent}\tquadTextureSprite = "${spriteName}"`,
            `${childIndent}}`,
        ].join('\n');
        const edit = new vscode.WorkspaceEdit();
        // Insert before the container's closing brace
        const insertPos = new vscode.Position(msg.parentEndLine - 1, 0);
        edit.insert(doc.uri, insertPos, bgCode + '\n');
        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
    }

    /**
     * Handle addElement message from webview.
     * msg: { command, parentEndLine, type, name, x, y, w, h }
     */
    private async _handleAddElement(msg: { parentEndLine: number; type: string; name: string; x: number; y: number; w: number; h: number }) {
        if (!this._document) return;
        const doc = this._document;
        this._saveSnapshot(doc);
        // Determine indentation from parent's closing brace
        const closingLine = doc.lineAt(msg.parentEndLine - 1);
        const parentIndent = closingLine.text.match(/^(\s*)/)?.[1] ?? '';
        const childIndent = parentIndent + '\t';
        const newElement = serializeNewElement(msg.type, msg.name, msg.x, msg.y, msg.w, msg.h, childIndent);
        // Insert before the parent's closing brace
        const edit = new vscode.WorkspaceEdit();
        const insertPos = new vscode.Position(msg.parentEndLine - 1, 0);
        edit.insert(doc.uri, insertPos, newElement + '\n');
        await vscode.workspace.applyEdit(edit);
        // Full re-render to pick up the new element
        await this._loadAndRender(doc);
    }

    /**
     * Handle duplicateElement message from webview.
     * msg: { command, startLine, endLine, newName }
     */
    private async _handleDuplicateElement(msg: { startLine: number; endLine: number; newName: string }) {
        if (!this._document) return;
        const doc = this._document;
        this._saveSnapshot(doc);
        // Copy the source lines
        const sourceLines: string[] = [];
        for (let i = msg.startLine - 1; i < msg.endLine; i++) {
            sourceLines.push(doc.lineAt(i).text);
        }
        let block = sourceLines.join('\n');
        // Replace the name in the copied block
        block = block.replace(/(name\s*=\s*")([^"]*)(")/, `$1${msg.newName}$3`);
        block = block.replace(/(name\s*=\s*)([^\s"{}]+)/, `$1"${msg.newName}"`);
        // Offset position by +10, +10
        block = block.replace(
            /position\s*=\s*\{\s*x\s*=\s*(-?\d+)\s+y\s*=\s*(-?\d+)\s*\}/,
            (_, x, y) => `position = { x = ${parseInt(x) + 10} y = ${parseInt(y) + 10} }`,
        );
        // Insert after the original element's end line
        const edit = new vscode.WorkspaceEdit();
        const insertPos = new vscode.Position(msg.endLine - 1, doc.lineAt(msg.endLine - 1).text.length);
        edit.insert(doc.uri, insertPos, '\n' + block);
        await vscode.workspace.applyEdit(edit);
        // Full re-render
        await this._loadAndRender(doc);
    }

    /**
     * Handle reparentElement message — move an element to be a child of another container.
     * msg: { command, startLine, endLine, newParentEndLine, positionAdjust?: { dx: number; dy: number } }
     * Cuts the element's source lines and inserts them before the new parent's closing brace.
     * Indentation is automatically adjusted to match the new nesting level.
     */
    private async _handleReparentElement(msg: { startLine: number; endLine: number; newParentEndLine: number; positionAdjust?: { dx: number; dy: number } }) {
        if (!this._document) return;
        const doc = this._document;
        this._saveSnapshot(doc);

        // Read the source lines of the element to move
        const sourceLines: string[] = [];
        for (let i = msg.startLine - 1; i < msg.endLine; i++) {
            sourceLines.push(doc.lineAt(i).text);
        }

        // Determine indentation: new parent's closing brace indent + one tab
        const newParentClosingLine = doc.lineAt(msg.newParentEndLine - 1);
        const parentIndent = newParentClosingLine.text.match(/^(\s*)/)?.[1] ?? '';
        const childIndent = parentIndent + '\t';

        // Detect current indentation of the element
         
        const currentIndent = sourceLines[0]!.match(/^(\s*)/)?.[1] ?? '';

        // Re-indent all lines
        let block = sourceLines.map(line => {
            if (line.startsWith(currentIndent)) {
                return childIndent + line.slice(currentIndent.length);
            }
            return childIndent + line.trimStart();
        }).join('\n');

        // Adjust position if needed (to preserve visual location)
        if (msg.positionAdjust) {
            const posRegex = /position\s*=\s*\{[^}]*\}/;
            const posMatch = block.match(posRegex);
            if (posMatch) {
                // Try to extract x and y from the position block
                const xMatch = posMatch[0].match(/x\s*=\s*(-?[\d.]+)/);
                const yMatch = posMatch[0].match(/y\s*=\s*(-?[\d.]+)/);
                if (xMatch && yMatch) {
                     
                    const newX = Math.round(parseFloat(xMatch[1]!) + msg.positionAdjust.dx);
                     
                    const newY = Math.round(parseFloat(yMatch[1]!) + msg.positionAdjust.dy);
                    block = block.replace(posRegex, `position = { x = ${newX} y = ${newY} }`);
                }
            }
        }

        // Build the edit
        const edit = new vscode.WorkspaceEdit();

        // Delete original lines (including preceding newline)
        const deleteStartPos = msg.startLine > 1
            ? new vscode.Position(msg.startLine - 2, doc.lineAt(msg.startLine - 2).text.length)
            : new vscode.Position(0, 0);
        const deleteEndPos = new vscode.Position(msg.endLine - 1, doc.lineAt(msg.endLine - 1).text.length);
        edit.delete(doc.uri, new vscode.Range(deleteStartPos, deleteEndPos));

        // Insert before new parent's closing brace
        const insertPos = new vscode.Position(msg.newParentEndLine - 1, 0);
        edit.insert(doc.uri, insertPos, block + '\n');

        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
    }

    /**
     * Handle unparentElement message — move an element up one level out of its parent.
     * msg: { command, startLine, endLine, parentEndLine, positionAdjust?: { dx: number; dy: number } }
     * Cuts the element and inserts it after the parent's closing brace.
     */
    private async _handleUnparentElement(msg: { startLine: number; endLine: number; parentEndLine: number; positionAdjust?: { dx: number; dy: number } }) {
        if (!this._document) return;
        const doc = this._document;
        this._saveSnapshot(doc);

        // Read the source lines
        const sourceLines: string[] = [];
        for (let i = msg.startLine - 1; i < msg.endLine; i++) {
            sourceLines.push(doc.lineAt(i).text);
        }

        // Adjust indentation: remove one level of indentation
         
        const currentIndent = sourceLines[0]!.match(/^(\s*)/)?.[1] ?? '';
        const newIndent = currentIndent.length > 0
            ? currentIndent.replace(/\t$/, '').replace(/ {4}$/, '')  // remove one tab or 4 spaces
            : '';

        let block = sourceLines.map(line => {
            if (line.startsWith(currentIndent)) {
                return newIndent + line.slice(currentIndent.length);
            }
            return newIndent + line.trimStart();
        }).join('\n');

        // Adjust position to preserve visual location
        if (msg.positionAdjust) {
            const posRegex = /position\s*=\s*\{[^}]*\}/;
            const posMatch = block.match(posRegex);  // in _handleUnparentElement
            if (posMatch) {
                const xMatch = posMatch[0].match(/x\s*=\s*(-?[\d.]+)/);
                const yMatch = posMatch[0].match(/y\s*=\s*(-?[\d.]+)/);
                if (xMatch && yMatch) {
                     
                    const newX = Math.round(parseFloat(xMatch[1]!) + msg.positionAdjust.dx);
                     
                    const newY = Math.round(parseFloat(yMatch[1]!) + msg.positionAdjust.dy);
                    block = block.replace(posRegex, `position = { x = ${newX} y = ${newY} }`);
                }
            }
        }

        // Delete original, insert after parent's closing brace
        const edit = new vscode.WorkspaceEdit();

        // Delete original lines (including preceding newline)
        const deleteStartPos = msg.startLine > 1
            ? new vscode.Position(msg.startLine - 2, doc.lineAt(msg.startLine - 2).text.length)
            : new vscode.Position(0, 0);
        const deleteEndPos = new vscode.Position(msg.endLine - 1, doc.lineAt(msg.endLine - 1).text.length);
        edit.delete(doc.uri, new vscode.Range(deleteStartPos, deleteEndPos));

        // Insert after parent's closing brace
        const insertPos = new vscode.Position(msg.parentEndLine - 1, doc.lineAt(msg.parentEndLine - 1).text.length);
        edit.insert(doc.uri, insertPos, '\n' + block);

        await vscode.workspace.applyEdit(edit);
        await this._loadAndRender(doc);
    }

    private _getHtml(): string {
        const styleUri = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'guiPreview.css')));
        const scriptUri = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'guiPreview.js')));
        const nonce = getNonce();
        const lang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
        const title = panelText('GUI Preview', 'GUI 预览');
        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this._panel.webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${this._panel.webview.cspSource} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>${title}</title>
</head>
<body class="mode-inspect overlay-focus">
    <header id="toolbar">
        <div id="title-area">
            <span class="app-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 8h10M7 12h6M7 16h8"></path></svg></span>
            <span class="title-copy"><span class="title-kicker">${panelText('GUI WORKBENCH', 'GUI 工作台')}</span><strong id="title">${title}</strong></span>
        </div>
        <div id="mode-switch" role="group" aria-label="${panelText('Workspace mode', '工作模式')}">
            <button id="btn-preview" type="button" aria-pressed="false">${panelText('Preview', '预览')}</button>
            <button id="btn-inspect" class="active" type="button" aria-pressed="true">${panelText('Inspect', '检查')}</button>
            <button id="btn-edit" type="button" aria-pressed="false">${panelText('Edit', '编辑')}</button>
        </div>
        <div id="controls">
            <span id="title-status" role="status">${panelText('No element selected', '未选择元素')}</span>
            <button id="btn-search" type="button" aria-label="${panelText('Search elements', '搜索元素')}" title="${panelText('Search elements (Ctrl+F)', '搜索元素 (Ctrl+F)')}"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg></button>
            <button id="btn-layers" class="active" type="button" aria-pressed="true" aria-label="${panelText('Toggle inspector', '切换检视器')}" title="${panelText('Toggle inspector', '切换检视器')}"><svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Z"></path><path d="m3 12 9 5 9-5M3 16l9 5 9-5"></path></svg></button>
        </div>
    </header>
    <div id="search-bar" class="hidden">
        <input id="search-input" type="text" placeholder="${panelText('Search element name...', '搜索元素名称...')}" />
        <span id="search-count"></span>
        <button id="search-prev" title="${panelText('Previous', '上一个')}">↑</button>
        <button id="search-next" title="${panelText('Next', '下一个')}">↓</button>
        <button id="search-close" title="${panelText('Close', '关闭')}">✕</button>
    </div>
    <div id="edit-context-menu" class="hidden">
        <button data-action="add-container">+ ${panelText('Container window', '容器窗口')}</button>
        <button data-action="add-background">+ ${panelText('Background', '背景')}</button>
        <button data-action="add-icon">+ ${panelText('Icon', '图标')}</button>
        <button data-action="add-button">+ ${panelText('Button', '按钮')}</button>
        <button data-action="add-effectbutton">+ ${panelText('Effect button', '效果按钮')}</button>
        <button data-action="add-guibutton">+ ${panelText('GUI button', 'GUI按钮')}</button>
        <button data-action="add-text">+ ${panelText('Text box', '文本框')}</button>
        <hr />
        <button data-action="duplicate">${panelText('Duplicate (Ctrl+D)', '复制 (Ctrl+D)')}</button>
        <button data-action="hide-off-canvas">${panelText('Move off canvas (Del)', '移出画布 (Del)')}</button>
        <hr />
        <button data-action="reparent">${panelText('Move into container (P)', '移入容器 (P)')}</button>
        <button data-action="unparent">${panelText('Move out of container (Shift+P)', '移出容器 (Shift+P)')}</button>
    </div>
    <div id="main-layout">
        <main id="viewport" aria-label="${panelText('Interactive GUI canvas', '交互式 GUI 画布')}">
            <div id="view-toolbar" role="toolbar" aria-label="${panelText('View controls', '视图控制')}">
                <div class="tool-cluster zoom-cluster">
                    <button id="btn-zoom-out" type="button" aria-label="${panelText('Zoom out', '缩小')}">−</button>
                    <strong id="zoom-level">100%</strong>
                    <button id="btn-zoom-in" type="button" aria-label="${panelText('Zoom in', '放大')}">+</button>
                </div>
                <div class="tool-cluster fit-cluster">
                    <button id="btn-fit" class="text-button" type="button" title="${panelText('Fit authored GUI content', '适应实际 GUI 内容')}">${panelText('Fit content', '适应内容')}</button>
                    <button id="btn-fit-screen" class="text-button" type="button" title="${panelText('Fit the complete game screen', '适应完整游戏屏幕')}">${panelText('Full screen', '完整屏幕')}</button>
                    <button id="btn-fit-selection" class="text-button" type="button" disabled title="${panelText('Fit selected element', '适应选中元素')}">${panelText('Selection', '选中项')}</button>
                    <button id="btn-actual-size" class="text-button" type="button" title="${panelText('Show native pixels at 100%', '以 100% 显示原始像素')}">1:1</button>
                    <button id="btn-reset" type="button" aria-label="${panelText('Reset view', '重置视图')}" title="${panelText('Reset view', '重置视图')}">↻</button>
                </div>
                <div class="tool-cluster select-cluster">
                    <label for="overlay-select">${panelText('Overlays', '叠加')}</label>
                    <select id="overlay-select" title="${panelText('Overlay density', '叠加层密度')}">
                        <option value="focus">${panelText('Focused', '聚焦')}</option>
                        <option value="all">${panelText('All', '全部')}</option>
                        <option value="clean">${panelText('Clean', '干净')}</option>
                    </select>
                    <label for="resolution-select">${panelText('Screen', '屏幕')}</label>
                    <select id="resolution-select" title="${panelText('Game screen resolution', '游戏屏幕分辨率')}">
                        <option value="auto">${panelText('Auto', '自动')}</option>
                        <option value="1920x1080">1080p</option>
                        <option value="2560x1440">1440p</option>
                        <option value="3840x2160">4K</option>
                    </select>
                    <button id="btn-anim" type="button" aria-pressed="false" title="${panelText('Play sprite animation', '播放精灵动画')}">▶</button>
                </div>
            </div>
            <div id="edit-toolbar" class="edit-only" role="toolbar" aria-label="${panelText('Editing actions', '编辑操作')}">
                <div class="tool-cluster save-cluster">
                    <button id="btn-save" class="primary-action" type="button" disabled title="${panelText('Save GUI changes (Ctrl+S)', '保存 GUI 更改 (Ctrl+S)')}">${panelText('Save', '保存')}</button>
                    <span id="edit-save-state" role="status" aria-live="polite">${panelText('Saved', '已保存')}</span>
                </div>
                <span class="toolbar-divider"></span>
                <button id="btn-undo" type="button" title="${panelText('Undo (Ctrl+Z)', '撤销 (Ctrl+Z)')}">↶</button>
                <button id="btn-redo" type="button" title="${panelText('Redo (Ctrl+Y)', '重做 (Ctrl+Y)')}">↷</button>
                <button id="btn-duplicate" type="button" disabled title="${panelText('Duplicate (Ctrl+D)', '复制 (Ctrl+D)')}">${panelText('Duplicate', '复制')}</button>
                <button id="btn-hide-off-canvas" type="button" disabled title="${panelText('Preserve the control and move it off canvas (Del)', '保留控件并将其移出画布 (Del)')}">${panelText('Move off canvas', '移出画布')}</button>
                <span class="toolbar-divider"></span>
                <button id="btn-align-left" title="${panelText('Align left', '左对齐')}" class="align-btn" disabled>⬅</button>
                <button id="btn-align-hcenter" title="${panelText('Center horizontally', '水平居中')}" class="align-btn" disabled>⬌</button>
                <button id="btn-align-right" title="${panelText('Align right', '右对齐')}" class="align-btn" disabled>➡</button>
                <button id="btn-align-top" title="${panelText('Align top', '上对齐')}" class="align-btn" disabled>⬆</button>
                <button id="btn-align-vcenter" title="${panelText('Center vertically', '垂直居中')}" class="align-btn" disabled>⬍</button>
                <button id="btn-align-bottom" title="${panelText('Align bottom', '下对齐')}" class="align-btn" disabled>⬇</button>
            </div>
            <div id="canvas-container">
                <div id="snap-guides"></div>
                <div id="gui-root"></div>
            </div>
            <div id="viewport-hint" role="note">${panelText('Wheel to zoom · Alt/middle-drag to pan · Double-click an element to open source', '滚轮缩放 · Alt/中键拖动平移 · 双击元素打开源码')}</div>
        </main>
        <div id="inspector-resizer" role="separator" aria-orientation="vertical" aria-label="${panelText('Resize inspector', '调整检视器宽度')}" tabindex="0"></div>
        <aside id="side-panel" aria-label="${panelText('GUI inspector', 'GUI 检视器')}">
            <div id="inspector-header"><span><small>${panelText('INSPECTOR', '检视器')}</small><strong id="inspector-title">${panelText('GUI structure', 'GUI 结构')}</strong></span><button id="btn-close-inspector" type="button" aria-label="${panelText('Close inspector', '关闭检视器')}">×</button></div>
            <div id="side-panel-tabs" role="tablist">
                <button id="tab-layers" class="tab active" role="tab" aria-selected="true">${panelText('Layers', '图层')}</button>
                <button id="tab-properties" class="tab" role="tab" aria-selected="false">${panelText('Properties', '属性')}</button>
            </div>
            <div id="layers-panel" role="tabpanel">
                <div id="layers-header">
                    <span><strong>${panelText('Layer tree', '图层树')}</strong><small id="layer-count"></small></span>
                    <button id="layers-collapse-all" title="${panelText('Collapse all', '全部折叠')}">▸</button>
                    <button id="layers-expand-all" title="${panelText('Expand all', '全部展开')}">▾</button>
                </div>
                <div id="layer-filter-bar">
                    <input id="layer-filter" type="search" placeholder="${panelText('Filter by name or type…', '按名称或类型筛选…')}" aria-label="${panelText('Filter layers', '筛选图层')}" />
                    <select id="layer-type-filter" aria-label="${panelText('Filter by element type', '按元素类型筛选')}"><option value="">${panelText('All types', '全部类型')}</option></select>
                </div>
                <div id="layers-tree"></div>
            </div>
            <div id="properties-panel" class="hidden" role="tabpanel">
                <div id="props-content">${panelText('Select an element to inspect its properties', '选择一个元素以检查属性')}</div>
            </div>
        </aside>
    </div>
    <div id="tooltip" class="hidden"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
}

function panelText(en: string, zh: string): string {
    return vscode.env.language.toLowerCase().startsWith('zh') ? zh : en;
}
