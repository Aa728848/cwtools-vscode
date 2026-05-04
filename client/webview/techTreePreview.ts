/**
 * Tech Tree Preview — Webview Script
 *
 * Uses cytoscape.js + cytoscape-elk to render a layered technology tree.
 * Receives data from the extension host via postMessage.
 *
 * Features:
 * - ELK LEFT→RIGHT layered layout (tier-based columns)
 * - Area color coding (physics/society/engineering)
 * - Rare/dangerous styling
 * - Area & tier filter dropdowns
 * - Search by tech ID
 * - Hover tooltip with tech details
 * - Click to navigate to source file
 */

import cytoscape from 'cytoscape';
import { svgIconNoMargin } from './svgIcons';
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

// ─── Types (mirror of techTreeParser.ts) ─────────────────────────────────────

interface TechNode {
    id: string;
    area: 'physics' | 'society' | 'engineering' | 'unknown';
    tier: number;
    category: string;
    cost: number;
    title: string;
    isRare: boolean;
    isDangerous: boolean;
    isStartTech: boolean;
    file: string;
    line: number;
}

interface TechEdge {
    source: string;
    target: string;
}

interface TechGraph {
    nodes: TechNode[];
    edges: TechEdge[];
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const cyContainer = document.getElementById('cy-container')!;
const loadingEl = document.getElementById('loading')!;
const emptyState = document.getElementById('empty-state')!;
const areaFilter = document.getElementById('area-filter') as HTMLSelectElement;
const tierFilter = document.getElementById('tier-filter') as HTMLSelectElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const showRareCheck = document.getElementById('show-rare') as HTMLInputElement;
const btnZoomIn = document.getElementById('btn-zoom-in')!;
const btnZoomOut = document.getElementById('btn-zoom-out')!;
const btnFit = document.getElementById('btn-fit')!;
const statsBar = document.getElementById('stats-bar')!;

// ─── State ────────────────────────────────────────────────────────────────────

let fullGraph: TechGraph = { nodes: [], edges: [] };
let currentArea = '__all__';
let currentTier = '__all__';

// ─── Cytoscape instance ───────────────────────────────────────────────────────

const cy = cytoscape({
    container: cyContainer,
    elements: [],
    wheelSensitivity: 0.5,
    minZoom: 0.05,
    maxZoom: 6,
    style: [
        // ── Base node
        {
            selector: 'node',
            style: {
                label: 'data(label)',
                'font-size': '9px',
                color: '#fff',
                'text-valign': 'center',
                'text-halign': 'center',
                'background-color': '#4d4d4d',
                'border-width': 1.5,
                'border-color': '#888',
                width: 'label',
                height: 20,
                shape: 'round-rectangle',
                padding: '8px',
                'text-wrap': 'wrap' as any,
                'text-max-width': '160px' as any,
            },
        },
        // ── Physics
        {
            selector: 'node[area="physics"]',
            style: { 'background-color': '#0d47a1', 'border-color': '#29b6f6' },
        },
        // ── Society
        {
            selector: 'node[area="society"]',
            style: { 'background-color': '#1b5e20', 'border-color': '#66bb6a' },
        },
        // ── Engineering
        {
            selector: 'node[area="engineering"]',
            style: { 'background-color': '#4a1800', 'border-color': '#ffa726' },
        },
        // ── Start tech (bright gold border)
        {
            selector: 'node[?isStartTech]',
            style: {
                'border-width': 2.5,
                'border-color': '#fff176',
            },
        },
        // ── Rare tech (dashed border + purple tint)
        {
            selector: 'node[?isRare]',
            style: {
                'border-style': 'dashed' as any,
                'border-color': '#ce93d8',
                'opacity': 0.8,
            },
        },
        // ── Dangerous tech (red glow)
        {
            selector: 'node[?isDangerous]',
            style: {
                'border-color': '#ef5350',
                'border-width': 2,
            },
        },
        // ── Selected
        {
            selector: 'node:selected',
            style: {
                'border-color': '#fff',
                'border-width': 2.5,
            },
        },
        // ── Dimmed (filtered out)
        {
            selector: 'node.dimmed',
            style: { opacity: 0.15 },
        },
        // ── Highlighted (search match)
        {
            selector: 'node.highlighted',
            style: {
                'border-color': '#e8c840',
                'border-width': 2.5,
            },
        },
        // ── Edges (prerequisite arrows)
        {
            selector: 'edge',
            style: {
                width: 1.2,
                'line-color': '#555',
                'target-arrow-color': '#555',
                'target-arrow-shape': 'triangle',
                'curve-style': 'taxi',
                'taxi-direction': 'horizontal' as any,
                'taxi-turn': '15px' as any,
                'taxi-turn-min-distance': 5 as any,
                'arrow-scale': 0.7,
            },
        },
        {
            selector: 'edge[area="physics"]',
            style: { 'line-color': '#1565c0', 'target-arrow-color': '#1565c0' },
        },
        {
            selector: 'edge[area="society"]',
            style: { 'line-color': '#2e7d32', 'target-arrow-color': '#2e7d32' },
        },
        {
            selector: 'edge[area="engineering"]',
            style: { 'line-color': '#bf360c', 'target-arrow-color': '#bf360c' },
        },
        {
            selector: 'edge.dimmed',
            style: { opacity: 0.08 },
        },
    ],
});

// ─── Controls ─────────────────────────────────────────────────────────────────

btnZoomIn.addEventListener('click', () => cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cyContainer.clientWidth / 2, y: cyContainer.clientHeight / 2 } }));
btnZoomOut.addEventListener('click', () => cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cyContainer.clientWidth / 2, y: cyContainer.clientHeight / 2 } }));
btnFit.addEventListener('click', () => cy.fit(undefined, 30));

