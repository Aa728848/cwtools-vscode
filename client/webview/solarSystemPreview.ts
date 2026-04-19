/**
 * Solar System Preview Webview - renders Stellaris solar systems with 3D orbital view.
 * Uses HTML5 Canvas for high-performance rendering with perspective projection.
 */

interface vscode { postMessage(message: unknown): void; }
declare const acquireVsCodeApi: () => vscode;
const vscode: vscode = acquireVsCodeApi();

// ─── Types (mirrors parser output) ──────────────────────────────────────────

interface ValueOrRange {
    type: 'fixed' | 'range' | 'random';
    value?: number;
    min?: number;
    max?: number;
}

interface AsteroidBelt {
    beltType: string;
    radius: number;
    line: number;
}

interface RingSegment {
    line: number;
    endLine: number;
    planetClass: string;
    name?: string;
    startAngle: number;
    endAngle: number;
    color: string;
}

interface RingGroup {
    orbitRadius: number;
    segments: RingSegment[];
    totalAngle: number;
    firstLine: number;
    lastEndLine: number;
    changeOrbitLine: number;
    changeOrbitValue: number;
}

interface CelestialBody {
    bodyType: 'star' | 'planet' | 'moon';
    name?: string;
    planetClass: string;
    orbitDistance: ValueOrRange;
    orbitAngle: ValueOrRange;
    size: ValueOrRange;
    count: ValueOrRange;
    hasRing: boolean;
    homePlanet: boolean;
    startingPlanet: boolean;
    moons: CelestialBody[];
    subPlanets: CelestialBody[];
    flags: string[];
    line: number;
    endLine: number;
    changeOrbit: number;
    resolvedOrbitRadius: number;
    resolvedOrbitAngle: number;
    resolvedSize: number;
    resolvedCount: number;
    isRingSegment?: boolean;
    ringGroup?: RingGroup;
    ringSegmentHidden?: boolean;
    ringGroupAnchorLine?: number;
}

interface SolarSystem {
    key: string;
    displayName?: string;
    starClass: string;
    flags: string[];
    usage?: string;
    asteroidBelts: AsteroidBelt[];
    bodies: CelestialBody[];
    line: number;
    endLine: number;
}

// ─── Star & Planet Colors ───────────────────────────────────────────────────

const STAR_COLORS: Record<string, { fill: string; glow: string; name: string }> = {
    'sc_a':            { fill: '#C8D8FF', glow: 'rgba(200,216,255,0.4)', name: 'A型星' },
    'sc_b':            { fill: '#AAC8FF', glow: 'rgba(170,200,255,0.4)', name: 'B型星' },
    'sc_f':            { fill: '#F8F0D0', glow: 'rgba(248,240,208,0.35)', name: 'F型星' },
    'sc_g':            { fill: '#FFD800', glow: 'rgba(255,216,0,0.4)', name: 'G型星' },
    'sc_k':            { fill: '#FF9030', glow: 'rgba(255,144,48,0.35)', name: 'K型星' },
    'sc_m':            { fill: '#FF4040', glow: 'rgba(255,64,64,0.3)', name: 'M型矮星' },
    'sc_m_giant':      { fill: '#CC2020', glow: 'rgba(204,32,32,0.35)', name: 'M型巨星' },
    'sc_t':            { fill: '#8B4513', glow: 'rgba(139,69,19,0.3)', name: 'T型褐矮星' },
    'sc_black_hole':   { fill: '#200030', glow: 'rgba(100,0,200,0.3)', name: '黑洞' },
    'sc_neutron_star': { fill: '#00FFFF', glow: 'rgba(0,255,255,0.4)', name: '中子星' },
    'sc_pulsar':       { fill: '#FF00FF', glow: 'rgba(255,0,255,0.3)', name: '脉冲星' },
    'sc_binary_1':     { fill: '#FFD800', glow: 'rgba(255,216,0,0.3)', name: '双星系统' },
    'sc_binary_2':     { fill: '#FF9030', glow: 'rgba(255,144,48,0.3)', name: '双星系统' },
    'sc_trinary_1':    { fill: '#FFD800', glow: 'rgba(255,216,0,0.3)', name: '三星系统' },
};

const PLANET_COLORS: Record<string, { fill: string; name: string }> = {
    // Stars as planets
    'pc_a_star':       { fill: '#C8D8FF', name: 'A型星' },
    'pc_b_star':       { fill: '#AAC8FF', name: 'B型星' },
    'pc_f_star':       { fill: '#F8F0D0', name: 'F型星' },
    'pc_g_star':       { fill: '#FFD800', name: 'G型星' },
    'pc_k_star':       { fill: '#FF9030', name: 'K型星' },
    'pc_m_star':       { fill: '#FF4040', name: 'M型星' },
    'pc_m_giant_star': { fill: '#CC2020', name: 'M型巨星' },
    'pc_t_star':       { fill: '#8B4513', name: 'T型星' },
    'pc_black_hole':   { fill: '#200030', name: '黑洞' },
    'pc_neutron_star': { fill: '#00FFFF', name: '中子星' },
    'pc_pulsar':       { fill: '#FF00FF', name: '脉冲星' },
    'star':            { fill: '#FFD800', name: '恒星' },
    // Habitable
    'ideal_planet_class': { fill: '#40C060', name: '陆地星球' },
    'pc_continental':  { fill: '#3DA55D', name: '大陆星球' },
    'pc_ocean':        { fill: '#2090C0', name: '海洋星球' },
    'pc_tropical':     { fill: '#30B040', name: '热带星球' },
    'pc_arid':         { fill: '#C0A040', name: '干旱星球' },
    'pc_desert':       { fill: '#D0B060', name: '沙漠星球' },
    'pc_savannah':     { fill: '#B0A030', name: '草原星球' },
    'pc_alpine':       { fill: '#90B0C0', name: '高山星球' },
    'pc_arctic':       { fill: '#A0D0E0', name: '极地星球' },
    'pc_tundra':       { fill: '#80A0B0', name: '冻原星球' },
    'pc_gaia':         { fill: '#50E080', name: '盖亚星球' },
    'pc_relic':        { fill: '#C0A060', name: '遗迹星球' },
    'pc_nuked':        { fill: '#808040', name: '死寂星球' },
    'pc_hive':         { fill: '#608030', name: '蜂巢星球' },
    'pc_machine':      { fill: '#6090B0', name: '机械星球' },
    // Uninhabitable
    'pc_gas_giant':    { fill: '#C09060', name: '气态巨行星' },
    'pc_molten':       { fill: '#E04020', name: '熔融星球' },
    'pc_barren':       { fill: '#808080', name: '贫瘠星球' },
    'pc_barren_cold':  { fill: '#6080A0', name: '寒冷贫瘠星球' },
    'pc_frozen':       { fill: '#A0C0D0', name: '冰冻星球' },
    'pc_toxic':        { fill: '#80C040', name: '剧毒星球' },
    'pc_asteroid':     { fill: '#706050', name: '小行星' },
    'pc_ice_asteroid': { fill: '#90B0C0', name: '冰质小行星' },
    // Ringworld
    'pc_ringworld_habitable':    { fill: '#E0C060', name: '环形世界(宜居)' },
    'pc_ringworld_tech':         { fill: '#A0A0A0', name: '环形世界(技术)' },
    'pc_ringworld_tech_damaged': { fill: '#808060', name: '环形世界(受损技术)' },
    'pc_ringworld_seam':         { fill: '#909090', name: '环形世界(接缝)' },
    'pc_ringworld_seam_damaged': { fill: '#707060', name: '环形世界(受损接缝)' },
    // Random
    'random_non_colonizable':    { fill: '#707070', name: '随机不可殖民' },
    'rl_unhabitable_planets':    { fill: '#606060', name: '不可居住星球' },
    'rl_standard_stars':         { fill: '#FFD800', name: '标准恒星' },
};

function getStarColor(starClass: string): { fill: string; glow: string; name: string } {
    return STAR_COLORS[starClass] ?? { fill: '#FFD800', glow: 'rgba(255,216,0,0.3)', name: starClass };
}

function getPlanetColor(planetClass: string): { fill: string; name: string } {
    return PLANET_COLORS[planetClass] ?? { fill: '#808080', name: planetClass || '未知' };
}

