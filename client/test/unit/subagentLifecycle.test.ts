/**
 * Sub-agent lifecycle regressions for the DSH-inspired improvements:
 *
 * 1. Monotone delegation-depth budget (a resumed coordinator cannot buy itself
 *    another delegation level).
 * 2. Delegated-scope statement injected into a child's system prompt.
 * 3. Context-preserving clarification resume (node fields survive persistence;
 *    the one-wave answer never does).
 * 4. Orchestration catalog projection and its explicit state wording.
 * 5. Background settlement notice always carrying a stop reason and whatever
 *    content was preserved.
 */

import { expect } from 'chai';
import { GENERAL_PARALLEL } from './schedulingFixtures';

const ORCHESTRATOR_OPTIONS = { schedulingState: GENERAL_PARALLEL };

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    commands: { executeCommand: async () => undefined },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

const moduleLoader = require('module') as { _load: (...args: any[]) => any };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.apply(this, [request, ...args]);
};

// ── 1. Delegation depth ──────────────────────────────────────────────────────

describe('delegationDepth', () => {
    let mod: typeof import('../../extension/ai/orchestrator/delegationDepth');

    before(() => {
        mod = require('../../extension/ai/orchestrator/delegationDepth');
    });

    it('normalizeDelegationDepth: 缺失或非法值都视为顶层 0', () => {
        expect(mod.normalizeDelegationDepth(undefined)).to.equal(0);
        expect(mod.normalizeDelegationDepth(null)).to.equal(0);
        expect(mod.normalizeDelegationDepth('2')).to.equal(0);
        expect(mod.normalizeDelegationDepth(-1)).to.equal(0);
        expect(mod.normalizeDelegationDepth(1.5)).to.equal(0);
        expect(mod.normalizeDelegationDepth(3)).to.equal(3);
    });

    it('monotoneDelegationDepth: 持久化下界只能加深，不能降低', () => {
        // The whole point: a resumed child arrives with fresh runtime options.
        expect(mod.monotoneDelegationDepth(0, 1)).to.equal(1);
        expect(mod.monotoneDelegationDepth(undefined, 2)).to.equal(2);
        expect(mod.monotoneDelegationDepth(3, 1)).to.equal(3);
        expect(mod.monotoneDelegationDepth('bad', 'worse')).to.equal(0);
    });

    it('resolveMaxDelegationDepth: 默认 1，非法回落默认，超限收敛到上限', () => {
        expect(mod.resolveMaxDelegationDepth(undefined)).to.equal(mod.DEFAULT_MAX_DELEGATION_DEPTH);
        expect(mod.resolveMaxDelegationDepth(mod.DEFAULT_MAX_DELEGATION_DEPTH)).to.equal(1);
        expect(mod.resolveMaxDelegationDepth('2')).to.equal(1);
        expect(mod.resolveMaxDelegationDepth(-4)).to.equal(1);
        expect(mod.resolveMaxDelegationDepth(0)).to.equal(0);
        expect(mod.resolveMaxDelegationDepth(999)).to.equal(mod.MAX_CONFIGURABLE_DELEGATION_DEPTH);
    });

    it('assertDelegationDepth: 只接受 undefined 与非负安全整数', () => {
        expect(() => mod.assertDelegationDepth(undefined)).to.not.throw();
        expect(() => mod.assertDelegationDepth(0)).to.not.throw();
        expect(() => mod.assertDelegationDepth(3)).to.not.throw();
        expect(() => mod.assertDelegationDepth(-1)).to.throw(/non-negative safe integer/);
        expect(() => mod.assertDelegationDepth(1.5)).to.throw(/non-negative safe integer/);
        expect(() => mod.assertDelegationDepth('1')).to.throw(/non-negative safe integer/);
    });

    it('evaluateDelegationBudget: 顶层放行一层子代理', () => {
        const decision = mod.evaluateDelegationBudget({ parentDepth: 0 });
        expect(decision.allowed).to.equal(true);
        expect(decision.parentDepth).to.equal(0);
        expect(decision.childDepth).to.equal(1);
        expect(decision.maxDepth).to.equal(1);
        expect(decision.reason).to.equal(undefined);
    });

    it('evaluateDelegationBudget: 子代理不得再派发（孙代理会绕过写作用域裁剪）', () => {
        const decision = mod.evaluateDelegationBudget({ parentDepth: 1 });
        expect(decision.allowed).to.equal(false);
        expect(decision.childDepth).to.equal(2);
        expect(decision.reason).to.match(/depth budget exhausted/i);
    });

    it('evaluateDelegationBudget: 持久化下界阻止 resume 后被重新算作顶层', () => {
        // Runtime says "I am top level"; the stored graph says otherwise.
        const decision = mod.evaluateDelegationBudget({ parentDepth: 0, persistedFloor: 1 });
        expect(decision.allowed).to.equal(false);
        expect(decision.parentDepth).to.equal(1);
    });

    it('evaluateDelegationBudget: maxDepth 0 完全禁止委派', () => {
        const decision = mod.evaluateDelegationBudget({ parentDepth: 0, maxDepth: 0 });
        expect(decision.allowed).to.equal(false);
        expect(decision.reason).to.match(/Delegation is disabled/i);
    });

    it('evaluateDelegationBudget: 放宽到 2 层后子代理可再派发一层', () => {
        const decision = mod.evaluateDelegationBudget({ parentDepth: 1, maxDepth: 2 });
        expect(decision.allowed).to.equal(true);
        expect(decision.childDepth).to.equal(2);
    });
});

