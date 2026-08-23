import { expect } from 'chai';
import { buildTypedPdxCandidate, type BuildTypedPdxArgs } from '../../extension/ai/tools/typedPdxWrite';

const read = (text: string) => async (_path: string) => text;

async function expectFailure(args: BuildTypedPdxArgs, source: string, pattern: RegExp): Promise<void> {
    try {
        await buildTypedPdxCandidate(args, read(source));
        expect.fail('Expected typed PDX candidate construction to fail.');
    } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).to.match(pattern);
    }
}

describe('typed PDX writer', () => {
    it('clones a unique top-level definition by event id', async () => {
        const source = 'country_event = {\n\tid = one.1\n}\n';
        const result = await buildTypedPdxCandidate({
            filePath: 'x.txt',
            operation: { operation: 'clone_definition', source: 'one.1', newSymbol: 'one.2' },
        }, read(source));
        expect(result.content).to.contain('country_event = {');
        expect(result.content).to.contain('id = one.2');
        expect(result.content).not.to.contain('one.2 = {');
        expect(result.beforeHash).to.have.length(64);
        expect(result.contentHash).to.have.length(64);
    });

    it('renders a typed event call inside an existing effect container', async () => {
        const source = 'country_event = {\n\tid = one.1\n\timmediate = {\n\t}\n}\n';
        const result = await buildTypedPdxCandidate({
            filePath: 'x.txt',
            operation: {
                operation: 'add_event_call',
                target: 'one.1',
                containerPath: ['immediate'],
                callType: 'country_event',
                eventId: 'one.2',
                days: 1,
            },
        }, read(source));
        expect(result.content).to.contain('country_event = {');
        expect(result.content).to.contain('id = one.2');
        expect(result.content).to.contain('days = 1');
    });

    it('adds typed options, trigger conditions, and inline scripts', async () => {
        const source = [
            'country_event = {',
            '\tid = one.1',
            '\ttrigger = {',
            '\t}',
            '\timmediate = {',
            '\t}',
            '}',
            '',
        ].join('\n');
        const option = await buildTypedPdxCandidate({
            filePath: 'x.txt',
            operation: { operation: 'add_event_option', target: 'one.1', name: 'one.1.a' },
        }, read(source));
        expect(option.content).to.contain('name = one.1.a');
        const condition = await buildTypedPdxCandidate({
            filePath: 'x.txt',
            operation: {
                operation: 'append_trigger_condition',
                target: 'one.1',
                condition: { key: 'has_country_flag', value: { kind: 'identifier', value: 'one_ready' } },
            },
        }, read(source));
        expect(condition.content).to.contain('has_country_flag = one_ready');
        const inline = await buildTypedPdxCandidate({
            filePath: 'x.txt',
            operation: {
                operation: 'instantiate_inline_script',
                target: 'one.1',
                containerPath: ['immediate'],
                script: 'my/scripts/example',
                arguments: [{ key: 'OWNER', value: { kind: 'identifier', value: 'root' } }],
            },
        }, read(source));
        expect(inline.content).to.contain('script = "my/scripts/example"');
        expect(inline.content).to.contain('OWNER = root');
    });

    it('applies ordered structured overrides with repeated occurrences exactly', async () => {
        const source = [
            'country_event = {',
            '    id = one.1 # identity',
            '    note = one.1',
            '    trigger = { flag = first flag = second nested = { value = old } }',
            '} # source tail',
            'other = { id = other.1 }',
            '',
        ].join('\n');
        const result = await buildTypedPdxCandidate({
            filePath: 'x.txt',
            operation: {
                operation: 'clone_definition', source: 'one.1', newSymbol: 'one.2',
                overrides: [
                    { action: 'set', path: [{ key: 'trigger', occurrence: 1 }, { key: 'flag', occurrence: 2 }], value: { kind: 'identifier', value: 'changed' } },
                    { action: 'delete', path: [{ key: 'trigger', occurrence: 1 }, { key: 'flag', occurrence: 1 }] },
                    { action: 'append', path: [{ key: 'trigger', occurrence: 1 }], entry: { key: 'items', value: { kind: 'list', values: [{ kind: 'identifier', value: 'a' }, { kind: 'identifier', value: 'b' }] } } },
                    { action: 'set', path: [{ key: 'trigger', occurrence: 1 }, { key: 'nested', occurrence: 1 }, { key: 'value', occurrence: 1 }], value: { kind: 'string', value: 'new' } },
                ],
            },
        }, read(source));
        expect(result.content).to.equal([
            'country_event = {',
            '    id = one.1 # identity',
            '    note = one.1',
            '    trigger = { flag = first flag = second nested = { value = old } }',
            '} # source tail',
            'country_event = {',
            '    id = one.2 # identity',
            '    note = one.1',
            '    trigger = {  flag = changed nested = { value = "new" }',
            '        items = { a b }',
            '    }',
            '}',
            'other = { id = other.1 }',
            '',
        ].join('\n'));
    });

    it('preserves CRLF and infers space indentation for append', async () => {
        const source = 'root = {\r\n  child = {\r\n  }\r\n}\r\n';
        const result = await buildTypedPdxCandidate({
            filePath: 'x.txt',
            operation: { operation: 'clone_definition', source: 'root', newSymbol: 'copy', overrides: [
                { action: 'append', path: [{ key: 'child', occurrence: 1 }], entry: { key: 'enabled', value: { kind: 'boolean', value: true } } },
            ] },
        }, read(source));
        expect(result.content).to.equal('root = {\r\n  child = {\r\n  }\r\n}\r\ncopy = {\r\n  child = {\r\n    enabled = yes\r\n  }\r\n}\r\n');
    });

    it('rewrites only the exact immediate id span in compact and commented definitions', async () => {
        const source = 'country_event={# id = wrong.1\n nested={id=one.1} id=one.1 note="id=one.1"} # tail\n';
        const result = await buildTypedPdxCandidate({ filePath: 'x.txt', operation: { operation: 'clone_definition', source: 'one.1', newSymbol: 'one.2' } }, read(source));
        expect(result.content).to.equal(source + 'country_event={# id = wrong.1\n nested={id=one.1} id=one.2 note="id=one.1"}\n');
    });

    it('scans a block after a scalar on the same line', async () => {
        const source = 'root = { id = one child = { value = old } }\n';
        const result = await buildTypedPdxCandidate({ filePath: 'x.txt', operation: { operation: 'clone_definition', source: 'root', newSymbol: 'copy', overrides: [
            { action: 'set', path: [{ key: 'child', occurrence: 1 }, { key: 'value', occurrence: 1 }], value: { kind: 'identifier', value: 'new' } },
        ] } }, read(source));
        expect(result.content).to.equal(source + 'copy = { id = one child = { value = new } }\n');
    });

    it('sets a compact scalar to a structured block without copying code as indentation', async () => {
        const source = 'root = { child = old }\n';
        const result = await buildTypedPdxCandidate({ filePath: 'x.txt', operation: {
            operation: 'clone_definition', source: 'root', newSymbol: 'copy', overrides: [{
                action: 'set',
                path: [{ key: 'child', occurrence: 1 }],
                value: { kind: 'block', entries: [{ key: 'enabled', value: { kind: 'boolean', value: true } }] },
            }],
        } }, read(source));
        expect(result.content).to.contain('copy = { child = {\n');
        expect(result.content).to.contain('enabled = yes');
        expect(result.content).not.to.contain('copy = { child = {\ncopy = {');
        expect(result.content).not.to.contain('root = {     enabled');
    });

    it('deletes a complete CRLF entry line without leaving whitespace-only trivia', async () => {
        const source = 'root = {\r\n  remove = yes\r\n  keep = yes\r\n}\r\n';
        const result = await buildTypedPdxCandidate({ filePath: 'x.txt', operation: {
            operation: 'clone_definition', source: 'root', newSymbol: 'copy', overrides: [{
                action: 'delete', path: [{ key: 'remove', occurrence: 1 }],
            }],
        } }, read(source));
        expect(result.content).to.equal(source + 'copy = {\r\n  keep = yes\r\n}\r\n');
    });

    it('rejects clone override arrays above the runtime safety limit', async () => {
        const overrides = Array.from({ length: 65 }, () => ({ action: 'delete' as const, path: [{ key: 'child', occurrence: 1 }] }));
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'clone_definition', source: 'root', newSymbol: 'copy', overrides } }, 'root = { child = yes }\n', /at most 64/);
    });

    it('strictly rejects unknown/raw override fields, identity changes, and control strings', async () => {
        const source = 'root = { id = one child = { value = old } }\n';
        const base = { operation: 'clone_definition' as const, source: 'root', newSymbol: 'copy' };
        await expectFailure({ filePath: 'x.txt', operation: { ...base, overrides: [{ action: 'set', path: [{ key: 'child', occurrence: 1 }], value: { kind: 'identifier', value: 'x' }, raw: 'x' } as never] } }, source, /unsupported field.*raw/);
        await expectFailure({ filePath: 'x.txt', operation: { ...base, overrides: [{ action: 'set', path: [{ key: 'child', occurrence: 1, unknown: true } as never], value: { kind: 'identifier', value: 'x' } }] } }, source, /unsupported field.*unknown/);
        await expectFailure({ filePath: 'x.txt', operation: { ...base, overrides: [{ action: 'delete', path: [{ key: 'id', occurrence: 1 }] }] } }, source, /identity/);
        await expectFailure({ filePath: 'x.txt', operation: { ...base, overrides: [{ action: 'set', path: [{ key: 'child', occurrence: 1 }, { key: 'value', occurrence: 1 }], value: { kind: 'string', value: 'bad\ntext' } }] } }, source, /invalid string/);
    });


    it('supports the second batch of structured operations', async () => {
        const definition = 'root = {\n  id = stable.1\n  old = yes\n  child = { existing = yes }\n  effects = {}\n  triggers = {}\n}\n';
        const cases: Array<{ operation: BuildTypedPdxArgs['operation']; expected: string }> = [
            { operation: { operation: 'set_definition_field', target: 'stable.1', path: [{ key: 'old', occurrence: 1 }], value: { kind: 'number', value: 2 } }, expected: 'old = 2' },
            { operation: { operation: 'delete_definition_field', target: 'stable.1', path: [{ key: 'old', occurrence: 1 }] }, expected: 'old = yes' },
            { operation: { operation: 'add_definition_field', target: 'stable.1', path: [{ key: 'child', occurrence: 1 }], entry: { key: 'added', value: { kind: 'boolean', value: true } } }, expected: 'added = yes' },
            { operation: { operation: 'add_scripted_effect_call', target: 'stable.1', containerPath: ['effects'], script: 'my_effect', arguments: [{ key: 'amount', value: { kind: 'number', value: 3 } }] }, expected: 'my_effect = {' },
            { operation: { operation: 'add_scripted_trigger_call', target: 'stable.1', containerPath: ['triggers'], script: 'my_trigger' }, expected: 'my_trigger = {}' },
            { operation: { operation: 'add_on_action_entry', target: 'stable.1', entry: { key: 'events', value: { kind: 'list', values: [{ kind: 'identifier', value: 'one.1' }] } } }, expected: 'events = { one.1 }' },
            { operation: { operation: 'bind_event_target', target: 'stable.1', eventTarget: 'saved_target' }, expected: 'save_event_target_as = saved_target' },
            { operation: { operation: 'clear_event_target', target: 'stable.1', eventTarget: 'saved_target' }, expected: 'clear_event_target = saved_target' },
            { operation: { operation: 'add_variable_transition', target: 'stable.1', transition: 'change_variable', variable: 'score', value: { kind: 'number', value: 4 } }, expected: 'change_variable = {' },
        ];
        for (const item of cases) {
            const result = await buildTypedPdxCandidate({ filePath: 'x.txt', operation: item.operation }, read(definition));
            if (item.operation.operation === 'delete_definition_field') expect(result.content).not.to.contain(item.expected);
            else expect(result.content).to.contain(item.expected);
        }
    });

    it('rejects unsafe second-batch operations and protects identity', async () => {
        const source = 'root = { id = stable.1 child = {} }\n';
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'set_definition_field', target: 'stable.1', path: [{ key: 'id', occurrence: 1 }], value: { kind: 'identifier', value: 'other' } } }, source, /identity/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'delete_definition_field', target: 'stable.1', path: [{ key: 'id', occurrence: 1 }] } }, source, /identity/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'add_definition_field', target: 'stable.1', path: [], entry: { key: 'id', value: { kind: 'identifier', value: 'other' } } } }, source, /identity/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'add_scripted_effect_call', target: 'stable.1', script: 'bad script' } }, source, /script/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'add_scripted_trigger_call', target: 'stable.1', script: 'ok', arguments: [{ key: 'x', value: { kind: 'raw' } as never }] } }, source, /raw|unsupported/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'add_on_action_entry', target: 'stable.1', entry: { key: 'id', value: { kind: 'identifier', value: 'other' } } } }, source, /identity/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'bind_event_target', target: 'stable.1', eventTarget: 'bad target' } }, source, /eventTarget/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'clear_event_target', target: 'stable.1', eventTarget: 'bad target' } }, source, /eventTarget/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'add_variable_transition', target: 'stable.1', transition: 'raw' as never, variable: 'score', value: { kind: 'number', value: 1 } } }, source, /unsupported variable transition/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'set_definition_field', target: 'stable.1', path: Array.from({ length: 9 }, () => ({ key: 'child', occurrence: 1 })), value: { kind: 'boolean', value: true } } }, source, /safety limit/);
        await expectFailure({ filePath: 'x.txt', operation: { operation: 'bind_event_target', target: 'stable.1', eventTarget: 'ok', raw: 'x' } as never }, source, /unsupported field.*raw/);
    });

    it('rejects raw values, ambiguous targets, duplicate symbols, and hash drift', async () => {
        const source = 'root = {}\nroot = {}\n';
        await expectFailure({
            filePath: 'x.txt',
            operation: { operation: 'add_event_option', target: 'root', name: 'option_name' },
        }, source, /not unique/);
        await expectFailure({
            filePath: 'x.txt',
            expectedHash: '0',
            operation: { operation: 'add_event_option', target: 'root', name: 'option_name' },
        }, 'root = {}\n', /expectedHash/);
        await expectFailure({
            filePath: 'x.txt',
            operation: {
                operation: 'append_trigger_condition',
                target: 'root',
                containerPath: [],
                condition: { key: 'always', value: { kind: 'raw', value: 'yes' } as never },
            },
        }, 'root = {}\n', /unsupported/);
        await expectFailure({
            filePath: 'x.txt',
            operation: { operation: 'clone_definition', source: 'root', newSymbol: 'root' },
        }, 'root = {}\n', /duplicate/);
    });
});
