/**
 * CWTools AI Module — Agent Runner
 *
 * Orchestrates the AI reasoning loop:
 * 1. Send user message + context + tools to AI
 * 2. If AI wants to call tools → execute tools → feed results back
 * 3. Repeat until AI produces final answer or max iterations reached
 * 4. Fold deterministic tool validation back into the same loop before finalizing
 */

import type {
    ChatMessage,
    AgentStep,
    GenerationResult,
    AgentToolName,
    AgentMode,
    ChatCompletionResponse,
    ContentPart,
    TokenUsage,
    AgentToolFocus,
    AgentRunMetrics,
    ToolDefinition,
    ReasoningEffort,
    AgentSchedulingState,
    AgentRuntimeDomain,
    ToolCall,
    ToolInvocation,
} from './types';
import { contentToString } from './types';
import { estimateTokenCount, estimateChatMessageTokens, hasImageContent, CHARS_PER_TOKEN } from './runner/tokenEstimation';
import { defaultDomainForMode } from './agentProfile';
import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// P1-7: contentToString is now imported from './types' — see import above.

import { AIService } from './aiService';
import { AgentToolExecutor, TOOL_DEFINITIONS } from './agentTools';
import { PromptBuilder, hashToolDefinitionsForFingerprint, orderMessagesForStablePrefix } from './promptBuilder';
import { getEffectiveEndpoint, getModelOutputTokens, getProvider, getProviderApiFormat, isModelVisionCapable } from './providers';
import { DEFAULT_REASONING_KEY, detectReasoningKey, reasoningValue } from './providers/reasoningKey';
import { getCurrentModelPricing, getCacheDiscountFactor } from './pricing';
import { buildProviderCallTokenUsage } from './providerCallUsage';
import { parseDsmlToolCalls as _parseDsmlToolCalls, stripDsmlMarkup as _stripDsmlMarkup, stripThinkBlocks as _stripThinkBlocks, cleanFinalContent as _cleanFinalContent } from './toolCallParser';
import { budgetToolResult as _budgetToolResult, compactToolResultForUi, getToolResultBudget } from './contextBudget';
import type { CompactMessagesOptions } from './contextBudget';
import { computeLineDiff } from './diffEngine';
import { AGENT, SOURCE, aiText } from './messages';
import { describeImagesWithMinimaxCli } from './visionAdapter';
import { ErrorReporter } from './errorReporter';
import { createBestEffortReporter } from './runner/bestEffortDiagnostics';
import { MemoryParser } from './memoryParser';
import { getProjectWorkspaceRoot, getPrivateTopicStorageDir, getPrivateTopicStorageDirCandidates, canonicalPathKey } from './workspacePaths';
import {
    filterToolDefinitionsForMode,
    initialToolFocusForMode,
    buildToolFocusReminder,
    isExecutionActionTool,
    resolveMaxToolIterations,
    resolveRunMaxOutputTokens,
    resolveContextSafeOutputTokens,
    resolveCompactionOutputReserve,
    shouldAutoDiscloseExecutionTools,
    shouldContinueAuthorizedExecution,
    finalResponseRequiresUserInput,
    isTruncationInducedStop,
    shouldRenewIterationLimit,
    SLIM_SUB_AGENT_THINKING_CHAR_LIMIT,
} from './runnerPolicy';
import { getWorkflow } from './workflowRegistry';
import { TOOL_REGISTRY, WRITE_TOOLS, READ_ONLY_TOOLS } from './tools/registry';
import { hasAddedErrors, type DiagnosticDelta } from './runner/diagnosticSnapshot';
import { buildRunCodePromptAdditions, buildRunCodePromptBlock, createRunCodeCapabilitySnapshot } from './tools/runCode';
import { globalPartitionedWriteQueue } from './runner/writeCoordinator';
import { runLedger } from './runner/runLedger';
import { atomicWriteText, sha256Text } from './runner/durableStorage';
import { loadResumeState, hasResumeState, saveResumeState as saveCheckpointResumeState } from './runner/checkpoint';
import { maybeCompactHistory as _maybeCompactHistory, MID_LOOP_COMPACTION_INTERVAL, DEFAULT_CONTEXT_LIMIT, AUTO_COMPACTION_MIN_INTERVAL_MS, COST_GATE_MIN_EVIDENCE_SAMPLES, COST_GATE_MIN_USAGE_RATIO, COST_GATE_WARM_HIT_RATIO, resolveCompactionContextLimit, resolveCompactionRatios, resolveMidLoopBlockRatio, resolveToolResultArchiveLimit, type CompactionBudgetOptions, type AutoCompactionThrottle } from './runner/compaction';
import { refreshLiveVsCodeContext } from './runner/liveContext';
import { runContextMaintenance, shouldCompactEarlyForCost } from './runner/contextMaintenance';
import { TokenCalibrationTable, buildCalibrationKey } from './runner/tokenCalibration';
import { executeFallbackRetry } from './runner/fallbackPolicy';
import { SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS, getAgentToolTargetFiles, toolScheduler } from './runner/toolScheduler';
import { buildToolInvocation } from './runner/toolInvocation';
import { DOOM_LOOP_SOFT_THRESHOLD, DOOM_LOOP_PAIR_THRESHOLD, fnv32a, normalizeToolResultHash, DoomLoopState } from './runner/doomLoopDetector';
import { OutputRepetitionDetector, type OutputRepetitionMatch } from './runner/outputRepetitionDetector';
import { ReadTracker } from './runner/readTracker';
import { TurnRunner } from './runner/turnRunner';
import type { AgentInputQueue, AgentQueuedInputKind } from './runner/inputQueue';
import type { RunEventSink } from './runner/runContext';
import { activeTurnRegistry } from './runner/activeTurnRegistry';
import { isRetryStepRequest, type RetryStepRequest, type StepRequest } from './runner/stepRequest';
import {
    normalizeSchedulingState,
    transitionSchedulingState,
} from './runner/scheduling';
import { sortToolDefinitionsForStableRequest, toolDisclosureService, type ToolDisclosureContext } from './runner/toolDisclosure';
import { createToolCallSignature, ToolDedupeService } from './runner/toolDedupe';
import { contextLimitTracker } from './runner/contextLimitTracker';
import { RecoveryCoordinator } from './runner/recoveryCoordinator';
import { runtimeFaultInjector } from './runner/faultInjection';
import { threadStore } from './runner/threadStore';
import {
    buildApprovedPlanExecutionReminder,
    isCompleteImplementationPlanWrite,
    shouldPauseForInteractivePlan,
} from './executePlanHandoff';
import { appendCacheRequestUsage, isCacheCapableUsage, supportsOpenAiStylePrefixCache } from './cacheCapability';
import { getCachedInputTokens, getCacheCreationInputTokens } from './providerUsage';
import {
    DEFAULT_GOAL_HARD_BUDGET_MULTIPLIER,
    DEFAULT_HARD_BUDGET_MULTIPLIER,
    RunBudgetTracker,
    selectHardBudgetMultiplier,
    shouldAutoExtendSubAgentBudget,
    shouldAutoExtendRunBudget,
    shouldPersistResumeSnapshot,
    shouldRetainResumeState,
    type RunBudgetEvaluation,
} from './runner/runBudget';
import { buildModelRequestMessageArchive, type ModelRequestArchiveState } from './runner/requestArtifacts';
import {
    createTerminalValidationState,
    formatTerminalValidationFeedback,
    terminalValidationOutcome,
    updateTerminalValidationState,
    type TerminalValidationState,
} from './runner/terminalValidation';

export { getAgentToolTargetFiles, SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS } from './runner/toolScheduler';
export { DOOM_LOOP_SOFT_THRESHOLD, DOOM_LOOP_PAIR_THRESHOLD, fnv32a, normalizeToolResultHash } from './runner/doomLoopDetector';
export { AgentAbortError, checkCancellation, isAbortError } from './runner/cancellation';
export { StepEmitter } from './runner/stepEmitter';
// Token estimation primitives live in runner/tokenEstimation (extracted to avoid
// runner/ modules importing this god-file). Re-exported for existing consumers.
export { estimateTokenCount, estimateChatMessageTokens, estimateChatMessagesTokens, CHARS_PER_TOKEN } from './runner/tokenEstimation';


const reportBestEffortFailure = createBestEffortReporter((message, error) => {
    ErrorReporter.debug(SOURCE.AGENT_RUNNER, message, error);
});

function toolResultRecord(result: unknown): Record<string, unknown> | undefined {
    return result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined;
}

export function isToolResultFailure(result: unknown): boolean {
    const record = toolResultRecord(result);
    if (!record) return false;
    return record.success === false || record.ok === false || record.error !== undefined;
}

export function isToolResultSuccess(result: unknown): boolean {
    if (isToolResultFailure(result)) return false;
    return toolResultRecord(result)?.skipped !== true;
}

function compactArchiveControlValue(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
    }
    if (value === null || typeof value !== 'object') return value;
    try {
        const serialized = JSON.stringify(value);
        return serialized.length <= 4_000
            ? value
            : { truncated: true, preview: serialized.slice(0, 1_000) };
    } catch {
        return { truncated: true, preview: String(value).slice(0, 1_000) };
    }
}

export function buildArchivedToolResultEnvelope(input: {
    toolName: string;
    result: unknown;
    resultSize: number;
    preview: string;
    resultRef?: string;
    resultSha256?: string;
}): Record<string, unknown> {
    const record = toolResultRecord(input.result);
    const envelope: Record<string, unknown> = {
        ok: isToolResultSuccess(input.result),
        truncated: true,
        message: input.resultRef
            ? `Tool result for ${input.toolName} was archived because it is large (${input.resultSize} chars). Use the preview and resultRef, or retry with narrower arguments if more detail is needed.`
            : `Tool result for ${input.toolName} was truncated because it is very large (${input.resultSize} chars). Retry with narrower arguments if more detail is needed.`,
        preview: input.preview,
    };
    if (input.resultRef) {
        envelope.fullResultLocalPath = input.resultRef;
        envelope.resultRef = input.resultRef;
    }
    if (input.resultSha256) envelope.resultSha256 = input.resultSha256;
    if (!record) return envelope;

    const controlKeys = [
        'success',
        'error',
        'skipped',
        'requiresRepair',
        'requiresValidation',
        'postWriteValidation',
        'postWriteValidationPassed',
        'postWriteEvidence',
        'freshness',
    ] as const;
    for (const key of controlKeys) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
            envelope[key] = compactArchiveControlValue(record[key]);
        }
    }
    if (typeof record.message === 'string') {
        envelope.toolMessage = compactArchiveControlValue(record.message);
    }
    if (Array.isArray(record.diagnostics)) {
        envelope.diagnosticSummary = {
            total: record.diagnostics.length,
            errors: record.diagnostics.filter(item => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
                const severity = (item as Record<string, unknown>).severity;
                return severity === 'error' || severity === 0;
            }).length,
        };
    }
    if (record.diagnosticDelta && typeof record.diagnosticDelta === 'object' && !Array.isArray(record.diagnosticDelta)) {
        const delta = record.diagnosticDelta as Record<string, unknown>;
        const added = Array.isArray(delta.added) ? delta.added : [];
        const removed = Array.isArray(delta.removed) ? delta.removed : [];
        envelope.diagnosticDeltaSummary = {
            comparable: delta.comparable === true,
            added: added.length,
            addedErrors: added.filter(item => !!item
                && typeof item === 'object'
                && !Array.isArray(item)
                && (item as Record<string, unknown>).severity === 'error').length,
            removed: removed.length,
        };
    }
    return envelope;
}

interface ProcessedToolResult {
    readonly modelResult: unknown;
    readonly stateResult: unknown;
}

interface NormalizedToolCall {
    invocationId: string;
    toolName: AgentToolName;
    toolArgs: Record<string, unknown>;
    toolArgsParseError?: string;
    toolCall: ToolCall;
    concurrencyClass: import('./types').ToolConcurrencyClass;
    effect: import('./types').ToolEffect;
    targetPaths: string[];
}

function normalizeToolCallBatch(input: {
    runId: string;
    toolCalls: ToolCall[];
    availableTools: ToolDefinition[];
    workspaceRoot: string;
    topicId?: string;
    previewInvocationByModelToolCallId: Map<string, string>;
    previewInvocationByToolIndex: Map<number, string>;
    globalToolCallIndex: number;
    iteration: number;
    maxToolIterations: number;
    preparedInvocations?: ReadonlyMap<ToolCall, ToolInvocation>;
    runMetrics?: AgentRunMetrics;
    abortSignal?: AbortSignal;
    emitStep: (step: AgentStep) => void;
}): { calls: NormalizedToolCall[]; globalToolCallIndex: number } {
    const calls: NormalizedToolCall[] = [];
    let globalToolCallIndex = input.globalToolCallIndex;
    for (const [toolCallPosition, toolCall] of input.toolCalls.entries()) {
        input.abortSignal?.throwIfAborted();
        const invocation = input.preparedInvocations?.get(toolCall) ?? buildToolInvocation({
            runId: input.runId,
            toolCall,
            availableTools: input.availableTools,
            workspaceRoot: input.workspaceRoot,
            topicId: input.topicId,
        });
        const invocationId = (toolCall.id && input.previewInvocationByModelToolCallId.get(toolCall.id))
            ?? input.previewInvocationByToolIndex.get(toolCallPosition)
            ?? invocation.invocationId;
        const toolName = invocation.name as AgentToolName;
        if (invocation.originalName !== invocation.name) {
            input.emitStep({
                type: 'thinking',
                content: aiText(
                    `Repaired tool name: ${invocation.originalName} -> ${invocation.name}`,
                    `修复工具名: ${invocation.originalName} -> ${invocation.name}`,
                ),
                invocationId,
                timestamp: Date.now(),
            });
            toolCall.function.name = invocation.name;
        }
        if (input.runMetrics) {
            input.runMetrics.toolCallCount++;
            input.runMetrics.toolCallsByName[toolName] = (input.runMetrics.toolCallsByName[toolName] ?? 0) + 1;
        }
        input.emitStep({
            type: 'tool_call',
            content: aiText(`Calling tool: ${toolName}`, `调用工具: ${toolName}`),
            toolName,
            toolArgs: invocation.args,
            timestamp: Date.now(),
            stepIndex: ++globalToolCallIndex,
            iterationInfo: `Iteration ${input.iteration}/${input.maxToolIterations}`,
            invocationId,
        });
        if (invocation.argRepairs.length > 0) {
            input.emitStep({
                type: 'thinking',
                content: `[Tool Arg Repair] ${invocation.argRepairs.join('; ')}`,
                invocationId,
                timestamp: Date.now(),
            });
        }
        calls.push({
            invocationId,
            toolName,
            toolArgs: invocation.args,
            toolArgsParseError: invocation.parseError,
            toolCall,
            concurrencyClass: invocation.concurrencyClass,
            effect: invocation.effect,
            targetPaths: invocation.targetPaths,
        });
    }
    return { calls, globalToolCallIndex };
}

function findSupersededWriteIndices(calls: NormalizedToolCall[]): Map<string, number> {
    const lastWriteIndexByFile = new Map<string, number>();
    for (let index = 0; index < calls.length; index++) {
        const call = calls[index]!;
        if (!SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has(call.toolName)) continue;
        for (const filePath of call.targetPaths) lastWriteIndexByFile.set(filePath, index);
    }
    return lastWriteIndexByFile;
}

function observeToolBatchRepetition(
    calls: NormalizedToolCall[],
    doomLoop: DoomLoopState,
    runMetrics?: AgentRunMetrics,
): { guardedIndices: number[]; softGuidancePending: boolean; needsHashValidation: boolean } {
    doomLoop.currentPairKey = undefined;
    const guardedIndices = calls.flatMap((call, index) =>
        TOOL_REGISTRY.get(call.toolName)?.stormExempt ? [] : [index]);
    if (guardedIndices.length === 0) {
        return { guardedIndices, softGuidancePending: false, needsHashValidation: false };
    }

    const callSignature = guardedIndices.map(index => {
        const call = calls[index]!;
        return createToolCallSignature(call.toolName, call.toolArgs, call.targetPaths);
    }).join('|');
    let softGuidancePending = false;
    let needsHashValidation = false;
    if (doomLoop.prevCallSignature) {
        const pairKey = `${doomLoop.prevCallSignature}->${callSignature}`;
        doomLoop.currentPairKey = pairKey;
        const pairFrequency = (doomLoop.pairFrequency.get(pairKey) ?? 0) + 1;
        doomLoop.pairFrequency.set(pairKey, pairFrequency);
        if (runMetrics && pairFrequency > 1) runMetrics.repeatedToolSignatureCount++;
        softGuidancePending = pairFrequency === DOOM_LOOP_SOFT_THRESHOLD;
        needsHashValidation = pairFrequency >= DOOM_LOOP_PAIR_THRESHOLD;
    }
    doomLoop.prevCallSignature = callSignature;
    return { guardedIndices, softGuidancePending, needsHashValidation };
}

function prepareModelRequest(input: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
    providerId: string;
    model: string;
    desiredOutputTokens: number;
    contextLimit: number;
    reservedTokens: number;
    calibrateEstimate: (tokens: number) => number;
    slim: boolean;
    mode: AgentMode;
}): {
    providerId: string;
    model: string;
    toolSchemaTokens: number;
    maxTokens: number;
    disableThinking: boolean;
} {
    const toolSchemaTokens = estimateTokenCount(JSON.stringify(input.tools));
    const estimatedPromptTokens = input.calibrateEstimate(
        input.messages.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0)
        + toolSchemaTokens,
    );
    return {
        providerId: input.providerId,
        model: input.model,
        toolSchemaTokens,
        maxTokens: resolveContextSafeOutputTokens({
            desiredTokens: input.desiredOutputTokens,
            contextLimit: input.contextLimit,
            promptTokens: estimatedPromptTokens,
            safetyMarginTokens: input.reservedTokens,
        }),
        disableThinking: input.slim && (input.mode === 'loc_writer' || input.mode === 'loc_translator'),
    };
}

function decideFinalResponse(input: {
    content: string;
    mode: AgentMode;
    approvedPlanExecution?: boolean;
    interactivePlanApprovalPending: boolean;
    authorization: AgentSchedulingState['authorization'];
    executionActionObserved: boolean;
    terminalValidation?: TerminalValidationState;
}): {
    finalContent: string;
    pauseForInteractivePlan: boolean;
    continuation: 'authorized_execution' | 'truncation_stop' | 'validation_failed' | 'finish';
} {
    const finalContent = _cleanFinalContent(input.content);
    const pauseForInteractivePlan = shouldPauseForInteractivePlan(finalContent, {
        mode: input.mode,
        approvedPlanExecution: input.approvedPlanExecution,
    });
    const requiresUserInput = input.interactivePlanApprovalPending
        || pauseForInteractivePlan
        || finalResponseRequiresUserInput(finalContent);
    let continuation: 'authorized_execution' | 'truncation_stop' | 'validation_failed' | 'finish' = 'finish';
    if (!requiresUserInput && shouldContinueAuthorizedExecution(
        input.mode,
        input.authorization,
        input.executionActionObserved,
    )) {
        continuation = 'authorized_execution';
    } else if (!requiresUserInput
        && input.authorization === 'workspace_write'
        && isTruncationInducedStop(finalContent)) {
        continuation = 'truncation_stop';
    } else if (!requiresUserInput
        && input.terminalValidation
        && terminalValidationOutcome(input.terminalValidation) !== 'allow') {
        continuation = 'validation_failed';
    }
    return { finalContent, pauseForInteractivePlan, continuation };
}

function foldToolBatchState(input: {
    calls: NormalizedToolCall[];
    results: unknown[];
    submittedPlanIndex: number;
    terminalValidation?: TerminalValidationState;
    completedTodoCount: number;
    diagnosticErrorsByTarget: Map<string, number>;
    blockingValidationIssues: Set<string>;
}): {
    progressDelta: number;
    completedTodoCount: number;
    interactivePlanApprovalPending: boolean;
    executionActionObserved: boolean;
} {
    let progressDelta = 0;
    let completedTodoCount = input.completedTodoCount;
    let interactivePlanApprovalPending = false;
    let executionActionObserved = false;
    for (let index = 0; index < input.calls.length; index++) {
        const result = input.results[index];
        const record = result && typeof result === 'object' && !Array.isArray(result)
            ? result as Record<string, unknown>
            : undefined;
        const diagnostics = Array.isArray(record?.diagnostics) ? record.diagnostics : [];
        const diagnosticErrorCount = diagnostics.filter(item => {
            if (!item || typeof item !== 'object') return false;
            const severity = (item as Record<string, unknown>).severity;
            return severity === 'error' || severity === 0;
        }).length;
        const diagnosticDelta = record?.diagnosticDelta && typeof record.diagnosticDelta === 'object'
            ? record.diagnosticDelta as DiagnosticDelta
            : undefined;
        const effectiveDiagnosticErrorCount = diagnosticDelta?.comparable === true
            ? diagnosticDelta.added.filter(item => item.severity === 'error').length
            : diagnosticErrorCount;
        const hasDiagnosticErrors = diagnosticDelta?.comparable === true
            ? hasAddedErrors(diagnosticDelta)
            : diagnosticErrorCount > 0;
        const call = input.calls[index]!;
        const targetKeys = call.targetPaths.length > 0 ? call.targetPaths : [`tool:${call.toolName}`];
        const resultSucceeded = isToolResultSuccess(record);
        if (resultSucceeded && index === input.submittedPlanIndex) interactivePlanApprovalPending = true;
        if (resultSucceeded && isExecutionActionTool(call.toolName)) executionActionObserved = true;
        if (input.terminalValidation) {
            updateTerminalValidationState(input.terminalValidation, targetKeys, record);
        }
        if (resultSucceeded && call.toolName === 'todo_write') {
            const todos = Array.isArray(call.toolArgs.todos) ? call.toolArgs.todos : [];
            const nextCompletedTodoCount = todos.filter(todo =>
                !!todo && typeof todo === 'object' && (todo as Record<string, unknown>).status === 'done').length;
            if (nextCompletedTodoCount > completedTodoCount) progressDelta++;
            completedTodoCount = nextCompletedTodoCount;
        }
        if (Array.isArray(record?.diagnostics)) {
            for (const targetKey of targetKeys) {
                const currentErrorCount = input.terminalValidation?.introducedErrorsByTarget.get(targetKey)?.length
                    ?? effectiveDiagnosticErrorCount;
                const previousErrorCount = input.diagnosticErrorsByTarget.get(targetKey);
                if (previousErrorCount !== undefined && currentErrorCount < previousErrorCount) progressDelta++;
                input.diagnosticErrorsByTarget.set(targetKey, currentErrorCount);
                const hasRunDiagnosticErrors = input.terminalValidation?.diagnosticErrorTargets.has(targetKey)
                    ?? hasDiagnosticErrors;
                if (hasRunDiagnosticErrors) input.blockingValidationIssues.add(targetKey);
                else if (record?.freshness === 'fresh') input.blockingValidationIssues.delete(targetKey);
            }
        }
        if (record?.requiresRepair === true) {
            for (const targetKey of targetKeys) input.blockingValidationIssues.add(targetKey);
        } else if (record?.postWriteValidationPassed === true) {
            for (const targetKey of targetKeys) {
                if (!input.terminalValidation?.diagnosticErrorTargets.has(targetKey)) {
                    input.blockingValidationIssues.delete(targetKey);
                }
            }
        }
    }
    return {
        progressDelta,
        completedTodoCount,
        interactivePlanApprovalPending,
        executionActionObserved,
    };
}
// Compact when conversation exceeds this fraction of provider context
// Default context limit if unknown
// How many recent messages to keep un-compressed during compaction
// Mid-loop compaction: check every N iterations within reasoningLoop
// Mid-loop compaction triggers at this fraction of context limit

// ─── Batch 2.3: Checkpoint mechanism ─────────────────────────────────────────
// Save a lightweight progress checkpoint every N iterations within the reasoning loop.
// On crash or context-window overflow, the agent can load the last checkpoint
// instead of starting from scratch.
const CHECKPOINT_INTERVAL = 10;
const RESUME_SNAPSHOT_INTERVAL = 10;
const RESUME_SNAPSHOT_MIN_INTERVAL_MS = 30_000;



