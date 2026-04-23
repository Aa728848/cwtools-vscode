/**
 * CWTools AI Module — Inline Completion Provider
 *
 * Provides AI-powered inline code completion for PDXScript files.
 * Uses a lightweight prompt (no tool calls) for fast response times.
 * Supports independent model/provider configuration from the chat panel.
 *
 * Performance optimizations:
 *   - 150ms timeout on LSP completion to avoid blocking
 *   - LRU cache (capacity 10, 5s TTL) for identical contexts
 *   - Local fast-path: ≤5 LSP results on simple kv lines skip AI call
 *   - AbortController for clean request cancellation
 *   - Thinking/reasoning models are blocked (too slow for inline)
 *   - Context window limited to ±30 lines around cursor
 */

import * as vs from 'vscode';
import type { ChatCompletionResponse } from './types';
import { AIService } from './aiService';
import { PromptBuilder } from './promptBuilder';
import { getProvider, getEffectiveModel, ALWAYS_THINKING_PREFIXES } from './providers';

// ─── Thinking-model detection ────────────────────────────────────────────────

// Fix #4: Use shared ALWAYS_THINKING_PREFIXES from providers.ts (single source of truth)
const THINKING_MODEL_PREFIXES = ALWAYS_THINKING_PREFIXES;

/**
 * Models that support thinking but can disable it via API parameters.
 * For these, we pass disableThinking=true to aiService.chatCompletion().
 *
 * API methods per provider:
 *   - Claude: don't send `thinking` param (default = no thinking)
 *   - Qwen3+: `enable_thinking: false` in extra_body, or `/no_think` prompt
 *   - Gemini 2.5 Flash: `thinking_budget: 0`
 *   - Gemini 3 Flash/Lite: `thinking_level: "minimal"`
 *   - GLM thinking models: `thinking: {type: "disabled"}`
 */
const THINKING_DISABLEABLE_PREFIXES: string[] = [
    'claude-opus',            // Claude Opus — don't send thinking param
    'claude-sonnet',          // Claude Sonnet 4.6 — thinking.type="disabled"
    'claude-haiku',           // Claude Haiku 4.5 — no thinking by default
    'gemini-2.5-flash',       // Gemini 2.5 Flash — thinkingBudget=0
    'gemini-3-flash',         // Gemini 3 Flash — thinkingLevel=minimal
    'gemini-3.1-flash',       // Gemini 3.1 Flash Lite — thinkingLevel=minimal
    'qwen3',                  // Qwen3/3.5/3.6+ — enable_thinking=false
    'qwen-max',               // Qwen Max — enable_thinking=false
    'qwen-turbo',             // Qwen Turbo — non-thinking, but safe to pass
    'glm-4.1v-thinking',      // GLM thinking — thinking.type=disabled
];

