/**
 * Eddy CWTool Code Module — Agent Tools (Orchestrator)
 *
 * This file is the public API surface. It re-exports TOOL_DEFINITIONS and
 * the AgentToolExecutor class. Internally, tool implementations are split
 * across domain-specific modules under ./tools/.
 *
 * Consumers (agentRunner.ts, index.ts) import from this file — no change needed.
 */

import * as vs from 'vscode';
import * as fs from 'fs';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { AgentToolName, TodoItem } from './types';

// Re-export the canonical tool definitions (unchanged public API)
export { TOOL_DEFINITIONS } from './tools/definitions';

// Import handler classes
import { FileToolHandler, findFiles } from './tools/fileTools';
import { LspToolHandler } from './tools/lspTools';
import { ExternalToolHandler } from './tools/externalTools';
import { getTopicStorageDir } from './workspacePaths';
import type { IndexService } from '../indexing/indexService';

// ─── Tool Executor ───────────────────────────────────────────────────────────

/** Maximum tool result size before truncation.
 * This is a safety-net ceiling — the smarter budgetToolResult in agentRunner.ts
 * handles context-aware dedup/segmentation. This threshold must be >= TOOL_RESULT_BUDGET_MAX
 * so the intelligent budgeting layer gets first crack at the data.
 */
const MAX_TOOL_RESULT_CHARS = 18000;

// Tool execution timeouts (ms) — prevents hangs on network filesystems or LSP deadlocks
const TOOL_TIMEOUTS: Record<string, number> = {
    // LSP / CWTools query tools — 45s (LSP can be queued behind heavy indexing)
    query_scope: 45_000,
    query_types: 45_000,
    query_localisation_index: 10_000,
    query_workspace_index: 10_000,
    query_rules: 45_000,
    query_references: 45_000,
    // validate_code — REMOVED: replaced by get_diagnostics + edit_file inline diagnostics
    get_diagnostics: 45_000,
    get_file_context: 45_000,
    search_mod_files: 45_000,
    find_sprite_candidates: 45_000,
    find_sound_candidates: 45_000,
    get_completion_at: 45_000,
    document_symbols: 45_000,
    workspace_symbols: 45_000,
    verify_pdx_identifier: 45_000,
    get_pdx_block: 45_000,
    lsp_operation: 45_000,
    query_definition: 45_000,
    query_definition_by_name: 45_000,
    query_scripted_effects: 45_000,
    query_scripted_triggers: 45_000,
    query_enums: 45_000,
    get_entity_info: 45_000,
    query_static_modifiers: 45_000,
    query_variables: 45_000,
    // File tools — 30s
    read_file: 30_000,
    write_file: 30_000,
    multi_replace_file_content: 30_000,
    replace_lines: 30_000,
    apply_patch: 30_000,
    list_directory: 30_000,
    glob_files: 30_000,
    grep: 30_000,
    // Network/External — 20s
    web_fetch: 20_000,
    search_web: 20_000,
    codesearch: 20_000,
    // Shell - requires user permission approval (infinite wait), command execution has independent internal timeoutMs protection,
    // Set outer timeout to 0 = disabled, AbortSignal is responsible for global interrupt instead
    run_command: 0,
    // MiniMax CLI Media — also requires permission approval and has an independent spawn timeout internally.
    mmx_generate_image: 0,
    mmx_generate_video: 0,
    mmx_generate_music: 0,
    mmx_generate_speech: 0,
    // Media Asset Conversion
    convert_image_to_dds: 60_000,
    convert_audio: 60_000,
    // Media asset deployment - requires permission approval, also disables outer timeout
    deploy_mod_asset: 0,
    // Git
    git_ops: 30_000,
    // Todo — pure memory operation, very short timeout is enough
    todo_write: 5_000,
    // Orchestrator - sub-Agent scheduling takes a long time and is managed by the coordinator's own life cycle and external AbortSignal
    // Relax the timeout to 1 hour to prevent unexpected timeouts and zombie retries due to slow response of large language models
    dispatch_agents: 3600_000,
    merge_results: 30_000,
};
const DEFAULT_TOOL_TIMEOUT = 30_000;

/**
 * Executes Agent tools by communicating with the CWTools Language Server
 * and directly reading workspace files.
 *
 * This is the orchestrator: it owns shared state and dispatches each tool
 * call to the appropriate domain handler (file, LSP, or external).
 */
export class AgentToolExecutor {
    /** Callback when todos are updated (for UI) */
    public onTodoUpdate?: (todos: TodoItem[]) => void;
    /** Callback when a file write needs user confirmation (confirm mode). */
    public onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
    /** Callback when a file is automatically written (auto mode). */
    public onAutoWritten?: (file: string, isNewFile: boolean) => void;
    /**
     * Callback fired BEFORE any file is written or created.
     * Used by the retract system to snapshot file state for later restoration.
     */
    public onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    /** Agent file write mode from config */
    public fileWriteMode: 'confirm' | 'auto' = 'confirm';

    /** Parent AgentRunner options (used for sub-agent dispatch to inherit provider/model/abort) */
    public parentRunnerOptions?: import('./agentRunner').AgentRunnerOptions;
    /** Parent AgentRunner instance (used for Orchestrator to spawn sub-agents) */
    public parentAgentRunner?: import('./agentRunner').AgentRunner;
    /** Parent token accumulator (used for sub-agent dispatch to merge costs) */
    public parentTokenAccumulator?: import('./types').TokenUsage;
    /** Permission request callback for run_command */
    public onPermissionRequest?: (
        id: string,
        tool: string,
        description: string,
        command?: string
    ) => Promise<boolean>;
    /** Step callback for real-time UI progress (subtask events) */
    public onStep?: (step: import('./types').AgentStep) => void;

