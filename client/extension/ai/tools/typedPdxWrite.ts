import { createHash } from 'crypto';

export type PdxValue =
    | { kind: 'identifier' | 'string'; value: string }
    | { kind: 'number'; value: number }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'list'; values: PdxValue[] }
    | { kind: 'block'; entries: PdxEntry[] };

export interface PdxEntry {
    key: string;
    value: PdxValue;
}

export interface PdxPathSegment {
    key: string;
    occurrence: number;
}

export type CloneDefinitionOverride =
    | { action: 'set'; path: PdxPathSegment[]; value: PdxValue }
    | { action: 'delete'; path: PdxPathSegment[] }
    | { action: 'append'; path: PdxPathSegment[]; entry: PdxEntry };

export type TypedPdxOperation =
    | { operation: 'clone_definition'; source: string; newSymbol: string; overrides?: CloneDefinitionOverride[] }
    | { operation: 'add_event_call'; target: string; callType: string; eventId: string; containerPath?: string[]; days?: number }
    | { operation: 'add_event_option'; target: string; name: string; fields?: PdxEntry[] }
    | { operation: 'append_trigger_condition'; target: string; condition: PdxEntry; containerPath?: string[] }
    | { operation: 'instantiate_inline_script'; target: string; script: string; arguments?: PdxEntry[]; containerPath?: string[] }
    | { operation: 'set_definition_field'; target: string; path: PdxPathSegment[]; value: PdxValue }
    | { operation: 'delete_definition_field'; target: string; path: PdxPathSegment[] }
    | { operation: 'add_definition_field'; target: string; path: PdxPathSegment[]; entry: PdxEntry }
    | { operation: 'add_scripted_effect_call'; target: string; script: string; arguments?: PdxEntry[]; containerPath?: string[] }
    | { operation: 'add_scripted_trigger_call'; target: string; script: string; arguments?: PdxEntry[]; containerPath?: string[] }
    | { operation: 'add_on_action_entry'; target: string; entry: PdxEntry }
    | { operation: 'bind_event_target'; target: string; eventTarget: string; containerPath?: string[] }
    | { operation: 'clear_event_target'; target: string; eventTarget: string; containerPath?: string[] }
    | { operation: 'add_variable_transition'; target: string; transition: 'set_variable' | 'change_variable' | 'multiply_variable' | 'divide_variable'; variable: string; value: PdxValue; containerPath?: string[] };

export interface BuildTypedPdxArgs {
    filePath: string;
    operation: TypedPdxOperation;
    expectedHash?: string;
}

export interface TypedPdxCandidate {
    beforeHash: string;
    contentHash: string;
    content: string;
    summary: string;
    targetRange: { start: number; end: number };
    operation: TypedPdxOperation;
    diff: { added: number; removed: number };
}

export type TypedPdxReadFile = (filePath: string) => string | Promise<string>;

const MAX_DEPTH = 8;
const MAX_NODES = 256;
const MAX_TEXT = 4096;
const MAX_FILE_CHARS = 2_000_000;
const MAX_OVERRIDES = 64;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.:@-]*$/;
const INLINE_SCRIPT = /^[A-Za-z0-9_.:@/-]+$/;

interface BlockSpan {
    key: string;
    symbol: string;
    start: number;
    open: number;
    close: number;
    end: number;
    indent: string;
    children: BlockSpan[];
}

function fail(message: string): never {
    throw new Error(`typedPdxWrite: ${message}`);
}

function assertIdentifier(value: string, label: string): void {
    if (!IDENTIFIER.test(value)) fail(`${label} must be a PDX identifier`);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const extra = Object.keys(record).filter(key => !allowed.includes(key));
    if (extra.length > 0) fail(`${label} contains unsupported field(s): ${extra.join(', ')}`);
}

