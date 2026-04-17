/**
 * GUI Preview Panel - manages the webview for GUI visualization.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseGuiFile, buildSpriteIndex, serializePosition, serializeSize, serializeProperty, serializeNewElement, type GuiElement } from './guiParser';
import { decodeDds, decodeTga, type DdsResult } from './ddsDecoder';

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
            this._panel.webview.onDidReceiveMessage(async msg => {
                switch (msg.command) {
                    case 'goToLine': {
                        const ed = await vscode.window.showTextDocument(document.uri, { viewColumn: vscode.ViewColumn.One });
                        const range = new vscode.Range(msg.line - 1, 0, msg.line - 1, 0);
                        ed.selection = new vscode.Selection(range.start, range.start);
                        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        break;
                    }
                    case 'updateProperty':
                        await this._handleUpdateProperty(msg);
                        break;
                    case 'addElement':
                        await this._handleAddElement(msg);
                        break;
                    case 'deleteElement':
                        await this._handleDeleteElement(msg);
                        break;
                    case 'duplicateElement':
                        await this._handleDuplicateElement(msg);
                        break;
                    case 'removePropertyLine':
                        await this._handleRemovePropertyLine(msg);
                        break;
                    case 'vscodeUndo':
                        await this._handleVscodeUndo();
                        break;
                }
            }, null, this._disposables),
        );

        // Watch for document saves to auto-refresh preview
        this._disposables.push(
            vscode.workspace.onDidSaveTextDocument(async savedDoc => {
                if (savedDoc.uri.fsPath === document.uri.fsPath) {
                    if (this._skipNextReload) {
                        this._skipNextReload = false;
                        return;
                    }
                    this._textureCache.clear();
                    this._textureCacheBytes = 0;
                    await this._loadAndRender(savedDoc);
                }
            }),
        );
    }

    /**
     * Get Stellaris game installation path from the plugin's existing configuration.
     * Uses `cwtools.cache.stellaris` which is set by the user via the "Select vanilla folder" prompt.
     */
    private _getGamePath(): string | null {
        const config = vscode.workspace.getConfiguration('cwtools');
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

        // Build sprite index from .gfx files in all search roots
        const spriteIndex = await this._buildSpriteIndex(searchRoots);

        // Parse the GUI file
        const elements = parseGuiFile(content, spriteIndex);

        // Resolve texture URIs for webview display
        const resolved = this._resolveTextures(elements, searchRoots);

        // Collect sprite names for the webview dropdown
        const spriteNames = Array.from(spriteIndex.keys()).sort();

        this._panel.webview.postMessage({
            command: 'render',
            data: resolved,
            fileName: path.basename(document.fileName),
            spriteNames,
        });
    }

    private async _buildSpriteIndex(searchRoots: string[]): Promise<Map<string, import('./guiParser').SpriteInfo>> {
        const gfxContents: Array<{ path: string; content: string }> = [];

        for (const root of searchRoots) {
            // Search both interface/ and gfx/ directories for .gfx files
            const searchDirs = [
                path.join(root, 'interface'),
                path.join(root, 'gfx'),
            ];

            for (const dir of searchDirs) {
                if (!fs.existsSync(dir)) continue;
                this._findGfxFiles(dir, gfxContents);
            }
        }

        return buildSpriteIndex(gfxContents);
    }

    private _findGfxFiles(dir: string, result: Array<{ path: string; content: string }>) {
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    this._findGfxFiles(full, result);
                } else if (entry.name.endsWith('.gfx')) {
                    try {
                        result.push({ path: full, content: fs.readFileSync(full, 'utf-8') });
                    } catch { /* skip unreadable */ }
                }
            }
        } catch { /* skip inaccessible dirs */ }
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

    // ── Visual Editor: Source File Editing ─────────────────────────────────

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
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
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
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
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
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
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
        const hasExistingLine = msg.propertyLine !== undefined && msg.propertyLine !== null && msg.propertyLine !== msg.line;

        if (msg.property === 'position') {
            const val = msg.value as { x: number; y: number };
            if (hasExistingLine) {
                const line = doc.lineAt(msg.propertyLine! - 1);
                const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                const newText = `${indent}${serializePosition(val.x, val.y)}`;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, line.range, newText);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            } else {
                const openLine = doc.lineAt(msg.line - 1);
                const indent = openLine.text.match(/^(\s*)/)?.[1] ?? '';
                const childIndent = indent + '\t';
                await this._insertAfterLine(msg.line, `${childIndent}${serializePosition(val.x, val.y)}`);
                // Re-render to refresh line numbers so subsequent edits won't re-insert
                await this._loadAndRender(doc);
            }
        } else if (msg.property === 'size') {
            const val = msg.value as { width: number; height: number };
            if (hasExistingLine) {
                const line = doc.lineAt(msg.propertyLine! - 1);
                const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                const newText = `${indent}${serializeSize(val.width, val.height)}`;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, line.range, newText);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            } else {
                const openLine = doc.lineAt(msg.line - 1);
                const indent = openLine.text.match(/^(\s*)/)?.[1] ?? '';
                const childIndent = indent + '\t';
                await this._insertAfterLine(msg.line, `${childIndent}${serializeSize(val.width, val.height)}`);
                await this._loadAndRender(doc);
            }
        } else {
            if (hasExistingLine) {
                const line = doc.lineAt(msg.propertyLine! - 1);
                const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
                const newText = `${indent}${serializeProperty(msg.property, msg.value)}`;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, line.range, newText);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            } else {
                const openLine = doc.lineAt(msg.line - 1);
                const indent = openLine.text.match(/^(\s*)/)?.[1] ?? '';
                const childIndent = indent + '\t';
                await this._insertAfterLine(msg.line, `${childIndent}${serializeProperty(msg.property, msg.value)}`);
                await this._loadAndRender(doc);
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
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
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
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        await this._loadAndRender(doc);
    }

    /**
     * Handle addElement message from webview.
     * msg: { command, parentEndLine, type, name, x, y, w, h }
     */
    private async _handleAddElement(msg: { parentEndLine: number; type: string; name: string; x: number; y: number; w: number; h: number }) {
        if (!this._document) return;
        const doc = this._document;
        this._contentSnapshots.push(doc.getText());
        // Determine indentation from parent's closing brace
        const closingLine = doc.lineAt(msg.parentEndLine - 1);
        const parentIndent = closingLine.text.match(/^(\s*)/)?.[1] ?? '';
        const childIndent = parentIndent + '\t';
        const newElement = serializeNewElement(msg.type, msg.name, msg.x, msg.y, msg.w, msg.h, childIndent);
        // Insert before the parent's closing brace
        const edit = new vscode.WorkspaceEdit();
        const insertPos = new vscode.Position(msg.parentEndLine - 1, 0);
        edit.insert(doc.uri, insertPos, newElement + '\n');
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        // Full re-render to pick up the new element
        await this._loadAndRender(doc);
    }

    /**
     * Handle deleteElement message from webview.
     * msg: { command, startLine, endLine }
     */
    private async _handleDeleteElement(msg: { startLine: number; endLine: number }) {
        if (!this._document) return;
        const doc = this._document;
        this._contentSnapshots.push(doc.getText());
        const edit = new vscode.WorkspaceEdit();
        // Delete the entire line range including the preceding newline
        const startPos = msg.startLine > 1
            ? new vscode.Position(msg.startLine - 2, doc.lineAt(msg.startLine - 2).text.length)
            : new vscode.Position(0, 0);
        const endPos = new vscode.Position(msg.endLine - 1, doc.lineAt(msg.endLine - 1).text.length);
        edit.delete(doc.uri, new vscode.Range(startPos, endPos));
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        // Full re-render
        await this._loadAndRender(doc);
    }

    /**
     * Handle duplicateElement message from webview.
     * msg: { command, startLine, endLine, newName }
     */
    private async _handleDuplicateElement(msg: { startLine: number; endLine: number; newName: string }) {
        if (!this._document) return;
        const doc = this._document;
        this._contentSnapshots.push(doc.getText());
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
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        // Full re-render
        await this._loadAndRender(doc);
    }

    private _getHtml(): string {
        const styleUri = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'guiPreview.css')));
        const scriptUri = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'guiPreview.js')));
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this._panel.webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${this._panel.webview.cspSource} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>GUI 预览</title>
</head>
<body>
    <div id="toolbar">
        <span id="title">GUI 预览</span>
        <div id="controls">
            <button id="btn-edit" title="切换编辑模式 (E)" class="edit-toggle">✏️</button>
            <span class="separator">|</span>
            <button id="btn-zoom-in" title="放大">+</button>
            <span id="zoom-level">100%</span>
            <button id="btn-zoom-out" title="缩小">−</button>
            <button id="btn-fit" title="适应窗口">⊡</button>
            <button id="btn-reset" title="重置">↻</button>
            <button id="btn-preview" title="预览模式 (隐藏边框)">👁</button>
            <button id="btn-search" title="搜索元素 (Ctrl+F)">🔍</button>
            <button id="btn-layers" title="切换图层面板">☰</button>
            <span class="separator edit-only">|</span>
            <button id="btn-align-left" title="左对齐" class="edit-only align-btn" disabled>⬅</button>
            <button id="btn-align-hcenter" title="水平居中" class="edit-only align-btn" disabled>⬌</button>
            <button id="btn-align-right" title="右对齐" class="edit-only align-btn" disabled>➡</button>
            <button id="btn-align-top" title="上对齐" class="edit-only align-btn" disabled>⬆</button>
            <button id="btn-align-vcenter" title="垂直居中" class="edit-only align-btn" disabled>⬍</button>
            <button id="btn-align-bottom" title="下对齐" class="edit-only align-btn" disabled>⬇</button>
        </div>
    </div>
    <div id="search-bar" class="hidden">
        <input id="search-input" type="text" placeholder="搜索元素名称..." />
        <span id="search-count"></span>
        <button id="search-prev" title="上一个">↑</button>
        <button id="search-next" title="下一个">↓</button>
        <button id="search-close" title="关闭">✕</button>
    </div>
    <div id="edit-context-menu" class="hidden">
        <button data-action="add-container">+ 容器窗口</button>
        <button data-action="add-icon">+ 图标</button>
        <button data-action="add-button">+ 按钮</button>
        <button data-action="add-text">+ 文本框</button>
        <hr />
        <button data-action="duplicate">复制 (Ctrl+D)</button>
        <button data-action="delete">删除 (Del)</button>
    </div>
    <div id="main-layout">
        <div id="viewport">
            <div id="canvas-container">
                <div id="snap-guides"></div>
                <div id="gui-root"></div>
            </div>
        </div>
        <div id="side-panel" class="hidden">
            <div id="side-panel-tabs">
                <button id="tab-layers" class="tab active">图层</button>
                <button id="tab-properties" class="tab">属性</button>
            </div>
            <div id="layers-panel">
                <div id="layers-header">
                    <button id="layers-collapse-all" title="全部折叠">▾</button>
                    <button id="layers-expand-all" title="全部展开">▸</button>
                </div>
                <div id="layers-tree"></div>
            </div>
            <div id="properties-panel" class="hidden">
                <div id="props-content">选择一个元素以编辑属性</div>
            </div>
        </div>
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
