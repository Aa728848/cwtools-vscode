/**
 * Event Chain Preview — Webview Script
 *
 * Uses cytoscape.js to render a directed graph of Stellaris event chains.
 * Receives data from the extension host via postMessage.
 *
 * Features:
 * - Auto-layout with ELK (layered/hierarchical)
 * - Select-to-inspect node details
 * - Namespace filtering
 * - Search by event ID
 * - Zoom/fit controls
 * - Hover tooltip with event details
 */

import cytoscape from 'cytoscape';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- cytoscape-elk has no TS declarations
import elk from 'cytoscape-elk';

cytoscape.use(elk);

// VS Code API handle
declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

// ─── Types (mirrors eventChainParser.ts) ─────────────────────────────────────

interface EventNode {
    id: string;
    type: string;
    title?: string;
    isTriggeredOnly: boolean;
    file: string;
    line: number;
    endLine: number;
    namespace: string;
    isFireOnAction: boolean;
    isHidden: boolean;
    hasMTTH: boolean;
}

interface EventEdge {
    source: string;
    target: string;
    edgeType: 'option' | 'immediate' | 'after' | 'effect' | 'on_action' | 'decision' | 'scripted' | 'flag' | 'on_action_implicit' | 'unknown';
    label?: string;
}

interface EventGraph {
    nodes: EventNode[];
    edges: EventEdge[];
}

// ─── Cytoscape initialization ────────────────────────────────────────────────

const container = document.getElementById('cy-container')!;
const loadingEl = document.getElementById('loading')!;
const emptyEl = document.getElementById('empty-state')!;
const statsBar = document.getElementById('stats-bar')!;
const nsSelect = document.getElementById('ns-filter') as HTMLSelectElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const detailPanel = document.getElementById('details-panel') as HTMLDivElement | null;

const cy = cytoscape({
    container,
    style: [
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'text-valign': 'center',
                'text-halign': 'center',
                'font-size': '11px',
                'font-weight': 600,
                'color': '#fff',
                'background-color': '#4d4d4d',
                'border-width': 1,
                'border-color': '#707070',
                'width': 'label',
                'height': 38,
                'shape': 'round-rectangle',
                'padding': '14px' as any,
                'text-wrap': 'wrap' as any,
                'text-max-width': '220px' as any,
                'text-outline-width': 1,
                'text-outline-color': '#1b1b1b',
            },
        },
        {
            selector: 'node[?isEntry]',
            style: {
                'background-color': '#2e7d32',
                'border-color': '#4caf50',
                'border-width': 2,
            },
        },
        {
            selector: 'node[?isTriggered]',
            style: {
                'background-color': '#1565c0',
                'border-color': '#42a5f5',
            },
        },
        {
            selector: 'node[?isOrphan]',
            style: {
                'background-color': '#6d4c41',
                'border-color': '#8d6e63',
            },
        },
        {
            selector: 'node:selected',
            style: {
                'border-color': '#e8c840',
                'border-width': 3,
                'background-color': '#42506a',
            },
        },
        {
            selector: 'node[?isHidden]',
            style: {
                'opacity': 0.65,
                'border-style': 'dashed' as any,
            },
        },
        {
            selector: 'node[?hasMTTH]',
            style: {
                'background-color': '#5d4037',
                'border-color': '#8d6e63',
                'border-style': 'dashed' as any,
            },
        },
        {
            selector: 'edge',
            style: {
                'width': 1.5,
                'line-color': '#666',
                'target-arrow-color': '#666',
                'target-arrow-shape': 'triangle',
                'curve-style': 'taxi',
                'taxi-direction': 'auto' as any,
                'taxi-turn': '15px' as any,
                'taxi-turn-min-distance': 5 as any,
                'arrow-scale': 0.8,
                'font-size': '10px',
                'font-weight': 500,
                'color': '#c7c7c7',
                'text-background-color': '#1f1f1f',
                'text-background-opacity': 0.85,
                'text-background-padding': '3px' as any,
                'text-rotation': 'autorotate',
                'opacity': 0.7,
            },
        },
        {
            selector: 'edge[?isPrimary]',
            style: {
                'width': 2.2,
                'opacity': 0.9,
            },
        },
        {
            selector: 'edge[?isImplicit]',
            style: {
                'width': 1,
                'opacity': 0.45,
            },
        },
        {
            selector: 'edge[edgeType="option"]',
            style: { 'line-color': '#e8c840', 'target-arrow-color': '#e8c840' },
        },
        {
            selector: 'edge[edgeType="immediate"]',
            style: { 'line-color': '#4caf50', 'target-arrow-color': '#4caf50' },
        },
        {
            selector: 'edge[edgeType="after"]',
            style: { 'line-color': '#ff9800', 'target-arrow-color': '#ff9800' },
        },
        {
            selector: 'edge[edgeType="effect"]',
            style: { 'line-color': '#ab47bc', 'target-arrow-color': '#ab47bc' },
        },
        {
            selector: 'edge[edgeType="on_action"]',
            style: { 'line-color': '#e91e63', 'target-arrow-color': '#e91e63', 'line-style': 'dashed' as any },
        },
        {
            selector: 'edge[edgeType="decision"]',
            style: { 'line-color': '#00bcd4', 'target-arrow-color': '#00bcd4', 'line-style': 'dashed' as any },
        },
        {
            selector: 'edge[edgeType="scripted"]',
            style: { 'line-color': '#009688', 'target-arrow-color': '#009688', 'line-style': 'dashed' as any },
        },
        {
            selector: 'edge[edgeType="flag"]',
            style: { 'line-color': '#ff7043', 'target-arrow-color': '#ff7043', 'line-style': 'dotted' as any, 'width': 1 },
        },
        {
            selector: 'edge[edgeType="on_action_implicit"]',
            style: { 'line-color': '#ec407a', 'target-arrow-color': '#ec407a', 'line-style': 'dotted' as any, 'width': 1 },
        },
        {
            selector: 'node[?isExternal]',
            style: {
                'shape': 'diamond',
                'background-color': '#78909c',
                'border-color': '#b0bec5',
                'border-width': 2,
                'font-size': '10px',
            },
        },
        {
            selector: '.highlighted',
            style: { 'opacity': 1 },
        },
        {
            selector: '.focus-node',
            style: {
                'border-color': '#f2d85c',
                'border-width': 4,
                'z-index': 20,
            },
        },
        {
            selector: '.focus-neighbor',
            style: {
                'border-color': '#9bbcff',
                'border-width': 2,
                'z-index': 12,
            },
        },
        {
            selector: '.focus-edge',
            style: {
                'label': 'data(shortLabel)',
                'width': 3,
                'opacity': 1,
                'z-index': 18,
            },
        },
        {
            selector: '.search-match',
            style: {
                'border-color': '#ffcf4a',
                'border-width': 4,
                'z-index': 24,
            },
        },
        {
            selector: '.faded',
            style: { 'opacity': 0.12 },
        },
    ],
    layout: { name: 'preset' },
    minZoom: 0.05,
    maxZoom: 8,
    wheelSensitivity: 0.8,
});

