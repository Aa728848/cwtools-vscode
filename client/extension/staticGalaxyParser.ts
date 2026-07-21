/**
 * Static Galaxy scenario parser.
 *
 * Parses Stellaris `map/setup_scenarios/*.txt` `static_galaxy_scenario` blocks
 * into a span-carrying semantic model used by the Static Galaxy preview/editor.
 *
 * Design rules (see docs/static-galaxy-preview-editor-plan.md):
 * - Never locate coordinates with line-based regex; every editable number keeps
 *   its exact token span so write-back can replace only that token.
 * - Single tokenization + single ordered AST walk.
 * - `coordinate_transform` applies to later declarations in document order.
 * - Unknown fields are preserved and never reported as errors.
 */
import { Token, TokenType, tokenize } from './pdxTokenizer';
import {
    StaticGalaxyAxis,
    StaticGalaxyDiagnosticView,
    StaticGalaxyHyperlaneView,
    StaticGalaxyNebulaView,
    StaticGalaxyPosition,
    StaticGalaxyScenarioView,
    StaticGalaxySystemView,
} from '../shared/staticGalaxyProtocol';

// ─── Lightweight span-carrying AST ──────────────────────────────────────────

export interface OffsetSpan {
    start: number;
    end: number;
}

export interface PdxAssignmentNode {
    key: string;
    keySpan: OffsetSpan;
    /** Scalar value token span (absent for blocks and bare values). */
    valueSpan?: OffsetSpan;
    /** Span of the `{ ... }` block including braces. */
    blockSpan?: OffsetSpan;
    /** Raw scalar token text (number/identifier, or string content). */
    value?: string;
    valueKind: 'number' | 'string' | 'identifier' | 'block' | 'none';
    children?: PdxAssignmentNode[];
    line: number;
}

class AstParser {
    private pos = 0;
    private readonly errors: string[] = [];

    constructor(private readonly tokens: Token[]) { }

    parse(): { nodes: PdxAssignmentNode[]; errors: string[] } {
        const nodes: PdxAssignmentNode[] = [];
        while (this.peek().type !== TokenType.EOF) {
            if (this.peek().type === TokenType.RBrace) {
                const token = this.advance();
                this.errors.push(`Unexpected closing brace at line ${token.line}`);
                continue;
            }
            const node = this.parseStatement();
            if (node) nodes.push(node);
        }
        return { nodes, errors: [...this.errors] };
    }

    private peek(): Token {
        return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', line: 0, startOffset: 0, endOffset: 0 };
    }

    private advance(): Token {
        return this.tokens[this.pos++] ?? this.peek();
    }

    private parseStatementsUntilRBrace(): { nodes: PdxAssignmentNode[]; endToken?: Token } {
        const nodes: PdxAssignmentNode[] = [];
        while (this.peek().type !== TokenType.EOF && this.peek().type !== TokenType.RBrace) {
            const node = this.parseStatement();
            if (node) nodes.push(node);
        }
        if (this.peek().type === TokenType.RBrace) {
            return { nodes, endToken: this.advance() };
        }
        return { nodes };
    }

    private parseStatement(): PdxAssignmentNode | null {
        // The enclosing block normally consumes RBrace; reaching one here is
        // structurally invalid and must make the document read-only.
        if (this.peek().type === TokenType.RBrace) {
            const token = this.advance();
            this.errors.push(`Unexpected closing brace at line ${token.line}`);
            return null;
        }
        const keyToken = this.advance();
        if (keyToken.type === TokenType.EOF) return null;
        if (keyToken.type !== TokenType.Identifier && keyToken.type !== TokenType.String && keyToken.type !== TokenType.Number) {
            this.errors.push(`Unexpected token ${keyToken.value || TokenType[keyToken.type]} at line ${keyToken.line}`);
            return null;
        }

        if (this.peek().type === TokenType.Equals) {
            this.advance(); // =
            if (this.peek().type === TokenType.LBrace) {
                const open = this.advance();
                const block = this.parseStatementsUntilRBrace();
                if (!block.endToken) {
                    this.errors.push(`Unclosed block for ${keyToken.value} at line ${keyToken.line}`);
                }
                const end = block.endToken ? block.endToken.endOffset : open.endOffset;
                return {
                    key: keyToken.value,
                    keySpan: { start: keyToken.startOffset, end: keyToken.endOffset },
                    blockSpan: { start: open.startOffset, end },
                    valueKind: 'block',
                    children: block.nodes,
                    line: keyToken.line,
                };
            }
            const valueToken = this.peek();
            if (valueToken.type === TokenType.EOF || valueToken.type === TokenType.RBrace) {
                // Keep a closing brace available to the enclosing block.
                this.errors.push(`Missing value for ${keyToken.value} at line ${keyToken.line}`);
                return {
                    key: keyToken.value,
                    keySpan: { start: keyToken.startOffset, end: keyToken.endOffset },
                    valueKind: 'none',
                    line: keyToken.line,
                };
            }
            if (valueToken.type !== TokenType.Identifier
                && valueToken.type !== TokenType.String
                && valueToken.type !== TokenType.Number) {
                this.advance();
                this.errors.push(`Unexpected value for ${keyToken.value} at line ${valueToken.line}`);
                return {
                    key: keyToken.value,
                    keySpan: { start: keyToken.startOffset, end: keyToken.endOffset },
                    valueKind: 'none',
                    line: keyToken.line,
                };
            }
            this.advance();
            const valueKind = valueToken.type === TokenType.Number
                ? 'number'
                : valueToken.type === TokenType.String
                    ? 'string'
                    : 'identifier';
            return {
                key: keyToken.value,
                keySpan: { start: keyToken.startOffset, end: keyToken.endOffset },
                valueSpan: { start: valueToken.startOffset, end: valueToken.endOffset },
                value: valueToken.value,
                valueKind,
                line: keyToken.line,
            };
        }

        // Bare value inside a block (e.g. extra_crisis_strength = { 0.5 1 }).
        return {
            key: keyToken.value,
            keySpan: { start: keyToken.startOffset, end: keyToken.endOffset },
            valueKind: 'none',
            line: keyToken.line,
        };
    }
}

