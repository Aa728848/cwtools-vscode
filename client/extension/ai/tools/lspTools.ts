/**
 * LSP Tool Handler — all CWTools Language Server query operations.
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
    QueryRulesResult,
    QueryReferencesResult,
    ValidateCodeResult,
    GetFileContextResult,
    SearchModFilesResult,
    GetCompletionAtResult,
    DocumentSymbolsResult,
    DocumentSymbolInfo,
    WorkspaceSymbolsResult,
    RuleInfo,
} from '../types';

// ─── Context type ────────────────────────────────────────────────────────────

/** Structural type for the properties LspToolHandler reads from the executor. */
export interface LspToolContext {
    readonly workspaceRoot: string;
    /** Agent file write mode from config ('confirm' or 'auto') */
    fileWriteMode?: 'confirm' | 'auto';
    /** Callback when a file write needs user confirmation (confirm mode). */
    onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
}

// ─── Handler class ───────────────────────────────────────────────────────────

export class LspToolHandler {
    private cwtRulesCache: { triggers: RuleInfo[]; effects: RuleInfo[]; modifiers: RuleInfo[] } | null = null;
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

    // ─── Concurrency limiter ─────────────────────────────────────────────────
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
            // Don't decrement — the slot transfers directly to the next waiter
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

    // ─── LSP request with timeout ─────────────────────────────────────────────

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
        let timer: ReturnType<typeof setTimeout>;
        try {
            const promise = this.client.sendRequest('workspace/executeCommand', {
                command,
                arguments: args,
            });
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(
                    `LSP request "${command}" timed out after ${timeoutMs / 1000}s`
                )), timeoutMs);
            });
            return await Promise.race([promise, timeout]) as T;
        } finally {
            clearTimeout(timer!);
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

    // ─── Generic LRU+TTL cache (Batch 2.2 upgrade) ────────────────────────────
    //
    // The original cache was unbounded — during long reasoning loops with hundreds
    // of unique query_scope / query_types calls, it could grow without limit.
    // This version adds LRU eviction (oldest entry removed when size > MAX) on top
    // of the existing TTL expiration.

    private static readonly LSP_CACHE_MAX_SIZE = 128;

    private async cachedLspRead<T>(key: string, fetcher: () => Promise<T>, ttlMs = 5000): Promise<T> {
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

    // ─── queryScope ──────────────────────────────────────────────────────────

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
                                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                                const ctx = match[1]!;
                                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
        } catch (e) {
            return unknown;
        }
    }

    // ─── CWTools Deep API tools ──────────────────────────────────────────────

    async queryDefinition(args: { file: string; line: number; column: number }): Promise<unknown> {
        try {
            const uri = vs.Uri.file(args.file);
            const raw = await this.lspRequest('cwtools.ai.queryDefinition', [uri.toString(), args.line, args.column]) as any;
            if (raw && raw.ok === true) return raw;
            return { ok: false, error: '未找到定义' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    async queryDefinitionByName(args: { symbolName?: string }): Promise<unknown> {
        const name = args?.symbolName?.trim();
        if (!name) {
            return {
                ok: false,
                error: '缺少必要的 symbolName 参数。你必须传入确切的符号名称。示例：query_definition_by_name({ "symbolName": "kuat_has_psionic_research" })',
            };
        }
        try {
            const raw = await this.lspRequest('cwtools.ai.queryDefinitionByName', [name]) as any;
            return raw ?? { ok: false, error: 'LSP 无响应' };
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
                    raw._note = `正显示前 ${limit} 个结果。请使用 filter 参数进行更精确的搜索。`;
                }
                return raw ?? { ok: false, error: '无响应' };
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
                    raw._note = `正显示前 ${limit} 个结果。请使用 filter 参数进行更精确的搜索。`;
                }
                return raw ?? { ok: false, error: '无响应' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    async queryEnums(args: { enumName?: string; limit?: number }): Promise<unknown> {
        const cacheKey = `enm:${JSON.stringify([args.enumName ?? '', args.limit ?? 500])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.lspRequestWithRetry('cwtools.ai.queryEnums', [args.enumName ?? '', args.limit ?? 500], 20_000) as any;
                return raw ?? { ok: false, error: '无响应' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    async getEntityInfo(args: { file: string }): Promise<unknown> {
        try {
            const uri = vs.Uri.file(args.file);
            const raw = await this.lspRequest('cwtools.ai.getEntityInfo', [uri.toString()]) as any;
            return raw ?? { ok: false, error: '无响应' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    async queryStaticModifiers(args: { filter?: string; limit?: number }): Promise<unknown> {
        const cacheKey = `smod:${JSON.stringify([args.filter ?? '', args.limit ?? 300])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.lspRequestWithRetry('cwtools.ai.queryStaticModifiers', [args.filter ?? '', args.limit ?? 300], 20_000) as any;
                return raw ?? { ok: false, error: '无响应' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    async queryVariables(args: { filter?: string }): Promise<unknown> {
        try {
            const raw = await this.lspRequest('cwtools.ai.queryVariables', [args.filter ?? '']) as any;
            return raw ?? { ok: false, error: '无响应' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    // ─── queryTypes ──────────────────────────────────────────────────────────

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
                                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
        } catch (e) {
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
        } else if (args.category === 'modifier') {
            rules = cache.modifiers;
        } else {
            rules = [...cache.triggers, ...cache.effects, ...cache.modifiers];
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

    // ─── getPdxBlock ─────────────────────────────────────────────────────────

    async getPdxBlock(args: { file: string; symbol: string }): Promise<{ content: string; truncated: boolean }> {
        try {
            const symbols = await this.documentSymbols({ file: args.file });
            if (symbols.symbols.length === 0) {
                return { content: `Error: Could not parse symbols in file (or file is empty/invalid).`, truncated: false };
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
                return { content: `Error: Symbol '${args.symbol}' not found in file. Check spelling or use document_symbols first.`, truncated: false };
            }

            const tsym = targetSymbol as DocumentSymbolInfo;
            const content = fs.readFileSync(args.file, 'utf-8');
            const lines = content.split('\n');
            // document_symbols is 0-indexed line numbers
            const slice = lines.slice(tsym.range.startLine, tsym.range.endLine + 1);
            
            let resultText = slice.join('\n');
            const MAX_CHARS = 16000;
            const truncated = resultText.length > MAX_CHARS;
            if (truncated) {
                resultText = resultText.substring(0, MAX_CHARS) + '\n... [Block truncated due to extreme size]';
            }

            return { content: resultText, truncated };
        } catch (e) {
            return { content: `Error reading PDX Block: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
        }
    }

    private async loadCWTRules(): Promise<{ triggers: RuleInfo[]; effects: RuleInfo[]; modifiers: RuleInfo[] }> {
        const triggers: RuleInfo[] = [];
        const effects: RuleInfo[] = [];
        const modifiers: RuleInfo[] = [];

        const configPaths: string[] = [
            path.join(this.ctx.workspaceRoot, 'submodules', 'cwtools-stellaris-config', 'config'),
        ];

        const ext = vs.extensions.getExtension('Eddy.eddy-stellaris-cwt') ??
            vs.extensions.getExtension('tboby.cwtools-vscode') ??
            vs.extensions.getExtension('cwtools.cwtools-vscode');
        if (ext) {
            configPaths.push(path.join(ext.extensionPath, 'config'));
            // Cache directories downloaded by the language server
            const games = ['stellaris', 'hoi4', 'eu4', 'ck2', 'imperator', 'vic2', 'ck3', 'vic3', 'eu5'];
            for (const game of games) {
                configPaths.push(path.join(ext.extensionPath, '.cwtools', game, 'config'));
            }
        }
        
        const cwtoolsConfig = vs.workspace.getConfiguration('cwtools');
        const customRulesFolder = cwtoolsConfig.get<string>('rules_folder');
        if (customRulesFolder) {
            configPaths.push(customRulesFolder);
        }

        for (const configPath of configPaths) {
            const triggersFile = path.join(configPath, 'triggers.cwt');
            const effectsFile = path.join(configPath, 'effects.cwt');
            const modifiersLog = path.join(configPath, 'logs', 'modifiers.log');
            const triggerDocsLog = path.join(configPath, 'logs', 'trigger_docs.log');
            
            const scopeMap = new Map<string, string[]>();
            if (fs.existsSync(triggerDocsLog)) { this.parseDocsLog(triggerDocsLog, scopeMap); }

            if (fs.existsSync(triggersFile)) { this.parseCWTFile(triggersFile, triggers, scopeMap); }
            if (fs.existsSync(effectsFile)) { this.parseCWTFile(effectsFile, effects, scopeMap); }
            if (fs.existsSync(modifiersLog)) { this.parseModifiersLog(modifiersLog, modifiers); }
            if (triggers.length > 0 || effects.length > 0 || modifiers.length > 0) break;
        }

        return { triggers, effects, modifiers };
    }

    private parseDocsLog(filePath: string, scopeMap: Map<string, string[]>): void {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            let currentName = '';
            for (const line of lines) {
                const nameMatch = line.match(/^([\w.-]+)\s*-/);
                if (nameMatch) {
                    currentName = nameMatch[1]!;
                    continue;
                }
                const scopeMatch = line.match(/^Supported Scopes:\s*(.*)/);
                if (scopeMatch && currentName) {
                    const scopes = scopeMatch[1]!.split(/\s+/).filter(s => s.length > 0 && s !== 'none');
                    scopeMap.set(currentName, scopes);
                    currentName = '';
                }
            }
        } catch { /* skip */ }
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
                    });
                }
            }
        } catch { /* skip */ }
    }

    private parseCWTFile(filePath: string, results: RuleInfo[], scopeMap?: Map<string, string[]>): void {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');

            const aliasPattern = /^##\s*scope\s*=\s*\{?\s*([^}]*)\}?\s*$/i;
            const namePattern = /^alias\[(?:trigger|effect):(\w+)\]\s*=\s*(.*)/;

            let currentScopes: string[] = [];
            let currentDesc = '';

            for (let i = 0; i < lines.length; i++) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const line = lines[i]!.trim();

                const scopeMatch = line.match(aliasPattern);
                if (scopeMatch) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    currentScopes = scopeMatch[1]!.split(/\s+/).filter(s => s.length > 0);
                    continue;
                }

                if (line.startsWith('## ') && !line.startsWith('## scope')) {
                    currentDesc = line.substring(3).trim();
                    continue;
                }

                const nameMatch = line.match(namePattern);
                if (nameMatch) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const name = nameMatch[1]!;
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const syntax = nameMatch[2]!;
                    
                    let scopes = [...currentScopes];
                    // IMPORTANT: Reset currentScopes after applying it, so it doesn't leak to next rule
                    currentScopes = [];
                    
                    if (scopeMap && scopeMap.has(name)) {
                        scopes = scopeMap.get(name)!;
                    }

                    results.push({
                        name,
                        description: currentDesc,
                        scopes,
                        syntax: syntax.trim(),
                    });
                    currentDesc = '';
                }
            }
        } catch { /* skip */ }
    }

    // ─── queryReferences ─────────────────────────────────────────────────────

    async queryReferences(args: { identifier: string; file?: string }): Promise<QueryReferencesResult> {
        const references: Array<{ file: string; line: number; context: string }> = [];

        try {
            const searchRoot = args.file ? path.dirname(args.file) : this.ctx.workspaceRoot;
            const files = this.findFilesFn(searchRoot, '.txt');

            for (const file of files) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        if (lines[i]!.includes(args.identifier)) {
                            references.push({
                                file: path.relative(this.ctx.workspaceRoot, file),
                                line: i,
                                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                                context: lines[i]!.trim().substring(0, 120),
                            });
                        }
                    }
                } catch { /* skip */ }
                if (references.length >= 30) break;
            }
        } catch { /* skip */ }

        return { references };
    }

    // ─── validateCode ────────────────────────────────────────────────────────

    async validateCode(args: { code: string; targetFile: string }): Promise<ValidateCodeResult> {
        const errors: import('../types').ValidationError[] = [];

        try {
            const wsFolders = vs.workspace.workspaceFolders;
            const wsRoot = wsFolders && wsFolders.length > 0
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                ? wsFolders[0]!.uri.fsPath
                : this.ctx.workspaceRoot;

            // Strategy 1: In-memory validation via LSP server command
            try {
                const client = this.client;
                if (client) {
                    const raw = await this.lspRequest('cwtools.ai.validateCode', [args.code, args.targetFile ?? ''], 30_000) as any;

                    if (raw && raw.ok === true) {
                        if (Array.isArray(raw.errors)) {
                            for (const e of raw.errors) {
                                errors.push({
                                    code: String(e.code ?? ''),
                                    severity: e.severity ?? 'error',
                                    message: String(e.message ?? ''),
                                    line: Number(e.line ?? 0),
                                    column: Number(e.column ?? 0),
                                });
                            }
                        }
                        return {
                            isValid: errors.filter(e => e.severity === 'error').length === 0,
                            errors,
                        };
                    }
                }
            } catch { /* fall through */ }

            // C3: Strategy 1.5 — incremental: if targetFile is already open in the editor
            // and has active diagnostics, return those directly without creating a temp file.
            // This avoids unnecessary disk I/O and temp-file flickering.
            if (args.targetFile && fs.existsSync(args.targetFile)) {
                try {
                    const targetUri = vs.Uri.file(args.targetFile);
                    const existingDiags = vs.languages.getDiagnostics(targetUri);
                    if (existingDiags.length > 0) {
                        for (const d of existingDiags) {
                            errors.push({
                                code: String(d.code ?? ''),
                                severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                                    : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                                        : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint',
                                message: d.message,
                                line: d.range.start.line,
                                column: d.range.start.character,
                            });
                        }
                        return {
                            isValid: errors.filter(e => e.severity === 'error').length === 0,
                            errors,
                            _strategy: 'incremental',
                        } as ValidateCodeResult;
                    }
                } catch { /* fall through to temp-file */ }
            }

            // Fallback: Temp-file approach
            let tempSubdir = '.cwtools-ai-tmp';
            if (args.targetFile) {
                const relToWs = path.relative(wsRoot, path.dirname(args.targetFile));
                if (relToWs && !relToWs.startsWith('..') && !path.isAbsolute(relToWs)) {
                    tempSubdir = path.join('.cwtools-ai-tmp', relToWs);
                }
            }
            const tempDir = path.join(wsRoot, tempSubdir);

            let ext = '.txt';
            if (args.targetFile) {
                const origExt = path.extname(args.targetFile);
                if (origExt) ext = origExt;
            }
            const tempName = `__ai_validate_${Date.now()}${ext}`;
            const tempPath = path.join(tempDir, tempName);

            try {
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }

                let originalContent = '';
                try {
                    if (args.targetFile && fs.existsSync(args.targetFile)) {
                        originalContent = fs.readFileSync(args.targetFile, 'utf-8');
                    }
                } catch { /* ok */ }

                const contentToValidate = originalContent
                    ? originalContent + '\n\n# AI_VALIDATE_START\n' + args.code
                    : args.code;

                fs.writeFileSync(tempPath, contentToValidate, 'utf-8');

                const tempUri = vs.Uri.file(tempPath);
                const _doc = await vs.workspace.openTextDocument(tempUri);
                await new Promise(r => setTimeout(r, 80));

                const diags = await new Promise<vs.Diagnostic[]>((resolve) => {
                    const existing = vs.languages.getDiagnostics(tempUri);
                    if (existing.length > 0) { resolve(existing); return; }

                    // Early check at 3000ms — diagnostics may have arrived before the event fired
                    const earlyCheck = setTimeout(() => {
                        const current = vs.languages.getDiagnostics(tempUri);
                        if (current.length > 0) {
                            clearTimeout(deadline);
                            disposable.dispose();
                            resolve(current);
                        }
                    }, 3000);

                    const deadline = setTimeout(() => {
                        clearTimeout(earlyCheck);
                        disposable.dispose();
                        resolve(vs.languages.getDiagnostics(tempUri));
                    }, 10000);

                    const disposable = vs.languages.onDidChangeDiagnostics((e) => {
                        const changedForUs = e.uris.some(u => u.fsPath === tempUri.fsPath);
                        if (changedForUs) {
                            clearTimeout(earlyCheck);
                            clearTimeout(deadline);
                            disposable.dispose();
                            resolve(vs.languages.getDiagnostics(tempUri));
                        }
                    });
                });

                const originalLineCount = originalContent ? originalContent.split('\n').length + 2 : 0;

                for (const d of diags) {
                    const adjustedLine = d.range.start.line - originalLineCount;
                    if (originalContent && adjustedLine < 0) continue;

                    errors.push({
                        code: String(d.code ?? ''),
                        severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                            : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                                : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint',
                        message: d.message,
                        line: Math.max(0, adjustedLine),
                        column: d.range.start.character,
                    });
                }
            } catch (e) {
                errors.push({
                    code: 'VALIDATION_ERROR',
                    severity: 'error',
                    message: String(e),
                    line: 0,
                    column: 0,
                });
            } finally {
                // P3 Fix: close the temp file's tab by URI instead of closing
                // the active editor (which could be the user's file)
                try {
                    const tempUri = vs.Uri.file(tempPath);
                    for (const group of vs.window.tabGroups.all) {
                        for (const tab of group.tabs) {
                            const input = tab.input;
                            if (input instanceof vs.TabInputText && input.uri.fsPath === tempUri.fsPath) {
                                await vs.window.tabGroups.close(tab, true);
                            }
                        }
                    }
                } catch { /* ignore tab close failure */ }
                try {
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    try {
                        const remaining = fs.readdirSync(tempDir);
                        if (remaining.length === 0) fs.rmdirSync(tempDir);
                    } catch { /* ignore dir cleanup failure */ }
                } catch { /* ignore temp file cleanup failure */ }
            }
        } catch (outerErr) {
            errors.push({
                code: 'VALIDATION_ERROR',
                severity: 'error',
                message: String(outerErr),
                line: 0,
                column: 0,
            });
        }

        return {
            isValid: errors.filter(e => e.severity === 'error').length === 0,
            errors,
        };
    }

    // ─── getDiagnostics ──────────────────────────────────────────────────────

    async getDiagnostics(args: {
        file?: string;
        severity?: 'error' | 'warning' | 'info' | 'hint' | 'all';
        limit?: number;
    }): Promise<import('../types').GetDiagnosticsResult> {
        const limit = Math.min(args.limit ?? 500, 2000);
        const severityFilter = args.severity && args.severity !== 'all' ? args.severity : null;

        const allPairs = vs.languages.getDiagnostics();

        const entries: import('../types').DiagnosticEntry[] = [];
        const filesWithDiags = new Set<string>();

        for (const [uri, diags] of allPairs) {
            if (diags.length === 0) continue;

            const fsPath = uri.fsPath;

            if (args.file) {
                const fileNorm = args.file.replace(/\\/g, '/').toLowerCase();
                const pathNorm = fsPath.replace(/\\/g, '/').toLowerCase();
                if (!pathNorm.includes(fileNorm)) continue;
            }

            if (fsPath.includes('.cwtools-ai-tmp')) continue;

            filesWithDiags.add(fsPath);

            for (const d of diags) {
                if (entries.length >= limit) break;

                const sev = d.severity === vs.DiagnosticSeverity.Error ? 'error'
                    : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                        : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint';

                if (severityFilter && sev !== severityFilter) continue;

                entries.push({
                    file: fsPath,
                    logicalPath: path.relative(this.ctx.workspaceRoot, fsPath).replace(/\\/g, '/'),
                    severity: sev,
                    message: d.message,
                    line: d.range.start.line,
                    column: d.range.start.character,
                    code: d.code !== undefined ? String(d.code) : undefined,
                });
            }
            if (entries.length >= limit) break;
        }

        const summary = {
            errors: entries.filter(e => e.severity === 'error').length,
            warnings: entries.filter(e => e.severity === 'warning').length,
            info: entries.filter(e => e.severity === 'info').length,
            hints: entries.filter(e => e.severity === 'hint').length,
        };

        let totalDiagCount = 0;
        for (const [uri, diags] of allPairs) {
            if (uri.fsPath.includes('.cwtools-ai-tmp')) continue;
            if (args.file) {
                const fileNorm = args.file.replace(/\\/g, '/').toLowerCase();
                if (!uri.fsPath.replace(/\\/g, '/').toLowerCase().includes(fileNorm)) continue;
            }
            if (severityFilter) {
                for (const d of diags) {
                    const sev = d.severity === vs.DiagnosticSeverity.Error ? 'error'
                        : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                            : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint';
                    if (sev === severityFilter) totalDiagCount++;
                }
            } else {
                totalDiagCount += diags.length;
            }
        }

        return {
            summary,
            diagnostics: entries,
            totalFiles: filesWithDiags.size,
            totalDiagnosticCount: totalDiagCount,
            truncated: totalDiagCount > limit,
        };
    }

    // ─── getFileContext ──────────────────────────────────────────────────────

    async getFileContext(args: { file: string; line: number; radius?: number }): Promise<GetFileContextResult> {
        const radius = args.radius ?? 20;
        try {
            const content = fs.readFileSync(args.file, 'utf-8');
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
                code: contextLines.join('\n'),
                fileType,
            };
        } catch {
            return { code: '', fileType: 'unknown' };
        }
    }

    async searchModFiles(args: { query: string; directory?: string; fileExtension?: string; exactMatch?: boolean; searchContext?: 'mod' | 'vanilla' | 'both' }): Promise<SearchModFilesResult> {
        const results: SearchModFilesResult['files'] = [];

        const workspaceFolders = vs.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [this.ctx.workspaceRoot];

        const searchRoots: string[] = [];
        const ctxStr = args.searchContext || 'mod';

        // Add Mod roots
        if (ctxStr === 'mod' || ctxStr === 'both') {
            if (args.directory) {
                for (const wsRoot of workspaceFolders) {
                    const candidate = path.join(wsRoot, args.directory);
                    if (fs.existsSync(candidate)) searchRoots.push(candidate);
                }
                if (searchRoots.length === 0 && fs.existsSync(args.directory)) {
                    const resolvedDir = path.resolve(args.directory);
                    const isWindows = process.platform === 'win32';
                    const checkDir = isWindows ? resolvedDir.toLowerCase() : resolvedDir;
                    const isWithinWorkspace = workspaceFolders.some(ws => {
                        const wsResolved = path.resolve(ws);
                        const checkWs = isWindows ? wsResolved.toLowerCase() : wsResolved;
                        return checkDir.startsWith(checkWs + path.sep) || checkDir === checkWs;
                    });
                    if (isWithinWorkspace) {
                        searchRoots.push(resolvedDir);
                    }
                }
            } else {
                searchRoots.push(...workspaceFolders);
            }
        }

        // Add Vanilla root
        if (ctxStr === 'vanilla' || ctxStr === 'both') {
            const cwtoolsConfig = vs.workspace.getConfiguration('cwtools');
            // Check Stellaris cache, fall back to language specific paths if added later
            const vanillaStellaris = cwtoolsConfig.get<string>('cache.stellaris');
            // Assuming we also check cache.hoi4 etc. if needed
            const vanillaMods = [vanillaStellaris].filter(Boolean) as string[];
            for (const vMod of vanillaMods) {
                if (args.directory) {
                    const candidate = path.join(vMod, args.directory);
                    if (fs.existsSync(candidate)) searchRoots.push(candidate);
                } else if (fs.existsSync(vMod)) {
                    searchRoots.push(vMod);
                }
            }
        }

        const ext = args.fileExtension ?? '.txt';
        const queryLower = args.query.toLowerCase();
        
        let exactRegex: RegExp | null = null;
        if (args.exactMatch) {
            // Escape query and wrap in boundaries.
            const escapedQuery = args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            try {
                exactRegex = new RegExp('\\b' + escapedQuery + '\\b', 'i');
            } catch (e) {
                exactRegex = new RegExp(escapedQuery, 'i');
            }
        }

        const MAX_SEARCH_RESULTS = 15;
        let limitReached = false;

        for (const searchRoot of searchRoots) {
            try {
                const files = this.findFilesFn(searchRoot, ext, 1000);
                
                // Process in chunks of 50 to avoid running out of file descriptors or memory
                const CHUNK_SIZE = 50;
                for (let i = 0; i < files.length; i += CHUNK_SIZE) {
                    if (results.length >= MAX_SEARCH_RESULTS) { limitReached = true; break; }
                    
                    const chunk = files.slice(i, i + CHUNK_SIZE);
                    await Promise.all(chunk.map(async (file) => {
                        if (results.length >= MAX_SEARCH_RESULTS) { limitReached = true; return; }
                        try {
                            const content = await fs.promises.readFile(file, 'utf-8');
                            // Early rejection based on loose text search
                            const contentLower = content.toLowerCase();
                            if (!contentLower.includes(queryLower)) return;
                            
                            // If exact match is required, perform regex test
                            if (args.exactMatch && exactRegex && !exactRegex.test(content)) {
                                return;
                            }

                            const lines = content.split('\n');
                            const matchingLines: Array<{ line: number; content: string }> = [];
                            for (let j = 0; j < lines.length; j++) {
                                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                                const lineStr = lines[j]!;
                                if (args.exactMatch && exactRegex) {
                                    if (exactRegex.test(lineStr)) {
                                        matchingLines.push({ line: j, content: lineStr.trim().substring(0, 120) });
                                    }
                                } else if (lineStr.toLowerCase().includes(queryLower)) {
                                    matchingLines.push({ line: j, content: lineStr.trim().substring(0, 120) });
                                }
                                if (matchingLines.length >= 10) break;
                            }
                            
                            // Because we're in parallel, check one last time before pushing
                            if (results.length < MAX_SEARCH_RESULTS) {
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

        const returnObj: any = {
            files: results,
            searchedRoot: searchRoots.join(', '),
            totalFound: results.length,
        };
        if (limitReached) {
            returnObj._warning = `[CRITICAL TRUNCATION] 截断：已达到 ${MAX_SEARCH_RESULTS} 个文件的输出上限，剩余匹配项文件（可能包含几百个）已被强制抛弃以保护大模型上下文！请使用更精确的 \`query\` 或 \`directory\` 参数缩小搜索范围。`;
        }
        return returnObj as SearchModFilesResult;
    }

    // ─── getCompletionAt ─────────────────────────────────────────────────────

    async getCompletionAt(args: { file: string; line: number; column: number; limit?: number }): Promise<GetCompletionAtResult> {
        try {
            const limit = args.limit ?? 30;
            const uri = vs.Uri.file(args.file);
            const position = new vs.Position(args.line, args.column);
            const completions = await this.vsCommand<vs.CompletionList>(
                'vscode.executeCompletionItemProvider', [uri, position]
            );

            if (completions) {
                return {
                    completions: completions.items.slice(0, limit).map(item => ({
                        label: typeof item.label === 'string' ? item.label : item.label.label,
                        kind: vs.CompletionItemKind[item.kind ?? vs.CompletionItemKind.Text],
                        description: typeof item.detail === 'string' ? item.detail : undefined,
                    })),
                    totalAvailable: completions.items.length,
                    ...(completions.items.length > limit ? { _note: `正显示 ${limit}/${completions.items.length} 个补全项。如需查看更多请增加 limit 参数。` } : {}),
                };
            }
            return { completions: [] };
        } catch {
            return { completions: [] };
        }
    }

    // ─── documentSymbols ─────────────────────────────────────────────────────

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

                return { symbols: symbols.map(s => mapSymbol(s, 0)) };
            } catch {
                return { symbols: [] };
            }
        }, 8000);
    }

    // ─── workspaceSymbols ────────────────────────────────────────────────────

    async workspaceSymbols(args: { query: string; limit?: number }): Promise<WorkspaceSymbolsResult> {
        try {
            const limit = args.limit ?? 20;
            const symbols = await this.vsCommand<vs.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider', [args.query]
            );

            if (!symbols || symbols.length === 0) {
                return { symbols: [] };
            }

            return {
                symbols: symbols.slice(0, limit).map(s => ({
                    name: s.name,
                    kind: vs.SymbolKind[s.kind],
                    file: path.relative(this.ctx.workspaceRoot, s.location.uri.fsPath).replace(/\\/g, '/'),
                    line: s.location.range.start.line,
                })),
            };
        } catch {
            return { symbols: [] };
        }
    }

    // ─── lspOperation ────────────────────────────────────────────────────────

    async lspOperation(args: {
        operation: 'goToDefinition' | 'findReferences' | 'hover' | 'rename';
        file: string;
        line: number;
        column: number;
        newName?: string;
    }): Promise<unknown> {
        const uri = vs.Uri.file(args.file);
        const position = new vs.Position(args.line, args.column);

        try {
            switch (args.operation) {
                case 'goToDefinition': {
                    const defs = await this.vsCommand<vs.Location[]>(
                        'vscode.executeDefinitionProvider', [uri, position]
                    );
                    if (!defs || defs.length === 0) return { locations: [], message: '未找到定义' };
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
                    if (!refs || refs.length === 0) return { references: [], message: '未找到引用' };
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
                    if (!hovers || hovers.length === 0) return { text: '', message: '无悬停提示信息' };
                    const text = hovers.flatMap(h =>
                        h.contents.map(c => typeof c === 'string' ? c : (c as vs.MarkdownString).value)
                    ).join('\n\n');
                    return { text };
                }
                case 'rename': {
                    if (!args.newName) return { error: '重命名操作需要提供 newName 参数' };
                    const edit = await this.vsCommand<vs.WorkspaceEdit>(
                        'vscode.executeDocumentRenameProvider', [uri, position, args.newName]
                    );
                    if (!edit) return { error: '当前位置不支持重命名' };
                    const changes: Array<{ file: string; edits: number }> = [];
                    edit.entries().forEach(([u, edits]) => {
                        changes.push({ file: path.relative(this.ctx.workspaceRoot, u.fsPath).replace(/\\/g, '/'), edits: edits.length });
                    });
                    // Permission check: rename modifies multiple files, require user confirmation
                    // in 'confirm' mode (consistent with edit_file/write_file permission model).
                    if (this.ctx.fileWriteMode === 'confirm' && this.ctx.onPendingWrite) {
                        const summary = changes.map(c => `${c.file} (${c.edits} edits)`).join(', ');
                        const confirmed = await this.ctx.onPendingWrite(
                            args.file, `Rename: ${changes.length} file(s) affected: ${summary}`, `rename_${Date.now()}`
                        );
                        if (!confirmed) return { error: '用户拒绝了重命名操作' };
                    }
                    const applied = await vs.workspace.applyEdit(edit);
                    if (!applied) return { error: '重命名应用失败 — 工作区拒绝了该修改' };
                    return {
                        changes,
                        message: `重命名已应用：影响了 ${changes.length} 个文件，共计 ${changes.reduce((s, c) => s + c.edits, 0)} 处修改`,
                    };
                }
                default:
                    return { error: `未知的 LSP 操作：${args.operation}` };
            }
        } catch (e) {
            return { error: `LSP 操作失败：${e instanceof Error ? e.message : String(e)}` };
        }
    }
}
