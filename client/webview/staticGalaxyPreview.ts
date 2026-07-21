/**
 * Static Galaxy Preview/Editor webview.
 *
 * Renders plain data snapshots from the Extension Host with Canvas2D and sends
 * semantic edit requests back. The webview never sees source spans, file paths
 * or replacement text — only opaque nodeKeys plus revision/document versions.
 *
 * Rendering rules (docs/static-galaxy-preview-editor-plan.md §8):
 * - Canvas2D only, devicePixelRatio capped at 2.
 * - All world<->screen math goes through worldToScreen/screenToWorld; the Y
 *   flip lives in exactly those two functions.
 * - On-demand rendering via scheduleRender(); no permanent RAF loop.
 */
import type {
    StaticGalaxyAxis,
    StaticGalaxyAxisUpdate,
    StaticGalaxyDiagnosticView,
    StaticGalaxyDocumentState,
    StaticGalaxyHostMessage,
    StaticGalaxyHyperlaneView,
    StaticGalaxyNebulaView,
    StaticGalaxyRevision,
    StaticGalaxyScenarioView,
    StaticGalaxySystemView,
    StaticGalaxyWebviewMessage,
} from '../shared/staticGalaxyProtocol';
import { estimateHyperlanes, STATIC_GALAXY_DEFAULT_LANE_DISTANCE } from '../shared/staticGalaxyEstimate';

const vscode = acquireVsCodeApi();

const locale = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
const isZh = locale === 'zh-cn';
function tr(en: string, zh: string): string {
    return isZh ? zh : en;
}

// ─── State ──────────────────────────────────────────────────────────────────

type Mode = 'preview' | 'edit';
type NodeKind = 'system' | 'nebula';

interface Viewport {
    cx: number;
    cy: number;
    scale: number; // px per world unit
}

interface DragState {
    pointerId: number;
    kind: NodeKind;
    nodeKey: string;
    startScreenX: number;
    startScreenY: number;
    grabOffsetX: number; // world offset between grab point and node center
    grabOffsetY: number;
    origCenterX: number; // effective center at drag start
    origCenterY: number;
    targetX: number; // effective, snapped
    targetY: number;
    moved: boolean;
    dragging: boolean;
}

interface PanState {
    pointerId: number;
    lastX: number;
    lastY: number;
}

interface Permissions {
    canEdit: boolean;
    reason?: string;
    workshopFile: boolean;
}

interface PersistedState {
    showLabels?: boolean;
    showRanges?: boolean;
    showNebulas?: boolean;
    showLanes?: boolean;
    showGrid?: boolean;
    showEstimatedLanes?: boolean;
    inspectorCollapsed?: boolean;
    activeScenarioKey?: string;
}

const persisted = (vscode.getState() as PersistedState | undefined) ?? {};

const state = {
    revision: null as StaticGalaxyRevision | null,
    activeScenarioKey: persisted.activeScenarioKey ?? null as string | null,
    mode: 'preview' as Mode,
    viewport: { cx: 0, cy: 0, scale: 1 } as Viewport,
    fitScale: 1,
    selection: null as { kind: NodeKind; nodeKey: string } | null,
    hover: null as { kind: NodeKind; nodeKey: string } | null,
    search: '',
    showLabels: persisted.showLabels !== false,
    showRanges: persisted.showRanges !== false,
    showNebulas: persisted.showNebulas !== false,
    showLanes: persisted.showLanes !== false,
    showGrid: persisted.showGrid === true,
    showEstimatedLanes: persisted.showEstimatedLanes === true,
    estimatedLanes: null as Array<[string, string]> | null,
    estimatedDirty: true,
    inspectorCollapsed: persisted.inspectorCollapsed === true,
    permissions: { canEdit: false, workshopFile: false } as Permissions,
    docState: 'saved' as StaticGalaxyDocumentState,
    docStateMessage: undefined as string | undefined,
    docDirty: false,
    drag: null as DragState | null,
    pan: null as PanState | null,
    spacePan: false,
    previewPositions: new Map<string, { x: number; y: number }>(),
    applyingNodeKey: null as string | null,
    pendingLink: null as { path: string[]; cursorX: number; cursorY: number; hoverNodeKey?: string } | null,
    pendingEditMode: false,
    requestCounter: 0,
};

// ─── DOM ────────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node as T;
}

const viewportEl = el<HTMLElement>('viewport');
const canvas = el<HTMLCanvasElement>('galaxy-canvas');
const ctx = canvas.getContext('2d')!;
const tooltipEl = el<HTMLDivElement>('tooltip');
const dragHudEl = el<HTMLDivElement>('drag-hud');
const scenarioSelect = el<HTMLSelectElement>('scenario-select');
const editStatusEl = el<HTMLSpanElement>('edit-status');
const selectionTitleEl = el<HTMLElement>('selection-title');
const infoPanelEl = el<HTMLDivElement>('info-panel');
const propsPanelEl = el<HTMLDivElement>('props-panel');
const searchInput = el<HTMLInputElement>('search-input');
const diagnosticsSummaryEl = el<HTMLSpanElement>('diagnostics-summary');
const diagnosticsListEl = el<HTMLDivElement>('diagnostics-list');
const diagnosticsToggle = el<HTMLButtonElement>('diagnostics-toggle');
const emptyStateEl = el<HTMLDivElement>('empty-state');
const emptyStateMessageEl = el<HTMLParagraphElement>('empty-state-message');
const workshopBannerEl = el<HTMLDivElement>('workshop-banner');
const randomLanesNoteEl = el<HTMLDivElement>('random-lanes-note');
const lanesLegendEl = el<HTMLDivElement>('lanes-legend');

// ─── Model access ───────────────────────────────────────────────────────────

function scenario(): StaticGalaxyScenarioView | null {
    const rev = state.revision;
    if (!rev || rev.scenarios.length === 0) return null;
    return rev.scenarios.find(s => s.scenarioKey === state.activeScenarioKey) ?? rev.scenarios[0]!;
}

function systemsByKey(): Map<string, StaticGalaxySystemView> {
    const map = new Map<string, StaticGalaxySystemView>();
    const sc = scenario();
    if (sc) for (const s of sc.systems) map.set(s.nodeKey, s);
    return map;
}

function findSystem(nodeKey: string): StaticGalaxySystemView | undefined {
    return scenario()?.systems.find(s => s.nodeKey === nodeKey);
}

function findNebula(nodeKey: string): StaticGalaxyNebulaView | undefined {
    return scenario()?.nebulas.find(n => n.nodeKey === nodeKey);
}

function axisCenter(axis: StaticGalaxyAxis): number {
    return axis.kind === 'unresolved' ? 0 : axis.center;
}

/** Effective center with drag-preview override applied. */
function nodeCenter(node: StaticGalaxySystemView | StaticGalaxyNebulaView): { x: number; y: number } {
    const preview = state.previewPositions.get(node.nodeKey);
    if (preview) return preview;
    return { x: axisCenter(node.effectivePosition.x), y: axisCenter(node.effectivePosition.y) };
}

function worstSeverity(diags: StaticGalaxyDiagnosticView[]): 'error' | 'warning' | 'information' | null {
    if (diags.some(d => d.severity === 'error')) return 'error';
    if (diags.some(d => d.severity === 'warning')) return 'warning';
    if (diags.length > 0) return 'information';
    return null;
}

// ─── Viewport transforms ────────────────────────────────────────────────────

let canvasWidth = 0;
let canvasHeight = 0;

function worldToScreen(wx: number, wy: number): { x: number; y: number } {
    // Stellaris' galactic axes are flipped on the in-game map: X grows to the
    // left, Y grows upward. Both flips live only in these two transforms.
    return {
        x: (state.viewport.cx - wx) * state.viewport.scale + canvasWidth / 2,
        y: (wy - state.viewport.cy) * -state.viewport.scale + canvasHeight / 2,
    };
}

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
        x: state.viewport.cx - (sx - canvasWidth / 2) / state.viewport.scale,
        y: state.viewport.cy - (sy - canvasHeight / 2) / state.viewport.scale,
    };
}

function fitAll(): void {
    const sc = scenario();
    if (!sc || canvasWidth === 0) return;
    const { minX, maxX, minY, maxY } = sc.bounds;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const scale = clamp(Math.min((canvasWidth - 80) / bw, (canvasHeight - 80) / bh), 0.02, 50);
    state.viewport = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale };
    state.fitScale = scale;
    updateZoomLabel();
    scheduleRender();
}

function focusNode(kind: NodeKind, nodeKey: string): void {
    const node = kind === 'system' ? findSystem(nodeKey) : findNebula(nodeKey);
    if (!node) return;
    const c = nodeCenter(node);
    state.viewport.cx = c.x;
    state.viewport.cy = c.y;
    scheduleRender();
}

function updateZoomLabel(): void {
    const pct = state.fitScale > 0 ? Math.round((state.viewport.scale / state.fitScale) * 100) : 100;
    el<HTMLSpanElement>('zoom-level').textContent = `${pct}%`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ─── Rendering ──────────────────────────────────────────────────────────────

let rafId: number | null = null;

function scheduleRender(): void {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!document.hidden) render();
    });
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    } else {
        scheduleRender();
    }
});

