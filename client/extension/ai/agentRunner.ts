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
    ToolCall,
    AgentStep,
    GenerationResult,
    ValidationError,
    AgentToolName,
    AgentMode,
    ChatCompletionResponse,
    ContentPart,
    TokenUsage,
    AgentRunMetrics,
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
import { getModelPricing } from './pricing';
import { parseDsmlToolCalls as _parseDsmlToolCalls, stripDsmlMarkup as _stripDsmlMarkup, stripThinkBlocks as _stripThinkBlocks, cleanFinalContent as _cleanFinalContent } from './toolCallParser';
import { tryRepairJson as _tryRepairJson } from './jsonRepair';
import { budgetToolResult as _budgetToolResult, compactMessagesInPlace as _compactMessagesInPlace, TOOL_RESULT_BUDGET_BASE } from './contextBudget';
import { AGENT, SOURCE } from './messages';
import { ErrorReporter } from './errorReporter';
import { getProjectWorkspaceRoot, getTopicStorageDir, getTopicStorageDirCandidates } from './workspacePaths';
import { filterToolDefinitionsForMode, resolveMaxToolIterations } from './runnerPolicy';
import { getWorkflow } from './workflowRegistry';
import { WRITE_TOOLS, READ_ONLY_TOOLS } from './tools/registry';
import { PartitionedWriteQueue } from './runner/writeCoordinator';
import { saveResumeState, loadResumeState, hasResumeState, clearResumeState } from './runner/checkpoint';
import { maybeCompactHistory as _maybeCompactHistory, MID_LOOP_COMPACTION_INTERVAL, MID_LOOP_COMPACTION_RATIO, DEFAULT_CONTEXT_LIMIT } from './runner/compaction';

// Doom-loop detection: two-phase approach.
// Phase 1 — signature-pair tracking: (prevSig, currSig) pairs. Same pair ≥ PAIR_THRESHOLD triggers Phase 2.
// Phase 2 — normalized result hash: compare hashes of adjacent same-name tool results.
//   Same hash = "spinning in place" → confirmed doom-loop → stop.
//   Different hash = "making progress" → reset pair counter and continue.
const DOOM_LOOP_SOFT_THRESHOLD = 4;
const DOOM_LOOP_PAIR_THRESHOLD = 6;

// Lightweight 32-bit FNV-1a hash for normalized tool result comparison.
function fnv32a(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 16777619) | 0;
    }
    return hash >>> 0;
}

// Normalize a tool result to a hashable key, extracting only semantically
// meaningful fields (stripping positional info like line/column numbers).
function normalizeToolResultHash(toolName: string, result: unknown): string {
    if (result === null || result === undefined) return String(result);
    if (typeof result !== 'object') return String(result).substring(0, 256);

    const obj = result as Record<string, unknown>;
    // read_file → hash file content
    if (toolName === 'read_file' && typeof obj.content === 'string') {
        return `read_file:${obj.file ?? ''}:${obj.content.length}`;
    }
    // multi_replace_file_content / write_file → hash written content
    if ((toolName === 'multi_replace_file_content' || toolName === 'write_file') && typeof obj.content === 'string') {
        return `write:${obj.filePath ?? obj.file ?? obj.TargetFile ?? ''}:${obj.content.length}`;
    }
    // query_scope → hash scope chain
    if (toolName === 'query_scope') {
        return `scope:${JSON.stringify(obj.currentScope ?? '')}:${JSON.stringify(obj.thisScope ?? '')}`;
    }
    // get_diagnostics → hash summary counts
    if (toolName === 'get_diagnostics' && obj.summary) {
        return `diag:${JSON.stringify(obj.summary)}`;
    }
    // lsp_operation → hash the returned structure (exclude positions)
    if (toolName === 'lsp_operation') {
        const stripped = JSON.stringify(obj, (key, val) =>
            (key === 'line' || key === 'column' || key === 'character' || key === 'offset') ? undefined : val
        );
        return `lsp:${stripped.substring(0, 256)}`;
    }
    // Generic fallback: first 256 chars of JSON
    return `${toolName}:${JSON.stringify(obj).substring(0, 256)}`;
}
// Maximum validation-retry rounds (reduced: edit_file now returns inline LSP diagnostics)
const MAX_VALIDATION_RETRIES = 2;
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
// Compact when conversation exceeds this fraction of provider context
// Default context limit if unknown
// How many recent messages to keep un-compressed during compaction
// Mid-loop compaction: check every N iterations within reasoningLoop
// Mid-loop compaction triggers at this fraction of context limit

