import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

describe('RunLedger Unit Tests', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-run-ledger-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty */ }
    });

    it('creates a new run and appends events with incremental sequence numbers', async () => {
        const { runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_test', 'build', 'test user prompt');
        const runId = run.runId;
        expect(runId).to.be.a('string');

        const updatedRun = runLedger.getRun(runId);
        expect(updatedRun).to.not.be.undefined;
        expect(updatedRun!.runId).to.equal(runId);
        expect(updatedRun!.topicId).to.equal('topic_test');
        expect(updatedRun!.mode).to.equal('build');

        // Append step events which populate run.steps
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'thinking', content: 'drafting', timestamp: 1 } });
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'validation', content: 'passed', timestamp: 2 } });

        const finalRun = runLedger.getRun(runId);
        expect(finalRun!.steps).to.have.lengthOf(2);
        expect((finalRun!.steps as any[])[0].type).to.equal('thinking');
        expect((finalRun!.steps as any[])[1].type).to.equal('validation');
    });

    it('correctly tracks status transition events', async () => {
        const { runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_status', 'plan', 'test prompt');
        const runId = run.runId;
        
        await runLedger.appendEvent(runId, 'status_changed', { status: 'running' });
        let updated = runLedger.getRun(runId);
        expect(updated!.status).to.equal('running');

        await runLedger.appendEvent(runId, 'status_changed', { status: 'completed' });
        updated = runLedger.getRun(runId);
        expect(updated!.status).to.equal('completed');
    });

    it('reloads persisted events and continues sequence numbers after restart', async () => {
        const { RunLedger, runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_reload', 'build', 'reload prompt');
        await runLedger.appendEvent(run.runId, 'tool_call_start', { toolName: 'read_file' }, { invocationId: 'inv_reload' });
        await runLedger.appendEvent(run.runId, 'tool_call_end', { toolName: 'read_file', success: true }, { invocationId: 'inv_reload' });

        const freshLedger = new (RunLedger as any)() as typeof runLedger;
        const loaded = await freshLedger.loadLatestRunForTopic('topic_reload');
        expect(loaded?.runId).to.equal(run.runId);

        const snapshot = freshLedger.getSnapshot(run.runId);
        expect(snapshot?.events.map(event => event.type)).to.deep.equal([
            'run_created',
            'tool_call_start',
            'tool_call_end',
        ]);
        expect(snapshot?.events.map(event => event.sequence)).to.deep.equal([1, 2, 3]);

        await freshLedger.appendEvent(run.runId, 'status_changed', { status: 'completed' });
        const updatedSnapshot = freshLedger.getSnapshot(run.runId);
        expect(updatedSnapshot?.events.at(-1)?.sequence).to.equal(4);
    });

    it('cleans old or excess large tool result artifacts', async () => {
        const { runLedger } = loadRunLedgerModule();
        const topicId = 'topic_cleanup';
        const runsDir = path.join(workspaceRoot, '.cwtools-ai', topicId, 'runs');
        const largeDirA = path.join(runsDir, 'run_a', 'large_results');
        const largeDirB = path.join(runsDir, 'run_b', 'large_results');
        fs.mkdirSync(largeDirA, { recursive: true });
        fs.mkdirSync(largeDirB, { recursive: true });

        const oldFile = path.join(largeDirA, 'old_result.json');
        const keepFile = path.join(largeDirB, 'keep_result.json');
        const extraFile = path.join(largeDirB, 'extra_result.json');
        fs.writeFileSync(oldFile, 'old-result', 'utf-8');
        fs.writeFileSync(keepFile, 'keep-result', 'utf-8');
        fs.writeFileSync(extraFile, 'extra-result', 'utf-8');

        const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        fs.utimesSync(oldFile, oldTime, oldTime);

        const result = await runLedger.cleanupLargeResultArtifacts(topicId, { maxAgeDays: 14, maxFiles: 1 });
        expect(result.deletedCount).to.equal(2);
        expect(result.keptCount).to.equal(1);
        expect(result.reclaimedBytes).to.be.greaterThan(0);
        expect(fs.existsSync(oldFile)).to.equal(false);
        expect([keepFile, extraFile].filter(file => fs.existsSync(file))).to.have.lengthOf(1);
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
        delete require.cache[require.resolve('../../extension/ai/workspacePaths')];
        delete require.cache[require.resolve('../../extension/ai/runner/runLedger')];
        return require('../../extension/ai/runner/runLedger') as typeof import('../../extension/ai/runner/runLedger');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    },
};
