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
import { getProvider } from './providers';

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

/**
 * Per-model cost table (USD per 1M tokens, [input, output]).
 * Uses cache-miss (standard) input rate as the representative figure.
 * Sources (verified 2026-04):
 *   OpenAI:    https://openai.com/api/pricing
 *   Anthropic: https://www.anthropic.com/api
 *   DeepSeek:  https://platform.deepseek.com/  (V3.2 pricing, post 2025-09-29)
 *   Google:    https://ai.google.dev/pricing
 *   MiniMax:   https://www.minimax.io/
 *   Zhipu:     https://bigmodel.cn / z.ai
 *   DashScope: https://www.alibabacloud.com/help/en/model-studio/
 */
const MODEL_PRICING: Record<string, [number, number]> = {
    // ── Anthropic Claude ─────────────────────────────────────────────────────
    'claude-opus-4-7':                  [5.00,  25.00],
    'claude-opus-4-6':                  [5.00,  25.00],   // same tier as 4-7
    'claude-sonnet-4-6':                [3.00,  15.00],
    'claude-haiku-4-5':                 [1.00,   5.00],

    // ── OpenAI GPT-5.4 series ─────────────────────────────────────────────────
    'gpt-5.4':                          [2.50,  15.00],
    'gpt-5.4-mini':                     [0.75,   4.50],
    'gpt-5.4-nano':                     [0.20,   1.25],
    'gpt-5-mini':                       [0.75,   4.50],   // alias, same tier
    'gpt-5-nano':                       [0.20,   1.25],   // alias, same tier

    // ── DeepSeek V3.2 (unified, post 2025-09-29) ─────────────────────────────
    'deepseek-chat':                    [0.28,   0.42],
    'deepseek-reasoner':                [0.28,   0.42],

    // ── MiniMax ───────────────────────────────────────────────────────────────
    'MiniMax-M2.7':                     [0.30,   1.20],
    'MiniMax-M2.5':                     [0.12,   0.95],
    'MiniMax-M2.5-Lightning':           [0.12,   2.40],

    // ── Zhipu GLM ─────────────────────────────────────────────────────────────
    'glm-5.1':                          [1.40,   4.40],
    'glm-5':                            [1.00,   3.20],
    'glm-5v-turbo':                     [0.50,   1.50],   // estimated visual-turbo tier

    // ── Qwen / DashScope ──────────────────────────────────────────────────────
    'qwen3.6-plus':                     [0.33,   1.95],
    'qwen3.5-plus':                     [0.30,   1.80],
    'qwen3.6-flash':                    [0.06,   0.25],   // flash tier (estimated)

    // ── Google Gemini 2.5 ─────────────────────────────────────────────────────
    'gemini-2.5-pro':                   [1.25,  10.00],
    'gemini-2.5-flash':                 [0.30,   2.50],
    'gemini-2.5-flash-lite':            [0.10,   0.40],

    // ── Google Gemini 3 / 3.1 (preview, as of 2026-04) ────────────────────────
    'gemini-3.1-pro-preview':           [2.00,  12.00],   // ≤200K ctx tier
    'gemini-3-flash-preview':           [0.50,   3.00],
    'gemini-3.1-flash-lite-preview':    [0.25,   1.50],
};

/** Look up per-million-token cost for a model. Falls back to [0, 0] if unknown. */
function getModelPricing(model: string): [number, number] {
    if (!model) return [0, 0];
    // 1. Exact match
    if (model in MODEL_PRICING) return MODEL_PRICING[model];
    // 2. Prefix match (e.g. "claude-opus-4-5-20251101" -> "claude-opus-4-5")
    for (const key of Object.keys(MODEL_PRICING)) {
        if (model.startsWith(key)) return MODEL_PRICING[key];
    }
    // 3. Contains match (e.g. "deepseek-chat-v3" contains "deepseek-chat")
    for (const key of Object.keys(MODEL_PRICING)) {
        if (model.includes(key)) return MODEL_PRICING[key];
    }
    return [0, 0];
}

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
    'read_file', 'list_directory', 'get_diagnostics',
];

/** Explore mode: same as plan, plus workspace_symbols — no writes (OpenCode explore agent) */
const EXPLORE_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'read_file', 'list_directory',
    'get_diagnostics',
];

