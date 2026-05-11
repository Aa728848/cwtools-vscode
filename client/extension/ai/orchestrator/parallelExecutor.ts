/**
 * Eddy CWTool Code — 并行执行器
 *
 * 管理多个 Agent 实例的并行执行，控制并发上限和全局 Token 预算。
 * 按 DAG 层级调度：同层节点并行，层间流水线。
 */

import * as os from 'os';
import type {
    TaskGraph,
    TaskNode,
    SubAgentResult,
    OrchestratorResult,
    OrchestratorOptions,
    AgentInstance,
} from './types';
import type { TokenUsage, AgentStep, AgentMode } from '../types';
import { TaskGraphEngine } from './taskGraphEngine';
import { Blackboard } from './blackboard';
import { ConflictDetector } from './conflictDetector';
import { getAgentProfile } from './agentRegistry';
import { ErrorReporter } from '../errorReporter';
import { SOURCE } from '../messages';

/** 子 Agent 执行函数签名 — 由 Orchestrator 注入具体的 AgentRunner.run 调用 */
export type SubAgentExecutor = (
    taskNode: TaskNode,
    blackboard: Blackboard,
    parentAccumulator: TokenUsage,
    abortSignal: AbortSignal,
    onStep: (step: AgentStep) => void,
) => Promise<SubAgentResult>;

/**
 * 并行执行器。
 *
 * 功能：
 * 1. 按 DAG 拓扑层级调度 Agent 执行
 * 2. 同层节点限制并发数（防止事件循环阻塞）
 * 3. 监控全局 Token 预算，超限时降级为串行
 * 4. 通过 ConflictDetector 管理写入意图
 * 5. 支持失败重试和级联取消
 */
export class ParallelExecutor {
    /** 最大并发 Agent 数 */
    private readonly maxConcurrency: number;
    /** 全局 Token 预算上限（0 = 无限制） */
    private globalTokenBudget: number;
    /** 已消耗的 Token 总量 */
    private consumedTokens: TokenUsage;
    /** 冲突检测器 */
    private conflictDetector: ConflictDetector;
    /** DAG 引擎 */
    private graphEngine: TaskGraphEngine;

