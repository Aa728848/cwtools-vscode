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

        // Runs keep structured events only; chat steps stay in the conversation surface.
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'thinking', content: 'drafting', timestamp: 1 } });
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'validation', content: 'passed', timestamp: 2 } });

        const finalRun = runLedger.getRun(runId);
        expect(finalRun!.steps).to.have.lengthOf(0);
        expect(runLedger.getSnapshot(runId)?.events.map(event => event.type)).to.deep.equal(['run_created']);
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

    it('filters chat step events from persisted run state', async () => {
        const { runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_streaming', 'orchestrator', 'stream prompt');
        const runId = run.runId;

        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'text_delta', content: 'hello', timestamp: 1 } });
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'thinking_content', content: 'thought', timestamp: 2 } });
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'orchestrator_progress', content: '正在等待模型返回 (30s)...', timestamp: 3 } });
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'validation', content: 'passed', timestamp: 4 } });

        const snapshot = runLedger.getSnapshot(runId);
        expect(snapshot?.run.steps).to.deep.equal([]);
        expect(snapshot?.events.map(event => event.type)).to.deep.equal(['run_created']);
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

    it('archives the complete prompt and discovers replay context after restart', async () => {
        const { RunLedger, runLedger } = loadRunLedgerModule();
        const fullPrompt = `inspect every relevant file\n${'detail '.repeat(200)}`;
        const run = await runLedger.createRun(
            'topic_replay',
            'build',
            fullPrompt.slice(0, 100),
            undefined,
            fullPrompt,
        );
        await runLedger.appendEvent(run.runId, 'status_changed', { status: 'completed' });

        const runDir = path.join(workspaceRoot, '.cwtools-ai', 'topic_replay', 'runs', run.runId);
        const promptArtifact = JSON.parse(fs.readFileSync(path.join(runDir, 'prompt.json'), 'utf-8'));
        expect(promptArtifact.prompt).to.equal(fullPrompt);
        expect(promptArtifact.sha256).to.match(/^[a-f0-9]{64}$/);

        const freshLedger = new (RunLedger as any)() as typeof runLedger;
        const recent = await freshLedger.listRecentRunsFromDisk(10);
        expect(recent.some(candidate => candidate.runId === run.runId)).to.equal(true);
        expect(await freshLedger.readPrompt(run.runId)).to.equal(fullPrompt);
        expect((await freshLedger.getOrLoadSnapshot(run.runId))?.events.map(event => event.sequence)).to.deep.equal([1, 2]);
    });

    it('replays a disk-only run with its original prompt and recorded tool result', async () => {
        const { runLedger } = loadRunLedgerModule();
        const fullPrompt = 'compare the persisted implementation after restart';
        const run = await runLedger.createRun('topic_disk_replay', 'build', fullPrompt, undefined, fullPrompt);
        await runLedger.appendEvent(
            run.runId,
            'tool_call_created',
            { toolName: 'read_file', toolArgs: { filePath: 'a.txt', line: 1 } },
            { invocationId: 'inv_replay' },
        );
        await runLedger.appendEvent(
            run.runId,
            'tool_call_end',
            { toolName: 'read_file', success: true, result: { content: 'persisted result' } },
            { invocationId: 'inv_replay' },
        );

        const { replayRun } = loadRunReplayModule();
        let receivedPrompt = '';
        let recordedResult: unknown;
        await replayRun(run.runId, {
            run: async (prompt: string, _context: unknown, _history: unknown, options: any) => {
                receivedPrompt = prompt;
                recordedResult = options.replaySession.lookup('read_file', { line: 1, filePath: 'a.txt' });
                return {};
            },
        } as any);

        expect(receivedPrompt).to.equal(fullPrompt);
        expect(recordedResult).to.deep.equal({ content: 'persisted result' });
    });

    it('serializes concurrent event writes in monotonic JSONL order', async () => {
        const { RunLedger, runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_order', 'build', 'ordered prompt');
        await Promise.all(Array.from({ length: 24 }, (_, index) => (
            runLedger.appendEvent(run.runId, 'todo_update', { index })
        )));

        const runDir = path.join(workspaceRoot, '.cwtools-ai', 'topic_order', 'runs', run.runId);
        const persistedSequences = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf-8')
            .trim()
            .split(/\r?\n/)
            .map(line => JSON.parse(line).sequence);
        expect(persistedSequences).to.deep.equal(Array.from({ length: 25 }, (_, index) => index + 1));

        const freshLedger = new (RunLedger as any)() as typeof runLedger;
        await freshLedger.loadLatestRunForTopic('topic_order');
        expect(freshLedger.getSnapshot(run.runId)?.events.map(event => event.sequence)).to.deep.equal(persistedSequences);
    });

    it('recovers run state from its atomic backup and reapplies durable events', async () => {
        const { RunLedger, runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_state_backup', 'build', 'backup prompt');
        await runLedger.appendEvent(run.runId, 'status_changed', { status: 'running' });
        await runLedger.appendEvent(run.runId, 'model_call_start', { model: 'test-model' });

        const statePath = path.join(
            workspaceRoot,
            '.cwtools-ai',
            'topic_state_backup',
            'runs',
            run.runId,
            'run_state.json',
        );
        expect(fs.existsSync(`${statePath}.bak`)).to.equal(true);
        fs.writeFileSync(statePath, '{invalid state', 'utf-8');

        const freshLedger = new (RunLedger as any)() as typeof runLedger;
        const loaded = await freshLedger.loadLatestRunForTopic('topic_state_backup');
        expect(loaded?.runId).to.equal(run.runId);
        expect(loaded?.status).to.equal('running');
        expect(loaded?.metrics.modelCallCount).to.equal(1);
        expect(freshLedger.getSnapshot(run.runId)?.events.map(event => event.sequence)).to.deep.equal([1, 2, 3]);
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

function loadRunReplayModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/workspacePaths')];
        delete require.cache[require.resolve('../../extension/ai/runner/runLedger')];
        delete require.cache[require.resolve('../../extension/ai/runner/runReplay')];
        return require('../../extension/ai/runner/runReplay') as typeof import('../../extension/ai/runner/runReplay');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    },
};
