import { expect } from 'chai';
import { extractArchetypeSlots, instantiateArchetypeSlots } from '../../extension/ai/tools/archetypeSlots';

function expectFailure(operation: () => unknown, pattern: RegExp): void {
    try {
        operation();
        expect.fail('Expected archetype slot operation to fail.');
    } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).to.match(pattern);
    }
}

describe('archetype slots', () => {
    const text = [
        'country_event = {',
        '  id = $ID$',
        '  title = "$TITLE$" # preserve this comment',
        '  count = $COUNT$',
        '  enabled = $ENABLED$',
        '  repeated = $ID$',
        '  literal = "prefix_$ID$"',
        '}',
        '',
    ].join('\n');
    const placeholders = {
        '$ID$': 'identifier' as const,
        '$TITLE$': 'string' as const,
        '$COUNT$': 'number' as const,
        '$ENABLED$': 'boolean' as const,
        '$OPTIONAL$': { type: 'identifier' as const, required: false },
    };

    it('extracts deterministic scalar contracts and immutable hash', () => {
        const extracted = extractArchetypeSlots(text, placeholders);
        expect(extracted.text).to.equal(text);
        expect(extracted.contract.immutableHash).to.match(/^[a-f0-9]{64}$/);
        expect(extracted.contract.slots).to.deep.equal([
            { name: '$COUNT$', required: true, type: 'number', occurrences: 1 },
            { name: '$ENABLED$', required: true, type: 'boolean', occurrences: 1 },
            { name: '$ID$', required: true, type: 'identifier', occurrences: 2 },
            { name: '$OPTIONAL$', required: false, type: 'identifier', occurrences: 0 },
            { name: '$TITLE$', required: true, type: 'string', occurrences: 1 },
        ]);
        expect(extractArchetypeSlots(text, placeholders).contract.immutableHash).to.equal(extracted.contract.immutableHash);
    });

    it('fills typed values structurally while preserving all other bytes', () => {
        const extracted = extractArchetypeSlots(text, placeholders);
        const result = instantiateArchetypeSlots(extracted, {
            '$ID$': { kind: 'identifier', value: 'example.42' },
            '$TITLE$': { kind: 'string', value: 'A "quoted" title' },
            '$COUNT$': { kind: 'number', value: 3.5 },
            '$ENABLED$': { kind: 'boolean', value: false },
        });
        expect(result).to.equal([
            'country_event = {',
            '  id = example.42',
            String.raw`  title = "A \"quoted\" title" # preserve this comment`,
            '  count = 3.5',
            '  enabled = no',
            '  repeated = example.42',
            '  literal = "prefix_$ID$"',
            '}',
            '',
        ].join('\n'));
        expect(result).to.contain('# preserve this comment');
        expect(result).to.contain('literal = "prefix_$ID$"');
    });

    it('rejects immutable text and occurrence drift', () => {
        const extracted = extractArchetypeSlots(text, placeholders);
        expectFailure(() => instantiateArchetypeSlots({ ...extracted, text: extracted.text.replace('count =', 'amount =') }, {}), /hash drift/);
        expectFailure(() => instantiateArchetypeSlots({ ...extracted, text: extracted.text.replace('repeated = $ID$\n', '') }, {}), /(hash|occurrence) drift/);
    });

    it('rejects missing, mismatched, unknown, and raw values', () => {
        const extracted = extractArchetypeSlots(text, placeholders);
        expectFailure(() => instantiateArchetypeSlots(extracted, {}), /missing required/);
        const valid = {
            '$ID$': { kind: 'identifier' as const, value: 'example.42' },
            '$TITLE$': { kind: 'string' as const, value: 'title' },
            '$COUNT$': { kind: 'number' as const, value: 1 },
            '$ENABLED$': { kind: 'boolean' as const, value: true },
        };
        expectFailure(() => instantiateArchetypeSlots(extracted, { ...valid,
            '$ID$': { kind: 'string', value: 'wrong' },
        } as never), /must have type identifier/);
        expectFailure(() => instantiateArchetypeSlots(extracted, { ...valid,
            '$ID$': { kind: 'raw', value: 'injected = yes' },
        } as never), /must have type identifier/);
        expectFailure(() => instantiateArchetypeSlots(extracted, { ...valid,
            '$UNKNOWN$': { kind: 'identifier', value: 'x' },
        } as never), /unknown slot/);
    });

    it('recognizes placeholders only as complete scalar values', () => {
        const source = '{ key = prefix_$SLOT$ quoted = "prefix_$SLOT$" # $SLOT$\n }';
        expectFailure(() => extractArchetypeSlots(source, { '$SLOT$': 'identifier' }), /required placeholder/);
        expectFailure(() => extractArchetypeSlots('{ key = "$SLOT$" }', { '$SLOT$': 'identifier' }), /must be unquoted/);
        expectFailure(() => extractArchetypeSlots('{ key = $SLOT$ }', { '$SLOT$': 'string' }), /must be quoted/);
    });

    it('enforces parser and collection bounds', () => {
        expectFailure(() => extractArchetypeSlots('{'.repeat(18) + '}'.repeat(18), { '$S$': { type: 'identifier', required: false } }), /nesting|expected scalar/);
        const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`$S${index}$`, 'identifier' as const]));
        expectFailure(() => extractArchetypeSlots('{}', tooMany), /1-64/);
        expectFailure(() => extractArchetypeSlots('x'.repeat(1_000_001), { '$S$': { type: 'identifier', required: false } }), /1000000/);
    });
});