interface Theme {
    fg: string;
    fgDim: string;
    accent: string;
    error: string;
    warning: string;
    nebula: string;
    grid: string;
    laneAdd: string;
    label: string;
}

function readTheme(): Theme {
    const cs = getComputedStyle(document.body);
    const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
        fg: read('--vscode-foreground', '#cccccc'),
        fgDim: read('--vscode-descriptionForeground', '#888888'),
        accent: read('--vscode-focusBorder', '#007fd4'),
        error: read('--vscode-errorForeground', '#f14c4c'),
        warning: read('--vscode-editorWarning-foreground', '#cca700'),
        nebula: read('--vscode-textLink-foreground', '#3794ff'),
        grid: read('--vscode-widget-border', '#3c3c3c'),
        laneAdd: read('--vscode-charts-green', '#89d185'),
        label: read('--vscode-foreground', '#cccccc'),
    };
}

interface HitEntry {
    kind: NodeKind;
    nodeKey: string;
    sx: number;
    sy: number;
    r: number;
}

const hitGrid = new Map<string, HitEntry[]>();
const HIT_CELL = 32;

function hitGridKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
}

function registerHit(entry: HitEntry): void {
    const cx = Math.floor(entry.sx / HIT_CELL);
    const cy = Math.floor(entry.sy / HIT_CELL);
    const key = hitGridKey(cx, cy);
    const bucket = hitGrid.get(key);
    if (bucket) bucket.push(entry);
    else hitGrid.set(key, [entry]);
}

function hitTest(sx: number, sy: number): HitEntry | null {
    const cx = Math.floor(sx / HIT_CELL);
    const cy = Math.floor(sy / HIT_CELL);
    let best: HitEntry | null = null;
    let bestScore = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const bucket = hitGrid.get(hitGridKey(cx + dx, cy + dy));
            if (!bucket) continue;
            for (const entry of bucket) {
                const dist = Math.hypot(entry.sx - sx, entry.sy - sy);
                const hitRadius = Math.max(7, entry.r + 3);
                if (dist > hitRadius) continue;
                // Priority: selected node, then systems, then nebulas.
                let priority = entry.kind === 'system' ? 1 : 2;
                if (state.selection && state.selection.nodeKey === entry.nodeKey) priority = 0;
                const score = priority * 1000 + dist;
                if (score < bestScore) {
                    bestScore = score;
                    best = entry;
                }
            }
        }
    }
    return best;
}

function render(): void {
    hitGrid.clear();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const theme = readTheme();
    const sc = scenario();

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    if (!sc) return;

    if (state.showGrid) drawGrid(theme);
    if (state.showNebulas) drawNebulas(sc, theme);
    if (state.showEstimatedLanes && sc.settings.randomHyperlanes) drawEstimatedLanes(sc, theme);
    if (state.showLanes) drawHyperlanes(sc, theme);
    if (state.showRanges) drawRanges(sc, theme);
    drawSystems(sc, theme);
    if (state.pendingLink) drawPendingLink(theme);
    drawLabels(sc, theme);
}

/** Chained lane drawing: committed segments solid, live segment dashed. */
function drawPendingLink(theme: Theme): void {
    const pending = state.pendingLink;
    if (!pending) return;
    const systems = systemsByKey();
    const centers: Array<{ x: number; y: number }> = [];
    for (const key of pending.path) {
        const sys = systems.get(key);
        if (!sys) continue;
        centers.push(worldToScreen(...centerTuple(nodeCenter(sys))));
    }
    if (centers.length === 0) return;

    // Committed segments.
    ctx.strokeStyle = theme.laneAdd;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = 1; i < centers.length; i++) {
        ctx.moveTo(centers[i - 1]!.x, centers[i - 1]!.y);
        ctx.lineTo(centers[i]!.x, centers[i]!.y);
    }
    ctx.stroke();

    // Live segment from the last endpoint to the hovered system or cursor.
    const last = centers[centers.length - 1]!;
    const hover = pending.hoverNodeKey ? systems.get(pending.hoverNodeKey) : undefined;
    const tail = hover ? worldToScreen(...centerTuple(nodeCenter(hover))) : { x: pending.cursorX, y: pending.cursorY };
    ctx.strokeStyle = hover ? theme.laneAdd : theme.accent;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(tail.x, tail.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Endpoint rings: start in accent, the rest in lane green.
    centers.forEach((c, i) => {
        ctx.beginPath();
        ctx.arc(c.x, c.y, i === 0 ? 8 : 6, 0, Math.PI * 2);
        ctx.strokeStyle = i === 0 ? theme.accent : theme.laneAdd;
        ctx.lineWidth = 2;
        ctx.stroke();
    });
}

