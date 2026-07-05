/**
 * Tech Tree Preview — Webview Script
 *
 * Uses cytoscape.js + cytoscape-elk to render a layered technology tree.
 * Receives data from the extension host via postMessage.
 *
 * Features:
 * - Dependency-aware LEFT→RIGHT layout
 * - Area color coding (physics/society/engineering)
 * - Rare/dangerous styling
 * - Area & tier filter dropdowns
 * - Search by tech ID
 * - Hover tooltip with tech details
 * - Select-to-inspect tech details
 */

import cytoscape from 'cytoscape';
import { svgIconNoMargin } from './svgIcons';
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

// ─── Types (mirror of techTreeParser.ts) ─────────────────────────────────────

interface TechNode {
    id: string;
    area: 'physics' | 'society' | 'engineering' | 'unknown';
    tier: number;
    category: string;
    cost: number;
    weight: number;
    icon: string;
    iconUri?: string;
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
const detailPanel = document.getElementById('details-panel') as HTMLDivElement | null;
const locale = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
const t = (en: string, zh: string) => locale === 'zh-cn' ? zh : en;

// ─── State ────────────────────────────────────────────────────────────────────

let fullGraph: TechGraph = { nodes: [], edges: [] };
let currentArea = '__all__';
let currentTier = '__all__';
let selectedTechId: string | null = null;
let hasInitializedArea = false;

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
                'font-family': 'Segoe UI, system-ui, sans-serif',
                'font-size': '9.5px',
                'font-weight': 700,
                color: '#fff',
                'text-valign': 'center',
                'text-halign': 'center',
                'text-justification': 'left' as any,
                'text-margin-x': 28,
                'line-height': 1.12,
                'background-color': '#071521',
                'background-opacity': 0.96,
                'background-image': 'data(iconUri)',
                'background-fit': 'none' as any,
                'background-width': '48px' as any,
                'background-height': '48px' as any,
                'background-position-x': '8px' as any,
                'background-position-y': '50%' as any,
                'background-clip': 'node' as any,
                'border-width': 2,
                'border-color': '#2d8fd7',
                width: 286,
                height: 68,
                shape: 'round-rectangle',
                padding: '0px',
                'text-wrap': 'wrap' as any,
                'text-max-width': '206px' as any,
                'text-outline-width': 1,
                'text-outline-color': '#02070b',
                'overlay-opacity': 0,
            },
        },
        {
            selector: 'node[!iconUri]',
            style: {
                'background-image': 'none',
            },
        },
        // ── Physics
        {
            selector: 'node[area="physics"]',
            style: { 'background-color': '#07192a', 'border-color': '#2f9fe8' },
        },
        // ── Society
        {
            selector: 'node[area="society"]',
            style: { 'background-color': '#071f18', 'border-color': '#59c99c' },
        },
        // ── Engineering
        {
            selector: 'node[area="engineering"]',
            style: { 'background-color': '#211707', 'border-color': '#e3a044' },
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
                'border-color': '#a855f7',
            },
        },
        // ── Dangerous tech (red glow)
        {
            selector: 'node[?isDangerous]',
            style: {
                'border-color': '#ef5350',
                'border-width': 2.5,
            },
        },
        // ── Selected
        {
            selector: 'node:selected',
            style: {
                'border-color': '#f2d85c',
                'border-width': 3.5,
            },
        },
        // ── Dimmed (filtered out)
        {
            selector: 'node.dimmed',
            style: { opacity: 0.15 },
        },
        {
            selector: 'node.filtered-out',
            style: { display: 'none' },
        },
        // ── Highlighted (search match)
        {
            selector: 'node.highlighted',
            style: {
                'border-color': '#e8c840',
                'border-width': 2.5,
            },
        },
        {
            selector: 'node.focus-node',
            style: {
                'border-color': '#f2d85c',
                'border-width': 4,
                'z-index': 20,
            },
        },
        {
            selector: 'node.focus-neighbor',
            style: {
                'border-color': '#9bd3ff',
                'border-width': 2.5,
                'z-index': 12,
            },
        },
        {
            selector: 'node.search-match',
            style: {
                'border-color': '#ffcf4a',
                'border-width': 4,
                'z-index': 24,
            },
        },
        // ── Edges (prerequisite arrows)
        {
            selector: 'edge',
            style: {
                width: 1.5,
                'line-color': '#555',
                'target-arrow-color': '#555',
                'target-arrow-shape': 'triangle',
                'curve-style': 'taxi',
                'taxi-direction': 'horizontal' as any,
                'taxi-turn': '15px' as any,
                'taxi-turn-min-distance': 5 as any,
                'arrow-scale': 0.7,
                opacity: 0.72,
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
        {
            selector: 'edge.filtered-out',
            style: { display: 'none' },
        },
        {
            selector: 'edge.focus-edge',
            style: {
                width: 3,
                opacity: 1,
                'z-index': 18,
            },
        },
        {
            selector: '.faded',
            style: { opacity: 0.12 },
        },
    ],
});

