import { expect } from 'chai';

describe('AgentManagerRunSnapshot Unit Tests', () => {
    it('saves, queries, and completes multi-agent run records', async () => {
        const { runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_mult', 'orchestrator', 'test prompt');
        const runId = run.runId;
        
        // Assert base fields of snapshot
        let updated = runLedger.getRun(runId);
        expect(updated!.runId).to.equal(runId);
        expect(updated!.mode).to.equal('orchestrator');

        // Emulate subagent dispatch run events
        await runLedger.appendEvent(runId, 'tool_call_created', { toolName: 'dispatch_agents' }, { invocationId: 'inv_sub1' });
        await runLedger.appendEvent(runId, 'status_changed', { status: 'running' });

        updated = runLedger.getRun(runId);
        expect(updated!.status).to.equal('running');

        // Terminate and verify completed snapshot status
        await runLedger.appendEvent(runId, 'status_changed', { status: 'completed' });
        updated = runLedger.getRun(runId);
        expect(updated!.status).to.equal('completed');
    });
});

function loadRunLedgerModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/runLedger') as typeof import('../../extension/ai/runner/runLedger');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
    },
};
