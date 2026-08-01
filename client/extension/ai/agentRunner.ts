/**
 * CWTools AI Module — Agent Runner
 *
 * Orchestrates the AI reasoning loop:
 * 1. Send user message + context + tools to AI
 * 2. If AI wants to call tools → execute tools → feed results back
 * 3. Repeat until AI produces final answer or max iterations reached
 * 4. Extract generated code → validate → retry if needed (max 3 rounds)
 */

import type {
    ChatMessage,
    AgentStep,
    GenerationResult,
    ValidationError,
    AgentToolName,
    AgentMode,
    ChatCompletionResponse,
    ContentPart,
    TokenUsage,
    AgentToolStage,
    AgentRunMetrics,
    AnalyzeDiagnosticErrorResult,
    GetDiagnosticsResult,
    ToolDefinition,
    ReasoningEffort,
    AgentSchedulingState,
    AgentRuntimeDomain,
    ToolCall,
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
import { getEffectiveEndpoint, getProvider, getProviderApiFormat, isModelVisionCapable } from './providers';
import { getModelPricing, getCacheDiscountFactor } from './pricing';
import { buildProviderCallTokenUsage } from './providerCallUsage';
import { parseDsmlToolCalls as _parseDsmlToolCalls, stripDsmlMarkup as _stripDsmlMarkup, stripThinkBlocks as _stripThinkBlocks, cleanFinalContent as _cleanFinalContent } from './toolCallParser';
import { tryRepairJson as _tryRepairJson } from './jsonRepair';
import { repairToolArgs } from './tools/argRepair';
import { budgetToolResult as _budgetToolResult, getToolResultBudget } from './contextBudget';
import type { CompactMessagesOptions } from './contextBudget';
import { AGENT, SOURCE, aiText } from './messages';
import { ErrorReporter } from './errorReporter';
import { MemoryParser } from './memoryParser';
import { getProjectWorkspaceRoot, getPrivateTopicStorageDir, getPrivateTopicStorageDirCandidates, canonicalPathKey } from './workspacePaths';
import {
    filterToolDefinitionsForMode,
    filterToolDefinitionsForStage,
    extendStageToolPoolWithSupport,
    getWorkflowStageSupportTools,
    initialToolStageForMode,
    normalizeToolStageForMode,
    advanceToolStage,
    buildToolStageReminder,
    isExecutionActionTool,
    resolveMaxToolIterations,
    resolveRunMaxOutputTokens,
    shouldAutoDiscloseExecutionTools,
    shouldContinueAuthorizedExecution,
    shouldRenewIterationLimit,
    SLIM_SUB_AGENT_OUTPUT_BUDGET_RECOVERY_LIMIT,
    SLIM_SUB_AGENT_THINKING_CHAR_LIMIT,
} from './runnerPolicy';
import { getWorkflow } from './workflowRegistry';
import { TOOL_REGISTRY, WRITE_TOOLS, READ_ONLY_TOOLS } from './tools/registry';
import { PartitionedWriteQueue } from './runner/writeCoordinator';
import { runLedger } from './runner/runLedger';
import { atomicWriteText, sha256Text } from './runner/durableStorage';
import { loadResumeState, hasResumeState, saveResumeState as saveCheckpointResumeState } from './runner/checkpoint';
import { maybeCompactHistory as _maybeCompactHistory, COMPACTION_THRESHOLD_RATIO, MID_LOOP_COMPACTION_INTERVAL, MID_LOOP_COMPACTION_RATIO, DEFAULT_CONTEXT_LIMIT, AUTO_COMPACTION_MIN_INTERVAL_MS, resolveCompactionContextLimit, type CompactionBudgetOptions, type AutoCompactionThrottle } from './runner/compaction';
import { refreshLiveVsCodeContext } from './runner/liveContext';
import { runContextMaintenance } from './runner/contextMaintenance';
import { TokenCalibrationTable, buildCalibrationKey } from './runner/tokenCalibration';
import { executeFallbackRetry, isFallbackEligibleApiError } from './runner/fallbackPolicy';
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
    phaseForToolStage,
    shouldEnterPlanFromTodos,
    transitionSchedulingState,
} from './runner/scheduling';
import { toolDisclosureService, type ToolDisclosureContext } from './runner/toolDisclosure';
import { ToolDedupeService } from './runner/toolDedupe';
import { contextLimitTracker } from './runner/contextLimitTracker';
import { RecoveryCoordinator } from './runner/recoveryCoordinator';
import { createAgentRuntimeServices } from './runner/runtimeServices';
import { runtimeFaultInjector } from './runner/faultInjection';
import { threadStore } from './runner/threadStore';
import { validateGitOpsForMode, validatePlanModeToolUse } from './planModeGuard';
import { buildApprovedPlanExecutionReminder } from './executePlanHandoff';
import { appendCacheRequestUsage, isCacheCapableUsage, supportsOpenAiStylePrefixCache } from './cacheCapability';
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
    hasOnlyPendingValidationErrors,
    terminalValidationOutcome,
    updateTerminalValidationState,
    type TerminalValidationState,
} from './runner/terminalValidation';

export { isFallbackEligibleApiError } from './runner/fallbackPolicy';
export { getAgentToolTargetFiles, SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS } from './runner/toolScheduler';
export { DOOM_LOOP_SOFT_THRESHOLD, DOOM_LOOP_PAIR_THRESHOLD, fnv32a, normalizeToolResultHash } from './runner/doomLoopDetector';
export { AgentAbortError, checkCancellation, isAbortError } from './runner/cancellation';
export { StepEmitter } from './runner/stepEmitter';
// Token estimation primitives live in runner/tokenEstimation (extracted to avoid
// runner/ modules importing this god-file). Re-exported for existing consumers.
export { estimateTokenCount, estimateChatMessageTokens, estimateChatMessagesTokens, CHARS_PER_TOKEN } from './runner/tokenEstimation';


// Maximum validation-retry rounds (reduced: edit_file now returns inline LSP diagnostics)
const MAX_VALIDATION_RETRIES = 2;
const VALIDATION_DIAGNOSTIC_FRESHNESS_RECHECK_DELAYS_MS = [500, 1500, 3000];
const MAX_OUTPUT_REPETITION_RECOVERIES = 1;
const MAX_TOP_LEVEL_LENGTH_RECOVERIES = 1;
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
    /** Main-Agent approved-plan continuation may resume directly at the write stage. */
    initialToolStage?: AgentToolStage;
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
    /** 
* Skip built-in validation loop (Phase 3). 
* Orchestrator subagent uses this flag because Orchestrator has its own QualityGate mechanism, 
* The subagent does not need to be repeatedly verified, and the validation loop will continue to generate steps after the inference ends, resulting in inconsistent UI status. 
*/
    skipValidation?: boolean;
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
* Whether to restore the state from the last breakpoint snapshot that exited abnormally (breakpoint resume) 
*/
    resumeFromState?: boolean;
    /**
     * If set, the agent run is executing within a specific workflow.
     * The runner will apply the workflow's tool policy and prompt supplement.
     */
    workflowId?: string;
}

/** Tools allowed in Plan mode (read-only + architecture design tools) */
const _PLAN_MODE_TOOLS: AgentToolName[] = [
    'explore_pdx_project',
    'query_scope', 'query_types', 'query_rules', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'todo_write',
    'read_file', 'list_directory', 'get_lsp_status', 'get_diagnostics', 'web_open', 'web_search',
    'glob_files', 'web_find',
    // Deep API tools for archetype study in Plan mode
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_definition', 'query_definition_by_name',
    'query_static_modifiers', 'query_variables',
    // Structured design blueprint output
    'write_design_blueprint', 'save_workflow',
    // Read-only planning fan-out; the dispatch boundary rejects writer roles in Plan mode.
    'dispatch_agents', 'query_blackboard', 'merge_results',
    // Memory tools for persisting architectural state
    'set_memory', 'get_memory', 'search_memory',
    // Git operations for investigation
    'git_ops', 'save_workflow',
];

/** Explore mode: same as plan, plus CWTools Deep API tools — no writes (OpenCode explore agent) */
const _EXPLORE_MODE_TOOLS: AgentToolName[] = [
    'explore_pdx_project',
    'query_scope', 'query_types', 'query_rules', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_lsp_status', 'get_diagnostics', 'web_open', 'web_search', 'glob_files',
    // CWTools Deep API tools (read-only, advertised in Explore mode prompt)
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'query_definition', 'query_definition_by_name', 'web_find',
    // Bounded read-only evidence fan-out. The dispatch boundary rejects writer roles and planned files.
    'dispatch_agents', 'query_blackboard', 'merge_results',
    // Git operations for investigation
    'git_ops', 'save_workflow',
];

/** General mode: legacy read-only Q&A mode. */
const _GENERAL_EXCLUDED_TOOLS: AgentToolName[] = ['todo_write'];

function filterWebToolsForConfiguredAccess(tools: ToolDefinition[]): ToolDefinition[] {
    const mode = vs.workspace.getConfiguration('stellarisLanguageServices.ai.web')
        .get<'disabled' | 'indexed' | 'live'>('mode', 'indexed');
    if (mode === 'live') return tools;
    const unavailable = mode === 'disabled'
        ? new Set(['web_search', 'web_open', 'web_find'])
        : new Set(['web_open', 'web_find']);
    return tools.filter(tool => !unavailable.has(tool.function.name));
}

/** Utility mode: full ordinary coding tools for non-PDX helper scripts/tools. */
const _UTILITY_EXCLUDED_TOOLS: AgentToolName[] = ['dispatch_agents', 'query_blackboard', 'merge_results'];

/** Review mode: same as explore, plus query_definition — read-only tools only */
const _REVIEW_MODE_TOOLS: AgentToolName[] = [
    'explore_pdx_project',
    'query_scope', 'query_types', 'query_rules', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_lsp_status', 'get_diagnostics', 'query_definition', 'query_definition_by_name',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'web_open', 'web_search', 'glob_files', 'web_find',
    // Git operations for investigation
    'git_ops',
];

/** Loc Translator mode: read localisation files, write translated output */
const _LOC_TRANSLATOR_TOOLS: AgentToolName[] = [
    'explore_pdx_project',
    'read_file', 'write_file', 'edit_file', 'replace_lines',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'workspace_symbols',
    'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_lsp_status', 'get_diagnostics',
    'query_localisation_index', 'query_workspace_index',
    'todo_write',
    'write_localisation', 'git_ops', 'save_workflow',
];

/** Loc Writer mode: create new localisation entries from scratch */
const _LOC_WRITER_TOOLS: AgentToolName[] = [
    'explore_pdx_project',
    'read_file', 'write_file', 'edit_file', 'replace_lines',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'workspace_symbols',
    'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_lsp_status', 'get_diagnostics',
    'query_types', 'query_rules', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'todo_write',
    'write_localisation', 'git_ops', 'save_workflow',
];

/** General Multi-Agent parent: read-only tools plus coordinator-specific dispatch/blackboard/merge tools. */
const _ORCHESTRATOR_MODE_TOOLS: AgentToolName[] = [
    'explore_pdx_project',
    //Read-only information collection
    'query_scope', 'query_types', 'query_rules', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_lsp_status', 'get_diagnostics', 'web_open', 'web_search', 'glob_files', 'web_find',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'query_definition', 'query_definition_by_name',
    // Blackboard and task management
    'set_memory', 'get_memory', 'search_memory', 'todo_write',
    // Topic-scoped Implementation_Plan.md handoff only; runtime guard blocks project files.
    'write_file',
    // Coordinator-specific
    'dispatch_agents', 'query_blackboard', 'merge_results',
    // Git
    'git_ops', 'save_workflow',
];




const globalPartitionedWriteQueue = new PartitionedWriteQueue();

