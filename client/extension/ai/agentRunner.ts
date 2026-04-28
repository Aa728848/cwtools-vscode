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
} from './types';
import { contentToString } from './types';

// P1-7: contentToString is now imported from './types' — see import above.

import { AIService } from './aiService';
import { AgentToolExecutor, TOOL_DEFINITIONS } from './agentTools';
import { PromptBuilder } from './promptBuilder';
import { getProvider, isModelVisionCapable } from './providers';
import { getModelPricing } from './pricing';
import { parseDsmlToolCalls as _parseDsmlToolCalls, stripDsmlMarkup as _stripDsmlMarkup, stripThinkBlocks as _stripThinkBlocks, cleanFinalContent as _cleanFinalContent } from './toolCallParser';
import { tryRepairJson as _tryRepairJson } from './jsonRepair';
import { budgetToolResult as _budgetToolResult, compactMessagesInPlace as _compactMessagesInPlace } from './contextBudget';

// Base fallback tool iterations (dynamically scaled in reasoningLoop)
const MAX_TOOL_ITERATIONS_BASE = 50;
// Doom-loop detection: two-phase approach.
// Phase 1 — signature-pair tracking: (prevSig, currSig) pairs. Same pair ≥ PAIR_THRESHOLD triggers Phase 2.
// Phase 2 — normalized result hash: compare hashes of adjacent same-name tool results.
//   Same hash = "spinning in place" → confirmed doom-loop → stop.
//   Different hash = "making progress" → reset pair counter and continue.
const DOOM_LOOP_PAIR_THRESHOLD = 4;

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
    // edit_file / write_file → hash written content
    if ((toolName === 'edit_file' || toolName === 'write_file') && typeof obj.content === 'string') {
        return `write:${obj.filePath ?? obj.file ?? ''}:${obj.content.length}`;
    }
    // query_scope → hash scope chain
    if (toolName === 'query_scope') {
        return `scope:${JSON.stringify(obj.currentScope ?? '')}:${JSON.stringify(obj.thisScope ?? '')}`;
    }
    // validate_code → hash error code+message set (exclude line/col)
    if (toolName === 'validate_code' && Array.isArray(obj.errors)) {
        const sigs = (obj.errors as Array<Record<string, unknown>>)
            .map(e => `${e.code ?? ''}:${e.message ?? ''}`).sort().join('|');
        return `validate:${sigs}`;
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
// Token estimation: adaptive based on content character distribution.
// English-dominated text ≈ 4 chars/token; CJK-dominated ≈ 1.5 chars/token.
// Uses a fast CJK regex sample to interpolate between the two extremes.
const CHARS_PER_TOKEN_ASCII = 4;
const CHARS_PER_TOKEN_CJK = 1.5;
 
const CJK_RANGE = /[\u3000-\u9fff\uf900-\ufaff\ufe30-\ufe4f]/g;
function estimateTokenCount(text: string): number {
    // Sample the first 4000 chars — sufficient for ratio estimation, avoids scanning huge strings
    const sample = text.length > 4000 ? text.substring(0, 4000) : text;
    const cjkMatches = sample.match(CJK_RANGE);
    const cjkRatio = cjkMatches ? cjkMatches.length / sample.length : 0;
    const charsPerToken = CHARS_PER_TOKEN_ASCII * (1 - cjkRatio) + CHARS_PER_TOKEN_CJK * cjkRatio;
    return Math.ceil(text.length / charsPerToken);
}
const COMPACTION_SUMMARY_TEMPLATE = `Output exactly this Markdown structure and keep the section order unchanged:
---
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
---

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

// WriteQueue: serializes write operations to prevent race conditions on AST/file state.
// Each AgentRunner owns one; sub-agents get their own instance for isolated tracking.
class WriteQueue {
    private queue: Promise<void> = Promise.resolve();

    enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue = this.queue
                .then(() => fn().then(resolve, reject))
                .catch(() => { /* swallow to keep the queue alive — a rejected write must not stall subsequent writes */ });
        });
    }
}

// PartitionedWriteQueue: per-file-path write serialization.
// Replaces the global single WriteQueue to allow parallel writes to different files
// while preserving per-file ordering. Multi-file operations acquire all path locks
// in sorted order (lexicographic) to prevent AB/BA deadlocks.
class PartitionedWriteQueue {
    private queues = new Map<string, WriteQueue>();

    enqueue(files: string[], fn: () => Promise<void>): Promise<void> {
        const sorted = [...new Set(files)].sort();
        const acquire = (idx: number): Promise<void> => {
            if (idx >= sorted.length) return fn(); // all locks held, execute write
            return this.getQueue(sorted[idx]!).enqueue(() => acquire(idx + 1));
        };
        return acquire(0);
    }

    private getQueue(filePath: string): WriteQueue {
        let q = this.queues.get(filePath);
        if (!q) {
            q = new WriteQueue();
            this.queues.set(filePath, q);
        }
        return q;
    }
}

// Backward-compat alias for non-text token estimation (images etc.)
const CHARS_PER_TOKEN = 4;
// Compact when conversation exceeds this fraction of provider context
const COMPACTION_THRESHOLD_RATIO = 0.95;
// Default context limit if unknown
const DEFAULT_CONTEXT_LIMIT = 128000;
// How many recent messages to keep un-compressed during compaction
const COMPACTION_KEEP_LAST_N = 8;
// Mid-loop compaction: check every N iterations within reasoningLoop
const MID_LOOP_COMPACTION_INTERVAL = 3;
// Mid-loop compaction triggers at this fraction of context limit
const MID_LOOP_COMPACTION_RATIO = 0.95;
// Tool result budget: max chars per individual tool result (scaled by context limit)
const TOOL_RESULT_BUDGET_BASE = 8000;
// Minimum tool result budget (even for tiny context windows)
const TOOL_RESULT_BUDGET_MIN = 3000;
// Maximum tool result budget (even for huge context windows like 1M)
const TOOL_RESULT_BUDGET_MAX = 30000;

export interface AgentRunnerOptions {
    /** Override provider for this run */
    providerId?: string;
    /** Override model for this run */
    model?: string;
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
}

/** Tools allowed in Plan mode (read-only, no validate_code / write operations) */
const PLAN_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'todo_write',
    'read_file', 'list_directory', 'get_diagnostics', 'web_fetch', 'search_web',
    'glob_files', 'codesearch',
];

/** Explore mode: same as plan, plus CWTools Deep API tools — no writes (OpenCode explore agent) */
const EXPLORE_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'read_file', 'list_directory',
    'get_diagnostics', 'web_fetch', 'search_web', 'glob_files',
    // CWTools Deep API tools (read-only, advertised in Explore mode prompt)
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'query_definition', 'query_definition_by_name', 'codesearch',
];

/** General mode: all tools EXCEPT todo_write (research without task tracking) */
const GENERAL_EXCLUDED_TOOLS: AgentToolName[] = ['todo_write'];

/** Review mode: same as explore, plus query_definition — NO validate_code (it creates temp files, violating read-only contract) */
const REVIEW_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'read_file', 'list_directory',
    'get_diagnostics', 'query_definition', 'query_definition_by_name',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'web_fetch', 'search_web', 'glob_files', 'codesearch',
];


// Fix #9: module-level constants — no need to recreate on every loop iteration
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multiedit', 'apply_patch', 'ast_mutate']);
const READ_ONLY_TOOLS = new Set<string>([
    'read_file', 'list_directory', 'search_mod_files',
    'get_file_context', 'document_symbols', 'workspace_symbols',
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_diagnostics', 'get_completion_at',
    // Newly added Deep API tools for parallel execution
    'query_definition', 'query_definition_by_name',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables', 'glob_files', 'codesearch'
    // validate_code is intentionally omitted: it modifies the LSP game state temporarily
]);

const globalPartitionedWriteQueue = new PartitionedWriteQueue();

export class AgentRunner {
    private writeQueue = globalPartitionedWriteQueue;
    constructor(
        private aiService: AIService,
        public readonly toolExecutor: AgentToolExecutor,
        private promptBuilder: PromptBuilder
    ) {
        // Wire up sub-agent dispatch: give the tool executor a reference to this runner
        this.toolExecutor.agentRunnerRef = this;
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
            console.error(`Failed to commit transaction ${txId}:`, e);
            return false;
        }
    }

    public discardTransaction(txId: string): boolean {
        return this.pendingTransactions.delete(txId);
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
        const tokenAccumulator: TokenUsage = { total: 0, input: 0, output: 0, estimatedCostUsd: 0 };

        // Propagate runner options + accumulator to tool executor for sub-agent dispatch
        this.toolExecutor.parentRunnerOptions = options;
        // P0 Fix: wire up permission callback so run_command can prompt user approval
        this.toolExecutor.onPermissionRequest = options?.onPermissionRequest;
        // L8 Fix: wire up the parent accumulator so dispatchSubTask can merge sub-agent costs
        this.toolExecutor.parentTokenAccumulator = tokenAccumulator;
        // Wire up onStep for sub-task progress visualization
        this.toolExecutor.onStep = emitStep;

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

        let effectiveImages = images && images.length > 0 ? images : undefined;
        if (effectiveImages && !visionSupported) {
            emitStep({
                type: 'error',
                content: `⚠️ 当前提供商 (${_providerVision.name}) 不支持图片输入，图片附件已被忽略。` +
                    (_providerIdVision === 'minimax-token-plan'
                        ? '\n提示: MiniMax Token Plan 的 Anthropic 兼容接口明确不支持图片 (官方文档)。\n若需发送图片，请切换到 "MiniMax (按量计费)" 提供商。'
                        : '\n请检查您所选模型是否支持视觉功能。'),
                timestamp: Date.now(),
            });
            effectiveImages = undefined; // drop images, proceed text-only
        }

        // Build the user turn: multimodal ContentPart[] when images are provided,
        // otherwise a plain string (keeps token overhead minimal for text-only turns)
        const userContent: string | ContentPart[] =
            effectiveImages && effectiveImages.length > 0
                ? [
                    { type: 'text' as const, text: userMessage },
                    ...effectiveImages.map(url => ({
                        type: 'image_url' as const,
                        image_url: { url, detail: 'auto' as const },
                    })),
                  ]
                : userMessage;

        // Build the message array
        const messages: ChatMessage[] = [
            { role: 'system', content: this.promptBuilder.buildSystemPromptForMode(mode, this.aiService.getConfig().provider) },
            ...this.promptBuilder.buildContextMessages(context),
            ...compactedHistory,
            { role: 'user', content: userContent },
        ];

        const modeLabel: Record<string, string> = {
            build: '分析需求中...',
            plan: '分析中（Plan 模式 — 只读）...',
            explore: '探索代码库中（Explore 模式）...',
            general: '处理请求中（General 模式）...',
            review: '代码审查中（Review 模式）...',
        };
        emitStep({
            type: 'thinking',
            content: modeLabel[mode] ?? '分析中...',
            timestamp: Date.now(),
        });


        try {
            // Phase 1: Agent reasoning loop (with tool calls)
            const finalMessage = await this.reasoningLoop(messages, emitStep, mode, options, tokenAccumulator);

            // Auto-mark remaining in-progress todos as done on successful completion
            this.autoCompleteTodos();

            // Phase 2: Extract code from the response
            const code = this.extractCode(finalMessage);

            // Plan / Explore / General / Review mode — or no code generated — just an explanation
            if (!code || mode === 'plan' || mode === 'explore' || mode === 'general' || mode === 'review') {
                return {
                    code: '',
                    explanation: finalMessage,
                    validationErrors: [],
                    isValid: true,
                    retryCount: 0,
                    steps,
                    tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
                };
            }

            // Phase 3: Validation loop
            const targetFile = context.activeFile ?? '';
            const validationResult = await this.validationLoop(
                code, targetFile, messages, emitStep, options
            );

            return {
                ...validationResult,
                explanation: this.extractExplanation(finalMessage),
                steps,
                tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
            };
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);

            if (errorMsg.includes('aborted') || errorMsg.includes('cancel')) {
                emitStep({ type: 'error', content: '已取消生成', timestamp: Date.now() });
            } else {
                emitStep({ type: 'error', content: `错误: ${errorMsg}`, timestamp: Date.now() });
            }

            return {
                code: '',
                explanation: '',
                validationErrors: [],
                isValid: false,
                retryCount: 0,
                steps,
                tokenUsage: tokenAccumulator.total > 0 ? tokenAccumulator : undefined,
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
        history: ChatMessage[],
        emitStep: (step: AgentStep) => void,
        options?: AgentRunnerOptions,
        tokenAccumulator?: TokenUsage
    ): Promise<ChatMessage[]> {
        // No early-return based on message count alone — a single large message (e.g. with
        // images) can exceed the context limit. Let the token estimate decide.

        // Estimate total token usage using CJK-aware estimation.
        // For ContentPart[] messages, also add image token overhead:
        // a typical 512×512 screenshot in base64 ≈ 800 tokens; we use the data URL byte length
        // divided by ~3 (base64 overhead factor) divided by CHARS_PER_TOKEN as a rough estimate.
        const estimatedTokens = history.reduce((sum, m) => {
            if (typeof m.content === 'string') return sum + estimateTokenCount(m.content);
            if (Array.isArray(m.content)) {
                return sum + (m.content as import('./types').ContentPart[]).reduce((s, part) => {
                    if (part.type === 'text') return s + estimateTokenCount(part.text);
                    if (part.type === 'image_url') {
                        // base64 data URL byte length / 3 ≈ raw bytes; divide by 4 chars/token
                        const urlLen = part.image_url.url.length;
                        return s + Math.ceil(urlLen / 3 / CHARS_PER_TOKEN);
                    }
                    return s;
                }, 0);
            }
            return sum;
        }, 0);

        // Get provider context limit (user override takes precedence)
        const config = this.aiService.getConfig();
        const providerId = options?.providerId ?? config.provider;
        const provider = getProvider(providerId);
        const contextLimit = config.maxContextTokens > 0
            ? config.maxContextTokens
            : (provider.maxContextTokens || DEFAULT_CONTEXT_LIMIT);
        const threshold = Math.floor(contextLimit * COMPACTION_THRESHOLD_RATIO);

        if (estimatedTokens < threshold) return history;

        // Need to compact!
        emitStep({
            type: 'compaction',
            content: `上下文压缩中... (${estimatedTokens} tokens → 目标 <${threshold})`,
            timestamp: Date.now(),
        });

        try {
            // Keep the most recent messages intact
            const recentCount = Math.min(COMPACTION_KEEP_LAST_N, history.length);
            const recentMessages = history.slice(history.length - recentCount);

            // ── Incremental compaction: detect existing summary and merge ──
            // If history already contains a compacted summary (from a previous
            // compaction round), merge it with the new older messages instead of
            // discarding it. This preserves L2 (cold archive) knowledge.
            const existingSummaryIdx = history.findIndex(
                m => m.role === 'system' && contentToString(m.content).startsWith('## Conversation Summary')
            );
            let existingSummaryText = '';
            let olderMessages: ChatMessage[];
            if (existingSummaryIdx >= 0 && existingSummaryIdx < history.length - recentCount) {
                // Extract existing summary content (strip the header)
                existingSummaryText = contentToString(history[existingSummaryIdx]!.content)  
                    .replace(/^## Conversation Summary \(compacted\)\n?/, '').trim();
                // New L1 messages = everything between the old summary and the recent window
                olderMessages = history.slice(existingSummaryIdx + 1, history.length - recentCount);
            } else {
                olderMessages = history.slice(0, history.length - recentCount);
            }

            // Build compaction prompt
            // L3 Fix: exclude system messages (they'd be mapped as 'Assistant', misleading the summarizer).
            // M4 Fix: use a larger char limit for tool/assistant messages which carry technical detail.
            
            // Enhancement: Extract pinned context — critical entities that must survive compaction.
            // These include file paths modified, scope chains established, and key entity names.
            const pinnedContext: string[] = [];
            const seenFiles = new Set<string>();
            for (const m of olderMessages) {
                const text = contentToString(m.content);
                // Extract file paths from tool calls (read_file, write_file, edit_file)
                const fileMatches = text.match(/(?:filePath|file|path)["']?\s*[:=]\s*["']([^"'\n]+)/gi);
                if (fileMatches) {
                    for (const fm of fileMatches) {
                        const fp = fm.replace(/.*?["']([^"']+)["']?$/, '$1').trim();
                        if (fp && fp.includes('/') && !seenFiles.has(fp)) {
                            seenFiles.add(fp);
                            pinnedContext.push(`• File: ${fp}`);
                        }
                    }
                }
                // Extract scope chains (common in Stellaris modding context)
                const scopeMatches = text.match(/scope\s*[:=]\s*\w+/gi);
                if (scopeMatches) {
                    for (const sm of scopeMatches.slice(0, 5)) {
                        pinnedContext.push(`• ${sm}`);
                    }
                }
            }
            const pinnedSection = pinnedContext.length > 0
                ? `\n\n## Pinned Context (do NOT omit):\n${[...new Set(pinnedContext)].slice(0, 30).join('\n')}`
                : '';

             // Build structured message context for the compaction AI call.
            // Tool results preserve file path + success/error as dense metadata.
            const messageContext = olderMessages
                .filter(m => m.role !== 'system')
                .map(m => {
                    const role = m.role === 'user' ? 'User' : m.role === 'tool' ? 'Tool' : 'Assistant';
                    if (m.role === 'tool') {
                        const content = contentToString(m.content);
                        const successMatch = content.match(/"success"\s*:\s*(true|false)/);
                        const fileMatch = content.match(/"(?:file|filePath)"\s*:\s*"([^"]+)"/);
                        const errorMatch = content.match(/"(?:error|message)"\s*:\s*"([^"]{0,200})"/);
                        const summary = [
                            fileMatch ? `file=${fileMatch[1]}` : null,
                            successMatch ? `success=${successMatch[1]}` : null,
                            errorMatch && successMatch?.[1] === 'false' ? `error=${errorMatch[1]}` : null,
                        ].filter(Boolean).join(' ');
                        return `<${role}>: ${summary || content.substring(0, 500)}`;
                    }
                    const maxLen = m.role === 'user' ? 500 : 2000;
                    const content = contentToString(m.content).substring(0, maxLen);
                    return `<${role}>: ${content}`;
                }).join('\n');

            // Build compaction instruction with the structured template.
            // Incremental merge: prepend existing summary as <previous-summary>.
            const compactionSystemPrompt = existingSummaryText
                ? [
                    `Update the anchored summary below using the conversation history above.`,
                    `Preserve still-true details, remove stale details, and merge in the new facts.`,
                    `<previous-summary>`,
                    existingSummaryText,
                    `</previous-summary>`,
                  ].join('\n')
                : `Create a new anchored summary from the conversation history above.`;

            const compactionInstruction = [
                compactionSystemPrompt,
                COMPACTION_SUMMARY_TEMPLATE,
                pinnedSection,
                messageContext,
            ].filter(Boolean).join('\n\n');

            const compactionMessages: ChatMessage[] = [
                { role: 'system', content: this.promptBuilder.buildCompactionPrompt() },
                { role: 'user', content: compactionInstruction },
            ];

            const compactionResponse = await this.aiService.chatCompletion(compactionMessages, {
                temperature: 0.1,
                maxTokens: 2048,
                providerId: options?.providerId,
                model: options?.model,
            });

            // Account for compaction call's token usage in the parent accumulator
            if (tokenAccumulator && compactionResponse.usage) {
                const pricing = getModelPricing(compactionResponse.model ?? options?.model ?? '');
                tokenAccumulator.input += compactionResponse.usage.prompt_tokens;
                tokenAccumulator.output += compactionResponse.usage.completion_tokens;
                tokenAccumulator.total += compactionResponse.usage.total_tokens;
                tokenAccumulator.estimatedCostUsd +=
                    (compactionResponse.usage.prompt_tokens / 1_000_000) * pricing[0] +
                    (compactionResponse.usage.completion_tokens / 1_000_000) * pricing[1];
            }

            const summary = compactionResponse.choices?.[0]?.message?.content ?? '';

            if (summary.length > 0) {
                const compactionType = existingSummaryText ? '增量合并' : '初始压缩';
                emitStep({
                    type: 'compaction',
                    content: `上下文已压缩 (${compactionType}): ${olderMessages.length} 条消息 → 摘要 (${summary.length} chars, ${pinnedContext.length} pinned entities)`,
                    timestamp: Date.now(),
                });

                // Return compacted history: summary (with pinned context) + recent messages
                return [
                    {
                        role: 'system',
                        content: `## Conversation Summary (compacted)\n${summary}${pinnedSection}`,
                    },
                    ...recentMessages,
                ];
            }
        } catch (e) {
            // If compaction fails, just truncate to recent messages
            emitStep({
                type: 'error',
                content: `上下文压缩失败: ${e instanceof Error ? e.message : String(e)}`,
                timestamp: Date.now(),
            });
        }

        // Fallback: keep only recent messages
        const fallbackCount = Math.min(6, history.length);
        return history.slice(history.length - fallbackCount);
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
        onFileWrite?: (filePath: string, prevContent: string | null) => void
    ): Promise<string> {
        let iteration = 0;
        // Two-phase doom-loop detection:
        // phase1: track (prevSig → currSig) pair frequency
        // phase2: compare normalized result hashes for same-name calls
        const pairFrequency = new Map<string, number>();
        const lastResultHash = new Map<string, number>(); // sig → fnv32a(normalized result)
        let prevCallSignature = '';
        let consecutiveErrorCount = 0;
        // Flag set to true when we need to exit the outer while loop
        let forceStop = false;
        // Track files confirmed-written this session
        const confirmedWrittenFiles = new Set<string>();
        // Track permanently allowed tool calls
        const alwaysAllowedTools = new Set<string>();

        // Filter tools by mode
        let availableTools: typeof TOOL_DEFINITIONS;
        if (mode === 'plan') {
            availableTools = TOOL_DEFINITIONS.filter(t => PLAN_MODE_TOOLS.includes(t.function.name as AgentToolName));
        } else if (mode === 'explore') {
            availableTools = TOOL_DEFINITIONS.filter(t => EXPLORE_MODE_TOOLS.includes(t.function.name as AgentToolName));
        } else if (mode === 'review') {
            availableTools = TOOL_DEFINITIONS.filter(t => REVIEW_MODE_TOOLS.includes(t.function.name as AgentToolName));
        } else if (mode === 'general') {
            availableTools = TOOL_DEFINITIONS.filter(t => !GENERAL_EXCLUDED_TOOLS.includes(t.function.name as AgentToolName));
        } else {
            availableTools = TOOL_DEFINITIONS;
        }

        // M3 Fix: remove per-call dynamic import — getProvider is already statically
        // imported at the top of this file; dynamic import added latency for nothing.
        const _config0 = this.aiService.getConfig();
        const _providerId0 = options?.providerId ?? _config0.provider;
        const _provider0 = getProvider(_providerId0);
        const useDsmlToolRole0 = _provider0.toolCallStyle === 'dsml';

        // Compute context limit and tool result budget once for the entire loop
        const contextLimit = _config0.maxContextTokens > 0
            ? _config0.maxContextTokens
            : (_provider0.maxContextTokens || DEFAULT_CONTEXT_LIMIT);
        const midLoopThreshold = Math.floor(contextLimit * MID_LOOP_COMPACTION_RATIO);
        // Scale tool result budget proportionally to context window (linear interpolation)
        // 128K → 8000 chars, 200K → 12500, 1M → 30000 (capped)
        const toolResultBudget = Math.min(
            TOOL_RESULT_BUDGET_MAX,
            Math.max(TOOL_RESULT_BUDGET_MIN, Math.floor(TOOL_RESULT_BUDGET_BASE * (contextLimit / DEFAULT_CONTEXT_LIMIT)))
        );

        // Dynamic iteration limit based on context scale
        // 128K → 50, 200K → ~78→cap80, 1M → cap80.  Min 30, Max 80.
        const maxToolIterations = Math.min(
            80, // Cap: beyond 80 iterations, compaction overhead dominates
            Math.max(
                30, // Absolute minimum iterations
                Math.floor(MAX_TOOL_ITERATIONS_BASE * (contextLimit / DEFAULT_CONTEXT_LIMIT))
            )
        );

        while (iteration < maxToolIterations) {
            options?.abortSignal?.throwIfAborted();
            iteration++;

            // ── Mid-loop compaction: prevent uncontrolled context growth ──────
            // Every MID_LOOP_COMPACTION_INTERVAL iterations, estimate message size
            // and compact if approaching the context window limit.
            if (iteration > 1 && (iteration - 1) % MID_LOOP_COMPACTION_INTERVAL === 0) {
                const loopTokens = messages.reduce((s, m) => s + estimateTokenCount(contentToString(m.content)), 0);
                if (loopTokens > midLoopThreshold) {
                    emitStep({
                        type: 'compaction',
                        content: `循环内上下文压缩中... (${loopTokens} tokens, 阈值 ${midLoopThreshold})`,
                        timestamp: Date.now(),
                    });
                    this.compactMessagesInPlace(messages, toolResultBudget);
                }
            }

            const announcedPaths = new Set<string>();
            const WRITE_TOOLS_PEEK = new Set(['write_file', 'edit_file', 'multiedit', 'apply_patch', 'ast_mutate']);
            
            const tryAnnouncePath = (name: string, content: string) => {
                if (!WRITE_TOOLS_PEEK.has(name)) return;
                const pathMatch = content.match(/"file(?:Path)?"\s*:\s*"([^"]+)"/);
                if (pathMatch && pathMatch[1]) {
                    const extractedPath = pathMatch[1];
                    if (!announcedPaths.has(extractedPath)) {
                        announcedPaths.add(extractedPath);
                        emitStep({
                            type: 'text_delta',
                            content: `\n> ⏳ 正在解析修改策略... 锁定目标文件: \`${extractedPath}\`\n`,
                            timestamp: Date.now()
                        });
                    }
                }
            };
            
            let dsmlToolNameBuf = '';
            let dsmlArgsBuf = '';
            let isInsideDsml = false;

            let response;
            try {
                response = await this.aiService.chatCompletion(messages, {
                    tools: availableTools,
                    providerId: options?.providerId,
                    model: options?.model,
                    // Stream thinking tokens to UI in real-time (OpenCode-style)
                    onThinking: (text) => {
                        emitStep({
                            type: 'thinking_content',
                            content: text,
                            timestamp: Date.now(),
                        });
                    },
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
                        content: `[SYSTEM] Your previous response was forcefully terminated by the API server (likely due to hard length limits or timeout). Please DO NOT output massive text blocks, and DO NOT use write_file for files over 150 lines. Break your task into small steps using multiedit.`
                    });
                    continue;
                }
                throw err;
            }

            // Accumulate token usage from this API call
            if (tokenAccumulator && response.usage) {
                const pricing = getModelPricing(response.model ?? options?.model ?? '');
                const inputCost = (response.usage.prompt_tokens / 1_000_000) * pricing[0];
                const outputCost = (response.usage.completion_tokens / 1_000_000) * pricing[1];
                tokenAccumulator.input += response.usage.prompt_tokens;
                tokenAccumulator.output += response.usage.completion_tokens;
                tokenAccumulator.total += response.usage.total_tokens;
                tokenAccumulator.estimatedCostUsd += inputCost + outputCost;
                tokenAccumulator.contextWindowTokens = response.usage.prompt_tokens;
                // Enforce session-wide token budget (propagates through sub-agents via parentAccumulator)
                this.aiService.reportUsage(tokenAccumulator.total);
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
            if (thinkContent.trim()) {
                emitStep({
                    type: 'thinking_content',
                    content: thinkContent.trim(),
                    timestamp: Date.now(),
                });
            }

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
                    content: `[SYSTEM] Your previous response was truncated by the API max_tokens length limit. Please DO NOT output massive blocks of text. Break down your modifications into smaller steps. Use todo_write to plan them, and execute a single multiedit/apply_patch per response.`
                });
                continue;
            }

            // If no tool calls (either format), we're done
            if (!toolCalls || toolCalls.length === 0) {
                return this.cleanFinalContent(contentToString(assistantMessage.content));
            }

            // ── Two-phase doom-loop detection: phase 1 (pre-exec) ──
            // Track (prevSig → currSig) pairs. If the same pair repeats
            // ≥ DOOM_LOOP_PAIR_THRESHOLD times, flag for phase-2 hash check.
            const callSignature = toolCalls.map(tc => `${tc.function.name}:${tc.function.arguments}`).join('|');
            let needsHashValidation = false;
            if (prevCallSignature) {
                const pairKey = `${prevCallSignature}→${callSignature}`;
                const pairFreq = (pairFrequency.get(pairKey) || 0) + 1;
                pairFrequency.set(pairKey, pairFreq);
                if (pairFreq >= DOOM_LOOP_PAIR_THRESHOLD) needsHashValidation = true;
            }
            prevCallSignature = callSignature;

            // ── Deduplicate file-write calls ──────────────────────────────────
            // If the model emitted multiple write/edit calls targeting the same file
            // in one response, only keep the LAST one for each file.
            const lastWriteIndexByFile = new Map<string, number>();
            for (let i = 0; i < toolCalls.length; i++) {
                if (!WRITE_TOOLS.has(toolCalls[i]!.function.name)) continue;  
                try {
                    const a = JSON.parse(toolCalls[i]!.function.arguments);  
                    // edit_file uses filePath, write_file uses file
                    const filePath: string = a.filePath ?? a.file ?? '';
                    if (filePath) lastWriteIndexByFile.set(filePath, i);
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
                emitStep({ type: 'tool_call', content: `调用工具: ${toolName}`, toolName, toolArgs, timestamp: Date.now() });
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
                const ci = parsedCalls[i]!;
                const { toolName, toolArgs, toolCall } = ci;

                if (ci.toolArgsParseError) {
                    toolResults[i] = { ok: false, error: `Tool argument JSON parse failed — ${ci.toolArgsParseError}. Please retry with valid JSON arguments.` };
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
                            const callInfo = parsedCalls[idx]!;
                            toolResults[idx] = await this.toolExecutor.execute(callInfo.toolName, callInfo.toolArgs);
                        } catch (e) {
                            toolResults[idx] = { error: e instanceof Error ? e.message : String(e) };
                        }
                    }));
                } else {
                    // Write tool: execute serially taking advantage of PartitionedWriteQueue
                    const filePath = (toolArgs['filePath'] as string) ?? (toolArgs['file'] as string) ?? '';
                    const isSupersededWrite = WRITE_TOOLS.has(toolName) && filePath &&
                        lastWriteIndexByFile.get(filePath) !== i;

                    // Collect all file paths that this tool touches for partitioned locking
                    const lockPaths: string[] = [];
                    if (filePath) lockPaths.push(filePath);
                    // multiedit may touch multiple files
                    if (toolName === 'multiedit' && Array.isArray(toolArgs['edits'])) {
                        for (const edit of toolArgs['edits'] as Array<Record<string, unknown>>) {
                            const ep = (edit.filePath ?? edit.file ?? '') as string;
                            if (ep && !lockPaths.includes(ep)) lockPaths.push(ep);
                        }
                    }

                    await this.writeQueue.enqueue(lockPaths.length > 0 ? lockPaths : ['__global__'], async () => {
                        try {
                            // Sub-agent snapshot isolate hook
                            if (onFileWrite && filePath) {
                                if (!fsModule) fsModule = await import('fs');
                                const prev = fsModule.existsSync(filePath) ? fsModule.readFileSync(filePath, 'utf8') : null;
                                onFileWrite(filePath, prev);
                            }

                            if (isSupersededWrite) {
                                toolResults[i] = { skipped: true, message: `已被后续对 ${filePath} 的写入操作覆盖，跳过本次写入` };
                            } else if (toolName === 'write_file') {
                                const content = (toolArgs['content'] as string) || '';
                                let openCount = 0, closeCount = 0;
                                for (let c = 0; c < content.length; c++) {
                                    if (content[c] === '{') openCount++;
                                    if (content[c] === '}') closeCount++;
                                }
                                if (openCount !== closeCount) {
                                    toolResults[i] = { error: `Pre-flight Syntax Reject: Unbalanced braces detected (open: ${openCount}, close: ${closeCount}). Please fix your code, use analyze_diagnostic_error to reflect, and retry.` };
                                } else {
                                    const args = (confirmedWrittenFiles.has(filePath)) ? { ...toolArgs, _autoApply: true } : toolArgs;
                                    toolResults[i] = await this.toolExecutor.execute(toolName, args);
                                    const r = toolResults[i] as Record<string, unknown>;
                                    if (r && (r.success || r.confirmed)) confirmedWrittenFiles.add(filePath);
                                }
                            } else if (WRITE_TOOLS.has(toolName) && filePath && confirmedWrittenFiles.has(filePath)) {
                                toolResults[i] = await this.toolExecutor.execute(toolName, { ...toolArgs, _autoApply: true });
                            } else {
                                toolResults[i] = await this.toolExecutor.execute(toolName, toolArgs);
                                if (WRITE_TOOLS.has(toolName) && filePath) {
                                    const r = toolResults[i] as Record<string, unknown>;
                                    if (r && (r.success || r.confirmed)) confirmedWrittenFiles.add(filePath);
                                }
                            }
                        } catch (e) {
                            toolResults[i] = { error: e instanceof Error ? e.message : String(e) };
                        }
                    });
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
                        const pairKey = `${prevCallSignature}→${callSignature}`;
                        pairFrequency.set(pairKey, 0);
                        allHashesMatch = false;
                    }
                    lastResultHash.set(sig, resultHash);
                }
                if (allHashesMatch) {
                    emitStep({
                        type: 'error',
                        content: '检测到死循环 (Doom-Loop): 签名对重复且工具返回结果未变化，已强制停止',
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
                    content: `紧急上下文压缩 (${emergencyTokens} tokens > ${contextLimit} 上限)`,
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

                emitStep({ type: 'tool_result', content: `工具结果: ${toolName}`, toolName, toolResult, timestamp: Date.now() });

                // Track consecutive errors
                if (typeof toolResult === 'object' && toolResult !== null &&
                    'error' in toolResult && !('success' in toolResult)) {
                    consecutiveErrorCount++;
                    if (consecutiveErrorCount >= 5) {
                        emitStep({ type: 'error', content: '工具连续失败 5 次，已强制停止', timestamp: Date.now() });
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
                        content: `[Tool Result for ${toolCall.function.name} (id=${toolCall.id})]:\n${budgetedResult}`,
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

            // If forceStop was set in the emit-results loop, exit outer while now
            if (forceStop) break;
        }

        // C2 Fix: check abort signal BEFORE the final over-iteration API call.
        // If the user cancelled, skip this call — it would produce charges and
        // stale UI state ("已取消" already emitted but a new request fires anyway).
        options?.abortSignal?.throwIfAborted();

        // Max iterations reached — try to get a final response without tools
        const finalResponse = await this.aiService.chatCompletion(messages, {
            providerId: options?.providerId,
            model: options?.model,
        });

        const finalContent = contentToString(finalResponse.choices[0]?.message?.content);
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
     * Validation loop: validate code → if errors → retry with AI → repeat (max 3 retries)
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

        while (retryCount <= MAX_VALIDATION_RETRIES) {
            options?.abortSignal?.throwIfAborted();

            emitStep({
                type: 'validation',
                content: retryCount === 0
                    ? '验证生成的代码...'
                    : `第 ${retryCount} 次修正验证...`,
                timestamp: Date.now(),
            });

            // Validate
            let result;
            try {
                result = await this.toolExecutor.execute('validate_code', {
                    code: currentCode,
                    targetFile,
                }) as { isValid: boolean; errors: ValidationError[] };
            } catch {
                // Validation mechanism itself failed — assume code is OK
                result = { isValid: true, errors: [] };
            }

            lastErrors = result.errors;

            if (result.isValid) {
                emitStep({
                    type: 'validation',
                    content: `✅ 验证通过 (${result.errors.length} 警告)`,
                    timestamp: Date.now(),
                });

                return {
                    code: currentCode,
                    validationErrors: result.errors,
                    isValid: true,
                    retryCount,
                };
            }

            // Check if we've exhausted retries
            if (retryCount >= MAX_VALIDATION_RETRIES) {
                emitStep({
                    type: 'validation',
                    content: `⚠️ ${MAX_VALIDATION_RETRIES} 次修正后仍有错误`,
                    timestamp: Date.now(),
                });
                break;
            }

            // Retry: send errors back to AI for fixing
            retryCount++;
            const errorSummary = result.errors
                .filter(e => e.severity === 'error')
                .map(e => `Line ${e.line}: ${e.message}`)
                .join('\n');

            emitStep({
                type: 'validation',
                content: `❌ 发现 ${result.errors.filter(e => e.severity === 'error').length} 个错误，正在修正 (第 ${retryCount}/${MAX_VALIDATION_RETRIES} 次)...`,
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
                        content: '已生成修正后的代码',
                        timestamp: Date.now(),
                    });
                } else {
                    // AI couldn't fix it
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

    // ─── Sub-Agent Dispatch ───────────────────────────────────────────────────

    /**
     * Run a sub-agent task with a restricted tool set (explore or general mode).
     * L8 Fix: accepts optional parentAccumulator so sub-agent token costs are
     * merged into the parent generation's token counter (UI shows full cost).
     */
    async runSubAgent(
        prompt: string,
        mode: 'explore' | 'general' | 'build',
        parentOptions?: AgentRunnerOptions,
        onStep?: (step: AgentStep) => void,
        parentAccumulator?: TokenUsage,
        onFileWrite?: (filePath: string, prevContent: string | null) => void,
        parentContextHint?: string,
    ): Promise<string> {
        // P3: sub-agents use slim CWTOOLS.md (only mod info + namespaces)
        // to avoid bloating narrow-scope sub-agent contexts with full project rules
        const subSystemPrompt = this.promptBuilder.buildSlimSystemPromptForMode(
            mode,
            this.aiService.getConfig().provider
        );

        // Inject parent context summary so sub-agents don't start from scratch
        const contextualizedPrompt = parentContextHint
            ? `## Context from parent agent\n${parentContextHint}\n\n---\n\n## Your task\n${prompt}`
            : prompt;

        const messages: ChatMessage[] = [
            { role: 'system', content: subSystemPrompt },
            { role: 'user', content: contextualizedPrompt },
        ];

        const subOptions: AgentRunnerOptions = {
            providerId: parentOptions?.providerId,
            model: parentOptions?.model,
            mode,
            abortSignal: parentOptions?.abortSignal,
            onStep,
        };

        const subTokens: TokenUsage = { total: 0, input: 0, output: 0, estimatedCostUsd: 0 };

        try {
            const result = await this.reasoningLoop(messages, onStep ?? (() => { }), mode, subOptions, subTokens, onFileWrite);
            // L8 Fix: merge sub-agent token usage into parent accumulator
            if (parentAccumulator) {
                parentAccumulator.total += subTokens.total;
                parentAccumulator.input += subTokens.input;
                parentAccumulator.output += subTokens.output;
                parentAccumulator.estimatedCostUsd += subTokens.estimatedCostUsd;
            }
            return result;
        } catch (e) {
            return `Sub-agent error: ${e instanceof Error ? e.message : String(e)}`;
        }
    }
}