// ─── UI helpers ───────────────────────────────────────────────────────────────

const areaLabel: Record<string, string> = {
    physics: t('Physics', '物理学'),
    society: t('Society', '社会学'),
    engineering: t('Engineering', '工程学'),
    unknown: t('Unknown', '未知'),
};
const areaOrder: TechNode['area'][] = ['physics', 'society', 'engineering', 'unknown'];

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

function formatNumber(value: number | undefined): string {
    if (!value || !Number.isFinite(value)) return '-';
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function formatTier(node: TechNode): string {
    return node.tier < 1 ? t('Initial', '初始') : `${t('Level', '等级')} ${node.tier}`;
}

function formatTechLabel(node: TechNode): string {
    const title = truncateText(node.title && node.title !== node.id ? node.title : node.id, 24);
    const category = truncateText(node.category || areaLabel[node.area] || node.area, 16);
    const cost = node.cost > 0 ? formatNumber(node.cost) : '-';
    const weight = node.weight > 0 ? formatNumber(node.weight) : '-';
    return `${title}\n${category} - ${formatTier(node)}\n${t('Cost', '花费')}: ${cost}, ${t('Weight', '权重')}: ${weight}`;
}

function compareTech(a: TechNode, b: TechNode, ranks: Map<string, number>): number {
    const rankDiff = (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0);
    if (rankDiff !== 0) return rankDiff;
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.id.localeCompare(b.id);
}

function computeTechRanks(nodes: TechNode[], edges: TechEdge[]): Map<string, number> {
    const tierList = [...new Set(nodes.map(n => n.tier))].sort((a, b) => a - b);
    const tierRank = new Map(tierList.map((tier, index) => [tier, index]));
    const ranks = new Map(nodes.map(node => [node.id, tierRank.get(node.tier) ?? 0]));

    // Keep tier columns, but push same-tier dependency chains to the right.
    for (let i = 0; i < nodes.length; i++) {
        let changed = false;
        for (const edge of edges) {
            const sourceRank = ranks.get(edge.source);
            const targetRank = ranks.get(edge.target);
            if (sourceRank === undefined || targetRank === undefined) continue;
            const nextRank = Math.max(targetRank, sourceRank + 1);
            if (nextRank !== targetRank) {
                ranks.set(edge.target, nextRank);
                changed = true;
            }
        }
        if (!changed) break;
    }

    return ranks;
}

function findAreaComponents(areaNodes: TechNode[], edges: TechEdge[], ranks: Map<string, number>): TechNode[][] {
    const nodeById = new Map(areaNodes.map(node => [node.id, node]));
    const adjacency = new Map(areaNodes.map(node => [node.id, new Set<string>()]));

    for (const edge of edges) {
        if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
        adjacency.get(edge.source)?.add(edge.target);
        adjacency.get(edge.target)?.add(edge.source);
    }

    const visited = new Set<string>();
    const components: TechNode[][] = [];

    for (const start of [...areaNodes].sort((a, b) => compareTech(a, b, ranks))) {
        if (visited.has(start.id)) continue;
        const stack = [start.id];
        const component: TechNode[] = [];
        visited.add(start.id);

        while (stack.length > 0) {
            const id = stack.pop()!;
            const node = nodeById.get(id);
            if (node) component.push(node);
            for (const next of adjacency.get(id) ?? []) {
                if (visited.has(next)) continue;
                visited.add(next);
                stack.push(next);
            }
        }

        component.sort((a, b) => compareTech(a, b, ranks));
        components.push(component);
    }

    components.sort((a, b) => {
        const aMinRank = Math.min(...a.map(node => ranks.get(node.id) ?? 0));
        const bMinRank = Math.min(...b.map(node => ranks.get(node.id) ?? 0));
        if (aMinRank !== bMinRank) return aMinRank - bMinRank;
        if (a.length !== b.length) return b.length - a.length;
        return a[0]!.id.localeCompare(b[0]!.id);
    });

    return components;
}

function assignComponentLanes(component: TechNode[], edges: TechEdge[], ranks: Map<string, number>) {
    const ids = new Set(component.map(node => node.id));
    const predecessors = new Map(component.map(node => [node.id, [] as string[]]));

    for (const edge of edges) {
        if (ids.has(edge.source) && ids.has(edge.target)) {
            predecessors.get(edge.target)?.push(edge.source);
        }
    }

    const laneById = new Map<string, number>();
    const usedByRank = new Map<number, Set<number>>();

    for (const node of [...component].sort((a, b) => compareTech(a, b, ranks))) {
        const rank = ranks.get(node.id) ?? 0;
        let used = usedByRank.get(rank);
        if (!used) {
            used = new Set<number>();
            usedByRank.set(rank, used);
        }

        const inheritedLane = (predecessors.get(node.id) ?? [])
            .map(id => laneById.get(id))
            .find((lane): lane is number => lane !== undefined && !used.has(lane));

        let lane = inheritedLane;
        if (lane === undefined) {
            lane = 0;
            while (used.has(lane)) lane++;
        }

        laneById.set(node.id, lane);
        used.add(lane);
    }

    const laneCount = Math.max(1, ...Array.from(laneById.values()).map(lane => lane + 1));
    return { laneById, laneCount };
}

function computeTechPositions(nodes: TechNode[], edges: TechEdge[]): Map<string, { x: number; y: number }> {
    const ranks = computeTechRanks(nodes, edges);
    const posMap = new Map<string, { x: number; y: number }>();
    const NODE_W = 356;
    const ROW_H = 92;
    const COMPONENT_GAP = 52;
    const AREA_GAP = 120;

    let yCursor = 0;
    for (const area of areaOrder) {
        const areaNodes = nodes.filter(node => node.area === area);
        if (areaNodes.length === 0) continue;

        const components = findAreaComponents(areaNodes, edges, ranks);
        for (const component of components) {
            const { laneById, laneCount } = assignComponentLanes(component, edges, ranks);
            for (const node of component) {
                const rank = ranks.get(node.id) ?? 0;
                const lane = laneById.get(node.id) ?? 0;
                posMap.set(node.id, {
                    x: rank * NODE_W,
                    y: yCursor + lane * ROW_H,
                });
            }
            yCursor += laneCount * ROW_H + COMPONENT_GAP;
        }
        yCursor += AREA_GAP;
    }

    return posMap;
}

function chooseInitialArea(nodes: TechNode[]): string {
    for (const area of areaOrder) {
        if (area === 'unknown') continue;
        if (nodes.some(node => node.area === area)) return area;
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

    const bbox = visibleNodes.boundingBox({ includeLabels: true, includeOverlays: false });
    const availableWidth = Math.max(360, cyContainer.clientWidth - 120);
    const columnsInView = cyContainer.clientWidth < 900 ? 2.4 : 3.2;
    const targetZoom = Math.max(0.72, Math.min(1, availableWidth / (356 * columnsInView)));
    cy.zoom({
        level: targetZoom,
        renderedPosition: { x: 0, y: 0 },
    });
    cy.pan({
        x: 76 - bbox.x1 * targetZoom,
        y: 76 - bbox.y1 * targetZoom,
    });
}

function clearFocusClasses() {
    cy.elements().removeClass('faded highlighted focus-node focus-neighbor focus-edge search-match');
}

function focusTech(node: cytoscape.NodeSingular, scope: 'direct' | 'flow' = 'flow') {
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

function openTechSource(node: cytoscape.NodeSingular) {
    const file = node.data('file');
    const line = node.data('line');
    if (file && line) {
        vscode.postMessage({ command: 'goToTech', file, line });
    }
}

function selectTech(node: cytoscape.NodeSingular) {
    selectedTechId = node.id();
    cy.nodes().unselect();
    node.select();
    focusTech(node);
    updateDetails(node);
}

function clearSelection() {
    selectedTechId = null;
    cy.nodes().unselect();
    if (searchInput.value.trim()) {
        applySearch(searchInput.value.trim().toLowerCase());
    } else {
        clearFocusClasses();
        updateDetails(null);
    }
}

function updateDetails(node: cytoscape.NodeSingular | null) {
    if (!detailPanel) return;

    if (!node) {
        detailPanel.classList.add('empty');
        detailPanel.innerHTML = `
            <div class="details-empty">
                <div class="details-empty-title">${t('Select a technology node', '选择科技节点')}</div>
                <div class="details-empty-copy">${t('View area, tier, cost, source location, and prerequisite/dependent technologies.', '查看领域、层级、费用、来源位置，以及它的前置和后续科技。')}</div>
            </div>
        `;
        return;
    }

    const data = node.data();
    const incoming = node.incomers('edge').length;
    const outgoing = node.outgoers('edge').length;
    const iconHtml = data.iconUri
        ? `<img class="details-tech-icon" src="${escapeHtml(data.iconUri)}" alt="">`
        : `<div class="details-tech-icon placeholder">${escapeHtml((data.area || '?').slice(0, 1).toUpperCase())}</div>`;
    const badges = [
        data.isStartTech ? t('Starting tech', '起始科技') : '',
        data.isRare ? t('Rare', '稀有') : '',
        data.isDangerous ? t('Dangerous', '危险') : '',
    ].filter(Boolean);

    detailPanel.classList.remove('empty');
    detailPanel.innerHTML = `
        <div class="details-header">
            <div class="details-kicker">${escapeHtml(areaLabel[data.area] ?? data.area)}</div>
            <button type="button" class="details-icon-button" data-clear-selection title="${t('Clear selection', '清除选择')}" aria-label="${t('Clear selection', '清除选择')}">×</button>
        </div>
        <div class="details-tech-heading">
            ${iconHtml}
            <div>
                <div class="details-title">${escapeHtml(data.title || data.id)}</div>
                ${data.title && data.title !== data.id ? `<div class="details-subtitle">${escapeHtml(data.id)}</div>` : ''}
            </div>
        </div>
        ${badges.length > 0 ? `<div class="details-badges">${badges.map(badge => `<span>${escapeHtml(badge)}</span>`).join('')}</div>` : ''}
        <dl class="details-list">
            <div><dt>${t('Tier', '层级')}</dt><dd>${escapeHtml(formatTier(data as TechNode))}</dd></div>
            <div><dt>${t('Category', '分类')}</dt><dd>${escapeHtml(data.category || '-')}</dd></div>
            <div><dt>${t('Cost', '费用')}</dt><dd>${Number(data.cost) > 0 ? escapeHtml(data.cost) : '-'}</dd></div>
            <div><dt>${t('Weight', '权重')}</dt><dd>${Number(data.weight) > 0 ? escapeHtml(formatNumber(data.weight)) : '-'}</dd></div>
            <div><dt>${t('Dependencies', '依赖')}</dt><dd>${t(`${incoming} prerequisites / ${outgoing} dependents`, `${incoming} 个前置 / ${outgoing} 个后续`)}</dd></div>
            <div><dt>${t('Source', '来源')}</dt><dd>${escapeHtml(data.file)}:${escapeHtml(data.line)}</dd></div>
        </dl>
        <div class="details-actions">
            <button type="button" data-open-source>${t('Open source file', '打开源文件')}</button>
        </div>
    `;
}

// ─── Controls ─────────────────────────────────────────────────────────────────

btnZoomIn.addEventListener('click', () => cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cyContainer.clientWidth / 2, y: cyContainer.clientHeight / 2 } }));
btnZoomOut.addEventListener('click', () => cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cyContainer.clientWidth / 2, y: cyContainer.clientHeight / 2 } }));
btnFit.addEventListener('click', () => fitVisible(80));

