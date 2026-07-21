/**
 * Static Galaxy edit builder — pure write-back logic.
 *
 * Turns validated semantic edit requests into deterministic source
 * replacements. Coordinate edits touch only exact number tokens. Hyperlane
 * edits rename an existing declaration key or insert one declaration while
 * preserving the surrounding text and line-ending style.
 *
 * The builder is platform-free so it can be unit-tested without VS Code.
 */
import {
    STATIC_GALAXY_MAX_COORDINATE,
    StaticGalaxyEditRejectCode,
    StaticGalaxyHyperlaneUpdate,
    StaticGalaxyPositionUpdate,
} from '../shared/staticGalaxyProtocol';
import {
    AxisTransform,
    OffsetSpan,
    ParsedAxis,
    ParsedHyperlane,
    ParsedNebula,
    ParsedScenario,
    ParsedSystem,
} from './staticGalaxyParser';

export interface StaticGalaxyEditContext {
    /** Current document text (must match the parsed revision). */
    text: string;
    /** Parsed scenarios of the current Host revision. */
    scenarios: ParsedScenario[];
}

export interface StaticGalaxyMoveRequest {
    nodeKey: string;
    /** Target center in effective (canvas) coordinates. */
    x: number;
    y: number;
}

export type StaticGalaxyEditRequest =
    | { kind: 'move'; moves: StaticGalaxyMoveRequest[] }
    | { kind: 'update'; update: StaticGalaxyPositionUpdate }
    | { kind: 'nebulaRadius'; nodeKey: string; radius: number }
    | { kind: 'hyperlane'; update: StaticGalaxyHyperlaneUpdate }
    | { kind: 'addLanes'; links: Array<{ fromNodeKey: string; toNodeKey: string }> }
    | { kind: 'deleteLane'; fromNodeKey: string; toNodeKey: string };

type ParsedPositionNode = ParsedSystem | ParsedNebula;

export interface StaticGalaxyReplacement {
    span: OffsetSpan;
    text: string;
}

export interface StaticGalaxyBuiltEdit {
    /** Replacements sorted by start offset, back to front. */
    replacements: StaticGalaxyReplacement[];
    summary: string;
}

