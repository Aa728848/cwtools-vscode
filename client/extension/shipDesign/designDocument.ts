/**
 * Ship Design Document Parser, Format-Preserving Editor, and Draft Session.
 *
 * Parses `common/global_ship_designs/*.txt` via `pdxTokenizer`, applies
 * span-targeted `ShipDesignOperation` edits without clobbering unrelated
 * comments or formatting, and manages undo/redo draft state.
 */

import { TokenType, tokenize, type Token } from '../pdxTokenizer';
import type {
    ShipDesignData,
    ShipDesignDiagnosticData,
    ShipDesignLoadoutSection,
    ShipDesignOperation,
    ShipDesignSectionData,
    ShipDesignSourceRangeData,
} from '../../shared/shipDesignProtocol';

interface ScalarNode {
    kind: 'scalar';
    key: string;
    value: string;
    quoted: boolean;
    valueToken: Token;
    source: ShipDesignSourceRangeData;
}

interface BlockNode {
    kind: 'block';
    key: string;
    open: Token;
    close: Token;
    bodyFirst: number;
    bodyLast: number;
    source: ShipDesignSourceRangeData;
}

type Node = ScalarNode | BlockNode;
type FieldMap = Map<string, Node[]>;

interface ParsedSection {
    data: ShipDesignSectionData;
    node: BlockNode;
    fields: FieldMap;
    components: Array<{ slot: string; node: BlockNode; fields: FieldMap }>;
}

interface ParsedDesign {
    data: ShipDesignData;
    node: BlockNode;
    fields: FieldMap;
    sections: ParsedSection[];
}

interface ParsedDocument {
    text: string;
    tokens: Token[];
    pairs: Map<number, number>;
    designs: ParsedDesign[];
    diagnostics: ShipDesignDiagnosticData[];
    syntaxErrors: ShipDesignDiagnosticData[];
}

export interface ShipDesignParseResult {
    designs: ShipDesignData[];
    diagnostics: ShipDesignDiagnosticData[];
    hasSyntaxErrors: boolean;
}

export interface ShipDesignTextEdit {
    start: number;
    end: number;
    newText: string;
}

export interface ShipDesignEditResult {
    text: string;
    edits: ShipDesignTextEdit[];
}

export class ShipDesignEditError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'ShipDesignEditError';
    }
}

const BOOLEAN_FIELDS = new Set([
    'hide_size',
    'creature_designer_template',
    'is_event_design',
    'use_design_name',
    'regenerates_when_disabled',
    'upgrade_ship_components',
    'auto_gen_design',
    'is_special_buildable',
]);

const EDITABLE_FIELDS = new Set([
    'name',
    'roles',
    'ship_size',
    'custom_trade_weight',
    'hide_size',
    'fleet_specialization_tag',
    'graphical_culture',
    'creature_designer_template',
    'newborn_ship_design',
    'is_event_design',
    'use_design_name',
    'regenerates_when_disabled',
    'upgrade_ship_components',
    'auto_gen_design',
    'country_type',
    'is_special_buildable',
    ...BOOLEAN_FIELDS,
]);

function normalize(value: string): string {
    return value.toLowerCase();
}

function range(start: Token, end: Token): ShipDesignSourceRangeData {
    return { start: start.startOffset, end: end.endOffset, startLine: start.line, endLine: end.line };
}

function fieldsOf(nodes: readonly Node[]): FieldMap {
    const fields: FieldMap = new Map();
    for (const node of nodes) {
        const key = normalize(node.key);
        const current = fields.get(key);
        if (current) current.push(node);
        else fields.set(key, [node]);
    }
    return fields;
}

function scalars(fields: FieldMap, key: string): ScalarNode[] {
    return (fields.get(normalize(key)) ?? []).filter((node): node is ScalarNode => node.kind === 'scalar');
}

function blocks(fields: FieldMap, key: string): BlockNode[] {
    return (fields.get(normalize(key)) ?? []).filter((node): node is BlockNode => node.kind === 'block');
}

function firstScalar(fields: FieldMap, key: string): ScalarNode | undefined {
    return scalars(fields, key)[0];
}

