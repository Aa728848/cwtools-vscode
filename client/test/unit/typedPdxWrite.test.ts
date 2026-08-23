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
