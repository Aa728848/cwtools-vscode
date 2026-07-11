/** 
* Multi-Agent coordinator module - unit testing 
* 
* Covers Blackboard, TaskGraphEngine, ConflictDetector, QualityGate, AgentRegistry. 
* Use ts-mocha + chai to be consistent with the existing testing style of the project. 
*/

import { expect } from 'chai';

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    commands: {
        executeCommand: async () => undefined,
    },
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

// ── Blackboard ────────────────────────────────────────────────────────────────

describe('Blackboard', () => {
    let Blackboard: typeof import('../../extension/ai/orchestrator/blackboard').Blackboard;

    before(() => {
        Blackboard = require('../../extension/ai/orchestrator/blackboard').Blackboard;
    });

    it('write + read: 基本存取', () => {
        const bb = new Blackboard();
        bb.write('test:key1', 'hello', 'free_text', 'agent-1');
        const entry = bb.read('test:key1');
        expect(entry).to.exist;
        expect(entry!.value).to.equal('hello');
        expect(entry!.type).to.equal('free_text');
        expect(entry!.version).to.equal(1);
        expect(entry!.authorAgentId).to.equal('agent-1');
    });

    it('write: 版本号自增', () => {
        const bb = new Blackboard();
        bb.write('k', 'v1', 'free_text', 'a');
        bb.write('k', 'v2', 'free_text', 'a');
        const entry = bb.read('k');
        expect(entry!.version).to.equal(2);
        expect(entry!.value).to.equal('v2');
    });

    it('write: CAS — 版本匹配时成功', () => {
        const bb = new Blackboard();
        bb.write('cas', 'v1', 'free_text', 'a');
        const result = bb.write('cas', 'v2', 'free_text', 'b', 1);
        expect(result.success).to.be.true;
        expect(bb.read('cas')!.value).to.equal('v2');
    });

    it('write: CAS — 版本不匹配时失败', () => {
        const bb = new Blackboard();
        bb.write('cas', 'v1', 'free_text', 'a');
        bb.write('cas', 'v2', 'free_text', 'a'); // version=2
        const result = bb.write('cas', 'v3', 'free_text', 'b', 1);
        expect(result.success).to.be.false;
        expect(result.conflict).to.be.a('string');
        expect(bb.read('cas')!.value).to.equal('v2'); // not changed
    });

    it('queryByPrefix: 前缀查询', () => {
        const bb = new Blackboard();
        bb.write('entity:ship', 'ship_data', 'entity_registry', 'a');
        bb.write('entity:planet', 'planet_data', 'entity_registry', 'a');
        bb.write('file:main.txt', 'content', 'file_snapshot', 'b');
        const results = bb.queryByPrefix('entity:');
        expect(results).to.have.length(2);
        expect(results.every(r => r.key.startsWith('entity:'))).to.be.true;
    });

    it('queryByType: 类型过滤', () => {
        const bb = new Blackboard();
        bb.write('a', 'x', 'file_snapshot', 'p');
        bb.write('b', 'y', 'scope_info', 'p');
        bb.write('c', 'z', 'file_snapshot', 'p');
        const results = bb.queryByType('file_snapshot');
        expect(results).to.have.length(2);
    });

    it('watch: 前缀订阅回调', () => {
        const bb = new Blackboard();
        const received: string[] = [];
        bb.watch('event:', (entry) => { received.push(`${entry.key}=${entry.value}`); });
        bb.write('event:created', '1', 'free_text', 'a');
        bb.write('other:key', '2', 'free_text', 'a');
        bb.write('event:updated', '3', 'free_text', 'a');
        expect(received).to.deep.equal(['event:created=1', 'event:updated=3']);
    });

    it('delete: 删除条目', () => {
        const bb = new Blackboard();
        bb.write('del', 'v', 'free_text', 'a');
        expect(bb.read('del')).to.exist;
        bb.delete('del');
        expect(bb.read('del')).to.be.undefined;
    });

    it('clear: 清空所有条目', () => {
        const bb = new Blackboard();
        bb.write('a', 'x', 'free_text', 'p');
        bb.write('b', 'y', 'free_text', 'p');
        bb.clear();
        expect(bb.size).to.equal(0);
    });

    it('search: 模糊搜索 key 和 value', () => {
        const bb = new Blackboard();
        bb.write('ship_data', 'corvette class', 'free_text', 'p');
        bb.write('planet_data', 'continental', 'free_text', 'p');
        const results = bb.search('corvette');
        expect(results).to.have.length(1);
        expect(results[0]!.key).to.equal('ship_data');
    });

    it('readValue: 便捷读取值', () => {
        const bb = new Blackboard();
        bb.write('key1', 'val1', 'free_text', 'a');
        expect(bb.readValue('key1')).to.equal('val1');
        expect(bb.readValue('nonexistent')).to.be.undefined;
    });

    it('snapshot + restore: 序列化 / 反序列化', () => {
        const bb = new Blackboard();
        bb.write('snap1', 'data1', 'free_text', 'a');
        bb.write('snap2', 'data2', 'scope_info', 'b');
        const snapshot = bb.snapshot();
        const bb2 = new Blackboard();
        bb2.restore(snapshot);
        expect(bb2.readValue('snap1')).to.equal('data1');
        expect(bb2.readValue('snap2')).to.equal('data2');
        expect(bb2.size).to.equal(2);
    });

    // ── Compatibility layer testing ──
    it('legacySet + legacyGet: 兼容旧 API', () => {
        const bb = new Blackboard();
        bb.legacySet('old_key', 'old_value');
        const result = bb.legacyGet('old_key');
        expect(result.found).to.be.true;
        expect(result.value).to.equal('old_value');
    });

    it('legacyGet: 不存在的 key', () => {
        const bb = new Blackboard();
        const result = bb.legacyGet('nonexistent');
        expect(result.found).to.be.false;
    });

    it('legacySearch: 关键词搜索', () => {
        const bb = new Blackboard();
        bb.legacySet('ship_data', 'corvette class');
        bb.legacySet('planet_data', 'continental world');
        bb.legacySet('fleet_info', 'corvette fleet');
        const result = bb.legacySearch('corvette');
        expect(result.found).to.be.true;
        expect(result.count).to.equal(2);
    });

    it('clearAgent: 清除指定 Agent 的所有条目', () => {
        const bb = new Blackboard();
        bb.write('x1', 'v', 'free_text', 'agent-A');
        bb.write('x2', 'v', 'free_text', 'agent-A');
        bb.write('x3', 'v', 'free_text', 'agent-B');
        const removed = bb.clearAgent('agent-A');
        expect(removed).to.equal(2);
        expect(bb.size).to.equal(1);
        expect(bb.read('x3')).to.exist;
    });
});

