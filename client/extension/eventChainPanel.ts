/**
 * Event Chain Panel — VS Code Webview host for the Event Chain Visualizer.
 *
 * Behaviour:
 * 1. Seeds from the currently active event file
 * 2. Scans ALL events/ files to build the full event graph
 * 3. Scans common/ directories (on_actions, decisions, scripted_effects) for
 *    non-event triggers that reference events
 * 4. BFS-expands from seed events to show only the connected subgraph
 * 5. Click-to-navigate jumps to source file
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
    parseEventFile,
    parseCommonFile,
    mergeGraphs,
    extractConnectedSubgraph,
    type EventGraph,
} from './eventChainParser';

// ─── Nonce generator ─────────────────────────────────────────────────────────

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export class EventChainPanel {
    public static currentPanel: EventChainPanel | undefined;
    private static readonly viewType = 'cwtools-event-chain';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];
    /** The document that seeded this panel */
    private _seedDocument: vscode.TextDocument | undefined;

    /**
     * Create or reveal the Event Chain Panel.
     * If a document is provided, seeds the graph from that file's events.
     * Otherwise uses the active editor's document.
     */
    public static async create(extensionPath: string, document?: vscode.TextDocument) {
        const column = vscode.ViewColumn.Beside;
        const seedDoc = document ?? vscode.window.activeTextEditor?.document;

        if (EventChainPanel.currentPanel) {
            EventChainPanel.currentPanel._seedDocument = seedDoc;
            EventChainPanel.currentPanel._panel.reveal(column);
            await EventChainPanel.currentPanel._scanAndRender();
            return;
        }

        const panel = new EventChainPanel(extensionPath, column, seedDoc);
        EventChainPanel.currentPanel = panel;
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, seedDoc?: vscode.TextDocument) {
        this._extensionPath = extensionPath;
        this._seedDocument = seedDoc;
        const webviewRootPath = path.join(extensionPath, 'bin/client/webview');

        const title = seedDoc
            ? `事件链: ${path.basename(seedDoc.fileName)}`
            : '事件链可视化';

        this._panel = vscode.window.createWebviewPanel(
            EventChainPanel.viewType,
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

        // Handle messages from webview
        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(async msg => {
                if (!msg?.command) return;
                switch (msg.command) {
                    case 'ready':
                        await this._scanAndRender();
                        break;
                    case 'goToEvent':
                        await this._goToEvent(msg.file, msg.line);
                        break;
                }
            }, null, this._disposables),
        );
    }

    public dispose() {
        EventChainPanel.currentPanel = undefined;
        this._seedDocument = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    // ── Scan workspace for event files and build graph ──────────────────────

    private async _scanAndRender() {
        this._panel.webview.postMessage({
            command: 'loading',
            text: '扫描事件文件...',
        });

        try {
            const graph = await this._buildEventGraph();
            this._panel.webview.postMessage({
                command: 'render',
                data: graph,
            });
        } catch (e) {
            console.error('[EventChainPanel] Failed to scan events:', e);
            this._panel.webview.postMessage({
                command: 'render',
                data: { nodes: [], edges: [] },
            });
        }
    }

    private async _buildEventGraph(): Promise<EventGraph> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return { nodes: [], edges: [] };
        }

        const wsRoot = workspaceFolders[0]!;

        // ── Phase 0: Parse seed document first to get our target event IDs ────
        let seedIds = new Set<string>();
        if (this._seedDocument) {
            const seedContent = this._seedDocument.getText();
            const seedPath = vscode.workspace.asRelativePath(this._seedDocument.uri);
            const seedGraph = parseEventFile(seedContent, seedPath);
            seedIds = new Set(seedGraph.nodes.map(n => n.id));
        }

        // If seed document doesn't contain any event definitions, show empty
        if (seedIds.size === 0) {
            this._panel.webview.postMessage({
                command: 'loading',
                text: '当前文件不包含事件定义',
            });
            return { nodes: [], edges: [] };
        }

        // ── Phase 1: Parse ALL event files to build the full event graph ──────
        this._panel.webview.postMessage({ command: 'loading', text: '扫描 events/ 文件...' });

        const eventPattern = new vscode.RelativePattern(wsRoot, '**/events/**/*.txt');
        const eventFiles = await vscode.workspace.findFiles(eventPattern, '**/node_modules/**', 500);
        const eventGraphs: EventGraph[] = [];

        for (const fileUri of eventFiles) {
            try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const content = doc.getText();
                const relativePath = vscode.workspace.asRelativePath(fileUri);
                const graph = parseEventFile(content, relativePath);
                if (graph.nodes.length > 0) {
                    eventGraphs.push(graph);
                }
            } catch {
                // Skip unreadable files
            }
        }

        this._panel.webview.postMessage({ command: 'loading', text: '扫描 common/ 触发器...' });

        const commonPatterns = [
            '**/common/on_actions/**/*.txt',
            '**/common/decisions/**/*.txt',
            '**/common/scripted_effects/**/*.txt',
            '**/common/scripted_triggers/**/*.txt',
            '**/common/special_projects/**/*.txt',
            '**/common/anomalies/**/*.txt',
            '**/common/archaeological_site_types/**/*.txt',
            '**/common/situations/**/*.txt',
            '**/common/technology/**/*.txt',
            '**/common/tradition_categories/**/*.txt',
            '**/common/traditions/**/*.txt',
            '**/common/ascension_perks/**/*.txt',
            '**/common/espionage_operation_types/**/*.txt',
            '**/common/first_contact/**/*.txt',
            '**/common/diplomatic_actions/**/*.txt',
            '**/common/war_goals/**/*.txt',
            '**/common/casus_belli/**/*.txt',
            '**/common/policies/**/*.txt',
            '**/common/edicts/**/*.txt',
            '**/common/megastructures/**/*.txt',
            '**/common/ship_sizes/**/*.txt',
            '**/common/observation_station_missions/**/*.txt',
            '**/common/colony_types/**/*.txt',
            '**/common/resolutions/**/*.txt',
        ];

        for (const glob of commonPatterns) {
            const pattern = new vscode.RelativePattern(wsRoot, glob);
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 200);
            for (const fileUri of files) {
                try {
                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    const content = doc.getText();
                    const relativePath = vscode.workspace.asRelativePath(fileUri);
                    const result = parseCommonFile(content, relativePath);

                    const graph: EventGraph = { nodes: [], edges: result.edges };
                    for (const src of result.externalSources) {
                        graph.nodes.push({
                            id: src.id,
                            type: src.sourceType,
                            title: src.name,
                            isTriggeredOnly: false,
                            file: src.file,
                            line: src.line,
                            endLine: src.line,
                            namespace: `__${src.sourceType}__`,
                            isFireOnAction: src.sourceType === 'on_action',
                            isHidden: false,
                        });
                    }
                    if (graph.nodes.length > 0 || graph.edges.length > 0) {
                        eventGraphs.push(graph);
                    }
                } catch {
                    // Skip
                }
            }
        }

        // ── Phase 2: BFS-expand from seed events (shallow: depth 2) ───────────
        this._panel.webview.postMessage({ command: 'loading', text: '构建事件关系图...' });

        const eventsOnlyGraph = mergeGraphs(eventGraphs);
        // Depth 2: seed events → their direct targets → one more hop
        const subgraph = extractConnectedSubgraph(eventsOnlyGraph, seedIds, 2);

        // (Phase 3 removed: common/ scanning is now done in Phase 1 before BFS)

        // ── Phase 4: Resolve localization titles for non-hidden events ─────────
        this._panel.webview.postMessage({ command: 'loading', text: '解析本地化文本...' });
        await this._resolveLocTitles(subgraph);

        return subgraph;
    }

    // ── Resolve localization titles for non-hidden events ────────────────────

    private async _resolveLocTitles(graph: EventGraph) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        // Collect title keys that need resolving (non-hidden events with a title key)
        const keysToResolve = new Set<string>();
        for (const node of graph.nodes) {
            if (!node.isHidden && node.title) {
                keysToResolve.add(node.title);
            }
        }
        if (keysToResolve.size === 0) return;

        const locMap = new Map<string, string>();

        // Get configured validation languages, prioritize Chinese if present
        const config = vscode.workspace.getConfiguration('cwtools');
        let locLangs = config.get<string[]>('localisation.languages') || ['English'];
        
        let targetLangs = locLangs.map(l => l.toLowerCase());
        if (targetLangs.length >= 2 && targetLangs.includes('chinese')) {
            targetLangs = ['simp_chinese', 'chinese'];
        } else {
            targetLangs = targetLangs.map(l => l === 'english' ? 'english' : l === 'chinese' ? 'simp_chinese' : l);
        }

        // Only scan YML files that match the target languages (e.g. *l_english.yml)
        // This is significantly faster than parsing all loc files
        for (const lang of targetLangs) {
            const locPattern = new vscode.RelativePattern(
                workspaceFolders[0]!,
                `**/{localisation,localisation_synced,localization}/**/*l_${lang}.yml`,
            );
            const locFiles = await vscode.workspace.findFiles(locPattern, '**/node_modules/**', 200);
            const linePattern = /^\s*([a-zA-Z0-9_.:-]+)\s*:\d*\s*"(.*)"\s*$/;

            for (const fileUri of locFiles) {
                try {
                    const data = await vscode.workspace.fs.readFile(fileUri);
                    const text = new TextDecoder('utf-8').decode(data);
                    for (const line of text.split('\n')) {
                        const m = linePattern.exec(line);
                        if (m && keysToResolve.has(m[1]!)) {
                            // Strip Paradox color codes for clean display
                            locMap.set(m[1]!, m[2]!.replace(/§[RGBYWHETLMSPr!]/g, ''));
                        }
                    }
                } catch {
                    // Skip
                }
            }
        }

        // Apply resolved titles to nodes
        for (const node of graph.nodes) {
            if (!node.isHidden && node.title && locMap.has(node.title)) {
                node.title = locMap.get(node.title)!;
            }
        }
    }

    // ── Navigate to event source ────────────────────────────────────────────

    private async _goToEvent(file: string, line: number) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        const fileUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, file);
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            const range = new vscode.Range(line - 1, 0, line - 1, 0);
            editor.selection = new vscode.Selection(range.start, range.start);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch {
            vscode.window.showWarningMessage(`无法打开文件: ${file}`);
        }
    }

    // ── HTML template ────────────────────────────────────────────────────────

    private _getHtml(webviewRootPath: string): string {
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(webviewRootPath, 'eventChainPreview.css'))
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(webviewRootPath, 'eventChainPreview.js'))
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
    <title>事件链可视化</title>