function bracePairs(tokens: readonly Token[], diagnostics: ShipDesignDiagnosticData[]): Map<number, number> {
    const pairs = new Map<number, number>();
    const stack: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!token) continue;
        if (token.type === TokenType.LBrace) stack.push(index);
        else if (token.type === TokenType.RBrace) {
            const open = stack.pop();
            if (open === undefined) {
                diagnostics.push({
                    severity: 'error',
                    code: 'unexpected-closing-brace',
                    message: 'Unexpected closing brace; visual write-back is disabled.',
                    source: range(token, token),
                });
            } else {
                pairs.set(open, index);
            }
        }
    }
    for (const open of stack) {
        const token = tokens[open];
        if (token) diagnostics.push({
            severity: 'error',
            code: 'unclosed-brace',
            message: 'Unclosed brace; visual write-back is disabled.',
            source: range(token, token),
        });
    }
    return pairs;
}

function readNodes(
    tokens: readonly Token[],
    from: number,
    to: number,
    pairs: ReadonlyMap<number, number>,
): Node[] {
    const nodes: Node[] = [];
    let index = Math.max(0, from);
    while (index < to) {
        const key = tokens[index];
        const equals = tokens[index + 1];
        const value = tokens[index + 2];
        if (!key || key.type === TokenType.EOF) break;
        if (!equals || !value || equals.type !== TokenType.Equals) {
            index++;
            continue;
        }
        if (value.type === TokenType.LBrace) {
            const closeIndex = pairs.get(index + 2);
            if (closeIndex === undefined || closeIndex >= to) break;
            const close = tokens[closeIndex];
            if (!close) break;
            nodes.push({
                kind: 'block',
                key: key.value,
                open: value,
                close,
                bodyFirst: index + 3,
                bodyLast: closeIndex,
                source: range(key, close),
            });
            index = closeIndex + 1;
            continue;
        }
        nodes.push({
            kind: 'scalar',
            key: key.value,
            value: value.value,
            quoted: value.type === TokenType.String,
            valueToken: value,
            source: range(key, value),
        });
        index += 3;
    }
    return nodes;
}

function directAnonymousBlockCount(
    tokens: readonly Token[],
    block: BlockNode,
    pairs: ReadonlyMap<number, number>,
): number {
    let count = 0;
    let index = block.bodyFirst;
    while (index < block.bodyLast) {
        const token = tokens[index];
        if (!token) break;
        if (token.type === TokenType.LBrace) {
            count++;
            const close = pairs.get(index);
            if (close === undefined) break;
            index = close + 1;
        } else {
            index++;
        }
    }
    return count;
}

