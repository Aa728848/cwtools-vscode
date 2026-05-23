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

// ─── Run state ───────────────────────────────────────────────────────────────

export interface RunStateSnapshot {
    runId: string | undefined;
    status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';
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
        switch (ev.type) {
            case 'run_created':
                snap.startedAt = ev.timestamp;
                snap.status = 'running';
                break;
            case 'status_changed':
                if (ev.status) snap.status = ev.status as RunStateSnapshot['status'];
                if (ev.status === 'done' || ev.status === 'failed' || ev.status === 'cancelled') {
                    snap.endedAt = ev.timestamp;
                }
                break;
            case 'model_call_end': {
                snap.iterations++;
                const p = ev.payload as Record<string, any> | undefined;
                if (p?.usage) {
                    snap.totalInputTokens += p.usage.prompt_tokens ?? 0;
                    snap.totalOutputTokens += p.usage.completion_tokens ?? 0;
                    snap.totalCachedTokens += p.usage.cached_tokens ?? 0;
                    snap.totalCacheCreationTokens += p.usage.cache_creation_tokens ?? 0;
                }
                break;
            }
            case 'cache_stats': {
                const p = ev.payload as Record<string, any> | undefined;
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
                const p = ev.payload as Record<string, any> | undefined;
                if (typeof p?.content === 'string') snap.lastStepContent = p.content;
                break;
            }
        }
    }
    return snap;
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
    for (const ev of events) {
        if (ev.type !== 'cache_stats') continue;
        const p = (ev.payload as Record<string, any>) ?? {};
        const agentId = ev.agentId ?? '__root__';
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

// ─── Aggregate snapshot (one-shot helper for broadcasters) ───────────────────

export interface RunReducerSnapshot {
    state: RunStateSnapshot;
    toolTimeline: ToolTimelineSnapshot;
    agentGraph: AgentGraphSnapshot;
    cacheStats: CacheStatsSnapshot;
}

export function reduceAll(events: AgentRunEvent[]): RunReducerSnapshot {
    return {
        state: reduceRunState(events),
        toolTimeline: reduceToolTimeline(events),
        agentGraph: reduceAgentGraph(events),
        cacheStats: reduceCacheStats(events),
    };
}

export type { AgentRunEvent, AgentRunEventType };
