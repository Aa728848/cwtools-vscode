import { createHash } from 'crypto';
import type { PdxValue } from './typedPdxWrite';

export type ArchetypeSlotType = 'identifier' | 'string' | 'number' | 'boolean';
export type ArchetypePlaceholder = ArchetypeSlotType | { type: ArchetypeSlotType; required?: boolean };
export type ArchetypePlaceholders = Readonly<Record<string, ArchetypePlaceholder>>;
export type ArchetypeSlotValue = Extract<PdxValue, { kind: ArchetypeSlotType }>;

export interface ArchetypeSlotContract {
    name: string;
    required: boolean;
    type: ArchetypeSlotType;
    occurrences: number;
}

export interface ArchetypeContract {
    slots: ArchetypeSlotContract[];
    immutableHash: string;
}

export interface ExtractedArchetype {
    text: string;
    contract: ArchetypeContract;
}

const MAX_TEXT_CHARS = 1_000_000;
const MAX_SLOTS = 64;
const MAX_OCCURRENCES = 512;
const MAX_DEPTH = 16;
const MAX_TOKEN_CHARS = 4096;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.:@-]*$/;
const PLACEHOLDER = /^\$[A-Za-z_][A-Za-z0-9_]*\$$/;

type Occurrence = { name: string; start: number; end: number; quoted: boolean };

function fail(message: string): never {
    throw new Error(`archetypeSlots: ${message}`);
}

function normalizePlaceholders(input: ArchetypePlaceholders): Map<string, { type: ArchetypeSlotType; required: boolean }> {
    const keys = Object.keys(input).sort();
    if (keys.length === 0 || keys.length > MAX_SLOTS) fail(`placeholders must contain 1-${MAX_SLOTS} slots`);
    const result = new Map<string, { type: ArchetypeSlotType; required: boolean }>();
    for (const name of keys) {
        if (!PLACEHOLDER.test(name)) fail(`invalid placeholder ${name}`);
        const raw: unknown = input[name];
        const descriptor = typeof raw === 'string' ? { type: raw, required: true } : raw;
        if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) fail(`invalid descriptor for ${name}`);
        const record = descriptor as Record<string, unknown>;
        if (Object.keys(record).some(key => key !== 'type' && key !== 'required')) fail(`unsupported descriptor field for ${name}`);
        if (!['identifier', 'string', 'number', 'boolean'].includes(String(record.type))) fail(`invalid type for ${name}`);
        if (record.required !== undefined && typeof record.required !== 'boolean') fail(`required must be boolean for ${name}`);
        result.set(name, { type: record.type as ArchetypeSlotType, required: record.required !== false });
    }
    return result;
}

class Scanner {
    private index = 0;
    private readonly occurrences: Occurrence[] = [];

    constructor(private readonly text: string, private readonly slots: ReadonlyMap<string, { type: ArchetypeSlotType }>) {}

    scan(): Occurrence[] {
        this.skipTrivia();
        if (this.text[this.index] === '{') {
            this.index++;
            this.scanSequence('}', 1);
            this.skipTrivia();
            if (this.index !== this.text.length) fail('unexpected text after block');
        } else {
            this.scanSequence(undefined, 0);
        }
        return this.occurrences;
    }

    private scanSequence(stop: '}' | undefined, depth: number): void {
        if (depth > MAX_DEPTH) fail('block nesting exceeds safety limit');
        while (true) {
            this.skipTrivia();
            if (this.index >= this.text.length) {
                if (stop) fail('unterminated block');
                return;
            }
            if (this.text[this.index] === '}') {
                if (!stop) fail('unmatched closing brace');
                this.index++;
                return;
            }
            const start = this.index;
            this.readScalar(false);
            const afterFirst = this.index;
            this.skipTrivia();
            if (this.text[this.index] === '=') {
                this.index++;
                this.skipTrivia();
                this.readValue(depth);
            } else {
                this.index = afterFirst;
                if (this.index === start) fail(`invalid token at offset ${this.index}`);
            }
        }
    }

    private readValue(depth: number): void {
        if (this.text[this.index] === '{') {
            this.index++;
            this.scanSequence('}', depth + 1);
            return;
        }
        this.readScalar(true);
    }

