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
const locale = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
const t = (en: string, zh: string) => locale === 'zh-cn' ? zh : en;

const cy = cytoscape({
    container,
    style: [
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'font-family': 'Segoe UI, system-ui, sans-serif',
                'text-valign': 'center',
                'text-halign': 'center',
                'text-justification': 'left' as any,
                'font-size': '13px',
                'font-weight': 600,
                'color': '#fff',
                'line-height': 1.12,
                'background-color': '#071521',
                'background-opacity': 0.96,
                'border-width': 2,
                'border-color': '#2d8fd7',
                'width': 306,
                'height': 74,
                'shape': 'round-rectangle',
                'padding': '0px' as any,
                'text-wrap': 'wrap' as any,
                'text-max-width': '266px' as any,
                'text-outline-width': 1,
                'text-outline-color': '#02070b',
                'overlay-opacity': 0,
            },
        },
        {
            selector: 'node[?isSeed]',
            style: {
                'border-color': '#fff176',
                'border-width': 3,
            },
        },
        {
            selector: 'node[?isEntry]',
            style: {
                'background-color': '#071f18',
                'border-color': '#59c99c',
                'border-width': 2,
            },
        },
        {
            selector: 'node[?isTriggered]',
            style: {
                'background-color': '#07192a',
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
                'background-color': '#211707',
                'border-color': '#e3a044',
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
                'taxi-direction': 'horizontal' as any,
                'taxi-turn': '15px' as any,
                'taxi-turn-min-distance': 5 as any,
                'arrow-scale': 0.8,
                'font-size': '12px',
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
                'font-size': '12px',
                'width': 170,
                'height': 64,
                'text-max-width': '132px' as any,
            },
        },
        {
            selector: 'node.filtered-out',
            style: { display: 'none' },
        },
        {
            selector: 'edge.filtered-out',
            style: { display: 'none' },
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
let seedIds = new Set<string>();

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
    const id = truncateText(node.id, 34);
    const kind = node.hasMTTH
        ? 'MTTH'
        : node.isFireOnAction
            ? 'On action'
            : node.isTriggeredOnly
                ? t('Triggered', '触发型')
                : t('Event', '事件');
    const type = truncateText(node.type.replace(/_event$/, ''), 18);
    if (!node.isHidden && node.title) {
        return `${id}\n${kind} - ${type}\n${truncateText(node.title, 34)}`;
    }
    return `${id}\n${kind} - ${type}`;
}

function formatExternalLabel(id: string): string {
    const normalized = id.startsWith('[') ? id.replace(/^\[\w+\]\s*/, '') : id;
    return truncateText(normalized, 26);
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
        case 'flag': return t('Flag implicit', 'Flag 隐式');
        case 'on_action_implicit': return t('On action implicit', 'On action 隐式');
        default: return t('Unknown relation', '未知关系');
    }
}

function clearFocusClasses() {
    cy.elements().removeClass('faded highlighted focus-node focus-neighbor focus-edge search-match');
}

function chooseInitialNamespace(nodes: EventNode[]): string {
    const seedNamespaces = new Set(
        nodes
            .filter(node => seedIds.has(node.id) && node.namespace && !node.namespace.startsWith('__'))
            .map(node => node.namespace),
    );
    if (seedNamespaces.size === 1) {
        return [...seedNamespaces][0]!;
    }
    return '__all__';
}

function getVisibleNodes(): cytoscape.NodeCollection {
    return cy.nodes().filter(node => !node.hasClass('filtered-out'));
}

function fitVisible(padding = 80) {
    const visibleNodes = getVisibleNodes();
    if (visibleNodes.length > 0) {
        cy.fit(visibleNodes, padding);
    }
}

