/**
 * Eddy CWTool Code — Resumed-graph normalization.
 *
 * One question, answered in one place: which persisted node states become
 * re-eligible when a graph is resumed?
 *
 * Historical answer: only `failed` and `cancelled`. That was wrong for one
 * narrow but real path — a wave that THREW mid-execution is persisted by the
 * dispatch catch with a live graph reference, so whatever was mid-flight on
 * the throw stays `running` on disk. `getReadyNodes` only schedules `pending`
 * nodes, so those `running` nodes would never run again and the graph would
 * sit incomplete forever.
 *
 * `running` is always stale at resume time: `executeDispatchAgents` rejects a
 * resume while the graph is still executing in the background, and a plain host
 * kill cannot persist `running` at all (the last snapshot was taken before the
 * wave started, with every node `pending`). So resetting `running` to `pending`
 * is safe and is the only way a wave-interrupted graph can ever complete.
 *
 * What is deliberately NOT touched here:
 * - `done` nodes stay done — completed work is never re-run.
 * - `resumeContextRef` / `pendingClarification` stay in place — the answer
 *   path consumes them for a context-preserving clarification resume.
 * - `agentId` stays — stable identity is reused across retry/resume tasks.
 */

import type { TaskGraph } from './types';

export interface ResumeNormalizationSummary {
    /** Nodes whose previous attempt never settled (wave interrupted mid-flight). */
    resetRunning: string[];
    /** Nodes re-eligible after a previous failure. */
    resetFailed: string[];
    /** Nodes re-eligible after a previous cancellation. */
    resetCancelled: string[];
    /** True when at least one node state was changed. */
    changed: boolean;
}

/**
 * Re-queue every persisted node that can legitimately run again.
 * @param graph Deserialized graph, mutated in place.
 * @returns Which nodes were reset, split by their previous state.
 */
export function normalizeResumedGraph(graph: TaskGraph): ResumeNormalizationSummary {
    const resetRunning: string[] = [];
    const resetFailed: string[] = [];
    const resetCancelled: string[] = [];
    for (const node of graph.nodes.values()) {
        if (node.status !== 'failed' && node.status !== 'cancelled' && node.status !== 'running') continue;
        (node.status === 'running' ? resetRunning : node.status === 'failed' ? resetFailed : resetCancelled)
            .push(node.id);
        node.status = 'pending';
        node.error = undefined;
        node.retryCount = 0;
    }
    const changed = resetRunning.length + resetFailed.length + resetCancelled.length > 0;
    return { resetRunning, resetFailed, resetCancelled, changed };
}
