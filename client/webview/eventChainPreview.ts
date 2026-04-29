/**
 * Event Chain Preview — Webview Script
 *
 * Uses cytoscape.js to render a directed graph of Stellaris event chains.
 * Receives data from the extension host via postMessage.
 *
 * Features:
 * - Auto-layout with ELK (layered/hierarchical)
 * - Click-to-navigate to source file
 * - Namespace filtering
 * - Search by event ID
 * - Zoom/fit controls
 * - Hover tooltip with event details
 */

import cytoscape from 'cytoscape';
// @ts-ignore
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
}

interface EventEdge {
    source: string;
    target: string;
    edgeType: 'option' | 'immediate' | 'after' | 'effect' | 'on_action' | 'decision' | 'scripted' | 'unknown';
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

// Edge color map
const EDGE_COLORS: Record<string, string> = {
    option: '#e8c840',
    immediate: '#4caf50',
    after: '#ff9800',
    effect: '#ab47bc',
    unknown: '#888',
};

const cy = cytoscape({
    container,
    style: [
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'text-valign': 'center',
                'text-halign': 'center',
                'font-size': '9px',
                'color': '#fff',
                'background-color': '#4d4d4d',
                'border-width': 1,
                'border-color': '#666',
                'width': 'label',
                'height': 28,
                'shape': 'round-rectangle',
                'padding': '10px' as any,
                'text-wrap': 'wrap' as any,
                'text-max-width': '180px' as any,
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
                'background-color': '#5c5c1a',
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
            selector: 'edge',
            style: {
                'width': 1.5,
                'line-color': '#666',
                'target-arrow-color': '#666',
                'target-arrow-shape': 'triangle',
                'curve-style': 'taxi',
                'taxi-direction': 'vertical' as any,
                'taxi-turn': '15px' as any,
                'taxi-turn-min-distance': 5 as any,
                'arrow-scale': 0.8,
                'font-size': '7px',
                'color': '#999',
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
            selector: 'node[?isExternal]',
            style: {
                'shape': 'diamond',
                'background-color': '#78909c',
                'border-color': '#b0bec5',
                'border-width': 2,
                'font-size': '8px',
            },
        },
        {
            selector: '.highlighted',
            style: { 'opacity': 1 },
        },
        {
            selector: '.faded',
            style: { 'opacity': 0.15 },
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

// ─── Event handlers ──────────────────────────────────────────────────────────

// Click node → navigate to source file
cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const file = node.data('file');
    const line = node.data('line');
    if (file && line) {
        vscode.postMessage({ command: 'goToEvent', file, line });
    }
});

// Hover → show tooltip
cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    showTooltip(node);
});
cy.on('mouseout', 'node', () => {
    hideTooltip();
});

// Hover → highlight connected nodes
cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    const neighborhood = node.closedNeighborhood();
    cy.elements().addClass('faded');
    neighborhood.removeClass('faded').addClass('highlighted');
});
cy.on('mouseout', 'node', () => {
    cy.elements().removeClass('faded').removeClass('highlighted');
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
        <div class="tt-id">${data.id}</div>
        <div class="tt-type">${data.eventType}${data.isEntry ? ' (entry point)' : ''}${data.isTriggered ? ' (triggered only)' : ''}</div>
        ${data.title ? `<div style="margin-top:2px;">${data.title}</div>` : ''}
        <div class="tt-file">${data.file}:${data.line}</div>
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
    cy.fit(undefined, 30);
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
    renderGraph();
});

// Search
searchInput?.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
        cy.elements().removeClass('faded').removeClass('highlighted');
        return;
    }
    cy.elements().addClass('faded');
    const matching = cy.nodes().filter(n => {
        const id = (n.data('id') || '').toLowerCase();
        const title = (n.data('title') || '').toLowerCase();
        return id.includes(query) || title.includes(query);
    });
    const neighborhood = matching.closedNeighborhood();
    neighborhood.removeClass('faded').addClass('highlighted');
});

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderGraph() {
    cy.elements().remove();

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
        statsBar.textContent = '';
        return;
    }
    emptyEl.classList.remove('visible');

    // Find which nodes have no incoming edges (entry points)
    const hasIncoming = new Set(edges.map(e => e.target));

    // Build cytoscape elements
    const elements: cytoscape.ElementDefinition[] = [];

    for (const node of nodes) {
        const isEntry = node.isFireOnAction || (!node.isTriggeredOnly && !hasIncoming.has(node.id));
        // For non-hidden popup events, show localized title if available
        let displayLabel = node.id;
        if (!node.isHidden && node.title) {
            displayLabel = `${node.id}\n${node.title}`;
        }
        elements.push({
            data: {
                id: node.id,
                label: displayLabel,
                eventType: node.type,
                title: node.title,
                file: node.file,
                line: node.line,
                isEntry: isEntry || undefined,
                isTriggered: node.isTriggeredOnly || undefined,
                isHidden: node.isHidden || undefined,
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
                    label: isExternalSource
                        ? id.replace(/^\[\w+\]\s*/, '')
                        : (id.length > 20 ? '…' + id.slice(-16) : id),
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
        elements.push({
            data: {
                id: `${edge.source}→${edge.target}`,
                source: edge.source,
                target: edge.target,
                edgeType: edge.edgeType,
                label: edge.label,
            },
        });
    }

    cy.add(elements);

    // Layout — ELK (layered/hierarchical) for clean DAG visualization
    cy.layout({
        name: 'elk',
        animate: false,
        fit: true,
        padding: 40,
        nodeDimensionsIncludeLabels: true,
        elk: {
            algorithm: 'layered',
            'elk.direction': 'RIGHT',
            'elk.aspectRatio': 0.2, // Force disconnected components to pack vertically
            'elk.spacing.componentComponent': 40,
            'elk.spacing.nodeNode': 30,
            'elk.spacing.edgeNode': 25,
            'elk.layered.spacing.nodeNodeBetweenLayers': 60,
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        },
    } as any).run();

    cy.fit(undefined, 30);

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