// ── 2. Delegated-scope statement ─────────────────────────────────────────────

describe('buildDelegationScopeStatement', () => {
    let build: typeof import('../../extension/ai/prompt/sections/delegationScope').buildDelegationScopeStatement;

    before(() => {
        build = require('../../extension/ai/prompt/sections/delegationScope').buildDelegationScopeStatement;
    });

    it('非委派运行不注入任何内容（配额与前缀缓存都不受影响）', () => {
        expect(build(undefined)).to.equal('');
    });

    it('只读角色明确说明所有写工具都已收回', () => {
        const text = build({ readOnly: true, writeScope: [] });
        expect(text).to.match(/read-only/i);
        expect(text).to.not.match(/You may write only inside:/);
    });

    it('可写角色列出写作用域，去重且排序', () => {
        const text = build({ writeScope: ['events/b.txt', 'events/a.txt', 'events/a.txt'] });
        expect(text).to.include('events/a.txt, events/b.txt');
    });

    it('超过上限的作用域折叠为 (+N more)，避免撑爆 system prompt', () => {
        const scopes = Array.from({ length: 20 }, (_, index) => `common/f${String(index).padStart(2, '0')}.txt`);
        const text = build({ writeScope: scopes });
        expect(text).to.include('(+8 more)');
    });

    it('用户保留的作用域与被丢弃的越界目标都显式告知子代理', () => {
        const text = build({
            writeScope: ['events/a.txt'],
            deniedWriteScopes: ['localisation'],
            rejectedScopes: ['../outside/x.txt'],
        });
        expect(text).to.include('localisation');
        expect(text).to.include('../outside/x.txt');
        expect(text).to.match(/outside the parent's writable roots/);
    });

    it('始终包含「不要重试 + 写进 Unresolved」这条止损指令', () => {
        const text = build({ readOnly: true, writeScope: [] });
        expect(text).to.match(/Do not retry an operation the host denied/);
        expect(text).to.include('`Unresolved`');
        expect(text).to.include('BLOCKED_FOR_ORCHESTRATOR');
    });

    it('相同输入产生完全相同的文本（system prompt 必须前缀稳定）', () => {
        const facts = { writeScope: ['b', 'a'], deniedWriteScopes: ['localisation'] };
        expect(build(facts)).to.equal(build({ ...facts }));
    });
});

// ── 3. Clarification resume metadata ─────────────────────────────────────────

describe('orchestration store — clarification resume metadata', () => {
    let store: typeof import('../../extension/ai/orchestrator/orchestrationStore');
    type TaskGraph = import('../../extension/ai/orchestrator/types').TaskGraph;
    type TaskNode = import('../../extension/ai/orchestrator/types').TaskNode;

    before(() => {
        store = require('../../extension/ai/orchestrator/orchestrationStore');
    });

    const nodeWith = (overrides: Partial<TaskNode>): TaskNode => ({
        id: 'explore_events',
        agentType: 'explore',
        prompt: 'scan events',
        dependencies: [],
        priority: 'normal',
        status: 'failed',
        retryCount: 0,
        maxRetries: 1,
        ...overrides,
    });

    const graphWith = (node: TaskNode): TaskGraph => ({
        id: 'graph_1',
        nodes: new Map([[node.id, node]]),
        metadata: { userPrompt: 'demo', createdAt: 1 },
    });

    it('resumeContextRef 与 pendingClarification 跨持久化保留', () => {
        const graph = graphWith(nodeWith({
            resumeContextRef: 'run_42',
            pendingClarification: 'Which namespace should the event use?',
        }));
        const restored = store.deserializeGraph(store.serializeGraph(graph));
        const node = restored.nodes.get('explore_events')!;
        expect(node.resumeContextRef).to.equal('run_42');
        expect(node.pendingClarification).to.equal('Which namespace should the event use?');
    });

    it('resumeAnswer 绝不持久化：重放已结案的答复会再答一次', () => {
        const graph = graphWith(nodeWith({ resumeContextRef: 'run_42', resumeAnswer: 'use namespace foo' }));
        const stored = store.serializeGraph(graph);
        expect(Object.keys(stored.nodes[0]!)).to.not.include('resumeAnswer');
        const restored = store.deserializeGraph(stored);
        expect(restored.nodes.get('explore_events')!.resumeAnswer).to.equal(undefined);
    });

    it('pendingClarification 有长度上界，不会把整段追问写进快照', () => {
        const graph = graphWith(nodeWith({ pendingClarification: 'x'.repeat(20_000) }));
        const stored = store.serializeGraph(graph);
        expect(stored.nodes[0]!.pendingClarification!.length).to.be.lessThan(20_000);
    });
});

// ── 4. Orchestration catalog ─────────────────────────────────────────────────

describe('buildOrchestrationCatalog', () => {
    let build: typeof import('../../extension/ai/orchestrator/orchestrationCatalog').buildOrchestrationCatalog;
    type StoredOrchestration = import('../../extension/ai/orchestrator/orchestrationStore').StoredOrchestration;

    before(() => {
        build = require('../../extension/ai/orchestrator/orchestrationCatalog').buildOrchestrationCatalog;
    });

    const record = (overrides: Partial<StoredOrchestration> = {}): StoredOrchestration => ({
        version: 2,
        graphId: 'graph_a',
        topicId: 'topic_1',
        runId: 'run_1',
        domain: 'paradox',
        graph: {
            id: 'graph_a',
            userPrompt: 'demo',
            createdAt: 1,
            nodes: [
                {
                    id: 'n1', agentType: 'explore', prompt: 'p', dependencies: [],
                    priority: 'normal', status: 'done', retryCount: 0, maxRetries: 1,
                },
                {
                    id: 'n2', agentType: 'build', prompt: 'p', dependencies: [],
                    priority: 'normal', status: 'failed', retryCount: 0, maxRetries: 1,
                    pendingClarification: 'Which namespace?', resumeContextRef: 'run_9',
                },
            ],
        },
        agentResults: {
            n1: {
                nodeId: 'n1', success: true, output: 'done',
                tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
                writtenFiles: [], stepCount: 1,
            },
        },
        blackboard: { entries: [], timestamp: 1 },
        summary: 'partial wave',
        totalTokenUsage: { total: 120, input: 100, output: 20, estimatedCostCny: 0.01 },
        complete: false,
        createdAt: 1,
        updatedAt: 1_700_000_000_000,
        ...overrides,
    });

    it('空目录也给出可执行的下一步，而不是一句错误', () => {
        const catalog = build([], () => false, { domain: 'paradox' });
        expect(catalog.success).to.equal(true);
        expect(catalog.graphCount).to.equal(0);
        expect(catalog.hint).to.match(/dispatch_agents/);
    });

    it('未完成的图标为 resumable，并显式声明它不是终态、也不是待收取的结果', () => {
        const catalog = build([record()], () => false, { topicId: 'topic_1', domain: 'paradox' });
        const entry = catalog.graphs[0]!;
        expect(entry.state).to.equal('resumable');
        expect(entry.canResume).to.equal(true);
        expect(entry.canMerge).to.equal(true);
        expect(entry.stateMeaning).to.match(/NOT terminal and NOT a result waiting to be collected/);
    });

    it('节点状态计数与待澄清项（含上下文是否保留）逐条暴露', () => {
        const catalog = build([record()], () => false, { domain: 'paradox' });
        const entry = catalog.graphs[0]!;
        expect(entry.nodeStatusCounts.done).to.equal(1);
        expect(entry.nodeStatusCounts.failed).to.equal(1);
        expect(entry.nodes).to.deep.equal([
            { id: 'n1', status: 'done', hasResult: true },
            { id: 'n2', status: 'failed', hasResult: false },
        ]);
        expect(entry.pendingClarifications).to.have.length(1);
        expect(entry.pendingClarifications![0]!.nodeId).to.equal('n2');
        expect(entry.pendingClarifications![0]!.contextPreserved).to.equal(true);
    });

    it('后台仍在跑的图既不能 resume 也不能 merge', () => {
        const catalog = build([record()], graphId => graphId === 'graph_a', { domain: 'paradox' });
        const entry = catalog.graphs[0]!;
        expect(entry.state).to.equal('running_in_background');
        expect(entry.canResume).to.equal(false);
        expect(entry.canMerge).to.equal(false);
    });

    it('已完成的图标为 complete 且只能 merge', () => {
        const catalog = build([record({ complete: true })], () => false, { domain: 'paradox' });
        const entry = catalog.graphs[0]!;
        expect(entry.state).to.equal('complete');
        expect(entry.canResume).to.equal(false);
        expect(entry.canMerge).to.equal(true);
    });
});

// ── 5. Background settlement notice ──────────────────────────────────────────

describe('formatBackgroundTaskNotice', () => {
    let format: typeof import('../../extension/ai/runner/backgroundTaskNotice').formatBackgroundTaskNotice;

    before(() => {
        format = require('../../extension/ai/runner/backgroundTaskNotice').formatBackgroundTaskNotice;
    });

    it('成功结算：状态 + stop reason + 摘要', () => {
        const text = format({
            taskId: 't1', status: 'completed', stopReason: 'completed', resultSummary: 'wrote 3 files',
        });
        expect(text).to.include('[BACKGROUND TASK RESULT]');
        expect(text).to.include('Status: completed');
        expect(text).to.include('Stop reason: completed');
        expect(text).to.include('Summary: wrote 3 files');
    });

    it('失败但有保留输出：保留内容单独成段，不被 failed 状态吞掉', () => {
        const text = format({
            taskId: 't2',
            status: 'failed',
            stopReason: 'idle_timeout',
            resultSummary: 'Sub-Agent idle timeout exceeded',
            lastMessage: 'Summary: found 12 candidate events; stopped before writing',
        });
        expect(text).to.include('Stop reason: idle_timeout');
        expect(text).to.include('Preserved final message from the sub-agent:');
        expect(text).to.include('found 12 candidate events');
    });

    it('保留内容与摘要相同时不重复输出', () => {
        const text = format({ taskId: 't3', status: 'failed', resultSummary: 'same', lastMessage: 'same' });
        expect(text).to.not.include('Preserved final message');
        expect(text.match(/same/g)).to.have.length(1);
    });

    it('子代理什么都没留下时，明确劝阻原样重派', () => {
        const text = format({ taskId: 't4', status: 'lost', stopReason: 'host_restart' });
        expect(text).to.include('Stop reason: host_restart');
        expect(text).to.match(/before re-dispatching identical work/);
    });

    it('outputRef 存在时给出完整输出位置', () => {
        const text = format({ taskId: 't5', status: 'completed', outputRef: 'C:/tmp/t5.log' });
        expect(text).to.include('Full output: C:/tmp/t5.log');
    });
});

// ── 7. Resumed-graph normalization ───────────────────────────────────────────

describe('normalizeResumedGraph', () => {
    let normalize: typeof import('../../extension/ai/orchestrator/resumeNormalization').normalizeResumedGraph;
    type TaskGraph = import('../../extension/ai/orchestrator/types').TaskGraph;
    type TaskNode = import('../../extension/ai/orchestrator/types').TaskNode;

    before(() => {
        normalize = require('../../extension/ai/orchestrator/resumeNormalization').normalizeResumedGraph;
    });

    const node = (id: string, status: TaskNode['status'], overrides: Partial<TaskNode> = {}): TaskNode => ({
        id,
        agentType: 'explore',
        prompt: id,
        dependencies: [],
        priority: 'normal',
        status,
        retryCount: 2,
        error: 'previous failure',
        maxRetries: 1,
        ...overrides,
    });

    const graph = (nodes: TaskNode[]): TaskGraph => ({
        id: 'g',
        nodes: new Map(nodes.map(n => [n.id, n])),
        metadata: { userPrompt: 'demo', createdAt: 1 },
    });

    it('failed/cancelled 节点重新入队并清除错误与重试计数（既有行为）', () => {
        const g = graph([node('failed_a', 'failed'), node('cancelled_b', 'cancelled')]);
        const summary = normalize(g);
        expect(g.nodes.get('failed_a')!.status).to.equal('pending');
        expect(g.nodes.get('failed_a')!.error).to.equal(undefined);
        expect(g.nodes.get('failed_a')!.retryCount).to.equal(0);
        expect(summary.resetFailed).to.deep.equal(['failed_a']);
        expect(summary.resetCancelled).to.deep.equal(['cancelled_b']);
    });

    it('running 节点也重新入队：波中途抛出后被持久化的节点不再死锁', () => {
        // This is the wave-threw-mid-flight shape: a live graph reference was
        // persisted by the dispatch catch, so in-flight nodes stayed `running`.
        // Without the reset they never schedule again — getReadyNodes only
        // accepts `pending`.
        const g = graph([node('interrupted', 'running')]);
        const summary = normalize(g);
        expect(g.nodes.get('interrupted')!.status).to.equal('pending');
        expect(summary.resetRunning).to.deep.equal(['interrupted']);
        expect(summary.changed).to.equal(true);
    });

    it('done 节点不受影响：已完成的工作绝不重跑', () => {
        const g = graph([
            node('done_a', 'done', { resumeContextRef: 'run_1' }),
            node('running_b', 'running'),
        ]);
        const summary = normalize(g);
        expect(g.nodes.get('done_a')!.status).to.equal('done');
        expect(g.nodes.get('done_a')!.resumeContextRef).to.equal('run_1');
        expect(summary.resetRunning).to.deep.equal(['running_b']);
    });

    it('恢复元数据原样保留：澄清恢复依赖 resumeContextRef 与 pendingClarification', () => {
        const g = graph([node('asker', 'failed', {
            resumeContextRef: 'run_42',
            pendingClarification: 'Which namespace?',
        })]);
        normalize(g);
        const resumed = g.nodes.get('asker')!;
        expect(resumed.status).to.equal('pending');
        expect(resumed.resumeContextRef).to.equal('run_42');
        expect(resumed.pendingClarification).to.equal('Which namespace?');
    });

    it('无任何待重排队列的图返回 changed=false', () => {
        const g = graph([node('done_a', 'done'), node('pending_b', 'pending')]);
        const summary = normalize(g);
        expect(summary.changed).to.equal(false);
        expect(g.nodes.get('pending_b')!.status).to.equal('pending');
    });
});


// ── 6. Executor-level resume bookkeeping ─────────────────────────────────────

describe('ParallelExecutor — clarification resume bookkeeping', () => {
    let ParallelExecutor: typeof import('../../extension/ai/orchestrator/parallelExecutor').ParallelExecutor;
    let TaskGraphEngine: typeof import('../../extension/ai/orchestrator/taskGraphEngine').TaskGraphEngine;
    let Blackboard: typeof import('../../extension/ai/orchestrator/blackboard').Blackboard;
    type SubAgentResult = import('../../extension/ai/orchestrator/types').SubAgentResult;

    before(() => {
        ParallelExecutor = require('../../extension/ai/orchestrator/parallelExecutor').ParallelExecutor;
        TaskGraphEngine = require('../../extension/ai/orchestrator/taskGraphEngine').TaskGraphEngine;
        Blackboard = require('../../extension/ai/orchestrator/blackboard').Blackboard;
    });

    const baseResult = (nodeId: string, overrides: Partial<SubAgentResult> = {}): SubAgentResult => ({
        nodeId,
        success: true,
        output: 'done',
        tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
        writtenFiles: [],
        stepCount: 1,
        ...overrides,
    });

    it('澄清结果记录 resumeContextRef 与问题，供下一波恢复', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('clarification anchor');
        TaskGraphEngine.addNode(graph, 'A', 'explore', 'scan');

        await executor.executeGraph(graph, new Blackboard(), async () => baseResult('A', {
            success: false,
            output: 'Which namespace?',
            error: 'SUB_AGENT_NEEDS_CLARIFICATION: Which namespace?',
            needsClarification: true,
            clarification: 'Which namespace?',
            runId: 'run_77',
        }), ORCHESTRATOR_OPTIONS);

        const node = graph.nodes.get('A')!;
        expect(node.resumeContextRef).to.equal('run_77');
        expect(node.pendingClarification).to.equal('Which namespace?');
    });

    it('成功结算清空恢复元数据，避免下一波误用陈旧上下文', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('anchor cleared on success');
        TaskGraphEngine.addNode(graph, 'A', 'explore', 'scan');
        const node = graph.nodes.get('A')!;
        node.resumeContextRef = 'stale_run';
        node.pendingClarification = 'stale question';

        await executor.executeGraph(graph, new Blackboard(), async () => baseResult('A'), ORCHESTRATOR_OPTIONS);

        expect(node.resumeContextRef).to.equal(undefined);
        expect(node.pendingClarification).to.equal(undefined);
    });

    it('resumeAnswer 只对本波有效：子代理拿到它，节点上随即清空', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('one-wave answer');
        TaskGraphEngine.addNode(graph, 'A', 'explore', 'scan');
        const node = graph.nodes.get('A')!;
        node.resumeContextRef = 'run_5';
        node.resumeAnswer = 'use namespace foo';

        let seenByChild: string | undefined;
        await executor.executeGraph(graph, new Blackboard(), async executionNode => {
            seenByChild = executionNode.resumeAnswer;
            return baseResult('A');
        }, ORCHESTRATOR_OPTIONS);

        expect(seenByChild).to.equal('use namespace foo');
        expect(node.resumeAnswer).to.equal(undefined);
    });
});
