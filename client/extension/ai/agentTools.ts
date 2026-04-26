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
    /**
     * Reference to the parent AgentRunner for task sub-agent dispatch.
     */
    public agentRunnerRef?: {
        runSubAgent(
            prompt: string,
            mode: 'explore' | 'general' | 'build',
            parentOptions?: import('./agentRunner').AgentRunnerOptions,
            onStep?: (step: import('./types').AgentStep) => void,
            parentAccumulator?: import('./types').TokenUsage
        ): Promise<string>;
    };
    /** Parent AgentRunner options (used for sub-agent dispatch to inherit provider/model/abort) */
    public parentRunnerOptions?: import('./agentRunner').AgentRunnerOptions;
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

    /** Expose the external handler so AgentRunner can auto-complete todos on task finish. */
    getExternalToolHandler(): ExternalToolHandler {
        return this.externalHandler;
    }

    /**
     * Execute a tool by name with the given arguments.
     * Results are automatically truncated if too large.
     */
    async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
        let result: unknown;
        switch (toolName as AgentToolName | 'glob_files' | 'lsp_operation' | 'web_fetch' | 'run_command' | 'search_web' | 'apply_patch' | 'multiedit' | 'task' | 'analyze_diagnostic_error') {
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
            case 'get_completion_at':
                result = await this.lspHandler.getCompletionAt(args as any); break;
            case 'document_symbols':
                result = await this.lspHandler.documentSymbols(args as any); break;
            case 'workspace_symbols':
                result = await this.lspHandler.workspaceSymbols(args as any); break;
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
                result = await this.fileHandler.readFile(args as any); break;
            case 'write_file':
                result = await this.fileHandler.writeFile(args as any); break;
            case 'edit_file':
                result = await this.fileHandler.editFile(args as any); break;
            case 'multiedit':
                result = await this.fileHandler.multiEdit(args as any); break;
            case 'apply_patch':
                result = await this.fileHandler.applyPatch(args as any); break;
            case 'list_directory':
                result = await this.fileHandler.listDirectory(args as any); break;
            case 'glob_files':
                result = await this.fileHandler.globFiles(args as any); break;

            // ── External / agent tools ────────────────────────────────────
            case 'web_fetch':
                result = await this.externalHandler.webFetch(args as any); break;
            case 'run_command':
                result = await this.externalHandler.runCommand(args as any); break;
            case 'search_web':
                result = await this.externalHandler.searchWeb(args as any); break;
            case 'todo_write':
                result = await this.externalHandler.todoWrite(args as any); break;
            case 'spawn_sub_agents':
                result = await this.externalHandler.spawnSubAgents(args as any); break;
            case 'analyze_diagnostic_error':
                result = {
                    success: true,
                    acknowledged: true,
                    message: "Reflection recorded. Proceed with your planned fix in the next step."
                };
                break;

            // ── MCP tool call ────────────────────────────────────────────
            case 'mcp_call':
                result = await this.executeMcpTool(args as any); break;

            default:
                // Check if this is a dynamically registered MCP tool (mcp_<server>_<tool>)
                if (toolName.startsWith('mcp_')) {
                    result = await this.executeMcpTool({ ...args, _toolName: toolName } as any);
                } else {
                    throw new Error(`Unknown tool: ${toolName}`);
                }
        }
        return this.truncateResult(result);
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
        try {
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

            const client = await this.getMcpClient(serverName);
            const result = await client.callTool(toolName, (args.arguments || {}) as Record<string, unknown>);
            return { success: true, result };
        } catch (e) {
            return { success: false, error: `MCP tool call failed: ${e instanceof Error ? e.message : String(e)}` };
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

    // ── Public accessors for external consumers ─────────────────────────────

    getTodos(): TodoItem[] { return this.externalHandler.getTodos(); }
    clearTodos(): void { this.externalHandler.clearTodos(); }
}