// ─── State ───────────────────────────────────────────────────────────────────

let fullGraph: EventGraph = { nodes: [], edges: [] };
let currentNamespace = '__all__';
let tooltip: HTMLDivElement | null = null;
let selectedNodeId: string | null = null;

// ─── UI helpers ──────────────────────────────────────────────────────────────

const primaryEdgeTypes = new Set<EventEdge['edgeType']>(['option', 'immediate', 'after', 'effect']);
const implicitEdgeTypes = new Set<EventEdge['edgeType']>(['flag', 'on_action_implicit']);

function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch] ?? ch));
}

function truncateText(value: string | undefined, maxLength: number): string {
    if (!value) return '';
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatNodeLabel(node: EventNode): string {
    const id = truncateText(node.id, 42);
    if (!node.isHidden && node.title) {
        return `${id}\n${truncateText(node.title, 48)}`;
    }
    return id;
}

function formatExternalLabel(id: string): string {
    const normalized = id.startsWith('[') ? id.replace(/^\[\w+\]\s*/, '') : id;
    return truncateText(normalized, 36);
}

function edgeTypeLabel(edgeType: EventEdge['edgeType'] | string): string {
    switch (edgeType) {
        case 'option': return 'Option';
        case 'immediate': return 'Immediate';
        case 'after': return 'After';
        case 'effect': return 'Effect';
        case 'on_action': return 'On action';
        case 'decision': return 'Decision';
        case 'scripted': return 'Scripted';
        case 'flag': return 'Flag 隐式';
        case 'on_action_implicit': return 'On action 隐式';
        default: return '未知关系';
    }
}

function clearFocusClasses() {
    cy.elements().removeClass('faded highlighted focus-node focus-neighbor focus-edge search-match');
}

function focusNode(node: cytoscape.NodeSingular, scope: 'direct' | 'flow' = 'flow') {
    clearFocusClasses();

    const related = scope === 'direct'
        ? node.closedNeighborhood()
        : node.predecessors().union(node.successors()).union(node);
    cy.elements().addClass('faded');
    related.removeClass('faded').addClass('highlighted');
    related.edges().addClass('focus-edge');
    node.addClass('focus-node');

    related.nodes().forEach((relatedNode) => {
        if (relatedNode.id() !== node.id()) {
            relatedNode.addClass('focus-neighbor');
        }
    });
}

function selectNode(node: cytoscape.NodeSingular) {
    selectedNodeId = node.id();
    cy.nodes().unselect();
    node.select();
    focusNode(node);
    updateDetails(node);
}

function clearSelection() {
    selectedNodeId = null;
    cy.nodes().unselect();
    clearFocusClasses();
    updateDetails(null);
}

function getNodeKind(data: Record<string, unknown>): string {
    if (data.isExternal) return '外部入口';
    if (data.isOrphan) return '外部引用';
    if (data.hasMTTH) return 'MTTH 事件';
    if (data.isEntry) return '入口事件';
    if (data.isTriggered) return '触发型事件';
    return '事件';
}

function updateDetails(node: cytoscape.NodeSingular | null) {
    if (!detailPanel) return;

    if (!node) {
        detailPanel.classList.add('empty');
        detailPanel.innerHTML = `
            <div class="details-empty">
                <div class="details-empty-title">选择事件节点</div>
                <div class="details-empty-copy">查看事件标题、来源位置，以及它在链路中的前后关系。</div>
            </div>
        `;
        return;
    }

    const data = node.data();
    const incoming = node.incomers('edge').length;
    const outgoing = node.outgoers('edge').length;
    const canOpen = Boolean(data.file && data.line);
    const badges = [
        data.isEntry ? '入口' : '',
        data.isTriggered ? '触发型' : '',
        data.isHidden ? '隐藏' : '',
        data.hasMTTH ? 'MTTH' : '',
        data.isExternal || data.isOrphan ? '图外引用' : '',
    ].filter(Boolean);

    detailPanel.classList.remove('empty');
    detailPanel.innerHTML = `
        <div class="details-header">
            <div class="details-kicker">${escapeHtml(getNodeKind(data))}</div>
            <button type="button" class="details-icon-button" data-clear-selection title="清除选择" aria-label="清除选择">×</button>
        </div>
        <div class="details-title">${escapeHtml(data.id)}</div>
        ${data.title ? `<div class="details-subtitle">${escapeHtml(data.title)}</div>` : ''}
        ${badges.length > 0 ? `<div class="details-badges">${badges.map(badge => `<span>${escapeHtml(badge)}</span>`).join('')}</div>` : ''}
        <dl class="details-list">
            <div><dt>类型</dt><dd>${escapeHtml(data.eventType || 'unknown')}</dd></div>
            <div><dt>命名空间</dt><dd>${escapeHtml(data.namespace || '-')}</dd></div>
            <div><dt>来源</dt><dd>${canOpen ? `${escapeHtml(data.file)}:${escapeHtml(data.line)}` : '图外引用'}</dd></div>
            <div><dt>关系</dt><dd>${incoming} 个前序 / ${outgoing} 个后续</dd></div>
        </dl>
        <div class="details-actions">
            <button type="button" data-open-source ${canOpen ? '' : 'disabled'}>打开源文件</button>
        </div>
    `;
}

function applySearch() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
        if (selectedNodeId) {
            const selectedNode = cy.getElementById(selectedNodeId) as cytoscape.NodeSingular;
            if (selectedNode.length > 0) {
                focusNode(selectedNode);
                return;
            }
        }
        clearFocusClasses();
        return;
    }

    selectedNodeId = null;
    cy.nodes().unselect();
    clearFocusClasses();
    cy.elements().addClass('faded');

    const matching = cy.nodes().filter(n => {
        const id = (n.data('id') || '').toLowerCase();
        const title = (n.data('title') || '').toLowerCase();
        return id.includes(query) || title.includes(query);
    });

    if (matching.length === 0) {
        updateDetails(null);
        return;
    }

    const neighborhood = matching.closedNeighborhood();
    neighborhood.removeClass('faded').addClass('highlighted');
    matching.addClass('search-match');

    let firstMatch: cytoscape.NodeSingular | null = null;
    matching.forEach((n) => {
        if (!firstMatch) firstMatch = n;
    });
    updateDetails(firstMatch);
    cy.fit(neighborhood, 100);
}

