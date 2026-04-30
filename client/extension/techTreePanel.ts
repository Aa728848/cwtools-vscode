/**
 * Tech Tree Panel — VS Code Webview host for the Technology Tree Visualizer.
 *
 * Behaviour:
 * 1. Scans ALL common/technology/**\/*.txt files in the workspace
 * 2. Parses tech nodes and prerequisite edges
 * 3. If an active tech file is open, seeds from its techs (BFS-expand to show their tree)
 * 4. Resolves localization titles using the configured language
 * 5. Sends the graph to the webview for rendering
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ErrorReporter } from './ai/errorReporter';
import {
    parseTechFile,
    mergeTechGraphs,
    extractTechSubgraph,
    type TechGraph,
    type TechNode,
} from './techTreeParser';

// ─── Nonce generator ─────────────────────────────────────────────────────────

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export class TechTreePanel {
    public static currentPanel: TechTreePanel | undefined;
    private static readonly viewType = 'cwtools-tech-tree';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];
    private _seedDocument: vscode.TextDocument | undefined;

    public static async create(extensionPath: string, document?: vscode.TextDocument) {
        const column = vscode.ViewColumn.Beside;
        const seedDoc = document ?? vscode.window.activeTextEditor?.document;

        if (TechTreePanel.currentPanel) {
            TechTreePanel.currentPanel._seedDocument = seedDoc;
            TechTreePanel.currentPanel._panel.reveal(column);
            await TechTreePanel.currentPanel._scanAndRender();
            return;
        }

        const panel = new TechTreePanel(extensionPath, column, seedDoc);
        TechTreePanel.currentPanel = panel;
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, seedDoc?: vscode.TextDocument) {
        this._extensionPath = extensionPath;
        this._seedDocument = seedDoc;
        const webviewRootPath = path.join(extensionPath, 'bin/client/webview');

        const title = seedDoc
            ? `科技树: ${path.basename(seedDoc.fileName)}`
            : '科技树可视化';

        this._panel = vscode.window.createWebviewPanel(
            TechTreePanel.viewType,
            title,
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(webviewRootPath)],
            },
        );

        this._panel.webview.html = this._getHtml(webviewRootPath);
        this._panel.iconPath = vscode.Uri.file(path.join(extensionPath, 'images', 'icon.png'));
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(async msg => {
                if (!msg?.command) return;
                switch (msg.command) {
                    case 'ready':
                        await this._scanAndRender();
                        break;
                    case 'goToTech':
                        await this._goToTech(msg.file, msg.line);
                        break;
                }
            }, null, this._disposables),
        );
    }

    public dispose() {
        TechTreePanel.currentPanel = undefined;
        this._seedDocument = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    // ── Scan & render ─────────────────────────────────────────────────────────

    private async _scanAndRender() {
        this._panel.webview.postMessage({ command: 'loading', text: '扫描科技文件...' });
        try {
            const graph = await this._buildTechGraph();
            this._panel.webview.postMessage({ command: 'render', data: graph });
        } catch (e) {
            ErrorReporter.debug('TechTreePanel', 'Failed to scan tech files', e);
            this._panel.webview.postMessage({ command: 'render', data: { nodes: [], edges: [] } });
        }
    }

    private async _buildTechGraph(): Promise<TechGraph> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return { nodes: [], edges: [] };
        const wsRoot = workspaceFolders[0]!;

        // Determine seed tech IDs from the active file (if it's a tech file)
        let seedIds = new Set<string>();
        if (this._seedDocument) {
            const seedPath = vscode.workspace.asRelativePath(this._seedDocument.uri).toLowerCase();
            if (seedPath.includes('technology')) {
                const seedGraph = parseTechFile(this._seedDocument.getText(),
                    vscode.workspace.asRelativePath(this._seedDocument.uri));
                seedIds = new Set(seedGraph.nodes.map(n => n.id));
            }
        }

        // ── Phase 1: Scan all tech files ──────────────────────────────────────
        this._panel.webview.postMessage({ command: 'loading', text: '扫描 common/technology/ 文件...' });

        const techPattern = new vscode.RelativePattern(wsRoot, '**/common/technology/**/*.txt');
        const techFiles = await vscode.workspace.findFiles(techPattern, '**/node_modules/**', 500);
        const graphs: TechGraph[] = [];

        for (const fileUri of techFiles) {
            try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const g = parseTechFile(doc.getText(), vscode.workspace.asRelativePath(fileUri));
                if (g.nodes.length > 0) graphs.push(g);
            } catch { /* skip */ }
        }

        // ── Phase 2: Merge & BFS-expand ───────────────────────────────────────
        this._panel.webview.postMessage({ command: 'loading', text: '构建科技关系图...' });

        const fullGraph = mergeTechGraphs(graphs);

        // If we have seeds, show that subgraph (BFS from seed in both directions)
        // Otherwise show the entire graph
        const graph = seedIds.size > 0
            ? extractTechSubgraph(fullGraph, seedIds, 10)
            : fullGraph;

        // ── Phase 3: Resolve localization titles ──────────────────────────────
        this._panel.webview.postMessage({ command: 'loading', text: '解析本地化文本...' });
        await this._resolveLocTitles(graph.nodes);

        return graph;
    }

    private async _resolveLocTitles(nodes: TechNode[]) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        const keysToResolve = new Set(nodes.map(n => n.id));
        if (keysToResolve.size === 0) return;

        const locMap = new Map<string, string>();

        // Determine target languages (prefer Chinese)
        const config = vscode.workspace.getConfiguration('cwtools');
        const locLangs = config.get<string[]>('localisation.languages') || ['English'];
        let targetLangs = locLangs.map(l => l.toLowerCase());
        if (targetLangs.length >= 2 && targetLangs.includes('chinese')) {
            targetLangs = ['simp_chinese', 'chinese'];
        } else {
            targetLangs = targetLangs.map(l => l === 'chinese' ? 'simp_chinese' : l);
        }

        const linePattern = /^\s*([a-zA-Z0-9_.:-]+)\s*:\d*\s*"(.*)"\s*$/;

        for (const lang of targetLangs) {
            const locPattern = new vscode.RelativePattern(
                workspaceFolders[0]!,
                `**/{localisation,localisation_synced,localization}/**/*l_${lang}.yml`,
            );
            const locFiles = await vscode.workspace.findFiles(locPattern, '**/node_modules/**', 200);
            for (const fileUri of locFiles) {
                try {
                    const data = await vscode.workspace.fs.readFile(fileUri);
                    const text = new TextDecoder('utf-8').decode(data);
                    for (const line of text.split('\n')) {
                        const m = linePattern.exec(line);
                        if (m && keysToResolve.has(m[1]!)) {
                            locMap.set(m[1]!, m[2]!.replace(/§[RGBYWHETLMSPr!]/g, ''));
                        }
                    }
                } catch { /* skip */ }
            }
        }

        for (const node of nodes) {
            if (locMap.has(node.id)) node.title = locMap.get(node.id)!;
        }
    }

    private async _goToTech(filePath: string, line: number) {
        if (!filePath) return;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        let uri: vscode.Uri | undefined;
        try {
            uri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, filePath);
        } catch { return; }

        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    private _getHtml(webviewRootPath: string): string {
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(webviewRootPath, 'techTreePreview.css'))
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(webviewRootPath, 'techTreePreview.js'))
        );
        const nonce = getNonce();
        const csp = this._panel.webview.cspSource;

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${csp} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>科技树可视化</title>
</head>
<body>
    <div id="toolbar">
        <span class="title">
            <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                <circle cx="8" cy="8" r="3" fill="#4fc3f7"/>
                <line x1="8" y1="1" x2="8" y2="5" stroke="#4fc3f7" stroke-width="1.5"/>
                <line x1="8" y1="11" x2="8" y2="15" stroke="#4fc3f7" stroke-width="1.5"/>
                <line x1="1" y1="8" x2="5" y2="8" stroke="#4fc3f7" stroke-width="1.5"/>
                <line x1="11" y1="8" x2="15" y2="8" stroke="#4fc3f7" stroke-width="1.5"/>
            </svg>
            科技树可视化
        </span>
        <div class="controls">
            <select id="area-filter" title="领域筛选" aria-label="按领域过滤">
                <option value="__all__">全部领域</option>
                <option value="physics">物理学</option>
                <option value="society">社会学</option>
                <option value="engineering">工程学</option>
            </select>
            <span class="separator">|</span>
            <select id="tier-filter" title="层级筛选" aria-label="按层级过滤">
                <option value="__all__">全部层级</option>
            </select>
            <span class="separator">|</span>
            <input type="text" id="search-input" placeholder="搜索科技 ID..." aria-label="搜索科技" />
            <span class="separator">|</span>
            <label class="toggle-label" title="显示稀有科技">
                <input type="checkbox" id="show-rare" checked /> 稀有
            </label>
            <span class="separator">|</span>
            <button id="btn-zoom-in" title="放大" aria-label="放大">+</button>
            <button id="btn-zoom-out" title="缩小" aria-label="缩小">−</button>
            <button id="btn-fit" title="适应窗口" aria-label="适应窗口">⊡</button>
        </div>
    </div>

    <div id="cy-container">
        <div id="loading">扫描科技文件...</div>
        <div id="empty-state">
            <div style="font-size:24px; opacity:0.3;">🔬</div>
            <div>未发现科技定义</div>
            <div style="font-size:10px;">请确保工作区包含 common/technology/ 目录</div>
        </div>
        <div id="legend">
            <div class="legend-item"><span class="legend-swatch" style="background:#4fc3f7;"></span> 物理学</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#81c784;"></span> 社会学</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ffb74d;"></span> 工程学</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ce93d8; border-style:dashed; border-width:1px;"></span> 稀有科技</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ef5350;"></span> 危险科技</div>
        </div>
    </div>

    <div id="stats-bar"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