// ─── Host-internal parsed model ─────────────────────────────────────────────

/** Affine transform effective = raw * mul + add, composed in document order. */
export interface AxisTransform {
    mul: number;
    add: number;
    invertible: boolean;
    reason?: string;
}

const IDENTITY_TRANSFORM: AxisTransform = { mul: 1, add: 0, invertible: true };

export interface ParsedAxis {
    kind: 'fixed' | 'range' | 'unresolved';
    /** Raw file values (pre-transform). */
    value?: number;
    min?: number;
    max?: number;
    /** Exact number token spans for write-back. Absent => not writable. */
    spans?: { value?: OffsetSpan; min?: OffsetSpan; max?: OffsetSpan };
    /** Unresolved raw text / reason (expressions, unknown variables). */
    raw?: string;
    reason?: string;
}

export interface ParsedSystem {
    nodeKey: string;
    id: string;
    name?: string;
    initializer?: string;
    x?: ParsedAxis;
    y?: ParsedAxis;
    z?: ParsedAxis;
    transform: { x: AxisTransform; y: AxisTransform; z?: AxisTransform };
    hasTransform: boolean;
    editable: boolean;
    editBlockedReason?: string;
    diagnostics: StaticGalaxyDiagnosticView[];
    positionBlockSpan?: OffsetSpan;
    keySpan: OffsetSpan;
    blockSpan?: OffsetSpan;
    line: number;
}

export interface ParsedNebula {
    nodeKey: string;
    name?: string;
    x?: ParsedAxis;
    y?: ParsedAxis;
    z?: ParsedAxis;
    transform: { x: AxisTransform; y: AxisTransform; z?: AxisTransform };
    hasTransform: boolean;
    editable: boolean;
    editBlockedReason?: string;
    radius: number | null;
    /** Token span of a literal radius value (write-back target). */
    radiusSpan?: OffsetSpan;
    /** Whether radius can be written (literal token or insertable block). */
    radiusWritable: boolean;
    diagnostics: StaticGalaxyDiagnosticView[];
    positionBlockSpan?: OffsetSpan;
    keySpan: OffsetSpan;
    blockSpan?: OffsetSpan;
    line: number;
}

export interface ParsedHyperlane {
    nodeKey: string;
    kind: 'add' | 'remove' | 'prevent';
    fromId: string;
    toId: string;
    fromNodeKey?: string;
    toNodeKey?: string;
    diagnostics: StaticGalaxyDiagnosticView[];
    keySpan: OffsetSpan;
    blockSpan?: OffsetSpan;
    /** Exact declaration text at parse time; used as a staleness check before deletion. */
    rawText?: string;
    line: number;
}

export interface ParsedScenario {
    scenarioKey: string;
    name: string;
    settings: { randomHyperlanes: boolean; maxHyperlaneDistance?: number; hyperlaneDensity?: number };
    systems: ParsedSystem[];
    nebulas: ParsedNebula[];
    hyperlanes: ParsedHyperlane[];
    diagnostics: StaticGalaxyDiagnosticView[];
    keySpan: OffsetSpan;
    blockSpan?: OffsetSpan;
    line: number;
}

export interface StaticGalaxyParseResult {
    ok: boolean;
    error?: string;
    scenarios: ParsedScenario[];
}