    constructor(options?: {
        maxConcurrency?: number;
        globalTokenBudget?: number;
    }) {
        // 默认并发数 = min(4, CPU核心数)
        this.maxConcurrency = options?.maxConcurrency ??
            Math.min(4, os.cpus().length || 2);
        this.globalTokenBudget = options?.globalTokenBudget ?? 0;
        this.consumedTokens = { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
        this.conflictDetector = new ConflictDetector();
        this.graphEngine = new TaskGraphEngine();
    }

    /**
     * 执行完整的任务图。
     *
     * 按层级调度：
     * 1. 拓扑排序得到执行层级
     * 2. 每层内并行执行（受并发上限限制）
     * 3. 层完成后检查是否有新的就绪节点
     * 4. 直到所有节点完成或全部失败/取消
     */
    async executeGraph(
        graph: TaskGraph,
        blackboard: Blackboard,
        executor: SubAgentExecutor,
        options: OrchestratorOptions,
    ): Promise<OrchestratorResult> {
        const agentResults = new Map<string, SubAgentResult>();
        const totalTokenUsage: TokenUsage = { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
        const emitStep = options.onStep ?? (() => {});

        // 验证图的合法性
        const cycles = this.graphEngine.detectCycles(graph);
        if (cycles) {
            return {
                success: false,
                summary: `任务图存在循环依赖: ${cycles.map(c => c.join(' → ')).join('; ')}`,
                agentResults,
                totalTokenUsage,
                failedNodes: [],
                cancelledNodes: [],
            };
        }

        emitStep({
            type: 'thinking',
            content: `📊 任务图调度开始: ${graph.nodes.size} 个节点, 最大并发 ${this.maxConcurrency}`,
            timestamp: Date.now(),
        });

        // 主调度循环
        while (!this.graphEngine.isComplete(graph)) {
            options.abortSignal?.throwIfAborted();

            const readyNodes = this.graphEngine.getReadyNodes(graph);
            if (readyNodes.length === 0) {
                // 没有就绪节点但图未完成 — 说明有运行中的节点，等待
                // 实际上不会发生，因为我们同步等待每批次完成
                break;
            }

            // 检查 Token 预算
            if (this.globalTokenBudget > 0 &&
                this.consumedTokens.total > this.globalTokenBudget) {
                emitStep({
                    type: 'error',
                    content: `⚠ 全局 Token 预算超限 (${this.consumedTokens.total}/${this.globalTokenBudget})，降级为串行执行`,
                    timestamp: Date.now(),
                });
                // 降级：只取第一个就绪节点串行执行
                readyNodes.splice(1);
            }

            // 按并发上限分批执行
            const batch = readyNodes.slice(0, this.maxConcurrency);

            emitStep({
                type: 'thinking',
                content: `🚀 执行批次: ${batch.map(n => `${n.id}(${n.agentType})`).join(', ')}`,
                timestamp: Date.now(),
            });

            // 并行执行本批次
            const batchResults = await this.executeBatch(
                batch, graph, blackboard, executor, totalTokenUsage, options
            );

            // 合并结果
            for (const [nodeId, result] of batchResults) {
                agentResults.set(nodeId, result);
            }
        }

        // 汇总
        const progress = this.graphEngine.getProgressSummary(graph);
        const failedNodes = [...graph.nodes.values()]
            .filter(n => n.status === 'failed')
            .map(n => n.id);
        const cancelledNodes = [...graph.nodes.values()]
            .filter(n => n.status === 'cancelled')
            .map(n => n.id);

        const success = failedNodes.length === 0 && cancelledNodes.length === 0;

        const summary = [
            `## 执行完成`,
            `- 总节点: ${progress.total}`,
            `- 成功: ${progress.done}`,
            `- 失败: ${progress.failed}`,
            `- 取消: ${progress.cancelled}`,
            `- Token 消耗: ${totalTokenUsage.total} (约 ¥${totalTokenUsage.estimatedCostCny.toFixed(4)})`,
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

    /**
     * 执行一批无依赖的节点（并行）。
     */
    private async executeBatch(
        nodes: TaskNode[],
        graph: TaskGraph,
        blackboard: Blackboard,
        executor: SubAgentExecutor,
        totalTokenUsage: TokenUsage,
        options: OrchestratorOptions,
    ): Promise<Map<string, SubAgentResult>> {
        const results = new Map<string, SubAgentResult>();

        // 标记所有节点为运行中
        for (const node of nodes) {
            this.graphEngine.markRunning(graph, node.id);
        }

        // 并行执行
        const promises = nodes.map(async (node) => {
            const agentId = `agent_${node.id}_${Date.now().toString(36)}`;

            try {
                // 步骤回调加上 agentId 标签
                const taggedStep = (step: AgentStep) => {
                    options.onStep?.({
                        ...step,
                        content: `[${node.id}] ${step.content}`,
                    });
                };

                // 使用子 Agent Token 累加器
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

                // 合并 Token 消耗
                totalTokenUsage.total += result.tokenUsage.total;
                totalTokenUsage.input += result.tokenUsage.input;
                totalTokenUsage.output += result.tokenUsage.output;
                totalTokenUsage.estimatedCostCny += result.tokenUsage.estimatedCostCny;
                this.consumedTokens.total += result.tokenUsage.total;

                // 更新节点状态
                node.tokenUsage = result.tokenUsage;

                if (result.success) {
                    this.graphEngine.markComplete(graph, node.id, result.output);

                    // 写入成功后清除写入意图
                    this.conflictDetector.clearIntent(agentId, blackboard);
                } else {
                    // 检查是否可重试
                    if (node.retryCount < node.maxRetries) {
                        node.retryCount++;
                        node.status = 'pending'; // 重置为待执行
                        ErrorReporter.debug(SOURCE.ORCHESTRATOR, `节点 ${node.id} 执行失败，重试 ${node.retryCount}/${node.maxRetries}`);
                    } else {
                        const cancelled = this.graphEngine.markFailed(
                            graph, node.id, result.error ?? '未知错误'
                        );
                        if (cancelled.length > 0) {
                            options.onStep?.({
                                type: 'error',
                                content: `节点 ${node.id} 失败，已取消下游节点: ${cancelled.join(', ')}`,
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

                // 重试或级联失败
                if (node.retryCount < node.maxRetries) {
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

    /** 获取当前已消耗的 Token 总量 */
    getConsumedTokens(): TokenUsage {
        return { ...this.consumedTokens };
    }
}