function parseInternal(text: string): ParsedDocument {
    const tokens = tokenize(text);
    const diagnostics: ShipDesignDiagnosticData[] = [];
    const pairs = bracePairs(tokens, diagnostics);
    const roots = readNodes(tokens, 0, tokens.length - 1, pairs);
    const rootFields = fieldsOf(roots);
    const designs: ParsedDesign[] = [];

    for (const node of blocks(rootFields, 'ship_design')) {
        const occurrence = designs.length;
        const id = 'design:' + occurrence;
        const fields = fieldsOf(readNodes(tokens, node.bodyFirst, node.bodyLast, pairs));
        const name = firstScalar(fields, 'name')?.value ?? '';
        const growth = blocks(fields, 'growth_stages')[0];
        const growthStageCount = growth ? directAnonymousBlockCount(tokens, growth, pairs) : 0;
        const metadata: Record<string, string | boolean> = {};
        for (const key of EDITABLE_FIELDS) {
            const scalar = firstScalar(fields, key);
            if (!scalar) continue;
            metadata[key] = BOOLEAN_FIELDS.has(key)
                ? normalize(scalar.value) === 'yes'
                : scalar.value;
        }

        const data: ShipDesignData = {
            id,
            occurrence,
            name,
            shipSize: firstScalar(fields, 'ship_size')?.value,
            graphicalCulture: firstScalar(fields, 'graphical_culture')?.value,
            roles: firstScalar(fields, 'roles')?.value,
            sections: [],
            requiredComponents: scalars(fields, 'required_component').map(component => component.value),
            growthStageCount,
            loadoutReadOnlyReason: growth
                ? 'Growth-stage loadouts are read-only; shared metadata remains editable.'
                : undefined,
            metadata,
            source: node.source,
        };
        if (!name) diagnostics.push({
            severity: 'warning',
            code: 'missing-design-name',
            message: 'The ship_design block has no name field.',
            designId: id,
            source: node.source,
        });

        const parsedDesign: ParsedDesign = { data, node, fields, sections: [] };
        let sectionOccurrence = 0;
        for (const sectionNode of blocks(fields, 'section')) {
            const sectionId = id + '/section:' + sectionOccurrence;
            const sectionFields = fieldsOf(readNodes(tokens, sectionNode.bodyFirst, sectionNode.bodyLast, pairs));
            const sectionData: ShipDesignSectionData = {
                id: sectionId,
                designId: id,
                occurrence: sectionOccurrence,
                slot: firstScalar(sectionFields, 'slot')?.value ?? '',
                template: firstScalar(sectionFields, 'template')?.value ?? '',
                components: [],
                source: sectionNode.source,
            };
            const parsedSection: ParsedSection = {
                data: sectionData,
                node: sectionNode,
                fields: sectionFields,
                components: [],
            };
            let componentOccurrence = 0;
            for (const componentNode of blocks(sectionFields, 'component')) {
                const componentFields = fieldsOf(readNodes(tokens, componentNode.bodyFirst, componentNode.bodyLast, pairs));
                const slot = firstScalar(componentFields, 'slot')?.value ?? '';
                sectionData.components.push({
                    id: sectionId + '/component:' + componentOccurrence,
                    slot,
                    template: firstScalar(componentFields, 'template')?.value ?? '',
                    source: componentNode.source,
                });
                parsedSection.components.push({ slot, node: componentNode, fields: componentFields });
                componentOccurrence++;
            }
            parsedDesign.sections.push(parsedSection);
            data.sections.push(sectionData);
            sectionOccurrence++;
        }
        designs.push(parsedDesign);
    }

    return {
        text,
        tokens,
        pairs,
        designs,
        diagnostics,
        syntaxErrors: diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    };
}

export function parseShipDesignDocument(text: string): ShipDesignParseResult {
    const parsed = parseInternal(text);
    return {
        designs: parsed.designs.map(design => design.data),
        diagnostics: parsed.diagnostics,
        hasSyntaxErrors: parsed.syntaxErrors.length > 0,
    };
}

function findDesign(parsed: ParsedDocument, id: string): ParsedDesign {
    const design = parsed.designs.find(candidate => candidate.data.id === id);
    if (!design) throw new ShipDesignEditError('design-not-found', 'The selected design no longer exists. Reload the snapshot.');
    return design;
}

function findSection(parsed: ParsedDocument, id: string): { design: ParsedDesign; section: ParsedSection } {
    for (const design of parsed.designs) {
        const section = design.sections.find(candidate => candidate.data.id === id);
        if (section) return { design, section };
    }
    throw new ShipDesignEditError('section-not-found', 'The selected section no longer exists. Reload the snapshot.');
}

function assertWritable(parsed: ParsedDocument): void {
    if (parsed.syntaxErrors.length > 0) {
        throw new ShipDesignEditError('syntax-error', 'Fix the document braces before using visual write-back.');
    }
}

function assertLoadoutWritable(design: ParsedDesign): void {
    if (design.data.loadoutReadOnlyReason) {
        throw new ShipDesignEditError('growth-stage-read-only', design.data.loadoutReadOnlyReason);
    }
}

