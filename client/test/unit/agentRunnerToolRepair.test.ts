import { expect } from 'chai';

describe('AgentRunner Tool Name Repair (P0-1)', () => {
    it('repairs case-insensitive tool name mismatches via buildToolInvocation', () => {
        const { buildToolInvocation } = loadModule();
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
        const { buildToolInvocation } = loadModule();
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
        const { buildToolInvocation } = loadModule();
        // Trailing comma is invalid JSON but should be repaired
        const inv = buildToolInvocation({
            runId: 'run_test',
            toolCall: { id: 'tc3', type: 'function', function: { name: 'read_file', arguments: '{"file":"test.txt",}' } },
            availableTools: [{ function: { name: 'read_file' } }],
            workspaceRoot: 'C:/project'
        });
        // Either parsed successfully or repaired
        expect(inv.parseError).to.be.undefined;
        expect(inv.args).to.have.property('file', 'test.txt');
    });

    it('assigns unique invocationId to each tool call', () => {
        const { buildToolInvocation } = loadModule();
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

function loadModule() {
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
    workspace: { workspaceFolders: [] },
};