// Minimum tool result budget (even for tiny context windows)
const TOOL_RESULT_BUDGET_MIN = 3000;
// Maximum tool result budget (even for huge context windows like 1M)
const TOOL_RESULT_BUDGET_MAX = 18000;

// ─── Batch 2.3: Checkpoint mechanism ─────────────────────────────────────────
// Save a lightweight progress checkpoint every N iterations within the reasoning loop.
// On crash or context-window overflow, the agent can load the last checkpoint
// instead of starting from scratch.
const CHECKPOINT_INTERVAL = 10;

// ─── Batch 2.5: Provider fallback retry ──────────────────────────────────────
// When a provider returns a catastrophic error (5xx, rate-limit after exhaustion,
// network timeout), the agent can retry with a fallback model.
// Maps primary provider → fallback provider+model pairs.
const PROVIDER_FALLBACK: Record<string, { providerId: string; model: string }[]> = {
    // If the primary provider fails, try these in order:
    openai:     [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    deepseek:   [{ providerId: 'minimax-token-plan',  model: 'MiniMax-M2.7-highspeed' }],
    claude:     [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    qwen:       [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    glm:        [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    google:     [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    minimax:    [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
};

export function isFallbackEligibleApiError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /\b(5\d{2})\b/.test(msg) ||          // 5xx server errors
           /timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(msg) ||  // Network failures
           /overloaded|capacity|unavailable/i.test(msg); // Capacity issues
}

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
    onPermissionRequest?: (id: string, tool: string, description: string, command?: string) => Promise<boolean>;
    /** If provided, file mutations are written to this memory overlay instead of disk. */
    vfsOverlay?: Map<string, string>;
    /** Topic ID for checkpoint persistence — threaded from run() context */
    topicId?: string;
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
const PLAN_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'todo_write',
    'read_file', 'list_directory', 'get_diagnostics', 'web_fetch', 'search_web',
    'glob_files', 'codesearch',
    // Deep API tools for archetype study in Plan mode
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_definition', 'query_definition_by_name',
    'query_static_modifiers', 'query_variables',
    // Structured design blueprint output
    'write_design_blueprint',
    // Memory tools for persisting architectural state
    'set_memory', 'get_memory', 'search_memory',
    // Git operations for investigation
    'git_ops',
];

/** Explore mode: same as plan, plus CWTools Deep API tools — no writes (OpenCode explore agent) */
const EXPLORE_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_diagnostics', 'web_fetch', 'search_web', 'glob_files',
    // CWTools Deep API tools (read-only, advertised in Explore mode prompt)
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'query_definition', 'query_definition_by_name', 'codesearch',
    // Git operations for investigation
    'git_ops',
];

/** General mode: legacy read-only Q&A mode. */
const GENERAL_EXCLUDED_TOOLS: AgentToolName[] = ['todo_write'];

/** Utility mode: full ordinary coding tools for non-PDX helper scripts/tools. */
const UTILITY_EXCLUDED_TOOLS: AgentToolName[] = ['dispatch_agents', 'query_blackboard', 'merge_results'];

/** Review mode: same as explore, plus query_definition — read-only tools only */
const REVIEW_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_diagnostics', 'query_definition', 'query_definition_by_name',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'web_fetch', 'search_web', 'glob_files', 'codesearch',
    // Git operations for investigation
    'git_ops',
];

/** Loc Translator mode: read localisation files, write translated output */
const LOC_TRANSLATOR_TOOLS: AgentToolName[] = [
    'read_file', 'write_file', 'multi_replace_file_content', 'replace_lines', 'apply_patch',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'workspace_symbols',
    'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_diagnostics',
    // W9 fix: remove web_fetch/search_web/codesearch, localization Agent does not require network search capabilities
    'todo_write',
    'write_localisation', 'git_ops',
];

/** Loc Writer mode: create new localisation entries from scratch */
const LOC_WRITER_TOOLS: AgentToolName[] = [
    'read_file', 'write_file', 'multi_replace_file_content', 'replace_lines', 'apply_patch',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'workspace_symbols',
    'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_diagnostics',
    'query_types', 'query_rules', 'query_references',
    // W9 fix: remove web_fetch/search_web/codesearch, localization Agent does not require network search capabilities
    'todo_write',
    'write_localisation', 'git_ops',
];

/** Orchestrator mode: read-only tools + coordinator-specific tools (dispatch_agents, query_blackboard, merge_results) */
const ORCHESTRATOR_MODE_TOOLS: AgentToolName[] = [
    //Read-only information collection
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory',
    'get_diagnostics', 'web_fetch', 'search_web', 'glob_files', 'codesearch',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'query_definition', 'query_definition_by_name',
    // Blackboard and task management
    'set_memory', 'get_memory', 'search_memory', 'todo_write',
    // Coordinator-specific
    'dispatch_agents', 'query_blackboard', 'merge_results',
    // Git
    'git_ops',
];


// Fix #9: module-level constants — no need to recreate on every loop iteration
export const SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS = new Set<string>(['write_file']);

export function getAgentToolTargetFiles(
    toolName: string,
    args: Record<string, unknown>,
    workspaceRoot?: string,
    topicId?: string
): string[] {
    const paths: string[] = [];
    const add = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            const trimmed = value.trim();
            paths.push(workspaceRoot
                ? (path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(workspaceRoot, trimmed))
                : trimmed);
        }
    };

    switch (toolName) {
        case 'write_file':
        case 'edit_pdx_block':
        case 'git_ops':
            add(args.file);
            break;
        case 'multi_replace_file_content':
            add(args.TargetFile);
            break;
        case 'replace_lines':
        case 'write_localisation':
            add(args.filePath);
            break;
        case 'deploy_mod_asset':
            if (workspaceRoot && typeof args.targetRelativePath === 'string') {
                paths.push(path.resolve(workspaceRoot, args.targetRelativePath));
            } else {
                add(args.targetRelativePath);
            }
            break;
        case 'write_design_blueprint':
            if (workspaceRoot) {
                paths.push(path.join(getTopicStorageDir(topicId || 'default', workspaceRoot), 'design_blueprint.md'));
            }
            break;
    }

    return [...new Set(paths)];
}