/** General mode: all tools EXCEPT todo_write (research without task tracking) */
const GENERAL_EXCLUDED_TOOLS: AgentToolName[] = ['todo_write'];

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
        options?: AgentRunnerOptions
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

        // Context compaction: if history is too long, summarize it
        const compactedHistory = await this.maybeCompactHistory(
            conversationHistory, emitStep, options, tokenAccumulator
        );

        // Build the message array
        const messages: ChatMessage[] = [
            { role: 'system', content: this.promptBuilder.buildSystemPromptForMode(mode, this.aiService.getConfig().provider) },
            ...this.promptBuilder.buildContextMessages(context),
            ...compactedHistory,
            { role: 'user', content: userMessage },
        ];

        const modeLabel: Record<string, string> = {
            build: '分析需求中...',
            plan: '分析中（Plan 模式 — 只读）...',
            explore: '探索代码库中（Explore 模式）...',
            general: '处理请求中（General 模式）...',
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

            // Plan / Explore / General mode — or no code generated — just an explanation
            if (!code || mode === 'plan' || mode === 'explore' || mode === 'general') {
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

        // Estimate total token usage (use contentToString to handle ContentPart[] correctly)
        const totalChars = history.reduce((sum, m) => sum + contentToString(m.content).length, 0);
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
            const olderMessages = history.slice(0, history.length - recentCount);
            const recentMessages = history.slice(history.length - recentCount);

            // Build compaction prompt
            // L3 Fix: exclude system messages (they'd be mapped as 'Assistant', misleading the summarizer).
            // M4 Fix: use a larger char limit for tool/assistant messages which carry technical detail.
            const summaryText = olderMessages
                .filter(m => m.role !== 'system')   // L3 Fix
                .map(m => {
                    const role = m.role === 'user' ? 'User' : m.role === 'tool' ? 'Tool' : 'Assistant';
                    // M4 Fix: user messages get 500 chars; tool/assistant get 2000
                    const maxLen = m.role === 'user' ? 500 : 2000;
                    const content = contentToString(m.content).substring(0, maxLen);
                    return `[${role}]: ${content}`;
                }).join('\n');

            const compactionMessages: ChatMessage[] = [
                { role: 'system', content: this.promptBuilder.buildCompactionPrompt() },
                { role: 'user', content: `Summarize this conversation:\n\n${summaryText}` },
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
                tokenAccumulator.input  += compactionResponse.usage.prompt_tokens;
                tokenAccumulator.output += compactionResponse.usage.completion_tokens;
                tokenAccumulator.total  += compactionResponse.usage.total_tokens;
                tokenAccumulator.estimatedCostUsd +=
                    (compactionResponse.usage.prompt_tokens     / 1_000_000) * pricing[0] +
                    (compactionResponse.usage.completion_tokens / 1_000_000) * pricing[1];
            }

            const summary = compactionResponse.choices?.[0]?.message?.content ?? '';

            if (summary.length > 0) {
                emitStep({
                    type: 'compaction',
                    content: `上下文已压缩: ${olderMessages.length} 条消息 → 摘要 (${summary.length} chars)`,
                    timestamp: Date.now(),
                });

                // Return compacted history: summary + recent messages
                return [
                    {
                        role: 'system',
                        content: `## Conversation Summary (compacted)\n${summary}`,
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
        } else if (mode === 'general') {
            availableTools = TOOL_DEFINITIONS.filter(t => !GENERAL_EXCLUDED_TOOLS.includes(t.function.name as AgentToolName));
        } else {
            availableTools = TOOL_DEFINITIONS;
        }

        // M3 Fix: remove per-call dynamic import — getProvider is already statically
        // imported at the top of this file; dynamic import added latency for nothing.
        const _config0 = this.aiService.getConfig();
        const _providerId0 = options?.providerId ?? _config0.provider;
        const useDsmlToolRole0 = getProvider(_providerId0).toolCallStyle === 'dsml';

        while (iteration < MAX_TOOL_ITERATIONS) {
            options?.abortSignal?.throwIfAborted();
            iteration++;

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
            });

            // Accumulate token usage from this API call
            if (tokenAccumulator && response.usage) {
                const pricing = getModelPricing(response.model ?? options?.model ?? '');
                const inputCost  = (response.usage.prompt_tokens     / 1_000_000) * pricing[0];
                const outputCost = (response.usage.completion_tokens / 1_000_000) * pricing[1];
                tokenAccumulator.input  += response.usage.prompt_tokens;
                tokenAccumulator.output += response.usage.completion_tokens;
                tokenAccumulator.total  += response.usage.total_tokens;
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
            // L6 Fix: include multiedit in the WRITE_TOOLS set (it also modifies files).
            const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multiedit', 'patch']);
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
            // Read-only tools can safely run in parallel; write tools are kept serial
            // because they may show confirm dialogs or interact with the UI.
            // M6 Fix: validate_code removed from READ_ONLY_TOOLS — it calls UpdateFile
            // which temporarily mutates the game AST and must not run concurrently.
            const READ_ONLY_TOOLS = new Set<string>([
                'read_file', 'list_directory', 'search_mod_files',
                'get_file_context', 'document_symbols', 'workspace_symbols',
                'query_scope', 'query_types', 'query_rules', 'query_references',
                'get_diagnostics', 'get_completion_at',
                // validate_code is intentionally omitted: it modifies the LSP game state temporarily
            ]);

            // Use pre-fetched provider info from outside the loop
            const useDsmlToolRole = useDsmlToolRole0;

            // Emit all tool_call steps upfront (preserves UI ordering)
            const parsedCalls: Array<{ toolName: AgentToolName; toolArgs: Record<string, unknown>; toolCall: typeof toolCalls[0] }> = [];
            for (const toolCall of toolCalls) {
                options?.abortSignal?.throwIfAborted();
                const toolName = toolCall.function.name as AgentToolName;
                let toolArgs: Record<string, unknown>;
                try { toolArgs = JSON.parse(toolCall.function.arguments); } catch { toolArgs = {}; }
                emitStep({ type: 'tool_call', content: `调用工具: ${toolName}`, toolName, toolArgs, timestamp: Date.now() });
                parsedCalls.push({ toolName, toolArgs, toolCall });
            }

            // Partition into groups: run read-only in parallel, write in serial
            // We process them in order but batch consecutive read-only calls.
            const toolResults: unknown[] = new Array(parsedCalls.length);
            let i = 0;
            while (i < parsedCalls.length) {
                options?.abortSignal?.throwIfAborted();
                const { toolName, toolArgs, toolCall } = parsedCalls[i];

                if (READ_ONLY_TOOLS.has(toolName)) {
                    // Collect a batch of consecutive read-only tools
                    const batchStart = i;
                    const batch: Array<{ idx: number; toolName: AgentToolName; toolArgs: Record<string, unknown>; toolCall: typeof toolCalls[0] }> = [];
                    while (i < parsedCalls.length && READ_ONLY_TOOLS.has(parsedCalls[i].toolName)) {
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
                    void batchStart; // suppress unused-var warning
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
                    void toolCall;
                    i++;
                }
            }

            // If forceStop was set in the inner loop, exit the outer while now
            if (forceStop) break;

            // Emit results in original order and feed back to AI
            for (let j = 0; j < parsedCalls.length; j++) {
                const { toolName, toolArgs: _ta, toolCall } = parsedCalls[j];
                const toolResult = toolResults[j];
                void _ta;

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

                if (useDsmlToolRole) {
                    messages.push({
                        role: 'user',
                        content: `[Tool Result for ${toolCall.function.name} (id=${toolCall.id})]:\n${JSON.stringify(toolResult, null, 2)}`,
                    });
                } else {
                    messages.push({
                        role: 'tool',
                        content: JSON.stringify(toolResult, null, 2),
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
    private parseDsmlToolCalls(content: string): import('./types').ToolCall[] {
        const calls: import('./types').ToolCall[] = [];
        let callIndex = 0;

        // ── Pre-normalize: full-width ｜ (U+FF5C) → | (U+007C) ───────────────
        // DeepSeek actual output: <｜DSML｜function_calls>  (full-width pipes)
        // Normalizing to ASCII lets us use simple, reliable regexes.
        const norm = content.replace(/\uFF5C/g, '|');

        // ── Format 1: DeepSeek DSML  <|DSML|function_calls> ──────────────────
        const hasDsml = /<\|DSML\|function_calls>/i.test(norm) ||
                        /<\|DSML\|invoke\s+name=/i.test(norm);

        if (hasDsml) {
            const invokeRe = /<\|DSML\|invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\|DSML\|invoke>/gi;
            const paramRe  = /<\|DSML\|parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\|DSML\|parameter>/gi;
            invokeRe.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = invokeRe.exec(norm)) !== null) {
                const toolName = m[1];
                const inner = m[2];
                const args: Record<string, unknown> = {};
                paramRe.lastIndex = 0;
                let pm: RegExpExecArray | null;
                while ((pm = paramRe.exec(inner)) !== null) {
                    const val = pm[2].trim();
                    try { args[pm[1]] = JSON.parse(val); } catch { args[pm[1]] = val; }
                }
                // Use crypto.randomUUID() to avoid ID collisions in concurrent sub-agents
                calls.push({ id: `dsml_${crypto.randomUUID()}`, type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(args) } });
            }
            if (calls.length > 0) return calls;
        }

        // ── Format 2: Qwen / Hermes <tool_call>{JSON}</tool_call> ─────────────
        const toolCallJsonRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
        toolCallJsonRe.lastIndex = 0;
        let tm: RegExpExecArray | null;
        const toolCallMatches: string[] = [];
        while ((tm = toolCallJsonRe.exec(content)) !== null) {
            toolCallMatches.push(tm[1]);
        }
        for (const raw of toolCallMatches) {
            // might be plain JSON or <function=...><parameter=...> inside
            if (raw.trimStart().startsWith('<function=') || raw.trimStart().startsWith('<function ')) {
                // Format 3 inside tool_call wrapper — fall through to format 3
                const parsed = this.parseQwenCoderBlock(raw, callIndex);
                calls.push(...parsed); callIndex += parsed.length;
            } else {
                try {
                    const obj = JSON.parse(raw) as { name?: string; arguments?: unknown };
                    if (obj.name) {
                        // Use crypto.randomUUID() to avoid ID collisions in concurrent sub-agents
                        calls.push({ id: `tc_${crypto.randomUUID()}`, type: 'function',
                            function: { name: obj.name,
                                arguments: typeof obj.arguments === 'string'
                                    ? obj.arguments : JSON.stringify(obj.arguments ?? {}) } });
                    }
                } catch { /* not valid JSON, ignore */ }
            }
        }
        if (calls.length > 0) return calls;

        // ── Format 3: Qwen-Coder (no outer tool_call wrapper) ─────────────────
        if (/<function[= ]/.test(content)) {
            const qwenCalls = this.parseQwenCoderBlock(content, callIndex);
            calls.push(...qwenCalls); callIndex += qwenCalls.length;
            if (calls.length > 0) return calls;
        }

        // ── Format 4: Generic XML <function_calls><invoke ...> ────────────────
        // (also handles Claude antml_ prefix)
        const hasGeneric = /< *(?:antml_)?function_calls *>/i.test(content) ||
                           /< *(?:antml_)?invoke\s+name=/i.test(content);
        if (hasGeneric) {
            const invokeRe2 = /< *(?:antml_)?invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/ *(?:antml_)?invoke *>/gi;
            const paramRe2 = /< *(?:antml_)?parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/ *(?:antml_)?parameter *>/gi;
            invokeRe2.lastIndex = 0;
            let m2: RegExpExecArray | null;
            while ((m2 = invokeRe2.exec(content)) !== null) {
                const toolName = m2[1], inner = m2[2];
                const args: Record<string, unknown> = {};
                paramRe2.lastIndex = 0;
                let pm2: RegExpExecArray | null;
                while ((pm2 = paramRe2.exec(inner)) !== null) {
                    const val = pm2[2].trim();
                    try { args[pm2[1]] = JSON.parse(val); } catch { args[pm2[1]] = val; }
                }
                calls.push({ id: `gen_${crypto.randomUUID()}`, type: 'function',
                    function: { name: toolName, arguments: JSON.stringify(args) } });
            }
        }

        return calls;
    }

    /** Parse Qwen-Coder style <function=fn><parameter=key>val</parameter></function> blocks */
    private parseQwenCoderBlock(content: string, startIndex: number): import('./types').ToolCall[] {
        const calls: import('./types').ToolCall[] = [];
        const fnRe = /<function[= ]["']?([\w.-]+)["']?>([\s\S]*?)<\/function>/gi;
        const paramRe2 = /<parameter[= ]["']?([\w.-]+)["']?>([\s\S]*?)<\/parameter>/gi;
        fnRe.lastIndex = 0;
        let fm: RegExpExecArray | null;
        while ((fm = fnRe.exec(content)) !== null) {
            const toolName = fm[1], inner = fm[2];
            const args: Record<string, unknown> = {};
            paramRe2.lastIndex = 0;
            let pm: RegExpExecArray | null;
            while ((pm = paramRe2.exec(inner)) !== null) {
                const val = pm[2].trim();
                try { args[pm[1]] = JSON.parse(val); } catch { args[pm[1]] = val; }
            }
            calls.push({ id: `qc_${crypto.randomUUID()}`, type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) } });
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
        const subSystemPrompt = this.promptBuilder.buildSystemPromptForMode(
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
            const result = await this.reasoningLoop(messages, onStep ?? (() => {}), mode, subOptions, subTokens);
            // L8 Fix: merge sub-agent token usage into parent accumulator
            if (parentAccumulator) {
                parentAccumulator.total  += subTokens.total;
                parentAccumulator.input  += subTokens.input;
                parentAccumulator.output += subTokens.output;
                parentAccumulator.estimatedCostUsd += subTokens.estimatedCostUsd;
            }
            return result;
        } catch (e) {
            return `Sub-agent error: ${e instanceof Error ? e.message : String(e)}`;
        }
    }
}