// ── TaskGraphEngine ───────────────────────────────────────────────────────────

describe('TaskGraphEngine', () => {
    let TaskGraphEngine: typeof import('../../extension/ai/orchestrator/taskGraphEngine').TaskGraphEngine;
    type TaskGraph = import('../../extension/ai/orchestrator/types').TaskGraph;
    type TaskNode = import('../../extension/ai/orchestrator/types').TaskNode;

    before(() => {
        TaskGraphEngine = require('../../extension/ai/orchestrator/taskGraphEngine').TaskGraphEngine;
    });

    /** Create a simple diamond-shaped DAG: A → (B, C) → D */
    function makeGraph(): TaskGraph {
        const graph = TaskGraphEngine.createGraph('test');
        TaskGraphEngine.addNode(graph, 'A', 'explore', 'explore');
        TaskGraphEngine.addNode(graph, 'B', 'build', 'build 1', { dependencies: ['A'] });
        TaskGraphEngine.addNode(graph, 'C', 'build', 'build 2', { dependencies: ['A'] });
        TaskGraphEngine.addNode(graph, 'D', 'review', 'review', { dependencies: ['B', 'C'] });
        return graph;
    }

    it('topologicalSort: 正确的层级排列', () => {
        const engine = new TaskGraphEngine();
        const graph = makeGraph();
        const layers = engine.topologicalSort(graph);
        expect(layers).to.have.length(3);
        expect(layers[0]!.map(n => n.id)).to.deep.equal(['A']);
        expect(layers[1]!.map(n => n.id).sort()).to.deep.equal(['B', 'C']);
        expect(layers[2]!.map(n => n.id)).to.deep.equal(['D']);
    });

    it('getReadyNodes: 返回依赖全部完成的 pending 节点', () => {
        const engine = new TaskGraphEngine();
        const graph = makeGraph();
        //In the initial state, only A is ready
        let ready = engine.getReadyNodes(graph);
        expect(ready.map(n => n.id)).to.deep.equal(['A']);
        //Complete A
        engine.markComplete(graph, 'A', 'done');
        ready = engine.getReadyNodes(graph);
        expect(ready.map(n => n.id).sort()).to.deep.equal(['B', 'C']);
    });

    it('markFailed + 级联取消', () => {
        const engine = new TaskGraphEngine();
        const graph = makeGraph();
        engine.markComplete(graph, 'A', 'done'); // A done
        engine.markRunning(graph, 'B');
        const cancelled = engine.markFailed(graph, 'B', 'timeout');
        // If B fails, D should be cascaded and canceled (depending on B)
        expect(graph.nodes.get('B')!.status).to.equal('failed');
        expect(cancelled).to.include('D');
        expect(graph.nodes.get('D')!.status).to.equal('cancelled');
        // C is not affected
        expect(graph.nodes.get('C')!.status).to.equal('pending');
    });

    it('detectCycles: 无环返回 null', () => {
        const engine = new TaskGraphEngine();
        const graph = makeGraph();
        expect(engine.detectCycles(graph)).to.be.null;
    });

    it('detectCycles: 有环返回路径', () => {
        const engine = new TaskGraphEngine();
        const graph = TaskGraphEngine.createGraph('cycle test');
        // Manually create the ring: X → Y → Z → X
        const makeNode = (id: string, deps: string[]): TaskNode => ({
            id, agentType: 'explore', prompt: '', dependencies: deps,
            status: 'pending', priority: 'normal', retryCount: 0, maxRetries: 1,
        });
        graph.nodes.set('X', makeNode('X', ['Z']));
        graph.nodes.set('Y', makeNode('Y', ['X']));
        graph.nodes.set('Z', makeNode('Z', ['Y']));
        const cycle = engine.detectCycles(graph);
        expect(cycle).to.not.be.null;
        expect(cycle!.length).to.be.greaterThan(0);
    });

    it('isComplete: 全部完成时返回 true', () => {
        const engine = new TaskGraphEngine();
        const graph = makeGraph();
        engine.markComplete(graph, 'A', 'ok');
        engine.markComplete(graph, 'B', 'ok');
        engine.markComplete(graph, 'C', 'ok');
        engine.markComplete(graph, 'D', 'ok');
        expect(engine.isComplete(graph)).to.be.true;
    });

    it('isComplete: 有 pending 时返回 false', () => {
        const engine = new TaskGraphEngine();
        const graph = makeGraph();
        engine.markComplete(graph, 'A', 'ok');
        expect(engine.isComplete(graph)).to.be.false;
    });

    it('getProgressSummary: 各状态计数', () => {
        const engine = new TaskGraphEngine();
        const graph = makeGraph();
        engine.markComplete(graph, 'A', 'ok');
        engine.markRunning(graph, 'B');
        const summary = engine.getProgressSummary(graph);
        expect(summary.total).to.equal(4);
        expect(summary.done).to.equal(1);
        expect(summary.running).to.equal(1);
        expect(summary.pending).to.equal(2);
    });

    it('addNode: stores planned write targets for conflict-aware scheduling', () => {
        const graph = TaskGraphEngine.createGraph('planned targets');
        const node = TaskGraphEngine.addNode(graph, 'A', 'build', 'build', {
            plannedFiles: ['events/shared.txt'],
            plannedEntities: ['event:foo.1'],
        });

        expect(node.plannedFiles).to.deep.equal(['events/shared.txt']);
        expect(node.plannedEntities).to.deep.equal(['event:foo.1']);
    });

    it('linkEntityDependencies: derives producer-consumer ordering', () => {
        const graph = TaskGraphEngine.createGraph('entity data flow');
        TaskGraphEngine.addNode(graph, 'build_effect', 'build', 'build effect', {
            produces: [{ kind: 'scripted_effect', id: 'foo_create', operation: 'define' }],
        });
        const consumer = TaskGraphEngine.addNode(graph, 'build_event', 'build', 'build event', {
            consumes: [{ kind: 'scripted_effect', id: 'foo_create', operation: 'call' }],
        });

        TaskGraphEngine.linkEntityDependencies(graph);

        expect(consumer.dependencies).to.deep.equal(['build_effect']);
        expect(graph.nodes.get('build_effect')?.plannedEntities).to.include('scripted_effect:foo_create');
    });
});

