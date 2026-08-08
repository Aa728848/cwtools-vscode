/** 
* Multi-Agent coordinator module - unit testing 
* 
* Covers Blackboard, TaskGraphEngine, ConflictDetector, QualityGate, AgentRegistry. 
* Use ts-mocha + chai to be consistent with the existing testing style of the project. 
*/

import { expect } from 'chai';
import * as path from 'path';
import sinon from 'sinon';

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
        bb.write('entity:ship', 'ship_data', 'free_text', 'a');
        bb.write('entity:planet', 'planet_data', 'free_text', 'a');
        bb.write('file:main.txt', 'content', 'free_text', 'b');
        const results = bb.queryByPrefix('entity:');
        expect(results).to.have.length(2);
        expect(results.every(r => r.key.startsWith('entity:'))).to.be.true;
    });

    it('queryByType: 类型过滤', () => {
        const bb = new Blackboard();
        bb.write('a', '{}', 'file_snapshot', 'p');
        bb.write('b', '{}', 'scope_info', 'p');
        bb.write('c', '{}', 'file_snapshot', 'p');
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
        bb.write('snap2', 'data2', 'free_text', 'b');
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

    it('separates general and Paradox writer roles at dispatch time', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());

        const result = await executor.execute('dispatch_agents', {
            tasks: [{ id: 'wrong_writer', agentType: 'build', prompt: 'edit TypeScript' }],
        }, {
            runnerOptions: { mode: 'orchestrator', abortSignal: new AbortController().signal },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include("Agent type 'build' is not allowed in General Multi-Agent mode");
        expect(result.error).to.include('utility');
    });

    it('rejects localisation child work retained by the user', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());

        const result = await executor.execute('dispatch_agents', {
            userConstraints: {
                localisationOwnership: 'user',
                warningHandling: 'ignore',
            },
            tasks: [{
                id: 'write_loc',
                agentType: 'loc_writer',
                prompt: 'Write localisation.',
                plannedFiles: ['localisation/english/demo_l_english.yml'],
            }],
        }, {
            runnerOptions: {
                mode: 'script',
                domain: 'paradox',
                originalUserMessage: '本地化由我自己写',
                abortSignal: new AbortController().signal,
            },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include('retained ownership of localisation');
    });

    it('intersects mode roles with the selected runtime profile sub-agent allowlist', async () => {
        const { AgentToolExecutor } = require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
        const executor = new AgentToolExecutor({
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any, process.cwd());

        const result = await executor.execute('dispatch_agents', {
            tasks: [{ id: 'reviewer', agentType: 'review', prompt: 'review changes' }],
        }, {
            runnerOptions: {
                mode: 'orchestrator',
                agentProfileAllowedSubagents: ['explore'],
                abortSignal: new AbortController().signal,
            },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include("Agent type 'review' is not allowed");
        expect(result.error).to.include('explore');
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
        (executor as any)._lastOrchestratorDomain = 'paradox';
        (executor as any)._lastOrchestratorTopicId = 'merge-topic';
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

        const merged = await executor.execute('merge_results', { nodeIds: ['A'], strategy: 'structured' }, {
            runnerOptions: { mode: 'script', domain: 'paradox', topicId: 'merge-topic' },
        } as any) as any;

        expect(merged.success).to.equal(true);
        expect(merged.selectedNodeIds).to.deep.equal(['A']);
        expect(merged.writtenFiles).to.deep.equal(['events/a.txt']);
        expect(merged.integration.entityContracts[0].produces[0].id).to.equal('foo.1');
        expect(merged.agentOutputs.map((entry: any) => entry.id)).to.deep.equal(['A']);

        const crossDomain = await executor.execute('merge_results', { nodeIds: ['A'], strategy: 'structured' }, {
            runnerOptions: { mode: 'orchestrator', domain: 'general', topicId: 'merge-topic' },
        } as any) as any;
        expect(crossDomain.success).to.equal(false);
        expect(crossDomain.message).to.include('dispatch_agents first');
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
        const parentUsage: import('../../extension/ai/types').TokenUsage = {
            total: 10,
            input: 8,
            output: 2,
            estimatedCostCny: 0.01,
            apiCalls: 1,
        };
        const originalExecute = Orchestrator.prototype.execute;
        (Orchestrator.prototype as any).execute = async (graph: import('../../extension/ai/orchestrator/types').TaskGraph) => {
            capturedGraph = graph;
            return {
                success: true, summary: 'ok', agentResults: new Map(),
                totalTokenUsage: {
                    total: 120,
                    input: 100,
                    output: 20,
                    estimatedCostCny: 0.2,
                    cachedTokens: 40,
                    netInput: 60,
                    netTotal: 80,
                    apiCalls: 2,
                    cacheRequests: [{
                        provider: 'deepseek',
                        model: 'deepseek-chat',
                        inputTokens: 100,
                        cachedTokens: 40,
                        cacheCapable: true,
                        agentMode: 'build',
                        toolStage: 'write',
                        promptFingerprint: 'child-fp',
                        purpose: 'reasoning',
                    }],
                },
                failedNodes: [], cancelledNodes: [],
            };
        };

        try {
            const result = await executor.execute('dispatch_agents', { blueprintFile }, {
                runnerOptions: { mode: 'script', abortSignal: new AbortController().signal },
                tokenAccumulator: parentUsage,
            } as any) as any;
            expect(result.success).to.equal(true);
            expect(capturedGraph?.metadata.featureManifest?.objective).to.equal('Build approved event');
            expect(capturedGraph?.nodes.get('build_event')?.produces?.[0].id).to.equal('approved.1');
            expect(parentUsage).to.include({
                total: 130,
                input: 108,
                output: 22,
                estimatedCostCny: 0.21000000000000002,
                cachedTokens: 40,
                netInput: 60,
                netTotal: 80,
                apiCalls: 3,
            });
            expect(parentUsage.cacheRequests).to.have.length(1);
            expect(parentUsage.cacheRequests?.[0]?.promptFingerprint).to.equal('child-fp');
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

    it('executeGraph: never heals a misspelled dependency to the node itself', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('self dependency healing');
        TaskGraphEngine.addNode(graph, 'build_ui', 'build', 'build', { dependencies: ['build_u1'] });

        const result = await executor.executeGraph(graph, new Blackboard(), async () => {
            throw new Error('should not run');
        }, {});

        expect(result.success).to.equal(false);
        expect(result.summary).to.include('missing dependencies');
        expect(graph.nodes.get('build_ui')?.dependencies).to.deep.equal(['build_u1']);
    });

    it('executeGraph: rejects ambiguous dependency healing matches', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('ambiguous dependency healing');
        TaskGraphEngine.addNode(graph, 'build_ui', 'build', 'build');
        TaskGraphEngine.addNode(graph, 'build_ux', 'build', 'build');
        TaskGraphEngine.addNode(graph, 'consumer', 'build', 'build', { dependencies: ['build_ua'] });

        const result = await executor.executeGraph(graph, new Blackboard(), async () => {
            throw new Error('should not run');
        }, {});

        expect(result.success).to.equal(false);
        expect(result.summary).to.include('missing dependencies');
        expect(graph.nodes.get('consumer')?.dependencies).to.deep.equal(['build_ua']);
    });

    it('executeGraph: rechecks cycles introduced by dependency healing', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('healed dependency cycle');
        TaskGraphEngine.addNode(graph, 'compile', 'build', 'build', { dependencies: ['consumr'] });
        TaskGraphEngine.addNode(graph, 'consumer', 'build', 'build', { dependencies: ['compile'] });

        const result = await executor.executeGraph(graph, new Blackboard(), async () => {
            throw new Error('should not run');
        }, {});

        expect(result.success).to.equal(false);
        expect(result.summary).to.include('cyclic dependencies after dependency healing');
        expect(graph.nodes.get('compile')?.dependencies).to.deep.equal(['consumr']);
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

    it('executeGraph: persists and injects structured dependency handoffs', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 2 });
        const graph = TaskGraphEngine.createGraph('handoff propagation');
        TaskGraphEngine.addNode(graph, 'A', 'explore', 'inspect source');
        TaskGraphEngine.addNode(graph, 'B', 'build', 'implement result', { dependencies: ['A'] });
        const blackboard = new Blackboard();
        let dependentPrompt = '';

        const result = await executor.executeGraph(
            graph,
            blackboard,
            async (node) => {
                if (node.id === 'B') dependentPrompt = node.prompt;
                return {
                    nodeId: node.id,
                    success: true,
                    output: `raw ${node.id}`,
                    handoff: {
                        version: 1,
                        summary: `summary ${node.id}`,
                        changedFiles: node.id === 'B' ? ['client/b.ts'] : [],
                        verification: ['unit test'],
                        unresolved: ['none'],
                    },
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount: 1,
                };
            },
            {},
        );

        expect(result.success).to.equal(true);
        expect(blackboard.readValue('__handoff:A')).to.include('summary A');
        expect(dependentPrompt).to.include('Structured dependency handoffs');
        expect(dependentPrompt).to.include('summary A');
        expect(result.summary).to.include('A: summary A');
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

    it('executeGraph: preserves child cache and request-level usage in totals', async () => {
        const executor = new ParallelExecutor({ maxConcurrency: 1 });
        const graph = TaskGraphEngine.createGraph('usage aggregation');
        TaskGraphEngine.addNode(graph, 'A', 'build', 'build A');

        const result = await executor.executeGraph(
            graph,
            new Blackboard(),
            async () => ({
                nodeId: 'A',
                success: true,
                output: 'ok',
                tokenUsage: {
                    total: 120,
                    input: 100,
                    output: 20,
                    estimatedCostCny: 0.2,
                    cachedTokens: 40,
                    netInput: 60,
                    netTotal: 80,
                    cacheSavedCostCny: 0.05,
                    apiCalls: 2,
                    compactionCalls: 1,
                    fallbackCalls: 1,
                    cacheRequests: [{
                        provider: 'deepseek',
                        model: 'deepseek-chat',
                        inputTokens: 100,
                        cachedTokens: 40,
                        cacheCapable: true,
                        agentMode: 'build',
                        toolStage: 'write',
                        promptFingerprint: 'child-fp',
                        purpose: 'reasoning',
                    }],
                },
                writtenFiles: [],
                stepCount: 1,
            }),
            {},
        );

        expect(result.totalTokenUsage).to.include({
            total: 120,
            input: 100,
            output: 20,
            estimatedCostCny: 0.2,
            cachedTokens: 40,
            netInput: 60,
            netTotal: 80,
            cacheSavedCostCny: 0.05,
            apiCalls: 2,
            compactionCalls: 1,
            fallbackCalls: 1,
        });
        expect(result.totalTokenUsage.cacheRequests).to.have.length(1);
        expect(result.totalTokenUsage.cacheRequests?.[0]?.promptFingerprint).to.equal('child-fp');
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

    it('executeSubAgent: allows active work to continue beyond twenty minutes', async () => {
        const clock = sinon.useFakeTimers({ now: 0 });
        try {
            let childOptions: any;
            let finishRun!: (result: any) => void;
            const runner = {
                toolExecutor: { workspaceRoot: process.cwd() },
                run: (_prompt: string, _context: any, _history: any[], options: any) => {
                    childOptions = options;
                    return new Promise(resolve => { finishRun = resolve; });
                },
            };
            const orchestrator = new Orchestrator(runner as any);
            const promise = (orchestrator as any).executeSubAgent(
                {
                    id: 'long-active', agentType: 'explore', prompt: 'scan', dependencies: [],
                    priority: 'normal', status: 'pending', retryCount: 0, maxRetries: 0,
                },
                new Blackboard(),
                { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                new AbortController().signal,
                () => undefined,
                { topicId: 'topic-long' },
            );

            await Promise.resolve();
            for (let minute = 1; minute <= 21; minute++) {
                await clock.tickAsync(60_000);
                childOptions.onStep({
                    type: 'thinking',
                    content: `active minute ${minute}`,
                    timestamp: Date.now(),
                });
            }
            finishRun({
                code: '', explanation: 'done', validationErrors: [], isValid: true,
                retryCount: 0, steps: [],
                tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            });
            await clock.tickAsync(0);

            const result = await promise;
            expect(result.success).to.equal(true);
            expect(childOptions.renewableIterationLimit).to.equal(true);
        } finally {
            clock.restore();
        }
    });

    it('executeSubAgent: aborts after twenty minutes without activity', async () => {
        const clock = sinon.useFakeTimers({ now: 0 });
        try {
            const runner = {
                toolExecutor: { workspaceRoot: process.cwd() },
                run: (_prompt: string, _context: any, _history: any[], options: any) => {
                    const heartbeatId = setInterval(() => options.onStep({
                        type: 'orchestrator_progress',
                        content: 'Waiting for model response...',
                        timestamp: Date.now(),
                    }), 30_000);
                    options.abortSignal.addEventListener('abort', () => clearInterval(heartbeatId), { once: true });
                    return new Promise(() => undefined);
                },
            };
            const orchestrator = new Orchestrator(runner as any);
            const promise = (orchestrator as any).executeSubAgent(
                {
                    id: 'stalled', agentType: 'explore', prompt: 'scan', dependencies: [],
                    priority: 'normal', status: 'pending', retryCount: 0, maxRetries: 0,
                },
                new Blackboard(),
                { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                new AbortController().signal,
                () => undefined,
                { topicId: 'topic-stalled' },
            );

            await clock.tickAsync(20 * 60_000);
            const result = await promise;
            expect(result.success).to.equal(false);
            expect(result.error).to.include('idle timeout exceeded');
            expect(result.error).to.include('20m');
        } finally {
            clock.restore();
        }
    });

    it('executeSubAgent: records successful write targets when tool results omit filePath', async () => {
        const workspaceRoot = process.cwd();
        let capturedOptions: any;
        const runner = {
            toolExecutor: { workspaceRoot },
            run: async (_prompt: string, _context: any, _history: any[], options: any) => {
                capturedOptions = options;
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
        expect(capturedOptions.initialToolStage).to.equal('write');
        expect(capturedOptions.useSlimPrompt).to.equal(true);
        expect(capturedOptions.forceAutoApplyWrites).to.equal(true);
        expect(result.writtenFiles).to.deep.equal([
            require('path').resolve(workspaceRoot, 'events/subagent_target.txt'),
        ]);
    });

    it('executeSubAgent: exposes run_command to General Multi-Agent utility writers', async () => {
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
            id: 'utility_writer',
            agentType: 'utility',
            prompt: 'update code and run focused tests',
            plannedFiles: ['client/example.ts'],
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
            { topicId: 'topic-1', domain: 'general' },
        );

        expect(result.success).to.equal(true);
        expect(capturedOptions.domain).to.equal('general');
        expect(capturedOptions.initialToolStage).to.equal('write');
        expect(capturedOptions.useSlimPrompt).to.equal(true);
        expect(capturedOptions.forceAutoApplyWrites).to.equal(true);
        expect(capturedOptions.excludeTools).to.not.include('run_command');
        expect(capturedOptions.excludeTools).to.include('git_ops');
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
            { topicId: 'topic-1', domain: 'paradox' },
        );

        expect(result.success).to.equal(true);
        expect(capturedOptions.domain).to.equal('paradox');
        expect(capturedOptions.excludeTools).to.include.members([
            'write_file',
            'edit_file',
            'replace_lines',
        ]);
        expect(capturedOptions.excludeTools).to.not.include('write_localisation');
    });

    it('executeSubAgent: hides every mutating and nested-dispatch tool for read-only fan-out', async () => {
        const workspaceRoot = process.cwd();
        let capturedOptions: any;
        const runner = {
            toolExecutor: { workspaceRoot },
            run: async (_prompt: string, _context: any, _history: any[], options: any) => {
                capturedOptions = options;
                return {
                    code: '', explanation: 'done', validationErrors: [], isValid: true, retryCount: 0, steps: [],
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                };
            },
        };
        const orchestrator = new Orchestrator(runner as any);
        const node = {
            id: 'reader', agentType: 'plan', prompt: 'Inspect dependencies.', dependencies: [],
            priority: 'normal', status: 'pending', retryCount: 0, maxRetries: 0,
        };

        const result = await (orchestrator as any).executeSubAgent(
            node,
            new Blackboard(),
            { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            new AbortController().signal,
            () => undefined,
            { topicId: 'topic-1', domain: 'general', readOnlyFanout: true },
        );

        const { MUTATING_TOOLS } = require('../../extension/ai/tools/registry') as typeof import('../../extension/ai/tools/registry');
        expect(result.success).to.equal(true);
        expect(capturedOptions.excludeTools).to.include.members([...MUTATING_TOOLS]);
        expect(capturedOptions.excludeTools).to.include.members(['dispatch_agents', 'merge_results']);
    });

    it('executeGraph: suspends and requeues a rate-limited child before retrying', async function () {
        this.timeout(5_000);
        const eventTypes: string[] = [];
        const executor = new ParallelExecutor({
            maxConcurrency: 2,
            eventSink: {
                appendSoon: (type: string) => {
                    eventTypes.push(type);
                },
            } as any,
        });
        const graph = TaskGraphEngine.createGraph('rate limit recovery');
        TaskGraphEngine.addNode(graph, 'A', 'explore', 'inspect', { maxRetries: 1 });
        let calls = 0;

        const result = await executor.executeGraph(
            graph,
            new Blackboard(),
            async () => {
                calls++;
                if (calls === 1) {
                    return {
                        nodeId: 'A',
                        success: false,
                        output: '',
                        error: '429 Too Many Requests',
                        tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                        writtenFiles: [],
                        stepCount: 1,
                    };
                }
                return {
                    nodeId: 'A',
                    success: true,
                    output: 'done',
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount: 1,
                };
            },
            {},
        );

        expect(result.success).to.equal(true);
        expect(calls).to.equal(2);
        expect(eventTypes).to.include.members([
            'agent_suspended',
            'agent_requeued',
            'provider_capacity_changed',
        ]);
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
        const executedNodes: string[] = [];
        const runner = { toolExecutor: { workspaceRoot: process.cwd() } };
        const orchestrator = new Orchestrator(runner as any);
        (orchestrator as any).executor.executeGraph = async () => executionResult();
        (orchestrator as any).executeSubAgent = async (node: any) => {
            executedNodes.push(node.id);
            if (node.id !== 'loc_sweep') fixCalls++;
            return {
                nodeId: node.id, success: true, output: '', writtenFiles: [],
                tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 }, stepCount: 0,
            };
        };
        (orchestrator as any).qualityGate.reviewOutput = async () => gateResult(++reviewCalls >= passOnReview);
        (orchestrator as any).qualityGate.getConfig = () => ({ autoFix: true, maxFixCycles });
        (orchestrator as any).qualityGate.buildFixPrompt = () => 'fix';
        return { orchestrator, counts: () => ({ fixCalls, reviewCalls }), executedNodes };
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

    it('does not create the automatic localisation child when the user retained localisation', async () => {
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const { orchestrator, executedNodes } = makeOrchestrator(3, 1);
        const graph = TaskGraphEngine.createGraph('本地化由我自己写');
        graph.metadata.userExecutionPolicy = {
            localisationOwnership: 'user',
            warningHandling: 'ignore',
        };
        const builder = TaskGraphEngine.addNode(graph, 'builder', 'build', 'build', { plannedFiles: ['events/test.txt'] });
        builder.status = 'done';

        const result = await orchestrator.execute(graph, { abortSignal: new AbortController().signal });

        expect(result.success).to.equal(true);
        expect(executedNodes).to.not.include('loc_sweep');
    });

    it('keeps automatic localisation enabled by default', async () => {
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const { orchestrator, executedNodes } = makeOrchestrator(3, 1);
        const graph = TaskGraphEngine.createGraph('实现完整事件功能');
        const builder = TaskGraphEngine.addNode(graph, 'builder', 'build', 'build', { plannedFiles: ['events/test.txt'] });
        builder.status = 'done';

        const result = await orchestrator.execute(graph, { abortSignal: new AbortController().signal });

        expect(result.success).to.equal(true);
        expect(executedNodes).to.include('loc_sweep');
    });

    it('does not repair localisation warnings when the user ignores non-error diagnostics', async () => {
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const { orchestrator, executedNodes } = makeOrchestrator(3, 1);
        const graph = TaskGraphEngine.createGraph('忽略黄色警告');
        graph.metadata.userExecutionPolicy = {
            localisationOwnership: 'agent',
            warningHandling: 'ignore',
        };
        const builder = TaskGraphEngine.addNode(graph, 'builder', 'build', 'build', { plannedFiles: ['events/test.txt'] });
        builder.status = 'done';

        const result = await orchestrator.execute(graph, { abortSignal: new AbortController().signal });

        expect(result.success).to.equal(true);
        expect(executedNodes).to.not.include('loc_sweep');
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

    it('does not auto-fix when the reviewer itself failed to complete', async () => {
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const { orchestrator, counts } = makeOrchestrator(3, Number.POSITIVE_INFINITY);
        (orchestrator as any).qualityGate.reviewOutput = async () => ({
            ...gateResult(false),
            operationalFailure: true,
        });
        const graph = TaskGraphEngine.createGraph('quality reviewer failure');
        const builder = TaskGraphEngine.addNode(graph, 'builder', 'build', 'build', { plannedFiles: ['events/test.txt'] });
        builder.status = 'done';

        const result = await orchestrator.execute(graph, { abortSignal: new AbortController().signal });

        expect(result.success).to.equal(false);
        expect(result.qualityGate?.operationalFailure).to.equal(true);
        expect(counts()).to.deep.equal({ reviewCalls: 0, fixCalls: 0 });
    });

    it('uses utility repairs and skips Paradox localisation sweep for general code', async () => {
        const { Orchestrator } = require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator');
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const orchestrator = new Orchestrator({ toolExecutor: { workspaceRoot: process.cwd() } } as any);
        (orchestrator as any).executor.executeGraph = async () => ({
            success: true,
            summary: 'utility complete',
            agentResults: new Map([['utility', {
                nodeId: 'utility', success: true, output: 'done', writtenFiles: ['package.json'],
                tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 }, stepCount: 1,
            }]]),
            totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            failedNodes: [], cancelledNodes: [],
        });
        const repairRoles: string[] = [];
        (orchestrator as any).executeSubAgent = async (node: any) => {
            repairRoles.push(node.agentType);
            return {
                nodeId: node.id, success: true, output: '', writtenFiles: [],
                tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 }, stepCount: 1,
            };
        };
        let reviews = 0;
        (orchestrator as any).qualityGate.reviewOutput = async () => gateResult(++reviews > 1);
        (orchestrator as any).qualityGate.getConfig = () => ({ autoFix: true, maxFixCycles: 1 });
        (orchestrator as any).qualityGate.buildFixPrompt = () => 'fix general code';
        const graph = TaskGraphEngine.createGraph('general code');
        const utility = TaskGraphEngine.addNode(graph, 'utility', 'utility', 'edit package', { plannedFiles: ['package.json'] });
        utility.status = 'done';

        const result = await orchestrator.execute(graph, { abortSignal: new AbortController().signal });

        expect(result.success).to.equal(true);
        expect(repairRoles).to.deep.equal(['utility']);
    });

    it('does not launch a code repair agent when only final validation is pending', async () => {
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const { orchestrator, counts } = makeOrchestrator(3, Number.POSITIVE_INFINITY);
        (orchestrator as any).qualityGate.reviewOutput = async () => ({
            ...gateResult(true),
            passed: false,
            validationPending: 1,
            reviewReport: 'diagnostics pending',
        });
        const graph = TaskGraphEngine.createGraph('quality pending');
        const builder = TaskGraphEngine.addNode(graph, 'builder', 'build', 'build', { plannedFiles: ['events/test.txt'] });
        builder.status = 'done';

        const result = await orchestrator.execute(graph, { abortSignal: new AbortController().signal });

        expect(result.success).to.equal(false);
        expect(result.qualityGate?.validationPending).to.equal(1);
        expect(counts()).to.deep.equal({ reviewCalls: 0, fixCalls: 0 });
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

    it('checks every EvidenceGate PDX file type with full-file diagnostics', () => {
        expect([...PDX_DIAGNOSTIC_EXTENSIONS]).to.deep.equal(['.txt', '.gui', '.gfx', '.asset', '.entity']);
        expect(isPdxDiagnosticFile('events/test.txt')).to.equal(true);
        expect(isPdxDiagnosticFile('interface/test.gui')).to.equal(true);
        expect(isPdxDiagnosticFile('localisation/test_l_english.yml')).to.equal(false);
        expect(isPdxDiagnosticFile('interface/sprites.gfx')).to.equal(true);
        expect(isPdxDiagnosticFile('sound/test.asset')).to.equal(true);
        expect(isPdxDiagnosticFile('gfx/models/test.entity')).to.equal(true);
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

        expect(prompt).to.include('.txt, .gui, .gfx, .asset, .entity');
        expect(prompt).to.include('LSP diagnostic target files include: events/test.txt, interface/test.gui, interface/sprites.gfx, sound/test.asset');
        expect(prompt).to.not.include('localisation/test_l_english.yml, interface/sprites.gfx');
    });

    it('tells the quality reviewer that user-owned localisation warnings are non-blocking', () => {
        const qg = new QualityGate();
        const { TaskGraphEngine } = require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine');
        const graph = TaskGraphEngine.createGraph('本地化由用户处理');
        graph.metadata.userExecutionPolicy = {
            localisationOwnership: 'user',
            warningHandling: 'ignore',
        };

        const prompt = qg.buildCombinedReviewPrompt(['events/test.txt'], undefined, { taskGraph: graph });

        expect(prompt).to.include('Localisation ownership: user');
        expect(prompt).to.include('Warning handling: ignore');
        expect(prompt).to.include('Error-severity LSP diagnostics remain blocking');
        expect(prompt).to.include('Do not request, suggest, or perform localisation writes');
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
        let reviewerOptions: any;
        const reviewSteps: any[] = [];
        const runner = {
            toolExecutor: {
                workspaceRoot: process.cwd(),
                execute: async () => ({ totalDiagnosticCount: 0 }),
            },
            run: async (_prompt: string, _context: any, _history: any[], options: any) => {
                reviewerOptions = options;
                return {
                    explanation: '```json\n{"logicIssuesCount":0,"logicIssues":[],"fixSuggestions":[],"acceptanceEvidence":[],"acceptanceFailures":[]}\n```',
                    isValid: true,
                    validationErrors: [],
                    retryCount: 0,
                    steps: [],
                    tokenUsage: {
                        total: 120,
                        input: 100,
                        output: 20,
                        estimatedCostCny: 0.2,
                        cachedTokens: 40,
                        netInput: 60,
                        netTotal: 80,
                        apiCalls: 2,
                        cacheRequests: [{
                            provider: 'deepseek', model: 'deepseek-chat', inputTokens: 100, cachedTokens: 40,
                            cacheCapable: true, agentMode: 'script_reviewer', toolStage: 'validation',
                            promptFingerprint: 'review-fp', purpose: 'reasoning',
                        }],
                    },
                };
            },
        };
        const usage: import('../../extension/ai/types').TokenUsage = {
            total: 0,
            input: 0,
            output: 0,
            estimatedCostCny: 0,
        };

        const result = await new QualityGate().reviewOutput(
            runner as any,
            ['package.json'],
            { onStep: step => reviewSteps.push(step) },
            { taskGraph: graph, workspaceRoot: process.cwd() },
            usage,
        );

        expect(result.passed).to.equal(false);
        expect(result.acceptanceFailures[0]).to.include('functional_chain');
        expect(reviewerOptions.mode).to.equal('review');
        expect(reviewerOptions.useSlimPrompt).to.equal(true);
        expect(reviewerOptions.maxIterations).to.equal(15);
        expect(reviewerOptions.skipValidation).to.equal(true);
        expect(reviewerOptions.abortSignal).to.be.instanceOf(AbortSignal);
        expect(reviewSteps.map(step => step.type)).to.deep.equal(['subtask_start', 'subtask_complete']);
        expect(reviewSteps.every(step => step.agentId === 'quality_gate_review')).to.equal(true);
        expect(usage).to.include({
            total: 120,
            input: 100,
            output: 20,
            estimatedCostCny: 0.2,
            cachedTokens: 40,
            netInput: 60,
            netTotal: 80,
            apiCalls: 2,
        });
        expect(usage.cacheRequests?.[0]?.promptFingerprint).to.equal('review-fp');
    });

    it('reviewOutput keeps pending diagnostics distinct from a passed final check', async () => {
        const runner = {
            toolExecutor: {
                workspaceRoot: process.cwd(),
                execute: async () => ({ totalDiagnosticCount: 0, diagnostics: [], freshness: 'pending' }),
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
            ['events/test.txt'],
            {},
        );

        expect(result.passed).to.equal(false);
        expect(result.diagnosticErrors).to.equal(0);
        expect(result.validationPending).to.equal(1);
    });

    it('accepts bounded extraction coverage only after fresh full-file diagnostics', async () => {
        const target = path.resolve('interface/large.gfx');
        const runner = {
            toolExecutor: {
                workspaceRoot: process.cwd(),
                finalizePdxEvidence: async () => ({
                    passed: false,
                    filesChecked: [target],
                    conflictFiles: [],
                    pendingFiles: [target],
                    coveragePendingFiles: [target],
                    report: 'coverage-pending',
                }),
                execute: async () => ({ totalDiagnosticCount: 0, diagnostics: [], freshness: 'fresh' }),
            },
            run: async () => ({
                explanation: '```json\n{"logicIssuesCount":0,"logicIssues":[],"fixSuggestions":[],"acceptanceEvidence":[],"acceptanceFailures":[]}\n```',
                isValid: true,
                validationErrors: [],
                retryCount: 0,
                steps: [],
            }),
        };

        const result = await new QualityGate().reviewOutput(runner as any, [target], {});

        expect(result.passed).to.equal(true);
        expect(result.validationPending).to.equal(0);
        expect(result.semanticReport).to.include('fresh diagnostics covered 1 file');
    });

    it('prefetches final diagnostics with deterministic bounded concurrency', async () => {
        let active = 0;
        let maxActive = 0;
        const runner = {
            toolExecutor: {
                workspaceRoot: process.cwd(),
                finalizePdxEvidence: async () => ({
                    passed: true,
                    filesChecked: [],
                    conflictFiles: [],
                    pendingFiles: [],
                    coveragePendingFiles: [],
                    report: '',
                }),
                execute: async () => {
                    active++;
                    maxActive = Math.max(maxActive, active);
                    await new Promise(resolve => setTimeout(resolve, 20));
                    active--;
                    return { totalDiagnosticCount: 0, diagnostics: [], freshness: 'fresh' };
                },
            },
            run: async () => ({
                explanation: '```json\n{"logicIssuesCount":0,"logicIssues":[],"fixSuggestions":[],"acceptanceEvidence":[],"acceptanceFailures":[]}\n```',
                isValid: true,
                validationErrors: [],
                retryCount: 0,
                steps: [],
            }),
        };
        const files = Array.from({ length: 10 }, (_, index) => `events/test_${index}.txt`);

        const result = await new QualityGate().reviewOutput(runner as any, files, {});

        expect(result.passed).to.equal(true);
        expect(maxActive).to.equal(4);
    });

    it('reviewOutput stops promptly when the parent run is cancelled', async () => {
        const controller = new AbortController();
        const runner = {
            toolExecutor: {
                workspaceRoot: process.cwd(),
                finalizePdxEvidence: async () => new Promise(() => {}),
                execute: async () => ({ totalDiagnosticCount: 0 }),
            },
            run: async () => new Promise(() => {}),
        };
        const pending = new QualityGate().reviewOutput(
            runner as any,
            ['events/test.txt'],
            { abortSignal: controller.signal },
        );
        controller.abort(new Error('parent cancelled'));

        let failure: unknown;
        try {
            await Promise.race([
                pending,
                new Promise((_, reject) => setTimeout(() => reject(new Error('review cancellation timed out')), 250)),
            ]);
        } catch (error) {
            failure = error;
        }

        expect(failure).to.be.instanceOf(Error);
        expect((failure as Error).message).to.equal('parent cancelled');
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
            ['events/samplemod_force_echo_events.txt'],
            'File: events/samplemod_force_echo_events.txt\n[{"message":"Expected value of type sprite","line":299,"column":12}]',
        );

        expect(prompt).to.include('Sprite Resource Diagnostic Protocol');
        expect(prompt).to.include('find_sprite_candidates');
        expect(prompt).to.include('never a raw `.dds` file path');
    });

    it('buildFixPrompt: sprite issues require verified candidates', () => {
        const qg = new QualityGate();
        const prompt = qg.buildFixPrompt(
            'FAILED: 1 issue need to be fixed\nLine 299: Expected value of type sprite for picture = GFX_evt_analyzing_anomaly',
            ['events/samplemod_force_echo_events.txt'],
        );

        expect(prompt).to.include('find_sprite_candidates');
        expect(prompt).to.include('never invent a `GFX_*` name');
    });

    it('buildFixPrompt: show_sound issues require verified asset candidates', () => {
        const qg = new QualityGate();
        const prompt = qg.buildFixPrompt(
            'FAILED: 1 issue need to be fixed\nLine 42: show_sound = samplemod_force_echo_missing references an unknown sound asset',
            ['events/samplemod_force_echo_events.txt'],
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