// ─── Event handlers ──────────────────────────────────────────────────────────

// Click node → inspect details and keep the relevant chain highlighted.
cy.on('tap', 'node', (evt) => {
    selectNode(evt.target);
});

cy.on('dbltap', 'node', (evt) => {
    const node = evt.target;
    const file = node.data('file');
    const line = node.data('line');
    if (file && line) {
        vscode.postMessage({ command: 'goToEvent', file, line });
    }
});

cy.on('tap', (evt) => {
    if (evt.target === cy) {
        clearSelection();
    }
});

// Hover → show tooltip and preview connected nodes when no node is pinned.
cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    showTooltip(node);
    if (!selectedNodeId) {
        focusNode(node, 'direct');
    }
});
cy.on('mouseout', 'node', () => {
    hideTooltip();
    if (!selectedNodeId) {
        clearFocusClasses();
    }
});

detailPanel?.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const openButton = target.closest('[data-open-source]') as HTMLButtonElement | null;
    if (openButton && !openButton.disabled && selectedNodeId) {
        const node = cy.getElementById(selectedNodeId);
        const file = node.data('file');
        const line = node.data('line');
        if (file && line) {
            vscode.postMessage({ command: 'goToEvent', file, line });
        }
        return;
    }

    if (target.closest('[data-clear-selection]')) {
        clearSelection();
    }
});