// ── ConflictDetector ──────────────────────────────────────────────────────────

describe('ConflictDetector', () => {
    let ConflictDetector: typeof import('../../extension/ai/orchestrator/conflictDetector').ConflictDetector;
    let Blackboard: typeof import('../../extension/ai/orchestrator/blackboard').Blackboard;

    before(() => {
        ConflictDetector = require('../../extension/ai/orchestrator/conflictDetector').ConflictDetector;
        Blackboard = require('../../extension/ai/orchestrator/blackboard').Blackboard;
    });

    it('declareIntent + checkWriteConflict: 无冲突', () => {
        const cd = new ConflictDetector();
        const bb = new Blackboard();
        cd.declareIntent('agent-1', ['file-a.txt', 'file-b.txt'], bb);
        const result = cd.checkWriteConflict('agent-1', 'file-a.txt', bb);
        expect(result.hasConflict).to.be.false; // The same Agent does not conflict
    });

    it('checkWriteConflict: 检测到文件冲突', () => {
        const cd = new ConflictDetector();
        const bb = new Blackboard();
        cd.declareIntent('agent-1', ['shared.txt', 'only-1.txt'], bb);
        const result = cd.checkWriteConflict('agent-2', 'shared.txt', bb);
        expect(result.hasConflict).to.be.true;
        expect(result.conflictType).to.equal('file_write');
        expect(result.conflictAgentId).to.equal('agent-1');
    });

    it('clearIntent: 释放后不再冲突', () => {
        const cd = new ConflictDetector();
        const bb = new Blackboard();
        cd.declareIntent('agent-1', ['target.txt'], bb);
        cd.clearIntent('agent-1', bb);
        const result = cd.checkWriteConflict('agent-2', 'target.txt', bb);
        expect(result.hasConflict).to.be.false;
    });

    it('checkEntityConflict: 实体 ID 冲突', () => {
        const cd = new ConflictDetector();
        const bb = new Blackboard();
        cd.registerEntities('agent-1', ['event:ns.100'], bb);
        const result = cd.checkEntityConflict('agent-2', 'event:ns.100', bb);
        expect(result.hasConflict).to.be.true;
        expect(result.conflictAgentId).to.equal('agent-1');
    });

    it('checkEntityConflict: 不同实体无冲突', () => {
        const cd = new ConflictDetector();
        const bb = new Blackboard();
        cd.registerEntities('agent-1', ['event:ns.100'], bb);
        const result = cd.checkEntityConflict('agent-2', 'event:ns.200', bb);
        expect(result.hasConflict).to.be.false;
    });
});

// ── ParallelExecutor / Orchestrator Runtime Safety ───────────────────────────

// -- dispatch_agents wiring ---------------------------------------------------

