/**
 * Pure event-projection reducers for run state (T3.2).
 *
 * Each function takes a slice of AgentRunEvent[] and produces an immutable
 * snapshot the Webview consumes. Reducers are pure and side-effect-free so
 * that they can be unit-tested in isolation and re-played from `runLedger`
 * JSONL streams without touching the live RunLedger singleton.
 *
 * Per the plan:
 *  - `reduceRunState` — overall run progress, token counts, status.
 *  - `reduceToolTimeline` — turn-by-turn tool call list, agentId-filterable.
 *  - `reduceAgentGraph` — parent / sub-agent topology with sandbox-rejection markers.
 *  - `reduceCacheStats` — per-agent prefix-cache hit aggregation.
 *
 * Reducers iterate events once; callers are expected to slice by runId upstream.
 */

import type { AgentRunEvent, AgentRunEventType } from './runLedger';
import type { RuntimeItem, RuntimeItemStatus, RuntimeItemType } from './runtimeItems';
import type {
    AgentAuthorization,
    AgentDispatchMode,
    AgentRunPhase,
    AgentRuntimeDomain,
} from '../types';

// ─── Run state ───────────────────────────────────────────────────────────────

export interface RunStateSnapshot {
    runId: string | undefined;
    status: 'pending' | 'planning' | 'running' | 'completed' | 'done' | 'failed' | 'cancelled' | 'unknown';
    startedAt: number | undefined;
    endedAt: number | undefined;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalCacheCreationTokens: number;
    iterations: number;
    toolCallCount: number;
    errorCount: number;
    lastStepContent: string | undefined;
}

export function reduceRunState(events: AgentRunEvent[]): RunStateSnapshot {
    const snap: RunStateSnapshot = {
        runId: events[0]?.runId,
        status: 'unknown',
        startedAt: undefined,
        endedAt: undefined,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCacheCreationTokens: 0,
        iterations: 0,
        toolCallCount: 0,
        errorCount: 0,
        lastStepContent: undefined,
    };
    for (const ev of events) {
        const p = ev.payload as Record<string, any> | undefined;
        switch (ev.type) {
            case 'run_created':
                snap.startedAt = ev.timestamp;
                snap.status = 'running';
                break;
            case 'status_changed': {
                const status = normalizeRunStatus(p?.status);
                if (status) snap.status = status;
                if (isTerminalRunStatus(status)) {
                    snap.endedAt = ev.timestamp;
                }
                break;
            }
            case 'model_call_end': {
                snap.iterations++;
                if (p?.usage) {
                    snap.totalInputTokens += p.usage.prompt_tokens ?? 0;
                    snap.totalOutputTokens += p.usage.completion_tokens ?? 0;
                    snap.totalCachedTokens += p.usage.cached_tokens ?? 0;
                    snap.totalCacheCreationTokens += p.usage.cache_creation_tokens ?? 0;
                }
                break;
            }
            case 'cache_stats': {
                snap.totalCachedTokens += p?.cachedTokens ?? 0;
                snap.totalCacheCreationTokens += p?.cacheCreationTokens ?? 0;
                break;
            }
            case 'tool_call_end':
                snap.toolCallCount++;
                break;
            case 'error':
                snap.errorCount++;
                break;
            case 'step_appended': {
                if (typeof p?.content === 'string') snap.lastStepContent = p.content;
                break;
            }
        }
    }
    return snap;
}

function normalizeRunStatus(value: unknown): RunStateSnapshot['status'] | undefined {
    if (value === 'pending'
        || value === 'planning'
        || value === 'running'
        || value === 'completed'
        || value === 'done'
        || value === 'failed'
        || value === 'cancelled'
        || value === 'unknown') {
        return value;
    }
    return undefined;
}

function isTerminalRunStatus(status: RunStateSnapshot['status'] | undefined): boolean {
    return status === 'completed' || status === 'done' || status === 'failed' || status === 'cancelled';
}

// ─── Tool timeline ───────────────────────────────────────────────────────────

