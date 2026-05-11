/**
 * Eddy CWTool Code — 协调器核心 (Orchestrator)
 *
 * 多 Agent 协作系统的顶层入口。接收用户请求，判断复杂度，
 * 简单请求直接走单 Agent，复杂请求生成 TaskGraph 并通过
 * ParallelExecutor 调度多个专家 Agent 协作完成。
 *
 * 模型选择策略：默认继承用户在设置面板配置的供应商/模型。
 */

import type {
    TaskGraph,
    TaskNode,
    SubAgentResult,
    OrchestratorResult,
    OrchestratorOptions,
} from './types';
import type {
    AgentMode,
    AgentStep,
    TokenUsage,
    ChatMessage,
    GenerationResult,
} from '../types';
import { TaskGraphEngine } from './taskGraphEngine';
import { Blackboard } from './blackboard';
import { ParallelExecutor, type SubAgentExecutor } from './parallelExecutor';
import { QualityGate } from './qualityGate';
import { getAgentProfile } from './agentRegistry';
import { ErrorReporter } from '../errorReporter';
import { SOURCE } from '../messages';

// AgentRunner 和 AgentToolExecutor 的类型引用（避免循环依赖，使用 import type）
import type { AgentRunner, AgentRunnerOptions } from '../agentRunner';

/**
 * 协调器 — 多 Agent 团队的指挥中心。
 *
 * 职责：
 * 1. 请求分析：判断是否需要多 Agent 协作
 * 2. 任务分解：将复杂请求分解为 TaskGraph（DAG）
 * 3. 调度执行：通过 ParallelExecutor 管理 Agent 生命周期
 * 4. 结果综合：汇总各 Agent 输出为最终交付物
 * 5. 质量把关：Builder 完成后触发 Reviewer 审查
 */
export class Orchestrator {
    private blackboard: Blackboard;
    private executor: ParallelExecutor;
    private qualityGate: QualityGate;
    private graphEngine: TaskGraphEngine;

    constructor(
        private agentRunner: AgentRunner,
        options?: {
            maxConcurrency?: number;
            globalTokenBudget?: number;
        },
    ) {
        this.blackboard = new Blackboard();
        this.executor = new ParallelExecutor({
            maxConcurrency: options?.maxConcurrency,
            globalTokenBudget: options?.globalTokenBudget,
        });
        this.qualityGate = new QualityGate();
        this.graphEngine = new TaskGraphEngine();
    }

    /** 获取黑板实例（供外部模块读取 Agent 间共享数据） */
    getBlackboard(): Blackboard {
        return this.blackboard;
    }

    /**
     * 主入口：执行多 Agent 协作任务。
     *
     * @param taskGraph 预构建的任务图（由 LLM 分解或手动构建）
     * @param options 协调器选项
     * @returns 协作执行结果
     */
    async execute(
        taskGraph: TaskGraph,
        options: OrchestratorOptions,
    ): Promise<OrchestratorResult> {
        const emitStep = options.onStep ?? (() => {});

        emitStep({
            type: 'thinking',
            content: `🎯 协调器启动: ${taskGraph.nodes.size} 个子任务`,
            timestamp: Date.now(),
        });

        // 验证任务图
        const cycles = this.graphEngine.detectCycles(taskGraph);
        if (cycles) {
            const errMsg = `任务图存在循环依赖: ${cycles.map(c => c.join(' → ')).join('; ')}`;
            emitStep({ type: 'error', content: errMsg, timestamp: Date.now() });
            return {
                success: false,
                summary: errMsg,
                agentResults: new Map(),
                totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                failedNodes: [],
                cancelledNodes: [],
            };
        }

        // 构建子 Agent 执行器（闭包捕获 agentRunner 和配置）
        const subAgentExecutor: SubAgentExecutor = async (
            taskNode, blackboard, parentAccumulator, abortSignal, onStep,
        ) => {
            return this.executeSubAgent(
                taskNode, blackboard, parentAccumulator, abortSignal, onStep, options,
            );
        };

        // 通过并行执行器调度
        const result = await this.executor.executeGraph(
            taskGraph, this.blackboard, subAgentExecutor, options,
        );

        // 质量门：对所有成功的 Builder 节点触发审查
        if (result.success && this.shouldRunQualityGate(taskGraph)) {
            emitStep({
                type: 'orchestrator_progress',
                content: '$(search) 触发质量门审查...',
                timestamp: Date.now(),
            });
            const allWrittenFiles: string[] = [];
            for (const agentResult of result.agentResults.values()) {
                allWrittenFiles.push(...agentResult.writtenFiles);
            }
            if (allWrittenFiles.length > 0) {
                emitStep({
                    type: 'validation',
                    content: `质量门: ${allWrittenFiles.length} 个文件待审查`,
                    timestamp: Date.now(),
                });

                // 启动 Reviewer Agent
                const reviewResult = await this.qualityGate.reviewOutput(
                    this.agentRunner,
                    allWrittenFiles,
                    options
                );

                if (reviewResult.passed) {
                    emitStep({ type: 'orchestrator_progress', content: '$(check) 质量门审查通过！', timestamp: Date.now() });
                } else {
                    emitStep({ type: 'error', content: `$(x) 质量门审查未通过，发现 ${reviewResult.remainingIssues} 个问题。`, timestamp: Date.now() });
                    const config = this.qualityGate.getConfig();
                    
                    if (config.autoFix) {
                        emitStep({ type: 'orchestrator_progress', content: '$(gear) 正在调度自动修复...', timestamp: Date.now() });
                        
                        const fixPrompt = this.qualityGate.buildFixPrompt(reviewResult.reviewReport, allWrittenFiles);
                        const fixResult = await this.agentRunner.run(
                            fixPrompt,
                            {}, // context
                            [], // conversationHistory
                            {
                                ...options,
                                mode: 'build', // 强制使用构建模式进行修复
                            }
                        );

                        if (fixResult.isValid) {
                            emitStep({ type: 'orchestrator_progress', content: '$(check) 自动修复完成。', timestamp: Date.now() });
                            // 这里可以递归或再次触发审查，但在简单的实现中先只执行一次 autoFix
                        } else {
                            emitStep({ type: 'error', content: '$(x) 自动修复失败。', timestamp: Date.now() });
                        }
                    }
                }
            }
        }

        // 最终报告
        emitStep({
            type: 'orchestrator_progress',
            content: result.summary,
            timestamp: Date.now(),
        });

        return result;
    }

