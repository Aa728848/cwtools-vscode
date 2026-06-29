/**
 * CWTools AI Module — Inline Completion Provider
 *
 * Provides AI-powered inline code completion for PDXScript files.
 * Uses a lightweight prompt (no tool calls) for fast response times.
 * Supports independent model/provider configuration from the chat panel.
 *
 * Performance optimizations:
 *   - Local template fast-path: common PDX block scaffolds skip the AI call
 *   - LSP fast-path: a single dominant completion (150ms timeout) skips the AI call
 *   - LRU cache (capacity 10, 5s TTL) for identical contexts
 *   - In-flight request is aborted as soon as a newer request arrives
 *   - Hard FIM timeout (configurable, default 1500ms) to avoid hung ghost text
 *   - MCP context is off by default; when on, results are TTL-cached
 *   - Acceptance telemetry records accepted vs stale inline suggestions
 *   - Thinking/reasoning models are blocked (too slow for inline)
 *   - Context window is configurable (default 20 lines before / 10 after)
 */

import * as vs from 'vscode';
import { AIService } from './aiService';
import { PromptBuilder } from './promptBuilder';
import { getEffectiveModel, ALWAYS_THINKING_PREFIXES, BUILTIN_PROVIDERS } from './providers';
import { MCPClient } from './mcpClient';
import { UsageTracker } from './usageTracker';
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

type InlineTelemetrySource = 'template' | 'lsp' | 'fim' | 'cache';

interface InlineTelemetryBucket {
    issued: number;
    accepted: number;
    stale: number;
}

