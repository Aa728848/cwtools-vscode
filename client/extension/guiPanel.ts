/**
 * GUI Preview Panel - manages the webview for GUI visualization.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseGuiFile, buildSpriteIndex, type GuiElement } from './guiParser';
import { decodeDds, type DdsResult } from './ddsDecoder';

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
                if (msg.command === 'goToLine') {
                    const ed = await vscode.window.showTextDocument(document.uri, { viewColumn: vscode.ViewColumn.One });
                    const range = new vscode.Range(msg.line - 1, 0, msg.line - 1, 0);
                    ed.selection = new vscode.Selection(range.start, range.start);
                    ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                }
            }, null, this._disposables),
        );

        // Watch for document saves to auto-refresh preview
        this._disposables.push(
            vscode.workspace.onDidSaveTextDocument(async savedDoc => {
                if (savedDoc.uri.fsPath === document.uri.fsPath) {
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

        this._panel.webview.postMessage({
            command: 'render',
            data: resolved,
            fileName: path.basename(document.fileName),
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

                    // Try .tga (show as unresolved placeholder)
                    if (fs.existsSync(fullTga)) {
                        textureUri = `tga:${el.spriteTexture}`;
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

    private _getHtml(): string {
        const styleUri = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'guiPreview.css')));
        const scriptUri = this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(this._webviewRootPath, 'guiPreview.js')));
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this._panel.webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${this._panel.webview.cspSource} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>GUI Preview</title>
</head>
<body>
    <div id="toolbar">
        <span id="title">GUI Preview</span>
        <div id="controls">
            <button id="btn-zoom-in" title="Zoom In">+</button>
            <span id="zoom-level">100%</span>
            <button id="btn-zoom-out" title="Zoom Out">−</button>
            <button id="btn-fit" title="Fit">⊡</button>
            <button id="btn-reset" title="Reset">↻</button>
            <button id="btn-preview" title="Toggle Preview Mode (hide borders)">👁</button>
            <button id="btn-search" title="Search elements (Ctrl+F)">🔍</button>
            <button id="btn-layers" title="Toggle Layers Panel">☰</button>
        </div>
    </div>
    <div id="search-bar" class="hidden">
        <input id="search-input" type="text" placeholder="Search element name..." />
        <span id="search-count"></span>
        <button id="search-prev" title="Previous">↑</button>
        <button id="search-next" title="Next">↓</button>
        <button id="search-close" title="Close">✕</button>
    </div>
    <div id="main-layout">
        <div id="viewport">
            <div id="canvas-container">
                <div id="gui-root"></div>
            </div>
        </div>
        <div id="layers-panel" class="hidden">
            <div id="layers-header">
                <span>Layers</span>
                <button id="layers-collapse-all" title="Collapse All">▾</button>
                <button id="layers-expand-all" title="Expand All">▸</button>
            </div>
            <div id="layers-tree"></div>
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