function validateValue(value: unknown, depth = 0, state = { nodes: 0 }): asserts value is PdxValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PDX value must be an object');
    if (depth > MAX_DEPTH || ++state.nodes > MAX_NODES) fail('PDX value exceeds safety limits');
    const record = value as Record<string, unknown>;
    switch (record.kind) {
        case 'identifier':
            assertOnlyKeys(record, ['kind', 'value'], 'identifier value');
            if (typeof record.value !== 'string') fail('identifier value must be a string');
            assertIdentifier(record.value, 'identifier');
            return;
        case 'string':
            assertOnlyKeys(record, ['kind', 'value'], 'string value');
            if (typeof record.value !== 'string' || record.value.length > MAX_TEXT || [...record.value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail('invalid string value');
            return;
        case 'number':
            assertOnlyKeys(record, ['kind', 'value'], 'number value');
            if (typeof record.value !== 'number' || !Number.isFinite(record.value)) fail('invalid number value');
            return;
        case 'boolean':
            assertOnlyKeys(record, ['kind', 'value'], 'boolean value');
            if (typeof record.value !== 'boolean') fail('invalid boolean value');
            return;
        case 'list':
            assertOnlyKeys(record, ['kind', 'values'], 'list value');
            if (!Array.isArray(record.values)) fail('list values must be an array');
            for (const item of record.values) validateValue(item, depth + 1, state);
            return;
        case 'block':
            assertOnlyKeys(record, ['kind', 'entries'], 'block value');
            if (!Array.isArray(record.entries)) fail('block entries must be an array');
            validateEntries(record.entries, depth + 1, state);
            return;
        default:
            fail('unsupported PdxValue kind; raw code is forbidden');
    }
}

function validateEntries(entries: unknown[], depth = 0, state = { nodes: 0 }): asserts entries is PdxEntry[] {
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid PDX entry');
        const record = entry as Record<string, unknown>;
        assertOnlyKeys(record, ['key', 'value'], 'PDX entry');
        if (typeof record.key !== 'string') fail('PDX entry key must be a string');
        assertIdentifier(record.key, 'entry key');
        validateValue(record.value, depth, state);
    }
}

function quote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderValue(value: PdxValue, indent: string, newline: string, depth = 0): string {
    if (depth > MAX_DEPTH) fail('render depth exceeded');
    switch (value.kind) {
        case 'identifier': return value.value;
        case 'string': return quote(value.value);
        case 'number': return String(value.value);
        case 'boolean': return value.value ? 'yes' : 'no';
        case 'list': return `{ ${value.values.map(item => renderValue(item, indent, newline, depth + 1)).join(' ')} }`;
        case 'block': {
            if (value.entries.length === 0) return '{}';
            const childIndent = indent + '\t';
            return `{${newline}${value.entries.map(entry => `${childIndent}${entry.key} = ${renderValue(entry.value, childIndent, newline, depth + 1)}`).join(newline)}${newline}${indent}}`;
        }
    }
}