export interface ToolTimelineEntry {
    invocationId: string | undefined;
    agentId: string | undefined;
    toolName: string;
    toolArgs: any;
    startedAt: number | undefined;
    endedAt: number | undefined;
    status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
    success: boolean | undefined;
    errorMessage: string | undefined;
}

export interface ToolTimelineSnapshot {
    entries: ToolTimelineEntry[];
    byAgent: Map<string, ToolTimelineEntry[]>;
}

export interface ToolTimelineOptions {
    agentId?: string;
}

export function reduceToolTimeline(events: AgentRunEvent[], opts: ToolTimelineOptions = {}): ToolTimelineSnapshot {
    const map = new Map<string, ToolTimelineEntry>();
    const ordered: ToolTimelineEntry[] = [];
    for (const ev of events) {
        if (opts.agentId && ev.agentId && ev.agentId !== opts.agentId) continue;
        const id = ev.invocationId;
        if (!id) {
            // events without invocationId only matter when correlated, skip
            continue;
        }
        let entry = map.get(id);
        if (!entry) {
            entry = {
                invocationId: id,
                agentId: ev.agentId,
                toolName: '',
                toolArgs: undefined,
                startedAt: undefined,
                endedAt: undefined,
                status: 'pending',
                success: undefined,
                errorMessage: undefined,
            };
            map.set(id, entry);
            ordered.push(entry);
        }
        const p = ev.payload as Record<string, any> | undefined;
        switch (ev.type) {
            case 'tool_call_created':
                entry.toolName = p?.toolName ?? entry.toolName;
                entry.toolArgs = p?.toolArgs ?? entry.toolArgs;
                entry.status = 'pending';
                break;
            case 'tool_call_start':
                entry.startedAt = ev.timestamp;
                entry.status = 'running';
                break;
            case 'tool_call_end':
                entry.endedAt = ev.timestamp;
                entry.status = ev.status as ToolTimelineEntry['status'] ?? 'done';
                entry.success = (p?.success !== false);
                entry.errorMessage = p?.error ?? p?.errorMessage;
                break;
        }
    }
    const byAgent = new Map<string, ToolTimelineEntry[]>();
    for (const e of ordered) {
        const key = e.agentId ?? '__root__';
        const arr = byAgent.get(key) ?? [];
        arr.push(e);
        byAgent.set(key, arr);
    }
    return { entries: ordered, byAgent };
}

// ─── Agent graph ─────────────────────────────────────────────────────────────

export interface AgentGraphNode {
    agentId: string;
    role: string | undefined;
    parentAgentId: string | undefined;
    status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'refused';
    refusalReason: string | undefined;
    toolCallCount: number;
    blackboardWrites: number;
    conflicts: number;
}

export interface AgentGraphSnapshot {
    rootAgentId: string | undefined;
    nodes: AgentGraphNode[];
    nodeById: Map<string, AgentGraphNode>;
}