// ─── Transform composition ──────────────────────────────────────────────────

function applyTransformOp(t: AxisTransform, op: string, operand: number): AxisTransform {
    if (!Number.isFinite(operand)) {
        return { ...t, invertible: false, reason: `transform operand ${op} is not finite` };
    }
    switch (op) {
        case 'add': return { ...t, add: t.add + operand };
        case 'sub': return { ...t, add: t.add - operand };
        case 'mul':
            if (operand === 0) return { ...t, mul: 0, invertible: false, reason: 'mul = 0 is not invertible' };
            return { mul: t.mul * operand, add: t.add * operand, invertible: t.invertible, reason: t.reason };
        case 'div':
            if (operand === 0) return { ...t, invertible: false, reason: 'div = 0 is not invertible' };
            return { mul: t.mul / operand, add: t.add / operand, invertible: t.invertible, reason: t.reason };
        default:
            return t;
    }
}

function applyTransform(t: AxisTransform, raw: number): number {
    return raw * t.mul + t.add;
}

function isIdentity(t: AxisTransform): boolean {
    return t.mul === 1 && t.add === 0 && t.invertible;
}

// ─── Scenario parsing ───────────────────────────────────────────────────────

interface TransformState {
    x: AxisTransform;
    y: AxisTransform;
    z: AxisTransform;
}

function cloneTransformState(state: TransformState): TransformState {
    return { x: { ...state.x }, y: { ...state.y }, z: { ...state.z } };
}

function scalarNumber(node: PdxAssignmentNode | undefined): number | undefined {
    if (!node || node.valueKind === 'block' || node.valueKind === 'none') return undefined;
    const n = parseFloat(node.value ?? '');
    return Number.isFinite(n) ? n : undefined;
}

function scalarString(node: PdxAssignmentNode | undefined): string | undefined {
    if (!node || node.valueKind === 'block' || node.valueKind === 'none') return undefined;
    return node.value;
}

function findChild(children: PdxAssignmentNode[] | undefined, key: string): PdxAssignmentNode | undefined {
    return children?.find(c => c.key === key);
}

/**
 * Parses one axis (`x`/`y`/`z`) of a position block: fixed number,
 * `{ min max }` range, or an unresolved expression/variable.
 * Simple `@var` references resolve when a numeric `@var = n` assignment was
 * seen earlier; such axes display but are not writable (no literal span).
 */
function parseAxis(
    positionChildren: PdxAssignmentNode[],
    axisKey: 'x' | 'y' | 'z',
    variables: Map<string, number>,
): ParsedAxis | undefined {
    const node = findChild(positionChildren, axisKey);
    if (!node) return undefined;

    if (node.valueKind === 'block' && node.children) {
        const minNode = findChild(node.children, 'min');
        const maxNode = findChild(node.children, 'max');
        const min = scalarNumber(minNode);
        const max = scalarNumber(maxNode);
        if (min !== undefined && max !== undefined && minNode?.valueSpan && maxNode?.valueSpan) {
            return {
                kind: 'range',
                min,
                max,
                spans: { min: minNode.valueSpan, max: maxNode.valueSpan },
            };
        }
        return { kind: 'unresolved', raw: 'block', reason: `axis ${axisKey} block lacks numeric min/max` };
    }

    if (node.valueKind === 'number' && node.valueSpan) {
        const value = parseFloat(node.value ?? '');
        if (Number.isFinite(value)) {
            return { kind: 'fixed', value, spans: { value: node.valueSpan } };
        }
    }

    if (node.value && node.value.startsWith('@') && !node.value.startsWith('@[')) {
        const resolved = variables.get(node.value);
        if (resolved !== undefined) {
            // Resolved for display, but the token is a variable reference —
            // write-back must not replace it with a literal.
            return { kind: 'fixed', value: resolved };
        }
    }

    return {
        kind: 'unresolved',
        raw: node.value ?? (node.valueKind === 'block' ? 'block' : ''),
        reason: node.value?.startsWith('@[')
            ? 'arithmetic expression is not editable'
            : `unresolved value for axis ${axisKey}`,
    };
}

function axisCenter(axis: ParsedAxis | undefined): number | undefined {
    if (!axis) return undefined;
    if (axis.kind === 'fixed') return axis.value;
    if (axis.kind === 'range') return (axis.min! + axis.max!) / 2;
    return undefined;
}