export interface AgentRunnerOptions {
    /** Override provider for this run */
    providerId?: string;
    /** Override model for this run */
    model?: string;
    /** Override reasoning effort for external runtimes. */
    reasoningEffort?: ReasoningEffort;
    /** Dynamic maximum context tokens for this run */
    maxContextTokens?: number;
    /** Optional durable-goal aggregate token budget for the run. */
    tokenBudget?: number;
    /** True when this run belongs to an active durable goal. Selects the goal emergency ceiling. */
    durableGoal?: boolean;
    /** Host-authored evidence that the user explicitly requested durable long-running work. */
    goalCreationAuthorized?: boolean;
    /** Override the reasoning-loop iteration limit. Used by orchestrator role budgets. */
    maxIterations?: number;
    /** Treat maxIterations as a renewable healthy-progress window instead of an absolute ceiling. */
    renewableIterationLimit?: boolean;
    /** Agent mode: build (default), plan (read-only), explore (parallel read), general (research) */
    mode?: AgentMode;
    /** Main-Agent approved-plan continuation may start with write-focused guidance. */
    initialToolFocus?: AgentToolFocus;
    /** The user approved a design-complete plan; coordinators must execute it without a second design pass. */
    approvedPlanExecution?: boolean;
    /** Original top-level user turn used to preserve user-owned work across orchestration. */
    originalUserMessage?: string;
    /** Resolved capability domain. General runs cannot access Paradox-only tools or prompts. */
    domain?: import('./types').AgentRuntimeDomain;
    /** Admission and runtime phase state, persisted independently from legacy mode. */
    schedulingState?: AgentSchedulingState;
    /** Concrete catalog profile and its isolated operating instructions. */
    agentProfileName?: string;
    agentProfileInstructions?: string;
    /** Dispatch roles allowed by the selected runtime profile. Undefined preserves mode defaults. */
    agentProfileAllowedSubagents?: string[];
    /** Host-issued, bounded authority grants. They never bypass mode/domain/path guards. */
    capabilityLeases?: import('./runner/capabilityLease').CapabilityLease[];
    /** Callback for real-time step updates (for UI) */
    onStep?: (step: AgentStep) => void;
    /** Called when an external runtime has allocated a durable run id. */
    onRunStarted?: (runId: string) => void;
    /** Abort signal */
    abortSignal?: AbortSignal;
    /** Enable streaming text tokens (emits text_delta steps) */
    streaming?: boolean;
    /**
     * Permission callback for bash/run_command tool (OpenCode strategy).
     * Resolve with true=allow, false=deny.
     */
    onPermissionRequest?: (id: string, tool: string, description: string, command?: string, context?: any) => Promise<boolean>;
    /** Structured blocking clarification supplied by the active host UI. */
    onUserQuestion?: import('./types').AgentToolContext['onUserQuestion'];
    /** If provided, file mutations are written to this memory overlay instead of disk. */
    vfsOverlay?: Map<string, string>;
    /** Parent durable run when this run is a child agent/replay/fix turn. */
    parentRunId?: string;
    /** Stable agent id inside a multi-agent graph. */
    agentId?: string;
    /** Durable provider thread id for protocol-backed runtimes. */
    threadId?: string;
    /** Durable provider turn id for protocol-backed runtimes. */
    turnId?: string;
    /** Explicit event sink for this run. Avoids global latest-run routing. */
    runEventSink?: RunEventSink;
    /** Running user-steer queue drained at safe model boundaries. */
    inputQueue?: AgentInputQueue;
    /** Explicit durable run record for this turn. Avoids class-level active-run races. */
    runRecord?: import('./types').AgentRunRecord;
    /** Topic ID for checkpoint persistence — threaded from run() context */
    topicId?: string;
    /** T4.1 — replay session. When present, tool calls are served from the ledger instead of live execution. */
    replaySession?: import('./runner/runReplay').ReplaySession;
    /** T4.1 — id of the original run being replayed (recorded in ledger meta for traceability). */
    replayOf?: string;
    /** T4.1 — rebuild the system prompt this turn (clears frozen cache key so promptBuilder edits take effect). */
    rebuildSystemPrompt?: boolean;
    /** Hook called before a file is written, allowing the caller to take a snapshot for rollback */
    onBeforeFileWrite?: (filePath: string, prevContent: string | null) => void;
    /** Callback when a sub-agent creates or modifies a todo list plan */
    onTodoUpdate?: import('./types').TodoUpdateCallback;
    /** Leave terminal validation ownership to the parent orchestrator quality gate. */
    deferTerminalValidationToParent?: boolean;
    /** 
* A list of tool names to exclude from the set of available tools. 
* Used in sub-Agent scenarios: disable tools that are not suitable for independent use by sub-Agents (such as network search), 
* Prevent child Agents from falling into meaningless search loops. 
*/
    excludeTools?: string[];
    /** Sub-Agent sandboxing scope configuration (Phase 5) */
    sandbox?: import('./orchestrator/subAgentSandbox').SubAgentSandbox;
    /** Force file-mutating tools to bypass interactive diff confirmation. Used by orchestrator sub-agents. */
    forceAutoApplyWrites?: boolean;
    /** Max time a write tool may wait for another file lock before returning a structured error. */
    writeQueueWaitTimeoutMs?: number;
    /** 
* Use condensed system prompt words for Orchestrator sub-agents. 
* The sub-Agent should not directly ask questions to the user or wait for user approval, but should report the blocking points to the main Agent. 
*/
    useSlimPrompt?: boolean;
    /**
     * Delegation depth of this run: 0 for a top-level agent, parent depth + 1
     * for a dispatched sub-agent. Read by the dispatch gate to decide whether
     * this agent may open another delegation level; see
     * `orchestrator/delegationDepth.ts` for the monotone accounting.
     */
    delegationDepth?: number;
    /** 
* Whether to restore the state from the last breakpoint snapshot that exited abnormally (breakpoint resume) 
*/
    resumeFromState?: boolean;
    /**
     * If set, the agent run is executing within a specific workflow.
     * The runner will apply the workflow's tool policy and prompt supplement.
     */
    workflowId?: string;
}

function filterWebToolsForConfiguredAccess(tools: ToolDefinition[]): ToolDefinition[] {
    const mode = vs.workspace.getConfiguration('stellarisLanguageServices.ai.web')
        .get<'disabled' | 'indexed' | 'live'>('mode', 'indexed');
    if (mode === 'live') return tools;
    const unavailable = mode === 'disabled'
        ? new Set(['web_search', 'web_open', 'web_find'])
        : new Set(['web_open', 'web_find']);
    return tools.filter(tool => !unavailable.has(tool.function.name));
}

export class AgentRunner {
    public readonly readTracker = new ReadTracker();
    private writeQueue = globalPartitionedWriteQueue;
    private activeRunRecordPromise?: Promise<import('./types').AgentRunRecord>;
    private readonly turnRunner = new TurnRunner();
    private readonly activeInputQueues = new Map<string, AgentInputQueue>();
    private readonly activeRunEventSinks = new Map<string, RunEventSink>();
    /** Runs whose normal-looking return is actually a resumable budget/loop pause. */
    private readonly retainedResumeRuns = new Set<string>();
    constructor(
        private aiService: AIService,
        public readonly toolExecutor: AgentToolExecutor,
        private promptBuilder: PromptBuilder,
        private tokenCalibration?: TokenCalibrationTable,
    ) {
        this.toolExecutor.parentAgentRunner = this;
    }

    /** Response-side calibration key: fallback samples never hit the primary key. */
    private calibrationKeyFor(providerId: string, model: string | undefined): string {
        const config = this.aiService.getConfig();
        const effectiveModel = model ?? getProvider(providerId).defaultModel;
        return buildCalibrationKey(
            providerId,
            effectiveModel,
            getProviderApiFormat(providerId, effectiveModel, config.customApiFormat),
            getEffectiveEndpoint(providerId, this.aiService.getEndpointForProvider(providerId)),
        );
    }

    private calibrateContextEstimate(providerId: string, model: string | undefined, estimate: number): number {
        return this.tokenCalibration?.apply(this.calibrationKeyFor(providerId, model), estimate) ?? estimate;
    }

    /** Per-runner throttle state for automatic (non-forced) compaction. */
    private readonly autoCompactionThrottle: AutoCompactionThrottle = {
        lastAutoCompactionAt: 0,
        minIntervalMs: AUTO_COMPACTION_MIN_INTERVAL_MS,
    };
    private static readonly CACHE_EVIDENCE_KEY_LIMIT = 32;
    private readonly cacheEvidence = new Map<string, { input: number; cached: number; samples: number }>();

    private cacheHitRatio(providerId: string, model: string | undefined): number | undefined {
        const evidence = this.cacheEvidence.get(this.calibrationKeyFor(providerId, model));
        return evidence && evidence.samples >= COST_GATE_MIN_EVIDENCE_SAMPLES && evidence.input > 0
            ? Math.min(1, evidence.cached / evidence.input)
            : undefined;
    }

    private recordCacheEvidence(providerId: string, model: string | undefined, input: number, cached: number): void {
        const config = this.aiService.getConfig();
        if (!isCacheCapableUsage(
            providerId, cached, config.customApiFormat, model, this.aiService.getEndpointForProvider(providerId),
        ) || input <= 0) return;
        const key = this.calibrationKeyFor(providerId, model);
        const previous = this.cacheEvidence.get(key) ?? { input: 0, cached: 0, samples: 0 };
        this.cacheEvidence.delete(key);
        this.cacheEvidence.set(key, {
            input: previous.input + input,
            cached: previous.cached + Math.min(input, Math.max(0, cached)),
            samples: previous.samples + 1,
        });
        while (this.cacheEvidence.size > AgentRunner.CACHE_EVIDENCE_KEY_LIMIT) {
            const oldest = this.cacheEvidence.keys().next().value;
            if (oldest === undefined) break;
            this.cacheEvidence.delete(oldest);
        }
    }

    public clearPromptCache(): void {
        this.promptBuilder.clearFrozenPromptCache();
    }

    public getActiveRunRecordPromise(): Promise<import('./types').AgentRunRecord> | undefined {
        return this.activeRunRecordPromise;
    }

    public submitInput(
        runId: string,
        message: string,
        clientUserMessageId?: string,
        images?: string[],
        kind: AgentQueuedInputKind = 'steer',
        operationId?: string,
    ): boolean {
        const queue = this.activeInputQueues.get(runId);
        if (!queue) return false;
        const item = queue.enqueue(message, clientUserMessageId, images, kind, operationId);
        this.activeRunEventSinks.get(runId)?.appendSoon('input_queued', {
            inputId: item.id,
            clientUserMessageId,
            size: message.length,
            imageCount: images?.length ?? 0,
            preview: message.slice(0, 240),
            kind,
            operationId,
        }, { status: 'pending' });
        this.activeRunEventSinks.get(runId)?.appendSoon('prompt_queued', {
            promptId: item.id,
            kind,
            operationId,
            clientUserMessageId,
        }, { status: 'pending' });
        if (kind === 'steer') {
            this.activeRunEventSinks.get(runId)?.appendSoon('prompt_steered', {
                promptId: item.id,
                activePromptId: runId,
            }, { status: 'pending' });
        }
        return true;
    }

    // ─── Batch 2.3: Checkpoint save/load ─────────────────────────────────────

    /**
     * Save a lightweight checkpoint of agent progress for crash recovery.
     * Called every CHECKPOINT_INTERVAL iterations in the reasoning loop.
     */
    private async saveCheckpoint(
        iteration: number,
        messages: ChatMessage[],
        writtenFiles: string[],
        topicId?: string,
        agentId?: string,
    ): Promise<void> {
        try {
            const wsRoot = getProjectWorkspaceRoot();

            const checkpointDir = getPrivateTopicStorageDir(topicId || 'default', wsRoot);
            if (!checkpointDir) return;
            if (!fs.existsSync(checkpointDir)) fs.mkdirSync(checkpointDir, { recursive: true });

            const checkpoint: import('./types').AgentCheckpoint = {
                version: 1,
                timestamp: Date.now(),
                iteration,
                writtenFiles,
                conversationSummary: messages
                    .filter(m => m.role === 'assistant')
                    .slice(-3)
                    .map(m => contentToString(m.content).substring(0, 500))
                    .join('\n---\n'),
                todoSnapshot: JSON.stringify(this.toolExecutor.getTodos(agentId)),
                topicId,
            };

            fs.writeFileSync(
                path.join(checkpointDir, 'checkpoint.json'),
                JSON.stringify(checkpoint, null, 2),
                'utf-8'
            );
        } catch (error) {
            reportBestEffortFailure('checkpoint.save', {
                topicId: topicId || 'default',
                agentId,
                iteration,
            }, error);
        }
    }

    /**
     * Load a previously saved checkpoint for UI display purposes.
     * Returns null if no checkpoint exists or it is invalid.
     * Note: this does NOT restore agent state — checkpoints are lossy
     * (only 3 recent assistant message summaries, 500 chars each).
     */
    async loadCheckpoint(topicId: string): Promise<import('./types').AgentCheckpoint | null> {
        try {
            const wsRoot = getProjectWorkspaceRoot();

            const checkpointPath = getPrivateTopicStorageDirCandidates(topicId, wsRoot)
                .map(dir => path.join(dir, 'checkpoint.json'))
                .find(candidate => fs.existsSync(candidate));
            if (!checkpointPath) return null;

            const raw = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
            if (!raw || raw.version !== 1 || typeof raw.timestamp !== 'number') return null;

            return raw as import('./types').AgentCheckpoint;
        } catch {
            return null;
        }
    }

    /** 
* Save the complete status of the current Agent (for use in resumed downloads). 
* Unlike Checkpoint, this will save the complete message queue and tool return results, 
* Ability to resume and continue the last context after timeout or cancellation. 
*/
    private async saveResumeState(
        topicId: string,
        messages: ChatMessage[],
        mode: AgentMode,
        domain: import('./types').AgentRuntimeDomain,
        runId?: string,
        pendingToolCalls?: ToolCall[],
        schedulingState?: AgentSchedulingState,
    ): Promise<void> {
        await saveCheckpointResumeState(topicId, mode, messages, this.toolExecutor, runId, pendingToolCalls, domain, schedulingState);
    }

    /** 
* Read the resumable download status under the specified topicId. 
*/
    /** Checkpoint proxy */
    public async loadResumeState(topicId: string): Promise<import('./types').AgentResumeState | null> {
        return loadResumeState(topicId);
    }

    /** 
* Determine whether there is a breakpoint resume state. 
*/
    /** Checkpoint proxy */
    public async hasResumeState(topicId: string): Promise<boolean> {
        return hasResumeState(topicId);
    }

    /** 
* Clean up the resumption status (when a new task starts). 
*/
    public async clearResumeState(topicId: string): Promise<void> {
        if (!topicId) return;
        try {
            const wsRoot = getProjectWorkspaceRoot();
            for (const resumeDir of getPrivateTopicStorageDirCandidates(topicId, wsRoot)) {
                const resumePath = path.join(resumeDir, 'resume_state.json');
                if (fs.existsSync(resumePath)) {
                    fs.unlinkSync(resumePath);
                }
            }
        } catch (error) {
            reportBestEffortFailure('resume.clear', { topicId }, error);
        }
    }

    /**
     * One run_code step through the same gates as a direct model tool call:
     * the model-visible catalog decides the allowlist (domain isolation),
     * writes take the partitioned per-file queue, and execution goes through
     * the authoritative executor (policy, plan guard, git guard). The
     * guest signal replaces the run-level signal for this nested call so a
     * timed-out program aborts in-flight work instead of leaking it.
     */
    private async runNestedToolStep(
        toolName: string,
        args: Record<string, unknown>,
        context: import('./types').AgentToolContext,
        onFileWrite: ((filePath: string, previousContent: string | null) => void) | undefined,
        modelVisibleTools: readonly import('./types').ToolDefinition[],
        signal?: AbortSignal,
        writeQueueWaitTimeoutMs?: number,
    ): Promise<unknown> {
        if (!createRunCodeCapabilitySnapshot(modelVisibleTools).names.has(toolName)) {
            return {
                success: false,
                stepBlocked: true,
                error: `Tool '${toolName}' is not available to run_code in the current mode, domain, or disclosed toolset.`,
            };
        }
        const registryEntry = TOOL_REGISTRY.get(toolName as AgentToolName);
        if (!registryEntry) {
            return { success: false, stepBlocked: true, error: `Tool '${toolName}' is not registered.` };
        }
        const nestedContext: import('./types').AgentToolContext = signal
            ? {
                ...context,
                runnerOptions: {
                    ...(context.runnerOptions ?? {}),
                    abortSignal: signal,
                } as import('./types').AgentToolContext['runnerOptions'],
            }
            : context;
        const workspaceRoot = this.toolExecutor.workspaceRoot;
        const filePaths = getAgentToolTargetFiles(toolName, args, workspaceRoot, nestedContext?.runnerOptions?.topicId);
        const primaryFilePath = filePaths[0] ?? '';
        const executeWithScheduler = async (): Promise<unknown> => {
            const releaseScheduler = await toolScheduler.acquireLock(registryEntry.concurrencyClass, signal);
            try {
                return await this.executeToolPipeline(toolName, args, nestedContext);
            } finally {
                releaseScheduler();
            }
        };
        if (WRITE_TOOLS.has(toolName)) {
            if (onFileWrite && primaryFilePath) {
                const prev = fs.existsSync(primaryFilePath) ? fs.readFileSync(primaryFilePath, 'utf8') : null;
                onFileWrite(primaryFilePath, prev);
            }
            const lockPaths = (filePaths.length > 0 ? filePaths : ['__global__'])
                .map(p => p === '__global__' ? p : canonicalPathKey(p, workspaceRoot));
            // Match direct calls: write queue first, then scheduler. Reversing
            // that order can deadlock nested and sibling direct writes.
            return await this.writeQueue.enqueue(
                lockPaths,
                executeWithScheduler,
                {
                    waitTimeoutMs: writeQueueWaitTimeoutMs,
                    timeoutMessage: 'run_code call timed out waiting for the file write queue.',
                },
            );
        }
        return await executeWithScheduler();
    }

    private async executeToolPipeline(
        toolName: string,
        args: Record<string, unknown>,
        context?: import('./types').AgentToolContext,
    ): Promise<unknown> {
        runtimeFaultInjector.setEnabled(vs.workspace
            .getConfiguration('stellarisLanguageServices.ai.developer')
            .get<boolean>('faultInjection', false));
        await runtimeFaultInjector.hit('before_tool', context?.runnerOptions?.abortSignal);
        context?.runnerOptions?.abortSignal?.throwIfAborted();
        const result = await this.toolExecutor.execute(toolName, args, context);
        await runtimeFaultInjector.hit('after_tool', context?.runnerOptions?.abortSignal);
        return result;
    }

    /**
     * Attempt to retry a failed API call with a fallback provider/model.
     * Returns the response on success, or null if no fallback is available or all fail.
     */
    private async tryFallbackProvider(
        messages: ChatMessage[],
        originalProviderId: string,
        options?: { tools?: import('./types').ToolDefinition[]; model?: string; onAttempt?: () => void },
        emitStep?: (step: AgentStep) => void
    ): Promise<ChatCompletionResponse | null> {
        return executeFallbackRetry(this.aiService, messages, originalProviderId, options, emitStep);
    }

    /** Account for paid runner-side calls outside the main reasoning request. */
    private accumulateAuxiliaryUsage(
        response: ChatCompletionResponse,
        messages: ChatMessage[],
        accumulator: TokenUsage | undefined,
        providerId: string | undefined,
        requestedModel: string | undefined,
        metadata: {
            toolFocus?: AgentToolFocus;
            purpose: 'validation' | 'final_summary';
            promptFingerprint?: string;
        },
    ): void {
        if (!accumulator) return;
        const promptTokens = response.usage?.prompt_tokens
            ?? messages.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0);
        const completionText = response.choices[0]?.message
            ? contentToString(response.choices[0].message.content)
            : '';
        const completionTokens = response.usage?.completion_tokens ?? estimateTokenCount(completionText);
        const totalTokens = response.usage?.total_tokens ?? promptTokens + completionTokens;
        const effectiveProvider = (response as { __providerId?: string }).__providerId
            ?? providerId
            ?? this.aiService.getConfig().provider;
        const effectiveModel = response.model ?? requestedModel ?? '';
        const pricing = getCurrentModelPricing(effectiveModel, effectiveProvider);
        const cachedTokens = getCachedInputTokens(response.usage);
        const uncachedInputTokens = Math.max(0, promptTokens - cachedTokens);
        const cacheDiscount = getCacheDiscountFactor(effectiveModel, effectiveProvider);
        const cachedCost = (cachedTokens / 1_000_000) * pricing[0] * cacheDiscount;
        const uncachedCost = (uncachedInputTokens / 1_000_000) * pricing[0];
        const outputCost = (completionTokens / 1_000_000) * pricing[1];