function focusReadableStart() {
    const visibleNodes = getVisibleNodes();
    if (visibleNodes.length === 0) return;

    let focusNodes = visibleNodes.filter(node => Boolean(node.data('isSeed')));
    if (focusNodes.length === 0) {
        focusNodes = visibleNodes.filter(node => Boolean(node.data('isEntry')));
    }
    const targetNodes = focusNodes.length > 0
        ? focusNodes.closedNeighborhood().nodes().filter(node => !node.hasClass('filtered-out'))
        : visibleNodes;

    const bbox = targetNodes.length > 0
        ? targetNodes.boundingBox({ includeLabels: true, includeOverlays: false })
        : visibleNodes.boundingBox({ includeLabels: true, includeOverlays: false });
    const availableWidth = Math.max(360, container.clientWidth - 120);
    const columnsInView = container.clientWidth < 900 ? 2.2 : 3.1;
    const targetZoom = Math.max(0.58, Math.min(1, availableWidth / (346 * columnsInView)));
    cy.zoom({
        level: targetZoom,
        renderedPosition: { x: 0, y: 0 },
    });
    cy.pan({
        x: 82 - bbox.x1 * targetZoom,
        y: 82 - bbox.y1 * targetZoom,
    });
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
    if (searchInput.value.trim()) {
        applySearch();
    } else {
        clearFocusClasses();
        updateDetails(null);
    }
}

function getNodeKind(data: Record<string, unknown>): string {
    if (data.isExternal) return t('External entry', '外部入口');
    if (data.isOrphan) return t('External reference', '外部引用');
    if (data.hasMTTH) return t('MTTH event', 'MTTH 事件');
    if (data.isEntry) return t('Entry event', '入口事件');
    if (data.isTriggered) return t('Triggered event', '触发型事件');
    return t('Event', '事件');
}

