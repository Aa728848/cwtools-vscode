import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoopKernel } from '../../extension/ai/runner/loopKernel';
import { OrderedHookSlot } from '../../extension/ai/runner/loopHooks';
import { createStepRequest } from '../../extension/ai/runner/stepRequest';
import { DomainOpRegistry } from '../../extension/ai/runner/state/domainOp';
import { replayDomainOps } from '../../extension/ai/runner/state/domainReplay';
import { DomainJournal } from '../../extension/ai/runner/state/domainJournal';
import { ToolDisclosureService } from '../../extension/ai/runner/toolDisclosure';
import { TOOL_REGISTRY } from '../../extension/ai/tools/registry';
import { TOOL_DEFINITIONS } from '../../extension/ai/tools/definitions';
import {
    filterToolDefinitionsForMode,
    filterToolDefinitionsForStage,
    initialToolStageForMode,
    shouldAutoDiscloseExecutionTools,
} from '../../extension/ai/runnerPolicy';
import { createToolDedupeKey, ToolDedupeService } from '../../extension/ai/runner/toolDedupe';
import { ContextLimitTracker } from '../../extension/ai/runner/contextLimitTracker';
import { ConversationUndoCoordinator } from '../../extension/ai/runner/undoCoordinator';
import { FaultInjector } from '../../extension/ai/runner/faultInjection';
import { SideQuestionService } from '../../extension/ai/runner/sideQuestionService';
import { StepRetryPolicy } from '../../extension/ai/runner/stepRetryPolicy';
import { ModelRequestService } from '../../extension/ai/runner/modelRequestService';
import { ToolExecutionPipeline } from '../../extension/ai/runner/toolExecutionPipeline';
import { migrateLegacyRuntimeState } from '../../extension/ai/runner/state/migrations';
import { projectActivities } from '../../extension/ai/runner/activityProjection';
import { TranscriptStreamBuffer } from '../../extension/ai/runner/transcriptStreamBuffer';

describe('agent runtime kernel', () => {
    it('orders requests deterministically and rejects duplicate ids', async () => {
        const seen: string[] = [];
        const kernel = new AgentLoopKernel({
            execute: async ({ request }) => { seen.push(request.kind); },
        });
        expect(kernel.enqueue(createStepRequest('goal_continuation', {}, { id: 'same', createdAt: 1 }))).to.equal(true);
        expect(kernel.enqueue(createStepRequest('goal_continuation', {}, { id: 'same', createdAt: 2 }))).to.equal(false);
        kernel.enqueue(createStepRequest('steer', {}, { id: 'steer', createdAt: 3 }));
        kernel.enqueue(createStepRequest('tool_result', {}, { id: 'tool', createdAt: 2 }));
        await kernel.runUntilIdle();
        expect(seen).to.deep.equal(['steer', 'tool_result', 'goal_continuation']);
        expect(kernel.status).to.equal('idle');
    });

    it('exposes run, cancellation, settlement, quiescence, and ordered error handling', async () => {
        const seen: string[] = [];
        const kernel = new AgentLoopKernel({
            execute: async ({ request, signal }) => {
                if (request.kind === 'retry') throw new Error('retry');
                if (request.kind === 'continuation') {
                    await new Promise<void>((resolve, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                    });
                }
                seen.push(request.id);
                return request.id;
            },
        });
        kernel.registerErrorHandler('later', () => { seen.push('later'); return 'continue'; }, 2);
        kernel.registerErrorHandler('first', () => { seen.push('first'); return 'continue'; }, 1);
        const failed = kernel.run(createStepRequest('retry', {}, { id: 'failed' })).catch(error => String(error));
        expect(await failed).to.include('retry');
        await kernel.settled();
        expect(seen).to.deep.equal(['first', 'later']);
        expect(kernel.tryAcquireQuiescence()).to.equal(true);

        const hanging = kernel.run(createStepRequest('continuation', {}, { id: 'turn-1' })).catch(error => String(error));
        await Promise.resolve();
        expect(kernel.cancel('turn-1', new Error('cancelled'))).to.equal(true);
        expect(await hanging).to.include('cancelled');
        await kernel.settled();
        expect(kernel.tryAcquireQuiescence()).to.equal(true);

        expect(await kernel.run<string>(createStepRequest('tool_result', {}, { id: 'done' }))).to.equal('done');
    });

    it('runs hooks by order and stable id', async () => {
        const slot = new OrderedHookSlot<string>();
        const seen: string[] = [];
        slot.register({ id: 'z', order: 1, run: value => { seen.push(`z:${value}`); } });
        slot.register({ id: 'a', order: 1, run: value => { seen.push(`a:${value}`); } });
        slot.register({ id: 'first', order: 0, run: value => { seen.push(`first:${value}`); } });
        await slot.run('x');
        expect(seen).to.deep.equal(['first:x', 'a:x', 'z:x']);
    });
});

