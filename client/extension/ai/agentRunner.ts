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
    CustomApiFormat,
    TokenUsage,
    AgentRunMetrics,
    AnalyzeDiagnosticErrorResult,
    GetDiagnosticsResult,
} from './types';
import { contentToString } from './types';
import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// P1-7: contentToString is now imported from './types' — see import above.

import { AIService } from './aiService';
import { AgentToolExecutor, TOOL_DEFINITIONS } from './agentTools';
import { PromptBuilder } from './promptBuilder';
import { getProvider, isModelVisionCapable } from './providers';
import { getModelPricing, getCacheDiscountFactor } from './pricing';
import { parseDsmlToolCalls as _parseDsmlToolCalls, stripDsmlMarkup as _stripDsmlMarkup, stripThinkBlocks as _stripThinkBlocks, cleanFinalContent as _cleanFinalContent } from './toolCallParser';
import { tryRepairJson as _tryRepairJson } from './jsonRepair';
import { repairToolArgs } from './tools/argRepair';
import { budgetToolResult as _budgetToolResult, compactMessagesInPlace as _compactMessagesInPlace, getToolResultBudget } from './contextBudget';
import type { CompactMessagesOptions } from './contextBudget';
import { AGENT, SOURCE } from './messages';
import { ErrorReporter } from './errorReporter';
import { getProjectWorkspaceRoot, getTopicStorageDir, getTopicStorageDirCandidates } from './workspacePaths';
import {
    filterToolDefinitionsForMode,
    resolveMaxToolIterations,
    resolveRunMaxOutputTokens,
    SLIM_SUB_AGENT_OUTPUT_BUDGET_RECOVERY_LIMIT,
    SLIM_SUB_AGENT_THINKING_CHAR_LIMIT,
} from './runnerPolicy';
import { getWorkflow } from './workflowRegistry';
import { TOOL_REGISTRY, WRITE_TOOLS, READ_ONLY_TOOLS } from './tools/registry';
import { PartitionedWriteQueue } from './runner/writeCoordinator';
import { runLedger } from './runner/runLedger';
import { loadResumeState, hasResumeState, saveResumeState as saveCheckpointResumeState } from './runner/checkpoint';
import { maybeCompactHistory as _maybeCompactHistory, MID_LOOP_COMPACTION_INTERVAL, MID_LOOP_COMPACTION_RATIO, DEFAULT_CONTEXT_LIMIT } from './runner/compaction';
import { executeFallbackRetry, isFallbackEligibleApiError } from './runner/fallbackPolicy';
import { SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS, getAgentToolTargetFiles, toolScheduler } from './runner/toolScheduler';
import { buildToolInvocation } from './runner/toolInvocation';
import { DOOM_LOOP_SOFT_THRESHOLD, DOOM_LOOP_PAIR_THRESHOLD, fnv32a, normalizeToolResultHash, DoomLoopState } from './runner/doomLoopDetector';
import { ReadTracker } from './runner/readTracker';
import { validateGitOpsForMode, validatePlanModeToolUse } from './planModeGuard';

export { isFallbackEligibleApiError } from './runner/fallbackPolicy';
export { getAgentToolTargetFiles, SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS } from './runner/toolScheduler';
export { DOOM_LOOP_SOFT_THRESHOLD, DOOM_LOOP_PAIR_THRESHOLD, fnv32a, normalizeToolResultHash } from './runner/doomLoopDetector';
export { AgentAbortError, checkCancellation, isAbortError } from './runner/cancellation';
export { StepEmitter } from './runner/stepEmitter';


// Maximum validation-retry rounds (reduced: edit_file now returns inline LSP diagnostics)
const MAX_VALIDATION_RETRIES = 2;
const VALIDATION_DIAGNOSTIC_FRESHNESS_RECHECK_DELAYS_MS = [500, 1500, 3000];
// Token estimation: Dual-path strategy for balancing speed and accuracy.
// Path 1 (fast): Short text (<1000 chars) uses character-ratio interpolation.
// Path 2 (precise): Longer text uses sub-word segmentation heuristic for
//   better accuracy in compaction/context-window decisions (~10% more precise
//   than pure char ratio, without requiring an external tokenizer dependency).
const CHARS_PER_TOKEN_ASCII = 4;
const CHARS_PER_TOKEN_CJK = 1.5;
/** Threshold for switching to precise estimation */
const PRECISE_TOKEN_THRESHOLD = 1000;
 
const CJK_RANGE = /[\u3000-\u9fff\uf900-\ufaff\ufe30-\ufe4f]/g;

/** Fast char-ratio estimation (original method) */
function estimateTokensFast(text: string): number {
    const sample = text.length > 4000 ? text.substring(0, 4000) : text;
    const cjkMatches = sample.match(CJK_RANGE);
    const cjkRatio = cjkMatches ? cjkMatches.length / sample.length : 0;
    const charsPerToken = CHARS_PER_TOKEN_ASCII * (1 - cjkRatio) + CHARS_PER_TOKEN_CJK * cjkRatio;
    return Math.ceil(text.length / charsPerToken);
}

/**
 * Precise sub-word segmentation heuristic.
 * Counts: word boundaries (split on whitespace/punctuation), CJK chars (each ≈ 1 token),
 * numbers (each digit sequence ≈ 1-2 tokens), and code tokens (operators, brackets).
 * Accuracy: typically within 10-15% of BPE tokenizers on mixed CJK/English code text.
 */
