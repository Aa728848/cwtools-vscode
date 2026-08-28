import { expect } from 'chai';
import {
    reduceRunState,
    reduceToolTimeline,
    reduceAgentGraph,
    reduceCacheStats,
    reduceRuntimeItems,
    reduceScheduling,
    reduceAll,
} from '../../extension/ai/runner/runReducers';
import type { AgentRunEvent } from '../../extension/ai/runner/runLedger';
import { schedulingStateFromAdmission } from '../../extension/ai/runner/scheduling';

function ev(type: AgentRunEvent['type'], extra: Partial<AgentRunEvent> = {}, payload: any = {}): AgentRunEvent {
    return {
        eventId: extra.eventId ?? `${type}-${Math.random().toString(36).slice(2, 8)}`,
        runId: extra.runId ?? 'run_1',
        sequence: extra.sequence ?? 0,
        timestamp: extra.timestamp ?? Date.now(),
        type,
        status: extra.status,
        invocationId: extra.invocationId,
        agentId: extra.agentId,
        payload,
    };
}

describe('RunReducers — pure event projections (T3.2)', () => {
    describe('reduceScheduling', () => {
        it('projects admission, phase, prompt, dispatch, and capacity events', () => {
            const snapshot = reduceScheduling([
                ev('admission_decided', {}, {
                    domainProfile: 'general',
                    authorization: 'workspace_write',
                    initialPhase: 'execute',
                    confidence: 0.9,
                    evidence: ['TypeScript'],
                }),
                ev('phase_changed', {}, { to: 'execute', revision: 1 }),
                ev('prompt_queued'),
                ev('prompt_steered'),
                ev('dispatch_evaluated', {}, { accepted: true }),
                ev('provider_capacity_changed', {}, { current: 2 }),
            ]);
            expect(snapshot).to.include({
                domainProfile: 'general',
                authorization: 'workspace_write',
                phase: 'execute',
                dispatch: 'parallel',
                routeConfidence: 0.9,
                queuedPrompts: 1,
                steeredPrompts: 1,
                dispatchEvaluations: 1,
                dispatchAccepted: 1,
                providerCapacity: 2,
            });
        });
    });

    describe('reduceRunState', () => {
        it('marks status running on run_created and completed from status_changed payload', () => {
            const events: AgentRunEvent[] = [
                ev('run_created', { timestamp: 1 }),
                ev('status_changed', { timestamp: 2 }, { status: 'completed' }),
            ];
            const snap = reduceRunState(events);
            expect(snap.status).to.equal('completed');
            expect(snap.startedAt).to.equal(1);
            expect(snap.endedAt).to.equal(2);
        });

        it('accumulates token usage from model_call_end', () => {
            const events: AgentRunEvent[] = [
                ev('model_call_end', {}, { usage: { prompt_tokens: 100, completion_tokens: 50, cached_tokens: 30 } }),
                ev('model_call_end', {}, { usage: { prompt_tokens: 80, completion_tokens: 40, cached_tokens: 50 } }),
            ];
            const snap = reduceRunState(events);
            expect(snap.totalInputTokens).to.equal(180);
            expect(snap.totalOutputTokens).to.equal(90);
            expect(snap.totalCachedTokens).to.equal(80);
            expect(snap.iterations).to.equal(2);
        });

        it('counts tool calls and errors', () => {
            const events: AgentRunEvent[] = [
                ev('tool_call_end'),
                ev('tool_call_end'),
                ev('error'),
            ];
            const snap = reduceRunState(events);
            expect(snap.toolCallCount).to.equal(2);
            expect(snap.errorCount).to.equal(1);
        });
    });

    describe('reduceToolTimeline', () => {
        it('joins tool_call_created / start / end into one entry per invocationId', () => {
            const inv = 'inv_1';
            const events: AgentRunEvent[] = [
                ev('tool_call_created', { invocationId: inv, timestamp: 1 }, { toolName: 'read_file', toolArgs: { file: 'a.txt' } }),
                ev('tool_call_start', { invocationId: inv, timestamp: 2 }),
                ev('tool_call_end', { invocationId: inv, timestamp: 3, status: 'done' }, { success: true }),
            ];
            const snap = reduceToolTimeline(events);
            expect(snap.entries).to.have.length(1);
            const e = snap.entries[0]!;
            expect(e.toolName).to.equal('read_file');
            expect(e.startedAt).to.equal(2);
            expect(e.endedAt).to.equal(3);
            expect(e.success).to.equal(true);
        });

        it('filters by agentId when supplied', () => {
            const events: AgentRunEvent[] = [
                ev('tool_call_created', { invocationId: 'a', agentId: 'agent_root' }, { toolName: 't1' }),
                ev('tool_call_created', { invocationId: 'b', agentId: 'agent_sub' }, { toolName: 't2' }),
            ];
            const subOnly = reduceToolTimeline(events, { agentId: 'agent_sub' });
            expect(subOnly.entries).to.have.length(1);
            expect(subOnly.entries[0]!.toolName).to.equal('t2');
        });

        it('groups entries by agent in byAgent map', () => {
            const events: AgentRunEvent[] = [
                ev('tool_call_created', { invocationId: 'a', agentId: 'agent_root' }, { toolName: 't1' }),
                ev('tool_call_created', { invocationId: 'b', agentId: 'agent_sub' }, { toolName: 't2' }),
                ev('tool_call_created', { invocationId: 'c' }, { toolName: 't3' }),
            ];
            const snap = reduceToolTimeline(events);
            expect(snap.byAgent.get('agent_root')).to.have.length(1);
            expect(snap.byAgent.get('agent_sub')).to.have.length(1);
            expect(snap.byAgent.get('__root__')).to.have.length(1);
        });
    });

    describe('reduceAgentGraph', () => {
        it('builds parent → child topology from subagent_start', () => {
            const events: AgentRunEvent[] = [
                ev('run_created', {}, { parentAgentId: 'root' }),
                ev('subagent_start', {}, { agentId: 'sub_a', parentAgentId: 'root', role: 'gui_expert' }),
                ev('subagent_end', {}, { agentId: 'sub_a', success: true }),
            ];
            const snap = reduceAgentGraph(events);
            expect(snap.rootAgentId).to.equal('root');
            const sub = snap.nodeById.get('sub_a')!;
            expect(sub.parentAgentId).to.equal('root');
            expect(sub.role).to.equal('gui_expert');
            expect(sub.status).to.equal('done');
        });

        it('marks sub-agent as refused on subagent_refused with reason', () => {
            const events: AgentRunEvent[] = [
                ev('subagent_start', {}, { agentId: 'sub_b' }),
                ev('subagent_refused', {}, {
                    agentId: 'sub_b',
                    reason: 'SANDBOX_VIOLATION',
                    detail: 'Path outside sandbox',
                }),
            ];
            const snap = reduceAgentGraph(events);
            const node = snap.nodeById.get('sub_b')!;
            expect(node.status).to.equal('refused');
            expect(node.refusalReason).to.contain('SANDBOX_VIOLATION');
        });

        it('counts blackboard writes and conflicts per agent', () => {
            const events: AgentRunEvent[] = [
                ev('subagent_start', {}, { agentId: 'sub_c' }),
                ev('blackboard_write', { agentId: 'sub_c' }),
                ev('blackboard_write', { agentId: 'sub_c' }),
                ev('conflict_detected', { agentId: 'sub_c' }),
            ];
            const snap = reduceAgentGraph(events);
            const node = snap.nodeById.get('sub_c')!;
            expect(node.blackboardWrites).to.equal(2);
            expect(node.conflicts).to.equal(1);
        });
    });

    describe('reduceCacheStats', () => {
        it('aggregates cache_stats events per agent', () => {
            const events: AgentRunEvent[] = [
                ev('cache_stats', { agentId: 'root' }, { cachedTokens: 100, inputTokens: 500, savedCostCny: 0.05 }),
                ev('cache_stats', { agentId: 'root' }, { cachedTokens: 200, inputTokens: 500, savedCostCny: 0.1 }),
                ev('cache_stats', { agentId: 'sub' }, { cachedTokens: 50, inputTokens: 200, savedCostCny: 0.02 }),
            ];
            const snap = reduceCacheStats(events);
            expect(snap.totalCachedTokens).to.equal(350);
            expect(snap.totalInputTokens).to.equal(1200);
            expect(snap.aggregateHitRate).to.be.closeTo(350 / 1200, 0.0001);
            const root = snap.byAgent.find(b => b.agentId === 'root')!;
            expect(root.cachedTokens).to.equal(300);
            expect(root.callCount).to.equal(2);
            expect(root.hitRate).to.be.closeTo(300 / 1000, 0.0001);
        });

        it('captures Anthropic cache_creation_tokens', () => {
            const events: AgentRunEvent[] = [
                ev('cache_stats', {}, { cachedTokens: 0, inputTokens: 1000, cacheCreationTokens: 1000 }),
            ];
            const snap = reduceCacheStats(events);
            expect(snap.totalCacheCreationTokens).to.equal(1000);
        });
    });

    describe('reduceRuntimeItems', () => {
        it('replays canonical item lifecycle events into a stable latest snapshot', () => {
            const events: AgentRunEvent[] = [
                ev('item_started', { timestamp: 10 }, { itemId: 'permission_1', type: 'permission', status: 'awaitingApproval', title: 'Run command' }),
                ev('item_updated', { timestamp: 11 }, { itemId: 'permission_1', status: 'inProgress', metadata: { reviewer: 'user' } }),
                ev('item_completed', { timestamp: 12 }, { itemId: 'permission_1', status: 'completed', metadata: { decision: 'accept' } }),
            ];
            const snap = reduceRuntimeItems(events);
            expect(snap.items).to.have.length(1);
            expect(snap.byId.get('permission_1')).to.include({ status: 'completed', completedAt: 12 });
            expect(snap.byId.get('permission_1')?.metadata).to.deep.equal({ reviewer: 'user', decision: 'accept' });
        });
    });

    describe('reduceAll', () => {
        it('returns the same shape for one-shot consumers', () => {
            const snap = reduceAll([ev('run_created', { timestamp: 1 })]);
            expect(snap.state.startedAt).to.equal(1);
            expect(snap.toolTimeline.entries).to.have.length(0);
            expect(snap.agentGraph.nodes.length).to.be.greaterThanOrEqual(0);
            expect(snap.cacheStats.totalCachedTokens).to.equal(0);
            expect(snap.runtimeItems.items).to.have.length(0);
        });
    });
});