    private readScalar(valuePosition: boolean): void {
        const start = this.index;
        if (this.text[this.index] === '"') {
            this.index++;
            const contentStart = this.index;
            let decoded = '';
            while (this.index < this.text.length && this.text[this.index] !== '"') {
                const char = this.text[this.index]!;
                if (char === '\n' || char === '\r') fail('newline in quoted scalar');
                if (char === '\\') {
                    this.index++;
                    if (this.index >= this.text.length) fail('unterminated escape');
                    decoded += this.text[this.index]!;
                    this.index++;
                } else {
                    decoded += char;
                    this.index++;
                }
                if (this.index - contentStart > MAX_TOKEN_CHARS) fail('scalar exceeds safety limit');
            }
            if (this.text[this.index] !== '"') fail('unterminated quoted scalar');
            const contentEnd = this.index;
            this.index++;
            if (valuePosition && this.slots.has(decoded)) this.addOccurrence(decoded, contentStart, contentEnd, true);
            return;
        }
        while (this.index < this.text.length && !/[\s{}=#]/.test(this.text[this.index]!)) this.index++;
        if (this.index === start) fail(`expected scalar at offset ${start}`);
        if (this.index - start > MAX_TOKEN_CHARS) fail('scalar exceeds safety limit');
        const token = this.text.slice(start, this.index);
        if (valuePosition && this.slots.has(token)) this.addOccurrence(token, start, this.index, false);
    }

    private addOccurrence(name: string, start: number, end: number, quoted: boolean): void {
        const descriptor = this.slots.get(name)!;
        if ((descriptor.type === 'string') !== quoted) fail(`placeholder ${name} must be ${descriptor.type === 'string' ? 'quoted' : 'unquoted'}`);
        if (this.occurrences.length >= MAX_OCCURRENCES) fail('slot occurrences exceed safety limit');
        this.occurrences.push({ name, start, end, quoted });
    }

    private skipTrivia(): void {
        while (this.index < this.text.length) {
            if (/\s/.test(this.text[this.index]!)) { this.index++; continue; }
            if (this.text[this.index] === '#') {
                while (this.index < this.text.length && this.text[this.index] !== '\n') this.index++;
                continue;
            }
            break;
        }
    }
}

function findOccurrences(text: string, slots: ReadonlyMap<string, { type: ArchetypeSlotType }>): Occurrence[] {
    if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) fail(`text must not exceed ${MAX_TEXT_CHARS} characters`);
    return new Scanner(text, slots).scan();
}

function immutableHash(text: string, occurrences: readonly Occurrence[], slots: ReadonlyMap<string, { type: ArchetypeSlotType; required: boolean }>): string {
    const hash = createHash('sha256');
    const frame = (value: string): void => { hash.update(String(Buffer.byteLength(value, 'utf8'))).update(':').update(value); };
    frame('cwtools.archetype-slots.v1');
    for (const [name, descriptor] of slots) {
        frame(name);
        frame(descriptor.type);
        frame(descriptor.required ? 'required' : 'optional');
        frame(String(occurrences.filter(occurrence => occurrence.name === name).length));
    }
    let offset = 0;
    for (const occurrence of occurrences) {
        frame(text.slice(offset, occurrence.start));
        frame(occurrence.name);
        offset = occurrence.end;
    }
    frame(text.slice(offset));
    return hash.digest('hex');
}

export function extractArchetypeSlots(text: string, placeholders: ArchetypePlaceholders): ExtractedArchetype {
    const slots = normalizePlaceholders(placeholders);
    const occurrences = findOccurrences(text, slots);
    const contractSlots: ArchetypeSlotContract[] = [];
    for (const [name, descriptor] of slots) {
        const count = occurrences.reduce((total, occurrence) => total + Number(occurrence.name === name), 0);
        if (descriptor.required && count === 0) fail(`required placeholder ${name} does not occur in the archetype`);
        contractSlots.push({ name, required: descriptor.required, type: descriptor.type, occurrences: count });
    }
    return { text, contract: { slots: contractSlots, immutableHash: immutableHash(text, occurrences, slots) } };
}

function renderSlot(value: unknown, slot: ArchetypeSlotContract, quoted: boolean): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`value for ${slot.name} must be a typed PdxValue`);
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== 'kind' && key !== 'value')) fail(`unsupported value field for ${slot.name}; raw is forbidden`);
    if (record.kind !== slot.type) fail(`value for ${slot.name} must have type ${slot.type}`);
    switch (slot.type) {
        case 'identifier':
            if (typeof record.value !== 'string' || !IDENTIFIER.test(record.value)) fail(`invalid identifier for ${slot.name}`);
            return record.value;
        case 'string':
            if (!quoted || typeof record.value !== 'string' || record.value.length > MAX_TOKEN_CHARS || [...record.value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail(`invalid string for ${slot.name}`);
            return JSON.stringify(record.value).slice(1, -1);
        case 'number':
            if (typeof record.value !== 'number' || !Number.isFinite(record.value)) fail(`invalid number for ${slot.name}`);
            return String(record.value);
        case 'boolean':
            if (typeof record.value !== 'boolean') fail(`invalid boolean for ${slot.name}`);
            return record.value ? 'yes' : 'no';
    }
}

export function instantiateArchetypeSlots(archetype: ExtractedArchetype, values: Readonly<Record<string, ArchetypeSlotValue>>): string {
    if (!archetype || typeof archetype !== 'object' || typeof archetype.text !== 'string' || !archetype.contract || !Array.isArray(archetype.contract.slots)) fail('invalid archetype');
    const descriptors: ArchetypePlaceholders = Object.fromEntries(archetype.contract.slots.map(slot => [slot.name, { type: slot.type, required: slot.required }]));
    const slots = normalizePlaceholders(descriptors);
    const occurrences = findOccurrences(archetype.text, slots);
    if (immutableHash(archetype.text, occurrences, slots) !== archetype.contract.immutableHash) fail('immutable hash drift detected');
    for (const slot of archetype.contract.slots) {
        const actual = occurrences.filter(occurrence => occurrence.name === slot.name).length;
        if (actual !== slot.occurrences) fail(`occurrence drift detected for ${slot.name}`);
        if (slot.required && values[slot.name] === undefined) fail(`missing required value for ${slot.name}`);
    }
    const allowed = new Set(archetype.contract.slots.map(slot => slot.name));
    const extra = Object.keys(values).filter(name => !allowed.has(name));
    if (extra.length) fail(`unknown slot value(s): ${extra.join(', ')}`);
    let result = '';
    let offset = 0;
    const byName = new Map(archetype.contract.slots.map(slot => [slot.name, slot]));
    for (const occurrence of occurrences) {
        result += archetype.text.slice(offset, occurrence.start);
        const value = values[occurrence.name];
        result += value === undefined ? archetype.text.slice(occurrence.start, occurrence.end) : renderSlot(value, byName.get(occurrence.name)!, occurrence.quoted);
        offset = occurrence.end;
    }
    return result + archetype.text.slice(offset);
}
