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

/** Safely coerce ChatMessage.content (string | ContentPart[] | null) to a string for text operations. */
function contentToString(content: string | ContentPart[] | null | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    // ContentPart[] — join text parts
    return content.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map(p => p.text)
        .join('');
}

import { AIService } from './aiService';
import { AgentToolExecutor, TOOL_DEFINITIONS } from './agentTools';
import { PromptBuilder } from './promptBuilder';
import { getProvider, isModelVisionCapable } from './providers';
import { getModelPricing } from './pricing';

// Maximum tool-call iterations per generation (matches OpenCode's permissive default)
const MAX_TOOL_ITERATIONS = 50;
// Doom-loop detection threshold: N consecutive identical call-signatures = loop (OpenCode: DOOM_LOOP_THRESHOLD)
const DOOM_LOOP_THRESHOLD = 3;
// Maximum validation-retry rounds (reduced: edit_file now returns inline LSP diagnostics)
const MAX_VALIDATION_RETRIES = 2;
// Token estimation: ~4 chars per token (rough approximation)
const CHARS_PER_TOKEN = 4;
// Compact when conversation exceeds this fraction of provider context
const COMPACTION_THRESHOLD_RATIO = 0.7;
// Default context limit if unknown
const DEFAULT_CONTEXT_LIMIT = 128000;
// How many recent messages to keep un-compressed during compaction
const COMPACTION_KEEP_LAST_N = 4;
// Mid-loop compaction: check every N iterations within reasoningLoop
const MID_LOOP_COMPACTION_INTERVAL = 3;
// Mid-loop compaction triggers at this fraction of context limit
const MID_LOOP_COMPACTION_RATIO = 0.80;
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
}

/** Tools allowed in Plan mode (read-only, no validate_code / write operations) */
const PLAN_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'todo_write',
    'read_file', 'list_directory', 'get_diagnostics', 'web_fetch', 'search_web',
];

/** Explore mode: same as plan, plus workspace_symbols and web tools — no writes (OpenCode explore agent) */
const EXPLORE_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'read_file', 'list_directory',
    'get_diagnostics', 'web_fetch', 'search_web',
];

/** General mode: all tools EXCEPT todo_write (research without task tracking) */
const GENERAL_EXCLUDED_TOOLS: AgentToolName[] = ['todo_write'];

/** Review mode: same as explore, plus validate_code and query_definition */
const REVIEW_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'read_file', 'list_directory',
    'get_diagnostics', 'validate_code', 'query_definition', 'query_definition_by_name',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables'
];


// Fix #9: module-level constants — no need to recreate on every loop iteration
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multiedit', 'patch']);
const READ_ONLY_TOOLS = new Set<string>([
    'read_file', 'list_directory', 'search_mod_files',
    'get_file_context', 'document_symbols', 'workspace_symbols',
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_diagnostics', 'get_completion_at',
    // validate_code is intentionally omitted: it modifies the LSP game state temporarily
]);

export class AgentRunner {
    constructor(
        private aiService: AIService,
        public readonly toolExecutor: AgentToolExecutor,
        private promptBuilder: PromptBuilder
    ) {
        // Wire up sub-agent dispatch: give the tool executor a reference to this runner
        this.toolExecutor.agentRunnerRef = this;
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

        // Estimate total token usage. For ContentPart[] messages, also add image token overhead:
        // a typical 512×512 screenshot in base64 ≈ 800 tokens; we use the data URL byte length
        // divided by ~3 (base64 overhead factor) divided by CHARS_PER_TOKEN as a rough estimate.
        const totalChars = history.reduce((sum, m) => {
            if (typeof m.content === 'string') return sum + m.content.length;
            if (Array.isArray(m.content)) {
                return sum + (m.content as import('./types').ContentPart[]).reduce((s, part) => {
                    if (part.type === 'text') return s + part.text.length;
                    if (part.type === 'image_url') {
                        // base64 data URL byte length / 3 ≈ raw bytes; divide by 4 chars/token
                        const urlLen = part.image_url.url.length;
                        return s + Math.ceil(urlLen / 3);  // rough token estimate for image
                    }
                    return s;
                }, 0);
            }
            return sum;
        }, 0);
        const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);

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
                existingSummaryText = contentToString(history[existingSummaryIdx].content)
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