function estimateTokensPrecise(text: string): number {
    let tokens = 0;
    // Sample up to 8000 chars for estimation, then extrapolate
    const sample = text.length > 8000 ? text.substring(0, 8000) : text;
    const ratio = text.length / sample.length;

    // Count CJK characters (each is typically 1 token in most tokenizers)
    const cjkMatches = sample.match(CJK_RANGE);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    tokens += cjkCount;

    // Remove CJK chars and count remaining as English/code
    const nonCjk = sample.replace(CJK_RANGE, ' ');

    // Split on whitespace to get word-like segments
    const words = nonCjk.split(/\s+/).filter(w => w.length > 0);
    for (const word of words) {
        if (word.length <= 3) {
            tokens += 1; // Short words = 1 token
        } else if (word.length <= 7) {
            tokens += 1; // Medium words ≈ 1 token
        } else if (word.length <= 12) {
            tokens += 2; // Long words ≈ 2 sub-word tokens
        } else {
            // Very long words (identifiers, URLs): ~1 token per 4 chars
            tokens += Math.ceil(word.length / 4);
        }
    }

    return Math.ceil(tokens * ratio);
}

/**
 * Estimate token count for a string.
 * Uses fast path for short text, precise path for longer text
 * (compaction decisions, context window calculations).
 */
export function estimateTokenCount(text: string): number {
    if (text.length < PRECISE_TOKEN_THRESHOLD) {
        return estimateTokensFast(text);
    }
    return estimateTokensPrecise(text);
}





// Backward-compat alias for non-text token estimation (images etc.)
export const CHARS_PER_TOKEN = 4;

export function supportsOpenAiStylePrefixCache(providerId: string, customApiFormat?: CustomApiFormat): boolean {
    if (providerId.startsWith('deepseek') || providerId.startsWith('openai')) return true;
    if (providerId === 'custom') {
        return customApiFormat === 'openai-chat-completions' || customApiFormat === 'openai-responses';
    }
    return false;
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



export interface AgentRunnerOptions {
    /** Override provider for this run */
    providerId?: string;
    /** Override model for this run */
    model?: string;
    /** Dynamic maximum context tokens for this run */
    maxContextTokens?: number;
    /** Override the reasoning-loop iteration limit. Used by orchestrator role budgets. */
    maxIterations?: number;
    /** Agent mode: build (default), plan (read-only), explore (parallel read), general (research) */
    mode?: AgentMode;
    /** Callback for real-time step updates (for UI) */
    onStep?: (step: AgentStep) => void;
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
    onTodoUpdate?: (todos: import('./types').TodoItem[]) => void;
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
    'query_scope', 'query_types', 'query_rules', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'todo_write',
    'read_file', 'list_directory', 'get_lsp_status', 'get_diagnostics', 'web_fetch', 'search_web',
    'glob_files', 'codesearch',
    // Deep API tools for archetype study in Plan mode
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_definition', 'query_definition_by_name',
    'query_static_modifiers', 'query_variables',
    // Structured design blueprint output
    'write_design_blueprint', 'save_workflow',
    // Memory tools for persisting architectural state
    'set_memory', 'get_memory', 'search_memory',
    // Git operations for investigation
    'git_ops', 'save_workflow',
];

/** Explore mode: same as plan, plus CWTools Deep API tools — no writes (OpenCode explore agent) */
const _EXPLORE_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_lsp_status', 'get_diagnostics', 'web_fetch', 'search_web', 'glob_files',
    // CWTools Deep API tools (read-only, advertised in Explore mode prompt)
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'query_definition', 'query_definition_by_name', 'codesearch',
    // Git operations for investigation
    'git_ops', 'save_workflow',
];

/** General mode: legacy read-only Q&A mode. */
const _GENERAL_EXCLUDED_TOOLS: AgentToolName[] = ['todo_write'];

/** Utility mode: full ordinary coding tools for non-PDX helper scripts/tools. */
const _UTILITY_EXCLUDED_TOOLS: AgentToolName[] = ['dispatch_agents', 'query_blackboard', 'merge_results'];

/** Review mode: same as explore, plus query_definition — read-only tools only */
const _REVIEW_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_lsp_status', 'get_diagnostics', 'query_definition', 'query_definition_by_name',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'web_fetch', 'search_web', 'glob_files', 'codesearch',
    // Git operations for investigation
    'git_ops',
];

/** Loc Translator mode: read localisation files, write translated output */
const _LOC_TRANSLATOR_TOOLS: AgentToolName[] = [
    'read_file', 'write_file', 'edit_file', 'replace_lines',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'workspace_symbols',
    'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_lsp_status', 'get_diagnostics',
    'query_localisation_index', 'query_workspace_index',
    'todo_write',
    'write_localisation', 'git_ops', 'save_workflow',
];

/** Loc Writer mode: create new localisation entries from scratch */
const _LOC_WRITER_TOOLS: AgentToolName[] = [
    'read_file', 'write_file', 'edit_file', 'replace_lines',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'workspace_symbols',
    'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_lsp_status', 'get_diagnostics',
    'query_types', 'query_rules', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'todo_write',
    'write_localisation', 'git_ops', 'save_workflow',
];

/** Orchestrator mode: read-only tools + coordinator-specific tools (dispatch_agents, query_blackboard, merge_results) */
const _ORCHESTRATOR_MODE_TOOLS: AgentToolName[] = [
    //Read-only information collection
    'query_scope', 'query_types', 'query_rules', 'query_references', 'query_localisation_index', 'query_workspace_index',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_lsp_status', 'get_diagnostics', 'web_fetch', 'search_web', 'glob_files', 'codesearch',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'query_definition', 'query_definition_by_name',
    // Blackboard and task management
    'set_memory', 'get_memory', 'search_memory', 'todo_write',
    // Coordinator-specific
    'dispatch_agents', 'query_blackboard', 'merge_results',
    // Git
    'git_ops', 'save_workflow',
];




