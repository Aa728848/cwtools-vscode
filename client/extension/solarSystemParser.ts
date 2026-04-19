/**
 * Solar System Initializer Parser
 * Parses Stellaris solar_system_initializers .txt files into structured data
 * for the visual preview.
 */

// ─── Data Types ─────────────────────────────────────────────────────────────

export type ValueOrRange =
    | { type: 'fixed'; value: number }
    | { type: 'range'; min: number; max: number }
    | { type: 'random' };

export interface AsteroidBelt {
    beltType: string;       // rocky_asteroid_belt, icy_asteroid_belt
    radius: number;
    line: number;
}

export interface RingSegment {
    line: number;         // body line for lookup
    endLine: number;
    planetClass: string;
    name?: string;
    startAngle: number;   // degrees
    endAngle: number;     // degrees
    color: string;        // fill color for this segment
}

export interface RingGroup {
    orbitRadius: number;
    segments: RingSegment[];
    totalAngle: number;   // total arc degrees
    firstLine: number;    // line of first segment
    lastEndLine: number;  // endLine of last segment
    changeOrbitLine: number;  // line of the change_orbit that positions this ring
    changeOrbitValue: number; // value of that change_orbit
}

export interface CelestialBody {
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
    /** Nested planets (for binary/trinary star sub-systems) */
    subPlanets: CelestialBody[];
    flags: string[];
    line: number;
    endLine: number;
    changeOrbit: number;
    /** Per-moon cumulative change_orbit offsets from parent block */
    moonChangeOrbitOffsets: number[];
    /** Line numbers of the last change_orbit before each moon */
    moonChangeOrbitLines: number[];
    // Resolved values for rendering
    resolvedOrbitRadius: number;   // cumulative distance from parent center
    resolvedOrbitAngle: number;    // degrees
    resolvedSize: number;
    resolvedCount: number;
    // Ring world grouping
    isRingSegment?: boolean;       // true for all ring segments
    ringGroup?: RingGroup;         // set on the FIRST segment of a ring group
    ringSegmentHidden?: boolean;   // true for non-anchor segments (skip rendering)
    ringGroupAnchorLine?: number;  // line of the anchor body for this ring group
}

export interface SolarSystem {
    key: string;                // top-level block identifier
    displayName?: string;       // name = "..." value
    starClass: string;          // class = sc_g, etc.
    flags: string[];
    usage?: string;
    asteroidBelts: AsteroidBelt[];
    bodies: CelestialBody[];    // all top-level bodies (star + planets)
    line: number;
    endLine: number;
}

// ─── Tokenizer (shared logic with guiParser) ────────────────────────────────

enum TokenType {
    LBrace, RBrace, Equals, String, Identifier, Number, Comment, EOF,
}

interface Token {
    type: TokenType;
    value: string;
    line: number;
}

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let line = 1;

    while (i < input.length) {
        const ch = input[i];

        if (ch === '\n') { line++; i++; continue; }
        if (ch === '\r') { line++; i++; if (i < input.length && input[i] === '\n') i++; continue; }
        if (ch === ' ' || ch === '\t') { i++; continue; }

        if (ch === '#') {
            while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i++;
            continue;
        }
        if (ch === '{') { tokens.push({ type: TokenType.LBrace, value: '{', line }); i++; continue; }
        if (ch === '}') { tokens.push({ type: TokenType.RBrace, value: '}', line }); i++; continue; }
        if (ch === '=') { tokens.push({ type: TokenType.Equals, value: '=', line }); i++; continue; }

        if (ch === '"') {
            i++;
            const start = i;
            while (i < input.length && input[i] !== '"') {
                if (input[i] === '\n') line++;
                i++;
            }
            tokens.push({ type: TokenType.String, value: input.slice(start, i), line });
            if (i < input.length) i++;
            continue;
        }

        // Numbers
        if ((ch >= '0' && ch <= '9') || ((ch === '-' || ch === '+') && i + 1 < input.length && input[i + 1] >= '0' && input[i + 1] <= '9')) {
            const start = i;
            if (ch === '-' || ch === '+') i++;
            while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) i++;
            tokens.push({ type: TokenType.Number, value: input.slice(start, i), line });
            continue;
        }

        // Arithmetic expressions @[ ... ]
        if (ch === '@' && i + 1 < input.length && input[i + 1] === '[') {
            const start = i;
            i += 2;
            let depth = 1;
            while (i < input.length && depth > 0) {
                if (input[i] === '[') depth++;
                else if (input[i] === ']') depth--;
                if (input[i] === '\n') line++;
                i++;
            }
            tokens.push({ type: TokenType.Identifier, value: input.slice(start, i), line });
            continue;
        }

        // Identifiers
        if (isIdentStart(ch)) {
            const start = i;
            while (i < input.length && isIdentCont(input[i])) i++;
            tokens.push({ type: TokenType.Identifier, value: input.slice(start, i), line });
            continue;
        }

        i++; // skip unknown
    }
    tokens.push({ type: TokenType.EOF, value: '', line });
    return tokens;
}

function isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '@';
}

function isIdentCont(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch === '_' || ch === '.' || ch === '@' ||
        ch === ':' || ch === '/' || ch === '\\' ||
        ch === '-' || ch === '!' || ch === '%';
}

// ─── Parser ─────────────────────────────────────────────────────────────────

interface PdxNode {
    key: string;
    line: number;
    endLine?: number;
    value?: string | number;
    children?: PdxNode[];
}

class Parser {
    private tokens: Token[];
    private pos: number;
    private variables: Map<string, number | string>;

    constructor(tokens: Token[]) {
        this.tokens = tokens;
        this.pos = 0;
        this.variables = new Map();
    }

    getVariables(): Map<string, number | string> {
        return this.variables;
    }

    private peek(): Token {
        return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', line: 0 };
    }

    private advance(): Token {
        return this.tokens[this.pos++];
    }

    parse(): PdxNode[] {
        const nodes: PdxNode[] = [];
        while (this.peek().type !== TokenType.EOF) {
            const node = this.parseStatement();
            if (node) nodes.push(node);
        }
        return nodes;
    }

    private parseBlock(): { nodes: PdxNode[]; endLine: number } {
        const nodes: PdxNode[] = [];
        while (this.peek().type !== TokenType.RBrace && this.peek().type !== TokenType.EOF) {
            const node = this.parseStatement();
            if (node) nodes.push(node);
        }
        const endLine = this.peek().line;
        if (this.peek().type === TokenType.RBrace) this.advance();
        return { nodes, endLine };
    }

    private parseStatement(): PdxNode | null {
        const keyToken = this.advance();
        if (keyToken.type === TokenType.EOF) return null;

        // Variable definition: @VAR = value
        if (keyToken.value.startsWith('@') && this.peek().type === TokenType.Equals) {
            this.advance(); // skip =
            const valToken = this.advance();
            const numVal = parseFloat(valToken.value);
            if (!isNaN(numVal) && valToken.type !== TokenType.String) {
                this.variables.set(keyToken.value, numVal);
            } else {
                this.variables.set(keyToken.value, valToken.value);
            }
            return null;
        }

        // key = value or key = { ... }
        if (this.peek().type === TokenType.Equals) {
            this.advance(); // skip =
            if (this.peek().type === TokenType.LBrace) {
                this.advance(); // skip {
                const block = this.parseBlock();
                return { key: keyToken.value, line: keyToken.line, endLine: block.endLine, children: block.nodes };
            } else {
                const valToken = this.advance();
                const resolved = this.resolveValue(valToken);
                return { key: keyToken.value, line: keyToken.line, value: resolved };
            }
        }

        // Bare identifier/value
        const resolved = this.resolveValue(keyToken);
        return { key: String(resolved), line: keyToken.line };
    }

    private resolveValue(token: Token): string | number {
        if (token.type === TokenType.Number) {
            return parseFloat(token.value);
        }
        if (token.value.startsWith('@[')) {
            return this.evaluateExpression(token.value);
        }
        if (token.value.startsWith('@')) {
            const v = this.variables.get(token.value);
            if (v !== undefined) {
                const nv = typeof v === 'string' ? parseFloat(v) : v;
                return !isNaN(nv as number) ? nv : v;
            }
        }
        return token.value;
    }