export function reduceAgentGraph(events: AgentRunEvent[]): AgentGraphSnapshot {
    const nodes = new Map<string, AgentGraphNode>();
    let rootAgentId: string | undefined;

    function ensure(id: string, parent?: string): AgentGraphNode {
        let n = nodes.get(id);
        if (!n) {
            n = {
                agentId: id,
                role: undefined,
                parentAgentId: parent,
                status: 'pending',
                refusalReason: undefined,
                toolCallCount: 0,
                blackboardWrites: 0,
                conflicts: 0,
            };
            nodes.set(id, n);
        } else if (parent && !n.parentAgentId) {
            n.parentAgentId = parent;
        }
        return n;
    }

    for (const ev of events) {
        const p = ev.payload as Record<string, any> | undefined;
        switch (ev.type) {
            case 'run_created': {
                const id = p?.parentAgentId ?? ev.agentId ?? 'root';
                if (!rootAgentId) rootAgentId = id;
                ensure(id);
                break;
            }
            case 'subagent_start': {
                const aid = p?.agentId ?? ev.agentId;
                const parent = p?.parentAgentId ?? rootAgentId;
                if (aid) {
                    const node = ensure(aid, parent);
                    node.role = p?.role ?? node.role;
                    node.status = 'running';
                }
                break;
            }
            case 'subagent_end': {
                const aid = p?.agentId ?? ev.agentId;
                if (aid) {
                    const node = ensure(aid);
                    node.status = (p?.success === false) ? 'failed' : 'done';
                }
                break;
            }
            case 'subagent_refused': {
                const aid = p?.agentId ?? ev.agentId;
                if (aid) {
                    const node = ensure(aid);
                    node.status = 'refused';
                    node.refusalReason = p?.reason ? `${p.reason}${p.detail ? `: ${p.detail}` : ''}` : node.refusalReason;
                }
                break;
            }
            case 'tool_call_end': {
                const aid = ev.agentId ?? rootAgentId;
                if (aid) ensure(aid).toolCallCount++;
                break;
            }
            case 'blackboard_write': {
                const aid = ev.agentId ?? rootAgentId;
                if (aid) ensure(aid).blackboardWrites++;
                break;
            }
            case 'conflict_detected': {
                const aid = ev.agentId ?? rootAgentId;
                if (aid) ensure(aid).conflicts++;
                break;
            }
        }
    }

    return {
        rootAgentId,
        nodes: Array.from(nodes.values()),
        nodeById: nodes,
    };
}

// ─── Cache stats ─────────────────────────────────────────────────────────────

export interface CacheStatsAgentBucket {
    agentId: string;
    cachedTokens: number;
    inputTokens: number;
    cacheCreationTokens: number;
    savedCostCny: number;
    callCount: number;
    hitRate: number;
}

export interface CacheStatsSnapshot {
    totalCachedTokens: number;
    totalInputTokens: number;
    totalCacheCreationTokens: number;
    totalSavedCostCny: number;
    aggregateHitRate: number;
    byAgent: CacheStatsAgentBucket[];
}

export function reduceCacheStats(events: AgentRunEvent[]): CacheStatsSnapshot {
    const buckets = new Map<string, CacheStatsAgentBucket>();
    let totalCached = 0;
    let totalInput = 0;
    let totalCreation = 0;
    let totalSaved = 0;
    const records: Array<{ ev: AgentRunEvent; payload: Record<string, any>; agentId: string; key: string; score: number }> = [];
    for (const ev of events) {
        if (ev.type !== 'cache_stats') continue;
        const p = (ev.payload as Record<string, any>) ?? {};
        const cached = p.cachedTokens ?? p.totalCachedTokens ?? 0;
        const input = p.inputTokens ?? p.totalTokens ?? 0;
        const creation = p.cacheCreationTokens ?? 0;
        const output = p.outputTokens ?? p.completionTokens ?? 0;
        const saved = p.savedCostCny ?? 0;
        const agentId = ev.agentId ?? p.agentId ?? '__root__';
        const key = `${p.providerId ?? ''}|${p.model ?? ''}|${input}|${cached}|${creation}|${output}`;
        const score = (agentId === '__root__' ? 0 : 2) + (saved ? 1 : 0);
        const duplicateIndex = records.findIndex(record =>
            record.key === key
            && Math.abs((record.ev.sequence ?? 0) - (ev.sequence ?? 0)) <= 4
            && Math.abs((record.ev.timestamp ?? 0) - (ev.timestamp ?? 0)) <= 10_000
        );
        if (duplicateIndex >= 0) {
            if (score > records[duplicateIndex]!.score) {
                records[duplicateIndex] = { ev, payload: p, agentId, key, score };
            }
            continue;
        }
        records.push({ ev, payload: p, agentId, key, score });
    }
    for (const record of records) {
        const p = record.payload;
        const agentId = record.agentId;
        const bucket = buckets.get(agentId) ?? {
            agentId,
            cachedTokens: 0,
            inputTokens: 0,
            cacheCreationTokens: 0,
            savedCostCny: 0,
            callCount: 0,
            hitRate: 0,
        };
        const cached = p.cachedTokens ?? p.totalCachedTokens ?? 0;
        const input = p.inputTokens ?? p.totalTokens ?? 0;
        const creation = p.cacheCreationTokens ?? 0;
        const saved = p.savedCostCny ?? 0;
        bucket.cachedTokens += cached;
        bucket.inputTokens += input;
        bucket.cacheCreationTokens += creation;
        bucket.savedCostCny += saved;
        bucket.callCount++;
        bucket.hitRate = bucket.inputTokens > 0 ? bucket.cachedTokens / bucket.inputTokens : 0;
        buckets.set(agentId, bucket);
        totalCached += cached;
        totalInput += input;
        totalCreation += creation;
        totalSaved += saved;
    }
    return {
        totalCachedTokens: totalCached,
        totalInputTokens: totalInput,
        totalCacheCreationTokens: totalCreation,
        totalSavedCostCny: totalSaved,
        aggregateHitRate: totalInput > 0 ? totalCached / totalInput : 0,
        byAgent: Array.from(buckets.values()),
    };
}