function toViewAxis(axis: ParsedAxis | undefined, transform: AxisTransform | undefined, label: string): StaticGalaxyAxis {
    const t = transform ?? IDENTITY_TRANSFORM;
    if (!axis) {
        // Missing axis: preview falls back to 0 (diagnostic emitted elsewhere).
        return { kind: 'fixed', value: 0, center: 0 };
    }
    if (axis.kind === 'fixed') {
        const eff = applyTransform(t, axis.value!);
        return { kind: 'fixed', value: eff, center: eff };
    }
    if (axis.kind === 'range') {
        const a = applyTransform(t, axis.min!);
        const b = applyTransform(t, axis.max!);
        const reversed = a > b;
        const low = reversed ? b : a;
        const high = reversed ? a : b;
        return {
            kind: 'range',
            min: low,
            max: high,
            center: (a + b) / 2,
            width: high - low,
            reversed,
        };
    }
    return { kind: 'unresolved', raw: axis.raw ?? '', reason: axis.reason ?? `unresolved ${label}` };
}

function toRawViewAxis(axis: ParsedAxis | undefined): StaticGalaxyAxis {
    if (!axis) return { kind: 'fixed', value: 0, center: 0 };
    if (axis.kind === 'fixed') return { kind: 'fixed', value: axis.value!, center: axis.value! };
    if (axis.kind === 'range') {
        const reversed = axis.min! > axis.max!;
        return {
            kind: 'range',
            min: axis.min!,
            max: axis.max!,
            center: (axis.min! + axis.max!) / 2,
            width: Math.abs(axis.max! - axis.min!),
            reversed,
        };
    }
    return { kind: 'unresolved', raw: axis.raw ?? '', reason: axis.reason ?? 'unresolved' };
}

function axisDiagnostics(axis: ParsedAxis | undefined, label: 'x' | 'y', nodeKey: string): StaticGalaxyDiagnosticView[] {
    const diags: StaticGalaxyDiagnosticView[] = [];
    if (!axis) {
        diags.push({
            severity: 'warning',
            code: 'missing-axis',
            message: `System is missing ${label.toUpperCase()} — preview falls back to 0`,
            nodeKey,
        });
        return diags;
    }
    if (axis.kind === 'unresolved') {
        diags.push({
            severity: 'error',
            code: 'unresolved-coordinate',
            message: `${label.toUpperCase()} is not a resolvable number: ${axis.raw ?? ''}`,
            nodeKey,
        });
    } else if (axis.kind === 'range' && axis.min! > axis.max!) {
        diags.push({
            severity: 'warning',
            code: 'reversed-range',
            message: `${label.toUpperCase()} range is reversed (min > max)`,
            nodeKey,
        });
    } else if (axis.kind === 'fixed' && axis.spans === undefined) {
        diags.push({
            severity: 'information',
            code: 'non-literal-coordinate',
            message: `${label.toUpperCase()} uses a variable reference — canvas editing disabled`,
            nodeKey,
        });
    }
    return diags;
}

// ─── Main parse ─────────────────────────────────────────────────────────────

export function parseStaticGalaxy(text: string): StaticGalaxyParseResult {
    let ast: PdxAssignmentNode[];
    try {
        const parsed = new AstParser(tokenize(text)).parse();
        if (parsed.errors.length > 0) {
            return { ok: false, error: parsed.errors[0], scenarios: [] };
        }
        ast = parsed.nodes;
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), scenarios: [] };
    }

    const scenarios: ParsedScenario[] = [];
    const variables = new Map<string, number>();
    let scenarioIndex = 0;

    for (const node of ast) {
        // Track top-level numeric @variables for display resolution.
        if (node.key.startsWith('@') && node.valueKind === 'number') {
            const n = parseFloat(node.value ?? '');
            if (Number.isFinite(n)) variables.set(node.key, n);
            continue;
        }
        if (node.key !== 'static_galaxy_scenario' || node.valueKind !== 'block' || !node.children) continue;

        scenarios.push(parseScenario(node, scenarioIndex++, variables));
    }

    // Keep the exact declaration text so edit-time staleness checks can
    // verify the source still matches before deleting a lane.
    for (const scenario of scenarios) {
        for (const lane of scenario.hyperlanes) {
            lane.rawText = text.slice(lane.keySpan.start, (lane.blockSpan ?? lane.keySpan).end);
        }
    }

    if (scenarios.length === 0) {
        return { ok: false, error: 'No static_galaxy_scenario block found', scenarios: [] };
    }
    return { ok: true, scenarios };
}