    private evaluateExpression(expr: string): string | number {
        let inner = expr.slice(2, -1).trim();
        const vars = Array.from(this.variables.entries()).sort((a, b) => b[0].length - a[0].length);
        for (const [k, v] of vars) {
            const rawKey = k.startsWith('@') ? k.substring(1) : k;
            inner = inner.split(k).join(String(v));
            const regex = new RegExp(`\\b${rawKey}\\b`, 'g');
            inner = inner.replace(regex, String(v));
        }
        try {
            if (/^[0-9\.\+\-\*\/\s\(\)]+$/.test(inner)) {
                const result = new Function(`return (${inner})`)();
                return typeof result === 'number' && !isNaN(result) ? result : expr;
            }
        } catch {
            return expr;
        }
        return expr;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function numProp(nodes: PdxNode[], key: string): number | undefined {
    const n = nodes.find(n => n.key === key && typeof n.value === 'number');
    return n?.value as number | undefined;
}

function strProp(nodes: PdxNode[], key: string): string | undefined {
    const n = nodes.find(n => n.key === key && n.value !== undefined);
    return n !== undefined ? String(n.value) : undefined;
}

/**
 * Parse a value that could be: a number, { min = X max = Y }, or "random"
 */
function parseValueOrRange(nodes: PdxNode[], key: string): ValueOrRange {
    // Check for block form: key = { min = X max = Y }
    const blockNode = nodes.find(n => n.key === key && n.children);
    if (blockNode?.children) {
        const min = numProp(blockNode.children, 'min');
        const max = numProp(blockNode.children, 'max');
        if (min !== undefined && max !== undefined) {
            return { type: 'range', min, max };
        }
        // fallback: if single value in block
        const val = numProp(blockNode.children, 'value');
        if (val !== undefined) return { type: 'fixed', value: val };
    }

    // Check for scalar value
    const scalarNode = nodes.find(n => n.key === key && n.value !== undefined && !n.children);
    if (scalarNode) {
        if (scalarNode.value === 'random') return { type: 'random' };
        if (typeof scalarNode.value === 'number') return { type: 'fixed', value: scalarNode.value };
        // Try parse string as number
        const parsed = parseFloat(String(scalarNode.value));
        if (!isNaN(parsed)) return { type: 'fixed', value: parsed };
    }

    return { type: 'fixed', value: 0 };
}

/** Resolve a ValueOrRange to a single number for rendering */
function resolveValue(v: ValueOrRange): number {
    switch (v.type) {
        case 'fixed': return v.value;
        case 'range': return (v.min + v.max) / 2;
        case 'random': return Math.random() * 360;
    }
}

/** Resolve count specifically (default 1) */
function resolveCount(v: ValueOrRange): number {
    switch (v.type) {
        case 'fixed': return Math.max(1, v.value);
        case 'range': return Math.round((v.min + v.max) / 2);
        case 'random': return 1;
    }
}

/** Extract flags from a `flags = { flag1 flag2 }` block */
function parseFlags(nodes: PdxNode[]): string[] {
    const flagsNode = nodes.find(n => n.key === 'flags' && n.children);
    if (!flagsNode?.children) return [];
    return flagsNode.children.map(n => n.key);
}

// ─── Build Celestial Bodies ─────────────────────────────────────────────────

function buildBody(
    bodyType: 'star' | 'planet' | 'moon',
    nodes: PdxNode[],
    line: number,
    endLine: number,
): CelestialBody {
    const name = strProp(nodes, 'name');
    const planetClass = strProp(nodes, 'class') ?? '';
    const orbitDistance = parseValueOrRange(nodes, 'orbit_distance');
    const orbitAngle = parseValueOrRange(nodes, 'orbit_angle');
    const size = parseValueOrRange(nodes, 'size');
    const count = parseValueOrRange(nodes, 'count');
    const hasRing = strProp(nodes, 'has_ring') === 'yes';
    const homePlanet = strProp(nodes, 'home_planet') === 'yes';
    const startingPlanet = strProp(nodes, 'starting_planet') === 'yes';
    const changeOrbit = numProp(nodes, 'change_orbit') ?? 0;
    const flags = parseFlags(nodes);

    // Parse moons and sub-planets with inter-body change_orbit tracking
    // (change_orbit between moon/planet declarations offsets subsequent bodies)
    const moons: CelestialBody[] = [];
    const subPlanets: CelestialBody[] = [];
    const moonChangeOrbitOffsets: number[] = [];
    const moonChangeOrbitLines: number[] = [];
    let interBodyChangeOrbit = 0;
    let lastChangeOrbitLine = -1;
    for (const n of nodes) {
        if (n.key === 'change_orbit') {
            interBodyChangeOrbit += Number(n.value) || 0;
            lastChangeOrbitLine = n.line;
        } else if (n.key === 'moon' && n.children) {
            moons.push(buildBody('moon', n.children, n.line, n.endLine ?? n.line));
            moonChangeOrbitOffsets.push(interBodyChangeOrbit);
            moonChangeOrbitLines.push(lastChangeOrbitLine);
        } else if (n.key === 'planet' && n.children) {
            subPlanets.push(buildBody('planet', n.children, n.line, n.endLine ?? n.line));
        }
    }

    return {
        bodyType,
        name,
        planetClass,
        orbitDistance,
        orbitAngle,
        size,
        count,
        hasRing,
        homePlanet,
        startingPlanet,
        moons,
        subPlanets,
        flags,
        line,
        endLine,
        changeOrbit,
        moonChangeOrbitOffsets,
        moonChangeOrbitLines,
        resolvedOrbitRadius: 0,
        resolvedOrbitAngle: 0,
        resolvedSize: 0,
        resolvedCount: 1,
    };
}

// ─── Recursive Moon Resolution ─────────────────────────────────────────────

/**
 * Resolve orbit, angle, size for all moons of a parent body, recursively.
 * Handles change_orbit offsets from the parent block (moonChangeOrbitOffsets).
 */
function resolveMoonsRecursive(parent: CelestialBody): void {
    let moonCumulativeOrbit = 0;
    for (let mi = 0; mi < parent.moons.length; mi++) {
        const moon = parent.moons[mi];
        // Apply parent-block change_orbit that precedes this moon (delta from cumulative offsets)
        const parentOffset = (parent.moonChangeOrbitOffsets[mi] ?? 0)
            - (mi > 0 ? (parent.moonChangeOrbitOffsets[mi - 1] ?? 0) : 0);
        moonCumulativeOrbit += parentOffset;
        const moonDist = resolveValue(moon.orbitDistance);
        moon.resolvedOrbitRadius = moonCumulativeOrbit + moonDist;
        moon.resolvedOrbitAngle = moon.orbitAngle.type === 'random'
            ? Math.random() * 360
            : resolveValue(moon.orbitAngle);
        moon.resolvedSize = resolveValue(moon.size);
        moon.resolvedCount = resolveCount(moon.count);
        moonCumulativeOrbit = moon.resolvedOrbitRadius + moon.changeOrbit;

        // Recursively resolve sub-moons
        if (moon.moons.length > 0) {
            resolveMoonsRecursive(moon);
        }
    }
}

/**
 * Recursively detect and group ring world segments inside moons at any depth.
 */
function groupRingWorldsRecursive(bodies: CelestialBody[]): void {
    for (const body of bodies) {
        if (body.moons.length >= 2) {
            const moonChangeOrbitMap = body.moons.map((m, i) => ({
                line: body.moonChangeOrbitLines[i] ?? m.line,
                value: body.moonChangeOrbitOffsets[i] ?? m.changeOrbit,
            }));
            groupRingWorlds(body.moons, moonChangeOrbitMap);
        }
        // Recurse into moons (for sub-moons that might be ring worlds)
        if (body.moons.length > 0) {
            groupRingWorldsRecursive(body.moons);
        }
        // Recurse into sub-planets
        for (const sub of body.subPlanets) {
            if (sub.moons.length >= 2) {
                const subMoonMap = sub.moons.map((m, i) => ({
                    line: sub.moonChangeOrbitLines[i] ?? m.line,
                    value: sub.moonChangeOrbitOffsets[i] ?? m.changeOrbit,
                }));
                groupRingWorlds(sub.moons, subMoonMap);
            }
            if (sub.moons.length > 0) {
                groupRingWorldsRecursive(sub.moons);
            }
        }
    }
}

// ─── Build Solar System ─────────────────────────────────────────────────────

function buildSolarSystem(key: string, nodes: PdxNode[], line: number, endLine: number): SolarSystem {
    const displayName = strProp(nodes, 'name');
    const starClass = strProp(nodes, 'class') ?? '';
    const usage = strProp(nodes, 'usage');
    const flags = parseFlags(nodes);

    // Asteroid belts
    const asteroidBelts: AsteroidBelt[] = [];
    for (const n of nodes) {
        if (n.key === 'asteroid_belt' && n.children) {
            const beltType = strProp(n.children, 'type') ?? 'rocky_asteroid_belt';
            const radius = numProp(n.children, 'radius') ?? 0;
            asteroidBelts.push({ beltType, radius, line: n.line });
        }
    }

    // Collect top-level planet blocks and change_orbit commands in order
    const bodies: CelestialBody[] = [];
    let cumulativeOrbit = 0;
    let lastChangeOrbitLine = -1;
    let lastChangeOrbitValue = 0;
    // Map: body index → the change_orbit line that precedes it
    const bodyChangeOrbitMap: { line: number; value: number }[] = [];

    for (const n of nodes) {
        if (n.key === 'change_orbit' && typeof n.value === 'number') {
            lastChangeOrbitLine = n.line;
            lastChangeOrbitValue = n.value;
            cumulativeOrbit += n.value;
            continue;
        }
        if (n.key === 'planet' && n.children) {
            const body = buildBody('planet', n.children, n.line, n.endLine ?? n.line);

            // First planet with orbit_distance = 0 is the star
            const thisOrbitDist = resolveValue(body.orbitDistance);
            if (bodies.length === 0 && thisOrbitDist === 0) {
                body.bodyType = 'star';
            }

            // Accumulate orbit
            body.resolvedOrbitRadius = cumulativeOrbit + thisOrbitDist;
            body.resolvedOrbitAngle = body.orbitAngle.type === 'random'
                ? Math.random() * 360
                : resolveValue(body.orbitAngle);
            body.resolvedSize = resolveValue(body.size);
            body.resolvedCount = resolveCount(body.count);

            // Handle per-body change_orbit for next sibling
            cumulativeOrbit = body.resolvedOrbitRadius + body.changeOrbit;

            // Resolve moons recursively (handles sub-moons, ring worlds at any depth)
            resolveMoonsRecursive(body);

            // Resolve sub-planets (binary star companions)
            let subCumulativeOrbit = 0;
            for (const sub of body.subPlanets) {
                const subDist = resolveValue(sub.orbitDistance);
                sub.resolvedOrbitRadius = subCumulativeOrbit + subDist;
                sub.resolvedOrbitAngle = sub.orbitAngle.type === 'random'
                    ? Math.random() * 360
                    : resolveValue(sub.orbitAngle);
                sub.resolvedSize = resolveValue(sub.size);
                sub.resolvedCount = resolveCount(sub.count);
                subCumulativeOrbit = sub.resolvedOrbitRadius + sub.changeOrbit;

                // Resolve sub-planet moons recursively
                resolveMoonsRecursive(sub);
            }

            bodies.push(body);
            bodyChangeOrbitMap.push({ line: lastChangeOrbitLine, value: lastChangeOrbitValue });
        }
    }

    // ── Post-process: detect ring world groups at all levels ──────────────
    groupRingWorlds(bodies, bodyChangeOrbitMap);
    groupRingWorldsRecursive(bodies);

    return {
        key,
        displayName,
        starClass,
        flags,
        usage,
        asteroidBelts,
        bodies,
        line,
        endLine,
    };
}

// ─── Ring World Grouping ────────────────────────────────────────────────────

const RING_CLASS_COLORS: Record<string, string> = {
    'pc_ringworld_habitable':        '#E0C060',
    'pc_ringworld_habitable_damaged':'#B09040',
    'pc_ringworld_tech':             '#A0A0A0',
    'pc_ringworld_tech_damaged':     '#808060',
    'pc_ringworld_seam':             '#909090',
    'pc_ringworld_seam_damaged':     '#707060',
    'pc_ringworld_shielded':         '#6080C0',
};

function isRingWorldClass(cls: string): boolean {
    return cls.startsWith('pc_ringworld');
}

function getRingColor(cls: string): string {
    return RING_CLASS_COLORS[cls] ?? '#888888';
}

/**
 * Detect consecutive ring world segments at the same orbit and group them.
 * Ring segments: consecutive planets with pc_ringworld_* class at the same resolvedOrbitRadius.
 */
function groupRingWorlds(bodies: CelestialBody[], bodyChangeOrbitMap: { line: number; value: number }[]): void {
    let i = 0;
    while (i < bodies.length) {
        // Skip non-ring bodies
        if (!isRingWorldClass(bodies[i].planetClass)) { i++; continue; }

        // Start a potential ring group
        const groupStart = i;
        const orbitRadius = bodies[i].resolvedOrbitRadius;

        // Collect consecutive ring segments at same orbit radius
        while (i < bodies.length
            && isRingWorldClass(bodies[i].planetClass)
            && bodies[i].resolvedOrbitRadius === orbitRadius) {
            i++;
        }

        const groupEnd = i; // exclusive
        const groupSize = groupEnd - groupStart;

        // Need at least 2 segments to form a ring group
        if (groupSize < 2) continue;

        // Build ring segments with angular positions
        const segments: RingSegment[] = [];
        let runningAngle = bodies[groupStart].resolvedOrbitAngle;
        for (let j = groupStart; j < groupEnd; j++) {
            const body = bodies[j];
            const segAngle = resolveValue(body.orbitAngle);
            if (j > groupStart) {
                runningAngle += segAngle;
            }
            const startAngle = runningAngle - segAngle;
            segments.push({
                line: body.line,
                endLine: body.endLine,
                planetClass: body.planetClass,
                name: body.name,
                startAngle,
                endAngle: runningAngle,
                color: getRingColor(body.planetClass),
            });
            body.isRingSegment = true;
        }

        // Total arc covered
        const totalAngle = runningAngle - (bodies[groupStart].resolvedOrbitAngle - resolveValue(bodies[groupStart].orbitAngle));

        // Get the change_orbit line that precedes this ring group
        const changeOrbitInfo = bodyChangeOrbitMap[groupStart];

        // Set ring group on the first segment (anchor)
        const anchorLine = bodies[groupStart].line;
        const ringGroup: RingGroup = {
            orbitRadius,
            segments,
            totalAngle,
            firstLine: anchorLine,
            lastEndLine: bodies[groupEnd - 1].endLine,
            changeOrbitLine: changeOrbitInfo?.line ?? -1,
            changeOrbitValue: changeOrbitInfo?.value ?? 0,
        };
        bodies[groupStart].ringGroup = ringGroup;
        bodies[groupStart].ringGroupAnchorLine = anchorLine;

        // Mark non-anchor segments as hidden, set anchor line
        for (let j = groupStart + 1; j < groupEnd; j++) {
            bodies[j].ringSegmentHidden = true;
            bodies[j].ringGroupAnchorLine = anchorLine;
        }
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseSolarSystemFile(content: string): SolarSystem[] {
    const tokens = tokenize(content);
    const parser = new Parser(tokens);
    const rootNodes = parser.parse();

    const systems: SolarSystem[] = [];
    for (const node of rootNodes) {
        // Top-level blocks with children that contain 'planet' sub-blocks are solar systems
        if (node.children) {
            // Check if this block looks like a solar system (has planet children or class)
            const hasClass = node.children.some(c => c.key === 'class');
            const hasPlanet = node.children.some(c => c.key === 'planet');
            if (hasClass || hasPlanet) {
                systems.push(buildSolarSystem(node.key, node.children, node.line, node.endLine ?? node.line));
            }
        }
    }

    return systems;
}

// Expose for property editing
export { resolveValue, resolveCount };
