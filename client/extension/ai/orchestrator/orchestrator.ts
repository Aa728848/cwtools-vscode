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
import { BLACKBOARD_KEY_PREFIXES } from './blackboardSchema';
import { ParallelExecutor, type SubAgentExecutor } from './parallelExecutor';
import { QualityGate, PDX_DIAGNOSTIC_EXTENSIONS, isPdxDiagnosticFile } from './qualityGate';
import { getAgentProfile } from './agentRegistry';
import { ErrorReporter } from '../errorReporter';
import { SOURCE, ORCHESTRATOR_MSG, aiText } from '../messages';
import { getAgentToolTargetFiles } from '../runner/toolScheduler';
import { MUTATING_TOOLS, WRITE_TOOLS } from '../tools/registry';
import { mergeTokenUsageTotals } from '../cacheCapability';
import { defaultDomainForMode } from '../agentProfile';
import { agentProfileCatalog } from '../runner/agentProfileCatalog';
import { parseAgentHandoff, repairAgentHandoff, validateAgentHandoff } from '../runner/agentHandoff';

// Type references of AgentRunner and AgentToolExecutor (to avoid circular dependencies, use import type)
import type { AgentRunner, AgentRunnerOptions } from '../agentRunner';

const SUB_AGENT_IDLE_WARNING_MS = 60 * 1000;
const SUB_AGENT_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const SUB_AGENT_IDLE_CHECK_MS = 30 * 1000;
const SUB_AGENT_IDLE_NOTICE_INTERVAL_MS = 30 * 1000;
const CLARIFICATION_PREFIX = 'BLOCKED_FOR_ORCHESTRATOR';
const LOCALISATION_GENERIC_WRITE_TOOLS = [
    'write_file',
    'edit_file',
    'replace_lines',
];

function isLocalisationYmlPath(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().replace(/\\/g, '/').toLowerCase();
    if (!normalized.endsWith('.yml')) return false;
    return /(?:^|\/)(localisation|localization)(?:\/|$)/.test(normalized);
}

