/**
 * Eddy CWTool Code - Parallel Executor
 *
 * Schedules multiple agent nodes with bounded concurrency, token-budget checks,
 * retry/cascade behavior, and planned write-target conflict avoidance.
 */

import * as os from 'os';
import type {
    TaskGraph,
    TaskNode,
    SubAgentResult,
    OrchestratorResult,
    OrchestratorOptions,
} from './types';
import type { TokenUsage, AgentStep } from '../types';
import { TaskGraphEngine } from './taskGraphEngine';
import { Blackboard } from './blackboard';
import { ConflictDetector } from './conflictDetector';
import { ErrorReporter } from '../errorReporter';
import { SOURCE, aiText } from '../messages';
import type { RunEventSink } from '../runner/runContext';

/** Sub-agent executor injected by Orchestrator. */
export type SubAgentExecutor = (
    taskNode: TaskNode,
    blackboard: Blackboard,
    parentAccumulator: TokenUsage,
    abortSignal: AbortSignal,
    onStep: (step: AgentStep) => void,
) => Promise<SubAgentResult>;

function isTimeoutLikeError(error?: string): boolean {
    return !!error && /timeout|timed out|idle timeout|absolute timeout|\u8d85\u65f6/i.test(error);
}

export class ParallelExecutor {
    private readonly maxConcurrency: number;
    private globalTokenBudget: number;
    private consumedTokens: TokenUsage;
    private conflictDetector: ConflictDetector;
    private graphEngine: TaskGraphEngine;