function drawGrid(theme: Theme): void {
    const steps = [5, 10, 25, 50, 100, 250, 500, 1000];
    const step = steps.find(s => s * state.viewport.scale >= 42) ?? 1000;
    // Both axes are screen-flipped, so normalize world extents explicitly.
    const cornerA = screenToWorld(0, 0);
    const cornerB = screenToWorld(canvasWidth, canvasHeight);
    const minX = Math.min(cornerA.x, cornerB.x);
    const maxX = Math.max(cornerA.x, cornerB.x);
    const minY = Math.min(cornerA.y, cornerB.y);
    const maxY = Math.max(cornerA.y, cornerB.y);

    ctx.strokeStyle = theme.grid;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(minX / step) * step; x <= maxX; x += step) {
        const sx = worldToScreen(x, 0).x;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, canvasHeight);
    }
    for (let y = Math.floor(minY / step) * step; y <= maxY; y += step) {
        const sy = worldToScreen(0, y).y;
        ctx.moveTo(0, sy);
        ctx.lineTo(canvasWidth, sy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
}

function drawNebulas(sc: StaticGalaxyScenarioView, theme: Theme): void {
    for (const nebula of sc.nebulas) {
        const c = nodeCenter(nebula);
        const s = worldToScreen(c.x, c.y);
        const radius = Math.max(4, (nebula.radius ?? 20) * state.viewport.scale);
        const selected = state.selection?.nodeKey === nebula.nodeKey;
        ctx.beginPath();
        ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = theme.nebula;
        ctx.globalAlpha = selected ? 0.28 : 0.14;
        ctx.fill();
        ctx.globalAlpha = selected ? 0.9 : 0.45;
        ctx.strokeStyle = theme.nebula;
        ctx.lineWidth = selected ? 2 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        registerHit({ kind: 'nebula', nodeKey: nebula.nodeKey, sx: s.x, sy: s.y, r: Math.min(radius, 30) });
    }
}

/**
 * Estimated lanes for random_hyperlanes scenarios: a clearly-marked heuristic
 * layer (k-nearest within max distance), recomputed lazily after new data.
 */
function drawEstimatedLanes(sc: StaticGalaxyScenarioView, theme: Theme): void {
    if (state.estimatedDirty || !state.estimatedLanes) {
        const points = sc.systems
            .filter(s => s.effectivePosition.x.kind !== 'unresolved' && s.effectivePosition.y.kind !== 'unresolved')
            .map(s => ({ nodeKey: s.nodeKey, x: axisCenter(s.effectivePosition.x), y: axisCenter(s.effectivePosition.y) }));
        state.estimatedLanes = estimateHyperlanes(
            points,
            sc.settings.maxHyperlaneDistance ?? STATIC_GALAXY_DEFAULT_LANE_DISTANCE,
            sc.settings.hyperlaneDensity ?? 1,
        );
        state.estimatedDirty = false;
    }
    const systems = systemsByKey();
    ctx.strokeStyle = theme.fgDim;
    ctx.globalAlpha = 0.28;
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [aKey, bKey] of state.estimatedLanes) {
        const a = systems.get(aKey);
        const b = systems.get(bKey);
        if (!a || !b) continue;
        const sa = worldToScreen(...centerTuple(nodeCenter(a)));
        const sb = worldToScreen(...centerTuple(nodeCenter(b)));
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
}

function drawHyperlanes(sc: StaticGalaxyScenarioView, theme: Theme): void {
    const systems = systemsByKey();
    for (const lane of sc.hyperlanes) {
        if (!lane.fromNodeKey || !lane.toNodeKey) continue;
        const from = systems.get(lane.fromNodeKey);
        const to = systems.get(lane.toNodeKey);
        if (!from || !to) continue;
        const a = worldToScreen(...centerTuple(nodeCenter(from)));
        const b = worldToScreen(...centerTuple(nodeCenter(to)));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        if (lane.kind === 'add') {
            ctx.strokeStyle = theme.laneAdd;
            ctx.globalAlpha = 0.55;
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = theme.error;
            ctx.globalAlpha = 0.7;
            ctx.setLineDash([5, 4]);
        }
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
}

function centerTuple(c: { x: number; y: number }): [number, number] {
    return [c.x, c.y];
}

function drawRanges(sc: StaticGalaxyScenarioView, theme: Theme): void {
    ctx.lineWidth = 1;
    for (const sys of sc.systems) {
        const rx = sys.effectivePosition.x;
        const ry = sys.effectivePosition.y;
        if (rx.kind !== 'range' && ry.kind !== 'range') continue;
        const minX = rx.kind === 'range' ? rx.min : axisCenter(rx);
        const maxX = rx.kind === 'range' ? rx.max : axisCenter(rx);
        const minY = ry.kind === 'range' ? ry.min : axisCenter(ry);
        const maxY = ry.kind === 'range' ? ry.max : axisCenter(ry);
        const a = worldToScreen(minX, maxY);
        const b = worldToScreen(maxX, minY);
        // The X flip puts minX on the right — normalize the screen rect.
        const left = Math.min(a.x, b.x);
        const right = Math.max(a.x, b.x);
        const top = Math.min(a.y, b.y);
        const bottom = Math.max(a.y, b.y);
        const selected = state.selection?.nodeKey === sys.nodeKey;
        ctx.strokeStyle = selected ? theme.accent : theme.fgDim;
        ctx.globalAlpha = selected ? 0.9 : 0.4;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(left, top, Math.max(2, right - left), Math.max(2, bottom - top));
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
}

function systemMatchesSearch(sys: StaticGalaxySystemView, query: string): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    return sys.id.toLowerCase().includes(q)
        || (sys.name?.toLowerCase().includes(q) ?? false)
        || (sys.initializer?.toLowerCase().includes(q) ?? false);
}

function drawSystems(sc: StaticGalaxyScenarioView, theme: Theme): void {
    const query = state.search.trim();
    for (const sys of sc.systems) {
        const c = nodeCenter(sys);
        const s = worldToScreen(c.x, c.y);
        if (s.x < -20 || s.x > canvasWidth + 20 || s.y < -20 || s.y > canvasHeight + 20) continue;

        const selected = state.selection?.nodeKey === sys.nodeKey;
        const hovered = state.hover?.nodeKey === sys.nodeKey;
        const severity = worstSeverity(sys.diagnostics);
        const named = Boolean(sys.name || sys.initializer);
        const dimmed = query !== '' && !systemMatchesSearch(sys, query);
        const unresolved = sys.effectivePosition.x.kind === 'unresolved' || sys.effectivePosition.y.kind === 'unresolved';

        let radius = named ? 3.5 : 2.8;
        if (hovered) radius += 1;
        if (selected) radius = 6;

        ctx.globalAlpha = dimmed ? 0.15 : 1;

        // Uneditable nodes get a dashed ring.
        if (!sys.editable && !unresolved) {
            ctx.beginPath();
            ctx.arc(s.x, s.y, radius + 3, 0, Math.PI * 2);
            ctx.strokeStyle = theme.fgDim;
            ctx.globalAlpha = dimmed ? 0.15 : 0.5;
            ctx.setLineDash([2, 2]);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = dimmed ? 0.15 : 1;
        }

        ctx.beginPath();
        ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
        if (selected) {
            ctx.fillStyle = theme.accent;
        } else if (unresolved) {
            ctx.fillStyle = theme.fgDim;
        } else {
            ctx.fillStyle = named ? theme.fg : theme.fgDim;
        }
        ctx.fill();

        if (severity === 'error' || severity === 'warning') {
            ctx.beginPath();
            ctx.arc(s.x, s.y, radius + 2.5, 0, Math.PI * 2);
            ctx.strokeStyle = severity === 'error' ? theme.error : theme.warning;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        if (selected) {
            ctx.beginPath();
            ctx.arc(s.x, s.y, radius + 3.5, 0, Math.PI * 2);
            ctx.strokeStyle = theme.accent;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        registerHit({ kind: 'system', nodeKey: sys.nodeKey, sx: s.x, sy: s.y, r: radius });
    }
}

function drawLabels(sc: StaticGalaxyScenarioView, theme: Theme): void {
    if (!state.showLabels) return;
    const scale = state.viewport.scale;
    const showNamed = scale >= 2.2;
    const showIds = scale >= 7;
    const occupied = new Set<string>();
    const CELL_W = 92;
    const CELL_H = 16;

    ctx.font = '11px var(--vscode-font-family, sans-serif)';
    ctx.textBaseline = 'top';

    const placeLabel = (sx: number, sy: number, text: string, color: string, bold: boolean): void => {
        const cell = `${Math.floor(sx / CELL_W)},${Math.floor(sy / CELL_H)}`;
        if (occupied.has(cell)) return;
        occupied.add(cell);
        ctx.font = `${bold ? '600 ' : ''}11px var(--vscode-font-family, sans-serif)`;
        ctx.fillStyle = color;
        ctx.fillText(text, sx + 6, sy - 5);
    };

    for (const sys of sc.systems) {
        const selected = state.selection?.nodeKey === sys.nodeKey;
        const hovered = state.hover?.nodeKey === sys.nodeKey;
        const severity = worstSeverity(sys.diagnostics);
        const important = selected || hovered || severity === 'error' || severity === 'warning';
        if (!important) {
            if (!showNamed) continue;
            if (!sys.name && !showIds) continue;
        }
        const c = nodeCenter(sys);
        const s = worldToScreen(c.x, c.y);
        if (s.x < -60 || s.x > canvasWidth + 60 || s.y < -20 || s.y > canvasHeight + 20) continue;
        let text = sys.name ?? '';
        if (showIds || (!text && important)) {
            text = text ? `${text} (${sys.id})` : sys.id;
        }
        if (!text) continue;
        placeLabel(s.x, s.y, text, selected ? theme.accent : theme.label, selected || hovered);
    }

    if (state.showNebulas) {
        // Nebula names clutter dense regions at overview zoom; reveal them as
        // the user zooms in. Selected/hovered nebulas stay labeled.
        const showNebulaLabels = scale >= 1.2;
        for (const nebula of sc.nebulas) {
            if (!nebula.name) continue;
            const emphasized = state.selection?.nodeKey === nebula.nodeKey || state.hover?.nodeKey === nebula.nodeKey;
            if (!showNebulaLabels && !emphasized) continue;
            const c = nodeCenter(nebula);
            const s = worldToScreen(c.x, c.y);
            placeLabel(s.x, s.y, nebula.name, theme.nebula, emphasized);
        }
    }
}

// ─── Canvas sizing ──────────────────────────────────────────────────────────

function resizeCanvas(): void {
    const rect = viewportEl.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvasWidth = Math.max(1, rect.width);
    canvasHeight = Math.max(1, rect.height);
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    scheduleRender();
}

const resizeObserver = new ResizeObserver(() => resizeCanvas());
resizeObserver.observe(viewportEl);

// ─── Tooltip ────────────────────────────────────────────────────────────────

function formatAxis(axis: StaticGalaxyAxis): string {
    switch (axis.kind) {
        case 'fixed': return formatNumber(axis.value);
        case 'range': return `${formatNumber(axis.min)} .. ${formatNumber(axis.max)}${axis.reversed ? ' ⚠' : ''}`;
        case 'unresolved': return axis.raw || '?';
    }
}

function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function showTooltip(x: number, y: number, html: string): void {
    tooltipEl.innerHTML = html;
    tooltipEl.classList.remove('hidden');
    const rect = viewportEl.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + tipRect.width > rect.width - 8) left = x - tipRect.width - 10;
    if (top + tipRect.height > rect.height - 8) top = y - tipRect.height - 10;
    tooltipEl.style.left = `${Math.max(4, left)}px`;
    tooltipEl.style.top = `${Math.max(4, top)}px`;
}

function hideTooltip(): void {
    tooltipEl.classList.add('hidden');
}

function tooltipHtml(kind: NodeKind, nodeKey: string): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
    if (kind === 'system') {
        const sys = findSystem(nodeKey);
        if (!sys) return '';
        const lines = [
            `<div class="tooltip-title">${esc(sys.displayName)}</div>`,
            `<div class="tooltip-sub">id: ${esc(sys.id)}${sys.initializer ? ` · ${esc(sys.initializer)}` : ''}</div>`,
            `<div class="tooltip-sub">${tr('raw', '原始')}: x ${esc(formatAxis(sys.rawPosition.x))}, y ${esc(formatAxis(sys.rawPosition.y))}${sys.rawPosition.z ? `, z ${esc(formatAxis(sys.rawPosition.z))}` : ''}</div>`,
        ];
        if (sys.transformApplied) {
            lines.push(`<div class="tooltip-sub">${tr('effective', '有效')}: x ${esc(formatAxis(sys.effectivePosition.x))}, y ${esc(formatAxis(sys.effectivePosition.y))}${sys.effectivePosition.z ? `, z ${esc(formatAxis(sys.effectivePosition.z))}` : ''}</div>`);
        }
        for (const d of sys.diagnostics.slice(0, 3)) {
            lines.push(`<div class="tooltip-diag">${esc(d.message)}</div>`);
        }
        return lines.join('');
    }
    const nebula = findNebula(nodeKey);
    if (!nebula) return '';
    return [
        `<div class="tooltip-title">${esc(nebula.displayName)}</div>`,
        `<div class="tooltip-sub">${tr('radius', '半径')}: ${nebula.radius ?? '?'}</div>`,
        `<div class="tooltip-sub">${tr('raw', '原始')}: x ${esc(formatAxis(nebula.rawPosition.x))}, y ${esc(formatAxis(nebula.rawPosition.y))}${nebula.rawPosition.z ? `, z ${esc(formatAxis(nebula.rawPosition.z))}` : ''}</div>`,
    ].join('');
}

// ─── Pointer interactions ───────────────────────────────────────────────────

const DRAG_THRESHOLD_PX = 4;

function canvasPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function snapValue(value: number, e: { shiftKey: boolean; altKey: boolean }): number {
    if (e.altKey) return value; // freehand; host still rounds to a legal int
    const grid = e.shiftKey ? 5 : 1;
    return Math.round(value / grid) * grid;
}

viewportEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.target !== canvas) return;
    viewportEl.focus();
    const p = canvasPoint(e);
    const hit = hitTest(p.x, p.y);

    // Right-click: confirm a chained drawing (≥2 endpoints), cancel it (no
    // endpoint yet), arm one from a system, or delete the lane under the cursor.
    if (e.button === 2) {
        if (state.mode === 'edit' && state.permissions.canEdit) {
            if (state.pendingLink) {
                const pending = state.pendingLink;
                clearPendingLink();
                if (pending.path.length >= 2) {
                    submitAddLanes(pending.path);
                }
                scheduleRender();
            } else if (hit?.kind === 'system' && state.applyingNodeKey === null) {
                const sys = findSystem(hit.nodeKey);
                if (sys && sys.id !== '') {
                    state.pendingLink = { path: [sys.nodeKey], cursorX: p.x, cursorY: p.y };
                    viewportEl.classList.add('linking');
                    setSelection('system', sys.nodeKey);
                    scheduleRender();
                }
            } else if (!hit && state.applyingNodeKey === null) {
                const lane = hitTestLane(p.x, p.y);
                if (lane?.fromNodeKey && lane.toNodeKey) {
                    deleteHyperlane(lane.fromNodeKey, lane.toNodeKey);
                }
            }
        }
        e.preventDefault();
        return;
    }

    // In draw mode left-click only extends the endpoint chain — systems cannot
    // be dragged and nebulas cannot be selected. Right-click confirms next.
    if (e.button === 0 && state.pendingLink) {
        const pending = state.pendingLink;
        if (hit?.kind === 'system' && hit.nodeKey !== pending.path[pending.path.length - 1]) {
            if (!pending.path.includes(hit.nodeKey)) {
                pending.path.push(hit.nodeKey);
                pending.hoverNodeKey = undefined;
            }
        } else if (!hit || hit.kind !== 'system') {
            clearPendingLink();
        }
        scheduleRender();
        e.preventDefault();
        return;
    }

    const wantsPan = e.button === 1 || (e.button === 0 && (e.altKey || state.spacePan));
    if (wantsPan) {
        state.pan = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
        viewportEl.setPointerCapture(e.pointerId);
        viewportEl.classList.add('panning');
        e.preventDefault();
        return;
    }
    if (e.button !== 0) return;

    if (state.mode === 'edit' && hit) {
        const node = hit.kind === 'system' ? findSystem(hit.nodeKey) : findNebula(hit.nodeKey);
        if (node?.editable && state.applyingNodeKey === null) {
            const world = screenToWorld(p.x, p.y);
            const center = nodeCenter(node);
            state.drag = {
                pointerId: e.pointerId,
                kind: hit.kind,
                nodeKey: node.nodeKey,
                startScreenX: p.x,
                startScreenY: p.y,
                grabOffsetX: world.x - center.x,
                grabOffsetY: world.y - center.y,
                origCenterX: center.x,
                origCenterY: center.y,
                targetX: center.x,
                targetY: center.y,
                moved: false,
                dragging: false,
            };
            viewportEl.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
    }

    if (hit) {
        setSelection(hit.kind, hit.nodeKey);
    } else {
        setSelection(null);
    }
});