function skipTrivia(text: string, index: number): number {
    let i = index;
    while (i < text.length) {
        if (/\s/.test(text[i]!)) { i++; continue; }
        if (text[i] === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
        break;
    }
    return i;
}

function readIdentifier(text: string, index: number): { value: string; end: number } | undefined {
    const match = /^[A-Za-z_][A-Za-z0-9_.:@-]*/.exec(text.slice(index));
    return match ? { value: match[0], end: index + match[0].length } : undefined;
}

function findMatchingBrace(text: string, open: number): number {
    let depth = 0;
    let quoted = false;
    let comment = false;
    for (let i = open; i < text.length; i++) {
        const char = text[i]!;
        if (comment) { if (char === '\n') comment = false; continue; }
        if (quoted) { if (char === '\\') i++; else if (char === '"') quoted = false; continue; }
        if (char === '"') { quoted = true; continue; }
        if (char === '#') { comment = true; continue; }
        if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return i;
    }
    fail('unclosed PDX block');
}

function readQuoted(text: string, start: number, limit: number): string | undefined {
    let value = '';
    for (let i = start + 1; i < limit; i++) {
        const char = text[i]!;
        if (char === '\\') {
            const next = text[++i];
            if (next === undefined) return undefined;
            value += next;
        } else if (char === '"') {
            return value;
        } else {
            value += char;
        }
    }
    return undefined;
}

function immediateId(text: string, open: number, close: number): string | undefined {
    let depth = 0;
    let quoted = false;
    let comment = false;
    for (let i = open + 1; i < close; i++) {
        const char = text[i]!;
        if (comment) { if (char === '\n') comment = false; continue; }
        if (quoted) { if (char === '\\') i++; else if (char === '"') quoted = false; continue; }
        if (char === '"') { quoted = true; continue; }
        if (char === '#') { comment = true; continue; }
        if (char === '{') { depth++; continue; }
        if (char === '}') { depth--; continue; }
        if (depth !== 0) continue;
        const key = readIdentifier(text, i);
        if (!key) continue;
        i = skipTrivia(text, key.end);
        if (text[i] !== '=') continue;
        i = skipTrivia(text, i + 1);
        if (key.value !== 'id') continue;
        if (text[i] === '"') return readQuoted(text, i, close);
        return readIdentifier(text, i)?.value;
    }
    return undefined;
}

function scanBlocks(text: string, start = 0, end = text.length, depth = 0, state = { nodes: 0 }): BlockSpan[] {
    if (depth > 64) fail('PDX block nesting exceeds scanner limit');
    const blocks: BlockSpan[] = [];
    let i = start;
    while (i < end) {
        i = skipTrivia(text, i);
        const key = readIdentifier(text, i);
        if (!key) { i++; continue; }
        const keyStart = i;
        i = skipTrivia(text, key.end);
        if (text[i] !== '=') { i = key.end; continue; }
        i = skipTrivia(text, i + 1);
        if (text[i] !== '{') {
            if (text[i] === '"') {
                i++;
                while (i < end) { if (text[i] === '\\') i += 2; else if (text[i++] === '"') break; }
            } else {
                while (i < end && !/\s|#|[{}]/.test(text[i]!)) i++;
            }
            continue;
        }
        const open = i;
        const close = findMatchingBrace(text, open);
        const lineStart = text.lastIndexOf('\n', keyStart - 1) + 1;
        const indent = /^[ \t]*/.exec(text.slice(lineStart, keyStart))?.[0] ?? '';
        const id = immediateId(text, open, close);
        if (++state.nodes > 20_000) fail('PDX block count exceeds scanner limit');
        blocks.push({
            key: key.value,
            symbol: id ?? key.value,
            start: keyStart,
            open,
            close,
            end: close + 1,
            indent,
            children: scanBlocks(text, open + 1, close, depth + 1, state),
        });
        i = close + 1;
    }
    return blocks;
}

interface EntrySpan {
    key: string;
    start: number;
    keyEnd: number;
    valueStart: number;
    valueEnd: number;
    end: number;
    block?: BlockSpan;
}

function scanEntries(text: string, block: BlockSpan): EntrySpan[] {
    const entries: EntrySpan[] = [];
    let i = block.open + 1;
    while (i < block.close) {
        i = skipTrivia(text, i);
        if (i >= block.close) break;
        const key = readIdentifier(text, i);
        if (!key) { i++; continue; }
        const start = i;
        i = skipTrivia(text, key.end);
        if (text[i] !== '=') { i = key.end; continue; }
        const valueStart = skipTrivia(text, i + 1);
        let valueEnd = valueStart;
        let child: BlockSpan | undefined;
        if (text[valueStart] === '{') {
            valueEnd = findMatchingBrace(text, valueStart) + 1;
            child = block.children.find(candidate => candidate.open === valueStart);
        } else if (text[valueStart] === '"') {
            valueEnd++;
            while (valueEnd < block.close) {
                if (text[valueEnd] === '\\') valueEnd += 2;
                else if (text[valueEnd++] === '"') break;
            }
        } else {
            while (valueEnd < block.close && !/\s|#|[{}]/.test(text[valueEnd]!)) valueEnd++;
        }
        entries.push({ key: key.value, start, keyEnd: key.end, valueStart, valueEnd, end: valueEnd, block: child });
        i = valueEnd;
    }
    return entries;
}

function validatePath(path: unknown, label: string): asserts path is PdxPathSegment[] {
    if (!Array.isArray(path)) fail(`${label} path must be an array`);
    if (path.length > MAX_DEPTH) fail(`${label} path exceeds safety limit`);
    for (const segment of path) {
        if (!segment || typeof segment !== 'object' || Array.isArray(segment)) fail(`${label} path segment must be an object`);
        const record = segment as Record<string, unknown>;
        assertOnlyKeys(record, ['key', 'occurrence'], `${label} path segment`);
        if (typeof record.key !== 'string') fail(`${label} path key must be a string`);
        assertIdentifier(record.key, `${label} path key`);
        if (!Number.isSafeInteger(record.occurrence) || (record.occurrence as number) < 1) fail(`${label} occurrence must be a positive integer`);
    }
}

function selectEntry(text: string, block: BlockSpan, segment: PdxPathSegment, label: string): EntrySpan {
    const matches = scanEntries(text, block).filter(entry => entry.key === segment.key);
    const selected = matches[segment.occurrence - 1];
    if (!selected) fail(`${label} not found: ${segment.key}[${segment.occurrence}]`);
    return selected;
}

function resolveOverridePath(text: string, root: BlockSpan, path: PdxPathSegment[], label: string): { parent: BlockSpan; entry: EntrySpan } {
    if (path.length === 0) fail(`${label} path must not be empty`);
    let parent = root;
    for (let index = 0; index < path.length - 1; index++) {
        const entry = selectEntry(text, parent, path[index]!, label);
        if (!entry.block) fail(`${label} path traverses a scalar: ${entry.key}`);
        parent = entry.block;
    }
    return { parent, entry: selectEntry(text, parent, path[path.length - 1]!, label) };
}

function indentationFor(text: string, block: BlockSpan): string {
    const first = scanEntries(text, block)[0];
    if (first) {
        const lineStart = text.lastIndexOf('\n', first.start - 1) + 1;
        const indent = /^[ \t]*/.exec(text.slice(lineStart, first.start))?.[0];
        if (indent !== undefined && indent.length > block.indent.length) return indent;
    }
    const unit = block.indent.endsWith('\t') || /(?:^|\n)\t+\S/.test(text) ? '\t'
        : (/ +$/.exec(block.indent)?.[0] ?? /^( +)\S/m.exec(text.slice(block.open + 1, block.close))?.[1] ?? '    ');
    return block.indent + unit;
}

function appendOverrideEntry(text: string, block: BlockSpan, entry: PdxEntry, newline: string): string {
    validateEntries([entry]);
    const indent = indentationFor(text, block);
    const rendered = `${indent}${entry.key} = ${renderValue(entry.value, indent, newline)}`;
    const closeLineStart = text.lastIndexOf('\n', block.close - 1) + 1;
    const closePrefix = text.slice(closeLineStart, block.close);
    if (/^[ \t]*$/.test(closePrefix)) {
        return text.slice(0, closeLineStart) + rendered + newline + closePrefix + text.slice(block.close);
    }
    let insertion = block.close;
    while (insertion > block.open + 1 && (text[insertion - 1] === ' ' || text[insertion - 1] === '\t')) insertion--;
    return text.slice(0, insertion) + newline + rendered + newline + block.indent + text.slice(block.close);
}

function validateOverride(value: unknown): asserts value is CloneDefinitionOverride {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('clone override must be an object');
    const record = value as Record<string, unknown>;
    if (record.action === 'set') {
        assertOnlyKeys(record, ['action', 'path', 'value'], 'set override');
        validatePath(record.path, 'set override');
        validateValue(record.value);
    } else if (record.action === 'delete') {
        assertOnlyKeys(record, ['action', 'path'], 'delete override');
        validatePath(record.path, 'delete override');
    } else if (record.action === 'append') {
        assertOnlyKeys(record, ['action', 'path', 'entry'], 'append override');
        validatePath(record.path, 'append override');
        validateEntries([record.entry]);
    } else {
        fail('unsupported clone override action; raw code is forbidden');
    }
}

function applyCloneOverride(text: string, root: BlockSpan, override: CloneDefinitionOverride, newline: string): string {
    validateOverride(override);
    if (override.action === 'append') {
        let container = root;
        for (const segment of override.path) {
            const selected = selectEntry(text, container, segment, 'append override');
            if (!selected.block) fail(`append override path traverses a scalar: ${selected.key}`);
            container = selected.block;
        }
        if (container === root && override.entry.key === 'id') fail('clone override cannot append top-level identity');
        return appendOverrideEntry(text, container, override.entry, newline);
    }
    const resolved = resolveOverridePath(text, root, override.path, `${override.action} override`);
    if (resolved.parent === root && resolved.entry.key === 'id') fail('clone override cannot modify top-level identity');
    if (override.action === 'set') {
        const linePrefix = text.slice(text.lastIndexOf('\n', resolved.entry.start - 1) + 1, resolved.entry.start);
        const indent = /^[ \t]*$/.test(linePrefix) ? linePrefix : resolved.parent.indent + (indentationFor(text, resolved.parent).slice(resolved.parent.indent.length) || '    ');
        const rendered = renderValue(override.value, indent, newline);
        return text.slice(0, resolved.entry.valueStart) + rendered + text.slice(resolved.entry.valueEnd);
    }
    let deleteStart = resolved.entry.start;
    let deleteEnd = resolved.entry.end;
    const lineStart = text.lastIndexOf('\n', deleteStart - 1) + 1;
    const lineEnd = text.indexOf('\n', deleteEnd);
    const trailing = text.slice(deleteEnd, lineEnd < 0 ? text.length : lineEnd).replace(/\r$/, '');
    if (/^[ \t]*$/.test(text.slice(lineStart, deleteStart)) && /^[ \t]*(?:#[^\r\n]*)?$/.test(trailing)) {
        deleteStart = lineStart;
        deleteEnd = lineEnd < 0 ? text.length : lineEnd + 1;
    }
    return text.slice(0, deleteStart) + text.slice(deleteEnd);
}

function findUnique(blocks: readonly BlockSpan[], symbol: string, label: string): BlockSpan {
    assertIdentifier(symbol, label);
    const matches = blocks.filter(block => block.symbol === symbol || block.key === symbol);
    if (matches.length === 0) fail(`${label} not found: ${symbol}`);
    if (matches.length > 1) fail(`${label} is not unique: ${symbol}`);
    return matches[0]!;
}

function findContainer(root: BlockSpan, path: readonly string[] | undefined): BlockSpan {
    if (path !== undefined && !Array.isArray(path)) fail('containerPath must be an array');
    if ((path?.length ?? 0) > MAX_DEPTH) fail('containerPath exceeds safety limit');
    let current = root;
    for (const segment of path ?? []) {
        if (typeof segment !== 'string') fail('containerPath segment must be a string');
        current = findUnique(current.children, segment, 'container');
    }
    return current;
}

function scriptedCallEntry(script: string, argumentsList: PdxEntry[]): PdxEntry {
    assertIdentifier(script, 'script');
    validateEntries(argumentsList);
    return { key: script, value: { kind: 'block', entries: argumentsList } };
}

function appendEntry(text: string, block: BlockSpan, entry: PdxEntry, newline: string): string {
    return appendOverrideEntry(text, block, entry, newline);
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function countChangedLines(before: string, after: string): { added: number; removed: number } {
    const beforeLines = before.split(/\r?\n/).length;
    const afterLines = after.split(/\r?\n/).length;
    return { added: Math.max(0, afterLines - beforeLines), removed: Math.max(0, beforeLines - afterLines) };
}

export async function buildTypedPdxCandidate(
    args: BuildTypedPdxArgs,
    readFile: TypedPdxReadFile,
): Promise<TypedPdxCandidate> {
    if (!args.filePath.toLowerCase().endsWith('.txt')) fail('only .txt files are supported');
    const text = await readFile(args.filePath);
    if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) fail('file is missing or oversized');
    const beforeHash = sha256(text);
    if (args.expectedHash !== undefined && args.expectedHash !== beforeHash) fail('expectedHash does not match current content');
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const blocks = scanBlocks(text);
    const operation = args.operation;
    let target: BlockSpan;
    let content: string;
    let summary: string;

    if (operation.operation === 'clone_definition') {
        assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'source', 'newSymbol', 'overrides'], 'clone_definition');
        target = findUnique(blocks, operation.source, 'source');
        assertIdentifier(operation.newSymbol, 'newSymbol');
        if (blocks.some(block => block.symbol === operation.newSymbol || block.key === operation.newSymbol)) fail(`duplicate target: ${operation.newSymbol}`);
        const overrides = operation.overrides ?? [];
        if (!Array.isArray(overrides)) fail('clone_definition overrides must be an array');
        if (overrides.length > MAX_OVERRIDES) fail(`clone_definition supports at most ${MAX_OVERRIDES} overrides`);
        for (const override of overrides) validateOverride(override);
        let clone = text.slice(target.start, target.end);
        let cloneRoot = scanBlocks(clone)[0];
        if (!cloneRoot) fail('could not scan cloned definition');
        if (target.symbol !== target.key && operation.source === target.symbol) {
            const identity = scanEntries(clone, cloneRoot).find(entry => entry.key === 'id');
            if (!identity) fail(`could not rewrite id field for ${operation.source}`);
            const current = clone.slice(identity.valueStart, identity.valueEnd);
            const expected = current.startsWith('"') ? quote(operation.source) : operation.source;
            if (current !== expected) fail(`could not rewrite id field for ${operation.source}`);
            const replacement = current.startsWith('"') ? quote(operation.newSymbol) : operation.newSymbol;
            clone = clone.slice(0, identity.valueStart) + replacement + clone.slice(identity.valueEnd);
        } else {
            const sourceName = readIdentifier(clone, 0);
            if (!sourceName || sourceName.value !== operation.source) fail('could not rewrite definition key');
            clone = operation.newSymbol + clone.slice(sourceName.end);
        }
        for (const override of overrides) {
            cloneRoot = scanBlocks(clone)[0];
            if (!cloneRoot) fail('could not rescan cloned definition');
            clone = applyCloneOverride(clone, cloneRoot, override, newline);
        }
        const tail = /^[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(text.slice(target.end))?.[0] ?? '';
        const insertion = target.end + tail.length;
        const separator = insertion > 0 && (text[insertion - 1] === '\n' || text[insertion - 1] === '\r') ? '' : newline;
        const suffix = text.slice(insertion);
        const trailingSeparator = suffix.length > 0 || text.endsWith(newline) ? newline : '';
        content = text.slice(0, insertion) + separator + clone + trailingSeparator + suffix;
        summary = `cloned ${operation.source} as ${operation.newSymbol}`;
    } else {
        target = findUnique(blocks, operation.target, 'target');
        if (operation.operation === 'add_event_call') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'callType', 'eventId', 'containerPath', 'days'], 'add_event_call');
            assertIdentifier(operation.callType, 'callType');
            assertIdentifier(operation.eventId, 'eventId');
            if (operation.days !== undefined && (!Number.isSafeInteger(operation.days) || operation.days < 0)) fail('days must be a non-negative integer');
            const entries: PdxEntry[] = [{ key: 'id', value: { kind: 'identifier', value: operation.eventId } }];
            if (operation.days !== undefined) entries.push({ key: 'days', value: { kind: 'number', value: operation.days } });
            content = appendEntry(text, findContainer(target, operation.containerPath), {
                key: operation.callType,
                value: { kind: 'block', entries },
            }, newline);
            summary = `added ${operation.callType} call to ${operation.eventId}`;
        } else if (operation.operation === 'add_event_option') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'name', 'fields'], 'add_event_option');
            assertIdentifier(operation.name, 'option name');
            const fields = operation.fields ?? [];
            validateEntries(fields);
            if (text.slice(target.open, target.close).includes(`name = ${operation.name}`)) fail(`duplicate option name: ${operation.name}`);
            content = appendEntry(text, target, {
                key: 'option',
                value: { kind: 'block', entries: [{ key: 'name', value: { kind: 'identifier', value: operation.name } }, ...fields] },
            }, newline);
            summary = `added option ${operation.name} to ${operation.target}`;
        } else if (operation.operation === 'append_trigger_condition') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'condition', 'containerPath'], 'append_trigger_condition');
            validateEntries([operation.condition]);
            const path = operation.containerPath ?? ['trigger'];
            content = appendEntry(text, findContainer(target, path), operation.condition, newline);
            summary = `appended trigger condition ${operation.condition.key}`;
        } else if (operation.operation === 'instantiate_inline_script') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'script', 'arguments', 'containerPath'], 'instantiate_inline_script');
            if (!INLINE_SCRIPT.test(operation.script)) fail('inline script must be a safe project-relative identifier');
            const argumentsList = operation.arguments ?? [];
            validateEntries(argumentsList);
            content = appendEntry(text, findContainer(target, operation.containerPath), {
                key: 'inline_script',
                value: { kind: 'block', entries: [
                    { key: 'script', value: { kind: 'string', value: operation.script } },
                    ...argumentsList,
                ] },
            }, newline);
            summary = `instantiated inline script ${operation.script}`;
        } else if (operation.operation === 'set_definition_field') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'path', 'value'], 'set_definition_field');
            validatePath(operation.path, 'set_definition_field');
            validateValue(operation.value);
            content = applyCloneOverride(text, target, { action: 'set', path: operation.path, value: operation.value }, newline);
            summary = `set field on ${operation.target}`;
        } else if (operation.operation === 'delete_definition_field') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'path'], 'delete_definition_field');
            validatePath(operation.path, 'delete_definition_field');
            content = applyCloneOverride(text, target, { action: 'delete', path: operation.path }, newline);
            summary = `deleted field from ${operation.target}`;
        } else if (operation.operation === 'add_definition_field') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'path', 'entry'], 'add_definition_field');
            validatePath(operation.path, 'add_definition_field');
            validateEntries([operation.entry]);
            content = applyCloneOverride(text, target, { action: 'append', path: operation.path, entry: operation.entry }, newline);
            summary = `added field ${operation.entry.key} to ${operation.target}`;
        } else if (operation.operation === 'add_scripted_effect_call' || operation.operation === 'add_scripted_trigger_call') {
            const label = operation.operation;
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'script', 'arguments', 'containerPath'], label);
            const argumentsList = operation.arguments ?? [];
            content = appendEntry(text, findContainer(target, operation.containerPath), scriptedCallEntry(operation.script, argumentsList), newline);
            summary = `added ${label === 'add_scripted_effect_call' ? 'scripted effect' : 'scripted trigger'} call ${operation.script}`;
        } else if (operation.operation === 'add_on_action_entry') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'entry'], 'add_on_action_entry');
            validateEntries([operation.entry]);
            if (operation.entry.key === 'id') fail('add_on_action_entry cannot append identity');
            content = appendEntry(text, target, operation.entry, newline);
            summary = `added on-action entry ${operation.entry.key}`;
        } else if (operation.operation === 'bind_event_target' || operation.operation === 'clear_event_target') {
            const label = operation.operation;
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'eventTarget', 'containerPath'], label);
            assertIdentifier(operation.eventTarget, 'eventTarget');
            content = appendEntry(text, findContainer(target, operation.containerPath), {
                key: label === 'bind_event_target' ? 'save_event_target_as' : 'clear_event_target',
                value: { kind: 'identifier', value: operation.eventTarget },
            }, newline);
            summary = `${label === 'bind_event_target' ? 'bound' : 'cleared'} event target ${operation.eventTarget}`;
        } else if (operation.operation === 'add_variable_transition') {
            assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'target', 'transition', 'variable', 'value', 'containerPath'], 'add_variable_transition');
            if (!['set_variable', 'change_variable', 'multiply_variable', 'divide_variable'].includes(operation.transition)) fail('unsupported variable transition');
            assertIdentifier(operation.variable, 'variable');
            validateValue(operation.value);
            content = appendEntry(text, findContainer(target, operation.containerPath), {
                key: operation.transition,
                value: { kind: 'block', entries: [
                    { key: 'which', value: { kind: 'identifier', value: operation.variable } },
                    { key: 'value', value: operation.value },
                ] },
            }, newline);
            summary = `added ${operation.transition} transition for ${operation.variable}`;
        } else {
            fail('unsupported typed PDX operation; raw code is forbidden');
        }
    }

    return {
        beforeHash,
        contentHash: sha256(content),
        content,
        summary,
        targetRange: { start: target.start, end: target.end },
        operation,
        diff: countChangedLines(text, content),
    };
}
