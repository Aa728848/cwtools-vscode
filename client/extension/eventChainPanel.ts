/**
 * Event Chain Panel — VS Code Webview host for the Event Chain Visualizer.
 *
 * Behaviour:
 * 1. Seeds from the currently active event file
 * 2. Scans ALL events/ files to build the full event graph
 * 3. Scans definition paths declared by the active semantic catalog for
 *    typed relationships that reference events
 * 4. BFS-expands from seed events to show only the connected subgraph
 * 5. Click-to-navigate jumps to source file
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ErrorReporter } from './ai/errorReporter';
import {
    parseEventFile,
    parseCommonFile,
    mergeGraphs,
    buildMtthConditionEdges,
    buildDefinitionReferenceEdges,
    extractConnectedSubgraph,
    selectEventSeedIds,
    type EventGraph,
} from './eventChainParser';
import { parsePdxSemanticCatalog } from '../shared/pdxSemanticCatalog';

// ─── Nonce generator ─────────────────────────────────────────────────────────

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function panelText(en: string, zh: string): string {
    return vscode.env.language.toLowerCase().startsWith('zh') ? zh : en;
}

interface EventGraphBuildResult {
    graph: EventGraph;
    seedIds: string[];
}

const EVENT_CHAIN_NODE_LIMIT = 1_000;

// ─── Panel ───────────────────────────────────────────────────────────────────

export class EventChainPanel {
    public static currentPanel: EventChainPanel | undefined;
    private static readonly viewType = 'cwtools-event-chain';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];
    /** The document that seeded this panel */
    private _seedDocument: vscode.TextDocument | undefined;
    /** One-based cursor line captured before focus moves to the Webview. */
    private _seedLine: number | undefined;

    /**
     * Create or reveal the Event Chain Panel.
     * If a document is provided, seeds the graph from the cursor event.
     * Otherwise uses the active editor's document.
     */
    public static async create(extensionPath: string, document?: vscode.TextDocument, seedLine?: number) {
        const column = vscode.ViewColumn.Beside;
        const seedDoc = document ?? vscode.window.activeTextEditor?.document;

        if (EventChainPanel.currentPanel) {
            EventChainPanel.currentPanel._seedDocument = seedDoc;
            EventChainPanel.currentPanel._seedLine = seedLine;
            EventChainPanel.currentPanel._panel.reveal(column);
            await EventChainPanel.currentPanel._scanAndRender();
            return;
        }

        const panel = new EventChainPanel(extensionPath, column, seedDoc, seedLine);
        EventChainPanel.currentPanel = panel;
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, seedDoc?: vscode.TextDocument, seedLine?: number) {
        this._extensionPath = extensionPath;
        this._seedDocument = seedDoc;
        this._seedLine = seedLine;
        const webviewRootPath = path.join(extensionPath, 'bin/client/webview');

        const title = seedDoc
            ? panelText(`Event Chain: ${path.basename(seedDoc.fileName)}`, `事件链: ${path.basename(seedDoc.fileName)}`)
            : panelText('Event Chain Visualizer', '事件链可视化');

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
        this._seedLine = undefined;
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
            text: panelText('Scanning event files...', '扫描事件文件...'),
        });

        try {
            const result = await this._buildEventGraph();
            this._panel.webview.postMessage({
                command: 'render',
                data: result.graph,
                seedIds: result.seedIds,
            });
        } catch (e) {
            ErrorReporter.debug('EventChainPanel', 'Failed to scan events', e);
            this._panel.webview.postMessage({
                command: 'render',
                data: { nodes: [], edges: [] },
                seedIds: [],
            });
        }
    }

    private async _buildEventGraph(): Promise<EventGraphBuildResult> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return { graph: { nodes: [], edges: [] }, seedIds: [] };
        }

        const wsRoot = workspaceFolders[0]!;
        const seedPath = this._seedDocument ? vscode.workspace.asRelativePath(this._seedDocument.uri) : '';
        const rawCatalog = await vscode.commands.executeCommand<unknown>(
            'cwtools.ai.getSemanticCatalog',
            [],
            seedPath ? [seedPath] : [],
        );
        const catalog = parsePdxSemanticCatalog(rawCatalog);
        if (!catalog || catalog.status === 'unavailable') {
            this._panel.webview.postMessage({
                command: 'loading',
                text: panelText(
                    'CWTools semantic data is not ready; reload rules and retry.',
                    'CWTools 语义数据尚未就绪；请重新加载规则后重试。',
                ),
            });
            return { graph: { nodes: [], edges: [] }, seedIds: [] };
        }

        // ── Phase 0: Parse seed document first to get our target event IDs ────
        let seedIds = new Set<string>();
        if (this._seedDocument) {
            const seedContent = this._seedDocument.getText();
            const seedGraph = parseEventFile(seedContent, seedPath, catalog);
            seedIds = new Set(selectEventSeedIds(seedGraph, this._seedLine));
        }

        // If seed document doesn't contain any event definitions, show empty
        if (seedIds.size === 0) {
            this._panel.webview.postMessage({
                command: 'loading',
                text: panelText('The current file does not contain event definitions.', '当前文件不包含事件定义'),
            });
            return { graph: { nodes: [], edges: [] }, seedIds: [] };
        }

        // ── Phase 1: Parse ALL event files to build the full event graph ──────
        this._panel.webview.postMessage({ command: 'loading', text: panelText('Scanning events/ files...', '扫描 events/ 文件...') });

        const eventPaths = catalog.definitionTypes.find(type => type.name === 'event')?.paths ?? [];
        const eventFiles = await this._findSemanticFiles(wsRoot, eventPaths, 500);
