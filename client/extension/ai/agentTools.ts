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

/** Maximum tool result size before truncation (~8K chars) */
const MAX_TOOL_RESULT_CHARS = 8000;

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
            mode: 'explore' | 'general',
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

    /**
     * Execute a tool by name with the given arguments.
     * Results are automatically truncated if too large.
     */
    async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
        let result: unknown;
        switch (toolName as AgentToolName | 'glob_files' | 'lsp_operation' | 'web_fetch' | 'run_command' | 'search_web' | 'apply_patch' | 'multiedit' | 'task') {
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
            case 'task':
                result = await this.externalHandler.dispatchSubTask(args as any); break;

            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
        return this.truncateResult(result);
    }

    /** Truncate large tool results to avoid overloading context window. */
    private truncateResult(result: unknown): unknown {
        const json = JSON.stringify(result);
        if (json.length <= MAX_TOOL_RESULT_CHARS) return result;
        if (typeof result === 'object' && result !== null) {
            const truncated = json.substring(0, MAX_TOOL_RESULT_CHARS);
            return {
                _truncated: true,
                _originalLength: json.length,
                _note: `Result truncated to ${MAX_TOOL_RESULT_CHARS} chars. Request a narrower range or specific subsection.`,
                data: truncated,
            };
        }
        return result;
    }

    // ── Public accessors for external consumers ─────────────────────────────

    getTodos(): TodoItem[] { return this.externalHandler.getTodos(); }
    clearTodos(): void { this.externalHandler.clearTodos(); }
}