describe('dispatch_agents tool wiring', () => {
    const makeTasks = (count: number) => Array.from({ length: count }, (_, index) => ({
        id: `task_${index + 1}`,
        agentType: 'explore',
        prompt: `inspect area ${index + 1}`,
    }));

    it('passes planned write targets from task args into TaskGraph nodes', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const { Orchestrator } = require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());
        executor.parentAgentRunner = { run: async () => undefined } as any;

        let capturedGraph: import('../../extension/ai/orchestrator/types').TaskGraph | undefined;
        const originalExecute = Orchestrator.prototype.execute;
        (Orchestrator.prototype as any).execute = async (graph: import('../../extension/ai/orchestrator/types').TaskGraph) => {
            capturedGraph = graph;
            return {
                success: true,
                summary: 'ok',
                agentResults: new Map(),
                totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                failedNodes: [],
                cancelledNodes: [],
            };
        };

        try {
            const result = await executor.execute('dispatch_agents', {
                userPrompt: 'planned target pass-through',
                tasks: [{
                    id: 'build_events',
                    agentType: 'build',
                    prompt: 'update event script',
                    plannedFiles: ['events/shared.txt'],
                    plannedEntities: ['event:foo.1'],
                }],
            }, {
                runnerOptions: { abortSignal: new AbortController().signal },
                onStep: () => undefined,
            } as any) as any;

            expect(result.success).to.equal(true);
            const node = capturedGraph?.nodes.get('build_events');
            expect(node?.plannedFiles).to.deep.equal(['events/shared.txt']);
            expect(node?.plannedEntities).to.deep.equal(['event:foo.1']);
        } finally {
            (Orchestrator.prototype as any).execute = originalExecute;
        }
    });

    it('routes localisation yml planned-file tasks to loc_writer with write_localisation guidance', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const { Orchestrator } = require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());
        executor.parentAgentRunner = { run: async () => undefined } as any;

        let capturedGraph: import('../../extension/ai/orchestrator/types').TaskGraph | undefined;
        const originalExecute = Orchestrator.prototype.execute;
        (Orchestrator.prototype as any).execute = async (graph: import('../../extension/ai/orchestrator/types').TaskGraph) => {
            capturedGraph = graph;
            return {
                success: true,
                summary: 'ok',
                agentResults: new Map(),
                totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                failedNodes: [],
                cancelledNodes: [],
            };
        };

        try {
            const result = await executor.execute('dispatch_agents', {
                userPrompt: 'localisation update',
                tasks: [{
                    id: 'build_loc',
                    agentType: 'build',
                    prompt: 'Update the title text in this yml file.',
                    plannedFiles: ['localisation/english/demo_l_english.yml'],
                }],
            }, {
                runnerOptions: { abortSignal: new AbortController().signal },
                onStep: () => undefined,
            } as any) as any;

            expect(result.success).to.equal(true);
            const node = capturedGraph?.nodes.get('build_loc');
            expect(node?.agentType).to.equal('loc_writer');
            expect(node?.prompt).to.include('write_localisation');
            expect(node?.prompt).to.include('Do not use `write_file`');
        } finally {
            (Orchestrator.prototype as any).execute = originalExecute;
        }
    });

    it('returns compact sub-agent summaries without internal truncation markers', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const { Orchestrator } = require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());
        executor.parentAgentRunner = { run: async () => undefined } as any;

        const originalExecute = Orchestrator.prototype.execute;
        (Orchestrator.prototype as any).execute = async () => ({
            success: true,
            summary: 'ok',
            agentResults: new Map([[
                'writer',
                {
                    nodeId: 'writer',
                    success: true,
                    output: `${'summary line\n'.repeat(220)}2.`,
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: ['events/writer.txt'],
                    stepCount: 2,
                },
            ]]),
            totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            failedNodes: [],
            cancelledNodes: [],
        });

        try {
            const result = await executor.execute('dispatch_agents', {
                userPrompt: 'compact output',
                tasks: [{
                    id: 'writer',
                    agentType: 'build',
                    prompt: 'write something',
                }],
            }, {
                runnerOptions: { abortSignal: new AbortController().signal },
                onStep: () => undefined,
            } as any) as any;

            expect(result.success).to.equal(true);
            expect(result.agents[0].outputSummary).to.not.include('truncated, full length');
            expect(result.agents[0].outputSummary.trim()).to.not.match(/(^|\n)\s*2\.\s*$/);
        } finally {
            (Orchestrator.prototype as any).execute = originalExecute;
        }
    });

    it('keeps classic orchestrator dispatches capped at four tasks', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());

        const result = await executor.execute('dispatch_agents', {
            userPrompt: 'too many classic tasks',
            tasks: makeTasks(5),
        }, {
            runnerOptions: { mode: 'orchestrator', abortSignal: new AbortController().signal },
            onStep: () => undefined,
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('current mode limit of 4');
    });

    it('allows script mode to dispatch up to eight tasks but rejects nine', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const { Orchestrator } = require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());
        executor.parentAgentRunner = { run: async () => undefined } as any;

        let capturedGraph: import('../../extension/ai/orchestrator/types').TaskGraph | undefined;
        const originalExecute = Orchestrator.prototype.execute;
        (Orchestrator.prototype as any).execute = async (graph: import('../../extension/ai/orchestrator/types').TaskGraph) => {
            capturedGraph = graph;
            return {
                success: true,
                summary: 'ok',
                agentResults: new Map(),
                totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                failedNodes: [],
                cancelledNodes: [],
            };
        };

        try {
            const allowed = await executor.execute('dispatch_agents', {
                userPrompt: 'script wave',
                tasks: makeTasks(8),
            }, {
                runnerOptions: { mode: 'script', abortSignal: new AbortController().signal },
                onStep: () => undefined,
            } as any) as any;

            expect(allowed.success).to.equal(true);
            expect(capturedGraph?.nodes.size).to.equal(8);

            const rejected = await executor.execute('dispatch_agents', {
                userPrompt: 'script wave too large',
                tasks: makeTasks(9),
            }, {
                runnerOptions: { mode: 'script', abortSignal: new AbortController().signal },
                onStep: () => undefined,
            } as any) as any;

            expect(rejected.success).to.equal(false);
            expect(rejected.error).to.include('current mode limit of 8');
        } finally {
            (Orchestrator.prototype as any).execute = originalExecute;
        }
    });

    it('does not cancel an in-flight dispatch when another top-level run starts', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const { Orchestrator } = require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());
        executor.parentAgentRunner = { run: async () => undefined } as any;

        const originalExecute = Orchestrator.prototype.execute;
        let firstSignal: AbortSignal | undefined;
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        let callCount = 0;
        const successfulResult = () => ({
            success: true,
            summary: 'ok',
            agentResults: new Map(),
            totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            failedNodes: [],
            cancelledNodes: [],
        });

        (Orchestrator.prototype as any).execute = async (_graph: unknown, options: { abortSignal?: AbortSignal }) => {
            callCount++;
            if (callCount === 1) {
                firstSignal = options.abortSignal;
                markFirstStarted();
                await firstGate;
            }
            return successfulResult();
        };

        const context = () => ({
            runnerOptions: { mode: 'script', abortSignal: new AbortController().signal },
            onStep: () => undefined,
        } as any);

        try {
            const first = executor.execute('dispatch_agents', {
                userPrompt: 'first long wave',
                tasks: makeTasks(1),
            }, context()) as Promise<any>;
            await firstStarted;

            const second = await executor.execute('dispatch_agents', {
                userPrompt: 'independent second wave',
                tasks: makeTasks(1),
            }, context()) as any;

            expect(second.success).to.equal(true);
            expect(firstSignal?.aborted).to.equal(false);
            releaseFirst();
            expect((await first).success).to.equal(true);
        } finally {
            releaseFirst();
            (Orchestrator.prototype as any).execute = originalExecute;
        }
    });
    it('requires a feature manifest and entity contracts for Script Mode write waves', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());
        executor.parentAgentRunner = { run: async () => undefined } as any;

        const result = await executor.execute('dispatch_agents', {
            tasks: [{
                id: 'build_event',
                agentType: 'build',
                prompt: 'build event',
                plannedFiles: ['events/test.txt'],
            }],
        }, {
            runnerOptions: { mode: 'script', abortSignal: new AbortController().signal },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('featureManifest');
    });

    it('merge_results honors nodeIds and returns entity-level integration data', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());
        const graph = TaskGraphEngine.createGraph('merge', {
            objective: 'merge selected work',
            acceptanceCriteria: [],
        });
        TaskGraphEngine.addNode(graph, 'A', 'build', 'A', {
            produces: [{ kind: 'event', id: 'foo.1', operation: 'define' }],
        });
        TaskGraphEngine.addNode(graph, 'B', 'build', 'B');
        (executor as any)._lastOrchestratorGraph = graph;
        (executor as any)._lastOrchestratorResult = {
            success: true,
            summary: 'ok',
            agentResults: new Map([
                ['A', { nodeId: 'A', success: true, output: 'A output', writtenFiles: ['events/a.txt'], tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 }, stepCount: 1 }],
                ['B', { nodeId: 'B', success: true, output: 'B output', writtenFiles: ['events/b.txt'], tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 }, stepCount: 1 }],
            ]),
            totalTokenUsage: { total: 2, input: 2, output: 0, estimatedCostCny: 0 },
            failedNodes: [],
            cancelledNodes: [],
        };

        const merged = await executor.execute('merge_results', { nodeIds: ['A'], strategy: 'structured' }) as any;

        expect(merged.success).to.equal(true);
        expect(merged.selectedNodeIds).to.deep.equal(['A']);
        expect(merged.writtenFiles).to.deep.equal(['events/a.txt']);
        expect(merged.integration.entityContracts[0].produces[0].id).to.equal('foo.1');
        expect(merged.agentOutputs.map((entry: any) => entry.id)).to.deep.equal(['A']);
    });
});