areaFilter.addEventListener('change', () => { currentArea = areaFilter.value; applyFilters('start'); });
tierFilter.addEventListener('change', () => { currentTier = tierFilter.value; applyFilters('start'); });
showRareCheck.addEventListener('change', () => applyFilters('start'));

let searchDebounce: ReturnType<typeof setTimeout> | null = null;
searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => applySearch(searchInput.value.trim().toLowerCase()), 200);
});

detailPanel?.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.closest('[data-clear-selection]')) {
        clearSelection();
        return;
    }

    const openButton = target.closest('[data-open-source]');
    if (openButton && selectedTechId) {
        const node = cy.getElementById(selectedTechId) as cytoscape.NodeSingular;
        if (node.length > 0) {
            openTechSource(node);
        }
    }
});

function applyFilters(viewAction: 'start' | 'none' = 'none') {
    const showRare = showRareCheck.checked;
    const visibleNodeIds = new Set<string>();
    cy.batch(() => {
        cy.nodes().forEach(n => {
            const data = n.data();
            const areaOk = currentArea === '__all__' || data.area === currentArea;
            const tierOk = currentTier === '__all__' || String(data.tier) === currentTier;
            const rareOk = showRare || !data.isRare;
            if (areaOk && tierOk && rareOk) {
                n.removeClass('dimmed filtered-out');
                visibleNodeIds.add(n.id());
            } else {
                n.addClass('filtered-out');
            }
        });
        cy.edges().forEach(edge => {
            if (visibleNodeIds.has(edge.source().id()) && visibleNodeIds.has(edge.target().id())) {
                edge.removeClass('dimmed filtered-out');
            } else {
                edge.addClass('filtered-out');
            }
        });
    });

    if (selectedTechId && !visibleNodeIds.has(selectedTechId)) {
        selectedTechId = null;
        cy.nodes().unselect();
        updateDetails(null);
    }

    applySearch(searchInput.value.trim().toLowerCase());
    if (viewAction === 'start' && !searchInput.value.trim()) {
        focusReadableStart();
    }
}

