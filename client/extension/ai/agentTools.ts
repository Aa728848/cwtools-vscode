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
import type { LanguageClient } from 'vscode-languageclient/node';
import type { AgentToolName, TodoItem } from './types';

// Re-export the canonical tool definitions (unchanged public API)
export { TOOL_DEFINITIONS } from './tools/definitions';

// Import handler classes
import { FileToolHandler, findFiles } from './tools/fileTools';
import { LspToolHandler } from './tools/lspTools';
import { ExternalToolHandler } from './tools/externalTools';

// ─── Tool Executor ───────────────────────────────────────────────────────────

/** Maximum tool result size before truncation.
 * This is a safety-net ceiling — the smarter budgetToolResult in agentRunner.ts
 * handles context-aware dedup/segmentation. This threshold must be >= TOOL_RESULT_BUDGET_MAX
 * so the intelligent budgeting layer gets first crack at the data.
 */
const MAX_TOOL_RESULT_CHARS = 30000;

// Tool execution timeouts (ms) — prevents hangs on network filesystems or LSP deadlocks
const TOOL_TIMEOUTS: Record<string, number> = {
    // LSP / CWTools query tools — 45s (LSP can be queued behind heavy indexing)
    query_scope: 45_000,
    query_types: 45_000,
    query_rules: 45_000,
    query_references: 45_000,
    validate_code: 60_000, // Validation is the heaviest operation, give it 60s
    get_diagnostics: 45_000,
    get_file_context: 45_000,
    search_mod_files: 45_000,
    get_completion_at: 45_000,
    document_symbols: 45_000,
    workspace_symbols: 45_000,
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
    edit_file: 30_000,
    multiedit: 30_000,
    replace_lines: 30_000,
    apply_patch: 30_000,
    list_directory: 30_000,
    glob_files: 30_000,
    grep: 30_000,
    // Network/External — 20s
    web_fetch: 20_000,
    search_web: 20_000,
    codesearch: 20_000,
    // Shell — 30s
    run_command: 120_000,
    // MiniMax CLI Media
    mmx_generate_image: 120_000,
    mmx_generate_video: 300_000,
    mmx_generate_music: 300_000,
    mmx_generate_speech: 60_000,
    // Media Asset Conversion
    convert_image_to_dds: 60_000,
    convert_audio: 60_000,
    deploy_mod_asset: 30_000,
    // Git
    git_ops: 30_000,
    // Todo — 纯内存操作，极短超时即可
    todo_write: 5_000,
    // Orchestrator — 子 Agent 调度需要较长时间，由协调器自身生命周期和外部 AbortSignal 管理
    // 超时放宽至 1 小时，防止因为大语言模型响应慢导致意外超时和僵尸重试
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

    constructor(
        clientOrGetter: LanguageClient | (() => LanguageClient),
        workspaceRoot: string
    ) {
        this.workspaceRoot = workspaceRoot;
        this.clientGetter = typeof clientOrGetter === 'function'
            ? clientOrGetter
            : () => clientOrGetter;

        // Create domain handlers — each receives `this` as context so they
        // can read mutable properties (fileWriteMode, callbacks, etc.) at call time.
        this.fileHandler = new FileToolHandler(this);
        this.lspHandler = new LspToolHandler(this, this.clientGetter, findFiles);
        this.externalHandler = new ExternalToolHandler(this);

        // 初始化增强版黑板（替代旧版 sharedMemory）
        // eslint-disable-next-line @typescript-eslint/no-var-requires
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

    suspendLsp = (): void => {
        try { this.client.sendNotification('cwtools/suspendIndexing'); } catch { /* ignore */ }
    }

    resumeLsp = (): void => {
        try { this.client.sendNotification('cwtools/resumeIndexing'); } catch { /* ignore */ }
    }

    /** 增强版黑板——多 Agent 间的共享知识存储。
     * 替代旧版 sharedMemory Map，提供类型化条目、CAS 乐观锁、前缀订阅。
     * 兼容层 legacySet/Get/Search 确保现有 set_memory/get_memory/search_memory 工具无缝工作。 */
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
        let timeout = TOOL_TIMEOUTS[toolName];
        if (timeout === undefined) {
            if (toolName.startsWith('mcp_') || toolName === 'mcp_call') {
                timeout = 120_000; // MCP tools can involve network calls or complex processing
            } else {
                timeout = DEFAULT_TOOL_TIMEOUT;
            }
        }
        try {
            const result = await Promise.race([
                this.executeInternal(toolName, args, context),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`工具 ${toolName} 执行超时 (${timeout / 1000}s)`)), timeout)
                ),
            ]);
            return this.truncateResult(result);
        } catch (e) {
            if (e instanceof Error && e.message.includes('执行超时')) {
                return { error: e.message, hint: '请重试或使用更小范围的操作' };
            }
            throw e;
        }
    }

    /** Internal tool dispatch — the actual switch statement, called within a timeout wrapper. */
    private async executeInternal(toolName: string, args: Record<string, unknown>, context?: import('./types').AgentToolContext): Promise<unknown> {
        let result: unknown;
        switch (toolName as AgentToolName | 'glob_files' | 'lsp_operation' | 'web_fetch' | 'run_command' | 'search_web' | 'codesearch' | 'apply_patch' | 'multiedit' | 'task' | 'analyze_diagnostic_error') {
            // ── LSP / CWTools query tools ─────────────────────────────────
            case 'query_scope':
                result = await this.lspHandler.queryScope(args as any); break;
            case 'query_types':
                result = await this.lspHandler.queryTypes(args as any); break;
            case 'query_rules':
                result = await this.lspHandler.queryRules(args as any); break;
            case 'query_references':
                result = await this.lspHandler.queryReferences(args as any); break;
            case 'validate_code':
                result = await this.lspHandler.validateCode(args as any); break;
            case 'get_diagnostics':
                result = await this.lspHandler.getDiagnostics(args as any); break;
            case 'get_file_context':
                result = await this.lspHandler.getFileContext(args as any); break;
            case 'search_mod_files':
                result = await this.lspHandler.searchModFiles(args as any); break;
            case 'grep':
                result = await this.lspHandler.grep(args as any); break;
            case 'get_completion_at':
                result = await this.lspHandler.getCompletionAt(args as any); break;
            case 'document_symbols':
                result = await this.lspHandler.documentSymbols(args as any); break;
            case 'workspace_symbols':
                result = await this.lspHandler.workspaceSymbols(args as any); break;
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
                    // 直接附带可用符号列表，避免 AI 再调 document_symbols
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
                result = await this.fileHandler.replaceLines({
                    filePath: argsBlock.file,
                    startLine,
                    endLine,
                    newContent: argsBlock.newContent
                }, context);
                break;
            }
            case 'lsp_operation':
                result = await this.lspHandler.lspOperation(args as any); break;
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
            case 'edit_file':
                result = await this.fileHandler.editFile(args as any, context); break;
            case 'multiedit':
                result = await this.fileHandler.multiEdit(args as any, context); break;
            case 'apply_patch':
                result = await this.fileHandler.applyPatch(args as any, context); break;
            case 'list_directory':
                result = await this.fileHandler.listDirectory(args as any); break;
            case 'glob_files':
                result = await this.fileHandler.globFiles(args as any); break;
            case 'write_localisation':
                result = await this.fileHandler.writeLocalisation(args as any, context); break;
            case 'write_design_blueprint':
                result = await this.fileHandler.writeDesignBlueprint(args as any, context); break;
            case 'git_ops':
                result = await this.fileHandler.gitOps(args as any); break; // git ops uses workspace wide state mostly
            case 'replace_lines':
                result = await this.fileHandler.replaceLines(args as any, context); break;

            // ── External / agent tools ────────────────────────────────────
            case 'web_fetch':
                result = await this.externalHandler.webFetch(args as any); break;
            case 'run_command':
                result = await this.externalHandler.runCommand(args as any, context); break;
            case 'search_web':
                result = await this.externalHandler.searchWeb(args as any); break;
            case 'codesearch':
                result = await this.externalHandler.searchCode(args as any); break;
            case 'todo_write':
                result = await this.externalHandler.todoWrite(args as any, context); break;
            // spawn_sub_agents — REMOVED: sub-agent system not suitable for current architecture
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
                result = await this.externalHandler.convertImageToDds(args as any); break;
            case 'convert_audio':
                result = await this.externalHandler.convertAudio(args as any); break;
            case 'deploy_mod_asset':
                result = await this.externalHandler.deployModAsset(args as any); break;

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
                    const blackboardDir = path.join(this.workspaceRoot, '.cwtools-ai', topicId, 'blackboard');
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
                        } catch (e) {
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
                result = await this.executeMcpTool(args as any); break;

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
                        } catch (e) {
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
                    result = await this.executeMcpTool({ ...args, _toolName: toolName } as any);
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
    private async getMcpClient(serverName: string): Promise<import('./mcpClient').MCPClient> {
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
        await client.connect();

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
    }): Promise<{ success: boolean; result?: unknown; error?: string }> {
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

        try {
            const client = await this.getMcpClient(serverName!);
            const result = await client.callTool(toolName!, (args.arguments || {}) as Record<string, unknown>);
            return { success: true, result };
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            // Connection crash: evict dead client from pool, reconnect once, and retry
            if (CONNECTION_ERRORS.test(errMsg)) {
                this.evictMcpClient(serverName!);
                try {
                    const client = await this.getMcpClient(serverName!);
                    const result = await client.callTool(toolName!, (args.arguments || {}) as Record<string, unknown>);
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

    // ── Orchestrator 调度实现 ─────────────────────────────────────────────────

    /** 正在执行的 Orchestrator 中止控制器（防重入保护） */
    private _activeDispatchAbortController?: AbortController;

    /** 最近一次协调器执行结果（供 merge_results 读取） */
    private _lastOrchestratorResult?: import('./orchestrator/types').OrchestratorResult;

    /**
     * 执行 dispatch_agents 工具：将 AI 构建的任务数组转换为 TaskGraph，
     * 然后通过 Orchestrator.execute() 触发真正的多 Agent 并行执行。
     */
    private async executeDispatchAgents(args: Record<string, unknown>, context?: import('./types').AgentToolContext): Promise<unknown> {
        // 防重入：如果已经有正在运行的调度（由于超时重试或用户强制中断），先中止旧的以清理僵尸进程
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
            dependencies?: string[];
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

        // 确保有 parentAgentRunner（Orchestrator 需要它来调度子 Agent）
        if (!this.parentAgentRunner) {
            return { success: false, error: 'Orchestrator 未就绪：缺少 AgentRunner 实例引用。请确保在协调模式下运行。' };
        }

        try {
            // 动态导入避免循环依赖
            const { Orchestrator } = await import('./orchestrator/orchestrator');
            const { TaskGraphEngine } = await import('./orchestrator/taskGraphEngine');
            const { applyUserModelOverrides } = await import('./orchestrator/agentRegistry');
            const { ErrorReporter } = await import('./errorReporter');
            const { SOURCE } = await import('./messages');

            // 应用用户的子 Agent 模型配置（从 VS Code 设置中读取）
            const cfg = vs.workspace.getConfiguration('cwtools.ai');
            const agentModels = cfg.get<Record<string, { provider: string; model: string }>>('orchestrator.agentModels');
            if (agentModels) {
                applyUserModelOverrides(agentModels);
            }

            // 构建 TaskGraph
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
                        dependencies: task.dependencies || [],
                        modelOverride: task.modelOverride,
                        providerOverride: task.providerOverride,
                    },
                );
            }

            // 实例化 Orchestrator
            const orchestrator = new Orchestrator(this.parentAgentRunner);

            // 构建执行选项（优先从 AgentToolContext 读取，回退到旧的实例字段）
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
            };

            // 推送初始进度
            options.onStep?.({
                type: 'thinking',
                content: `🎯 协调器启动: 分派 ${tasks.length} 个子 Agent 任务`,
                timestamp: Date.now(),
            });

            let result;
            try {
                // 执行
                result = await orchestrator.execute(graph, options);
            } finally {
                if (globalSignal) {
                    globalSignal.removeEventListener('abort', onGlobalAbort);
                }
                if (this._activeDispatchAbortController === localAbort) {
                    this._activeDispatchAbortController = undefined;
                }
            }

            // 缓存结果供 merge_results 使用
            this._lastOrchestratorResult = result;

            // 将执行结果写入 Blackboard 供后续查询
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

            // 构建轻量返回结果（只含状态和文件列表，不含完整输出）
            // 减少主 Agent context 大小，缓解总结阶段 thinking 卡顿
            const agentSummaries: Array<{ id: string; success: boolean; filesWritten: string[]; tokenUsed: number }> = [];
            for (const [id, agentResult] of result.agentResults) {
                agentSummaries.push({
                    id,
                    success: agentResult.success,
                    filesWritten: agentResult.writtenFiles,
                    tokenUsed: agentResult.tokenUsage.total,
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
                hint: 'To view the detailed output of each sub-agent, use the merge_results tool.',
            };
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            return { success: false, error: `协调器执行异常: ${errMsg}` };
        }
    }

    /**
     * 执行 merge_results 工具：从最近一次协调器执行结果中提取摘要。
     */
    private executeMergeResults(): unknown {
        if (!this._lastOrchestratorResult) {
            // 尝试从 Blackboard 读取
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

        // 智能截断：单 Agent 上限 2000 字符，总量预算 8000 字符
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
