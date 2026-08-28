import { expect } from 'chai';

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
});

function loadToolInvocationModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/toolInvocation') as typeof import('../../extension/ai/runner/toolInvocation');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
    },
};
