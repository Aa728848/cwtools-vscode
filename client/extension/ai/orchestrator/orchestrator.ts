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
    ChatMessage,
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
import { normalizeDelegationDepth } from './delegationDepth';
import { runLedger } from '../runner/runLedger';

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
        const preservedFailureResults = this.getPreservedFailureResults(result);
        const hasPreservedFailures = preservedFailureResults.length > 0;
        if (hasPreservedFailures) {
            emitStep({
                type: 'validation',
                content: aiText(
                    `Parent quality gate will repair ${preservedFailureResults.length} preserved failed subtask(s).`,
                    `父级质量门将接管修复 ${preservedFailureResults.length} 个已保留文件的失败子任务。`,
                ),
                timestamp: Date.now(),
            });
        }

        // Quality gate: review successful builder output and preserved failed writes.
        if ((result.success && this.shouldRunQualityGate(taskGraph)) || hasPreservedFailures) {
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
                const preservedFailureReport = this.formatPreservedFailureReport(preservedFailureResults);
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
                    '- Use `query_localisation_index` or an exact `grep` to check existing localisation keys.',
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
                        || reviewResult.acceptanceFailures.length > 0
                        || hasPreservedFailures;

                    if (config.autoFix && !reviewResult.operationalFailure && hasRepairableIssues) {
                        for (let fixCycle = 0; fixCycle < config.maxFixCycles && !reviewResult.passed; fixCycle++) {
                        if (recoveryStorm.decision) {
                            options.runEventSink?.appendSoon('error', { kind: 'recovery_storm', ...recoveryStorm.decision }, { status: 'failed' });
                            emitStep({ type: 'error', content: recoveryStorm.decision.reason!, timestamp: Date.now() });
                            break;
                        }
                        emitStep({ type: 'orchestrator_progress', content: ORCHESTRATOR_MSG.AUTOFIX_START, timestamp: Date.now() });
                        
                        const fixPrompt = this.qualityGate.buildFixPrompt(
                            [reviewResult.reviewReport, preservedFailureReport].filter(Boolean).join('\n\n'),
                            allWrittenFiles,
                            paradoxWorkflow,
                            options.userExecutionPolicy,
                        );
                        const fixNode: TaskNode = {
                            id: `quality_gate_autofix_${fixCycle + 1}`,
                            agentType: paradoxWorkflow ? 'build' : 'utility',
                            prompt: fixPrompt,
                            // Quality review may identify a dependent contract file that
                            // was not written by the original children. Leave this repair
                            // scope dynamic; every actual target still passes workspace,
                            // user-ownership, policy, and per-file write safety gates.
                            plannedFiles: undefined,
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
                        if (fixResult.needsClarification) {
                            // Synthetic repair children are outside the original graph,
                            // so retain their blocker explicitly or dispatch_agents would
                            // omit it and the main Agent could never route the follow-up.
                            result.agentResults.set(fixNode.id, fixResult);
                            if (!result.failedNodes.includes(fixNode.id)) result.failedNodes.push(fixNode.id);
                            // A parent decision is required before another deterministic
                            // review can prove anything new. Stop this repair wave instead
                            // of reloading/revalidating the unchanged project up to three times.
                            break;
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
                if (reviewResult.passed) {
                    this.resolvePendingValidationResults(result, emitStep);
                    if (hasPreservedFailures) {
                        this.resolvePreservedFailureResults(taskGraph, result, preservedFailureResults, emitStep);
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

    private isPendingValidationOnly(result: GenerationResult): boolean {
        const errors = result.validationErrors ?? [];
        return errors.some(error => error.code === 'VALIDATION_PENDING')
            && errors.every(error => error.code === 'VALIDATION_PENDING' || error.severity !== 'error');
    }

    private collectPreservedFiles(writtenFiles: readonly string[], snapshots: Map<string, string | null>): string[] {
        const preserved = new Set<string>();
        for (const filePath of writtenFiles) {
            preserved.add(path.resolve(filePath));
        }
        for (const [filePath, previousContent] of snapshots.entries()) {
            if (previousContent !== null || fs.existsSync(filePath)) {
                preserved.add(path.resolve(filePath));
            }
        }
        return [...preserved].sort((left, right) => left.localeCompare(right));
    }

    private getPreservedFailureResults(result: OrchestratorResult): SubAgentResult[] {
        return [...result.agentResults.values()]
            .filter(agentResult => !agentResult.success
                && agentResult.preservedAfterFailure
                && agentResult.writtenFiles.length > 0)
            .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    }

    private resolvePendingValidationResults(
        result: OrchestratorResult,
        onStep: (step: AgentStep) => void,
    ): void {
        for (const [nodeId, agentResult] of result.agentResults) {
            if (!agentResult.validationPending) continue;
            result.agentResults.set(nodeId, {
                ...agentResult,
                validationPending: undefined,
            });
            onStep({
                type: 'subtask_complete',
                agentId: nodeId,
                content: aiText('Complete after parent validation', '父级验证后完成'),
                subtaskStatus: 'completed',
                timestamp: Date.now(),
            });
        }
    }

    private formatPreservedFailureReport(results: readonly SubAgentResult[]): string {
        if (results.length === 0) return '';
        const lines = [
            '## Preserved Failed Subtasks',
            'These subtasks touched files and failed after the writes were preserved. The parent repair must inspect and fix the listed files instead of discarding them.',
        ];
        for (const result of results) {
            lines.push(`- ${result.nodeId}: ${result.writtenFiles.join(', ')}`);
            const reason = (result.error || result.output || '').trim();
            if (reason) lines.push(`  Reason: ${reason.slice(0, 1200)}`);
        }
        return lines.join('\n');
    }

    private resolvePreservedFailureResults(
        graph: TaskGraph,
        result: OrchestratorResult,
        preservedFailures: readonly SubAgentResult[],
        onStep: (step: AgentStep) => void,
    ): void {
        const repairedNodeIds = new Set(preservedFailures.map(failure => failure.nodeId));
        if (repairedNodeIds.size === 0) return;
        const note = aiText(
            `Parent quality gate repaired preserved subtask output: ${[...repairedNodeIds].join(', ')}`,
            `父级质量门已修复保留的子任务产物: ${[...repairedNodeIds].join(', ')}`,
        );

        for (const nodeId of repairedNodeIds) {
            const previous = result.agentResults.get(nodeId);
            const existingOutput = previous?.output?.trim();
            if (previous) {
                result.agentResults.set(nodeId, {
                    ...previous,
                    success: true,
                    output: existingOutput ? `${existingOutput}\n\n${note}` : note,
                    error: undefined,
                    preservedAfterFailure: undefined,
                });
            }
            this.graphEngine.markComplete(graph, nodeId, note);
            onStep({
                type: 'subtask_complete',
                agentId: nodeId,
                content: aiText('Complete after parent repair', '父级修复后完成'),
                subtaskStatus: 'completed',
                timestamp: Date.now(),
            });
        }

        result.failedNodes = result.failedNodes.filter(nodeId => !repairedNodeIds.has(nodeId));
        if (result.failedNodes.length === 0 && result.cancelledNodes.length === 0) {
            result.success = true;
        }
        result.summary += `\n- ${note}`;
        onStep({
            type: 'validation',
            content: note,
            timestamp: Date.now(),
        });
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
            agentProfileName: profile.mode === 'utility' ? 'general-coder'
                : profile.mode === 'review' || profile.mode === 'script_reviewer' ? 'reviewer'
                    : profile.mode === 'explore' || profile.mode === 'plan' ? 'explore' : 'paradox-coder',
            // The parent already approved and decomposed this Execute task.
            // Writer roles start with execution-focused guidance and never reopen
            // the main-Agent design/approval lifecycle.
            initialToolFocus: profile.mode === 'build' || profile.mode === 'utility' ? 'write' : undefined,
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
            // Children run exactly one level below this coordinator. The dispatch
            // gate reads this back to refuse a further delegation level.
            delegationDepth: normalizeDelegationDepth(orchestratorOptions.delegationDepth) + 1,
            maxIterations: taskNode.maxIterations ?? profile.maxIterations,
            // Role iteration limits are health-check windows. Only a task-level
            // maxIterations override remains an absolute iteration ceiling.
            renewableIterationLimit: taskNode.maxIterations === undefined,
            // The parent quality gate owns final cross-subtask validation.
            deferTerminalValidationToParent: true,
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

        // ─── Context-preserving resume (clarification answers) ───
        let resumedHistory: ChatMessage[] = [];
        if (taskNode.resumeAnswer && taskNode.resumeContextRef) {
            try {
                const transcript = await runLedger.readResumeTranscript(
                    taskNode.resumeContextRef,
                    orchestratorOptions.topicId,
                );
                const replayable = (transcript ?? []).filter(message => message.role !== 'system');
                if (replayable.length > 0) {
                    resumedHistory = replayable;
                    wrappedOnStep({
                        type: 'orchestrator_progress',
                        content: aiText(
                            `Resumed subtask ${taskNode.id} with its preserved context (${replayable.length} restored messages) instead of re-running it from scratch.`,
                            `已带着已保留的上下文恢复子任务 ${taskNode.id}（复原 ${replayable.length} 条消息），未从零重跑。`,
                        ),
                        timestamp: Date.now(),
                    });
                }
            } catch (error) {
                ErrorReporter.debug(
                    SOURCE.ORCHESTRATOR,
                    `Clarification resume for ${taskNode.id} fell back to a fresh run: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        const isResuming = resumedHistory.length > 0;

        // Pre-read and inject contextFiles
        let effectivePrompt = taskNode.prompt;
        if (isResuming) {
            effectivePrompt = [
                '## Parent clarification answer',
                taskNode.resumeAnswer,
                '',
                'Continue this same subtask from where you stopped. The conversation above is your own restored working context.',
                '- Do not restart the investigation, and do not repeat tool calls whose results are already present above.',
                '- Re-read a file only before you change it, or to confirm it changed since you last read it.',
                '- This answer does not widen your permission scope.',
                '- Finish with the same structured handoff (Summary, Changed Files, Verification, Unresolved).',
            ].join('\n');
        }
        if (!isResuming && ((taskNode.produces?.length ?? 0) > 0 || (taskNode.consumes?.length ?? 0) > 0 || (taskNode.acceptanceChecks?.length ?? 0) > 0)) {
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
        if (!isResuming && taskNode.contextFiles && taskNode.contextFiles.length > 0) {
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
                resumedHistory,
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
                const preservedFiles = this.collectPreservedFiles(writtenFiles, fileSnapshots);
                if (preservedFiles.length > 0) {
                    wrappedOnStep({
                        type: 'validation',
                        content: aiText(
                            `Subtask requested clarification after touching ${preservedFiles.length} file(s). Changes were preserved for parent inspection.`,
                            `子任务在触及 ${preservedFiles.length} 个文件后请求澄清。已保留改动，交由父级检查。`,
                        ),
                        timestamp: Date.now(),
                    });
                }
                wrappedOnStep({
                    type: 'subtask_complete',
                    content: aiText('Needs main agent clarification', '需要主 Agent 澄清'),
                    subtaskStatus: 'needs_clarification',
                    timestamp: Date.now(),
                });
                return {
                    nodeId: taskNode.id,
                    success: false,
                    output: clarification,
                    error: `SUB_AGENT_NEEDS_CLARIFICATION: ${clarification}`,
                    tokenUsage: result.tokenUsage ?? { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: preservedFiles,
                    stepCount,
                    runId: result.runId,
                    needsClarification: true,
                    clarification,
                    clarificationOptions: clarificationDetails.options,
                    clarificationRequests: [{
                        questionId: `clarify_${taskNode.id}`,
                        taskId: taskNode.id,
                        question: clarification,
                        category: 'requirement',
                        materiality: 'blocking',
                        ...(clarificationDetails.options?.length ? { options: clarificationDetails.options } : {}),
                        repositoryEvidence: taskNode.contextFiles?.slice(0, 8),
                        recommendedDefault: clarificationDetails.options?.[0],
                    }],
                    preservedAfterFailure: preservedFiles.length > 0,
                };
            }

            // If execution only ended with pending deterministic validation,
            // preserve completed writes for the parent quality gate instead of
            // deleting them as a failed transaction.
            if (!result.isValid || (result as any).success === false) {
                const pendingValidationOnly = this.isPendingValidationOnly(result);
                const preservedFiles = this.collectPreservedFiles(writtenFiles, fileSnapshots);
                if (pendingValidationOnly && preservedFiles.length > 0) {
                    const finalOutput = result.explanation || result.code || '';
                    const pendingNote = aiText(
                        'Subtask wrote files, but deterministic validation was still pending/stale. Changes were preserved for the parent quality gate.',
                        '子任务已写入文件，但确定性验证仍处于 pending/stale。已保留改动并交由父级质量门继续验收。',
                    );
                    wrappedOnStep({
                        type: 'validation',
                        content: pendingNote,
                        timestamp: Date.now(),
                    });
                    wrappedOnStep({
                        type: 'subtask_complete',
                        content: aiText('Pending validation', '待验证'),
                        subtaskStatus: 'pending_validation',
                        timestamp: Date.now(),
                    });
                    const handoffOutput = [finalOutput, '', pendingNote].filter(Boolean).join('\n');
                    const handoff = parseAgentHandoff(handoffOutput, preservedFiles);
                    handoff.verification = [...new Set([...handoff.verification, pendingNote])];
                    handoff.unresolved = [...new Set([
                        ...handoff.unresolved,
                        aiText(
                            'Final deterministic validation was pending when the child finished; parent quality gate must re-check these files.',
                            '子任务结束时最终确定性验证仍在等待；父级质量门必须重新检查这些文件。',
                        ),
                    ])];
                    return {
                        nodeId: taskNode.id,
                        success: true,
                        output: handoffOutput,
                        handoff,
                        tokenUsage: result.tokenUsage ?? { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                        writtenFiles: preservedFiles,
                        stepCount,
                        runId: result.runId,
                        validationPending: true,
                    };
                }
                const actualError = result.explanation || result.code || '';
                if (preservedFiles.length > 0) {
                    wrappedOnStep({
                        type: 'validation',
                        content: aiText(
                            `Subtask failed after touching ${preservedFiles.length} file(s). Changes were preserved for parent repair without reverting them.`,
                            `子任务在触及 ${preservedFiles.length} 个文件后失败。已保留改动供父级修复，而不是回滚。`,
                        ),
                        timestamp: Date.now(),
                    });
                }
                wrappedOnStep({
                    type: 'subtask_complete',
                    content: aiText('Failed validation', '未通过'),
                    subtaskStatus: 'failed',
                    timestamp: Date.now(),
                });
                return {
                    nodeId: taskNode.id,
                    success: false,
                    output: actualError,
                    error: aiText(
                        `Subtask failed: validation failed or execution errored; preserved ${preservedFiles.length} touched file(s) for parent repair.${actualError ? ' Reason: ' + actualError : ''}`,
                        `子任务失败: 验证未通过或执行出错；已保留 ${preservedFiles.length} 个被触及文件供父级修复。${actualError ? ' 原因: ' + actualError : ''}`,
                    ),
                    tokenUsage: result.tokenUsage ?? { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                    writtenFiles: preservedFiles,
                    stepCount,
                    runId: result.runId,
                    preservedAfterFailure: preservedFiles.length > 0,
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

            wrappedOnStep({
                type: 'subtask_complete',
                content: aiText('Complete', '完成'),
                subtaskStatus: 'completed',
                timestamp: Date.now(),
            });

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
            const preservedFiles = this.collectPreservedFiles(writtenFiles, fileSnapshots);
            if (preservedFiles.length > 0) {
                wrappedOnStep({
                    type: 'validation',
                    content: aiText(
                        `Subtask stopped after touching ${preservedFiles.length} file(s). Changes were preserved for parent inspection.`,
                        `子任务在触及 ${preservedFiles.length} 个文件后中止。已保留改动，交由父级检查。`,
                    ),
                    timestamp: Date.now(),
                });
            }
            wrappedOnStep({
                type: 'subtask_complete',
                content: error.includes('timeout') ? aiText('Stopped after timeout', '超时终止') : aiText('Stopped after error', '异常终止'),
                subtaskStatus: error.includes('timeout') ? 'cancelled' : 'failed',
                timestamp: Date.now(),
            });
            ErrorReporter.warn(SOURCE.ORCHESTRATOR, aiText(`Sub-agent ${taskNode.id} execution failed`, `子 Agent ${taskNode.id} 执行异常`), e);
            return {
                nodeId: taskNode.id,
                success: false,
                output: '',
                error: aiText(
                    `Subtask stopped after error: ${error}; preserved ${preservedFiles.length} touched file(s) for parent inspection.`,
                    `子任务异常中止: ${error}；已保留 ${preservedFiles.length} 个被触及文件供父级检查。`,
                ),
                tokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
                writtenFiles: preservedFiles,
                stepCount,
                preservedAfterFailure: preservedFiles.length > 0,
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