// ─── Policy / approval activity ──────────────────────────────────────────────

export interface PolicyActivitySnapshot {
    policyResolvedCount: number;
    actionCounts: { allow: number; ask: number; deny: number };
    approvalsRequested: number;
    approvalsAllowed: number;
    approvalsDenied: number;
    rulesCreated: Array<{ ruleId?: string; tool?: string; commandPrefix?: string[]; createdBy?: string }>;
    reviewerDecisions: { approved: number; denied: number; askUser: number; cacheHits: number };
    sandboxDenials: number;
    evidenceGate: { decisions: number; allowed: number; blocked: number; overrides: number; degraded: number };
}

export function reducePolicyActivity(events: AgentRunEvent[]): PolicyActivitySnapshot {
    const snap: PolicyActivitySnapshot = {
        policyResolvedCount: 0,
        actionCounts: { allow: 0, ask: 0, deny: 0 },
        approvalsRequested: 0,
        approvalsAllowed: 0,
        approvalsDenied: 0,
        rulesCreated: [],
        reviewerDecisions: { approved: 0, denied: 0, askUser: 0, cacheHits: 0 },
        sandboxDenials: 0,
        evidenceGate: { decisions: 0, allowed: 0, blocked: 0, overrides: 0, degraded: 0 },
    };
    for (const ev of events) {
        const p = (ev.payload as Record<string, any>) ?? {};
        switch (ev.type) {
            case 'policy_resolved':
                snap.policyResolvedCount++;
                if (p.action === 'allow' || p.action === 'ask' || p.action === 'deny') snap.actionCounts[p.action as 'allow' | 'ask' | 'deny']++;
                break;
            case 'permission_requested':
                snap.approvalsRequested++;
                break;
            case 'permission_resolved':
                if (p.allowed) snap.approvalsAllowed++;
                else snap.approvalsDenied++;
                break;
            case 'approval_rule_created':
                snap.rulesCreated.push({ ruleId: p.ruleId, tool: p.tool, commandPrefix: p.commandPrefix, createdBy: p.createdBy });
                break;
            case 'reviewer_decision':
                if (p.fromCache) snap.reviewerDecisions.cacheHits++;
                if (p.verdict === 'deny') snap.reviewerDecisions.denied++;
                else if (p.verdict === 'ask_user') snap.reviewerDecisions.askUser++;
                else snap.reviewerDecisions.approved++;
                break;
            case 'sandbox_denied':
            case 'subagent_refused':
                snap.sandboxDenials++;
                break;
            case 'evidence_gate_decision': {
                snap.evidenceGate.decisions++;
                if (p.verdict === 'allow') snap.evidenceGate.allowed++;
                else if (p.verdict === 'block') snap.evidenceGate.blocked++;
                else if (p.verdict === 'override') snap.evidenceGate.overrides++;
                if (p.degraded === true) snap.evidenceGate.degraded++;
                break;
            }
        }
    }
    return snap;
}