function getBodyColor(body: CelestialBody, systemClass: string): string {
    if (body.bodyType === 'star') {
        const sc = getStarColor(systemClass);
        return sc.fill;
    }
    if (body.planetClass) {
        // Check if it's a star-type planet (for binary systems)
        if (body.planetClass.includes('_star') || body.planetClass === 'star') {
            return (PLANET_COLORS[body.planetClass] ?? { fill: '#FFD800' }).fill;
        }
        return getPlanetColor(body.planetClass).fill;
    }
    return '#808080';
}

// ─── Viewport State ─────────────────────────────────────────────────────────

let scale = 1.2;
let viewRotation = 0; // horizontal rotation around star (degrees)
let tiltAngle = 55; // vertical tilt (degrees)
let panX = 0, panY = 0; // pan offset (screen pixels / scale)
let isDragging = false; // left-drag to rotate view
let isPanning = false; // middle-click or alt+left to pan
let lastMX = 0, lastMY = 0;
let canvasW = 0, canvasH = 0;

// Display toggles
let showLabels = true;
let showOrbits = true;
let editMode = false;

// Data
let allSystems: SolarSystem[] = [];
let currentSystemIndex = 0;
let selectedBody: CelestialBody | null = null;
let hoveredBody: CelestialBody | null = null;

// Drag editing
let isDragEditing = false;
let dragBody: CelestialBody | null = null;
let dragParentX = 0;
let dragParentY = 0;
let dragMoved = false; // tracks whether mouse actually moved during drag
let dragStartX = 0; // mouse position at drag start (for threshold)
let dragStartY = 0;
let dragCumulativeOffset = 0; // cumulative orbit offset from change_orbit at drag start
let dragRingGroup: RingGroup | null = null; // set when dragging a ring world group

// Rendered body positions (screen space) for hit testing
interface RenderedBody {
    body: CelestialBody;
    screenX: number;
    screenY: number;
    screenRadius: number;
    parentScreenX: number;
    parentScreenY: number;
}
let renderedBodies: RenderedBody[] = [];

// Animation
let animFrame = 0;
let starPulse = 0;

// ─── 3D Projection ─────────────────────────────────────────────────────────

/** Convert 3D world coordinates to 2D screen coordinates with perspective */
function project(worldX: number, worldY: number, worldZ: number): { x: number; y: number; scale: number } {
    // Apply view rotation: rotate around Z axis (horizontal orbit)
    const rotRad = (viewRotation * Math.PI) / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    const rx = worldX * cosR - worldY * sinR;
    const ry = worldX * sinR + worldY * cosR;

    // Apply tilt: rotate around X axis (vertical)
    const tiltRad = (tiltAngle * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);
    const projY = ry * cosT - worldZ * sinT;
    const rz = ry * sinT + worldZ * cosT;

    // Simple perspective projection
    const perspectiveDistance = 1200;
    const perspectiveScale = perspectiveDistance / (perspectiveDistance + rz);

    const screenX = canvasW / 2 + (rx * perspectiveScale + panX) * scale;
    const screenY = canvasH / 2 + (projY * perspectiveScale + panY) * scale;

    return { x: screenX, y: screenY, scale: perspectiveScale * scale };
}

/** Convert orbital coordinates to world XY (orbit plane is XY, Z=0) */
function orbitalToWorld(orbitRadius: number, angleDeg: number): { x: number; y: number; z: number } {
    const rad = (angleDeg * Math.PI) / 180;
    return {
        x: Math.cos(rad) * orbitRadius,
        y: Math.sin(rad) * orbitRadius,
        z: 0,
    };
}

/** Inverse of project(): convert screen coordinates back to world XY (assuming worldZ=0) */
function screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const sx = (screenX - canvasW / 2) / scale - panX;
    const sy = (screenY - canvasH / 2) / scale - panY;

    const rotRad = (viewRotation * Math.PI) / 180;
    const tiltRad = (tiltAngle * Math.PI) / 180;
    const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
    const cosT = Math.cos(tiltRad), sinT = Math.sin(tiltRad);

    // Solve for ry_cam from: sy = ry_cam * cosT * perspScale
    // where perspScale = 1200 / (1200 + ry_cam * sinT)
    // => ry_cam = 1200 * sy / (1200 * cosT - sy * sinT)
    const denom = 1200 * cosT - sy * sinT;
    const ryCam = denom !== 0 ? (1200 * sy) / denom : 0;

    const perspScale = 1200 / (1200 + ryCam * sinT);
    const rxCam = perspScale !== 0 ? sx / perspScale : 0;

    // Inverse view rotation: camera → world
    const worldX = rxCam * cosR + ryCam * sinR;
    const worldY = -rxCam * sinR + ryCam * cosR;
    return { x: worldX, y: worldY };
}

// ─── Canvas Rendering ───────────────────────────────────────────────────────

function getCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    const canvas = document.getElementById('solar-canvas') as HTMLCanvasElement;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    return { canvas, ctx };
}

function resizeCanvas() {
    const r = getCanvas();
    if (!r) return;
    const { canvas } = r;
    const vp = document.getElementById('viewport')!;
    const dpr = window.devicePixelRatio || 1;
    const rect = vp.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvasW = canvas.width;
    canvasH = canvas.height;
}