function applySearch(query: string) {
    let neighborhoodToFit: cytoscape.CollectionReturnValue | null = null;
    cy.batch(() => {
        if (!query) {
            if (selectedTechId) {
                const selected = cy.getElementById(selectedTechId) as cytoscape.NodeSingular;
                if (selected.length > 0) {
                    focusTech(selected);
                    return;
                }
            }
            clearFocusClasses();
            return;
        }

        selectedTechId = null;
        cy.nodes().unselect();
        clearFocusClasses();
        cy.elements().addClass('faded');

        const matches = cy.nodes().filter(n => {
            if (n.hasClass('filtered-out')) return false;
            const id = (n.data('id') as string).toLowerCase();
            const lbl = (n.data('label') as string).toLowerCase();
            const title = String(n.data('title') ?? '').toLowerCase();
            return id.includes(query) || lbl.includes(query) || title.includes(query);
        });

        if (matches.length === 0) {
            updateDetails(null);
            return;
        }

        const neighborhood = matches.closedNeighborhood();
        neighborhood.removeClass('faded').addClass('highlighted');
        matches.addClass('search-match');
        neighborhoodToFit = neighborhood;

        let firstMatch: cytoscape.NodeSingular | null = null;
        matches.forEach((n) => {
            if (!firstMatch) firstMatch = n;
        });
        updateDetails(firstMatch);
    });
    const fitTarget = neighborhoodToFit as cytoscape.CollectionReturnValue | null;
    if (fitTarget) {
        cy.fit(fitTarget, 110);
    }
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

const tooltip = document.createElement('div');
tooltip.className = 'cy-tooltip';
tooltip.style.display = 'none';
document.body.appendChild(tooltip);

cy.on('mouseover', 'node', evt => {
    const d = evt.target.data();
    const flags = [
        d.isStartTech ? `${svgIconNoMargin('star')} ${t('Starting tech', '起始科技')}` : '',
        d.isRare ? `${svgIconNoMargin('shield')} ${t('Rare', '稀有')}` : '',
        d.isDangerous ? `${svgIconNoMargin('warning')} ${t('Dangerous', '危险')}` : '',
    ].filter(Boolean).join(' ');
    const iconHtml = d.iconUri
        ? `<img class="tt-icon" src="${escapeHtml(d.iconUri)}" alt="">`
        : `<div class="tt-icon placeholder">${escapeHtml((d.area || '?').slice(0, 1).toUpperCase())}</div>`;

    tooltip.innerHTML = `
        <div class="tt-head">
            ${iconHtml}
            <div>
                <div class="tt-title">${escapeHtml(d.title || d.id)}</div>
                <div class="tt-id">${escapeHtml(d.id)}</div>
            </div>
        </div>
        <div class="tt-meta">${escapeHtml(areaLabel[d.area] ?? d.area)} · ${escapeHtml(formatTier(d as TechNode))} · ${escapeHtml(d.category || '-')}</div>
        <div class="tt-meta">${t('Research cost', '研究费用')}: ${escapeHtml(formatNumber(d.cost))} · ${t('Weight', '权重')}: ${escapeHtml(formatNumber(d.weight))}</div>
        ${flags ? `<div class="tt-meta">${flags}</div>` : ''}
        <div class="tt-file">${escapeHtml(d.file)}:${escapeHtml(d.line)}</div>
    `;
    tooltip.style.display = 'block';

    if (!selectedTechId && !searchInput.value.trim()) {
        focusTech(evt.target, 'direct');
    }
});

cy.on('mouseout', 'node', () => {
    tooltip.style.display = 'none';
    if (!selectedTechId && !searchInput.value.trim()) {
        clearFocusClasses();
    }
});

cy.on('mousemove', evt => {
    const pos = evt.renderedPosition;
    const cx = cyContainer.getBoundingClientRect();
    tooltip.style.left = (cx.left + pos.x + 14) + 'px';
    tooltip.style.top = (cx.top + pos.y - 10) + 'px';
});

cy.on('tap', 'node', evt => {
    selectTech(evt.target);
});

cy.on('dbltap', 'node', evt => {
    openTechSource(evt.target);
});

cy.on('tap', evt => {
    if (evt.target === cy) {
        clearSelection();
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
    selectedTechId = null;
    updateDetails(null);
    emptyState.classList.remove('visible');

    if (nodes.length === 0) {
        emptyState.classList.add('visible');
        detailPanel?.classList.add('hidden');
        return;
    }
    detailPanel?.classList.remove('hidden');

    const availableAreas = new Set(nodes.map(node => node.area));
    if (!hasInitializedArea || (currentArea !== '__all__' && !availableAreas.has(currentArea as TechNode['area']))) {
        currentArea = chooseInitialArea(nodes);
        hasInitializedArea = true;
    }
    areaFilter.value = currentArea;

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
        elements.push({
            data: {
                id: node.id,
                label: formatTechLabel(node),
                area: node.area,
                tier: node.tier,
                category: node.category,
                cost: node.cost,
                weight: node.weight,
                icon: node.icon,
                iconUri: node.iconUri,
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
    const layoutEdges: TechEdge[] = [];
    for (const edge of edges) {
        // Only add edge if both endpoints exist as nodes
        if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
        const key = `${edge.source}→${edge.target}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        layoutEdges.push(edge);

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

    const posMap = computeTechPositions(nodes, layoutEdges);

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
        fit: false,
        padding: 80,
    }).run();

    // Update stats
    const areaCount: Record<string, number> = {};
    for (const n of nodes) areaCount[n.area] = (areaCount[n.area] ?? 0) + 1;

    statsBar.innerHTML = `
        <span>${t('Technologies', '科技')}: ${nodes.length}</span>
        <span>${t('Dependencies', '依赖关系')}: ${edgeSet.size}</span>
        <span>${areaLabel.physics}: ${areaCount.physics ?? 0}</span>
        <span>${areaLabel.society}: ${areaCount.society ?? 0}</span>
        <span>${areaLabel.engineering}: ${areaCount.engineering ?? 0}</span>
    `;

    applyFilters('start');
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
            loadingEl.textContent = msg.text ?? t('Loading...', '加载中...');
            break;
        }
    }
});

// Signal ready to the extension host
vscode.postMessage({ command: 'ready' });