describe('approved blueprint dispatch', () => {
    it('hydrates the canonical feature manifest and task DAG from design_blueprint.json', async () => {
        const fs = require('fs') as typeof import('fs');
        const os = require('os') as typeof import('os');
        const path = require('path') as typeof import('path');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-blueprint-dispatch-'));
        const blueprintDir = path.join(root, '.cwtools-ai', 'topic');
        const blueprintFile = path.join(blueprintDir, 'design_blueprint.json');
        fs.mkdirSync(blueprintDir, { recursive: true });
        fs.writeFileSync(blueprintFile, JSON.stringify({
            schemaVersion: 2,
            featureManifest: {
                objective: 'Build approved event',
                entities: [{ kind: 'event', id: 'approved.1', operation: 'define' }],
                requiredEdges: [],
                acceptanceCriteria: [{ id: 'event_exists', description: 'Event exists', type: 'entity_exists', subject: 'approved.1' }],
                expectsFileChanges: true,
            },
            taskPlan: [{
                id: 'build_event',
                agentType: 'build',
                prompt: 'Build the approved event.',
                plannedFiles: ['events/approved.txt'],
                produces: [{ kind: 'event', id: 'approved.1', operation: 'define' }],
                dependencies: [],
                acceptanceChecks: [{ id: 'event_exists', description: 'Event exists', type: 'entity_exists', subject: 'approved.1' }],
            }],
        }));

        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const { Orchestrator } = require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator');
        const executor = new AgentToolExecutor({ onNotification: () => undefined, sendNotification: () => undefined } as any, root);
        executor.parentAgentRunner = { run: async () => undefined } as any;
        let capturedGraph: import('../../extension/ai/orchestrator/types').TaskGraph | undefined;
        const originalExecute = Orchestrator.prototype.execute;
        (Orchestrator.prototype as any).execute = async (graph: import('../../extension/ai/orchestrator/types').TaskGraph) => {
            capturedGraph = graph;
            return {
                success: true, summary: 'ok', agentResults: new Map(),
                totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                failedNodes: [], cancelledNodes: [],
            };
        };

        try {
            const result = await executor.execute('dispatch_agents', { blueprintFile }, {
                runnerOptions: { mode: 'script', abortSignal: new AbortController().signal },
            } as any) as any;
            expect(result.success).to.equal(true);
            expect(capturedGraph?.metadata.featureManifest?.objective).to.equal('Build approved event');
            expect(capturedGraph?.nodes.get('build_event')?.produces?.[0].id).to.equal('approved.1');
        } finally {
            (Orchestrator.prototype as any).execute = originalExecute;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('Orchestrator runtime safety', () => {
    let ParallelExecutor: typeof import('../../extension/ai/orchestrator/parallelExecutor').ParallelExecutor;
    let Orchestrator: typeof import('../../extension/ai/orchestrator/orchestrator').Orchestrator;
    let TaskGraphEngine: typeof import('../../extension/ai/orchestrator/taskGraphEngine').TaskGraphEngine;
    let Blackboard: typeof import('../../extension/ai/orchestrator/blackboard').Blackboard;

    before(() => {
        ParallelExecutor = require('../../extension/ai/orchestrator/parallelExecutor').ParallelExecutor;
        Orchestrator = require('../../extension/ai/orchestrator/orchestrator').Orchestrator;
        TaskGraphEngine = require('../../extension/ai/orchestrator/taskGraphEngine').TaskGraphEngine;
        Blackboard = require('../../extension/ai/orchestrator/blackboard').Blackboard;
    });

    it('executeGraph: reports missing dependencies instead of silently completing', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('missing dependency');
        TaskGraphEngine.addNode(graph, 'A', 'build', 'build', { dependencies: ['missing_node'] });

        const result = await executor.executeGraph(
            graph,
            new Blackboard(),
            async () => {
                throw new Error('should not run');
            },
            {},
        );

        expect(result.success).to.equal(false);
        expect(result.failedNodes).to.deep.equal(['A']);
        expect(result.summary).to.include('missing dependencies');
    });

    it('executeGraph: does not retry timeout-like sub-agent failures', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('timeout');
        TaskGraphEngine.addNode(graph, 'A', 'build', 'build', { maxRetries: 2 });
        let calls = 0;

        const result = await executor.executeGraph(
            graph,
            new Blackboard(),
            async () => {
                calls++;
                return {
                    nodeId: 'A',
                    success: false,
                    output: '',
                    error: 'Sub-Agent idle timeout exceeded (10m without progress).',
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount: 1,
                };
            },
            {},
        );

        expect(calls).to.equal(1);
        expect(result.success).to.equal(false);
        expect(result.failedNodes).to.deep.equal(['A']);
    });

    it('executeGraph: serializes ready nodes that declare the same planned file', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 2 });
        const graph = TaskGraphEngine.createGraph('file conflict');
        TaskGraphEngine.addNode(graph, 'A', 'build', 'build A', { plannedFiles: ['events/shared.txt'] });
        TaskGraphEngine.addNode(graph, 'B', 'build', 'build B', { plannedFiles: ['events/shared.txt'] });
        const order: string[] = [];

        const result = await executor.executeGraph(
            graph,
            new Blackboard(),
            async (node) => {
                order.push(node.id);
                return {
                    nodeId: node.id,
                    success: true,
                    output: 'ok',
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount: 1,
                };
            },
            {},
        );

        expect(result.success).to.equal(true);
        expect(order).to.deep.equal(['A', 'B']);
    });

    it('executeGraph: keeps non-conflicting planned files in the same batch', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 2 });
        const graph = TaskGraphEngine.createGraph('no file conflict');
        TaskGraphEngine.addNode(graph, 'A', 'build', 'build A', { plannedFiles: ['events/a.txt'] });
        TaskGraphEngine.addNode(graph, 'B', 'build', 'build B', { plannedFiles: ['events/b.txt'] });
        let active = 0;
        let maxActive = 0;

        const result = await executor.executeGraph(
            graph,
            new Blackboard(),
            async (node) => {
                active++;
                maxActive = Math.max(maxActive, active);
                await Promise.resolve();
                active--;
                return {
                    nodeId: node.id,
                    success: true,
                    output: 'ok',
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount: 1,
                };
            },
            {},
        );

        expect(result.success).to.equal(true);
        expect(maxActive).to.equal(2);
    });

    it('executeGraph: serializes ready nodes that declare the same planned entity', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 2 });
        const graph = TaskGraphEngine.createGraph('entity conflict');
        TaskGraphEngine.addNode(graph, 'A', 'build', 'build A', { plannedEntities: ['event:foo.1'] });
        TaskGraphEngine.addNode(graph, 'B', 'build', 'build B', { plannedEntities: ['event:foo.1'] });
        const order: string[] = [];

        const result = await executor.executeGraph(
            graph,
            new Blackboard(),
            async (node) => {
                order.push(node.id);
                return {
                    nodeId: node.id,
                    success: true,
                    output: 'ok',
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount: 1,
                };
            },
            {},
        );

        expect(result.success).to.equal(true);
        expect(order).to.deep.equal(['A', 'B']);
    });

    it('executeSubAgent: returns on abort even if AgentRunner.run never settles', async () => {
        const runner = {
            run: () => new Promise(() => undefined),
        };
        const orchestrator = new Orchestrator(runner as any);
        const abortController = new AbortController();
        const node = {
            id: 'A',
            agentType: 'explore',
            prompt: 'scan',
            dependencies: [],
            priority: 'normal',
            status: 'pending',
            retryCount: 0,
            maxRetries: 0,
        };

        const promise = (orchestrator as any).executeSubAgent(
            node,
            new Blackboard(),
            { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            abortController.signal,
            () => undefined,
            { topicId: 'topic-1' },
        );

        abortController.abort(new Error('manual abort'));
        const result = await Promise.race([
            promise,
            new Promise(resolve => setTimeout(() => resolve('__timeout__'), 200)),
        ]) as any;

        expect(result).to.not.equal('__timeout__');
        expect(result.success).to.equal(false);
        expect(result.error).to.include('manual abort');
    });

    it('executeSubAgent: records successful write targets when tool results omit filePath', async () => {
        const workspaceRoot = process.cwd();
        const runner = {
            toolExecutor: { workspaceRoot },
            run: async (_prompt: string, _context: any, _history: any[], options: any) => {
                options.onStep({
                    type: 'tool_call',
                    content: 'call edit_file',
                    toolName: 'edit_file',
                    toolArgs: { filePath: 'events/subagent_target.txt', oldString: 'a', newString: 'b' },
                    invocationId: 'inv-write',
                    timestamp: Date.now(),
                });
                options.onStep({
                    type: 'tool_result',
                    content: 'result edit_file',
                    toolName: 'edit_file',
                    toolResult: { success: true, message: 'edit_file: updated subagent_target.txt' },
                    invocationId: 'inv-write',
                    timestamp: Date.now(),
                });
                return {
                    code: '',
                    explanation: 'done',
                    validationErrors: [],
                    isValid: true,
                    retryCount: 0,
                    steps: [],
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                };
            },
        };
        const orchestrator = new Orchestrator(runner as any);
        const node = {
            id: 'writer',
            agentType: 'build',
            prompt: 'edit target',
            dependencies: [],
            priority: 'normal',
            status: 'pending',
            retryCount: 0,
            maxRetries: 0,
        };

        const result = await (orchestrator as any).executeSubAgent(
            node,
            new Blackboard(),
            { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            new AbortController().signal,
            () => undefined,
            { topicId: 'topic-1' },
        );

        expect(result.success).to.equal(true);
        expect(result.writtenFiles).to.deep.equal([
            require('path').resolve(workspaceRoot, 'events/subagent_target.txt'),
        ]);
    });

    it('executeSubAgent: removes generic write tools for pure localisation yml tasks', async () => {
        const workspaceRoot = process.cwd();
        let capturedOptions: any;
        const runner = {
            toolExecutor: { workspaceRoot },
            run: async (_prompt: string, _context: any, _history: any[], options: any) => {
                capturedOptions = options;
                return {
                    code: '',
                    explanation: 'done',
                    validationErrors: [],
                    isValid: true,
                    retryCount: 0,
                    steps: [],
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                };
            },
        };
        const orchestrator = new Orchestrator(runner as any);
        const node = {
            id: 'loc_writer',
            agentType: 'loc_writer',
            prompt: 'update localisation keys',
            plannedFiles: ['localisation/english/demo_l_english.yml'],
            dependencies: [],
            priority: 'normal',
            status: 'pending',
            retryCount: 0,
            maxRetries: 0,
        };

        const result = await (orchestrator as any).executeSubAgent(
            node,
            new Blackboard(),
            { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            new AbortController().signal,
            () => undefined,
            { topicId: 'topic-1' },
        );

        expect(result.success).to.equal(true);
        expect(capturedOptions.excludeTools).to.include.members([
            'write_file',
            'edit_file',
            'replace_lines',
            'multi_replace_file_content',
            'apply_patch',
        ]);
        expect(capturedOptions.excludeTools).to.not.include('write_localisation');
    });
});

// ── QualityGate ───────────────────────────────────────────────────────────────

describe('Orchestrator quality propagation', () => {
    const gateResult = (passed: boolean) => ({
        passed,
        diagnosticErrors: 0,
        logicIssues: passed ? 0 : 1,
        semanticIssues: 0,
        acceptanceFailures: [],
        filesChecked: ['events/test.txt'],
        reviewReport: passed ? 'passed' : 'failed',
        fixSuggestions: passed ? [] : ['fix it'],
    });

    const executionResult = () => ({
        success: true,
        summary: 'builders complete',
        agentResults: new Map([
            ['builder', {
                nodeId: 'builder', success: true, output: 'done', writtenFiles: ['events/test.txt'],
                tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 }, stepCount: 1,
            }],
        ]),
        totalTokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
        failedNodes: [],
        cancelledNodes: [],
    });

    function makeOrchestrator(maxFixCycles: number, passOnReview: number) {
        const { Orchestrator } = require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator');
        let fixCalls = 0;
        let reviewCalls = 0;
        const runner = {
            toolExecutor: { workspaceRoot: process.cwd() },
            run: async () => {
                fixCalls++;
                return { isValid: true, steps: [], explanation: 'fixed', validationErrors: [], retryCount: 0 };
            },
        };
        const orchestrator = new Orchestrator(runner as any);
        (orchestrator as any).executor.executeGraph = async () => executionResult();
        (orchestrator as any).executeSubAgent = async () => ({
            nodeId: 'loc_sweep', success: true, output: '', writtenFiles: [],
            tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 }, stepCount: 0,
        });
        (orchestrator as any).qualityGate.reviewOutput = async () => gateResult(++reviewCalls >= passOnReview);
        (orchestrator as any).qualityGate.getConfig = () => ({ autoFix: true, maxFixCycles });
        (orchestrator as any).qualityGate.buildFixPrompt = () => 'fix';
        return { orchestrator, counts: () => ({ fixCalls, reviewCalls }) };
    }

    it('re-runs the quality gate after auto-fix and passes only after re-review', async () => {
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const { orchestrator, counts } = makeOrchestrator(3, 2);
        const graph = TaskGraphEngine.createGraph('quality re-review');
        const builder = TaskGraphEngine.addNode(graph, 'builder', 'build', 'build', { plannedFiles: ['events/test.txt'] });
        builder.status = 'done';

        const result = await orchestrator.execute(graph, { abortSignal: new AbortController().signal });

        expect(result.success).to.equal(true);
        expect(result.qualityGate?.passed).to.equal(true);
        expect(counts()).to.deep.equal({ reviewCalls: 2, fixCalls: 1 });
    });

    it('propagates persistent quality-gate failure into the orchestrator result', async () => {
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const { orchestrator, counts } = makeOrchestrator(2, Number.POSITIVE_INFINITY);
        const graph = TaskGraphEngine.createGraph('quality failure');
        const builder = TaskGraphEngine.addNode(graph, 'builder', 'build', 'build', { plannedFiles: ['events/test.txt'] });
        builder.status = 'done';

        const result = await orchestrator.execute(graph, { abortSignal: new AbortController().signal });

        expect(result.success).to.equal(false);
        expect(result.failedNodes).to.include('quality_gate');
        expect(result.qualityGate?.passed).to.equal(false);
        expect(counts()).to.deep.equal({ reviewCalls: 3, fixCalls: 2 });
    });
});