// ─── Pre-existing RunLedger smoke (kept for parity) ──────────────────────────

describe('RunReducers & Structured Events', () => {
    it('RunLedger singleton returns correct instance', () => {
        const { RunLedger } = loadRunLedgerModule();
        const ledger = RunLedger.getInstance();
        expect(ledger).to.not.equal(undefined);
    });

    it('latestActiveRunId gets updated correctly on createRun', async () => {
        const { RunLedger } = loadRunLedgerModule();
        const ledger = RunLedger.getInstance();
        const run = await ledger.createRun('topic_1', schedulingStateFromAdmission({
            domainProfile: 'general', authorization: 'workspace_write', initialPhase: 'execute',
            explicitDelegation: false, confidence: 1, evidence: ['test'],
        }), 'test prompt');
        expect(RunLedger.getLatestActiveRunId()).to.equal(run.runId);
    });

    it('rebuilds scheduling state from unapplied ledger events', () => {
        const { RunLedger } = loadRunLedgerModule();
        const ledger = RunLedger.getInstance();
        const record = {
            schedulingState: schedulingStateFromAdmission({
                domainProfile: 'general', authorization: 'workspace_write', initialPhase: 'execute',
                explicitDelegation: false, confidence: 1, evidence: ['test'],
            }),
            steps: [],
            writtenFiles: [],
            metrics: {},
        } as any;
        (ledger as any).applyPersistedEvents(record, [
            ev('admission_decided', {}, {
                domainProfile: 'general',
                authorization: 'workspace_write',
                initialPhase: 'execute',
                explicitDelegation: false,
                confidence: 0.9,
                evidence: ['TypeScript'],
            }),
            ev('phase_changed', {}, { to: 'execute', reason: 'write stage', revision: 1 }),
            ev('dispatch_evaluated', {}, { accepted: true, reason: 'independent tasks' }),
        ]);

        expect(record.schedulingState).to.include({
            domainProfile: 'general',
            authorization: 'workspace_write',
            phase: 'execute',
            dispatch: 'parallel',
        });
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