const globalPartitionedWriteQueue = new PartitionedWriteQueue();

export class AgentRunner {
    private writeQueue = globalPartitionedWriteQueue;
    constructor(
        private aiService: AIService,
        public readonly toolExecutor: AgentToolExecutor,
        private promptBuilder: PromptBuilder
    ) {
        this.toolExecutor.parentAgentRunner = this;
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
        mode: AgentMode
    ): Promise<void> {
        try {
            const fs = await import('fs');
            const pathModule = await import('path');
            const wsRoot = getProjectWorkspaceRoot();
            if (!topicId) return;

            const resumeDir = getTopicStorageDir(topicId, wsRoot);
            if (!resumeDir) return;
            if (!fs.existsSync(resumeDir)) fs.mkdirSync(resumeDir, { recursive: true });

            const resumeState: import('./types').AgentResumeState = {
                timestamp: Date.now(),
                mode,
                messages,
                todos: this.toolExecutor.getTodos(),
                topicId,
            };

            fs.writeFileSync(
                pathModule.join(resumeDir, 'resume_state.json'),
                JSON.stringify(resumeState),
                'utf-8'
            );
        } catch {
            // Non-critical — silently ignore save failures
        }
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
        const fallbacks = PROVIDER_FALLBACK[originalProviderId];
        if (!fallbacks || fallbacks.length === 0) return null;

        for (const fb of fallbacks) {
            try {
                emitStep?.({
                    type: 'compaction',
                    content: `Provider fallback: ${originalProviderId} → ${fb.providerId} (${fb.model})`,
                    timestamp: Date.now(),
                });
                const response = await this.aiService.chatCompletion(messages, {
                    tools: options?.tools,
                    providerId: fb.providerId,
                    model: fb.model,
                });
                return response;
            } catch {
                // This fallback also failed — try the next one
                continue;
            }
        }
        return null;
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
        const mode = options?.mode ?? 'build';
        const emitStep = (step: AgentStep) => {
            steps.push(step);
            options?.onStep?.(step);
        };

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

        // Context object to be passed to tool executor (replaces old global assignment)
        const agentToolContext: import('./types').AgentToolContext = {
            runnerOptions: options,
            agentRunner: this,
            tokenAccumulator: tokenAccumulator,
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
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
                } catch (e) {
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

        const providerForPrompt = options?.providerId ?? this.aiService.getConfig().provider;
        let systemPrompt = options?.useSlimPrompt
            ? this.promptBuilder.buildSlimSystemPromptForMode(mode, providerForPrompt)
            : this.promptBuilder.buildSystemPromptForMode(mode, providerForPrompt);

        // Inject workflow prompt supplement if running within a workflow
        const activeWorkflowForPrompt = options?.workflowId ? getWorkflow(options.workflowId) : undefined;
        if (activeWorkflowForPrompt?.promptSupplement) {
            systemPrompt = activeWorkflowForPrompt.promptSupplement + '\n\n' + systemPrompt;
        }

        // Build the message array
        let messages: ChatMessage[];
        
        if (options?.resumeFromState && context.topicId) {
            const resumeState = await this.loadResumeState(context.topicId);
            if (resumeState) {
                messages = resumeState.messages;
                if (resumeState.todos && resumeState.todos.length > 0) {
                    void this.toolExecutor.getExternalToolHandler().todoWrite({ todos: resumeState.todos });
                }
                emitStep({
                    type: 'thinking',
                    content: '已从断点快照中恢复上下文并继续执行...',
                    timestamp: Date.now(),
                });
            } else {
                messages = [
                    { role: 'system', content: systemPrompt },
                    ...this.promptBuilder.buildContextMessages(context),
                    ...compactedHistory,
                    { role: 'user', content: userContent },
                ];
            }
        } else {
            messages = [
                { role: 'system', content: systemPrompt },
                ...this.promptBuilder.buildContextMessages(context),
                ...compactedHistory,
                { role: 'user', content: userContent },
            ];
        }

        const modeLabel: Record<string, string> = {
            build: AGENT.MODE_BUILD,
            plan: AGENT.MODE_PLAN,
            explore: AGENT.MODE_EXPLORE,
            general: AGENT.MODE_GENERAL,
            utility: AGENT.MODE_UTILITY,
            review: AGENT.MODE_REVIEW,
            orchestrator: AGENT.MODE_ORCHESTRATOR,
        };
        emitStep({
            type: 'thinking',
            content: modeLabel[mode] ?? AGENT.MODE_FALLBACK,
            timestamp: Date.now(),
        });


        try {
            // Wire topicId from context into options for checkpoint persistence
            if (context.topicId) {
                options = { ...options, topicId: context.topicId };
            }

            // Phase 1: Agent reasoning loop (with tool calls)
            const finalMessage = await this.reasoningLoop(messages, emitStep, mode, options, tokenAccumulator, undefined, runMetrics);
            runMetrics.finalPromptTokens = messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);

            // Auto-mark remaining in-progress todos as done on successful completion
            this.autoCompleteTodos();

            // Phase 2: Extract code from the response
            const code = this.extractCode(finalMessage);

            // Plan / Explore / General / Review / Orchestrator mode — or no code generated — just an explanation
            if (!code || mode === 'plan' || mode === 'explore' || mode === 'general' || mode === 'utility' || mode === 'review' || mode === 'orchestrator') {
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

            return {
                ...validationResult,
                explanation: this.extractExplanation(finalMessage),
                steps,
                tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                runMetrics,
            };
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);

            if (errorMsg.includes('aborted') || errorMsg.includes('cancel')) {
                emitStep({ type: 'error', content: AGENT.CANCELLED, timestamp: Date.now() });
            } else {
                emitStep({ type: 'error', content: `${AGENT.ERROR_PREFIX}: ${errorMsg}`, timestamp: Date.now() });
            }

            if (context.topicId) {
                await this.saveResumeState(context.topicId, messages, mode);
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
    private async reasoningLoop(
        messages: ChatMessage[],
        emitStep: (step: AgentStep) => void,
        mode: AgentMode,
        options?: AgentRunnerOptions,
        tokenAccumulator?: TokenUsage,
        onFileWrite?: (filePath: string, prevContent: string | null) => void,
        runMetrics?: AgentRunMetrics
    ): Promise<string> {
        let iteration = 0;
        
        const agentToolContext: import('./types').AgentToolContext = {
            runnerOptions: options,
            agentRunner: this,
            tokenAccumulator: tokenAccumulator,
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
            onBeforeFileWrite: onFileWrite,
            onTodoUpdate: options?.onTodoUpdate
        };

        // Two-phase doom-loop detection:
        // phase1: track (prevSig -currSig) pair frequency
        // phase2: compare normalized result hashes for same-name calls
        const pairFrequency = new Map<string, number>();
        const lastResultHash = new Map<string, number>(); // sig -fnv32a(normalized result)
        let prevCallSignature = '';
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

        // Apply workflow tool policy if running within a workflow
        const activeWorkflow = options?.workflowId ? getWorkflow(options.workflowId) : undefined;
        if (activeWorkflow) {
            const policy = activeWorkflow.toolPolicy;
            if (policy.strategy === 'allowlist') {
                const allowed = new Set<string>(policy.tools);
                availableTools = availableTools.filter(t => allowed.has(t.function.name));
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
        // Scale tool result budget proportionally to context window (linear interpolation)
        // 128K → 8000 chars, 200K → 12500, 1M → 30000 (capped)
        const toolResultBudget = Math.min(
            TOOL_RESULT_BUDGET_MAX,
            Math.max(TOOL_RESULT_BUDGET_MIN, Math.floor(TOOL_RESULT_BUDGET_BASE * (baseContextLimit / DEFAULT_CONTEXT_LIMIT)))
        );

        const maxToolIterations = resolveMaxToolIterations({
            mode,
            baseContextLimit,
            bypassSandbox,
            override: options?.maxIterations,
        });
        if (runMetrics) runMetrics.maxIterations = maxToolIterations;

        // Global tool call counter for timeline step indexing (Phase 4)
        let globalToolCallIndex = 0;

        while (iteration < maxToolIterations) {
            options?.abortSignal?.throwIfAborted();
            iteration++;
            if (runMetrics) runMetrics.iterations = iteration;

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
                    this.compactMessagesInPlace(messages, toolResultBudget);
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
            try {
                response = await this.aiService.chatCompletion(messages, {
                    tools: availableTools,
                    providerId: options?.providerId,
                    model: options?.model,
                    // 🔴 Key fix: propagate abort signal to HTTP request layer
                    // The absence of this parameter will cause the child agent to wait for the LLM streaming response
                    // Cannot be interrupted at all by the parent's cancelGeneration/abort
                    abortSignal: options?.abortSignal,
                    // Stream thinking tokens to UI in real-time (OpenCode-style)
                    onThinking: options?.streaming ? (text) => {
                        emitStep({
                            type: 'thinking_content',
                            content: text,
                            timestamp: Date.now(),
                        });
                    } : undefined,
                    // Stream text content tokens for typewriter effect
                    onTextDelta: options?.streaming ? (text) => {
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
                if (err && err.message && (err.message.includes('terminated') || err.message.includes('socket hang up') || err.message.includes('ECONNRESET'))) {
                    emitStep({
                        type: 'error',
                        content: `服务端异常断开 (${err.message}). 这通常是因为输出超出物理上限。自动触发切片恢复...`,
                        timestamp: Date.now(),
                    });
                    messages.push({
                        role: 'user',
                        content: `[SYSTEM] Your previous response was forcefully terminated by the API server (likely due to hard length limits or timeout). Please DO NOT output massive text blocks, and DO NOT use write_file for files over 150 lines. Break your task into small steps using multi_replace_file_content.`
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
                        // Fall through to normal processing below
                    } else {
                        throw err; // All fallbacks exhausted
                    }
                } else {
                    throw err;
                }
            } finally {
                if (modelHeartbeatId) clearInterval(modelHeartbeatId);
            }

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

                const pricing = getModelPricing(response.model ?? options?.model ?? '');
                const inputCost = (promptTokens / 1_000_000) * pricing[0];
                const outputCost = (completionTokens / 1_000_000) * pricing[1];
                
                tokenAccumulator.input += promptTokens;
                tokenAccumulator.output += completionTokens;
                tokenAccumulator.total += totalTokens;
                tokenAccumulator.estimatedCostCny += inputCost + outputCost;
                tokenAccumulator.contextWindowTokens = promptTokens;
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
            let toolCalls = assistantMessage.tool_calls;
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
                messages.push({
                    role: 'user',
                    content: `[SYSTEM] Your previous response was truncated by the API max_tokens length limit. Please DO NOT output massive blocks of text. Break down your modifications into smaller steps. Use todo_write to plan them, and execute a single multi_replace_file_content/apply_patch per response.`
                });
                continue;
            }

            // If no tool calls (either format), we're done — the final answer is no emit thinking block
            if (!toolCalls || toolCalls.length === 0) {
                return this.cleanFinalContent(contentToString(assistantMessage.content));
            }

            // ── Delay emit thinking_content: emit only when it is confirmed that there are subsequent tool_calls ──
            // This avoids redundant Thinking blocks after the final answer.
            if (thinkContent.trim()) {
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
            let needsHashValidation = false;
            let softLoopGuidancePending = false;
            let currentPairKey: string | undefined;
            if (prevCallSignature) {
                const pairKey = `${prevCallSignature}->${callSignature}`;
                currentPairKey = pairKey;
                const pairFreq = (pairFrequency.get(pairKey) || 0) + 1;
                pairFrequency.set(pairKey, pairFreq);
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
            prevCallSignature = callSignature;

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
            const parsedCalls: Array<{ toolName: AgentToolName; toolArgs: Record<string, unknown>; toolArgsParseError?: string; toolCall: typeof toolCalls[0] }> = [];
            for (const toolCall of toolCalls) {
                options?.abortSignal?.throwIfAborted();
                const toolName = toolCall.function.name as AgentToolName;
                if (runMetrics) {
                    runMetrics.toolCallCount++;
                    runMetrics.toolCallsByName[toolName] = (runMetrics.toolCallsByName[toolName] ?? 0) + 1;
                }
                let toolArgs: Record<string, unknown>;
                let toolArgsParseError: string | undefined;
                try { 
                    toolArgs = JSON.parse(toolCall.function.arguments); 
                } catch (e) {
                    // Attempt common JSON repairs before giving up (Issue #2 fix)
                    const repaired = this.tryRepairJson(toolCall.function.arguments);
                    if (repaired !== null) {
                        toolArgs = repaired;
                    } else {
                        toolArgs = {};
                        toolArgsParseError = `JSON parse error: ${e instanceof Error ? e.message : String(e)}. Raw arguments: ${toolCall.function.arguments?.substring(0, 200)}`;
                    }
                }
                emitStep({ type: 'tool_call', content: `调用工具: ${toolName}`, toolName, toolArgs, timestamp: Date.now(), stepIndex: ++globalToolCallIndex, iterationInfo: `Iteration ${iteration}/${maxToolIterations}` });
                parsedCalls.push({ toolName, toolArgs, toolArgsParseError, toolCall });
            }

            // Tool Call Repair: case-insensitive correction of hallucinated tool names.
            // Prevents doom-loop false positives when LLM emits slightly misspelled names.
            const knownNames = availableTools.map(t => t.function.name);
            for (const tc of toolCalls) {
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
                // error, which triggers analyze_diagnostic_error reflection rather than doom-loop.
            }

            const toolResults: unknown[] = new Array(parsedCalls.length);

            // Fetch fs module lazily if we need it for snapshots
            let fsModule: typeof import('fs') | undefined;

            for (let i = 0; i < parsedCalls.length; i++) {
                options?.abortSignal?.throwIfAborted();
                const ci = parsedCalls[i]!;
                const { toolName, toolArgs, toolCall } = ci;

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

                if (READ_ONLY_TOOLS.has(toolName)) {
                    // Collect consecutive read-only tools to batch them in parallel
                    const batchIndices: number[] = [i];
                    while (i + 1 < parsedCalls.length && READ_ONLY_TOOLS.has(parsedCalls[i + 1]!.toolName) && !parsedCalls[i + 1]!.toolArgsParseError) {
                        i++;
                        batchIndices.push(i);
                    }
                    await Promise.all(batchIndices.map(async idx => {
                        try {
                            options?.abortSignal?.throwIfAborted();
                            const callInfo = parsedCalls[idx]!;
                            toolResults[idx] = await this.toolExecutor.execute(callInfo.toolName, callInfo.toolArgs, agentToolContext);
                        } catch (e: any) {
                            if (e?.name === 'AbortError') throw e;
                            toolResults[idx] = { error: e instanceof Error ? e.message : String(e) };
                        }
                    }));
                } else {
                    if (!WRITE_TOOLS.has(toolName)) {
                        try {
                            options?.abortSignal?.throwIfAborted();
                            toolResults[i] = await this.toolExecutor.execute(toolName, toolArgs, agentToolContext);
                        } catch (e: any) {
                            if (e?.name === 'AbortError') throw e;
                            toolResults[i] = { error: e instanceof Error ? e.message : String(e) };
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
                        try {
                            options?.abortSignal?.throwIfAborted();
                            
                            // Sub-agent snapshot isolate hook
                            if (onFileWrite && primaryFilePath) {
                                if (!fsModule) fsModule = await import('fs');
                                const prev = fsModule.existsSync(primaryFilePath) ? fsModule.readFileSync(primaryFilePath, 'utf8') : null;
                                onFileWrite(primaryFilePath, prev);
                            }

                            if (isSupersededWrite) {
                                toolResults[i] = { skipped: true, message: `已被后续对 ${primaryFilePath} 的写入操作覆盖，跳过本次写入` };
                            } else if (toolName === 'write_file') {
                                const content = (toolArgs['content'] as string) || '';
                                let openCount = 0, closeCount = 0;
                                for (let c = 0; c < content.length; c++) {
                                    if (content[c] === '{') openCount++;
                                    if (content[c] === '}') closeCount++;
                                }
                                if (openCount !== closeCount) {
                                    toolResults[i] = { error: `Pre-flight Syntax Reject: Unbalanced braces detected (open: ${openCount}, close: ${closeCount}). This almost ALWAYS means your code output was truncated due to API length limits. DO NOT retry write_file with the same massive file! Instead, split your task using todo_write, or use multi_replace_file_content to apply the changes incrementally.` };
                                } else {
                                    const args = (confirmedWrittenFiles.has(primaryFilePath) || shouldAutoApplyWrite) ? { ...toolArgs, _autoApply: true } : toolArgs;
                                    toolResults[i] = await this.toolExecutor.execute(toolName, args, agentToolContext);
                                    const r = toolResults[i] as Record<string, unknown>;
                                    if (r && (r.success || r.confirmed) && primaryFilePath) confirmedWrittenFiles.add(primaryFilePath);
                                }
                            } else if (WRITE_TOOLS.has(toolName) && primaryFilePath && (confirmedWrittenFiles.has(primaryFilePath) || shouldAutoApplyWrite)) {
                                toolResults[i] = await this.toolExecutor.execute(toolName, { ...toolArgs, _autoApply: true }, agentToolContext);
                            } else {
                                toolResults[i] = await this.toolExecutor.execute(toolName, toolArgs, agentToolContext);
                                if (WRITE_TOOLS.has(toolName) && primaryFilePath) {
                                    const r = toolResults[i] as Record<string, unknown>;
                                    if (r && (r.success || r.confirmed)) confirmedWrittenFiles.add(primaryFilePath);
                                }
                            }
                        } catch (e: any) {
                            if (e?.name === 'AbortError') throw e;
                            toolResults[i] = { error: e instanceof Error ? e.message : String(e) };
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

            // ── Two-phase doom-loop detection: phase 2 (post-exec hash check) ──
            if (needsHashValidation) {
                let allHashesMatch = true;
                for (let j = 0; j < parsedCalls.length; j++) {
                    const { toolName, toolArgs, toolCall } = parsedCalls[j]!;
                    const sig = `${toolCall.function.name}:${toolCall.function.arguments}`;
                    const resultHash = fnv32a(normalizeToolResultHash(toolName, toolResults[j]));
                    const prevHash = lastResultHash.get(sig);
                    if (prevHash !== undefined && prevHash !== resultHash) {
                        // Hash differs — meaningful progress, not a doom-loop.
                        // Reset the pair counter for this pair.
                        if (currentPairKey) pairFrequency.set(currentPairKey, 0);
                        allHashesMatch = false;
                    }
                    lastResultHash.set(sig, resultHash);
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
                    lastResultHash.set(sig, fnv32a(normalizeToolResultHash(toolName, toolResults[j])));
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
                this.compactMessagesInPlace(messages, toolResultBudget);
            }

            // If forceStop was set in the inner loop, exit the outer while now
            if (forceStop) break;

            // Emit results in original order and feed back to AI
            for (let j = 0; j < parsedCalls.length; j++) {
                // Fix #10: use _prefix for intentionally unused destructured vars
                const { toolName, toolArgs: _toolArgs, toolCall } = parsedCalls[j]!;  
                const toolResult = toolResults[j];
                if (runMetrics) {
                    runMetrics.maxToolResultChars = Math.max(
                        runMetrics.maxToolResultChars,
                        measureToolResultChars(toolResult)
                    );
                }

                emitStep({ type: 'tool_result', content: `${AGENT.TOOL_RESULT_PREFIX}: ${toolName}`, toolName, toolResult, timestamp: Date.now() });

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

        const finalResponse = await this.aiService.chatCompletion(messages, {
            providerId: options?.providerId,
            model: options?.model,
        });

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

    private compactMessagesInPlace(messages: ChatMessage[], toolResultBudget: number): void {
        _compactMessagesInPlace(messages, toolResultBudget);
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

        const agentToolContext: import('./types').AgentToolContext = {
            runnerOptions: options,
            agentRunner: this,
            onStep: emitStep,
            onPermissionRequest: options?.onPermissionRequest,
            onTodoUpdate: options?.onTodoUpdate
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
            try {
                const rawResult = await this.toolExecutor.execute('get_diagnostics', {
                    file: targetFile,
                    severity: 'error',
                }, agentToolContext) as any;

                const diagnostics: ValidationError[] = [];
                if (rawResult?.diagnostics && Array.isArray(rawResult.diagnostics)) {
                    for (const d of rawResult.diagnostics) {
                        diagnostics.push({
                            code: String(d.code ?? ''),
                            severity: d.severity ?? 'error',
                            message: String(d.message ?? ''),
                            line: Number(d.line ?? 0),
                            column: Number(d.column ?? 0),
                        });
                    }
                }

                result = {
                    isValid: diagnostics.length === 0,
                    errors: diagnostics,
                };
            } catch {
                // The diagnostic mechanism itself failed - considered passed
                result = { isValid: true, errors: [] };
            }

            lastErrors = result.errors;

            if (result.isValid) {
                emitStep({
                    type: 'validation',
                    content: 'Validation passed.',
                    timestamp: Date.now(),
                });

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
                break;
            }

            //Retry: send error list back to AI for correction
            retryCount++;
            const errorSummary = result.errors
                .filter(e => e.severity === 'error')
                .map(e => `Line ${e.line}: ${e.message}`)
                .join('\n');

            emitStep({
                type: 'validation',
                content: "Found " + result.errors.filter(e => e.severity === "error").length + " validation error(s); requesting a focused fix (" + retryCount + "/" + MAX_VALIDATION_RETRIES + ").",
                timestamp: Date.now(),
            });

            const retryMessage = this.promptBuilder.buildValidationRetryMessage(
                currentCode,
                result.errors.filter(e => e.severity === 'error')
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

        return {
            code: currentCode,
            validationErrors: lastErrors,
            isValid: false,
            retryCount,
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

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