interface PendingInlineTelemetry {
    source: InlineTelemetrySource;
    timestamp: number;
    length: number;
    /** Stable per-slot identity (uri:line:linePrefix::text) used to dedup re-offers of the same suggestion. */
    identity: string;
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
    private readonly acceptCommand = `cwtools.ai.inlineCompletion.accepted.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingDebounceResolve: ((items: vs.InlineCompletionItem[] | undefined) => void) | null = null;
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
    private mcpContextCache = new Map<string, { text: string; timestamp: number }>();
    private telemetrySeq = 0;
    private pendingTelemetry = new Map<string, PendingInlineTelemetry>();
    /** Maps a suggestion slot identity to its current live pending id, so re-offers reuse one issuance. */
    private pendingByIdentity = new Map<string, string>();
    private telemetry: InlineTelemetryBucket = { issued: 0, accepted: 0, stale: 0 };
    private telemetryBySource = new Map<InlineTelemetrySource, InlineTelemetryBucket>();
    private cacheHits = 0;
    private lastTelemetryReportAt = 0;
    /** A re-offered suggestion younger than this is not marked stale — it may still be displayed/accepted. */
    private static readonly STALE_GRACE_MS = 1500;

    /** Fix #1: collect event Disposables for proper cleanup */
    private _disposables: vs.Disposable[] = [];

    constructor(
        private aiService: AIService,
        private promptBuilder: PromptBuilder,
        private usageTracker: UsageTracker
    ) {
        // Watch for configuration changes — Fix #1: capture Disposable
        this._disposables.push(
            vs.commands.registerCommand(this.acceptCommand, (id: string) => {
                this.recordTelemetryAccepted(id);
            }),
            vs.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('stellarisLanguageServices.ai')) {
                    this.updateEnabled();
                }
            })
        );
        this.updateEnabled();
    }

    /** Fix #1: release event listeners */
    dispose(): void {
        this.markPendingTelemetryStale('dispose', true);
        this.reportInlineTelemetry(true);
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
        this.disconnectAllMcp();
    }

    private disconnectAllMcp(): void {
        for (const client of this.mcpClients.values()) {
            client.disconnect();
        }
        this.mcpClients.clear();
        this.mcpContextCache.clear();
    }

    private clearPendingDebounce(): void {
        this.markPendingTelemetryStale('new_request');
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.pendingDebounceResolve) {
            this.pendingDebounceResolve(undefined);
            this.pendingDebounceResolve = null;
        }
    }

    private abortCurrentRequest(): void {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
    }

    private getTelemetryBucket(source: InlineTelemetrySource): InlineTelemetryBucket {
        let bucket = this.telemetryBySource.get(source);
        if (!bucket) {
            bucket = { issued: 0, accepted: 0, stale: 0 };
            this.telemetryBySource.set(source, bucket);
        }
        return bucket;
    }

    private suggestionIdentity(
        document: vs.TextDocument,
        position: vs.Position,
        insertText: string | vs.SnippetString
    ): string {
        const linePrefix = document.lineAt(position.line).text.substring(0, position.character).trim();
        const text = insertText instanceof vs.SnippetString ? insertText.value : insertText;
        return `${document.uri.fsPath}:${position.line}:${linePrefix}::${text}`;
    }

    private createInlineCompletionItem(
        insertText: string | vs.SnippetString,
        range: vs.Range,
        source: InlineTelemetrySource,
        identity: string
    ): vs.InlineCompletionItem {
        // Re-offer of the same slot (provider re-invocation / cache re-serve): reuse the live id,
        // refresh its age, and do NOT count a new issuance. The denominator must track distinct
        // suggestions offered to the user, not raw provider productions.
        const existingId = this.pendingByIdentity.get(identity);
        let id: string;
        if (existingId !== undefined && this.pendingTelemetry.has(existingId)) {
            id = existingId;
            this.pendingTelemetry.get(existingId)!.timestamp = Date.now();
        } else {
            id = `${Date.now()}.${++this.telemetrySeq}`;
            const length = insertText instanceof vs.SnippetString ? insertText.value.length : insertText.length;
            this.pendingTelemetry.set(id, { source, timestamp: Date.now(), length, identity });
            this.pendingByIdentity.set(identity, id);
            this.telemetry.issued++;
            this.getTelemetryBucket(source).issued++;
        }

        const item = new vs.InlineCompletionItem(insertText, range, {
            title: 'Record inline completion acceptance',
            command: this.acceptCommand,
            arguments: [id],
        });
        this.reportInlineTelemetry(false);
        return item;
    }

    private cloneInlineCompletionItem(
        item: vs.InlineCompletionItem,
        fallbackRange: vs.Range,
        source: InlineTelemetrySource,
        identity: string
    ): vs.InlineCompletionItem {
        const cloned = this.createInlineCompletionItem(item.insertText, item.range ?? fallbackRange, source, identity);
        cloned.filterText = item.filterText;
        return cloned;
    }

    /** Remove a pending entry and its identity mapping together. */
    private dropPending(id: string, pending: PendingInlineTelemetry): void {
        this.pendingTelemetry.delete(id);
        if (this.pendingByIdentity.get(pending.identity) === id) {
            this.pendingByIdentity.delete(pending.identity);
        }
    }

    private recordTelemetryAccepted(id: string): void {
        const pending = this.pendingTelemetry.get(id);
        if (!pending) return;

        this.dropPending(id, pending);
        this.telemetry.accepted++;
        this.getTelemetryBucket(pending.source).accepted++;
        this.reportInlineTelemetry(false);
    }

    /**
     * Mark superseded suggestions stale. Entries younger than STALE_GRACE_MS are kept, so a
     * suggestion still on screen (whose accept command may be in flight) is not lost to the blanket
     * clear that previously ran on every re-invocation. `all` forces a full flush (dispose).
     */
    private markPendingTelemetryStale(reason: string, all = false): void {
        if (this.pendingTelemetry.size === 0) return;

        const now = Date.now();
        let count = 0;
        for (const [id, pending] of this.pendingTelemetry) {
            if (!all && now - pending.timestamp <= AIInlineCompletionProvider.STALE_GRACE_MS) continue;
            this.dropPending(id, pending);
            this.telemetry.stale++;
            this.getTelemetryBucket(pending.source).stale++;
            count++;
        }
        if (count > 0) {
            ErrorReporter.debug(SOURCE.INLINE_PROVIDER, `Inline telemetry marked ${count} pending suggestion(s) stale: ${reason}`);
            this.reportInlineTelemetry(false);
        }
    }

    private sweepStaleTelemetry(): void {
        const now = Date.now();
        let staleCount = 0;
        for (const [id, pending] of this.pendingTelemetry) {
            if (now - pending.timestamp <= 30_000) continue;
            this.dropPending(id, pending);
            this.telemetry.stale++;
            this.getTelemetryBucket(pending.source).stale++;
            staleCount++;
        }
        if (staleCount > 0) {
            ErrorReporter.debug(SOURCE.INLINE_PROVIDER, `Inline telemetry swept ${staleCount} expired suggestion(s)`);
            this.reportInlineTelemetry(false);
        }
    }

    private reportInlineTelemetry(force: boolean): void {
        const now = Date.now();
        if (!force && this.telemetry.issued % 20 !== 0 && now - this.lastTelemetryReportAt < 60_000) return;
        if (this.telemetry.issued === 0) return;

        this.lastTelemetryReportAt = now;
        // Acceptance rate is computed over RESOLVED suggestions (accepted + stale), not raw issued,
        // so outstanding/pending suggestions don't deflate it. With per-slot dedup each distinct
        // suggestion contributes exactly one accepted or one stale, making this an honest proxy.
        const resolved = this.telemetry.accepted + this.telemetry.stale;
        const acceptedRate = resolved > 0 ? (this.telemetry.accepted / resolved * 100).toFixed(1) : '0.0';
        const bySource = Array.from(this.telemetryBySource.entries())
            .map(([source, bucket]) => {
                const r = bucket.accepted + bucket.stale;
                const rate = r > 0 ? (bucket.accepted / r * 100).toFixed(1) : '0.0';
                return `${source}=${bucket.accepted}/${r} (${rate}%)`;
            })
            .join('; ');
        ErrorReporter.debug(
            SOURCE.INLINE_PROVIDER,
            `Inline acceptance telemetry: accepted=${this.telemetry.accepted}/${resolved} (${acceptedRate}%) [issued=${this.telemetry.issued}, stale=${this.telemetry.stale}, pending=${this.pendingTelemetry.size}, cacheHits=${this.cacheHits}]${bySource ? `; ${bySource}` : ''}`
        );
    }

    private updateEnabled(): void {
        const config = this.aiService.getConfig();
        this.isEnabled = config.enabled && config.inlineCompletion.enabled;

        const shouldUseMcp = this.isEnabled && config.inlineCompletion.includeMcpContext && config.mcp.servers.length > 0;
        if (!shouldUseMcp) {
            this.disconnectAllMcp();
            return;
        }

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

        this.sweepStaleTelemetry();
        this.clearPendingDebounce();
        this.abortCurrentRequest();

        // Debounce to avoid excessive API calls
        const debounceMs = config.inlineCompletion.debounceMs;

        return new Promise((resolve) => {
            const requestId = ++this.lastRequestId;
            // Capture document version at the moment the debounce starts.
            const docVersionAtCapture = document.version;
            this.pendingDebounceResolve = resolve;

            this.debounceTimer = setTimeout(async () => {
                this.debounceTimer = null;
                this.pendingDebounceResolve = null;
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

    private tryTemplateFastPath(
        document: vs.TextDocument,
        position: vs.Position
    ): vs.InlineCompletionItem | undefined {
        const line = document.lineAt(position.line).text;
        const before = line.substring(0, position.character);
        const after = line.substring(position.character);
        if (!before.trimEnd().endsWith('{') || after.includes('}')) return undefined;

        const trimmed = before.trim();
        if (!/\b(?:limit|trigger|option|immediate|potential|allow|effect|hidden_effect)\s*=\s*\{$/i.test(trimmed)) {
            return undefined;
        }

        if (position.line + 1 < document.lineCount) {
            const nextLine = document.lineAt(position.line + 1).text.trim();
            if (nextLine.startsWith('}')) return undefined;
        }

        const indent = before.match(/^\s*/)?.[0] ?? '';
        const snippet = new vs.SnippetString(`\n${indent}\t$0\n${indent}\\}`);
        return this.createInlineCompletionItem(snippet, new vs.Range(position, position), 'template', this.suggestionIdentity(document, position, snippet));
    }

    private async tryLspFastPath(
        document: vs.TextDocument,
        position: vs.Position,
        token: vs.CancellationToken
    ): Promise<vs.InlineCompletionItem | undefined> {
        if (token.isCancellationRequested) return undefined;

        try {
            const completions = await Promise.race([
                vs.commands.executeCommand<vs.CompletionList | vs.CompletionItem[]>(
                    'vscode.executeCompletionItemProvider',
                    document.uri,
                    position
                ),
                new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 150))
            ]);
            if (!completions || token.isCancellationRequested) return undefined;

            const items = Array.isArray(completions) ? completions : completions.items;
            if (items.length !== 1) return undefined;

            const item = items[0];
            if (!item) return undefined;

            const candidate = this.completionItemText(item);
            if (!candidate) return undefined;

            const line = document.lineAt(position.line).text;
            const before = line.substring(0, position.character);
            const after = line.substring(position.character);
            const tokenPrefix = before.match(/[A-Za-z0-9_:.@-]+$/)?.[0] ?? '';
            let insertText = candidate;
            if (tokenPrefix) {
                if (!candidate.startsWith(tokenPrefix)) return undefined;
                insertText = candidate.substring(tokenPrefix.length);
            }

            if (!insertText || insertText.includes('\n') || after.startsWith(insertText)) return undefined;
            return this.createInlineCompletionItem(insertText, new vs.Range(position, position), 'lsp', this.suggestionIdentity(document, position, insertText));
        } catch {
            return undefined;
        }
    }

    private shouldTryLspFastPath(document: vs.TextDocument, position: vs.Position): boolean {
        const line = document.lineAt(position.line).text;
        const before = line.substring(0, position.character);
        const trimmed = before.trimEnd();
        if (!trimmed || trimmed.endsWith('{')) return false;

        if (/=\s*$/.test(trimmed)) return true;

        const tokenPrefix = before.match(/[A-Za-z0-9_:.@-]+$/)?.[0] ?? '';
        return tokenPrefix.length >= 2;
    }

    private completionItemText(item: vs.CompletionItem): string | undefined {
        const textEdit = item.textEdit;
        if (textEdit && 'newText' in textEdit && typeof textEdit.newText === 'string') {
            return this.cleanLspCandidate(textEdit.newText);
        }
        if (typeof item.insertText === 'string') {
            return this.cleanLspCandidate(item.insertText);
        }
        if (typeof item.label === 'string') {
            return this.cleanLspCandidate(item.label);
        }
        if (typeof item.label === 'object' && typeof item.label.label === 'string') {
            return this.cleanLspCandidate(item.label.label);
        }
        return undefined;
    }

    private cleanLspCandidate(value: string): string | undefined {
        const trimmed = value.trim();
        if (!trimmed || trimmed.includes('${') || trimmed.includes('$0') || trimmed.includes('$1')) return undefined;
        return trimmed;
    }

    private async getMcpContext(ttlMs: number, token: vs.CancellationToken): Promise<string> {
        if (this.mcpClients.size === 0 || token.isCancellationRequested) return '';

        const start = Date.now();
        const contexts = await Promise.all(
            Array.from(this.mcpClients.entries()).map(([name, client]) =>
                this.getMcpContextForServer(name, client, ttlMs, token)
            )
        );
        const text = contexts.filter(Boolean).join('\n\n');
        ErrorReporter.debug(SOURCE.INLINE_PROVIDER, `MCP context ${text ? 'loaded' : 'empty'} in ${Date.now() - start}ms`);
        return text;
    }

    private async getMcpContextForServer(
        name: string,
        client: MCPClient,
        ttlMs: number,
        token: vs.CancellationToken
    ): Promise<string> {
        const cached = this.mcpContextCache.get(name);
        const now = Date.now();
        if (cached && now - cached.timestamp <= Math.max(0, ttlMs)) {
            return cached.text;
        }

        let text = '';
        try {
            const res = await Promise.race([
                client.getResources(),
                new Promise<any>((_, reject) => setTimeout(() => reject(new Error('timeout')), 300))
            ]);
            if (!token.isCancellationRequested && res?.resources?.length > 0) {
                const firstResource = res.resources[0];
                const content = await Promise.race([
                    client.readResource(firstResource.uri),
                    new Promise<any>((_, reject) => setTimeout(() => reject(new Error('timeout')), 300))
                ]);
                if (content?.contents?.[0]?.text) {
                    text = `[MCP Resource ${firstResource.name || firstResource.uri}]:\n${content.contents[0].text}`;
                }
            }
        } catch {
            text = '';
        }

        this.mcpContextCache.set(name, { text, timestamp: now });
        return text;
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
        if (cached) {
            this.cacheHits++;
            const fallbackRange = new vs.Range(position, position);
            return cached.map(item => this.cloneInlineCompletionItem(item, fallbackRange, 'cache', this.suggestionIdentity(document, position, item.insertText)));
        }

        // Determine provider and model for inline completion
        const inlineProvider = config.inlineCompletion.provider || config.provider;
        const inlineModel = config.inlineCompletion.model || undefined;

        // Determine if the selected provider natively supports FIM
        const fimMode = !!BUILTIN_PROVIDERS[inlineProvider]?.supportsFIM;

        if (!fimMode) {
            // If model doesn't support FIM, we no longer fallback to slow Chat Mode.
            return undefined;
        }

        const abortController = new AbortController();
        this.currentAbortController = abortController;

        // Link VS Code cancellation token to our AbortController
        token.onCancellationRequested(() => abortController.abort());

        try {
            let completionText = '';

            const templateFastPath = this.tryTemplateFastPath(document, position);
            if (templateFastPath) return [templateFastPath];

            if (config.inlineCompletion.lspFastPath && this.shouldTryLspFastPath(document, position)) {
                const lspStart = Date.now();
                const lspFastPath = await this.tryLspFastPath(document, position, token);
                ErrorReporter.debug(SOURCE.INLINE_PROVIDER, `LSP fast path ${lspFastPath ? 'hit' : 'miss'} in ${Date.now() - lspStart}ms`);
                if (lspFastPath) return [lspFastPath];
            }

            const mcpContextStr = await this.getMcpContext(config.inlineCompletion.mcpCacheTtlMs, token);

            // ── FIM Mode ──
            const totalLines = document.lineCount;
            const contextStart = Math.max(0, position.line - Math.max(0, config.inlineCompletion.contextBeforeLines));
            const contextEnd = Math.min(totalLines, position.line + Math.max(1, config.inlineCompletion.contextAfterLines) + 1);
            
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

            const requestTimeoutMs = Math.max(500, config.inlineCompletion.requestTimeoutMs);
            let timeoutFired = false;
            const timeoutTimer = setTimeout(() => {
                timeoutFired = true;
                abortController.abort();
            }, requestTimeoutMs);
            const fimStart = Date.now();
            let contentStr = '';
            try {
                contentStr = await this.aiService.fimCompletion(prefixDoc, suffixDoc, {
                    providerId: inlineProvider,
                    model: inlineModel,
                    temperature: 0.2,
                    maxTokens: Math.max(16, config.inlineCompletion.maxTokens),
                    abortSignal: abortController.signal
                });
                ErrorReporter.debug(SOURCE.INLINE_PROVIDER, `FIM completed in ${Date.now() - fimStart}ms, text=${contentStr.length}`);
            } catch (err) {
                if (timeoutFired) {
                    ErrorReporter.debug(SOURCE.INLINE_PROVIDER, `FIM timed out after ${requestTimeoutMs}ms`);
                    return undefined;
                }
                throw err;
            } finally {
                clearTimeout(timeoutTimer);
            }

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
            const item = this.createInlineCompletionItem(
                completionText,
                new vs.Range(position, position),
                'fim',
                this.suggestionIdentity(document, position, completionText)
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