function parseScenario(
    node: PdxAssignmentNode,
    index: number,
    variables: Map<string, number>,
): ParsedScenario {
    const scenarioKey = `sc${index}`;
    const children = node.children ?? [];

    const parsedName = scalarString(findChild(children, 'name'));
    const name = parsedName?.trim() ? parsedName : `Scenario ${index + 1}`;
    const settings = {
        randomHyperlanes: scalarString(findChild(children, 'random_hyperlanes')) === 'yes',
        maxHyperlaneDistance: scalarNumber(findChild(children, 'max_hyperlane_distance')),
        hyperlaneDensity: scalarNumber(findChild(children, 'hyperlane_density')),
    };

    const systems: ParsedSystem[] = [];
    const nebulas: ParsedNebula[] = [];
    const hyperlanes: ParsedHyperlane[] = [];
    const diagnostics: StaticGalaxyDiagnosticView[] = [];
    const transform: TransformState = { x: { ...IDENTITY_TRANSFORM }, y: { ...IDENTITY_TRANSFORM }, z: { ...IDENTITY_TRANSFORM } };
    let sawTransform = false;
    let sawZ = false;

    // Document-order walk: transforms affect only later declarations.
    for (const child of children) {
        switch (child.key) {
            case 'coordinate_transform': {
                updateTransformState(transform, child);
                sawTransform = true;
                break;
            }
            case 'system': {
                const sys = parseSystem(child, scenarioKey, systems.length, transform, sawTransform, variables);
                sawZ = sawZ || sys.z !== undefined;
                systems.push(sys);
                break;
            }
            case 'nebula': {
                const neb = parseNebula(child, scenarioKey, nebulas.length, transform, sawTransform, variables);
                sawZ = sawZ || neb.z !== undefined;
                nebulas.push(neb);
                break;
            }
            case 'add_hyperlane':
            case 'remove_hyperlane':
            case 'prevent_hyperlane': {
                hyperlanes.push(parseHyperlane(child, scenarioKey, hyperlanes.length));
                break;
            }
            default:
                // Unknown fields are preserved and never reported.
                break;
        }
    }

    // ── Cross-node diagnostics ──────────────────────────────────────────────

    const idCounts = new Map<string, number>();
    for (const sys of systems) {
        if (sys.id === '') continue;
        idCounts.set(sys.id, (idCounts.get(sys.id) ?? 0) + 1);
    }
    for (const sys of systems) {
        if (sys.id !== '' && (idCounts.get(sys.id) ?? 0) > 1) {
            sys.diagnostics.push({
                severity: 'error',
                code: 'duplicate-system-id',
                message: `Duplicate system id ${sys.id}`,
                nodeKey: sys.nodeKey,
            });
        }
    }

    // Duplicate effective centers.
    const centerOwners = new Map<string, string[]>();
    for (const sys of systems) {
        const cx = effectiveCenter(sys.x, sys.transform.x);
        const cy = effectiveCenter(sys.y, sys.transform.y);
        if (cx === undefined || cy === undefined) continue;
        const key = `${cx}|${cy}`;
        const owners = centerOwners.get(key) ?? [];
        owners.push(sys.nodeKey);
        centerOwners.set(key, owners);
    }
    for (const owners of centerOwners.values()) {
        if (owners.length < 2) continue;
        for (const nodeKey of owners) {
            const sys = systems.find(s => s.nodeKey === nodeKey);
            sys?.diagnostics.push({
                severity: 'warning',
                code: 'duplicate-position',
                message: `${owners.length} systems share the same center`,
                nodeKey,
            });
        }
    }

    // Overlapping coordinate ranges (rect intersection over range axes).
    const rangeRects = systems
        .filter(s => s.x?.kind === 'range' || s.y?.kind === 'range')
        .map(s => {
            const x = s.x?.kind === 'range'
                ? { low: Math.min(s.x.min!, s.x.max!), high: Math.max(s.x.min!, s.x.max!) }
                : { low: s.x?.value ?? 0, high: s.x?.value ?? 0 };
            const y = s.y?.kind === 'range'
                ? { low: Math.min(s.y.min!, s.y.max!), high: Math.max(s.y.min!, s.y.max!) }
                : { low: s.y?.value ?? 0, high: s.y?.value ?? 0 };
            return { nodeKey: s.nodeKey, x, y };
        });
    const overlapping = new Set<string>();
    for (let i = 0; i < rangeRects.length; i++) {
        for (let j = i + 1; j < rangeRects.length; j++) {
            const a = rangeRects[i]!;
            const b = rangeRects[j]!;
            if (a.x.low <= b.x.high && b.x.low <= a.x.high && a.y.low <= b.y.high && b.y.low <= a.y.high) {
                overlapping.add(a.nodeKey);
                overlapping.add(b.nodeKey);
            }
        }
    }
    for (const sys of systems) {
        if (overlapping.has(sys.nodeKey)) {
            sys.diagnostics.push({
                severity: 'warning',
                code: 'overlapping-range',
                message: 'Coordinate range overlaps another system',
                nodeKey: sys.nodeKey,
            });
        }
    }

    // Resolve hyperlane endpoints against system ids.
    for (const lane of hyperlanes) {
        lane.fromNodeKey = resolveEndpoint(lane.fromId, systems, idCounts, lane, 'from');
        lane.toNodeKey = resolveEndpoint(lane.toId, systems, idCounts, lane, 'to');
    }

    if (settings.randomHyperlanes) {
        diagnostics.push({
            severity: 'warning',
            code: 'random-hyperlanes-imprecise',
            message: 'random_hyperlanes = yes — final lanes are generated at runtime and cannot be previewed exactly',
        });
    }
    if (sawZ) {
        diagnostics.push({
            severity: 'information',
            code: 'z-projection',
            message: 'Z coordinates exist — the canvas shows a 2D X/Y projection',
        });
    }
    if (sawTransform) {
        diagnostics.push({
            severity: 'information',
            code: 'transform-applied',
            message: 'coordinate_transform affects displayed positions; raw file values are shown alongside',
        });
    }

    return {
        scenarioKey,
        name,
        settings,
        systems,
        nebulas,
        hyperlanes,
        diagnostics,
        keySpan: { ...node.keySpan },
        blockSpan: node.blockSpan ? { ...node.blockSpan } : undefined,
        line: node.line,
    };
}