    // ── Domain handlers ─────────────────────────────────────────────────────
    private fileHandler: FileToolHandler;
    private lspHandler: LspToolHandler;
    private externalHandler: ExternalToolHandler;

    private readonly clientGetter: () => LanguageClient;
    public readonly workspaceRoot: string;
    private readonly indexService?: IndexService;

    constructor(
        clientOrGetter: LanguageClient | (() => LanguageClient),
        workspaceRoot: string,
        indexService?: IndexService
    ) {
        this.workspaceRoot = workspaceRoot;
        this.indexService = indexService;
        this.clientGetter = typeof clientOrGetter === 'function'
            ? clientOrGetter
            : () => clientOrGetter;

        // Create domain handlers — each receives `this` as context so they
        // can read mutable properties (fileWriteMode, callbacks, etc.) at call time.
        this.fileHandler = new FileToolHandler(this);
        this.lspHandler = new LspToolHandler(this, this.clientGetter, findFiles);
        this.externalHandler = new ExternalToolHandler(this);

        // Initialize the enhanced blackboard (replacing the old sharedMemory)
         
        const { Blackboard } = require('./orchestrator/blackboard') as typeof import('./orchestrator/blackboard');
        this.blackboard = new Blackboard();

        // Listen for LSP server-ready notification
        vs.commands.executeCommand('setContext', 'cwtools.lspReady', false);
        const tryRegisterNotif = () => {
            try {
                const c = this.clientGetter();
                if (c) {
                    try {
                        c.onNotification('cwtools/serverReady', (_params: any) => {
                            vs.commands.executeCommand('setContext', 'cwtools.lspReady', true);
                        });
                    } catch {
                        (c as any).onReady?.().then?.(() => {
                            c.onNotification('cwtools/serverReady', (_params: any) => {
                                vs.commands.executeCommand('setContext', 'cwtools.lspReady', true);
                            });
                        });
                    }
                }
            } catch { /* ignore, clientGetter not ready yet */ }
        };
        tryRegisterNotif();
        setTimeout(tryRegisterNotif, 2000);
        setTimeout(tryRegisterNotif, 5000);
    }

    get client(): LanguageClient {
        return this.clientGetter();
    }

    private queryLocalisationIndex(args: import('./types').QueryLocalisationIndexArgs): import('./types').QueryLocalisationIndexResult {
        if (!this.indexService) {
            return {
                status: 'unavailable',
                totalCount: 0,
                entries: [],
                _hint: 'The shared IndexService is not available in this extension host.',
            };
        }

        const limit = Math.max(1, Math.min(Number(args.limit ?? 20) || 20, 100));
        const entries = this.indexService.queryLocalisation({
            key: args.key,
            language: args.language,
            prefix: !!args.prefix,
            limit,
        });

        return {
            status: this.indexService.status,
            totalCount: entries.length,
            entries: entries.map(entry => ({
                key: entry.key,
                value: entry.value,
                file: entry.file,
                line: entry.line,
                language: entry.language,
            })),
            _hint: this.indexService.status === 'ready'
                ? undefined
                : 'Index may still be building; retry after the initial refresh completes.',
        };
    }

    private queryWorkspaceIndex(args: import('./types').QueryWorkspaceIndexArgs): import('./types').QueryWorkspaceIndexResult {
        if (!this.indexService) {
            return {
                status: 'unavailable',
                totalCount: 0,
                entries: [],
                _hint: 'The shared IndexService is not available in this extension host.',
            };
        }

        const limit = Math.max(1, Math.min(Number(args.limit ?? 50) || 50, 200));
        const entries = this.indexService.queryWorkspaceSymbols({
            name: args.name,
            kind: args.kind,
            category: args.category,
            source: args.source,
            directory: args.directory,
            prefix: !!args.prefix,
            exact: !!args.exact,
            limit,
        });

        return {
            status: this.indexService.status,
            totalCount: entries.length,
            entries: entries.map(entry => ({
                name: entry.name,
                kind: entry.kind,
                file: entry.file,
                line: entry.line,
                source: entry.source,
                container: entry.container,
                category: entry.category,
            })),
            indexedSymbolNames: this.indexService.workspaceSymbolCount,
            _hint: this.indexService.status === 'ready'
                ? undefined
                : 'Index may still be building; retry after the initial refresh completes.',
        };
    }

    suspendLsp = (): void => {
        try { void this.client.sendNotification('cwtools/suspendIndexing'); } catch { /* ignore */ }
    }

    resumeLsp = (): void => {
        try { void this.client.sendNotification('cwtools/resumeIndexing'); } catch { /* ignore */ }
    }

    /** Enhanced Blackboard - Shared knowledge storage between multiple Agents. 
* Replaces the old sharedMemory Map and provides typed entries, CAS optimistic locking, and prefix subscriptions. 
* Compatibility layer legacySet/Get/Search ensures existing set_memory/get_memory/search_memory tools work seamlessly. */
    public blackboard!: import('./orchestrator/blackboard').Blackboard;

    /** Forward LSP read-cache invalidation to the lspHandler. */
    invalidateCacheForFile(filePath: string): void {
        this.lspHandler.invalidateCacheForFile(filePath);
    }
    
