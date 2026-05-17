/**
 * Eddy CWTool Code — 协调器核心 (Orchestrator)
 *
 * 多 Agent 协作系统的顶层入口。接收用户请求，判断复杂度，
 * 简单请求直接走单 Agent，复杂请求生成 TaskGraph 并通过
 * ParallelExecutor 调度多个专家 Agent 协作完成。
 *
 * 模型选择策略：默认继承用户在设置面板配置的供应商/模型。
 */

import * as fs from 'fs';
import * as path from 'path';
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

const SUB_AGENT_ABSOLUTE_TIMEOUT_MS = 20 * 60 * 1000;
const SUB_AGENT_IDLE_WARNING_MS = 60 * 1000;
const SUB_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SUB_AGENT_IDLE_CHECK_MS = 30 * 1000;
const SUB_AGENT_IDLE_NOTICE_INTERVAL_MS = 30 * 1000;
const CLARIFICATION_PREFIX = 'BLOCKED_FOR_ORCHESTRATOR';

function formatDurationMs(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function normalizeClarificationText(text: string): string {
    return text
        .replace(/```[\w-]*\n?/g, '')
        .replace(/```/g, '')
        .trim();
}

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
                // --- 本地化收尾清扫阶段 (Loc Sweep Phase) ---
                emitStep({
                    type: 'orchestrator_progress',
                    content: '$(globe) 正在执行本地化遗漏清扫 (Loc Sweep Phase)...',
                    timestamp: Date.now(),
                });

                const txtFiles = allWrittenFiles
                    .filter(f => f.endsWith('.txt') || f.endsWith('.gui'))
                    .map(f => `   - ${f}`)
                    .join('\n');

                const sweepPrompt = [
                    '## Localization Sweep Phase (Diagnostic-Driven ONLY)',
                    '',
                    '### STRICT RULES:',
                    '- You MUST ONLY fix keys that appear as "Missing localisation key" in `get_diagnostics` output.',
                    '- DO NOT use `search_mod_files` to look for existing localisation keys. That wastes time and finds keys that already exist.',
                    '- Your ONLY data source is the diagnostic error list from `get_diagnostics`.',
                    '',
                    '### Workflow:',
                    '1. Call `get_diagnostics` on EACH of these files (only .txt and .gui files):',
                    txtFiles,
                    '2. From the diagnostics output, extract ONLY errors/warnings containing "Missing localisation" or "missing loc key".',
                    '3. For each missing key found in step 2, call `write_localisation` to create it with appropriate text.',
                    '4. If `get_diagnostics` returns zero localisation-related errors, output "No missing localisation keys found." and STOP immediately.',
                    '',
                    '### IMPORTANT:',
                    '- Write Chinese text for simp_chinese localisation files.',
                    '- Write English text for english localisation files.',
                    '- Do NOT invent keys that are not reported by diagnostics.',
                ].join('\n');

                const sweepNode: TaskNode = {
                    id: 'loc_sweep',
                    agentType: 'loc_writer',
                    prompt: sweepPrompt,
                    dependencies: [],
                    priority: 'critical',
                    status: 'pending',
                    retryCount: 0,
                    maxRetries: 1
                };
                
                const sweepController = new AbortController();
                const sweepAccumulator = { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
                
                try {
                    const sweepResult = await this.executeSubAgent(
                        sweepNode,
                        this.blackboard,
                        sweepAccumulator,
                        sweepController.signal,
                        emitStep,
                        options
                    );
                    
                    if (sweepResult.writtenFiles && sweepResult.writtenFiles.length > 0) {
                        allWrittenFiles.push(...sweepResult.writtenFiles);
                        emitStep({
                            type: 'orchestrator_progress',
                            content: `$(check) 本地化清扫完成，补全了 ${sweepResult.writtenFiles.length} 个文件。`,
                            timestamp: Date.now(),
                        });
                    }
                } catch (e) {
                    emitStep({
                        type: 'error',
                        content: `$(warning) 本地化清扫遇到异常，已跳过: ${e instanceof Error ? e.message : String(e)}`,
                        timestamp: Date.now(),
                    });
                }
                // ----------------------------------------------

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
                                skipValidation: true, // Orchestrator 已有独立的 QualityGate，无需重复验证
                                excludeTools: [ // 与正常子代理保持一致的安全约束
                                    'web_fetch', 'search_web', 'codesearch',
                                    'run_command', 'git_ops',
                                    'mmx_generate_image', 'mmx_generate_video', 'mmx_generate_music', 'mmx_generate_speech',
                                    'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
                                ],
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

    private extractSubAgentClarification(output: string): string | undefined {
        const text = output.trim();
        if (!text) return undefined;

        if (text.includes(':::question')) {
            return normalizeClarificationText(text);
        }

        const markerIndex = text.toUpperCase().indexOf(CLARIFICATION_PREFIX);
        if (markerIndex >= 0) {
            return normalizeClarificationText(text.slice(markerIndex + CLARIFICATION_PREFIX.length).replace(/^[:：]\s*/, ''));
        }

        return undefined;
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
            abortSignal, // 稍后会被带有超时的 child controller 覆盖
            streaming: true, // 启用流式输出，使得深思进度可视化
            topicId: orchestratorOptions.topicId,
            onTodoUpdate: orchestratorOptions.onTodoUpdate,
            useSlimPrompt: true,
            maxIterations: taskNode.maxIterations ?? profile.maxIterations,
            // 子代理跳过内置 validation loop —— Orchestrator 有独立的 QualityGate 机制，
            // 不需要子代理重复验证。同时避免推理结束后 validation loop 继续产生步骤，
            // 导致外部判断卡片已标记完成但内部仍在运行的 UI 状态不一致。
            skipValidation: true,
            forceAutoApplyWrites: true,
            writeQueueWaitTimeoutMs: 60_000,
            // 🔴 子 Agent 禁用特定工具：
            // 1. 网络搜索容易导致无意义的重复搜索循环（doom loop）
            // 2. run_command / mmx_* / convert_* / deploy_mod_asset 需要用户权限审批或涉及外部创建，
            //    子 Agent 不应向用户弹出交互卡片，资产应从原版游戏文件和项目文件中选择
            // 3. 如果子任务需要网络信息，应由 Orchestrator 在分派前搜索并通过 contextFiles 注入
            excludeTools: [
                'web_fetch', 'search_web', 'codesearch', 
                'run_command', 'git_ops',
                'mmx_generate_image', 'mmx_generate_video', 'mmx_generate_music', 'mmx_generate_speech', 
                'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
            ],
        };

        const writtenFiles: string[] = [];
        const fileSnapshots = new Map<string, string | null>();
        let stepCount = 0;
        let lastActivityAt = Date.now();
        let lastIdleNoticeAt = 0;

        // 监听步骤计数和文件写入
        const forwardStep = (step: AgentStep, marksActivity = true) => {
            stepCount++;
            if (marksActivity) {
                lastActivityAt = Date.now();
            }
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
        const wrappedOnStep = (step: AgentStep) => forwardStep(step, true);

        runnerOptions.onStep = wrappedOnStep;
        runnerOptions.onPermissionRequest = async (_id, tool, description) => {
            forwardStep({
                type: 'validation',
                content: `子 Agent 已阻止交互式权限请求: ${tool}${description ? ` — ${description}` : ''}`,
                timestamp: Date.now(),
            }, false);
            return false;
        };
        
        // 记录文件快照
        runnerOptions.onBeforeFileWrite = (filePath, prevContent) => {
            if (!fileSnapshots.has(filePath)) {
                fileSnapshots.set(filePath, prevContent);
            }
            // 向上传递给父级 UI 撤回系统
            orchestratorOptions.onBeforeFileWrite?.(filePath, prevContent);
        };

        // 预读并注入 contextFiles
        let effectivePrompt = taskNode.prompt;
        if (taskNode.contextFiles && taskNode.contextFiles.length > 0) {
            let injectedContext = '';
            for (const contextRef of taskNode.contextFiles) {
                try {
                    // 1. 尝试从 Blackboard 读取
                    const bbValue = _blackboard.read(contextRef);
                    if (bbValue) {
                        injectedContext += `\n--- Context from Blackboard: ${contextRef} ---\n${bbValue.value}\n`;
                        continue;
                    }

                    // 2. 尝试作为物理文件读取
                    let targetPath = contextRef;
                    if (!path.isAbsolute(targetPath)) {
                        const vs = require('vscode');
                        const workspaceFolders = vs.workspace.workspaceFolders;
                        if (workspaceFolders && workspaceFolders.length > 0) {
                            targetPath = path.join(workspaceFolders[0].uri.fsPath, targetPath);
                        }
                    }

                    if (fs.existsSync(targetPath)) {
                        let content = fs.readFileSync(targetPath, 'utf8');
                        const MAX_CONTEXT_LENGTH = 50000;
                        if (content.length > MAX_CONTEXT_LENGTH) {
                            content = content.substring(0, MAX_CONTEXT_LENGTH) + '\n\n... [内容超长已截断。如果需要查看完整内容，请使用 read_file 工具自行分块读取]';
                        }
                        injectedContext += `\n--- Context from File: ${contextRef} ---\n${content}\n`;
                    } else {
                        ErrorReporter.warn(SOURCE.ORCHESTRATOR, `Context injection warning: could not find blackboard key or file '${contextRef}'`);
                    }
                } catch (e) {
                    ErrorReporter.warn(SOURCE.ORCHESTRATOR, `Context injection failed for '${contextRef}'`, e);
                }
            }
            if (injectedContext) {
                effectivePrompt = `<system-injected-context>\n${injectedContext}\n</system-injected-context>\n\n${effectivePrompt}`;
            }
        }

        let subAgentTimeoutId: NodeJS.Timeout | undefined;
        let subAgentIdleIntervalId: NodeJS.Timeout | undefined;
        const subAgentController = new AbortController();
        const parentAbortHandler = () => subAgentController.abort(abortSignal.reason);
        if (abortSignal.aborted) {
            subAgentController.abort(abortSignal.reason);
        } else {
            abortSignal.addEventListener('abort', parentAbortHandler);
        }

        const clearSubAgentTimers = () => {
            if (subAgentTimeoutId) {
                clearTimeout(subAgentTimeoutId);
                subAgentTimeoutId = undefined;
            }
            if (subAgentIdleIntervalId) {
                clearInterval(subAgentIdleIntervalId);
                subAgentIdleIntervalId = undefined;
            }
        };

        let subAgentAbortListener: (() => void) | undefined;
        const subAgentAbortPromise = new Promise<never>((_, reject) => {
            subAgentAbortListener = () => {
                const reason = subAgentController.signal.reason;
                if (reason instanceof Error) {
                    reject(reason);
                    return;
                }
                const err = new Error(reason ? String(reason) : 'Sub-Agent execution aborted.');
                err.name = 'AbortError';
                reject(err);
            };
            if (subAgentController.signal.aborted) {
                subAgentAbortListener();
                return;
            }
            subAgentController.signal.addEventListener('abort', subAgentAbortListener, { once: true });
        });

        const clearSubAgentGuards = () => {
            clearSubAgentTimers();
            abortSignal.removeEventListener('abort', parentAbortHandler);
            if (subAgentAbortListener) {
                subAgentController.signal.removeEventListener('abort', subAgentAbortListener);
                subAgentAbortListener = undefined;
            }
        };

        // 设定绝对超时：20 分钟 (1,200,000 ms)
        subAgentTimeoutId = setTimeout(() => {
            const err = new Error('Sub-Agent execution absolute timeout exceeded (20 minutes).');
            err.name = 'TimeoutError';
            subAgentController.abort(err);
        }, SUB_AGENT_ABSOLUTE_TIMEOUT_MS);  // W7 修复：实际值与注释/错误消息保持一致（20 分钟）

        subAgentIdleIntervalId = setInterval(() => {
            if (subAgentController.signal.aborted) return;
            const now = Date.now();
            const idleMs = now - lastActivityAt;
            if (idleMs >= SUB_AGENT_IDLE_TIMEOUT_MS) {
                const err = new Error(`Sub-Agent idle timeout exceeded (${formatDurationMs(idleMs)} without progress).`);
                err.name = 'TimeoutError';
                forwardStep({
                    type: 'error',
                    content: `子任务 ${taskNode.id} 长时间无新输出，已自动中止以避免假死 (${formatDurationMs(idleMs)})`,
                    timestamp: now,
                }, false);
                subAgentController.abort(err);
                return;
            }
            if (idleMs >= SUB_AGENT_IDLE_WARNING_MS && now - lastIdleNoticeAt >= SUB_AGENT_IDLE_NOTICE_INTERVAL_MS) {
                lastIdleNoticeAt = now;
                forwardStep({
                    type: 'orchestrator_progress',
                    content: `$(warning) 子任务 ${taskNode.id} 已 ${formatDurationMs(idleMs)} 没有新输出，仍在等待模型或工具返回。`,
                    timestamp: now,
                }, false);
            }
        }, SUB_AGENT_IDLE_CHECK_MS);

        runnerOptions.abortSignal = subAgentController.signal;

        try {
            wrappedOnStep({
                type: 'subtask_start',
                content: `启动 ${profile.mode} 子任务`,
                subagentType: profile.mode,
                timestamp: Date.now(),
            });

            const runPromise = this.agentRunner.run(
                effectivePrompt,
                { topicId: orchestratorOptions.topicId },
                [], // 空对话历史 — 子 Agent 从头开始
                runnerOptions,
            );
            const result: GenerationResult = await Promise.race([runPromise, subAgentAbortPromise]);
            
            clearSubAgentGuards();

            const output = result.explanation || result.code || '';
            const clarification = this.extractSubAgentClarification(output);
            if (clarification) {
                _blackboard.write(
                    `orchestrator:clarification:${taskNode.id}`,
                    clarification.slice(0, 8000),
                    'free_text',
                    taskNode.id,
                );
                wrappedOnStep({
                    type: 'validation',
                    content: `子任务需要主 Agent 澄清: ${clarification.slice(0, 220)}${clarification.length > 220 ? '...' : ''}`,
                    timestamp: Date.now(),
                });
                await this.rollbackSnapshots(fileSnapshots, wrappedOnStep);
                wrappedOnStep({
                    type: 'subtask_complete',
                    content: '需要主 Agent 澄清',
                    timestamp: Date.now(),
                });
                return {
                    nodeId: taskNode.id,
                    success: false,
                    output: clarification,
                    error: `SUB_AGENT_NEEDS_CLARIFICATION: ${clarification}`,
                    tokenUsage: result.tokenUsage ?? { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount,
                    needsClarification: true,
                    clarification,
                };
            }

            // 任务结束，通知前端更新状态
            wrappedOnStep({
                type: 'subtask_complete',
                content: result.isValid ? '完成' : '未通过',
                timestamp: Date.now(),
            });

            // 如果执行失败，回滚文件
            if (!result.isValid || (result as any).success === false) {
                await this.rollbackSnapshots(fileSnapshots, wrappedOnStep);
                const actualError = result.explanation || '';
                return {
                    nodeId: taskNode.id,
                    success: false,
                    output: '',
                    error: `子任务失败: 验证未通过或执行出错，已回滚 ${fileSnapshots.size} 个文件。${actualError ? ' 原因: ' + actualError : ''}`,
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
            clearSubAgentGuards();

            const error = e instanceof Error ? e.message : String(e);
            wrappedOnStep({
                type: 'subtask_complete',
                content: error.includes('timeout') ? '超时终止' : '异常终止',
                timestamp: Date.now(),
            });
            ErrorReporter.warn(SOURCE.ORCHESTRATOR, `子 Agent ${taskNode.id} 执行异常`, e);
            await this.rollbackSnapshots(fileSnapshots, wrappedOnStep);
            return {
                nodeId: taskNode.id,
                success: false,
                output: '',
                error: `子任务异常中止: ${error}，已回滚 ${fileSnapshots.size} 个文件。`,
                tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                writtenFiles: [],
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