    constructor(options?: {
        maxConcurrency?: number;
        globalTokenBudget?: number;
        eventSink?: RunEventSink;
    }) {
        this.maxConcurrency = options?.maxConcurrency ?? Math.min(4, os.cpus().length || 2);
        this.globalTokenBudget = options?.globalTokenBudget ?? 0;
        this.consumedTokens = { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
        this.conflictDetector = new ConflictDetector(options?.eventSink);
        this.graphEngine = new TaskGraphEngine();
    }

    setEventSink(eventSink?: RunEventSink): void {
        this.conflictDetector.setEventSink(eventSink);
    }

    async executeGraph(
        graph: TaskGraph,
        blackboard: Blackboard,
        executor: SubAgentExecutor,
        options: OrchestratorOptions,
    ): Promise<OrchestratorResult> {
        const agentResults = new Map<string, SubAgentResult>();
        const totalTokenUsage: TokenUsage = { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
        const emitStep = options.onStep ?? (() => {});

        const cycles = this.graphEngine.detectCycles(graph);
        if (cycles) {
            return {
                success: false,
                summary: `Task graph contains cyclic dependencies: ${cycles.map(c => c.join(' -> ')).join('; ')}`,
                agentResults,
                totalTokenUsage,
                failedNodes: [],
                cancelledNodes: [],
            };
        }

        const missingDependencies: Array<{ nodeId: string; dependencyId: string }> = [];
        for (const node of graph.nodes.values()) {
            const healedDeps: string[] = [];
            for (const depId of node.dependencies) {
                if (!graph.nodes.has(depId)) {
                    // 尝试在图里寻找相似度的真实节点 ID 进行防幻觉拼写自愈
                    let matchedId: string | undefined = undefined;
                    const depLower = depId.toLowerCase();
                    for (const realId of graph.nodes.keys()) {
                        const realLower = realId.toLowerCase();
                        if (
                            realLower.includes(depLower) || 
                            depLower.includes(realLower) ||
                            (realLower.startsWith('build') && depLower.startsWith('build')) ||
                            (realLower.includes('loc') && depLower.includes('loc'))
                        ) {
                            matchedId = realId;
                            break;
                        }
                    }

                    if (matchedId) {
                        healedDeps.push(matchedId);
                        const healMsg = aiText(
                            `Dependency auto-heal: node ${node.id} depended on missing "${depId}", so it was linked to similar node "${matchedId}".`,
                            `✨ 智能依赖自愈: 检测到节点 ${node.id} 依赖了不存在的 "${depId}"，已自动修正并关联至相似节点 "${matchedId}"`,
                        );
                        ErrorReporter.debug(SOURCE.ORCHESTRATOR, healMsg);
                        emitStep({ type: 'thinking', content: healMsg, timestamp: Date.now() });
                    } else {
                        missingDependencies.push({ nodeId: node.id, dependencyId: depId });
                    }
                } else {
                    healedDeps.push(depId);
                }
            }
            node.dependencies = healedDeps;
        }

        if (missingDependencies.length > 0) {
            const summary = `Task graph contains missing dependencies: ${missingDependencies.map(d => `${d.nodeId} -> ${d.dependencyId}`).join('; ')}`;
            emitStep({ type: 'error', content: summary, timestamp: Date.now() });
            return {
                success: false,
                summary,
                agentResults,
                totalTokenUsage,
                failedNodes: [...new Set(missingDependencies.map(d => d.nodeId))],
                cancelledNodes: [],
            };
        }

        emitStep({
            type: 'orchestrator_progress',
            content: `$(chart) Task graph scheduling started: ${graph.nodes.size} nodes, max concurrency ${this.maxConcurrency}`,
            timestamp: Date.now(),
        });

        while (!this.graphEngine.isComplete(graph)) {
            options.abortSignal?.throwIfAborted();

            const readyNodes = this.graphEngine.getReadyNodes(graph);
            if (readyNodes.length === 0) {
                const summary = 'Task graph stalled: no executable nodes remain, but the graph is incomplete.';
                emitStep({ type: 'error', content: summary, timestamp: Date.now() });
                return {
                    success: false,
                    summary,
                    agentResults,
                    totalTokenUsage,
                    failedNodes: [...graph.nodes.values()].filter(n => n.status === 'pending' || n.status === 'running').map(n => n.id),
                    cancelledNodes: [...graph.nodes.values()].filter(n => n.status === 'cancelled').map(n => n.id),
                };
            }

            if (this.globalTokenBudget > 0 && this.consumedTokens.total > this.globalTokenBudget) {
                emitStep({
                    type: 'error',
                    content: `Global token budget exceeded (${this.consumedTokens.total}/${this.globalTokenBudget}); falling back to serial execution`,
                    timestamp: Date.now(),
                });
                readyNodes.splice(1);
            }

            const { batch, deferred } = this.selectConflictAwareBatch(readyNodes);
            if (deferred.length > 0) {
                emitStep({
                    type: 'orchestrator_progress',
                    content: `Deferred conflict nodes to a later batch: ${deferred.join('; ')}`,
                    timestamp: Date.now(),
                });
            }

            emitStep({
                type: 'orchestrator_progress',
                content: `$(zap) Executing batch: ${batch.map(n => `${n.id}(${n.agentType})`).join(', ')}`,
                timestamp: Date.now(),
            });

            const batchResults = await this.executeBatch(
                batch, graph, blackboard, executor, totalTokenUsage, options
            );

            for (const [nodeId, result] of batchResults) {
                agentResults.set(nodeId, result);
            }
        }

        const progress = this.graphEngine.getProgressSummary(graph);
        const failedNodes = [...graph.nodes.values()]
            .filter(n => n.status === 'failed')
            .map(n => n.id);
        const cancelledNodes = [...graph.nodes.values()]
            .filter(n => n.status === 'cancelled')
            .map(n => n.id);

        const success = failedNodes.length === 0 && cancelledNodes.length === 0;

        const summary = [
            '## Execution Complete',
            `- Total nodes: ${progress.total}`,
            `- Succeeded: ${progress.done}`,
            `- Failed: ${progress.failed}`,
            `- Cancelled: ${progress.cancelled}`,
            `- Tokens: ${totalTokenUsage.total} (about CNY ${totalTokenUsage.estimatedCostCny.toFixed(4)})`,
        ].join('\n');

        return {
            success,
            summary,
            agentResults,
            totalTokenUsage,
            failedNodes,
            cancelledNodes,
        };
    }

    private async executeBatch(
        nodes: TaskNode[],
        graph: TaskGraph,
        blackboard: Blackboard,
        executor: SubAgentExecutor,
        totalTokenUsage: TokenUsage,
        options: OrchestratorOptions,
    ): Promise<Map<string, SubAgentResult>> {
        const results = new Map<string, SubAgentResult>();

        for (const node of nodes) {
            this.graphEngine.markRunning(graph, node.id);
        }

        const promises = nodes.map(async (node) => {
            const agentId = `agent_${node.id}_${Date.now().toString(36)}`;

            try {
                const taggedStep = (step: AgentStep) => {
                    options.onStep?.({
                        ...step,
                        agentId: node.id,
                    });
                };

                const nodeAccumulator: TokenUsage = {
                    total: 0, input: 0, output: 0, estimatedCostCny: 0,
                };

                const result = await executor(
                    node,
                    blackboard,
                    nodeAccumulator,
                    options.abortSignal ?? new AbortController().signal,
                    taggedStep,
                );

                totalTokenUsage.total += result.tokenUsage.total;
                totalTokenUsage.input += result.tokenUsage.input;
                totalTokenUsage.output += result.tokenUsage.output;
                totalTokenUsage.estimatedCostCny += result.tokenUsage.estimatedCostCny;
                this.consumedTokens.total += result.tokenUsage.total;

                node.tokenUsage = result.tokenUsage;

                if (result.success) {
                    for (const contract of node.produces ?? []) {
                        blackboard.write(
                            `__entity:${contract.kind}:${contract.id}`,
                            JSON.stringify({ nodeId: node.id, contract }),
                            'entity_registry',
                            node.id,
                        );
                    }
                    for (const contract of node.consumes ?? []) {
                        blackboard.write(
                            `__relation:${node.id}:${contract.kind}:${contract.id}:${contract.operation}`,
                            JSON.stringify({ nodeId: node.id, contract }),
                            'entity_relation',
                            node.id,
                        );
                    }
                    this.graphEngine.markComplete(graph, node.id, result.output);
                    this.conflictDetector.clearIntent(agentId, blackboard);
                } else {
                    if (options.abortSignal?.aborted || result.error === 'User cancelled') {
                        node.status = 'cancelled';
                    } else if (result.needsClarification) {
                        const cancelled = this.graphEngine.markFailed(
                            graph,
                            node.id,
                            result.error ?? result.clarification ?? 'Sub-task needs parent-agent clarification'
                        );
                        options.onStep?.({
                            type: 'error',
                            content: `Node ${node.id} needs parent-agent clarification; downstream nodes paused${cancelled.length ? `: ${cancelled.join(', ')}` : ''}`,
                            timestamp: Date.now(),
                        });
                    } else if (isTimeoutLikeError(result.error)) {
                        const cancelled = this.graphEngine.markFailed(
                            graph,
                            node.id,
                            result.error ?? 'Sub-task timed out'
                        );
                        options.onStep?.({
                            type: 'error',
                            content: `Node ${node.id} timed out; retries stopped${cancelled.length ? ` and downstream nodes cancelled: ${cancelled.join(', ')}` : ''}`,
                            timestamp: Date.now(),
                        });
                    } else if (node.retryCount < node.maxRetries) {
                        node.retryCount++;
                        node.status = 'pending';
                        ErrorReporter.debug(SOURCE.ORCHESTRATOR, `Node ${node.id} failed, retry ${node.retryCount}/${node.maxRetries}`);
                    } else {
                        const cancelled = this.graphEngine.markFailed(
                            graph, node.id, result.error ?? 'Unknown error'
                        );
                        if (cancelled.length > 0) {
                            options.onStep?.({
                                type: 'error',
                                content: `Node ${node.id} failed; downstream nodes cancelled: ${cancelled.join(', ')}`,
                                timestamp: Date.now(),
                            });
                        }
                    }
                }

                results.set(node.id, result);
            } catch (e) {
                const error = e instanceof Error ? e.message : String(e);
                const failResult: SubAgentResult = {
                    nodeId: node.id,
                    success: false,
                    output: '',
                    error,
                    tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount: 0,
                };
                results.set(node.id, failResult);

                if (options.abortSignal?.aborted) {
                    node.status = 'cancelled';
                } else if (isTimeoutLikeError(error)) {
                    this.graphEngine.markFailed(graph, node.id, error);
                } else if (node.retryCount < node.maxRetries) {
                    node.retryCount++;
                    node.status = 'pending';
                } else {
                    this.graphEngine.markFailed(graph, node.id, error);
                }

                this.conflictDetector.clearIntent(agentId, blackboard);
            }
        });

        await Promise.allSettled(promises);
        return results;
    }

    private selectConflictAwareBatch(readyNodes: TaskNode[]): { batch: TaskNode[]; deferred: string[] } {
        const batch: TaskNode[] = [];
        const deferred: string[] = [];
        const fileOwners = new Map<string, string>();
        const entityOwners = new Map<string, string>();

        for (const node of readyNodes) {
            if (batch.length >= this.maxConcurrency) break;

            const conflict = this.findPlannedTargetConflict(node, fileOwners, entityOwners);
            if (conflict) {
                deferred.push(`${node.id} (${conflict})`);
                continue;
            }

            batch.push(node);
            for (const file of node.plannedFiles ?? []) {
                const key = this.normalizeFileTarget(file);
                if (key) fileOwners.set(key, node.id);
            }
            for (const entity of node.plannedEntities ?? []) {
                const key = this.normalizeEntityTarget(entity);
                if (key) entityOwners.set(key, node.id);
            }
        }

        return { batch, deferred };
    }

    private findPlannedTargetConflict(
        node: TaskNode,
        fileOwners: Map<string, string>,
        entityOwners: Map<string, string>,
    ): string | undefined {
        for (const file of node.plannedFiles ?? []) {
            const key = this.normalizeFileTarget(file);
            const owner = key ? fileOwners.get(key) : undefined;
            if (owner) return `file ${file} already planned by ${owner}`;
        }
        for (const entity of node.plannedEntities ?? []) {
            const key = this.normalizeEntityTarget(entity);
            const owner = key ? entityOwners.get(key) : undefined;
            if (owner) return `entity ${entity} already planned by ${owner}`;
        }
        return undefined;
    }

    private normalizeFileTarget(filePath: string): string {
        return filePath.trim().replace(/\\/g, '/').toLowerCase();
    }

    private normalizeEntityTarget(entity: string): string {
        return entity.trim();
    }

    getConsumedTokens(): TokenUsage {
        return { ...this.consumedTokens };
    }
}