function render() {
    const r = getCanvas();
    if (!r) return;
    const { ctx } = r;

    // Clear
    ctx.clearRect(0, 0, canvasW, canvasH);

    const system = allSystems[currentSystemIndex];
    if (!system) return;

    renderedBodies = [];
    starPulse = 1.0; // no animation, constant glow

    // Draw asteroid belts
    for (const belt of system.asteroidBelts) {
        drawOrbitEllipse(ctx, 0, 0, belt.radius, belt.beltType.includes('icy') ? 'rgba(140,180,220,0.2)' : 'rgba(160,140,100,0.2)', true);
    }

    // Draw bodies
    for (const body of system.bodies) {
        drawBody(ctx, body, 0, 0, system.starClass);
    }

    // Draw selection highlight
    if (selectedBody) {
        const rb = renderedBodies.find(r => r.body === selectedBody);
        if (rb) {
            ctx.save();
            ctx.strokeStyle = '#4a9eff';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.arc(rb.screenX, rb.screenY, rb.screenRadius + 6, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }
    }

    animFrame++;
    requestAnimationFrame(render);
}

function drawOrbitEllipse(
    ctx: CanvasRenderingContext2D,
    centerWorldX: number,
    centerWorldY: number,
    radius: number,
    color: string,
    isDotted = false,
) {
    if (!showOrbits) return;
    if (radius <= 0) return;

    // Draw the orbit as a series of projected points
    const steps = Math.max(60, Math.min(200, Math.round(radius * 2)));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = isDotted ? 1.5 : 1;
    if (isDotted) {
        ctx.setLineDash([3, 6]);
    }
    ctx.globalAlpha = 0.6;

    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const wx = centerWorldX + Math.cos(angle) * radius;
        const wy = centerWorldY + Math.sin(angle) * radius;
        const p = project(wx, wy, 0);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
}

function drawRangeArc(
    ctx: CanvasRenderingContext2D,
    centerWorldX: number,
    centerWorldY: number,
    radius: number,
    angleStart: number,
    angleEnd: number,
    color: string,
) {
    if (radius <= 0) return;

    const startRad = (angleStart * Math.PI) / 180;
    const endRad = (angleEnd * Math.PI) / 180;
    const steps = 40;

    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.15;

    ctx.beginPath();
    // Center point
    const cp = project(centerWorldX, centerWorldY, 0);
    ctx.moveTo(cp.x, cp.y);

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const angle = startRad + (endRad - startRad) * t;
        const wx = centerWorldX + Math.cos(angle) * radius;
        const wy = centerWorldY + Math.sin(angle) * radius;
        const p = project(wx, wy, 0);
        ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

/** Draw a ring world as colored arc bands around the parent */
function drawRingWorld(
    ctx: CanvasRenderingContext2D,
    ringGroup: RingGroup,
    parentWorldX: number,
    parentWorldY: number,
    anchorBody: CelestialBody,
) {
    const orbitR = ringGroup.orbitRadius;
    const bandWidth = Math.max(4, orbitR * 0.08); // ring band thickness in world units

    // Draw the orbit circle for the ring
    drawOrbitEllipse(ctx, parentWorldX, parentWorldY, orbitR, 'rgba(80,100,140,0.2)');

    // Arc scaling: only during drag. _dragOrigRadius is set at drag start.
    // When not dragging, arcScale = 1 (segments render at their defined angles).
    const dragOrigR = (ringGroup as any)._dragOrigRadius as number | undefined;
    const arcScale = dragOrigR ? (dragOrigR / Math.max(1, orbitR)) : 1;

    // Draw each segment as a colored arc band
    for (const seg of ringGroup.segments) {
        // Calculate the center and span of this segment
        const originalSpan = seg.endAngle - seg.startAngle;
        const center = (seg.startAngle + seg.endAngle) / 2;
        // Scale the span while keeping the center fixed
        const scaledSpan = originalSpan * Math.min(1, arcScale);
        const scaledStart = center - scaledSpan / 2;
        const scaledEnd = center + scaledSpan / 2;

        const startRad = scaledStart * Math.PI / 180;
        const endRad = scaledEnd * Math.PI / 180;

        // Draw arc band by sampling points along inner and outer edge
        const innerR = orbitR - bandWidth / 2;
        const outerR = orbitR + bandWidth / 2;
        const steps = Math.max(8, Math.ceil(Math.abs(scaledSpan) / 3));

        ctx.save();
        ctx.beginPath();

        // Outer edge (forward)
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const angle = startRad + (endRad - startRad) * t;
            const wx = parentWorldX + Math.cos(angle) * outerR;
            const wy = parentWorldY + Math.sin(angle) * outerR;
            const p = project(wx, wy, 0);
            if (s === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        }

        // Inner edge (backward)
        for (let s = steps; s >= 0; s--) {
            const t = s / steps;
            const angle = startRad + (endRad - startRad) * t;
            const wx = parentWorldX + Math.cos(angle) * innerR;
            const wy = parentWorldY + Math.sin(angle) * innerR;
            const p = project(wx, wy, 0);
            ctx.lineTo(p.x, p.y);
        }

        ctx.closePath();

        // Check if this segment is selected or hovered
        const isSelected = selectedBody && seg.line === selectedBody.line;
        const isHovered = hoveredBody && seg.line === hoveredBody.line;

        ctx.fillStyle = seg.color;
        ctx.globalAlpha = isSelected ? 1.0 : isHovered ? 0.9 : 0.7;
        ctx.fill();

        // Segment outline
        ctx.strokeStyle = isSelected ? '#FFD700' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = isSelected ? 2 : 0.5;
        ctx.stroke();
        ctx.restore();

        // Store for hit testing: use midpoint of arc
        const midAngle = (startRad + endRad) / 2;
        const midWx = parentWorldX + Math.cos(midAngle) * orbitR;
        const midWy = parentWorldY + Math.sin(midAngle) * orbitR;
        const midP = project(midWx, midWy, 0);
        const system = allSystems[currentSystemIndex];
        const segBody = system?.bodies.find(b => b.line === seg.line);
        if (segBody) {
            renderedBodies.push({
                body: segBody,
                screenX: midP.x,
                screenY: midP.y,
                screenRadius: Math.max(10, bandWidth * midP.scale),
                parentScreenX: project(parentWorldX, parentWorldY, 0).x,
                parentScreenY: project(parentWorldX, parentWorldY, 0).y,
            });
        }
    }

    // Label for the ring group
    if (showLabels) {
        const coverage = ringGroup.totalAngle * Math.min(1, arcScale);
        const labelAngle = ringGroup.segments[0].startAngle * Math.PI / 180;
        const labelWx = parentWorldX + Math.cos(labelAngle) * (orbitR + bandWidth);
        const labelWy = parentWorldY + Math.sin(labelAngle) * (orbitR + bandWidth);
        const lp = project(labelWx, labelWy, 0);
        const fontSize = Math.max(9, Math.min(13, 10 * lp.scale));
        ctx.save();
        ctx.font = `${fontSize}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(224,192,96,0.85)';

        // Show snap info during drag
        const snapN = (ringGroup as any)._snapN as number | undefined;
        const snapAngle = (ringGroup as any)._snapAngle as number | undefined;
        let arcText: string;
        if (snapN && snapN > ringGroup.segments.length) {
            const newSegs = snapN - ringGroup.segments.length;
            arcText = `环世界 ${snapN}段×${snapAngle}° (+${newSegs}段)`;
        } else if (coverage >= 358) {
            arcText = '完整环世界';
        } else {
            arcText = `环世界 (${Math.round(coverage)}°/${ringGroup.segments.length}段)`;
        }
        ctx.fillText(arcText, lp.x, lp.y - fontSize);
        ctx.restore();
    }
}

function drawBody(
    ctx: CanvasRenderingContext2D,
    body: CelestialBody,
    parentWorldX: number,
    parentWorldY: number,
    systemClass: string,
) {
    // Skip hidden ring segments (drawn as part of ring group by anchor)
    if (body.ringSegmentHidden) return;

    // If this body is a ring group anchor, draw the ring world
    if (body.ringGroup) {
        drawRingWorld(ctx, body.ringGroup, parentWorldX, parentWorldY, body);
        return; // ring segments are drawn by drawRingWorld, skip normal body rendering
    }

    const orbitR = body.resolvedOrbitRadius;
    const angleDeg = body.resolvedOrbitAngle;

    // World position
    const bodyWorld = orbitalToWorld(orbitR, angleDeg);
    const worldX = parentWorldX + bodyWorld.x;
    const worldY = parentWorldY + bodyWorld.y;

    // Draw orbit
    if (orbitR > 0) {
        const orbitColor = body.bodyType === 'moon'
            ? 'rgba(120,120,140,0.3)'
            : 'rgba(80,100,140,0.35)';
        drawOrbitEllipse(ctx, parentWorldX, parentWorldY, orbitR, orbitColor);
    }

    // Project to screen
    const p = project(worldX, worldY, 0);
    const baseSize = getDisplaySize(body);
    const screenRadius = Math.max(3, baseSize * p.scale);
    const color = getBodyColor(body, systemClass);

    // Render the count (ghost copies for count > 1)
    const count = body.resolvedCount;
    if (count > 1 && body.orbitAngle.type !== 'fixed') {
        // Draw ghost copies
        ctx.save();
        ctx.globalAlpha = 0.2;
        for (let i = 1; i < Math.min(count, 6); i++) {
            const ghostAngle = angleDeg + (360 / count) * i;
            const gWorld = orbitalToWorld(orbitR, ghostAngle);
            const gx = parentWorldX + gWorld.x;
            const gy = parentWorldY + gWorld.y;
            const gp = project(gx, gy, 0);
            const gr = Math.max(2, baseSize * gp.scale * 0.8);
            ctx.beginPath();
            ctx.arc(gp.x, gp.y, gr, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        }
        ctx.restore();
    }

    // Draw the body
    ctx.save();

    // Glow effect for stars
    if (body.bodyType === 'star' || body.planetClass.includes('_star') || body.planetClass === 'star') {
        const sc = getStarColor(systemClass);
        const glowRadius = screenRadius * 3 * starPulse;
        const gradient = ctx.createRadialGradient(p.x, p.y, screenRadius * 0.5, p.x, p.y, glowRadius);
        gradient.addColorStop(0, sc.glow);
        gradient.addColorStop(0.5, sc.glow.replace(/[\d.]+\)$/, '0.1)'));
        gradient.addColorStop(1, 'transparent');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    // Special rendering for black holes
    if (body.planetClass === 'pc_black_hole' || systemClass === 'sc_black_hole') {
        // Accretion disk
        const diskRadius = screenRadius * 2.5;
        const diskGrad = ctx.createRadialGradient(p.x, p.y, screenRadius, p.x, p.y, diskRadius);
        diskGrad.addColorStop(0, 'rgba(100,0,200,0.4)');
        diskGrad.addColorStop(0.5, 'rgba(255,100,50,0.2)');
        diskGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = diskGrad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, diskRadius, 0, Math.PI * 2);
        ctx.fill();

        // Dark center
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(p.x, p.y, screenRadius, 0, Math.PI * 2);
        ctx.fill();

        // Event horizon ring
        ctx.strokeStyle = 'rgba(100,0,200,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, screenRadius, 0, Math.PI * 2);
        ctx.stroke();
    } else {
        // Draw planet/star body — flat uniform color (no shadow)
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, screenRadius, 0, Math.PI * 2);
        ctx.fill();

        // Thin outline for definition
        ctx.strokeStyle = lightenColor(color, 30);
        ctx.lineWidth = 0.5;
        ctx.stroke();
    }

    // Draw ring if has_ring
    if (body.hasRing) {
        ctx.save();
        ctx.strokeStyle = `rgba(200, 180, 140, 0.5)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        // Draw an elliptical ring (pseudo-3D by flattening Y)
        const ringRadius = screenRadius * 1.8;
        ctx.ellipse(p.x, p.y, ringRadius, ringRadius * 0.3, 0, 0, Math.PI * 2);
        ctx.stroke();
        // Second ring for depth
        ctx.strokeStyle = `rgba(200, 180, 140, 0.3)`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, ringRadius * 1.15, ringRadius * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    // Home/starting planet indicator
    if (body.homePlanet || body.startingPlanet) {
        ctx.save();
        ctx.strokeStyle = '#40E060';
        ctx.lineWidth = 2;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, screenRadius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    ctx.restore();

    // Label
    if (showLabels && screenRadius > 2) {
        const label = body.name || body.planetClass || body.bodyType;
        const fontSize = Math.max(9, Math.min(13, 10 * p.scale));
        ctx.save();
        ctx.font = `${fontSize}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = body.bodyType === 'star'
            ? 'rgba(255,255,220,0.9)'
            : 'rgba(200,210,230,0.75)';
        ctx.fillText(label, p.x, p.y + screenRadius + fontSize + 2);

        // Count badge
        if (count > 1) {
            const countLabel = `×${count}`;
            ctx.font = `bold ${fontSize - 1}px "Segoe UI", sans-serif`;
            ctx.fillStyle = 'rgba(74,158,255,0.8)';
            ctx.fillText(countLabel, p.x + screenRadius + 8, p.y - 2);
        }

        // Type badge for moons
        if (body.bodyType === 'moon') {
            ctx.font = `${fontSize - 2}px "Segoe UI", sans-serif`;
            ctx.fillStyle = 'rgba(160,160,180,0.5)';
        }
        ctx.restore();
    }

    // Store for hit testing
    renderedBodies.push({
        body,
        screenX: p.x,
        screenY: p.y,
        screenRadius: Math.max(8, screenRadius), // minimum hit area
        parentScreenX: project(parentWorldX, parentWorldY, 0).x,
        parentScreenY: project(parentWorldX, parentWorldY, 0).y,
    });

    // Draw moons
    for (const moon of body.moons) {
        drawBody(ctx, moon, worldX, worldY, systemClass);
    }

    // Draw sub-planets (binary star companions)
    for (const sub of body.subPlanets) {
        drawBody(ctx, sub, worldX, worldY, systemClass);
    }
}

function getDisplaySize(body: CelestialBody): number {
    const size = Math.max(1, body.resolvedSize);
    if (body.bodyType === 'star') {
        return Math.max(12, Math.min(25, size * 0.7));
    }
    if (body.planetClass === 'pc_gas_giant') {
        return Math.max(6, Math.min(14, size * 0.5));
    }
    if (body.bodyType === 'moon') {
        return Math.max(2, Math.min(6, size * 0.4));
    }
    if (body.planetClass.includes('asteroid')) {
        return Math.max(2, Math.min(4, size * 0.3));
    }
    if (body.planetClass.includes('ringworld')) {
        return Math.max(5, Math.min(10, 8));
    }
    return Math.max(3, Math.min(10, size * 0.45));
}

// ─── Color Utilities ────────────────────────────────────────────────────────

function lightenColor(hex: string, amount: number): string {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    return `rgb(${clamp(rgb.r + amount)}, ${clamp(rgb.g + amount)}, ${clamp(rgb.b + amount)})`;
}

function darkenColor(hex: string, amount: number): string {
    return lightenColor(hex, -amount);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return null;
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function clamp(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v)));
}

// ─── Interaction ────────────────────────────────────────────────────────────

function setupControls() {
    const vp = document.getElementById('viewport');
    const canvas = document.getElementById('solar-canvas') as HTMLCanvasElement | null;
    if (!canvas || !vp) return;

    // ── Event delegation for all buttons/tabs ──────────────────────────────
    document.addEventListener('click', (e: MouseEvent) => {
        const target = (e.target as HTMLElement)?.closest('[id]') as HTMLElement | null;
        if (!target) return;
        const id = target.id;

        switch (id) {
            case 'btn-zoom-in':
                scale = Math.min(8, scale + 0.2);
                updateZoomDisplay();
                break;
            case 'btn-zoom-out':
                scale = Math.max(0.2, scale - 0.2);
                updateZoomDisplay();
                break;
            case 'btn-fit':
                fitToView();
                break;
            case 'btn-reset':
                scale = 1.2; viewRotation = 0; tiltAngle = 55; panX = 0; panY = 0;
                updateZoomDisplay(); updateTiltDisplay();
                break;
            case 'btn-edit':
                editMode = !editMode;
                target.classList.toggle('active', editMode);
                const sp = document.getElementById('side-panel');
                if (sp && editMode) sp.classList.remove('hidden');
                canvas.style.cursor = editMode ? 'crosshair' : 'grab';
                updatePropertiesPanel();
                break;
            case 'btn-labels':
                showLabels = !showLabels;
                target.classList.toggle('active', showLabels);
                break;
            case 'btn-orbits':
                showOrbits = !showOrbits;
                target.classList.toggle('active', showOrbits);
                break;
            case 'tab-info':
                target.classList.add('active');
                document.getElementById('tab-properties')?.classList.remove('active');
                document.getElementById('info-panel')?.classList.remove('hidden');
                document.getElementById('properties-panel')?.classList.add('hidden');
                break;
            case 'tab-properties':
                target.classList.add('active');
                document.getElementById('tab-info')?.classList.remove('active');
                document.getElementById('properties-panel')?.classList.remove('hidden');
                document.getElementById('info-panel')?.classList.add('hidden');
                break;
        }
    });

    // ── System selector ────────────────────────────────────────────────────
    document.getElementById('system-select')?.addEventListener('change', (e: Event) => {
        currentSystemIndex = parseInt((e.target as HTMLSelectElement).value);
        selectedBody = null;
        updateInfoPanel();
        updatePropertiesPanel();
        fitToView();
    });

    // ── Context menu (right-click → add planet in edit mode) ──────────────
    const ctxMenu = document.getElementById('context-menu');
    let ctxClickX = 0, ctxClickY = 0;

    function showCtxMenu(e: MouseEvent) {
        if (!ctxMenu) return;
        ctxClickX = e.clientX;
        ctxClickY = e.clientY;
        ctxMenu.classList.remove('hidden');
        ctxMenu.style.left = `${e.clientX}px`;
        ctxMenu.style.top = `${e.clientY}px`;
        requestAnimationFrame(() => {
            const r = ctxMenu.getBoundingClientRect();
            if (r.right > window.innerWidth) ctxMenu.style.left = `${e.clientX - r.width}px`;
            if (r.bottom > window.innerHeight) ctxMenu.style.top = `${e.clientY - r.height}px`;
        });
    }

    function hideCtxMenu() {
        ctxMenu?.classList.add('hidden');
    }

    canvas.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        if (editMode) {
            showCtxMenu(e);
        }
    });

    // Context menu button clicks
    ctxMenu?.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action ?? '';
            hideCtxMenu();
            if (action === 'add-ringworld') {
                const system = allSystems[currentSystemIndex];
                if (!system) return;
                // Don't create if system already has a ring world
                const hasRing = system.bodies.some(b => b.planetClass?.includes('ringworld'));
                if (hasRing) {
                    return; // already has ring world
                }
                vscode.postMessage({
                    command: 'addRingWorld',
                    systemEndLine: system.endLine,
                    orbitDistance: 30,
                    segmentCount: 12,
                    segmentAngle: 30,
                });
            } else if (action.startsWith('add-')) {
                const planetClass = 'pc_' + action.slice(4);
                const system = allSystems[currentSystemIndex];
                if (!system) return;

                const dpr = window.devicePixelRatio || 1;
                const rect = canvas.getBoundingClientRect();
                const clickScreenX = (ctxClickX - rect.left) * dpr;
                const clickScreenY = (ctxClickY - rect.top) * dpr;
                const world = screenToWorld(clickScreenX, clickScreenY);
                const dist = Math.round(Math.sqrt(world.x * world.x + world.y * world.y));
                const angle = Math.round(Math.atan2(world.y, world.x) * 180 / Math.PI);

                vscode.postMessage({
                    command: 'addPlanet',
                    systemEndLine: system.endLine,
                    orbitDistance: Math.max(20, dist),
                    orbitAngle: ((angle % 360) + 360) % 360,
                    planetClass: planetClass,
                    size: planetClass === 'pc_gas_giant' ? 25 : 15,
                });
            }
        });
    });

    // Close context menu on click outside or Escape
    document.addEventListener('pointerdown', (e: PointerEvent) => {
        if (ctxMenu && !ctxMenu.contains(e.target as Node) && !ctxMenu.classList.contains('hidden')) {
            hideCtxMenu();
        }
    });
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            hideCtxMenu();
            // Also close any autocomplete dropdown
                const dd = document.getElementById('class-dropdown'); if (dd) dd.style.display = 'none';
        }
    });

    // ── Canvas mouse events ────────────────────────────────────────────────
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
        // Close menus/dropdowns on any canvas interaction
        hideCtxMenu();
            const dd = document.getElementById('class-dropdown'); if (dd) dd.style.display = 'none';

        // Middle-click or Alt+left-click → pan
        if (e.button === 1 || (e.button === 0 && e.altKey)) {
            isPanning = true;
            lastMX = e.clientX;
            lastMY = e.clientY;
            vp.style.cursor = 'move';
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }

        if (e.button === 0 && !e.altKey) {
            const hit = hitTest(e.clientX, e.clientY);

            // In edit mode, left-click on a body → drag-edit its orbit
            if (editMode && hit && !e.ctrlKey) {
                isDragEditing = true;
                let body = hit.body;
                dragRingGroup = null;

                // If dragging a ring segment, redirect to the anchor body
                if (body.isRingSegment) {
                    const system = allSystems[currentSystemIndex];
                    const anchorLine = body.ringGroupAnchorLine ?? body.line;
                    const anchor = system?.bodies.find(b => b.line === anchorLine && b.ringGroup);
                    if (anchor && anchor.ringGroup) {
                        body = anchor;
                        dragRingGroup = anchor.ringGroup;
                        // Store original orbit radius for arc scaling during drag
                        (dragRingGroup as any)._dragOrigRadius = dragRingGroup.orbitRadius;
                    }
                }

                dragBody = body;
                dragParentX = hit.parentScreenX;
                dragParentY = hit.parentScreenY;
                dragMoved = false;
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                const od = body.orbitDistance;
                const rawDist = od.type === 'fixed' ? od.value
                    : od.type === 'range' ? ((od as any).min + (od as any).max) / 2
                    : 0;
                dragCumulativeOffset = body.resolvedOrbitRadius - (rawDist || 0);
                lastMX = e.clientX;
                lastMY = e.clientY;
                canvas.setPointerCapture(e.pointerId);
                e.preventDefault();
                return;
            }

            // Click on a body → select it
            if (hit) {
                selectBody(hit.body);
                return;
            }

            // Click on empty space → deselect + start view rotation drag
            selectedBody = null;
            updatePropertiesPanel();
            isDragging = true;
            lastMX = e.clientX;
            lastMY = e.clientY;
            vp.style.cursor = 'grabbing';
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
        }
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
        // Pan (middle-click or Alt+left-click)
        if (isPanning) {
            const dpr = window.devicePixelRatio || 1;
            panX += (e.clientX - lastMX) * dpr / scale;
            panY += (e.clientY - lastMY) * dpr / scale;
            lastMX = e.clientX;
            lastMY = e.clientY;
            e.preventDefault();
            return;
        }

        // View rotation drag (left-click on empty space)
        if (isDragging) {
            const dx = e.clientX - lastMX;
            const dy = e.clientY - lastMY;
            viewRotation = (viewRotation - dx * 0.5) % 360;
            tiltAngle = Math.max(5, Math.min(85, tiltAngle + dy * 0.5));
            lastMX = e.clientX;
            lastMY = e.clientY;
            updateTiltDisplay();
            e.preventDefault();
            return;
        }

        // Drag-edit orbit
        if (isDragEditing && dragBody) {
            // Use total displacement from drag start (not per-frame delta)
            if (!dragMoved) {
                const totalDx = e.clientX - dragStartX;
                const totalDy = e.clientY - dragStartY;
                if (Math.abs(totalDx) > 3 || Math.abs(totalDy) > 3) {
                    dragMoved = true;
                }
            }

            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            const mouseScreenX = (e.clientX - rect.left) * dpr;
            const mouseScreenY = (e.clientY - rect.top) * dpr;

            // Convert both mouse and parent to world coordinates using full inverse
            const mouseWorld = screenToWorld(mouseScreenX, mouseScreenY);
            const parentWorld = screenToWorld(dragParentX, dragParentY);

            // Orbit = mouse_world - parent_world
            const dx = mouseWorld.x - parentWorld.x;
            const dy = mouseWorld.y - parentWorld.y;
            const orbitDist = Math.sqrt(dx * dx + dy * dy);
            const orbitAngle = Math.atan2(dy, dx) * 180 / Math.PI;

            dragBody.resolvedOrbitRadius = Math.max(0, Math.round(orbitDist));
            dragBody.resolvedOrbitAngle = ((Math.round(orbitAngle) % 360) + 360) % 360;

            // If dragging a ring world group, snap to valid radii and update all segments
            if (dragRingGroup) {
                const R0 = (dragRingGroup as any)._dragOrigRadius || dragRingGroup.orbitRadius;
                const N0 = dragRingGroup.segments.length;

                // Divisors of 360 that are valid segment counts for integer orbit_angles
                const divisors360 = [3,4,5,6,8,9,10,12,15,18,20,24,30,36,40,45,60,72,90,120,180,360];
                const validN = divisors360.filter(d => d >= 3);

                // Find closest valid segment count to the raw orbit
                const rawN = N0 * orbitDist / R0;
                let bestN = N0;
                let bestDiff = Infinity;
                for (const n of validN) {
                    const diff = Math.abs(n - rawN);
                    if (diff < bestDiff) { bestDiff = diff; bestN = n; }
                }

                // Snap orbit radius: R = R0 * N / N0
                const snappedR = Math.round(R0 * bestN / N0);
                dragBody.resolvedOrbitRadius = Math.max(Math.round(R0 * 3 / N0), snappedR);

                // Store snap info for label display
                (dragRingGroup as any)._snapN = bestN;
                (dragRingGroup as any)._snapAngle = 360 / bestN;

                dragRingGroup.orbitRadius = dragBody.resolvedOrbitRadius;
                const system = allSystems[currentSystemIndex];
                if (system) {
                    for (const seg of dragRingGroup.segments) {
                        const segBody = system.bodies.find(b => b.line === seg.line);
                        if (segBody && segBody !== dragBody) {
                            segBody.resolvedOrbitRadius = dragBody.resolvedOrbitRadius;
                        }
                    }
                }
            }

            lastMX = e.clientX;
            lastMY = e.clientY;
            e.preventDefault();
            return;
        }

        // Hover hit test
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) {
            if (hoveredBody !== hit.body) {
                hoveredBody = hit.body;
                showTooltip(hit.body, e.clientX, e.clientY);
                canvas.style.cursor = editMode ? 'move' : 'pointer';
            }
        } else if (hoveredBody) {
            hoveredBody = null;
            hideTooltip();
            canvas.style.cursor = editMode ? 'crosshair' : 'grab';
        }
    });

    canvas.addEventListener('pointerup', (e: PointerEvent) => {
        canvas.releasePointerCapture(e.pointerId);

        if (isPanning) {
            isPanning = false;
            vp.style.cursor = editMode ? 'crosshair' : 'grab';
        }
        if (isDragging) {
            isDragging = false;
            vp.style.cursor = editMode ? 'crosshair' : 'grab';
        }
        if (isDragEditing && dragBody) {
            const body = dragBody;
            const ringGroup = dragRingGroup;
            isDragEditing = false;
            dragBody = null;
            dragRingGroup = null;

            // Only commit if mouse actually moved
            if (dragMoved) {
                vscode.postMessage({
                    command: 'movePlanetOrbit',
                    bodyLine: body.line,
                    bodyEndLine: ringGroup ? ringGroup.lastEndLine : body.endLine,
                    targetResolvedOrbit: body.resolvedOrbitRadius,
                    targetOrbitAngle: Math.round(body.resolvedOrbitAngle),
                    // Ring world specific data
                    isRingWorld: !!ringGroup,
                    ringChangeOrbitLine: ringGroup?.changeOrbitLine ?? -1,
                    ringOldOrbitRadius: ringGroup ? ((ringGroup as any)._dragOrigRadius || ringGroup.orbitRadius) : 0,
                    ringFirstLine: ringGroup?.firstLine ?? 0,
                    ringLastEndLine: ringGroup?.lastEndLine ?? 0,
                    // Ring expansion data
                    ringTargetSegCount: ringGroup ? ((ringGroup as any)._snapN || ringGroup.segments.length) : 0,
                    ringNewAngle: ringGroup ? ((ringGroup as any)._snapAngle || (360 / ringGroup.segments.length)) : 0,
                    ringOrigSegCount: ringGroup ? ringGroup.segments.length : 0,
                });
            } else {
                selectBody(body);
            }
            dragMoved = false;
        }
    });

    canvas.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        // Block zoom during active drags
        if (isDragEditing || isDragging || isPanning) return;
        const factor = e.deltaY > 0 ? 0.85 : 1.18;
        scale = Math.max(0.1, Math.min(10, scale * factor));
        updateZoomDisplay();
    });

    canvas.addEventListener('dblclick', (e: MouseEvent) => {
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) vscode.postMessage({ command: 'goToLine', line: hit.body.line });
    });

    // ── Keyboard shortcuts ─────────────────────────────────────────────────
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

        switch (e.key) {
            case 'e':
            case 'E': {
                e.preventDefault();
                editMode = !editMode;
                const editBtn = document.getElementById('btn-edit');
                if (editBtn) editBtn.classList.toggle('active', editMode);
                const sp = document.getElementById('side-panel');
                if (sp && editMode) sp.classList.remove('hidden');
                canvas.style.cursor = editMode ? 'crosshair' : 'grab';
                updatePropertiesPanel();
                break;
            }
            case 'l':
            case 'L':
                e.preventDefault();
                showLabels = !showLabels;
                break;
            case 'o':
            case 'O':
                e.preventDefault();
                showOrbits = !showOrbits;
                break;
            case 'z':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    vscode.postMessage({ command: 'vscodeUndo' });
                }
                break;
            case 'Delete':
                if (editMode && selectedBody && selectedBody.bodyType !== 'star') {
                    e.preventDefault();
                    vscode.postMessage({ command: 'deletePlanet', line: selectedBody.line });
                    selectedBody = null;
                    updatePropertiesPanel();
                }
                break;
        }
    });

    // Ensure webview body can receive keyboard events
    document.body.setAttribute('tabindex', '0');
    document.body.focus();

    window.addEventListener('resize', () => { resizeCanvas(); });
}

function hitTest(clientX: number, clientY: number): RenderedBody | null {
    const canvas = document.getElementById('solar-canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mx = (clientX - rect.left) * dpr;
    const my = (clientY - rect.top) * dpr;

    // Check in reverse order (top-most first)
    for (let i = renderedBodies.length - 1; i >= 0; i--) {
        const rb = renderedBodies[i];
        const dx = mx - rb.screenX;
        const dy = my - rb.screenY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= rb.screenRadius + 4) {
            return rb;
        }
    }
    return null;
}

function selectBody(body: CelestialBody) {
    selectedBody = body;
    updatePropertiesPanel();

    // Show side panel and switch to properties tab
    document.getElementById('side-panel')!.classList.remove('hidden');
    document.getElementById('tab-properties')!.click();

    // Highlight in body list
    document.querySelectorAll('.body-item').forEach(el => {
        el.classList.toggle('selected', el.getAttribute('data-line') === String(body.line));
    });
}

function fitToView() {
    const system = allSystems[currentSystemIndex];
    if (!system) return;

    // Find the maximum orbit radius
    let maxR = 100;
    for (const body of system.bodies) {
        if (body.resolvedOrbitRadius > maxR) maxR = body.resolvedOrbitRadius;
        for (const moon of body.moons) {
            const moonR = body.resolvedOrbitRadius + moon.resolvedOrbitRadius;
            if (moonR > maxR) maxR = moonR;
        }
        for (const sub of body.subPlanets) {
            const subR = body.resolvedOrbitRadius + sub.resolvedOrbitRadius;
            if (subR > maxR) maxR = subR;
        }
    }
    for (const belt of system.asteroidBelts) {
        if (belt.radius > maxR) maxR = belt.radius;
    }

    // Fit the view
    const margin = 80;
    const viewW = canvasW - margin * 2;
    const viewH = canvasH - margin * 2;
    const tiltRad = (tiltAngle * Math.PI) / 180;
    const projectedH = maxR * 2 * Math.cos(tiltRad);
    const projectedW = maxR * 2;

    scale = Math.min(viewW / projectedW, viewH / projectedH, 3);
    updateZoomDisplay();
}

function updateZoomDisplay() {
    document.getElementById('zoom-level')!.textContent = `${Math.round(scale * 100)}%`;
}

function updateTiltDisplay() {
    document.getElementById('tilt-level')!.textContent = `${tiltAngle}°`;
}

// ─── Tooltip ────────────────────────────────────────────────────────────────

function showTooltip(body: CelestialBody, clientX: number, clientY: number) {
    const t = document.getElementById('tooltip')!;
    const pc = getPlanetColor(body.planetClass);
    const typeNames: Record<string, string> = { star: '恒星', planet: '行星', moon: '卫星' };

    let html = `<div class="tip-type" style="color:${getBodyColor(body, allSystems[currentSystemIndex]?.starClass ?? '')}">${typeNames[body.bodyType] || body.bodyType}</div>`;
    html += `<div class="tip-name">${body.name || pc.name || '(未命名)'}</div>`;
    html += `<table>`;
    html += `<tr><td>类型</td><td>${pc.name}</td></tr>`;
    html += `<tr><td>轨道距离</td><td>${formatValueOrRange(body.orbitDistance)}</td></tr>`;
    html += `<tr><td>轨道角度</td><td>${formatValueOrRange(body.orbitAngle)}</td></tr>`;
    html += `<tr><td>大小</td><td>${formatValueOrRange(body.size)}</td></tr>`;
    if (body.count.type !== 'fixed' || (body.count.value ?? 1) > 1) {
        html += `<tr><td>数量</td><td>${formatValueOrRange(body.count)}</td></tr>`;
    }
    if (body.hasRing) html += `<tr><td>行星环</td><td>是</td></tr>`;
    if (body.homePlanet) html += `<tr><td>母星</td><td>是</td></tr>`;
    if (body.startingPlanet) html += `<tr><td>起始星球</td><td>是</td></tr>`;
    if (body.moons.length > 0) html += `<tr><td>卫星</td><td>${body.moons.length}</td></tr>`;
    if (body.flags.length > 0) html += `<tr><td>标志</td><td>${body.flags.join(', ')}</td></tr>`;
    html += `</table>`;
    html += `<div class="tip-line">Line ${body.line} · 双击跳转 · 单击选择</div>`;

    t.innerHTML = html;
    t.classList.remove('hidden');
    t.style.left = `${clientX + 14}px`;
    t.style.top = `${clientY + 14}px`;

    requestAnimationFrame(() => {
        const r = t.getBoundingClientRect();
        if (r.right > window.innerWidth) t.style.left = `${clientX - r.width - 14}px`;
        if (r.bottom > window.innerHeight) t.style.top = `${clientY - r.height - 14}px`;
    });
}

function hideTooltip() {
    document.getElementById('tooltip')!.classList.add('hidden');
}

function formatValueOrRange(v: ValueOrRange): string {
    switch (v.type) {
        case 'fixed': return String(v.value ?? 0);
        case 'range': return `${v.min} ~ ${v.max}`;
        case 'random': return 'random';
    }
}

// ─── Info Panel ─────────────────────────────────────────────────────────────

function updateInfoPanel() {
    const system = allSystems[currentSystemIndex];
    if (!system) return;

    const info = document.getElementById('system-info')!;
    const sc = getStarColor(system.starClass);

    let html = `<div class="sys-card">`;
    html += `<div class="sys-card-title">${system.displayName || system.key}</div>`;
    html += `<div class="sys-card-row"><span class="sys-card-label">标识</span><span class="sys-card-value">${system.key}</span></div>`;
    html += `<div class="sys-card-row"><span class="sys-card-label">星级类型</span><span class="sys-card-value" style="color:${sc.fill}">${sc.name} (${system.starClass})</span></div>`;
    if (system.usage) html += `<div class="sys-card-row"><span class="sys-card-label">用途</span><span class="sys-card-value">${system.usage}</span></div>`;
    if (system.flags.length > 0) {
        html += `<div class="sys-card-row"><span class="sys-card-label">标志</span><span class="sys-card-value">${system.flags.join(', ')}</span></div>`;
    }
    html += `<div class="sys-card-row"><span class="sys-card-label">天体数</span><span class="sys-card-value">${countBodies(system.bodies)}</span></div>`;
    if (system.asteroidBelts.length > 0) {
        html += `<div class="sys-card-row"><span class="sys-card-label">小行星带</span><span class="sys-card-value">${system.asteroidBelts.length}</span></div>`;
    }
    html += `</div>`;

    // Body list
    html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600;">天体列表</div>`;
    html += `<ul class="body-list">`;
    for (const body of system.bodies) {
        html += renderBodyListItem(body, system.starClass, 0);
    }
    html += `</ul>`;

    info.innerHTML = html;

    // Add click handlers to body list items
    info.querySelectorAll<HTMLElement>('.body-item').forEach(el => {
        el.addEventListener('click', () => {
            const line = parseInt(el.getAttribute('data-line') ?? '0');
            const body = findBodyByLine(system.bodies, line);
            if (body) selectBody(body);
        });
    });
}

function renderBodyListItem(body: CelestialBody, systemClass: string, indent: number): string {
    const color = getBodyColor(body, systemClass);
    const pc = getPlanetColor(body.planetClass);
    const name = body.name || pc.name || body.bodyType;
    const isSelected = selectedBody === body;

    let html = `<li class="body-item ${isSelected ? 'selected' : ''} body-indent-${indent}" data-line="${body.line}">`;
    html += `<span class="body-dot" style="background:${color}"></span>`;
    html += `<span class="body-name">${name}</span>`;
    html += `<span class="body-class">${body.planetClass}</span>`;
    html += `</li>`;

    for (const moon of body.moons) {
        html += renderBodyListItem(moon, systemClass, Math.min(indent + 1, 2));
    }
    for (const sub of body.subPlanets) {
        html += renderBodyListItem(sub, systemClass, Math.min(indent + 1, 2));
    }

    return html;
}

function countBodies(bodies: CelestialBody[]): number {
    let count = 0;
    for (const body of bodies) {
        count++;
        count += countBodies(body.moons);
        count += countBodies(body.subPlanets);
    }
    return count;
}

function findBodyByLine(bodies: CelestialBody[], line: number): CelestialBody | null {
    for (const body of bodies) {
        if (body.line === line) return body;
        const found = findBodyByLine(body.moons, line) || findBodyByLine(body.subPlanets, line);
        if (found) return found;
    }
    return null;
}

// ─── Properties Panel ───────────────────────────────────────────────────────

function updatePropertiesPanel() {
    // Close any open autocomplete dropdown before rebuilding panel
        const dd = document.getElementById('class-dropdown'); if (dd) dd.style.display = 'none';
    const panel = document.getElementById('props-content')!;
    if (!selectedBody) {
        panel.innerHTML = '选择一个天体以编辑属性';
        return;
    }

    const body = selectedBody;
    const pc = getPlanetColor(body.planetClass);
    const typeNames: Record<string, string> = { star: '恒星', planet: '行星', moon: '卫星' };

    let html = '';

    // Type badge
    html += `<div style="margin-bottom:12px">`;
    html += `<span class="prop-badge ${body.bodyType}">${typeNames[body.bodyType]}</span>`;
    if (body.homePlanet || body.startingPlanet) {
        html += ` <span class="prop-badge home">母星</span>`;
    }
    html += `</div>`;

    // Basic info
    html += `<div class="prop-group">`;
    html += `<div class="prop-group-title">基本信息</div>`;
    if (body.name) {
        html += propRow('名称', `<input class="prop-input" type="text" value="${body.name}" data-prop="name" data-line="${body.line}" style="width:120px;text-align:left" />`);
    }
    html += propRow('星球类型', `<span class="prop-value" style="color:${getBodyColor(body, allSystems[currentSystemIndex]?.starClass ?? '')}">${pc.name}</span>`);
    html += propRow('类型代码', `<div class="class-picker" style="position:relative;flex:1;min-width:0"><input class="prop-input" id="class-search" type="text" value="${body.planetClass}" data-prop="class" data-line="${body.line}" autocomplete="off" style="width:100%;text-align:left" /></div>`);
    html += `</div>`;

    // Orbit
    html += `<div class="prop-group">`;
    html += `<div class="prop-group-title">轨道参数</div>`;
    html += propRowVOR('轨道距离', 'orbit_distance', body.orbitDistance, body.line);
    html += propRowVOR('轨道角度', 'orbit_angle', body.orbitAngle, body.line);
    if (body.changeOrbit !== 0) {
        html += propRow('轨道偏移', `<input class="prop-input" type="number" value="${body.changeOrbit}" data-prop="change_orbit" data-line="${body.line}" />`);
    }
    html += `</div>`;

    // Size
    html += `<div class="prop-group">`;
    html += `<div class="prop-group-title">大小与计数</div>`;
    html += propRowVOR('大小', 'size', body.size, body.line);
    html += propRowVOR('数量', 'count', body.count, body.line);
    html += propRow('行星环', `<select class="prop-select" data-prop="has_ring" data-line="${body.line}"><option value="no" ${!body.hasRing ? 'selected' : ''}>否</option><option value="yes" ${body.hasRing ? 'selected' : ''}>是</option></select>`);
    html += `</div>`;

    // Actions
    html += `<div class="prop-group">`;
    html += `<div class="prop-group-title">操作</div>`;
    html += `<div class="prop-row"><button class="prop-input btn-jump-to-line" data-jump-line="${body.line}" style="width:100%;text-align:center;cursor:pointer;padding:4px 8px">跳转到源码 (行 ${body.line})</button></div>`;
    if (editMode) {
        html += `<div class="prop-row" style="justify-content:center;margin-top:4px"><span style="font-size:10px;color:var(--text-muted)">💡 右键画布可添加新行星</span></div>`;
    }
    html += `</div>`;

    panel.innerHTML = html;

    // Bind events
    panel.querySelectorAll<HTMLInputElement>('.prop-input[data-prop]').forEach(input => {
        const handler = () => {
            const prop = input.getAttribute('data-prop')!;
            const line = parseInt(input.getAttribute('data-line')!);
            let value: string | number = input.value;
            if (input.type === 'number') value = parseFloat(input.value);
            vscode.postMessage({
                command: 'updateProperty',
                line,
                property: prop,
                value,
                valueType: 'fixed',
            });
        };
        input.addEventListener('change', handler);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); });
    });

    panel.querySelectorAll<HTMLSelectElement>('.prop-select[data-prop]').forEach(select => {
        select.addEventListener('change', () => {
            const prop = select.getAttribute('data-prop')!;
            const line = parseInt(select.getAttribute('data-line')!);
            vscode.postMessage({
                command: 'updateProperty',
                line,
                property: prop,
                value: select.value,
                valueType: 'fixed',
            });
        });
    });

    panel.querySelectorAll<HTMLInputElement>('.vor-input').forEach(input => {
        const handler = () => {
            const prop = input.getAttribute('data-prop')!;
            const line = parseInt(input.getAttribute('data-line')!);
            const vorType = input.getAttribute('data-vor-type') as 'min' | 'max' | 'value';
            const otherInput = panel.querySelector<HTMLInputElement>(`.vor-input[data-prop="${prop}"][data-line="${line}"][data-vor-type="${vorType === 'min' ? 'max' : 'min'}"]`);

            if (vorType === 'value') {
                vscode.postMessage({
                    command: 'updateProperty',
                    line,
                    property: prop,
                    value: parseFloat(input.value) || 0,
                    valueType: 'fixed',
                });
            } else {
                const min = vorType === 'min' ? (parseFloat(input.value) || 0) : (parseFloat(otherInput?.value ?? '0') || 0);
                const max = vorType === 'max' ? (parseFloat(input.value) || 0) : (parseFloat(otherInput?.value ?? '0') || 0);
                vscode.postMessage({
                    command: 'updateProperty',
                    line,
                    property: prop,
                    value: { min, max },
                    valueType: 'range',
                });
            }
        };
        input.addEventListener('change', handler);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); });
    });

    // Jump-to-line buttons (cannot use inline onclick due to CSP)
    panel.querySelectorAll<HTMLButtonElement>('.btn-jump-to-line').forEach(btn => {
        btn.addEventListener('click', () => {
            const line = parseInt(btn.getAttribute('data-jump-line') ?? '0');
            if (line > 0) vscode.postMessage({ command: 'goToLine', line });
        });
    });

    // Planet class autocomplete
    const classInput = panel.querySelector<HTMLInputElement>('#class-search');
    if (classInput) {
        const allClasses = Object.keys(PLANET_COLORS);
        setupClassAutocomplete(classInput, allClasses);
    }
}