function updateDetails(node: cytoscape.NodeSingular | null) {
    if (!detailPanel) return;

    if (!node) {
        detailPanel.classList.add('empty');
        detailPanel.innerHTML = `
            <div class="details-empty">
                <div class="details-empty-title">${t('Select an event node', '选择事件节点')}</div>
                <div class="details-empty-copy">${t('View the event title, source location, and incoming/outgoing chain relations.', '查看事件标题、来源位置，以及它在链路中的前后关系。')}</div>
            </div>
        `;
        return;
    }

    const data = node.data();
    const incoming = node.incomers('edge').length;
    const outgoing = node.outgoers('edge').length;
    const canOpen = Boolean(data.file && data.line);
    const badges = [
        data.isSeed ? t('Seed', '种子') : '',
        data.isEntry ? t('Entry', '入口') : '',
        data.isTriggered ? t('Triggered', '触发型') : '',
        data.isHidden ? t('Hidden', '隐藏') : '',
        data.hasMTTH ? 'MTTH' : '',
        data.isExternal || data.isOrphan ? t('External reference', '图外引用') : '',
    ].filter(Boolean);

    detailPanel.classList.remove('empty');
    detailPanel.innerHTML = `
        <div class="details-header">
            <div class="details-kicker">${escapeHtml(getNodeKind(data))}</div>
            <button type="button" class="details-icon-button" data-clear-selection title="${t('Clear selection', '清除选择')}" aria-label="${t('Clear selection', '清除选择')}">×</button>
        </div>
        <div class="details-title">${escapeHtml(data.id)}</div>
        ${data.title ? `<div class="details-subtitle">${escapeHtml(data.title)}</div>` : ''}
        ${badges.length > 0 ? `<div class="details-badges">${badges.map(badge => `<span>${escapeHtml(badge)}</span>`).join('')}</div>` : ''}
        <dl class="details-list">
            <div><dt>${t('Type', '类型')}</dt><dd>${escapeHtml(data.eventType || 'unknown')}</dd></div>
            <div><dt>${t('Namespace', '命名空间')}</dt><dd>${escapeHtml(data.namespace || '-')}</dd></div>
            <div><dt>${t('Source', '来源')}</dt><dd>${canOpen ? `${escapeHtml(data.file)}:${escapeHtml(data.line)}` : t('External reference', '图外引用')}</dd></div>
            <div><dt>${t('Relations', '关系')}</dt><dd>${t(`${incoming} incoming / ${outgoing} outgoing`, `${incoming} 个前序 / ${outgoing} 个后续`)}</dd></div>
        </dl>
        <div class="details-actions">
            <button type="button" data-open-source ${canOpen ? '' : 'disabled'}>${t('Open source file', '打开源文件')}</button>
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

    const matching = getVisibleNodes().filter(n => {
        const id = (n.data('id') || '').toLowerCase();
        const label = (n.data('label') || '').toLowerCase();
        const title = (n.data('title') || '').toLowerCase();
        return id.includes(query) || label.includes(query) || title.includes(query);
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
    cy.fit(neighborhood, 110);
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
    if (!selectedNodeId && !searchInput.value.trim()) {
        focusNode(node, 'direct');
    }
});
cy.on('mouseout', 'node', () => {
    hideTooltip();
    if (!selectedNodeId && !searchInput.value.trim()) {
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
        <div class="tt-file">${data.file && data.line ? `${escapeHtml(data.file)}:${escapeHtml(data.line)}` : t('External reference', '图外引用')}</div>
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
    fitVisible(80);
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
                isSeed: seedIds.has(node.id) || undefined,
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

    edges.forEach((edge, index) => {
        const label = edge.label || edgeTypeLabel(edge.edgeType);
        elements.push({
            data: {
                id: `${edge.source}→${edge.target}:${edge.edgeType}:${index}`,
                source: edge.source,
                target: edge.target,
                edgeType: edge.edgeType,
                label,
                shortLabel: truncateText(label, 32),
                isPrimary: primaryEdgeTypes.has(edge.edgeType) || undefined,
                isImplicit: implicitEdgeTypes.has(edge.edgeType) || undefined,
            },
        });
    });

    cy.add(elements);

    // Layout — ELK (layered/hierarchical) for clean DAG visualization
    const layout = cy.layout({
        name: 'elk',
        animate: false,
        fit: false,
        padding: 80,
        elk: {
            algorithm: 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'POLYLINE',
            'elk.spacing.componentComponent': 100,
            'elk.spacing.nodeNode': 48,
            'elk.spacing.edgeNode': 36,
            'elk.layered.spacing.nodeNodeBetweenLayers': 120,
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        },
    } as any);
    cy.one('layoutstop', () => {
        applySearch();
        if (!searchInput.value.trim()) {
            focusReadableStart();
        }
    });
    
    // Run layout in the next frame to prevent race condition where ELK reads 0x0 node dimensions
    requestAnimationFrame(() => {
        layout.run();
    });

    // Update stats
    statsBar.innerHTML = `
        <span>${t('Nodes', '节点')}: ${nodes.length}</span>
        <span>${t('Edges', '边')}: ${edges.length}</span>
        <span>${t('Seed events', '种子事件')}: ${seedIds.size}</span>
        <span>${t('Namespace', '命名空间')}: ${currentNamespace === '__all__' ? t('All', '全部') : currentNamespace}</span>
    `;
}

// ─── Message handler ─────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    switch (msg.command) {
        case 'render': {
            fullGraph = msg.data as EventGraph;
            seedIds = new Set(Array.isArray(msg.seedIds) ? msg.seedIds : []);
            loadingEl.classList.add('hidden');

            // Populate namespace filter
            const namespaces = [...new Set(fullGraph.nodes.map(n => n.namespace))].sort();
            nsSelect.innerHTML = `<option value="__all__">${t('All namespaces', '全部命名空间')}</option>`;
            for (const ns of namespaces) {
                const opt = document.createElement('option');
                opt.value = ns;
                opt.textContent = ns;
                nsSelect.appendChild(opt);
            }
            currentNamespace = chooseInitialNamespace(fullGraph.nodes);
            nsSelect.value = currentNamespace;

            renderGraph();
            break;
        }
        case 'loading': {
            loadingEl.classList.remove('hidden');
            loadingEl.textContent = msg.text || t('Scanning event files...', '扫描事件文件...');
            break;
        }
    }
});

// Signal ready
vscode.postMessage({ command: 'ready' });
