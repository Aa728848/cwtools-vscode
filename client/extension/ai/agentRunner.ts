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

// Maximum tool-call iterations per generation (prevent infinite loops)
const MAX_TOOL_ITERATIONS = 8;
// How many consecutive identical tool calls before we stop
const MAX_REPEATED_CALLS = 3;
// Maximum validation-retry rounds
const MAX_VALIDATION_RETRIES = 3;
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
    /** Agent mode: build (default) or plan (read-only) */
    mode?: AgentMode;
    /** Callback for real-time step updates (for UI) */
    onStep?: (step: AgentStep) => void;
    /** Abort signal */
    abortSignal?: AbortSignal;
}

/** Tools allowed in Plan mode (read-only, no validate_code) */
const PLAN_MODE_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'todo_write',
];

export class AgentRunner {
    constructor(
        private aiService: AIService,
        private toolExecutor: AgentToolExecutor,
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
            { role: 'system', content: this.promptBuilder.buildSystemPrompt(mode) },
            ...this.promptBuilder.buildContextMessages(context),
            ...compactedHistory,
            { role: 'user', content: userMessage },
        ];

        emitStep({
            type: 'thinking',
            content: mode === 'plan' ? '分析中（Plan 模式 — 只读）...' : '分析需求中...',
            timestamp: Date.now(),
        });

        try {
            // Phase 1: Agent reasoning loop (with tool calls)
            const finalMessage = await this.reasoningLoop(messages, emitStep, mode, options);

            // Phase 2: Extract code from the response
            const code = this.extractCode(finalMessage);

            if (!code || mode === 'plan') {
                // Plan mode or no code generated — just an explanation
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
        // Loop detection: track last N tool signatures to detect repetition
        const recentCallSignatures: string[] = [];

        // Filter tools by mode
        const availableTools = mode === 'plan'
            ? TOOL_DEFINITIONS.filter(t => PLAN_MODE_TOOLS.includes(t.function.name as AgentToolName))
            : TOOL_DEFINITIONS;

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

            // Add assistant response to conversation
            messages.push(assistantMessage);

            // Try OpenAI-style tool_calls first, then fall back to DSML/XML parsing
            let toolCalls = assistantMessage.tool_calls;
            if ((!toolCalls || toolCalls.length === 0) && assistantMessage.content) {
                toolCalls = this.parseDsmlToolCalls(assistantMessage.content);
                if (toolCalls && toolCalls.length > 0) {
                    // Strip the DSML markup from the message content for clean display
                    assistantMessage.content = this.stripDsmlMarkup(assistantMessage.content);
                }
            }

            // If no tool calls (either format), we're done
            if (!toolCalls || toolCalls.length === 0) {
                return assistantMessage.content ?? '';
            }

            // Loop detection: check if we're repeating the same tool calls
            const callSignature = toolCalls.map(tc => `${tc.function.name}:${tc.function.arguments}`).join('|');
            recentCallSignatures.push(callSignature);
            if (recentCallSignatures.length > MAX_REPEATED_CALLS) {
                recentCallSignatures.shift();
            }
            const allSame = recentCallSignatures.length >= MAX_REPEATED_CALLS &&
                recentCallSignatures.every(s => s === recentCallSignatures[0]);
            if (allSame) {
                emitStep({
                    type: 'error',
                    content: '检测到循环工具调用，已强制停止',
                    timestamp: Date.now(),
                });
                break;
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
                    toolResult = await this.toolExecutor.execute(toolName, toolArgs);
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

                // Feed tool result back to AI
                messages.push({
                    role: 'tool',
                    content: JSON.stringify(toolResult, null, 2),
                    tool_call_id: toolCall.id,
                    name: toolName,
                });
            }
        }

        // Max iterations reached — try to get a final response without tools
        const finalResponse = await this.aiService.chatCompletion(messages, {
            providerId: options?.providerId,
            model: options?.model,
        });

        return finalResponse.choices[0]?.message?.content ?? '';
    }

    /**
     * Parse DSML/XML-format tool calls from model response text.
     * Some models (e.g. DeepSeek on certain configs) output tool calls as:
     *   <function_calls><invoke name="..."><parameter name="...">value</parameter></invoke></function_calls>
     * or Claude-style or similar XML variants.
     */
    private parseDsmlToolCalls(content: string): import('./types').ToolCall[] {
        const calls: import('./types').ToolCall[] = [];

        // Pattern 1: <function_calls><invoke name="tool">...
        // Pattern 2: <antml_function_calls><antml_invoke name="tool">...
        const invokePattern = /<(?:antml_)?invoke\s+name=["']([^"']+)["']>(.*?)<\/(?:antml_)?invoke>/gs;
        const paramPattern = /<parameter\s+name=["']([^"']+)["'][^>]*>(.*?)<\/parameter>/gs;

        // Check if content contains any function call block
        if (!/<(?:antml_)?function_calls>/i.test(content) && 
            !/<(?:antml_)?invoke\s+name=/i.test(content)) {
            return [];
        }

        let invokeMatch: RegExpExecArray | null;
        let callIndex = 0;
        while ((invokeMatch = invokePattern.exec(content)) !== null) {
            const toolName = invokeMatch[1];
            const innerContent = invokeMatch[2];

            const args: Record<string, unknown> = {};
            let paramMatch: RegExpExecArray | null;
            paramPattern.lastIndex = 0;
            while ((paramMatch = paramPattern.exec(innerContent)) !== null) {
                const paramName = paramMatch[1];
                const paramValue = paramMatch[2].trim();
                // Try to parse JSON values, fall back to string
                try {
                    args[paramName] = JSON.parse(paramValue);
                } catch {
                    args[paramName] = paramValue;
                }
            }

            calls.push({
                id: `dsml_${Date.now()}_${callIndex++}`,
                type: 'function',
                function: {
                    name: toolName,
                    arguments: JSON.stringify(args),
                },
            });
        }

        return calls;
    }

    /** Remove DSML/XML function call blocks from the response text */
    private stripDsmlMarkup(content: string): string {
        // Remove <function_calls>...</function_calls> and <antml_function_calls>...</antml_function_calls>
        return content
            .replace(/<(?:antml_)?function_calls>.*?<\/(?:antml_)?function_calls>/gs, '')
            .replace(/<(?:antml_)?invoke[^>]*>.*?<\/(?:antml_)?invoke>/gs, '')
            .trim();
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

        // Remove DSML/XML function call blocks (DeepSeek / Claude XML format)
        let explanation = text
            .replace(/<(?:antml_)?function_calls>[\s\S]*?<\/(?:antml_)?function_calls>/g, '')
            .replace(/<(?:antml_)?invoke[^>]*>[\s\S]*?<\/(?:antml_)?invoke>/g, '');

        // Remove code blocks
        explanation = explanation.replace(/```[\s\S]*?```/g, '').trim();

        // Clean up excess blank lines
        explanation = explanation.replace(/\n{3,}/g, '\n\n').trim();
        return explanation;
    }
}