viewportEl.addEventListener('pointermove', (e: PointerEvent) => {
    const p = canvasPoint(e);

    if (state.pan && state.pan.pointerId === e.pointerId) {
        const dx = e.clientX - state.pan.lastX;
        const dy = e.clientY - state.pan.lastY;
        state.pan.lastX = e.clientX;
        state.pan.lastY = e.clientY;
        state.viewport.cx += dx / state.viewport.scale;
        state.viewport.cy += dy / state.viewport.scale;
        scheduleRender();
        return;
    }

    if (state.drag && state.drag.pointerId === e.pointerId) {
        const drag = state.drag;
        if (!drag.dragging) {
            const dist = Math.hypot(p.x - drag.startScreenX, p.y - drag.startScreenY);
            if (dist >= DRAG_THRESHOLD_PX) {
                drag.dragging = true;
                drag.moved = true;
            } else {
                return;
            }
        }
        const world = screenToWorld(p.x, p.y);
        drag.targetX = snapValue(world.x - drag.grabOffsetX, e);
        drag.targetY = snapValue(world.y - drag.grabOffsetY, e);
        state.previewPositions.set(drag.nodeKey, { x: drag.targetX, y: drag.targetY });
        updateDragHud(drag);
        scheduleRender();
        return;
    }

    // Pending chain: the rubber-band follows the cursor from the last endpoint;
    // left-click extends the chain, right-click confirms all segments.
    if (state.pendingLink) {
        const link = state.pendingLink;
        link.cursorX = p.x;
        link.cursorY = p.y;
        const hit = hitTest(p.x, p.y);
        link.hoverNodeKey = hit?.kind === 'system' && !link.path.includes(hit.nodeKey) ? hit.nodeKey : undefined;
        viewportEl.classList.add('linking');
        scheduleRender();
        return;
    }

    // Hover.
    const hit = hitTest(p.x, p.y);
    const nextHover = hit ? { kind: hit.kind, nodeKey: hit.nodeKey } : null;
    const changed = nextHover?.nodeKey !== state.hover?.nodeKey;
    state.hover = nextHover;
    if (nextHover) {
        showTooltip(p.x, p.y, tooltipHtml(nextHover.kind, nextHover.nodeKey));
    } else {
        hideTooltip();
    }
    updateCursor(hit);
    if (changed) scheduleRender();
});

function endDrag(e: PointerEvent, commit: boolean): void {
    const drag = state.drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    state.drag = null;
    dragHudEl.classList.add('hidden');
    try {
        viewportEl.releasePointerCapture(e.pointerId);
    } catch { /* capture may already be gone */ }

    if (!commit || !drag.dragging) {
        // Cancelled or a plain click: rollback preview, treat click as select.
        state.previewPositions.delete(drag.nodeKey);
        if (drag.dragging) {
            scheduleRender();
        } else if (commit) {
            setSelection(drag.kind, drag.nodeKey);
        }
        return;
    }

    const dx = drag.targetX - drag.origCenterX;
    const dy = drag.targetY - drag.origCenterY;
    if (dx === 0 && dy === 0) {
        state.previewPositions.delete(drag.nodeKey);
        scheduleRender();
        return;
    }
    submitMove(drag.kind, drag.nodeKey, drag.targetX, drag.targetY);
}

viewportEl.addEventListener('pointerup', (e: PointerEvent) => {
    if (state.pan && state.pan.pointerId === e.pointerId) {
        state.pan = null;
        viewportEl.classList.remove('panning');
        try {
            viewportEl.releasePointerCapture(e.pointerId);
        } catch { /* ignore */ }
        return;
    }
    endDrag(e, true);
});

viewportEl.addEventListener('pointercancel', (e: PointerEvent) => {
    if (state.pan && state.pan.pointerId === e.pointerId) {
        state.pan = null;
        viewportEl.classList.remove('panning');
        return;
    }
    endDrag(e, false);
});

viewportEl.addEventListener('dblclick', (e: MouseEvent) => {
    const p = canvasPoint(e);
    const hit = hitTest(p.x, p.y);
    if (hit && state.revision) {
        post({ type: 'goToSource', revisionId: state.revision.revisionId, nodeKey: hit.nodeKey });
    }
});

viewportEl.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const p = canvasPoint(e);
    const before = screenToWorld(p.x, p.y);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    state.viewport.scale = clamp(state.viewport.scale * factor, 0.02, 400);
    const after = screenToWorld(p.x, p.y);
    state.viewport.cx += before.x - after.x;
    state.viewport.cy += before.y - after.y;
    updateZoomLabel();
    scheduleRender();
}, { passive: false });

function updateCursor(hit: HitEntry | null): void {
    let canDrag = false;
    if (state.mode === 'edit' && hit) {
        const node = hit.kind === 'system' ? findSystem(hit.nodeKey) : findNebula(hit.nodeKey);
        canDrag = Boolean(node?.editable) && state.applyingNodeKey === null;
    }
    viewportEl.classList.toggle('can-drag', canDrag);
}

function updateDragHud(drag: DragState): void {
    const dx = drag.targetX - drag.origCenterX;
    const dy = drag.targetY - drag.origCenterY;
    dragHudEl.innerHTML = `(${formatNumber(drag.targetX)}, ${formatNumber(drag.targetY)})` +
        `<span class="hud-delta">Δ ${formatNumber(dx)}, ${formatNumber(dy)}</span>`;
    dragHudEl.classList.remove('hidden');
}

// ─── Edit submission ────────────────────────────────────────────────────────

function post(message: StaticGalaxyWebviewMessage): void {
    vscode.postMessage(message);
}

function submitMove(kind: NodeKind, nodeKey: string, x: number, y: number): void {
    const rev = state.revision;
    if (!rev || state.applyingNodeKey !== null) return;
    const requestId = `req-${++state.requestCounter}`;
    state.applyingNodeKey = nodeKey;
    const envelope = { requestId, revisionId: rev.revisionId, documentVersion: rev.documentVersion };
    if (kind === 'system') {
        post({ type: 'moveSystems', ...envelope, moves: [{ nodeKey, x, y }] });
    } else {
        post({ type: 'moveNebula', ...envelope, move: { nodeKey, x, y } });
    }
}