const eventGraphs: EventGraph[] = [];

for (const fileUri of eventFiles) {
try {
const doc = await vscode.workspace.openTextDocument(fileUri);
const content = doc.getText();
const relativePath = vscode.workspace.asRelativePath(fileUri);
const graph = parseEventFile(content, relativePath, catalog);
if (graph.nodes.length > 0) {
eventGraphs.push(graph);
}
} catch {
// Skip unreadable files
}
}

this._panel.webview.postMessage({ command: 'loading', text: panelText('Scanning catalog-declared definitions...', '扫描规则目录中声明的定义...') });

const relatedPaths = catalog.definitionTypes
.filter(type => type.name !== 'event')
.flatMap(type => type.paths);
const commonFiles = await this._findSemanticFiles(wsRoot, relatedPaths, 1_500);
for (const fileUri of commonFiles) {
try {
const doc = await vscode.workspace.openTextDocument(fileUri);
const content = doc.getText();
const relativePath = vscode.workspace.asRelativePath(fileUri);
const result = parseCommonFile(content, relativePath, catalog);

const graph: EventGraph = { nodes: [], edges: result.edges };
for (const src of result.externalSources) {
graph.nodes.push({
id: src.id,
type: src.sourceType,
title: src.name,
file: src.file,
line: src.line,
endLine: src.line,
namespace: `__${src.sourceType}__`,
semanticReferences: src.semanticReferences,
definitionIdentity: src.definitionIdentity,
});
}
if (graph.nodes.length > 0 || graph.edges.length > 0) {
eventGraphs.push(graph);
}
} catch {
// Skip
}
}

// ── Phase 2: BFS-expand from seed events (shallow: depth 2) ───────────
this._panel.webview.postMessage({ command: 'loading', text: panelText('Building event relationship graph...', '构建事件关系图...') });

const eventsOnlyGraph = mergeGraphs(eventGraphs);

// Resolve catalog-typed references against the definitions discovered above.
eventsOnlyGraph.edges.push(...buildDefinitionReferenceEdges(eventsOnlyGraph));

// Only root MTTH trigger conditions create implicit event-to-event links.
this._panel.webview.postMessage({ command: 'loading', text: panelText('Building MTTH dependencies...', '构建 MTTH 条件依赖...') });
eventsOnlyGraph.edges.push(...buildMtthConditionEdges(eventsOnlyGraph));

// Traverse the complete high-confidence component. Generic typed read/write
// edges are excluded earlier, so a node cap is sufficient protection against
// malformed or unusually broad definition sets.
const subgraph = extractConnectedSubgraph(
eventsOnlyGraph,
seedIds,
Number.POSITIVE_INFINITY,
EVENT_CHAIN_NODE_LIMIT,
);