function formatDurationMs(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

/** Timer-generated wait heartbeats are visibility signals, not proof that work advanced. */
function isSubAgentActivityStep(step: AgentStep): boolean {
    return step.type !== 'orchestrator_progress' && step.type !== 'error';
}

function normalizeClarificationText(text: string): string {
    return text
        .replace(/```[\w-]*\n?/g, '')
        .replace(/```/g, '')
        .trim();
}

const MAX_CLARIFICATION_OPTIONS = 4;
const MAX_CLARIFICATION_OPTION_CHARS = 200;

/**
 * Extract preset answer options from an OPTIONS: block (one `- ` or `* ` item
 * per line) that may follow the clarification text. Returns undefined when
 * fewer than two valid options are present.
 */
export function parseClarificationOptions(text: string): string[] | undefined {
    const marker = text.indexOf('OPTIONS:');
    if (marker < 0) return undefined;
    const options: string[] = [];
    for (const line of text.slice(marker + 'OPTIONS:'.length).split(/\r?\n/)) {
        const match = /^[-*]\s+(.+)$/.exec(line.trim());
        if (!match) {
            if (options.length > 0) break;
            continue;
        }
        const option = match[1]!.trim().slice(0, MAX_CLARIFICATION_OPTION_CHARS);
        if (option && !options.includes(option)) options.push(option);
        if (options.length >= MAX_CLARIFICATION_OPTIONS) break;
    }
    return options.length >= 2 ? options : undefined;
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
        options = {
            ...options,
            domain: options.domain ?? ([...taskGraph.nodes.values()].some(node =>
                ['build', 'loc_writer', 'gui_expert', 'script_reviewer'].includes(node.agentType))
                ? 'paradox'
                : 'general'),
            userExecutionPolicy: options.userExecutionPolicy ?? taskGraph.metadata.userExecutionPolicy,
        };
        const emitStep = options.onStep ?? (() => {});
        this.blackboard.setEventSink(options.runEventSink);
        this.executor.setEventSink(options.runEventSink);
        this.qualityGate.setEventSink(options.runEventSink);

        // Resumed graphs carry the previous wave's shared state.
        if (options.restoredBlackboard) {
            this.blackboard.restore(options.restoredBlackboard);
        }

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
                content: aiText('$(search) Triggering quality gate review...', '$(search) 触发质量门审查...'),
                timestamp: Date.now(),
            });
            const allWrittenFiles: string[] = [];
            for (const agentResult of result.agentResults.values()) {
                allWrittenFiles.push(
                    ...agentResult.writtenFiles,
                    ...(agentResult.handoff?.changedFiles ?? []),
                );
            }
            allWrittenFiles.splice(0, allWrittenFiles.length, ...new Set(allWrittenFiles));
            {
                const paradoxWorkflow = [...taskGraph.nodes.values()].some(node => ['build', 'loc_writer', 'gui_expert'].includes(node.agentType));
                const userOwnsLocalisation = options.userExecutionPolicy?.localisationOwnership === 'user';
                const userIgnoresWarnings = options.userExecutionPolicy?.warningHandling === 'ignore';
                if (paradoxWorkflow && (userOwnsLocalisation || userIgnoresWarnings)) {
                    emitStep({
                        type: 'orchestrator_progress',
                        content: userOwnsLocalisation
                            ? aiText(
                                '$(info) Skipped automatic localisation writing because the user retained ownership of localisation.',
                                '$(info) 用户已保留本地化处理权，已跳过自动本地化写入。',
                            )
                            : aiText(
                                '$(info) Skipped the localisation-warning sweep because the user asked to ignore non-error diagnostics.',
                                '$(info) 用户要求忽略非错误级诊断，已跳过本地化警告扫描。',
                            ),
                        timestamp: Date.now(),
                    });
                } else if (paradoxWorkflow && allWrittenFiles.some(isPdxDiagnosticFile)) {
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
                    mergeTokenUsageTotals(result.totalTokenUsage, sweepResult.tokenUsage);
                    
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
                }

                emitStep({
                    type: 'validation',
                    content: ORCHESTRATOR_MSG.QG_START(allWrittenFiles.length),
                    timestamp: Date.now(),
                });

                // Start Reviewer Agent
                let reviewResult = await this.qualityGate.reviewOutput(
                    this.agentRunner,
                    allWrittenFiles,
                    options,
                    {
                        taskGraph,
                        workspaceRoot: this.agentRunner.toolExecutor.workspaceRoot,
                        handoffs: [...result.agentResults.values()]
                            .map(agentResult => agentResult.handoff)
                            .filter((handoff): handoff is NonNullable<typeof handoff> => !!handoff),
                    },
                    result.totalTokenUsage,
                );

                if (reviewResult.passed) {
                    emitStep({ type: 'orchestrator_progress', content: ORCHESTRATOR_MSG.QG_PASS, timestamp: Date.now() });
                } else {
                    const recoveryStorm = this.executor.getRecoveryStormBudget();
                    recoveryStorm.record('reviewer_rejection', 'quality_gate_initial', reviewResult.reviewReport);
                    emitStep({ type: 'error', content: ORCHESTRATOR_MSG.QG_FAIL(reviewResult.logicIssues), timestamp: Date.now() });
                    const config = this.qualityGate.getConfig();
                    const hasRepairableIssues = reviewResult.diagnosticErrors > 0
                        || (reviewResult.evidenceConflicts ?? 0) > 0
                        || reviewResult.semanticIssues > 0
                        || reviewResult.logicIssues > 0
                        || reviewResult.acceptanceFailures.length > 0;

                    if (config.autoFix && !reviewResult.operationalFailure && hasRepairableIssues) {
                        for (let fixCycle = 0; fixCycle < config.maxFixCycles && !reviewResult.passed; fixCycle++) {
                        if (recoveryStorm.decision) {
                            options.runEventSink?.appendSoon('error', { kind: 'recovery_storm', ...recoveryStorm.decision }, { status: 'failed' });
                            emitStep({ type: 'error', content: recoveryStorm.decision.reason!, timestamp: Date.now() });
                            break;
                        }
                        emitStep({ type: 'orchestrator_progress', content: ORCHESTRATOR_MSG.AUTOFIX_START, timestamp: Date.now() });
                        
                        const fixPrompt = this.qualityGate.buildFixPrompt(
                            reviewResult.reviewReport,
                            allWrittenFiles,
                            paradoxWorkflow,
                            options.userExecutionPolicy,
                        );
                        const fixNode: TaskNode = {
                            id: `quality_gate_autofix_${fixCycle + 1}`,
                            agentType: paradoxWorkflow ? 'build' : 'utility',
                            prompt: fixPrompt,
                            plannedFiles: [...new Set(allWrittenFiles)],
                            dependencies: [],
                            priority: 'critical',
                            status: 'pending',
                            retryCount: 0,
                            maxRetries: 0,
                            // A targeted repair must not inherit the top-level 10,000-iteration allowance.
                            maxIterations: 30,
                        };
                        const fixResult = await this.executeSubAgent(
                            fixNode,
                            this.blackboard,
                            { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                            options.abortSignal ?? new AbortController().signal,
                            emitStep,
                            options,
                        );
                        mergeTokenUsageTotals(result.totalTokenUsage, fixResult.tokenUsage);
                        for (const target of fixResult.writtenFiles) {
                            if (!allWrittenFiles.includes(target)) allWrittenFiles.push(target);
                        }

                        if (fixResult.success) {
                            emitStep({ type: 'orchestrator_progress', content: ORCHESTRATOR_MSG.AUTOFIX_DONE, timestamp: Date.now() });
                            // Here you can recurse or trigger the review again, but in a simple implementation only execute autoFix once
                        } else {
                            const fixStorm = recoveryStorm.record('no_progress', fixNode.id, fixResult.error ?? fixResult.output);
                            if (fixStorm.tripped) {
                                options.runEventSink?.appendSoon('error', { kind: 'recovery_storm', ...fixStorm }, { status: 'failed' });
                            }
                            emitStep({ type: 'error', content: ORCHESTRATOR_MSG.AUTOFIX_FAIL, timestamp: Date.now() });
                        }
                        reviewResult = await this.qualityGate.reviewOutput(
                            this.agentRunner,
                            allWrittenFiles,
                            options,
                            {
                                taskGraph,
                                workspaceRoot: this.agentRunner.toolExecutor.workspaceRoot,
                            },
                            result.totalTokenUsage,
                        );
                        if (reviewResult.passed) {
                            emitStep({ type: 'orchestrator_progress', content: ORCHESTRATOR_MSG.QG_PASS, timestamp: Date.now() });
                        }
                        if (!reviewResult.passed) {
                            recoveryStorm.record('reviewer_rejection', `quality_gate_${fixCycle + 1}`, reviewResult.reviewReport);
                        }
                        }
                    }
                    if (!reviewResult.passed) {
                        result.success = false;
                        if (!result.failedNodes.includes('quality_gate')) result.failedNodes.push('quality_gate');
                        result.summary += aiText(
                            `\n- Quality gate: failed (${reviewResult.diagnosticErrors} diagnostics, ${reviewResult.evidenceConflicts ?? 0} evidence conflicts, ${reviewResult.validationPending ?? 0} pending validations, ${reviewResult.semanticIssues} semantic issues, ${reviewResult.logicIssues} review issues)`,
                            `\n- 质量门：未通过（${reviewResult.diagnosticErrors} 个诊断、${reviewResult.evidenceConflicts ?? 0} 个证据冲突、${reviewResult.validationPending ?? 0} 个待确认验证、${reviewResult.semanticIssues} 个语义问题、${reviewResult.logicIssues} 个审查问题）`,
                        );
                    }
                }
                result.qualityGate = reviewResult;
                this.blackboard.write(
                    `${BLACKBOARD_KEY_PREFIXES.qualityGate}final`,
                    JSON.stringify(reviewResult),
                    'acceptance_evidence',
                    '__quality_gate__',
                );
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

    private extractSubAgentClarification(output: string): { clarification: string; options?: string[] } | undefined {
        const text = output.trim();
        if (!text) return undefined;

        const markerIndex = text.toUpperCase().indexOf(CLARIFICATION_PREFIX);
        if (markerIndex >= 0) {
            const raw = text.slice(markerIndex + CLARIFICATION_PREFIX.length).replace(/^[:：]\s*/, '');
            return { clarification: normalizeClarificationText(raw), options: parseClarificationOptions(raw) };
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
        const childDomain = orchestratorOptions.domain ?? defaultDomainForMode(profile.mode);

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
        const userOwnsLocalisation = orchestratorOptions.userExecutionPolicy?.localisationOwnership === 'user';
        const sandbox = buildSubAgentSandbox(
            taskNode,
            workspaceRoot,
            undefined,
            userOwnsLocalisation ? ['localisation'] : undefined,
        );
        orchestratorOptions.runEventSink?.appendSoon('subagent_policy_derived', {
            agentId: taskNode.id,
            role: taskNode.agentType,
            mode: profile.mode,
            domain: childDomain,
            writeScope: sandbox.writeScope,
            rejectedScopes: sandbox.rejectedScopes,
        }, { agentId: taskNode.id });
        const plannedFiles = Array.isArray(taskNode.plannedFiles) ? taskNode.plannedFiles : [];
        const onlyLocalisationYmlWrites = plannedFiles.length > 0 && plannedFiles.every(isLocalisationYmlPath);
        const excludedTools = [
            'web_search', 'web_open', 'web_find',
            ...(profile.mode === 'utility' ? [] : ['run_command']),
            'git_ops',
            'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
            ...(onlyLocalisationYmlWrites ? LOCALISATION_GENERIC_WRITE_TOOLS : []),
            ...(userOwnsLocalisation ? ['write_localisation'] : []),
            ...(orchestratorOptions.readOnlyFanout
                ? [...MUTATING_TOOLS, 'dispatch_agents', 'merge_results']
                : []),
        ];

        const runnerOptions: AgentRunnerOptions = {
            sandbox,
            providerId,
            model,
            reasoningEffort: taskNode.reasoningEffort ?? orchestratorOptions.reasoningEffort,
            mode: profile.mode,
            // The parent already approved and decomposed this Execute task.
            // Staged writer roles start with write tools visible and never reopen
            // the main-Agent design/approval lifecycle.
            initialToolStage: profile.mode === 'build' || profile.mode === 'utility' ? 'write' : undefined,
            domain: childDomain,
            onStep,
            abortSignal, // Replaced below by the child controller with parent/idle guards.
            streaming: true, // Enable streaming output to visualize the progress of deep thinking
            topicId: orchestratorOptions.topicId,
            parentRunId: orchestratorOptions.parentRunId,
            durableGoal: orchestratorOptions.durableGoal,
            originalUserMessage: orchestratorOptions.originalUserMessage,
            agentId: taskNode.id,
            threadId: `${orchestratorOptions.parentRunId ?? orchestratorOptions.topicId ?? 'orchestrator'}/${taskNode.id}`,
            turnId: taskNode.id,
            onTodoUpdate: orchestratorOptions.onTodoUpdate,
            useSlimPrompt: true,
            maxIterations: taskNode.maxIterations ?? profile.maxIterations,
            // Role iteration limits are health-check windows. Only a task-level
            // maxIterations override remains an absolute iteration ceiling.
            renewableIterationLimit: taskNode.maxIterations === undefined,
            // The subagent skips the built-in validation loop - Orchestrator has an independent QualityGate mechanism,
            // No need for sub-agent to re-verify. At the same time, it prevents the validation loop from continuing to generate steps after the inference is completed.
            // Leading to an inconsistent UI state where the external judgment card is marked as completed but the internal one is still running.
            skipValidation: true,
            forceAutoApplyWrites: true,
            writeQueueWaitTimeoutMs: 60_000,
            // 🔴 Sub-Agent disables specific tools:
            // 1. Internet searches can easily lead to meaningless repetitive search loops (doom loops)
            // 2. Paradox children cannot use run_command; General Multi-Agent utility writers may run scoped checks through the parent policy engine.
            // git/media/deployment tools remain disabled because they are privileged or create external side effects.
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
        const wrappedOnStep = (step: AgentStep) => forwardStep(step, isSubAgentActivityStep(step));

        runnerOptions.onStep = wrappedOnStep;
        runnerOptions.onPermissionRequest = async (id, tool, description, command, permissionContext) => {
            const requestPermission = orchestratorOptions.onPermissionRequest;
            forwardStep({
                type: 'validation',
                content: requestPermission
                    ? aiText(
                        `Sub-agent waiting for user permission: ${tool}${description ? ` - ${description}` : ''}`,
                        `子 Agent 等待用户授权: ${tool}${description ? ` - ${description}` : ''}`,
                    )
                    : aiText(
                        `Sub-agent cannot request user permission: ${tool}${description ? ` - ${description}` : ''}`,
                        `子 Agent 无法请求用户授权: ${tool}${description ? ` - ${description}` : ''}`,
                    ),
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
                    content: aiText(
                        `Sub-agent permission request ${allowed ? 'approved' : 'denied'}: ${tool}`,
                        `子 Agent 权限请求${allowed ? '已批准' : '被拒绝'}: ${tool}`,
                    ),
                    timestamp: Date.now(),
                });
                if (!allowed) {
                    orchestratorOptions.runEventSink?.appendSoon('subagent_refused', {
                        agentId: taskNode.id,
                        tool,
                        command,
                        reason: 'USER_PERMISSION_DENIED'
                    }, { agentId: taskNode.id });
                }
                return allowed;
            } catch (error) {
                forwardStep({
                    type: 'validation',
                    content: aiText(
                        `Sub-agent permission request failed: ${tool} (${error instanceof Error ? error.message : String(error)})`,
                        `子 Agent 权限请求失败: ${tool} (${error instanceof Error ? error.message : String(error)})`,
                    ),
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
        if ((taskNode.produces?.length ?? 0) > 0 || (taskNode.consumes?.length ?? 0) > 0 || (taskNode.acceptanceChecks?.length ?? 0) > 0) {
            effectivePrompt = [
                '<system-entity-contract>',
                JSON.stringify({
                    produces: taskNode.produces ?? [],
                    consumes: taskNode.consumes ?? [],
                    acceptanceChecks: taskNode.acceptanceChecks ?? [],
                }, null, 2),
                'Implement only this contract. Before finishing, verify every required operation and cite its file/line in your result.',
                '</system-entity-contract>',
                '',
                effectivePrompt,
            ].join('\n');
        }
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
                            content = content.substring(0, MAX_CONTEXT_LENGTH) + aiText(
                                '\n\n... [Content was too long and has been truncated. Use the read_file tool in chunks if you need the full content.]',
                                '\n\n... [内容超长已截断。如果需要查看完整内容，请使用 read_file 工具自行分块读取]',
                            );
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

        let subAgentIdleIntervalId: NodeJS.Timeout | undefined;
        const subAgentController = new AbortController();
        const parentAbortHandler = () => subAgentController.abort(abortSignal.reason);
        if (abortSignal.aborted) {
            subAgentController.abort(abortSignal.reason);
        } else {
            abortSignal.addEventListener('abort', parentAbortHandler);
        }

        const clearSubAgentTimers = () => {
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

        // Activity renews the child indefinitely. Abort only after 20 minutes
        // without model tokens, a completed/requested tool action, permission,
        // validation, or another concrete step. Timer-only wait heartbeats do
        // not count, otherwise a hung provider/tool could renew itself forever.
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
                content: aiText(`Starting ${profile.mode} subtask`, `启动 ${profile.mode} 子任务`),
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
            const clarificationDetails = this.extractSubAgentClarification(output);
            if (clarificationDetails) {
                const clarification = clarificationDetails.clarification;
                _blackboard.write(
                    `${BLACKBOARD_KEY_PREFIXES.clarification}${taskNode.id}`,
                    clarification.slice(0, 8000),
                    'free_text',
                    taskNode.id,
                );
                wrappedOnStep({
                    type: 'validation',
                    content: aiText(
                        `Subtask needs main agent clarification: ${clarification.slice(0, 220)}${clarification.length > 220 ? '...' : ''}`,
                        `子任务需要主 Agent 澄清: ${clarification.slice(0, 220)}${clarification.length > 220 ? '...' : ''}`,
                    ),
                    timestamp: Date.now(),
                });
                await this.rollbackSnapshots(fileSnapshots, wrappedOnStep);
                wrappedOnStep({
                    type: 'subtask_complete',
                    content: aiText('Needs main agent clarification', '需要主 Agent 澄清'),
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
                    runId: result.runId,
                    needsClarification: true,
                    clarification,
                    clarificationOptions: clarificationDetails.options,
                };
            }

            // When the task ends, notify the front end to update the status
            wrappedOnStep({
                type: 'subtask_complete',
                content: result.isValid ? aiText('Complete', '完成') : aiText('Failed validation', '未通过'),
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
                    error: aiText(
                        `Subtask failed: validation failed or execution errored; rolled back ${fileSnapshots.size} file(s).${actualError ? ' Reason: ' + actualError : ''}`,
                        `子任务失败: 验证未通过或执行出错，已回滚 ${fileSnapshots.size} 个文件。${actualError ? ' 原因: ' + actualError : ''}`,
                    ),
                    tokenUsage: result.tokenUsage ?? { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: [],
                    stepCount,
                    runId: result.runId,
                };
            }

            const finalOutput = result.explanation || result.code || '';
            const summaryProfileName = taskNode.agentType === 'review' || taskNode.agentType === 'script_reviewer'
                ? 'reviewer'
                : taskNode.agentType === 'explore' || taskNode.agentType === 'general'
                    ? 'explore'
                    : childDomain === 'paradox' ? 'paradox-coder' : 'general-coder';
            const summaryPolicy = agentProfileCatalog.get(summaryProfileName)?.summaryPolicy;
            let handoff = parseAgentHandoff(finalOutput, writtenFiles);
            const missing = summaryPolicy ? validateAgentHandoff(handoff, summaryPolicy) : [];
            const totalUsage = result.tokenUsage ?? { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
            if (summaryPolicy && missing.length > 0 && summaryPolicy.retries > 0) {
                handoff = repairAgentHandoff(finalOutput, writtenFiles, missing);
            }

            return {
                nodeId: taskNode.id,
                success: result.isValid,
                output: finalOutput,
                handoff,
                tokenUsage: totalUsage,
                writtenFiles,
                stepCount,
                runId: result.runId,
            };
        } catch (e) {
            clearSubAgentGuards();

            const error = e instanceof Error ? e.message : String(e);
            wrappedOnStep({
                type: 'subtask_complete',
                content: error.includes('timeout') ? aiText('Stopped after timeout', '超时终止') : aiText('Stopped after error', '异常终止'),
                timestamp: Date.now(),
            });
            ErrorReporter.warn(SOURCE.ORCHESTRATOR, aiText(`Sub-agent ${taskNode.id} execution failed`, `子 Agent ${taskNode.id} 执行异常`), e);
            await this.rollbackSnapshots(fileSnapshots, wrappedOnStep);
            return {
                nodeId: taskNode.id,
                success: false,
                output: '',
                error: aiText(
                    `Subtask stopped after error: ${error}; rolled back ${fileSnapshots.size} file(s).`,
                    `子任务异常中止: ${error}，已回滚 ${fileSnapshots.size} 个文件。`,
                ),
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
            if ((node.agentType === 'build' || node.agentType === 'utility') && node.status === 'done') {
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
                            content: aiText(`Rollback: deleted newly created file ${filePath}`, `回滚: 已删除新建的文件 ${filePath}`),
                            timestamp: Date.now(),
                        });
                    }
                } else {
                    // Restore old content (prevContent is UTF-8 raw text)
                    fs.writeFileSync(filePath, prevContent, 'utf-8');
                    onStep({
                        type: 'thinking',
                        content: aiText(`Rollback: restored ${filePath} to its previous state`, `回滚: 已恢复文件 ${filePath} 到修改前状态`),
                        timestamp: Date.now(),
                    });
                }
            }
        } catch (e) {
            ErrorReporter.warn(SOURCE.ORCHESTRATOR, aiText('File rollback failed', '执行文件回滚时发生异常'), e);
        }
    }

    // ─── Convenience factory method ───────────────────────────────────────────────────

     /**
* Quickly create a simple pipeline task diagram.
*
* Example usage (Explorer → Builder → LocWriter → Reviewer):
* ```typescript
* const graph = Orchestrator.createPipeline('Create a typed content pipeline', [
* { id: 'explore', agentType: 'explore', prompt: 'Scan project structure...' },
* { id: 'build', agentType: 'build', prompt: 'Create the selected typed definition file...' },
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