function eol(text: string): string {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

function quote(value: string): string {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function scalar(value: string | boolean, quoted = false): string {
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (!quoted && /^[@A-Za-z0-9_.:\/+%-]+$/.test(value)) return value;
    return quote(value);
}

function lineStart(text: string, offset: number): number {
    return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function indentationAt(text: string, offset: number): string {
    const start = lineStart(text, offset);
    const prefix = text.slice(start, offset);
    return /^[\t ]*$/.test(prefix) ? prefix : '';
}

function childIndent(text: string, block: BlockNode): string {
    const body = text.slice(block.open.endOffset, block.close.startOffset);
    const match = /(?:\r?\n)([\t ]+)\S/.exec(body);
    return match?.[1] ?? indentationAt(text, block.close.startOffset) + '\t';
}

function insertion(text: string, block: BlockNode, lines: readonly string[]): ShipDesignTextEdit {
    const newline = eol(text);
    const closeLineStart = lineStart(text, block.close.startOffset);
    const beforeClose = text.slice(closeLineStart, block.close.startOffset);
    const indent = childIndent(text, block);
    const body = lines.map(line => indent + line).join(newline) + newline;
    if (/^[\t ]*$/.test(beforeClose)) {
        return { start: closeLineStart, end: closeLineStart, newText: body };
    }
    const parentIndent = indentationAt(text, block.open.startOffset);
    return {
        start: block.close.startOffset,
        end: block.close.startOffset,
        newText: newline + body + parentIndent,
    };
}

function removal(text: string, node: Node): ShipDesignTextEdit {
    let start = node.source.start;
    let end = node.source.end;
    const startOfLine = lineStart(text, start);
    const nextNewline = text.indexOf('\n', end);
    const endOfLine = nextNewline < 0 ? text.length : nextNewline + 1;
    if (/^[\t ]*$/.test(text.slice(startOfLine, start))
        && /^[\t ]*(?:\r)?$/.test(text.slice(end, endOfLine))) {
        start = startOfLine;
        end = endOfLine;
    }
    return { start, end, newText: '' };
}

function uniqueScalar(fields: FieldMap, key: string): ScalarNode | undefined {
    const values = scalars(fields, key);
    if (values.length > 1) {
        throw new ShipDesignEditError('ambiguous-field', 'Multiple ' + key + ' fields exist; edit the source to disambiguate them.');
    }
    return values[0];
}

function setFieldEdits(
    text: string,
    block: BlockNode,
    fields: FieldMap,
    field: string,
    value: string | boolean | null,
): ShipDesignTextEdit[] {
    const existing = uniqueScalar(fields, field);
    if (value === null) return existing ? [removal(text, existing)] : [];
    if (existing) {
        return [{
            start: existing.valueToken.startOffset,
            end: existing.valueToken.endOffset,
            newText: scalar(value, existing.quoted),
        }];
    }
    return [insertion(text, block, [field + ' = ' + scalar(value, field === 'name')])];
}

function sectionLines(section: ShipDesignLoadoutSection): string[] {
    const lines = ['section = {', '\ttemplate = ' + quote(section.template), '\tslot = ' + quote(section.slot)];
    for (const component of section.components) {
        lines.push(
            '\tcomponent = {',
            '\t\tslot = ' + quote(component.slot),
            '\t\ttemplate = ' + quote(component.template),
            '\t}',
        );
    }
    lines.push('}');
    return lines;
}

function applyEdits(text: string, edits: readonly ShipDesignTextEdit[]): ShipDesignEditResult {
    const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
    let previousStart = text.length + 1;
    let result = text;
    for (const edit of ordered) {
        if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)
            || edit.start < 0 || edit.start > edit.end || edit.end > text.length || edit.end > previousStart) {
            throw new ShipDesignEditError('overlapping-edits', 'The requested operation produced overlapping source edits.');
        }
        result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
        previousStart = edit.start;
    }
    return { text: result, edits: ordered };
}

function appendBlock(text: string, block: string): ShipDesignEditResult {
    const newline = eol(text);
    let prefix = '';
    if (text.length > 0 && !text.endsWith('\n')) prefix = newline;
    if (text.trim().length > 0) prefix += newline;
    return applyEdits(text, [{ start: text.length, end: text.length, newText: prefix + block + newline }]);
}

function assertNewName(parsed: ParsedDocument, name: string): void {
    if (!name.trim()) throw new ShipDesignEditError('empty-name', 'A design name is required.');
    if (parsed.designs.some(design => normalize(design.data.name) === normalize(name))) {
        throw new ShipDesignEditError('duplicate-name', 'A design with this name already exists in the document.');
    }
}

export function applyShipDesignOperation(text: string, operation: ShipDesignOperation): ShipDesignEditResult {
    const parsed = parseInternal(text);
    assertWritable(parsed);
    switch (operation.kind) {
        case 'set-field': {
            if (!EDITABLE_FIELDS.has(operation.field)) {
                throw new ShipDesignEditError('field-not-editable', operation.field + ' is not editable in the ship design workbench.');
            }
            if (BOOLEAN_FIELDS.has(operation.field) && typeof operation.value !== 'boolean' && operation.value !== null) {
                throw new ShipDesignEditError('boolean-required', operation.field + ' requires a boolean value.');
            }
            const design = findDesign(parsed, operation.designId);
            return applyEdits(text, setFieldEdits(text, design.node, design.fields, operation.field, operation.value));
        }
        case 'set-section-template': {
            const { design, section } = findSection(parsed, operation.sectionId);
            assertLoadoutWritable(design);
            return applyEdits(text, setFieldEdits(text, section.node, section.fields, 'template', operation.template));
        }
        case 'set-component': {
            const { design, section } = findSection(parsed, operation.sectionId);
            assertLoadoutWritable(design);
            const matches = section.components.filter(component => normalize(component.slot) === normalize(operation.slot));
            if (matches.length > 1) {
                throw new ShipDesignEditError('ambiguous-slot', 'Multiple components use slot ' + operation.slot + '; edit the source to disambiguate them.');
            }
            const component = matches[0];
            if (operation.template === null) {
                return applyEdits(text, component ? [removal(text, component.node)] : []);
            }
            if (component) {
                return applyEdits(text, setFieldEdits(text, component.node, component.fields, 'template', operation.template));
            }
            return applyEdits(text, [insertion(text, section.node, [
                'component = {',
                '\tslot = ' + quote(operation.slot),
                '\ttemplate = ' + quote(operation.template),
                '}',
            ])]);
        }
        case 'add-section': {
            const design = findDesign(parsed, operation.designId);
            assertLoadoutWritable(design);
            return applyEdits(text, [insertion(text, design.node, sectionLines({
                slot: operation.slot,
                template: operation.template,
                components: [],
            }))]);
        }
        case 'remove-section': {
            const { design, section } = findSection(parsed, operation.sectionId);
            assertLoadoutWritable(design);
            return applyEdits(text, [removal(text, section.node)]);
        }
        case 'set-required-components': {
            const design = findDesign(parsed, operation.designId);
            assertLoadoutWritable(design);
            const edits = scalars(design.fields, 'required_component').map(node => removal(text, node));
            if (operation.components.length > 0) {
                edits.push(insertion(text, design.node, operation.components.map(component =>
                    'required_component = ' + quote(component))));
            }
            return applyEdits(text, edits);
        }
        case 'drop-component':
            throw new ShipDesignEditError('host-only-operation', 'Drop-component requires catalog validation in the Host panel.');
        case 'set-required-component':
            throw new ShipDesignEditError('host-only-operation', 'Set-required-component requires catalog validation in the Host panel.');
        case 'fill-empty-slots':
            throw new ShipDesignEditError('host-only-operation', 'Fill-empty-slots requires catalog validation in the Host panel.');
        case 'replace-loadout': {
            const design = findDesign(parsed, operation.designId);
            assertLoadoutWritable(design);
            const edits = [
                ...design.sections.map(section => removal(text, section.node)),
                ...scalars(design.fields, 'required_component').map(node => removal(text, node)),
                ...setFieldEdits(text, design.node, design.fields, 'auto_gen_design', operation.autoGenerated),
            ];
            const lines = operation.sections.flatMap(section => sectionLines(section));
            lines.push(...operation.requiredComponents.map(component => 'required_component = ' + quote(component)));
            if (lines.length > 0) edits.push(insertion(text, design.node, lines));
            return applyEdits(text, edits);
        }
        case 'create-design': {
            assertNewName(parsed, operation.name);
            const lines = [
                'ship_design = {',
                '\tname = ' + quote(operation.name),
                '\tship_size = ' + scalar(operation.shipSize),
            ];
            if (operation.graphicalCulture) lines.push('\tgraphical_culture = ' + scalar(operation.graphicalCulture));
            lines.push('}');
            return appendBlock(text, lines.join(eol(text)));
        }
        case 'duplicate-design': {
            assertNewName(parsed, operation.newName);
            const design = findDesign(parsed, operation.designId);
            const name = uniqueScalar(design.fields, 'name');
            if (!name) throw new ShipDesignEditError('missing-name', 'Cannot duplicate a design without a name field.');
            const original = text.slice(design.node.source.start, design.node.source.end);
            const relativeStart = name.valueToken.startOffset - design.node.source.start;
            const relativeEnd = name.valueToken.endOffset - design.node.source.start;
            const copy = original.slice(0, relativeStart) + quote(operation.newName) + original.slice(relativeEnd);
            return appendBlock(text, copy);
        }
        case 'delete-design': {
            const design = findDesign(parsed, operation.designId);
            return applyEdits(text, [removal(text, design.node)]);
        }
    }
}

interface ShipDesignDraftHistoryEntry {
    before: string;
    after: string;
}

/** Host-owned draft state. TextDocument writes are deliberately performed only by the panel's save path. */
export class ShipDesignDraftSession {
    private currentText: string;
    private checkpointText: string;
    private revision = 0;
    private conflict = false;
    private readonly undoStack: ShipDesignDraftHistoryEntry[] = [];
    private readonly redoStack: ShipDesignDraftHistoryEntry[] = [];

    constructor(text: string) {
        this.currentText = text;
        this.checkpointText = text;
    }

    get text(): string { return this.currentText; }
    get version(): number { return this.revision; }
    get dirty(): boolean { return this.currentText !== this.checkpointText; }
    get canUndo(): boolean { return this.undoStack.length > 0; }
    get canRedo(): boolean { return this.redoStack.length > 0; }
    get hasConflict(): boolean { return this.conflict; }

    assertEditable(): void {
        if (this.conflict) {
            throw new ShipDesignEditError('version-conflict', 'The source document changed outside the workbench. Discard the draft to adopt the external contents before editing again.');
        }
    }

    assertVersion(expectedVersion: number): void {
        this.assertEditable();
        if (expectedVersion !== this.revision) {
            throw new ShipDesignEditError('version-conflict', 'The draft changed. Review the refreshed snapshot before applying this operation.');
        }
    }

    apply(target: string): void {
        this.assertEditable();
        const before = this.currentText;
        if (before === target) return;
        this.undoStack.push({ before, after: target });
        if (this.undoStack.length > 100) this.undoStack.shift();
        this.redoStack.length = 0;
        this.currentText = target;
        this.revision++;
    }

    undo(): boolean {
        this.assertEditable();
        const entry = this.undoStack.pop();
        if (!entry) return false;
        this.redoStack.push(entry);
        this.currentText = entry.before;
        this.revision++;
        return true;
    }

    redo(): boolean {
        this.assertEditable();
        const entry = this.redoStack.pop();
        if (!entry) return false;
        this.undoStack.push(entry);
        this.currentText = entry.after;
        this.revision++;
        return true;
    }

    discard(externalText?: string): void {
        const target = externalText ?? this.checkpointText;
        this.currentText = target;
        this.checkpointText = target;
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.conflict = false;
        this.revision++;
    }

    markSaved(): void {
        this.checkpointText = this.currentText;
        this.conflict = false;
    }

    externalChange(text: string): boolean {
        if (text === this.currentText) {
            this.checkpointText = text;
            this.conflict = false;
            return true;
        }
        if (this.dirty) {
            this.conflict = true;
            return false;
        }
        this.currentText = text;
        this.checkpointText = text;
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.conflict = false;
        this.revision++;
        return true;
    }
}