function propRow(label: string, valueHtml: string): string {
    return `<div class="prop-row"><span class="prop-label">${label}</span>${valueHtml}</div>`;
}

/** Autocomplete dropdown for planet class input */
function setupClassAutocomplete(inputEl: HTMLInputElement, dataSource: string[]) {
    let dropdown = document.getElementById('class-dropdown') as HTMLElement;
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.id = 'class-dropdown';
        Object.assign(dropdown.style, {
            position: 'fixed', zIndex: '10000',
            background: 'var(--bg-surface, #252525)', border: '1px solid var(--border, #555)',
            borderRadius: '4px', maxHeight: '200px', overflowY: 'auto',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)', fontSize: '12px',
            display: 'none',
        });
        document.body.appendChild(dropdown);
    }
    let ddIndex = -1;

    const hideDD = () => { dropdown.style.display = 'none'; };
    const isHidden = () => dropdown.style.display === 'none';

    const positionDropdown = () => {
        const rect = inputEl.getBoundingClientRect();
        dropdown.style.top = `${rect.bottom + 2}px`;
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.width = `${Math.max(rect.width, 200)}px`;
    };

    const showDropdown = (query: string) => {
        const q = query.toLowerCase();
        const matches = q
            ? dataSource.filter(s => s.toLowerCase().includes(q)).slice(0, 30)
            : dataSource.slice(0, 30);
        if (matches.length === 0) { hideDD(); return; }
        ddIndex = -1;
        dropdown.innerHTML = matches.map(s => {
            const pc = PLANET_COLORS[s];
            const colorDot = pc ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${pc.fill};margin-right:6px"></span>` : '';
            const label = pc ? `${colorDot}${s} <span style="color:var(--text-muted,#888);font-size:10px">${pc.name}</span>` : s;
            return `<div class="class-option" style="padding:4px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>`;
        }).join('');
        positionDropdown();
        dropdown.style.display = 'block';
        dropdown.querySelectorAll('.class-option').forEach((opt, i) => {
            (opt as HTMLElement).addEventListener('mousedown', (e) => {
                e.preventDefault();
                inputEl.value = matches[i];
                hideDD();
                inputEl.dispatchEvent(new Event('change'));
            });
            (opt as HTMLElement).addEventListener('mouseenter', () => {
                dropdown.querySelectorAll('.class-option').forEach(o => (o as HTMLElement).style.background = '');
                (opt as HTMLElement).style.background = 'var(--accent, #0078d4)';
                ddIndex = i;
            });
            (opt as HTMLElement).addEventListener('mouseleave', () => {
                (opt as HTMLElement).style.background = '';
            });
        });
    };

    inputEl.addEventListener('input', () => showDropdown(inputEl.value));
    inputEl.addEventListener('focus', () => showDropdown(inputEl.value));
    inputEl.addEventListener('blur', () => setTimeout(hideDD, 150));
    // Close dropdown when clicking anywhere outside
    document.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!dropdown.contains(e.target as Node) && e.target !== inputEl && !isHidden()) {
            hideDD();
        }
    });
    inputEl.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.class-option');
        if (items.length === 0 || isHidden()) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault(); ddIndex = Math.min(ddIndex + 1, items.length - 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault(); ddIndex = Math.max(ddIndex - 1, 0);
        } else if (e.key === 'Enter' && ddIndex >= 0) {
            e.preventDefault();
            inputEl.value = (items[ddIndex] as HTMLElement).textContent!.split(' ')[0].trim();
            hideDD();
            inputEl.dispatchEvent(new Event('change'));
            return;
        } else if (e.key === 'Escape') {
            hideDD(); return;
        } else return;
        items.forEach((it, i) => {
            (it as HTMLElement).style.background = i === ddIndex ? 'var(--accent, #0078d4)' : '';
        });
        if (ddIndex >= 0) items[ddIndex].scrollIntoView({ block: 'nearest' });
    });
}

