/**
 * 多 Agent 协调器模块 — 单元测试
 *
 * 覆盖 Blackboard、TaskGraphEngine、ConflictDetector、QualityGate、AgentRegistry。
 * 使用 ts-mocha + chai，与项目现有测试风格保持一致。
 */

import { expect } from 'chai';

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
        expect(bb.read('cas')!.value).to.equal('v2'); // 未被改变
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

    // ── 兼容层测试 ──
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

    /** 创建一个简单的钻石形 DAG：A → (B, C) → D */
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
        // 初始状态只有 A 就绪
        let ready = engine.getReadyNodes(graph);
        expect(ready.map(n => n.id)).to.deep.equal(['A']);
        // 完成 A
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
        // B 失败应级联取消 D（依赖 B）
        expect(graph.nodes.get('B')!.status).to.equal('failed');
        expect(cancelled).to.include('D');
        expect(graph.nodes.get('D')!.status).to.equal('cancelled');
        // C 不受影响
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
        // 手动创建环：X → Y → Z → X
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
        expect(result.hasConflict).to.be.false; // 同一 Agent 不冲突
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

// ── QualityGate ───────────────────────────────────────────────────────────────

describe('QualityGate', () => {
    let QualityGate: typeof import('../../extension/ai/orchestrator/qualityGate').QualityGate;

    before(() => {
        QualityGate = require('../../extension/ai/orchestrator/qualityGate').QualityGate;
    });

    it('buildReviewPrompt: 生成包含文件列表的审查提示', () => {
        const qg = new QualityGate();
        const mockResult = {
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

    it('parseReviewResult: 识别通过结果', () => {
        const qg = new QualityGate();
        const result = qg.parseReviewResult('PASSED: All checks passed, code is clean.');
        expect(result.passed).to.be.true;
        expect(result.issueCount).to.equal(0);
    });

    it('parseReviewResult: 识别失败结果', () => {
        const qg = new QualityGate();
        const result = qg.parseReviewResult('FAILED: 3 issues need fixing.');
        expect(result.passed).to.be.false;
        expect(result.issueCount).to.equal(3);
    });

    it('buildFixPrompt: 包含审查报告和文件列表', () => {
        const qg = new QualityGate();
        const prompt = qg.buildFixPrompt('Missing localization keys', ['events/main.txt']);
        expect(prompt).to.include('Missing localization keys');
        expect(prompt).to.include('events/main.txt');
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
        expect(profile.mode).to.equal('build'); // 默认 builder
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
