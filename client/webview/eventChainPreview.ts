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
    file: string;
    line: number;
    endLine: number;
    namespace: string;
    isTriggeredOnly?: boolean;
    isHidden?: boolean;
    meanTimeToHappen?: boolean;
    entryStatus?: 'triggered_only' | 'mtth_present' | 'referenced' | 'unknown' | 'external_definition';
}

type EventConditionRelation = 'requires' | 'alternative' | 'blocks' | 'complex';

interface EventEdge {
    source: string;
    target: string;
    edgeType: 'effect' | 'trigger' | 'mtth_condition' | 'definition' | 'definition_effect' | 'definition_trigger' | 'sequence' | 'unknown';
    label?: string;
    conditionRelation?: EventConditionRelation;
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
const LARGE_GRAPH_NODE_THRESHOLD = 450;
const LARGE_GRAPH_EDGE_THRESHOLD = 1_600;
const MAX_RELATION_LINKS_PER_DIRECTION = 12;
const MAX_SUBTREE_DRAG_NODES = 250;
const NODE_WIDTH = 252;
const NODE_HEIGHT = 66;

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
                'width': NODE_WIDTH,
                'height': NODE_HEIGHT,
                'shape': 'round-rectangle',
                'padding': '0px' as any,
                'text-wrap': 'wrap' as any,
                'text-max-width': '218px' as any,
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
            selector: 'edge[edgeType="effect"]',
            style: { 'line-color': '#ab47bc', 'target-arrow-color': '#ab47bc' },
        },
        {
            selector: 'edge[edgeType="trigger"]',
            style: { 'line-color': '#ff7043', 'target-arrow-color': '#ff7043', 'line-style': 'dashed' as any, 'width': 1.8 },
        },
        {
            selector: 'edge[edgeType="mtth_condition"]',
            style: { 'line-color': '#42a5f5', 'target-arrow-color': '#42a5f5', 'line-style': 'dashed' as any, 'width': 1.5 },
        },
        {
            selector: 'edge[edgeType="definition"]',
            style: { 'line-color': '#26a69a', 'target-arrow-color': '#26a69a', 'line-style': 'dotted' as any, 'width': 1.4 },
        },
        {
            selector: 'edge[edgeType="definition_effect"]',
            style: { 'line-color': '#ec407a', 'target-arrow-color': '#ec407a', 'width': 2 },
        },
        {
            selector: 'edge[edgeType="definition_trigger"]',
            style: { 'line-color': '#29b6f6', 'target-arrow-color': '#29b6f6', 'line-style': 'dashed' as any, 'width': 1.6 },
        },
        {
            selector: 'edge[edgeType="sequence"]',
            style: { 'line-color': '#66bb6a', 'target-arrow-color': '#66bb6a', 'width': 2.2 },
        },
        {
            selector: 'edge[conditionRelation="alternative"]',
            style: { 'line-color': '#f9a825', 'target-arrow-color': '#f9a825' },
        },
        {
            selector: 'edge[conditionRelation="blocks"]',
            style: { 'line-color': '#ef5350', 'target-arrow-color': '#ef5350' },
        },
        {
            selector: 'edge[conditionRelation="complex"]',
            style: { 'line-color': '#ab47bc', 'target-arrow-color': '#ab47bc', 'line-style': 'dotted' as any },
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
    hideEdgesOnViewport: true,
    textureOnViewport: true,
});

// ─── State ───────────────────────────────────────────────────────────────────

let fullGraph: EventGraph = { nodes: [], edges: [] };
let currentNamespace = '__all__';
let tooltip: HTMLDivElement | null = null;
let selectedNodeId: string | null = null;
let seedIds = new Set<string>();
let largeGraphMode = false;
let activeLayout: cytoscape.Layouts | null = null;
let layoutFrame: number | null = null;
let renderGeneration = 0;
let expandedRelationNodeId: string | null = null;
const expandedRelationDirections = new Set<'incoming' | 'outgoing'>();

// ─── UI helpers ──────────────────────────────────────────────────────────────

const primaryEdgeTypes = new Set<EventEdge['edgeType']>(['effect', 'trigger', 'definition_effect', 'sequence']);
const implicitEdgeTypes = new Set<EventEdge['edgeType']>(['mtth_condition', 'definition', 'definition_trigger']);

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
    const type = truncateText(node.type, 24);
    if (node.title) {
        return `${id}\n${type}\n${truncateText(node.title, 34)}`;
    }
    return `${id}\n${type}`;
}

