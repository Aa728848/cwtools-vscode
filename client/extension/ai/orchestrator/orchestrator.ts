/** 
* Eddy CWTool Code — Orchestrator 
* 
* Top-level entrance to multi-Agent collaboration system. Receive user requests and determine complexity, 
* Simple requests can go directly to the agent, and complex requests can generate TaskGraph and pass it through. 
* ParallelExecutor schedules multiple expert Agents to complete the task collaboratively. 
* 
* Model selection strategy: By default, the supplier/model configured by the user in the settings panel will be inherited. 
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
    AgentToolName,
    TokenUsage,
    GenerationResult,
} from '../types';
import { TaskGraphEngine } from './taskGraphEngine';
import { Blackboard } from './blackboard';
import { ParallelExecutor, type SubAgentExecutor } from './parallelExecutor';
import { QualityGate, PDX_DIAGNOSTIC_EXTENSIONS, isPdxDiagnosticFile } from './qualityGate';
import { getAgentProfile } from './agentRegistry';
import { ErrorReporter } from '../errorReporter';
import { SOURCE, ORCHESTRATOR_MSG } from '../messages';
import { runLedger, RunLedger } from '../runner/runLedger';
import { getAgentToolTargetFiles } from '../runner/toolScheduler';
import { WRITE_TOOLS } from '../tools/registry';

// Type references of AgentRunner and AgentToolExecutor (to avoid circular dependencies, use import type)
import type { AgentRunner, AgentRunnerOptions } from '../agentRunner';

const SUB_AGENT_ABSOLUTE_TIMEOUT_MS = 20 * 60 * 1000;
const SUB_AGENT_IDLE_WARNING_MS = 60 * 1000;
const SUB_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SUB_AGENT_IDLE_CHECK_MS = 30 * 1000;
const SUB_AGENT_IDLE_NOTICE_INTERVAL_MS = 30 * 1000;
const CLARIFICATION_PREFIX = 'BLOCKED_FOR_ORCHESTRATOR';
const LOCALISATION_GENERIC_WRITE_TOOLS = [
    'write_file',
    'edit_file',
    'replace_lines',
    'multi_replace_file_content',
    'apply_patch',
];

function isLocalisationYmlPath(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().replace(/\\/g, '/').toLowerCase();
    if (!normalized.endsWith('.yml')) return false;
    return /(?:^|\/)(localisation|localisation_synced|localization)(?:\/|$)/.test(normalized);
}

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
* Coordinator - the command center for multi-Agent teams. 
* 
* Responsibilities: 
* 1. Request analysis: determine whether multi-Agent collaboration is required 
* 2. Task decomposition: Decompose complex requests into TaskGraph (DAG) 
* 3. Scheduling execution: Manage Agent life cycle through ParallelExecutor 
* 4. Result synthesis: Summarize the output of each Agent into the final deliverable 
* 5. Quality control: Reviewer triggers review after Builder is completed 
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

    /** Obtain the blackboard instance (for external modules to read shared data between Agents) */
    getBlackboard(): Blackboard {
        return this.blackboard;
    }

    /** 
* Main entrance: perform multi-Agent collaboration tasks. 
* 
* @param taskGraph pre-built task graph (decomposed by LLM or built manually) 
* @param options coordinator options 
* @returns collaborative execution results 
*/
    async execute(
        taskGraph: TaskGraph,
        options: OrchestratorOptions,
    ): Promise<OrchestratorResult> {
        const emitStep = options.onStep ?? (() => {});

        emitStep({
            type: 'thinking',
            content: ORCHESTRATOR_MSG.START(taskGraph.nodes.size),
            timestamp: Date.now(),
        });

        // Verify task graph
        const cycles = this.graphEngine.detectCycles(taskGraph);
        if (cycles) {
            const errMsg = ORCHESTRATOR_MSG.CYCLE_ERROR(cycles.map(c => c.join(' → ')).join('; '));
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

        // Build child Agent executor (closure captures agentRunner and configuration)
        const subAgentExecutor: SubAgentExecutor = async (
            taskNode, blackboard, parentAccumulator, abortSignal, onStep,
        ) => {
            return this.executeSubAgent(
                taskNode, blackboard, parentAccumulator, abortSignal, onStep, options,
            );
        };

        // Scheduling via parallel executors
        const result = await this.executor.executeGraph(
            taskGraph, this.blackboard, subAgentExecutor, options,
        );

        // Quality gate: Trigger review on all successful Builder nodes
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
                // --- Localization Sweep Phase (Loc Sweep Phase) ---
                emitStep({
                    type: 'orchestrator_progress',
                    content: ORCHESTRATOR_MSG.LOC_SWEEP_START,
                    timestamp: Date.now(),
                });

                const diagnosticFiles = allWrittenFiles
                    .filter(isPdxDiagnosticFile)
                    .map(f => `   - ${f}`)
                    .join('\n');
                const diagnosticExtensionList = PDX_DIAGNOSTIC_EXTENSIONS.join(', ');

                const sweepPrompt = [
                    '## Localization Sweep Phase (Diagnostic-Driven ONLY)',
                    '',
                    '### STRICT RULES:',
                    '- You MUST ONLY fix keys that appear as "Missing localisation key" in `get_diagnostics` output.',
                    '- DO NOT use `search_mod_files` to look for existing localisation keys. That wastes time and finds keys that already exist.',
                    '- Your ONLY data source is the diagnostic error list from `get_diagnostics`.',
                    '',
                    '### Workflow:',
                    `1. Call \`get_diagnostics\` on EACH of these LSP diagnostic target files (${diagnosticExtensionList}):`,
                    diagnosticFiles || '   - (No PDX diagnostic target files)',
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
                            content: ORCHESTRATOR_MSG.LOC_SWEEP_DONE(sweepResult.writtenFiles.length),
                            timestamp: Date.now(),
                        });
                    }
                } catch (e) {
                    emitStep({
                        type: 'error',
                        content: ORCHESTRATOR_MSG.LOC_SWEEP_ERROR(e instanceof Error ? e.message : String(e)),
                        timestamp: Date.now(),
                    });
                }
                // ----------------------------------------------

                emitStep({
                    type: 'validation',
                    content: ORCHESTRATOR_MSG.QG_START(allWrittenFiles.length),
                    timestamp: Date.now(),
                });

                // Start Reviewer Agent
                const reviewResult = await this.qualityGate.reviewOutput(
                    this.agentRunner,
                    allWrittenFiles,
                    options
                );

                if (reviewResult.passed) {
                    emitStep({ type: 'orchestrator_progress', content: ORCHESTRATOR_MSG.QG_PASS, timestamp: Date.now() });
                } else {
                    emitStep({ type: 'error', content: ORCHESTRATOR_MSG.QG_FAIL(reviewResult.logicIssues), timestamp: Date.now() });
                    const config = this.qualityGate.getConfig();
                    
                    if (config.autoFix) {
                        emitStep({ type: 'orchestrator_progress', content: ORCHESTRATOR_MSG.AUTOFIX_START, timestamp: Date.now() });
                        
                        const fixPrompt = this.qualityGate.buildFixPrompt(reviewResult.reviewReport, allWrittenFiles);
                        const fixResult = await this.agentRunner.run(
                            fixPrompt,
                            {}, // context
                            [], // conversationHistory
                            {
                                ...options,
                                mode: 'build', // Force use of build mode for repair
                                skipValidation: true, // Orchestrator already has an independent QualityGate, no need to repeat verification
                                excludeTools: [ // Maintain consistent security constraints with normal subagents
                                    'web_fetch', 'search_web', 'codesearch',
                                    'run_command', 'git_ops',

                                    'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
                                ],
                            }
                        );

                        if (fixResult.isValid) {
                            emitStep({ type: 'orchestrator_progress', content: ORCHESTRATOR_MSG.AUTOFIX_DONE, timestamp: Date.now() });
                            // Here you can recurse or trigger the review again, but in a simple implementation only execute autoFix once
                        } else {
                            emitStep({ type: 'error', content: ORCHESTRATOR_MSG.AUTOFIX_FAIL, timestamp: Date.now() });
                        }
                    }
                }
            }
        }

        // final report
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
* Execute a single sub-Agent. 
* 
* Convert TaskNode to AgentRunner.run() call, 
* Model selection priority: TaskNode.modelOverride > AgentProfile.suggestedModel > User settings 
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

        // Model selection priority chain:
        // 1. TaskNode explicit override
        // 2. AgentProfile recommended value
        // 3. Orchestrator options (from user settings)
        const providerId = taskNode.providerOverride
            ?? profile.suggestedProvider
            ?? orchestratorOptions.providerId;
        const model = taskNode.modelOverride
            ?? profile.suggestedModel
            ?? orchestratorOptions.model;

        const workspaceRoot = this.agentRunner.toolExecutor?.workspaceRoot || process.cwd();
        const { buildSubAgentSandbox } = require('./subAgentSandbox');
        const sandbox = buildSubAgentSandbox(taskNode, workspaceRoot);
        const plannedFiles = Array.isArray(taskNode.plannedFiles) ? taskNode.plannedFiles : [];
        const onlyLocalisationYmlWrites = plannedFiles.length > 0 && plannedFiles.every(isLocalisationYmlPath);
        const excludedTools = [
            'web_fetch', 'search_web', 'codesearch',
            'run_command', 'git_ops',

            'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
            ...(onlyLocalisationYmlWrites ? LOCALISATION_GENERIC_WRITE_TOOLS : []),
        ];

        const runnerOptions: AgentRunnerOptions = {
            sandbox,
            providerId,
            model,
            mode: profile.mode,
            onStep,
            abortSignal, // Will be overwritten later by the child controller with timeout
            streaming: true, // Enable streaming output to visualize the progress of deep thinking
            topicId: orchestratorOptions.topicId,
            onTodoUpdate: orchestratorOptions.onTodoUpdate,
            useSlimPrompt: true,
            maxIterations: taskNode.maxIterations ?? profile.maxIterations,
            // The subagent skips the built-in validation loop - Orchestrator has an independent QualityGate mechanism,
            // No need for sub-agent to re-verify. At the same time, it prevents the validation loop from continuing to generate steps after the inference is completed.
            // Leading to an inconsistent UI state where the external judgment card is marked as completed but the internal one is still running.
            skipValidation: true,
            forceAutoApplyWrites: true,
            writeQueueWaitTimeoutMs: 60_000,
            // 🔴 Sub-Agent disables specific tools:
            // 1. Internet searches can easily lead to meaningless repetitive search loops (doom loops)
            // 2. run_command / mmx_* / convert_* / deploy_mod_asset requires user permission approval or involves external creation.
            // The child Agent should not pop up interactive cards to the user, and the assets should be selected from the original game files and project files.
            // 3. If the subtask requires network information, it should be searched by Orchestrator and injected through contextFiles before dispatching.
            excludeTools: excludedTools,
        };

        const writtenFiles: string[] = [];
        const writtenFileKeys = new Set<string>();
        const toolTargetsByInvocation = new Map<string, string[]>();
        const fileSnapshots = new Map<string, string | null>();
        let stepCount = 0;
        let lastActivityAt = Date.now();
        let lastIdleNoticeAt = 0;
        const rememberWrittenFile = (filePath: unknown) => {
            if (typeof filePath !== 'string' || !filePath.trim()) return;
            const normalized = path.isAbsolute(filePath)
                ? path.resolve(filePath)
                : path.resolve(workspaceRoot, filePath);
            const key = normalized.toLowerCase();
            if (writtenFileKeys.has(key)) return;
            writtenFileKeys.add(key);
            writtenFiles.push(normalized);
        };
        const rememberWrittenFilesFromResult = (result: Record<string, unknown>) => {
            for (const key of ['filePath', 'file', 'TargetFile', 'targetRelativePath']) {
                rememberWrittenFile(result[key]);
            }
            for (const key of ['filesChanged', 'writtenFiles', 'filesWritten']) {
                const files = result[key];
                if (!Array.isArray(files)) continue;
                for (const file of files) rememberWrittenFile(file);
            }
        };
        const isSuccessfulWriteResult = (result: Record<string, unknown>) => {
            return result.success !== false && !result.error && !result.skipped;
        };

        //Listen to step count and file writing
        const forwardStep = (step: AgentStep, marksActivity = true) => {
            stepCount++;
            if (marksActivity) {
                lastActivityAt = Date.now();
            }
            step.agentId = taskNode.id; //Add subagent ID
            if (step.type === 'tool_call' && step.toolName && WRITE_TOOLS.has(step.toolName as AgentToolName) && step.toolArgs && step.invocationId) {
                const targets = getAgentToolTargetFiles(step.toolName, step.toolArgs as Record<string, unknown>, workspaceRoot, orchestratorOptions.topicId);
                if (targets.length > 0) toolTargetsByInvocation.set(step.invocationId, targets);
            }
            // Extract written file paths from successful write tool results. Some file tools
            // return only a message/diff, so keep the target path from the paired tool_call.
            if (step.type === 'tool_result' && step.toolName && WRITE_TOOLS.has(step.toolName as AgentToolName) && step.toolResult) {
                const result = step.toolResult as Record<string, unknown>;
                if (isSuccessfulWriteResult(result)) {
                    rememberWrittenFilesFromResult(result);
                    const targets = step.invocationId ? toolTargetsByInvocation.get(step.invocationId) : undefined;
                    if (targets) {
                        for (const file of targets) rememberWrittenFile(file);
                    }
                }
            }
            onStep(step);
        };
        const wrappedOnStep = (step: AgentStep) => forwardStep(step, true);

        runnerOptions.onStep = wrappedOnStep;
        runnerOptions.onPermissionRequest = async (id, tool, description, command, permissionContext) => {
            const requestPermission = orchestratorOptions.onPermissionRequest;
            forwardStep({
                type: 'validation',
                content: requestPermission
                    ? `子 Agent 等待用户授权: ${tool}${description ? ` - ${description}` : ''}`
                    : `子 Agent 无法请求用户授权: ${tool}${description ? ` - ${description}` : ''}`,
                timestamp: Date.now(),
            });
            if (!requestPermission) return false;
            try {
                const allowed = await requestPermission(
                    id,
                    tool,
                    `[${taskNode.id}] ${description}`,
                    command,
                    permissionContext,
                );
                forwardStep({
                    type: 'validation',
                    content: `子 Agent 权限请求${allowed ? '已批准' : '被拒绝'}: ${tool}`,
                    timestamp: Date.now(),
                });
                if (!allowed) {
                    const latestRunId = RunLedger.getLatestActiveRunId();
                    if (latestRunId) {
                        runLedger.appendEvent(latestRunId, 'subagent_refused', {
                            agentId: taskNode.id,
                            tool,
                            command,
                            reason: 'USER_PERMISSION_DENIED'
                        }).catch(() => {});
                    }
                }
                return allowed;
            } catch (error) {
                forwardStep({
                    type: 'validation',
                    content: `子 Agent 权限请求失败: ${tool} (${error instanceof Error ? error.message : String(error)})`,
                    timestamp: Date.now(),
                });
                return false;
            }
        };
        
        // Record file snapshot
        runnerOptions.onBeforeFileWrite = (filePath, prevContent) => {
            if (!fileSnapshots.has(filePath)) {
                fileSnapshots.set(filePath, prevContent);
            }
            // Pass up to the parent UI withdrawal system
            orchestratorOptions.onBeforeFileWrite?.(filePath, prevContent);
        };

        // Pre-read and inject contextFiles
        let effectivePrompt = taskNode.prompt;
        if (taskNode.contextFiles && taskNode.contextFiles.length > 0) {
            let injectedContext = '';
            for (const contextRef of taskNode.contextFiles) {
                try {
                    // 1. Try to read from Blackboard
                    const bbValue = _blackboard.read(contextRef);
                    if (bbValue) {
                        injectedContext += `\n--- Context from Blackboard: ${contextRef} ---\n${bbValue.value}\n`;
                        continue;
                    }

                    // 2. Try to read as a physical file
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

        // Set absolute timeout: 20 minutes (1,200,000 ms)
        subAgentTimeoutId = setTimeout(() => {
            const err = new Error('Sub-Agent execution absolute timeout exceeded (20 minutes).');
            err.name = 'TimeoutError';
            subAgentController.abort(err);
        }, SUB_AGENT_ABSOLUTE_TIMEOUT_MS);  // W7 fix: actual values   consistent with comments/error messages (20 min)

        subAgentIdleIntervalId = setInterval(() => {
            if (subAgentController.signal.aborted) return;
            const now = Date.now();
            const idleMs = now - lastActivityAt;
            if (idleMs >= SUB_AGENT_IDLE_TIMEOUT_MS) {
                const err = new Error(`Sub-Agent idle timeout exceeded (${formatDurationMs(idleMs)} without progress).`);
                err.name = 'TimeoutError';
                forwardStep({
                    type: 'error',
                    content: ORCHESTRATOR_MSG.SUB_TIMEOUT(taskNode.id, formatDurationMs(idleMs)),
                    timestamp: now,
                }, false);
                subAgentController.abort(err);
                return;
            }
            if (idleMs >= SUB_AGENT_IDLE_WARNING_MS && now - lastIdleNoticeAt >= SUB_AGENT_IDLE_NOTICE_INTERVAL_MS) {
                lastIdleNoticeAt = now;
                forwardStep({
                    type: 'orchestrator_progress',
                    content: ORCHESTRATOR_MSG.SUB_IDLE(taskNode.id, formatDurationMs(idleMs)),
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
                [], // Empty conversation history - child Agent starts from scratch
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

            // When the task ends, notify the front end to update the status
            wrappedOnStep({
                type: 'subtask_complete',
                content: result.isValid ? '完成' : '未通过',
                timestamp: Date.now(),
            });

            //If execution fails, roll back the file
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
* Determine whether quality gate review needs to be triggered. 
* Condition: The task graph contains nodes of builder type. 
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
* File write rollback mechanism. 
* When the sub-Agent fails to execute, restore all modified files to their original state. 
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
                    //The file does not exist originally, indicating that it is newly created and needs to be deleted.
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        onStep({
                            type: 'thinking',
                            content: `🔄 回滚: 已删除新建的文件 ${filePath}`,
                            timestamp: Date.now(),
                        });
                    }
                } else {
                    // Restore old content (prevContent is UTF-8 raw text)
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

    // ─── Convenience factory method ───────────────────────────────────────────────────

    /** 
* Quickly create a simple pipeline task diagram. 
* 
* Example usage (Explorer → Builder → LocWriter → Reviewer): 
* ```typescript 
* const graph = Orchestrator.createPipeline('Create archaeological site', [ 
* { id: 'explore', agentType: 'explore', prompt: 'Scan project structure...' }, 
* { id: 'build', agentType: 'build', prompt: 'Create archaeological site file...' }, 
* { id: 'loc', agentType: 'loc_writer', prompt: 'Generate localization...' }, 
* { id: 'review', agentType: 'review', prompt: 'Review code quality...' }, 
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
* Create a parallel branch task graph (multiple nodes share the same pre-dependency). 
* 
* Example usage: 
* ```typescript 
* const graph = Orchestrator.createFanOut('Translation Localization', 'explore_1', [ 
* { id: 'loc_en', agentType: 'loc_writer', prompt: 'Generate English localization' }, 
* { id: 'loc_zh', agentType: 'loc_writer', prompt: 'Generate Chinese localization' }, 
* { id: 'loc_fr', agentType: 'loc_writer', prompt: 'Generate French localization' }, 
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
