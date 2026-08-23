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

export type TypedPdxOperation =
    | { operation: 'clone_definition'; source: string; newSymbol: string }
    | { operation: 'add_event_call'; target: string; callType: string; eventId: string; containerPath?: string[]; days?: number }
    | { operation: 'add_event_option'; target: string; name: string; fields?: PdxEntry[] }
    | { operation: 'append_trigger_condition'; target: string; condition: PdxEntry; containerPath?: string[] }
    | { operation: 'instantiate_inline_script'; target: string; script: string; arguments?: PdxEntry[]; containerPath?: string[] };

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
            if (typeof record.value !== 'string' || record.value.length > MAX_TEXT) fail('invalid string value');
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
        case 'list': return value.values.map(item => renderValue(item, indent, newline, depth + 1)).join(' ');
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
        if (text[i] !== '{') { while (i < end && text[i] !== '\n') i++; continue; }
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

function findUnique(blocks: readonly BlockSpan[], symbol: string, label: string): BlockSpan {
    assertIdentifier(symbol, label);
    const matches = blocks.filter(block => block.symbol === symbol || block.key === symbol);
    if (matches.length === 0) fail(`${label} not found: ${symbol}`);
    if (matches.length > 1) fail(`${label} is not unique: ${symbol}`);
    return matches[0]!;
}

function findContainer(root: BlockSpan, path: readonly string[] | undefined): BlockSpan {
    let current = root;
    for (const segment of path ?? []) current = findUnique(current.children, segment, 'container');
    return current;
}

function appendEntry(text: string, block: BlockSpan, entry: PdxEntry, newline: string): string {
    validateEntries([entry]);
    const indent = block.indent + '\t';
    const rendered = `${indent}${entry.key} = ${renderValue(entry.value, indent, newline)}`;
    const beforeClose = text.slice(0, block.close);
    const needsLeadingNewline = !beforeClose.endsWith('\n') && !beforeClose.endsWith('\r');
    return beforeClose + (needsLeadingNewline ? newline : '') + rendered + newline + block.indent + text.slice(block.close);
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
        assertOnlyKeys(operation as unknown as Record<string, unknown>, ['operation', 'source', 'newSymbol'], 'clone_definition');
        target = findUnique(blocks, operation.source, 'source');
        assertIdentifier(operation.newSymbol, 'newSymbol');
        if (blocks.some(block => block.symbol === operation.newSymbol || block.key === operation.newSymbol)) fail(`duplicate target: ${operation.newSymbol}`);
        const sourceText = text.slice(target.start, target.end);
        const sourceNameLength = readIdentifier(sourceText, 0)?.value.length ?? 0;
        let clone: string;
        if (target.symbol !== target.key) {
            const escaped = operation.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const idPattern = new RegExp(`(\\bid\\s*=\\s*(?:"))${escaped}(")|(\\bid\\s*=\\s*)${escaped}(?=\\s|#|$)`);
            clone = sourceText.replace(idPattern, (_match, quotedPrefix: string | undefined, quotedSuffix: string | undefined, plainPrefix: string | undefined) =>
                quotedPrefix ? `${quotedPrefix}${operation.newSymbol}${quotedSuffix}` : `${plainPrefix}${operation.newSymbol}`);
            if (clone === sourceText) fail(`could not rewrite id field for ${operation.source}`);
        } else {
            clone = operation.newSymbol + sourceText.slice(sourceNameLength);
        }
        const separator = text.slice(0, target.end).endsWith(newline) ? '' : newline;
        content = text.slice(0, target.end) + separator + clone + text.slice(target.end);
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
        } else {
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