/** Returns true if the model always thinks and CANNOT disable thinking */
function isAlwaysThinkingModel(model: string): boolean {
    const lower = model.toLowerCase();

    // If it natively supports disabling, it's not "always" thinking
    if (isDisableableThinkingModel(model)) {
        return false;
    }

    // Dynamic checks for fetched models
    if (lower.includes('-r1') || lower.includes('reasoner') || lower.includes('think') || lower.match(/^o[13]/)) {
        return true;
    }

    return THINKING_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/** Returns true if the model supports thinking but CAN disable it */
function isDisableableThinkingModel(model: string): boolean {
    const lower = model.toLowerCase();
    return THINKING_DISABLEABLE_PREFIXES.some(prefix => lower.startsWith(prefix));
}

// ─── LRU Cache ───────────────────────────────────────────────────────────────

interface CacheEntry {
    items: vs.InlineCompletionItem[];
    timestamp: number;
    docVersion: number;
}

class InlineCompletionCache {
    private cache = new Map<string, CacheEntry>();
    private readonly maxSize: number;
    private readonly ttlMs: number;

    constructor(maxSize = 10, ttlMs = 5000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }

    get(key: string, docVersion: number): vs.InlineCompletionItem[] | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;
        // Invalid if document changed or TTL expired
        if (entry.docVersion !== docVersion || Date.now() - entry.timestamp > this.ttlMs) {
            this.cache.delete(key);
            return undefined;
        }
        // Move to end (LRU refresh)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.items;
    }

    set(key: string, items: vs.InlineCompletionItem[], docVersion: number): void {
        if (this.cache.size >= this.maxSize) {
            // Evict oldest entry
            const first = this.cache.keys().next().value;
            if (first !== undefined) this.cache.delete(first);
        }
        this.cache.set(key, { items, timestamp: Date.now(), docVersion });
    }

    clear(): void {
        this.cache.clear();
    }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class AIInlineCompletionProvider implements vs.InlineCompletionItemProvider {
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private lastRequestId = 0;
    private isEnabled = false;
    /** Track cursor line between calls to detect Enter key press */
    private lastSeenLine = -1;
    private lastSeenUri = '';
    /** LRU cache for recent completions */
    private completionCache = new InlineCompletionCache(10, 5000);
    /** AbortController for the current in-flight AI request */
    private currentAbortController: AbortController | null = null;

    /** Fix #1: collect event Disposables for proper cleanup */
    private _disposables: vs.Disposable[] = [];

    constructor(
        private aiService: AIService,
        private promptBuilder: PromptBuilder
    ) {
        // Watch for configuration changes — Fix #1: capture Disposable
        this._disposables.push(
            vs.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('cwtools.ai')) {
                    this.updateEnabled();
                }
            })
        );
        this.updateEnabled();
    }

    /** Fix #1: release event listeners */
    dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private updateEnabled(): void {
        const config = this.aiService.getConfig();
        this.isEnabled = config.enabled && config.inlineCompletion.enabled;
    }

    async provideInlineCompletionItems(
        document: vs.TextDocument,
        position: vs.Position,
        context: vs.InlineCompletionContext,
        token: vs.CancellationToken
    ): Promise<vs.InlineCompletionItem[] | undefined> {
        if (!this.isEnabled) return undefined;

        // Only provide completions for paradox/stellaris language files
        if (document.languageId !== 'paradox' && document.languageId !== 'stellaris') {
            return undefined;
        }

        // Auto-trigger on Enter (line number increased), Space, or Tab.
        // Explicit trigger (e.g. editor.action.inlineSuggest.trigger) always proceeds.
        if (context.triggerKind === vs.InlineCompletionTriggerKind.Automatic) {
            const uri = document.uri.toString();
            const enteredNewLine = uri === this.lastSeenUri && position.line > this.lastSeenLine;
            this.lastSeenLine = position.line;
            this.lastSeenUri = uri;
            const lineText = document.lineAt(position.line).text;
            const charBefore = position.character > 0 ? lineText.charAt(position.character - 1) : '';
            const isSpace = charBefore === ' ';
            const isTab   = charBefore === '\t';
            if (!enteredNewLine && !isSpace && !isTab) return undefined;
        }

        // Don't complete in comments
        const lineText = document.lineAt(position.line).text;
        const textBeforeCursor = lineText.substring(0, position.character).trimStart();
        if (textBeforeCursor.startsWith('#')) return undefined;

        // ── Block thinking models that cannot disable thinking ──
        const config = this.aiService.getConfig();
        const inlineProvider = config.inlineCompletion.provider || config.provider;
        const inlineModel = config.inlineCompletion.model
            || getEffectiveModel(inlineProvider, undefined);
        if (isAlwaysThinkingModel(inlineModel)) {
            // Silently skip — these models are too slow for inline use
            return undefined;
        }

        // Debounce to avoid excessive API calls
        const debounceMs = config.inlineCompletion.debounceMs;

        return new Promise((resolve) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            const requestId = ++this.lastRequestId;
            // Capture document version at the moment the debounce starts.
            const docVersionAtCapture = document.version;

            this.debounceTimer = setTimeout(async () => {
                // Check if this request is still current AND the document hasn't changed
                if (requestId !== this.lastRequestId || token.isCancellationRequested) {
                    resolve(undefined);
                    return;
                }
                if (document.version !== docVersionAtCapture) {
                    resolve(undefined);
                    return;
                }

                try {
                    const completion = await this.getCompletion(document, position, token);
                    if (token.isCancellationRequested || requestId !== this.lastRequestId) {
                        resolve(undefined);
                        return;
                    }
                    resolve(completion);
                } catch {
                    resolve(undefined);
                }
            }, debounceMs);
        });
    }

    private async getCompletion(
        document: vs.TextDocument,
        position: vs.Position,
        token: vs.CancellationToken
    ): Promise<vs.InlineCompletionItem[] | undefined> {
        const config = this.aiService.getConfig();
        const fimMode = config.inlineCompletion.fimMode;

        // ── Build cache key from context ──
        const linePrefix = document.lineAt(position.line).text.substring(0, position.character).trim();
        const cacheKey = `${document.uri.fsPath}:${position.line}:${linePrefix}`;
        const cached = this.completionCache.get(cacheKey, document.version);
        if (cached) return cached;

        // ── Fetch LSP suggestions with 150ms timeout (Chat mode only) ──
        // FIM models infer context themselves; skip to avoid unnecessary latency.
        let lspSuggestions: string[] = [];
        if (!fimMode) {
            try {
                const lspPromise = vs.commands.executeCommand<vs.CompletionList>(
                    'vscode.executeCompletionItemProvider',
                    document.uri,
                    position
                );
                const timeoutPromise = new Promise<null>(r => setTimeout(() => r(null), 150));
                const completions = await Promise.race([lspPromise, timeoutPromise]);

                if (completions && 'items' in completions && completions.items) {
                    const invalidKinds = [
                        vs.CompletionItemKind.Snippet,
                        vs.CompletionItemKind.Keyword
                    ];
                    lspSuggestions = completions.items
                        .filter(item => item.kind === undefined || !invalidKinds.includes(item.kind))
                        .map(item => typeof item.label === 'string' ? item.label : item.label.label)
                        .slice(0, 20);
                }
            } catch {
                // LSP timeout or error — continue with empty suggestions
            }

            if (token.isCancellationRequested) return undefined;

            // ── Local fast-path: simple kv pattern with ≤5 clear LSP results ──
            // Pattern: `key = ` or `key =` at cursor — if LSP has few clear results, use directly
            if (lspSuggestions.length > 0 && lspSuggestions.length <= 5) {
                const kvMatch = linePrefix.match(/^\s*[\w.]+\s*=\s*$/);
                if (kvMatch) {
                    const item = new vs.InlineCompletionItem(
                        lspSuggestions[0],
                        new vs.Range(position, position)
                    );
                    const result = [item];
                    this.completionCache.set(cacheKey, result, document.version);
                    return result;
                }
            }
        }

        // Determine provider and model for inline completion
        const inlineProvider = config.inlineCompletion.provider || config.provider;
        const inlineModel = config.inlineCompletion.model || undefined;

        // ── Cancel previous in-flight request ──
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
        const abortController = new AbortController();
        this.currentAbortController = abortController;

        // Link VS Code cancellation token to our AbortController
        token.onCancellationRequested(() => abortController.abort());

        try {
            let completionText = '';

            if (fimMode) {
                // ── FIM Mode ──
                const totalLines = document.lineCount;
                const contextStart = Math.max(0, position.line - 30);
                const contextEnd = Math.min(totalLines, position.line + 31);
                
                // Prefix: from contextStart to cursor
                const prefixDoc = document.getText(new vs.Range(
                    new vs.Position(contextStart, 0),
                    position
                ));
                // Suffix: from cursor to contextEnd
                const suffixDoc = document.getText(new vs.Range(
                    position,
                    new vs.Position(contextEnd, 0)
                ));

                const contentStr = await this.aiService.fimCompletion(prefixDoc, suffixDoc, {
                    providerId: inlineProvider,
                    model: inlineModel,
                    temperature: 0.2,
                    maxTokens: 200,
                    abortSignal: abortController.signal
                });

                if (token.isCancellationRequested || abortController.signal.aborted) return undefined;
                completionText = contentStr.trim();
                
            } else {
                // ── Chat Mode (Legacy) ──
                // ── Extract limited context (±30 lines around cursor) ──
                const totalLines = document.lineCount;
                const contextStart = Math.max(0, position.line - 30);
                const contextEnd = Math.min(totalLines, position.line + 31);
                const contextLines: string[] = [];
                for (let i = contextStart; i < contextEnd; i++) {
                    contextLines.push(document.lineAt(i).text);
                }
                const contextContent = contextLines.join('\n');

                // Build the lightweight inline prompt with limited context
                const messages = this.promptBuilder.buildInlinePrompt({
                    fileContent: contextContent,
                    cursorLine: position.line - contextStart,  // Adjust to relative line
                    cursorColumn: position.character,
                    filePath: document.uri.fsPath,
                    lspSuggestions: lspSuggestions.length > 0 ? lspSuggestions : undefined
                });

                // Determine effective model for thinking-disable check
                const effectiveModel = inlineModel || getEffectiveModel(inlineProvider, undefined);
                const disableThinking = isDisableableThinkingModel(effectiveModel);

                const response = await this.aiService.chatCompletion(messages, {
                    providerId: inlineProvider,
                    model: inlineModel,
                    temperature: disableThinking ? 0 : 0.2,
                    maxTokens: 200,  // Keep responses short for inline
                    // Pass abort signal so cancellation immediately releases the connection
                    abortSignal: abortController.signal,
                    // Disable thinking for models that support it
                    disableThinking,
                } as Parameters<typeof this.aiService.chatCompletion>[1]);

                if (token.isCancellationRequested || abortController.signal.aborted) return undefined;

                const content = response.choices[0]?.message?.content;
                const contentStr = typeof content === 'string' ? content : '';

                // Clean up the response
                completionText = contentStr.trim();

                // Remove markdown code fences if present
                completionText = completionText
                    .replace(/^```\w*\n?/, '')
                    .replace(/\n?```$/, '')
                    .trim();

                // Strip <think>...</think> blocks if the model still outputs them
                // Also handle unclosed <think> (truncated by max_tokens)
                completionText = completionText
                    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
                    .replace(/<think>[\s\S]*$/g, '')  // unclosed think at end
                    .trim();
            }

            if (!completionText || completionText.length === 0) return undefined;

            // ── Prefix dedup: strip line prefix if AI repeated it ──
            // AI sometimes echoes the current line prefix (e.g. "limit = {" when cursor is after "limit = {")
            const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
            const trimmedPrefix = linePrefix.trimStart();
            if (trimmedPrefix.length > 0) {
                // Check if completion starts with the full prefix (or its trimmed version)
                if (completionText.startsWith(trimmedPrefix)) {
                    completionText = completionText.substring(trimmedPrefix.length);
                } else if (completionText.startsWith(linePrefix)) {
                    completionText = completionText.substring(linePrefix.length);
                }
                // Also check first line only for prefix echo
                const firstNewline = completionText.indexOf('\n');
                const firstLine = firstNewline >= 0 ? completionText.substring(0, firstNewline) : completionText;
                if (firstLine.trim().length === 0 && firstNewline >= 0) {
                    // AI output started with a blank first line after dedup — skip it
                    completionText = completionText.substring(firstNewline + 1);
                }
            }

            // ── Overlap stripping: prevent collision with existing suffix after cursor ──
            if (config.inlineCompletion.overlapStripping) {
                const lineSuffix = document.lineAt(position.line).text.substring(position.character);
                if (lineSuffix) {
                    const firstLine = completionText.split('\n')[0];
                    for (let i = 0; i < firstLine.length; i++) {
                        const overlapCandidate = firstLine.slice(i);
                        if (overlapCandidate.trim().length === 0) continue;
                        if (lineSuffix.startsWith(overlapCandidate)) {
                            completionText = completionText.slice(0, i);
                            break;
                        }
                    }
                }
            }

            if (completionText.length === 0) return undefined;

            // Create inline completion item
            const item = new vs.InlineCompletionItem(
                completionText,
                new vs.Range(position, position)
            );

            const result = [item];
            this.completionCache.set(cacheKey, result, document.version);
            return result;
        } catch {
            return undefined;
        } finally {
            if (this.currentAbortController === abortController) {
                this.currentAbortController = null;
            }
        }
    }
}