    get vfsOverlay(): Map<string, string> | undefined {
        return this.parentRunnerOptions?.vfsOverlay;
    }

    /** Expose the external handler so AgentRunner can auto-complete todos on task finish. */
    getExternalToolHandler(): ExternalToolHandler {
        return this.externalHandler;
    }

    /**
     * Execute a tool by name with the given arguments.
     * Results are automatically truncated if too large.
     * Each tool execution is wrapped in a Promise.race with a category-specific timeout
     * to prevent hangs on network filesystems, LSP deadlocks, or unresponsive external services.
     */
    async execute(toolName: string, args: Record<string, unknown>, context?: import('./types').AgentToolContext): Promise<unknown> {
        if (context?.runnerOptions?.useSlimPrompt && toolName === 'git_ops') {
            return {
                success: false,
                message: 'git_ops is disabled for orchestrator sub-agents. Report the issue to the main agent instead of running git commands.',
            };
        }
        if (context?.runnerOptions?.useSlimPrompt && toolName === 'run_command') {
            return {
                stdout: '',
                stderr: 'run_command is disabled for orchestrator sub-agents. Report the need to the main agent instead of running shell commands or requesting permission.',
                exitCode: 1,
            };
        }

        let timeout = TOOL_TIMEOUTS[toolName];
        if (timeout === undefined) {
            if (toolName.startsWith('mcp_') || toolName === 'mcp_call') {
                timeout = 120_000; // MCP tools can involve network calls or complex processing
            } else {
                timeout = DEFAULT_TOOL_TIMEOUT;
            }
        }
        try {
            const parentAbortSignal = context?.runnerOptions?.abortSignal;
            if (parentAbortSignal?.aborted) {
                const err = new Error('AbortError');
                err.name = 'AbortError';
                throw err;
            }

            const toolAbortController = new AbortController();
            const abortSignal = toolAbortController.signal;
            const onParentAbort = () => toolAbortController.abort(parentAbortSignal?.reason);
            if (parentAbortSignal) {
                parentAbortSignal.addEventListener('abort', onParentAbort);
            }

            const startedAt = Date.now();
            let heartbeatId: ReturnType<typeof setInterval> | undefined;
            if (context?.onStep) {
                heartbeatId = setInterval(() => {
                    if (abortSignal.aborted) return;
                    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
                    context.onStep?.({
                        type: 'orchestrator_progress',
                        content: `工具 ${toolName} 已执行 ${elapsedSec}s，仍在等待返回...`,
                        toolName,
                        timestamp: Date.now(),
                    });
                }, 15_000);
            }

            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            if (timeout > 0) {
                timeoutId = setTimeout(() => {
                    if (abortSignal.aborted) return;
                    const err = new Error(`工具 ${toolName} 执行超时 (${timeout / 1000}s)`);
                    err.name = 'TimeoutError';
                    toolAbortController.abort(err);
                }, timeout);
            }

            let abortListener: (() => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
                abortListener = () => {
                    const reason = abortSignal.reason;
                    if (reason instanceof Error) {
                        reject(reason);
                        return;
                    }
                    const err = new Error(reason ? String(reason) : 'AbortError');
                    err.name = 'AbortError';
                    reject(err);
                };
                if (abortSignal.aborted) {
                    abortListener();
                    return;
                }
                abortSignal.addEventListener('abort', abortListener, { once: true });
            });

            const toolContext = context
                ? {
                    ...context,
                    runnerOptions: {
                        ...(context.runnerOptions ?? {}),
                        abortSignal,
                    },
                } as import('./types').AgentToolContext
                : undefined;

            const racePromises: Promise<unknown>[] = [
                this.executeInternal(toolName, args, toolContext),
                abortPromise,
            ];

            try {
                const result = await Promise.race(racePromises);
                return this.truncateResult(result);
            } finally {
                if (heartbeatId) clearInterval(heartbeatId);
                if (timeoutId) clearTimeout(timeoutId);
                if (abortListener) {
                    abortSignal.removeEventListener('abort', abortListener);
                }
                if (parentAbortSignal) {
                    parentAbortSignal.removeEventListener('abort', onParentAbort);
                }
            }
        } catch (e) {
            if (e instanceof Error && (e.name === 'TimeoutError' || e.message.includes('执行超时'))) {
                return { error: e.message, hint: '请重试或使用更小范围的操作' };
            }
            throw e;
        }
    }

    /** Internal tool dispatch — the actual switch statement, called within a timeout wrapper. */
    private async executeInternal(toolName: string, args: Record<string, unknown>, context?: import('./types').AgentToolContext): Promise<unknown> {
        let result: unknown;
        switch (toolName as AgentToolName | 'glob_files' | 'lsp_operation' | 'web_fetch' | 'run_command' | 'search_web' | 'codesearch' | 'apply_patch' | 'multi_replace_file_content' | 'task' | 'analyze_diagnostic_error') {
            // ── LSP / CWTools query tools ─────────────────────────────────
            case 'query_scope':
                result = await this.lspHandler.queryScope(args as any); break;
            case 'query_types':
                result = await this.lspHandler.queryTypes(args as any); break;
            case 'query_localisation_index':
                result = this.queryLocalisationIndex(args as any); break;
            case 'query_workspace_index':
                result = this.queryWorkspaceIndex(args as any); break;
            case 'query_rules':
                result = await this.lspHandler.queryRules(args as any); break;
            case 'query_references':
                result = await this.lspHandler.queryReferences(args as any); break;
            // validate_code — REMOVED: replaced by get_diagnostics + edit_file inline diagnostics
            case 'get_diagnostics':
                result = await this.lspHandler.getDiagnostics(args as any); break;
            case 'get_file_context':
                result = await this.lspHandler.getFileContext(args as any); break;
            case 'search_mod_files':
                result = await this.lspHandler.searchModFiles(args as any); break;
            case 'find_sprite_candidates':
                result = await this.lspHandler.findSpriteCandidates(args as any); break;
            case 'find_sound_candidates':
                result = await this.lspHandler.findSoundCandidates(args as any); break;
            case 'grep':
                result = await this.lspHandler.grep(args as any); break;
            case 'get_completion_at':
                result = await this.lspHandler.getCompletionAt(args as any); break;
            case 'document_symbols':
                result = await this.lspHandler.documentSymbols(args as any); break;
            case 'workspace_symbols':
                result = await this.lspHandler.workspaceSymbols(args as any); break;
            case 'verify_pdx_identifier':
                result = await this.lspHandler.verifyPdxIdentifier(args as any); break;
            case 'get_pdx_block':
                result = await this.lspHandler.getPdxBlock(args as any); break;
            case 'edit_pdx_block': {
                const argsBlock = args as unknown as import('./types').EditPdxBlockArgs;
                const symbols = await this.lspHandler.documentSymbols({ file: argsBlock.file });
                if (symbols.symbols.length === 0) {
                    result = { success: false, message: 'Could not parse symbols in file. File might be invalid or empty.' };
                    break;
                }
                const findSymbol = (syms: import('./types').DocumentSymbolInfo[]): import('./types').DocumentSymbolInfo | null => {
                    for (const sym of syms) {
                        if (sym.name === argsBlock.symbol) {
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
                    const collectNames = (syms: import('./types').DocumentSymbolInfo[], depth = 0): string[] => {
                        const names: string[] = [];
                        for (const s of syms) {
                            const prefix = depth > 0 ? '  '.repeat(depth) + '└ ' : '';
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
                    result = { success: false, message: `Symbol '${argsBlock.symbol}' not found in file.\n\nAvailable symbols:\n${preview}${suffix}\n\nUse one of these exact names.` };
                    break;
                }
                // documentSymbols is 0-indexed, replaceLines is 1-indexed
                const startLine = targetSymbol.range.startLine + 1;
                const endLine = targetSymbol.range.endLine + 1;
                
                const rawContent = fs.readFileSync(argsBlock.file, 'utf-8');
                const hasBom = rawContent.charCodeAt(0) === 0xFEFF;
                const content = hasBom ? rawContent.slice(1) : rawContent;

                const isCRLF = content.includes('\r\n');
                // The split needs to preserve the exact string to be a precise match
                const targetContent = content.split(isCRLF ? '\r\n' : '\n').slice(startLine - 1, endLine).join(isCRLF ? '\r\n' : '\n');

                result = await this.fileHandler.multiReplaceFileContent({
                    TargetFile: argsBlock.file,
                    Instruction: `Update PDX block: ${argsBlock.symbol}`,
                    ReplacementChunks: [{
                        StartLine: startLine,
                        EndLine: endLine,
                        TargetContent: targetContent,
                        ReplacementContent: argsBlock.newContent
                    }]
                }, context);
                break;
            }
            case 'lsp_operation':
                result = await this.lspHandler.lspOperation(args as any, context); break;
            case 'query_definition':
                result = await this.lspHandler.queryDefinition(args as any); break;
            case 'query_definition_by_name':
                result = await this.lspHandler.queryDefinitionByName(args as any); break;
            case 'query_scripted_effects':
                result = await this.lspHandler.queryScriptedEffects(args as any); break;
            case 'query_scripted_triggers':
                result = await this.lspHandler.queryScriptedTriggers(args as any); break;
            case 'query_enums':
                result = await this.lspHandler.queryEnums(args as any); break;
            case 'get_entity_info':
                result = await this.lspHandler.getEntityInfo(args as any); break;
            case 'query_static_modifiers':
                result = await this.lspHandler.queryStaticModifiers(args as any); break;
            case 'query_variables':
                result = await this.lspHandler.queryVariables(args as any); break;

            // ── File tools ────────────────────────────────────────────────
            case 'read_file':
                result = await this.fileHandler.readFile(args as any, context); break;
            case 'write_file':
                result = await this.fileHandler.writeFile(args as any, context); break;
            case 'multi_replace_file_content':
                result = await this.fileHandler.multiReplaceFileContent(args as any, context); break;
            case 'replace_lines':
                result = await this.fileHandler.replaceLines(args as any, context); break;
            case 'apply_patch':
                result = await this.fileHandler.applyPatch(args as any, context); break;
            case 'list_directory':
                result = await this.fileHandler.listDirectory(args as any, context); break;
            case 'glob_files':
                result = await this.fileHandler.globFiles(args as any); break;
            case 'write_localisation':
                result = await this.fileHandler.writeLocalisation(args as any, context); break;
            case 'write_design_blueprint':
                result = await this.fileHandler.writeDesignBlueprint(args as any, context); break;
            case 'git_ops':
                result = await this.fileHandler.gitOps(args as any); break; // git ops uses workspace wide state mostly

            // ── External / agent tools ────────────────────────────────────
            case 'web_fetch':
                result = await this.externalHandler.webFetch(args as any, context); break;
            case 'run_command':
                result = await this.externalHandler.runCommand(args as any, context); break;
            case 'search_web':
                result = await this.externalHandler.searchWeb(args as any, context); break;
            case 'codesearch':
                result = await this.externalHandler.searchCode(args as any, context); break;
            case 'todo_write':
                result = await this.externalHandler.todoWrite(args as any, context); break;
            // ignore_validation_error — REMOVED: AI must fix errors, not suppress them
            case 'remove_ignored_diagnostic':
                result = await this.externalHandler.removeIgnoredDiagnostic(args as any, context); break;
            case 'get_ignored_diagnostics':
                result = await this.externalHandler.getIgnoredDiagnostics(); break;

            // ── MiniMax CLI Media tools ────────────────────────────────
            case 'mmx_generate_image':
                result = await this.externalHandler.mmxGenerateImage(args as any, context); break;
            case 'mmx_generate_video':
                result = await this.externalHandler.mmxGenerateVideo(args as any, context); break;
            case 'mmx_generate_music':
                result = await this.externalHandler.mmxGenerateMusic(args as any, context); break;
            case 'mmx_generate_speech':
                result = await this.externalHandler.mmxGenerateSpeech(args as any, context); break;

            // ── Media Asset Conversion tools ──────────────────────────
            case 'convert_image_to_dds':
                result = await this.externalHandler.convertImageToDds(args as any, context); break;
            case 'convert_audio':
                result = await this.externalHandler.convertAudio(args as any, context); break;
            case 'deploy_mod_asset':
                result = await this.externalHandler.deployModAsset(args as any, context); break;

            case 'analyze_diagnostic_error':
                result = {
                    success: true,
                    acknowledged: true,
                    message: "Reflection recorded. Proceed with your planned fix in the next step."
                };
                break;
            case 'set_memory': {
                const { key, value } = args as unknown as import('./types').SetMemoryArgs;
                if (!key || typeof value !== 'string') {
                    result = { success: false, message: 'Invalid arguments' };
                } else if (value.length > 500) {
                    const topicId = context?.runnerOptions?.topicId ?? this.parentRunnerOptions?.topicId ?? 'session';
                    const fs = await import('fs');
                    const path = await import('path');
                    const blackboardDir = path.join(getTopicStorageDir(topicId, this.workspaceRoot), 'blackboard');
                    fs.mkdirSync(blackboardDir, { recursive: true });
                    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
                    const filePath = path.join(blackboardDir, `${safeKey}.txt`);
                    fs.writeFileSync(filePath, value, 'utf-8');
                    this.blackboard.legacySet(key, `file://${filePath}`);
                    result = { success: true, message: `Successfully saved large payload (${value.length} chars) to high-capacity storage. Reference stored in blackboard. You MUST now output your final text response to complete your sub-task.` };
                } else {
                    this.blackboard.legacySet(key, value);
                    result = { success: true, message: `Stored value in memory under key '${key}'.` };
                }
                break;
            }
            case 'get_memory': {
                const { key } = args as unknown as import('./types').GetMemoryArgs;
                if (!key) {
                    result = { found: false };
                } else {
                    const mem = this.blackboard.legacyGet(key);
                    if (mem && typeof mem.value === 'string' && mem.value.startsWith('file://')) {
                        const filePath = mem.value.slice(7);
                        try {
                            const fs = await import('fs');
                            const content = fs.readFileSync(filePath, 'utf-8');
                            const truncated = content.length > 3000 
                                ? content.substring(0, 3000) + `\n...[truncated, full ${content.length} chars at ${filePath}]`
                                : content;
                            result = { found: true, value: truncated, _sourceFile: filePath, _fullLength: content.length };
                        } catch {
                            result = { found: false, error: `File not found: ${filePath}` };
                        }
                    } else {
                        result = mem;
                    }
                }
                break;
            }
            case 'search_memory': {
                const { query } = args as unknown as { query: string };
                if (!query) {
                    result = { success: false, message: 'Missing query argument' };
                } else {
                    result = this.blackboard.legacySearch(query);
                }
                break;
            }

            // ── Persistent memory (cross-session, written to .cwtools-ai-memory.md) ──
            case 'save_memory': {
                const { key, content, priority } = args as { key: string; content: string; priority?: 'high' | 'normal' | 'low' };
                if (!key || !content) {
                    result = { success: false, message: 'Missing key or content' };
                } else {
                    const { MemoryParser } = await import('./memoryParser');
                    const parser = new MemoryParser(this.workspaceRoot);
                    result = await parser.appendMemory({ key, content, priority: priority || 'normal' });
                }
                break;
            }

            // ── MCP tool call ────────────────────────────────────────────────────
            case 'mcp_call':
                result = await this.executeMcpTool(args as any, context); break;

            // ── Orchestrator tools ───────────────────────────────────────────────
            case 'dispatch_agents': {
                result = await this.executeDispatchAgents(args, context);
                break;
            }
            case 'query_blackboard': {
                const { key: qbKey, prefix, type: qbType } = args as { key?: string; prefix?: string; type?: string };
                const resolveFileRef = async (entry: any) => {
                    if (entry && typeof entry.value === 'string' && entry.value.startsWith('file://')) {
                        const filePath = entry.value.slice(7);
                        try {
                            const fs = await import('fs');
                            const content = fs.readFileSync(filePath, 'utf-8');
                            const truncated = content.length > 3000 
                                ? content.substring(0, 3000) + `\n...[truncated, full ${content.length} chars at ${filePath}]`
                                : content;
                            return { ...entry, value: truncated, _sourceFile: filePath, _fullLength: content.length };
                        } catch {
                            return entry;
                        }
                    }
                    return entry;
                };

                if (qbKey) {
                    const entry = this.blackboard.read(qbKey);
                    result = entry ? { found: true, entry: await resolveFileRef(entry) } : { found: false };
                } else if (prefix) {
                    const entries = this.blackboard.queryByPrefix(prefix);
                    const resolved = await Promise.all(entries.slice(0, 50).map(resolveFileRef));
                    result = { found: resolved.length > 0, count: entries.length, entries: resolved };
                } else if (qbType) {
                    const entries = this.blackboard.queryByType(qbType as any);
                    const resolved = await Promise.all(entries.slice(0, 50).map(resolveFileRef));
                    result = { found: resolved.length > 0, count: entries.length, entries: resolved };
                } else {
                    result = { success: false, message: '请提供 key、prefix 或 type 参数' };
                }
                break;
            }
            case 'merge_results': {
                result = this.executeMergeResults();
                break;
            }

            default:
                // Check if this is a dynamically registered MCP tool (mcp_<server>_<tool>)
                if (toolName.startsWith('mcp_')) {
                    result = await this.executeMcpTool({ ...args, _toolName: toolName } as any, context);
                } else {
                    throw new Error(`Unknown tool: ${toolName}`);
                }
        }
        return result;
    }

    // ─── MCP Connection Pool ─────────────────────────────────────────────────

    /** Per-server MCP connection pool.  Avoids re-connecting on every tool call
     *  during a reasoning loop (connect + initialize handshake can take 500ms+). */
    private mcpPool = new Map<string, { client: import('./mcpClient').MCPClient; lastUsed: number; timer: ReturnType<typeof setTimeout> }>();
    /** Idle timeout before an MCP connection is automatically disconnected (ms). */
    private static readonly MCP_IDLE_TIMEOUT_MS = 60_000;

    /** Get or create a pooled MCP client for the given server. */
    private async getMcpClient(serverName: string, abortSignal?: AbortSignal): Promise<import('./mcpClient').MCPClient> {
        const cached = this.mcpPool.get(serverName);
        if (cached) {
            cached.lastUsed = Date.now();
            // Reset idle timer
            clearTimeout(cached.timer);
            cached.timer = setTimeout(() => this.evictMcpClient(serverName), AgentToolExecutor.MCP_IDLE_TIMEOUT_MS);
            return cached.client;
        }

        // Create new connection
        const { MCPClient } = await import('./mcpClient');
        const config = vs.workspace.getConfiguration('cwtools.ai');
        const servers = config.get<any[]>('mcp.servers') || [];
        const serverConfig = servers.find((s: any) => s.name === serverName);
        if (!serverConfig) throw new Error(`MCP server "${serverName}" not found in configuration`);

        const client = new MCPClient({
            name: serverConfig.name,
            type: serverConfig.type,
            command: serverConfig.command,
            args: serverConfig.args,
            env: serverConfig.env,
            url: serverConfig.url,
        });
        await client.connect(abortSignal);

        const timer = setTimeout(() => this.evictMcpClient(serverName), AgentToolExecutor.MCP_IDLE_TIMEOUT_MS);
        this.mcpPool.set(serverName, { client, lastUsed: Date.now(), timer });
        return client;
    }

    /** Disconnect and remove a pooled MCP client. */
    private evictMcpClient(serverName: string): void {
        const entry = this.mcpPool.get(serverName);
        if (entry) {
            clearTimeout(entry.timer);
            try { entry.client.disconnect(); } catch { /* ignore */ }
            this.mcpPool.delete(serverName);
        }
    }

    /** Disconnect all pooled MCP clients (call on extension deactivate). */
    disposeMcpPool(): void {
        for (const [name] of this.mcpPool) {
            this.evictMcpClient(name);
        }
    }

    // ─── MCP Tool Execution ──────────────────────────────────────────────────

    /**
     * Execute a tool call via MCP (Model Context Protocol).
     * Uses a per-server connection pool to avoid reconnect overhead.
     * Supports both generic mcp_call (with server + tool in args) and
     * named mcp_<server>_<tool> patterns.
     */
    private async executeMcpTool(args: {
        server?: string;
        tool?: string;
        arguments?: Record<string, unknown>;
        _toolName?: string;
        [key: string]: unknown;
    }, context?: import('./types').AgentToolContext): Promise<{ success: boolean; result?: unknown; error?: string }> {
        let serverName = args.server;
        let toolName = args.tool;

        // Parse from mcp_<server>_<tool> pattern
        if (!serverName && args._toolName) {
            const match = args._toolName.match(/^mcp_(.+?)_(.+)$/);
            if (match) {
                serverName = match[1];
                toolName = match[2];
            }
        }

        if (!serverName || !toolName) {
            return { success: false, error: 'Missing server or tool name. Use mcp_call with server and tool args.' };
        }

        const CONNECTION_ERRORS = /ECONNREFUSED|EPIPE|disconnect|not connected|ECONNRESET/i;
        const abortSignal = context?.runnerOptions?.abortSignal;

        try {
            const client = await this.getMcpClient(serverName!, abortSignal);
            const result = await client.callTool(toolName!, (args.arguments || {}) as Record<string, unknown>, abortSignal);
            return { success: true, result };
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            // Connection crash: evict dead client from pool, reconnect once, and retry
            if (CONNECTION_ERRORS.test(errMsg)) {
                this.evictMcpClient(serverName!);
                try {
                    const client = await this.getMcpClient(serverName!, abortSignal);
                    const result = await client.callTool(toolName!, (args.arguments || {}) as Record<string, unknown>, abortSignal);
                    return { success: true, result };
                } catch (retryErr) {
                    return { success: false, error: `MCP tool call failed after reconnect: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}` };
                }
            }
            return { success: false, error: `MCP tool call failed: ${errMsg}` };
        }
    }

    /** Truncate large tool results to avoid overloading context window.
     * This is a safety-net for extreme cases — the smarter budgetToolResult
     * in agentRunner.ts handles normal-sized results with dedup/segmentation.
     */
    private truncateResult(result: unknown): unknown {
        const json = JSON.stringify(result);
        if (json.length <= MAX_TOOL_RESULT_CHARS) return result;
        // For objects, extract known array fields and truncate them
        // rather than producing broken JSON
        if (typeof result === 'object' && result !== null) {
            return {
                _truncated: true,
                _originalLength: json.length,
                _note: `Result exceeded ${MAX_TOOL_RESULT_CHARS} chars safety limit. Use targeted queries (add filter, limit, or file parameters) for smaller results.`,
            };
        }
        return result;
    }

    //── Orchestrator scheduling implementation ───────────────────────────────────────────────

    /** Executing Orchestrator abort controller (anti-reentrancy protection) */
    private _activeDispatchAbortController?: AbortController;

    /** The latest coordinator execution result (read by merge_results) */
    private _lastOrchestratorResult?: import('./orchestrator/types').OrchestratorResult;

    /** 
* Execute the dispatch_agents tool: convert the task array built by AI into TaskGraph, 
* Then trigger true multi-Agent parallel execution through Orchestrator.execute(). 
*/
    private async executeDispatchAgents(args: Record<string, unknown>, context?: import('./types').AgentToolContext): Promise<unknown> {
        // Anti-reentrancy: If there is already a running schedule (due to timeout retry or user forced interruption), kill the old one first to clean up the zombie process
        if (this._activeDispatchAbortController) {
            this._activeDispatchAbortController.abort('New dispatch_agents call replaced the previous one.');
            this._activeDispatchAbortController = undefined;
        }

        const localAbort = new AbortController();
        this._activeDispatchAbortController = localAbort;

        const tasks = args.tasks as Array<{
            id: string;
            agentType: string;
            prompt: string;
            contextFiles?: string[];
            plannedFiles?: string[];
            plannedEntities?: string[];
            dependencies?: string[];
            maxIterations?: number;
            modelOverride?: string;
            providerOverride?: string;
        }> | undefined;

        if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
            return { success: false, error: '请提供 tasks 数组，每个 task 需包含 id、agentType、prompt 字段' };
        }

        if (tasks.length > 4) {
            return {
                success: false,
                error: `并发上限保护: 您尝试一次性分派 ${tasks.length} 个任务，超过了最大允许的 4 个上限。过长的任务列表会导致大模型生成超时或被截断。请将任务拆分为多批次分步执行。`
            };
        }

        // Make sure there is a parentAgentRunner (the Orchestrator needs it to schedule child Agents)
        if (!this.parentAgentRunner) {
            return { success: false, error: 'Orchestrator 未就绪：缺少 AgentRunner 实例引用。请确保在协调模式下运行。' };
        }

        try {
            //Dynamic import avoids circular dependencies
            const { Orchestrator } = await import('./orchestrator/orchestrator');
            const { TaskGraphEngine } = await import('./orchestrator/taskGraphEngine');
            const { applyUserModelOverrides } = await import('./orchestrator/agentRegistry');
            //Apply user's child Agent model configuration (read from VS Code settings)
            const cfg = vs.workspace.getConfiguration('cwtools.ai');
            const agentModels = cfg.get<Record<string, { provider: string; model: string }>>('orchestrator.agentModels');
            if (agentModels) {
                applyUserModelOverrides(agentModels);
            }

            // Build TaskGraph
            const userPrompt = (args.userPrompt as string) || '多 Agent 协作任务';
            const graph = TaskGraphEngine.createGraph(userPrompt);

            for (const task of tasks) {
                TaskGraphEngine.addNode(
                    graph,
                    task.id,
                    task.agentType as import('./types').AgentMode,
                    task.prompt,
                    {
                        contextFiles: task.contextFiles,
                        plannedFiles: task.plannedFiles,
                        plannedEntities: task.plannedEntities,
                        dependencies: task.dependencies || [],
                        maxIterations: task.maxIterations,
                        modelOverride: task.modelOverride,
                        providerOverride: task.providerOverride,
                    },
                );
            }

            // Instantiate Orchestrator
            const orchestrator = new Orchestrator(this.parentAgentRunner);

            // Build execution options (read first from AgentToolContext, fallback to old instance fields)
            const runnerOpts = context?.runnerOptions ?? this.parentRunnerOptions;
            const globalSignal = runnerOpts?.abortSignal;
            const onGlobalAbort = () => localAbort.abort(globalSignal?.reason);
            if (globalSignal) {
                globalSignal.addEventListener('abort', onGlobalAbort);
            }

            const options: import('./orchestrator/types').OrchestratorOptions = {
                providerId: runnerOpts?.providerId,
                model: runnerOpts?.model,
                abortSignal: localAbort.signal,
                topicId: runnerOpts?.topicId,
                onStep: context?.onStep,
                onBeforeFileWrite: runnerOpts?.onBeforeFileWrite,
                onTodoUpdate: context?.onTodoUpdate || runnerOpts?.onTodoUpdate,
                // Do not pass the parent permission callback into orchestrator workers.
                // Sub-agents are non-interactive and install their own deny callback.
            };

            // Push initial progress
            options.onStep?.({
                type: 'thinking',
                content: `🎯 协调器启动: 分派 ${tasks.length} 个子 Agent 任务`,
                timestamp: Date.now(),
            });

            let result;
            try {
                // implement
                result = await orchestrator.execute(graph, options);
            } finally {
                if (globalSignal) {
                    globalSignal.removeEventListener('abort', onGlobalAbort);
                }
                if (this._activeDispatchAbortController === localAbort) {
                    this._activeDispatchAbortController = undefined;
                }
            }

            // Cache results for use by merge_results
            this._lastOrchestratorResult = result;

            //Write execution results to Blackboard for subsequent query
            this.blackboard.write(
                'orchestrator:lastResult',
                JSON.stringify({
                    success: result.success,
                    summary: result.summary,
                    totalTokenUsage: result.totalTokenUsage,
                    failedNodes: result.failedNodes,
                    cancelledNodes: result.cancelledNodes,
                }),
                'free_text',
                '__orchestrator__',
            );

            // Build lightweight return results (only status and file list, not complete output)
            // Reduce the size of the main Agent context and alleviate the thinking lag in the summary stage.
            const agentSummaries: Array<{
                id: string;
                success: boolean;
                filesWritten: string[];
                tokenUsed: number;
                error?: string;
                needsClarification?: boolean;
                clarification?: string;
            }> = [];
            const clarifications: Array<{ id: string; clarification: string }> = [];
            for (const [id, agentResult] of result.agentResults) {
                if (agentResult.needsClarification && agentResult.clarification) {
                    clarifications.push({ id, clarification: agentResult.clarification.slice(0, 4000) });
                }
                agentSummaries.push({
                    id,
                    success: agentResult.success,
                    filesWritten: agentResult.writtenFiles,
                    tokenUsed: agentResult.tokenUsage.total,
                    error: agentResult.error ? agentResult.error.slice(0, 1000) : undefined,
                    needsClarification: agentResult.needsClarification,
                    clarification: agentResult.clarification ? agentResult.clarification.slice(0, 2000) : undefined,
                });
            }

            return {
                success: result.success,
                summary: result.summary,
                totalTokens: result.totalTokenUsage.total,
                estimatedCostCny: result.totalTokenUsage.estimatedCostCny,
                agents: agentSummaries,
                failedNodes: result.failedNodes,
                cancelledNodes: result.cancelledNodes,
                clarifications,
                hint: clarifications.length > 0
                    ? 'One or more sub-agents escalated a decision to the parent agent. The parent agent should decide from the approved plan and available context when safe. Ask the user in the main chat only if the parent agent cannot make a safe decision, then dispatch a follow-up batch after the answer.'
                    : 'To view the detailed output of each sub-agent, use the merge_results tool.',
            };
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            return { success: false, error: `协调器执行异常: ${errMsg}` };
        }
    }

    /** 
* Execute the merge_results tool: extract a summary from the results of the most recent coordinator execution. 
*/
    private executeMergeResults(): unknown {
        if (!this._lastOrchestratorResult) {
            //Try to read from Blackboard
            const stored = this.blackboard.readValue('orchestrator:lastResult');
            if (stored) {
                try {
                    const parsed = JSON.parse(stored);
                    return { success: true, ...parsed, source: 'blackboard' };
                } catch {
                    return { success: false, message: 'Failed to find the most recent orchestrator execution result. Please use dispatch_agents first.' };
                }
            }
            return { success: false, message: 'Failed to find the most recent orchestrator execution result. Please use dispatch_agents first.' };
        }

        const r = this._lastOrchestratorResult;
        const allWrittenFiles: string[] = [];
        const agentOutputs: Array<{ id: string; output: string; files: string[] }> = [];

        //Smart truncation: the upper limit for a single Agent is 2000 characters, and the total budget is 8000 characters
        const MAX_PER_AGENT = 2000;
        const MAX_TOTAL = 8000;
        let totalOutputLen = 0;

        for (const [id, agentResult] of r.agentResults) {
            allWrittenFiles.push(...agentResult.writtenFiles);
            const remaining = Math.max(0, MAX_TOTAL - totalOutputLen);
            const limit = Math.min(MAX_PER_AGENT, remaining);
            let output = agentResult.output;
            if (output.length > limit) {
                output = output.substring(0, limit) + `...(truncated, full length: ${agentResult.output.length})`;
            }
            totalOutputLen += output.length;
            agentOutputs.push({ id, output, files: agentResult.writtenFiles });
        }

        return {
            success: true,
            overallSuccess: r.success,
            summary: r.summary,
            totalTokens: r.totalTokenUsage.total,
            estimatedCostCny: r.totalTokenUsage.estimatedCostCny,
            totalFilesWritten: allWrittenFiles.length,
            writtenFiles: allWrittenFiles,
            agentOutputs,
            failedNodes: r.failedNodes,
            cancelledNodes: r.cancelledNodes,
        };
    }

    // ── Public accessors for external consumers ─────────────────────────────

    getTodos(): TodoItem[] { return this.externalHandler.getTodos(); }
    clearTodos(): void { this.externalHandler.clearTodos(); }
}