return { graph: subgraph, seedIds: Array.from(seedIds) };
}

private async _findSemanticFiles(
    workspaceFolder: vscode.WorkspaceFolder,
    paths: readonly string[],
    limit: number,
): Promise<vscode.Uri[]> {
    const found = new Map<string, vscode.Uri>();
    for (const semanticPath of [...new Set(paths)].sort()) {
        if (!semanticPath || found.size >= limit) break;
        const normalized = semanticPath.replace(/\\/g, '/').replace(/^game\//i, '').replace(/^\/+|\/+$/g, '');
        if (!normalized) continue;
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, `**/${normalized}/**/*.txt`),
            '**/node_modules/**',
            Math.max(1, limit - found.size),
        );
        for (const file of files) found.set(file.toString(), file);
    }
    return [...found.values()].slice(0, limit);
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
            vscode.window.showWarningMessage(panelText(`Could not open file: ${file}`, `无法打开文件: ${file}`));
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
        const lang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
        const title = panelText('Event Chain Visualizer', '事件链可视化');

        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${csp} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>${title}</title>
</head>
<body>
    <div id="toolbar">
        <span class="title">
            <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                <path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/>
            </svg>
            ${title}
        </span>
        <div class="controls">
            <select id="ns-filter" title="${panelText('Namespace filter', '命名空间筛选')}" aria-label="${panelText('Filter by namespace', '按命名空间过滤')}">
                <option value="__all__">${panelText('All namespaces', '全部命名空间')}</option>
            </select>
            <span class="separator">|</span>
            <input type="text" id="search-input" placeholder="${panelText('Search event ID...', '搜索事件 ID...')}" aria-label="${panelText('Search events', '搜索事件')}" />
            <span class="separator">|</span>
            <button id="btn-zoom-in" title="${panelText('Zoom in', '放大')}" aria-label="${panelText('Zoom in', '放大')}">+</button>
            <button id="btn-zoom-out" title="${panelText('Zoom out', '缩小')}" aria-label="${panelText('Zoom out', '缩小')}">−</button>
            <button id="btn-fit" title="${panelText('Fit to window', '适应窗口')}" aria-label="${panelText('Fit to window', '适应窗口')}">⊡</button>
        </div>
    </div>

    <div id="cy-container">
        <div id="loading">${panelText('Scanning event files...', '扫描事件文件...')}</div>
        <div id="empty-state">
            <div style="font-size:24px; opacity:0.3;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg></div>
            <div>${panelText('No catalog-declared event definitions found', '未发现规则声明的事件定义')}</div>
            <div style="font-size:10px;">${panelText('Wait for CWTools rules to load and retry.', '请等待 CWTools 规则加载后重试。')}</div>
        </div>
        <div id="legend">
            <div class="legend-title">${panelText('Legend', '图例')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#fff176;"></span> ${panelText('Seed definition', '种子定义')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#4caf50;"></span> ${panelText('Entry definition', '入口定义')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ab47bc;"></span> ${panelText('Triggered event', '触发事件')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ff7043;border:1px dashed #ff7043;"></span> ${panelText('Trigger dependency', '触发器事件')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#42a5f5;border:1px dashed #42a5f5;"></span> ${panelText('MTTH trigger condition', 'MTTH 触发条件')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#26a69a;border:1px dotted #26a69a;"></span> ${panelText('Definition member', '定义成员')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#ec407a;"></span> ${panelText('Definition creation / activation', '定义创建/启用')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#29b6f6;border:1px dashed #29b6f6;"></span> ${panelText('Definition trigger dependency', '定义触发依赖')}</div>
            <div class="legend-item"><span class="legend-swatch" style="background:#66bb6a;"></span> ${panelText('Definition order', '定义顺序')}</div>
        </div>
        <aside id="details-panel" class="empty" aria-live="polite">
            <div class="details-empty">
                <div class="details-empty-title">${panelText('Select a definition node', '选择定义节点')}</div>
                <div class="details-empty-copy">${panelText('View its source location and catalog-derived relationships.', '查看来源位置及规则目录推导的关系。')}</div>
            </div>
        </aside>
    </div>

    <div id="stats-bar"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
