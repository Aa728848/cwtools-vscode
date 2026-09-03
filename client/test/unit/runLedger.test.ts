import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executionModeForSchedulingState, schedulingStateFromAdmission } from '../../extension/ai/runner/scheduling';

const PARADOX_WRITE = schedulingStateFromAdmission({
    domainProfile: 'paradox', authorization: 'workspace_write', initialPhase: 'execute',
    explicitDelegation: false, confidence: 1, evidence: ['test'],
});
const PARADOX_PLAN = schedulingStateFromAdmission({
    domainProfile: 'paradox', authorization: 'plan_write_only', initialPhase: 'plan',
    explicitDelegation: false, confidence: 1, evidence: ['test'],
});
const GENERAL_PARALLEL = schedulingStateFromAdmission({
    domainProfile: 'general', authorization: 'workspace_write', initialPhase: 'execute',
    explicitDelegation: true, confidence: 1, evidence: ['test'],
});

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-run-ledger');

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
        const run = await runLedger.createRun('topic_test', PARADOX_WRITE, 'test user prompt');
        const runId = run.runId;
        expect(runId).to.be.a('string');

        const updatedRun = runLedger.getRun(runId);
        expect(updatedRun).to.not.be.undefined;
        expect(updatedRun!.runId).to.equal(runId);
        expect(updatedRun!.topicId).to.equal('topic_test');
        expect(executionModeForSchedulingState(updatedRun!.schedulingState)).to.equal('build');

        // Runs keep structured events only; chat steps stay in the conversation surface.
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'thinking', content: 'drafting', timestamp: 1 } });
        await runLedger.appendEvent(runId, 'step_appended', { step: { type: 'validation', content: 'passed', timestamp: 2 } });

        const finalRun = runLedger.getRun(runId);
        expect(finalRun!.steps).to.have.lengthOf(0);
        expect(runLedger.getSnapshot(runId)?.events.map(event => event.type)).to.deep.equal(['run_created']);
    });

    it('correctly tracks status transition events', async () => {
        const { runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_status', PARADOX_PLAN, 'test prompt');
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
        const run = await runLedger.createRun('topic_streaming', GENERAL_PARALLEL, 'stream prompt');
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
        const run = await runLedger.createRun('topic_reload', PARADOX_WRITE, 'reload prompt');
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
            PARADOX_WRITE,
            fullPrompt.slice(0, 100),
            undefined,
            fullPrompt,
        );
        await runLedger.appendEvent(run.runId, 'status_changed', { status: 'completed' });

        const runDir = path.join(workspaceRoot, '.cwtools', 'topic_replay', 'runs', run.runId);
        const promptArtifact = JSON.parse(fs.readFileSync(path.join(runDir, 'prompt.json'), 'utf-8'));
        expect(promptArtifact.prompt).to.equal(fullPrompt);
        expect(promptArtifact.sha256).to.match(/^[a-f0-9]{64}$/);

        const freshLedger = new (RunLedger as any)() as typeof runLedger;
        const recent = await freshLedger.listRecentRunsFromDisk(10);
        expect(recent.some(candidate => candidate.runId === run.runId)).to.equal(true);
        expect(await freshLedger.readPrompt(run.runId)).to.equal(fullPrompt);
        expect((await freshLedger.getOrLoadSnapshot(run.runId))?.events.map(event => event.sequence)).to.deep.equal([1, 2]);
    });

    it('writes checked JSON artifacts under the run directory', async () => {
        const { runLedger } = loadRunLedgerModule();
        const run = await runLedger.createRun('topic_artifact', PARADOX_WRITE, 'artifact prompt');

        const artifact = await runLedger.writeJsonArtifact(run.runId, 'model_requests/request_1.json', {
            messages: [{ role: 'user', content: 'hello' }],
            tools: [],
        });

        expect(artifact?.ref).to.equal('model_requests/request_1.json');
        expect(artifact?.sha256).to.match(/^[a-f0-9]{64}$/);

        const artifactPath = path.join(
            workspaceRoot,
            '.cwtools',
            'topic_artifact',
            'runs',
            run.runId,
            'model_requests',
            'request_1.json',
        );
        expect(fs.existsSync(artifactPath)).to.equal(true);
        expect(JSON.parse(fs.readFileSync(artifactPath, 'utf-8')).messages[0].content).to.equal('hello');
        expect(await runLedger.writeJsonArtifact(run.runId, '../outside.json', {})).to.equal(undefined);
    });

    it('replays a disk-only run with its original prompt and recorded tool result', async () => {
        const { runLedger } = loadRunLedgerModule();
        const fullPrompt = 'compare the persisted implementation after restart';
        const run = await runLedger.createRun('topic_disk_replay', PARADOX_WRITE, fullPrompt, undefined, fullPrompt);
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
        const run = await runLedger.createRun('topic_order', PARADOX_WRITE, 'ordered prompt');
        await Promise.all(Array.from({ length: 24 }, (_, index) => (
            runLedger.appendEvent(run.runId, 'todo_update', { index })
        )));

        const runDir = path.join(workspaceRoot, '.cwtools', 'topic_order', 'runs', run.runId);
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
        const run = await runLedger.createRun('topic_state_backup', PARADOX_WRITE, 'backup prompt');
        await runLedger.appendEvent(run.runId, 'status_changed', { status: 'running' });
        await runLedger.appendEvent(run.runId, 'model_call_start', { model: 'test-model' });

        const statePath = path.join(
            workspaceRoot,
            '.cwtools',
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
        const runsDir = path.join(workspaceRoot, '.cwtools', topicId, 'runs');
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

    it('routes blackboard events through an explicit run event sink instead of the latest run', async () => {
        const { runLedger } = loadRunLedgerModule();
        const { createRunEventSink } = loadRunContextModule();
        const { Blackboard } = loadBlackboardModule();

        const intendedRun = await runLedger.createRun('topic_sink_a', GENERAL_PARALLEL, 'intended prompt');
        const latestRun = await runLedger.createRun('topic_sink_b', GENERAL_PARALLEL, 'latest prompt');
        const sink = createRunEventSink({ runId: intendedRun.runId, agentId: 'parent' });
        const blackboard = new Blackboard(undefined, sink);

        blackboard.write('k', 'value', 'free_text', 'agent_a');
        expect(blackboard.read('k')?.value).to.equal('value');

        await waitForEvent(runLedger, intendedRun.runId, 'blackboard_read');
        expect(runLedger.getSnapshot(intendedRun.runId)?.events.map(event => event.type)).to.include.members([
            'blackboard_write',
            'blackboard_read',
        ]);
        expect(runLedger.getSnapshot(latestRun.runId)?.events.map(event => event.type)).to.not.include('blackboard_write');
    });

    it('routes conflict detector events through the provided run event sink', async () => {
        const { runLedger } = loadRunLedgerModule();
        const { createRunEventSink } = loadRunContextModule();
        const { Blackboard } = loadBlackboardModule();
        const { ConflictDetector } = loadConflictDetectorModule();

        const intendedRun = await runLedger.createRun('topic_conflict_a', GENERAL_PARALLEL, 'intended prompt');
        const latestRun = await runLedger.createRun('topic_conflict_b', GENERAL_PARALLEL, 'latest prompt');
        const sink = createRunEventSink({ runId: intendedRun.runId, agentId: 'parent' });
        const blackboard = new Blackboard(undefined, sink);
        const detector = new ConflictDetector(sink);

        detector.declareIntent('agent_b', ['common/events/test.txt'], blackboard);
        const result = detector.checkWriteConflict('agent_a', 'common/events/test.txt', blackboard);

        expect(result.hasConflict).to.equal(true);
        await waitForEvent(runLedger, intendedRun.runId, 'conflict_detected');
        expect(runLedger.getSnapshot(intendedRun.runId)?.events.map(event => event.type)).to.include('conflict_detected');
        expect(runLedger.getSnapshot(latestRun.runId)?.events.map(event => event.type)).to.not.include('conflict_detected');
    });

    it('exposes rollout projection and explicit run metadata', async () => {
        const { runLedger } = loadRunLedgerModule();
        const { createRunEventSink } = loadRunContextModule();
        const { readRunRollout } = loadRolloutStoreModule();
        const run = await runLedger.createRun(
            'topic_rollout',
            PARADOX_WRITE,
            'rollout prompt',
            'parent_run',
            'rollout prompt',
            { agentId: 'agent_rollout', providerId: 'test-provider', model: 'test-model', threadId: 'thread_1', turnId: 'turn_1' },
        );
        const sink = createRunEventSink({ runId: run.runId, agentId: 'agent_rollout' });
        await sink.append('input_queued', { inputId: 'input_1', size: 5 }, { status: 'pending' });

        const rollout = await readRunRollout(run.runId);
        expect(rollout?.run.parentRunId).to.equal('parent_run');
        expect(rollout?.run.agentId).to.equal('agent_rollout');
        expect(rollout?.events.map(event => event.type)).to.include('input_queued');
        expect(rollout?.projection).to.be.an('object');
    });

    it('queues and drains steer input in FIFO order', () => {
        const { AgentInputQueue } = loadInputQueueModule();
        const queue = new AgentInputQueue('run_input');
        queue.enqueue('first', 'client_1');
        queue.enqueue('second', undefined, ['data:image/png;base64,abc']);

        expect(queue.size).to.equal(2);
        const drained = queue.drain();
        expect(drained.map(item => item.message)).to.deep.equal(['first', 'second']);
        expect(drained[1]?.images).to.deep.equal(['data:image/png;base64,abc']);
        expect(queue.size).to.equal(0);
    });

    it('records background process lifecycle events through the run event sink', async () => {
        const { runLedger } = loadRunLedgerModule();
        const { createRunEventSink } = loadRunContextModule();
        const { ProcessRegistry } = loadProcessRegistryModule();
        const run = await runLedger.createRun('topic_process', PARADOX_WRITE, 'process prompt');
        const sink = createRunEventSink({ runId: run.runId });
        const registry = new ProcessRegistry();

        let stdin = '';
        const process = registry.register('echo hello', workspaceRoot, 1234, sink, {
            sandboxMode: 'direct-preflight',
            networkAccess: true,
        }, { writeStdin: text => { stdin += text; } });
        expect(registry.writeStdin(process.processId, 'continue\n')).to.equal(true);
        expect(stdin).to.equal('continue\n');
        registry.appendOutput(process.processId, 'stdout', 'hello\n', sink);
        registry.complete(process.processId, 0, sink);

        await waitForEvent(runLedger, run.runId, 'process_completed');
        const snapshot = runLedger.getSnapshot(run.runId);
        expect(snapshot?.events.map(event => event.type)).to.include.members([
            'process_started',
            'process_output_delta',
            'process_completed',
            'item_started',
            'item_updated',
            'item_completed',
        ]);
        const started = snapshot?.events.find(event => event.type === 'process_started');
        expect(started?.payload.sandboxMode).to.equal('direct-preflight');
        expect(started?.payload.networkAccess).to.equal(true);
    });

    it('persists durable thread records and supports fork/compact metadata', async () => {
        const { runLedger } = loadRunLedgerModule();
        const { ThreadStore } = loadThreadStoreModule();
        const store = new ThreadStore();
        const run = await runLedger.createRun(
            'topic_threads',
            PARADOX_WRITE,
            'thread prompt',
            undefined,
            'thread prompt',
            { threadId: 'thread_main', turnId: 'turn_1', agentId: 'agent_main' },
        );

        const record = await store.recordRun(run);
        expect(record.threadId).to.equal('thread_main');
        expect(record.currentRunId).to.equal(run.runId);
        expect(record.runIds).to.deep.equal([run.runId]);

        const fork = await store.forkThread('topic_threads', 'thread_main', 'thread_fork', 'topic_threads_fork');
        expect(fork?.parentThreadId).to.equal('thread_main');
        expect(fork?.topicId).to.equal('topic_threads_fork');
        expect(fork?.forkedFromRunId).to.equal(run.runId);

        const compacted = await store.markCompacted('topic_threads', 'thread_main', run.runId, 'summaries/latest.json');
        expect(compacted?.status).to.equal('compacted');
        expect(compacted?.latestSummaryRef).to.equal('summaries/latest.json');

        const fresh = new ThreadStore();
        expect((await fresh.getThread('topic_threads', 'thread_main'))?.currentRunId).to.equal(run.runId);
        expect((await fresh.listThreads('topic_threads')).map(thread => thread.threadId)).to.include('thread_main');
        expect((await fresh.listThreads('topic_threads_fork')).map(thread => thread.threadId)).to.include('thread_fork');
    });

    it('forks a durable thread at the requested historical run', async () => {
        const { runLedger } = loadRunLedgerModule();
        const { ThreadStore } = loadThreadStoreModule();
        const store = new ThreadStore();
        const first = await runLedger.createRun('topic_exact_fork', PARADOX_WRITE, 'first', undefined, 'first', { threadId: 'thread_exact', turnId: 'turn_1' });
        await store.recordRun(first);
        const second = await runLedger.createRun('topic_exact_fork', PARADOX_WRITE, 'second', first.runId, 'second', { threadId: 'thread_exact', turnId: 'turn_2' });
        await store.recordRun(second);

        const fork = await store.forkThread('topic_exact_fork', 'thread_exact', 'thread_from_first', 'topic_from_first', first.runId, 1);
        expect(fork?.currentRunId).to.equal(first.runId);
        expect(fork?.runIds).to.deep.equal([first.runId]);
        expect(fork?.forkedFromMessageIndex).to.equal(1);
    });

    it('TurnRunner records a durable thread for each started turn', async () => {
        const { runLedger } = loadRunLedgerModule();
        const { TurnRunner } = loadTurnRunnerModule();
        const { ThreadStore } = loadThreadStoreModule();
        const store = new ThreadStore();
        const runner = new TurnRunner(runLedger, store);

        const runtime = await runner.startTurn({
            topicId: 'topic_turn_runner',
            schedulingState: PARADOX_WRITE,
            userPrompt: 'turn prompt',
            threadId: 'thread_turn_runner',
            turnId: 'turn_1',
        });

        const thread = await store.getThread('topic_turn_runner', 'thread_turn_runner');
        expect(thread?.currentRunId).to.equal(runtime.run.runId);
        expect(runtime.eventSink.runId).to.equal(runtime.run.runId);
    });

    it('ActiveTurnRegistry steers and interrupts active turns', () => {
        const { ActiveTurnRegistry } = loadActiveTurnRegistryModule();
        const registry = new ActiveTurnRegistry();
        const controller = new AbortController();
        const steered: Array<{ message: string; images?: string[] }> = [];
        registry.register({
            runId: 'run_active',
            runner: {
                submitInput: (_runId: string, message: string, _clientId?: string, images?: string[]) => {
                    steered.push({ message, images });
                    return true;
                },
            },
            abortController: controller,
        });

        expect(registry.steer('run_active', 'please pivot', undefined, ['img'])).to.equal(true);
        expect(steered).to.deep.equal([{ message: 'please pivot', images: ['img'] }]);
        expect(registry.interrupt('run_active', 'stop now')).to.equal(true);
        expect(controller.signal.aborted).to.equal(true);
    });

    it('AgentRuntime exposes protocol-style start/steer/interrupt/thread methods', async () => {
        const { activeTurnRegistry } = loadActiveTurnRegistryModule();
        const { AgentRuntime } = loadAgentRuntimeModule();
        const { ThreadStore } = loadThreadStoreModule();
        const capturedOptions: any[] = [];
        const runtime = new AgentRuntime({
            run: async (_message: string, _context: unknown, _history: unknown, options: unknown) => {
                capturedOptions.push(options);
                return {
                    runId: 'run_protocol',
                    code: '',
                    explanation: 'done',
                    validationErrors: [],
                    isValid: true,
                    retryCount: 0,
                    steps: [],
                };
            },
            submitInput: () => true,
        } as any);

        const started = await runtime.startTurn({
            userMessage: 'hello',
            context: { topicId: 'topic_protocol' },
            options: { threadId: 'thread_protocol', schedulingState: PARADOX_WRITE },
        });

        expect(started.threadId).to.equal('thread_protocol');
        expect(started.runId).to.equal('run_protocol');
        expect(capturedOptions[0].threadId).to.equal('thread_protocol');
        expect(capturedOptions[0].durableGoal).to.equal(false);

        const durableGoal = await runtime.setGoal('topic_protocol', 'thread_protocol', 'finish the long Paradox task', 10_000);
        expect(durableGoal).to.include({ version: 2, status: 'active' });
        expect(durableGoal.budgetLimits.tokens).to.equal(10_000);
        expect(durableGoal.goalId).to.be.a('string').and.not.empty;
        await runtime.startTurn({
            userMessage: 'continue',
            context: { topicId: 'topic_protocol' },
            options: { threadId: 'thread_protocol', schedulingState: PARADOX_WRITE },
        });
        expect(capturedOptions[1].durableGoal).to.equal(true);

        const controller = new AbortController();
        const runtimeSteered: Array<{ message: string; images?: string[] }> = [];
        const unregister = activeTurnRegistry.register({
            runId: 'run_direct',
            runner: {
                submitInput: (_runId: string, message: string, _clientId?: string, images?: string[]) => {
                    runtimeSteered.push({ message, images });
                    return true;
                },
            },
            abortController: controller,
        });
        expect(runtime.steerTurn('run_direct', 'queued', undefined, ['img_runtime']).accepted).to.equal(true);
        expect(runtimeSteered).to.deep.equal([{ message: 'queued', images: ['img_runtime'] }]);
        expect(runtime.interruptTurn('run_direct').interrupted).to.equal(true);
        unregister();

        const store = new ThreadStore();
        const thread = await store.markStatus('topic_protocol', 'thread_missing', 'active');
        expect(thread).to.equal(undefined);
    });

    it('fails closed when no verified command sandbox backend exists', () => {
        const { BrokeredSandboxRunner, detectSandboxBackend, SandboxUnavailableError } = require('../../extension/ai/runner/sandboxRunner') as typeof import('../../extension/ai/runner/sandboxRunner');
        expect(detectSandboxBackend('aix')).to.equal(undefined);
        if (process.platform === 'win32' && !detectSandboxBackend()) {
            const runner = new BrokeredSandboxRunner((() => { throw new Error('must not spawn'); }) as any);
            expect(() => runner.spawn({
                command: 'cmd.exe',
                args: ['/c', 'echo test'],
                options: { cwd: process.cwd() },
                profile: { sandboxMode: 'workspace-write', networkAccess: false },
            })).to.throw(SandboxUnavailableError);
        }
    });

    it('enforces private history age retention', async () => {
        const { configureHistoryPolicy, enforceHistoryRetention } = require('../../extension/ai/runner/historyPolicy') as typeof import('../../extension/ai/runner/historyPolicy');
        const root = fs.mkdtempSync(path.join(TEMP_BASE, 'history-policy-'));
        try {
            const oldFile = path.join(root, 'topics', 't', 'runs', 'old.json');
            const newFile = path.join(root, 'topics', 't', 'runs', 'new.json');
            fs.mkdirSync(path.dirname(oldFile), { recursive: true });
            fs.writeFileSync(oldFile, 'old');
            fs.writeFileSync(newFile, 'new');
            const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
            fs.utimesSync(oldFile, oldTime, oldTime);
            configureHistoryPolicy({ persistence: 'full', maxAgeDays: 2, maxBytes: 1024 });
            const result = await enforceHistoryRetention(root);
            expect(result.deletedFiles).to.equal(1);
            expect(fs.existsSync(oldFile)).to.equal(false);
            expect(fs.existsSync(newFile)).to.equal(true);
        } finally {
            configureHistoryPolicy({ persistence: 'full', maxAgeDays: 30, maxBytes: 256 * 1024 * 1024 });
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('routes new run state to configured VS Code private storage', async () => {
        const { RunLedger } = loadRunLedgerModule();
        const workspacePaths = require('../../extension/ai/workspacePaths') as typeof import('../../extension/ai/workspacePaths');
        const privateRoot = path.join(workspaceRoot, '.private-agent-state');
        workspacePaths.configurePrivateAgentStorage(privateRoot);
        try {
            const ledger = new (RunLedger as any)();
            const run = await ledger.createRun('topic_private', PARADOX_WRITE, 'private prompt', undefined, 'private prompt');
            expect(fs.existsSync(path.join(privateRoot, 'topics', 'topic_private', 'runs', run.runId, 'run_state.json'))).to.equal(true);
            expect(fs.existsSync(path.join(workspaceRoot, '.cwtools', 'topic_private', 'runs', run.runId))).to.equal(false);
        } finally {
            workspacePaths.configurePrivateAgentStorage(undefined);
        }
    });

    it('persists chat topic metadata without message content when metadata mode is selected', () => {
        const { ChatTopicManager } = loadChatTopicsModule();
        const storageRoot = path.join(workspaceRoot, '.chat-private');
        const manager = new ChatTopicManager({ fsPath: storageRoot } as any, () => {}, 'metadata');
        manager.createNewTopic('metadata topic', PARADOX_WRITE);
        manager.addHistoryMessage({ role: 'user', content: 'sensitive prompt', timestamp: Date.now(), schedulingState: PARADOX_WRITE });
        manager.saveTopics();
        const stored = JSON.parse(fs.readFileSync(path.join(storageRoot, 'ai-chat-topics.json'), 'utf8'));
        expect(stored[0].title).to.include('metadata topic');
        expect(stored[0].messages).to.deep.equal([]);
    });

    it('persists, forks, and validates canonical scheduling state on topics', async () => {
        const { ChatTopicManager } = loadChatTopicsModule();
        const storageRoot = path.join(workspaceRoot, '.chat-domain');
        const storageUri = { fsPath: storageRoot } as ConstructorParameters<typeof ChatTopicManager>[0];
        const manager = new ChatTopicManager(storageUri, () => {}, 'full');
        manager.createNewTopic('Paradox follow-up', PARADOX_WRITE);
        if (!manager.currentTopic) throw new Error('Expected the topic to be created.');
        manager.currentTopic.schedulingState = PARADOX_WRITE;
        manager.addHistoryMessage({ role: 'user', content: 'change the next event id', timestamp: Date.now(), schedulingState: PARADOX_WRITE });
        manager.saveTopics();

        const restored = new ChatTopicManager(storageUri, () => {}, 'full');
        expect(restored.topics[0]?.schedulingState?.domainProfile).to.equal('paradox');
        const restoredTopic = restored.topics[0];
        if (!restoredTopic) throw new Error('Expected the topic to be restored.');
        restored.forkTopic(restoredTopic.id, 0);
        expect(restored.currentTopic?.schedulingState?.domainProfile).to.equal('paradox');

        const invalid = await restored.importTopicFromJson(JSON.stringify({
            title: 'invalid scheduler',
            messages: [{ role: 'user', content: 'continue', timestamp: Date.now() }],
            schedulingState: { domainProfile: 'invalid' },
        }));
        expect(invalid).to.equal(null);
    });

    it('adds history message to specific targetTopicId even when currentTopic switched', () => {
        const { ChatTopicManager } = loadChatTopicsModule();
        const storageRoot = path.join(workspaceRoot, '.chat-target-topic');
        const storageUri = { fsPath: storageRoot } as ConstructorParameters<typeof ChatTopicManager>[0];
        const manager = new ChatTopicManager(storageUri, () => {}, 'full');
        manager.createNewTopic('Topic A', PARADOX_WRITE);
        const topicAId = manager.currentTopic!.id;
        manager.addHistoryMessage({ role: 'user', content: 'hello from A', timestamp: Date.now() });

        // User starts a new topic or switches away
        manager.startNewTopic();
        expect(manager.currentTopic).to.equal(null);

        // Background task from Topic A finishes and writes assistant message to Topic A
        manager.addHistoryMessage({ role: 'assistant', content: 'response for A', timestamp: Date.now() }, topicAId);

        const topicA = manager.topics.find(t => t.id === topicAId);
        expect(topicA?.messages.length).to.equal(2);
        expect(topicA?.messages[1]?.content).to.equal('response for A');
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

function loadRunContextModule() {
    delete require.cache[require.resolve('../../extension/ai/runner/runContext')];
    return require('../../extension/ai/runner/runContext') as typeof import('../../extension/ai/runner/runContext');
}

function loadRolloutStoreModule() {
    delete require.cache[require.resolve('../../extension/ai/runner/rolloutStore')];
    return require('../../extension/ai/runner/rolloutStore') as typeof import('../../extension/ai/runner/rolloutStore');
}

function loadInputQueueModule() {
    delete require.cache[require.resolve('../../extension/ai/runner/inputQueue')];
    return require('../../extension/ai/runner/inputQueue') as typeof import('../../extension/ai/runner/inputQueue');
}

function loadProcessRegistryModule() {
    return loadModuleWithVscodeStub('../../extension/ai/runner/processRegistry') as typeof import('../../extension/ai/runner/processRegistry');
}

function loadThreadStoreModule() {
    return loadModuleWithVscodeStub('../../extension/ai/runner/threadStore') as typeof import('../../extension/ai/runner/threadStore');
}

function loadTurnRunnerModule() {
    return loadModuleWithVscodeStub('../../extension/ai/runner/turnRunner') as typeof import('../../extension/ai/runner/turnRunner');
}

function loadActiveTurnRegistryModule() {
    delete require.cache[require.resolve('../../extension/ai/runner/activeTurnRegistry')];
    return require('../../extension/ai/runner/activeTurnRegistry') as typeof import('../../extension/ai/runner/activeTurnRegistry');
}

function loadAgentRuntimeModule() {
    delete require.cache[require.resolve('../../extension/ai/workspacePaths')];
    delete require.cache[require.resolve('../../extension/ai/runner/goalStore')];
    delete require.cache[require.resolve('../../extension/ai/runner/goalSupervisor')];
    delete require.cache[require.resolve('../../extension/ai/runner/taskManager')];
    return loadModuleWithVscodeStub('../../extension/ai/runner/agentRuntime') as typeof import('../../extension/ai/runner/agentRuntime');
}

function loadChatTopicsModule() {
    return loadModuleWithVscodeStub('../../extension/ai/chatTopics') as typeof import('../../extension/ai/chatTopics');
}

function loadBlackboardModule() {
    delete require.cache[require.resolve('../../extension/ai/orchestrator/blackboard')];
    return require('../../extension/ai/orchestrator/blackboard') as typeof import('../../extension/ai/orchestrator/blackboard');
}

function loadConflictDetectorModule() {
    delete require.cache[require.resolve('../../extension/ai/orchestrator/conflictDetector')];
    return require('../../extension/ai/orchestrator/conflictDetector') as typeof import('../../extension/ai/orchestrator/conflictDetector');
}

function loadModuleWithVscodeStub(request: string): unknown {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, moduleRequest: string, ...args: any[]) {
        if (moduleRequest === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [moduleRequest, ...args]);
    };
    try {
        delete require.cache[require.resolve(request)];
        return require(request);
    } finally {
        moduleLoader._load = originalLoad;
    }
}

async function waitForEvent(
    ledger: typeof import('../../extension/ai/runner/runLedger').runLedger,
    runId: string,
    eventType: string,
): Promise<void> {
    for (let i = 0; i < 40; i++) {
        if (ledger.getSnapshot(runId)?.events.some(event => event.type === eventType)) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    },
    window: {
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};