    /**
     * 执行单个子 Agent。
     *
     * 将 TaskNode 转换为 AgentRunner.run() 调用，
     * 模型选择优先级：TaskNode.modelOverride > AgentProfile.suggestedModel > 用户设置
     */
    private async executeSubAgent(
        taskNode: TaskNode,
        _blackboard: Blackboard,
        _parentAccumulator: TokenUsage,
        abortSignal: AbortSignal,
        onStep: (step: AgentStep) => void,
        orchestratorOptions: OrchestratorOptions,
    ): Promise<SubAgentResult> {
        const profile = getAgentProfile(taskNode.agentType);

        // 模型选择优先级链：
        // 1. TaskNode 显式覆盖
        // 2. AgentProfile 建议值
        // 3. Orchestrator 选项（来自用户设置）
        const providerId = taskNode.providerOverride
            ?? profile.suggestedProvider
            ?? orchestratorOptions.providerId;
        const model = taskNode.modelOverride
            ?? profile.suggestedModel
            ?? orchestratorOptions.model;

        const runnerOptions: AgentRunnerOptions = {
            providerId,
            model,
            mode: profile.mode,
            onStep,
            abortSignal,
            streaming: true, // 启用流式输出，使得深思进度可视化
            topicId: orchestratorOptions.topicId,
            onTodoUpdate: orchestratorOptions.onTodoUpdate,
        };

        const writtenFiles: string[] = [];
        const fileSnapshots = new Map<string, string | null>();
        let stepCount = 0;

        // 监听步骤计数和文件写入
        const wrappedOnStep = (step: AgentStep) => {
            stepCount++;
            step.agentId = taskNode.id; // 添加子代理 ID 标识
            // 从 tool_result 中提取写入的文件路径
            if (step.type === 'tool_result' && step.toolResult) {
                const result = step.toolResult as Record<string, unknown>;
                if (result.success && typeof result.filePath === 'string') {
                    writtenFiles.push(result.filePath);
                }
            }
            onStep(step);
        };

        runnerOptions.onStep = wrappedOnStep;
        
        // 记录文件快照
        runnerOptions.onBeforeFileWrite = (filePath, prevContent) => {
            if (!fileSnapshots.has(filePath)) {
                fileSnapshots.set(filePath, prevContent);
            }
            // 向上传递给父级 UI 撤回系统
            orchestratorOptions.onBeforeFileWrite?.(filePath, prevContent);
        };

        try {
            const result: GenerationResult = await this.agentRunner.run(
                taskNode.prompt,
                { topicId: orchestratorOptions.topicId },
                [], // 空对话历史 — 子 Agent 从头开始
                runnerOptions,
            );
            
            // 如果执行失败，回滚文件
            if (!result.isValid || (result as any).success === false) {
                await this.rollbackSnapshots(fileSnapshots, onStep);
                return {
                    nodeId: taskNode.id,
                    success: false,
                    output: '',
                    error: `子任务失败: 验证未通过或执行出错，已回滚 ${fileSnapshots.size} 个文件。`,
                    tokenUsage: result.tokenUsage ?? { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount,
                };
            }

            return {
                nodeId: taskNode.id,
                success: result.isValid,
                output: result.explanation || result.code || '',
                tokenUsage: result.tokenUsage ?? { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                writtenFiles,
                stepCount,
            };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            ErrorReporter.warn(SOURCE.ORCHESTRATOR, `子 Agent ${taskNode.id} 执行异常`, e);
            return {
                nodeId: taskNode.id,
                success: false,
                output: '',
                error,
                tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                writtenFiles,
                stepCount,
            };
        }
    }

    /**
     * 判断是否需要触发质量门审查。
     * 条件：任务图中包含 builder 类型的节点。
     */
    private shouldRunQualityGate(graph: TaskGraph): boolean {
        for (const node of graph.nodes.values()) {
            if (node.agentType === 'build' && node.status === 'done') {
                return true;
            }
        }
        return false;
    }

    /**
     * 文件写入回滚机制。
     * 当子 Agent 执行失败时，恢复所有已修改的文件到原始状态。
     */
    private async rollbackSnapshots(
        snapshots: Map<string, string | null>,
        onStep: (step: AgentStep) => void
    ): Promise<void> {
        if (snapshots.size === 0) return;

        try {
            const fs = await import('fs');
            for (const [filePath, prevContent] of snapshots.entries()) {
                if (prevContent === null) {
                    // 文件原本不存在，说明是新创建的，需要删除
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        onStep({
                            type: 'thinking',
                            content: `🔄 回滚: 已删除新建的文件 ${filePath}`,
                            timestamp: Date.now(),
                        });
                    }
                } else {
                    // 恢复旧内容（prevContent 是 UTF-8 原始文本）
                    fs.writeFileSync(filePath, prevContent, 'utf-8');
                    onStep({
                        type: 'thinking',
                        content: `🔄 回滚: 已恢复文件 ${filePath} 到修改前状态`,
                        timestamp: Date.now(),
                    });
                }
            }
        } catch (e) {
            ErrorReporter.warn(SOURCE.ORCHESTRATOR, '执行文件回滚时发生异常', e);
        }
    }

    // ─── 便捷工厂方法 ────────────────────────────────────────────────────────

    /**
     * 快速创建一个简单的流水线任务图。
     *
     * 示例用法（Explorer → Builder → LocWriter → Reviewer）：
     * ```typescript
     * const graph = Orchestrator.createPipeline('创建考古遗址', [
     *     { id: 'explore', agentType: 'explore', prompt: '扫描项目结构...' },
     *     { id: 'build',   agentType: 'build',   prompt: '创建考古遗址文件...' },
     *     { id: 'loc',     agentType: 'loc_writer', prompt: '生成本地化...' },
     *     { id: 'review',  agentType: 'review',  prompt: '审查代码质量...' },
     * ]);
     * ```
     */
    static createPipeline(
        userPrompt: string,
        stages: Array<{ id: string; agentType: AgentMode; prompt: string }>,
    ): TaskGraph {
        const graph = TaskGraphEngine.createGraph(userPrompt);
        let prevId: string | undefined;

        for (const stage of stages) {
            TaskGraphEngine.addNode(graph, stage.id, stage.agentType, stage.prompt, {
                dependencies: prevId ? [prevId] : [],
            });
            prevId = stage.id;
        }

        return graph;
    }

    /**
     * 创建并行分支任务图（多个节点共享相同的前置依赖）。
     *
     * 示例用法：
     * ```typescript
     * const graph = Orchestrator.createFanOut('翻译本地化', 'explore_1', [
     *     { id: 'loc_en',   agentType: 'loc_writer', prompt: '生成英文本地化' },
     *     { id: 'loc_zh',   agentType: 'loc_writer', prompt: '生成中文本地化' },
     *     { id: 'loc_fr',   agentType: 'loc_writer', prompt: '生成法文本地化' },
     * ]);
     * ```
     */
    static createFanOut(
        userPrompt: string,
        sharedDependency: string,
        branches: Array<{ id: string; agentType: AgentMode; prompt: string }>,
    ): TaskGraph {
        const graph = TaskGraphEngine.createGraph(userPrompt);

        for (const branch of branches) {
            TaskGraphEngine.addNode(graph, branch.id, branch.agentType, branch.prompt, {
                dependencies: [sharedDependency],
            });
        }

        return graph;
    }
}
