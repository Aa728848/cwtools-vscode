/**
 * Background orchestration registry.
 *
 * `dispatch_agents(background: true)` returns immediately while the task
 * graph keeps executing off the tool call. The registry owns the graph's
 * abort controller (chained to the parent run signal), deduplicates active
 * graphs, and lets resume/merge guard against concurrent execution.
 */

import { ErrorReporter } from '../errorReporter';
import { SOURCE } from '../messages';

export interface BackgroundOrchestration {
    graphId: string;
    topicId?: string;
    runId?: string;
    startedAt: number;
    /** Resolves when the background graph has fully settled (success or failure). */
    settled: Promise<void>;
    abort(): void;
}

export interface StartBackgroundOrchestrationOptions {
    graphId: string;
    topicId?: string;
    runId?: string;
    /** Parent run abort signal; aborting it cancels the background graph. */
    parentAbortSignal?: AbortSignal;
    /** Executes the graph. Receives the graph-local abort signal. */
    run: (abortSignal: AbortSignal) => Promise<void>;
}

export class BackgroundOrchestratorRegistry {
    private readonly active = new Map<string, BackgroundOrchestration>();

    hasActive(graphId: string): boolean {
        return this.active.has(graphId);
    }

    /** Register a background graph. Throws when the graph id is already running. */
    start(options: StartBackgroundOrchestrationOptions): BackgroundOrchestration {
        if (this.active.has(options.graphId)) {
            throw new Error(`Orchestration '${options.graphId}' is already running in the background.`);
        }
        const controller = new AbortController();
        const onParentAbort = () => controller.abort(options.parentAbortSignal?.reason);
        if (options.parentAbortSignal?.aborted) {
            onParentAbort();
        } else {
            options.parentAbortSignal?.addEventListener('abort', onParentAbort, { once: true });
        }

        const settled = (async () => {
            try {
                await options.run(controller.signal);
            } catch (error) {
                ErrorReporter.warn(
                    SOURCE.ORCHESTRATOR,
                    `Background orchestration ${options.graphId} failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            } finally {
                options.parentAbortSignal?.removeEventListener('abort', onParentAbort);
                this.active.delete(options.graphId);
            }
        })();

        const entry: BackgroundOrchestration = {
            graphId: options.graphId,
            topicId: options.topicId,
            runId: options.runId,
            startedAt: Date.now(),
            settled,
            abort: () => controller.abort(new Error('Background orchestration cancelled.')),
        };
        this.active.set(options.graphId, entry);
        return entry;
    }

    /** Abort one graph. Returns false when it is not running. */
    cancel(graphId: string): boolean {
        const entry = this.active.get(graphId);
        if (!entry) return false;
        entry.abort();
        return true;
    }

    /** Abort every background graph of a topic. Returns the number cancelled. */
    cancelAllForTopic(topicId: string): number {
        let count = 0;
        for (const entry of this.active.values()) {
            if (entry.topicId === topicId) {
                entry.abort();
                count++;
            }
        }
        return count;
    }

    list(): BackgroundOrchestration[] {
        return [...this.active.values()];
    }
}

export const backgroundOrchestrators = new BackgroundOrchestratorRegistry();