function submitUpdate(
    nodeKey: string,
    x: StaticGalaxyAxisUpdate | undefined,
    y: StaticGalaxyAxisUpdate | undefined,
    z: StaticGalaxyAxisUpdate | undefined,
): void {
    const rev = state.revision;
    if (!rev || state.applyingNodeKey !== null || (!x && !y && !z)) return;
    const requestId = `req-${++state.requestCounter}`;
    state.applyingNodeKey = nodeKey;
    post({
        type: 'updatePosition',
        requestId,
        revisionId: rev.revisionId,
        documentVersion: rev.documentVersion,
        update: { nodeKey, x, y, z },
    });
}

function submitHyperlane(fromNodeKey: string, toNodeKey: string, connected: boolean): void {
    const rev = state.revision;
    if (!rev || state.applyingNodeKey !== null) return;
    state.applyingNodeKey = fromNodeKey;
    post({
        type: 'setHyperlane',
        requestId: `req-${++state.requestCounter}`,
        revisionId: rev.revisionId,
        documentVersion: rev.documentVersion,
        update: { fromNodeKey, toNodeKey, connected },
    });
}

/** Confirms a chained lane drawing: all consecutive pairs in one WorkspaceEdit. */
function submitAddLanes(path: string[]): void {
    const rev = state.revision;
    if (!rev || state.applyingNodeKey !== null || path.length < 2) return;
    state.applyingNodeKey = path[0]!;
    const links: Array<{ fromNodeKey: string; toNodeKey: string }> = [];
    for (let i = 1; i < path.length; i++) {
        links.push({ fromNodeKey: path[i - 1]!, toNodeKey: path[i]! });
    }
    post({
        type: 'addHyperlanes',
        requestId: `req-${++state.requestCounter}`,
        revisionId: rev.revisionId,
        documentVersion: rev.documentVersion,
        links,
    });
}

/** Asks the Host to delete the add_hyperlane declaration(s) for this pair. */
function deleteHyperlane(fromNodeKey: string, toNodeKey: string): void {
    const rev = state.revision;
    if (!rev || state.applyingNodeKey !== null) return;
    state.applyingNodeKey = fromNodeKey;
    post({
        type: 'deleteHyperlane',
        requestId: `req-${++state.requestCounter}`,
        revisionId: rev.revisionId,
        documentVersion: rev.documentVersion,
        fromNodeKey,
        toNodeKey,
    });
}

function submitNebulaRadius(nodeKey: string, radius: number): void {
    const rev = state.revision;
    if (!rev || state.applyingNodeKey !== null) return;
    state.applyingNodeKey = nodeKey;
    post({
        type: 'updateNebulaRadius',
        requestId: `req-${++state.requestCounter}`,
        revisionId: rev.revisionId,
        documentVersion: rev.documentVersion,
        nodeKey,
        radius,
    });
}

/** Edits queued behind the in-flight request (one WorkspaceEdit at a time). */
const pendingFollowUps: Array<() => void> = [];

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Nearest explicit lane within a small screen-pixel threshold (add lanes win ties). */
function hitTestLane(sx: number, sy: number): StaticGalaxyHyperlaneView | null {
    const sc = scenario();
    if (!sc || !state.showLanes) return null;
    const systems = systemsByKey();
    let best: { lane: StaticGalaxyHyperlaneView; dist: number } | null = null;
    for (const lane of sc.hyperlanes) {
        if (!lane.fromNodeKey || !lane.toNodeKey) continue;
        const from = systems.get(lane.fromNodeKey);
        const to = systems.get(lane.toNodeKey);
        if (!from || !to) continue;
        const a = worldToScreen(...centerTuple(nodeCenter(from)));
        const b = worldToScreen(...centerTuple(nodeCenter(to)));
        const dist = distToSegment(sx, sy, a.x, a.y, b.x, b.y);
        if (dist > 6) continue;
        if (!best || dist < best.dist || (lane.kind === 'add' && best.lane.kind !== 'add')) {
            best = { lane, dist };
        }
    }
    return best?.lane ?? null;
}

function clearPendingLink(): void {
    state.pendingLink = null;
    viewportEl.classList.remove('linking');
}

// The canvas uses right-click for hyperlane linking; suppress the browser menu.
viewportEl.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
});

// ─── Selection & inspector ──────────────────────────────────────────────────

function setSelection(kind: NodeKind | null, nodeKey?: string): void {
    state.selection = kind && nodeKey !== undefined ? { kind, nodeKey } : null;
    el<HTMLButtonElement>('btn-focus').disabled = !state.selection;
    renderInspector();
    scheduleRender();
}

function axisSummary(axis: StaticGalaxyAxis): { text: string; reversed: boolean } {
    switch (axis.kind) {
        case 'fixed': return { text: formatNumber(axis.value), reversed: false };
        case 'range':
            return {
                text: `${formatNumber(axis.min)} .. ${formatNumber(axis.max)} (${tr('width', '宽度')} ${formatNumber(axis.width)})`,
                reversed: axis.reversed,
            };
        case 'unresolved': return { text: `${axis.raw} (${axis.reason})`, reversed: false };
    }
}

function detailRow(label: string, value: string, reversed = false): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
    return `<div class="detail-row"><span class="detail-label">${esc(label)}</span><span class="detail-value${reversed ? ' reversed' : ''}">${esc(value)}</span></div>`;
}

function renderInspector(): void {
    const sc = scenario();
    if (!sc) {
        selectionTitleEl.textContent = tr('Galaxy overview', '银河概览');
        infoPanelEl.textContent = tr('No scenario loaded', '未加载场景');
        propsPanelEl.classList.add('hidden');
        infoPanelEl.classList.remove('hidden');
        return;
    }

    if (!state.selection) {
        selectionTitleEl.textContent = tr('Galaxy overview', '银河概览');
        const errorCount = countDiagnostics(sc, 'error');
        const warningCount = countDiagnostics(sc, 'warning');
        infoPanelEl.innerHTML = [
            `<div class="detail-section"><div class="detail-title">${tr('Scenario', '场景')}</div>`,
            detailRow(tr('Name', '名称'), sc.name),
            detailRow(tr('Systems', '系统'), String(sc.systems.length)),
            detailRow(tr('Nebulas', '星云'), String(sc.nebulas.length)),
            detailRow(tr('Explicit lanes', '显式航道'), String(sc.hyperlanes.length)),
            detailRow('random_hyperlanes', sc.settings.randomHyperlanes ? 'yes' : 'no'),
            `</div>`,
            `<div class="detail-section"><div class="detail-title">${tr('Diagnostics', '诊断')}</div>`,
            detailRow(tr('Errors', '错误'), String(errorCount)),
            detailRow(tr('Warnings', '警告'), String(warningCount)),
            `</div>`,
        ].join('');
        propsPanelEl.classList.add('hidden');
        infoPanelEl.classList.remove('hidden');
        return;
    }

    const { kind, nodeKey } = state.selection;
    if (kind === 'system') {
        const sys = findSystem(nodeKey);
        if (!sys) {
            setSelection(null);
            return;
        }
        selectionTitleEl.textContent = sys.displayName;
        const sections: string[] = [
            `<div class="detail-section"><div class="detail-title">${tr('System', '系统')}</div>`,
            detailRow('ID', sys.id),
        ];
        if (sys.name) sections.push(detailRow(tr('Name', '名称'), sys.name));
        if (sys.initializer) sections.push(detailRow('initializer', sys.initializer));
        sections.push(`</div>`);

        sections.push(`<div class="detail-section"><div class="detail-title">${tr('Raw coordinates (file)', '原始坐标（文件）')}</div>`);
        const rawX = axisSummary(sys.rawPosition.x);
        const rawY = axisSummary(sys.rawPosition.y);
        sections.push(detailRow('x', rawX.text, rawX.reversed));
        sections.push(detailRow('y', rawY.text, rawY.reversed));
        sections.push(detailRow('z', sys.rawPosition.z ? axisSummary(sys.rawPosition.z).text : tr('not set', '未设置')));
        sections.push(`</div>`);

        if (sys.transformApplied) {
            sections.push(`<div class="detail-section"><div class="detail-title">${tr('Effective coordinates (canvas)', '有效坐标（画布）')}</div>`);
            sections.push(detailRow('x', axisSummary(sys.effectivePosition.x).text));
            sections.push(detailRow('y', axisSummary(sys.effectivePosition.y).text));
            if (sys.effectivePosition.z) sections.push(detailRow('z', axisSummary(sys.effectivePosition.z).text));
            sections.push(`</div>`);
        }

        if (sys.diagnostics.length > 0) {
            sections.push(`<div class="detail-section node-diags"><div class="detail-title">${tr('Diagnostics', '诊断')}</div>`);
            for (const d of sys.diagnostics) {
                sections.push(`<div class="diagnostic-item severity-${d.severity}"><span class="diag-badge">${d.severity}</span><span class="diag-message">${d.message}</span></div>`);
            }
            sections.push(`</div>`);
        }
        infoPanelEl.innerHTML = sections.join('');
        renderNodeProps(sys);
    } else {
        const nebula = findNebula(nodeKey);
        if (!nebula) {
            setSelection(null);
            return;
        }
        selectionTitleEl.textContent = nebula.displayName;
        const sections: string[] = [
            `<div class="detail-section"><div class="detail-title">${tr('Nebula', '星云')}</div>`,
        ];
        if (nebula.name) sections.push(detailRow(tr('Name', '名称'), nebula.name));
        sections.push(detailRow(tr('Radius', '半径'), nebula.radius === null ? '?' : formatNumber(nebula.radius)));
        sections.push(`</div>`);
        sections.push(`<div class="detail-section"><div class="detail-title">${tr('Raw coordinates (file)', '原始坐标（文件）')}</div>`);
        sections.push(detailRow('x', axisSummary(nebula.rawPosition.x).text));
        sections.push(detailRow('y', axisSummary(nebula.rawPosition.y).text));
        sections.push(detailRow('z', nebula.rawPosition.z ? axisSummary(nebula.rawPosition.z).text : tr('not set', '未设置')));
        sections.push(`</div>`);
        if (nebula.transformApplied) {
            sections.push(`<div class="detail-section"><div class="detail-title">${tr('Effective coordinates (canvas)', '有效坐标（画布）')}</div>`);
            sections.push(detailRow('x', axisSummary(nebula.effectivePosition.x).text));
            sections.push(detailRow('y', axisSummary(nebula.effectivePosition.y).text));
            if (nebula.effectivePosition.z) sections.push(detailRow('z', axisSummary(nebula.effectivePosition.z).text));
            sections.push(`</div>`);
        }
        if (nebula.diagnostics.length > 0) {
            sections.push(`<div class="detail-section node-diags"><div class="detail-title">${tr('Diagnostics', '诊断')}</div>`);
            for (const d of nebula.diagnostics) {
                sections.push(`<div class="diagnostic-item severity-${d.severity}"><span class="diag-badge">${d.severity}</span><span class="diag-message">${d.message}</span></div>`);
            }
            sections.push(`</div>`);
        }
        infoPanelEl.innerHTML = sections.join('');
        renderNodeProps(nebula);
    }
    renderInspectorActions(kind, nodeKey);
}