export class AgentRunner {
    public readonly readTracker = new ReadTracker();
    private readonly runtimeServices = createAgentRuntimeServices();
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
            const fs = await import('fs');
            const pathModule = await import('path');
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
                pathModule.join(checkpointDir, 'checkpoint.json'),
                JSON.stringify(checkpoint, null, 2),
                'utf-8'
            );
        } catch {
            // Non-critical — silently ignore checkpoint failures
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
            const fs = await import('fs');
            const pathModule = await import('path');
            const wsRoot = getProjectWorkspaceRoot();

            const checkpointPath = getPrivateTopicStorageDirCandidates(topicId, wsRoot)
                .map(dir => pathModule.join(dir, 'checkpoint.json'))
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
            const fs = await import('fs');
            const pathModule = await import('path');
            const wsRoot = getProjectWorkspaceRoot();
            for (const resumeDir of getPrivateTopicStorageDirCandidates(topicId, wsRoot)) {
                const resumePath = pathModule.join(resumeDir, 'resume_state.json');
                if (fs.existsSync(resumePath)) {
                    fs.unlinkSync(resumePath);
                }
            }
        } catch {
            // Ignore deletion errors
        }
    }

    // ─── Batch 2.5: Provider fallback retry ──────────────────────────────────

    /**
     * Determine if an API error is catastrophic enough to warrant a fallback retry.
     * Returns true for 5xx server errors, network timeouts, and exhausted rate limits.
     */
    private isFallbackEligibleError(error: unknown): boolean {
        return isFallbackEligibleApiError(error)
            || this.runtimeServices.retryPolicy.decide(error, 1).retry;
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
        const pipeline = this.runtimeServices.createToolPipeline({
            execute: pipelineContext => this.toolExecutor.execute(
                pipelineContext.toolName,
                pipelineContext.args,
                context,
            ),
        });
        const result = await pipeline.run({
            invocationId: context?.runnerOptions?.runRecord?.runId ?? `tool_${Date.now()}`,
            toolName,
            args,
            signal: context?.runnerOptions?.abortSignal,
        });
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
            toolStage?: AgentToolStage;
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
        const pricing = getModelPricing(effectiveModel, effectiveProvider);
        const cachedTokens = response.usage?.cached_tokens
            ?? response.usage?.prompt_tokens_details?.cached_tokens
            ?? response.usage?.prompt_cache_hit_tokens
            ?? response.usage?.cached_content_token_count
            ?? 0;
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
            toolStage: metadata.toolStage,
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
            toolStage?: AgentToolStage;
            purpose: 'reasoning' | 'fallback' | 'validation' | 'final_summary';
            promptFingerprint?: string;
            invalidationReason?: string;
        },
    ): void {
        if (!accumulator) return;
        const config = this.aiService.getConfig();
        const customFormat = sample.provider === config.provider ? config.customApiFormat : undefined;
        const cacheCapable = isCacheCapableUsage(sample.provider, sample.cachedTokens, customFormat);
        const previousComparable = [...(accumulator.cacheRequests ?? [])]
            .reverse()
            .find(request => request.purpose === sample.purpose);
        let invalidationReason = sample.invalidationReason;
        if (sample.cachedTokens > 0 || !cacheCapable) {
            invalidationReason = undefined;
        } else if (!invalidationReason && previousComparable?.toolStage !== sample.toolStage) {
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
        const runRecordPromise = turnRuntimePromise.then(runtime => runtime.run);
        this.activeRunRecordPromise = runRecordPromise;

        const emitStep = (step: AgentStep) => {
            steps.push(step);
            options?.onStep?.(step);
            runRecordPromise.then(r => {
                runLedger.appendEvent(r.runId, 'step_appended', { step }).catch(() => {});
            }).catch(() => {});
        };
        const updateRunStatus = (status: import('./types').AgentRunStatus) => {
            runRecordPromise.then(async r => {
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
                    ).catch(() => {});
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
            }).catch(() => {});
        };
            // Empty
        // Empty

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
            toolStage: normalizeToolStageForMode(mode, options?.initialToolStage ?? initialToolStageForMode(mode)),
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
                try {
                    const cp = await import('child_process');
                    const util = await import('util');
                    const os = await import('os');
                    const execAsync = util.promisify(cp.exec);

                    // Check if mmx is installed
                    await execAsync('mmx --version');

                    emitStep({
                        type: 'thinking',
                        content: 'Using MiniMax CLI to process images...',
                        timestamp: Date.now(),
                    });

                    let visionText = '\n\n[System Notice: The user attached image(s) to this message. Since you do not have native vision capabilities, the images were automatically analyzed by an external Vision AI. Below is the textual description of what the image contains. You MUST use this description to answer the user\'s prompt. Do NOT use file-system tools (like list_directory) to answer questions about the image unless specifically asked to correlate them.]\n';
                    
                    for (let i = 0; i < effectiveImages.length; i++) {
                        const img = effectiveImages[i];
                        if (!img) continue;
                        
                        const base64Index = img.indexOf('base64,');
                        if (base64Index > -1) {
                            const header = img.substring(0, base64Index);
                            const extMatch = header.match(/^data:image\/([^;]+)/);
                            const rawExt = extMatch && extMatch[1] ? extMatch[1] : 'jpg';
                            const ext = rawExt === 'jpeg' ? 'jpg' : rawExt.replace(/[^a-zA-Z0-9]/g, '');
                            
                            const base64Data = img.substring(base64Index + 7);
                            const tempFilePath = path.join(os.tmpdir(), `mmx_img_${Date.now()}_${i}.${ext}`);
                            
                            try {
                                await fs.promises.writeFile(tempFilePath, Buffer.from(base64Data, 'base64'));
                                const { stdout } = await execAsync(`mmx vision describe --image "${tempFilePath}" --non-interactive --no-color`, { timeout: 60000 });
                                const vlmResult = stdout.trim();
                                visionText += `\nImage ${i + 1}:\n${vlmResult}\n`;
                                emitStep({
                                    type: 'thinking',
                                    content: `[VLM Image ${i + 1}]: ${vlmResult}`,
                                    timestamp: Date.now(),
                                });
                            } catch (err) {
                                const errMsg = err instanceof Error ? err.message : String(err);
                                visionText += `\nImage ${i + 1}: Failed to analyze (${errMsg})\n`;
                                emitStep({
                                    type: 'thinking',
                                    content: `[VLM Image ${i + 1} Failed]: ${errMsg}`,
                                    timestamp: Date.now(),
                                });
                            } finally {
                                if (fs.existsSync(tempFilePath)) {
                                    await fs.promises.unlink(tempFilePath).catch(() => {});
                                }
                            }
                        } else {
                            visionText += `\nImage ${i + 1}: Invalid image data format.\n`;
                            emitStep({
                                type: 'thinking',
                                content: `[VLM Image ${i + 1}]: Invalid format`,
                                timestamp: Date.now(),
                            });
                        }
                    }
                    visionText += '\n[End of Image Descriptions]\n';
                    effectiveUserMessage += visionText;
                    minimaxCliUsed = true;
                    effectiveImages = undefined;
                } catch {
                    // mmx not installed or error, fall through to default unsupported message
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
        const runId = runRecord.runId;
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
        const unregisterActiveTurn = activeTurnRegistry.register({
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
        const supportsPrefixCache = supportsOpenAiStylePrefixCache(providerForPrompt, promptConfig.customApiFormat);
        // The model-visible tool set feeds both the frozen prompt fingerprint
        // (plan sec.7.1) and the reserved-token estimate below; mirror the
        // reasoning loop's filter inputs so both describe the real toolset.
        const promptPerformanceConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance');
        const promptLegacyFullToolset = promptPerformanceConfig.get<boolean>('legacyFullToolset') === true;
        const promptModeTools = filterWebToolsForConfiguredAccess(filterToolDefinitionsForMode(TOOL_DEFINITIONS, mode, {
            domain,
            useSlimPrompt: options?.useSlimPrompt,
            excludeTools: options?.excludeTools,
            legacyFullToolset: promptLegacyFullToolset,
        }));
        const initialToolStage = normalizeToolStageForMode(mode, options?.initialToolStage ?? initialToolStageForMode(mode));
        const promptToolDefinitions = filterToolDefinitionsForStage(
            promptModeTools,
            mode,
            initialToolStage,
            promptLegacyFullToolset,
        );
        // DeepSeek prefix-cache optimization: use frozen (session-cached) system prompt
        // to ensure byte-level stability across API calls for cache hits.
        // rebuildSystemPrompt drops this fingerprint's cache entry before building (plan sec.7.1).
        const systemPrompt = options?.useSlimPrompt
            ? this.promptBuilder.buildSlimSystemPromptForMode(mode, providerForPrompt, undefined, topicId, domain)
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
        tokenAccumulator.promptFingerprint = supportsPrefixCache && !options?.useSlimPrompt
            ? this.promptBuilder.getLastFrozenPromptFingerprintHash()
            : undefined;
        tokenAccumulator.promptCacheMissReason = supportsPrefixCache && !options?.useSlimPrompt
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
        const initialStageReminder = buildToolStageReminder(mode, initialToolStage, promptToolDefinitions, domain);
        const dynamicBlock: ChatMessage[] = [...promptDynamicBlock];
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
        if (initialStageReminder) {
            dynamicBlock.push({ role: 'user', content: initialStageReminder });
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
        const admissionMaintenance = runContextMaintenance(conversationHistory, 'admission', {
            toolResultBudget: getToolResultBudget(
                admissionConfig.maxContextTokens > 0
                    ? admissionConfig.maxContextTokens
                    : (getProvider(admissionProviderId).maxContextTokens || DEFAULT_CONTEXT_LIMIT)),
            compactionOptions: {
                preserveTailBytes: supportsOpenAiStylePrefixCache(admissionProviderId, admissionConfig.customApiFormat)
                    || admissionPreserveMimo,
                preserveReasoningContentForToolCalls: admissionPreserveMimo,
            },
            extraTokens: fixedPromptTokens + toolSchemaTokens,
            calibrateEstimate: (t) => this.calibrateContextEstimate(admissionProviderId, admissionModel, t),
            // NOTE: when this prunes, conversationHistory is mutated in place even
            // if the paid summarizer later fails or is throttled. That is
            // intentional (free prune first) and safe: squeezing is lossy only
            // for re-derivable tool output, and canonicalization still runs.
            summarizeThreshold: Math.floor(
                resolveCompactionContextLimit(admissionProviderId, admissionModel, options?.maxContextTokens ?? admissionConfig.maxContextTokens)
                * Math.max(0.5, Math.min(0.95, vs.workspace
                    .getConfiguration('stellarisLanguageServices.ai.performance')
                    .get<number>('compactionTriggerRatio', COMPACTION_THRESHOLD_RATIO)))),
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
                reservedTokens: fixedPromptTokens + toolSchemaTokens,
                precomputedRequestTokens: admissionMaintenance.afterTokens,
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

            // Plan / Explore / General / Review / multi-Agent parent — or no code generated — just an explanation
            if (!code || mode === 'plan' || mode === 'explore' || mode === 'general' || mode === 'utility' || mode === 'review' || mode === 'orchestrator' || mode === 'script') {
                const orchestratorValidation = mode === 'script' || mode === 'orchestrator'
                    ? this.toolExecutor.getOrchestratorValidation(runId)
                    : undefined;
                const toolValidationOutcome = terminalValidationOutcome(terminalValidation);
                const parentQualityGateWillRevalidate = options?.useSlimPrompt === true && !!options.parentRunId;
                const validationPending = !parentQualityGateWillRevalidate && (
                    orchestratorValidation?.pendingOnly === true
                    || (!orchestratorValidation && toolValidationOutcome === 'pending')
                );
                const validationFailed = (orchestratorValidation?.success === false && orchestratorValidation.pendingOnly !== true)
                    || (!orchestratorValidation && toolValidationOutcome === 'repair');
                if (validationPending && !validationFailed) {
                    this.retainedResumeRuns.add(runId);
                    if (context.topicId) {
                        await this.saveResumeState(context.topicId, messages, mode, domain, runId, undefined, options.schedulingState ?? schedulingState);
                    }
                    updateRunStatus('paused');
                    await clearResumeStateIfComplete();
                    return {
                        runId,
                        code: '',
                        explanation: finalMessage,
                        validationErrors: [{
                            code: 'VALIDATION_PENDING',
                            severity: 'error',
                            message: orchestratorValidation?.summary
                                ?? 'Written files are saved, but final deterministic validation is still pending. The run can be resumed.',
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
                const isValid = orchestratorValidation?.success ?? (toolValidationOutcome !== 'repair');
                updateRunStatus(isValid ? 'completed' : 'failed');
                if (isValid) this.autoCompleteTodos(options);
                await clearResumeStateIfComplete();
                return {
                    runId,
                    code: '',
                    explanation: finalMessage,
                    validationErrors: isValid ? [] : [{
                        code: orchestratorValidation ? 'orchestrator_quality_gate' : 'post_write_validation',
                        severity: 'error',
                        message: orchestratorValidation?.summary ?? aiText(
                            `Post-write validation requires repair for ${terminalValidation.repairTargets.size + terminalValidation.diagnosticErrorTargets.size} target(s).`,
                            `写后验证发现 ${terminalValidation.repairTargets.size + terminalValidation.diagnosticErrorTargets.size} 个目标需要修复。`,
                        ),
                        line: 0,
                        column: 0,
                    }],
                    isValid,
                    retryCount: 0,
                    steps,
                    tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                    runMetrics,
                };
            }

            // Phase 3: Validation loop
            // Orchestrator subagent skips this stage via skipValidation -
            // Orchestrator has an independent QualityGate mechanism, and subagents do not need to be repeatedly verified.
            // In addition, the validation loop will continue to generate steps after the reasoning ends, causing the external judgment card to be inconsistent with the internal state.
            if (options?.skipValidation) {
                updateRunStatus('completed');
                this.autoCompleteTodos(options);
                await clearResumeStateIfComplete();
                return {
                    runId,
                    code,
                    explanation: this.extractExplanation(finalMessage),
                    validationErrors: [],
                    isValid: true,
                    retryCount: 0,
                    steps,
                    tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                    runMetrics,
                };
            }

            const targetFile = context.activeFile ?? '';
            const validationResult = await this.validationLoop(
                code, targetFile, messages, emitStep, options, tokenAccumulator
            );

            const toolValidationOutcome = terminalValidationOutcome(terminalValidation);
            if (validationResult.isValid && toolValidationOutcome !== 'allow') {
                validationResult.isValid = false;
                validationResult.validationErrors.push({
                    code: toolValidationOutcome === 'pending' ? 'VALIDATION_PENDING' : 'post_write_validation',
                    severity: 'error',
                    message: toolValidationOutcome === 'pending'
                        ? aiText(
                            'Written files are saved, but final deterministic validation is still pending. The run can be resumed.',
                            '文件已写入，但最终确定性验证仍在等待中；该运行可以恢复。',
                        )
                        : aiText(
                            'A tool-written file still requires repair after post-write validation.',
                            '工具写入的文件在写后验证后仍需修复。',
                        ),
                    line: 0,
                    column: 0,
                });
            }
            const validationPending = hasOnlyPendingValidationErrors(validationResult.validationErrors);
            if (validationPending) {
                this.retainedResumeRuns.add(runId);
                if (context.topicId) {
                    await this.saveResumeState(context.topicId, messages, mode, domain, runId, undefined, options.schedulingState ?? schedulingState);
                }
                updateRunStatus('paused');
            } else {
                updateRunStatus(validationResult.isValid ? 'completed' : 'failed');
                if (validationResult.isValid) this.autoCompleteTodos(options);
            }
            await clearResumeStateIfComplete();
            return {
                runId,
                ...validationResult,
                explanation: this.extractExplanation(finalMessage),
                steps,
                tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                runMetrics,
            };
        } catch (e) {
            updateRunStatus('failed');
            const errorMsg = e instanceof Error ? e.message : String(e);

            if (errorMsg.includes('aborted') || errorMsg.includes('cancel')) {
                threadStore.markStatus(topicId, threadId, 'interrupted').catch(() => {});
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
        } finally {
            this.toolExecutor.clearSkillPolicyForRun(runId);
            if (options?.agentId) this.toolExecutor.clearTodos(options.agentId);
            await this.tokenCalibration?.flush();
            this.retainedResumeRuns.delete(runId);
            unregisterActiveTurn();
            parentAbortSignal?.removeEventListener('abort', forwardParentAbort);
            this.activeRunEventSinks.delete(runId);
            this.activeInputQueues.delete(runId);
            if (this.activeRunRecordPromise === runRecordPromise) {
                this.activeRunRecordPromise = undefined;
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
                .get<number>('compactionTriggerRatio', COMPACTION_THRESHOLD_RATIO))),
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
        runContextMaintenance(history, 'manual', {
            toolResultBudget: getToolResultBudget(
                manualConfig.maxContextTokens > 0
                    ? manualConfig.maxContextTokens
                    : (getProvider(manualProviderId).maxContextTokens || DEFAULT_CONTEXT_LIMIT)),
            compactionOptions: {
                preserveTailBytes: supportsOpenAiStylePrefixCache(manualProviderId, manualConfig.customApiFormat)
                    || manualPreserveMimo,
                preserveReasoningContentForToolCalls: manualPreserveMimo,
            },
            extraTokens: manualSchemaTokens,
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
                reservedTokens: manualSchemaTokens,
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
     * if they exceed MID_LOOP_COMPACTION_RATIO of the context window.
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
        result: any
    ): Promise<any> {
        if (!result) return result;

        const strContent = this.serializeToolResult(result);

        const LIMIT = this.getToolResultArchiveLimit(toolName);
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
                { invocationId, status: 'done' }
            ).catch(() => {});
            return result;
        }

        try {
            const pathModule = await import('path');
            const wsRoot = getProjectWorkspaceRoot();
            const runDir = pathModule.join(getPrivateTopicStorageDir(topicId, wsRoot), 'runs', runId, 'large_results');

            const archivedResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            const resultSha256 = sha256Text(archivedResult);
            const artifactName = `${resultSha256}.json`;
            const filePath = pathModule.join(runDir, artifactName);
            if (!fs.existsSync(filePath)) {
                await atomicWriteText(filePath, archivedResult);
            }

            const relativeDiskPath = pathModule.posix.join('runs', runId, 'large_results', artifactName);
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
            ).catch(() => {});
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
                { invocationId, status: 'done' }
            ).catch(() => {});
            return {
                ok: true,
                truncated: true,
                message: `Tool result for ${toolName} was archived because it is large (${strContent.length} chars). Use the preview and resultRef, or retry with narrower arguments if more detail is needed.`,
                preview,
                fullResultLocalPath: relativeDiskPath,
                resultRef: relativeDiskPath,
                resultSha256,
            };
        } catch {
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
            ).catch(() => {});
            return {
                ok: true,
                truncated: true,
                message: `Tool result for ${toolName} was truncated because it is very large (${strContent.length} chars). Retry with narrower arguments if more detail is needed.`,
                preview: strContent.substring(0, 1000)
            };
        }
    }

    private getToolResultArchiveLimit(toolName: string): number {
        const structuredReadTools = new Set([
            'query_cwt_schema',
            'query_rules',
            'query_types',
            'query_override_modes',
            'search_rule_capabilities',
            'explore_pdx_project',
        ]);
        return structuredReadTools.has(toolName) ? 60000 : 16000;
    }

    private serializeToolResult(result: any): string {
        if (typeof result === 'string') return result;
        try {
            return JSON.stringify(result);
        } catch {
            return String(result);
        }
    }

    private summarizeToolResultForLedger(toolName: string, result: any): Record<string, unknown> {
        const resultRecord = result && typeof result === 'object' ? result as Record<string, any> : undefined;
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
            success: !error && !skipped && resultRecord?.success !== false,
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
        let schedulingState = normalizeSchedulingState(
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
        const supportsPrefixCache = supportsOpenAiStylePrefixCache(activeProviderId, this.aiService.getConfig().customApiFormat)
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
            onTodoUpdate: options?.onTodoUpdate
        };

        // Two-phase doom-loop detection (T1.2a — state encapsulated in DoomLoopState):
        // phase1: track (prevSig → currSig) pair frequency
        // phase2: compare normalized result hashes for same-name calls
        const doomLoop = new DoomLoopState();
        let consecutiveErrorCount = 0;
        // Flag set to true when we need to exit the outer while loop
        let forceStop = false;
        let outputRepetitionRecoveries = 0;
        let contextOverflowRecoveries = 0;
        let topLevelLengthRecoveries = 0;
        let prematureExecutionFinalRecoveries = 0;
        let executionActionObserved = false;
        let ineffectiveCompactionCount = 0;
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
        const legacyFullToolset = performanceConfig.get<boolean>('legacyFullToolset') === true;
        let toolStage = normalizeToolStageForMode(mode, options?.initialToolStage ?? initialToolStageForMode(mode));
        if (tokenAccumulator) tokenAccumulator.toolStage = toolStage;
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
            legacyFullToolset,
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
                if (mcpDefs.length > 0) availableTools = [...availableTools, ...mcpDefs];
            } catch { /* best effort */ }
        }

        // Apply workflow tool policy if running within a workflow
        const activeWorkflow = options?.workflowId ? getWorkflow(options.workflowId) : undefined;
        if (activeWorkflow) {
            const policy = activeWorkflow.toolPolicy;
            const workflowReadOnlySupportTools = new Set<string>(['run_skill']);
            if (policy.strategy === 'allowlist') {
                const allowed = new Set<string>(policy.tools);
                availableTools = availableTools.filter(t => allowed.has(t.function.name) || workflowReadOnlySupportTools.has(t.function.name));
            } else {
                // blocklist
                const blocked = new Set<string>(policy.tools);
                availableTools = availableTools.filter(t => !blocked.has(t.function.name));
            }
            ErrorReporter.debug('AgentRunner', `Workflow "${activeWorkflow.id}" tool policy applied: ${availableTools.length} tools available`);
        }
        const workflowStageSupportTools = activeWorkflow?.toolPolicy.strategy === 'allowlist'
            ? getWorkflowStageSupportTools(activeWorkflow.toolPolicy.tools)
            : undefined;
        const stagedToolPool = availableTools;
        const disclosureContext: ToolDisclosureContext = {
            mode,
            domain: options?.domain ?? defaultDomainForMode(mode),
            dynamicSupported: !legacyFullToolset
                && options?.useSlimPrompt !== true
                && vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance')
                    .get<boolean>('dynamicToolDisclosure.enabled', true),
            loaded: new Set<string>(),
        };
        const toolDedupe = new ToolDedupeService();
        const refreshAvailableTools = (): ToolDefinition[] => {
            const baseStagePool = filterToolDefinitionsForStage(
                stagedToolPool,
                mode,
                toolStage,
                legacyFullToolset,
                workflowStageSupportTools,
            );
            const stagePool = extendStageToolPoolWithSupport(
                baseStagePool,
                stagedToolPool,
                mode,
                toolStage,
                disclosureContext.loaded,
            );
            if (shouldAutoDiscloseExecutionTools(mode, toolStage, schedulingState.authorization)) {
                toolDisclosureService.select({
                    groups: ['file_write', 'command', 'git', 'media', 'orchestrator'],
                    reason: 'Runtime-authorized execution surface',
                }, stagePool, disclosureContext);
            }
            return toolDisclosureService.initialTools(stagePool, disclosureContext);
        };
        availableTools = refreshAvailableTools();

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
                .get<number>('compactionBlockRatio', Math.max(MID_LOOP_COMPACTION_RATIO, 0.90))));
        const configuredReservedTokens = Math.max(0,
            vs.workspace.getConfiguration('stellarisLanguageServices.ai.performance')
                .get<number>('compactionReservedTokens', 4_096));
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
        let slimOutputBudgetRecoveries = 0;
        const recoverSlimOutputBudget = (reason: 'thinking' | 'length'): boolean => {
            if (options?.useSlimPrompt !== true) return false;
            if (slimOutputBudgetRecoveries >= SLIM_SUB_AGENT_OUTPUT_BUDGET_RECOVERY_LIMIT) return false;
            slimOutputBudgetRecoveries++;
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
                if (loopTokens > midLoopThreshold) {
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
                    if (afterTokens > midLoopThreshold && afterTokens >= loopTokens * 0.95) {
                        ineffectiveCompactionCount++;
                    } else {
                        ineffectiveCompactionCount = 0;
                    }
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'compaction_end',
                        { kind: 'mid_loop', success: true, beforeTokens: loopTokens, afterTokens },
                        { status: 'done' }
                    );
                    emitStep({
                        type: 'compaction',
                        content: ineffectiveCompactionCount >= 3
                            ? AGENT.COMPACTION_THRASHING
                            : AGENT.COMPACTION_PHASE_DONE(loopTokens, afterTokens),
                        timestamp: Date.now(),
                        compactionInfo: {
                            state: ineffectiveCompactionCount >= 3 ? 'failed' : 'complete',
                            kind: 'mid_loop',
                            beforeTokens: loopTokens,
                            afterTokens,
                            thresholdTokens: midLoopThreshold,
                        },
                    });
                    if (ineffectiveCompactionCount >= 3) {
                        emitStep({
                            type: 'error',
                            content: AGENT.COMPACTION_THRASHING,
                            timestamp: Date.now(),
                        });
                        updateFinalPromptMetric();
                        return '[Agent Execution Terminated]: Context compaction was ineffective three times; stopped to avoid a retry loop.';
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
            const modelCallId = `model_${runRecord.runId}_${iteration}`;
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
            const requestProviderId = options?.providerId ?? activeProviderConfig.provider;
            const requestModel = options?.model ?? activeProviderConfig.model;
            const requestMaxTokens = resolveRunMaxOutputTokens({ useSlimPrompt: options?.useSlimPrompt });
            const requestDisableThinking = options?.useSlimPrompt === true && (mode === 'loc_writer' || mode === 'loc_translator');
            const appendModelDeltaEvent = (kind: string, text: string) => {
                const now = Date.now();
                if (now - lastModelDeltaEventAt < 1000) return;
                lastModelDeltaEventAt = now;
                runLedger.appendEvent(
                    runRecord.runId,
                    'model_call_delta',
                    { iteration, kind, preview: text.substring(0, 240), size: text.length },
                    { invocationId: modelCallId, status: 'running' }
                ).catch(() => {});
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
                    toolSchemaEstimateTokens: estimateTokenCount(JSON.stringify(availableTools)),
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
                    onToolCallDelta: (toolName, argsBuf) => {
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
                const overflowAttempt = recoveryError.kind === 'context_overflow'
                    ? recoveryCoordinator.claim('context_overflow', 2)
                    : undefined;
                if (overflowAttempt !== undefined) {
                    contextOverflowRecoveries = overflowAttempt;
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
                        attempt: contextOverflowRecoveries,
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
                    if (outputRepetitionRecoveries < MAX_OUTPUT_REPETITION_RECOVERIES) {
                        outputRepetitionRecoveries++;
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
                const transportAttempt = recoveryError.kind === 'transport'
                    ? recoveryCoordinator.claim('transport', 2)
                    : undefined;
                if (transportAttempt !== undefined) {
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'model_call_end',
                        { iteration, success: false, error: recoveryError.message, recoveryKind: recoveryError.kind, attempt: transportAttempt },
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
                // Batch 2.5: Provider fallback on catastrophic errors
                if (this.isFallbackEligibleError(err)) {
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
                const pricing = getModelPricing(response.model ?? options?.model ?? '', responseProviderId);
                 // Cache-aware cost calculation: cached tokens billed at discounted rate
                const cachedTokens = response.usage?.cached_tokens ?? 
                                     (response.usage as any)?.prompt_tokens_details?.cached_tokens ?? 
                                     (response.usage as any)?.prompt_cache_hit_tokens ??
                                     (response.usage as any)?.cached_content_token_count ?? 0;
                const uncachedInputTokens = Math.max(0, promptTokens - cachedTokens);
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
                    toolStage ?? 'full',
                    hashToolDefinitionsForFingerprint(availableTools),
                ].join('|')).slice(0, 24);
                const firstReasoningSample = !(tokenAccumulator.cacheRequests ?? [])
                    .some(sample => sample.purpose === 'reasoning' || sample.purpose === 'fallback');
                this.appendProviderCacheSample(tokenAccumulator, {
                    provider: responseProviderId,
                    model: response.model ?? options?.model ?? 'unknown',
                    inputTokens: promptTokens,
                    cachedTokens,
                    toolStage,
                    purpose: fallbackFromError ? 'fallback' : 'reasoning',
                    promptFingerprint: requestPromptFingerprint,
                    invalidationReason: firstReasoningSample ? tokenAccumulator.promptCacheMissReason : undefined,
                });

                // Emit cache hit rate, cache creation, and saved costs for real-time auditing in the UI
                const cacheCreationTokens = response.usage?.cache_creation_tokens ?? 0;
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
                    }, { agentId: options?.sandbox?.agentId }).catch(() => {});
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
                    if (outputRepetitionRecoveries < MAX_OUTPUT_REPETITION_RECOVERIES) {
                        outputRepetitionRecoveries++;
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
            // 1. reasoning_content field (DeepSeek-R1 / some OpenAI-compat providers)
            const rawMsg = (choice as unknown as Record<string, unknown>);
            const reasoningField = (rawMsg.message as Record<string, unknown>)?.reasoning_content as string | undefined;
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
            // Preserve reasoning_content for DeepSeek-R1 API compatibility:
            // DeepSeek requires reasoning_content on ALL assistant messages when
            // in thinking mode, even if null. Without it, after several iterations
            // the API returns 400: "reasoning_content must be passed back".
            // The reasoningField was already extracted at line 640 from the raw response.
            if (reasoningField !== undefined && assistantMessage.reasoning_content === undefined) {
                assistantMessage.reasoning_content = reasoningField || null;
            }

            // ── DeepSeek API guard: ensure assistant messages always have content or tool_calls ──
            // DeepSeek (and some other OpenAI-compat providers) returns 400:
            //   "Invalid assistant message: content or tool_calls must be set"
            // when an assistant message has null/empty content AND no tool_calls.
            // This happens during truncation (finish_reason=length) when the model
            // output only thinking tokens or was mid-tool-call with no text content.
            const hasContent = assistantMessage.content && (typeof assistantMessage.content === 'string' ? assistantMessage.content.trim().length > 0 : true);
            const hasToolCalls = assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0;
            if (!hasContent && !hasToolCalls) {
                assistantMessage.content = '[Response truncated — no text content was generated before the length limit was reached.]';
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
                if (topLevelLengthRecoveries >= MAX_TOP_LEVEL_LENGTH_RECOVERIES) {
                    return this.cleanFinalContent(contentToString(assistantMessage.content))
                        || '[Agent Execution Terminated]: The model reached its output limit twice; generation stopped safely.';
                }
                topLevelLengthRecoveries++;
                messages.push({
                    role: 'user',
                    content: `[SYSTEM] Your previous response was truncated by the API max_tokens length limit. Please DO NOT output massive blocks of text. Break down your modifications into smaller steps. Use todo_write to plan them, and execute a single edit_file/replace_lines per response.`
                });
                continue;
            }

            // If no tool calls (either format), we're done — the final answer is no emit thinking block
            if (!toolCalls || toolCalls.length === 0) {
                const finalContent = this.cleanFinalContent(contentToString(assistantMessage.content));
                const isExplicitQuestion = finalContent.includes(':::question');
                if (!isExplicitQuestion
                    && prematureExecutionFinalRecoveries < 3
                    && shouldContinueAuthorizedExecution(
                        mode,
                        toolStage,
                        schedulingState.authorization,
                        executionActionObserved,
                    )) {
                    prematureExecutionFinalRecoveries++;
                    messages.push({
                        role: 'user',
                        content: `<system-reminder>This task already has workspace-write authorization. `
                            + `${toolStage ? `The current ${toolStage} stage is an internal execution checkpoint, not a user approval boundary. ` : ''}`
                            + `Do not ask the user to say "execute", do not return manual edit instructions, and do not stop at evidence collection. `
                            + `Continue now with the available tools until the requested execution and verification are complete. `
                            + `Only ask a structured :::question when progress requires information that only the user can provide.</system-reminder>`,
                    });
                    emitStep({
                        type: 'thinking',
                        content: `Authorized execution continued automatically from ${toolStage ?? 'full'} mode after a premature final response.`,
                        timestamp: Date.now(),
                    });
                    continue;
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

            // ── Question Card Halt: stop loop when AI asks user questions ──
            // If the assistant's text contains :::question blocks, the user needs
            // to answer before the AI should proceed. Force-stop the loop.
            const assistantText = contentToString(assistantMessage.content);
            if (assistantText.includes(':::question')) {
                emitStep({
                    type: 'validation',
                    content: aiText(
                        'Question card detected - waiting for your answer before continuing',
                        '检测到问题卡片 — 等待用户回答后再继续',
                    ),
                    timestamp: Date.now(),
                });
                return this.cleanFinalContent(assistantText);
            }

            // ── Two-phase doom-loop detection: phase 1 (pre-exec) ──
            // Track (prevSig → currSig) pairs. If the same pair repeats
            // ≥ DOOM_LOOP_PAIR_THRESHOLD times, flag for phase-2 hash check.
            const callSignature = toolCalls.map(tc => `${tc.function.name}:${tc.function.arguments}`).join('|');
            needsHashValidation = false;
            softLoopGuidancePending = false;
            doomLoop.currentPairKey = undefined;

            let hasStormExempt = false;
            for (const tc of toolCalls) {
                const reg = TOOL_REGISTRY.get(tc.function.name as import('./tools/registry').AgentToolName);
                if (reg?.stormExempt) {
                    hasStormExempt = true;
                    break;
                }
            }

            if (doomLoop.prevCallSignature && !hasStormExempt) {
                const pairKey = `${doomLoop.prevCallSignature}->${callSignature}`;
                doomLoop.currentPairKey = pairKey;
                const pairFreq = (doomLoop.pairFrequency.get(pairKey) || 0) + 1;
                doomLoop.pairFrequency.set(pairKey, pairFreq);
                if (runMetrics && pairFreq > 1) {
                    runMetrics.repeatedToolSignatureCount++;
                }
                if (pairFreq === DOOM_LOOP_SOFT_THRESHOLD) {
                    emitStep({
                        type: 'validation',
                        content: 'Repeated tool-call pattern detected; prompting the agent to switch strategy.',
                        timestamp: Date.now(),
                    });
                    softLoopGuidancePending = true;
                }
                if (pairFreq >= DOOM_LOOP_PAIR_THRESHOLD) needsHashValidation = true;
            }
            if (!hasStormExempt) {
                doomLoop.prevCallSignature = callSignature;
            }
            }

            if (!toolCalls) toolCalls = [];
            toolDedupe.nextStep();
            for (const toolCall of toolCalls) {
                if (toolCall.function.name !== 'select_tools') continue;
                let selectionArgs: Record<string, unknown> = {};
                try {
                    selectionArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
                } catch {
                    // The normal argument-repair path will report malformed arguments.
                }
                const baseStagePool = filterToolDefinitionsForStage(
                    stagedToolPool,
                    mode,
                    toolStage,
                    legacyFullToolset,
                    workflowStageSupportTools,
                );
                const selectionPool = extendStageToolPoolWithSupport(
                    baseStagePool,
                    stagedToolPool,
                    mode,
                    toolStage,
                );
                const selection = toolDisclosureService.select({
                    tools: Array.isArray(selectionArgs.tools)
                        ? selectionArgs.tools.filter((value): value is string => typeof value === 'string')
                        : undefined,
                    groups: Array.isArray(selectionArgs.groups)
                        ? selectionArgs.groups.filter((value): value is string => typeof value === 'string')
                        : undefined,
                    reason: typeof selectionArgs.reason === 'string' ? selectionArgs.reason : '',
                }, selectionPool, disclosureContext);
                selectionArgs._selectionResult = selection;
                toolCall.function.arguments = JSON.stringify(selectionArgs);
                const visibleStagePool = extendStageToolPoolWithSupport(
                    baseStagePool,
                    stagedToolPool,
                    mode,
                    toolStage,
                    disclosureContext.loaded,
                );
                availableTools = toolDisclosureService.initialTools(visibleStagePool, disclosureContext);
                await runLedger.appendEvent(runRecord.runId, 'tool_disclosure_changed', {
                    iteration,
                    ...selection,
                    activeToolCount: availableTools.length,
                }, { invocationId: toolCall.id, status: selection.denied.length > 0 ? 'failed' : 'done' });
            }
            // ── Deduplicate file-write calls ──────────────────────────────────
            // If the model emitted multiple write/edit calls targeting the same file
            // in one response, only keep the LAST one for each file.
            const lastWriteIndexByFile = new Map<string, number>();
            for (let i = 0; i < toolCalls.length; i++) {
                const name = toolCalls[i]!.function.name;
                if (!SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has(name)) continue;
                try {
                    const a = JSON.parse(toolCalls[i]!.function.arguments);  
                    for (const filePath of getAgentToolTargetFiles(name, a, this.toolExecutor.workspaceRoot, options?.topicId)) {
                        lastWriteIndexByFile.set(filePath, i);
                    }
                } catch { /* ignore */ }
            }

            // ── Execute tool calls (parallel for read-only, serial for writes) ──
            // Fix #9: WRITE_TOOLS and READ_ONLY_TOOLS are now module-level constants

            // Use pre-fetched provider info from outside the loop
            const useDsmlToolRole = useDsmlToolRole0;

            // Emit all tool_call steps upfront (preserves UI ordering)
            const parsedCalls: Array<{ 
                invocationId: string; 
                toolName: AgentToolName; 
                toolArgs: Record<string, unknown>; 
                toolArgsParseError?: string; 
                toolCall: typeof toolCalls[0];
                concurrencyClass: import('./types').ToolConcurrencyClass;
                effect: import('./types').ToolEffect;
                targetPaths: string[];
            }> = [];
            for (const toolCall of toolCalls) {
                options?.abortSignal?.throwIfAborted();
                // runRecord is resolved at reasoningLoop entry
                const invocation = buildToolInvocation({
                    runId: runRecord.runId,
                    toolCall,
                    availableTools,
                    workspaceRoot: this.toolExecutor.workspaceRoot,
                    topicId: options?.topicId
                });
                const invocationId = invocation.invocationId;
                let toolName = toolCall.function.name as AgentToolName;
                const knownNames = availableTools.map(t => t.function.name);
                if (!knownNames.includes(toolName)) {
                    const matched = knownNames.find(n => n.toLowerCase() === toolName.toLowerCase());
                    if (matched) {
                        emitStep({
                            type: 'thinking',
                            content: aiText(`Repaired tool name: ${toolName} -> ${matched}`, `修复工具名: ${toolName} -> ${matched}`),
                            invocationId,
                            timestamp: Date.now(),
                        });
                        toolCall.function.name = matched;
                        toolName = matched as AgentToolName;
                    }
                }
                if (runMetrics) {
                    runMetrics.toolCallCount++;
                    runMetrics.toolCallsByName[toolName] = (runMetrics.toolCallsByName[toolName] ?? 0) + 1;
                }
                let toolArgs: Record<string, unknown>;
                let toolArgsParseError: string | undefined;
                const rawToolArgs = toolCall.function.arguments;
                if (!rawToolArgs || !rawToolArgs.trim()) {
                    // Zero-parameter tool calls legitimately arrive with empty arguments
                    // (e.g. Anthropic streams no input_json_delta for an empty input) —
                    // not a parse failure.
                    toolArgs = {};
                } else {
                    try {
                        toolArgs = JSON.parse(rawToolArgs);
                    } catch (e) {
                        // Attempt common JSON repairs before giving up (Issue #2 fix)
                        const repaired = this.tryRepairJson(rawToolArgs);
                        if (repaired !== null) {
                            toolArgs = repaired;
                        } else {
                            toolArgs = {};
                            toolArgsParseError = `JSON parse error: ${e instanceof Error ? e.message : String(e)}. Raw arguments: ${rawToolArgs.substring(0, 200)}`;
                        }
                    }
                }

                // P1-B: Semantic argument repair (fuzzy name match + type coercion)
                if (!toolArgsParseError) {
                    const argRepair = repairToolArgs(toolName, toolArgs);
                    if (argRepair.repaired) {
                        toolArgs = argRepair.args;
                        emitStep({
                            type: 'thinking',
                            content: `[Tool Arg Repair] ${argRepair.repairs.join('; ')}`,
                            invocationId,
                            timestamp: Date.now(),
                        });
                    }
                }

                emitStep({ type: 'tool_call', content: aiText(`Calling tool: ${toolName}`, `调用工具: ${toolName}`), toolName, toolArgs, timestamp: Date.now(), stepIndex: ++globalToolCallIndex, iterationInfo: `Iteration ${iteration}/${maxToolIterations}`, invocationId });
                if (invocation.argRepairs.length > 0) {
                    emitStep({
                        type: 'thinking',
                        content: `[Tool Arg Repair] ${invocation.argRepairs.join('; ')}`,
                        invocationId,
                        timestamp: Date.now(),
                    });
                }
                parsedCalls.push({ 
                    invocationId, 
                    toolName, 
                    toolArgs, 
                    toolArgsParseError, 
                    toolCall,
                    concurrencyClass: invocation.concurrencyClass,
                    effect: invocation.effect,
                    targetPaths: invocation.targetPaths
                });
            }

            // Tool Call Repair: case-insensitive correction of hallucinated tool names.
            // Prevents doom-loop false positives when LLM emits slightly misspelled names.
            const knownNames = availableTools.map(t => t.function.name);
            for (const tc of [] as any[]) {
                const raw = tc.function.name;
                // Quick check: if exact match, skip
                if (knownNames.includes(raw)) continue;
                // Case-insensitive match
                const matched = knownNames.find(n => n.toLowerCase() === raw.toLowerCase());
                if (matched) {
                    emitStep({
                        type: 'tool_call',
                        content: aiText(`Repaired tool name: ${raw} -> ${matched}`, `修复工具名: ${raw} -> ${matched}`),
                        toolName: matched as AgentToolName,
                        timestamp: Date.now(),
                    });
                    tc.function.name = matched;
                }
                // If completely unmatched, leave as-is — the tool will fail with a clear
                // error, which can be routed through analyze_diagnostic_error rather than becoming a doom-loop.
            }

            const toolResults: any[] = new Array(parsedCalls.length);

            for (const ci of parsedCalls) {
                await runLedger.appendEvent(
                    runRecord.runId,
                    'tool_call_created',
                    { toolName: ci.toolName, toolArgs: ci.toolArgs, concurrencyClass: ci.concurrencyClass, effect: ci.effect },
                    { invocationId: ci.invocationId }
                );
            }

            // Fetch fs module lazily if we need it for snapshots
            let fsModule: typeof import('fs') | undefined;

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
                        }).catch(() => {});
                        toolResults[i] = { success: false, error: safetyCheck.reason };
                        continue;
                    }
                }
                const { toolName, toolArgs } = ci;

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

                const runtimePlanPhase = options?.schedulingState?.phase === 'plan';
                if (runtimePlanPhase
                    || mode === 'plan'
                    || ((mode === 'orchestrator' || mode === 'script') && toolName === 'write_file')) {
                    const guard = validatePlanModeToolUse(
                        toolName,
                        toolArgs,
                        this.toolExecutor.workspaceRoot,
                        options?.topicId,
                        ci.targetPaths,
                        runtimePlanPhase ? 'plan' : mode as 'plan' | 'orchestrator' | 'script',
                    );
                    if (!guard.allowed) {
                        emitStep({
                            type: 'validation',
                            content: guard.reason ?? 'Plan mode blocked this tool call.',
                            timestamp: Date.now(),
                            invocationId: ci.invocationId,
                        });
                        toolResults[i] = {
                            success: false,
                            error: guard.reason ?? 'Plan mode blocked this tool call.',
                            planModeBlocked: true,
                        };
                        await runLedger.appendEvent(
                            runRecord.runId,
                            'tool_call_end',
                            { success: false, error: toolResults[i].error, planModeBlocked: true },
                            { invocationId: ci.invocationId }
                        );
                        continue;
                    }
                }
                if (toolName === 'git_ops') {
                    const guard = validateGitOpsForMode(runtimePlanPhase ? 'plan' : mode, toolArgs);
                    if (!guard.allowed) {
                        emitStep({
                            type: 'validation',
                            content: guard.reason ?? 'Current mode blocked this git operation.',
                            timestamp: Date.now(),
                            invocationId: ci.invocationId,
                        });
                        toolResults[i] = {
                            success: false,
                            error: guard.reason ?? 'Current mode blocked this git operation.',
                        };
                        await runLedger.appendEvent(
                            runRecord.runId,
                            'tool_call_end',
                            { success: false, error: toolResults[i].error },
                            { invocationId: ci.invocationId }
                        );
                        continue;
                    }
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
                        const runReadTool = async (): Promise<unknown> => {
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
                                    rawRes
                                );
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_end', this.summarizeToolResultForLedger(callInfo.toolName, processed), { invocationId: callInfo.invocationId });
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
                            toolResults[idx] = deduped.value;
                            if (deduped.reused) {
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_deduplicated', {
                                    toolName: callInfo.toolName,
                                    sourceInvocationId: deduped.sourceInvocationId,
                                }, { invocationId: callInfo.invocationId, status: 'done' });
                                await runLedger.appendEvent(
                                    runRecord.runId,
                                    'tool_call_end',
                                    this.summarizeToolResultForLedger(callInfo.toolName, toolResults[idx]),
                                    { invocationId: callInfo.invocationId, status: 'done' },
                                );
                            }
                            const repeatCount = toolDedupe.repeatCount(
                                callInfo.toolName,
                                callInfo.toolArgs,
                                options?.schedulingState?.authorization ?? mode,
                                targetResourceRevision,
                            );
                            if (repeatCount >= 2) {
                                await runLedger.appendEvent(runRecord.runId, 'tool_repeat_escalated', {
                                    toolName: callInfo.toolName,
                                    repeatCount,
                                    action: repeatCount >= 5 ? 'stop_or_narrow' : repeatCount >= 3 ? 'change_strategy' : 'observe',
                                }, { invocationId: callInfo.invocationId, status: repeatCount >= 5 ? 'failed' : 'pending' });
                                if (repeatCount >= 3) softLoopGuidancePending = true;
                                if (repeatCount >= 5) needsHashValidation = true;
                            }
                        } catch (e: any) {
                            if (e?.name === 'AbortError') throw e;
                            toolResults[idx] = { error: e instanceof Error ? e.message : String(e) };
                            await runLedger.appendEvent(runRecord.runId, 'tool_call_end', this.summarizeToolResultForLedger(callInfo.toolName, toolResults[idx]), { invocationId: callInfo.invocationId });
                        }
                    }));
                } else {
                    if (!WRITE_TOOLS.has(toolName)) {
                        const releaseLock = await toolScheduler.acquireLock(ci.concurrencyClass, options?.abortSignal);
                        try {
                            options?.abortSignal?.throwIfAborted();
                            await runLedger.appendEvent(runRecord.runId, 'tool_call_start', { toolName: ci.toolName }, { invocationId: ci.invocationId });
                            const rawRes = await this.executeToolPipeline(toolName, toolArgs, agentToolContext);
                            toolResults[i] = await this.processToolResult(
                                toolName,
                                ci.invocationId,
                                runRecord.runId,
                                options?.topicId || 'default',
                                rawRes
                            );
                            await runLedger.appendEvent(runRecord.runId, 'tool_call_end', this.summarizeToolResultForLedger(ci.toolName, toolResults[i]), { invocationId: ci.invocationId });
                        } catch (e: any) {
                            if (e?.name === 'AbortError') throw e;
                            toolResults[i] = { error: e instanceof Error ? e.message : String(e) };
                            await runLedger.appendEvent(runRecord.runId, 'tool_call_end', this.summarizeToolResultForLedger(ci.toolName, toolResults[i]), { invocationId: ci.invocationId });
                        } finally {
                            releaseLock();
                        }
                        continue;
                    }

                    // Write tool: execute serially taking advantage of PartitionedWriteQueue
                    const filePaths = getAgentToolTargetFiles(toolName, toolArgs, this.toolExecutor.workspaceRoot, options?.topicId);
                    const primaryFilePath = filePaths[0] ?? '';
                    const shouldAutoApplyWrite = options?.forceAutoApplyWrites === true || options?.useSlimPrompt === true;
                    const isSupersededWrite = SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has(toolName) && primaryFilePath &&
                        lastWriteIndexByFile.get(primaryFilePath) !== i;

                    // Collect all file paths that this tool touches for partitioned locking.
                    // Canonical keys make relative/absolute/case aliases share one lock.
                    const lockPaths = (filePaths.length > 0 ? filePaths : ['__global__'])
                        .map(p => p === '__global__' ? p : canonicalPathKey(p, this.toolExecutor.workspaceRoot));
                    const waitTimeoutMs = options?.writeQueueWaitTimeoutMs ?? (options?.useSlimPrompt ? 60_000 : 90_000);

                    try {
                        await this.writeQueue.enqueue(lockPaths, async () => {
                                const releaseLock = await toolScheduler.acquireLock(ci.concurrencyClass, options?.abortSignal);
                            try {
                                options?.abortSignal?.throwIfAborted();
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_start', { toolName: ci.toolName }, { invocationId: ci.invocationId });
                            
                            // Sub-agent snapshot isolate hook
                            if (onFileWrite && primaryFilePath) {
                                if (!fsModule) fsModule = await import('fs');
                                const prev = fsModule.existsSync(primaryFilePath) ? fsModule.readFileSync(primaryFilePath, 'utf8') : null;
                                onFileWrite(primaryFilePath, prev);
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
                                toolResults[i] = await this.processToolResult(
                                    toolName,
                                    ci.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes
                                );
                                const r = toolResults[i] as Record<string, unknown>;
                                if (r && (r.success || r.confirmed) && primaryFilePath) confirmedWrittenFiles.add(primaryFilePath);
                            } else if (WRITE_TOOLS.has(toolName) && primaryFilePath && (confirmedWrittenFiles.has(primaryFilePath) || shouldAutoApplyWrite)) {
                                const rawRes = await this.executeToolPipeline(toolName, { ...toolArgs, _autoApply: true }, agentToolContext);
                                toolResults[i] = await this.processToolResult(
                                    toolName,
                                    ci.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes
                                );
                            } else {
                                const rawRes = await this.executeToolPipeline(toolName, toolArgs, agentToolContext);
                                toolResults[i] = await this.processToolResult(
                                    toolName,
                                    ci.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes
                                );
                                if (WRITE_TOOLS.has(toolName) && primaryFilePath) {
                                    const r = toolResults[i] as Record<string, unknown>;
                                    if (r && (r.success || r.confirmed)) confirmedWrittenFiles.add(primaryFilePath);
                                }
                            }
                        } catch (e: any) {
                                if (e?.name === 'AbortError') throw e;
                                toolResults[i] = { error: e instanceof Error ? e.message : String(e) };
                            } finally {
                                const res = toolResults[i] as any;
                                const success = res && !res.error && !res.skipped;
                                await runLedger.appendEvent(
                                    runRecord.runId,
                                    'tool_call_end',
                                    { ...this.summarizeToolResultForLedger(ci.toolName, res), success },
                                    { invocationId: ci.invocationId }
                                );
                                if (success && primaryFilePath) {
                                    await runLedger.appendEvent(
                                        runRecord.runId,
                                        'file_change',
                                        { filePath: primaryFilePath },
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
                const mutationResult = toolResults[j] as Record<string, unknown> | undefined;
                if (!mutationResult
                    || mutationResult.success === false
                    || mutationResult.error !== undefined
                    || mutationResult.skipped === true) continue;
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
                for (let j = 0; j < parsedCalls.length; j++) {
                    const { toolName, toolCall } = parsedCalls[j]!;
                    const sig = `${toolCall.function.name}:${toolCall.function.arguments}`;
                    const resultHash = fnv32a(normalizeToolResultHash(toolName, toolResults[j]));
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
                for (let j = 0; j < parsedCalls.length; j++) {
                    const { toolName, toolCall } = parsedCalls[j]!;
                    const sig = `${toolCall.function.name}:${toolCall.function.arguments}`;
                    doomLoop.lastResultHash.set(sig, fnv32a(normalizeToolResultHash(toolName, toolResults[j])));
                }
            }

            if (forceStop) break;

            // Emit results in original order and feed back to AI
            for (let j = 0; j < parsedCalls.length; j++) {
                // Fix #10: use _prefix for intentionally unused destructured vars
                const { invocationId, toolName, toolArgs: _toolArgs, toolCall } = parsedCalls[j]!;  
                const toolResult = toolResults[j];
                if (runMetrics) {
                    runMetrics.maxToolResultChars = Math.max(
                        runMetrics.maxToolResultChars,
                        measureToolResultChars(toolResult)
                    );
                }

                emitStep({ type: 'tool_result', content: `${AGENT.TOOL_RESULT_PREFIX}: ${toolName}`, toolName, toolResult, timestamp: Date.now(), invocationId });

                // Track consecutive errors
                if (typeof toolResult === 'object' && toolResult !== null &&
                    'error' in toolResult && !('success' in toolResult)) {
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

            let nextToolStage = toolStage;
            for (let j = 0; j < parsedCalls.length; j++) {
                const result = toolResults[j];
                const record = result && typeof result === 'object' && !Array.isArray(result)
                    ? result as Record<string, unknown>
                    : undefined;
                const diagnostics = Array.isArray(record?.diagnostics) ? record.diagnostics : [];
                const diagnosticErrorCount = diagnostics.filter(item => {
                    if (!item || typeof item !== 'object') return false;
                    const severity = (item as Record<string, unknown>).severity;
                    return severity === 'error' || severity === 0;
                }).length;
                const hasDiagnosticErrors = diagnosticErrorCount > 0;
                const targetKeys = parsedCalls[j]!.targetPaths.length > 0
                    ? parsedCalls[j]!.targetPaths
                    : [`tool:${parsedCalls[j]!.toolName}`];
                const resultSucceeded = record?.success !== false && record?.error === undefined && record?.skipped !== true;
                if (resultSucceeded && isExecutionActionTool(parsedCalls[j]!.toolName)) {
                    executionActionObserved = true;
                }
                if (terminalValidation) {
                    updateTerminalValidationState(terminalValidation, targetKeys, record);
                }
                if (resultSucceeded && parsedCalls[j]!.toolName === 'todo_write') {
                    const rawTodos: unknown = parsedCalls[j]!.toolArgs.todos;
                    const todos: unknown[] = Array.isArray(rawTodos) ? rawTodos : [];
                    const nextCompletedTodoCount = todos.filter(todo =>
                        !!todo && typeof todo === 'object' && (todo as Record<string, unknown>).status === 'done').length;
                    if (nextCompletedTodoCount > completedTodoCount) progressRevision++;
                    completedTodoCount = nextCompletedTodoCount;
                    if (shouldEnterPlanFromTodos(schedulingState, todos)) {
                        const previousPhase = schedulingState.phase;
                        schedulingState = transitionSchedulingState(schedulingState, {
                            phase: 'plan',
                            reason: 'runtime task decomposition requires a design checkpoint',
                        });
                        if (options) options.schedulingState = schedulingState;
                        options?.runEventSink?.appendSoon('phase_changed', {
                            from: previousPhase,
                            to: schedulingState.phase,
                            reason: schedulingState.phaseReason,
                            revision: schedulingState.revision,
                        });
                    }
                }
                if (Array.isArray(record?.diagnostics)) {
                    for (const targetKey of targetKeys) {
                        const previousErrorCount = diagnosticErrorsByTarget.get(targetKey);
                        if (previousErrorCount !== undefined && diagnosticErrorCount < previousErrorCount) {
                            progressRevision++;
                        }
                        diagnosticErrorsByTarget.set(targetKey, diagnosticErrorCount);
                        if (hasDiagnosticErrors) blockingValidationIssues.add(targetKey);
                        else if (record?.freshness === 'fresh') blockingValidationIssues.delete(targetKey);
                    }
                }
                if (record?.requiresRepair === true) {
                    for (const targetKey of targetKeys) blockingValidationIssues.add(targetKey);
                } else if (record?.postWriteValidationPassed === true) {
                    for (const targetKey of targetKeys) blockingValidationIssues.delete(targetKey);
                }
                nextToolStage = advanceToolStage(mode, nextToolStage, parsedCalls[j]!.toolName, {
                    success: record?.success !== false && record?.error === undefined,
                    hasValidationErrors: hasDiagnosticErrors
                        || record?.postWriteValidationPassed === false
                        || record?.requiresRepair === true,
                });
                if (record?.success !== false
                    && record?.error === undefined
                    && parsedCalls[j]!.toolName === 'write_design_blueprint'
                    && schedulingState.phase !== 'plan') {
                    const previousPhase = schedulingState.phase;
                    schedulingState = transitionSchedulingState(schedulingState, {
                        phase: 'plan',
                        reason: 'design blueprint created after inspection',
                    });
                    if (options) options.schedulingState = schedulingState;
                    options?.runEventSink?.appendSoon('phase_changed', {
                        from: previousPhase,
                        to: 'plan',
                        reason: schedulingState.phaseReason,
                        revision: schedulingState.revision,
                    });
                }
            }
            if (schedulingState.phase === 'plan'
                && mode === 'utility'
                && toolStage === 'discovery'
                && nextToolStage === 'write') {
                // A mutation-authorized planning admission uses Utility's
                // validation surface as its design checkpoint before source
                // editors become visible.
                nextToolStage = 'validation';
            }
            if (nextToolStage !== toolStage) {
                const previousStage = toolStage;
                const previousToolNames = new Set(availableTools.map(tool => tool.function.name));
                toolStage = nextToolStage;
                if (tokenAccumulator) tokenAccumulator.toolStage = toolStage;
                const nextPhase = phaseForToolStage(toolStage, schedulingState.phase);
                if (nextPhase !== schedulingState.phase) {
                    const previousPhase = schedulingState.phase;
                    schedulingState = transitionSchedulingState(schedulingState, {
                        phase: nextPhase,
                        reason: `tool stage advanced to ${toolStage ?? 'full'}`,
                    });
                    if (options) options.schedulingState = schedulingState;
                    options?.runEventSink?.appendSoon('phase_changed', {
                        from: previousPhase,
                        to: nextPhase,
                        reason: schedulingState.phaseReason,
                        revision: schedulingState.revision,
                    });
                }
                availableTools = refreshAvailableTools();
                const nextToolNames = new Set(availableTools.map(tool => tool.function.name));
                options?.runEventSink?.appendSoon('capabilities_changed', {
                    stage: toolStage,
                    added: [...nextToolNames].filter(name => !previousToolNames.has(name)).sort(),
                    removed: [...previousToolNames].filter(name => !nextToolNames.has(name)).sort(),
                    toolHash: hashToolDefinitionsForFingerprint(availableTools),
                });
                const stageReminder = buildToolStageReminder(mode, toolStage, availableTools, options?.domain);
                if (stageReminder) {
                    messages.push({ role: 'user', content: stageReminder });
                }
                emitStep({
                    type: 'thinking',
                    content: `Tool stage advanced: ${previousStage ?? 'full'} -> ${toolStage ?? 'full'} (${availableTools.length} tools).`,
                    timestamp: Date.now(),
                });
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
                        summarizeThreshold: contextLimit * MID_LOOP_COMPACTION_RATIO,
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
            toolStage: 'finalize',
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

    private tryRepairJson(badJson: string | undefined): Record<string, unknown> | null {
        return _tryRepairJson(badJson);
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
* Verification loop: Check the LSP diagnosis of the target file after inference, and if there are errors, hand them over to AI for repair. 
* Use get_diagnostics to directly read the diagnostic panel (zero side effects), replacing the old validate_code (temporary file method). 
*/
    private async validationLoop(
        initialCode: string,
        targetFile: string,
        conversationMessages: ChatMessage[],
        emitStep: (step: AgentStep) => void,
        options?: AgentRunnerOptions,
        tokenAccumulator?: TokenUsage,
    ): Promise<Omit<GenerationResult, 'explanation' | 'steps'>> {
        let currentCode = initialCode;
        let retryCount = 0;
        let lastErrors: ValidationError[] = [];
        const validationRunRecord = options?.runRecord ?? await this.activeRunRecordPromise?.catch(() => undefined);
        let validationEndEmitted = false;
        if (validationRunRecord) {
            await runLedger.appendEvent(
                validationRunRecord.runId,
                'validation_start',
                { targetFile, maxRetries: MAX_VALIDATION_RETRIES },
                { status: 'running' }
            );
        }
        const appendValidationEnd = async (payload: Record<string, unknown>, status: 'done' | 'failed' = 'done') => {
            if (!validationRunRecord) return;
            if (validationEndEmitted) return;
            validationEndEmitted = true;
            await runLedger.appendEvent(
                validationRunRecord.runId,
                'validation_end',
                { targetFile, retryCount, ...payload },
                { status }
            ).catch(() => {});
        };

        const agentToolContext: import('./types').AgentToolContext = {
            runnerOptions: options,
            agentRunner: this,
            runEventSink: options?.runEventSink,
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
            // Same run as the main loop: share its anchor-guard scope.
            scopeId: validationRunRecord?.runId,
            onTodoUpdate: options?.onTodoUpdate
        };

        const readValidationDiagnostics = async (): Promise<{
            rawResult: GetDiagnosticsResult;
            diagnostics: ValidationError[];
            freshness?: 'fresh' | 'pending' | 'stale';
            pendingGlobalKinds: string[];
            lastEpoch?: number;
            diagnosticService?: GetDiagnosticsResult['diagnosticService'];
            validationStatus?: GetDiagnosticsResult['validationStatus'];
        }> => {
            const rawResult = await this.executeToolPipeline('get_diagnostics', {
                file: targetFile,
                severity: 'error',
            }, agentToolContext) as GetDiagnosticsResult;

            const diagnostics: ValidationError[] = [];
            if (rawResult?.diagnostics && Array.isArray(rawResult.diagnostics)) {
                for (const d of rawResult.diagnostics) {
                    diagnostics.push({
                        code: String(d.code ?? ''),
                        severity: d.severity ?? 'error',
                        message: String(d.message ?? ''),
                        line: Number(d.line ?? 0),
                        column: Number(d.column ?? 0),
                        currentVersion: d.currentVersion,
                        validatedVersion: d.validatedVersion,
                        category: d.category,
                        repairHint: d.repairHint,
                        expectedType: d.expectedType,
                        actualType: d.actualType,
                        scope: d.scope,
                        symbol: d.symbol,
                        confidence: d.confidence,
                        metadataSource: d.metadataSource,
                        data: d.data,
                    });
                }
            }

            const rawFreshness = rawResult?.freshness;
            const freshness = rawFreshness === 'fresh' || rawFreshness === 'pending' || rawFreshness === 'stale'
                ? rawFreshness
                : undefined;
            const pendingGlobalKinds = Array.isArray(rawResult?.pendingGlobalKinds)
                ? rawResult.pendingGlobalKinds.map((kind: unknown) => String(kind))
                : [];
            const lastEpoch = typeof rawResult?.lastEpoch === 'number' ? rawResult.lastEpoch : undefined;

            return {
                rawResult,
                diagnostics,
                freshness,
                pendingGlobalKinds,
                lastEpoch,
                diagnosticService: rawResult?.diagnosticService,
                validationStatus: rawResult?.validationStatus,
            };
        };

        while (retryCount <= MAX_VALIDATION_RETRIES) {
            options?.abortSignal?.throwIfAborted();

            emitStep({
                type: 'validation',
                content: retryCount === 0
                    ? 'Running validation diagnostics...'
                    : "Retrying validation fix " + retryCount + "...",
                timestamp: Date.now(),
            });

            // Use get_diagnostics to read directly from the diagnostics panel (zero side effects, ~50ms)
            let result: { isValid: boolean; errors: ValidationError[] };
            let rawDiagnosticResult: unknown | undefined;
            try {
                let diagnosticRead = await readValidationDiagnostics();
                rawDiagnosticResult = diagnosticRead.rawResult;
                let sawDiagnosticEpochProgress = false;

                for (let attempt = 0; diagnosticRead.diagnostics.length === 0
                    && (diagnosticRead.freshness === 'pending' || diagnosticRead.freshness === 'stale')
                    && attempt < VALIDATION_DIAGNOSTIC_FRESHNESS_RECHECK_DELAYS_MS.length; attempt++) {
                    const delayMs = VALIDATION_DIAGNOSTIC_FRESHNESS_RECHECK_DELAYS_MS[attempt]!;
                    const previousEpoch = diagnosticRead.lastEpoch;
                    emitStep({
                        type: 'validation',
                        content: `Validation diagnostics are ${diagnosticRead.freshness}; waiting ${delayMs}ms for CWTools LSP to settle.${this.formatValidationStatusBrief(diagnosticRead.validationStatus)}`,
                        timestamp: Date.now(),
                    });
                    await this.delay(delayMs);
                    options?.abortSignal?.throwIfAborted();
                    diagnosticRead = await readValidationDiagnostics();
                    rawDiagnosticResult = diagnosticRead.rawResult;
                    if (typeof previousEpoch === 'number'
                        && typeof diagnosticRead.lastEpoch === 'number'
                        && diagnosticRead.lastEpoch > previousEpoch) {
                        sawDiagnosticEpochProgress = true;
                    }
                }

                const diagnostics = diagnosticRead.diagnostics;
                const freshness = diagnosticRead.freshness;
                const pendingGlobalKinds = diagnosticRead.pendingGlobalKinds;
                if (diagnostics.length === 0 && (freshness === 'pending' || freshness === 'stale')) {
                    const fallbackErrors = this.runLocalSyntaxFallbackValidation(
                        targetFile,
                        currentCode,
                        freshness,
                        pendingGlobalKinds,
                        diagnosticRead.diagnosticService,
                        diagnosticRead.validationStatus,
                        sawDiagnosticEpochProgress,
                    );
                    const fallbackErrorCount = fallbackErrors.filter(e => e.severity === 'error').length;
                    if (fallbackErrorCount === 0) {
                        const pendingError: ValidationError = {
                            code: 'VALIDATION_PENDING',
                            severity: 'error',
                            message: `Local syntax passed, but CWTools diagnostics are still ${freshness}; final semantic validation is pending.`,
                            line: 0,
                            column: 0,
                        };
                        emitStep({
                            type: 'validation',
                            content: `CWTools LSP diagnostics are still ${freshness}; local syntax passed, but final semantic validation remains pending.`,
                            timestamp: Date.now(),
                        });
                        await appendValidationEnd({
                            isValid: false,
                            errorCount: 1,
                            warningCount: fallbackErrors.length,
                            validationMode: 'local-syntax-fallback',
                            diagnosticFreshness: freshness,
                            pendingGlobalKinds,
                            diagnosticService: diagnosticRead.diagnosticService?.status,
                            diagnosticEpochProgress: sawDiagnosticEpochProgress,
                            validationRuntime: this.compactValidationStatus(diagnosticRead.validationStatus),
                        }, 'failed');
                        return {
                            code: currentCode,
                            validationErrors: [...fallbackErrors, pendingError],
                            isValid: false,
                            retryCount,
                        };
                    }
                    emitStep({
                        type: 'validation',
                        content: `CWTools LSP diagnostics are still ${freshness}; local syntax fallback found ${fallbackErrorCount} issue(s).`,
                        timestamp: Date.now(),
                    });
                    result = {
                        isValid: false,
                        errors: fallbackErrors,
                    };
                } else {
                    result = {
                        isValid: diagnostics.length === 0,
                        errors: diagnostics,
                    };
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const diagnosticError: ValidationError = {
                    code: 'DIAGNOSTICS_UNAVAILABLE',
                    severity: 'error',
                    message: `get_diagnostics failed during validation: ${message}`,
                    line: 0,
                    column: 0,
                };
                emitStep({
                    type: 'validation',
                    content: 'Validation diagnostics unavailable; stopping validation as inconclusive.',
                    timestamp: Date.now(),
                });
                await appendValidationEnd({ isValid: false, errorCount: 1, diagnosticUnavailable: true }, 'failed');
                return {
                    code: currentCode,
                    validationErrors: [diagnosticError],
                    isValid: false,
                    retryCount,
                };
            }

            lastErrors = result.errors;

            if (result.isValid) {
                emitStep({
                    type: 'validation',
                    content: 'Validation passed.',
                    timestamp: Date.now(),
                });
                await appendValidationEnd({ isValid: true, errorCount: 0 });

                return {
                    code: currentCode,
                    validationErrors: result.errors,
                    isValid: true,
                    retryCount,
                };
            }

            //The number of retries has been exhausted
            if (retryCount >= MAX_VALIDATION_RETRIES) {
                emitStep({
                    type: 'validation',
                    content: `Validation still failed after ${MAX_VALIDATION_RETRIES} retries.`,
                    timestamp: Date.now(),
                });
                await appendValidationEnd({ isValid: false, errorCount: result.errors.length }, 'failed');
                break;
            }

            //Retry: send error list back to AI for correction
            retryCount++;
            const errorDiagnostics = result.errors.filter(e => e.severity === "error");
            emitStep({
                type: 'validation',
                content: "Found " + errorDiagnostics.length + " validation error(s); requesting a focused fix (" + retryCount + "/" + MAX_VALIDATION_RETRIES + ").",
                timestamp: Date.now(),
            });

            let diagnosticAdvice: string | undefined;
            try {
                const rawAnalysis = await this.executeToolPipeline('analyze_diagnostic_error', {
                    file: targetFile,
                    toolName: 'get_diagnostics',
                    diagnosticsSnapshot: rawDiagnosticResult ?? { diagnostics: result.errors },
                    message: 'validationLoop retry',
                    previousAttempt: retryCount > 1 ? `Validation retry ${retryCount - 1} did not clear diagnostics.` : undefined,
                }, agentToolContext);
                const analysis = rawAnalysis as Partial<AnalyzeDiagnosticErrorResult>;
                if (analysis.success) {
                    diagnosticAdvice = this.formatValidationDiagnosticAdvice(analysis);
                }
            } catch {
                // Validation retry can continue without routing advice.
            }

            const retryMessage = this.promptBuilder.buildValidationRetryMessage(
                currentCode,
                errorDiagnostics,
                diagnosticAdvice
            );

            const retryMessages: ChatMessage[] = [
                ...conversationMessages,
                {
                    role: 'assistant',
                    content: `\`\`\`pdx\n${currentCode}\n\`\`\``,
                },
                retryMessage,
            ];

            try {
                if (tokenAccumulator) {
                    tokenAccumulator.apiCalls = (tokenAccumulator.apiCalls ?? 0) + 1;
                }
                const retryResponse = await this.aiService.chatCompletion(retryMessages, {
                    providerId: options?.providerId,
                    model: options?.model,
                    reasoningEffort: options?.reasoningEffort,
                });
                this.accumulateAuxiliaryUsage(
                    retryResponse,
                    retryMessages,
                    tokenAccumulator,
                    options?.providerId,
                    options?.model,
                    {
                        toolStage: 'validation',
                        purpose: 'validation',
                        promptFingerprint: tokenAccumulator?.promptFingerprint,
                    },
                );

                const retryContent = contentToString(retryResponse.choices[0]?.message?.content);
                const fixedCode = this.extractCode(retryContent);

                if (fixedCode && fixedCode !== currentCode) {
                    currentCode = fixedCode;
                    emitStep({
                        type: 'code_generated',
                        content: 'Generated corrected code after validation.',
                        timestamp: Date.now(),
                    });
                } else {
                    // AI cannot be repaired
                    break;
                }
            } catch {
                break;
            }
        }

        await appendValidationEnd({ isValid: false, errorCount: lastErrors.length }, 'failed');
        return {
            code: currentCode,
            validationErrors: lastErrors,
            isValid: false,
            retryCount,
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private runLocalSyntaxFallbackValidation(
        targetFile: string,
        currentCode: string,
        freshness: 'pending' | 'stale',
        pendingGlobalKinds: string[],
        diagnosticService: GetDiagnosticsResult['diagnosticService'],
        validationStatus: GetDiagnosticsResult['validationStatus'],
        sawDiagnosticEpochProgress: boolean,
    ): ValidationError[] {
        const text = this.readValidationFallbackText(targetFile, currentCode);
        const syntaxErrors = this.scanLocalPdxSyntax(text);
        if (syntaxErrors.length > 0) {
            return syntaxErrors;
        }

        const pendingSuffix = pendingGlobalKinds.length
            ? ` Pending global checks: ${pendingGlobalKinds.join(', ')}.`
            : '';
        const serviceSuffix = diagnosticService
            ? ` Diagnostic service: ${diagnosticService.status}${diagnosticService.responded ? ', responded' : ', no response'}.`
            : ' Diagnostic service: unknown.';
        const epochSuffix = sawDiagnosticEpochProgress
            ? ' Diagnostic epoch advanced while waiting.'
            : ' Diagnostic epoch did not advance while waiting.';
        const runtimeSuffix = this.formatValidationStatusBrief(validationStatus);
        return [{
            code: 'VALIDATION_DEGRADED_LSP_NO_FEEDBACK',
            severity: 'warning',
            message: `CWTools LSP did not provide fresh diagnostics (${freshness}).${pendingSuffix}${serviceSuffix}${epochSuffix}${runtimeSuffix} Local syntax fallback found no brace/string errors, but semantic CWTools validation was not confirmed.`,
            line: 0,
            column: 0,
        }];
    }

    private compactValidationStatus(status?: GetDiagnosticsResult['validationStatus']): Record<string, unknown> | undefined {
        if (!status) return undefined;
        const runtime = status.runtime && typeof status.runtime === 'object'
            ? status.runtime as Record<string, unknown>
            : {};
        const loading = status.loading && typeof status.loading === 'object'
            ? status.loading as Record<string, unknown>
            : {};
        const completion = status.completion && typeof status.completion === 'object'
            ? status.completion as Record<string, unknown>
            : {};
        const refreshDomains = status.refreshDomains && typeof status.refreshDomains === 'object'
            ? status.refreshDomains as Record<string, unknown>
            : {};
        return {
            inProgress: status.inProgress,
            inProgressFile: status.inProgressFile,
            queueDepth: status.queueDepth,
            debounceQueueDepth: status.debounceQueueDepth,
            pendingGlobalKinds: status.pendingGlobalKinds,
            needsTypeRefresh: status.needsTypeRefresh,
            delayedLocalisationUpdate: status.delayedLocalisationUpdate,
            refreshSkipCount: status.refreshSkipCount,
            nextAnalyzeDelayMs: status.nextAnalyzeDelayMs,
            lastGlobalRefreshAtUnixMs: status.lastGlobalRefreshAtUnixMs,
            refreshPendingDomains: Array.isArray(refreshDomains.pendingDomains) ? refreshDomains.pendingDomains.map(String) : undefined,
            refreshLastCompletedDomains: Array.isArray(refreshDomains.lastCompletedDomains) ? refreshDomains.lastCompletedDomains.map(String) : undefined,
            refreshLastStatus: typeof refreshDomains.lastStatus === 'string' ? refreshDomains.lastStatus : undefined,
            lastRefreshStatus: typeof runtime.lastRefreshStatus === 'string' ? runtime.lastRefreshStatus : undefined,
            lastCycleElapsedMs: typeof runtime.lastCycleElapsedMs === 'number' ? runtime.lastCycleElapsedMs : undefined,
            lastAnalyzeElapsedMs: typeof runtime.lastAnalyzeElapsedMs === 'number' ? runtime.lastAnalyzeElapsedMs : undefined,
            loadingInProgress: typeof loading.inProgress === 'boolean' ? loading.inProgress : undefined,
            loadingPhase: typeof loading.phase === 'string' ? loading.phase : undefined,
            loadingElapsedMs: typeof loading.lastElapsedMs === 'number' ? loading.lastElapsedMs : undefined,
            loadedFileCount: typeof loading.lastFileCount === 'number' ? loading.lastFileCount : undefined,
            completionLastElapsedMs: typeof completion.lastElapsedMs === 'number' ? completion.lastElapsedMs : undefined,
            completionLastItemCount: typeof completion.lastItemCount === 'number' ? completion.lastItemCount : undefined,
            completionLastCacheHit: typeof completion.lastCacheHit === 'boolean' ? completion.lastCacheHit : undefined,
            completionLastIsIncomplete: typeof completion.lastIsIncomplete === 'boolean' ? completion.lastIsIncomplete : undefined,
            completionCacheHitRate: typeof completion.cacheHitRate === 'number' ? completion.cacheHitRate : undefined,
            completionTtlCacheEntries: typeof completion.ttlCacheEntries === 'number' ? completion.ttlCacheEntries : undefined,
        };
    }

    private formatValidationStatusBrief(status?: GetDiagnosticsResult['validationStatus']): string {
        const compact = this.compactValidationStatus(status);
        if (!compact) return '';
        const parts: string[] = [];
        if (typeof compact.inProgress === 'boolean') parts.push(`inProgress=${compact.inProgress}`);
        if (typeof compact.inProgressFile === 'string' && compact.inProgressFile) parts.push(`file=${path.basename(compact.inProgressFile)}`);
        if (typeof compact.queueDepth === 'number') parts.push(`queue=${compact.queueDepth}`);
        if (typeof compact.debounceQueueDepth === 'number') parts.push(`debounce=${compact.debounceQueueDepth}`);
        if (Array.isArray(compact.pendingGlobalKinds) && compact.pendingGlobalKinds.length > 0) parts.push(`pending=${compact.pendingGlobalKinds.join('/')}`);
        if (typeof compact.needsTypeRefresh === 'boolean' && compact.needsTypeRefresh) parts.push('needsTypeRefresh=true');
        if (typeof compact.delayedLocalisationUpdate === 'boolean' && compact.delayedLocalisationUpdate) parts.push('delayedLoc=true');
        if (Array.isArray(compact.refreshPendingDomains) && compact.refreshPendingDomains.length > 0) parts.push(`domains=${compact.refreshPendingDomains.join('/')}`);
        if (Array.isArray(compact.refreshLastCompletedDomains) && compact.refreshLastCompletedDomains.length > 0) parts.push(`lastDomains=${compact.refreshLastCompletedDomains.join('/')}`);
        if (typeof compact.refreshLastStatus === 'string') parts.push(`domainStatus=${compact.refreshLastStatus}`);
        if (typeof compact.nextAnalyzeDelayMs === 'number') parts.push(`nextDelayMs=${compact.nextAnalyzeDelayMs}`);
        if (typeof compact.lastRefreshStatus === 'string') parts.push(`lastRefresh=${compact.lastRefreshStatus}`);
        if (compact.loadingInProgress === true || typeof compact.loadingPhase === 'string') {
            const loadingBits = [
                typeof compact.loadingPhase === 'string' ? compact.loadingPhase : undefined,
                compact.loadingInProgress === true ? 'in-progress' : undefined,
                typeof compact.loadedFileCount === 'number' ? `files=${compact.loadedFileCount}` : undefined,
            ].filter(Boolean).join('/');
            if (loadingBits) parts.push(`loading=${loadingBits}`);
        }
        if (typeof compact.completionLastElapsedMs === 'number' && compact.completionLastElapsedMs > 0) {
            const completionBits = [
                `${compact.completionLastElapsedMs}ms`,
                typeof compact.completionLastItemCount === 'number' ? `${compact.completionLastItemCount} items` : undefined,
                compact.completionLastCacheHit === true ? 'ttl-hit' : undefined,
                compact.completionLastIsIncomplete === true ? 'incomplete' : undefined,
            ].filter(Boolean).join('/');
            if (completionBits) parts.push(`completion=${completionBits}`);
        }
        return parts.length ? ` Runtime: ${parts.join(', ')}.` : '';
    }

    private readValidationFallbackText(targetFile: string, currentCode: string): string {
        if (targetFile && fs.existsSync(targetFile)) {
            try {
                return fs.readFileSync(targetFile, 'utf8');
            } catch {
                // Fall through to the generated code block.
            }
        }
        return currentCode;
    }

    private scanLocalPdxSyntax(text: string): ValidationError[] {
        const errors: ValidationError[] = [];
        const braceStack: Array<{ line: number; column: number }> = [];
        const lines = text.split(/\r?\n/);

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex] ?? '';
            let inString = false;
            let stringStartColumn = 0;
            let escaped = false;

            for (let column = 0; column < line.length; column++) {
                const ch = line[column];
                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (ch === '\\') {
                        escaped = true;
                    } else if (ch === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (ch === '#') break;
                if (ch === '"') {
                    inString = true;
                    stringStartColumn = column;
                    continue;
                }
                if (ch === '{') {
                    braceStack.push({ line: lineIndex, column });
                } else if (ch === '}') {
                    const opened = braceStack.pop();
                    if (!opened) {
                        errors.push({
                            code: 'LOCAL_SYNTAX_UNEXPECTED_CLOSING_BRACE',
                            severity: 'error',
                            message: 'Unexpected closing brace in local syntax fallback validation.',
                            line: lineIndex,
                            column,
                        });
                    }
                }
            }

            if (inString) {
                errors.push({
                    code: 'LOCAL_SYNTAX_UNTERMINATED_STRING',
                    severity: 'error',
                    message: 'Unterminated string in local syntax fallback validation.',
                    line: lineIndex,
                    column: stringStartColumn,
                });
            }
            if (errors.length >= 20) return errors;
        }

        for (const opened of braceStack.slice(-20)) {
            errors.push({
                code: 'LOCAL_SYNTAX_MISSING_CLOSING_BRACE',
                severity: 'error',
                message: 'Missing closing brace in local syntax fallback validation.',
                line: opened.line,
                column: opened.column,
            });
        }
        return errors;
    }

    private formatValidationDiagnosticAdvice(analysis: Partial<AnalyzeDiagnosticErrorResult>): string {
        const recommendedTools = Array.isArray(analysis.recommendedTools) ? analysis.recommendedTools.join(', ') : '';
        const avoidTools = Array.isArray(analysis.avoidTools) ? analysis.avoidTools.join(', ') : '';
        const references = Array.isArray(analysis.referenceCandidates) ? analysis.referenceCandidates.join(', ') : '';
        const lines = [
            `Category: ${analysis.category ?? 'unknown'}`,
            `Recommended tools: ${recommendedTools || '(none)'}`,
            avoidTools ? `Avoid tools/patterns: ${avoidTools}` : '',
            references ? `Concrete references: ${references}` : '',
            analysis.referenceVerificationRequired ? 'Reference verification required before another write.' : '',
            analysis.verificationInstruction ? `Verification instruction: ${analysis.verificationInstruction}` : '',
            analysis.requiredFreshRead ? 'Fresh read required before writing.' : '',
            analysis.suspectedStaleCache ? 'Freshness warning: diagnostics may be pending/stale; avoid duplicate writes.' : '',
            analysis.nextInstruction ? `Next instruction: ${analysis.nextInstruction}` : '',
            analysis.stopReason ? `Stop reason: ${analysis.stopReason}` : '',
        ].filter(Boolean);
        return lines.join('\n');
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