const globalPartitionedWriteQueue = new PartitionedWriteQueue();

export class AgentRunner {
    public readonly readTracker = new ReadTracker();
    private writeQueue = globalPartitionedWriteQueue;
    private activeRunRecordPromise?: Promise<import('./types').AgentRunRecord>;
    constructor(
        private aiService: AIService,
        public readonly toolExecutor: AgentToolExecutor,
        private promptBuilder: PromptBuilder
    ) {
        this.toolExecutor.parentAgentRunner = this;
    }

    public clearPromptCache(): void {
        this.promptBuilder.clearFrozenPromptCache();
    }

    public getActiveRunRecordPromise(): Promise<import('./types').AgentRunRecord> | undefined {
        return this.activeRunRecordPromise;
    }

    // ─── Transaction Management ────────────────────────────────────────────────
    public pendingTransactions = new Map<string, Map<string, string>>();

    public async commitTransaction(txId: string): Promise<boolean> {
        const vfs = this.pendingTransactions.get(txId);
        if (!vfs) return false;

        try {
            for (const [filePath, content] of vfs.entries()) {
                const fs = await import('fs');
                const path = await import('path');
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, content, 'utf-8');
            }
            this.pendingTransactions.delete(txId);
            return true;
        } catch (e) {
            ErrorReporter.fatal(SOURCE.AGENT_RUNNER, `Failed to commit transaction ${txId}`, e);
            return false;
        }
    }

    public discardTransaction(txId: string): boolean {
        return this.pendingTransactions.delete(txId);
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
        topicId?: string
    ): Promise<void> {
        try {
            const fs = await import('fs');
            const pathModule = await import('path');
            const wsRoot = getProjectWorkspaceRoot();

            const checkpointDir = getTopicStorageDir(topicId || 'default', wsRoot);
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
                todoSnapshot: JSON.stringify(this.toolExecutor.getTodos()),
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

            const checkpointPath = getTopicStorageDirCandidates(topicId, wsRoot)
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
        runId?: string,
        pendingToolCalls?: any[]
    ): Promise<void> {
        await saveCheckpointResumeState(topicId, mode, messages, this.toolExecutor, runId, pendingToolCalls);
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
            for (const resumeDir of getTopicStorageDirCandidates(topicId, wsRoot)) {
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
        return isFallbackEligibleApiError(error);
    }

    /**
     * Attempt to retry a failed API call with a fallback provider/model.
     * Returns the response on success, or null if no fallback is available or all fail.
     */
    private async tryFallbackProvider(
        messages: ChatMessage[],
        originalProviderId: string,
        options?: { tools?: import('./types').ToolDefinition[]; model?: string },
        emitStep?: (step: AgentStep) => void
    ): Promise<ChatCompletionResponse | null> {
        return executeFallbackRetry(this.aiService, messages, originalProviderId, options, emitStep);
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
        let mode = options?.mode ?? 'build';
        const topicId = context.topicId || 'default';
        const userPromptPreview = userMessage.substring(0, 100);
        const runRecordPromise = runLedger.createRun(topicId, mode, userPromptPreview).then(async r => {
            await runLedger.appendEvent(r.runId, 'status_changed', { status: 'planning' });
            return r;
        });
        this.activeRunRecordPromise = runRecordPromise;

        const emitStep = (step: AgentStep) => {
            steps.push(step);
            options?.onStep?.(step);
            runRecordPromise.then(r => {
                runLedger.appendEvent(r.runId, 'step_appended', { step }).catch(() => {});
            }).catch(() => {});
        };
        const updateRunStatus = (status: import('./types').AgentRunStatus) => {
            runRecordPromise.then(r => {
                runLedger.appendEvent(r.runId, 'status_changed', { status }).catch(() => {});
                if (status === 'completed' || status === 'failed') {
                    runLedger.appendEvent(r.runId, 'metrics_updated', {
                        metrics: {
                            totalTokens: tokenAccumulator.total,
                            promptTokens: tokenAccumulator.input,
                            completionTokens: tokenAccumulator.output,
                            cachedTokens: tokenAccumulator.cachedTokens || 0,
                            costCny: tokenAccumulator.estimatedCostCny,
                            iterations: runMetrics.iterations,
                            toolCalls: runMetrics.toolCallCount
                        }
                    }).catch(() => {});
                }
            }).catch(() => {});
        };
            // Empty
        // Empty

        // Accumulate token usage across all API calls in this generation
        // (declared here so compaction call and sub-agent dispatch can also contribute to the total)
        const tokenAccumulator: TokenUsage = { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
        const runMetrics: AgentRunMetrics = {
            iterations: 0,
            maxIterations: 0,
            toolCallCount: 0,
            toolCallsByName: {},
            repeatedToolSignatureCount: 0,
            maxToolResultChars: 0,
            finalPromptTokens: 0,
        };
        const shouldKeepResumeState = () => steps.some(step =>
            step.type === 'error' && String(step.content).startsWith('Max tool iterations reached')
        );
        const clearResumeStateIfComplete = async () => {
            if (context.topicId && !shouldKeepResumeState()) {
                await this.clearResumeState(context.topicId);
            }
        };

        // Context object to be passed to tool executor (replaces old global assignment)
        const _agentToolContext: import('./types').AgentToolContext = {
            runnerOptions: options,
            agentRunner: this,
            tokenAccumulator: tokenAccumulator,
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
            onBeforeFileWrite: options?.onBeforeFileWrite,
            onTodoUpdate: options?.onTodoUpdate
        };

        // Context compaction: if history is too long, summarize it
        const compactedHistory = await this.maybeCompactHistory(
            conversationHistory, emitStep, options, tokenAccumulator
        );

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

        const runRecord = await runRecordPromise;
        const runId = runRecord.runId;
        // topicId is already declared in function scope

        // 收集 Pinned Context 实时数据 (Todos & Diagnostics)
        let pinnedData: any = undefined;
        if (topicId) {
            const todos = this.toolExecutor.getExternalToolHandler().getTodos();
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

        // 异步静默触发一次 Context Memory Compaction 看板压缩
        if (topicId && runId) {
            const runRec = runLedger.getRun(runId);
            if (runRec) {
                import('./runner/contextMemory').then(async ({ compactHistory }) => {
                    await runLedger.appendEvent(runId, 'compaction_start', { kind: 'structured_summary', trigger: 'background' }).catch(() => {});
                    const summary = await compactHistory(topicId, runId, conversationHistory, runRec.steps || [], this.aiService);
                    await runLedger.appendEvent(runId, 'compaction_end', { kind: 'structured_summary', success: true, summary }).catch(() => {});
                }).catch((error) => {
                    runLedger.appendEvent(runId, 'compaction_end', { kind: 'structured_summary', success: false, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
                }).catch(() => {});
            }
        }

        const promptConfig = this.aiService.getConfig();
        const providerForPrompt = options?.providerId ?? promptConfig.provider;
        const supportsPrefixCache = supportsOpenAiStylePrefixCache(providerForPrompt, promptConfig.customApiFormat);
        // DeepSeek prefix-cache optimization: use frozen (session-cached) system prompt
        // to ensure byte-level stability across API calls for cache hits.
        let systemPrompt = options?.useSlimPrompt
            ? this.promptBuilder.buildSlimSystemPromptForMode(mode, providerForPrompt, undefined, topicId)
            : supportsPrefixCache
                ? this.promptBuilder.buildFrozenSystemPrompt(mode, providerForPrompt, undefined)
                : this.promptBuilder.buildSystemPromptForMode(mode, providerForPrompt, undefined, topicId, runId, pinnedData);

        // Inject workflow prompt supplement if running within a workflow
        const activeWorkflowForPrompt = options?.workflowId ? getWorkflow(options.workflowId) : undefined;
        if (!supportsPrefixCache && activeWorkflowForPrompt?.promptSupplement) {
            systemPrompt = activeWorkflowForPrompt.promptSupplement + '\n\n' + systemPrompt;
        }

        // Build the dynamic prompt block containing pinned data / summaries
        const dynamicBlock = supportsPrefixCache
            ? this.promptBuilder.buildDynamicPromptBlock(pinnedData, topicId, runId, {
                mode,
                workflow: activeWorkflowForPrompt
                    ? {
                        id: activeWorkflowForPrompt.id,
                        title: activeWorkflowForPrompt.title,
                        promptSupplement: activeWorkflowForPrompt.promptSupplement,
                    }
                    : undefined,
            })
            : [];

        // Build the message array
        let messages: ChatMessage[];
        
        if (options?.resumeFromState && context.topicId) {
            const resumeState = await this.loadResumeState(context.topicId);
            if (resumeState) {
                messages = resumeState.messages;
                mode = resumeState.mode ?? mode;
                options = { ...options, mode };
                if (resumeState.todos && resumeState.todos.length > 0) {
                    void this.toolExecutor.getExternalToolHandler().todoWrite({ todos: resumeState.todos });
                }
                if (resumeState.pendingToolCalls && resumeState.pendingToolCalls.length > 0) {
                    (this as any).initialPendingToolCalls = resumeState.pendingToolCalls;
                }
                emitStep({
                    type: 'thinking',
                    content: '已从断点快照中恢复上下文并继续执行...',
                    timestamp: Date.now(),
                });
            } else {
                messages = [
                    { role: 'system', content: systemPrompt },
                    ...this.promptBuilder.buildContextMessages({
                        ...context,
                        commandToolsAvailable: options?.useSlimPrompt !== true,
                    }),
                    ...compactedHistory,
                    ...dynamicBlock,
                    { role: 'user', content: userContent },
                ];
            }
        } else {
            messages = [
                { role: 'system', content: systemPrompt },
                ...this.promptBuilder.buildContextMessages({
                    ...context,
                    commandToolsAvailable: options?.useSlimPrompt !== true,
                }),
                ...compactedHistory,
                ...dynamicBlock,
                { role: 'user', content: userContent },
            ];
        }

        if (context.topicId) {
            options = { ...options, topicId: context.topicId, mode };
            await this.saveResumeState(context.topicId, messages, mode, runId);
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
            const finalMessage = await this.reasoningLoop(messages, emitStep, mode, options, tokenAccumulator, options?.onBeforeFileWrite, runMetrics);
            runMetrics.finalPromptTokens = messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);

            // Auto-mark remaining in-progress todos as done on successful completion
            this.autoCompleteTodos();

            // Phase 2: Extract code from the response
            const code = this.extractCode(finalMessage);

            // Plan / Explore / General / Review / Orchestrator mode — or no code generated — just an explanation
            if (!code || mode === 'plan' || mode === 'explore' || mode === 'general' || mode === 'utility' || mode === 'review' || mode === 'orchestrator' || mode === 'script') {
                updateRunStatus('completed');
                await clearResumeStateIfComplete();
                return {
                    code: '',
                    explanation: finalMessage,
                    validationErrors: [],
                    isValid: true,
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
                await clearResumeStateIfComplete();
                return {
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
                code, targetFile, messages, emitStep, options
            );

            updateRunStatus('completed');
            await clearResumeStateIfComplete();
            return {
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
                emitStep({ type: 'error', content: AGENT.CANCELLED, timestamp: Date.now() });
            } else {
                emitStep({ type: 'error', content: `${AGENT.ERROR_PREFIX}: ${errorMsg}`, timestamp: Date.now() });
            }

            if (context.topicId) {
                await this.saveResumeState(context.topicId, messages, mode, runId);
            }
            runMetrics.finalPromptTokens = messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);

            return {
                code: '',
                explanation: `[执行异常] ${errorMsg}`,
                validationErrors: [],
                isValid: false,
                retryCount: 0,
                steps,
                tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                runMetrics,
            };
        }
    }




    /**
     * Auto-mark remaining in-progress todos as done when the run completes successfully.
     * Prevents the task window from showing stale in-progress items after the AI finishes.
     */
    private autoCompleteTodos(): void {
        const handler = this.toolExecutor.getExternalToolHandler();
        const todos = handler.getTodos();
        if (todos.length === 0) return;

        let updated = false;
        for (const item of todos) {
            if (item.status === 'in_progress') {
                item.status = 'done';
                updated = true;
            }
        }
        if (updated) {
            void handler.todoWrite({ todos });
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
        tokenAccumulator?: import('./types').TokenUsage
    ): Promise<import('./types').ChatMessage[]> {
        return _maybeCompactHistory(history, emitStep, { aiService: this.aiService, promptBuilder: this.promptBuilder }, options, tokenAccumulator);
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

        // Auto-truncation threshold: 16000 chars (approx. 4000-8000 tokens)
        const LIMIT = 16000;
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
            const fs = await import('fs');
            const pathModule = await import('path');
            const wsRoot = getProjectWorkspaceRoot();
            const runDir = pathModule.join(getTopicStorageDir(topicId, wsRoot), 'runs', runId, 'large_results');
            if (!fs.existsSync(runDir)) {
                fs.mkdirSync(runDir, { recursive: true });
            }

            const filePath = pathModule.join(runDir, `${invocationId}_result.json`);
            fs.writeFileSync(filePath, typeof result === 'string' ? result : JSON.stringify(result, null, 2), 'utf-8');

            const relativeDiskPath = pathModule.relative(wsRoot, filePath);
            const preview = strContent.substring(0, 1000);
            await runLedger.appendEvent(
                runId,
                'artifact_created',
                {
                    kind: 'tool_result',
                    title: `${toolName} result`,
                    filePath: relativeDiskPath,
                    resultRef: relativeDiskPath,
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
                message: `[WARNING: The result of tool ${toolName} was automatically truncated to 1000 characters to prevent context window overflow (Original size was ${strContent.length} chars). The full, un-truncated output has been securely archived on local disk for safety.]`,
                preview,
                fullResultLocalPath: relativeDiskPath,
                resultRef: relativeDiskPath
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
                message: `[WARNING: The result of tool ${toolName} was truncated due to massive size (${strContent.length} chars).]`,
                preview: strContent.substring(0, 1000)
            };
        }
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
        const previewSource = typeof resultRecord?.preview === 'string' ? resultRecord.preview : strContent;
        return {
            toolName,
            success: !error && !skipped && resultRecord?.success !== false,
            error,
            skipped,
            truncated: !!resultRecord?.truncated,
            resultRef,
            resultSize: strContent.length,
            preview: previewSource.substring(0, 1000)
        };
    }

    private loadPinnedContextSummary(topicId: string, runId: string): { blocked?: string[]; decisions?: string[] } | undefined {
        try {
            const summaryPath = path.join(getTopicStorageDir(topicId, getProjectWorkspaceRoot()), 'runs', runId, 'summary.json');
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

    private async reasoningLoop(
        messages: ChatMessage[],
        emitStep: (step: AgentStep) => void,
        mode: AgentMode,
        options?: AgentRunnerOptions,
        tokenAccumulator?: TokenUsage,
        onFileWrite?: (filePath: string, prevContent: string | null) => void,
        runMetrics?: AgentRunMetrics
    ): Promise<string> {
        const runRecord = await this.activeRunRecordPromise!;
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

        const agentToolContext: import('./types').AgentToolContext = {
            runnerOptions: options,
            agentRunner: this,
            tokenAccumulator: tokenAccumulator,
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
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
                return s + estimateTokenCount(contentToString(m.content));
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
        const performanceConfig = vs.workspace.getConfiguration('cwtools.ai.performance');
        const legacyFullToolset = performanceConfig.get<boolean>('legacyFullToolset') === true;
        let availableTools = filterToolDefinitionsForMode(TOOL_DEFINITIONS, mode, {
            useSlimPrompt: options?.useSlimPrompt,
            excludeTools: options?.excludeTools,
            legacyFullToolset,
        });

        // 🌟 核心优化：若开启了扁平化并且工具注册了展平 schema，则展现给模型的 availableTools 使用扁平化版本
        availableTools = availableTools.map(t => {
            const entry = TOOL_REGISTRY.get(t.function.name as any);
            return (entry && entry.flatSchema) ? entry.flatSchema : t;
        });

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

        // M3 Fix: remove per-call dynamic import — getProvider is already statically
        // imported at the top of this file; dynamic import added latency for nothing.
        const _config0 = this.aiService.getConfig();
        const _providerId0 = options?.providerId ?? _config0.provider;
        const _provider0 = getProvider(_providerId0);
        const useDsmlToolRole0 = _provider0.toolCallStyle === 'dsml';

        // Compute context limit and tool result budget once for the entire loop
        const bypassSandbox = vs.workspace.getConfiguration('cwtools.ai.developer').get<boolean>('disableSecuritySandbox') === true;
        
        const baseContextLimit = _config0.maxContextTokens > 0
            ? _config0.maxContextTokens
            : (_provider0.maxContextTokens || DEFAULT_CONTEXT_LIMIT);
            
        const contextLimit = bypassSandbox ? Number.MAX_SAFE_INTEGER : baseContextLimit;
        
        const midLoopThreshold = Math.floor(contextLimit * MID_LOOP_COMPACTION_RATIO);
        const toolResultBudget = getToolResultBudget(baseContextLimit);

        const maxToolIterations = resolveMaxToolIterations({
            mode,
            baseContextLimit,
            bypassSandbox,
            override: options?.maxIterations,
            isSubAgent: options?.useSlimPrompt === true,
        });
        if (runMetrics) runMetrics.maxIterations = maxToolIterations;

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
            iteration++;
            if (runMetrics) runMetrics.iterations = iteration;
            if (options?.topicId) {
                await this.saveResumeState(options.topicId, messages, mode, runRecord.runId);
            }

            let toolCalls: any[] | undefined = undefined;
            let needsHashValidation = false;
            let softLoopGuidancePending = false;

            const initialPending = (this as any).initialPendingToolCalls;
            if (iteration === 1 && initialPending && initialPending.length > 0) {
                (this as any).initialPendingToolCalls = undefined;
                toolCalls = initialPending;
                emitStep({
                    type: 'thinking',
                    content: '正在恢复并重新审批上一次会话遗留的敏感交互操作...',
                    timestamp: Date.now(),
                });
            } else {

            // Batch 2.3: Periodic checkpoint save for crash recovery
            if (iteration > 1 && iteration % CHECKPOINT_INTERVAL === 0) {
                void this.saveCheckpoint(
                    iteration,
                    messages,
                    Array.from(confirmedWrittenFiles),
                    options?.topicId
                );
            }

            // ── Mid-loop compaction: prevent uncontrolled context growth ──────
            // Every MID_LOOP_COMPACTION_INTERVAL iterations, estimate message size
            // and compact if approaching the context window limit.
            if (iteration > 1 && (iteration - 1) % MID_LOOP_COMPACTION_INTERVAL === 0) {
                const loopTokens = messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);
                if (loopTokens > midLoopThreshold) {
                    emitStep({
                        type: 'compaction',
                        content: AGENT.COMPACTION_MID_LOOP(loopTokens, midLoopThreshold),
                        timestamp: Date.now(),
                    });
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'compaction_start',
                        { kind: 'mid_loop', beforeTokens: loopTokens, threshold: midLoopThreshold },
                        { status: 'running' }
                    );
                    this.compactMessagesInPlace(messages, toolResultBudget, compactionOptions);
                    const afterTokens = messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'compaction_end',
                        { kind: 'mid_loop', success: true, beforeTokens: loopTokens, afterTokens },
                        { status: 'done' }
                    );
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
                        content: `正在等待模型返回 (${elapsedSec}s)...`,
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
            const parentAbortSignal = options?.abortSignal;
            const abortModelFromParent = () => modelAbortController.abort(parentAbortSignal?.reason);
            if (parentAbortSignal?.aborted) {
                abortModelFromParent();
            } else {
                parentAbortSignal?.addEventListener('abort', abortModelFromParent, { once: true });
            }
            const activeProviderConfig = this.aiService.getConfig();
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
            await runLedger.appendEvent(
                runRecord.runId,
                'model_call_start',
                {
                    iteration,
                    providerId: options?.providerId ?? activeProviderConfig.provider,
                    model: options?.model ?? activeProviderConfig.model,
                    messageCount: messages.length,
                    toolCount: availableTools.length
                },
                { invocationId: modelCallId, status: 'running' }
            );
            let fallbackFromError: string | undefined;
            try {
                response = await this.aiService.chatCompletion(messages, {
                    tools: availableTools,
                    providerId: options?.providerId,
                    model: options?.model,
                    maxTokens: resolveRunMaxOutputTokens({ useSlimPrompt: options?.useSlimPrompt }),
                    disableThinking: options?.useSlimPrompt === true && (mode === 'loc_writer' || mode === 'loc_translator'),
                    // 🔴 Key fix: propagate abort signal to HTTP request layer
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
            } catch (err: any) {
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
                if (err && err.message && (err.message.includes('terminated') || err.message.includes('socket hang up') || err.message.includes('ECONNRESET'))) {
                    await runLedger.appendEvent(
                        runRecord.runId,
                        'model_call_end',
                        { iteration, success: false, error: err.message },
                        { invocationId: modelCallId, status: 'failed' }
                    );
                    emitStep({
                        type: 'error',
                        content: `服务端异常断开 (${err.message}). 这通常是因为输出超出物理上限。自动触发切片恢复...`,
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
                        { tools: availableTools },
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
                    promptTokens = promptTokens ?? messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);
                    const assistantContentStr = response.choices[0]?.message ? contentToString(response.choices[0].message.content) : '';
                    completionTokens = completionTokens ?? estimateTokenCount(assistantContentStr);
                }
                const totalTokens = response.usage?.total_tokens ?? (promptTokens + completionTokens);

                const responseProviderId = (response as any).__providerId ?? options?.providerId ?? activeProviderConfig.provider;
                const pricing = getModelPricing(response.model ?? options?.model ?? '', responseProviderId);
                 // Cache-aware cost calculation: cached tokens billed at discounted rate
                const cachedTokens = response.usage?.cached_tokens ?? 
                                     (response.usage as any)?.prompt_tokens_details?.cached_tokens ?? 
                                     (response.usage as any)?.prompt_cache_hit_tokens ??
                                     (response.usage as any)?.cached_content_token_count ?? 0;
                const uncachedInputTokens = Math.max(0, promptTokens - cachedTokens);
                const cacheDiscount = getCacheDiscountFactor(response.model ?? options?.model ?? '');
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

            // ── M3: Length Truncation Fallback ──
            if (choice.finish_reason === 'length') {
                emitStep({
                    type: 'error',
                    content: '模型输出因长度限制(max_tokens)被截断。不抛出致命解析错误，自动触发切片引导...',
                    timestamp: Date.now(),
                });
                if (recoverSlimOutputBudget('length')) {
                    continue;
                }
                if (options?.useSlimPrompt === true) {
                    return stopForSlimOutputBudget();
                }
                messages.push({
                    role: 'user',
                    content: `[SYSTEM] Your previous response was truncated by the API max_tokens length limit. Please DO NOT output massive blocks of text. Break down your modifications into smaller steps. Use todo_write to plan them, and execute a single edit_file/replace_lines per response.`
                });
                continue;
            }

            // If no tool calls (either format), we're done — the final answer is no emit thinking block
            if (!toolCalls || toolCalls.length === 0) {
                return this.cleanFinalContent(contentToString(assistantMessage.content));
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
                    content: '检测到问题卡片 — 等待用户回答后再继续',
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
                            content: `修复工具名: ${toolName} → ${matched}`,
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

                emitStep({ type: 'tool_call', content: `调用工具: ${toolName}`, toolName, toolArgs, timestamp: Date.now(), stepIndex: ++globalToolCallIndex, iterationInfo: `Iteration ${iteration}/${maxToolIterations}`, invocationId });
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
                        content: `修复工具名: ${raw} → ${matched}`,
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
                            content: `🔴 [子 Agent 沙盒物理强拦截] ${safetyCheck.reason}`,
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
                    } else if (toolName === 'multi_replace_file_content') {
                        errMsg += '\n\n⚠️ Your ReplacementChunks array was truncated. Split into SMALLER batches: call multi_replace_file_content with fewer chunks.';
                    } else if (toolName === 'dispatch_agents') {
                        errMsg += '\n\n⚠️ Your tasks array was truncated or malformed because the prompt strings were too long. KEEP PROMPTS CONCISE. Do NOT embed massive file contents or long paths directly in the prompt. If you need to pass large data, use `set_memory` first and pass the memory key. Also, try dispatching fewer tasks at once.';
                    }
                    toolResults[i] = { ok: false, error: errMsg };
                    continue;
                }

                if (mode === 'plan') {
                    const guard = validatePlanModeToolUse(toolName, toolArgs, this.toolExecutor.workspaceRoot, options?.topicId, ci.targetPaths);
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
                    const guard = validateGitOpsForMode(mode, toolArgs);
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
                        const runReadTool = async () => {
                            const releaseLock = await toolScheduler.acquireLock(callInfo.concurrencyClass);
                            try {
                                options?.abortSignal?.throwIfAborted();
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_start', { toolName: callInfo.toolName }, { invocationId: callInfo.invocationId });
                                const rawRes = await this.toolExecutor.execute(callInfo.toolName, callInfo.toolArgs, agentToolContext);
                                toolResults[idx] = await this.processToolResult(
                                    callInfo.toolName,
                                    callInfo.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes
                                );
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_end', this.summarizeToolResultForLedger(callInfo.toolName, toolResults[idx]), { invocationId: callInfo.invocationId });
                            } catch (e: any) {
                                if (e?.name === 'AbortError') throw e;
                                toolResults[idx] = { error: e instanceof Error ? e.message : String(e) };
                                await runLedger.appendEvent(runRecord.runId, 'tool_call_end', this.summarizeToolResultForLedger(callInfo.toolName, toolResults[idx]), { invocationId: callInfo.invocationId });
                            } finally {
                                releaseLock();
                            }
                        };
                        const readPaths = callInfo.targetPaths.length > 0 ? callInfo.targetPaths : [];
                        if (readPaths.length > 0) {
                            await this.writeQueue.afterCurrentWrites(readPaths, runReadTool);
                        } else {
                            await runReadTool();
                        }
                    }));
                } else {
                    if (!WRITE_TOOLS.has(toolName)) {
                        const releaseLock = await toolScheduler.acquireLock(ci.concurrencyClass);
                        try {
                            options?.abortSignal?.throwIfAborted();
                            await runLedger.appendEvent(runRecord.runId, 'tool_call_start', { toolName: ci.toolName }, { invocationId: ci.invocationId });
                            const rawRes = await this.toolExecutor.execute(toolName, toolArgs, agentToolContext);
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

                    // Collect all file paths that this tool touches for partitioned locking
                    const lockPaths = filePaths.length > 0 ? filePaths : ['__global__'];
                    const waitTimeoutMs = options?.writeQueueWaitTimeoutMs ?? (options?.useSlimPrompt ? 60_000 : 90_000);

                    try {
                        await this.writeQueue.enqueue(lockPaths, async () => {
                            const releaseLock = await toolScheduler.acquireLock(ci.concurrencyClass);
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
                                toolResults[i] = { skipped: true, message: `已被后续对 ${primaryFilePath} 的写入操作覆盖，跳过本次写入` };
                            } else if (toolName === 'write_file') {
                                // Brace validation is handled inside FileToolHandler via the
                                // tokenizer-based rejectUnsafePdxStructureWrite guard, which
                                // ignores braces in strings/comments and only applies to PDX
                                // extensions. The old naive character count here spuriously
                                // rejected valid PDX files (commented/quoted braces) and
                                // non-PDX content (markdown/json), telling the model to switch
                                // tools for no reason.
                                const args = (confirmedWrittenFiles.has(primaryFilePath) || shouldAutoApplyWrite) ? { ...toolArgs, _autoApply: true } : toolArgs;
                                const rawRes = await this.toolExecutor.execute(toolName, args, agentToolContext);
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
                                const rawRes = await this.toolExecutor.execute(toolName, { ...toolArgs, _autoApply: true }, agentToolContext);
                                toolResults[i] = await this.processToolResult(
                                    toolName,
                                    ci.invocationId,
                                    runRecord.runId,
                                    options?.topicId || 'default',
                                    rawRes
                                );
                            } else {
                                const rawRes = await this.toolExecutor.execute(toolName, toolArgs, agentToolContext);
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
                if (!toolResults[j] || (toolResults[j] as any).success === false) continue;
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

            // Emergency compaction: if a single batch of tool results pushed the
            // conversation past 98% of context limit, force-compact immediately
            // rather than waiting for the next MID_LOOP_COMPACTION_INTERVAL check.
            const emergencyTokens = messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);
            if (emergencyTokens > contextLimit * 0.98) {
                emitStep({
                    type: 'compaction',
                    content: AGENT.COMPACTION_EMERGENCY(emergencyTokens, contextLimit),
                    timestamp: Date.now(),
                });
                await runLedger.appendEvent(
                    runRecord.runId,
                    'compaction_start',
                    { kind: 'emergency', beforeTokens: emergencyTokens, contextLimit },
                    { status: 'running' }
                );
                this.compactMessagesInPlace(messages, toolResultBudget, compactionOptions);
                const afterEmergencyTokens = messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);
                await runLedger.appendEvent(
                    runRecord.runId,
                    'compaction_end',
                    { kind: 'emergency', success: true, beforeTokens: emergencyTokens, afterTokens: afterEmergencyTokens },
                    { status: 'done' }
                );
            }

            // If forceStop was set in the inner loop, exit the outer while now
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

            if (softLoopGuidancePending && !forceStop) {
                messages.push({
                    role: 'user',
                    content: '[SYSTEM] Repeated tool-call pattern detected. Change strategy, avoid identical arguments, narrow the next action, or answer if enough information is available.',
                });
            }

            if (options?.topicId && !forceStop) {
                await this.saveResumeState(options.topicId, messages, mode, runRecord.runId);
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
        await runLedger.appendEvent(
            runRecord.runId,
            'model_call_start',
            {
                iteration,
                purpose: 'max_iteration_summary',
                providerId: options?.providerId ?? this.aiService.getConfig().provider,
                model: options?.model ?? this.aiService.getConfig().model,
                messageCount: messages.length,
                toolCount: 0
            },
            { invocationId: finalModelCallId, status: 'running' }
        );
        const finalResponse = await this.aiService.chatCompletion(messages, {
            providerId: options?.providerId,
            model: options?.model,
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

    private compactMessagesInPlace(messages: ChatMessage[], toolResultBudget: number, options?: CompactMessagesOptions): void {
        _compactMessagesInPlace(messages, toolResultBudget, options);
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
        options?: AgentRunnerOptions
    ): Promise<Omit<GenerationResult, 'explanation' | 'steps'>> {
        let currentCode = initialCode;
        let retryCount = 0;
        let lastErrors: ValidationError[] = [];
        const validationRunRecord = await this.activeRunRecordPromise?.catch(() => undefined);
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
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
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
            const rawResult = await this.toolExecutor.execute('get_diagnostics', {
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
                        emitStep({
                            type: 'validation',
                            content: `CWTools LSP diagnostics are still ${freshness}; local syntax fallback passed.`,
                            timestamp: Date.now(),
                        });
                        await appendValidationEnd({
                            isValid: true,
                            errorCount: 0,
                            warningCount: fallbackErrors.length,
                            validationMode: 'local-syntax-fallback',
                            diagnosticFreshness: freshness,
                            pendingGlobalKinds,
                            diagnosticService: diagnosticRead.diagnosticService?.status,
                            diagnosticEpochProgress: sawDiagnosticEpochProgress,
                            validationRuntime: this.compactValidationStatus(diagnosticRead.validationStatus),
                        });
                        return {
                            code: currentCode,
                            validationErrors: fallbackErrors,
                            isValid: true,
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
                const rawAnalysis = await this.toolExecutor.execute('analyze_diagnostic_error', {
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
                const retryResponse = await this.aiService.chatCompletion(retryMessages, {
                    providerId: options?.providerId,
                    model: options?.model,
                });

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
        options?: Pick<AgentRunnerOptions, 'providerId' | 'model'>
    ): Promise<string | null> {
        try {
            const context = [userMessage, assistantReply]
                .map(s => s.substring(0, 400))
                .join('\n\n---\n\n');

            const response = await this.aiService.chatCompletion([
                {
                    role: 'system',
                    content: 'You are a conversation title generator. Generate a concise title (max 50 characters) in the same language as the user message. Output ONLY the title text, no quotes, no punctuation at the end, no preamble.',
                },
                {
                    role: 'user',
                    content: `Generate a short title for this conversation:\n\n${context}`,
                },
            ], {
                maxTokens: 60,
                temperature: 0.3,
                providerId: options?.providerId,
                model: options?.model,
            });

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