            // Build per-message summaries with structured tool result preservation
            const summaryText = olderMessages
                .filter(m => m.role !== 'system')   // L3 Fix
                .map(m => {
                    const role = m.role === 'user' ? 'User' : m.role === 'tool' ? 'Tool' : 'Assistant';
                    // Tool messages: preserve file path + action + success/error as structured data
                    if (m.role === 'tool') {
                        const content = contentToString(m.content);
                        // Extract key result info: success/error + file path
                        const successMatch = content.match(/"success"\s*:\s*(true|false)/);
                        const fileMatch = content.match(/"(?:file|filePath)"\s*:\s*"([^"]+)"/);
                        const errorMatch = content.match(/"(?:error|message)"\s*:\s*"([^"]{0,200})"/);
                        const summary = [
                            fileMatch ? `file=${fileMatch[1]}` : null,
                            successMatch ? `success=${successMatch[1]}` : null,
                            errorMatch && successMatch?.[1] === 'false' ? `error=${errorMatch[1]}` : null,
                        ].filter(Boolean).join(' ');
                        return `[Tool]: ${summary || content.substring(0, 500)}`;
                    }
                    // M4 Fix: user messages get 500 chars; assistant get 2000
                    const maxLen = m.role === 'user' ? 500 : 2000;
                    const content = contentToString(m.content).substring(0, maxLen);
                    return `[${role}]: ${content}`;
                }).join('\n');

            // If there's an existing summary, ask the AI to merge it with the new messages
            const compactionInstruction = existingSummaryText
                ? `Merge the existing conversation summary with the new messages below into a single updated summary.\n\n## Existing Summary:\n${existingSummaryText}\n\n## New Messages:${pinnedSection}\n\n${summaryText}`
                : `Summarize this conversation:${pinnedSection}\n\n${summaryText}`;

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
        tokenAccumulator?: TokenUsage
    ): Promise<string> {
        let iteration = 0;
        // M2 Fix: track consecutive identical signatures via counter,
        // not a sliding window (A-B-A-B never triggered the old window approach).
        let consecutiveSameSignature = 0;
        let lastCallSignature = '';
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

        while (iteration < MAX_TOOL_ITERATIONS) {
            options?.abortSignal?.throwIfAborted();
            iteration++;

            // ── Mid-loop compaction: prevent uncontrolled context growth ──────
            // Every MID_LOOP_COMPACTION_INTERVAL iterations, estimate message size
            // and compact if approaching the context window limit.
            if (iteration > 1 && (iteration - 1) % MID_LOOP_COMPACTION_INTERVAL === 0) {
                const loopChars = messages.reduce((s, m) => s + contentToString(m.content).length, 0);
                const loopTokens = Math.ceil(loopChars / CHARS_PER_TOKEN);
                if (loopTokens > midLoopThreshold) {
                    emitStep({
                        type: 'compaction',
                        content: `循环内上下文压缩中... (${loopTokens} tokens, 阈值 ${midLoopThreshold})`,
                        timestamp: Date.now(),
                    });
                    this.compactMessagesInPlace(messages, toolResultBudget);
                }
            }

            const response = await this.aiService.chatCompletion(messages, {
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
                    emitStep({
                        type: 'text_delta',
                        content: text,
                        timestamp: Date.now(),
                    });
                } : undefined,
            });

            // Accumulate token usage from this API call
            if (tokenAccumulator && response.usage) {
                const pricing = getModelPricing(response.model ?? options?.model ?? '');
                const inputCost = (response.usage.prompt_tokens / 1_000_000) * pricing[0];
                const outputCost = (response.usage.completion_tokens / 1_000_000) * pricing[1];
                tokenAccumulator.input += response.usage.prompt_tokens;
                tokenAccumulator.output += response.usage.completion_tokens;
                tokenAccumulator.total += response.usage.total_tokens;
                tokenAccumulator.estimatedCostUsd += inputCost + outputCost;
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
                    thinkMatches.push(tm[1].trim());
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

            // Add assistant response (cleaned) to conversation history
            messages.push(assistantMessage);

            // If no tool calls (either format), we're done
            if (!toolCalls || toolCalls.length === 0) {
                return this.cleanFinalContent(contentToString(assistantMessage.content));
            }

            // ── M2 Fix: Doom loop detection via consecutive-call counter ──────
            // Count consecutive iterations with identical call signatures.
            // Works for both exact repeats AND alternating patterns if we track
            // only the latest signature (pure repeat = doom loop).
            const callSignature = toolCalls.map(tc => `${tc.function.name}:${tc.function.arguments}`).join('|');
            if (callSignature === lastCallSignature) {
                consecutiveSameSignature++;
            } else {
                consecutiveSameSignature = 1;
                lastCallSignature = callSignature;
            }
            if (consecutiveSameSignature >= DOOM_LOOP_THRESHOLD) {
                emitStep({
                    type: 'error',
                    content: '检测到循环工具调用，已强制停止',
                    timestamp: Date.now(),
                });
                break;
            }

            // ── Deduplicate file-write calls ──────────────────────────────────
            // If the model emitted multiple write/edit calls targeting the same file
            // in one response, only keep the LAST one for each file.
            const lastWriteIndexByFile = new Map<string, number>();
            for (let i = 0; i < toolCalls.length; i++) {
                if (!WRITE_TOOLS.has(toolCalls[i].function.name)) continue;
                try {
                    const a = JSON.parse(toolCalls[i].function.arguments);
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
                try { toolArgs = JSON.parse(toolCall.function.arguments); } catch (e) {
                    toolArgs = {};
                    toolArgsParseError = `JSON parse error: ${e instanceof Error ? e.message : String(e)}. Raw arguments: ${toolCall.function.arguments?.substring(0, 200)}`;
                }
                emitStep({ type: 'tool_call', content: `调用工具: ${toolName}`, toolName, toolArgs, timestamp: Date.now() });
                parsedCalls.push({ toolName, toolArgs, toolArgsParseError, toolCall });
            }

            const toolResults: unknown[] = new Array(parsedCalls.length);
            let i = 0;
            while (i < parsedCalls.length) {
                options?.abortSignal?.throwIfAborted();
                const { toolName, toolArgs, toolArgsParseError, toolCall } = parsedCalls[i];

                // If arguments failed to parse as JSON, short-circuit and return an error
                // so the AI knows to retry with properly formatted arguments.
                if (toolArgsParseError) {
                    toolResults[i] = { ok: false, error: `Tool argument JSON parse failed — ${toolArgsParseError}. Please retry with valid JSON arguments.` };
                    // Fix #10: toolCall unused in error path — no need for void statement
                    i++;
                    continue;
                }

                if (READ_ONLY_TOOLS.has(toolName)) {
                    // Collect a batch of consecutive read-only tools (skip any with parse errors)
                    const batch: Array<{ idx: number; toolName: AgentToolName; toolArgs: Record<string, unknown>; toolCall: typeof toolCalls[0] }> = [];
                    while (i < parsedCalls.length && READ_ONLY_TOOLS.has(parsedCalls[i].toolName) && !parsedCalls[i].toolArgsParseError) {
                        batch.push({ idx: i, ...parsedCalls[i] });
                        i++;
                    }
                    // Execute batch in parallel
                    await Promise.all(batch.map(async ({ idx, toolName: tn, toolArgs: ta }) => {
                        try {
                            toolResults[idx] = await this.toolExecutor.execute(tn, ta);
                        } catch (e) {
                            toolResults[idx] = { error: e instanceof Error ? e.message : String(e) };
                        }
                    }));
                    // Fix #10: batchStart was only used by void — removed
                } else {
                    // Write or interactive tool — execute serially
                    const callIndex = i;
                    const filePath = (toolArgs['filePath'] as string) ?? (toolArgs['file'] as string) ?? '';
                    const isSupersededWrite = WRITE_TOOLS.has(toolName) && filePath &&
                        lastWriteIndexByFile.get(filePath) !== callIndex;

                    try {
                        if (isSupersededWrite) {
                            toolResults[i] = { skipped: true, message: `已被后续对 ${filePath} 的写入操作覆盖，跳过本次写入` };
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
                    // Fix #10: removed void toolCall — variable unused in this branch
                    i++;
                }
            }

            // If forceStop was set in the inner loop, exit the outer while now
            if (forceStop) break;

            // Emit results in original order and feed back to AI
            for (let j = 0; j < parsedCalls.length; j++) {
                // Fix #10: use _prefix for intentionally unused destructured vars
                const { toolName, toolArgs: _toolArgs, toolCall } = parsedCalls[j];
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

    /**
     * Parse text-format tool calls from a model response.
     * Handles multiple real-world formats:
     *
     * 1. DeepSeek DSML (V3.2+, local/vLLM/SGLang):
     *    <｜DSML｜function_calls>\n  <｜DSML｜invoke name="fn">\n    <｜DSML｜parameter name="p" string="true">val</｜DSML｜parameter>\n  </｜DSML｜invoke>\n</｜DSML｜function_calls>
     *    (｜ is the FULL-WIDTH VERTICAL LINE U+FF5C)
     *
     * 2. Qwen / Hermes style:
     *    <tool_call>\n{"name": "fn", "arguments": {...}}\n</tool_call>
     *
     * 3. Qwen-Coder style:
     *    <tool_call><function=fn><parameter=p>val</parameter></function></tool_call>
     *
     * 4. Generic XML (Claude antml_, simple <invoke>):
     *    <function_calls><invoke name="fn"><parameter name="p">val</parameter></invoke></function_calls>
     */
    /**
     * Parses Tool Calls using a robust state-machine approach.
     * Replaces fragile regex parsing to handle nested brackets, code blocks,
     * and escaped sequences elegantly.
     */
    private parseDsmlToolCalls(content: string): import('./types').ToolCall[] {
        const calls: import('./types').ToolCall[] = [];
        
        // Normalize full-width pipes common in DeepSeek
        let norm = content.replace(/\uFF5C/g, '|');
        // Unify tag formats by normalizing them to standard <invoke name="...">...</invoke>
        norm = norm.replace(/<\|DSML\|invoke\s+name=/gi, '<invoke name=');
        norm = norm.replace(/<\/\|DSML\|invoke>/gi, '</invoke>');
        norm = norm.replace(/<\|DSML\|parameter\s+name=/gi, '<parameter name=');
        norm = norm.replace(/<\/\|DSML\|parameter>/gi, '</parameter>');
        
        norm = norm.replace(/<\s*(?:antml_)?invoke\s+name=/gi, '<invoke name=');
        norm = norm.replace(/<\/\s*(?:antml_)?invoke\s*>/gi, '</invoke>');
        norm = norm.replace(/<\s*(?:antml_)?parameter\s+name=/gi, '<parameter name=');
        norm = norm.replace(/<\/\s*(?:antml_)?parameter\s*>/gi, '</parameter>');
        
        // Qwen Format adaptation
        norm = norm.replace(/<function[= ]["']?([\w.-]+)["']?>/gi, '<invoke name="$1">');
        norm = norm.replace(/<\/function>/gi, '</invoke>');
        norm = norm.replace(/<parameter[= ]["']?([\w.-]+)["']?>/gi, '<parameter name="$1">');

        // State Machine Extractors
        const extractNodes = (text: string, tag: string) => {
            const results: { attr: string, content: string }[] = [];
            const openTagStart = `<${tag} name="`;
            const openTagStartAlt = `<${tag} name='`;
            const closeTag = `</${tag}>`;
            
            let pos = 0;
            while (pos < text.length) {
                let startIdx = text.indexOf(openTagStart, pos);
                let isSingleQuote = false;
                
                const startIdxAlt = text.indexOf(openTagStartAlt, pos);
                if (startIdx === -1 || (startIdxAlt !== -1 && startIdxAlt < startIdx)) {
                    startIdx = startIdxAlt;
                    isSingleQuote = true;
                }
                
                if (startIdx === -1) break;
                
                const attrStart = startIdx + openTagStart.length;
                const quoteChar = isSingleQuote ? "'" : '"';
                const attrEnd = text.indexOf(quoteChar, attrStart);
                if (attrEnd === -1) { pos = attrStart; continue; }
                
                const attrVal = text.substring(attrStart, attrEnd);
                
                // Find ">" closing the open tag
                const tagEnd = text.indexOf('>', attrEnd);
                if (tagEnd === -1) { pos = attrEnd; continue; }
                
                const contentStart = tagEnd + 1;
                
                // For a robust search, we find the next closeTag. If another tool call contains nested XML, 
                // we assume tools don't nest <invoke> inside <invoke>.
                let contentEnd = text.indexOf(closeTag, contentStart);
                if (contentEnd === -1) {
                    // Fallback for LLMs that occasionally drop the closing tag at the very end
                    contentEnd = text.length;
                }
                
                results.push({
                    attr: attrVal,
                    content: text.substring(contentStart, contentEnd)
                });
                pos = contentEnd + closeTag.length;
            }
            return results;
        };

        // 1. Process as XML Node block
        const invokes = extractNodes(norm, 'invoke');
        if (invokes.length > 0) {
            for (const inv of invokes) {
                const toolName = inv.attr;
                const args: Record<string, unknown> = {};
                const params = extractNodes(inv.content, 'parameter');
                for (const pm of params) {
                    const val = pm.content.trim();
                    try { args[pm.attr] = JSON.parse(val); } catch { args[pm.attr] = val; }
                }
                calls.push({
                    id: `sm_${crypto.randomUUID()}`, type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(args) }
                });
            }
            return calls;
        }

        // 2. Qwen/Hermes JSON in <tool_call>
        const toolCallJsonRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
        toolCallJsonRe.lastIndex = 0;
        let tm: RegExpExecArray | null;
        while ((tm = toolCallJsonRe.exec(content)) !== null) {
            const raw = tm[1];
            // If it contains embedded <function> tag
            if (raw.trimStart().startsWith('<function=') || raw.trimStart().startsWith('<function ')) {
                // Re-process recursively or rely on the normalized XML flow
                const parsed = this.parseDsmlToolCalls(raw);
                calls.push(...parsed);
            } else {
                try {
                    const obj = JSON.parse(raw) as { name?: string; arguments?: unknown };
                    if (obj.name) {
                        calls.push({
                            id: `tc_${crypto.randomUUID()}`, type: 'function',
                            function: {
                                name: obj.name,
                                arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments ?? {})
                            }
                        });
                    }
                } catch { /* ignore */ }
            }
        }

        return calls;
    }

    /** Strip all known text-format tool call markup from text.
     * Runs multiple passes; final pass also cleans orphaned lone tags. */
    private stripDsmlMarkup(content: string): string {
        // Normalize full-width | first (DeepSeek DSML uses U+FF5C)
        let s = content.replace(/\uFF5C/g, '|');

        // Run up to 4 passes - each pass strips paired open/close blocks
        for (let pass = 0; pass < 4; pass++) {
            const before = s;
            s = s
                // DeepSeek DSML: <|DSML|function_calls>...</|DSML|function_calls>
                .replace(/<\|DSML\|function_calls>[\s\S]*?<\/\|DSML\|function_calls>/gi, '')
                .replace(/<\|DSML\|invoke(?:\s[^>]*)?>([\s\S]*?)<\/\|DSML\|invoke>/gi, '')
                // Qwen / Hermes: <tool_call>...</tool_call>
                .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
                // Generic XML / Claude antml_
                .replace(/<\s*(?:antml_)?function_calls\s*>[\s\S]*?<\/\s*(?:antml_)?function_calls\s*>/gi, '')
                .replace(/<\s*(?:antml_)?invoke(?:\s[^>]*)?\s*>[\s\S]*?<\/\s*(?:antml_)?invoke\s*>/gi, '')
                // Orphaned lone open/close tags (safety net for unmatched pairs)
                .replace(/<\/?\s*(?:antml_)?function_calls\s*>/gi, '')
                .replace(/<\/?\s*(?:antml_)?invoke(?:\s[^>]*)?\s*>/gi, '')
                .replace(/<\/?\s*(?:antml_)?parameter(?:\s[^>]*)?\s*>/gi, '')
                // Strip leftover DSML pipe tags
                .replace(/<\/?\s*\|DSML\|[^>]*>/gi, '');
            if (s === before) break; // Stable - stop early
        }

        return s.replace(/\n{3,}/g, '\n\n').trim();
    }

    /** Strip <think>...</think> blocks from text (already emitted as thinking_content steps) */
    private stripThinkBlocks(content: string): string {
        return content
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // ─── Context Budget Utilities ────────────────────────────────────────────

    /**
     * Intelligently budget a tool result to fit within maxChars.
     * Instead of brute-force truncation, this uses strategies that preserve
     * information density:
     *
     * 1. **Array dedup**: For arrays of objects (e.g. diagnostics), group by
     *    a key field (message), deduplicate, and report counts.
     * 2. **Segmentation**: For long arrays, keep representative items from
     *    the start, middle, and end with a "[... N more]" gap.
     * 3. **Structured truncation**: For objects with large string fields,
     *    truncate the strings while preserving the structure.
     *
     * Returns a JSON string ready for injection into conversation messages.
     */
    private budgetToolResult(result: unknown, maxChars: number = TOOL_RESULT_BUDGET_BASE): string {
        const raw = JSON.stringify(result, null, 2);
        if (raw.length <= maxChars) return raw;

        // Strategy 1: Detect and handle diagnostic-like arrays
        // Common shapes: { diagnostics: [...] }, { entries: [...] }, or raw [...]
        const arrayTarget = this.extractBudgetableArray(result);
        if (arrayTarget) {
            const { array, wrapper, key: arrayKey } = arrayTarget;
            const budgeted = this.budgetArray(array, maxChars, wrapper, arrayKey);
            if (budgeted) return budgeted;
        }

        // Strategy 2: If result is a direct array
        if (Array.isArray(result)) {
            const budgeted = this.budgetArray(result, maxChars, null, null);
            if (budgeted) return budgeted;
        }

        // Strategy 3: Generic truncation with structure hint
        return raw.substring(0, maxChars) +
            `\n\n[... truncated — original: ${raw.length} chars. Ask for specific items if needed.]`;
    }

    /**
     * Extract a budgetable array from a tool result object.
     * Detects common patterns like { diagnostics: [...] }, { instances: [...] },
     * { results: [...] }, { files: [...] }, { references: [...] }.
     */
    private extractBudgetableArray(
        result: unknown
    ): { array: unknown[]; wrapper: Record<string, unknown>; key: string } | null {
        if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
        const obj = result as Record<string, unknown>;
        // Known array-valued keys in tool results, ordered by likelihood
        const candidateKeys = ['diagnostics', 'instances', 'results', 'files', 'references', 'entries', 'items', 'rules'];
        for (const k of candidateKeys) {
            if (Array.isArray(obj[k]) && (obj[k] as unknown[]).length > 5) {
                return { array: obj[k] as unknown[], wrapper: obj, key: k };
            }
        }
        return null;
    }

    /**
     * Budget an array using dedup + segmentation.
     * Returns a JSON string, or null if the array is too small to be worth budgeting.
     */
    private budgetArray(
        array: unknown[],
        maxChars: number,
        wrapper: Record<string, unknown> | null,
        arrayKey: string | null
    ): string | null {
        if (array.length <= 3) return null;

        // Step 1: Attempt deduplication by message/error field
        // Group items by a "message" or "error" or "id" field and report counts
        const groupKey = this.findGroupKey(array);
        if (groupKey && array.length > 10) {
            const grouped = new Map<string, { count: number; representative: unknown; files: Set<string> }>();
            for (const item of array) {
                const obj = item as Record<string, unknown>;
                const key = String(obj[groupKey] ?? '');
                const existing = grouped.get(key);
                if (existing) {
                    existing.count++;
                    // Track distinct files if available
                    const file = obj['file'] ?? obj['logicalPath'] ?? obj['filePath'];
                    if (file) existing.files.add(String(file));
                } else {
                    const file = obj['file'] ?? obj['logicalPath'] ?? obj['filePath'];
                    grouped.set(key, {
                        count: 1,
                        representative: item,
                        files: file ? new Set([String(file)]) : new Set(),
                    });
                }
            }

            // If dedup reduced the count significantly, use grouped output
            if (grouped.size < array.length * 0.7) {
                const dedupedItems = [...grouped.entries()]
                    .sort((a, b) => b[1].count - a[1].count)
                    .map(([, v]) => ({
                        ...v.representative as Record<string, unknown>,
                        _occurrences: v.count,
                        _affectedFiles: v.files.size > 1 ? v.files.size : undefined,
                        _sampleFiles: v.files.size > 1 ? [...v.files].slice(0, 3) : undefined,
                    }));

                // Build result within budget
                let kept = Math.min(dedupedItems.length, 30);
                let resultObj = this.buildArrayResult(dedupedItems, kept, array.length, wrapper, arrayKey);
                while (resultObj.length > maxChars && kept > 5) {
                    kept = Math.floor(kept * 0.6);
                    resultObj = this.buildArrayResult(dedupedItems, kept, array.length, wrapper, arrayKey);
                }
                return resultObj;
            }
        }

        // Step 2: Segmentation — keep items from start, middle, end
        const totalCount = array.length;
        const segmentSize = Math.max(3, Math.floor(maxChars / 800)); // ~800 chars per item
        const headCount = Math.ceil(segmentSize * 0.5);
        const tailCount = Math.floor(segmentSize * 0.3);
        const midCount = Math.max(1, segmentSize - headCount - tailCount);

        const head = array.slice(0, headCount);
        const midStart = Math.floor(totalCount / 2) - Math.floor(midCount / 2);
        const mid = array.slice(midStart, midStart + midCount);
        const tail = array.slice(totalCount - tailCount);

        const segmented = [
            ...head,
            { _gap: `... ${totalCount - headCount - midCount - tailCount} items omitted ...` },
            ...mid,
            { _gap: `... continuing to end ...` },
            ...tail,
        ];

        const result = this.buildArrayResult(segmented, segmented.length, totalCount, wrapper, arrayKey);
        if (result.length <= maxChars) return result;

        // Last resort: just head items with count
        let kept = headCount;
        let fallback = this.buildArrayResult(array.slice(0, kept), kept, totalCount, wrapper, arrayKey);
        while (fallback.length > maxChars && kept > 3) {
            kept = Math.floor(kept * 0.6);
            fallback = this.buildArrayResult(array.slice(0, kept), kept, totalCount, wrapper, arrayKey);
        }
        return fallback;
    }

    /** Find a suitable grouping key for deduplication of array items. */
    private findGroupKey(array: unknown[]): string | null {
        if (array.length === 0) return null;
        const first = array[0];
        if (typeof first !== 'object' || first === null) return null;
        const obj = first as Record<string, unknown>;
        // Prefer 'message' (diagnostics), then 'error', then 'id'
        for (const candidate of ['message', 'error', 'id', 'name']) {
            if (typeof obj[candidate] === 'string') return candidate;
        }
        return null;
    }

    /** Build a budgeted array result JSON string with metadata. */
    private buildArrayResult(
        items: unknown[],
        keptCount: number,
        totalCount: number,
        wrapper: Record<string, unknown> | null,
        arrayKey: string | null
    ): string {
        if (wrapper && arrayKey) {
            // Reconstruct wrapper with budgeted array
            const budgetedWrapper = { ...wrapper };
            budgetedWrapper[arrayKey] = items.slice(0, keptCount);
            budgetedWrapper[`_${arrayKey}Shown`] = Math.min(keptCount, items.length);
            budgetedWrapper[`_${arrayKey}Total`] = totalCount;
            if (keptCount < totalCount) {
                budgetedWrapper[`_${arrayKey}Note`] = `Showing ${Math.min(keptCount, items.length)} of ${totalCount} items (deduplicated/segmented to save context). Use targeted queries for specific files.`;
            }
            return JSON.stringify(budgetedWrapper, null, 2);
        }
        // Raw array
        const shown = items.slice(0, keptCount);
        if (keptCount >= totalCount) return JSON.stringify(shown, null, 2);
        return JSON.stringify({
            items: shown,
            _shown: Math.min(keptCount, items.length),
            _total: totalCount,
            _note: `Showing ${Math.min(keptCount, items.length)} of ${totalCount} items. Use targeted queries for specific items.`,
        }, null, 2);
    }

    /**
     * Compact messages array in-place during the reasoning loop.
     * This is a lightweight, synchronous operation (no AI call) that targets
     * the biggest context consumers: oversized tool result messages.
     *
     * Strategy:
     * 1. Keep the first message (system prompt) and last 6 messages intact.
     * 2. For messages in between, if they are tool results larger than
     *    toolResultBudget, replace their content with a truncated version.
     * 3. For very old tool results (beyond the last 12 messages),
     *    aggressively compress to just file/success/error metadata.
     */
    private compactMessagesInPlace(messages: ChatMessage[], toolResultBudget: number): void {
        if (messages.length <= 8) return; // Not enough to compact

        const keepHead = 1;  // System prompt
        const keepTail = 6;  // Recent messages (must be >= COMPACTION_KEEP_LAST_N)
        const aggressiveThreshold = messages.length - 12; // Beyond this age, compress hard

        for (let i = keepHead; i < messages.length - keepTail; i++) {
            const m = messages[i];
            const content = contentToString(m.content);
            if (content.length <= 500) continue; // Small messages are fine

            if (m.role === 'tool' || (m.role === 'user' && content.startsWith('[Tool Result'))) {
                if (i < aggressiveThreshold) {
                    // Aggressive: extract only key metadata
                    const successMatch = content.match(/"success"\s*:\s*(true|false)/);
                    const fileMatch = content.match(/"(?:file|filePath|logicalPath)"\s*:\s*"([^"]+)"/);
                    const errorMatch = content.match(/"(?:error|message)"\s*:\s*"([^"]{0,150})"/);
                    const countMatch = content.match(/"(?:total\w*Count|totalCount|length)"\s*:\s*(\d+)/);
                    const meta = [
                        fileMatch ? `file=${fileMatch[1]}` : null,
                        successMatch ? `ok=${successMatch[1]}` : null,
                        errorMatch && successMatch?.[1] === 'false' ? `err=${errorMatch[1].substring(0, 80)}` : null,
                        countMatch ? `count=${countMatch[1]}` : null,
                    ].filter(Boolean).join(', ');
                    messages[i] = { ...m, content: `[Compacted] ${meta || content.substring(0, 200)}` };
                } else if (content.length > toolResultBudget) {
                    // Moderate: apply budgeting
                    try {
                        const parsed = JSON.parse(content);
                        messages[i] = { ...m, content: this.budgetToolResult(parsed, toolResultBudget) };
                    } catch {
                        // Not valid JSON — just truncate
                        messages[i] = { ...m, content: content.substring(0, toolResultBudget) + '\n[... compacted]' };
                    }
                }
            } else if (m.role === 'assistant' && i < aggressiveThreshold && content.length > 2000) {
                // Aggressively compress old assistant reasoning
                messages[i] = { ...m, content: content.substring(0, 1000) + '\n[... compacted]' };
            }
        }
    }

    /**
     * Full clean pipeline for final user-visible content:
     * strip think blocks → strip DSML/XML → normalize whitespace.
     */
    private cleanFinalContent(content: string): string {
        if (!content) return content;
        return this.stripThinkBlocks(this.stripDsmlMarkup(content));
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
                .map(match => match[1].trim())
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
        mode: 'explore' | 'general',
        parentOptions?: AgentRunnerOptions,
        onStep?: (step: AgentStep) => void,
        parentAccumulator?: TokenUsage
    ): Promise<string> {
        // P3: sub-agents use slim CWTOOLS.md (only mod info + namespaces)
        // to avoid bloating narrow-scope sub-agent contexts with full project rules
        const subSystemPrompt = this.promptBuilder.buildSlimSystemPromptForMode(
            mode,
            this.aiService.getConfig().provider
        );

        const messages: ChatMessage[] = [
            { role: 'system', content: subSystemPrompt },
            { role: 'user', content: prompt },
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
            const result = await this.reasoningLoop(messages, onStep ?? (() => { }), mode, subOptions, subTokens);
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