// ─── Subtree dragging ────────────────────────────────────────────────────────

let dragPrevPos: cytoscape.Position | null = null;
let draggedSubtree: cytoscape.NodeCollection | null = null;

cy.on('grab', 'node', (evt) => {
    const node = evt.target;
    dragPrevPos = { ...node.position() };
    // Get all descendant nodes
    draggedSubtree = node.successors().nodes();
});

cy.on('drag', 'node', (evt) => {
    if (!dragPrevPos || !draggedSubtree || draggedSubtree.length === 0) return;
    const node = evt.target;
    const currPos = node.position();
    const dx = currPos.x - dragPrevPos.x;
    const dy = currPos.y - dragPrevPos.y;
    
    if (dx === 0 && dy === 0) return;
    
    draggedSubtree.forEach((child) => {
        const p = child.position();
        child.position({ x: p.x + dx, y: p.y + dy });
    });
    
    dragPrevPos = { ...currPos };
});

cy.on('free', 'node', () => {
    dragPrevPos = null;
    draggedSubtree = null;
});

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function showTooltip(node: cytoscape.NodeSingular) {
    hideTooltip();
    const data = node.data();
    tooltip = document.createElement('div');
    tooltip.className = 'cy-tooltip';
    tooltip.innerHTML = `
        <div class="tt-id">${escapeHtml(data.id)}</div>
        <div class="tt-type">${escapeHtml(getNodeKind(data))} · ${escapeHtml(data.eventType || 'unknown')}</div>
        ${data.title ? `<div class="tt-title">${escapeHtml(data.title)}</div>` : ''}
        <div class="tt-file">${data.file && data.line ? `${escapeHtml(data.file)}:${escapeHtml(data.line)}` : '图外引用'}</div>
    `;
    document.body.appendChild(tooltip);

    // Position near cursor
    const pos = node.renderedPosition();
    const bbox = container.getBoundingClientRect();
    tooltip.style.left = `${bbox.left + pos.x + 10}px`;
    tooltip.style.top = `${bbox.top + pos.y - 40}px`;
}

function hideTooltip() {
    if (tooltip) {
        tooltip.remove();
        tooltip = null;
    }
}

// ─── Controls ────────────────────────────────────────────────────────────────

document.getElementById('btn-fit')?.addEventListener('click', () => {
    cy.fit(undefined, 80);
});

document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 } });
});

document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 } });
});

// Namespace filter
nsSelect?.addEventListener('change', () => {
    currentNamespace = nsSelect.value;
    searchInput.value = '';
    renderGraph();
});