// ─── Scheduling state ───────────────────────────────────────────────────────

export interface SchedulingSnapshot {
    domainProfile?: AgentRuntimeDomain;
    authorization?: AgentAuthorization;
    phase?: AgentRunPhase;
    dispatch: AgentDispatchMode;
    routeConfidence: number;
    routeEvidence: string[];
    phaseRevision: number;
    queuedPrompts: number;
    steeredPrompts: number;
    dispatchEvaluations: number;
    dispatchAccepted: number;
    suspendedAgents: number;
    requeuedAgents: number;
    providerCapacity?: number;
}

export function reduceScheduling(events: AgentRunEvent[]): SchedulingSnapshot {
    const snapshot: SchedulingSnapshot = {
        dispatch: 'single',
        routeConfidence: 0,
        routeEvidence: [],
        phaseRevision: 0,
        queuedPrompts: 0,
        steeredPrompts: 0,
        dispatchEvaluations: 0,
        dispatchAccepted: 0,
        suspendedAgents: 0,
        requeuedAgents: 0,
    };
    for (const event of events) {
        const payload = (event.payload as Record<string, unknown>) ?? {};
        switch (event.type) {
            case 'admission_decided':
                if (payload.domainProfile === 'general' || payload.domainProfile === 'paradox') {
                    snapshot.domainProfile = payload.domainProfile;
                }
                if (payload.authorization === 'read_only'
                    || payload.authorization === 'plan_write_only'
                    || payload.authorization === 'workspace_write') {
                    snapshot.authorization = payload.authorization;
                }
                if (payload.initialPhase === 'inspect' || payload.initialPhase === 'plan'
                    || payload.initialPhase === 'execute' || payload.initialPhase === 'verify') {
                    snapshot.phase = payload.initialPhase;
                }
                snapshot.dispatch = payload.explicitDelegation === true ? 'parallel' : 'single';
                snapshot.routeConfidence = typeof payload.confidence === 'number' ? payload.confidence : 0;
                snapshot.routeEvidence = Array.isArray(payload.evidence)
                    ? payload.evidence.filter((item): item is string => typeof item === 'string').slice(0, 12)
                    : [];
                break;
            case 'phase_changed':
                if (payload.to === 'inspect' || payload.to === 'plan' || payload.to === 'execute'
                    || payload.to === 'verify' || payload.to === 'finalize') {
                    snapshot.phase = payload.to;
                }
                snapshot.phaseRevision = typeof payload.revision === 'number'
                    ? Math.max(snapshot.phaseRevision, payload.revision)
                    : snapshot.phaseRevision + 1;
                break;
            case 'prompt_queued':
                snapshot.queuedPrompts++;
                break;
            case 'prompt_steered':
                snapshot.steeredPrompts++;
                break;
            case 'dispatch_evaluated':
                snapshot.dispatchEvaluations++;
                if (payload.accepted === true) {
                    snapshot.dispatchAccepted++;
                    snapshot.dispatch = 'parallel';
                }
                break;
            case 'agent_suspended':
                snapshot.suspendedAgents++;
                break;
            case 'agent_requeued':
                snapshot.requeuedAgents++;
                break;
            case 'provider_capacity_changed':
                if (typeof payload.current === 'number') snapshot.providerCapacity = payload.current;
                break;
        }
    }
    return snapshot;
}

// ─── Aggregate snapshot (one-shot helper for broadcasters) ───────────────────

export interface RuntimeItemsSnapshot {
    items: RuntimeItem[];
    byId: Map<string, RuntimeItem>;
}

export interface ActivitySummarySnapshot {
    domainSequence: number;
    goalStatus?: string;
    activeTasks: number;
    lostTasks: number;
    disclosedTools: number;
    deduplicatedCalls: number;
    contextOverflows: number;
    sideQuestions: number;
    undoCount: number;
}