describe('QualityGate', () => {
    let QualityGate: typeof import('../../extension/ai/orchestrator/qualityGate').QualityGate;
    let isPdxDiagnosticFile: typeof import('../../extension/ai/orchestrator/qualityGate').isPdxDiagnosticFile;
    let PDX_DIAGNOSTIC_EXTENSIONS: typeof import('../../extension/ai/orchestrator/qualityGate').PDX_DIAGNOSTIC_EXTENSIONS;

    before(() => {
        const qualityGate = require('../../extension/ai/orchestrator/qualityGate') as typeof import('../../extension/ai/orchestrator/qualityGate');
        QualityGate = qualityGate.QualityGate;
        isPdxDiagnosticFile = qualityGate.isPdxDiagnosticFile;
        PDX_DIAGNOSTIC_EXTENSIONS = qualityGate.PDX_DIAGNOSTIC_EXTENSIONS;
    });

    it('buildReviewPrompt: 生成包含文件列表的审查提示', () => {
        const qg = new QualityGate();
        const mockResult = {
            nodeId: 'mock_node',
            success: true,
            output: 'built everything',
            tokenUsage: { input: 100, output: 50, total: 150, estimatedCostCny: 0.01 },
            writtenFiles: ['events/test.txt', 'common/tech.txt'],
            stepCount: 5,
        };
        const prompt = qg.buildReviewPrompt(mockResult);
        expect(prompt).to.include('events/test.txt');
        expect(prompt).to.include('common/tech.txt');
    });

    it('checks only LSP-precise diagnostic file types', () => {
        expect([...PDX_DIAGNOSTIC_EXTENSIONS]).to.deep.equal(['.txt', '.gui']);
        expect(isPdxDiagnosticFile('events/test.txt')).to.equal(true);
        expect(isPdxDiagnosticFile('interface/test.gui')).to.equal(true);
        expect(isPdxDiagnosticFile('localisation/test_l_english.yml')).to.equal(false);
        expect(isPdxDiagnosticFile('interface/sprites.gfx')).to.equal(false);
        expect(isPdxDiagnosticFile('sound/test.asset')).to.equal(false);
        expect(isPdxDiagnosticFile('notes.md')).to.equal(false);
    });

    it('buildCombinedReviewPrompt names only LSP diagnostic targets', () => {
        const qg = new QualityGate();
        const prompt = qg.buildCombinedReviewPrompt([
            'events/test.txt',
            'interface/test.gui',
            'localisation/test_l_english.yml',
            'interface/sprites.gfx',
            'sound/test.asset',
        ]);

        expect(prompt).to.include('.txt, .gui');
        expect(prompt).to.include('LSP diagnostic target files include: events/test.txt, interface/test.gui');
        expect(prompt).to.not.include('LSP diagnostic target files include: events/test.txt, interface/test.gui, localisation/test_l_english.yml');
    });

    it('parseReviewResult: 识别通过结果', () => {
        const qg = new QualityGate();
        const result = qg.parseReviewResult('PASSED: All checks passed, code is clean.');
        expect(result.logicIssuesCount).to.equal(0);
    });

    it('parseReviewResult: preserves acceptance evidence for manifest criteria', () => {
        const qg = new QualityGate();
        const result = qg.parseReviewResult([
            '```json',
            JSON.stringify({
                logicIssuesCount: 0,
                logicIssues: [],
                fixSuggestions: [],
                acceptanceEvidence: [{ id: 'event_exists', passed: true, evidence: 'events/test.txt:2' }],
                acceptanceFailures: [],
            }),
            '```',
        ].join('\n'));
        expect(result.acceptanceEvidence).to.deep.equal([
            { id: 'event_exists', passed: true, evidence: 'events/test.txt:2' },
        ]);
    });

    it('reviewOutput fails when a required manifest criterion has no evidence', async () => {
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const graph = TaskGraphEngine.createGraph('acceptance evidence', {
            objective: 'prove completion',
            acceptanceCriteria: [{
                id: 'functional_chain',
                description: 'The functional chain is reachable',
                type: 'custom',
            }],
        });
        const runner = {
            toolExecutor: {
                workspaceRoot: process.cwd(),
                execute: async () => ({ totalDiagnosticCount: 0 }),
            },
            run: async () => ({
                explanation: '```json\n{"logicIssuesCount":0,"logicIssues":[],"fixSuggestions":[],"acceptanceEvidence":[],"acceptanceFailures":[]}\n```',
                isValid: true,
                validationErrors: [],
                retryCount: 0,
                steps: [],
            }),
        };

        const result = await new QualityGate().reviewOutput(
            runner as any,
            ['package.json'],
            {},
            { taskGraph: graph, workspaceRoot: process.cwd() },
        );

        expect(result.passed).to.equal(false);
        expect(result.acceptanceFailures[0]).to.include('functional_chain');
    });

    it('parseReviewResult: 识别失败结果', () => {
        const qg = new QualityGate();
        const result = qg.parseReviewResult('FAILED: 3 issues need fixing.');
        expect(result.logicIssuesCount).to.equal(3);
    });

    it('buildFixPrompt: 包含审查报告和文件列表', () => {
        const qg = new QualityGate();
        const prompt = qg.buildFixPrompt('Missing localization keys', ['events/main.txt']);
        expect(prompt).to.include('Missing localization keys');
        expect(prompt).to.include('events/main.txt');
    });

    it('buildCombinedReviewPrompt: sprite diagnostics trigger asset repair protocol', () => {
        const qg = new QualityGate();
        const prompt = qg.buildCombinedReviewPrompt(
            ['events/kuat_force_echo_events.txt'],
            'File: events/kuat_force_echo_events.txt\n[{"message":"Expected value of type sprite","line":299,"column":12}]',
        );

        expect(prompt).to.include('Sprite Resource Diagnostic Protocol');
        expect(prompt).to.include('find_sprite_candidates');
        expect(prompt).to.include('never a raw `.dds` file path');
    });

    it('buildFixPrompt: sprite issues require verified candidates', () => {
        const qg = new QualityGate();
        const prompt = qg.buildFixPrompt(
            'FAILED: 1 issue need to be fixed\nLine 299: Expected value of type sprite for picture = GFX_evt_analyzing_anomaly',
            ['events/kuat_force_echo_events.txt'],
        );

        expect(prompt).to.include('find_sprite_candidates');
        expect(prompt).to.include('never invent a `GFX_*` name');
    });

    it('buildFixPrompt: show_sound issues require verified asset candidates', () => {
        const qg = new QualityGate();
        const prompt = qg.buildFixPrompt(
            'FAILED: 1 issue need to be fixed\nLine 42: show_sound = kuat_force_echo_missing references an unknown sound asset',
            ['events/kuat_force_echo_events.txt'],
        );

        expect(prompt).to.include('find_sound_candidates');
        expect(prompt).to.include('never invent a sound asset name');
    });
});

