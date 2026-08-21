/**
 * Eddy CWTool Code — Orchestration catalog projection.
 *
 * Projects persisted orchestration records into the answer `merge_results`
 * returns when it is called without `nodeIds`.
 *
 * Why this exists at all: a graph id is the only handle back into a persisted
 * wave. `dispatch_agents(resumeGraphId=...)` rejects an id it does not know, and
 * `merge_results` needs one to fetch node detail — so a coordinator that has
 * forgotten the id (a later turn, a resumed session) has no cheap way back and
 * its remaining move is to re-dispatch the whole wave.
 *
 * Why the wording is this explicit: the state a model most often misreads is a
 * persisted-but-unfinished graph. Read as "dead" it gets re-dispatched; read as
 * "a result waiting to be collected" it gets merged and comes back empty. Each
 * row therefore carries a `stateMeaning` sentence next to the state word.
 */

import type { StoredOrchestration, StoredTaskNode } from './orchestrationStore';
import type { AgentRuntimeDomain } from '../types';

const MAX_SUMMARY_CHARS = 600;
const MAX_QUESTION_CHARS = 400;

export type OrchestrationCatalogState = 'running_in_background' | 'complete' | 'resumable';

export interface OrchestrationCatalogClarification {
    nodeId: string;
    question: string;
    /**
     * True when this node kept a replayable transcript, so answering resumes it
     * instead of re-running its investigation.
     */
    contextPreserved: boolean;
}

export interface OrchestrationCatalogNode {
    id: string;
    status: StoredTaskNode['status'];
    hasResult: boolean;
}

export interface OrchestrationCatalogEntry {
    graphId: string;
    runId?: string;
    mode?: string;
    domain: AgentRuntimeDomain;
    nodeCount: number;
    nodes: OrchestrationCatalogNode[];
    nodeStatusCounts: Record<StoredTaskNode['status'], number>;
    updatedAt: string;
    totalTokens?: number;
    qualityGatePassed?: boolean;
    summary?: string;
    state: OrchestrationCatalogState;
    stateMeaning: string;
    pendingClarifications?: OrchestrationCatalogClarification[];
    canResume: boolean;
    canMerge: boolean;
}

export interface OrchestrationCatalog {
    success: true;
    mode: 'catalog';
    topicId?: string;
    domain: AgentRuntimeDomain;
    graphCount: number;
    graphs: OrchestrationCatalogEntry[];
    hint: string;
}

const STATE_MEANINGS: Record<OrchestrationCatalogState, string> = {
    running_in_background:
        'Still executing off the tool call. Its BACKGROUND TASK RESULT arrives in a later turn; do not resume or merge it yet.',
    complete:
        'Every node settled. merge_results(graphId=...) automatically returns every available node result.',
    resumable:
        'Persisted with unfinished nodes. This is resumable, NOT terminal and NOT a result waiting to be collected: '
        + 'dispatch_agents(resumeGraphId=...) re-runs the unfinished nodes.',
};

function emptyStatusCounts(): Record<StoredTaskNode['status'], number> {
    return { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
}

/**
 * Build the catalog answer.
 * @param records Persisted records, already filtered to the caller's topic/domain.
 * @param isRunningInBackground Whether a graph id is executing right now.
 * @param meta Topic and domain echoed back to the caller.
 * @returns The catalog, in the order the records were supplied.
 */
export function buildOrchestrationCatalog(
    records: readonly StoredOrchestration[],
    isRunningInBackground: (graphId: string) => boolean,
    meta: { topicId?: string; domain: AgentRuntimeDomain },
): OrchestrationCatalog {
    const graphs: OrchestrationCatalogEntry[] = records.map(record => {
        const nodeStatusCounts = emptyStatusCounts();
        const pendingClarifications: OrchestrationCatalogClarification[] = [];
        for (const node of record.graph.nodes) {
            if (node.status in nodeStatusCounts) nodeStatusCounts[node.status]++;
            if (node.pendingClarification) {
                pendingClarifications.push({
                    nodeId: node.id,
                    question: node.pendingClarification.slice(0, MAX_QUESTION_CHARS),
                    contextPreserved: !!node.resumeContextRef,
                });
            }
        }
        const running = isRunningInBackground(record.graphId);
        const state: OrchestrationCatalogState = running
            ? 'running_in_background'
            : record.complete
                ? 'complete'
                : 'resumable';
        return {
            graphId: record.graphId,
            runId: record.runId,
            mode: record.mode,
            domain: record.domain,
            nodeCount: record.graph.nodes.length,
            nodes: record.graph.nodes.map(node => ({
                id: node.id,
                status: node.status,
                hasResult: Object.prototype.hasOwnProperty.call(record.agentResults, node.id),
            })),
            nodeStatusCounts,
            updatedAt: new Date(record.updatedAt).toISOString(),
            totalTokens: record.totalTokenUsage?.total,
            qualityGatePassed: record.qualityGate?.passed,
            summary: record.summary ? record.summary.slice(0, MAX_SUMMARY_CHARS) : undefined,
            state,
            stateMeaning: STATE_MEANINGS[state],
            pendingClarifications: pendingClarifications.length > 0 ? pendingClarifications : undefined,
            canResume: state === 'resumable',
            canMerge: !running,
        };
    });

    return {
        success: true,
        mode: 'catalog',
        topicId: meta.topicId,
        domain: meta.domain,
        graphCount: graphs.length,
        graphs,
        hint: graphs.length === 0
            ? 'No orchestration graph is persisted for this topic yet. Use dispatch_agents to start one.'
            : 'Pass graphId alone to merge every available node output, or graphId plus nodeIds to select a subset. A graph that lists pendingClarifications is waiting on a decision: answer it with '
                + 'dispatch_agents(resumeGraphId=..., answerClarifications=[{id, answer}]). Any node whose contextPreserved is true resumes from its own '
                + 'preserved working context instead of repeating the investigation it already finished.',
    };
}