function formatExternalLabel(id: string): string {
    const normalized = id.startsWith('[') ? id.replace(/^\[\w+\]\s*/, '') : id;
    return truncateText(normalized, 26);
}

function edgeTypeLabel(edgeType: EventEdge['edgeType'] | string): string {
    switch (edgeType) {
        case 'effect': return 'Effect';
        case 'trigger': return t('Trigger dependency', '触发器事件');
        case 'mtth_condition': return t('MTTH trigger condition', 'MTTH 触发条件');
        case 'definition': return t('Definition member', '定义成员');
        case 'definition_effect': return t('Definition creation / activation', '定义创建/启用');
        case 'definition_trigger': return t('Definition trigger dependency', '定义触发依赖');
        case 'sequence': return t('Definition order', '定义顺序');
        default: return t('Unknown relation', '未知关系');
    }
}

function conditionRelationLabel(relation: EventConditionRelation | undefined): string {
    switch (relation) {
        case 'requires': return t('requires', '需要');
        case 'alternative': return t('one possible condition', '可选条件之一');
        case 'blocks': return t('blocks when present', '存在时阻断');
        case 'complex': return t('compound condition', '复合条件');
        default: return '';
    }
}

function edgeDisplayLabel(edge: EventEdge): string {
    const evidence = edge.label || edgeTypeLabel(edge.edgeType);
    const relation = edge.edgeType === 'mtth_condition'
        ? conditionRelationLabel(edge.conditionRelation)
        : '';
    return relation ? `${relation}: ${evidence}` : evidence;
}

function clearFocusClasses() {
    cy.$('.faded, .highlighted, .focus-node, .focus-neighbor, .focus-edge, .search-match')
        .removeClass('faded highlighted focus-node focus-neighbor focus-edge search-match');
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

    const focusNodes = visibleNodes.filter(node => Boolean(node.data('isSeed')));
    const anchor = (focusNodes.length > 0 ? focusNodes[0] : visibleNodes[0]) as cytoscape.NodeSingular | undefined;
    if (anchor) revealNode(anchor);
}

function focusNode(
    node: cytoscape.NodeSingular,
    scope: 'direct' | 'flow' = 'direct',
    fadeUnrelated = true,
) {
    const related = scope === 'direct'
        ? node.closedNeighborhood()
        : node.predecessors().union(node.successors()).union(node);
    cy.batch(() => {
        clearFocusClasses();
        if (fadeUnrelated) cy.elements().addClass('faded');
        related.removeClass('faded').addClass('highlighted');
        related.edges().addClass('focus-edge');
        node.addClass('focus-node');

        related.nodes().forEach((relatedNode) => {
            if (relatedNode.id() !== node.id()) {
                relatedNode.addClass('focus-neighbor');
            }
        });
    });
}

function revealNode(node: cytoscape.NodeSingular) {
    const neighborhood = node.closedNeighborhood().filter(element => !element.hasClass('filtered-out'));
    const target = neighborhood.nodes().length <= 18 ? neighborhood : node;
    cy.stop();
    cy.fit(target, 96);
    if (cy.zoom() > 1.05) {
        cy.zoom(1.05);
        cy.center(node);
    }
}

function selectNode(node: cytoscape.NodeSingular, reveal = false) {
    if (selectedNodeId !== node.id()) {
        expandedRelationNodeId = null;
        expandedRelationDirections.clear();
    }
    selectedNodeId = node.id();
    cy.nodes().unselect();
    node.select();
    focusNode(node);
    updateDetails(node);
    if (reveal) revealNode(node);
}

function clearSelection() {
    selectedNodeId = null;
    expandedRelationNodeId = null;
    expandedRelationDirections.clear();
    cy.nodes().unselect();
    if (searchInput.value.trim()) {
        applySearch();
    } else {
        clearFocusClasses();
        updateDetails(null);
    }
}

function getNodeKind(data: Record<string, unknown>): string {
    if (data.isExternal) return t('External definition', '外部定义');
    if (data.isOrphan) return t('External reference', '外部引用');
    return t('Definition', '定义');
}

interface DirectRelationLink {
    id: string;
    title: string;
    evidence: string[];
}