describe('transcript stream buffering', () => {
    it('coalesces small deltas into bounded journal batches with contiguous offsets', () => {
        const buffer = new TranscriptStreamBuffer(8);
        expect(buffer.append('turn', 'ab', 3)).to.equal(false);
        expect(buffer.append('turn', 'cd', 4)).to.equal(false);
        expect(buffer.append('turn', 'efgh', 5)).to.equal(true);
        expect(buffer.take('turn')).to.deep.equal({
            text: 'abcdefgh',
            offset: 0,
            ordinal: 3,
            initialize: true,
        });

        expect(buffer.append('turn', 'ij', 6)).to.equal(false);
        expect(buffer.take('turn')).to.deep.equal({
            text: 'ij',
            offset: 8,
            ordinal: 6,
            initialize: false,
        });
        expect(buffer.hasStream('turn')).to.equal(true);
    });

    it('keeps turns isolated and drops all buffered state when a turn is cleared', () => {
        const buffer = new TranscriptStreamBuffer(4);
        buffer.append('first', 'abc', 1);
        buffer.append('second', 'xy', 2);
        expect(buffer.pendingTurnIds()).to.deep.equal(['first', 'second']);

        buffer.clear('first');
        expect(buffer.take('first')).to.equal(undefined);
        expect(buffer.hasStream('first')).to.equal(false);
        expect(buffer.take('second')).to.deep.include({ text: 'xy', offset: 0, initialize: true });
    });

    it('reduces provider-sized reasoning deltas to a bounded number of journal batches', () => {
        const buffer = new TranscriptStreamBuffer();
        let batches = 0;
        let persisted = '';
        for (let index = 0; index < 45_000; index++) {
            if (!buffer.append('reasoning-turn', 'x', index)) continue;
            const batch = buffer.take('reasoning-turn');
            expect(batch?.offset).to.equal(persisted.length);
            persisted += batch?.text ?? '';
            batches++;
        }
        const tail = buffer.take('reasoning-turn');
        persisted += tail?.text ?? '';
        if (tail) batches++;

        expect(persisted).to.have.length(45_000);
        expect(batches).to.be.lessThan(24);
        expect(buffer.text('reasoning-turn')).to.equal(persisted);
        expect(buffer.ordinal('reasoning-turn')).to.equal(0);
    });
});

