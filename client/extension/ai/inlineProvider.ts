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
import { getProvider, getEffectiveModel, ALWAYS_THINKING_PREFIXES, BUILTIN_PROVIDERS } from './providers';
import { MCPClient } from './mcpClient';
import { UsageTracker } from './usageTracker';
import { getModelPricing } from './pricing';
import { ErrorReporter } from './errorReporter';
import { SOURCE } from './messages';

// ─── Thinking-model detection ────────────────────────────────────────────────

// Fix #4: Use shared ALWAYS_THINKING_PREFIXES from providers.ts (single source of truth)
const THINKING_MODEL_PREFIXES = ALWAYS_THINKING_PREFIXES;

/** Returns true if the model always thinks and CANNOT disable thinking */
function isAlwaysThinkingModel(model: string): boolean {
    const lower = model.toLowerCase();

    // Dynamic checks for fetched models
    if (lower.includes('-r1') || lower.includes('reasoner') || lower.includes('think') || lower.match(/^o[13]/)) {
        return true;
    }

    return THINKING_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix));
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
    /** Managed MCP Clients */
    private mcpClients = new Map<string, MCPClient>();

    /** Fix #1: collect event Disposables for proper cleanup */
    private _disposables: vs.Disposable[] = [];

    constructor(
        private aiService: AIService,
        private promptBuilder: PromptBuilder,
        private usageTracker: UsageTracker
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
        this.disconnectAllMcp();
    }

    private disconnectAllMcp(): void {
        for (const client of this.mcpClients.values()) {
            client.disconnect();
        }
        this.mcpClients.clear();
    }

    private updateEnabled(): void {
        const config = this.aiService.getConfig();
        this.isEnabled = config.enabled && config.inlineCompletion.enabled;

        // Initialize MCP servers
        const newServerNames = new Set(config.mcp.servers.map(s => s.name));
        // Remove stale servers
        for (const name of this.mcpClients.keys()) {
            if (!newServerNames.has(name)) {
                this.mcpClients.get(name)?.disconnect();
                this.mcpClients.delete(name);
            }
        }
        // Add new servers
        for (const serverConf of config.mcp.servers) {
            if (!this.mcpClients.has(serverConf.name)) {
                const client = new MCPClient(serverConf);
                client.connect().catch((e) => {
                    ErrorReporter.warn(SOURCE.INLINE_PROVIDER, `MCP: Failed to connect to ${serverConf.name}`, e);
                });
                this.mcpClients.set(serverConf.name, client);
            }
        }
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
            // Log and silently skip — these models are too slow for inline use
            ErrorReporter.debug('InlineProvider', `Skipping inline completion: model ${inlineModel} is always-thinking`);
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
                } catch (err) {
                    ErrorReporter.warn('InlineProvider', 'Unexpected error in provideInlineCompletionItems', err);
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

        // ── Build cache key from context ──
        const linePrefix = document.lineAt(position.line).text.substring(0, position.character).trim();
        const cacheKey = `${document.uri.fsPath}:${position.line}:${linePrefix}`;
        const cached = this.completionCache.get(cacheKey, document.version);
        if (cached) return cached;

        // Determine provider and model for inline completion
        const inlineProvider = config.inlineCompletion.provider || config.provider;
        const inlineModel = config.inlineCompletion.model || undefined;

        // Determine if the selected provider natively supports FIM
        const fimMode = !!BUILTIN_PROVIDERS[inlineProvider]?.supportsFIM;

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

            // ── Gather MCP context ──
            let mcpContextStr = '';
            if (this.mcpClients.size > 0 && !token.isCancellationRequested) {
                try {
                    const promises = Array.from(this.mcpClients.values()).map(async client => {
                        try {
                            const res = await Promise.race([
                                client.getResources(),
                                new Promise<any>((_, r) => setTimeout(() => r(new Error('timeout')), 300))
                            ]);
                            if (res && res.resources && res.resources.length > 0) {
                                const content = await Promise.race([
                                    client.readResource(res.resources[0].uri),
                                    new Promise<any>((_, r) => setTimeout(() => r(new Error('timeout')), 300))
                                ]);
                                if (content && content.contents && content.contents[0].text) {
                                    return `[MCP Resource ${res.resources[0].name || res.resources[0].uri}]:\n${content.contents[0].text}`;
                                }
                            }
                        } catch {
                            // Ignore
                        }
                        return '';
                    });
                    const contexts = await Promise.all(promises);
                    mcpContextStr = contexts.filter(Boolean).join('\n\n');
                } catch {
                    // Ignore
                }
            }

            if (!fimMode) {
                // If model doesn't support FIM, we no longer fallback to slow Chat Mode.
                return undefined;
            }

            // ── FIM Mode ──
            const totalLines = document.lineCount;
            const contextStart = Math.max(0, position.line - 30);
            const contextEnd = Math.min(totalLines, position.line + 31);
            
            // Prefix: from contextStart to cursor
            let prefixDoc = document.getText(new vs.Range(
                new vs.Position(contextStart, 0),
                position
            ));
            if (mcpContextStr) {
                prefixDoc = `<mcp_context>\n${mcpContextStr}\n</mcp_context>\n\n${prefixDoc}`;
            }
            
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

            if (!contentStr.trim()) {
                ErrorReporter.warn('InlineProvider', `Model ${inlineModel} returned empty FIM completion`);
            }

            completionText = contentStr.trim();

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
                    const firstLine = completionText.split('\n')[0]!;  
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
        } catch (err) {
            if (err instanceof Error && err.name !== 'AbortError') {
                ErrorReporter.warn('InlineProvider', `Completion error using ${config.inlineCompletion.provider || config.provider}`, err);
            }
            return undefined;
        } finally {
            if (this.currentAbortController === abortController) {
                this.currentAbortController = null;
            }
        }
    }
}