        accumulator.input += promptTokens;
        accumulator.output += completionTokens;
        accumulator.total += totalTokens;
        accumulator.estimatedCostCny += cachedCost + uncachedCost + outputCost;
        accumulator.cachedTokens = (accumulator.cachedTokens ?? 0) + cachedTokens;
        accumulator.netInput = (accumulator.netInput ?? 0) + uncachedInputTokens;
        accumulator.netTotal = (accumulator.netTotal ?? 0) + uncachedInputTokens + completionTokens;
        accumulator.cacheSavedCostCny = (accumulator.cacheSavedCostCny ?? 0)
            + (cachedTokens / 1_000_000) * pricing[0] * (1 - cacheDiscount);
        this.appendProviderCacheSample(accumulator, {
            provider: effectiveProvider,
            model: effectiveModel,
            inputTokens: promptTokens,
            cachedTokens,
            toolFocus: metadata.toolFocus,
            purpose: metadata.purpose,
            promptFingerprint: metadata.promptFingerprint,
        });
    }

    private appendProviderCacheSample(
        accumulator: TokenUsage | undefined,
        sample: {
            provider: string;
            model: string;
            inputTokens: number;
            cachedTokens: number;
            toolFocus?: AgentToolFocus;
            purpose: 'reasoning' | 'fallback' | 'validation' | 'final_summary';
            promptFingerprint?: string;
            invalidationReason?: string;
        },
    ): void {
        if (!accumulator) return;
        const config = this.aiService.getConfig();
        const customFormat = sample.provider === config.provider ? config.customApiFormat : undefined;
        const cacheCapable = isCacheCapableUsage(
            sample.provider, sample.cachedTokens, customFormat, sample.model,
            this.aiService.getEndpointForProvider(sample.provider),
        );
        const previousComparable = [...(accumulator.cacheRequests ?? [])]
            .reverse()
            .find(request => request.purpose === sample.purpose);
        let invalidationReason = sample.invalidationReason;
        if (sample.cachedTokens > 0 || !cacheCapable) {
            invalidationReason = undefined;
        } else if (!invalidationReason && previousComparable?.toolFocus !== sample.toolFocus) {
            invalidationReason = 'toolset_changed';
        } else if (!invalidationReason && !sample.promptFingerprint) {
            invalidationReason = 'fingerprint_missing';
        } else if (!invalidationReason) {
            invalidationReason = 'provider_miss';
        }
        appendCacheRequestUsage(accumulator, {
            ...sample,
            cacheCapable,
            agentMode: accumulator.agentMode,
            invalidationReason,
        });
    }

    /**
     * Run the full agent loop for a user request.
     * Returns the final generation result with code, explanation, and validation status.
     */
    async run(
        userMessage: string,
        context: {
            activeFile?: string;
            cursorLine?: number;
            cursorColumn?: number;
            selectedText?: string;
            fileContent?: string;
            topicId?: string;
        },
        conversationHistory: ChatMessage[],
        options?: AgentRunnerOptions,
        /** Base64 data-URL images to attach to this user turn (vision/multimodal) */
        images?: string[]
    ): Promise<GenerationResult> {
        const steps: AgentStep[] = [];
        const parentAbortSignal = options?.abortSignal;
        const turnAbortController = new AbortController();
        const forwardParentAbort = () => turnAbortController.abort(parentAbortSignal?.reason);
        if (parentAbortSignal?.aborted) {
            forwardParentAbort();
        } else {
            parentAbortSignal?.addEventListener('abort', forwardParentAbort, { once: true });
        }

        // Resources owned by this run (abort listener, active-turn registry entry,
        // active event-sink/input-queue maps, run record) are registered before the
        // main try block, so an exception in resume loading, turn admission, vision
        // processing, or prompt assembly must still reach the cleanup below. The
        // `''` runId sentinel keeps type narrowing simple; cleanup skips it.
        let runId = '';
        let runRecordPromise: Promise<import('./types').AgentRunRecord> | undefined;
        let unregisterActiveTurn: (() => void) | undefined;
        try {
        const restoredResumeState = options?.resumeFromState && context.topicId
            ? await this.loadResumeState(context.topicId)
            : null;
        let mode = restoredResumeState?.mode ?? options?.mode ?? 'build';
        let domain = restoredResumeState?.domain ?? options?.domain ?? defaultDomainForMode(mode);
        let schedulingState = normalizeSchedulingState(
            restoredResumeState?.schedulingState ?? options?.schedulingState,
            mode,
            domain,
        );
        const topicId = context.topicId || 'default';
        const threadId = options?.threadId ?? topicId;
        const turnId = options?.turnId ?? `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        options = {
            ...options,
            mode,
            domain,
            schedulingState,
            abortSignal: turnAbortController.signal,
            threadId,
            turnId,
            originalUserMessage: options?.originalUserMessage ?? userMessage,
        };
        const userPromptPreview = userMessage.substring(0, 100);
        const turnRuntimePromise = this.turnRunner.startTurn({
            topicId,
            mode,
            userPrompt: userMessage,
            userPromptPreview,
            parentRunId: options?.parentRunId,
            agentId: options?.agentId,
            providerId: options?.providerId,
            model: options?.model,
            workflowId: options?.workflowId,
            threadId,
            turnId,
            schedulingState,
        });
        runRecordPromise = turnRuntimePromise.then(runtime => runtime.run);
        this.activeRunRecordPromise = runRecordPromise;

        const emitStep = (step: AgentStep) => {
            steps.push(step);
            options?.onStep?.(step);
            // runRecordPromise is assigned just before this closure is defined.
            runRecordPromise!.then(r => {
                runLedger.appendEvent(r.runId, 'step_appended', { step }).catch(error => {
                    reportBestEffortFailure('ledger.append_step', { runId: r.runId, stepType: step.type }, error);
                });
            }).catch(error => {
                reportBestEffortFailure('run_record.resolve', { topicId, threadId }, error);
            });
        };
        const updateRunStatus = (status: import('./types').AgentRunStatus) => {
            runRecordPromise!.then(async r => {
                const currentSchedulingState = options?.schedulingState;
                if (status === 'completed' && currentSchedulingState && currentSchedulingState.phase !== 'finalize') {
                    const previousPhase = currentSchedulingState.phase;
                    const finalized = transitionSchedulingState(currentSchedulingState, {
                        phase: 'finalize',
                        reason: 'run completed',
                    });
                    if (options) options.schedulingState = finalized;
                    schedulingState = finalized;
                    await runLedger.appendEvent(r.runId, 'phase_changed', {
                        from: previousPhase,
                        to: finalized.phase,
                        reason: finalized.phaseReason,
                        revision: finalized.revision,
                    });
                }
                await runLedger.appendEvent(r.runId, 'status_changed', { status });
                if (status === 'completed' || status === 'failed' || status === 'paused') {
                    runMetrics.modelCalls = tokenAccumulator.apiCalls ?? 0;
                    runMetrics.compactionCalls = tokenAccumulator.compactionCalls ?? 0;
                    runMetrics.fallbackCalls = tokenAccumulator.fallbackCalls ?? 0;
                    runMetrics.uncachedInputTokens = tokenAccumulator.netInput ?? 0;
                    threadStore.markStatus(
                        topicId,
                        threadId,
                        status === 'completed' ? 'completed' : status === 'paused' ? 'interrupted' : 'failed',
                    ).catch(error => {
                        reportBestEffortFailure('thread.mark_status', { topicId, threadId, status }, error);
                    });
                    await runLedger.appendEvent(r.runId, 'metrics_updated', {
                        metrics: {
                            totalTokens: tokenAccumulator.total,
                            promptTokens: tokenAccumulator.input,
                            completionTokens: tokenAccumulator.output,
                            cachedTokens: tokenAccumulator.cachedTokens || 0,
                            costCny: tokenAccumulator.estimatedCostCny,
                            iterations: runMetrics.iterations,
                            modelCalls: runMetrics.modelCalls,
                            compactionCalls: runMetrics.compactionCalls,
                            fallbackCalls: runMetrics.fallbackCalls,
                            uncachedInputTokens: runMetrics.uncachedInputTokens,
                            toolCalls: runMetrics.toolCallCount
                        }
                    });
                }
            }).catch(error => {
                reportBestEffortFailure('run_status.persist', { topicId, threadId, status }, error);
            });
        };

        // Accumulate token usage across all API calls in this generation
        // (declared here so compaction call and sub-agent dispatch can also contribute to the total)
        // Widened with cache-observability fields (plan sec.7.3); they ride
        // GenerationResult.tokenUsage into UsageTracker.addUsage without chatPanel changes.
        const tokenAccumulator: TokenUsage = {
            total: 0,
            input: 0,
            output: 0,
            estimatedCostCny: 0,
            agentMode: mode,
            toolFocus: options?.initialToolFocus ?? initialToolFocusForMode(mode),
        };
        const runMetrics: AgentRunMetrics = {
            iterations: 0,
            modelCalls: 0,
            compactionCalls: 0,
            fallbackCalls: 0,
            uncachedInputTokens: 0,
            maxIterations: 0,
            toolCallCount: 0,
            toolCallsByName: {},
            repeatedToolSignatureCount: 0,
            maxToolResultChars: 0,
            finalPromptTokens: 0,
        };
        const shouldKeepResumeState = () => shouldRetainResumeState(this.retainedResumeRuns.has(runId), steps);
        const clearResumeStateIfComplete = async () => {
            const keep = shouldKeepResumeState();
            this.retainedResumeRuns.delete(runId);
            if (context.topicId && !keep) {
                await this.clearResumeState(context.topicId);
            }
        };

        // Context object to be passed to tool executor (replaces old global assignment)
        const _agentToolContext: import('./types').AgentToolContext = {
            runnerOptions: options,
            agentRunner: this,
            runEventSink: options?.runEventSink,
            tokenAccumulator: tokenAccumulator,
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
            onUserQuestion: options?.onUserQuestion,
            onBeforeFileWrite: options?.onBeforeFileWrite,
            onTodoUpdate: options?.onTodoUpdate
        };

        // Vision capability check: if the active provider doesn't support image input,
        // silently drop image attachments and emit a warning so the user knows.
        const _cfgVision = this.aiService.getConfig();
        const _providerIdVision = options?.providerId ?? _cfgVision.provider;
        const _providerVision = getProvider(_providerIdVision);
        const modelVision = _cfgVision.model || _providerVision.defaultModel;
        const visionSupported = _providerVision.supportsVision && isModelVisionCapable(modelVision);

        let effectiveUserMessage = userMessage;
        let effectiveImages = images && images.length > 0 ? images : undefined;
        if (effectiveImages && !visionSupported) {
            let minimaxCliUsed = false;
            if (_providerIdVision.startsWith('minimax')) {
                const visionResult = await describeImagesWithMinimaxCli({
                    images: effectiveImages,
                    signal: turnAbortController.signal,
                    onStep: emitStep,
                });
                if (visionResult && visionResult.describedCount > 0) {
                    effectiveUserMessage += visionResult.visionText;
                    minimaxCliUsed = true;
                    effectiveImages = undefined;
                }
            }

            if (!minimaxCliUsed) {
                // Vision not supported: emit UI warning and inject notice for the AI
                emitStep({
                    type: 'error',
                    content: AGENT.VISION_UNSUPPORTED(_providerVision.name) +
                        (_providerIdVision === 'minimax-token-plan'
                            ? AGENT.VISION_MINIMAX_HINT
                            : AGENT.VISION_GENERIC_HINT),
                    timestamp: Date.now(),
                });
                effectiveUserMessage += `\n\n[System Notice: The user uploaded image(s), but your current AI model (${_providerVision.name}) does not support native image processing. Please inform the user that their image cannot be analyzed with the current provider, and suggest switching to a vision-capable provider (e.g., Claude, Gemini, GPT-4o). Do NOT attempt to guess or hallucinate image content — the images are not available to you.]`;
                effectiveImages = undefined; // drop native images, proceed text-only
            }
        }

        // Build the user turn: multimodal ContentPart[] when images are provided,
        // otherwise a plain string (keeps token overhead minimal for text-only turns)
        const userContent: string | ContentPart[] =
            effectiveImages && effectiveImages.length > 0
                ? [
                    { type: 'text' as const, text: effectiveUserMessage },
                    ...effectiveImages.map(url => ({
                        type: 'image_url' as const,
                        image_url: { url, detail: 'auto' as const },
                    })),
                  ]
                : effectiveUserMessage;

        const turnRuntime = await turnRuntimePromise;
        const runRecord = turnRuntime.run;
        runId = runRecord.runId;
        if (mode === 'script' || mode === 'orchestrator') {
            this.toolExecutor.clearOrchestratorValidation(runId);
        }
        options = {
            ...options,
            topicId,
            mode,
            runEventSink: turnRuntime.eventSink,
            inputQueue: turnRuntime.inputQueue,
            runRecord: turnRuntime.run,
            schedulingState,
        };
        await turnRuntime.eventSink.append('admission_decided', {
            profileName: schedulingState.profileName ?? options.agentProfileName,
            overlays: schedulingState.overlays ?? [],
            domainProfile: schedulingState.domainProfile,
            authorization: schedulingState.authorization,
            initialPhase: schedulingState.phase,
            explicitDelegation: schedulingState.dispatch !== 'single',
            confidence: schedulingState.routeConfidence,
            evidence: schedulingState.routeEvidence,
        });
        await turnRuntime.eventSink.append('phase_changed', {
            from: null,
            to: schedulingState.phase,
            reason: schedulingState.phaseReason,
            revision: schedulingState.revision,
        });
        this.activeRunEventSinks.set(runId, turnRuntime.eventSink);
        this.activeInputQueues.set(runId, turnRuntime.inputQueue);
        unregisterActiveTurn = activeTurnRegistry.register({
            runId,
            threadId: options.threadId,
            turnId: options.turnId,
            runner: this,
            abortController: turnAbortController,
            eventSink: turnRuntime.eventSink,
        });
        // topicId is already declared in function scope

        // 收集 Pinned Context 实时数据 (Todos & Diagnostics)
        let pinnedData: any = undefined;
        if (topicId) {
            const todos = this.toolExecutor.getExternalToolHandler().getTodos(options.agentId);
            const diagnostics: Array<{ file: string; message: string; line: number }> = [];
            try {
                const vsDiags = vs.languages.getDiagnostics();
                for (const [uri, diags] of vsDiags) {
                    const rel = path.relative(getProjectWorkspaceRoot(), uri.fsPath);
                    if (rel && !rel.includes('node_modules') && !rel.startsWith('.')) {
                        for (const d of diags) {
                            if (d.severity === vs.DiagnosticSeverity.Error) {
                                diagnostics.push({
                                    file: uri.fsPath,
                                    message: d.message,
                                    line: d.range.start.line + 1
                                });
                            }
                        }
                    }
                }
            } catch {
                // Ignore diag errors
            }

            const { getPendingInteractions } = require('./chatPanel');
            const pendingInteractions = getPendingInteractions();
            const pinnedSummary = this.loadPinnedContextSummary(topicId, runId);

            pinnedData = {
                todos,
                diagnostics: diagnostics.slice(0, 10),
                pendingInteractions,
                recentWrittenFiles: runRecord.writtenFiles.slice(-10),
                blockedSubAgents: pinnedSummary?.blocked?.slice(0, 8) ?? [],
                decisions: pinnedSummary?.decisions?.slice(0, 8) ?? []
            };
        }

        const promptConfig = this.aiService.getConfig();
        const providerForPrompt = options?.providerId ?? promptConfig.provider;
        const supportsPrefixCache = supportsOpenAiStylePrefixCache(providerForPrompt, promptConfig.customApiFormat, options?.model ?? promptConfig.model, this.aiService.getEndpointForProvider(providerForPrompt));
        // The model-visible tool set feeds both the frozen prompt fingerprint
        // (plan sec.7.1) and the reserved-token estimate below; mirror the
        // reasoning loop's filter inputs so both describe the real toolset.
        const promptModeTools = filterWebToolsForConfiguredAccess(filterToolDefinitionsForMode(TOOL_DEFINITIONS, mode, {
            domain,
            useSlimPrompt: options?.useSlimPrompt,
            excludeTools: options?.excludeTools,
        }));
        const initialToolFocus = options?.initialToolFocus ?? initialToolFocusForMode(mode);
        const promptToolDefinitions = promptModeTools;
        // DeepSeek prefix-cache optimization: use frozen (session-cached) system prompt
        // to ensure byte-level stability across API calls for cache hits.
        // rebuildSystemPrompt drops this fingerprint's cache entry before building (plan sec.7.1).
        // A delegated child is told the shape of its own fixed scope so a host
        // denial reads as policy instead of a transient error worth retrying. The
        // host still enforces all of it independently. Only a real dispatched
        // child has a sandbox; other slim runs (quality gate, side questions) get
        // no statement.
        const delegationScopeFacts = options?.sandbox
            ? {
                readOnly: options.sandbox.writeScope?.length === 0,
                writeScope: options.sandbox.writeScope,
                deniedWriteScopes: options.sandbox.deniedWriteScopes,
                rejectedScopes: options.sandbox.rejectedScopes,
            }
            : undefined;
        const systemPrompt = options?.useSlimPrompt
            ? this.promptBuilder.buildFrozenSlimSystemPromptForMode(
                mode,
                providerForPrompt,
                undefined,
                {
                    toolsetHash: hashToolDefinitionsForFingerprint(promptToolDefinitions),
                    rebuild: options?.rebuildSystemPrompt === true,
                    domain,
                },
            )
            : supportsPrefixCache
                ? this.promptBuilder.buildFrozenSystemPrompt(mode, providerForPrompt, undefined, {
                    toolsetHash: hashToolDefinitionsForFingerprint(promptToolDefinitions),
                    rebuild: options?.rebuildSystemPrompt === true,
                    domain,
                })
                : this.promptBuilder.buildSystemPromptForMode(
                    mode,
                    providerForPrompt,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    false,
                    false,
                    domain,
                );
        const usesFrozenPrompt = supportsPrefixCache || options?.useSlimPrompt === true;
        tokenAccumulator.promptFingerprint = usesFrozenPrompt
            ? this.promptBuilder.getLastFrozenPromptFingerprintHash()
            : undefined;
        tokenAccumulator.promptCacheMissReason = usesFrozenPrompt
            ? this.promptBuilder.getLastFrozenPromptLookup()?.missReason
            : undefined;

        const activeWorkflowForPrompt = options?.workflowId ? getWorkflow(options.workflowId) : undefined;
        const workspaceRoot = getProjectWorkspaceRoot();
        const memoryPathScope = [...new Set([
            context.activeFile,
            ...runRecord.writtenFiles.slice(-10),
        ].flatMap(filePath => {
            if (typeof filePath !== 'string' || !filePath.trim()) return [];
            const normalized = filePath.replace(/\\/g, '/');
            const relative = path.isAbsolute(filePath)
                ? path.relative(workspaceRoot, filePath).replace(/\\/g, '/')
                : normalized;
            return [normalized, relative, path.basename(filePath)].filter(Boolean);
        }))];

        // Keep all runtime-only state after the static system/history prefix for
        // every provider. This also makes task-ranked memory retrieval consistent
        // instead of silently falling back to priority-only selection when prefix
        // caching is unavailable.
        const promptDynamicBlock = this.promptBuilder.buildDynamicPromptBlock(pinnedData, topicId, runId, {
            mode,
            domain,
            taskText: userMessage,
            pathScope: memoryPathScope,
            workflow: activeWorkflowForPrompt
                ? {
                    id: activeWorkflowForPrompt.id,
                    title: activeWorkflowForPrompt.title,
                    promptSupplement: activeWorkflowForPrompt.promptSupplement,
                }
                : undefined,
        });
        const initialFocusReminder = buildToolFocusReminder(mode, initialToolFocus, domain);
        const dynamicBlock: ChatMessage[] = [
            ...promptDynamicBlock,
            ...(options?.useSlimPrompt ? this.promptBuilder.buildSlimDynamicPromptBlock(delegationScopeFacts) : []),
        ];
        if (options?.agentProfileInstructions?.trim()) {
            dynamicBlock.unshift({
                role: 'system',
                content: [
                    `[AGENT PROFILE: ${options.agentProfileName ?? schedulingState.profileName ?? 'custom'}]`,
                    options.agentProfileInstructions.trim().slice(0, 32_000),
                ].join('\n'),
            });
        }
        if (options?.approvedPlanExecution) {
            dynamicBlock.push({ role: 'user', content: buildApprovedPlanExecutionReminder() });
        }
        if (initialFocusReminder) {
            dynamicBlock.push({ role: 'user', content: initialFocusReminder });
        }

        const contextMessages = this.promptBuilder.buildContextMessages({
            ...context,
            domain,
            commandToolsAvailable: options?.useSlimPrompt !== true,
        });
        const fixedPromptMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...contextMessages,
            ...dynamicBlock,
            { role: 'user', content: userContent },
        ];
        const fixedPromptTokens = fixedPromptMessages.reduce((sum, message) => {
            if (!Array.isArray(message.content)) return sum + estimateTokenCount(contentToString(message.content));
            return sum + message.content.reduce((partSum, part) => {
                if (part.type === 'text') return partSum + estimateTokenCount(part.text);
                if (part.type === 'image_url') return partSum + Math.ceil(part.image_url.url.length / 3 / CHARS_PER_TOKEN);
                return partSum;
            }, 0);
        }, 0);
        // Tool schemas are part of every model request even though they are not
        // represented in ChatMessage[]. Reserve their full known size here.
        const toolSchemaTokens = estimateTokenCount(JSON.stringify(promptToolDefinitions));
        // Context Maintenance Coordinator (admission): estimate first — histories
        // under the threshold are returned untouched; otherwise free-prune in
        // place and only escalate to the paid summarizer when still over.
        const admissionConfig = this.aiService.getConfig();
        const admissionProviderId = options?.providerId ?? admissionConfig.provider;
        const admissionModel = options?.model ?? admissionConfig.model;
        const admissionPreserveMimo = admissionProviderId.startsWith('mimo')
            || (admissionModel ?? '').toLowerCase().startsWith('mimo-v2');
        const admissionContextLimit = resolveCompactionContextLimit(
            admissionProviderId,
            admissionModel,
            options?.maxContextTokens ?? admissionConfig.maxContextTokens,
        );
        const admissionDesiredOutput = resolveRunMaxOutputTokens({ useSlimPrompt: options?.useSlimPrompt })
            ?? getModelOutputTokens(admissionModel ?? getProvider(admissionProviderId).defaultModel, admissionProviderId);
        const admissionOutputReserve = resolveCompactionOutputReserve(admissionDesiredOutput, admissionContextLimit);
        const costGateConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance');
        const costGateEnabled = costGateConfig.get<boolean>('compactionCostGate.enabled', true);
        const admissionMaintenance = runContextMaintenance(conversationHistory, 'admission', {
            toolResultBudget: getToolResultBudget(
                admissionConfig.maxContextTokens > 0
                    ? admissionConfig.maxContextTokens
                    : (getProvider(admissionProviderId).maxContextTokens || DEFAULT_CONTEXT_LIMIT)),
            compactionOptions: {
                preserveTailBytes: supportsOpenAiStylePrefixCache(admissionProviderId, admissionConfig.customApiFormat, admissionModel, this.aiService.getEndpointForProvider(admissionProviderId))
                    || admissionPreserveMimo,
                preserveReasoningContentForToolCalls: admissionPreserveMimo,
            },
            extraTokens: fixedPromptTokens + toolSchemaTokens + admissionOutputReserve,
            calibrateEstimate: (t) => this.calibrateContextEstimate(admissionProviderId, admissionModel, t),
            // NOTE: when this prunes, conversationHistory is mutated in place even
            // if the paid summarizer later fails or is throttled. That is
            // intentional (free prune first) and safe: squeezing is lossy only
            // for re-derivable tool output, and canonicalization still runs.
            costGate: costGateEnabled ? {
                contextLimitTokens: admissionContextLimit,
                inputPriceCnyPerMillion: getCurrentModelPricing(admissionModel ?? '', admissionProviderId)[0],
                recentHitRatio: this.cacheHitRatio(admissionProviderId, admissionModel),
                warmHitRatio: COST_GATE_WARM_HIT_RATIO,
                minUsageRatio: COST_GATE_MIN_USAGE_RATIO,
                maxUncachedCostCny: Math.max(0.001, costGateConfig
                    .get<number>('compactionCostGate.maxUncachedCostCnyPerRequest', 0.05)),
            } : undefined,
            summarizeThreshold: Math.floor(
                admissionContextLimit
                * Math.max(0.5, Math.min(0.95, vs.workspace
                    .getConfiguration('stellarisLanguageServices.ai.performance')
                    .get<number>('compactionTriggerRatio', resolveCompactionRatios(admissionProviderId, admissionModel).thresholdRatio)))),
        });
        if (admissionMaintenance.action === 'pruned-below-threshold') {
            refreshLiveVsCodeContext(conversationHistory);
            emitStep({
                type: 'compaction',
                content: AGENT.COMPACTION_PRUNED(admissionMaintenance.beforeTokens, admissionMaintenance.afterTokens),
                timestamp: Date.now(),
                compactionInfo: {
                    state: 'complete',
                    kind: 'history',
                    beforeTokens: admissionMaintenance.beforeTokens,
                    afterTokens: admissionMaintenance.afterTokens,
                },
            });
        }
        // Always pass through the paid path: for 'untouched'/'pruned-below-threshold'
        // the precomputed estimate is under threshold, so the wrapper returns the
        // canonicalized transcript without a summarizer call (preserving the
        // canonicalization side effect); for 'summarize' it compacts.
        const compactedHistory = await this.maybeCompactHistory(
            conversationHistory,
            emitStep,
            options,
            tokenAccumulator,
            {
                reservedTokens: fixedPromptTokens + toolSchemaTokens + admissionOutputReserve,
                precomputedRequestTokens: admissionMaintenance.afterTokens,
                costGateFired: admissionMaintenance.costGateFired,
            },
        );
        if (compactedHistory !== conversationHistory) {
            // Keep the full transcript in ChatTopicManager, but replace the active
            // model history. This mirrors Codex/Claude: disk transcript is durable,
            // active context becomes a rolling summary.
            conversationHistory.splice(0, conversationHistory.length, ...compactedHistory);
        }

        // Build the message array. Stable-prefix ordering (plan sec.7.2): the
        // frozen system prompt stays at the head, cacheable (possibly compacted)
        // history follows, and dynamic editor/project state sits immediately
        // before the user turn so the long static prefix remains byte-stable for
        // provider prefix caches. The OpenAI Responses path merges system
        // messages into top-level instructions preserving their relative order,
        // so this reorder does not conflict with that merge.
        let messages: ChatMessage[];
        let restoredStepRequests: StepRequest[] = [];
        
        if (options?.resumeFromState && context.topicId) {
            const resumeState = restoredResumeState;
            if (resumeState) {
                messages = resumeState.messages;
                mode = resumeState.mode ?? mode;
                domain = resumeState.domain ?? domain;
                options = { ...options, mode, domain };
                if (resumeState.todos && resumeState.todos.length > 0) {
                    void this.toolExecutor.getExternalToolHandler().todoWrite({ todos: resumeState.todos });
                }
                restoredStepRequests = (resumeState.pendingStepRequests ?? []).filter(isRetryStepRequest);
                emitStep({
                    type: 'thinking',
                    content: aiText('Restored context from checkpoint and continuing...', '已从断点快照中恢复上下文并继续执行...'),
                    timestamp: Date.now(),
                });
            } else {
                messages = orderMessagesForStablePrefix({
                    systemPrompt,
                    compactedHistory,
                    contextMessages,
                    dynamicBlock,
                    userContent,
                });
            }
        } else {
            messages = orderMessagesForStablePrefix({
                systemPrompt,
                compactedHistory,
                contextMessages,
                dynamicBlock,
                userContent,
            });
        }

        // mode may have been overridden by the resumed checkpoint; record the final one.
        tokenAccumulator.agentMode = mode;

        if (context.topicId) {
            options = { ...options, topicId: context.topicId, mode, domain };
            await this.saveResumeState(context.topicId, messages, mode, domain, runId, undefined, options.schedulingState ?? schedulingState);
        }

        const modeLabel: Record<string, string> = {
            build: AGENT.MODE_BUILD,
            plan: AGENT.MODE_PLAN,
            explore: AGENT.MODE_EXPLORE,
            general: AGENT.MODE_GENERAL,
            utility: AGENT.MODE_UTILITY,
            review: AGENT.MODE_REVIEW,
            orchestrator: AGENT.MODE_ORCHESTRATOR,
            script: AGENT.MODE_SCRIPT,
        };
        emitStep({
            type: 'thinking',
            content: modeLabel[mode] ?? AGENT.MODE_FALLBACK,
            timestamp: Date.now(),
        });


        try {
            // Wire topicId from context into options for checkpoint persistence
            if (context.topicId) {
                options = { ...options, topicId: context.topicId, mode };
            }

            // Phase 1: Agent reasoning loop (with tool calls)
            updateRunStatus('running');
            const terminalValidation = createTerminalValidationState();
            const finalMessage = await this.reasoningLoop(
                messages,
                emitStep,
                mode,
                options,
                tokenAccumulator,
                options?.onBeforeFileWrite,
                runMetrics,
                terminalValidation,
                restoredStepRequests,
            );
            runMetrics.finalPromptTokens = messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0);

            // Phase 2: Extract code from the response
            const code = this.extractCode(finalMessage);

            if (this.retainedResumeRuns.has(runId)) {
                updateRunStatus('paused');
                await clearResumeStateIfComplete();
                return {
                    runId,
                    code: code ?? '',
                    explanation: finalMessage,
                    validationErrors: [{
                        code: 'RUN_PAUSED',
                        severity: 'error',
                        message: 'The run paused at a durable budget or safety boundary. Progress is checkpointed and can be resumed.',
                        line: 0,
                        column: 0,
                    }],
                    isValid: false,
                    retryCount: 0,
                    steps,
                    tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                    runMetrics,
                };
            }

            const orchestratorValidation = mode === 'script' || mode === 'orchestrator'
                ? this.toolExecutor.getOrchestratorValidation(runId)
                : undefined;
            const toolValidationOutcome = terminalValidationOutcome(terminalValidation);
            const terminalValidationDeferred = options?.deferTerminalValidationToParent === true;
            const validationPending = !terminalValidationDeferred
                && (orchestratorValidation?.pendingOnly === true
                    || (!orchestratorValidation && toolValidationOutcome === 'pending'));
            const validationFailed = !terminalValidationDeferred
                && ((orchestratorValidation?.success === false && orchestratorValidation.pendingOnly !== true)
                    || (!orchestratorValidation && toolValidationOutcome === 'repair'));
            if (validationPending) {
                this.retainedResumeRuns.add(runId);
                if (context.topicId) {
                    await this.saveResumeState(context.topicId, messages, mode, domain, runId, undefined, options.schedulingState ?? schedulingState);
                }
                updateRunStatus('paused');
            } else {
                updateRunStatus(validationFailed ? 'failed' : 'completed');
                if (!validationFailed) this.autoCompleteTodos(options);
            }
            await clearResumeStateIfComplete();
            const validationErrors = validationPending || validationFailed ? [{
                code: validationPending
                    ? 'VALIDATION_PENDING'
                    : orchestratorValidation ? 'orchestrator_quality_gate' : 'post_write_validation',
                severity: 'error' as const,
                message: orchestratorValidation?.summary ?? (validationPending
                    ? aiText(
                        'Written files are saved, but final deterministic validation is still pending. The run can be resumed.',
                        '文件已写入，但最终确定性验证仍在等待中；该运行可以恢复。',
                    )
                    : formatTerminalValidationFeedback(terminalValidation)),
                line: 0,
                column: 0,
            }] : [];
            return {
                runId,
                code: code ?? '',
                explanation: code ? this.extractExplanation(finalMessage) : finalMessage,
                validationErrors,
                isValid: !validationPending && !validationFailed,
                retryCount: 0,
                steps,
                tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                runMetrics,
            };
        } catch (e) {
            updateRunStatus('failed');
            const errorMsg = e instanceof Error ? e.message : String(e);

            if (errorMsg.includes('aborted') || errorMsg.includes('cancel')) {
                threadStore.markStatus(topicId, threadId, 'interrupted').catch(error => {
                    reportBestEffortFailure('thread.mark_interrupted', { topicId, threadId }, error);
                });
                emitStep({ type: 'error', content: AGENT.CANCELLED, timestamp: Date.now() });
            } else {
                emitStep({ type: 'error', content: `${AGENT.ERROR_PREFIX}: ${errorMsg}`, timestamp: Date.now() });
            }

            if (context.topicId) {
                await this.saveResumeState(context.topicId, messages, mode, domain, runId, undefined, options.schedulingState ?? schedulingState);
            }
            runMetrics.finalPromptTokens = messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0);

            return {
                runId,
                code: '',
                explanation: aiText(`[Execution error] ${errorMsg}`, `[执行异常] ${errorMsg}`),
                validationErrors: [],
                isValid: false,
                retryCount: 0,
                steps,
                tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                runMetrics,
            };
        }
        } finally {
            // Cleanup runs for the whole run() scope: entries registered before the
            // main try block (abort listener, active-turn registry, active maps) are
            // released here too, with guards for runs that failed during setup.
            if (runId) this.toolExecutor.clearSkillPolicyForRun(runId);
            if (options?.agentId) this.toolExecutor.clearTodos(options.agentId);
            await this.tokenCalibration?.flush();
            if (runId) this.retainedResumeRuns.delete(runId);
            unregisterActiveTurn?.();
            parentAbortSignal?.removeEventListener('abort', forwardParentAbort);
            if (runId) {
                this.activeRunEventSinks.delete(runId);
                this.activeInputQueues.delete(runId);
                if (this.activeRunRecordPromise === runRecordPromise) {
                    this.activeRunRecordPromise = undefined;
                }
            }
        }
    }




    /**
     * Auto-mark remaining in-progress todos as done when the run completes successfully.
     * Prevents the task window from showing stale in-progress items after the AI finishes.
     */
    private autoCompleteTodos(options?: AgentRunnerOptions): void {
        const handler = this.toolExecutor.getExternalToolHandler();
        const todos = handler.getTodos(options?.agentId);
        if (todos.length === 0) return;

        let updated = false;
        for (const item of todos) {
            if (item.status === 'in_progress') {
                item.status = 'done';
                updated = true;
            }
        }
        if (updated) {
            void handler.todoWrite({ todos }, {
                runnerOptions: options,
                runEventSink: options?.runEventSink,
                onTodoUpdate: options?.onTodoUpdate,
            });
        }
    }

    // ─── Context Compaction ──────────────────────────────────────────────────

    /**
     * If conversation history is too long relative to the provider's context window,
     * summarize older messages into a compact system message.
     */
    private async maybeCompactHistory(
        history: import('./types').ChatMessage[],
        emitStep: (step: import('./types').AgentStep) => void,
        options?: import('./agentRunner').AgentRunnerOptions,
        tokenAccumulator?: import('./types').TokenUsage,
        budgetOptions?: CompactionBudgetOptions,
    ): Promise<import('./types').ChatMessage[]> {
        if (!budgetOptions?.force) {
            const intervalSeconds = vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance')
                .get<number>('compactionMinIntervalSeconds', AUTO_COMPACTION_MIN_INTERVAL_MS / 1000);
            this.autoCompactionThrottle.minIntervalMs = Math.max(0, intervalSeconds) * 1000;
        }
        return _maybeCompactHistory(
            history,
            emitStep,
            { aiService: this.aiService, promptBuilder: this.promptBuilder },
            options,
            tokenAccumulator,
            Math.max(0.5, Math.min(0.95, vs.workspace
                .getConfiguration('stellarisLanguageServices.ai.performance')
                .get<number>('compactionTriggerRatio', resolveCompactionRatios(options?.providerId, options?.model).thresholdRatio))),
            {
                ...budgetOptions,
                // Cancel in-flight compaction with the turn so a cancelled run
                // never completes a billed summarization call.
                abortSignal: options?.abortSignal,
                // Real-usage calibration for the summarizer call itself.
                onUsageSample: (sample) => {
                    this.tokenCalibration?.record(
                        this.calibrationKeyFor(sample.providerId, sample.model),
                        sample.estimated,
                        sample.actual,
                    );
                },
                // Throttle only automatic compaction; mid-loop, emergency, and
                // manual compaction must always run.
                autoThrottle: budgetOptions?.force ? undefined : this.autoCompactionThrottle,
            },
        );
    }

    /** Manually replace the active model history with one rolling summary. */
    public async compactActiveHistory(
        history: ChatMessage[],
        options?: AgentRunnerOptions,
        onStep?: (step: AgentStep) => void,
        tokenAccumulator?: TokenUsage,
    ): Promise<{ compacted: boolean; steps: AgentStep[] }> {
        if (history.length < 2) return { compacted: false, steps: [] };
        const steps: AgentStep[] = [];
        // Manual compaction is an explicit user request: free-prune first to
        // shrink the summarizer input, but always produce a summary.
        const manualConfig = this.aiService.getConfig();
        const manualProviderId = options?.providerId ?? manualConfig.provider;
        const manualModel = options?.model ?? manualConfig.model;
        const manualPreserveMimo = manualProviderId.startsWith('mimo')
            || (manualModel ?? '').toLowerCase().startsWith('mimo-v2');
        const manualSchemaTokens = estimateTokenCount(JSON.stringify(TOOL_DEFINITIONS));
        const manualDesiredOutput = resolveRunMaxOutputTokens({ useSlimPrompt: options?.useSlimPrompt })
            ?? getModelOutputTokens(manualModel ?? getProvider(manualProviderId).defaultModel, manualProviderId);
        const manualContextLimit = resolveCompactionContextLimit(
            manualProviderId,
            manualModel,
            options?.maxContextTokens ?? manualConfig.maxContextTokens,
        );
        const manualOutputReserve = resolveCompactionOutputReserve(manualDesiredOutput, manualContextLimit);
        runContextMaintenance(history, 'manual', {
            toolResultBudget: getToolResultBudget(
                manualConfig.maxContextTokens > 0
                    ? manualConfig.maxContextTokens
                    : (getProvider(manualProviderId).maxContextTokens || DEFAULT_CONTEXT_LIMIT)),
            compactionOptions: {
                preserveTailBytes: supportsOpenAiStylePrefixCache(manualProviderId, manualConfig.customApiFormat, manualModel, this.aiService.getEndpointForProvider(manualProviderId))
                    || manualPreserveMimo,
                preserveReasoningContentForToolCalls: manualPreserveMimo,
            },
            extraTokens: manualSchemaTokens + manualOutputReserve,
            summarizeThreshold: 0,
        });
        const compacted = await this.maybeCompactHistory(
            history,
            step => {
                const manualStep = step.compactionInfo
                    ? { ...step, compactionInfo: { ...step.compactionInfo, kind: 'manual' as const } }
                    : step;
                steps.push(manualStep);
                onStep?.(manualStep);
            },
            options,
            tokenAccumulator,
            {
                force: true,
                reservedTokens: manualSchemaTokens + manualOutputReserve,
            },
        );
        if (compacted === history) return { compacted: false, steps };
        history.splice(0, history.length, ...compacted);
        refreshLiveVsCodeContext(history);
        return { compacted: true, steps };
    }

    /**
     * Agent reasoning loop: call AI → if tool_calls → execute → feed back → repeat.
     * Supports both OpenAI JSON tool_calls and DSML/XML text-format tool calls (DeepSeek fallback).
     * Accumulates token usage into the provided tokenAccumulator (mutated in-place).
     *
     * Mid-loop compaction: every MID_LOOP_COMPACTION_INTERVAL iterations, the loop
     * estimates cumulative message size and compacts older tool results in-place
     * if they exceed the per-model mid-loop ratio of the context window.
     */
    /**
     * Process tool result to detect and automatically truncate massive payloads,
     * archiving the full result into the local topic run snapshot directory.
     */
    private async processToolResult(
        toolName: string,
        invocationId: string,
        runId: string,
        topicId: string,
        result: unknown,
        providerId?: string,
        model?: string,
    ): Promise<ProcessedToolResult> {
        if (!result) return { modelResult: result, stateResult: result };

        const strContent = this.serializeToolResult(result);

        const LIMIT = this.getToolResultArchiveLimit(toolName, providerId, model);
        if (strContent.length <= LIMIT) {
            await runLedger.appendEvent(
                runId,
                'tool_output_delta',
                {
                    toolName,
                    preview: strContent.substring(0, 1000),
                    resultSize: strContent.length,
                    truncated: false
                },
                { invocationId, status: isToolResultSuccess(result) ? 'done' : 'failed' }
            ).catch(error => {
                reportBestEffortFailure('ledger.append_tool_output', { runId, toolName, truncated: false }, error);
            });
            return { modelResult: result, stateResult: result };
        }

        try {
            const wsRoot = getProjectWorkspaceRoot();
            const runDir = path.join(getPrivateTopicStorageDir(topicId, wsRoot), 'runs', runId, 'large_results');

            const archivedResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            const resultSha256 = sha256Text(archivedResult);
            const artifactName = `${resultSha256}.json`;
            const filePath = path.join(runDir, artifactName);
            if (!fs.existsSync(filePath)) {
                await atomicWriteText(filePath, archivedResult);
            }

            const relativeDiskPath = path.posix.join('runs', runId, 'large_results', artifactName);
            const preview = strContent.substring(0, 1000);
            await runLedger.appendEvent(
                runId,
                'artifact_created',
                {
                    kind: 'tool_result',
                    title: `${toolName} result`,
                    filePath: relativeDiskPath,
                    resultRef: relativeDiskPath,
                    resultSha256,
                    toolName,
                    resultSize: strContent.length
                },
                { invocationId, status: 'done' }
            ).catch(error => {
                reportBestEffortFailure('ledger.append_artifact', { runId, toolName }, error);
            });
            await runLedger.appendEvent(
                runId,
                'tool_output_delta',
                {
                    toolName,
                    preview,
                    resultSize: strContent.length,
                    truncated: true,
                    resultRef: relativeDiskPath
                },
                { invocationId, status: isToolResultSuccess(result) ? 'done' : 'failed' }
            ).catch(error => {
                reportBestEffortFailure('ledger.append_tool_output', { runId, toolName, truncated: true }, error);
            });
            return {
                modelResult: buildArchivedToolResultEnvelope({
                    toolName,
                    result,
                    resultSize: strContent.length,
                    preview,
                    resultRef: relativeDiskPath,
                    resultSha256,
                }),
                stateResult: result,
            };
        } catch (archiveError) {
            reportBestEffortFailure('tool_result.archive', { runId, toolName }, archiveError);
            await runLedger.appendEvent(
                runId,
                'tool_output_delta',
                {
                    toolName,
                    preview: strContent.substring(0, 1000),
                    resultSize: strContent.length,
                    truncated: true
                },
                { invocationId, status: 'failed' }
            ).catch(error => {
                reportBestEffortFailure('ledger.append_tool_output', { runId, toolName, truncated: true }, error);
            });
            return {
                modelResult: buildArchivedToolResultEnvelope({
                    toolName,
                    result,
                    resultSize: strContent.length,
                    preview: strContent.substring(0, 1000),
                }),
                stateResult: result,
            };
        }
    }

    private getToolResultArchiveLimit(toolName: string, providerId?: string, model?: string): number {
        return resolveToolResultArchiveLimit(toolName, providerId, model);
    }

    private serializeToolResult(result: unknown): string {
        if (typeof result === 'string') return result;
        try {
            return JSON.stringify(result) ?? String(result);
        } catch {
            return String(result);
        }
    }

    private summarizeToolResultForLedger(toolName: string, result: unknown): Record<string, unknown> {
        const resultRecord = toolResultRecord(result);
        const strContent = this.serializeToolResult(result);
        const error = resultRecord?.error;
        const skipped = !!resultRecord?.skipped;
        const resultRef = resultRecord?.resultRef || resultRecord?.fullResultLocalPath;
        const resultSha256 = resultRecord?.resultSha256;
        const previewSource = typeof resultRecord?.preview === 'string' ? resultRecord.preview : strContent;
        const rawWrittenFiles = resultRecord?.writtenFiles ?? resultRecord?.changedFiles ?? resultRecord?.filesWritten ?? resultRecord?.filesChanged;
        const writtenFiles = Array.isArray(rawWrittenFiles)
            ? rawWrittenFiles.filter((file: unknown): file is string => typeof file === 'string' && file.length > 0)
            : [];
        return {
            toolName,
            success: isToolResultSuccess(result),
            error,
            skipped,
            truncated: !!resultRecord?.truncated,
            resultRef,
            resultSha256,
            resultSize: strContent.length,
            preview: previewSource.substring(0, 1000),
            ...(!resultRef ? { result } : {}),
            ...(writtenFiles.length > 0 ? { writtenFiles } : {}),
        };
    }

    private loadPinnedContextSummary(topicId: string, runId: string): { blocked?: string[]; decisions?: string[] } | undefined {
        try {
            const summaryPath = path.join(getPrivateTopicStorageDir(topicId, getProjectWorkspaceRoot()), 'runs', runId, 'summary.json');
            if (!fs.existsSync(summaryPath)) return undefined;
            const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
            return {
                blocked: Array.isArray(parsed?.blocked) ? parsed.blocked.map(String) : [],
                decisions: Array.isArray(parsed?.decisions) ? parsed.decisions.map(String) : []
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Best-effort long-term memory usage tracking (plan §8): when the assistant's
     * response mentions a stored memory key verbatim, count it as an actual use.
     * Persistence is debounced inside MemoryParser; failures never break the loop.
     */
    private trackMemoryKeyReferences(
        topicId: string | undefined,
        assistantText: string,
        domain: AgentRuntimeDomain,
    ): void {
        if (!assistantText) return;
        try {
            const wsRoot = getProjectWorkspaceRoot();
            if (!wsRoot) return;
            new MemoryParser(wsRoot, topicId).markMemoryUsedInText(topicId, assistantText, domain);
        } catch (e) {
            ErrorReporter.debug(SOURCE.AGENT_RUNNER, 'Failed to track memory key references', e);
        }
    }

    private async reasoningLoop(
        messages: ChatMessage[],
        emitStep: (step: AgentStep) => void,
        mode: AgentMode,
        options?: AgentRunnerOptions,
        tokenAccumulator?: TokenUsage,
        onFileWrite?: (filePath: string, prevContent: string | null) => void,
        runMetrics?: AgentRunMetrics,
        terminalValidation?: TerminalValidationState,
        restoredStepRequests: readonly StepRequest[] = [],
    ): Promise<string> {
        const schedulingState = normalizeSchedulingState(
            options?.schedulingState,
            mode,
            options?.domain,
        );
        if (options) options.schedulingState = schedulingState;
        const runRecord = options?.runRecord ?? await this.activeRunRecordPromise!;
        this.readTracker.reset();
        // Per-run reset of edit failure counters (top-level runs only: sub-agents
        // share the executor and must not clear the parent run's counters).
        if (!options?.useSlimPrompt) {
            this.toolExecutor.resetEditFailureTracking();
        }
        let iteration = 0;
        const activeProviderId = options?.providerId ?? this.aiService.getConfig().provider;
        const activeModel = (options?.model ?? this.aiService.getConfig().model ?? '').toLowerCase();
        const preserveMimoReasoningContent = activeProviderId.startsWith('mimo') || activeModel.startsWith('mimo-v2');
        const supportsPrefixCache = supportsOpenAiStylePrefixCache(activeProviderId, this.aiService.getConfig().customApiFormat, activeModel, this.aiService.getEndpointForProvider(activeProviderId))
            || preserveMimoReasoningContent;
        const compactionOptions: CompactMessagesOptions = {
            preserveTailBytes: supportsPrefixCache,
            preserveReasoningContentForToolCalls: preserveMimoReasoningContent,
        };

        // Calibrated estimate closure for in-loop threshold decisions (P0 design 3):
        // cold table returns the raw estimate unchanged.
        const calibrateLoopEstimate = (tokens: number): number => this.calibrateContextEstimate(
            options?.providerId ?? this.aiService.getConfig().provider,
            options?.model ?? this.aiService.getConfig().model,
            tokens,
        );
        const recoveryCoordinator = new RecoveryCoordinator();

        const agentToolContext: import('./types').AgentToolContext = {
            runnerOptions: options,
            agentRunner: this,
            runEventSink: options?.runEventSink,
            tokenAccumulator: tokenAccumulator,
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
            // Per-run scope for the anchor-failure guard: sub-agents share the
            // executor, so each run contributes only its own scoped signatures.
            scopeId: runRecord.runId,
            onBeforeFileWrite: onFileWrite,
            onTodoUpdate: options?.onTodoUpdate,
            // run_code snapshots the current model-visible catalog when its
            // guest starts. Nested calls still recheck the live catalog.
            runCodeToolDefinitions: () => availableTools.filter(tool => TOOL_REGISTRY.has(tool.function.name as AgentToolName)),
            runNestedTool: async (toolName, args, signal, writeQueueWaitTimeoutMs) => {
                const result = await this.runNestedToolStep(
                    toolName,
                    args,
                    agentToolContext,
                    onFileWrite,
                    availableTools,
                    signal,
                    writeQueueWaitTimeoutMs,
                );
                const files = getAgentToolTargetFiles(toolName, args, this.toolExecutor.workspaceRoot, options?.topicId);
                if (WRITE_TOOLS.has(toolName) && files[0]) {
                    const record = result as Record<string, unknown> | undefined;
                    if (record && (record.success === true || record.confirmed === true)) {
                        confirmedWrittenFiles.add(files[0]);
                    }
                }
                return result;
            },
        };

        // Cross-step repetition requires both a repeated call pattern and
        // unchanged normalized results before execution is stopped.
        const doomLoop = new DoomLoopState();
        let consecutiveErrorCount = 0;
        // Flag set to true when we need to exit the outer while loop
        let forceStop = false;
        let executionActionObserved = false;
        let interactivePlanApprovalPending = false;
        const updateFinalPromptMetric = () => {
            if (!runMetrics) return;
            runMetrics.finalPromptTokens = messages.reduce((s, m) => {
                if (Array.isArray(m.content)) {
                    return s + m.content.reduce((inner, part) => {
                        if (part.type === 'text') return inner + estimateTokenCount(part.text);
                        if (part.type === 'image_url') return inner + Math.ceil(part.image_url.url.length / 3 / CHARS_PER_TOKEN);
                        return inner;
                    }, 0);
                }
                return s + estimateChatMessageTokens(m);
            }, 0);
        };

        const measureToolResultChars = (result: unknown): number => {
            if (typeof result === 'string') return result.length;
            try {
                return JSON.stringify(result)?.length ?? String(result).length;
            } catch {
                return String(result).length;
            }
        };

        // Track files confirmed-written this session
        const confirmedWrittenFiles = new Set<string>();
        const performanceConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance');
        const toolFocus = options?.initialToolFocus ?? initialToolFocusForMode(mode);
        if (tokenAccumulator) tokenAccumulator.toolFocus = toolFocus;
        let requestArchiveState: ModelRequestArchiveState | undefined;
        const archivedToolsets = new Map<string, { ref: string; sha256: string }>();
        const archiveModelRequest = async (
            modelCallId: string,
            metadata: Record<string, unknown>,
            requestMessages: readonly ChatMessage[],
            requestTools: readonly ToolDefinition[],
        ): Promise<{ ref: string; sha256: string } | undefined> => {
            const toolsContentSha256 = sha256Text(JSON.stringify(requestTools));
            let toolsetArtifact = archivedToolsets.get(toolsContentSha256);
            if (!toolsetArtifact) {
                const written = await runLedger.writeJsonArtifact(
                    runRecord.runId,
                    `model_inputs/tools/${toolsContentSha256}.json`,
                    {
                        version: 1,
                        kind: 'model_toolset',
                        contentSha256: toolsContentSha256,
                        tools: requestTools,
                    },
                );
                if (written) {
                    toolsetArtifact = written;
                    archivedToolsets.set(toolsContentSha256, written);
                }
            }

            const messagePlan = buildModelRequestMessageArchive(requestMessages, requestArchiveState);
            const requestArtifact = await runLedger.writeJsonArtifact(
                runRecord.runId,
                `model_requests/${modelCallId}.json`,
                {
                    version: 2,
                    kind: 'model_request',
                    ...metadata,
                    messageArchive: messagePlan.archive,
                    toolset: {
                        ref: toolsetArtifact?.ref,
                        artifactSha256: toolsetArtifact?.sha256,
                        contentSha256: toolsContentSha256,
                        count: requestTools.length,
                    },
                },
            );
            if (requestArtifact) {
                requestArchiveState = {
                    requestRef: requestArtifact.ref,
                    messageHashes: messagePlan.messageHashes,
                };
            }
            return requestArtifact;
        };
        let availableTools = filterWebToolsForConfiguredAccess(filterToolDefinitionsForMode(TOOL_DEFINITIONS, mode, {
            domain: options?.domain,
            useSlimPrompt: options?.useSlimPrompt,
            excludeTools: options?.excludeTools,
        }));

        // 🌟 核心优化：若开启了扁平化并且工具注册了展平 schema，则展现给模型的 availableTools 使用扁平化版本
        availableTools = availableTools.map(t => {
            const entry = TOOL_REGISTRY.get(t.function.name as any);
            return (entry && entry.flatSchema) ? entry.flatSchema : t;
        });

        // Dynamic MCP tools (Phase 2): opt-in, share mcp_call mode gating, never offered to slim sub-agents.
        if (!options?.useSlimPrompt) {
            try {
                const mcpDefs = await this.toolExecutor.getDynamicMcpToolDefinitions(mode, options?.domain);
                if (mcpDefs.length > 0) availableTools = sortToolDefinitionsForStableRequest([...availableTools, ...mcpDefs]);
            } catch { /* best effort */ }
        }

        // Apply workflow tool policy if running within a workflow
        const activeWorkflow = options?.workflowId ? getWorkflow(options.workflowId) : undefined;
        if (activeWorkflow) {
            const policy = activeWorkflow.toolPolicy;
            const workflowRuntimeSupportTools = new Set<string>(['ask_user_question', 'run_skill']);
            if (policy.strategy === 'allowlist') {
                const allowed = new Set<string>(policy.tools);
                availableTools = availableTools.filter(t => allowed.has(t.function.name) || workflowRuntimeSupportTools.has(t.function.name));
            } else {
                // blocklist
                const blocked = new Set<string>(policy.tools);
                availableTools = availableTools.filter(t => !blocked.has(t.function.name) || workflowRuntimeSupportTools.has(t.function.name));
            }
            ErrorReporter.debug('AgentRunner', `Workflow "${activeWorkflow.id}" tool policy applied: ${availableTools.length} tools available`);
        }
        availableTools = sortToolDefinitionsForStableRequest(availableTools);
        const eligibleToolPool = availableTools;
        const disclosureContext: ToolDisclosureContext = {
            mode,
            domain: options?.domain ?? defaultDomainForMode(mode),
            dynamicSupported: vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance')
                .get<boolean>('dynamicToolDisclosure.enabled', true),
            loaded: new Set<string>(),
        };
        const toolDedupe = new ToolDedupeService();
        const refreshAvailableTools = (): ToolDefinition[] => {
            if (shouldAutoDiscloseExecutionTools(mode, schedulingState.authorization)) {
                toolDisclosureService.select({
                    groups: ['file_write', 'command', 'git'],
                    reason: 'Runtime-authorized execution surface',
                }, eligibleToolPool, disclosureContext, { eligibleTools: eligibleToolPool });
            }
            return toolDisclosureService.initialTools(eligibleToolPool, disclosureContext);
        };
        availableTools = refreshAvailableTools();
        const initialRunCodeSdk = buildRunCodePromptBlock(
            availableTools.filter(tool => TOOL_REGISTRY.has(tool.function.name as AgentToolName)),
        );
        if (initialRunCodeSdk && availableTools.some(tool => tool.function.name === 'run_code')) {
            messages.push({ role: 'user', content: initialRunCodeSdk });
        }

        // M3 Fix: remove per-call dynamic import — getProvider is already statically
        // imported at the top of this file; dynamic import added latency for nothing.
        const _config0 = this.aiService.getConfig();
        const _providerId0 = options?.providerId ?? _config0.provider;
        const _provider0 = getProvider(_providerId0);
        const useDsmlToolRole0 = _provider0.toolCallStyle === 'dsml';

        // Compute context limit and tool result budget once for the entire loop
        const bypassSandbox = vs.workspace.getConfiguration('stellarisLanguageServices.ai.developer').get<boolean>('disableSecuritySandbox') === true;
        
        const baseContextLimit = _config0.maxContextTokens > 0
            ? _config0.maxContextTokens
            : (_provider0.maxContextTokens || DEFAULT_CONTEXT_LIMIT);
            
        // Security permissions must never disable context safety. Full-access
        // mode may relax approvals, but the model still has the same window.
        const contextLimit = contextLimitTracker.get(
            _providerId0,
            options?.model ?? _config0.model,
            baseContextLimit,
        ).effectiveLimit;
        
        const configuredBlockRatio = Math.max(0.55, Math.min(0.98,
            vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance')
                .get<number>('compactionBlockRatio', resolveMidLoopBlockRatio(_providerId0, options?.model ?? _config0.model))));
        const configuredReservedTokens = Math.max(0,
            vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance')
                .get<number>('compactionReservedTokens', 4_096));
        const desiredRunOutputTokens = resolveRunMaxOutputTokens({ useSlimPrompt: options?.useSlimPrompt })
            ?? getModelOutputTokens(options?.model ?? _config0.model ?? _provider0.defaultModel, _providerId0);
        const midLoopThreshold = Math.floor((contextLimit - configuredReservedTokens) * configuredBlockRatio);
        const toolResultBudget = getToolResultBudget(baseContextLimit);

        const iterationWindow = resolveMaxToolIterations({
            mode,
            baseContextLimit,
            bypassSandbox,
            override: options?.maxIterations,
            isSubAgent: options?.useSlimPrompt === true,
        });
        let maxToolIterations = iterationWindow;
        if (runMetrics) runMetrics.maxIterations = maxToolIterations;

        const runBudgetConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance');
        const isSlimRun = options?.useSlimPrompt === true;
        const budgetTracker = new RunBudgetTracker(
            {
                modelCalls: runBudgetConfig.get<number>(
                    isSlimRun ? 'subAgentModelCallBudget' : 'modelCallBudget',
                    isSlimRun ? 24 : 64,
                ),
                wallTimeMs: runBudgetConfig.get<number>(
                    isSlimRun ? 'subAgentWallTimeBudgetMinutes' : 'wallTimeBudgetMinutes',
                    isSlimRun ? 8 : 20,
                ) * 60_000,
                uncachedInputTokens: runBudgetConfig.get<number>(
                    isSlimRun ? 'subAgentUncachedInputTokenBudget' : 'uncachedInputTokenBudget',
                    isSlimRun ? 100_000 : 300_000,
                ),
            },
            Date.now(),
            selectHardBudgetMultiplier({
                durableGoal: options?.durableGoal === true,
                regularMultiplier: runBudgetConfig.get<number>(
                    'hardBudgetMultiplier',
                    DEFAULT_HARD_BUDGET_MULTIPLIER,
                ),
                goalMultiplier: runBudgetConfig.get<number>(
                    'goalHardBudgetMultiplier',
                    DEFAULT_GOAL_HARD_BUDGET_MULTIPLIER,
                ),
            }),
        );
        let progressRevision = 0;
        let lastExtendedProgressRevision = 0;
        let lastExtendedActivityIteration = 0;
        let completedTodoCount = this.toolExecutor.getTodos(options?.agentId)
            .filter(todo => todo.status === 'done').length;
        const blockingValidationIssues = new Set<string>();
        const diagnosticErrorsByTarget = new Map<string, number>();
        let lastResumeSnapshotAt = Date.now();
        let lastResumeSnapshotIteration = 0;
        const maybeSaveResumeSnapshot = async (force = false): Promise<void> => {
            if (!options?.topicId) return;
            const now = Date.now();
            if (!shouldPersistResumeSnapshot({
                force,
                iteration,
                lastIteration: lastResumeSnapshotIteration,
                intervalIterations: RESUME_SNAPSHOT_INTERVAL,
                now,
                lastSavedAt: lastResumeSnapshotAt,
                minIntervalMs: RESUME_SNAPSHOT_MIN_INTERVAL_MS,
            })) return;
            await this.saveResumeState(
                options.topicId,
                messages,
                mode,
                options.domain ?? defaultDomainForMode(mode),
                runRecord.runId,
                undefined,
                options.schedulingState,
            );
            lastResumeSnapshotAt = now;
            lastResumeSnapshotIteration = iteration;
        };
        const saveRetainedResumeSnapshot = async (): Promise<void> => {
            this.retainedResumeRuns.add(runRecord.runId);
            await maybeSaveResumeSnapshot(true);
        };
        const describeBudget = (evaluation: RunBudgetEvaluation): string => {
            const u = evaluation.usage;
            const l = evaluation.limits;
            const h = evaluation.hardLimits;
            return `model calls ${u.modelCalls}/${l.modelCalls} (hard ${h.modelCalls}), wall time ${Math.ceil(u.wallTimeMs / 60_000)}/${Math.ceil(l.wallTimeMs / 60_000)} min (hard ${Math.ceil(h.wallTimeMs / 60_000)}), uncached input ${u.uncachedInputTokens}/${l.uncachedInputTokens} tokens (hard ${h.uncachedInputTokens})`;
        };

        // Global tool call counter for timeline step indexing (Phase 4)
        let globalToolCallIndex = 0;
        const recoverSlimOutputBudget = (reason: 'thinking' | 'length'): boolean => {
            if (options?.useSlimPrompt !== true) return false;
            if (!recoveryCoordinator.claim('output_truncated')) return false;
            messages.push({
                role: 'user',
                content: reason === 'thinking'
                    ? '[SYSTEM] Sub-agent reasoning exceeded the bounded thinking budget before a tool step completed. Stop extended reasoning now. If the task is still actionable, emit exactly one bounded structured tool call next; for localisation writes use write_localisation only. If the requested work is already done, return a concise final summary. If neither is safe, return BLOCKED_FOR_ORCHESTRATOR.'
                    : '[SYSTEM] Sub-agent output hit the bounded max_tokens limit. Do not continue a long explanation or a large patch. Continue with one smaller structured tool call now; for localisation writes use write_localisation only. If the requested work is already done, return a concise final summary. If neither is safe, return BLOCKED_FOR_ORCHESTRATOR.',
            });
            return true;
        };
        const stopForSlimOutputBudget = () =>
            'BLOCKED_FOR_ORCHESTRATOR:\n- Sub-agent output exceeded its bounded thinking/output budget before it could complete a safe concise step. The parent agent should narrow the task or retry with a concise/non-thinking model.';

        while (iteration < maxToolIterations) {
            options?.abortSignal?.throwIfAborted();
            const budgetEvaluation = budgetTracker.evaluate(
                tokenAccumulator?.apiCalls ?? iteration,
                tokenAccumulator?.netInput ?? 0,
            );
            if (budgetEvaluation.state !== 'within') {
                const detail = describeBudget(budgetEvaluation);
                if (budgetEvaluation.state === 'hard') {
                    emitStep({
                        type: 'error',
                        content: `Emergency Agent runtime budget reached (${detail}).`,
                        timestamp: Date.now(),
                    });
                    await saveRetainedResumeSnapshot();
                    return `The emergency runtime budget was reached (${detail}). Progress is checkpointed; review the current evidence before continuing.`;
                }
                const hasHealthySubAgentActivity = shouldAutoExtendSubAgentBudget({
                    isSubAgent: isSlimRun,
                    iteration,
                    lastExtendedIteration: lastExtendedActivityIteration,
                    consecutiveErrors: consecutiveErrorCount,
                    blockingValidationIssues: blockingValidationIssues.size,
                });
                if (shouldAutoExtendRunBudget({
                    progressRevision,
                    lastExtendedProgressRevision,
                    consecutiveErrors: consecutiveErrorCount,
                    blockingValidationIssues: blockingValidationIssues.size,
                }) || hasHealthySubAgentActivity) {
                    await maybeSaveResumeSnapshot(true);
                    budgetTracker.extend();
                    lastExtendedProgressRevision = progressRevision;
                    lastExtendedActivityIteration = iteration;
                    emitStep({
                        type: 'validation',
                        content: `Agent runtime soft budget reached with healthy ${hasHealthySubAgentActivity ? 'sub-agent activity' : 'durable progress'} (${detail}). Checkpoint saved; continuing automatically for one additional budget window.`,
                        timestamp: Date.now(),
                    });
                } else {
                    emitStep({
                        type: 'validation',
                        content: `Agent runtime soft budget reached (${detail}). Waiting for explicit continuation approval.`,
                        timestamp: Date.now(),
                    });
                    const approved = options?.onPermissionRequest
                        ? await options.onPermissionRequest(
                            `run_budget_${runRecord.runId}_${iteration}`,
                            'continue_agent_run',
                            `The Agent reached its soft runtime budget (${detail}). Continue for one additional budget window?\nAgent 已达到软运行预算（${detail}）。是否继续一个预算窗口？`,
                            undefined,
                            agentToolContext,
                        )
                        : false;
                    if (!approved) {
                        await saveRetainedResumeSnapshot();
                        return `The Agent paused at its soft runtime budget (${detail}). Progress is checkpointed; continue the task to resume.`;
                    }
                    budgetTracker.extend();
                    lastExtendedProgressRevision = progressRevision;
                    lastExtendedActivityIteration = iteration;
                }
            }
            if (options?.tokenBudget && tokenAccumulator && tokenAccumulator.total >= options.tokenBudget) {
                emitStep({
                    type: 'error',
                    content: `Durable goal token budget reached (${tokenAccumulator.total}/${options.tokenBudget}).`,
                    timestamp: Date.now(),
                });
                await saveRetainedResumeSnapshot();
                return `The durable goal token budget was reached (${tokenAccumulator.total}/${options.tokenBudget}). Progress is checkpointed; increase the goal budget or continue in a new turn.`;
            }
            iteration++;
            if (runMetrics) runMetrics.iterations = iteration;

            let toolCalls: ToolCall[] | undefined = undefined;
            let needsHashValidation = false;
            let softLoopGuidancePending = false;
            let loopGuardedCallIndices: number[] = [];
            const modelCallId = `model_${runRecord.runId}_${iteration}`;
            const streamedToolPreviewIds = new Set<string>();
            const previewInvocationByModelToolCallId = new Map<string, string>();
            const previewInvocationByToolIndex = new Map<number, string>();
            let streamedToolPreviewSequence = 0;

            const restoredRetry = iteration === 1
                ? restoredStepRequests.find((request): request is RetryStepRequest => isRetryStepRequest(request))
                : undefined;
            if (restoredRetry && restoredRetry.payload.pendingToolCalls.length > 0) {
                toolCalls = restoredRetry.payload.pendingToolCalls;
                emitStep({
                    type: 'thinking',
                    content: aiText(
                        'Restoring and re-approving sensitive interactive operations left from the previous session...',
                        '正在恢复并重新审批上一次会话遗留的敏感交互操作...',
                    ),
                    timestamp: Date.now(),
                });
            } else {

                const pendingInputs = options?.inputQueue?.drain() ?? [];
                if (pendingInputs.length > 0) {
                    for (const input of pendingInputs) {
                        const content: ChatMessage['content'] = input.images && input.images.length > 0
                            ? [
                                { type: 'text' as const, text: `[User steering input queued during run]\n${input.message}` },
                                ...input.images.map(url => ({
                                    type: 'image_url' as const,
                                    image_url: { url, detail: 'auto' as const },
                                })),
                            ]
                            : `[User steering input queued during run]\n${input.message}`;
                        messages.push({
                            role: 'user',
                            content,
                        });
                        options?.runEventSink?.appendSoon('input_injected', {
                            inputId: input.id,
                            clientUserMessageId: input.clientUserMessageId,
                            size: input.message.length,
                            imageCount: input.images?.length ?? 0,
                            preview: input.message.slice(0, 240),
                        }, { status: 'done' });
                    }
                    emitStep({
                        type: 'thinking',
                        content: aiText(
                            `Injected ${pendingInputs.length} queued user input message(s) into the next model step.`,
                            `已将 ${pendingInputs.length} 条排队用户输入注入下一次模型步骤。`,
                        ),
                        timestamp: Date.now(),
                    });
                }

            // Batch 2.3: Periodic checkpoint save for crash recovery
            if (iteration > 1 && iteration % CHECKPOINT_INTERVAL === 0) {
                void this.saveCheckpoint(
                    iteration,
                    messages,
                    Array.from(confirmedWrittenFiles),
                    options?.topicId,
                    options?.agentId,
                );
            }

            // ── Mid-loop compaction: prevent uncontrolled context growth ──────
            // Every MID_LOOP_COMPACTION_INTERVAL iterations, estimate message size
            // and compact if approaching the context window limit.
            if (iteration > 1 && (iteration - 1) % MID_LOOP_COMPACTION_INTERVAL === 0) {
                const activeToolSchemaTokens = estimateTokenCount(JSON.stringify(availableTools));
                const loopTokens = calibrateLoopEstimate(messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0)
                    + activeToolSchemaTokens);
                const loopCostGate = runBudgetConfig.get<boolean>('compactionCostGate.enabled', true) ? {
                    contextLimitTokens: contextLimit,
                    inputPriceCnyPerMillion: getCurrentModelPricing(options?.model ?? _config0.model ?? '', _providerId0)[0],
                    recentHitRatio: this.cacheHitRatio(_providerId0, options?.model ?? _config0.model),
                    warmHitRatio: COST_GATE_WARM_HIT_RATIO,
                    minUsageRatio: COST_GATE_MIN_USAGE_RATIO,
                    maxUncachedCostCny: Math.max(0.001, runBudgetConfig
                        .get<number>('compactionCostGate.maxUncachedCostCnyPerRequest', 0.05)),
                } : undefined;
                if (loopTokens > midLoopThreshold || shouldCompactEarlyForCost(loopTokens, loopCostGate)) {
                    emitStep({
                        type: 'compaction',
                        content: AGENT.COMPACTION_MID_LOOP(loopTokens, midLoopThreshold),
                        timestamp: Date.now(),
                        compactionInfo: {
                            state: 'start',
                            kind: 'mid_loop',
                            beforeTokens: loopTokens,
                            thresholdTokens: midLoopThreshold,
                        },
                    });
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'compaction_start',
                        { kind: 'mid_loop', beforeTokens: loopTokens, threshold: midLoopThreshold },
                        { status: 'running' }
                    );
                    const midLoopMaintenance = runContextMaintenance(messages, 'mid_loop', {
                        toolResultBudget,
                        compactionOptions,
                        extraTokens: activeToolSchemaTokens,
                        calibrateEstimate: calibrateLoopEstimate,
                        summarizeThreshold: midLoopThreshold,
                        ineffectivenessGate: true,
                        costGate: loopCostGate,
                    });
                    refreshLiveVsCodeContext(messages);
                    let afterTokens = midLoopMaintenance.afterTokens;
                    if (midLoopMaintenance.action === 'summarize') {
                        messages = await this.maybeCompactHistory(
                            messages,
                            emitStep,
                            options,
                            tokenAccumulator,
                            { reservedTokens: activeToolSchemaTokens + configuredReservedTokens, force: true },
                        );
                        refreshLiveVsCodeContext(messages);
                        afterTokens = calibrateLoopEstimate(messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0)
                            + activeToolSchemaTokens);
                    }
                    const ineffectiveCompaction = afterTokens > midLoopThreshold
                        && afterTokens >= loopTokens * 0.95;
                    const compactionClaim = ineffectiveCompaction
                        ? recoveryCoordinator.claim('compaction_ineffective')
                        : undefined;
                    const compactionBudgetExhausted = ineffectiveCompaction && !compactionClaim;
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'compaction_end',
                        { kind: 'mid_loop', success: true, beforeTokens: loopTokens, afterTokens },
                        { status: 'done' }
                    );
                    emitStep({
                        type: 'compaction',
                        content: compactionBudgetExhausted
                            ? AGENT.COMPACTION_THRASHING
                            : AGENT.COMPACTION_PHASE_DONE(loopTokens, afterTokens),
                        timestamp: Date.now(),
                        compactionInfo: {
                            state: compactionBudgetExhausted ? 'failed' : 'complete',
                            kind: 'mid_loop',
                            beforeTokens: loopTokens,
                            afterTokens,
                            thresholdTokens: midLoopThreshold,
                        },
                    });
                    if (compactionBudgetExhausted) {
                        emitStep({
                            type: 'error',
                            content: AGENT.COMPACTION_THRASHING,
                            timestamp: Date.now(),
                        });
                        updateFinalPromptMetric();
                        return '[Agent Execution Terminated]: Context compaction remained ineffective and the shared recovery budget is exhausted.';
                    }
                }
            }

            const announcedPaths = new Set<string>();

            const tryAnnouncePath = (name: string, content: string) => {
                if (!WRITE_TOOLS.has(name)) return;
                const matches = content.matchAll(/"(file|filePath|TargetFile|targetRelativePath)"\s*:\s*"([^"]+)"/g);
                for (const match of matches) {
                    const extractedPath = match[2];
                    if (!extractedPath) continue;
                    if (!announcedPaths.has(extractedPath)) {
                        announcedPaths.add(extractedPath);
                        emitStep({
                            type: 'text_delta',
                            content: AGENT.FILE_LOCKING(extractedPath),
                            timestamp: Date.now()
                        });
                    }
                }
            };
            
            let dsmlToolNameBuf = '';
            let dsmlArgsBuf = '';
            let isInsideDsml = false;

            const modelWaitStartedAt = Date.now();
            let modelHeartbeatId: ReturnType<typeof setInterval> | undefined;
            if (options?.onStep) {
                modelHeartbeatId = setInterval(() => {
                    const elapsedSec = Math.max(1, Math.round((Date.now() - modelWaitStartedAt) / 1000));
                    emitStep({
                        type: 'orchestrator_progress',
                        content: aiText(`Waiting for model response (${elapsedSec}s)...`, `正在等待模型返回 (${elapsedSec}s)...`),
                        timestamp: Date.now(),
                    });
                }, 30_000);
            }

            let response;
            let lastModelDeltaEventAt = 0;
            let streamedThinkingChars = 0;
            let slimThinkingBudgetExceeded = false;
            const modelAbortController = new AbortController();
            const thinkingRepetitionDetector = new OutputRepetitionDetector();
            const textRepetitionDetector = new OutputRepetitionDetector();
            let outputRepetition: { kind: 'reasoning' | 'response'; match: OutputRepetitionMatch } | undefined;
            const stopRepeatedOutput = (kind: 'reasoning' | 'response', match: OutputRepetitionMatch) => {
                if (outputRepetition) return;
                outputRepetition = { kind, match };
                modelAbortController.abort(new Error(`Repeated ${kind} output detected.`));
            };
            const parentAbortSignal = options?.abortSignal;
            const abortModelFromParent = () => modelAbortController.abort(parentAbortSignal?.reason);
            if (parentAbortSignal?.aborted) {
                abortModelFromParent();
            } else {
                parentAbortSignal?.addEventListener('abort', abortModelFromParent, { once: true });
            }
            const activeProviderConfig = this.aiService.getConfig();
            const requestPlan = prepareModelRequest({
                messages,
                tools: availableTools,
                providerId: options?.providerId ?? activeProviderConfig.provider,
                model: options?.model ?? activeProviderConfig.model,
                desiredOutputTokens: desiredRunOutputTokens,
                contextLimit,
                reservedTokens: configuredReservedTokens,
                calibrateEstimate: calibrateLoopEstimate,
                slim: options?.useSlimPrompt === true,
                mode,
            });
            const requestProviderId = requestPlan.providerId;
            const requestModel = requestPlan.model;
            const activeToolSchemaTokens = requestPlan.toolSchemaTokens;
            const requestMaxTokens = requestPlan.maxTokens;
            const requestDisableThinking = requestPlan.disableThinking;
            const appendModelDeltaEvent = (kind: string, text: string) => {
                const now = Date.now();
                if (now - lastModelDeltaEventAt < 1000) return;
                lastModelDeltaEventAt = now;
                runLedger.appendEvent(
                    runRecord.runId,
                    'model_call_delta',
                    { iteration, kind, preview: text.substring(0, 240), size: text.length },
                    { invocationId: modelCallId, status: 'running' }
                ).catch(error => {
                    reportBestEffortFailure('ledger.append_model_delta', { runId: runRecord.runId, kind }, error);
                });
            };
            const requestArtifact = await archiveModelRequest(
                modelCallId,
                {
                    runId: runRecord.runId,
                    invocationId: modelCallId,
                    iteration,
                    mode,
                    providerId: requestProviderId,
                    model: requestModel,
                    options: {
                        maxTokens: requestMaxTokens,
                        disableThinking: requestDisableThinking,
                        useSlimPrompt: options?.useSlimPrompt === true,
                        workflowId: options?.workflowId,
                        replayOf: options?.replayOf,
                    },
                },
                messages,
                availableTools,
            ).catch(error => {
                ErrorReporter.warn('AgentRunner', `Failed to archive model request ${modelCallId}`, error);
                return undefined;
            });
            await runLedger.appendEvent(
                runRecord.runId,
                'model_call_start',
                {
                    iteration,
                    providerId: requestProviderId,
                    model: requestModel,
                    messageCount: messages.length,
                    toolCount: availableTools.length,
                    toolSchemaEstimateTokens: requestPlan.toolSchemaTokens,
                    dynamicallyDisclosedToolCount: disclosureContext.loaded.size,
                    requestRef: requestArtifact?.ref,
                    requestSha256: requestArtifact?.sha256,
                },
                { invocationId: modelCallId, status: 'running' }
            );
            let fallbackFromError: string | undefined;
            try {
                if (tokenAccumulator) {
                    tokenAccumulator.apiCalls = (tokenAccumulator.apiCalls ?? 0) + 1;
                }
                runtimeFaultInjector.setEnabled(vs.workspace
                    .getConfiguration('stellarisLanguageServices.ai.developer')
                    .get<boolean>('faultInjection', false));
                await runtimeFaultInjector.hit('before_model', modelAbortController.signal);
                response = await this.aiService.chatCompletion(messages, {
                    tools: availableTools,
                    providerId: options?.providerId,
                    model: options?.model,
                    reasoningEffort: options?.reasoningEffort,
                    maxTokens: requestMaxTokens,
                    disableThinking: requestDisableThinking,
                    promptCacheKey: options?.threadId ? `agent-thread:${options.threadId}` : undefined,
                    // Key fix: propagate abort signal to HTTP request layer
                    // The absence of this parameter will cause the child agent to wait for the LLM streaming response
                    // Cannot be interrupted at all by the parent's cancelGeneration/abort
                    abortSignal: modelAbortController.signal,
                    // Stream thinking tokens to UI in real-time (OpenCode-style)
                    onThinking: options?.streaming ? (text) => {
                        if (
                            options?.useSlimPrompt === true
                            && !slimThinkingBudgetExceeded
                            && streamedThinkingChars + text.length > SLIM_SUB_AGENT_THINKING_CHAR_LIMIT
                        ) {
                            slimThinkingBudgetExceeded = true;
                            emitStep({
                                type: 'validation',
                                content: 'Sub-agent thinking budget reached; stopping this oversized model response and retrying with one bounded step.',
                                timestamp: Date.now(),
                            });
                            modelAbortController.abort(new Error('Slim sub-agent thinking budget exceeded.'));
                            return;
                        }
                        const repetition = thinkingRepetitionDetector.append(text);
                        if (repetition) {
                            stopRepeatedOutput('reasoning', repetition);
                            return;
                        }
                        streamedThinkingChars += text.length;
                        appendModelDeltaEvent('thinking', text);
                        emitStep({
                            type: 'thinking_content',
                            content: text,
                            timestamp: Date.now(),
                        });
                    } : undefined,
                    // Stream text content tokens for typewriter effect
                    onTextDelta: options?.streaming ? (text) => {
                        const repetition = textRepetitionDetector.append(text);
                        if (repetition) {
                            stopRepeatedOutput('response', repetition);
                            return;
                        }
                        appendModelDeltaEvent('text', text);
                        if (text.includes('<tool_call>')) isInsideDsml = true;
                        if (text.includes('</tool_call>')) {
                            isInsideDsml = false;
                            dsmlToolNameBuf = '';
                            dsmlArgsBuf = '';
                        }
                        if (isInsideDsml) {
                            dsmlArgsBuf += text;
                            if (!dsmlToolNameBuf) {
                                const nameMatch = dsmlArgsBuf.match(/"name"\s*:\s*"([^"]+)"/);
                                if (nameMatch && nameMatch[1]) dsmlToolNameBuf = nameMatch[1];
                            }
                            if (dsmlToolNameBuf) tryAnnouncePath(dsmlToolNameBuf, dsmlArgsBuf);
                        }

                        emitStep({
                            type: 'text_delta',
                            content: text,
                            timestamp: Date.now(),
                        });
                    } : undefined,
                    onToolCallDelta: (toolName, argsBuf, metadata) => {
                        const previewKey = metadata?.id
                            ? `id:${metadata.id}`
                            : metadata?.index !== undefined
                                ? `index:${metadata.index}`
                                : '';
                        if (toolName && previewKey && !streamedToolPreviewIds.has(previewKey)) {
                            streamedToolPreviewIds.add(previewKey);
                            const invocationId = `preview_${modelCallId}_${++streamedToolPreviewSequence}`;
                            if (metadata?.id) previewInvocationByModelToolCallId.set(metadata.id, invocationId);
                            if (metadata?.index !== undefined) previewInvocationByToolIndex.set(metadata.index, invocationId);
                            emitStep({
                                type: 'tool_call',
                                content: aiText(`Preparing tool call: ${toolName}`, `正在准备工具调用：${toolName}`),
                                toolName,
                                toolArgs: {},
                                invocationId,
                                streamingPreview: true,
                                timestamp: Date.now(),
                            });
                        }
                        tryAnnouncePath(toolName, argsBuf);
                    }
                });
                await runtimeFaultInjector.hit('after_model', modelAbortController.signal);
            } catch (err: unknown) {
                const estimatedMessageTokens = messages.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0);
                const recoveryError = recoveryCoordinator.classify(err, {
                    estimatedTokens: estimatedMessageTokens,
                    contextLimit,
                });
                const errorText = recoveryError.message;
                if (recoveryError.kind === 'cancelled') throw recoveryError.cause;
                const overflowClaim = recoveryError.kind === 'context_overflow'
                    ? recoveryCoordinator.claim('context_overflow')
                    : undefined;
                if (overflowClaim) {
                    const activeSchemaTokens = estimateTokenCount(JSON.stringify(availableTools));
                    const estimatedTokens = messages.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0)
                        + activeSchemaTokens;
                    const observedLimit = contextLimitTracker.observeOverflow(
                        requestProviderId,
                        requestModel,
                        estimatedTokens,
                    );
                    await runLedger.appendEvent(runRecord.runId, 'context_limit_observed', {
                        iteration,
                        providerId: requestProviderId,
                        model: requestModel,
                        estimatedTokens,
                        observedLimit,
                    }, { invocationId: modelCallId, status: 'failed' });
                    await runLedger.appendEvent(runRecord.runId, 'compaction_retry', {
                        iteration,
                        attempt: overflowClaim.attempt,
                        totalAttempt: overflowClaim.totalAttempt,
                        reason: errorText,
                    }, { invocationId: modelCallId, status: 'running' });
                    // Provider-reported overflow is authoritative: free-prune only
                    // to shrink the summarizer input, then always summarize.
                    runContextMaintenance(messages, 'overflow', {
                        toolResultBudget,
                        compactionOptions,
                        extraTokens: activeSchemaTokens,
                        calibrateEstimate: calibrateLoopEstimate,
                        summarizeThreshold: 0,
                    });
                    refreshLiveVsCodeContext(messages);
                    messages = await this.maybeCompactHistory(
                        messages,
                        emitStep,
                        options,
                        tokenAccumulator,
                        { reservedTokens: activeSchemaTokens + configuredReservedTokens, force: true },
                    );
                    continue;
                }
                if (outputRepetition) {
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'model_call_end',
                        {
                            iteration,
                            success: false,
                            error: 'Repeated streaming output detected.',
                            repetition: outputRepetition,
                        },
                        { invocationId: modelCallId, status: 'failed' }
                    );
                    const repetitionClaim = recoveryCoordinator.claim('output_repetition');
                    if (repetitionClaim) {
                        emitStep({
                            type: 'validation',
                            content: AGENT.OUTPUT_REPETITION_RETRY(outputRepetition.kind, outputRepetition.match.cycleChars),
                            timestamp: Date.now(),
                        });
                        messages.push({
                            role: 'user',
                            content: '[SYSTEM] Your previous stream entered an exact repeated-output cycle and was stopped. Do not restate the abandoned reasoning. Re-evaluate from the latest verified state, then either make one concrete tool call or return one concise final answer. If context is insufficient, say what is missing instead of repeating.',
                        });
                        continue;
                    }
                    emitStep({
                        type: 'error',
                        content: AGENT.OUTPUT_REPETITION_STOP(outputRepetition.kind),
                        timestamp: Date.now(),
                    });
                    return '[Agent Execution Terminated]: Repeated model output was detected twice; generation stopped safely.';
                }
                if (slimThinkingBudgetExceeded) {
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'model_call_end',
                        { iteration, success: false, error: 'Slim sub-agent thinking budget exceeded.' },
                        { invocationId: modelCallId, status: 'failed' }
                    );
                    if (recoverSlimOutputBudget('thinking')) {
                        continue;
                    }
                    return stopForSlimOutputBudget();
                }
                const rateLimitClaim = recoveryError.kind === 'rate_limit'
                    ? recoveryCoordinator.claim('rate_limit')
                    : undefined;
                if (rateLimitClaim) {
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'model_call_end',
                        {
                            iteration,
                            success: false,
                            error: recoveryError.message,
                            recoveryKind: recoveryError.kind,
                            attempt: rateLimitClaim.attempt,
                            totalAttempt: rateLimitClaim.totalAttempt,
                        },
                        { invocationId: modelCallId, status: 'failed' },
                    );
                    emitStep({
                        type: 'validation',
                        content: 'Provider rate limit reached; retrying once under the shared recovery budget.',
                        timestamp: Date.now(),
                    });
                    await new Promise(resolve => setTimeout(resolve, 1_000));
                    options?.abortSignal?.throwIfAborted();
                    continue;
                }
                const transportClaim = recoveryError.kind === 'transport'
                    ? recoveryCoordinator.claim('transport')
                    : undefined;
                if (transportClaim) {
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'model_call_end',
                        {
                            iteration,
                            success: false,
                            error: recoveryError.message,
                            recoveryKind: recoveryError.kind,
                            attempt: transportClaim.attempt,
                            totalAttempt: transportClaim.totalAttempt,
                        },
                        { invocationId: modelCallId, status: 'failed' }
                    );
                    emitStep({
                        type: 'error',
                        content: aiText(
                            `Server connection dropped unexpectedly (${recoveryError.message}). This usually means the output exceeded a hard limit. Triggering chunked recovery...`,
                            `服务端异常断开 (${recoveryError.message}). 这通常是因为输出超出物理上限。自动触发切片恢复...`,
                        ),
                        timestamp: Date.now(),
                    });
                    messages.push({
                        role: 'user',
                        content: `[SYSTEM] Your previous response was forcefully terminated by the API server (likely due to hard length limits or timeout). Please DO NOT output massive text blocks, and DO NOT use write_file for files over 150 lines. Break your task into small steps using edit_file or replace_lines.`
                    });
                    continue;
                }
                const fallbackEligible = recoveryError.kind === 'transport'
                    || recoveryError.kind === 'rate_limit'
                    || recoveryError.kind === 'provider';
                const fallbackClaim = fallbackEligible
                    ? recoveryCoordinator.claim('provider_fallback')
                    : undefined;
                if (fallbackClaim) {
                    const fallbackResponse = await this.tryFallbackProvider(
                        messages,
                        _providerId0,
                        {
                            tools: availableTools,
                            onAttempt: () => {
                                if (!tokenAccumulator) return;
                                tokenAccumulator.apiCalls = (tokenAccumulator.apiCalls ?? 0) + 1;
                                tokenAccumulator.fallbackCalls = (tokenAccumulator.fallbackCalls ?? 0) + 1;
                            },
                        },
                        emitStep
                    );
                    if (fallbackResponse) {
                        response = fallbackResponse;
                        fallbackFromError = err instanceof Error ? err.message : String(err);
                        // Fall through to normal processing below
                    } else {
                        await runLedger.appendEvent(
                            runRecord.runId,
                            'model_call_end',
                            { iteration, success: false, error: err instanceof Error ? err.message : String(err) },
                            { invocationId: modelCallId, status: 'failed' }
                        );
                        throw err; // All fallbacks exhausted
                    }
                } else {
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'model_call_end',
                        { iteration, success: false, error: err instanceof Error ? err.message : String(err) },
                        { invocationId: modelCallId, status: 'failed' }
                    );
                    throw err;
                }
            } finally {
                if (modelHeartbeatId) clearInterval(modelHeartbeatId);
                parentAbortSignal?.removeEventListener('abort', abortModelFromParent);
            }

            await runLedger.appendEvent(
                runRecord.runId,
                'model_call_end',
                {
                    iteration,
                    success: true,
                    model: response.model,
                    usage: response.usage,
                    finishReason: response.choices?.[0]?.finish_reason,
                    fallbackFromError
                },
                { invocationId: modelCallId, status: 'done' }
            );

            // Accumulate token usage from this API call
            if (tokenAccumulator) {
                let promptTokens = response.usage?.prompt_tokens;
                let completionTokens = response.usage?.completion_tokens;

                // Fallback to estimation if API did not return usage stats (e.g. streaming without stream_options)
                if (promptTokens === undefined || completionTokens === undefined) {
                    promptTokens = promptTokens ?? messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0);
                    const assistantContentStr = response.choices[0]?.message ? contentToString(response.choices[0].message.content) : '';
                    completionTokens = completionTokens ?? estimateTokenCount(assistantContentStr);
                }
                const totalTokens = response.usage?.total_tokens ?? (promptTokens + completionTokens);

                const responseProviderId = (response as any).__providerId ?? options?.providerId ?? activeProviderConfig.provider;
                // P0 design 3: feed the real-usage calibration table. Only a real
                // prompt_tokens counts (the estimation fallback above would be
                // self-referential). Estimate side mirrors the decision paths.
                if (
                    response.usage?.prompt_tokens !== undefined
                    && response.usage.prompt_tokens > 0
                    && this.tokenCalibration
                    && !hasImageContent(messages)
                ) {
                    const calibrationEstimate = messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0)
                        + estimateTokenCount(JSON.stringify(availableTools));
                    this.tokenCalibration.record(
                        this.calibrationKeyFor(responseProviderId, response.model ?? options?.model ?? ''),
                        calibrationEstimate,
                        response.usage.prompt_tokens,
                    );
                }
                const pricing = getCurrentModelPricing(response.model ?? options?.model ?? '', responseProviderId);
                 // Cache-aware cost calculation: cached tokens billed at discounted rate
                const cachedTokens = Math.min(promptTokens, getCachedInputTokens(response.usage));
                const uncachedInputTokens = Math.max(0, promptTokens - cachedTokens);
                this.recordCacheEvidence(
                    responseProviderId,
                    response.model ?? options?.model,
                    promptTokens,
                    cachedTokens,
                );
                const cacheDiscount = getCacheDiscountFactor(response.model ?? options?.model ?? '', responseProviderId);
                const cachedCost = (cachedTokens / 1_000_000) * pricing[0] * cacheDiscount;
                const uncachedCost = (uncachedInputTokens / 1_000_000) * pricing[0];
                const outputCost = (completionTokens / 1_000_000) * pricing[1];

                tokenAccumulator.input += promptTokens;
                tokenAccumulator.output += completionTokens;
                tokenAccumulator.total += totalTokens;
                tokenAccumulator.estimatedCostCny += cachedCost + uncachedCost + outputCost;
                tokenAccumulator.cachedTokens = (tokenAccumulator.cachedTokens ?? 0) + cachedTokens;
                tokenAccumulator.netInput = (tokenAccumulator.netInput ?? 0) + uncachedInputTokens;
                tokenAccumulator.netTotal = (tokenAccumulator.netTotal ?? 0) + uncachedInputTokens + completionTokens;
                tokenAccumulator.contextWindowTokens = promptTokens;
                // Accumulate cache savings: difference between full-price and discounted cost for cached tokens
                const thisSaved = (cachedTokens / 1_000_000) * pricing[0] * (1 - cacheDiscount);
                tokenAccumulator.cacheSavedCostCny = (tokenAccumulator.cacheSavedCostCny ?? 0) + thisSaved;

                const systemPrefix = messages
                    .filter(message => message.role === 'system')
                    .map(message => contentToString(message.content))
                    .join('\n\u0000');
                const requestPromptFingerprint = sha256Text([
                    tokenAccumulator.promptFingerprint ?? sha256Text(systemPrefix),
                    mode,
                    toolFocus ?? 'full',
                    hashToolDefinitionsForFingerprint(availableTools),
                ].join('|')).slice(0, 24);
                const firstReasoningSample = !(tokenAccumulator.cacheRequests ?? [])
                    .some(sample => sample.purpose === 'reasoning' || sample.purpose === 'fallback');
                this.appendProviderCacheSample(tokenAccumulator, {
                    provider: responseProviderId,
                    model: response.model ?? options?.model ?? 'unknown',
                    inputTokens: promptTokens,
                    cachedTokens,
                    toolFocus,
                    purpose: fallbackFromError ? 'fallback' : 'reasoning',
                    promptFingerprint: requestPromptFingerprint,
                    invalidationReason: firstReasoningSample ? tokenAccumulator.promptCacheMissReason : undefined,
                });

                // Emit cache hit rate, cache creation, and saved costs for real-time auditing in the UI
                const cacheCreationTokens = getCacheCreationInputTokens(response.usage, promptTokens, cachedTokens);
                if (cachedTokens > 0 || cacheCreationTokens > 0) {
                    const hitRate = promptTokens > 0 ? Math.min(1, cachedTokens / promptTokens) : 0;
                    const savedCostCny = (cachedTokens / 1_000_000) * pricing[0] * (1 - cacheDiscount);
                    
                    emitStep({
                        type: 'cache_stats',
                        content: `Prefix Cache: Hit ${cachedTokens} tokens (${(hitRate * 100).toFixed(1)}% hit), Created ${cacheCreationTokens} tokens. Saved approx. ¥${savedCostCny.toFixed(4)}.`,
                        timestamp: Date.now(),
                        agentId: options?.sandbox?.agentId,
                        cacheStats: {
                            cachedTokens,
                            totalTokens: promptTokens,
                            hitRate,
                            savedCostCny,
                            cacheCreationTokens
                        }
                    });
                    runLedger.appendEvent(runRecord.runId, 'cache_stats', {
                        providerId: options?.providerId ?? activeProviderConfig.provider,
                        model: response.model ?? options?.model ?? '',
                        inputTokens: promptTokens,
                        totalTokens: promptTokens,
                        cachedTokens,
                        cacheCreationTokens,
                        outputTokens: completionTokens,
                        hitRate,
                        savedCostCny
                    }, { agentId: options?.sandbox?.agentId }).catch(error => {
                        reportBestEffortFailure('ledger.append_cache_stats', { runId: runRecord.runId }, error);
                    });
                }
            }

            const choice = response.choices[0];
            if (!choice) throw new Error('No response from AI');

            const assistantMessage = choice.message;
            // Save raw content for DSML parsing BEFORE stripping markup
            // (assistant messages from API are always text strings, not ContentPart[])
            const rawContent = contentToString(assistantMessage.content);
            if (!options?.streaming) {
                const repetition = textRepetitionDetector.append(rawContent);
                if (repetition) {
                    const repetitionClaim = recoveryCoordinator.claim('output_repetition');
                    if (repetitionClaim) {
                        emitStep({
                            type: 'validation',
                            content: AGENT.OUTPUT_REPETITION_RETRY('response', repetition.cycleChars),
                            timestamp: Date.now(),
                        });
                        messages.push({
                            role: 'user',
                            content: '[SYSTEM] Your previous response entered an exact repeated-output cycle and was discarded. Do not restate it. Make one concrete tool call or return one concise final answer; report missing context instead of repeating.',
                        });
                        continue;
                    }
                    emitStep({
                        type: 'error',
                        content: AGENT.OUTPUT_REPETITION_STOP('response'),
                        timestamp: Date.now(),
                    });
                    return '[Agent Execution Terminated]: Repeated model output was detected twice; generation stopped safely.';
                }
            }

            // ── Extract thinking/reasoning content ──────────────────────
            // 1. reasoning field (DeepSeek-R1 / some OpenAI-compat providers);
            //    the exact field name is provider-specific, detected on the fly.
            const rawMsg = (choice as unknown as Record<string, unknown>);
            const rawMessage = rawMsg.message as Record<string, unknown> | undefined;
            const explicitReasoningKey = this.aiService.getConfig().reasoningKey;
            const reasoningField = rawMessage ? reasoningValue(rawMessage, explicitReasoningKey) : undefined;
            const reasoningKey = rawMessage ? (explicitReasoningKey || detectReasoningKey(rawMessage)) : undefined;
            // 2. <think>...</think> blocks in text (Qwen3 /think, local models)
            const thinkBlockRe = /<think>([\s\S]*?)<\/think>/gi;
            let thinkContent = reasoningField || '';
            if (!thinkContent) {
                const thinkMatches: string[] = [];
                let tm: RegExpExecArray | null;
                thinkBlockRe.lastIndex = 0;
                while ((tm = thinkBlockRe.exec(rawContent)) !== null) {
                    thinkMatches.push(tm[1]!.trim());  
                }
                thinkContent = thinkMatches.join('\n\n');
            }
            // Note: The emit of thinking_content is delayed until tool_calls are confirmed.
            // For final answers (no tool_calls), no separate emit thinking block -
            // Otherwise there will be an extra Thinking block displayed below the result after the final answer.

            // Try OpenAI-style tool_calls first, then fall back to DSML/XML parsing
            // (must happen before stripping, since strip removes the DSML tags we need)
            toolCalls = assistantMessage.tool_calls;
            if (!toolCalls || toolCalls.length === 0) {
                toolCalls = this.parseDsmlToolCalls(rawContent);
            }

            // Strip DSML/XML markup AND <think> blocks from content for clean display
            if (assistantMessage.content) {
                assistantMessage.content = this.stripThinkBlocks(
                    this.stripDsmlMarkup(contentToString(assistantMessage.content))
                );
            }

            // Add assistant response (cleaned) to conversation history.
            // Preserve the reasoning field for DeepSeek-R1 API compatibility:
            // DeepSeek requires it on ALL assistant messages when in thinking
            // mode, even if null. Without it, after several iterations the API
            // returns 400: "reasoning_content must be passed back".
            // The reasoningField was already extracted from the raw response.
            if (reasoningField !== undefined && assistantMessage.reasoning_content === undefined) {
                assistantMessage.reasoning_content = reasoningField || null;
            }
            // Remember a non-default reasoning field name so later turns replay
            // the thinking content under the field this provider actually uses.
            if (reasoningKey && reasoningKey !== DEFAULT_REASONING_KEY && assistantMessage.reasoning_key === undefined) {
                assistantMessage.reasoning_key = reasoningKey;
            }

            // ── DeepSeek API guard: ensure assistant messages always have content or tool_calls ──
            // DeepSeek (and some other OpenAI-compat providers) returns 400:
            //   "Invalid assistant message: content or tool_calls must be set"
            // when an assistant message has null/empty content AND no tool_calls.
            // This happens during truncation (finish_reason=length) when the model
            // output only thinking tokens or was mid-tool-call with no text content.
            const hasContent = assistantMessage.content && (typeof assistantMessage.content === 'string' ? assistantMessage.content.trim().length > 0 : true);
            const hasToolCalls = assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0;
            if (choice.finish_reason === 'length' && !hasContent && !hasToolCalls) {
                emitStep({
                    type: 'error',
                    content: aiText(
                        'The model exhausted its output budget before producing visible text. Compacting context and retrying with a context-safe output allowance...',
                        '模型在生成可见文本前已耗尽输出预算。正在压缩上下文，并以安全的输出额度重试...',
                    ),
                    timestamp: Date.now(),
                });
                const truncationClaim = recoveryCoordinator.claim('output_truncated');
                if (!truncationClaim) {
                    return '[Agent Execution Terminated]: The model exhausted its output limit and the shared recovery budget is unavailable.';
                }
                runContextMaintenance(messages, 'overflow', {
                    toolResultBudget,
                    compactionOptions,
                    extraTokens: activeToolSchemaTokens + configuredReservedTokens,
                    calibrateEstimate: calibrateLoopEstimate,
                    summarizeThreshold: 0,
                });
                refreshLiveVsCodeContext(messages);
                messages = await this.maybeCompactHistory(
                    messages,
                    emitStep,
                    options,
                    tokenAccumulator,
                    { reservedTokens: activeToolSchemaTokens + configuredReservedTokens, force: true },
                );
                refreshLiveVsCodeContext(messages);
                messages.push({
                    role: 'user',
                    content: '[SYSTEM] The previous response used its output budget without producing visible text. Continue from the compacted context with one concise tool call or final answer.',
                });
                continue;
            }
            if (!hasContent && !hasToolCalls) {
                assistantMessage.content = '[Response contained no text or tool call.]';
            }

            messages.push(assistantMessage);

            // Plan §8: count long-term memory usage only when the model's response
            // actually references a stored memory key (verbatim match, debounced).
            this.trackMemoryKeyReferences(
                options?.topicId,
                contentToString(assistantMessage.content),
                options?.domain ?? defaultDomainForMode(mode),
            );

            // ── M3: Length Truncation Fallback ──
            if (choice.finish_reason === 'length') {
                emitStep({
                    type: 'error',
                    content: aiText(
                        'Model output was truncated by the max_tokens limit. Triggering chunked recovery instead of treating it as a fatal parse error...',
                        '模型输出因长度限制(max_tokens)被截断。不抛出致命解析错误，自动触发切片引导...',
                    ),
                    timestamp: Date.now(),
                });
                if (recoverSlimOutputBudget('length')) {
                    continue;
                }
                if (options?.useSlimPrompt === true) {
                    return stopForSlimOutputBudget();
                }
                const truncationClaim = recoveryCoordinator.claim('output_truncated');
                if (!truncationClaim) {
                    return this.cleanFinalContent(contentToString(assistantMessage.content))
                        || '[Agent Execution Terminated]: The model reached its output limit and the shared recovery budget is unavailable.';
                }
                messages.push({
                    role: 'user',
                    content: `[SYSTEM] Your previous response was truncated by the API max_tokens length limit. Please DO NOT output massive blocks of text. Break down your modifications into smaller steps. Use todo_write to plan them, and execute a single edit_file/replace_lines per response.`
                });
                continue;
            }

            // If no tool calls (either format), we're done — the final answer is no emit thinking block
            if (!toolCalls || toolCalls.length === 0) {
                const finalDecision = decideFinalResponse({
                    content: contentToString(assistantMessage.content),
                    mode,
                    approvedPlanExecution: options?.approvedPlanExecution,
                    interactivePlanApprovalPending,
                    authorization: schedulingState.authorization,
                    executionActionObserved,
                    terminalValidation,
                });
                const { finalContent } = finalDecision;
                // The input queue is drained only at the top of each iteration,
                // so a steering message that arrives while the model is producing
                // its final answer would otherwise never be injected — the run
                // ends and the intervention is silently lost. Drain and inject it
                // here, then continue one more iteration so the model can respond
                // to the user's intervention. Interactive plan submissions stay a
                // strict approval boundary and still end the turn.
                if (!interactivePlanApprovalPending && !finalDecision.pauseForInteractivePlan) {
                    const lateInputs = options?.inputQueue?.drain() ?? [];
                    if (lateInputs.length > 0) {
                        for (const input of lateInputs) {
                            const steerContent: ChatMessage['content'] = input.images && input.images.length > 0
                                ? [
                                    { type: 'text' as const, text: `[User steering input queued during run]\n${input.message}` },
                                    ...input.images.map(url => ({
                                        type: 'image_url' as const,
                                        image_url: { url, detail: 'auto' as const },
                                    })),
                                ]
                                : `[User steering input queued during run]\n${input.message}`;
                            messages.push({ role: 'user', content: steerContent });
                            options?.runEventSink?.appendSoon('input_injected', {
                                inputId: input.id,
                                clientUserMessageId: input.clientUserMessageId,
                                size: input.message.length,
                                imageCount: input.images?.length ?? 0,
                                preview: input.message.slice(0, 240),
                            }, { status: 'done' });
                        }
                        emitStep({
                            type: 'thinking',
                            content: aiText(
                                `Injected ${lateInputs.length} queued user input message(s) into the next model step.`,
                                `已将 ${lateInputs.length} 条排队用户输入注入下一次模型步骤。`,
                            ),
                            timestamp: Date.now(),
                        });
                        continue;
                    }
                }
                if (finalDecision.continuation === 'authorized_execution') {
                    const incompleteClaim = recoveryCoordinator.claim('incomplete_execution');
                    if (incompleteClaim) {
                        messages.push({
                            role: 'user',
                            content: `<system-reminder>This task already has workspace-write authorization. `
                                + `Do not ask the user to say "execute", do not return manual edit instructions, and do not stop at evidence collection. `
                                + `Continue now with the available tools until the requested execution and verification are complete. `
                                + `Only call ask_user_question when progress requires a user-owned decision that cannot be discovered or safely defaulted.</system-reminder>`,
                        });
                        ErrorReporter.debug(
                            SOURCE.AGENT_RUNNER,
                            `Authorized execution recovery ${incompleteClaim.attempt}/${incompleteClaim.limit}.`,
                        );
                        continue;
                    }
                }
                if (finalDecision.continuation === 'truncation_stop') {
                    // The model stopped because it misread display-only tool-result
                    // truncation as partial application. Tool results are always
                    // fully applied; only the response text is shortened. Push one
                    // bounded recovery so the task continues instead of stalling.
                    const incompleteClaim = recoveryCoordinator.claim('incomplete_execution');
                    if (!incompleteClaim) return finalContent;
                    messages.push({
                        role: 'user',
                        content: `<system-reminder>Truncation markers in tool results ("truncated" / "已截断") are display-only: every tool completed and its result was fully applied; nothing is partial or unsafe. `
                            + `Continue the remaining work in smaller batches: re-query diagnostics per file with a filtered get_diagnostics, re-read exact line ranges when you need details, and keep editing until the requested result is complete and verified.</system-reminder>`,
                    });
                    ErrorReporter.debug(
                        SOURCE.AGENT_RUNNER,
                        `Truncation-stop recovery ${incompleteClaim.attempt}/${incompleteClaim.limit}.`,
                    );
                    continue;
                }
                if (finalDecision.continuation === 'validation_failed' && terminalValidation) {
                    const validationClaim = recoveryCoordinator.claim('validation_failed');
                    if (validationClaim) {
                        const feedback = formatTerminalValidationFeedback(terminalValidation);
                        messages.push({
                            role: 'user',
                            content: `<system-reminder>${feedback} Continue in this same loop: inspect the structured tool results, repair the affected targets, and obtain fresh validation before finalizing. Do not merely describe the remaining error.</system-reminder>`,
                        });
                        emitStep({
                            type: 'validation',
                            content: `Post-write validation returned to the main loop (${validationClaim.attempt}/${validationClaim.limit}).`,
                            timestamp: Date.now(),
                        });
                        continue;
                    }
                }
                return finalContent;
            }

            // ── Delay emit thinking_content: emit only when it is confirmed that there are subsequent tool_calls ──
            // This avoids redundant Thinking blocks after the final answer.
            if (thinkContent.trim() && streamedThinkingChars === 0) {
                emitStep({
                    type: 'thinking_content',
                    content: thinkContent.trim(),
                    timestamp: Date.now(),
                });
            }

            }

            if (!toolCalls) toolCalls = [];
            toolDedupe.nextStep();
            const preparedInvocations = new Map<ToolCall, ToolInvocation>();
            const newlyDisclosedToolNames = new Set<string>();
            for (const toolCall of toolCalls) {
                if (toolCall.function.name.toLowerCase() !== 'select_tools') continue;
                const invocation = buildToolInvocation({
                    runId: runRecord.runId,
                    toolCall,
                    availableTools,
                    workspaceRoot: this.toolExecutor.workspaceRoot,
                    topicId: options?.topicId,
                });
                preparedInvocations.set(toolCall, invocation);
                if (invocation.parseError) continue;
                const selectionArgs = { ...invocation.args };
                const selection = toolDisclosureService.select({
                    tools: Array.isArray(selectionArgs.tools)
                        ? selectionArgs.tools.filter((value): value is string => typeof value === 'string')
                        : undefined,
                    groups: Array.isArray(selectionArgs.groups)
                        ? selectionArgs.groups.filter((value): value is string => typeof value === 'string')
                        : undefined,
                    reason: typeof selectionArgs.reason === 'string' ? selectionArgs.reason : '',
                }, eligibleToolPool, disclosureContext, { eligibleTools: eligibleToolPool });
                selectionArgs._selectionResult = selection;
                invocation.args = selectionArgs;
                toolCall.function.arguments = JSON.stringify(selectionArgs);
                availableTools = refreshAvailableTools();
                for (const name of selection.loaded) newlyDisclosedToolNames.add(name);
                await runLedger.appendEvent(runRecord.runId, 'tool_disclosure_changed', {
                    iteration,
                    ...selection,
                    activeToolCount: availableTools.length,
                }, { invocationId: toolCall.id, status: selection.denied.length > 0 ? 'failed' : 'done' });
            }
            // ── Execute tool calls (parallel for read-only, serial for writes) ──
            // Fix #9: WRITE_TOOLS and READ_ONLY_TOOLS are now module-level constants

            // Use pre-fetched provider info from outside the loop
            const useDsmlToolRole = useDsmlToolRole0;

            const normalizedBatch = normalizeToolCallBatch({
                runId: runRecord.runId,
                toolCalls,
                availableTools,
                workspaceRoot: this.toolExecutor.workspaceRoot,
                topicId: options?.topicId,
                previewInvocationByModelToolCallId,
                previewInvocationByToolIndex,
                globalToolCallIndex,
                iteration,
                maxToolIterations,
                preparedInvocations,
                runMetrics,
                abortSignal: options?.abortSignal,
                emitStep,
            });
            const parsedCalls = normalizedBatch.calls;
            globalToolCallIndex = normalizedBatch.globalToolCallIndex;
            const lastWriteIndexByFile = findSupersededWriteIndices(parsedCalls);

            // ToolDedupeService only coalesces identical reads inside this batch;
            // cross-step stop policy belongs to the single repetition observer.
            const repetition = observeToolBatchRepetition(parsedCalls, doomLoop, runMetrics);
            loopGuardedCallIndices = repetition.guardedIndices;
            softLoopGuidancePending = repetition.softGuidancePending;
            needsHashValidation = repetition.needsHashValidation;
            if (softLoopGuidancePending) {
                emitStep({
                    type: 'validation',
                    content: 'Repeated tool-call pattern detected; prompting the agent to switch strategy.',
                    timestamp: Date.now(),
                });
            }

            const toolResults: unknown[] = new Array(parsedCalls.length);
            const toolStateResults: unknown[] = new Array(parsedCalls.length);
            const questionCallIndex = parsedCalls.findIndex(call => call.toolName === 'ask_user_question');
            const submittedPlanIndex = options?.approvedPlanExecution
                ? -1
                : parsedCalls.findIndex(call => isCompleteImplementationPlanWrite(
                    call.toolName,
                    call.toolArgs,
                    call.targetPaths,
                ));

            for (const ci of parsedCalls) {
                await runLedger.appendEvent(
                    runRecord.runId,
                    'tool_call_created',
                    { toolName: ci.toolName, toolArgs: ci.toolArgs, concurrencyClass: ci.concurrencyClass, effect: ci.effect },
                    { invocationId: ci.invocationId }
                );
            }

            for (let i = 0; i < parsedCalls.length; i++) {
                options?.abortSignal?.throwIfAborted();
                const ci = parsedCalls[i]!;
                
                // Phase 5: 子 Agent 物理沙盒安全强硬拦截
                if (options?.sandbox) {
                    const { enforceSubAgentSafety } = require('./orchestrator/subAgentSandbox');
                    const safetyCheck = enforceSubAgentSafety(options.sandbox, ci.toolName, ci.toolArgs, this.toolExecutor.workspaceRoot);
                    if (!safetyCheck.allowed) {
                        emitStep({
                            type: 'validation',
                            content: aiText(
                                `[Sub-agent sandbox hard block] ${safetyCheck.reason}`,
                                `[子 Agent 沙盒物理强拦截] ${safetyCheck.reason}`,
                            ),
                            timestamp: Date.now()
                        });
                        // B4: 结构化拒绝事件,供 reducer 投影聚合,而非只发字符串 step。
                        runLedger.appendEvent(runRecord.runId, 'subagent_refused', {
                            agentId: options.sandbox?.agentId,
                            tool: ci.toolName,
                            reason: 'SANDBOX_VIOLATION',
                            detail: safetyCheck.reason,
                            toolArgs: ci.toolArgs,
                        }).catch(error => {
                            reportBestEffortFailure('ledger.append_subagent_refusal', { runId: runRecord.runId, tool: ci.toolName }, error);
                        });
                        toolResults[i] = { success: false, error: safetyCheck.reason };
                        continue;
                    }
                }
                const { toolName, toolArgs } = ci;

                if (questionCallIndex >= 0 && parsedCalls.length > 1) {
                    const reason = 'ask_user_question must be the only tool call in a model response. Retry with only the structured question call.';
                    toolResults[i] = { success: false, error: reason };
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'tool_call_end',
                        toolResults[i],
                        { invocationId: ci.invocationId, status: 'failed' },
                    );
                    continue;
                }

                if (submittedPlanIndex >= 0
                    && parsedCalls[submittedPlanIndex]?.invocationId !== ci.invocationId
                    && isExecutionActionTool(toolName)) {
                    const reason = 'An interactive Implementation Plan was submitted in this model step. '
                        + 'Project writes, commands, and dispatch must wait for explicit user approval.';
                    emitStep({
                        type: 'validation',
                        content: reason,
                        timestamp: Date.now(),
                        invocationId: ci.invocationId,
                    });
                    toolResults[i] = { success: false, error: reason, approvalBoundaryBlocked: true };
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'tool_call_end',
                        { success: false, error: reason, approvalBoundaryBlocked: true },
                        { invocationId: ci.invocationId, status: 'failed' },
                    );
                    continue;
                }

                if (ci.toolArgsParseError) {
                    let errMsg = `Tool argument JSON parse failed — ${ci.toolArgsParseError}. Please retry with valid JSON arguments.`;
                    // Add tool-specific truncation recovery guidance
                    if (toolName === 'write_localisation') {
                        errMsg += '\n\n⚠️ Your entries array was truncated by the output length limit. Split into SMALLER batches: call write_localisation multiple times with at most 15 entries each.';
                    } else if (toolName === 'dispatch_agents') {
                        errMsg += '\n\n⚠️ Your tasks array was truncated or malformed because the prompt strings were too long. KEEP PROMPTS CONCISE. Do NOT embed massive file contents or long paths directly in the prompt. If you need to pass large data, use `set_memory` first and pass the memory key. Also, try dispatching fewer tasks at once.';
                    }
                    toolResults[i] = { ok: false, error: errMsg };
                    continue;
                }

                if (READ_ONLY_TOOLS.has(toolName)) {
                    // Collect consecutive read-only tools to batch them in parallel
                    const batchIndices: number[] = [i];
                    while (i + 1 < parsedCalls.length && READ_ONLY_TOOLS.has(parsedCalls[i + 1]!.toolName) && !parsedCalls[i + 1]!.toolArgsParseError) {
                        i++;
                        batchIndices.push(i);
                    }
                    await Promise.all(batchIndices.map(async idx => {
                        const callInfo = parsedCalls[idx]!;
                        const runReadTool = async (): Promise<ProcessedToolResult> => {
                            const releaseLock = await toolScheduler.acquireLock(callInfo.concurrencyClass, options?.abortSignal);
                            try {
                                options?.abortSignal?.throwIfAborted();
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_start', { toolName: callInfo.toolName }, { invocationId: callInfo.invocationId });
                                const rawRes = await this.executeToolPipeline(callInfo.toolName, callInfo.toolArgs, agentToolContext);
                                const processed = await this.processToolResult(
                                    callInfo.toolName,
                                    callInfo.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes,
                                    options?.providerId,
                                    options?.model,
                                );
                                await runLedger.appendEvent(
                                    runRecord.runId,
                                    'tool_call_end',
                                    this.summarizeToolResultForLedger(callInfo.toolName, processed.stateResult),
                                    { invocationId: callInfo.invocationId, status: isToolResultSuccess(processed.stateResult) ? 'done' : 'failed' },
                                );
                                return processed;
                            } finally {
                                releaseLock();
                            }
                        };
                        try {
                            const targetResourceRevision = callInfo.targetPaths.length > 0
                                ? (await Promise.all(callInfo.targetPaths.map(async targetPath => {
                                    try {
                                        const stat = await fs.promises.stat(targetPath);
                                        return `${targetPath}:${stat.size}:${stat.mtimeMs}`;
                                    } catch {
                                        return `${targetPath}:missing`;
                                    }
                                }))).join('|')
                                : agentToolContext.authoritativeProjectRevision ?? '';
                            const deduped = await toolDedupe.execute({
                                invocationId: callInfo.invocationId,
                                toolName: callInfo.toolName,
                                args: callInfo.toolArgs,
                                authorizationScope: options?.schedulingState?.authorization ?? mode,
                                targetResourceRevision,
                            }, async () => {
                                const readPaths = callInfo.targetPaths.length > 0 ? callInfo.targetPaths : [];
                                return readPaths.length > 0
                                    ? this.writeQueue.afterCurrentWrites(readPaths, runReadTool)
                                    : runReadTool();
                            });
                            toolResults[idx] = deduped.value.modelResult;
                            toolStateResults[idx] = deduped.value.stateResult;
                            if (deduped.reused) {
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_deduplicated', {
                                    toolName: callInfo.toolName,
                                    sourceInvocationId: deduped.sourceInvocationId,
                                }, { invocationId: callInfo.invocationId, status: 'done' });
                                await runLedger.appendEvent(
                                    runRecord.runId,
                                    'tool_call_end',
                                    this.summarizeToolResultForLedger(callInfo.toolName, toolStateResults[idx]),
                                    { invocationId: callInfo.invocationId, status: isToolResultSuccess(toolStateResults[idx]) ? 'done' : 'failed' },
                                );
                            }
                        } catch (e: any) {
                            if (e?.name === 'AbortError') throw e;
                            toolResults[idx] = { error: e instanceof Error ? e.message : String(e) };
                            await runLedger.appendEvent(
                                runRecord.runId,
                                'tool_call_end',
                                this.summarizeToolResultForLedger(callInfo.toolName, toolResults[idx]),
                                { invocationId: callInfo.invocationId, status: 'failed' },
                            );
                        }
                    }));
                } else {
                    if (!WRITE_TOOLS.has(toolName)) {
                        const releaseLock = await toolScheduler.acquireLock(ci.concurrencyClass, options?.abortSignal);
                        try {
                            options?.abortSignal?.throwIfAborted();
                            await runLedger.appendEvent(runRecord.runId, 'tool_call_start', { toolName: ci.toolName }, { invocationId: ci.invocationId });
                            const rawRes = await this.executeToolPipeline(toolName, toolArgs, agentToolContext);
                            const processed = await this.processToolResult(
                                toolName,
                                ci.invocationId,
                                runRecord.runId,
                                options?.topicId || 'default',
                                rawRes,
                                options?.providerId,
                                options?.model,
                            );
                            toolResults[i] = processed.modelResult;
                            toolStateResults[i] = processed.stateResult;
                            await runLedger.appendEvent(
                                runRecord.runId,
                                'tool_call_end',
                                this.summarizeToolResultForLedger(ci.toolName, processed.stateResult),
                                { invocationId: ci.invocationId, status: isToolResultSuccess(processed.stateResult) ? 'done' : 'failed' },
                            );
                        } catch (e: any) {
                            if (e?.name === 'AbortError') throw e;
                            toolResults[i] = { error: e instanceof Error ? e.message : String(e) };
                            await runLedger.appendEvent(
                                runRecord.runId,
                                'tool_call_end',
                                this.summarizeToolResultForLedger(ci.toolName, toolResults[i]),
                                { invocationId: ci.invocationId, status: 'failed' },
                            );
                        } finally {
                            releaseLock();
                        }
                        continue;
                    }

                    // Write tool: execute serially taking advantage of PartitionedWriteQueue
                    const filePaths = ci.targetPaths;
                    const primaryFilePath = filePaths[0] ?? '';
                    const shouldAutoApplyWrite = options?.forceAutoApplyWrites === true || options?.useSlimPrompt === true;
                    const isSupersededWrite = SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has(toolName) && primaryFilePath &&
                        lastWriteIndexByFile.get(primaryFilePath) !== i;

                    // Collect all file paths that this tool touches for partitioned locking.
                    // Canonical keys make relative/absolute/case aliases share one lock.
                    const lockPaths = (filePaths.length > 0 ? filePaths : ['__global__'])
                        .map(p => p === '__global__' ? p : canonicalPathKey(p, this.toolExecutor.workspaceRoot));
                    const waitTimeoutMs = options?.writeQueueWaitTimeoutMs ?? (options?.useSlimPrompt ? 60_000 : 90_000);
                    let previousFileContent: string | null | undefined;

                    try {
                        await this.writeQueue.enqueue(lockPaths, async () => {
                                const releaseLock = await toolScheduler.acquireLock(ci.concurrencyClass, options?.abortSignal);
                            try {
                                options?.abortSignal?.throwIfAborted();
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_start', { toolName: ci.toolName }, { invocationId: ci.invocationId });
                            
                            // Sub-agent snapshot isolate hook. Keep the same bounded
                            // before image locally so the durable file_change event can
                            // reconstruct line-level details after a manager reload.
                            if (primaryFilePath) {
                                try {
                                    const stat = fs.existsSync(primaryFilePath) ? fs.statSync(primaryFilePath) : undefined;
                                    previousFileContent = stat && stat.size <= 500_000
                                        ? fs.readFileSync(primaryFilePath, 'utf8')
                                        : stat ? undefined : null;
                                } catch {
                                    previousFileContent = undefined;
                                }
                                if (onFileWrite) {
                                    // Preserve the existing write-ownership hook even when
                                    // the file is too large to retain for a durable inline diff.
                                    const hookContent = previousFileContent === undefined && fs.existsSync(primaryFilePath)
                                        ? fs.readFileSync(primaryFilePath, 'utf8')
                                        : previousFileContent ?? null;
                                    onFileWrite(primaryFilePath, hookContent);
                                }
                            }

                            if (isSupersededWrite) {
                                toolResults[i] = {
                                    skipped: true,
                                    message: aiText(
                                        `Skipped because a later write to ${primaryFilePath} superseded this write`,
                                        `已被后续对 ${primaryFilePath} 的写入操作覆盖，跳过本次写入`,
                                    ),
                                };
                            } else if (toolName === 'write_file') {
                                // Brace validation is handled inside FileToolHandler via the
                                // tokenizer-based rejectUnsafePdxStructureWrite guard, which
                                // ignores braces in strings/comments and only applies to PDX
                                // extensions. The old naive character count here spuriously
                                // rejected valid PDX files (commented/quoted braces) and
                                // non-PDX content (markdown/json), telling the model to switch
                                // tools for no reason.
                                const args = (confirmedWrittenFiles.has(primaryFilePath) || shouldAutoApplyWrite) ? { ...toolArgs, _autoApply: true } : toolArgs;
                                const rawRes = await this.executeToolPipeline(toolName, args, agentToolContext);
                                const processed = await this.processToolResult(
                                    toolName,
                                    ci.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes,
                                    options?.providerId,
                                    options?.model,
                                );
                                toolResults[i] = processed.modelResult;
                                toolStateResults[i] = processed.stateResult;
                                const r = toolResultRecord(processed.stateResult);
                                if (r && (r.success || r.confirmed) && primaryFilePath) confirmedWrittenFiles.add(primaryFilePath);
                            } else if (WRITE_TOOLS.has(toolName) && primaryFilePath && (confirmedWrittenFiles.has(primaryFilePath) || shouldAutoApplyWrite)) {
                                const rawRes = await this.executeToolPipeline(toolName, { ...toolArgs, _autoApply: true }, agentToolContext);
                                const processed = await this.processToolResult(
                                    toolName,
                                    ci.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes,
                                    options?.providerId,
                                    options?.model,
                                );
                                toolResults[i] = processed.modelResult;
                                toolStateResults[i] = processed.stateResult;
                            } else {
                                const rawRes = await this.executeToolPipeline(toolName, toolArgs, agentToolContext);
                                const processed = await this.processToolResult(
                                    toolName,
                                    ci.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes,
                                    options?.providerId,
                                    options?.model,
                                );
                                toolResults[i] = processed.modelResult;
                                toolStateResults[i] = processed.stateResult;
                                if (WRITE_TOOLS.has(toolName) && primaryFilePath) {
                                    const r = toolResultRecord(processed.stateResult);
                                    if (r && (r.success || r.confirmed)) confirmedWrittenFiles.add(primaryFilePath);
                                }
                            }
                        } catch (e: any) {
                                if (e?.name === 'AbortError') throw e;
                                toolResults[i] = { error: e instanceof Error ? e.message : String(e) };
                            } finally {
                                const res = toolStateResults[i] ?? toolResults[i];
                                const success = isToolResultSuccess(res);
                                await runLedger.appendEvent(
                                    runRecord.runId,
                                    'tool_call_end',
                                    { ...this.summarizeToolResultForLedger(ci.toolName, res), success },
                                    { invocationId: ci.invocationId, status: success ? 'done' : 'failed' }
                                );
                                if (success && primaryFilePath) {
                                    const fileChange: Record<string, unknown> = { filePath: primaryFilePath };
                                    try {
                                        const existsAfter = fs.existsSync(primaryFilePath);
                                        const afterStat = existsAfter ? fs.statSync(primaryFilePath) : undefined;
                                        const currentContent = afterStat && afterStat.size <= 500_000
                                            ? fs.readFileSync(primaryFilePath, 'utf8')
                                            : afterStat ? undefined : null;
                                        if (previousFileContent !== undefined && currentContent !== undefined) {
                                            if (previousFileContent === null && currentContent !== null) {
                                                const lines = currentContent.split('\n');
                                                Object.assign(fileChange, {
                                                    status: 'created', additions: lines.length, deletions: 0,
                                                    diffPreview: `+ ${lines.length} lines added`,
                                                    diffLines: lines.slice(0, 1200).map((content, index) => ({ type: 'add', content, newLineNo: index + 1 })),
                                                });
                                            } else if (previousFileContent !== null && currentContent === null) {
                                                const lines = previousFileContent.split('\n');
                                                Object.assign(fileChange, {
                                                    status: 'deleted', additions: 0, deletions: lines.length,
                                                    diffPreview: `- ${lines.length} lines removed`,
                                                    diffLines: lines.slice(0, 1200).map((content, index) => ({ type: 'remove', content, oldLineNo: index + 1 })),
                                                });
                                            } else if (previousFileContent !== null && currentContent !== null) {
                                                const diff = computeLineDiff(previousFileContent, currentContent);
                                                Object.assign(fileChange, {
                                                    status: 'modified', additions: diff.additions, deletions: diff.deletions,
                                                    diffPreview: `+${diff.additions} -${diff.deletions}${diff.truncated ? ' (truncated)' : ''}`,
                                                    diffLines: diff.lines,
                                                });
                                            }
                                        }
                                    } catch (error) {
                                        reportBestEffortFailure('ledger.file_change_diff', { filePath: primaryFilePath }, error);
                                    }
                                    await runLedger.appendEvent(
                                        runRecord.runId,
                                        'file_change',
                                        fileChange,
                                        { invocationId: ci.invocationId }
                                    );
                                }
                                releaseLock();
                            }
                        }, {
                            waitTimeoutMs,
                            timeoutMessage: `Write queue wait timed out for ${toolName} (${lockPaths.join(', ')}) after ${Math.round(waitTimeoutMs / 1000)}s. Another write or orchestration task is holding the file lock. Report this blocker to the parent agent instead of retrying in a loop.`,
                        });
                    } catch (e) {
                        toolResults[i] = {
                            success: false,
                            error: e instanceof Error ? e.message : String(e),
                            hint: options?.useSlimPrompt
                                ? 'Sub-agent should stop retrying this write and report the blocker to the parent agent.'
                                : 'Try a smaller targeted edit after the current write finishes.',
                        };
                    }
                }
            }

            const effectiveToolResults = toolResults.map((result, index) => toolStateResults[index] ?? result);

            // ── Mutating write progress check ──
            // If a mutating tool call succeeded, clear only the pair entries that
            // reference its target files. Global clear was over-eager: writing file
            // A would silently wipe the loop signal for unrelated file B.
            const mutatedFilePaths = new Set<string>();
            let hasFilelessMutating = false;
            for (let j = 0; j < parsedCalls.length; j++) {
                const pc = parsedCalls[j]!;
                const reg = TOOL_REGISTRY.get(pc.toolName as import('./tools/registry').AgentToolName);
                if (!reg?.mutating) continue;
                const mutationResult = effectiveToolResults[j];
                if (!isToolResultSuccess(mutationResult)) continue;
                if (pc.targetPaths && pc.targetPaths.length > 0) {
                    for (const fp of pc.targetPaths) mutatedFilePaths.add(fp);
                } else {
                    // mutating without a file target (set_memory / save_memory / merge_results / git_ops 等)
                    hasFilelessMutating = true;
                }
            }
            if (mutatedFilePaths.size > 0) {
                doomLoop.clearForFiles(mutatedFilePaths);
            }
            if (hasFilelessMutating && mutatedFilePaths.size === 0) {
                // Pure fileless mutation (e.g. memory / git): no path scoping possible,
                // fall back to global clear so verify reads aren't suppressed.
                doomLoop.clearAllPairs();
            }
            if (mutatedFilePaths.size > 0 || hasFilelessMutating) {
                progressRevision++;
            }

            // ── Two-phase doom-loop detection: phase 2 (post-exec hash check) ──
            if (needsHashValidation) {
                let allHashesMatch = true;
                for (const j of loopGuardedCallIndices) {
                    const { toolName, toolArgs, targetPaths } = parsedCalls[j]!;
                    const sig = createToolCallSignature(toolName, toolArgs, targetPaths);
                    const resultHash = fnv32a(normalizeToolResultHash(toolName, effectiveToolResults[j]));
                    const prevHash = doomLoop.lastResultHash.get(sig);
                    if (prevHash !== undefined && prevHash !== resultHash) {
                        // Hash differs — meaningful progress, not a doom-loop.
                        // Reset the pair counter for this pair.
                        if (doomLoop.currentPairKey) doomLoop.pairFrequency.set(doomLoop.currentPairKey, 0);
                        allHashesMatch = false;
                    }
                    doomLoop.lastResultHash.set(sig, resultHash);
                }
                if (allHashesMatch) {
                    emitStep({
                        type: 'error',
                        content: 'Doom-loop detected: repeated tool-call signature and unchanged tool results; stopping execution.',
                        timestamp: Date.now(),
                    });
                    forceStop = true;
                }
            } else {
                // Update result hashes for future comparisons even when not flagged
                for (const j of loopGuardedCallIndices) {
                    const { toolName, toolArgs, targetPaths } = parsedCalls[j]!;
                    const sig = createToolCallSignature(toolName, toolArgs, targetPaths);
                    doomLoop.lastResultHash.set(sig, fnv32a(normalizeToolResultHash(toolName, effectiveToolResults[j])));
                }
            }

            if (forceStop) break;

            // Emit results in original order and feed back to AI
            for (let j = 0; j < parsedCalls.length; j++) {
                // Fix #10: use _prefix for intentionally unused destructured vars
                const { invocationId, toolName, toolArgs: _toolArgs, toolCall } = parsedCalls[j]!;  
                const toolResult = toolResults[j];
                const stateResult = effectiveToolResults[j];
                if (runMetrics) {
                    runMetrics.maxToolResultChars = Math.max(
                        runMetrics.maxToolResultChars,
                        measureToolResultChars(toolResult)
                    );
                }

                emitStep({
                    type: 'tool_result',
                    content: `${AGENT.TOOL_RESULT_PREFIX}: ${toolName}`,
                    toolName,
                    toolResult: compactToolResultForUi(toolResult),
                    timestamp: Date.now(),
                    invocationId,
                });

                // Track consecutive errors
                if (isToolResultFailure(stateResult)) {
                    consecutiveErrorCount++;
                    const errorLimit = bypassSandbox ? 100 : 10;
                    if (consecutiveErrorCount >= errorLimit) {
                        emitStep({ type: 'error', content: `Tool failures reached ${errorLimit}; stopping execution.`, timestamp: Date.now() });
                        forceStop = true;
                        break; // break inner for-loop; forceStop will exit the outer while
                    }
                } else {
                    consecutiveErrorCount = 0;
                }

                // Budget tool result: apply smart dedup/segmentation to prevent
                // oversized tool results from consuming the context window.
                const budgetedResult = this.budgetToolResult(toolResult, toolResultBudget);

                if (useDsmlToolRole) {
                    messages.push({
                        role: 'user',
                        content: "[Tool Result for " + toolCall.function.name + " (id=" + toolCall.id + ")]:\n" + budgetedResult,
                    });
                } else {
                    messages.push({
                        role: 'tool',
                        content: budgetedResult,
                        tool_call_id: toolCall.id,
                        name: toolName,
                    });
                }
            }

            if (newlyDisclosedToolNames.size > 0 && availableTools.some(tool => tool.function.name === 'run_code')) {
                const sdkAdditions = buildRunCodePromptAdditions(availableTools.filter(tool =>
                    newlyDisclosedToolNames.has(tool.function.name)));
                if (sdkAdditions) messages.push({ role: 'user', content: sdkAdditions });
            }

            const foldedBatch = foldToolBatchState({
                calls: parsedCalls,
                results: effectiveToolResults,
                submittedPlanIndex,
                terminalValidation,
                completedTodoCount,
                diagnosticErrorsByTarget,
                blockingValidationIssues,
            });
            progressRevision += foldedBatch.progressDelta;
            completedTodoCount = foldedBatch.completedTodoCount;
            interactivePlanApprovalPending ||= foldedBatch.interactivePlanApprovalPending;
            executionActionObserved ||= foldedBatch.executionActionObserved;

            if (interactivePlanApprovalPending) {
                return aiText(
                    'The implementation plan is ready for your review. Execution will begin only after you explicitly approve it.',
                    '实施方案已准备好，正在等待你的审阅。只有在你明确批准后才会开始执行。',
                );
            }

            // Run emergency compaction only after every tool result has been
            // appended. Compacting between an assistant tool call and its result
            // creates an invalid orphaned tool_result sequence.
            if (!forceStop) {
                const activeToolSchemaTokens = estimateTokenCount(JSON.stringify(availableTools));
                const emergencyTokens = calibrateLoopEstimate(messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0)
                    + activeToolSchemaTokens);
                if (emergencyTokens > contextLimit * 0.92) {
                    emitStep({
                        type: 'compaction',
                        content: AGENT.COMPACTION_EMERGENCY(emergencyTokens, contextLimit),
                        timestamp: Date.now(),
                        compactionInfo: {
                            state: 'start',
                            kind: 'emergency',
                            beforeTokens: emergencyTokens,
                            thresholdTokens: contextLimit,
                        },
                    });
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'compaction_start',
                        { kind: 'emergency', beforeTokens: emergencyTokens, contextLimit },
                        { status: 'running' }
                    );
                    const emergencyMaintenance = runContextMaintenance(messages, 'emergency', {
                        toolResultBudget,
                        compactionOptions,
                        extraTokens: activeToolSchemaTokens,
                        calibrateEstimate: calibrateLoopEstimate,
                        summarizeThreshold: Math.floor(contextLimit
                            * resolveCompactionRatios(_providerId0, options?.model ?? _config0.model).midLoopRatio),
                    });
                    refreshLiveVsCodeContext(messages);
                    let afterEmergencyTokens = emergencyMaintenance.afterTokens;
                    if (emergencyMaintenance.action === 'summarize') {
                        messages = await this.maybeCompactHistory(
                            messages,
                            emitStep,
                            options,
                            tokenAccumulator,
                            { reservedTokens: activeToolSchemaTokens + configuredReservedTokens, force: true },
                        );
                        refreshLiveVsCodeContext(messages);
                        afterEmergencyTokens = calibrateLoopEstimate(messages.reduce((s, m) => s + estimateChatMessageTokens(m), 0)
                            + activeToolSchemaTokens);
                    }
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'compaction_end',
                        { kind: 'emergency', success: true, beforeTokens: emergencyTokens, afterTokens: afterEmergencyTokens },
                        { status: 'done' }
                    );
                    emitStep({
                        type: 'compaction',
                        content: AGENT.COMPACTION_PHASE_DONE(emergencyTokens, afterEmergencyTokens),
                        timestamp: Date.now(),
                        compactionInfo: {
                            state: 'complete',
                            kind: 'emergency',
                            beforeTokens: emergencyTokens,
                            afterTokens: afterEmergencyTokens,
                            thresholdTokens: contextLimit,
                        },
                    });
                }
            }

            if (softLoopGuidancePending && !forceStop) {
                messages.push({
                    role: 'user',
                    content: '[SYSTEM] Repeated tool-call pattern detected. Change strategy, avoid identical arguments, narrow the next action, or answer if enough information is available.',
                });
            }

            if (options?.topicId && !forceStop) {
                await maybeSaveResumeSnapshot();
            }

            if (!forceStop && shouldRenewIterationLimit({
                renewable: options?.renewableIterationLimit === true,
                iteration,
                limit: maxToolIterations,
                consecutiveErrors: consecutiveErrorCount,
                blockingValidationIssues: blockingValidationIssues.size,
            })) {
                await maybeSaveResumeSnapshot(true);
                maxToolIterations += iterationWindow;
                if (runMetrics) runMetrics.maxIterations = maxToolIterations;
                emitStep({
                    type: 'validation',
                    content: `Sub-agent iteration window completed with healthy activity; extending to ${maxToolIterations} iterations.`,
                    timestamp: Date.now(),
                });
            }

            // If forceStop was set in the emit-results loop, exit outer while now
            if (forceStop) break;
        }

        // C2 Fix: check abort signal BEFORE the final over-iteration API call.
        // If the user cancelled, skip this call -it would produce charges and
        // stale UI state after cancellation.
        options?.abortSignal?.throwIfAborted();

        // If we force-stopped due to critical errors (e.g., Doom-Loop or consecutive errors),
        // we must not fire another chatCompletion, because the tool outputs for the last
        // assistant message were not fully appended, which would result in an API 400 error:
        // "No tool output found for function call...".
        if (forceStop) {
            await saveRetainedResumeSnapshot();
            updateFinalPromptMetric();
            return '[Agent Execution Terminated]: Tool execution failed consecutively or doom-loop detected.';
        }

        // Max iterations reached -notify user and try to get a final summary
        emitStep({
            type: 'error',
            content: "Max tool iterations reached (" + iteration + "/" + maxToolIterations + "). The task may be incomplete; send continue to resume.",
            timestamp: Date.now(),
        });

        // Inject a system hint so the final response summarizes progress
        messages.push({
            role: 'user',
            content: "[SYSTEM] Maximum iteration limit reached. Summarize completed work, list remaining work, and save progress in todo_write if needed. The user can send continue to resume.",




        });

        const finalModelCallId = `model_${runRecord.runId}_final`;
        const finalProviderConfig = this.aiService.getConfig();
        const finalProviderId = options?.providerId ?? finalProviderConfig.provider;
        const finalModel = options?.model ?? finalProviderConfig.model;
        const finalRequestArtifact = await archiveModelRequest(
            finalModelCallId,
            {
                runId: runRecord.runId,
                invocationId: finalModelCallId,
                iteration,
                purpose: 'max_iteration_summary',
                mode,
                providerId: finalProviderId,
                model: finalModel,
                options: {
                    workflowId: options?.workflowId,
                    replayOf: options?.replayOf,
                },
            },
            messages,
            [],
        ).catch(error => {
            ErrorReporter.warn('AgentRunner', `Failed to archive model request ${finalModelCallId}`, error);
            return undefined;
        });
        await runLedger.appendEvent(
            runRecord.runId,
            'model_call_start',
            {
                iteration,
                purpose: 'max_iteration_summary',
                providerId: finalProviderId,
                model: finalModel,
                messageCount: messages.length,
                toolCount: 0,
                requestRef: finalRequestArtifact?.ref,
                requestSha256: finalRequestArtifact?.sha256,
            },
            { invocationId: finalModelCallId, status: 'running' }
        );
        if (tokenAccumulator) {
            tokenAccumulator.apiCalls = (tokenAccumulator.apiCalls ?? 0) + 1;
        }
        const finalResponse = await this.aiService.chatCompletion(messages, {
            providerId: options?.providerId,
            model: options?.model,
            reasoningEffort: options?.reasoningEffort,
        });
        this.accumulateAuxiliaryUsage(finalResponse, messages, tokenAccumulator, finalProviderId, finalModel, {
            toolFocus: 'finalize',
            purpose: 'final_summary',
            promptFingerprint: tokenAccumulator?.promptFingerprint,
        });
        await runLedger.appendEvent(
            runRecord.runId,
            'model_call_end',
            {
                iteration,
                purpose: 'max_iteration_summary',
                success: true,
                model: finalResponse.model,
                usage: finalResponse.usage,
                finishReason: finalResponse.choices?.[0]?.finish_reason
            },
            { invocationId: finalModelCallId, status: 'done' }
        );

        const finalContent = contentToString(finalResponse.choices[0]?.message?.content);
        updateFinalPromptMetric();
        return this.cleanFinalContent(finalContent);
    }

    // ── Delegated utility methods ────────────────────────────────────────────
    // These delegate to extracted modules (toolCallParser, jsonRepair, contextBudget)
    // to keep agentRunner focused on orchestration while maintaining the existing API.

    private parseDsmlToolCalls(content: string, depth: number = 0): import('./types').ToolCall[] {
        return _parseDsmlToolCalls(content, depth);
    }

    private stripDsmlMarkup(content: string): string {
        return _stripDsmlMarkup(content);
    }

    private stripThinkBlocks(content: string): string {
        return _stripThinkBlocks(content);
    }

    private cleanFinalContent(content: string): string {
        return _cleanFinalContent(content);
    }

    private budgetToolResult(result: unknown, maxChars?: number): string {
        return _budgetToolResult(result, maxChars);
    }
    /**
     * Extract code blocks from AI response.
     * Looks for ```pdx or ``` code fences, or falls back to indented blocks.
     */
    private extractCode(text: string): string | null {
        if (!text) return null;

        // L1 Fix: merged into a single pattern — the two original patterns were
        // almost identical (second was a superset) and could double-match the same block.
        // Now: match optional language tag including empty (no-tag fences).
        const fencePattern = /```(?:pdx|paradox|stellaris|txt)?\s*\n([\s\S]*?)```/g;
        const matches: RegExpExecArray[] = [];
        let m: RegExpExecArray | null;
        fencePattern.lastIndex = 0;
        while ((m = fencePattern.exec(text)) !== null) {
            matches.push(m);
        }
        if (matches.length > 0) {
            // Return the largest code block
            return matches
                .map(match => match[1]!.trim())  
                .sort((a, b) => b.length - a.length)[0] || null;
        }

        // Fallback: heuristic check — the entire response looks like raw PDXScript.
        const lines = text.split('\n');
        const nonEmpty = lines.filter(l => l.trim().length > 0);
        if (nonEmpty.length === 0) return null;

        const pdxLineRe = /^\s*(?:\{\s*$|\}\s*$|[\w.]+\s*=[^=]|if\s*=|else\s*=|limit\s*=|trigger\s*=|effect\s*=|AND\s*=|OR\s*=|NOT\s*=)/;
        const codeLines = nonEmpty.filter(l => pdxLineRe.test(l));

        // L2 Fix: require at least one brace pair ({}) to guard against Markdown
        // tables / config examples that happen to contain '=' on ≥75% of lines.
        const hasBraces = text.includes('{') && text.includes('}');
        if (hasBraces && codeLines.length >= nonEmpty.length * 0.75 && nonEmpty.length >= 3) {
            return text.trim();
        }

        return null;
    }

    /**
     * Extract explanation text (non-code parts) from AI response.
     */
    private extractExplanation(text: string): string {
        if (!text) return '';

        let explanation = this.stripDsmlMarkup(text);

        // Remove code blocks
        explanation = explanation.replace(/```[\s\S]*?```/g, '').trim();

        // Clean up excess blank lines
        explanation = explanation.replace(/\n{3,}/g, '\n\n').trim();
        return explanation;
    }

    /**
     * Generate a short AI topic title from a user message + assistant reply.
     * Called after the first exchange in a new topic (OpenCode-style title agent).
     * Returns null if generation fails or produces nothing useful.
     */
    async generateTopicTitle(
        userMessage: string,
        assistantReply: string,
        options?: Pick<AgentRunnerOptions, 'providerId' | 'model' | 'reasoningEffort'> & {
            onUsage?: (sample: {
                usage: TokenUsage;
                providerId: string;
                model: string;
                cacheCapable: boolean;
                durationMs: number;
            }) => void;
        }
    ): Promise<string | null> {
        try {
            const context = [userMessage, assistantReply]
                .map(s => s.substring(0, 400))
                .join('\n\n---\n\n');

            const messages: ChatMessage[] = [
                {
                    role: 'system',
                    content: 'You are a conversation title generator. Generate a concise title (max 50 characters) in the same language as the user message. Output ONLY the title text, no quotes, no punctuation at the end, no preamble.',
                },
                {
                    role: 'user',
                    content: `Generate a short title for this conversation:\n\n${context}`,
                },
            ];
            const startedAt = Date.now();
            const response = await this.aiService.chatCompletion(messages, {
                maxTokens: 60,
                temperature: 0.3,
                providerId: options?.providerId,
                model: options?.model,
                reasoningEffort: options?.reasoningEffort,
            });
            const config = this.aiService.getConfig();
            const usageSample = buildProviderCallTokenUsage(response, messages, {
                providerId: options?.providerId ?? config.provider,
                requestedModel: options?.model ?? config.model,
                customApiFormat: config.customApiFormat,
                endpoint: this.aiService.getEndpointForProvider(options?.providerId ?? config.provider),
                agentMode: 'title',
                purpose: 'title',
            });
            try {
                options?.onUsage?.({ ...usageSample, durationMs: Date.now() - startedAt });
            } catch (error) {
                ErrorReporter.warn(SOURCE.AGENT_RUNNER, 'Failed to record topic-title provider usage.', error);
            }

            const raw = contentToString(response.choices[0]?.message?.content).trim();
            // Clean up think blocks and extra quotes
            const cleaned = raw
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/^["'\u300c\u300e]|["'\u300d\u300f]$/g, '')
                .trim();

            if (!cleaned || cleaned.length < 2 || cleaned.length > 80) return null;
            return cleaned;
        } catch {
            return null;
        }
    }
}