describe('domain replay', () => {
    it('migrates legacy runtime state into valid fail-closed domain models', () => {
        const migrated = migrateLegacyRuntimeState({
            agentId: 'agent',
            mode: 'build',
            schedulingState: { phase: 'execute' },
            context: { toolSchemas: ['b', 'a', 'b'] },
        });
        expect(migrated.models.scheduling).to.deep.equal({
            revision: 0,
            state: { phase: 'execute' },
        });
        expect(migrated.models.context).to.deep.equal({
            revision: 0,
            turns: [],
            toolSchemas: ['a', 'b'],
        });
        expect((migrateLegacyRuntimeState({ agentId: 'agent', schedulingState: 'unsafe' })
            .models.scheduling as { state: unknown }).state).to.equal(null);
    });

    it('replays pure operations deterministically and fails closed on sequence gaps', () => {
        const registry = new DomainOpRegistry();
        registry.register<{ count: number }, { delta: number }>({
            type: 'context.counter.incremented',
            version: 1,
            domain: 'context',
            validatePayload: (value): value is { delta: number } =>
                !!value && typeof value === 'object' && typeof (value as { delta?: unknown }).delta === 'number',
            apply: (state, payload) => ({ count: state.count + payload.delta }),
        });
        const base = { version: 1 as const, agentId: 'a', sequence: 0, models: { context: { count: 0 } } };
        const operations = [{
            type: 'context.counter.incremented',
            version: 1,
            domain: 'context' as const,
            payload: { delta: 2 },
            sequence: 1,
            operationId: 'op-1',
            timestamp: 1,
        }];
        expect(replayDomainOps(base, operations, registry).snapshot.models.context).to.deep.equal({ count: 2 });
        expect(replayDomainOps(base, operations, registry).snapshot).to.deep.equal(
            replayDomainOps(base, operations, registry).snapshot,
        );
        expect(replayDomainOps(base, [{ ...operations[0]!, sequence: 2 }], registry).rejected?.reason)
            .to.equal('Expected sequence 1.');
    });

    it('serializes JSONL appends and truncates a damaged tail', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-domain-journal-'));
        try {
            const journal = new DomainJournal(path.join(root, 'journal.jsonl'));
            await Promise.all([
                journal.append({ type: 'context.one', version: 1, domain: 'context', payload: { value: 1 } }, 1, 'one', 1),
                journal.append({ type: 'context.two', version: 1, domain: 'context', payload: { value: 2 } }, 2, 'two', 2),
            ]);
            fs.appendFileSync(journal.filePath, '{broken');
            const read = journal.read();
            await read.recovery;
            expect(read.truncated).to.equal(true);
            expect(read.operations.map(operation => operation.sequence)).to.deep.equal([1, 2]);
            expect(fs.readFileSync(journal.filePath, 'utf8')).not.to.include('{broken');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('tool disclosure and dedupe', () => {
    it('keeps the initial build schema materially smaller than the eligible tool pool', () => {
        const modeTools = filterToolDefinitionsForMode(TOOL_DEFINITIONS, 'build', { domain: 'paradox' });
        const stageTools = filterToolDefinitionsForStage(
            modeTools,
            'build',
            initialToolStageForMode('build'),
        );
        const initialTools = new ToolDisclosureService().initialTools(stageTools, {
            mode: 'build',
            domain: 'paradox',
            dynamicSupported: true,
            loaded: new Set(),
        });
        const modeBytes = Buffer.byteLength(JSON.stringify(modeTools), 'utf8');
        const initialBytes = Buffer.byteLength(JSON.stringify(initialTools), 'utf8');
        expect(initialTools.length).to.be.lessThan(stageTools.length);
        expect(initialBytes / modeBytes).to.be.lessThan(0.25);
    });

    it('loads deferred schemas without crossing the active domain', () => {
        const service = new ToolDisclosureService();
        const pool = [...TOOL_REGISTRY.values()].map(entry => entry.schema);
        const context = {
            mode: 'utility' as const,
            domain: 'general' as const,
            dynamicSupported: true,
            loaded: new Set<string>(),
        };
        const initial = service.initialTools(pool, context);
        expect(initial.some(tool => tool.function.name === 'run_command')).to.equal(false);
        const selected = service.select({ tools: ['run_command', 'mcp_call'], reason: 'validate' }, pool, context);
        expect(selected.loaded).to.deep.equal(['mcp_call', 'run_command']);
        expect(selected.denied).to.deep.equal([]);
        const mcpTool = {
            type: 'function' as const,
            function: {
                name: 'mcp_demo_lookup',
                description: 'demo',
                parameters: { type: 'object', properties: {} },
            },
        };
        const paradoxContext = {
            mode: 'build' as const,
            domain: 'paradox' as const,
            dynamicSupported: true,
            loaded: new Set<string>(),
        };
        expect(service.initialTools([...pool, mcpTool], paradoxContext).some(tool => tool.function.name === mcpTool.function.name)).to.equal(false);
        expect(service.select({ groups: ['mcp'], reason: 'semantic query' }, [...pool, mcpTool], paradoxContext).loaded)
            .to.include(mcpTool.function.name);
    });

    it('makes critical deferred tools visible for every workspace-write execution surface', () => {
        const service = new ToolDisclosureService();
        const cases = [
            { mode: 'build', domain: 'paradox', stage: 'write', expected: ['write_file', 'edit_file', 'replace_lines'] },
            { mode: 'utility', domain: 'general', stage: 'write', expected: ['write_file', 'edit_file', 'replace_lines', 'run_command', 'dispatch_agents'] },
            { mode: 'gui_expert', domain: 'paradox', stage: undefined, expected: ['write_file', 'edit_file', 'replace_lines', 'run_command', 'dispatch_agents'] },
            { mode: 'loc_translator', domain: 'paradox', stage: undefined, expected: ['write_file', 'git_ops'] },
            { mode: 'loc_writer', domain: 'paradox', stage: undefined, expected: ['write_file', 'git_ops'] },
            { mode: 'orchestrator', domain: 'paradox', stage: undefined, expected: ['write_file', 'git_ops', 'dispatch_agents'] },
            { mode: 'script', domain: 'paradox', stage: undefined, expected: ['write_file', 'git_ops', 'dispatch_agents'] },
        ] as const;

        for (const testCase of cases) {
            const modePool = filterToolDefinitionsForMode(TOOL_DEFINITIONS, testCase.mode, {
                domain: testCase.domain,
            });
            const stagePool = filterToolDefinitionsForStage(modePool, testCase.mode, testCase.stage);
            const context = {
                mode: testCase.mode,
                domain: testCase.domain,
                dynamicSupported: true,
                loaded: new Set<string>(),
            };
            expect(
                shouldAutoDiscloseExecutionTools(testCase.mode, testCase.stage, 'workspace_write'),
                `${testCase.mode} disclosure boundary`,
            ).to.equal(true);
            service.select({
                groups: ['file_write', 'command', 'git', 'media', 'orchestrator'],
                reason: 'runtime-authorized execution surface',
            }, stagePool, context);
            const visible = service.initialTools(stagePool, context).map(tool => tool.function.name);
            expect(visible, testCase.mode).to.include.members(testCase.expected);
            expect(visible, `${testCase.mode}:select_tools`).to.include('select_tools');
        }
    });

    it('canonicalizes arguments and coalesces concurrent read calls only', async () => {
        expect(createToolDedupeKey('read_file', { filePath: 'a\\b', x: 1 }, 'read', 'r1')).to.equal(
            createToolDedupeKey('read_file', { x: 1, filePath: 'a/b' }, 'read', 'r1'),
        );
        const service = new ToolDedupeService();
        let executions = 0;
        const request = {
            toolName: 'read_file',
            args: { filePath: 'a.txt' },
            authorizationScope: 'read',
            targetResourceRevision: '1',
        };
        const [first, second] = await Promise.all([
            service.execute({ ...request, invocationId: 'one' }, async () => { executions += 1; return 'ok'; }),
            service.execute({ ...request, invocationId: 'two' }, async () => { executions += 1; return 'ok'; }),
        ]);
        expect(executions).to.equal(1);
        expect(first.reused).to.equal(false);
        expect(second).to.include({ reused: true, sourceInvocationId: 'one' });
    });
});

describe('runtime recovery helpers', () => {
    it('rebuilds one shared activity snapshot from events and task state', () => {
        const projection = projectActivities({
            tasks: [{
                version: 1,
                taskId: 'task',
                kind: 'background_read',
                status: 'running',
                topicId: 'topic',
                runId: 'run',
                threadId: 'thread',
                outputBytes: 0,
                outputTruncated: false,
                notification: 'pending',
                createdAt: 1,
                updatedAt: 1,
            }],
            events: [
                { eventId: 'created', type: 'run_created', timestamp: 1 },
                { invocationId: 'tool', type: 'tool_call_start', timestamp: 2, payload: { toolName: 'read_file' } },
            ],
        });
        expect(projection.background).to.deep.include({
            taskId: 'task',
            kind: 'background_read',
            status: 'running',
            since: 1,
        });
        expect(projection.turn?.activeToolCalls).to.deep.equal([{ invocationId: 'tool', name: 'read_file' }]);
    });

    it('retries model requests with deterministic classification and bounded input shrinking', async () => {
        const policy = new StepRetryPolicy(3, 1, 2);
        expect(policy.decide({ status: 413 }, 1)).to.include({
            retry: true,
            reason: 'context_overflow',
            shrinkInput: true,
        });
        const attempts: string[] = [];
        const result = await new ModelRequestService().execute(
            'large',
            async ({ request, attempt }) => {
                attempts.push(`${attempt}:${request}`);
                if (attempt === 1) throw Object.assign(new Error('context overflow'), { status: 413 });
                return request;
            },
            {
                retryPolicy: policy,
                delay: async () => undefined,
                shrink: request => request.slice(0, 3),
            },
        );
        expect(result).to.equal('lar');
        expect(attempts).to.deep.equal(['1:large', '2:lar']);
    });

    it('runs the tool pipeline in the fixed fail-closed order', async () => {
        const stages: string[] = [];
        const pipeline = new ToolExecutionPipeline({
            guard: stage => {
                stages.push(stage);
                return { allowed: stage !== 'permission', reason: 'denied' };
            },
            execute: async () => {
                stages.push('actual');
                return { success: true };
            },
        });
        expect(await pipeline.run({ invocationId: 'i', toolName: 'read_file', args: {} })).to.deep.include({
            success: false,
            rejectedAt: 'permission',
        });
        expect(stages).to.deep.equal([
            'parse',
            'registry',
            'scheduling',
            'sandbox',
            'policy',
            'plan_guard',
            'permission',
        ]);
    });

    it('learns a lower context limit after overflow', () => {
        const tracker = new ContextLimitTracker();
        expect(tracker.observeOverflow('p', 'm', 10_000)).to.equal(9_000);
        expect(tracker.get('p', 'm', 20_000, 1_000)).to.deep.equal({
            effectiveLimit: 9_000,
            triggerTokens: 6_000,
            blockTokens: 7_200,
            reservedTokens: 1_000,
        });
    });

    it('coordinates undo in deterministic participant order', async () => {
        const coordinator = new ConversationUndoCoordinator();
        const seen: string[] = [];
        for (const id of ['b', 'a']) coordinator.register({
            id,
            precheck: () => ({ allowed: true }),
            reconcileAfterUndo: async () => { seen.push(id); },
        });
        const result = await coordinator.undo(
            { topicId: 't', threadId: 't', turnId: 'turn', sequence: 2 },
            async () => { seen.push('cut'); },
        );
        expect(result).to.deep.equal({ applied: true, needsAttention: [] });
        expect(seen).to.deep.equal(['cut', 'a', 'b']);
    });

    it('injects deterministic faults only when enabled', async () => {
        await new FaultInjector(false, [{ point: 'before_model', occurrence: 1, action: 'throw' }]).hit('before_model');
        let thrown: unknown;
        try {
            await new FaultInjector(true, [{ point: 'before_model', occurrence: 1, action: 'throw' }]).hit('before_model');
        } catch (error) {
            thrown = error;
        }
        expect(thrown).to.be.instanceOf(Error);
    });

    it('keeps side-question answers bound to their stable snapshot', () => {
        const service = new SideQuestionService();
        const question = service.start('run', 'thread', 'why?', 1);
        expect(service.complete(question.id, 'because', 2).status).to.equal('complete');
        expect(service.asStepMessage(question.id)?.content).to.include('because');
    });
});