</head>
<body>
    <div id="toolbar">
        <span class="title">
            <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                <path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/>
            </svg>
            事件链可视化
        </span>
        <div class="controls">
            <select id="ns-filter" title="命名空间筛选" aria-label="按命名空间过滤">
                <option value="__all__">全部命名空间</option>
            </select>
            <span class="separator">|</span>
            <input type="text" id="search-input" placeholder="搜索事件 ID..." aria-label="搜索事件" />
            <span class="separator">|</span>
            <button id="btn-zoom-in" title="放大" aria-label="放大">+</button>
            <button id="btn-zoom-out" title="缩小" aria-label="缩小">−</button>
            <button id="btn-fit" title="适应窗口" aria-label="适应窗口">⊡</button>
        </div>
    </div>

    <div id="cy-container">
        <div id="loading">扫描事件文件...</div>
        <div id="empty-state">
            <div style="font-size:24px; opacity:0.3;">🔗</div>
            <div>未发现事件定义</div>
            <div style="font-size:10px;">请确保工作区包含 events/ 目录</div>
        </div>
        <div id="legend">
            <div class="legend-item"><span class="legend-swatch" style="background:#4caf50;"></span> 入口事件</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#42a5f5;"></span> 触发型事件</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#e8c840;"></span> Option 边</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#4caf50;"></span> Immediate 边</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ff9800;"></span> After 边</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ab47bc;"></span> Effect 边</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#e91e63;"></span> On_action</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#00bcd4;"></span> Decision</div>
        </div>
    </div>

    <div id="stats-bar"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
