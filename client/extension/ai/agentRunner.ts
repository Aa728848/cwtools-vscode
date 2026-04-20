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
} from './types';
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
    'get_diagnostics', 'query_references',
];

/** General mode: all tools EXCEPT todo_write (research without task tracking) */
const GENERAL_EXCLUDED_TOOLS: AgentToolName[] = ['todo_write'];

export class AgentRunner {
    constructor(
        private aiService: AIService,
        public readonly toolExecutor: AgentToolExecutor,
        private promptBuilder: PromptBuilder
    ) {}

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

        // Context compaction: if history is too long, summarize it
        const compactedHistory = await this.maybeCompactHistory(
            conversationHistory, emitStep, options
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
            const finalMessage = await this.reasoningLoop(messages, emitStep, mode, options);

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
        options?: AgentRunnerOptions
    ): Promise<ChatMessage[]> {
        if (history.length < 4) return history; // too short to compact

        // Estimate total token usage
        const totalChars = history.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
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
            const recentCount = Math.min(4, history.length);
            const olderMessages = history.slice(0, history.length - recentCount);
            const recentMessages = history.slice(history.length - recentCount);

            // Build compaction prompt
            const summaryText = olderMessages.map(m => {
                const role = m.role === 'user' ? 'User' : 'Assistant';
                const content = (m.content ?? '').substring(0, 500);
                return `[${role}]: ${content}`;
            }).join('\n');

            const compactionMessages: ChatMessage[] = [
                {
                    role: 'system',
                    content: 'You are a conversation summarizer. Summarize the following conversation into a concise, information-dense summary. Preserve: key decisions, code snippets mentioned, file paths, identifiers, error messages, and any important context. Output ONLY the summary, no preamble.',
                },
                {
                    role: 'user',
                    content: `Summarize this conversation:\n\n${summaryText}`,
                },
            ];

            const compactionResponse = await this.aiService.chatCompletion(compactionMessages, {
                temperature: 0.1,
                maxTokens: 2048,
                providerId: options?.providerId,
                model: options?.model,
            });

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
     */
    private async reasoningLoop(
        messages: ChatMessage[],
        emitStep: (step: AgentStep) => void,
        mode: AgentMode,
        options?: AgentRunnerOptions
    ): Promise<string> {
        let iteration = 0;
        // Doom loop detection: sliding window of call signatures
        const recentCallSignatures: string[] = [];
        let consecutiveErrorCount = 0;
        // Track files confirmed-written this session — prevents duplicate confirm cards
        // if the AI calls write_file after edit_file for the same file (cross-iteration)
        const confirmedWrittenFiles = new Set<string>();
        // Track permanently allowed tool calls (OpenCode 'always' permission)
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

        while (iteration < MAX_TOOL_ITERATIONS) {
            options?.abortSignal?.throwIfAborted();
            iteration++;

            const response = await this.aiService.chatCompletion(messages, {
                tools: availableTools,
                providerId: options?.providerId,
                model: options?.model,
            });

            const choice = response.choices[0];
            if (!choice) throw new Error('No response from AI');

            const assistantMessage = choice.message;
            // Save raw content for DSML parsing BEFORE stripping markup
            const rawContent = assistantMessage.content ?? '';

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
                    this.stripDsmlMarkup(assistantMessage.content)
                );
            }

            // Add assistant response (cleaned) to conversation history
            messages.push(assistantMessage);

            // If no tool calls (either format), we're done
            if (!toolCalls || toolCalls.length === 0) {
                return this.cleanFinalContent(assistantMessage.content ?? '');
            }

            // ── Doom loop detection (OpenCode DOOM_LOOP_THRESHOLD) ─────────────
            // Track a sliding window of the last DOOM_LOOP_THRESHOLD call signatures.
            // If they are all identical, the agent is stuck in a loop.
            const callSignature = toolCalls.map(tc => `${tc.function.name}:${tc.function.arguments}`).join('|');
            recentCallSignatures.push(callSignature);
            if (recentCallSignatures.length > DOOM_LOOP_THRESHOLD) {
                recentCallSignatures.shift();
            }
            const allSame = recentCallSignatures.length >= DOOM_LOOP_THRESHOLD &&
                recentCallSignatures.every(s => s === recentCallSignatures[0]);
            if (allSame) {
                emitStep({
                    type: 'error',
                    content: '检测到循环工具调用，已强制停止',
                    timestamp: Date.now(),
                });
                break;
            }

            // ── Deduplicate file-write calls ──────────────────────────────────
            // If the model emitted multiple write_file/edit_file calls targeting
            // the same file in one response, only keep the LAST one for each file.
            const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
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

            // Execute tool calls
            for (const toolCall of toolCalls) {
                options?.abortSignal?.throwIfAborted();

                const toolName = toolCall.function.name as AgentToolName;
                let toolArgs: Record<string, unknown>;
                try {
                    toolArgs = JSON.parse(toolCall.function.arguments);
                } catch {
                    toolArgs = {};
                }

                emitStep({
                    type: 'tool_call',
                    content: `调用工具: ${toolName}`,
                    toolName,
                    toolArgs,
                    timestamp: Date.now(),
                });

                let toolResult: unknown;
                try {
                    // Skip duplicate write calls: if a later call writes to the same file, skip this one
                    const callIndex = toolCalls.indexOf(toolCall);
                    const filePath = (toolArgs['filePath'] as string) ?? (toolArgs['file'] as string) ?? '';
                    const isSupersededWrite = WRITE_TOOLS.has(toolName) && filePath &&
                        lastWriteIndexByFile.get(filePath) !== callIndex;

                    if (isSupersededWrite) {
                        // Silently skip — the later write for this file takes precedence
                        toolResult = { skipped: true, message: `已被后续对 ${filePath} 的写入操作覆盖，跳过本次写入` };
                    } else if (WRITE_TOOLS.has(toolName) && filePath && confirmedWrittenFiles.has(filePath)) {
                        // File was already written-and-confirmed in a PREVIOUS iteration:
                        // apply this write silently (treat as auto mode) to avoid a second confirm card
                        const origArgs = { ...toolArgs, _autoApply: true };
                        toolResult = await this.toolExecutor.execute(toolName, origArgs);
                    } else {
                        toolResult = await this.toolExecutor.execute(toolName, toolArgs);
                        // Mark file as confirmed-written so future iterations skip the confirm card
                        if (WRITE_TOOLS.has(toolName) && filePath) {
                            const r = toolResult as Record<string, unknown>;
                            if (r && (r.success || r.confirmed)) {
                                confirmedWrittenFiles.add(filePath);
                            }
                        }
                    }
                } catch (e) {
                    toolResult = { error: e instanceof Error ? e.message : String(e) };
                }

                emitStep({
                    type: 'tool_result',
                    content: `工具结果: ${toolName}`,
                    toolName,
                    toolResult,
                    timestamp: Date.now(),
                });

                // Track consecutive tool errors for early abort
                if (typeof toolResult === 'object' && toolResult !== null &&
                    'error' in toolResult && !('success' in toolResult)) {
                    consecutiveErrorCount++;
                    if (consecutiveErrorCount >= 5) {
                        emitStep({
                            type: 'error',
                            content: '工具连续失败 5 次，已强制停止',
                            timestamp: Date.now(),
                        });
                        break;
                    }
                } else {
                    consecutiveErrorCount = 0;
                }

                // Feed tool result back to AI
                // DeepSeek and some models in DSML mode require tool results as user messages
                // Check if provider uses DSML-style (tool role not well supported)
                const { getProvider } = await import('./providers');
                const config = this.aiService.getConfig();
                const providerId = options?.providerId ?? config.provider;
                const providerDef = getProvider(providerId);
                const useDsmlToolRole = providerDef.toolCallStyle === 'dsml';

                if (useDsmlToolRole) {
                    // DeepSeek DSML mode: wrap tool result as a user message
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
        }

        // Max iterations reached — try to get a final response without tools
        const finalResponse = await this.aiService.chatCompletion(messages, {
            providerId: options?.providerId,
            model: options?.model,
        });

        const finalContent = finalResponse.choices[0]?.message?.content ?? '';
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
                calls.push({ id: `dsml_${Date.now()}_${callIndex++}`, type: 'function',
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
                        calls.push({ id: `tc_${Date.now()}_${callIndex++}`, type: 'function',
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
                calls.push({ id: `gen_${Date.now()}_${callIndex++}`, type: 'function',
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
            calls.push({ id: `qc_${Date.now()}_${startIndex++}`, type: 'function',
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

                const retryContent = retryResponse.choices[0]?.message?.content ?? '';
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

        // Try fenced code blocks (```pdx, ```paradox, ```)
        const fencePatterns = [
            /```(?:pdx|paradox|stellaris|txt)?\s*\n([\s\S]*?)```/g,
            /```\s*\n([\s\S]*?)```/g,
        ];

        for (const pattern of fencePatterns) {
            const matches: RegExpExecArray[] = [];
            let m: RegExpExecArray | null;
            while ((m = pattern.exec(text)) !== null) {
                matches.push(m);
            }
            if (matches.length > 0) {
                // Return the largest code block
                return matches
                    .map(m => m[1].trim())
                    .sort((a, b) => b.length - a.length)[0] || null;
            }
        }

        // If the entire response looks like code (no markdown), return it
        const lines = text.split('\n');
        const codeLines = lines.filter(l => {
            const trimmed = l.trim();
            return trimmed.length > 0 &&
                !trimmed.startsWith('#') &&
                (trimmed.includes('=') || trimmed === '{' || trimmed === '}' ||
                 trimmed.startsWith('if') || trimmed.startsWith('else') ||
                 /^\w/.test(trimmed));
        });

        if (codeLines.length > lines.length * 0.6) {
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

            const raw = (response.choices[0]?.message?.content ?? '').trim();
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