function effectiveCenter(axis: ParsedAxis | undefined, transform: AxisTransform): number | undefined {
    const raw = axisCenter(axis);
    return raw === undefined ? undefined : applyTransform(transform, raw);
}

function resolveEndpoint(
    id: string,
    systems: ParsedSystem[],
    idCounts: Map<string, number>,
    lane: ParsedHyperlane,
    endpoint: 'from' | 'to',
): string | undefined {
    const matches = systems.filter(s => s.id === id);
    if (matches.length === 0) {
        lane.diagnostics.push({
            severity: 'error',
            code: 'dangling-hyperlane',
            message: `Hyperlane ${endpoint} endpoint ${id} does not match any system id`,
            nodeKey: lane.nodeKey,
        });
        return undefined;
    }
    if ((idCounts.get(id) ?? 0) > 1) {
        lane.diagnostics.push({
            severity: 'error',
            code: 'ambiguous-hyperlane-endpoint',
            message: `Hyperlane ${endpoint} endpoint ${id} matches multiple systems`,
            nodeKey: lane.nodeKey,
        });
        return undefined;
    }
    return matches[0]!.nodeKey;
}

function updateTransformState(state: TransformState, node: PdxAssignmentNode): void {
    for (const axisKey of ['x', 'y', 'z'] as const) {
        const axisNode = findChild(node.children, axisKey);
        if (!axisNode?.children) continue;
        let t = state[axisKey];
        // Operations apply in document order (add/sub/mul/div).
        for (const op of axisNode.children) {
            const operand = scalarNumber(op);
            if (operand === undefined) {
                if (op.key === 'add' || op.key === 'sub' || op.key === 'mul' || op.key === 'div') {
                    t = { ...t, invertible: false, reason: `transform operand ${op.key} is not a finite number` };
                }
                continue;
            }
            t = applyTransformOp(t, op.key, operand);
        }
        state[axisKey] = t;
    }
}

function parseSystem(
    node: PdxAssignmentNode,
    scenarioKey: string,
    index: number,
    transform: TransformState,
    sawTransform: boolean,
    variables: Map<string, number>,
): ParsedSystem {
    const nodeKey = `${scenarioKey}.sys${index}`;
    const children = node.children ?? [];
    const id = scalarString(findChild(children, 'id')) ?? '';
    const nameNode = findChild(children, 'name');
    const name = scalarString(nameNode);
    const initializer = scalarString(findChild(children, 'initializer'));
    const positionNode = findChild(children, 'position');
    const positionChildren = positionNode?.children ?? [];

    const x = parseAxis(positionChildren, 'x', variables);
    const y = parseAxis(positionChildren, 'y', variables);
    const z = parseAxis(positionChildren, 'z', variables);

    const snapshot = cloneTransformState(transform);
    const diagnostics: StaticGalaxyDiagnosticView[] = [
        ...axisDiagnostics(x, 'x', nodeKey),
        ...axisDiagnostics(y, 'y', nodeKey),
    ];

    if (!snapshot.x.invertible || !snapshot.y.invertible) {
        diagnostics.push({
            severity: 'information',
            code: 'non-invertible-transform',
            message: 'coordinate_transform is not invertible here — canvas editing disabled',
            nodeKey,
        });
    }
    if (!nameNode && !initializer) {
        diagnostics.push({
            severity: 'information',
            code: 'unnamed-system',
            message: 'System has neither name nor initializer',
            nodeKey,
        });
    }

    let editable = true;
    let editBlockedReason: string | undefined;
    const blockEdit = (reason: string) => {
        if (!editable) return;
        editable = false;
        editBlockedReason = reason;
    };
    if (!snapshot.x.invertible || !snapshot.y.invertible) {
        blockEdit(`coordinate_transform is not invertible: ${snapshot.x.reason ?? snapshot.y.reason ?? ''}`.trim());
    }
    if (!x?.spans || !y?.spans) {
        blockEdit('coordinates are not literal numbers (missing, expression or variable)');
    }

    return {
        nodeKey,
        id,
        name,
        initializer,
        x,
        y,
        z,
        transform: { x: snapshot.x, y: snapshot.y, z: snapshot.z },
        hasTransform: sawTransform && (!isIdentity(snapshot.x) || !isIdentity(snapshot.y) || (z !== undefined && !isIdentity(snapshot.z))),
        editable,
        editBlockedReason,
        diagnostics,
        positionBlockSpan: positionNode?.blockSpan ? { ...positionNode.blockSpan } : undefined,
        keySpan: { ...node.keySpan },
        blockSpan: node.blockSpan ? { ...node.blockSpan } : undefined,
        line: node.line,
    };
}