function renderInspectorActions(kind: NodeKind, nodeKey: string): void {
    // Actions row is appended into infoPanel (go-to-source available in both modes).
    const container = document.createElement('div');
    container.className = 'detail-actions';
    const gotoBtn = document.createElement('button');
    gotoBtn.type = 'button';
    gotoBtn.id = 'btn-goto-source';
    gotoBtn.textContent = tr('Go to source', '跳转源码');
    gotoBtn.addEventListener('click', () => {
        if (state.revision) post({ type: 'goToSource', revisionId: state.revision.revisionId, nodeKey });
    });
    container.appendChild(gotoBtn);

    const node = kind === 'system' ? findSystem(nodeKey) : findNebula(nodeKey);
    if (node && state.mode === 'edit' && node.editable) {
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.id = 'btn-apply-coords';
        applyBtn.textContent = tr('Apply coordinates', '应用坐标');
        applyBtn.addEventListener('click', () => applyInspectorCoords(node));
        container.appendChild(applyBtn);
    }
    infoPanelEl.appendChild(container);
}

type EditablePositionNode = StaticGalaxySystemView | StaticGalaxyNebulaView;

function renderNodeProps(node: EditablePositionNode): void {
    if (state.mode !== 'edit') {
        propsPanelEl.classList.add('hidden');
        infoPanelEl.classList.remove('hidden');
        return;
    }

    infoPanelEl.classList.remove('hidden');
    propsPanelEl.classList.remove('hidden');
    propsPanelEl.innerHTML = '';

    if (node.editable) {
        renderCoordinateEditor(node, propsPanelEl);
    } else {
        const note = document.createElement('div');
        note.className = 'edit-blocked-note';
        note.textContent = tr('Coordinate editing disabled: ', '坐标编辑已禁用：') + (node.editBlockedReason ?? '');
        propsPanelEl.appendChild(note);
    }

    if (!('id' in node)) renderNebulaRadiusEditor(node, propsPanelEl);
    if ('id' in node) renderHyperlaneEditor(node, propsPanelEl);
}

/** Nebula radius input — independent of position editability (radius is a plain float). */
function renderNebulaRadiusEditor(nebula: StaticGalaxyNebulaView, parent: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'detail-section';
    const title = document.createElement('div');
    title.className = 'detail-title';
    title.textContent = tr('Nebula radius', '星云半径');
    wrap.appendChild(title);

    if (!nebula.radiusEditable) {
        const note = document.createElement('div');
        note.className = 'edit-blocked-note';
        note.textContent = tr('Radius is not a literal number in source — edit it in the text editor.', '源码中的半径不是字面数字，请在文本编辑器中修改。');
        wrap.appendChild(note);
        parent.appendChild(wrap);
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'coord-inputs';
    const labelEl = document.createElement('label');
    labelEl.textContent = tr('radius', '半径');
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.5';
    input.min = '0';
    input.id = 'prop-radius-value';
    input.value = nebula.radius === null ? '' : String(nebula.radius);
    if (nebula.radius === null) input.placeholder = tr('not set', '未设置');
    input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            applyInspectorCoords(nebula);
        }
    });
    labelEl.appendChild(input);
    grid.appendChild(labelEl);
    wrap.appendChild(grid);
    parent.appendChild(wrap);
}

function renderCoordinateEditor(node: EditablePositionNode, parent: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'detail-section';
    const title = document.createElement('div');
    title.className = 'detail-title';
    title.textContent = tr('Edit raw coordinates', '编辑原始坐标');
    wrap.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'coord-inputs';
    const addInput = (id: string, label: string, value: number | undefined): void => {
        const labelEl = document.createElement('label');
        labelEl.textContent = label;
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '1';
        input.id = id;
        input.value = value === undefined ? '' : String(Math.round(value));
        if (value === undefined) input.placeholder = tr('not set', '未设置');
        // Enter in any coordinate field submits the whole position edit.
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyInspectorCoords(node);
            }
        });
        labelEl.appendChild(input);
        grid.appendChild(labelEl);
    };
    addAxisInputs('x', node.rawPosition.x, addInput);
    addAxisInputs('y', node.rawPosition.y, addInput);
    if (node.rawPosition.z) addAxisInputs('z', node.rawPosition.z, addInput);
    else addInput('prop-z-value', 'z', undefined);
    wrap.appendChild(grid);
    parent.appendChild(wrap);
}

function addAxisInputs(
    axisName: 'x' | 'y' | 'z',
    axis: StaticGalaxyAxis,
    addInput: (id: string, label: string, value: number | undefined) => void,
): void {
    if (axis.kind === 'fixed') {
        addInput(`prop-${axisName}-value`, axisName, axis.value);
    } else if (axis.kind === 'range') {
        addInput(`prop-${axisName}-min`, `${axisName} min`, axis.min);
        addInput(`prop-${axisName}-max`, `${axisName} max`, axis.max);
    }
}

function readNumberInput(id: string): number | null {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input || input.value.trim() === '') return null;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
}

function readAxisUpdate(axisName: 'x' | 'y' | 'z', axis: StaticGalaxyAxis | undefined): StaticGalaxyAxisUpdate | undefined {
    if (axisName === 'z' && axis === undefined) {
        const value = readNumberInput('prop-z-value');
        return value === null ? undefined : { kind: 'fixed', value };
    }
    if (axis?.kind === 'fixed') {
        const value = readNumberInput(`prop-${axisName}-value`);
        return value === null ? undefined : { kind: 'fixed', value };
    }
    if (axis?.kind === 'range') {
        const min = readNumberInput(`prop-${axisName}-min`);
        const max = readNumberInput(`prop-${axisName}-max`);
        return min === null || max === null ? undefined : { kind: 'range', min, max };
    }
    return undefined;
}

function applyInspectorCoords(node: EditablePositionNode): void {
    const xUpdate = readAxisUpdate('x', node.rawPosition.x);
    const yUpdate = readAxisUpdate('y', node.rawPosition.y);
    const zUpdate = readAxisUpdate('z', node.rawPosition.z);
    const hasCoordUpdate = Boolean(xUpdate || yUpdate || zUpdate) && node.editable;
    if (hasCoordUpdate) {
        submitUpdate(node.nodeKey, xUpdate, yUpdate, zUpdate);
    }

    if (!('id' in node) && node.radiusEditable) {
        const radius = readNumberInput('prop-radius-value');
        const changed = radius !== null && radius >= 0 && radius !== node.radius;
        if (changed && radius !== null) {
            // One request at a time: the radius edit follows the coordinate
            // edit once the Host accepts it.
            const value = radius;
            if (hasCoordUpdate) {
                pendingFollowUps.push(() => submitNebulaRadius(node.nodeKey, value));
            } else {
                submitNebulaRadius(node.nodeKey, value);
            }
        }
    }
}