areaFilter.addEventListener('change', () => { currentArea = areaFilter.value; applyFilters(); });
tierFilter.addEventListener('change', () => { currentTier = tierFilter.value; applyFilters(); });
showRareCheck.addEventListener('change', () => applyFilters());

let searchDebounce: ReturnType<typeof setTimeout> | null = null;
searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => applySearch(searchInput.value.trim().toLowerCase()), 200);
});

function applyFilters() {
    const showRare = showRareCheck.checked;
    cy.batch(() => {
        cy.nodes().forEach(n => {
            const data = n.data();
            const areaOk = currentArea === '__all__' || data.area === currentArea;
            const tierOk = currentTier === '__all__' || String(data.tier) === currentTier;
            const rareOk = showRare || !data.isRare;
            if (areaOk && tierOk && rareOk) {
                n.removeClass('dimmed');
                n.connectedEdges().removeClass('dimmed');
            } else {
                n.addClass('dimmed');
                n.connectedEdges().addClass('dimmed');
            }
        });
    });
}

function applySearch(query: string) {
    cy.batch(() => {
        cy.nodes().removeClass('highlighted');
        if (!query) return;
        cy.nodes().forEach(n => {
            const id = (n.data('id') as string).toLowerCase();
            const lbl = (n.data('label') as string).toLowerCase();
            if (id.includes(query) || lbl.includes(query)) {
                n.addClass('highlighted');
            }
        });
    });
    // Pan to first match
    const matched = cy.nodes('.highlighted');
    if (matched.length > 0) {
        cy.animate({ center: { eles: matched.first() }, duration: 300 });
    }
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

const tooltip = document.createElement('div');
tooltip.className = 'cy-tooltip';
tooltip.style.display = 'none';
document.body.appendChild(tooltip);

cy.on('mouseover', 'node', evt => {
    const d = evt.target.data();
    const areaLabel: Record<string, string> = { physics: '物理学', society: '社会学', engineering: '工程学', unknown: '未知' };
    const flags = [
        d.isStartTech ? `${svgIconNoMargin('star')} 起始科技` : '',
        d.isRare ? `${svgIconNoMargin('shield')} 稀有` : '',
        d.isDangerous ? `${svgIconNoMargin('warning')} 危险` : '',
    ].filter(Boolean).join(' ');

    tooltip.innerHTML = `
        <div class="tt-id">${d.id}</div>
        ${d.title !== d.id ? `<div class="tt-title">${d.title}</div>` : ''}
        <div class="tt-meta">${areaLabel[d.area] ?? d.area} · Tier ${d.tier} · ${d.category}</div>
        ${d.cost > 0 ? `<div class="tt-meta">研究费用: ${d.cost}</div>` : ''}
        ${flags ? `<div class="tt-meta">${flags}</div>` : ''}
        <div class="tt-file">${d.file}:${d.line}</div>
    `;
    tooltip.style.display = 'block';
});

cy.on('mouseout', 'node', () => { tooltip.style.display = 'none'; });

cy.on('mousemove', evt => {
    const pos = evt.renderedPosition;
    const cx = cyContainer.getBoundingClientRect();
    tooltip.style.left = (cx.left + pos.x + 14) + 'px';
    tooltip.style.top = (cx.top + pos.y - 10) + 'px';
});

cy.on('tap', 'node', evt => {
    const d = evt.target.data();
    if (d.file) {
        vscode.postMessage({ command: 'goToTech', file: d.file, line: d.line });
    }
});

// ─── Subtree dragging ────────────────────────────────────────────────────────

let dragPrevPos: cytoscape.Position | null = null;
let draggedSubtree: cytoscape.NodeCollection | null = null;

cy.on('grab', 'node', (evt) => {
    const node = evt.target;
    dragPrevPos = { ...node.position() };
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

// ─── Render ───────────────────────────────────────────────────────────────────

function render(nodes: TechNode[], edges: TechEdge[]) {
    cy.elements().remove();
    emptyState.classList.remove('visible');

    if (nodes.length === 0) {
        emptyState.classList.add('visible');
        return;
    }

    // Populate tier filter
    const tiers = [...new Set(nodes.map(n => n.tier))].sort((a, b) => a - b);
    // Remove old options except the first (all)
    while (tierFilter.options.length > 1) tierFilter.remove(1);
    for (const t of tiers) {
        const opt = document.createElement('option');
        opt.value = String(t);
        opt.textContent = `Tier ${t}`;
        tierFilter.appendChild(opt);
    }

    const elements: cytoscape.ElementDefinition[] = [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    for (const node of nodes) {
        const label = node.title !== node.id
            ? `${node.id}\n${node.title}`
            : node.id;

        elements.push({
            data: {
                id: node.id,
                label,
                area: node.area,
                tier: node.tier,
                category: node.category,
                cost: node.cost,
                title: node.title,
                isRare: node.isRare,
                isDangerous: node.isDangerous,
                isStartTech: node.isStartTech,
                file: node.file,
                line: node.line,
            },
        });
    }

    const edgeSet = new Set<string>();
    for (const edge of edges) {
        // Only add edge if both endpoints exist as nodes
        if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
        const key = `${edge.source}→${edge.target}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);

        const srcNode = nodeMap.get(edge.source)!;
        elements.push({
            data: {
                id: key,
                source: edge.source,
                target: edge.target,
                area: srcNode.area,
            },
        });
    }

    // ── Deterministic Grid Layout ───────────────────────────────────────────
    // X = tier column (left→right)
    // Y = area band + sorted slot within band
    
    const NODE_W = 280;   // horizontal stride per tier column (px)
    const NODE_H = 48;    // vertical stride per node within a band (px)
    const BAND_GAP = 60;  // extra gap between area bands

    const tierList = [...new Set(nodes.map(n => n.tier))].sort((a, b) => a - b);
    
    // For each tier, compute how many nodes per area band to define band heights
    const bandSizes: Record<string, number> = { physics: 0, society: 0, engineering: 0, unknown: 0 };
    for (const tier of tierList) {
        const tierNodes = nodes.filter(n => n.tier === tier);
        for (const area of ['physics', 'society', 'engineering', 'unknown']) {
            const cnt = tierNodes.filter(n => n.area === area).length;
            if (cnt > bandSizes[area]!) bandSizes[area] = cnt;
        }
    }

    // Compute band Y origins (cumulative, with gaps)
    const bandOrigin: Record<string, number> = {};
    let cumY = 0;
    for (const area of ['physics', 'society', 'engineering', 'unknown']) {
        bandOrigin[area] = cumY;
        const h = (bandSizes[area] || 0) * NODE_H;
        cumY += h + (h > 0 ? BAND_GAP : 0);
    }

    // Assign positions
    const posMap = new Map<string, { x: number; y: number }>();
    for (let ti = 0; ti < tierList.length; ti++) {
        const tier = tierList[ti]!;
        const x = ti * NODE_W;
        const tierNodes = nodes.filter(n => n.tier === tier);
        
        for (const area of ['physics', 'society', 'engineering', 'unknown']) {
            const areaNodes = tierNodes.filter(n => n.area === area);
            // Sort by category, then ID for stable layout
            areaNodes.sort((a, b) => {
                if (a.category !== b.category) return a.category.localeCompare(b.category);
                return a.id.localeCompare(b.id);
            });
            
            let y = bandOrigin[area]!;
            for (const n of areaNodes) {
                posMap.set(n.id, { x, y });
                y += NODE_H;
            }
        }
    }

    // Apply positions to nodes BEFORE adding to cy
    for (const el of elements) {
        const data = el.data as any;
        if (data.source) continue; // skip edges
        const pos = posMap.get(data.id);
        if (pos) {
            el.position = pos;
        }
    }

    // Add nodes FIRST, then edges — cytoscape handles them better this way
    const nodeElements = elements.filter(e => !(e.data as any).source);
    const edgeElements = elements.filter(e => (e.data as any).source);
    
    cy.add(nodeElements);
    cy.add(edgeElements);

    // Use preset layout since we manually calculated coordinates
    cy.layout({
        name: 'preset',
        animate: false,
        fit: true,
        padding: 40,
    }).run();

    cy.fit(undefined, 30);

    // Update stats
    const areaCount: Record<string, number> = {};
    for (const n of nodes) areaCount[n.area] = (areaCount[n.area] ?? 0) + 1;

    statsBar.innerHTML = `
        <span>科技: ${nodes.length}</span>
        <span>依赖关系: ${edgeSet.size}</span>
        <span>物理学: ${areaCount.physics ?? 0}</span>
        <span>社会学: ${areaCount.society ?? 0}</span>
        <span>工程学: ${areaCount.engineering ?? 0}</span>
    `;
}

// ─── Message handler ──────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    switch (msg.command) {
        case 'render': {
            fullGraph = msg.data as TechGraph;
            loadingEl.classList.add('hidden');
            render(fullGraph.nodes, fullGraph.edges);
            break;
        }
        case 'loading': {
            loadingEl.classList.remove('hidden');
            loadingEl.textContent = msg.text ?? '加载中...';
            break;
        }
    }
});

// Signal ready to the extension host
vscode.postMessage({ command: 'ready' });