function parseNebula(
    node: PdxAssignmentNode,
    scenarioKey: string,
    index: number,
    transform: TransformState,
    sawTransform: boolean,
    variables: Map<string, number>,
): ParsedNebula {
    const nodeKey = `${scenarioKey}.neb${index}`;
    const children = node.children ?? [];
    const name = scalarString(findChild(children, 'name'));
    const positionNode = findChild(children, 'position');
    const positionChildren = positionNode?.children ?? [];

    const x = parseAxis(positionChildren, 'x', variables);
    const y = parseAxis(positionChildren, 'y', variables);
    const z = parseAxis(positionChildren, 'z', variables);
    const radiusNode = findChild(children, 'radius');
    const radius = scalarNumber(radiusNode) ?? null;
    // Literal numeric radius keeps its token span for write-back. A missing
    // radius can be inserted at the end of the nebula block; a non-literal
    // radius key (variable/expression) blocks radius editing entirely.
    const radiusSpan = radius !== null && radiusNode?.valueSpan ? { ...radiusNode.valueSpan } : undefined;
    const radiusWritable = radiusSpan !== undefined || (radiusNode === undefined && node.blockSpan !== undefined);

    const diagnostics: StaticGalaxyDiagnosticView[] = [
        ...axisDiagnostics(x, 'x', nodeKey),
        ...axisDiagnostics(y, 'y', nodeKey),
    ];
    if (radius !== null && (!Number.isFinite(radius) || radius < 0)) {
        diagnostics.push({
            severity: 'warning',
            code: 'negative-nebula-radius',
            message: `Nebula radius ${radius} is negative or non-finite`,
            nodeKey,
        });
    }

    const snapshot = cloneTransformState(transform);
    if (!snapshot.x.invertible || !snapshot.y.invertible) {
        diagnostics.push({
            severity: 'information',
            code: 'non-invertible-transform',
            message: 'coordinate_transform is not invertible here — canvas editing disabled',
            nodeKey,
        });
    }

    let editable = true;
    let editBlockedReason: string | undefined;
    if (!snapshot.x.invertible || !snapshot.y.invertible) {
        editable = false;
        editBlockedReason = `coordinate_transform is not invertible: ${snapshot.x.reason ?? snapshot.y.reason ?? ''}`.trim();
    } else if (!x?.spans || !y?.spans) {
        editable = false;
        editBlockedReason = 'coordinates are not literal numbers (missing, expression or variable)';
    }

    return {
        nodeKey,
        name,
        x,
        y,
        z,
        transform: { x: snapshot.x, y: snapshot.y, z: snapshot.z },
        hasTransform: sawTransform && (!isIdentity(snapshot.x) || !isIdentity(snapshot.y) || (z !== undefined && !isIdentity(snapshot.z))),
        editable,
        editBlockedReason,
        radius,
        radiusSpan,
        radiusWritable,
        diagnostics,
        positionBlockSpan: positionNode?.blockSpan ? { ...positionNode.blockSpan } : undefined,
        keySpan: { ...node.keySpan },
        blockSpan: node.blockSpan ? { ...node.blockSpan } : undefined,
        line: node.line,
    };
}

function parseHyperlane(node: PdxAssignmentNode, scenarioKey: string, index: number): ParsedHyperlane {
    const kind = node.key === 'add_hyperlane' ? 'add' : node.key === 'remove_hyperlane' ? 'remove' : 'prevent';
    return {
        nodeKey: `${scenarioKey}.lane${index}`,
        kind,
        fromId: scalarString(findChild(node.children, 'from')) ?? '',
        toId: scalarString(findChild(node.children, 'to')) ?? '',
        diagnostics: [],
        keySpan: { ...node.keySpan },
        blockSpan: node.blockSpan ? { ...node.blockSpan } : undefined,
        line: node.line,
    };
}