export class StaticGalaxyEditError extends Error {
    constructor(
        public readonly code: StaticGalaxyEditRejectCode,
        message: string,
    ) {
        super(message);
        this.name = 'StaticGalaxyEditError';
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function buildStaticGalaxyEdits(
    request: StaticGalaxyEditRequest,
    context: StaticGalaxyEditContext,
): StaticGalaxyBuiltEdit {
    switch (request.kind) {
        case 'move':
            return buildMoveEdit(request.moves, context);
        case 'update':
            return buildUpdateEdit(request.update, context);
        case 'hyperlane':
            return buildHyperlaneEdit(request.update, context);
        case 'addLanes':
            return buildAddLanesEdit(request.links, context);
        case 'deleteLane':
            return buildDeleteLaneEdit(request.fromNodeKey, request.toNodeKey, context);
        case 'nebulaRadius':
            return buildNebulaRadiusEdit(request.nodeKey, request.radius, context);
    }
}

// ─── Move (canvas drag) ─────────────────────────────────────────────────────

function buildMoveEdit(moves: StaticGalaxyMoveRequest[], context: StaticGalaxyEditContext): StaticGalaxyBuiltEdit {
    if (moves.length === 0) {
        throw new StaticGalaxyEditError('invalid-value', 'Move request contains no moves');
    }
    const replacements: StaticGalaxyReplacement[] = [];
    const summaries: string[] = [];

    for (const move of moves) {
        const node = findPositionNode(move.nodeKey, context.scenarios);
        assertEditable(node);
        assertFiniteCoordinate(move.x, 'x');
        assertFiniteCoordinate(move.y, 'y');

        const rawTargetX = invertAxis(node.transform.x, move.x);
        const rawTargetY = invertAxis(node.transform.y, move.y);

        replacements.push(...axisMoveReplacements(node, node.x, rawTargetX, 'x', context.text));
        replacements.push(...axisMoveReplacements(node, node.y, rawTargetY, 'y', context.text));
        summaries.push(`${positionNodeLabel(node)} -> (${formatInt(rawTargetX)}, ${formatInt(rawTargetY)})`);
    }

    return finalize(replacements, `Move ${summaries.join(', ')}`);
}

/**
 * Dragging translates a range axis as a whole: an integer delta is applied to
 * both endpoints so the width and the original (possibly reversed) order are
 * preserved exactly. Fixed axes round to the nearest legal integer.
 */
function axisMoveReplacements(
    node: ParsedPositionNode,
    axis: ParsedAxis | undefined,
    rawTargetCenter: number,
    label: 'x' | 'y',
    text: string,
): StaticGalaxyReplacement[] {
    if (!axis || !axis.spans) {
        throw new StaticGalaxyEditError('not-editable', `${positionNodeLabel(node)} ${label} axis is not editable`);
    }

    if (axis.kind === 'fixed') {
        const span = axis.spans.value!;
        assertTokenMatches(span, axis.value!, text, node, label);
        const next = Math.round(rawTargetCenter);
        assertLegalValue(next, label);
        if (next === axis.value) return [];
        return [{ span, text: formatInt(next) }];
    }

    if (axis.kind === 'range') {
        const currentCenter = (axis.min! + axis.max!) / 2;
        // Integer delta keeps the width bit-exact, even for reversed ranges.
        const delta = Math.round(rawTargetCenter - currentCenter);
        const nextMin = axis.min! + delta;
        const nextMax = axis.max! + delta;
        assertLegalValue(nextMin, label);
        assertLegalValue(nextMax, label);
        assertTokenMatches(axis.spans.min!, axis.min!, text, node, label);
        assertTokenMatches(axis.spans.max!, axis.max!, text, node, label);
        if (delta === 0) return [];
        return [
            { span: axis.spans.min!, text: formatInt(nextMin) },
            { span: axis.spans.max!, text: formatInt(nextMax) },
        ];
    }

    throw new StaticGalaxyEditError('not-editable', `${positionNodeLabel(node)} ${label} axis is unresolved`);
}

// ─── Precise Inspector update ───────────────────────────────────────────────

function buildUpdateEdit(update: StaticGalaxyPositionUpdate, context: StaticGalaxyEditContext): StaticGalaxyBuiltEdit {
    const node = findPositionNode(update.nodeKey, context.scenarios);
    assertEditable(node);

    const replacements: StaticGalaxyReplacement[] = [];
    if (update.x) replacements.push(...axisUpdateReplacements(node, node.x, update.x, 'x', context.text));
    if (update.y) replacements.push(...axisUpdateReplacements(node, node.y, update.y, 'y', context.text));
    if (update.z) {
        replacements.push(...(node.z
            ? axisUpdateReplacements(node, node.z, update.z, 'z', context.text)
            : [buildMissingZInsertion(node, update.z, context.text)]));
    }
    return finalize(replacements, `Set position of ${positionNodeLabel(node)}`);
}

function buildMissingZInsertion(
    node: ParsedPositionNode,
    update: NonNullable<StaticGalaxyPositionUpdate['z']>,
    text: string,
): StaticGalaxyReplacement {
    const block = node.positionBlockSpan;
    if (!block || block.end <= block.start) {
        throw new StaticGalaxyEditError('not-editable', `${positionNodeLabel(node)} has no editable position block`);
    }
    const zValue = update.kind === 'fixed'
        ? formatInt(assertRoundedLegal(update.value, 'z'))
        : `{ min = ${formatInt(assertRoundedLegal(update.min, 'z'))} max = ${formatInt(assertRoundedLegal(update.max, 'z'))} }`;
    return buildBlockEndInsertion(block, `z = ${zValue}`, text, 'Position');
}

/**
 * Inserts a field before a block's closing brace, preserving the source
 * layout: multi-line blocks get an indented line of their own, single-line
 * blocks get the field inline with surrounding spaces.
 */
function buildBlockEndInsertion(
    block: OffsetSpan,
    fieldText: string,
    text: string,
    blockLabel: string,
): StaticGalaxyReplacement {
    const closeOffset = block.end - 1;
    if (text.slice(closeOffset, block.end) !== '}') {
        throw new StaticGalaxyEditError('token-mismatch', `${blockLabel} closing brace no longer matches the parsed source`);
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const closeLineStart = lineStartAt(text, closeOffset);
    const closeLinePrefix = text.slice(closeLineStart, closeOffset);
    if (/^[\t ]*$/.test(closeLinePrefix)) {
        return {
            span: { start: closeLineStart, end: closeLineStart },
            text: `${closeLinePrefix}    ${fieldText}${eol}`,
        };
    }
    const leadingSpace = /\s/.test(text.charAt(closeOffset - 1)) ? '' : ' ';
    return { span: { start: closeOffset, end: closeOffset }, text: `${leadingSpace}${fieldText} ` };
}

function axisUpdateReplacements(
    node: ParsedPositionNode,
    axis: ParsedAxis | undefined,
    update: NonNullable<StaticGalaxyPositionUpdate['x']>,
    label: 'x' | 'y' | 'z',
    text: string,
): StaticGalaxyReplacement[] {
    if (!axis || !axis.spans) {
        throw new StaticGalaxyEditError('not-editable', `${positionNodeLabel(node)} ${label} axis is not editable`);
    }

    if (update.kind === 'fixed') {
        // Precise input writes raw values verbatim (rounded to legal ints).
        if (axis.kind !== 'fixed') {
            throw new StaticGalaxyEditError('invalid-value', `${positionNodeLabel(node)} ${label} is a range axis, not fixed`);
        }
        const next = Math.round(update.value);
        assertLegalValue(next, label);
        assertTokenMatches(axis.spans.value!, axis.value!, text, node, label);
        if (next === axis.value) return [];
        return [{ span: axis.spans.value!, text: formatInt(next) }];
    }

    if (axis.kind !== 'range') {
        throw new StaticGalaxyEditError('invalid-value', `${positionNodeLabel(node)} ${label} is a fixed axis, not a range`);
    }
    const nextMin = Math.round(update.min);
    const nextMax = Math.round(update.max);
    assertLegalValue(nextMin, label);
    assertLegalValue(nextMax, label);
    assertTokenMatches(axis.spans.min!, axis.min!, text, node, label);
    assertTokenMatches(axis.spans.max!, axis.max!, text, node, label);
    const replacements: StaticGalaxyReplacement[] = [];
    if (nextMin !== axis.min) replacements.push({ span: axis.spans.min!, text: formatInt(nextMin) });
    if (nextMax !== axis.max) replacements.push({ span: axis.spans.max!, text: formatInt(nextMax) });
    return replacements;
}

// ─── Nebula radius ──────────────────────────────────────────────────────────

/**
 * Radius is a float and is never transformed, so this path is independent of
 * the nebula's position editability. A literal radius token is replaced in
 * place; a missing radius is inserted at the end of the nebula block.
 */
function buildNebulaRadiusEdit(nodeKey: string, radius: number, context: StaticGalaxyEditContext): StaticGalaxyBuiltEdit {
    if (!Number.isFinite(radius) || radius < 0 || radius > STATIC_GALAXY_MAX_COORDINATE) {
        throw new StaticGalaxyEditError('invalid-value', `Invalid nebula radius: ${radius}`);
    }
    const nebula = findNebulaNode(nodeKey, context.scenarios);
    if (!nebula.radiusWritable) {
        throw new StaticGalaxyEditError('not-editable', `Nebula ${nebula.name || nodeKey} radius is not a literal number`);
    }

    if (nebula.radiusSpan && nebula.radius !== null) {
        const current = parseFloat(context.text.slice(nebula.radiusSpan.start, nebula.radiusSpan.end));
        if (!Number.isFinite(current) || current !== nebula.radius) {
            throw new StaticGalaxyEditError('token-mismatch', 'Source no longer matches the parsed nebula radius');
        }
        const next = formatRadius(radius);
        if (next === context.text.slice(nebula.radiusSpan.start, nebula.radiusSpan.end)) {
            return finalize([], `Nebula ${nebula.name || nodeKey} radius unchanged`);
        }
        return finalize([{ span: nebula.radiusSpan, text: next }], `Nebula ${nebula.name || nodeKey} radius -> ${next}`);
    }

    if (!nebula.blockSpan) {
        throw new StaticGalaxyEditError('not-editable', `Nebula ${nebula.name || nodeKey} has no block for radius insertion`);
    }
    const insertion = buildBlockEndInsertion(nebula.blockSpan, `radius = ${formatRadius(radius)}`, context.text, 'Nebula');
    return finalize([insertion], `Nebula ${nebula.name || nodeKey} radius -> ${formatRadius(radius)}`);
}

function findNebulaNode(nodeKey: string, scenarios: ParsedScenario[]): ParsedNebula {
    for (const scenario of scenarios) {
        const nebula = scenario.nebulas.find(n => n.nodeKey === nodeKey);
        if (nebula) return nebula;
    }
    throw new StaticGalaxyEditError('unknown-node', `Unknown nebula: ${nodeKey}`);
}

/** Radius is a float: keep up to 3 decimals without float artifacts. */
function formatRadius(value: number): string {
    return String(Number(value.toFixed(3)));
}

// ─── Explicit hyperlanes ────────────────────────────────────────────────────

function buildHyperlaneEdit(
    update: StaticGalaxyHyperlaneUpdate,
    context: StaticGalaxyEditContext,
): StaticGalaxyBuiltEdit {
    const from = findSystemWithScenario(update.fromNodeKey, context.scenarios);
    const to = findSystemWithScenario(update.toNodeKey, context.scenarios);
    if (from.scenario !== to.scenario) {
        throw new StaticGalaxyEditError('invalid-value', 'Hyperlane endpoints must belong to the same scenario');
    }
    if (from.system === to.system) {
        throw new StaticGalaxyEditError('invalid-value', 'A system cannot have a hyperlane to itself');
    }
    assertUniqueSystemId(from.system, from.scenario);
    assertUniqueSystemId(to.system, to.scenario);

    const desiredKey = update.connected ? 'add_hyperlane' : 'remove_hyperlane';
    const matching = from.scenario.hyperlanes.filter(lane => unorderedPairMatches(
        lane.fromId,
        lane.toId,
        from.system.id,
        to.system.id,
    ));
    if (matching.length > 0) {
        const replacements: StaticGalaxyReplacement[] = [];
        for (const lane of matching) {
            const currentKey = `${lane.kind}_hyperlane`;
            if (currentKey === desiredKey) continue;
            if (context.text.slice(lane.keySpan.start, lane.keySpan.end) !== currentKey) {
                throw new StaticGalaxyEditError('token-mismatch', `Source no longer matches ${currentKey}`);
            }
            replacements.push({ span: lane.keySpan, text: desiredKey });
        }
        const verb = update.connected ? 'Connect' : 'Disconnect';
        return finalize(replacements, `${verb} ${from.system.id} ↔ ${to.system.id}`);
    }

    const insertion = buildHyperlaneInsertion(
        from.scenario,
        [`${desiredKey} = { from = ${formatPdxScalar(from.system.id)} to = ${formatPdxScalar(to.system.id)} }`],
        context.text,
    );
    const verb = update.connected ? 'Connect' : 'Disconnect';
    return finalize([insertion], `${verb} ${from.system.id} ↔ ${to.system.id}`);
}

/**
 * Confirms a chained lane drawing: every pair either renames a conflicting
 * declaration to add_hyperlane or gets one new declaration. All new
 * declarations for a scenario merge into a single anchored insertion, and the
 * whole chain lands as one WorkspaceEdit (one undo step).
 */
function buildAddLanesEdit(
    links: Array<{ fromNodeKey: string; toNodeKey: string }>,
    context: StaticGalaxyEditContext,
): StaticGalaxyBuiltEdit {
    if (links.length === 0) {
        throw new StaticGalaxyEditError('invalid-value', 'Add request contains no links');
    }
    const replacements: StaticGalaxyReplacement[] = [];
    const insertionsByScenario = new Map<ParsedScenario, string[]>();
    const seenPairs = new Set<string>();

    for (const link of links) {
        const from = findSystemWithScenario(link.fromNodeKey, context.scenarios);
        const to = findSystemWithScenario(link.toNodeKey, context.scenarios);
        if (from.scenario !== to.scenario) {
            throw new StaticGalaxyEditError('invalid-value', 'Hyperlane endpoints must belong to the same scenario');
        }
        if (from.system === to.system) {
            throw new StaticGalaxyEditError('invalid-value', 'A system cannot have a hyperlane to itself');
        }
        assertUniqueSystemId(from.system, from.scenario);
        assertUniqueSystemId(to.system, to.scenario);

        const pairKey = [from.system.id, to.system.id].sort().join('|');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const matching = from.scenario.hyperlanes.filter(lane => unorderedPairMatches(
            lane.fromId,
            lane.toId,
            from.system.id,
            to.system.id,
        ));
        if (matching.length > 0) {
            for (const lane of matching) {
                const currentKey = `${lane.kind}_hyperlane`;
                if (currentKey === 'add_hyperlane') continue;
                if (context.text.slice(lane.keySpan.start, lane.keySpan.end) !== currentKey) {
                    throw new StaticGalaxyEditError('token-mismatch', `Source no longer matches ${currentKey}`);
                }
                replacements.push({ span: lane.keySpan, text: 'add_hyperlane' });
            }
            continue;
        }
        const declaration = `add_hyperlane = { from = ${formatPdxScalar(from.system.id)} to = ${formatPdxScalar(to.system.id)} }`;
        const list = insertionsByScenario.get(from.scenario) ?? [];
        list.push(declaration);
        insertionsByScenario.set(from.scenario, list);
    }

    for (const [scenario, declarations] of insertionsByScenario) {
        replacements.push(buildHyperlaneInsertion(scenario, declarations, context.text));
    }
    return finalize(replacements, `Connect ${seenPairs.size} lane(s)`);
}

function unorderedPairMatches(a: string, b: string, c: string, d: string): boolean {
    return (a === c && b === d) || (a === d && b === c);
}

/**
 * Deletes matching `add_hyperlane` declarations from source. Only add lanes
 * are deletable this way — `remove_hyperlane`/`prevent_hyperlane` carry their
 * own meaning and are never removed by this path. A declaration on its own
 * line removes the whole line; inline declarations remove just the block and
 * one adjacent gap, so comments and neighboring fields stay untouched.
 */
function buildDeleteLaneEdit(fromNodeKey: string, toNodeKey: string, context: StaticGalaxyEditContext): StaticGalaxyBuiltEdit {
    const from = findSystemWithScenario(fromNodeKey, context.scenarios);
    const to = findSystemWithScenario(toNodeKey, context.scenarios);
    if (from.scenario !== to.scenario) {
        throw new StaticGalaxyEditError('invalid-value', 'Hyperlane endpoints must belong to the same scenario');
    }
    if (from.system === to.system) {
        throw new StaticGalaxyEditError('invalid-value', 'A system cannot have a hyperlane to itself');
    }
    assertUniqueSystemId(from.system, from.scenario);
    assertUniqueSystemId(to.system, to.scenario);

    const matching = from.scenario.hyperlanes.filter(lane => lane.kind === 'add' && unorderedPairMatches(
        lane.fromId,
        lane.toId,
        from.system.id,
        to.system.id,
    ));
    if (matching.length === 0) {
        throw new StaticGalaxyEditError('invalid-value', `No add_hyperlane declaration connects ${from.system.id} and ${to.system.id}`);
    }

    const replacements: StaticGalaxyReplacement[] = [];
    for (const lane of matching) {
        if (!lane.blockSpan) {
            throw new StaticGalaxyEditError('not-editable', 'Hyperlane declaration has no endpoint block to delete');
        }
        if (lane.rawText !== undefined && context.text.slice(lane.keySpan.start, lane.blockSpan.end) !== lane.rawText) {
            throw new StaticGalaxyEditError('token-mismatch', 'Hyperlane declaration no longer matches the parsed source');
        }
        if (context.text.slice(lane.keySpan.start, lane.keySpan.end) !== 'add_hyperlane') {
            throw new StaticGalaxyEditError('token-mismatch', 'Source no longer matches add_hyperlane');
        }
        replacements.push({ span: laneDeletionSpan(lane, context.text), text: '' });
    }
    return finalize(replacements, `Delete lane ${from.system.id} ↔ ${to.system.id}`);
}

/** Whole line when the declaration owns it; otherwise the declaration plus one adjacent gap. */
function laneDeletionSpan(lane: ParsedHyperlane, text: string): OffsetSpan {
    const keyStart = lane.keySpan.start;
    const blockEnd = lane.blockSpan!.end;
    const lineStart = lineStartAt(text, keyStart);
    const nextNewline = text.indexOf('\n', blockEnd);
    const contentEnd = nextNewline < 0 ? text.length : nextNewline;
    const lineEnd = nextNewline < 0 ? text.length : nextNewline + 1;

    const prefix = text.slice(lineStart, keyStart);
    const suffix = text.slice(blockEnd, contentEnd);
    // suffix may hold a lone '\r' from CRLF line endings — treat it as blank.
    if (/^\s*$/.test(prefix) && /^\s*$/.test(suffix)) {
        return { start: lineStart, end: lineEnd };
    }
    let start = keyStart;
    let end = blockEnd;
    const following = /^[\t ]+/.exec(text.slice(end, contentEnd));
    if (following) {
        end += following[0].length;
    } else {
        const preceding = /[\t ]+$/.exec(text.slice(lineStart, start));
        if (preceding) start -= preceding[0].length;
    }
    return { start, end };
}

function buildHyperlaneInsertion(
    scenario: ParsedScenario,
    declarations: string[],
    text: string,
): StaticGalaxyReplacement {
    if (!scenario.blockSpan || scenario.blockSpan.end <= scenario.blockSpan.start) {
        throw new StaticGalaxyEditError('not-editable', 'Scenario block is not editable');
    }
    const closeOffset = scenario.blockSpan.end - 1;
    if (text.slice(closeOffset, scenario.blockSpan.end) !== '}') {
        throw new StaticGalaxyEditError('token-mismatch', 'Scenario closing brace no longer matches the parsed source');
    }

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const scenarioIndent = lineIndentAt(text, scenario.keySpan.start);
    const childIndent = firstChildIndent(scenario, text) ?? `${scenarioIndent}    `;
    const body = declarations.map(d => `${childIndent}${d}${eol}`).join('');
    const closeLineStart = lineStartAt(text, closeOffset);
    const closeLinePrefix = text.slice(closeLineStart, closeOffset);

    if (/^[\t ]*$/.test(closeLinePrefix)) {
        return {
            span: { start: closeLineStart, end: closeLineStart },
            text: body,
        };
    }
    return {
        span: { start: closeOffset, end: closeOffset },
        text: `${eol}${body}${scenarioIndent}`,
    };
}

function firstChildIndent(scenario: ParsedScenario, text: string): string | undefined {
    const spans = [
        ...scenario.systems.map(node => node.keySpan),
        ...scenario.nebulas.map(node => node.keySpan),
        ...scenario.hyperlanes.map(node => node.keySpan),
    ].sort((a, b) => a.start - b.start);
    for (const span of spans) {
        const indent = lineIndentAt(text, span.start);
        if (lineStartAt(text, span.start) + indent.length === span.start) return indent;
    }
    return undefined;
}

function lineStartAt(text: string, offset: number): number {
    const previousNewline = text.lastIndexOf('\n', Math.max(0, offset - 1));
    return previousNewline < 0 ? 0 : previousNewline + 1;
}

function lineIndentAt(text: string, offset: number): string {
    const start = lineStartAt(text, offset);
    const match = /^[\t ]*/.exec(text.slice(start, offset));
    return match?.[0] ?? '';
}

function formatPdxScalar(value: string): string {
    if (/^-?\d+$/.test(value) || /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ─── Guards ─────────────────────────────────────────────────────────────────

function findPositionNode(nodeKey: string, scenarios: ParsedScenario[]): ParsedPositionNode {
    for (const scenario of scenarios) {
        const system = scenario.systems.find(s => s.nodeKey === nodeKey);
        if (system) return system;
        const nebula = scenario.nebulas.find(n => n.nodeKey === nodeKey);
        if (nebula) return nebula;
    }
    throw new StaticGalaxyEditError('unknown-node', `Unknown node: ${nodeKey}`);
}

function findSystemWithScenario(
    nodeKey: string,
    scenarios: ParsedScenario[],
): { system: ParsedSystem; scenario: ParsedScenario } {
    for (const scenario of scenarios) {
        const system = scenario.systems.find(s => s.nodeKey === nodeKey);
        if (system) return { system, scenario };
    }
    throw new StaticGalaxyEditError('unknown-node', `Unknown system: ${nodeKey}`);
}

function assertUniqueSystemId(system: ParsedSystem, scenario: ParsedScenario): void {
    if (system.id === '') {
        throw new StaticGalaxyEditError('not-editable', `System ${system.nodeKey} has no id`);
    }
    if (scenario.systems.filter(candidate => candidate.id === system.id).length !== 1) {
        throw new StaticGalaxyEditError('not-editable', `System id ${system.id} is not unique`);
    }
}

function assertEditable(node: ParsedPositionNode): void {
    if (!node.editable) {
        throw new StaticGalaxyEditError(
            'not-editable',
            `${positionNodeLabel(node)} is not editable: ${node.editBlockedReason ?? 'unknown reason'}`,
        );
    }
}

function positionNodeLabel(node: ParsedPositionNode): string {
    return 'id' in node ? `System ${node.id || node.nodeKey}` : `Nebula ${node.name || node.nodeKey}`;
}

function assertFiniteCoordinate(value: number, label: string): void {
    if (!Number.isFinite(value)) {
        throw new StaticGalaxyEditError('invalid-value', `Invalid ${label} coordinate: ${value}`);
    }
}

function assertLegalValue(value: number, label: string): void {
    if (!Number.isFinite(value) || Math.abs(value) > STATIC_GALAXY_MAX_COORDINATE) {
        throw new StaticGalaxyEditError('invalid-value', `Invalid ${label} value: ${value}`);
    }
}

function assertRoundedLegal(value: number, label: string): number {
    const rounded = Math.round(value);
    assertLegalValue(rounded, label);
    return rounded;
}

function invertAxis(transform: AxisTransform, effective: number): number {
    if (!transform.invertible || transform.mul === 0) {
        throw new StaticGalaxyEditError('not-editable', 'coordinate_transform is not invertible');
    }
    return (effective - transform.add) / transform.mul;
}

/** Guards against stale spans: the span must still hold the parsed number. */
function assertTokenMatches(span: OffsetSpan, expected: number, text: string, node: ParsedPositionNode, label: string): void {
    const current = parseFloat(text.slice(span.start, span.end));
    if (!Number.isFinite(current) || current !== expected) {
        throw new StaticGalaxyEditError(
            'token-mismatch',
            `Source no longer matches the parsed ${label} coordinate of ${positionNodeLabel(node)}`,
        );
    }
}

function formatInt(value: number): string {
    return String(Math.round(value));
}

function finalize(replacements: StaticGalaxyReplacement[], summary: string): StaticGalaxyBuiltEdit {
    // Deterministic order: back to front by start offset, and no overlaps.
    const sorted = [...replacements].sort((a, b) => b.span.start - a.span.start);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.span.end > sorted[i - 1]!.span.start) {
            throw new StaticGalaxyEditError('invalid-value', 'Edit ranges overlap');
        }
    }
    // Empty result is a valid no-op (e.g. a drag that ended where it started).
    return { replacements: sorted, summary };
}