function propRowVOR(label: string, prop: string, vor: ValueOrRange, line: number): string {
    if (vor.type === 'fixed') {
        return propRow(label, `<input class="prop-input vor-input" type="number" value="${vor.value ?? 0}" data-prop="${prop}" data-line="${line}" data-vor-type="value" />`);
    } else if (vor.type === 'range') {
        return propRow(label,
            `<span style="font-size:10px;color:var(--text-muted)">min</span>` +
            `<input class="prop-input vor-input" type="number" value="${vor.min}" data-prop="${prop}" data-line="${line}" data-vor-type="min" style="width:50px" />` +
            `<span style="font-size:10px;color:var(--text-muted)">max</span>` +
            `<input class="prop-input vor-input" type="number" value="${vor.max}" data-prop="${prop}" data-line="${line}" data-vor-type="max" style="width:50px" />`
        );
    } else {
        return propRow(label, `<span class="prop-value" style="color:var(--accent)">random</span>`);
    }
}

// ─── Global function for inline onclick ─────────────────────────────────────

(window as any).jumpToLine = (line: number) => {
    vscode.postMessage({ command: 'goToLine', line });
};

// ─── Message Handler ────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'render') {
        const isFirstRender = allSystems.length === 0;
        allSystems = msg.data;
        document.getElementById('title')!.textContent = `星系预览: ${msg.fileName}`;

        // Update system selector
        const select = document.getElementById('system-select') as HTMLSelectElement;
        select.innerHTML = '';
        allSystems.forEach((sys, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = sys.displayName || sys.key;
            select.appendChild(opt);
        });

        // Select current system
        if (currentSystemIndex >= allSystems.length) currentSystemIndex = 0;
        select.value = String(currentSystemIndex);

        // Try to preserve selected body across re-renders
        if (selectedBody) {
            const system = allSystems[currentSystemIndex];
            if (system) {
                const findBody = (bodies: CelestialBody[]): CelestialBody | null => {
                    for (const b of bodies) {
                        if (b.line === selectedBody!.line) return b;
                        for (const m of b.moons) {
                            if (m.line === selectedBody!.line) return m;
                        }
                    }
                    return null;
                };
                const found = findBody(system.bodies);
                selectedBody = found;
            } else {
                selectedBody = null;
            }
        }

        updateInfoPanel();
        updatePropertiesPanel();

        if (isFirstRender) {
            // First render: full initialization
            document.getElementById('btn-labels')!.classList.toggle('active', showLabels);
            document.getElementById('btn-orbits')!.classList.toggle('active', showOrbits);
            resizeCanvas();
            requestAnimationFrame(() => {
                fitToView();
                render();
            });
        }
        // Subsequent renders: data is already updated, render loop will pick it up
    }
});

// ─── Init ────────────────────────────────────────────────────────────────────

setupControls();
resizeCanvas();