// ─── View mapping (host -> webview render model) ────────────────────────────

function toViewPosition(
    x: ParsedAxis | undefined,
    y: ParsedAxis | undefined,
    z: ParsedAxis | undefined,
    transform: { x: AxisTransform; y: AxisTransform; z?: AxisTransform },
    effective: boolean,
): StaticGalaxyPosition {
    if (effective) {
        return {
            x: toViewAxis(x, transform.x, 'x'),
            y: toViewAxis(y, transform.y, 'y'),
            z: z ? toViewAxis(z, transform.z, 'z') : undefined,
        };
    }
    return {
        x: toRawViewAxis(x),
        y: toRawViewAxis(y),
        z: z ? toRawViewAxis(z) : undefined,
    };
}

export function toScenarioView(scenario: ParsedScenario): StaticGalaxyScenarioView {
    const systems: StaticGalaxySystemView[] = scenario.systems.map(sys => ({
        nodeKey: sys.nodeKey,
        id: sys.id,
        name: sys.name,
        displayName: sys.name?.trim() ? sys.name : (sys.id !== '' ? `System ${sys.id}` : sys.nodeKey),
        initializer: sys.initializer,
        rawPosition: toViewPosition(sys.x, sys.y, sys.z, sys.transform, false),
        effectivePosition: toViewPosition(sys.x, sys.y, sys.z, sys.transform, true),
        editable: sys.editable,
        editBlockedReason: sys.editBlockedReason,
        transformApplied: sys.hasTransform,
        diagnostics: sys.diagnostics,
    }));

    const nebulas: StaticGalaxyNebulaView[] = scenario.nebulas.map(neb => ({
        nodeKey: neb.nodeKey,
        name: neb.name,
        displayName: neb.name?.trim() ? neb.name : 'Nebula',
        rawPosition: toViewPosition(neb.x, neb.y, neb.z, neb.transform, false),
        effectivePosition: toViewPosition(neb.x, neb.y, neb.z, neb.transform, true),
        radius: neb.radius,
        radiusEditable: neb.radiusWritable,
        editable: neb.editable,
        editBlockedReason: neb.editBlockedReason,
        transformApplied: neb.hasTransform,
        diagnostics: neb.diagnostics,
    }));

    // Dedupe reversed duplicate declarations in the render model; source
    // diagnostics remain attached to each individual declaration.
    const seenLanes = new Set<string>();
    const hyperlanes: StaticGalaxyHyperlaneView[] = [];
    for (const lane of scenario.hyperlanes) {
        const pair = [lane.fromId, lane.toId].sort().join('|');
        const key = `${lane.kind}:${pair}`;
        if (lane.kind === 'add' && seenLanes.has(key)) continue;
        seenLanes.add(key);
        hyperlanes.push({
            nodeKey: lane.nodeKey,
            kind: lane.kind,
            fromId: lane.fromId,
            toId: lane.toId,
            fromNodeKey: lane.fromNodeKey,
            toNodeKey: lane.toNodeKey,
            diagnostics: lane.diagnostics,
        });
    }

    // Bounds over effective centers (nebulas expand by radius).
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const extend = (pos: StaticGalaxyPosition, pad: number) => {
        const cx = pos.x.kind === 'unresolved' ? 0 : pos.x.center;
        const cy = pos.y.kind === 'unresolved' ? 0 : pos.y.center;
        minX = Math.min(minX, cx - pad);
        maxX = Math.max(maxX, cx + pad);
        minY = Math.min(minY, cy - pad);
        maxY = Math.max(maxY, cy + pad);
    };
    for (const sys of systems) {
        extend(sys.effectivePosition, 0);
        // Range axes extend the visual footprint.
        const rx = sys.effectivePosition.x;
        const ry = sys.effectivePosition.y;
        if (rx.kind === 'range') {
            minX = Math.min(minX, rx.min);
            maxX = Math.max(maxX, rx.max);
        }
        if (ry.kind === 'range') {
            minY = Math.min(minY, ry.min);
            maxY = Math.max(maxY, ry.max);
        }
    }
    for (const neb of nebulas) {
        extend(neb.effectivePosition, Math.max(0, neb.radius ?? 0));
    }
    if (!Number.isFinite(minX)) {
        minX = -100;
        maxX = 100;
        minY = -100;
        maxY = 100;
    }

    return {
        scenarioKey: scenario.scenarioKey,
        name: scenario.name,
        systems,
        nebulas,
        hyperlanes,
        settings: scenario.settings,
        bounds: { minX, maxX, minY, maxY },
        diagnostics: scenario.diagnostics,
    };
}