function renderHyperlaneEditor(sys: StaticGalaxySystemView, parent: HTMLElement): void {
    const sc = scenario();
    if (!sc) return;

    const wrap = document.createElement('div');
    wrap.className = 'detail-section hyperlane-editor';
    const title = document.createElement('div');
    title.className = 'detail-title';
    title.textContent = tr('Explicit hyperlanes', '显式航道');
    wrap.appendChild(title);

    const candidates = sc.systems.filter(candidate => candidate.nodeKey !== sys.nodeKey && candidate.id !== '');
    if (sys.id === '' || candidates.length === 0) {
        const note = document.createElement('div');
        note.className = 'editor-note';
        note.textContent = sys.id === ''
            ? tr('This system has no id, so its lanes cannot be edited.', '此系统没有 ID，无法编辑其航道。')
            : tr('No other system is available as an endpoint.', '没有其他系统可作为航道端点。');
        wrap.appendChild(note);
        parent.appendChild(wrap);
        return;
    }

    const label = document.createElement('label');
    label.htmlFor = 'prop-hyperlane-target';
    label.textContent = tr('Other endpoint', '另一端点');
    const select = document.createElement('select');
    select.id = 'prop-hyperlane-target';
    for (const candidate of candidates) {
        const option = document.createElement('option');
        option.value = candidate.nodeKey;
        option.textContent = `${candidate.displayName} [${candidate.id}]`;
        select.appendChild(option);
    }
    label.appendChild(select);
    wrap.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'hyperlane-actions';
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.id = 'btn-add-hyperlane';
    addButton.textContent = tr('Add lane', '添加航道');
    const disconnectButton = document.createElement('button');
    disconnectButton.type = 'button';
    disconnectButton.id = 'btn-remove-hyperlane';
    disconnectButton.textContent = tr('Disconnect lane', '断开航道');
    actions.append(addButton, disconnectButton);
    wrap.appendChild(actions);

    const syncButtons = (): void => {
        const targetKey = select.value;
        const lanes = sc.hyperlanes.filter(lane =>
            (lane.fromNodeKey === sys.nodeKey && lane.toNodeKey === targetKey)
            || (lane.fromNodeKey === targetKey && lane.toNodeKey === sys.nodeKey));
        addButton.disabled = state.applyingNodeKey !== null
            || (lanes.length > 0 && lanes.every(lane => lane.kind === 'add'));
        disconnectButton.disabled = state.applyingNodeKey !== null
            || (lanes.length > 0 && lanes.every(lane => lane.kind === 'remove'));
    };
    select.addEventListener('change', syncButtons);
    addButton.addEventListener('click', () => submitHyperlane(sys.nodeKey, select.value, true));
    disconnectButton.addEventListener('click', () => submitHyperlane(sys.nodeKey, select.value, false));
    syncButtons();
    parent.appendChild(wrap);
}

function countDiagnostics(sc: StaticGalaxyScenarioView, severity: 'error' | 'warning' | 'information'): number {
    let count = sc.diagnostics.filter(d => d.severity === severity).length;
    for (const sys of sc.systems) count += sys.diagnostics.filter(d => d.severity === severity).length;
    for (const neb of sc.nebulas) count += neb.diagnostics.filter(d => d.severity === severity).length;
    for (const lane of sc.hyperlanes) count += lane.diagnostics.filter(d => d.severity === severity).length;
    return count;
}

// ─── Diagnostics panel ──────────────────────────────────────────────────────

function renderDiagnosticsPanel(): void {
    const sc = scenario();
    if (!sc) {
        diagnosticsSummaryEl.textContent = tr('No diagnostics', '没有诊断');
        diagnosticsListEl.innerHTML = '';
        return;
    }
    const errors = countDiagnostics(sc, 'error');
    const warnings = countDiagnostics(sc, 'warning');
    const infos = countDiagnostics(sc, 'information');
    diagnosticsSummaryEl.textContent = tr(
        `${errors} errors · ${warnings} warnings · ${infos} info`,
        `${errors} 个错误 · ${warnings} 个警告 · ${infos} 条信息`,
    );

    diagnosticsListEl.innerHTML = '';
    const addItem = (d: StaticGalaxyDiagnosticView, ownerLabel?: string) => {
        const item = document.createElement('div');
        item.className = `diagnostic-item severity-${d.severity}`;
        item.setAttribute('role', 'listitem');
        const badge = document.createElement('span');
        badge.className = 'diag-badge';
        badge.textContent = d.severity;
        const message = document.createElement('span');
        message.className = 'diag-message';
        message.textContent = ownerLabel ? `${ownerLabel}: ${d.message}` : d.message;
        message.title = d.message;
        item.appendChild(badge);
        item.appendChild(message);
        if (d.nodeKey) {
            const nodeKey = d.nodeKey;
            item.addEventListener('click', () => {
                const kind = findSystem(nodeKey) ? 'system' : findNebula(nodeKey) ? 'nebula' : null;
                if (kind) {
                    setSelection(kind, nodeKey);
                    focusNode(kind, nodeKey);
                }
            });
        } else {
            item.style.cursor = 'default';
        }
        diagnosticsListEl.appendChild(item);
    };

    for (const d of sc.diagnostics) addItem(d);
    for (const sys of sc.systems) {
        for (const d of sys.diagnostics) {
            if (d.severity === 'information') continue; // keep the list useful at 2000-system scale
            addItem(d, sys.displayName);
        }
    }
    for (const neb of sc.nebulas) {
        for (const d of neb.diagnostics) addItem(d, neb.displayName);
    }
    for (const lane of sc.hyperlanes) {
        for (const d of lane.diagnostics) addItem(d, `${lane.kind}_hyperlane`);
    }
}

diagnosticsToggle.addEventListener('click', () => {
    const expanded = diagnosticsToggle.getAttribute('aria-expanded') === 'true';
    diagnosticsToggle.setAttribute('aria-expanded', String(!expanded));
    diagnosticsListEl.classList.toggle('hidden', expanded);
});

// ─── Mode switching ─────────────────────────────────────────────────────────

function setMode(mode: Mode): void {
    if (mode === 'edit') {
        if (!state.permissions.canEdit) {
            if (state.permissions.workshopFile) {
                state.pendingEditMode = true;
                post({ type: 'requestWorkshopEdit' });
            }
            return;
        }
    }
    state.mode = mode;
    state.pendingEditMode = false;
    if (mode !== 'edit') clearPendingLink();
    document.body.classList.toggle('is-edit-mode', mode === 'edit');
    const btnPreview = el<HTMLButtonElement>('btn-preview');
    const btnEdit = el<HTMLButtonElement>('btn-edit');
    btnPreview.classList.toggle('active', mode === 'preview');
    btnPreview.setAttribute('aria-pressed', String(mode === 'preview'));
    btnEdit.classList.toggle('active', mode === 'edit');
    btnEdit.setAttribute('aria-pressed', String(mode === 'edit'));
    renderInspector();
    scheduleRender();
}

el<HTMLButtonElement>('btn-preview').addEventListener('click', () => setMode('preview'));
el<HTMLButtonElement>('btn-edit').addEventListener('click', () => setMode('edit'));

function updateEditAvailability(): void {
    const btnEdit = el<HTMLButtonElement>('btn-edit');
    const canRequest = state.permissions.canEdit || state.permissions.workshopFile;
    btnEdit.disabled = !canRequest;
    btnEdit.title = state.permissions.canEdit
        ? tr('Edit mode (E)', '编辑模式 (E)')
        : state.permissions.reason ?? tr('Editing unavailable', '无法编辑');
    workshopBannerEl.classList.toggle('hidden', !state.permissions.workshopFile);
    document.body.classList.toggle('workshop', state.permissions.workshopFile);
}

// ─── Document state ─────────────────────────────────────────────────────────

function renderDocumentState(): void {
    const labels: Record<StaticGalaxyDocumentState, string> = {
        saved: tr('Saved', '已保存'),
        modified: tr('Modified', '已修改'),
        applying: tr('Applying…', '正在提交…'),
        readonly: tr('Read-only', '只读'),
        stale: tr('Syncing…', '正在同步…'),
        error: tr('Error', '错误'),
    };
    editStatusEl.dataset.state = state.docState;
    editStatusEl.textContent = labels[state.docState];
    editStatusEl.title = state.docStateMessage ?? '';
}

// ─── Toolbar buttons ────────────────────────────────────────────────────────

el<HTMLButtonElement>('btn-zoom-in').addEventListener('click', () => {
    zoomAtCenter(1.25);
});
el<HTMLButtonElement>('btn-zoom-out').addEventListener('click', () => {
    zoomAtCenter(1 / 1.25);
});
function zoomAtCenter(factor: number): void {
    state.viewport.scale = clamp(state.viewport.scale * factor, 0.02, 400);
    updateZoomLabel();
    scheduleRender();
}

el<HTMLButtonElement>('btn-fit').addEventListener('click', () => fitAll());
el<HTMLButtonElement>('btn-focus').addEventListener('click', () => {
    if (state.selection) focusNode(state.selection.kind, state.selection.nodeKey);
});

function bindToggle(id: string, get: () => boolean, set: (v: boolean) => void): void {
    const button = el<HTMLButtonElement>(id);
    const sync = () => {
        const value = get();
        button.classList.toggle('active', value);
        button.setAttribute('aria-pressed', String(value));
    };
    button.addEventListener('click', () => {
        set(!get());
        sync();
        persistState();
        scheduleRender();
    });
    sync();
}

