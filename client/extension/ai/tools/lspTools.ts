/**
 * LSP Tool Handler - all CWTools Language Server query operations.
 *
 * Handles: scope queries, type queries, rule queries, references,
 * code validation, diagnostics, completions, symbols, and deep API tools.
 */

import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { LanguageClient } from 'vscode-languageclient/node';
import type {
    QueryScopeResult,
    QueryTypesResult,
    QueryRulesArgs,
    QueryRulesResult,
    QueryReferencesResult,
    GetFileContextResult,
    GetCompletionAtResult,
    DocumentSymbolsResult,
    DocumentSymbolInfo,
    WorkspaceSymbolsResult,
    RuleInfo,
} from '../types';
import { isPathInsideOrEqual } from '../workspaceSandbox';
import { diagnosticMetadata } from './diagnosticMetadata';
import { stripLineNumberPrefixes } from './replacerSuite';
import { diagnosticCodeString, diagnosticMatchesIgnoredKey } from '../../diagnosticI18n';
import { readProjectProfile } from '../projectProfile';

function isAgentTempPath(filePath: string): boolean {
    return /(?:^|[\\/])\.cwtools-ai[\\/](?:tmp|[^\\/]+[\\/]tmp)(?:[\\/]|$)/i.test(filePath);
}

function buildAbsenceWarning(identifier: string): string {
    return `No matches for "${identifier}" are not proof that it is missing. PDX identifiers can live in vanilla cache, localisation, .gui/.gfx/.asset files, generated indexes, or a different AST type. Before declaring it nonexistent, verify with verify_pdx_identifier or at least two independent lookups such as query_definition_by_name, workspace_symbols/query_types, and search_mod_files(searchContext="both").`;
}

function uniqStrings(values: string[]): string[] {
    return Array.from(new Set(values.filter(v => v.trim().length > 0)));
}

function relativeWorkspacePath(workspaceRoot: string, fsPath: string): string {
    return path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
}

function normalizeSearchLine(result: any): number {
    const ranges = Array.isArray(result?.ranges) ? result.ranges : [result?.ranges];
    const range = ranges.find(Boolean);
    if (typeof range?.startLineNumber === 'number') return Math.max(0, range.startLineNumber - 1);
    if (typeof range?.start?.line === 'number') return range.start.line;
    return 0;
}

function isLocalisationDirectory(value?: string): boolean {
    if (!value) return false;
    const normalized = value.replace(/\\/g, '/').toLowerCase();
    return normalized.split('/').some(part =>
        part === 'localisation' ||
        part === 'localisation_synced' ||
        part === 'localization'
    );
}

function isYmlExtension(ext?: string): boolean {
    return (ext ?? '').replace(/^\./, '').toLowerCase() === 'yml';
}

function mentionsYmlPattern(value?: string): boolean {
    return !!value && value.replace(/\\/g, '/').toLowerCase().includes('.yml');
}

function isLocalisationSearch(args: {
    directory?: string;
    path?: string;
    include?: string;
    fileExtension?: string;
    fileExtensions?: string[];
}): boolean {
    return isLocalisationDirectory(args.directory)
        || isLocalisationDirectory(args.path)
        || isLocalisationDirectory(args.include)
        || isYmlExtension(args.fileExtension)
        || !!args.fileExtensions?.some(isYmlExtension)
        || mentionsYmlPattern(args.path)
        || mentionsYmlPattern(args.include);
}

function normalizeWorkspaceIncludeGlob(include?: string): string {
    const trimmed = include?.trim();
    if (!trimmed) return '**/*';

    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized.includes('/')) return normalized;
    if (/^\.[a-z0-9]+$/i.test(normalized)) return `**/*${normalized}`;
    if (/^\*\.[^/]+$/i.test(normalized)) return `**/${normalized}`;
    return normalized;
}

interface RuleDocInfo {
    description: string;
    syntax: string;
    scopes: string[];
    file: string;
    line: number;
}

interface ScopeInfo {
    name: string;
    aliases: string[];
    isSubscopeOf: string[];
    description?: string;
    file: string;
    line: number;
}

interface RuleCapabilityCandidate {
    rule: RuleInfo;
    score: number;
    reasons: string[];
}

interface CwtRuleCache {
    triggers: RuleInfo[];
    effects: RuleInfo[];
    scopeChanges: RuleInfo[];
    modifiers: RuleInfo[];
    scopes: Map<string, ScopeInfo>;
}

// - Context type -

/** Structural type for the properties LspToolHandler reads from the executor. */
export interface LspToolContext {
    readonly workspaceRoot: string;
    readonly indexService?: import('../../indexing/indexService').IndexService;
    /** Agent file write mode from config ('confirm' or 'auto') */
    fileWriteMode?: 'confirm' | 'auto';
    /** Callback when a file write needs user confirmation (confirm mode). */
    onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
    /** Delegate multi_replace_file_content back to FileToolHandler via executor */
    multiReplaceFileContent?: (args: any, context?: any) => Promise<any>;
}

// - Handler class -

export class LspToolHandler {
    private cwtRulesCache: CwtRuleCache | null = null;
    /** 5-second TTL cache for heavy read-only LSP commands */
    private lspReadCache = new Map<string, { data: unknown; expiresAt: number }>();

    /** Invalidate all cached LSP read results for the given file path.
     * Call when a document is modified so the AI doesn't base decisions on stale symbols/diagnostics. */
    invalidateCacheForFile(filePath: string): void {
        const normalized = filePath.replace(/\\/g, '/');
        for (const key of this.lspReadCache.keys()) {
            if (key.includes(normalized)) this.lspReadCache.delete(key);
        }
    }

    // - Concurrency limiter -
    // The CWTools LSP server is single-threaded (F# async event loop).
    // When the AI agent fires many parallel read-only tool calls, flooding it
    // with simultaneous requests causes queue saturation and deadlocks.
    // This semaphore limits in-flight LSP requests to prevent overload.
    private static readonly MAX_CONCURRENT_LSP = 2;
    private lspInFlight = 0;
    private lspQueue: Array<() => void> = [];