function collectDirectRelationLinks(
    node: cytoscape.NodeSingular,
    direction: 'incoming' | 'outgoing',
): DirectRelationLink[] {
    const relations = new Map<string, DirectRelationLink>();
    const edges = direction === 'incoming' ? node.incomers('edge') : node.outgoers('edge');
    edges.forEach(edge => {
        const relatedNode = direction === 'incoming' ? edge.source() : edge.target();
        const id = relatedNode.id();
        const existing = relations.get(id) ?? {
            id,
            title: String(relatedNode.data('title') || relatedNode.data('label') || id).replace(/\n/g, ' · '),
            evidence: [],
        };
        const evidence = String(edge.data('shortLabel') || edge.data('label') || edgeTypeLabel(edge.data('edgeType')));
        if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
        relations.set(id, existing);
    });
    return [...relations.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function renderRelationLinks(
    nodeId: string,
    heading: string,
    direction: 'incoming' | 'outgoing',
    links: DirectRelationLink[],
): string {
    const expanded = expandedRelationNodeId === nodeId && expandedRelationDirections.has(direction);
    const shown = expanded ? links : links.slice(0, MAX_RELATION_LINKS_PER_DIRECTION);
    const arrow = direction === 'incoming' ? '←' : '→';
    return `
        <section class="details-relations">
            <div class="details-relations-heading">
                <span>${escapeHtml(heading)}</span>
                <span class="details-relations-count">${links.length}</span>
            </div>
            ${shown.length > 0 ? shown.map(link => `
                <button type="button" class="details-relation-link" data-select-node-id="${escapeHtml(link.id)}"
                    title="${escapeHtml(link.evidence.join(' · '))}">
                    <span class="details-relation-arrow">${arrow}</span>
                    <span>
                        <strong>${escapeHtml(link.id)}</strong>
                        ${link.title !== link.id ? `<small>${escapeHtml(link.title)}</small>` : ''}
                    </span>
                </button>
            `).join('') : `<div class="details-relations-empty">${t('None', '无')}</div>`}
            ${links.length > shown.length
                ? `<button type="button" class="details-relations-more" data-expand-relations="${direction}"
                    data-relation-node-id="${escapeHtml(nodeId)}">${t(`Show ${links.length - shown.length} more`, `显示其余 ${links.length - shown.length} 个`)}</button>`
                : ''}
        </section>
    `;
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
    const incomingLinks = collectDirectRelationLinks(node, 'incoming');
    const outgoingLinks = collectDirectRelationLinks(node, 'outgoing');
    const canOpen = Boolean(data.file && data.line);
    const badges = [
        data.isSeed ? t('Seed', '种子') : '',
        data.entryStatus === 'mtth_present' ? t('MTTH present', '包含 MTTH') : '',
        data.entryStatus === 'triggered_only' ? t('Triggered only', '仅被触发') : '',
        data.entryStatus === 'unknown' ? t('Entry evidence unknown', '入口证据未知') : '',
        data.meanTimeToHappen ? 'MTTH' : '',
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
        <div class="details-relation-grid">
            ${renderRelationLinks(node.id(), t('Upstream', '上游节点'), 'incoming', incomingLinks)}
            ${renderRelationLinks(node.id(), t('Downstream', '下游节点'), 'outgoing', outgoingLinks)}
        </div>
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
    expandedRelationNodeId = null;
    expandedRelationDirections.clear();
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
    selectNode(evt.target, true);
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
        focusNode(node, 'direct', !largeGraphMode);
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

    const relationButton = target.closest('[data-select-node-id]') as HTMLButtonElement | null;
    const relationNodeId = relationButton?.dataset.selectNodeId;
    if (relationNodeId) {
        const relationNode = cy.getElementById(relationNodeId) as cytoscape.NodeSingular;
        if (relationNode.length > 0) selectNode(relationNode, true);
        return;
    }

    const expandButton = target.closest('[data-expand-relations]') as HTMLButtonElement | null;
    const direction = expandButton?.dataset.expandRelations;
    const relationOwnerId = expandButton?.dataset.relationNodeId;
    if ((direction === 'incoming' || direction === 'outgoing') && relationOwnerId) {
        const relationOwner = cy.getElementById(relationOwnerId) as cytoscape.NodeSingular;
        if (relationOwner.length > 0) {
            const scrollTop = detailPanel.scrollTop;
            expandedRelationNodeId = relationOwnerId;
            expandedRelationDirections.add(direction);
            updateDetails(relationOwner);
            detailPanel.scrollTop = scrollTop;
        }
        return;
    }

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
    // Traversing and moving every successor is prohibitively expensive for a
    // dense graph and can run even when the gesture was only a click.
    draggedSubtree = cy.nodes().length <= MAX_SUBTREE_DRAG_NODES
        ? node.successors().nodes()
        : null;
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
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
searchInput?.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(applySearch, 160);
});

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderGraph() {
    const generation = ++renderGeneration;
    if (layoutFrame !== null) {
        cancelAnimationFrame(layoutFrame);
        layoutFrame = null;
    }
    activeLayout?.stop();
    activeLayout = null;
    cy.elements().remove();
    selectedNodeId = null;
    expandedRelationNodeId = null;
    expandedRelationDirections.clear();
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
    largeGraphMode = nodes.length + allReferencedIds.size > LARGE_GRAPH_NODE_THRESHOLD
        || edges.length > LARGE_GRAPH_EDGE_THRESHOLD;

    if (nodes.length === 0) {
        emptyEl.classList.add('visible');
        detailPanel?.classList.add('hidden');
        statsBar.textContent = '';
        return;
    }
    emptyEl.classList.remove('visible');
    detailPanel?.classList.remove('hidden');

    // Build cytoscape elements
    const elements: cytoscape.ElementDefinition[] = [];

    for (const node of nodes) {
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
                isTriggeredOnly: node.isTriggeredOnly || undefined,
                isHidden: node.isHidden || undefined,
                meanTimeToHappen: node.meanTimeToHappen || undefined,
                entryStatus: node.entryStatus ?? 'unknown',
                isSeed: seedIds.has(node.id) || undefined,
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
                    entryStatus: isExternalSource ? 'external_definition' : 'unknown',
                },
            });
            nodeIds.add(id);
        }
    }

    edges.forEach((edge, index) => {
        const label = edgeDisplayLabel(edge);
        elements.push({
            data: {
                id: `${edge.source}→${edge.target}:${edge.edgeType}:${index}`,
                source: edge.source,
                target: edge.target,
                edgeType: edge.edgeType,
                conditionRelation: edge.conditionRelation,
                label,
                shortLabel: truncateText(label, 32),
                isPrimary: primaryEdgeTypes.has(edge.edgeType) || undefined,
                isImplicit: implicitEdgeTypes.has(edge.edgeType) || undefined,
            },
        });
    });

    cy.add(elements);

    const seedRoots = cy.nodes().filter(node => Boolean(node.data('isSeed')));
    const layoutOptions = largeGraphMode
        ? {
            name: 'breadthfirst',
            animate: false,
            fit: false,
            padding: 56,
            directed: true,
            circle: false,
            grid: true,
            avoidOverlap: true,
            nodeDimensionsIncludeLabels: true,
            spacingFactor: 1.05,
            roots: seedRoots.length > 0 ? seedRoots : undefined,
        }
        : {
            name: 'elk',
            animate: false,
            fit: false,
            padding: 56,
            elk: {
                algorithm: 'layered',
                'elk.direction': 'RIGHT',
                'elk.edgeRouting': 'POLYLINE',
                'elk.spacing.componentComponent': 52,
                'elk.spacing.nodeNode': 28,
                'elk.spacing.edgeNode': 20,
                'elk.layered.spacing.nodeNodeBetweenLayers': 72,
                'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
            },
        };
    activeLayout = cy.layout(layoutOptions as any);
    cy.one('layoutstop', () => {
        if (generation !== renderGeneration) return;
        activeLayout = null;
        layoutFrame = null;
        loadingEl.classList.add('hidden');
        applySearch();
        if (!searchInput.value.trim()) {
            focusReadableStart();
        }
    });

    if (largeGraphMode) {
        loadingEl.textContent = t('Optimizing large event graph...', '正在优化大型事件关系图...');
        loadingEl.classList.remove('hidden');
    }

    // Run layout in the next frame to prevent race condition where ELK reads 0x0 node dimensions
    layoutFrame = requestAnimationFrame(() => {
        if (generation !== renderGeneration || !activeLayout) return;
        activeLayout.run();
    });

    // Update stats
    statsBar.innerHTML = `
        <span>${t('Nodes', '节点')}: ${nodes.length}</span>
        <span>${t('Edges', '边')}: ${edges.length}</span>
        <span>${t('Seed events', '种子事件')}: ${seedIds.size}</span>
        <span>${t('Namespace', '命名空间')}: ${currentNamespace === '__all__' ? t('All', '全部') : currentNamespace}</span>
        <span>${t('Layout', '布局')}: ${largeGraphMode ? t('Optimized overview', '大型图优化') : t('Layered', '分层')}</span>
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