// Search
searchInput?.addEventListener('input', () => {
    applySearch();
});

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderGraph() {
    cy.elements().remove();
    selectedNodeId = null;
    updateDetails(null);

    // Filter by namespace
    let nodes = fullGraph.nodes;
    if (currentNamespace !== '__all__') {
        nodes = nodes.filter(n => n.namespace === currentNamespace);
    }
    const nodeIds = new Set(nodes.map(n => n.id));

    // Filter edges: include if EITHER endpoint is visible (to show cross-namespace connections)
    const edges = fullGraph.edges.filter(e => nodeIds.has(e.source) || nodeIds.has(e.target));

    // Collect all referenced IDs that aren't in our node set
    const allReferencedIds = new Set<string>();
    for (const e of edges) {
        if (!nodeIds.has(e.source)) allReferencedIds.add(e.source);
        if (!nodeIds.has(e.target)) allReferencedIds.add(e.target);
    }

    if (nodes.length === 0) {
        emptyEl.classList.add('visible');
        detailPanel?.classList.add('hidden');
        statsBar.textContent = '';
        return;
    }
    emptyEl.classList.remove('visible');
    detailPanel?.classList.remove('hidden');

    // Find which nodes have no incoming edges (entry points)
    const hasIncoming = new Set(edges.map(e => e.target));

    // Build cytoscape elements
    const elements: cytoscape.ElementDefinition[] = [];

    for (const node of nodes) {
        const isEntry = node.isFireOnAction || (!node.isTriggeredOnly && !hasIncoming.has(node.id));
        elements.push({
            data: {
                id: node.id,
                label: formatNodeLabel(node),
                eventType: node.type,
                title: node.title,
                file: node.file,
                line: node.line,
                endLine: node.endLine,
                namespace: node.namespace,
                isEntry: isEntry || undefined,
                isTriggered: node.isTriggeredOnly || undefined,
                isHidden: node.isHidden || undefined,
                hasMTTH: node.hasMTTH || undefined,
                isOrphan: false,
            },
        });
    }

    // Add phantom/external nodes for references not in our node set
    for (const id of allReferencedIds) {
        if (!nodeIds.has(id)) {
            const isExternalSource = id.startsWith('[');
            elements.push({
                data: {
                    id,
                    label: formatExternalLabel(id),
                    eventType: isExternalSource ? 'external_source' : 'external',
                    isOrphan: !isExternalSource || undefined,
                    isExternal: isExternalSource || undefined,
                    isEntry: isExternalSource || undefined,
                },
            });
            nodeIds.add(id);
        }
    }

    for (const edge of edges) {
        const label = edge.label || edgeTypeLabel(edge.edgeType);
        elements.push({
            data: {
                id: `${edge.source}→${edge.target}`,
                source: edge.source,
                target: edge.target,
                edgeType: edge.edgeType,
                label,
                shortLabel: truncateText(label, 32),
                isPrimary: primaryEdgeTypes.has(edge.edgeType) || undefined,
                isImplicit: implicitEdgeTypes.has(edge.edgeType) || undefined,
            },
        });
    }

    cy.add(elements);

    // Layout — ELK (layered/hierarchical) for clean DAG visualization
    const direction = container.clientWidth > container.clientHeight * 1.12 ? 'RIGHT' : 'DOWN';
    const layout = cy.layout({
        name: 'elk',
        animate: false,
        fit: true,
        padding: 80,
        nodeDimensionsIncludeLabels: true,
        elk: {
            algorithm: 'layered',
            'elk.direction': direction,
            'elk.aspectRatio': direction === 'RIGHT' ? 1.6 : 0.65,
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.spacing.componentComponent': 72,
            'elk.spacing.nodeNode': 44,
            'elk.spacing.edgeNode': 32,
            'elk.layered.spacing.nodeNodeBetweenLayers': 92,
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        },
    } as any);
    cy.one('layoutstop', () => {
        cy.fit(undefined, 80);
        applySearch();
    });
    layout.run();

    // Update stats
    statsBar.innerHTML = `
        <span>节点: ${nodes.length}</span>
        <span>边: ${edges.length}</span>
        <span>命名空间: ${currentNamespace === '__all__' ? '全部' : currentNamespace}</span>
    `;
}

// ─── Message handler ─────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    switch (msg.command) {
        case 'render': {
            fullGraph = msg.data as EventGraph;
            loadingEl.classList.add('hidden');

            // Populate namespace filter
            const namespaces = [...new Set(fullGraph.nodes.map(n => n.namespace))].sort();
            nsSelect.innerHTML = '<option value="__all__">全部命名空间</option>';
            for (const ns of namespaces) {
                const opt = document.createElement('option');
                opt.value = ns;
                opt.textContent = ns;
                nsSelect.appendChild(opt);
            }

            renderGraph();
            break;
        }
        case 'loading': {
            loadingEl.classList.remove('hidden');
            loadingEl.textContent = msg.text || '扫描事件文件...';
            break;
        }
    }
});

// Signal ready
vscode.postMessage({ command: 'ready' });