    /** Acquire a slot in the LSP concurrency pool. Resolves when a slot is free. */
    private acquireLspSlot(): Promise<void> {
        if (this.lspInFlight < LspToolHandler.MAX_CONCURRENT_LSP) {
            this.lspInFlight++;
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            this.lspQueue.push(resolve);
        });
    }

    /** Release a slot, allowing the next queued request to proceed. */
    private releaseLspSlot(): void {
        const next = this.lspQueue.shift();
        if (next) {
            // Don't decrement - the slot transfers directly to the next waiter
            next();
        } else {
            this.lspInFlight--;
        }
    }

    constructor(
        private ctx: LspToolContext,
        private clientGetter: () => LanguageClient,
        private findFilesFn: (dir: string, ext: string, maxFiles?: number) => string[]
    ) {}

    private get client(): LanguageClient {
        return this.clientGetter();
    }

    // - LSP request with timeout -

    /** Default timeout for LSP requests (ms). */
    private static readonly LSP_TIMEOUT_MS = 10_000;

    /**
     * Send an LSP workspace/executeCommand request with a timeout guard
     * and concurrency control. Only MAX_CONCURRENT_LSP requests can be
     * in-flight simultaneously; additional requests queue up.
     */
    private async lspRequest<T = any>(
        command: string,
        args: unknown[],
        timeoutMs = LspToolHandler.LSP_TIMEOUT_MS,
    ): Promise<T> {
        await this.acquireLspSlot();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancellation = new vs.CancellationTokenSource();
        try {
            const promise = this.client.sendRequest('workspace/executeCommand', {
                command,
                arguments: args,
            }, cancellation.token);
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    cancellation.cancel();
                    reject(new Error(`LSP request "${command}" timed out after ${timeoutMs / 1000}s`));
                }, timeoutMs);
            });
            return await Promise.race([promise, timeout]) as T;
        } finally {
            if (timer) clearTimeout(timer);
            cancellation.dispose();
            this.releaseLspSlot();
        }
    }

    /**
     * Send an LSP request with a timeout and an automatic retry if the first attempt times out.
     * Useful for heavy queries (like queryStaticModifiers) that might time out during
     * the language server's initial load but succeed on a subsequent try.
     */
    private async lspRequestWithRetry<T = any>(
        command: string,
        args: unknown[],
        timeoutMs = 20_000,
    ): Promise<T> {
        try {
            return await this.lspRequest<T>(command, args, timeoutMs);
        } catch (e) {
            if (e instanceof Error && e.message.includes('timed out')) {
                // Retry once
                return await this.lspRequest<T>(command, args, timeoutMs);
            }
            throw e;
        }
    }

    /**
     * Execute a VS Code command with a timeout guard and concurrency control.
     * VS Code's built-in LSP provider commands (executeDocumentSymbolProvider etc.)
     * also route through the language server, so they share the same concurrency pool.
     */
    private async vsCommand<T>(
        command: string,
        args: unknown[],
        timeoutMs = LspToolHandler.LSP_TIMEOUT_MS,
    ): Promise<T | undefined> {
        await this.acquireLspSlot();
        let timer: ReturnType<typeof setTimeout>;
        try {
            const promise = vs.commands.executeCommand<T>(command, ...args);
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(
                    `VS Code command "${command}" timed out after ${timeoutMs / 1000}s`
                )), timeoutMs);
            });
            return await Promise.race([promise, timeout]);
        } finally {
            clearTimeout(timer!);
            this.releaseLspSlot();
        }
    }


    private static readonly LSP_CACHE_MAX_SIZE = 128;

    private async cachedLspRead<T>(key: string, fetcher: () => Promise<T>, ttlMs = 5000): Promise<T> {
        key = key.replace(/\\/g, '/');
        const now = Date.now();
        const cached = this.lspReadCache.get(key);
        if (cached && cached.expiresAt > now) {
            // LRU touch: move to end of Map iteration order
            this.lspReadCache.delete(key);
            this.lspReadCache.set(key, cached);
            return cached.data as T;
        }
        const freshData = await fetcher();
        this.lspReadCache.set(key, { data: freshData, expiresAt: now + ttlMs });
        // Evict oldest entries if over capacity
        while (this.lspReadCache.size > LspToolHandler.LSP_CACHE_MAX_SIZE) {
            const oldest = this.lspReadCache.keys().next().value as string;
            this.lspReadCache.delete(oldest);
        }
        return freshData;
    }

    // - queryScope -

    async queryScope(args: { file: string; line: number; column: number }): Promise<QueryScopeResult> {
        const unknown: QueryScopeResult = {
            currentScope: 'unknown',
            root: 'unknown',
            thisScope: 'unknown',
            prevChain: [],
            fromChain: [],
        };
        try {
            const uri = vs.Uri.file(args.file);

            // Strategy 1: structured LSP command
            try {
                const structResult = await this.vsCommand<any>(
                    'cwtools.executeServerCommand',
                    ['cwtools.ai.getScopeAtPosition', [uri.toString(), args.line, args.column]]
                );
                if (structResult && structResult.ok === true) {
                    return {
                        currentScope: structResult.thisScope ?? 'unknown',
                        root: structResult.root ?? 'unknown',
                        thisScope: structResult.thisScope ?? 'unknown',
                        prevChain: Array.isArray(structResult.prevChain) ? structResult.prevChain : [],
                        fromChain: Array.isArray(structResult.fromChain) ? structResult.fromChain : [],
                    };
                }
            } catch { /* fall through */ }

            // Strategy 2: LanguageClient direct request
            try {
                const raw = await this.lspRequest('cwtools.ai.getScopeAtPosition', [uri.toString(), args.line, args.column]) as any;
                if (raw && raw.ok === true) {
                    return {
                        currentScope: raw.thisScope ?? 'unknown',
                        root: raw.root ?? 'unknown',
                        thisScope: raw.thisScope ?? 'unknown',
                        prevChain: Array.isArray(raw.prevChain) ? raw.prevChain : [],
                        fromChain: Array.isArray(raw.fromChain) ? raw.fromChain : [],
                    };
                }
            } catch { /* fall through */ }

            // Fallback: Hover Markdown parsing
            const position = new vs.Position(args.line, args.column);
            const hovers = await this.vsCommand<vs.Hover[]>(
                'vscode.executeHoverProvider', [uri, position]
            );

            const result = { ...unknown };

            if (hovers && hovers.length > 0) {
                for (const hover of hovers) {
                    for (const content of hover.contents) {
                        const text = typeof content === 'string' ? content :
                            (content as vs.MarkdownString).value;
                        const lines = text.split('\n');
                        for (const line of lines) {
                            const match = line.match(/\|\s*(\w+)\s*\|\s*(\w+)\s*\|/);
                            if (match) {
                                 
                                const ctx = match[1]!;
                                 
                                const scope = match[2]!;
                                if (ctx === 'ROOT') result.root = scope;
                                else if (ctx === 'THIS') {
                                    result.thisScope = scope;
                                    result.currentScope = scope;
                                }
                                else if (ctx.startsWith('PREV')) result.prevChain.push(scope);
                                else if (ctx.startsWith('FROM')) result.fromChain.push(scope);
                            }
                        }
                    }
                }
            }

            return result;
        } catch {
            return unknown;
        }
    }

    // - CWTools Deep API tools -

    private scopeResultFromRaw(raw: any): QueryScopeResult | undefined {
        if (!raw || raw.ok !== true) return undefined;
        return {
            currentScope: raw.thisScope ?? 'unknown',
            root: raw.root ?? 'unknown',
            thisScope: raw.thisScope ?? 'unknown',
            prevChain: Array.isArray(raw.prevChain) ? raw.prevChain : [],
            fromChain: Array.isArray(raw.fromChain) ? raw.fromChain : [],
        };
    }

    private async queryScopeForCompletionContext(args: { file: string; line: number; column: number }): Promise<QueryScopeResult | undefined> {
        const uri = vs.Uri.file(args.file);
        const raw = await this.lspRequest(
            'cwtools.ai.getScopeAtPosition',
            [uri.toString(), args.line, args.column],
            1000,
        ) as any;
        return this.scopeResultFromRaw(raw);
    }

    async queryDefinition(args: { file: string; line: number; column: number }): Promise<unknown> {
        try {
            const uri = vs.Uri.file(args.file);
            const raw = await this.lspRequest('cwtools.ai.queryDefinition', [uri.toString(), args.line, args.column]) as any;
            if (raw && raw.ok === true) return raw;
            return { ok: false, error: 'Definition not found.' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    async queryDefinitionByName(args: { symbolName?: string }): Promise<unknown> {
        const name = args?.symbolName?.trim();
        if (!name) {
            return {
                ok: false,
                error: 'Missing required symbolName argument. Pass an exact symbol name, for example query_definition_by_name({ "symbolName": "kuat_has_psionic_research" }).',
            };
        }
        try {
            const raw = await this.lspRequest('cwtools.ai.queryDefinitionByName', [name]) as any;
            return raw ?? { ok: false, error: 'LSP returned no response.' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    async queryScriptedEffects(args: { filter?: string; limit?: number }): Promise<unknown> {
        const limit = args.limit ?? (args.filter ? 200 : 50);
        const cacheKey = `sfx:${JSON.stringify([args.filter ?? '', limit])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.lspRequestWithRetry('cwtools.ai.queryScriptedEffects', [args.filter ?? '', limit], 20_000) as any;
                if (!args.filter && raw?.ok && Array.isArray(raw.items) && raw.items.length >= limit) {
                    raw._note = `Showing the first ${limit} results. Use the filter argument for a more precise search.`;
                }
                return raw ?? { ok: false, error: 'No response.' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    async queryScriptedTriggers(args: { filter?: string; limit?: number }): Promise<unknown> {
        const limit = args.limit ?? (args.filter ? 200 : 50);
        const cacheKey = `stx:${JSON.stringify([args.filter ?? '', limit])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.lspRequestWithRetry('cwtools.ai.queryScriptedTriggers', [args.filter ?? '', limit], 20_000) as any;
                if (!args.filter && raw?.ok && Array.isArray(raw.items) && raw.items.length >= limit) {
                    raw._note = `Showing the first ${limit} results. Use the filter argument for a more precise search.`;
                }
                return raw ?? { ok: false, error: 'No response.' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    async queryEnums(args: { enumName?: string; limit?: number }): Promise<unknown> {
        const cacheKey = `enm:${JSON.stringify([args.enumName ?? '', args.limit ?? 500])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.lspRequestWithRetry('cwtools.ai.queryEnums', [args.enumName ?? '', args.limit ?? 500], 20_000) as any;
                return raw ?? { ok: false, error: 'No response.' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    async getEntityInfo(args: { file: string }): Promise<unknown> {
        try {
            const uri = vs.Uri.file(args.file);
            const raw = await this.lspRequest('cwtools.ai.getEntityInfo', [uri.toString()]) as any;
            return raw ?? { ok: false, error: 'No response.' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    async queryStaticModifiers(args: { filter?: string; limit?: number }): Promise<unknown> {
        const cacheKey = `smod:${JSON.stringify([args.filter ?? '', args.limit ?? 300])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.lspRequestWithRetry('cwtools.ai.queryStaticModifiers', [args.filter ?? '', args.limit ?? 300], 20_000) as any;
                return raw ?? { ok: false, error: 'No response.' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    async queryVariables(args: { filter?: string }): Promise<unknown> {
        try {
                const raw = await this.lspRequest('cwtools.ai.queryVariables', [args.filter ?? '']) as any;
                return raw ?? { ok: false, error: 'No response.' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    async queryOverrideModes(args: { path?: string; limit?: number }): Promise<unknown> {
        // Response includes `modes` (path-to-strategy), `matched`/`matchedModeInfo` for the
        // longest-prefix path match, and `modeInfo` (full legend: each mode's name+description
        // from the CWT `override_modes_info` block). The raw JSON is passed through unchanged.
        const cacheKey = `overrideModes:${JSON.stringify([args.path ?? '', args.limit ?? 250])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.lspRequest(
                    'cwtools.ai.queryOverrideModes',
                    [args.path ?? '', args.limit ?? 250],
                ) as any;
                return raw ?? { ok: false, error: 'No response.' };
            } catch (e) {
                return { ok: false, error: String(e) };
            }
        });
    }

    // - queryTypes -

    async queryTypes(args: { typeName: string; filter?: string; limit?: number; vanillaOnly?: boolean }): Promise<QueryTypesResult> {
        try {
            const limit = args.limit ?? 50;

            // Strategy 1: structured LSP command (includes vanilla cache)
            try {
                const client = this.client;
                if (client) {
                    const raw = await this.lspRequest('cwtools.ai.queryTypes', [
                        args.typeName,
                        args.filter ?? '',
                        limit,
                        args.vanillaOnly ?? false,
                    ]) as any;
                    if (raw && raw.ok === true) {
                        const instances = Array.isArray(raw.instances)
                            ? raw.instances.map((i: any) => ({
                                id: i.id ?? '',
                                file: i.file
                                    ? (path.isAbsolute(i.file)
                                        ? path.relative(this.ctx.workspaceRoot, i.file).replace(/\\/g, '/')
                                        : i.file)
                                    : '',
                                vanilla: i.vanilla ?? false,
                            }))
                            : [];
                        return {
                            typeName: args.typeName,
                            instances,
                            totalCount: raw.totalCount ?? instances.length,
                        };
                    }
                }
            } catch { /* fall through to file-system scan */ }

            // Fallback: File-system scan of local mod files
            const instances: Array<{ id: string; file: string; vanilla?: boolean }> = [];

            const typeToDir: Record<string, string> = {
                technology: 'common/technology',
                building: 'common/buildings',
                trait: 'common/traits',
                authority: 'common/governments/authorities',
                ethic: 'common/ethics',
                static_modifier: 'common/static_modifiers',
                scripted_modifier: 'common/scripted_modifiers',
                pop_job: 'common/pop_jobs',
                scripted_trigger: 'common/scripted_triggers',
                scripted_effect: 'common/scripted_effects',
                event: 'events',
                decision: 'common/decisions',
                edict: 'common/edicts',
                tradition: 'common/traditions',
                ascension_perk: 'common/ascension_perks',
                civic: 'common/governments/civics',
                origin: 'common/governments/origins',
                species_trait: 'common/species_classes',
                component_template: 'common/component_templates',
            };

            const searchDir = typeToDir[args.typeName];
            if (searchDir) {
                const fullDir = path.join(this.ctx.workspaceRoot, searchDir);
                if (fs.existsSync(fullDir)) {
                    const files = this.findFilesFn(fullDir, '.txt');
                    for (const file of files) {
                        try {
                            const content = fs.readFileSync(file, 'utf-8');
                            const keyPattern = /^(\w[\w.-]*)\s*=/gm;
                            let match;
                            while ((match = keyPattern.exec(content)) !== null && instances.length < limit) {
                                 
                                const id = match[1]!;
                                if (!args.filter || id.includes(args.filter)) {
                                    instances.push({ id, file: path.relative(this.ctx.workspaceRoot, file) });
                                }
                            }
                        } catch { /* skip unreadable files */ }
                    }
                }
            }

            return {
                typeName: args.typeName,
                instances: instances.slice(0, limit),
                totalCount: instances.length,
            };
        } catch {
            return { typeName: args.typeName, instances: [], totalCount: 0 };
        }
    }

    private levenshtein(a: string, b: string): number {
        const matrix: number[][] = [];
        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= a.length; j++) {
            matrix[0]![j] = j;
        }
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i]![j] = matrix[i - 1]![j - 1]!;
                } else {
                    matrix[i]![j] = Math.min(matrix[i - 1]![j - 1]! + 1, Math.min(matrix[i]![j - 1]! + 1, matrix[i - 1]![j]! + 1));
                }
            }
        }
        return matrix[b.length]![a.length]!;
    }

    async queryRules(args: { category: string; name?: string; scope?: string }): Promise<QueryRulesResult> {
        if (!this.cwtRulesCache) {
            this.cwtRulesCache = await this.loadCWTRules();
        }

        const cache = this.cwtRulesCache;
        let rules: RuleInfo[];
        if (args.category === 'trigger') {
            rules = cache.triggers;
        } else if (args.category === 'effect') {
            rules = cache.effects;
        } else if (args.category === 'scope_change') {
            rules = cache.scopeChanges;
        } else if (args.category === 'modifier') {
            rules = cache.modifiers;
        } else {
            rules = [...cache.triggers, ...cache.effects, ...cache.scopeChanges, ...cache.modifiers];
        }

        if (args.name) {
            const filtered = rules.filter(r => r.name.toLowerCase().includes(args.name!.toLowerCase()));
            if (filtered.length === 0 && rules.length > 0) {
                // Fuzzy searching fallback
                const scored = rules.map(r => ({ rule: r, score: this.levenshtein(args.name!.toLowerCase(), r.name.toLowerCase()) }));
                scored.sort((a, b) => a.score - b.score);
                rules = scored.slice(0, 5).map(s => ({
                    ...s.rule,
                    description: `[FUZZY SUGGESTION] Did you mean this? -> Original desc: ${s.rule.description}`
                }));
            } else {
                rules = filtered;
            }
        }
        
        if (args.scope) {
            rules = rules.filter(r =>
                r.scopes.length === 0 ||
                r.scopes.some(s => s.toLowerCase() === args.scope!.toLowerCase() || s.toLowerCase() === 'all' || s.toLowerCase() === 'any')
            );
        }

        return { rules: rules.slice(0, 80), totalCount: rules.length, truncated: rules.length > 80 };
    }

    async searchRuleCapabilities(args: {
        intent?: string;
        category?: QueryRulesArgs['category'] | 'all';
        currentScope?: string;
        desiredPushScope?: string;
        limit?: number;
    }): Promise<{
        status: 'ready';
        candidates: RuleCapabilityCandidate[];
        totalConsidered: number;
        source: string;
        warnings: string[];
    }> {
        if (!this.cwtRulesCache) {
            this.cwtRulesCache = await this.loadCWTRules();
        }
        const cache = this.cwtRulesCache;
        const categories = args.category && args.category !== 'all'
            ? [args.category]
            : ['trigger', 'effect', 'scope_change', 'modifier'] as const;
        const rules = categories.flatMap(category =>
            category === 'trigger' ? cache.triggers
                : category === 'effect' ? cache.effects
                    : category === 'scope_change' ? cache.scopeChanges
                        : cache.modifiers
        );
        const currentScope = args.currentScope?.trim().toLowerCase();
        const desiredPushScope = args.desiredPushScope?.trim().toLowerCase();
        const intentTokens = this.expandIntentTokens(args.intent ?? '');
        const candidates = rules
            .map(rule => this.scoreRuleCapability(rule, intentTokens, currentScope, desiredPushScope))
            .filter(candidate => candidate.score > 0)
            .sort((a, b) => b.score - a.score || a.rule.name.localeCompare(b.rule.name));
        const limit = Math.max(1, Math.min(Number(args.limit ?? 10) || 10, 50));
        return {
            status: 'ready',
            candidates: candidates.slice(0, limit),
            totalConsidered: rules.length,
            source: 'cwtools-node-rules',
            warnings: [
                'semanticHints are retrieval hints only; validate legality with hardFacts, completion, parse/diagnostics, or verified examples.',
            ],
        };
    }

    async explainScope(args: { scope: string }): Promise<{
        status: 'ready' | 'not_found';
        scope: string;
        canonicalName?: string;
        aliases?: string[];
        isSubscopeOf?: string[];
        description?: string;
        source?: { file: string; line: number };
        semanticHints?: NonNullable<RuleInfo['semanticHints']>;
        suggestions?: string[];
        error?: string;
    }> {
        if (!this.cwtRulesCache) {
            this.cwtRulesCache = await this.loadCWTRules();
        }
        const query = args.scope.trim();
        const scope = this.cwtRulesCache.scopes.get(query.toLowerCase());
        if (!scope) {
            const suggestions = Array.from(new Set(Array.from(this.cwtRulesCache.scopes.values()).map(item => item.name)))
                .filter(name => name.toLowerCase().includes(query.toLowerCase()) || this.levenshtein(query.toLowerCase(), name.toLowerCase()) <= 3)
                .slice(0, 10);
            return {
                status: 'not_found',
                scope: query,
                suggestions,
                error: `Scope '${query}' was not found in scopes.cwt.`,
            };
        }
        const detail = [
            scope.description,
            scope.aliases.length ? `aliases: ${scope.aliases.join(', ')}` : '',
            scope.isSubscopeOf.length ? `is_subscope_of: ${scope.isSubscopeOf.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        const semanticHints: NonNullable<RuleInfo['semanticHints']> = detail
            ? [{
                text: `Scope ${scope.name}: ${detail}`,
                source: 'scopes.cwt',
                file: scope.file,
                line: scope.line,
                confidence: 'hint',
            }]
            : [];
        return {
            status: 'ready',
            scope: query,
            canonicalName: scope.name,
            aliases: scope.aliases,
            isSubscopeOf: scope.isSubscopeOf,
            description: scope.description,
            source: { file: scope.file, line: scope.line },
            semanticHints,
        };
    }

    async parsePdxFragment(args: { code: string }): Promise<unknown> {
        const code = String(args.code ?? '');
        if (!code.trim()) {
            return {
                ok: false,
                valid: false,
                fragments: 0,
                errors: [{ line: 0, col: 0, message: 'Provide a non-empty PDXScript fragment.' }],
            };
        }
        try {
            return await this.lspRequest('cwtools.ai.parseFragment', [code], 10_000);
        } catch (e) {
            return {
                ok: false,
                valid: false,
                fragments: 0,
                errors: [{ line: 0, col: 0, message: e instanceof Error ? e.message : String(e) }],
            };
        }
    }

    // - getPdxBlock -

    async getPdxBlock(args: { file: string; symbol: string }, context?: import('../types').AgentToolContext): Promise<{ content: string; truncated: boolean; startLine?: number; endLine?: number; lineNumberBase?: 1; error?: string }> {
        try {
            const symbols = await this.documentSymbols({ file: args.file });
            if (symbols.symbols.length === 0) {
                return { content: `Error: Could not parse symbols in file (or file is empty/invalid).`, truncated: false, error: 'Could not parse symbols in file (or file is empty/invalid).' };
            }

            let targetSymbol: DocumentSymbolInfo | null = null;
            const findSymbol = (syms: DocumentSymbolInfo[]) => {
                for (const sym of syms) {
                    if (sym.name === args.symbol) {
                        targetSymbol = sym;
                        return;
                    }
                    if (sym.children && sym.children.length > 0) {
                        findSymbol(sym.children);
                    }
                }
            };
            findSymbol(symbols.symbols);

            if (!targetSymbol) {
                // Flatten all available symbol names (including children) and include them in the error message to help AI self-service positioning
                const collectNames = (syms: DocumentSymbolInfo[], depth = 0): string[] => {
                    const names: string[] = [];
                    for (const s of syms) {
                        const prefix = depth > 0 ? '  '.repeat(depth) + '- ' : '';
                        names.push(`${prefix}${s.name} (${s.kind}, L${s.range.startLine}-${s.range.endLine})`);
                        if (s.children && s.children.length > 0 && depth < 2) {
                            names.push(...collectNames(s.children, depth + 1));
                        }
                    }
                    return names;
                };
                const allNames = collectNames(symbols.symbols);
                const preview = allNames.slice(0, 30).join('\n');
                const suffix = allNames.length > 30 ? `\n... and ${allNames.length - 30} more` : '';
                return { content: `Error: Symbol '${args.symbol}' not found in file.\n\nAvailable symbols in this file:\n${preview}${suffix}\n\nTry using one of these exact names.`, truncated: false, error: `Symbol '${args.symbol}' not found in file.` };
            }

            const tsym = targetSymbol as DocumentSymbolInfo;
            const content = fs.readFileSync(args.file, 'utf-8');
            const readTracker = (context?.agentRunner as any)?.readTracker;
            if (readTracker) { readTracker.markRead(args.file); }
            const lines = content.split('\n');
            // document_symbols is 0-indexed line numbers
            const slice = lines.slice(tsym.range.startLine, tsym.range.endLine + 1);
            
            let resultText = slice.join('\n');
            const MAX_CHARS = 16000;
            const truncated = resultText.length > MAX_CHARS;
            if (truncated) {
                resultText = resultText.substring(0, MAX_CHARS) + '\n... [Block truncated due to extreme size]';
            }

            return {
                content: resultText,
                truncated,
                startLine: tsym.range.startLine + 1,
                endLine: tsym.range.endLine + 1,
                lineNumberBase: 1,
            };
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { content: `Error reading PDX Block: ${message}`, truncated: false, error: message };
        }
    }

    private async loadCWTRules(): Promise<CwtRuleCache> {
        const triggers: RuleInfo[] = [];
        const effects: RuleInfo[] = [];
        const scopeChanges: RuleInfo[] = [];
        const modifiers: RuleInfo[] = [];

        const configPaths: string[] = [];
        const addConfigPath = (candidate: string | undefined) => {
            if (!candidate?.trim()) return;
            const resolved = path.resolve(candidate);
            const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            if (!configPaths.some(existing => (process.platform === 'win32' ? path.resolve(existing).toLowerCase() : path.resolve(existing)) === key)) {
                configPaths.push(resolved);
            }
        };
        const addRulesRoot = (candidate: string | undefined) => {
            if (!candidate?.trim()) return;
            addConfigPath(candidate);
            addConfigPath(path.join(candidate, 'config'));
        };
        const game = this.resolveRulesGameId() ?? 'stellaris';
        const cwtoolsConfig = vs.workspace.getConfiguration('stellarisLanguageServices');
        const rulesVersion = cwtoolsConfig.get<string>('rules_version', 'latest');
        const customRulesFolder = cwtoolsConfig.get<string>('rules_folder');
        if (rulesVersion === 'manual' && customRulesFolder) {
            addRulesRoot(customRulesFolder);
        }

        addRulesRoot(path.join(this.ctx.workspaceRoot, '.cwtools', game));

        const ext = vs.extensions.getExtension('ForeverSkywalker.foreverskywalker-stellaris-cwtools') ??
            vs.extensions.getExtension('ForeverSkywalker.eddy-stellaris-cwt') ??
            vs.extensions.getExtension('Eddy.eddy-stellaris-cwt') ??
            vs.extensions.getExtension('tboby.cwtools-vscode') ??
            vs.extensions.getExtension('cwtools.cwtools-vscode');
        if (ext) {
            addRulesRoot(path.join(ext.extensionPath, '.cwtools', game));
            if (game === 'stellaris') addConfigPath(path.join(ext.extensionPath, 'config'));
        }

        addRulesRoot(path.join(this.ctx.workspaceRoot, 'release', 'rules', game));
        addRulesRoot(path.join(this.ctx.workspaceRoot, 'submodules', `cwtools-${game}-config`));
        if (game === 'stellaris') addConfigPath(path.join(this.ctx.workspaceRoot, 'submodules', 'cwtools-stellaris-config', 'config'));

        for (const configPath of configPaths) {
            const scopesFile = path.join(configPath, 'scopes.cwt');
            const modifiersLog = path.join(configPath, 'logs', 'modifiers.log');
            const triggerDocsLog = path.join(configPath, 'logs', 'trigger_docs.log');
            
            const docs = fs.existsSync(triggerDocsLog) ? this.parseDocsLog(triggerDocsLog) : new Map<string, RuleDocInfo>();
            const scopes = fs.existsSync(scopesFile) ? this.parseScopesFile(scopesFile) : new Map<string, ScopeInfo>();

            for (const file of ['triggers.cwt', 'trigger.cwt', path.join('generated', 'triggers.generated.cwt')]) {
                const fullPath = path.join(configPath, file);
                if (fs.existsSync(fullPath)) this.parseCWTFile(fullPath, 'trigger', triggers, docs, scopes);
            }
            for (const file of ['effects.cwt', 'effect.cwt', path.join('generated', 'effects.generated.cwt')]) {
                const fullPath = path.join(configPath, file);
                if (fs.existsSync(fullPath)) this.parseCWTFile(fullPath, 'effect', effects, docs, scopes);
            }
            for (const file of ['scope_changes.cwt', path.join('generated', 'scope_changes.generated.cwt')]) {
                const fullPath = path.join(configPath, file);
                if (fs.existsSync(fullPath)) this.parseCWTFile(fullPath, 'scope_change', scopeChanges, docs, scopes);
            }
            if (fs.existsSync(modifiersLog)) { this.parseModifiersLog(modifiersLog, modifiers); }
            if (triggers.length > 0 || effects.length > 0 || scopeChanges.length > 0 || modifiers.length > 0) {
                return { triggers, effects, scopeChanges, modifiers, scopes };
            }
        }

        return { triggers, effects, scopeChanges, modifiers, scopes: new Map<string, ScopeInfo>() };
    }

    private resolveRulesGameId(): string | undefined {
        const profileGame = readProjectProfile(this.ctx.workspaceRoot)?.game?.id;
        if (profileGame && profileGame !== 'unknown') return profileGame.toLowerCase();
        const languageId = vs.window.activeTextEditor?.document.languageId;
        if (languageId && languageId !== 'paradox' && languageId !== 'plaintext') return languageId.toLowerCase();
        return undefined;
    }

    private parseDocsLog(filePath: string): Map<string, RuleDocInfo> {
        const docs = new Map<string, RuleDocInfo>();
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split(/\r?\n/);
            let current: { name: string; description: string; syntaxLines: string[]; line: number } | undefined;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? '';
                const nameMatch = line.match(/^([\w.-]+)\s*-/);
                if (nameMatch) {
                    current = {
                        name: nameMatch[1]!,
                        description: line.slice(nameMatch[0].length).trim(),
                        syntaxLines: [],
                        line: i + 1,
                    };
                    continue;
                }
                const scopeMatch = line.match(/^Supported Scopes:\s*(.*)/);
                if (scopeMatch && current) {
                    docs.set(current.name, {
                        description: current.description,
                        syntax: current.syntaxLines.join('\n').trim(),
                        scopes: this.splitWords(scopeMatch[1]!).filter(s => s !== 'none'),
                        file: filePath,
                        line: current.line,
                    });
                    current = undefined;
                    continue;
                }
                if (current && line.trim().length > 0) {
                    current.syntaxLines.push(line);
                }
            }
        } catch { /* skip */ }
        return docs;
    }

    private parseScopesFile(filePath: string): Map<string, ScopeInfo> {
        const scopes = new Map<string, ScopeInfo>();
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split(/\r?\n/);
            let pendingDescription = '';
            let current: ScopeInfo | undefined;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]!.trim();
                const commentMatch = line.match(/^#+\s*(.+)$/);
                if (commentMatch?.[1] && !line.startsWith('## ')) {
                    pendingDescription = commentMatch[1].trim();
                    continue;
                }

                const scopeMatch = line.match(/^([A-Za-z][\w.-]*)\s*=\s*\{\s*$/);
                if (scopeMatch?.[1]) {
                    current = {
                        name: scopeMatch[1],
                        aliases: [],
                        isSubscopeOf: [],
                        description: pendingDescription || undefined,
                        file: filePath,
                        line: i + 1,
                    };
                    pendingDescription = '';
                    continue;
                }

                if (current) {
                    const aliasesMatch = line.match(/^aliases\s*=\s*\{([^}]*)\}/);
                    if (aliasesMatch?.[1]) current.aliases = this.splitWords(aliasesMatch[1]);
                    const subscopeMatch = line.match(/^is_subscope_of\s*=\s*\{([^}]*)\}/);
                    if (subscopeMatch?.[1]) current.isSubscopeOf = this.splitWords(subscopeMatch[1]);
                    if (line === '}') {
                        if (current.name !== 'types') {
                            scopes.set(current.name.toLowerCase(), current);
                            for (const alias of current.aliases) scopes.set(alias.toLowerCase(), current);
                        }
                        current = undefined;
                    }
                }
            }
        } catch { /* skip */ }
        return scopes;
    }

    private parseModifiersLog(filePath: string, results: RuleInfo[]): void {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            const modifierPattern = /^- ([\w.-]+), Category: (.*)/;
            
            for (const line of lines) {
                const match = line.trim().match(modifierPattern);
                if (match) {
                    results.push({
                        name: match[1]!,
                        description: `Categories: ${match[2]!}`,
                        scopes: [],
                        syntax: match[1]!,
                        category: 'modifier',
                        sourceFile: filePath,
                        hardFacts: {
                            category: 'modifier',
                            syntax: match[1]!,
                            cwtSource: { file: filePath, line: results.length + 1 },
                        },
                        semanticHints: [{
                            text: `Categories: ${match[2]!}`,
                            source: 'modifiers.log',
                            file: filePath,
                            confidence: 'hint',
                        }],
                    });
                }
            }
        } catch { /* skip */ }
    }

    private parseCWTFile(
        filePath: string,
        category: QueryRulesArgs['category'],
        results: RuleInfo[],
        docs: Map<string, RuleDocInfo>,
        scopes: Map<string, ScopeInfo>,
    ): void {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split(/\r?\n/);

            const namePattern = /^alias\[(?:trigger|effect):([\w.-]+)\]\s*=\s*(.*)/;

            let currentScopes: string[] = [];
            let currentSupportedScopes: string[] = [];
            let currentPushScope: string | undefined;
            let currentTypeKeyFilter: string | undefined;
            let currentDesc = '';

            for (let i = 0; i < lines.length; i++) {
                 
                const line = lines[i]!.trim();

                const directiveMatch = line.match(/^##\s*([A-Za-z_]+)\s*=\s*(.*)$/);
                const directive = directiveMatch?.[1]?.toLowerCase();
                const directiveValue = directiveMatch?.[2]?.trim() ?? '';
                if (directive === 'scope') {
                    currentScopes = this.splitRuleValueList(directiveValue);
                    continue;
                }
                if (directive === 'supported_scopes') {
                    currentSupportedScopes = this.splitRuleValueList(directiveValue);
                    continue;
                }
                if (directive === 'push_scope') {
                    currentPushScope = this.stripRuleValueBraces(directiveValue).split(/\s+/)[0];
                    continue;
                }
                if (directive === 'type_key_filter') {
                    currentTypeKeyFilter = this.stripRuleValueBraces(directiveValue).split(/\s+/)[0];
                    continue;
                }

                const scopeMatch = line.match(/^##\s*scope\s*=\s*\{?\s*([^}]*)\}?\s*$/i);
                if (scopeMatch) {
                    currentScopes = this.splitWords(scopeMatch[1]!);
                    continue;
                }

                if (line.startsWith('###')) {
                    currentDesc = line.replace(/^#+\s*/, '').trim();
                    continue;
                }
                if (line.startsWith('## ') && !line.startsWith('## scope')) {
                    const comment = line.substring(3).trim();
                    if (comment && !/^(cardinality|replace_scope)/i.test(comment)) currentDesc = comment;
                    continue;
                }

                const nameMatch = line.match(namePattern);
                if (nameMatch) {
                     
                    const name = nameMatch[1]!;
                     
                    const doc = docs.get(name);
                    const cwtBlockText = this.collectCwtBlockText(lines, i);
                    const scopesForRule = doc?.scopes.length
                        ? doc.scopes
                        : currentSupportedScopes.length
                            ? currentSupportedScopes
                            : currentScopes;
                    const syntax = doc?.syntax || this.normalizeInlineSyntax(name, nameMatch[2]!);
                    const description = doc?.description || currentDesc;
                    const semanticHints = this.buildSemanticHints({
                        description,
                        doc,
                        cwtDescription: currentDesc,
                        scopes,
                        relatedScopeNames: [
                            ...scopesForRule,
                            ...(currentPushScope ? [currentPushScope] : []),
                            ...this.extractScopeNamesFromSyntax(syntax),
                            ...this.extractScopeNamesFromSyntax(cwtBlockText),
                        ],
                        cwtFile: filePath,
                        cwtLine: i + 1,
                    });

                    currentScopes = [];

                    results.push({
                        name,
                        description,
                        scopes: scopesForRule,
                        syntax,
                        category,
                        sourceFile: filePath,
                        sourceLine: i + 1,
                        hardFacts: {
                            category,
                            supportedScopes: scopesForRule,
                            pushScope: currentPushScope,
                            typeKeyFilter: currentTypeKeyFilter,
                            syntax,
                            cwtSource: { file: filePath, line: i + 1 },
                        },
                        semanticHints,
                    });
                    currentSupportedScopes = [];
                    currentPushScope = undefined;
                    currentTypeKeyFilter = undefined;
                    currentDesc = '';
                }
            }
        } catch { /* skip */ }
    }

    private buildSemanticHints(args: {
        description: string;
        doc?: RuleDocInfo;
        cwtDescription: string;
        scopes: Map<string, ScopeInfo>;
        relatedScopeNames: string[];
        cwtFile: string;
        cwtLine: number;
    }): NonNullable<RuleInfo['semanticHints']> {
        const hints: NonNullable<RuleInfo['semanticHints']> = [];
        const seen = new Set<string>();
        const add = (hint: NonNullable<RuleInfo['semanticHints']>[number]) => {
            const key = `${hint.source}:${hint.text}`;
            if (seen.has(key) || !hint.text.trim()) return;
            seen.add(key);
            hints.push(hint);
        };

        if (args.doc?.description) {
            add({
                text: args.doc.description,
                source: 'trigger_docs.log',
                file: args.doc.file,
                line: args.doc.line,
                confidence: 'hint',
            });
        }
        if (args.cwtDescription && args.cwtDescription !== args.doc?.description) {
            add({
                text: args.cwtDescription,
                source: 'cwt-comment',
                file: args.cwtFile,
                line: args.cwtLine,
                confidence: 'hint',
            });
        }

        for (const scopeName of args.relatedScopeNames) {
            const scope = args.scopes.get(scopeName.toLowerCase());
            if (!scope) continue;
            const details = [
                scope.description,
                scope.aliases.length ? `aliases: ${scope.aliases.join(', ')}` : '',
                scope.isSubscopeOf.length ? `is_subscope_of: ${scope.isSubscopeOf.join(', ')}` : '',
            ].filter(Boolean).join('; ');
            if (!details) continue;
            add({
                text: `Scope ${scope.name}: ${details}`,
                source: 'scopes.cwt',
                file: scope.file,
                line: scope.line,
                confidence: 'hint',
            });
        }

        return hints.slice(0, 8);
    }

    private scoreRuleCapability(
        rule: RuleInfo,
        intentTokens: string[],
        currentScope?: string,
        desiredPushScope?: string,
    ): RuleCapabilityCandidate {
        let score = 0;
        const reasons: string[] = [];
        const supportedScopes = rule.hardFacts?.supportedScopes ?? rule.scopes;
        const pushScope = rule.hardFacts?.pushScope?.toLowerCase();
        const searchable = [
            rule.name,
            rule.description,
            rule.syntax,
            ...(rule.semanticHints ?? []).map(hint => hint.text),
        ].join(' ').toLowerCase();
        const ruleName = rule.name.toLowerCase();

        if (currentScope) {
            const matchesScope = supportedScopes.some(scope => {
                const lower = scope.toLowerCase();
                return lower === currentScope || lower === 'all' || lower === 'any';
            });
            if (matchesScope) {
                score += 60;
                reasons.push(`supported in current scope '${currentScope}'`);
            } else if (supportedScopes.length > 0) {
                score -= 20;
            }
        }

        if (desiredPushScope) {
            if (pushScope === desiredPushScope) {
                score += 120;
                reasons.push(`pushes scope to '${desiredPushScope}'`);
            } else if (searchable.includes(desiredPushScope)) {
                score += 15;
                reasons.push(`mentions '${desiredPushScope}'`);
            } else if (rule.category === 'scope_change') {
                score -= 10;
            }
        }

        for (const token of intentTokens) {
            if (token.length <= 1) continue;
            if (ruleName.includes(token)) {
                score += 25;
                reasons.push(`name matches '${token}'`);
            } else if (searchable.includes(token)) {
                score += 8;
            }
        }

        const wantsEvery = intentTokens.some(token => token === 'iterate' || token === 'every' || token === 'all');
        if (wantsEvery) {
            if (ruleName.startsWith('every_')) {
                score += 45;
                reasons.push('matches every/all iteration intent');
            } else if (/^(any|count|random|ordered)_/.test(ruleName)) {
                score -= 15;
            }
        }
        if (
            wantsEvery
            && currentScope === 'fleet'
            && desiredPushScope === 'ship'
            && ruleName.includes('_owned_ship')
            && !intentTokens.includes('controlled')
        ) {
            score += 8;
            reasons.push('preferred default fleet-to-ship iterator variant');
        }
        if (intentTokens.includes('random') && ruleName.startsWith('random_')) {
            score += 20;
            reasons.push('matches random selection intent');
        }
        if (intentTokens.includes('event') && ruleName.endsWith('_event')) {
            score += 20;
            reasons.push('matches event firing intent');
        }
        if (rule.semanticHints?.some(hint => hint.source === 'trigger_docs.log')) {
            score += 3;
        }

        return {
            rule,
            score,
            reasons: Array.from(new Set(reasons)).slice(0, 8),
        };
    }

    private expandIntentTokens(intent: string): string[] {
        const lower = intent.toLowerCase();
        const direct = lower
            .split(/[^a-z0-9_.:-]+/i)
            .map(token => token.trim())
            .filter(Boolean);
        const synonyms: Array<[RegExp, string[]]> = [
            [/舰队|艦隊/g, ['fleet']],
            [/舰船|艦船|飞船|飛船|船只|船\b/g, ['ship']],
            [/国家|國家|帝国|帝國/g, ['country']],
            [/行星|星球/g, ['planet']],
            [/殖民地/g, ['colony']],
            [/航母|载体|載體|承载|承載/g, ['carrier']],
            [/事件/g, ['event']],
            [/遍历|遍歷|每个|每個|所有/g, ['iterate', 'every']],
            [/随机|隨機/g, ['random']],
            [/作用域|范围|範圍/g, ['scope']],
            [/触发器|觸發器/g, ['trigger']],
            [/效果|效应|效應/g, ['effect']],
        ];
        const expanded = [...direct];
        for (const [pattern, tokens] of synonyms) {
            pattern.lastIndex = 0;
            if (pattern.test(intent)) expanded.push(...tokens);
        }
        return Array.from(new Set(expanded));
    }

    private extractScopeNamesFromSyntax(syntax: string): string[] {
        const results: string[] = [];
        for (const match of syntax.matchAll(/<event\.([A-Za-z][\w.-]*)>/g)) {
            if (match[1]) results.push(match[1]);
        }
        return results;
    }

    private collectCwtBlockText(lines: string[], startIndex: number): string {
        const collected: string[] = [];
        let depth = 0;
        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i] ?? '';
            collected.push(line);
            for (const ch of line) {
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
            }
            if (i > startIndex && depth <= 0) break;
        }
        return collected.join('\n');
    }

    private normalizeInlineSyntax(name: string, raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed || trimmed === '{') return `${name} = { ... }`;
        return `${name} = ${trimmed}`;
    }

    private splitRuleValueList(value: string): string[] {
        return this.splitWords(this.stripRuleValueBraces(value));
    }

    private stripRuleValueBraces(value: string): string {
        return value.replace(/^\{\s*/, '').replace(/\s*\}$/, '').trim();
    }

    private splitWords(value: string): string[] {
        return value.split(/\s+/).map(part => part.trim()).filter(Boolean);
    }

    // - queryReferences -

    async queryReferences(args: { identifier: string; file?: string }): Promise<QueryReferencesResult> {
        try {
            // Strategy 1: LSP via workspace_symbols + executeReferenceProvider
            const symbols = await this.vsCommand<vs.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider', [args.identifier]
            );
            if (symbols && symbols.length > 0) {
                const sym = symbols.find(s => s.name === args.identifier) || symbols[0]!;
                const refs = await this.vsCommand<vs.Location[]>(
                    'vscode.executeReferenceProvider',
                    [sym.location.uri, sym.location.range.start]
                );
                if (refs && refs.length > 0) {
                    return {
                        references: refs.slice(0, 50).map(r => ({
                            file: path.relative(this.ctx.workspaceRoot, r.uri.fsPath).replace(/\\/g, '/'),
                            line: r.range.start.line,
                            context: '', // LSP doesn't provide line content natively without opening the document
                        })),
                    };
                }
            }
        } catch { /* fallback to text search */ }

        // Strategy 2: Text search using findTextInFiles via grep
        try {
            const grepRes = await this.grep({
                query: args.identifier,
                path: args.file ? path.relative(this.ctx.workspaceRoot, path.dirname(args.file)) : undefined,
                limit: 50
            });
            return {
                references: grepRes.matches.map(m => ({
                    file: m.file,
                    line: m.line,
                    context: m.content.substring(0, 120)
                }))
            };
        } catch {
            return { references: [] };
        }
    }

    // - getDiagnostics -

    async getLspStatus(args: { timeoutMs?: number } = {}): Promise<import('../types').GetLspStatusResult> {
        const requestedTimeout = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
            ? args.timeoutMs
            : 5000;
        const timeoutMs = Math.max(500, Math.min(requestedTimeout, 30000));
        try {
            const statusResult = await this.lspRequest<Record<string, unknown> | null>(
                'cwtools.ai.getValidationStatus',
                [],
                timeoutMs,
            );
            if (statusResult && typeof statusResult === 'object') {
                return {
                    ...(statusResult as import('../types').ValidationStatusSnapshot),
                    status: 'available',
                    responded: true,
                };
            }
            return {
                ok: false,
                status: 'unavailable',
                responded: false,
                message: 'CWTools validation status command returned no object result.',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                status: /timed out|timeout/i.test(message) ? 'timeout' : 'error',
                responded: false,
                message,
            };
        }
    }

    async getDiagnostics(args: {
        file?: string;
        severity?: 'error' | 'warning' | 'info' | 'hint' | 'all';
        limit?: number;
    }): Promise<import('../types').GetDiagnosticsResult> {
        const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? args.limit
            : 500;
        const limit = Math.max(0, Math.min(Math.floor(requestedLimit), 2000));
        const severityFilter = args.severity && args.severity !== 'all' ? args.severity : null;

        const allPairs = vs.languages.getDiagnostics();
        const activelyIgnoredKeys = new Set<string>();
        const ignored = vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string[]>('ignoredDiagnostics', []);

        const entries: import('../types').DiagnosticEntry[] = [];
        const filesWithDiags = new Set<string>();
        const summary = { errors: 0, warnings: 0, info: 0, hints: 0 };
        let totalDiagCount = 0;
        let ignoredDiagnosticCount = 0;

        const diagnosticSeverity = (d: vs.Diagnostic): 'error' | 'warning' | 'info' | 'hint' =>
            d.severity === vs.DiagnosticSeverity.Error ? 'error'
                : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                    : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint';

        const ignoredKeyForDiagnostic = (d: vs.Diagnostic): string | undefined =>
            ignored.find(key => diagnosticMatchesIgnoredKey(d, key));

        for (const [uri, diags] of allPairs) {
            if (diags.length === 0) continue;

            const fsPath = uri.fsPath;

            if (args.file) {
                const fileNorm = args.file.replace(/\\/g, '/').toLowerCase();
                const pathNorm = fsPath.replace(/\\/g, '/').toLowerCase();
                if (!pathNorm.includes(fileNorm)) continue;
            }

            if (isAgentTempPath(fsPath)) continue;

            for (const d of diags) {
                const sev = diagnosticSeverity(d);

                if (severityFilter && sev !== severityFilter) continue;

                const ignoredKey = ignoredKeyForDiagnostic(d);
                if (ignoredKey) {
                    ignoredDiagnosticCount++;
                    activelyIgnoredKeys.add(ignoredKey);
                    continue;
                }

                totalDiagCount++;
                filesWithDiags.add(fsPath);
                if (sev === 'error') summary.errors++;
                else if (sev === 'warning') summary.warnings++;
                else if (sev === 'info') summary.info++;
                else summary.hints++;

                if (entries.length < limit) {
                    const metadata = diagnosticMetadata(d);
                    entries.push({
                        file: fsPath,
                        logicalPath: path.relative(this.ctx.workspaceRoot, fsPath).replace(/\\/g, '/'),
                        severity: sev,
                        message: d.message,
                        line: d.range.start.line,
                        column: d.range.start.character,
                        code: diagnosticCodeString(d.code),
                        category: metadata.category,
                        repairHint: metadata.repairHint,
                        expectedType: metadata.expectedType,
                        actualType: metadata.actualType,
                        scope: metadata.scope,
                        symbol: metadata.symbol,
                        confidence: metadata.confidence,
                        metadataSource: metadata.metadataSource,
                        data: metadata.data,
                    });
                }
            }
        }

        if (activelyIgnoredKeys.size > 0 && entries.length < limit) {
            entries.push({
                file: 'system',
                logicalPath: 'system',
                severity: 'hint',
                message: `The following diagnostic keys were matched and suppressed by the user's whitelist during this check: [${Array.from(activelyIgnoredKeys).join(', ')}]. If you suspect the user has erroneously ignored a true typo that is causing issues, call remove_ignored_diagnostic to ask them to remove it.`,
                line: 0,
                column: 0,
                code: 'SYSTEM_WHITELIST_INFO'
            });
        }

        // Query the global diagnostic freshness status. This is metadata only:
        // Problems-panel diagnostics above remain the fact source even if this
        // status request times out.
        let freshness: 'fresh' | 'pending' | 'stale' = 'pending';
        let pendingGlobalKinds: string[] = [];
        let lastEpoch = 0;
        let validationStatus: import('../types').GetDiagnosticsResult['validationStatus'] = undefined;
        let diagnosticService: import('../types').GetDiagnosticsResult['diagnosticService'] = {
            status: 'unavailable',
            responded: false,
            message: 'CWTools validation status request was not attempted.',
        };
        try {
            const client = this.clientGetter();
            if (client) {
                const statusResult = await this.lspRequest<Record<string, unknown> | null>(
                    'cwtools.ai.getValidationStatus',
                    [],
                    2000,
                );
                diagnosticService = {
                    status: 'available',
                    responded: true,
                };
                if (statusResult && typeof statusResult === 'object') {
                    validationStatus = statusResult as import('../types').ValidationStatusSnapshot;
                    freshness = (statusResult.freshness as any) || 'pending';
                    pendingGlobalKinds = Array.isArray(statusResult.pendingGlobalKinds)
                        ? statusResult.pendingGlobalKinds as string[] : [];
                    lastEpoch = typeof statusResult.epoch === 'number' ? statusResult.epoch : 0;
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            diagnosticService = {
                status: /timed out|timeout/i.test(message) ? 'timeout' : 'error',
                responded: false,
                message,
            };
        }

        return {
            summary,
            diagnostics: entries,
            totalFiles: filesWithDiags.size,
            totalDiagnosticCount: totalDiagCount,
            truncated: totalDiagCount > limit,
            ignoredDiagnosticCount,
            ignoredDiagnosticKeys: Array.from(activelyIgnoredKeys),
            freshness,
            pendingGlobalKinds,
            lastEpoch,
            validationStatus,
            diagnosticService,
        };
    }

    // - getFileContext -

    async getFileContext(args: { file: string; line: number; radius?: number }, context?: import('../types').AgentToolContext): Promise<GetFileContextResult> {
        const radius = args.radius ?? 20;
        try {
            const content = fs.readFileSync(args.file, 'utf-8');
            const readTracker = (context?.agentRunner as any)?.readTracker;
            if (readTracker) { readTracker.markRead(args.file); }
            const lines = content.split('\n');
            const startLine = Math.max(0, args.line - radius);
            const endLine = Math.min(lines.length - 1, args.line + radius);
            const contextLines = lines.slice(startLine, endLine + 1);

            const relPath = path.relative(this.ctx.workspaceRoot, args.file).replace(/\\/g, '/');
            let fileType = 'unknown';
            if (relPath.startsWith('events/')) fileType = 'events';
            else if (relPath.startsWith('common/')) {
                const parts = relPath.split('/');
                fileType = parts.length >= 2 ? `common/${parts[1]}` : 'common';
            }
            else if (relPath.startsWith('localisation')) fileType = 'localisation';

            return {
                code: contextLines.map((line, idx) => `${startLine + idx + 1} | ${line}`).join('\n'),
                fileType,
                startLine: startLine + 1,
                endLine: endLine + 1,
                lineNumberBase: 1,
            };
        } catch (e) {
            return { code: '', fileType: 'unknown', error: e instanceof Error ? e.message : String(e) };
        }
    }

    async searchModFiles(args: import('../types').SearchModFilesArgs): Promise<import('../types').SearchModFilesResult> {
        const limit = Math.min(args.limit ?? 30, 50);
        const results: import('../types').SearchModFilesResult['files'] = [];
        const ctxStr = args.searchContext || 'mod';
        const workspaceFolders = vs.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [this.ctx.workspaceRoot];
        const searchedRoots: string[] = [];
        let limitReached = false;

        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        if (ctxStr === 'mod' || ctxStr === 'both') {
            searchedRoots.push(...workspaceFolders);
            const localisationSearch = isLocalisationSearch(args);
            const pattern = args.isRegex ? args.query : escapeRegex(args.query);
            let finalPattern = pattern;
            if (args.exactMatch) {
                finalPattern = `\\b${pattern}\\b`;
            }

            const query: any = {
                pattern: finalPattern,
                isRegExp: true,
                isCaseSensitive: args.caseSensitive ?? false,
                isWordMatch: false, // handled by regex boundary
            };

            let includeGlob = '';
            if (args.fileExtensions && args.fileExtensions.length > 0) {
                const exts = args.fileExtensions.map(e => e.replace(/^\./, ''));
                includeGlob = exts.length === 1 ? `**/*.${exts[0]}` : `**/*.{${exts.join(',')}}`;
            } else {
                includeGlob = `**/*${args.fileExtension || (localisationSearch ? '.yml' : '.txt')}`;
            }

            if (args.directory) {
                const normalizedDirectory = args.directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                includeGlob = `${normalizedDirectory}/${includeGlob}`;
            }

            const options: any = {
                include: new vs.RelativePattern(this.ctx.workspaceRoot, includeGlob),
                maxResults: limit * 10,
                previewOptions: { matchLines: 1, charsPerLine: 120 },
            };

            // Strategy 1: Try native findTextInFiles, but do not trust it as the
            // only source because VS Code versions differ in result/range shapes.
            const fileMatches = new Map();
            const mergeFileResult = (fsPath: string, matchingLines: Array<{ line: number; content: string }>) => {
                if (matchingLines.length === 0) return;
                const logicalPath = relativeWorkspacePath(this.ctx.workspaceRoot, fsPath);
                let existing = results.find(item => item.logicalPath === logicalPath);
                if (!existing) {
                    if (results.length >= limit) {
                        limitReached = true;
                        return;
                    }
                    existing = { logicalPath, matchingLines: [] };
                    results.push(existing);
                }
                const seen = new Set(existing.matchingLines.map(line => `${line.line}:${line.content}`));
                for (const line of matchingLines) {
                    const key = `${line.line}:${line.content}`;
                    if (!seen.has(key) && existing.matchingLines.length < 10) {
                        existing.matchingLines.push(line);
                        seen.add(key);
                    }
                }
            };

            if (typeof (vs.workspace as any).findTextInFiles === 'function') {
                try {
                    await (vs.workspace as any).findTextInFiles(query, options, (result: any) => {
                        if (fileMatches.size >= limit && !fileMatches.has(result.uri.fsPath)) {
                            limitReached = true;
                            return;
                        }
                        if (!fileMatches.has(result.uri.fsPath)) {
                            fileMatches.set(result.uri.fsPath, []);
                        }
                        const arr = fileMatches.get(result.uri.fsPath);
                        if (arr.length < 10) {
                            arr.push({
                                line: normalizeSearchLine(result),
                                content: String(result.preview?.text ?? '').trim()
                            });
                        }
                    });

                    for (const [fsPath, matchingLines] of fileMatches.entries()) {
                        mergeFileResult(fsPath, matchingLines);
                    }
                } catch {
                    // findTextInFiles unavailable or broken
                }
            }

            // Strategy 2: Fallback - findFiles + manual regex scan (VSCode 1.95+)
            if (results.length < limit) {
                try {
                    const globPattern = new vs.RelativePattern(this.ctx.workspaceRoot, includeGlob);
                    const uris = await vs.workspace.findFiles(globPattern, '**/node_modules/**', limit * 20);
                    const regex = new RegExp(finalPattern, args.caseSensitive ? '' : 'i');

                    const CHUNK_SIZE = 30;
                    for (let i = 0; i < uris.length; i += CHUNK_SIZE) {
                        if (results.length >= limit) { limitReached = true; break; }
                        const chunk = uris.slice(i, i + CHUNK_SIZE);
                        await Promise.all(chunk.map(async (uri) => {
                            if (results.length >= limit) return;
                            try {
                                const fileContent: string = await fs.promises.readFile(uri.fsPath, 'utf-8');
                                if (!regex.test(fileContent)) return;
                                regex.lastIndex = 0;

                                const fLines = fileContent.split('\n');
                                const matchingLines = [];
                                for (let j = 0; j < fLines.length; j++) {
                                    const lineStr = fLines[j]!;
                                    if (regex.test(lineStr)) {
                                        regex.lastIndex = 0;
                                        matchingLines.push({ line: j, content: lineStr.trim().substring(0, 120) });
                                    }
                                    if (matchingLines.length >= 10) break;
                                }

                                if (matchingLines.length > 0 && results.length < limit) {
                                    mergeFileResult(uri.fsPath, matchingLines);
                                } else if (results.length >= limit) {
                                    limitReached = true;
                                }
                            } catch { /* skip unreadable */ }
                        }));
                    }
                } catch { /* skip */ }
            }

            // Strategy 3: localisation index fallback. This catches common cases
            // where the agent knows only a key prefix/fragment, or VS Code text
            // search misses YML files due to glob/API differences.
            if (localisationSearch && results.length < limit && this.ctx.indexService && !args.isRegex) {
                let entries = this.ctx.indexService.queryLocalisation({
                    key: args.query,
                    contains: !args.exactMatch,
                    prefix: !args.exactMatch,
                    caseSensitive: args.caseSensitive ?? false,
                    limit: Math.max(limit * 10, 50),
                });
                if (entries.length === 0 && args.exactMatch) {
                    entries = this.ctx.indexService.queryLocalisation({
                        key: args.query,
                        contains: true,
                        caseSensitive: args.caseSensitive ?? false,
                        limit: Math.max(limit * 10, 50),
                    });
                }
                const byFile = new Map<string, Array<{ line: number; content: string }>>();
                for (const entry of entries) {
                    if (results.length + byFile.size >= limit && !byFile.has(entry.file)) {
                        limitReached = true;
                        break;
                    }
                    const arr = byFile.get(entry.file) ?? [];
                    if (arr.length < 10) {
                        arr.push({
                            line: Math.max(0, entry.line - 1),
                            content: `${entry.key}:0 "${entry.value}"`.substring(0, 120),
                        });
                    }
                    byFile.set(entry.file, arr);
                }
                for (const [file, matchingLines] of byFile.entries()) {
                    mergeFileResult(file, matchingLines);
                }
            }
        }

        if (ctxStr === 'vanilla' || ctxStr === 'both') {
            const cwtoolsConfig = vs.workspace.getConfiguration('stellarisLanguageServices');
            const vanillaStellaris = cwtoolsConfig.get<string>('cache.stellaris');
            const vanillaMods = [vanillaStellaris].filter(Boolean) as string[];
            
            const vanillaRoots: string[] = [];
            for (const vMod of vanillaMods) {
                if (args.directory) {
                    const candidate = path.join(vMod, args.directory);
                    if (fs.existsSync(candidate)) vanillaRoots.push(candidate);
                } else if (fs.existsSync(vMod)) {
                    vanillaRoots.push(vMod);
                }
            }
            searchedRoots.push(...vanillaRoots);

            const exts = args.fileExtensions ?? [args.fileExtension ?? '.txt'];
            const queryLower = args.query.toLowerCase();
            let exactRegex: RegExp | null = null;
            
            const pattern = args.isRegex ? args.query : escapeRegex(args.query);
            let finalPattern = pattern;
            if (args.exactMatch) {
                finalPattern = `\\b${pattern}\\b`;
            }
            try {
                exactRegex = new RegExp(finalPattern, args.caseSensitive ? '' : 'i');
            } catch {
                exactRegex = new RegExp(escapeRegex(args.query), 'i');
            }

            for (const searchRoot of vanillaRoots) {
                try {
                    const files: string[] = [];
                    for (const ext of exts) {
                        files.push(...this.findFilesFn(searchRoot, ext, 1000));
                    }
                    
                    const CHUNK_SIZE = 50;
                    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
                        if (results.length >= limit) { limitReached = true; break; }
                        
                        const chunk = files.slice(i, i + CHUNK_SIZE);
                        await Promise.all(chunk.map(async (file) => {
                            if (results.length >= limit) { limitReached = true; return; }
                            try {
                                const content = await fs.promises.readFile(file, 'utf-8');
                                if (!args.isRegex && !args.caseSensitive && !args.exactMatch) {
                                    if (!content.toLowerCase().includes(queryLower)) return;
                                } else {
                                    if (exactRegex && !exactRegex.test(content)) return;
                                }

                                const lines = content.split('\n');
                                const matchingLines: Array<{ line: number; content: string }> = [];
                                for (let j = 0; j < lines.length; j++) {
                                    const lineStr = lines[j]!;
                                    if (!args.isRegex && !args.caseSensitive && !args.exactMatch) {
                                        if (lineStr.toLowerCase().includes(queryLower)) {
                                            matchingLines.push({ line: j, content: lineStr.trim().substring(0, 120) });
                                        }
                                    } else if (exactRegex) {
                                        if (exactRegex.test(lineStr)) {
                                            matchingLines.push({ line: j, content: lineStr.trim().substring(0, 120) });
                                        }
                                    }
                                    if (matchingLines.length >= 10) break;
                                }
                                
                                if (results.length < limit) {
                                    results.push({
                                        logicalPath: path.relative(searchRoot, file).replace(/\\/g, '/'),
                                        matchingLines,
                                    });
                                } else {
                                    limitReached = true;
                                }
                            } catch { /* skip unreadable */ }
                        }));
                    }
                } catch { /* skip inaccessible dirs */ }
            }
        }

        const returnObj: any = {
            files: results,
            searchedRoot: searchedRoots.join(', '),
            totalFound: results.length,
        };
        if (results.length === 0) {
            returnObj._warning = buildAbsenceWarning(args.query);
            returnObj._nextSteps = [
                'For a PDX ID or key, call verify_pdx_identifier(identifier=...) before treating it as missing.',
                'If you only searched mod files, retry with searchContext="both" or the likely vanilla/localisation extension.',
                'For event/scripted trigger/effect/type definitions, prefer query_definition_by_name, workspace_symbols, or query_types.',
            ];
        }
        if (limitReached) {
            returnObj._warning = `[CRITICAL TRUNCATION] Truncation: The output limit of ${limit} files has been reached. The remaining matching files (which may contain hundreds) have been forcibly discarded to protect the large model context! Please narrow your search using the more precise \`query\` or \`directory\` parameters.`;
        }
        returnObj._hint = "Found what you need? If the match is in a PDX Script (.txt), do not use read_file. Use document_symbols to find its boundaries, then get_pdx_block to read it, or edit_pdx_block to replace it directly.";
        return returnObj as import('../types').SearchModFilesResult;
    }

    async findSpriteCandidates(args: import('../types').FindSpriteCandidatesArgs): Promise<import('../types').FindSpriteCandidatesResult> {
        const limit = Math.min(args.limit ?? 20, 50);
        const ctxStr = args.searchContext || 'both';
        const searchedRoots: string[] = [];
        const candidates: import('../types').FindSpriteCandidatesResult['candidates'] = [];
        const seen = new Set<string>();

        const deriveTerms = (): string[] => {
            const raw = [
                args.query ?? '',
                args.currentValue ?? '',
                args.fieldName ?? '',
            ].join(' ');
            const normalized = raw
                .replace(/\bGFX\b/gi, ' ')
                .replace(/\bevt\b/gi, ' event ')
                .replace(/[^A-Za-z0-9]+/g, ' ')
                .toLowerCase();
            const stop = new Set(['gfx', 'sprite', 'type', 'picture', 'icon', 'image', 'event', 'evt']);
            return uniqStrings(normalized.split(/\s+/)
                .map(t => t.trim())
                .filter(t => t.length >= 3 && !stop.has(t)));
        };

        const terms = deriveTerms();
        const query = args.query?.trim() || args.currentValue?.trim() || terms.join(' ') || '';
        const field = (args.fieldName ?? '').toLowerCase();
        const currentLower = (args.currentValue ?? '').toLowerCase();
        const directName = args.currentValue?.match(/\bGFX_[A-Za-z0-9_.-]+\b/)?.[0];

        const addCandidate = (candidate: import('../types').FindSpriteCandidatesResult['candidates'][number]) => {
            const key = `${candidate.source}|${candidate.name.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push(candidate);
        };

        const scoreCandidate = (name: string, textureFile: string | undefined, source: 'mod' | 'vanilla'): { score: number; matchedBy: string[] } => {
            const matchedBy: string[] = [];
            let score = source === 'mod' ? 40 : 20;
            if (directName && name.toLowerCase() === directName.toLowerCase()) {
                score += 120;
                matchedBy.push('exact-current-value');
            } else if (currentLower && name.toLowerCase().includes(currentLower.replace(/^gfx_/, ''))) {
                score += 40;
                matchedBy.push('current-value-fragment');
            }
            for (const term of terms) {
                if (name.toLowerCase().includes(term)) {
                    score += 18;
                    matchedBy.push(`name:${term}`);
                } else if (textureFile?.toLowerCase().includes(term)) {
                    score += 8;
                    matchedBy.push(`texture:${term}`);
                }
            }
            if (field === 'picture') {
                if (/\bGFX_evt_/i.test(name) || /event_pictures|event|anomal/i.test(textureFile ?? '')) score += 35;
                if (/icons?\/|interface\/icons?|button|modifier/i.test(textureFile ?? '')) score -= 30;
            } else if (field === 'icon') {
                if (/icons?\/|interface\/icons?|modifier|technology|tradition/i.test(textureFile ?? '')) score += 25;
            }
            return { score, matchedBy: uniqStrings(matchedBy) };
        };

        if (ctxStr === 'mod' || ctxStr === 'both') {
            await this.ctx.indexService?.ensureWorkspaceSymbolsReady?.({ includeVanilla: false });
            const indexed = this.ctx.indexService?.queryWorkspaceSymbols({
                name: directName || (terms.length > 0 ? terms[0] : undefined),
                kind: 'sprite',
                source: 'asset',
                origin: 'workspace',
                includeReferences: true,
                limit: limit * 5,
            }) ?? [];
            if (indexed.length > 0) {
                searchedRoots.push('IndexService:workspaceSymbolIndex');
            }
            for (const entry of indexed) {
                const textureFile = entry.references?.find(ref => /texturefile/i.test(ref.context))?.context;
                const { score, matchedBy } = scoreCandidate(entry.name, textureFile, 'mod');
                addCandidate({
                    name: entry.name,
                    source: 'mod',
                    file: path.relative(this.ctx.workspaceRoot, entry.file).replace(/\\/g, '/'),
                    line: entry.line,
                    textureFile,
                    spriteType: entry.container,
                    score: score + 15,
                    matchedBy: uniqStrings([...matchedBy, 'workspace-index']),
                });
            }
        }

        if (ctxStr === 'vanilla' || ctxStr === 'both') {
            await this.ctx.indexService?.ensureWorkspaceSymbolsReady?.({ includeVanilla: true });
            const indexed = this.ctx.indexService?.queryWorkspaceSymbols({
                name: directName || (terms.length > 0 ? terms[0] : undefined),
                kind: 'sprite',
                source: 'asset',
                origin: 'vanilla',
                includeReferences: true,
                limit: limit * 5,
            }) ?? [];
            if (indexed.length > 0) {
                searchedRoots.push('IndexService:vanillaSymbolIndex');
            }
            for (const entry of indexed) {
                const textureFile = entry.references?.find(ref => /texturefile/i.test(ref.context))?.context;
                const { score, matchedBy } = scoreCandidate(entry.name, textureFile, 'vanilla');
                addCandidate({
                    name: entry.name,
                    source: 'vanilla',
                    file: entry.file,
                    line: entry.line,
                    textureFile,
                    spriteType: entry.container,
                    score: score + 15,
                    matchedBy: uniqStrings([...matchedBy, 'vanilla-index']),
                });
            }
        }

        const extractSprites = (content: string, file: string, source: 'mod' | 'vanilla', root: string) => {
            const blockRegex = /\b([A-Za-z0-9_]*spriteType)\s*=\s*\{([\s\S]*?)\n\s*\}/gi;
            let match: RegExpExecArray | null;
            while ((match = blockRegex.exec(content)) !== null) {
                const spriteType = match[1] ?? 'spriteType';
                const block = match[2] ?? '';
                const nameMatch = block.match(/\bname\s*=\s*"?([A-Za-z0-9_.-]+)"?/i);
                if (!nameMatch) continue;
                const name = nameMatch[1]!;
                if (!/^GFX_/i.test(name)) continue;
                const textureMatch = block.match(/\btexturefile\s*=\s*"([^"]+)"/i)
                    ?? block.match(/\btextureFile\s*=\s*"([^"]+)"/i);
                const textureFile = textureMatch?.[1];
                const { score, matchedBy } = scoreCandidate(name, textureFile, source);
                const hasDirectOrTermMatch = matchedBy.length > 0 || terms.length === 0 || (directName && name.toLowerCase() === directName.toLowerCase());
                if (!hasDirectOrTermMatch) continue;
                const before = content.slice(0, match.index);
                const line = before.split(/\r?\n/).length;
                const logicalPath = source === 'mod'
                    ? path.relative(this.ctx.workspaceRoot, file).replace(/\\/g, '/')
                    : path.relative(root, file).replace(/\\/g, '/');
                addCandidate({
                    name,
                    source,
                    file: logicalPath,
                    line,
                    textureFile,
                    spriteType,
                    score,
                    matchedBy,
                });
            }
        };

        const collectModRoots = (): string[] => {
            if (ctxStr !== 'mod' && ctxStr !== 'both') return [];
            const workspaceRoots = vs.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
            const roots = workspaceRoots.length > 0 ? workspaceRoots : [this.ctx.workspaceRoot];
            searchedRoots.push(...roots);
            return roots;
        };

        const collectVanillaRoots = (): string[] => {
            if (ctxStr !== 'vanilla' && ctxStr !== 'both') return [];
            const cwtoolsConfig = vs.workspace.getConfiguration('stellarisLanguageServices');
            const vanillaStellaris = cwtoolsConfig.get<string>('cache.stellaris');
            const roots = [vanillaStellaris].filter((r): r is string => !!r && fs.existsSync(r));
            searchedRoots.push(...roots);
            return roots;
        };

        const scanRoot = async (root: string, source: 'mod' | 'vanilla', maxFiles: number) => {
            const interfaceRoot = path.join(root, 'interface');
            const gfxRoot = path.join(root, 'gfx');
            const searchRoots = uniqStrings([
                fs.existsSync(interfaceRoot) ? interfaceRoot : '',
                fs.existsSync(gfxRoot) ? gfxRoot : '',
                root,
            ]);
            const files: string[] = [];
            for (const searchRoot of searchRoots) {
                files.push(...this.findFilesFn(searchRoot, '.gfx', Math.max(1, Math.floor(maxFiles / searchRoots.length))));
            }
            for (const file of uniqStrings(files).slice(0, maxFiles)) {
                if (candidates.length >= limit * 5) break;
                try {
                    const content = await fs.promises.readFile(file, 'utf-8');
                    const lower = content.toLowerCase();
                    const quickTerms = directName ? [directName.toLowerCase(), ...terms] : terms;
                    if (quickTerms.length > 0 && !quickTerms.some(t => lower.includes(t))) continue;
                    extractSprites(content, file, source, root);
                } catch { /* skip unreadable */ }
            }
        };

        for (const root of collectModRoots()) {
            await scanRoot(root, 'mod', 500);
        }
        for (const root of collectVanillaRoots()) {
            await scanRoot(root, 'vanilla', 1200);
        }

        const sorted = candidates
            .sort((a, b) => b.score - a.score || (a.source === 'mod' ? -1 : 1) || a.name.localeCompare(b.name))
            .slice(0, limit);

        const result: import('../types').FindSpriteCandidatesResult = {
            query,
            candidates: sorted,
            searchedRoots: uniqStrings(searchedRoots),
            _hint: 'Use a returned name as the value for sprite-typed fields. For event `picture = ...`, prefer event-picture candidates such as GFX_evt_* and do not replace it with a raw .dds path.',
        };
        if (sorted.length === 0) {
            result._warning = `No sprite candidates found for "${query}". Retry with broader semantic terms (for example anomaly, archaeology, situation, relic, event) and searchContext="both" before creating or guessing a GFX name.`;
        }
        return result;
    }

    async findSoundCandidates(args: import('../types').FindSoundCandidatesArgs): Promise<import('../types').FindSoundCandidatesResult> {
        const limit = Math.min(args.limit ?? 20, 50);
        const ctxStr = args.searchContext || 'both';
        const searchedRoots: string[] = [];
        const candidates: import('../types').FindSoundCandidatesResult['candidates'] = [];
        const seen = new Set<string>();

        const deriveTerms = (): string[] => {
            const raw = [
                args.query ?? '',
                args.currentValue ?? '',
                args.fieldName ?? '',
            ].join(' ');
            const normalized = raw
                .replace(/[^A-Za-z0-9]+/g, ' ')
                .toLowerCase();
            const stop = new Set(['sound', 'show', 'music', 'asset', 'event', 'audio', 'snd']);
            return uniqStrings(normalized.split(/\s+/)
                .map(t => t.trim())
                .filter(t => t.length >= 3 && !stop.has(t)));
        };

        const terms = deriveTerms();
        const query = args.query?.trim() || args.currentValue?.trim() || terms.join(' ') || '';
        const field = (args.fieldName ?? '').toLowerCase();
        const currentValue = (args.currentValue ?? '').replace(/^"|"$/g, '');
        const currentLower = currentValue.toLowerCase();

        const scoreCandidate = (name: string, fileRef: string | undefined, assetType: string | undefined, source: 'mod' | 'vanilla') => {
            const matchedBy: string[] = [];
            let score = source === 'mod' ? 40 : 20;
            if (currentLower && name.toLowerCase() === currentLower) {
                score += 120;
                matchedBy.push('exact-current-value');
            } else if (currentLower && name.toLowerCase().includes(currentLower)) {
                score += 35;
                matchedBy.push('current-value-fragment');
            }
            for (const term of terms) {
                if (name.toLowerCase().includes(term)) {
                    score += 18;
                    matchedBy.push(`name:${term}`);
                } else if (fileRef?.toLowerCase().includes(term)) {
                    score += 8;
                    matchedBy.push(`file:${term}`);
                }
            }
            if (/show_sound|sound/.test(field)) {
                if (/\.wav\b|sfx|event|ui|interface/i.test(fileRef ?? '')) score += 15;
                if (/music|\.ogg\b/i.test(fileRef ?? '') && field === 'show_sound') score -= 8;
            }
            return { score, matchedBy: uniqStrings(matchedBy) };
        };

        const addCandidate = (candidate: import('../types').FindSoundCandidatesResult['candidates'][number]) => {
            const key = `${candidate.source}|${candidate.name.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push(candidate);
        };

        if (ctxStr === 'mod' || ctxStr === 'both') {
            await this.ctx.indexService?.ensureWorkspaceSymbolsReady?.({ includeVanilla: false });
            const indexed = this.ctx.indexService?.queryWorkspaceSymbols({
                name: currentLower || (terms.length > 0 ? terms[0] : undefined),
                kind: 'sound',
                source: 'asset',
                origin: 'workspace',
                includeReferences: true,
                limit: limit * 5,
            }) ?? [];
            if (indexed.length > 0) {
                searchedRoots.push('IndexService:workspaceSymbolIndex');
            }
            for (const entry of indexed) {
                const fileRef = entry.references?.find(ref => /\bfiles?\s*=/i.test(ref.context))?.context;
                const { score, matchedBy } = scoreCandidate(entry.name, fileRef, entry.container, 'mod');
                addCandidate({
                    name: entry.name,
                    source: 'mod',
                    file: path.relative(this.ctx.workspaceRoot, entry.file).replace(/\\/g, '/'),
                    line: entry.line,
                    assetType: entry.container,
                    fileRef,
                    score: score + 15,
                    matchedBy: uniqStrings([...matchedBy, 'workspace-index']),
                });
            }
        }

        if (ctxStr === 'vanilla' || ctxStr === 'both') {
            await this.ctx.indexService?.ensureWorkspaceSymbolsReady?.({ includeVanilla: true });
            const indexed = this.ctx.indexService?.queryWorkspaceSymbols({
                name: currentLower || (terms.length > 0 ? terms[0] : undefined),
                kind: 'sound',
                source: 'asset',
                origin: 'vanilla',
                includeReferences: true,
                limit: limit * 5,
            }) ?? [];
            if (indexed.length > 0) {
                searchedRoots.push('IndexService:vanillaSymbolIndex');
            }
            for (const entry of indexed) {
                const fileRef = entry.references?.find(ref => /\bfiles?\s*=/i.test(ref.context))?.context;
                const { score, matchedBy } = scoreCandidate(entry.name, fileRef, entry.container, 'vanilla');
                addCandidate({
                    name: entry.name,
                    source: 'vanilla',
                    file: entry.file,
                    line: entry.line,
                    assetType: entry.container,
                    fileRef,
                    score: score + 15,
                    matchedBy: uniqStrings([...matchedBy, 'vanilla-index']),
                });
            }
        }

        const extractAssets = (content: string, file: string, source: 'mod' | 'vanilla', root: string) => {
            const blockRegex = /\b([A-Za-z0-9_]*(?:sound|music)[A-Za-z0-9_]*|soundeffect|soundEffect)\s*=\s*\{([\s\S]*?)\n\s*\}/gi;
            let match: RegExpExecArray | null;
            while ((match = blockRegex.exec(content)) !== null) {
                const assetType = match[1] ?? 'sound';
                const block = match[2] ?? '';
                const nameMatch = block.match(/\bname\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i);
                if (!nameMatch) continue;
                const name = nameMatch[1]!;
                const fileMatch = block.match(/\bfile\s*=\s*"([^"]+)"/i)
                    ?? block.match(/\bfiles\s*=\s*\{\s*"([^"]+)"/i);
                const fileRef = fileMatch?.[1];
                const { score, matchedBy } = scoreCandidate(name, fileRef, assetType, source);
                const hasDirectOrTermMatch = matchedBy.length > 0 || terms.length === 0;
                if (!hasDirectOrTermMatch) continue;
                const before = content.slice(0, match.index);
                const line = before.split(/\r?\n/).length;
                const logicalPath = source === 'mod'
                    ? path.relative(this.ctx.workspaceRoot, file).replace(/\\/g, '/')
                    : path.relative(root, file).replace(/\\/g, '/');
                addCandidate({
                    name,
                    source,
                    file: logicalPath,
                    line,
                    assetType,
                    fileRef,
                    score,
                    matchedBy,
                });
            }
        };

        const collectModRoots = (): string[] => {
            if (ctxStr !== 'mod' && ctxStr !== 'both') return [];
            const workspaceRoots = vs.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
            const roots = workspaceRoots.length > 0 ? workspaceRoots : [this.ctx.workspaceRoot];
            searchedRoots.push(...roots);
            return roots;
        };

        const collectVanillaRoots = (): string[] => {
            if (ctxStr !== 'vanilla' && ctxStr !== 'both') return [];
            const cwtoolsConfig = vs.workspace.getConfiguration('stellarisLanguageServices');
            const vanillaStellaris = cwtoolsConfig.get<string>('cache.stellaris');
            const roots = [vanillaStellaris].filter((r): r is string => !!r && fs.existsSync(r));
            searchedRoots.push(...roots);
            return roots;
        };

        const scanRoot = async (root: string, source: 'mod' | 'vanilla', maxFiles: number) => {
            const soundRoot = path.join(root, 'sound');
            const musicRoot = path.join(root, 'music');
            const searchRoots = uniqStrings([
                fs.existsSync(soundRoot) ? soundRoot : '',
                fs.existsSync(musicRoot) ? musicRoot : '',
                root,
            ]);
            const files: string[] = [];
            for (const searchRoot of searchRoots) {
                files.push(...this.findFilesFn(searchRoot, '.asset', Math.max(1, Math.floor(maxFiles / searchRoots.length))));
            }
            for (const file of uniqStrings(files).slice(0, maxFiles)) {
                if (candidates.length >= limit * 5) break;
                try {
                    const content = await fs.promises.readFile(file, 'utf-8');
                    const lower = content.toLowerCase();
                    const quickTerms = currentLower ? [currentLower, ...terms] : terms;
                    if (quickTerms.length > 0 && !quickTerms.some(t => lower.includes(t))) continue;
                    extractAssets(content, file, source, root);
                } catch { /* skip unreadable */ }
            }
        };

        for (const root of collectModRoots()) {
            await scanRoot(root, 'mod', 400);
        }
        for (const root of collectVanillaRoots()) {
            await scanRoot(root, 'vanilla', 1000);
        }

        const sorted = candidates
            .sort((a, b) => b.score - a.score || (a.source === 'mod' ? -1 : 1) || a.name.localeCompare(b.name))
            .slice(0, limit);

        const result: import('../types').FindSoundCandidatesResult = {
            query,
            candidates: sorted,
            searchedRoots: uniqStrings(searchedRoots),
            _hint: 'Use a returned name as the value for sound-typed fields such as `show_sound = ...`; do not replace it with a raw .wav/.ogg path unless the rule explicitly expects a file path.',
        };
        if (sorted.length === 0) {
            result._warning = `No sound asset candidates found for "${query}". Retry with broader terms and searchContext="both" before creating or guessing a sound asset name.`;
        }
        return result;
    }

    async grep(args: import('../types').GrepArgs): Promise<import('../types').GrepResult> {
        try {
            return await this.grepImpl(args);
        } catch (e) {
            return {
                matches: [],
                totalMatches: 0,
                truncated: false,
                error: e instanceof Error ? e.message : String(e),
                _hint: 'grep failed before completing the search. Fix the query or use a non-regex search.',
            } as any;
        }
    }

    private async grepImpl(args: import('../types').GrepArgs): Promise<import('../types').GrepResult> {
        const limit = Math.min(args.limit ?? 50, 200);
        const matches: Array<{ file: string; line: number; content: string }> = [];
        let totalMatches = 0;
        let truncated = false;

        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = args.isRegex ? args.query : escapeRegex(args.query);
        const localisationSearch = isLocalisationSearch({ path: args.path, include: args.include }) || (!args.path && !args.include);

        const query: any = {
            pattern,
            isRegExp: true,
            isCaseSensitive: args.caseSensitive ?? false,
        };

        const searchPath = args.path ? path.resolve(this.ctx.workspaceRoot, args.path) : this.ctx.workspaceRoot;
        let includePattern = normalizeWorkspaceIncludeGlob(args.include);
        
        // Ensure path stays within workspace boundaries to use findTextInFiles
        let relativePath = '';
        if (isPathInsideOrEqual(searchPath, this.ctx.workspaceRoot)) {
            relativePath = relativeWorkspacePath(this.ctx.workspaceRoot, searchPath);
            if (relativePath) {
                const isFilePath = fs.existsSync(searchPath)
                    ? fs.statSync(searchPath).isFile()
                    : /\.[^\\/]+$/.test(path.basename(searchPath));
                includePattern = isFilePath
                    ? relativePath
                    : `${relativePath.replace(/\/+$/g, '')}/${includePattern}`;
            }
        } else {
             // Fallback for paths outside workspace: not natively supported by VSCode findTextInFiles
             includePattern = `**/*`; // just a fallback
        }

        const options: any = {
            include: new vs.RelativePattern(this.ctx.workspaceRoot, includePattern),
            maxResults: limit,
            previewOptions: { matchLines: 1, charsPerLine: 150 },
        };

        const pushMatch = (fsPath: string, line: number, content: string) => {
            if (matches.length >= limit) {
                truncated = true;
                return;
            }
            const file = relativeWorkspacePath(this.ctx.workspaceRoot, fsPath);
            const key = `${file}:${line}:${content}`;
            if (matches.some(match => `${match.file}:${match.line}:${match.content}` === key)) return;
            matches.push({ file, line, content });
            totalMatches++;
        };

        // Strategy 1: Try native findTextInFiles, then fill gaps with manual scan.
        if (typeof (vs.workspace as any).findTextInFiles === 'function') {
            try {
                await (vs.workspace as any).findTextInFiles(query, options, (result: any) => {
                    if (matches.length >= limit) {
                        truncated = true;
                        return;
                    }
                    pushMatch(
                        result.uri.fsPath,
                        normalizeSearchLine(result),
                        String(result.preview?.text ?? '').trim()
                    );
                });
            } catch {
                // findTextInFiles unavailable or broken in this VSCode version
            }
        }

        // Strategy 2: Fallback - findFiles + manual regex scan (VSCode 1.95+)
        if (matches.length < limit) {
            try {
                const globPattern = new vs.RelativePattern(this.ctx.workspaceRoot, includePattern);
                const uris = await vs.workspace.findFiles(globPattern, '**/node_modules/**', limit * 20);
                const regex = new RegExp(pattern, args.caseSensitive ? '' : 'i');

                const CHUNK_SIZE = 30;
                for (let i = 0; i < uris.length; i += CHUNK_SIZE) {
                    if (matches.length >= limit) { truncated = true; break; }
                    const chunk = uris.slice(i, i + CHUNK_SIZE);
                    await Promise.all(chunk.map(async (uri) => {
                        if (matches.length >= limit) return;
                        try {
                            const fileContent: string = await fs.promises.readFile(uri.fsPath, 'utf-8');
                            if (!regex.test(fileContent)) return;
                            regex.lastIndex = 0;

                            const fLines = fileContent.split('\n');
                            for (let j = 0; j < fLines.length && matches.length < limit; j++) {
                                const lineStr = fLines[j]!;
                                if (regex.test(lineStr)) {
                                    regex.lastIndex = 0;
                                    pushMatch(uri.fsPath, j, lineStr.trim().substring(0, 150));
                                }
                            }
                        } catch { /* skip unreadable */ }
                    }));
                }
            } catch { /* skip */ }
        }

        if (localisationSearch && matches.length < limit && this.ctx.indexService && !args.isRegex) {
            const entries = this.ctx.indexService.queryLocalisation({
                key: args.query,
                contains: true,
                caseSensitive: args.caseSensitive ?? false,
                limit: Math.max(limit * 2, 50),
            });
            for (const entry of entries) {
                if (matches.length >= limit) {
                    truncated = true;
                    break;
                }
                pushMatch(
                    entry.file,
                    Math.max(0, entry.line - 1),
                    `${entry.key}:0 "${entry.value}"`.substring(0, 150)
                );
            }
        }

        const returnObj: any = {
            matches,
            totalMatches,
            truncated,
            _hint: "If you found your target in a PDX Script (.txt), do not use read_file. Use document_symbols + get_pdx_block to read it, or edit_pdx_block to directly replace the node."
        };
        if (matches.length === 0) {
            returnObj._warning = buildAbsenceWarning(args.query);
            returnObj._nextSteps = [
                'For a PDX ID or key, call verify_pdx_identifier(identifier=...) before treating it as missing.',
                'If the key may be vanilla, use search_mod_files(searchContext="both") because grep only searches the workspace.',
                'If the key may be in a large PDX file, use workspace_symbols/document_symbols instead of relying on line search.',
            ];
        }
        return returnObj as import('../types').GrepResult;
    }

    // - getCompletionAt -

    async getCompletionAt(args: { file: string; line: number; column: number; limit?: number }): Promise<GetCompletionAtResult> {
        let context: GetCompletionAtResult['context'] | undefined;
        try {
            const requestedLimit = Number.isFinite(args.limit) ? Math.trunc(args.limit as number) : 30;
            const limit = Math.max(1, Math.min(200, requestedLimit));
            const uri = vs.Uri.file(args.file);
            const document = await vs.workspace.openTextDocument(uri);
            let linePrefix = '';
            let tokenPrefix: string | undefined;
            if (args.line >= 0 && args.line < document.lineCount) {
                const lineText = document.lineAt(args.line).text;
                const boundedColumn = Math.max(0, Math.min(args.column, lineText.length));
                linePrefix = lineText.slice(0, boundedColumn);
                tokenPrefix = linePrefix.match(/[A-Za-z0-9_.:-]+$/)?.[0];
            }
            try {
                const rawContext = await this.lspRequest<Record<string, unknown> | null>(
                    'cwtools.ai.getCompletionContext',
                    [uri.toString(), args.line, args.column],
                    1000,
                );
                const rawScope = rawContext?.scope && typeof rawContext.scope === 'object'
                    ? rawContext.scope as Record<string, unknown>
                    : undefined;
                const scope: QueryScopeResult | undefined = rawScope ? {
                    currentScope: typeof rawScope.currentScope === 'string' ? rawScope.currentScope : 'unknown',
                    root: typeof rawScope.root === 'string' ? rawScope.root : 'unknown',
                    thisScope: typeof rawScope.thisScope === 'string' ? rawScope.thisScope : 'unknown',
                    prevChain: Array.isArray(rawScope.prevChain) ? rawScope.prevChain.map(String) : [],
                    fromChain: Array.isArray(rawScope.fromChain) ? rawScope.fromChain.map(String) : [],
                } : undefined;
                if (rawContext?.ok === true) {
                    context = {
                        file: typeof rawContext.file === 'string' ? rawContext.file : args.file,
                        line: typeof rawContext.line === 'number' ? rawContext.line : args.line,
                        column: typeof rawContext.column === 'number' ? rawContext.column : args.column,
                        languageId: document.languageId,
                        linePrefix: typeof rawContext.linePrefix === 'string' ? rawContext.linePrefix : linePrefix,
                        tokenPrefix: typeof rawContext.tokenPrefix === 'string' ? rawContext.tokenPrefix : tokenPrefix,
                        fieldName: typeof rawContext.fieldName === 'string' && rawContext.fieldName ? rawContext.fieldName : undefined,
                        isValueParameter: typeof rawContext.isValueParameter === 'boolean' ? rawContext.isValueParameter : undefined,
                        expectedValueType: typeof rawContext.expectedValueType === 'string' ? rawContext.expectedValueType : undefined,
                        currentVersion: typeof rawContext.currentVersion === 'number' ? rawContext.currentVersion : undefined,
                        scope,
                        source: 'cwtools.ai.getCompletionContext',
                    };
                }
            } catch { /* Context enrichment only. */ }
            if (!context) {
                const scope = await this.queryScopeForCompletionContext({ file: args.file, line: args.line, column: args.column }).catch(() => undefined);
                context = {
                    file: args.file,
                    line: args.line,
                    column: args.column,
                    languageId: document.languageId,
                    linePrefix,
                    tokenPrefix,
                    scope,
                    source: 'local_text_context',
                };
            }
            const position = new vs.Position(args.line, args.column);
            const completions = await this.vsCommand<vs.CompletionList>(
                'vscode.executeCompletionItemProvider', [uri, position]
            );

            if (completions) {
                const completionText = (value: unknown): string | undefined => {
                    if (typeof value === 'string') return value;
                    if (value && typeof value === 'object' && 'value' in value && typeof (value as { value?: unknown }).value === 'string') {
                        return (value as { value: string }).value;
                    }
                    return undefined;
                };
                const completionDocumentation = (value: unknown): string | undefined => {
                    if (typeof value === 'string') return value.slice(0, 500);
                    if (value && typeof value === 'object' && 'value' in value && typeof (value as { value?: unknown }).value === 'string') {
                        return (value as { value: string }).value.slice(0, 500);
                    }
                    return undefined;
                };
                const result: GetCompletionAtResult = {
                    completions: completions.items.slice(0, limit).map(item => ({
                        label: typeof item.label === 'string' ? item.label : item.label.label,
                        kind: vs.CompletionItemKind[item.kind ?? vs.CompletionItemKind.Text],
                        description: typeof item.detail === 'string' ? item.detail : undefined,
                        insertText: completionText(item.insertText) ?? completionText((item as any).textEdit?.newText),
                        filterText: item.filterText,
                        sortText: item.sortText,
                        documentation: completionDocumentation(item.documentation),
                        isSnippet: item.insertText instanceof vs.SnippetString,
                    })),
                    context,
                    totalAvailable: completions.items.length,
                };
                if (completions.items.length > limit) {
                    result._note = `Showing ${limit}/${completions.items.length} completions. Increase limit to inspect more candidates.`;
                }
                return result;
            }
            return {
                completions: [],
                context,
                totalAvailable: 0,
                _warning: 'Completion provider did not return a result. This is not proof that no values are valid at this position.',
                _nextSteps: [
                    'Confirm the file is openable and uses a CWTools-supported PDX language mode.',
                    'Call get_diagnostics to check whether the language server is still loading or reporting stale diagnostics.',
                    'Retry get_completion_at after validation/loading becomes fresh if the server is busy.',
                ],
            };
        } catch (error) {
            return {
                completions: [],
                context,
                totalAvailable: 0,
                _warning: `Completion lookup failed: ${error instanceof Error ? error.message : String(error)}. Empty completions are not authoritative.`,
                _nextSteps: [
                    'Call get_diagnostics to inspect LSP availability and loading/validation status.',
                    'Verify the requested 0-based line and column are inside the current file.',
                    'Use query_rules/query_types as fallback evidence before assuming the value is invalid.',
                ],
            };
        }
    }

    // - documentSymbols -

    async documentSymbols(args: { file: string }): Promise<DocumentSymbolsResult> {
        return this.cachedLspRead(`dsym:${args.file}`, async () => {
            try {
                const uri = vs.Uri.file(args.file);
                const symbols = await this.vsCommand<vs.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider', [uri]
                );

                if (!symbols || symbols.length === 0) {
                    return { symbols: [] };
                }

                const MAX_DEPTH = 2;
                const mapSymbol = (s: vs.DocumentSymbol, depth: number = 0): DocumentSymbolInfo => ({
                    name: s.name,
                    kind: vs.SymbolKind[s.kind],
                    range: {
                        startLine: s.range.start.line,
                        endLine: s.range.end.line,
                    },
                    children: depth < MAX_DEPTH && s.children && s.children.length > 0
                        ? s.children.map(c => mapSymbol(c, depth + 1))
                        : undefined,
                    _hasDeeper: depth >= MAX_DEPTH && s.children && s.children.length > 0
                        ? true
                        : undefined,
                });

                return { symbols: symbols.map(s => mapSymbol(s, 0)), lineNumberBase: 0 };
            } catch (e) {
                return { symbols: [], lineNumberBase: 0, error: e instanceof Error ? e.message : String(e) };
            }
        }, 8000);
    }

    // - workspaceSymbols -

    async workspaceSymbols(args: { query: string; limit?: number }): Promise<WorkspaceSymbolsResult> {
        try {
            const limit = args.limit ?? 20;
            const symbols = await this.vsCommand<vs.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider', [args.query]
            );

            if (!symbols || symbols.length === 0) {
                return {
                    symbols: [],
                    _warning: buildAbsenceWarning(args.query),
                    _hint: 'workspace_symbols depends on the current LSP index. If this was a PDX ID lookup, cross-check with verify_pdx_identifier, query_definition_by_name/query_types, or search_mod_files(searchContext="both") before deciding it is missing.',
                };
            }

            return {
                symbols: symbols.slice(0, limit).map(s => ({
                    name: s.name,
                    kind: vs.SymbolKind[s.kind],
                    file: path.relative(this.ctx.workspaceRoot, s.location.uri.fsPath).replace(/\\/g, '/'),
                    line: s.location.range.start.line,
                })),
            };
        } catch (e) {
            return { symbols: [], error: e instanceof Error ? e.message : String(e) };
        }
    }

    // - lspOperation -

    async verifyPdxIdentifier(args: import('../types').VerifyPdxIdentifierArgs): Promise<import('../types').VerifyPdxIdentifierResult> {
        const identifier = String(args.identifier ?? '').trim();
        const limit = Math.min(args.limit ?? 20, 50);
        const evidence: import('../types').VerifyPdxIdentifierResult['evidence'] = [];
        const matches: import('../types').VerifyPdxIdentifierResult['matches'] = [];
        const nextSteps = new Set<string>();

        const addEvidence = (source: string, status: 'found' | 'partial' | 'not_found' | 'error', summary: string) => {
            evidence.push({ source, status, summary });
        };
        const addNextStep = (step: string) => nextSteps.add(step);
        const addMatch = (match: import('../types').VerifyPdxIdentifierResult['matches'][number]) => {
            const key = `${match.source}|${match.file}|${match.line ?? ''}|${match.name ?? ''}|${match.content ?? ''}`;
            const exists = matches.some(existing =>
                `${existing.source}|${existing.file}|${existing.line ?? ''}|${existing.name ?? ''}|${existing.content ?? ''}` === key
            );
            if (!exists) matches.push(match);
        };
        const isOkObject = (value: unknown): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && (value as Record<string, unknown>).ok === true;

        if (!identifier) {
            return {
                identifier,
                status: 'inconclusive',
                confidence: 'low',
                canTreatAsMissing: false,
                evidence: [{ source: 'input', status: 'error', summary: 'identifier is required.' }],
                matches: [],
                nextSteps: ['Pass the exact PDX identifier or localisation key to verify.'],
                _warning: 'Cannot verify an empty identifier.',
            };
        }

        try {
            const raw = await this.queryDefinitionByName({ symbolName: identifier });
            if (isOkObject(raw)) {
                const file = typeof raw.file === 'string' ? raw.file : '';
                const line = typeof raw.line === 'number' ? raw.line : undefined;
                addEvidence('query_definition_by_name', 'found', `Exact AST definition found in ${file || 'unknown file'}.`);
                addMatch({
                    source: 'query_definition_by_name',
                    file,
                    line,
                    name: typeof raw.name === 'string' ? raw.name : identifier,
                });
            } else {
                const error = typeof raw === 'object' && raw !== null && typeof (raw as any).error === 'string'
                    ? (raw as any).error
                    : 'No exact AST definition returned.';
                addEvidence('query_definition_by_name', 'not_found', error);
                addNextStep('If this should be a typed game entity, provide typeName so query_types can verify the proper index.');
            }
        } catch (e) {
            addEvidence('query_definition_by_name', 'error', e instanceof Error ? e.message : String(e));
            addNextStep('Retry query_definition_by_name after the LSP finishes indexing.');
        }

        try {
            const symbolRes = await this.workspaceSymbols({ query: identifier, limit });
            const exactSymbols = symbolRes.symbols.filter(s =>
                args.caseSensitive ? s.name === identifier : s.name.toLowerCase() === identifier.toLowerCase()
            );
            const partialSymbols = symbolRes.symbols.filter(s => !exactSymbols.includes(s));
            if (exactSymbols.length > 0) {
                addEvidence('workspace_symbols', 'found', `${exactSymbols.length} exact symbol match(es) found.`);
                for (const sym of exactSymbols.slice(0, limit)) {
                    addMatch({
                        source: 'workspace_symbols',
                        file: sym.file,
                        line: sym.line,
                        name: sym.name,
                        kind: sym.kind,
                    });
                }
            } else if (partialSymbols.length > 0) {
                addEvidence('workspace_symbols', 'partial', `${partialSymbols.length} related symbol(s) found, but none exactly matched.`);
                for (const sym of partialSymbols.slice(0, Math.min(limit, 5))) {
                    addMatch({
                        source: 'workspace_symbols',
                        file: sym.file,
                        line: sym.line,
                        name: sym.name,
                        kind: sym.kind,
                    });
                }
                addNextStep('Inspect related workspace_symbols matches for spelling, namespace, or suffix differences.');
            } else {
                addEvidence('workspace_symbols', 'not_found', 'No symbol matches returned by the current LSP workspace index.');
            }
        } catch (e) {
            addEvidence('workspace_symbols', 'error', e instanceof Error ? e.message : String(e));
        }

        if (args.typeName) {
            try {
                const typeRes = await this.queryTypes({
                    typeName: args.typeName,
                    filter: identifier,
                    limit,
                    vanillaOnly: false,
                });
                const exactInstances = typeRes.instances.filter(i =>
                    args.caseSensitive ? i.id === identifier : i.id.toLowerCase() === identifier.toLowerCase()
                );
                const partialInstances = typeRes.instances.filter(i => !exactInstances.includes(i));
                if (exactInstances.length > 0) {
                    addEvidence('query_types', 'found', `${exactInstances.length} exact ${args.typeName} instance(s) found.`);
                    for (const item of exactInstances.slice(0, limit)) {
                        addMatch({
                            source: 'query_types',
                            file: item.file,
                            name: item.id,
                            vanilla: (item as any).vanilla === true,
                        });
                    }
                } else if (partialInstances.length > 0) {
                    addEvidence('query_types', 'partial', `${partialInstances.length} related ${args.typeName} instance(s) found, but none exactly matched.`);
                    for (const item of partialInstances.slice(0, Math.min(limit, 5))) {
                        addMatch({
                            source: 'query_types',
                            file: item.file,
                            name: item.id,
                            vanilla: (item as any).vanilla === true,
                        });
                    }
                    addNextStep(`Check whether the requested ${args.typeName} ID is misspelled or uses a different namespace.`);
                } else {
                    addEvidence('query_types', 'not_found', `No ${args.typeName} instances matched the filter.`);
                    addNextStep(`If ${identifier} is not a ${args.typeName}, retry verify_pdx_identifier with the correct typeName or omit typeName.`);
                }
            } catch (e) {
                addEvidence('query_types', 'error', e instanceof Error ? e.message : String(e));
            }
        } else {
            addEvidence('query_types', 'not_found', 'Skipped because typeName was not provided.');
            addNextStep('For game entities, pass typeName such as event, technology, scripted_trigger, scripted_effect, static_modifier, or building.');
        }

        const searchExtensions = args.fileExtensions && args.fileExtensions.length > 0
            ? args.fileExtensions
            : ['.txt', '.yml', '.gui', '.gfx', '.asset'];
        try {
            const textRes = await this.searchModFiles({
                query: identifier,
                directory: args.directory,
                fileExtensions: searchExtensions,
                exactMatch: false,
                searchContext: args.includeVanilla === false ? 'mod' : 'both',
                caseSensitive: args.caseSensitive ?? false,
                limit,
            });
            if (textRes.files.length > 0) {
                addEvidence('search_mod_files', 'found', `${textRes.files.length} file(s) contain the identifier text.`);
                for (const file of textRes.files.slice(0, limit)) {
                    for (const line of file.matchingLines.slice(0, 3)) {
                        addMatch({
                            source: 'search_mod_files',
                            file: file.logicalPath,
                            line: line.line,
                            content: line.content,
                        });
                    }
                }
            } else {
                addEvidence('search_mod_files', 'not_found', `No text matches in ${args.includeVanilla === false ? 'mod workspace' : 'mod workspace + vanilla cache'} for extensions ${searchExtensions.join(', ')}.`);
                addNextStep('If the ID may appear in another file type, retry with fileExtensions including that extension.');
            }
        } catch (e) {
            addEvidence('search_mod_files', 'error', e instanceof Error ? e.message : String(e));
        }

        const strongFound = evidence.some(e => e.status === 'found' && (e.source === 'query_definition_by_name' || e.source === 'query_types'));
        const anyFound = evidence.some(e => e.status === 'found');
        const partialFound = evidence.some(e => e.status === 'partial');
        const anyError = evidence.some(e => e.status === 'error');
        const requiredSources = args.typeName
            ? ['query_definition_by_name', 'workspace_symbols', 'query_types', 'search_mod_files']
            : ['query_definition_by_name', 'workspace_symbols', 'search_mod_files'];
        const completedRequired = requiredSources.every(source =>
            evidence.some(e => e.source === source && e.status !== 'error')
        );

        let status: import('../types').VerifyPdxIdentifierResult['status'];
        let confidence: import('../types').VerifyPdxIdentifierResult['confidence'];
        if (strongFound) {
            status = 'found';
            confidence = 'high';
        } else if (anyFound) {
            status = 'found';
            confidence = 'medium';
        } else if (partialFound) {
            status = 'ambiguous';
            confidence = 'low';
        } else if (!anyError && completedRequired) {
            status = 'not_found';
            confidence = 'medium';
        } else {
            status = 'inconclusive';
            confidence = 'low';
        }

        const canTreatAsMissing = status === 'not_found' && completedRequired && !anyError;
        if (!canTreatAsMissing && status !== 'found') {
            addNextStep('Do not delete, recreate, or duplicate this identifier yet; gather another independent source or ask the parent/user if the requirement depends on it.');
        }
        if (status === 'not_found') {
            addNextStep('Only treat this as missing for the searched context/extensions/type; mention that scope in your conclusion.');
        }

        return {
            identifier,
            status,
            confidence,
            canTreatAsMissing,
            evidence,
            matches: matches.slice(0, limit),
            nextSteps: Array.from(nextSteps),
            ...(!canTreatAsMissing && status !== 'found' ? { _warning: buildAbsenceWarning(identifier) } : {}),
        };
    }

    // lspOperation
    async lspOperation(args: {
        operation: 'goToDefinition' | 'findReferences' | 'hover' | 'rename';
        file: string;
        line: number;
        column: number;
        newName?: string;
    }, context?: import('../types').AgentToolContext): Promise<unknown> {
        const uri = vs.Uri.file(args.file);
        const position = new vs.Position(args.line, args.column);

        try {
            switch (args.operation) {
                case 'goToDefinition': {
                    const defs = await this.vsCommand<vs.Location[]>(
                        'vscode.executeDefinitionProvider', [uri, position]
                    );
                    if (!defs || defs.length === 0) return { locations: [], message: 'Definition not found.' };
                    return {
                        locations: defs.map(d => ({
                            file: d.uri.fsPath,
                            range: {
                                startLine: d.range.start.line,
                                startColumn: d.range.start.character,
                                endLine: d.range.end.line,
                                endColumn: d.range.end.character,
                            },
                        })),
                    };
                }
                case 'findReferences': {
                    const refs = await this.vsCommand<vs.Location[]>(
                        'vscode.executeReferenceProvider', [uri, position]
                    );
                    if (!refs || refs.length === 0) return { references: [], message: 'References not found.' };
                    return {
                        references: refs.slice(0, 50).map(r => ({
                            file: path.relative(this.ctx.workspaceRoot, r.uri.fsPath).replace(/\\/g, '/'),
                            line: r.range.start.line,
                            column: r.range.start.character,
                        })),
                        total: refs.length,
                    };
                }
                case 'hover': {
                    const hovers = await this.vsCommand<vs.Hover[]>(
                        'vscode.executeHoverProvider', [uri, position]
                    );
                    if (!hovers || hovers.length === 0) return { text: '', message: 'No hover information available.' };
                    const text = hovers.flatMap(h =>
                        h.contents.map(c => typeof c === 'string' ? c : (c as vs.MarkdownString).value)
                    ).join('\n\n');
                    return { text };
                }
                case 'rename': {
                    if (!args.newName) return { error: 'Rename requires the newName argument.' };
                    const edit = await this.vsCommand<vs.WorkspaceEdit>(
                        'vscode.executeDocumentRenameProvider', [uri, position, args.newName]
                    );
                    if (!edit) return { error: 'Rename is not supported at this position.' };
                    const changes: Array<{ file: string; edits: number }> = [];
                    edit.entries().forEach(([u, edits]) => {
                        changes.push({ file: path.relative(this.ctx.workspaceRoot, u.fsPath).replace(/\\/g, '/'), edits: edits.length });
                    });
                    // Permission check: rename modifies multiple files, require user confirmation
                    // in 'confirm' mode (consistent with edit_file/write_file permission model).
                    const shouldBypassConfirmation = context?.runnerOptions?.forceAutoApplyWrites === true
                        || context?.runnerOptions?.useSlimPrompt === true;
                    if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite && !shouldBypassConfirmation) {
                        const summary = changes.map(c => `${c.file} (${c.edits} edits)`).join(', ');
                        const confirmed = await this.ctx.onPendingWrite(
                            args.file, `Rename: ${changes.length} file(s) affected: ${summary}`, `rename_${Date.now()}`
                        );
                        if (!confirmed) return { error: 'The user rejected the rename operation.' };
                    }
                    const applied = await vs.workspace.applyEdit(edit);
                    if (!applied) return { error: 'Rename failed because the workspace rejected the edit.' };
                    return {
                        changes,
                        message: `Rename applied across ${changes.length} file(s), ${changes.reduce((s, c) => s + c.edits, 0)} edit(s).`,
                    };
                }
                default:
                    return { error: `Unknown LSP operation: ${args.operation}` };
            }
        } catch (e) {
            return { error: `LSP operation failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }
    queryLocalisationIndex(args: import('../types').QueryLocalisationIndexArgs): import('../types').QueryLocalisationIndexResult {
        if (!this.ctx.indexService) {
            return {
                status: 'unavailable',
                totalCount: 0,
                entries: [],
                _hint: 'The shared IndexService is not available in this extension host.',
            };
        }

        const limit = Math.max(1, Math.min(Number(args.limit ?? 20) || 20, 100));
        const entries = this.ctx.indexService.queryLocalisation({
            key: args.key,
            language: args.language,
            prefix: !!args.prefix,
            contains: !!args.contains,
            caseSensitive: args.caseSensitive ?? false,
            limit,
        });

        return {
            status: this.ctx.indexService.status,
            totalCount: entries.length,
            entries: entries.map(entry => ({
                key: entry.key,
                value: entry.value,
                file: entry.file,
                line: entry.line,
                language: entry.language,
            })),
            _hint: this.ctx.indexService.status === 'ready'
                ? undefined
                : 'Index may still be building; retry after the initial refresh completes.',
        };
    }

    async queryWorkspaceIndex(args: import('../types').QueryWorkspaceIndexArgs): Promise<import('../types').QueryWorkspaceIndexResult> {
        if (!this.ctx.indexService) {
            return {
                status: 'unavailable',
                totalCount: 0,
                entries: [],
                _hint: 'The shared IndexService is not available in this extension host.',
            };
        }

        const limit = Math.max(1, Math.min(Number(args.limit ?? 50) || 50, 200));
        await this.ctx.indexService.ensureWorkspaceSymbolsReady?.({
            includeVanilla: args.origin !== 'workspace',
        });
        const entries = this.ctx.indexService.queryWorkspaceSymbols({
            name: args.name,
            kind: args.kind,
            category: args.category,
            source: args.source,
            origin: args.origin,
            directory: args.directory,
            prefix: !!args.prefix,
            exact: !!args.exact,
            includeReferences: !!args.includeReferences,
            limit,
        });

        return {
            status: this.ctx.indexService.status,
            totalCount: entries.length,
            entries: entries.map(entry => ({
                name: entry.name,
                kind: entry.kind,
                file: entry.file,
                line: entry.line,
                source: entry.source,
                origin: entry.origin,
                container: entry.container,
                category: entry.category,
                references: args.includeReferences ? entry.references : undefined,
                updatedAt: entry.updatedAt,
                fileVersion: entry.fileVersion,
            })),
            indexedSymbolNames: this.ctx.indexService.workspaceSymbolCount,
            indexUpdatedAt: this.ctx.indexService.workspaceSymbolUpdatedAt,
            _hint: this.ctx.indexService.status === 'ready'
                ? undefined
                : 'Index may still be building; retry after the initial refresh completes.',
        };
    }

    async editPdxBlock(args: import('../types').EditPdxBlockArgs, context?: import('../types').AgentToolContext): Promise<unknown> {
        if (!this.ctx.multiReplaceFileContent) {
            return { success: false, message: 'File writing operations are unavailable in this context.' };
        }
        this.invalidateCacheForFile(args.file);
        const symbols = await this.documentSymbols({ file: args.file });
        if (symbols.symbols.length === 0) {
            return { success: false, message: 'Could not parse symbols in file. File might be invalid or empty.' };
        }
        const findSymbol = (syms: DocumentSymbolInfo[]): DocumentSymbolInfo | null => {
            for (const sym of syms) {
                if (sym.name === args.symbol) {
                    return sym;
                }
                if (sym.children && sym.children.length > 0) {
                    const found = findSymbol(sym.children);
                    if (found) return found;
                }
            }
            return null;
        };
        const targetSymbol = findSymbol(symbols.symbols);
        if (!targetSymbol) {
            // Directly attach the list of available symbols to avoid AI adjusting document_symbols again
            const collectNames = (syms: DocumentSymbolInfo[], depth = 0): string[] => {
                const names: string[] = [];
                for (const s of syms) {
                    const prefix = depth > 0 ? '  '.repeat(depth) + '- ' : '';
                    names.push(`${prefix}${s.name} (L${s.range.startLine}-${s.range.endLine})`);
                    if (s.children && s.children.length > 0 && depth < 1) {
                        names.push(...collectNames(s.children, depth + 1));
                    }
                }
                return names;
            };
            const allNames = collectNames(symbols.symbols);
            const preview = allNames.slice(0, 20).join('\n');
            const suffix = allNames.length > 20 ? `\n... and ${allNames.length - 20} more` : '';
            return { success: false, message: `Symbol '${args.symbol}' not found in file.\n\nAvailable symbols:\n${preview}${suffix}\n\nUse one of these exact names.` };
        }
        // documentSymbols is 0-indexed, replaceLines is 1-indexed
        const startLine = targetSymbol.range.startLine + 1;
        const endLine = targetSymbol.range.endLine + 1;
        
        const rawContent = fs.readFileSync(args.file, 'utf-8');
        const hasBom = rawContent.charCodeAt(0) === 0xFEFF;
        const content = hasBom ? rawContent.slice(1) : rawContent;

        const isCRLF = content.includes('\r\n');
        // The split needs to preserve the exact string to be a precise match
        const targetContent = content.split(isCRLF ? '\r\n' : '\n').slice(startLine - 1, endLine).join(isCRLF ? '\r\n' : '\n');

        if (!targetContent.includes(args.symbol)) {
            const preview = targetContent.split(/\r?\n/).slice(0, 3).join('\n');
            return {
                success: false,
                message: `edit_pdx_block aborted: lines ${startLine}-${endLine} do not contain the symbol '${args.symbol}' — the symbol ranges are stale (the file changed after the last parse). Current content at those lines starts with:\n${preview}\n\nWait for diagnostics to refresh or call document_symbols again, verify the symbol's current range, then retry.`,
            };
        }

        const readTracker = (context?.agentRunner as { readTracker?: { markRead(file: string): void } } | undefined)?.readTracker;
        readTracker?.markRead(args.file);

        const cleanedNewContent = stripLineNumberPrefixes(args.newContent) ?? args.newContent;

        return await this.ctx.multiReplaceFileContent({
            TargetFile: args.file,
            Instruction: `Update PDX block: ${args.symbol}`,
            ReplacementChunks: [{
                StartLine: startLine,
                EndLine: endLine,
                TargetContent: targetContent,
                ReplacementContent: cleanedNewContent
            }]
        }, context);
    }
}