export function reduceActivitySummary(events: AgentRunEvent[]): ActivitySummarySnapshot {
    const snapshot: ActivitySummarySnapshot = {
        domainSequence: 0,
        activeTasks: 0,
        lostTasks: 0,
        disclosedTools: 0,
        deduplicatedCalls: 0,
        contextOverflows: 0,
        sideQuestions: 0,
        undoCount: 0,
    };
    for (const event of events) {
        const payload = (event.payload as Record<string, unknown>) ?? {};
        switch (event.type) {
            case 'domain_op_applied':
                if (typeof payload.sequence === 'number') snapshot.domainSequence = Math.max(snapshot.domainSequence, payload.sequence);
                break;
            case 'goal_transitioned':
                if (typeof payload.status === 'string') snapshot.goalStatus = payload.status;
                break;
            case 'task_created':
                snapshot.activeTasks++;
                break;
            case 'task_status_changed':
                if (payload.status === 'lost') snapshot.lostTasks++;
                if (['completed', 'failed', 'timed_out', 'killed', 'lost'].includes(String(payload.status))) {
                    snapshot.activeTasks = Math.max(0, snapshot.activeTasks - 1);
                }
                break;
            case 'tool_disclosure_changed':
                snapshot.disclosedTools += Array.isArray(payload.loaded) ? payload.loaded.length : 0;
                break;
            case 'tool_call_deduplicated':
                snapshot.deduplicatedCalls++;
                break;
            case 'context_limit_observed':
                snapshot.contextOverflows++;
                break;
            case 'side_question_started':
                snapshot.sideQuestions++;
                break;
            case 'undo_completed':
                snapshot.undoCount++;
                break;
        }
    }
    return snapshot;
}

/** Rebuilds the latest state of permission, process, command, file, and tool items. */
export function reduceRuntimeItems(events: AgentRunEvent[]): RuntimeItemsSnapshot {
    const byId = new Map<string, RuntimeItem>();
    const order: string[] = [];
    for (const event of events) {
        if (event.type !== 'item_started' && event.type !== 'item_updated' && event.type !== 'item_completed') continue;
        const payload = (event.payload as Record<string, unknown>) ?? {};
        const itemId = typeof payload.itemId === 'string' ? payload.itemId : event.invocationId;
        if (!itemId) continue;
        const existing = byId.get(itemId);
        if (!existing) order.push(itemId);
        const item: RuntimeItem = {
            ...(existing ?? {
                itemId,
                type: (payload.type as RuntimeItemType | undefined) ?? 'toolCall',
                status: (payload.status as RuntimeItemStatus | undefined) ?? 'inProgress',
                startedAt: typeof payload.startedAt === 'number' ? payload.startedAt : event.timestamp,
            }),
            ...payload,
            itemId,
            metadata: {
                ...(existing?.metadata ?? {}),
                ...((payload.metadata as Record<string, unknown> | undefined) ?? {}),
            },
        } as RuntimeItem;
        if (event.type === 'item_completed' && item.completedAt === undefined) item.completedAt = event.timestamp;
        byId.set(itemId, item);
    }
    return { items: order.map(itemId => byId.get(itemId)!), byId };
}

export interface RunReducerSnapshot {
    state: RunStateSnapshot;
    toolTimeline: ToolTimelineSnapshot;
    agentGraph: AgentGraphSnapshot;
    cacheStats: CacheStatsSnapshot;
    policy: PolicyActivitySnapshot;
    runtimeItems: RuntimeItemsSnapshot;
    scheduling: SchedulingSnapshot;
    activity: ActivitySummarySnapshot;
}

export function reduceAll(events: AgentRunEvent[]): RunReducerSnapshot {
    return {
        state: reduceRunState(events),
        toolTimeline: reduceToolTimeline(events),
        agentGraph: reduceAgentGraph(events),
        cacheStats: reduceCacheStats(events),
        policy: reducePolicyActivity(events),
        runtimeItems: reduceRuntimeItems(events),
        scheduling: reduceScheduling(events),
        activity: reduceActivitySummary(events),
    };
}

export type { AgentRunEvent, AgentRunEventType };
