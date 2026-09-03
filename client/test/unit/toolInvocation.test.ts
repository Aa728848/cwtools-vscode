import { expect } from 'chai';
import { loadModuleWithVscodeStub } from './runnerTestFixtures';

function loadToolInvocationModule() {
    return loadModuleWithVscodeStub<typeof import('../../extension/ai/runner/toolInvocation')>(
        '../../extension/ai/runner/toolInvocation'
    );
}

describe('ToolInvocation & Registry Single Source of Truth Tests', () => {
    it('derives correct metadata for registered core tools from TOOL_REGISTRY', () => {
        const { getToolMetadata } = loadToolInvocationModule();
        const metaRead = getToolMetadata('read_file');
        expect(metaRead.effect).to.equal('workspace_read');
        expect(metaRead.riskLevel).to.equal(0);
        expect(metaRead.concurrencyClass).to.equal('parallel');

        const metaWrite = getToolMetadata('write_file');
        expect(metaWrite.effect).to.equal('workspace_write');
        expect(metaWrite.riskLevel).to.equal(2);
        expect(metaWrite.concurrencyClass).to.equal('per-file-write');

        const metaShell = getToolMetadata('run_command');
        expect(metaShell.effect).to.equal('shell');
        expect(metaShell.riskLevel).to.equal(2);
        expect(metaShell.concurrencyClass).to.equal('interactive');

        const metaSearch = getToolMetadata('web_search');
        expect(metaSearch.effect).to.equal('network');
        expect(metaSearch.concurrencyClass).to.equal('network-limited');
        const metaFind = getToolMetadata('web_find');
        expect(metaFind.effect).to.equal('workspace_read');
        expect(metaFind.riskLevel).to.equal(0);
    });

    it('falls back safely for unregistered, unknown tools', () => {
        const { getToolMetadata } = loadToolInvocationModule();
        const metaFallback = getToolMetadata('completely_unregistered_hypothetical_tool');
        expect(metaFallback.effect).to.equal('workspace_write');
        expect(metaFallback.riskLevel).to.equal(2);
        expect(metaFallback.concurrencyClass).to.equal('global-exclusive');
    });

    it('builds valid ToolInvocation envelopes with case-insensitive registry correction', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        const invocation = buildToolInvocation({
            runId: 'run123',
            toolCall: {
                id: 'call_abc',
                type: 'function',
                function: {
                    name: 'ReAd_FiLe',
                    arguments: '{"TargetFile": "a.txt"}'
                }
            },
            availableTools: [{ function: { name: 'read_file' } }],
            workspaceRoot: 'C:/ws'
        });

        expect(invocation.name).to.equal('read_file');
        expect(invocation.effect).to.equal('workspace_read');
        expect(invocation.riskLevel).to.equal(0);
        expect(invocation.args).to.deep.equal({ TargetFile: 'a.txt' });
    });

    it('reconstructs flattened model arguments before execution', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        const invocation = buildToolInvocation({
            runId: 'run123',
            toolCall: {
                id: 'call_flat',
                type: 'function',
                function: {
                    name: 'web_search',
                    arguments: '{"query":"test","location.country":"CN"}',
                },
            },
            availableTools: [{ function: { name: 'web_search' } }],
            workspaceRoot: 'C:/ws',
        });

        expect(invocation.parseError).to.equal(undefined);
        expect(invocation.args).to.deep.include({ query: 'test', location: { country: 'CN' } });
        expect(invocation.argRepairs).to.include('Nested schema reconstructed');
    });

    it('normalizes whitespace-only arguments to an empty object', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        const invocation = buildToolInvocation({
            runId: 'run123',
            toolCall: {
                id: 'call_empty',
                type: 'function',
                function: { name: 'get_lsp_status', arguments: '   ' },
            },
            availableTools: [{ function: { name: 'get_lsp_status' } }],
            workspaceRoot: 'C:/ws',
        });

        expect(invocation.parseError).to.equal(undefined);
        expect(invocation.args).to.deep.equal({});
    });

    it('rejects non-object JSON arguments at the tool boundary', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        for (const raw of ['null', '[]', '42', '"text"']) {
            const invocation = buildToolInvocation({
                runId: 'run123',
                toolCall: {
                    id: `call_${raw}`,
                    type: 'function',
                    function: { name: 'read_file', arguments: raw },
                },
                availableTools: [{ function: { name: 'read_file' } }],
                workspaceRoot: 'C:/ws',
            });
            expect(invocation.parseError, raw).to.equal('Tool arguments must be a JSON object');
            expect(invocation.args, raw).to.deep.equal({});
        }
    });

    it('normalizes and repairs select_tools through the same invocation path', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        const invocation = buildToolInvocation({
            runId: 'run123',
            toolCall: {
                id: 'call_select',
                type: 'function',
                function: { name: 'Select_Tools', arguments: '{"tools":["read_file"],}' },
            },
            availableTools: [{ function: { name: 'select_tools' } }],
            workspaceRoot: 'C:/ws',
        });

        expect(invocation.name).to.equal('select_tools');
        expect(invocation.parseError).to.equal(undefined);
        expect(invocation.args.tools).to.deep.equal(['read_file']);
        expect(invocation.argRepairs).to.include('JSON syntax repaired');
    });

    it('repairs case-insensitive tool name mismatches via buildToolInvocation', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        const inv = buildToolInvocation({
            runId: 'run_test',
            toolCall: { id: 'tc1', type: 'function', function: { name: 'Read_File', arguments: '{"file":"test.txt"}' } },
            availableTools: [{ function: { name: 'read_file' } }],
            workspaceRoot: 'C:/project'
        });
        expect(inv.name).to.equal('read_file');
        expect(inv.originalName).to.equal('Read_File');
    });

    it('preserves unknown tool names and marks them for error reporting', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        const inv = buildToolInvocation({
            runId: 'run_test',
            toolCall: { id: 'tc2', type: 'function', function: { name: 'nonexistent_tool', arguments: '{}' } },
            availableTools: [{ function: { name: 'read_file' } }],
            workspaceRoot: 'C:/project'
        });
        expect(inv.name).to.equal('nonexistent_tool');
        expect(inv.originalName).to.equal('nonexistent_tool');
    });

    it('repairs JSON syntax in arguments and records repair log', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        const inv = buildToolInvocation({
            runId: 'run_test',
            toolCall: { id: 'tc3', type: 'function', function: { name: 'read_file', arguments: '{"file":"test.txt",}' } },
            availableTools: [{ function: { name: 'read_file' } }],
            workspaceRoot: 'C:/project'
        });
        expect(inv.parseError).to.be.undefined;
        expect(inv.args).to.have.property('file', 'test.txt');
    });

    it('assigns unique invocationId to each tool call', () => {
        const { buildToolInvocation } = loadToolInvocationModule();
        const inv1 = buildToolInvocation({
            runId: 'run_test',
            toolCall: { id: 'tc4', type: 'function', function: { name: 'read_file', arguments: '{"file":"a.txt"}' } },
            availableTools: [{ function: { name: 'read_file' } }],
            workspaceRoot: 'C:/project'
        });
        const inv2 = buildToolInvocation({
            runId: 'run_test',
            toolCall: { id: 'tc5', type: 'function', function: { name: 'read_file', arguments: '{"file":"b.txt"}' } },
            availableTools: [{ function: { name: 'read_file' } }],
            workspaceRoot: 'C:/project'
        });
        expect(inv1.invocationId).to.be.a('string');
        expect(inv2.invocationId).to.be.a('string');
        expect(inv1.invocationId).to.not.equal(inv2.invocationId);
    });
});