bindToggle('btn-labels', () => state.showLabels, v => { state.showLabels = v; });
bindToggle('btn-ranges', () => state.showRanges, v => { state.showRanges = v; });
bindToggle('btn-nebulas', () => state.showNebulas, v => { state.showNebulas = v; });
bindToggle('btn-lanes', () => state.showLanes, v => { state.showLanes = v; });
bindToggle('btn-grid', () => state.showGrid, v => { state.showGrid = v; });
bindToggle('btn-est-lanes', () => state.showEstimatedLanes, v => {
    state.showEstimatedLanes = v;
    state.estimatedDirty = true;
    updateEstimatedLanesUi();
});

el<HTMLButtonElement>('btn-undo').addEventListener('click', () => post({ type: 'undo' }));
el<HTMLButtonElement>('btn-redo').addEventListener('click', () => post({ type: 'redo' }));
el<HTMLButtonElement>('btn-save').addEventListener('click', () => post({ type: 'saveDocument' }));
el<HTMLButtonElement>('btn-copy-workspace').addEventListener('click', () => post({ type: 'copyToWorkspace' }));
el<HTMLButtonElement>('btn-open-source').addEventListener('click', () => {
    post({ type: 'goToSource', revisionId: state.revision?.revisionId ?? '', nodeKey: '' });
});

function setInspectorCollapsed(collapsed: boolean): void {
    state.inspectorCollapsed = collapsed;
    document.body.classList.toggle('inspector-collapsed', collapsed);
    el<HTMLButtonElement>('btn-toggle-inspector').setAttribute('aria-pressed', String(!collapsed));
    persistState();
}

el<HTMLButtonElement>('btn-toggle-inspector').addEventListener('click', () => setInspectorCollapsed(!state.inspectorCollapsed));
el<HTMLButtonElement>('btn-close-inspector').addEventListener('click', () => setInspectorCollapsed(true));

scenarioSelect.addEventListener('change', () => {
    state.activeScenarioKey = scenarioSelect.value;
    state.selection = null;
    state.estimatedDirty = true;
    persistState();
    renderInspector();
    renderDiagnosticsPanel();
    updateRandomLanesNote();
    updateEstimatedLanesUi();
    fitAll();
});

searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    scheduleRender();
});
searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const sc = scenario();
    if (!sc) return;
    const match = sc.systems.find(s => systemMatchesSearch(s, state.search.trim()));
    if (match) {
        setSelection('system', match.nodeKey);
        focusNode('system', match.nodeKey);
    }
});

// ─── Keyboard ───────────────────────────────────────────────────────────────

function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

window.addEventListener('keydown', (e: KeyboardEvent) => {
    const inInput = isEditableTarget(e.target);

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 's' && !inInput) {
            e.preventDefault();
            post({ type: 'saveDocument' });
            return;
        }
        if (key === 'z' && !inInput) {
            e.preventDefault();
            post({ type: e.shiftKey ? 'redo' : 'undo' });
            return;
        }
        if (key === 'y' && !inInput) {
            e.preventDefault();
            post({ type: 'redo' });
            return;
        }
    }

    if (e.key === ' ') {
        if (!inInput && !state.spacePan) {
            state.spacePan = true;
            viewportEl.classList.add('panning');
            e.preventDefault();
        }
        return;
    }

    if (inInput) return;

    if (e.key === 'Escape') {
        if (state.pendingLink) {
            clearPendingLink();
            scheduleRender();
        } else if (state.drag) {
            const drag = state.drag;
            state.drag = null;
            dragHudEl.classList.add('hidden');
            state.previewPositions.delete(drag.nodeKey);
            scheduleRender();
        } else if (state.selection) {
            setSelection(null);
        }
        return;
    }

    if (e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setMode(state.mode === 'edit' ? 'preview' : 'edit');
        return;
    }
    if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        el<HTMLButtonElement>('btn-labels').click();
    }
});

window.addEventListener('keyup', (e: KeyboardEvent) => {
    if (e.key === ' ') {
        state.spacePan = false;
        if (!state.pan) viewportEl.classList.remove('panning');
    }
});

// ─── Persistence ────────────────────────────────────────────────────────────

function persistState(): void {
    const next: PersistedState = {
        showLabels: state.showLabels,
        showRanges: state.showRanges,
        showNebulas: state.showNebulas,
        showLanes: state.showLanes,
        showGrid: state.showGrid,
        showEstimatedLanes: state.showEstimatedLanes,
        inspectorCollapsed: state.inspectorCollapsed,
        activeScenarioKey: state.activeScenarioKey ?? undefined,
    };
    vscode.setState(next);
}

// ─── Host messages ──────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as StaticGalaxyHostMessage;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

    switch (message.type) {
        case 'render': {
            const firstSnapshot = state.revision === null;
            state.revision = message.revision;
            state.previewPositions.clear();
            const keys = new Set(message.revision.scenarios.map(s => s.scenarioKey));
            if (!state.activeScenarioKey || !keys.has(state.activeScenarioKey)) {
                state.activeScenarioKey = message.activeScenarioKey && keys.has(message.activeScenarioKey)
                    ? message.activeScenarioKey
                    : message.revision.scenarios[0]?.scenarioKey ?? null;
            }
            rebuildScenarioPicker();
            if (state.selection) {
                const { kind, nodeKey } = state.selection;
                const exists = kind === 'system' ? findSystem(nodeKey) : findNebula(nodeKey);
                if (!exists) state.selection = null;
            }
            state.estimatedDirty = true;
            updateEmptyState();
            renderInspector();
            renderDiagnosticsPanel();
            updateRandomLanesNote();
            updateEstimatedLanesUi();
            if (firstSnapshot && message.revision.scenarios.length > 0) {
                fitAll();
            } else {
                scheduleRender();
            }
            break;
        }
        case 'documentState': {
            state.docState = message.state;
            state.docDirty = message.dirty;
            state.docStateMessage = message.message;
            if (message.state === 'error' && message.message) {
                emptyStateMessageEl.textContent = message.message;
            }
            renderDocumentState();
            break;
        }
        case 'editAccepted': {
            state.applyingNodeKey = null;
            const followUp = pendingFollowUps.shift();
            if (followUp) followUp();
            scheduleRender();
            break;
        }
        case 'editRejected': {
            state.applyingNodeKey = null;
            pendingFollowUps.length = 0;
            state.previewPositions.clear();
            if (message.revision) {
                state.revision = message.revision;
                rebuildScenarioPicker();
                renderInspector();
                renderDiagnosticsPanel();
                scheduleRender();
            }
            renderInspector();
            state.docState = 'error';
            state.docStateMessage = message.message;
            renderDocumentState();
            break;
        }
        case 'focusNode': {
            const kind = findSystem(message.nodeKey) ? 'system' : findNebula(message.nodeKey) ? 'nebula' : null;
            if (kind) {
                setSelection(kind, message.nodeKey);
                focusNode(kind, message.nodeKey);
            }
            break;
        }
        case 'permissions': {
            state.permissions = {
                canEdit: message.canEdit,
                reason: message.reason,
                workshopFile: message.workshopFile,
            };
            updateEditAvailability();
            if (state.pendingEditMode && message.canEdit) {
                setMode('edit');
            } else if (state.mode === 'edit' && !message.canEdit) {
                setMode('preview');
            }
            break;
        }
    }
});

function rebuildScenarioPicker(): void {
    const rev = state.revision;
    scenarioSelect.innerHTML = '';
    if (!rev) return;
    // Setup scenarios are normally one file each — the picker only earns its
    // space when the file genuinely declares multiple scenarios.
    const multiple = rev.scenarios.length > 1;
    document.body.classList.toggle('single-scenario', !multiple);
    el<HTMLElement>('scenario-picker').classList.toggle('hidden', !multiple);
    for (const sc of rev.scenarios) {
        const option = document.createElement('option');
        option.value = sc.scenarioKey;
        option.textContent = sc.name;
        scenarioSelect.appendChild(option);
    }
    if (state.activeScenarioKey) scenarioSelect.value = state.activeScenarioKey;
}

function updateEmptyState(): void {
    const rev = state.revision;
    const empty = !rev || rev.scenarios.length === 0;
    emptyStateEl.classList.toggle('hidden', !empty);
}

function updateRandomLanesNote(): void {
    const sc = scenario();
    randomLanesNoteEl.classList.toggle('hidden', !sc?.settings.randomHyperlanes);
}

/** Estimated-lane layer is only meaningful for random_hyperlanes scenarios. */
function updateEstimatedLanesUi(): void {
    const sc = scenario();
    const random = Boolean(sc?.settings.randomHyperlanes);
    const button = el<HTMLButtonElement>('btn-est-lanes');
    button.disabled = !random;
    button.title = random
        ? tr('Toggle estimated lanes (heuristic approximation, not the game algorithm)', '切换估算航道（启发式近似，非游戏算法）')
        : tr('Estimated lanes apply only when random_hyperlanes = yes', '仅 random_hyperlanes = yes 时可用估算航道');
    lanesLegendEl.classList.toggle('hidden', !(state.showEstimatedLanes && random));
}

// ─── Init ───────────────────────────────────────────────────────────────────

setInspectorCollapsed(state.inspectorCollapsed);
renderDocumentState();
resizeCanvas();
post({ type: 'ready' });
