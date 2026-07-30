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
import { mergeTokenUsageTotals } from '../cacheCapability';
import { TaskGraphEngine } from './taskGraphEngine';
import { Blackboard } from './blackboard';
import { ConflictDetector } from './conflictDetector';
import { ErrorReporter } from '../errorReporter';
import { SOURCE, aiText } from '../messages';
import type { RunEventSink } from '../runner/runContext';
import { AdaptiveConcurrencyController, isProviderRateLimit } from '../runner/scheduling';
import { agentTaskManager, type AgentTaskStatus } from '../runner/taskManager';

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
    private readonly adaptiveCapacity: AdaptiveConcurrencyController;
    private readonly retryEligibleAt = new Map<string, number>();
    private eventSink?: RunEventSink;

    constructor(options?: {
        maxConcurrency?: number;
        globalTokenBudget?: number;
        eventSink?: RunEventSink;
    }) {
        this.maxConcurrency = options?.maxConcurrency ?? Math.min(4, os.cpus().length || 2);
        this.adaptiveCapacity = new AdaptiveConcurrencyController(this.maxConcurrency);
        this.eventSink = options?.eventSink;
        this.globalTokenBudget = options?.globalTokenBudget ?? 0;
        this.consumedTokens = { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
        this.conflictDetector = new ConflictDetector(options?.eventSink);
        this.graphEngine = new TaskGraphEngine();
    }

    setEventSink(eventSink?: RunEventSink): void {
        this.eventSink = eventSink;
        this.conflictDetector.setEventSink(eventSink);
    }

    async executeGraph(
        graph: TaskGraph,
        blackboard: Blackboard,
        executor: SubAgentExecutor,
        options: OrchestratorOptions,
    ): Promise<OrchestratorResult> {
        // Retry eligibility belongs to one task graph. Provider capacity is
        // intentionally retained, but stale node ids must not delay a later run.
        this.retryEligibleAt.clear();
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

            const allReadyNodes = this.graphEngine.getReadyNodes(graph);
            const now = Date.now();
            const readyNodes = allReadyNodes.filter(node => (this.retryEligibleAt.get(node.id) ?? 0) <= now);
            if (readyNodes.length === 0 && allReadyNodes.length > 0) {
                const nextEligibleAt = Math.min(...allReadyNodes.map(node => this.retryEligibleAt.get(node.id) ?? now));
                await this.waitForRetry(Math.max(0, Math.min(30_000, nextEligibleAt - now)), options.abortSignal);
                continue;
            }
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
            ...[...agentResults.entries()]
                .filter(([, result]) => result.success && result.handoff)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([nodeId, result]) => `- ${nodeId}: ${result.handoff!.summary}`),
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
            const agentId = node.agentId ?? `agent_${graph.id}_${node.id}`;
            node.agentId = agentId;
            const previousTaskId = node.lastTaskId;
            const managedTask = options.topicId && options.parentRunId
                ? await agentTaskManager.create({
                    kind: 'subagent',
                    agentId,
                    resumeAgentId: previousTaskId ? agentId : undefined,
                    topicId: options.topicId,
                    runId: options.parentRunId,
                    threadId: options.topicId,
                    parentTaskId: previousTaskId,
                    domain: options.domain,
                    authorization: options.readOnlyFanout ? 'read_only' : 'workspace_write',
                    providerId: node.providerOverride ?? options.providerId,
                    model: node.modelOverride ?? options.model,
                })
                : undefined;
            if (managedTask) {
                node.lastTaskId = managedTask.taskId;
                this.eventSink?.appendSoon('task_created', {
                    taskId: managedTask.taskId,
                    agentId,
                    kind: 'subagent',
                    parentTaskId: managedTask.parentTaskId,
                }, { agentId, status: 'pending' });
                await agentTaskManager.transition(managedTask.taskId, 'running');
                this.eventSink?.appendSoon('task_status_changed', {
                    taskId: managedTask.taskId,
                    status: 'running',
                }, { agentId, status: 'running' });
            }

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

                const dependencyHandoffs = node.dependencies
                    .map(dependencyId => blackboard.readValue(`__handoff:${dependencyId}`))
                    .filter((value): value is string => !!value);
                const executionNode = dependencyHandoffs.length > 0
                    ? {
                        ...node,
                        prompt: [
                            node.prompt,
                            '',
                            '## Structured dependency handoffs',
                            'Treat these as parent-validated summaries. Re-read authoritative files before editing.',
                            ...dependencyHandoffs,
                        ].join('\n'),
                    }
                    : node;
                const result = await executor(
                    executionNode,
                    blackboard,
                    nodeAccumulator,
                    options.abortSignal ?? new AbortController().signal,
                    taggedStep,
                );

                mergeTokenUsageTotals(totalTokenUsage, result.tokenUsage);
                this.consumedTokens.total += result.tokenUsage.total;

                node.tokenUsage = result.tokenUsage;

                if (result.success) {
                    this.retryEligibleAt.delete(node.id);
                    const capacity = this.adaptiveCapacity.onSuccess();
                    if (capacity.current !== capacity.previous) {
                        this.eventSink?.appendSoon('provider_capacity_changed', {
                            previous: capacity.previous,
                            current: capacity.current,
                            reason: 'stable successful sub-agent completions',
                        });
                    }
                    if (result.handoff) {
                        blackboard.write(
                            `__handoff:${node.id}`,
                            JSON.stringify(result.handoff),
                            'free_text',
                            node.id,
                        );
                    }
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
                    this.graphEngine.markComplete(graph, node.id, result.handoff?.summary ?? result.output);
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
                    } else if (isProviderRateLimit(result.error) && node.retryCount < node.maxRetries) {
                        this.requeueRateLimitedNode(node, result.error);
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
                if (managedTask) {
                    if (result.runId) await agentTaskManager.setContextRef(managedTask.taskId, result.runId);
                    const parentFacingOutput = result.handoff
                        ? JSON.stringify(result.handoff)
                        : result.output;
                    if (parentFacingOutput) await agentTaskManager.appendOutput(managedTask.taskId, parentFacingOutput);
                    const taskStatus: AgentTaskStatus = result.success
                        ? 'completed'
                        : node.status === 'cancelled'
                            ? 'killed'
                            : isTimeoutLikeError(result.error)
                                ? 'timed_out'
                                : node.status === 'pending'
                                    ? 'suspended'
                                    : 'failed';
                    await agentTaskManager.transition(managedTask.taskId, taskStatus, result.error ?? result.output);
                    this.eventSink?.appendSoon('task_status_changed', {
                        taskId: managedTask.taskId,
                        status: taskStatus,
                    }, { agentId, status: taskStatus === 'completed' ? 'done' : 'failed' });
                }
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
                } else if (isProviderRateLimit(error) && node.retryCount < node.maxRetries) {
                    this.requeueRateLimitedNode(node, error);
                } else if (isTimeoutLikeError(error)) {
                    this.graphEngine.markFailed(graph, node.id, error);
                } else if (node.retryCount < node.maxRetries) {
                    node.retryCount++;
                    node.status = 'pending';
                } else {
                    this.graphEngine.markFailed(graph, node.id, error);
                }

                this.conflictDetector.clearIntent(agentId, blackboard);
                if (managedTask) {
                    const taskStatus: AgentTaskStatus = options.abortSignal?.aborted
                        ? 'killed'
                        : isTimeoutLikeError(error)
                            ? 'timed_out'
                            : node.status === 'pending'
                                ? 'suspended'
                                : 'failed';
                    await agentTaskManager.transition(managedTask.taskId, taskStatus, error);
                    this.eventSink?.appendSoon('task_status_changed', {
                        taskId: managedTask.taskId,
                        status: taskStatus,
                    }, { agentId, status: taskStatus === 'suspended' ? 'pending' : 'failed' });
                }
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
            if (batch.length >= this.adaptiveCapacity.current) break;

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

    private requeueRateLimitedNode(node: TaskNode, error: string | undefined): void {
        node.retryCount++;
        node.status = 'pending';
        const delayMs = Math.min(30_000, 1_000 * (2 ** Math.max(0, node.retryCount - 1)));
        const eligibleAt = Date.now() + delayMs;
        this.retryEligibleAt.set(node.id, eligibleAt);
        const capacity = this.adaptiveCapacity.onRateLimit();
        this.eventSink?.appendSoon('agent_suspended', {
            agentId: node.id,
            reason: error ?? 'provider rate limit',
            retryCount: node.retryCount,
        }, { agentId: node.id, status: 'pending' });
        this.eventSink?.appendSoon('agent_requeued', {
            agentId: node.id,
            attempt: node.retryCount,
            eligibleAt: new Date(eligibleAt).toISOString(),
            delayMs,
        }, { agentId: node.id, status: 'pending' });
        if (capacity.current !== capacity.previous) {
            this.eventSink?.appendSoon('provider_capacity_changed', {
                previous: capacity.previous,
                current: capacity.current,
                reason: 'provider rate limit',
            });
        }
    }

    private async waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
        if (delayMs <= 0) return;
        await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
                reject(signal.reason instanceof Error ? signal.reason : new Error('Agent batch cancelled.'));
                return;
            }
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            const finish = () => {
                cleanup();
                resolve();
            };
            const onAbort = () => {
                clearTimeout(timer);
                cleanup();
                reject(signal?.reason instanceof Error ? signal.reason : new Error('Agent batch cancelled.'));
            };
            const timer = setTimeout(finish, delayMs);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
}