// ── AgentRegistry ─────────────────────────────────────────────────────────────

describe('AgentRegistry', () => {
    let AGENT_REGISTRY: typeof import('../../extension/ai/orchestrator/agentRegistry').AGENT_REGISTRY;
    let getAgentProfile: typeof import('../../extension/ai/orchestrator/agentRegistry').getAgentProfile;
    let getAvailableRoles: typeof import('../../extension/ai/orchestrator/agentRegistry').getAvailableRoles;

    before(() => {
        const registry = require('../../extension/ai/orchestrator/agentRegistry');
        AGENT_REGISTRY = registry.AGENT_REGISTRY;
        getAgentProfile = registry.getAgentProfile;
        getAvailableRoles = registry.getAvailableRoles;
    });

    it('AGENT_REGISTRY: 包含所有预定义角色', () => {
        const roles = Object.keys(AGENT_REGISTRY);
        expect(roles).to.include.members(['explorer', 'architect', 'builder', 'locWriter', 'reviewer']);
    });

    it('getAgentProfile: 返回已注册角色', () => {
        const profile = getAgentProfile('explorer');
        expect(profile).to.exist;
        expect(profile.mode).to.equal('explore');
    });

    it('getAgentProfile: 未注册角色返回 builder 默认', () => {
        const profile = getAgentProfile('unknown_role');
        expect(profile).to.exist;
        expect(profile.mode).to.equal('build'); //default builder
    });

    it('每个角色都有 toolBudget 和 maxIterations', () => {
        for (const [, profile] of Object.entries(AGENT_REGISTRY)) {
            expect(profile.toolBudget).to.be.a('string');
            expect(profile.maxIterations).to.be.a('number').and.greaterThan(0);
        }
    });

    it('getAvailableRoles: 返回所有角色名称', () => {
        const roles = getAvailableRoles();
        expect(roles).to.be.an('array');
        expect(roles.length).to.be.greaterThan(4);
        expect(roles).to.include('builder');
    });
});
