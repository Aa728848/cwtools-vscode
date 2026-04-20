/**
 * CWTools AI Module — Agent Tools
 *
 * Each tool maps to a CWTools engine capability via the LanguageClient.
 * The Agent can invoke these tools during its reasoning loop to query
 * scope, types, rules, validate code, etc.
 */

import * as vs from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { LanguageClient } from 'vscode-languageclient/node';
import type {
    ToolDefinition,
    AgentToolName,
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
    TodoItem,
    TodoWriteResult,
    RuleInfo,
    ValidationError,
} from './types';

// ─── Tool JSON Schema Definitions (for AI function calling) ──────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'query_scope',
            description: 'Query the scope context at a specific position in a file. Returns the current scope (Country, Planet, etc.), ROOT, THIS, PREV chain, and FROM chain. Use this to understand which triggers/effects are valid at a position.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    line: { type: 'number', description: 'Line number (0-based)' },
                    column: { type: 'number', description: 'Column number (0-based)' },
                },
                required: ['file', 'line', 'column'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_types',
            description: 'Query all defined instances of a specific type in the current mod and vanilla game files. For example, query all technology IDs, building IDs, trait IDs, etc. Use this to verify that a type reference actually exists before using it in generated code.',
            parameters: {
                type: 'object',
                properties: {
                    typeName: { type: 'string', description: 'Type name, e.g. "technology", "building", "trait", "ethic", "authority", "pop_job", "static_modifier"' },
                    filter: { type: 'string', description: 'Optional prefix filter, e.g. "tech_" to only return matching instances' },
                    limit: { type: 'number', description: 'Max results to return (default 50)' },
                },
                required: ['typeName'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_rules',
            description: 'Query the syntax rules for triggers, effects, scope changes, or modifiers. Returns the valid syntax, required parameters, and supported scopes for each rule. Use this to understand the correct syntax before generating code.',
            parameters: {
                type: 'object',
                properties: {
                    category: { type: 'string', enum: ['trigger', 'effect', 'scope_change', 'modifier'], description: 'Rule category' },
                    name: { type: 'string', description: 'Specific rule name (optional, lists all if omitted)' },
                    scope: { type: 'string', description: 'Filter by supported scope (optional)' },
                },
                required: ['category'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_references',
            description: 'Find all references to a specific identifier in the mod files. Use this to understand how an event, trigger, or effect is used across the codebase.',
            parameters: {
                type: 'object',
                properties: {
                    identifier: { type: 'string', description: 'The identifier to search for' },
                    file: { type: 'string', description: 'Optional file to limit search to' },
                },
                required: ['identifier'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'validate_code',
            description: 'Validate a piece of PDXScript code against the CWTools rule engine. Returns validation errors and warnings. ALWAYS validate generated code before presenting it to the user.',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'The PDXScript code to validate' },
                    targetFile: { type: 'string', description: 'The file path where this code would be placed (determines validation context)' },
                },
                required: ['code', 'targetFile'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_file_context',
            description: 'Get code context around a specific line in a file, including symbol information. Use this to understand the surrounding code structure.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    line: { type: 'number', description: 'Center line number (0-based)' },
                    radius: { type: 'number', description: 'Number of lines above and below to include (default 20)' },
                },
                required: ['file', 'line'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_mod_files',
            description: 'Search for files containing specific text patterns across the ENTIRE mod workspace (all workspace folders). Case-insensitive. Returns up to 50 matching files with up to 20 matching lines each. Use this for broad workspace searches. For narrower searches, supply the "directory" parameter (e.g. "common/scripted_triggers"). If no results, try a shorter or different query.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for (case-insensitive)' },
                    directory: { type: 'string', description: 'Optional subdirectory to restrict search, e.g. "common/scripted_triggers" or "events"' },
                    fileExtension: { type: 'string', description: 'File extension filter, default ".txt". Use ".yml" for localisation.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_completion_at',
            description: 'Get CWTools auto-completion suggestions for a specific position. Returns what keywords, values, or types are valid at that position according to the rule engine.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    line: { type: 'number', description: 'Line number (0-based)' },
                    column: { type: 'number', description: 'Column number (0-based)' },
                },
                required: ['file', 'line', 'column'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_symbols',
            description: 'Get all symbols (events, triggers, effects, buildings, etc.) defined in a specific file. Returns a hierarchical tree of symbol names and their line ranges. Useful for understanding file structure without reading the entire file.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                },
                required: ['file'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'workspace_symbols',
            description: 'Search for symbol definitions across the entire workspace by name. Returns matching symbols with their file location. Use this to find where an event, trigger, building, etc. is defined in a large mod project.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Symbol name or partial name to search for' },
                    limit: { type: 'number', description: 'Max results (default 30)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'todo_write',
            description: 'Create or update a TODO list to track multi-step tasks. Use this when you are performing complex work that involves multiple steps. Each item has a status (pending, in_progress, done). The entire list is replaced on each call.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: 'The full TODO list',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'Unique ID for this item' },
                                content: { type: 'string', description: 'Task description' },
                                status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Current status' },
                                priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority level' },
                            },
                            required: ['id', 'content', 'status'],
                        },
                    },
                },
                required: ['todos'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the full content of a file, with optional line range. Returns content with line numbers prepended. Large files are automatically truncated with a notice. Prefer this over get_file_context when you need to read a whole file.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    startLine: { type: 'number', description: 'Start line (1-based, optional)' },
                    endLine: { type: 'number', description: 'End line (1-based inclusive, optional)' },
                },
                required: ['file'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write content to a file, replacing its entire content. If agentFileWriteMode is "confirm", the write will be queued for user confirmation via a diff view. If "auto", writes immediately.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    content: { type: 'string', description: 'New file content' },
                },
                required: ['file', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Make precise string substitutions in files using oldString→newString replacement. Uses a cascade of 8 fuzzy-matching strategies that tolerate minor whitespace/indentation differences in the AI output. If oldString is empty, creates the file with newString as content. After writing, returns real-time LSP diagnostics so errors are detected immediately. Subject to agentFileWriteMode: confirm mode shows VSCode diff viewer and waits for approval; auto mode writes immediately.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute path to the file to modify' },
                    oldString: { type: 'string', description: 'The exact text to replace. Empty string = create new file with newString.' },
                    newString: { type: 'string', description: 'The replacement text (must differ from oldString)' },
                    replaceAll: { type: 'boolean', description: 'If true, replace all occurrences. Default: false. Fails if multiple matches found and replaceAll is false.' },
                },
                required: ['filePath', 'oldString', 'newString'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List files and subdirectories in a directory. Use this to understand project structure before reading files.',
            parameters: {
                type: 'object',
                properties: {
                    directory: { type: 'string', description: 'Directory path (absolute or relative to workspace root)' },
                    recursive: { type: 'boolean', description: 'Whether to list recursively (default false, depth limited to 3)' },
                },
                required: ['directory'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_diagnostics',
            description: 'Get validation errors and warnings for workspace files DIRECTLY from the CWTools language server \u2014 the same diagnostics shown in the VSCode Problems panel. No file writing required. Use this to: (1) count/list errors in the current project, (2) check if a specific file has errors, (3) understand what the validator complains about before generating fixes. Filter by severity or file path prefix.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Optional: restrict to a specific file path (absolute) or a path substring to match. Leave empty to get all workspace diagnostics.' },
                    severity: { type: 'string', enum: ['error', 'warning', 'info', 'hint', 'all'], description: 'Filter by severity. Default: "all"' },
                    limit: { type: 'number', description: 'Max diagnostics to return (default 100).' },
                },
                required: [],
            },
        },
    },
];

// ─── Tool Executor ───────────────────────────────────────────────────────────

/** Maximum tool result size before truncation (~8K chars) */
const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Executes Agent tools by communicating with the CWTools Language Server
 * and directly reading workspace files.
 */
export class AgentToolExecutor {
    private cwtRulesCache: { triggers: RuleInfo[]; effects: RuleInfo[] } | null = null;
    private currentTodos: TodoItem[] = [];
    /** Callback when todos are updated (for UI) */
    public onTodoUpdate?: (todos: TodoItem[]) => void;
    /** Callback when a file write needs user confirmation (confirm mode).
     * Receives the target file path, the proposed new content, and a messageId.
     * Returns true = confirmed, false = cancelled. */
    public onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
    /** Agent file write mode from config */
    public fileWriteMode: 'confirm' | 'auto' = 'confirm';

    private readonly clientGetter: () => LanguageClient;

    constructor(
        clientOrGetter: LanguageClient | (() => LanguageClient),
        private workspaceRoot: string
    ) {
        // Accept either a direct client or a lazy getter (for early registration before LSP starts)
        this.clientGetter = typeof clientOrGetter === 'function'
            ? clientOrGetter
            : () => clientOrGetter;
    }

    private get client(): LanguageClient {
        return this.clientGetter();
    }

    /**
     * Execute a tool by name with the given arguments.
     * Results are automatically truncated if too large.
     */
    async execute(toolName: AgentToolName, args: Record<string, unknown>): Promise<unknown> {
        let result: unknown;
        switch (toolName) {
            case 'query_scope':
                result = await this.queryScope(args as any); break;
            case 'query_types':
                result = await this.queryTypes(args as any); break;
            case 'query_rules':
                result = await this.queryRules(args as any); break;
            case 'query_references':
                result = await this.queryReferences(args as any); break;
            case 'validate_code':
                result = await this.validateCode(args as any); break;
            case 'get_diagnostics':
                result = await this.getDiagnostics(args as any); break;
            case 'get_file_context':
                result = await this.getFileContext(args as any); break;
            case 'search_mod_files':
                result = await this.searchModFiles(args as any); break;
            case 'get_completion_at':
                result = await this.getCompletionAt(args as any); break;
            case 'document_symbols':
                result = await this.documentSymbols(args as any); break;
            case 'workspace_symbols':
                result = await this.workspaceSymbols(args as any); break;
            case 'todo_write':
                result = await this.todoWrite(args as any); break;
            case 'read_file':
                result = await this.readFile(args as any); break;
            case 'write_file':
                result = await this.writeFile(args as any); break;
            case 'edit_file':
                result = await this.editFile(args as any); break;
            case 'list_directory':
                result = await this.listDirectory(args as any); break;
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
        return this.truncateResult(result);
    }

    /**
     * Truncate large tool results to avoid overloading context window.
     */
    private truncateResult(result: unknown): unknown {
        const json = JSON.stringify(result);
        if (json.length <= MAX_TOOL_RESULT_CHARS) return result;

        // For string-valued results, truncate directly
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

    // ─── Tool Implementations ────────────────────────────────────────────────

    private async queryScope(args: { file: string; line: number; column: number }): Promise<QueryScopeResult> {
        try {
            // Use hover to extract scope info (the server includes scope tables in hover)
            const uri = vs.Uri.file(args.file);
            const position = new vs.Position(args.line, args.column);
            const hovers = await vs.commands.executeCommand<vs.Hover[]>(
                'vscode.executeHoverProvider', uri, position
            );

            const result: QueryScopeResult = {
                currentScope: 'unknown',
                root: 'unknown',
                thisScope: 'unknown',
                prevChain: [],
                fromChain: [],
            };

            if (hovers && hovers.length > 0) {
                for (const hover of hovers) {
                    for (const content of hover.contents) {
                        const text = typeof content === 'string' ? content :
                            (content as vs.MarkdownString).value;
                        // Parse scope table from hover markdown
                        // Format: | Context | Scope |
                        //         | ROOT | Country |
                        //         | THIS | Country |
                        const lines = text.split('\n');
                        for (const line of lines) {
                            const match = line.match(/\|\s*(\w+)\s*\|\s*(\w+)\s*\|/);
                            if (match) {
                                const [, ctx, scope] = match;
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
            return {
                currentScope: 'unknown',
                root: 'unknown',
                thisScope: 'unknown',
                prevChain: [],
                fromChain: [],
            };
        }
    }

    private async queryTypes(args: { typeName: string; filter?: string; limit?: number }): Promise<QueryTypesResult> {
        try {
            // Use executeCommand to trigger the server's exportTypes command
            // and parse the result. Since the server sends it as a CustomNotification,
            // we instead query the completion system which has type info.
            const limit = args.limit ?? 50;
            const types = await vs.commands.executeCommand<any>('cwtools.exportTypes');

            // Fallback: search workspace files for type definitions
            const instances: Array<{ id: string; file: string; subtypes?: string[] }> = [];

            // Search for type definitions in common/ directory
            const typeToDir: Record<string, string> = {
                technology: 'common/technology',
                building: 'common/buildings',
                trait: 'common/traits',
                authority: 'common/governments/authorities',
                ethic: 'common/ethics',
                static_modifier: 'common/static_modifiers',
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
                const fullDir = path.join(this.workspaceRoot, searchDir);
                if (fs.existsSync(fullDir)) {
                    const files = this.findFiles(fullDir, '.txt');
                    for (const file of files) {
                        try {
                            const content = fs.readFileSync(file, 'utf-8');
                            // Extract top-level keys (type IDs)
                            const keyPattern = /^(\w[\w.-]*)\s*=/gm;
                            let match;
                            while ((match = keyPattern.exec(content)) !== null && instances.length < limit) {
                                const id = match[1];
                                if (!args.filter || id.startsWith(args.filter)) {
                                    instances.push({ id, file: path.relative(this.workspaceRoot, file) });
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

    private async queryRules(args: { category: string; name?: string; scope?: string }): Promise<QueryRulesResult> {
        // Load and parse CWT rule files
        if (!this.cwtRulesCache) {
            this.cwtRulesCache = await this.loadCWTRules();
        }

        let rules: RuleInfo[];
        if (args.category === 'trigger') {
            rules = this.cwtRulesCache.triggers;
        } else if (args.category === 'effect') {
            rules = this.cwtRulesCache.effects;
        } else {
            rules = [...this.cwtRulesCache.triggers, ...this.cwtRulesCache.effects];
        }

        // Apply filters
        if (args.name) {
            rules = rules.filter(r => r.name.toLowerCase().includes(args.name!.toLowerCase()));
        }
        if (args.scope) {
            rules = rules.filter(r =>
                r.scopes.length === 0 ||
                r.scopes.some(s => s.toLowerCase() === args.scope!.toLowerCase() || s.toLowerCase() === 'all')
            );
        }

        // Limit results
        return { rules: rules.slice(0, 80) };
    }

    private async queryReferences(args: { identifier: string; file?: string }): Promise<QueryReferencesResult> {
        const references: Array<{ file: string; line: number; context: string }> = [];

        try {
            // Search workspace files for the identifier
            const searchRoot = args.file ? path.dirname(args.file) : this.workspaceRoot;
            const files = this.findFiles(searchRoot, '.txt');

            for (const file of files) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes(args.identifier)) {
                            references.push({
                                file: path.relative(this.workspaceRoot, file),
                                line: i,
                                context: lines[i].trim().substring(0, 120),
                            });
                        }
                    }
                } catch { /* skip */ }
                if (references.length >= 30) break;
            }
        } catch { /* skip */ }

        return { references };
    }

    private async validateCode(args: { code: string; targetFile: string }): Promise<ValidateCodeResult> {
        // Strategy: write a temp file INSIDE the workspace so CWTools LSP can see it,
        // then wait for diagnostics to appear via onDidChangeDiagnostics event.
        // The temp file is deleted immediately after validation.
        const errors: ValidationError[] = [];

        // Find a suitable workspace folder to host the temp file
        const wsFolders = vs.workspace.workspaceFolders;
        const wsRoot = wsFolders && wsFolders.length > 0
            ? wsFolders[0].uri.fsPath
            : this.workspaceRoot;

        // Determine temp dir path — mirror the structure of targetFile within workspace
        // so CWTools applies the same validation rules (e.g. events/ vs common/)
        let tempSubdir = '.cwtools-ai-tmp';
        if (args.targetFile) {
            const relToWs = path.relative(wsRoot, path.dirname(args.targetFile));
            // Only use the relative path if it's within the workspace
            if (relToWs && !relToWs.startsWith('..') && !path.isAbsolute(relToWs)) {
                tempSubdir = path.join('.cwtools-ai-tmp', relToWs);
            }
        }
        const tempDir = path.join(wsRoot, tempSubdir);

        // Determine the file extension from original target or default to .txt
        let ext = '.txt';
        if (args.targetFile) {
            const origExt = path.extname(args.targetFile);
            if (origExt) ext = origExt;
        }
        const tempName = `__ai_validate_${Date.now()}${ext}`;
        const tempPath = path.join(tempDir, tempName);

        try {
            // Ensure temp directory exists
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // Build validation content: use original file as context for better validation
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

            // Open the document so VSCode/LSP knows about it
            void vs.workspace.openTextDocument(tempUri);

            // Wait for diagnostics from LSP — listen to onDidChangeDiagnostics
            // (LSP will push diagnostics once it processes the new file, or on file open)
            const diags = await new Promise<vs.Diagnostic[]>((resolve) => {
                // Immediately check if already have diagnostics (unlikely but possible)
                const existing = vs.languages.getDiagnostics(tempUri);
                if (existing.length > 0) {
                    resolve(existing);
                    return;
                }

                // Set up listener for diagnostic changes
                const timeout = setTimeout(() => {
                    disposable.dispose();
                    // Even on timeout, return whatever we have
                    resolve(vs.languages.getDiagnostics(tempUri));
                }, 6000); // 6 second timeout

                const disposable = vs.languages.onDidChangeDiagnostics((e) => {
                    // Check if our temp file's diagnostics changed
                    const changedForUs = e.uris.some(u => u.fsPath === tempUri.fsPath);
                    if (changedForUs) {
                        clearTimeout(timeout);
                        disposable.dispose();
                        resolve(vs.languages.getDiagnostics(tempUri));
                    }
                });
            });

            // Calculate offset: if we prepended originalContent, subtract its line count
            const originalLineCount = originalContent ? originalContent.split('\n').length + 2 : 0; // +2 for blank line + comment

            for (const d of diags) {
                // Skip diagnostics that fall within the original content prefix
                const adjustedLine = d.range.start.line - originalLineCount;
                if (originalContent && adjustedLine < 0) continue; // In original file portion

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
            // Clean up temp file
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                // Try to remove the temp directory if empty
                try {
                    const remaining = fs.readdirSync(tempDir);
                    if (remaining.length === 0) fs.rmdirSync(tempDir);
                } catch { /* ignore */ }
            } catch { /* ignore */ }
        }

        return {
            isValid: errors.filter(e => e.severity === 'error').length === 0,
            errors,
        };
    }

    /**
     * Directly read diagnostics from the CWTools LSP — the exact same data
     * shown in VSCode's Problems panel. Zero file I/O; instantaneous.
     *
     * vs.languages.getDiagnostics() returns all diagnostics the LSP server has
     * already pushed via textDocument/publishDiagnostics notifications.
     */
    private async getDiagnostics(args: {
        file?: string;
        severity?: 'error' | 'warning' | 'info' | 'hint' | 'all';
        limit?: number;
    }): Promise<import('./types').GetDiagnosticsResult> {
        const limit = Math.min(args.limit ?? 100, 500);
        const severityFilter = args.severity && args.severity !== 'all' ? args.severity : null;

        // vs.languages.getDiagnostics() returns all [uri, diagnostics[]] pairs
        // that ANY language server (including CWTools) has published.
        const allPairs = vs.languages.getDiagnostics();

        const entries: import('./types').DiagnosticEntry[] = [];
        const filesWithDiags = new Set<string>();

        for (const [uri, diags] of allPairs) {
            if (diags.length === 0) continue;

            const fsPath = uri.fsPath;

            // File filter: skip files that don't match the requested path/prefix
            if (args.file) {
                const fileNorm = args.file.replace(/\\/g, '/').toLowerCase();
                const pathNorm = fsPath.replace(/\\/g, '/').toLowerCase();
                if (!pathNorm.includes(fileNorm)) continue;
            }

            // Skip temporary validation files we may have created
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
                    logicalPath: path.relative(this.workspaceRoot, fsPath).replace(/\\/g, '/'),
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
            errors:   entries.filter(e => e.severity === 'error').length,
            warnings: entries.filter(e => e.severity === 'warning').length,
            info:     entries.filter(e => e.severity === 'info').length,
            hints:    entries.filter(e => e.severity === 'hint').length,
        };

        // Total count across all pairs (for "total in workspace" info)
        let totalDiagCount = 0;
        for (const [uri, diags] of allPairs) {
            if (uri.fsPath.includes('.cwtools-ai-tmp')) continue;
            if (args.file) {
                const fileNorm = args.file.replace(/\\/g, '/').toLowerCase();
                if (!uri.fsPath.replace(/\\/g, '/').toLowerCase().includes(fileNorm)) continue;
            }
            totalDiagCount += diags.length;
        }

        return {
            summary,
            diagnostics: entries,
            totalFiles: filesWithDiags.size,
            truncated: totalDiagCount > limit,
        };
    }

    private async getFileContext(args: { file: string; line: number; radius?: number }): Promise<GetFileContextResult> {
        const radius = args.radius ?? 20;
        try {
            const content = fs.readFileSync(args.file, 'utf-8');
            const lines = content.split('\n');
            const startLine = Math.max(0, args.line - radius);
            const endLine = Math.min(lines.length - 1, args.line + radius);
            const contextLines = lines.slice(startLine, endLine + 1);

            // Determine file type from path
            const relPath = path.relative(this.workspaceRoot, args.file).replace(/\\/g, '/');
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

    private async searchModFiles(args: { query: string; directory?: string; fileExtension?: string }): Promise<SearchModFilesResult> {
        const results: SearchModFilesResult['files'] = [];

        // Use all open workspace folders, not just workspaceRoot
        const workspaceFolders = vs.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [this.workspaceRoot];

        const searchRoots: string[] = [];
        if (args.directory) {
            // Try the directory under each workspace folder
            for (const wsRoot of workspaceFolders) {
                const candidate = path.join(wsRoot, args.directory);
                if (fs.existsSync(candidate)) searchRoots.push(candidate);
            }
            // Fallback to raw path if given
            if (searchRoots.length === 0 && fs.existsSync(args.directory)) {
                searchRoots.push(args.directory);
            }
        }
        if (searchRoots.length === 0) {
            searchRoots.push(...workspaceFolders);
        }

        const ext = args.fileExtension ?? '.txt';
        const queryLower = args.query.toLowerCase();

        for (const searchRoot of searchRoots) {
            try {
                const files = this.findFiles(searchRoot, ext, 1000);
                for (const file of files) {
                    if (results.length >= 50) break;
                    try {
                        const content = fs.readFileSync(file, 'utf-8');
                        const contentLower = content.toLowerCase();
                        if (!contentLower.includes(queryLower)) continue;

                        const lines = content.split('\n');
                        const matchingLines: Array<{ line: number; content: string }> = [];
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].toLowerCase().includes(queryLower)) {
                                matchingLines.push({ line: i, content: lines[i].trim().substring(0, 200) });
                            }
                            if (matchingLines.length >= 20) break;
                        }
                        results.push({
                            path: file,
                            logicalPath: path.relative(searchRoot, file).replace(/\\/g, '/'),
                            matchingLines,
                        });
                    } catch { /* skip unreadable */ }
                }
            } catch { /* skip inaccessible dirs */ }
        }

        return {
            files: results,
            searchedRoot: searchRoots.join(', '),
            totalFound: results.length,
        } as SearchModFilesResult;
    }

    private async getCompletionAt(args: { file: string; line: number; column: number }): Promise<GetCompletionAtResult> {
        try {
            const uri = vs.Uri.file(args.file);
            const position = new vs.Position(args.line, args.column);
            const completions = await vs.commands.executeCommand<vs.CompletionList>(
                'vscode.executeCompletionItemProvider', uri, position
            );

            if (completions) {
                return {
                    completions: completions.items.slice(0, 50).map(item => ({
                        label: typeof item.label === 'string' ? item.label : item.label.label,
                        kind: vs.CompletionItemKind[item.kind ?? vs.CompletionItemKind.Text],
                        description: typeof item.detail === 'string' ? item.detail : undefined,
                    })),
                };
            }
            return { completions: [] };
        } catch {
            return { completions: [] };
        }
    }

    private async documentSymbols(args: { file: string }): Promise<DocumentSymbolsResult> {
        try {
            const uri = vs.Uri.file(args.file);
            const symbols = await vs.commands.executeCommand<vs.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', uri
            );

            if (!symbols || symbols.length === 0) {
                return { symbols: [] };
            }

            const mapSymbol = (s: vs.DocumentSymbol): DocumentSymbolInfo => ({
                name: s.name,
                kind: vs.SymbolKind[s.kind],
                range: {
                    startLine: s.range.start.line,
                    endLine: s.range.end.line,
                },
                children: s.children && s.children.length > 0
                    ? s.children.map(mapSymbol)
                    : undefined,
            });

            return { symbols: symbols.map(mapSymbol) };
        } catch {
            return { symbols: [] };
        }
    }

    private async workspaceSymbols(args: { query: string; limit?: number }): Promise<WorkspaceSymbolsResult> {
        try {
            const limit = args.limit ?? 30;
            const symbols = await vs.commands.executeCommand<vs.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider', args.query
            );

            if (!symbols || symbols.length === 0) {
                return { symbols: [] };
            }

            return {
                symbols: symbols.slice(0, limit).map(s => ({
                    name: s.name,
                    kind: vs.SymbolKind[s.kind],
                    file: path.relative(this.workspaceRoot, s.location.uri.fsPath).replace(/\\/g, '/'),
                    line: s.location.range.start.line,
                })),
            };
        } catch {
            return { symbols: [] };
        }
    }

    private async todoWrite(args: { todos: TodoItem[] }): Promise<TodoWriteResult> {
        this.currentTodos = args.todos;
        this.onTodoUpdate?.(this.currentTodos);
        return {
            success: true,
            todoCount: this.currentTodos.length,
        };
    }

    /** Get the current TODO list (for external access) */
    getTodos(): TodoItem[] {
        return [...this.currentTodos];
    }

    /** Clear todos (e.g., when starting a new topic) */
    clearTodos(): void {
        this.currentTodos = [];
    }

    // ─── File Tools ──────────────────────────────────────────────────────────

    private async readFile(args: { file: string; startLine?: number; endLine?: number }): Promise<import('./types').ReadFileResult> {
        try {
            const content = fs.readFileSync(args.file, 'utf-8');
            const lines = content.split('\n');
            const totalLines = lines.length;

            const start = args.startLine ? Math.max(1, args.startLine) - 1 : 0;
            const end = args.endLine ? Math.min(totalLines, args.endLine) : totalLines;
            const slice = lines.slice(start, end);

            // Prepend line numbers
            const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');

            const MAX_READ_CHARS = 12000;
            const truncated = numbered.length > MAX_READ_CHARS;
            return {
                content: truncated ? numbered.substring(0, MAX_READ_CHARS) + '\n[... truncated ...]' : numbered,
                totalLines,
                truncated,
            };
        } catch (e) {
            return { content: `Error reading file: ${String(e)}`, totalLines: 0, truncated: false };
        }
    }

    private async writeFile(args: { file: string; content: string }): Promise<import('./types').WriteFileResult> {
        try {
            // Generate diff for display / confirmation
            let originalContent = '';
            try { originalContent = fs.readFileSync(args.file, 'utf-8'); } catch { /* new file */ }

            const diff = this.generateSimpleDiff(args.file, originalContent, args.content);

            if (this.fileWriteMode === 'confirm' && this.onPendingWrite && !(args as any)._autoApply) {
                const messageId = `write_${Date.now()}`;
                const confirmed = await this.onPendingWrite(args.file, args.content, messageId);
                if (!confirmed) {
                    return { success: false, message: '用户取消了写入操作' };
                }
            }

            // Ensure directory exists
            const dir = path.dirname(args.file);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(args.file, args.content, 'utf-8');
            return { success: true, message: `文件已写入: ${args.file}` };
        } catch (e) {
            return { success: false, message: `写入失败: ${String(e)}` };
        }
    }

    // ─── OpenCode-style edit_file tool ───────────────────────────────────────

    /**
     * Performs an exact string substitution in a file, falling back through 8
     * Replacer strategies to tolerate minor AI-produced whitespace differences.
     * After writing, pulls real-time LSP diagnostics for the file.
     */
    private async editFile(args: {
        filePath: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
    }): Promise<import('./types').EditFileResult> {
        const filePath = args.filePath;
        let originalContent = '';
        try {
            if (fs.existsSync(filePath)) {
                originalContent = fs.readFileSync(filePath, 'utf-8');
            }
        } catch (e) {
            return { success: false, message: `无法读取文件: ${String(e)}` };
        }

        // ── Create new file (oldString === '') ──────────────────────────────
        let newContent: string;
        if (args.oldString === '') {
            newContent = args.newString;
        } else {
            if (args.oldString === args.newString) {
                return { success: false, message: 'oldString 与 newString 完全相同，无需修改' };
            }
            const ending = this.detectLineEnding(originalContent);
            const old = this.convertLineEnding(this.normalizeLineEndings(args.oldString), ending);
            const next = this.convertLineEnding(this.normalizeLineEndings(args.newString), ending);
            try {
                newContent = this.replace(originalContent, old, next, args.replaceAll ?? false);
            } catch (e) {
                return { success: false, message: String(e) };
            }
        }

        const diff = this.buildUnifiedDiff(filePath, originalContent, newContent);

        // ── Confirm mode: show diff viewer and wait for user ────────────────
        if (this.fileWriteMode === 'confirm' && this.onPendingWrite && !(args as any)._autoApply) {
            const confirmed = await this.onPendingWrite(filePath, newContent, `edit_${Date.now()}`);
            if (!confirmed) {
                return { success: false, message: '用户取消了编辑操作', pendingDiff: diff };
            }
        }

        // ── Write file ─────────────────────────────────────────────────────
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, newContent, 'utf-8');
        } catch (e) {
            return { success: false, message: `写入失败: ${String(e)}` };
        }

        // ── Pull LSP diagnostics for this file ─────────────────────────────
        const diagnostics = await this.getLspDiagnosticsForFile(filePath);
        let message = `文件已更新: ${path.basename(filePath)}`;
        const errors = diagnostics.filter(d => d.severity === 'error');
        if (errors.length > 0) {
            message += `\n\nLSP 检测到 ${errors.length} 个错误，请修复：\n` +
                errors.slice(0, 5).map(e => `  第 ${e.line + 1} 行: ${e.message}`).join('\n');
        }
        return { success: true, message, diff, diagnostics };
    }

    /** Wait (up to 2s) for LSP to process a file, then return its diagnostics */
    private async getLspDiagnosticsForFile(filePath: string): Promise<import('./types').ValidationError[]> {
        try {
            const uri = vs.Uri.file(filePath);
            try { void vs.workspace.openTextDocument(uri); } catch { /* may already be open */ }
            await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, 2000);
                const sub = vs.languages.onDidChangeDiagnostics((e) => {
                    if (e.uris.some(u => u.fsPath === uri.fsPath)) {
                        clearTimeout(t); sub.dispose(); resolve();
                    }
                });
            });
            return vs.languages.getDiagnostics(uri).map(d => ({
                code: String(d.code ?? ''),
                severity: d.severity === vs.DiagnosticSeverity.Error ? 'error'
                    : d.severity === vs.DiagnosticSeverity.Warning ? 'warning'
                    : d.severity === vs.DiagnosticSeverity.Information ? 'info' : 'hint',
                message: d.message,
                line: d.range.start.line,
                column: d.range.start.character,
            } as import('./types').ValidationError));
        } catch { return []; }
    }

    // ─── OpenCode Replacer Suite ─────────────────────────────────────────────
    // Ported from: opencode/packages/opencode/src/tool/edit.ts

    private normalizeLineEndings(text: string): string { return text.split('\r\n').join('\n'); }
    private detectLineEnding(text: string): '\n' | '\r\n' { return text.includes('\r\n') ? '\r\n' : '\n'; }
    private convertLineEnding(text: string, ending: '\n' | '\r\n'): string {
        return ending === '\n' ? text : text.split('\n').join('\r\n');
    }

    private levenshtein(a: string, b: string): number {
        if (!a.length || !b.length) return Math.max(a.length, b.length);
        const m = Array.from({ length: a.length + 1 }, (_, i) =>
            Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
        for (let i = 1; i <= a.length; i++)
            for (let j = 1; j <= b.length; j++) {
                const c = a[i-1] === b[j-1] ? 0 : 1;
                m[i][j] = Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1]+c);
            }
        return m[a.length][b.length];
    }

    private *simpleReplacer(_c: string, find: string): Generator<string> { yield find; }

    private *lineTrimmedReplacer(content: string, find: string): Generator<string> {
        const oL = content.split('\n'), sL = find.split('\n');
        if (sL[sL.length-1] === '') sL.pop();
        for (let i = 0; i <= oL.length - sL.length; i++) {
            if (sL.every((s, j) => oL[i+j].trim() === s.trim())) {
                let st = 0; for (let k=0;k<i;k++) st += oL[k].length+1;
                let en = st; for (let k=0;k<sL.length;k++) { en += oL[i+k].length; if (k<sL.length-1) en+=1; }
                yield content.substring(st, en);
            }
        }
    }

    private *blockAnchorReplacer(content: string, find: string): Generator<string> {
        const oL = content.split('\n'), sL = find.split('\n');
        if (sL.length < 3) return;
        if (sL[sL.length-1] === '') sL.pop();
        const first = sL[0].trim(), last = sL[sL.length-1].trim();
        const cands: {s:number; e:number}[] = [];
        for (let i=0; i<oL.length; i++) {
            if (oL[i].trim() !== first) continue;
            for (let j=i+2; j<oL.length; j++) { if (oL[j].trim() === last) { cands.push({s:i,e:j}); break; } }
        }
        if (!cands.length) return;
        const score = (s: number, e: number) => {
            const check = Math.min(sL.length-2, e-s-1);
            if (check <= 0) return 1.0;
            let sim = 0;
            for (let j=1; j<sL.length-1 && j<e-s; j++) {
                const mx = Math.max(oL[s+j].trim().length, sL[j].trim().length);
                if (mx) sim += (1 - this.levenshtein(oL[s+j].trim(), sL[j].trim()) / mx) / check;
            }
            return sim;
        };
        const extract = (s: number, e: number) => {
            let st=0; for (let k=0;k<s;k++) st+=oL[k].length+1;
            let en=st; for (let k=s;k<=e;k++) { en+=oL[k].length; if (k<e) en+=1; }
            return content.substring(st, en);
        };
        if (cands.length === 1) { if (score(cands[0].s, cands[0].e) >= 0) yield extract(cands[0].s, cands[0].e); return; }
        let best=cands[0], bestSim=-1;
        for (const {s,e} of cands) { const sim=score(s,e); if (sim>bestSim) { bestSim=sim; best={s,e}; } }
        if (bestSim >= 0.3) yield extract(best.s, best.e);
    }

    private *whitespaceNormalizedReplacer(content: string, find: string): Generator<string> {
        const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
        const nF = norm(find), lns = content.split('\n'), fL = find.split('\n');
        if (fL.length === 1) { for (const l of lns) { if (norm(l) === nF) yield l; } return; }
        for (let i=0; i<=lns.length-fL.length; i++)
            if (norm(lns.slice(i, i+fL.length).join('\n')) === nF) yield lns.slice(i, i+fL.length).join('\n');
    }

    private *indentationFlexibleReplacer(content: string, find: string): Generator<string> {
        const strip = (text: string) => {
            const lns = text.split('\n'), ne = lns.filter(l => l.trim().length > 0);
            if (!ne.length) return text;
            const min = Math.min(...ne.map(l => { const m=l.match(/^(\s*)/); return m?m[1].length:0; }));
            return lns.map(l => l.trim().length === 0 ? l : l.slice(min)).join('\n');
        };
        const nF = strip(find), lns = content.split('\n'), fL = find.split('\n');
        for (let i=0; i<=lns.length-fL.length; i++) {
            const b = lns.slice(i, i+fL.length).join('\n');
            if (strip(b) === nF) yield b;
        }
    }

    private *escapeNormalizedReplacer(content: string, find: string): Generator<string> {
        const un = (s: string) => s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_m, c: string) =>
            ({n:'\n',t:'\t',r:'\r',"'":"'",'"':'"','`':'`','\\':'\\','\n':'\n','$':'$'}[c] ?? _m));
        const uF = un(find);
        if (content.includes(uF)) { yield uF; return; }
        const lns = content.split('\n'), fL = uF.split('\n');
        if (fL.length > 1) for (let i=0; i<=lns.length-fL.length; i++) {
            const b = lns.slice(i, i+fL.length).join('\n');
            if (un(b) === uF) yield b;
        }
    }

    private *trimmedBoundaryReplacer(content: string, find: string): Generator<string> {
        const trimmed = find.trim();
        if (trimmed === find) return;
        if (content.includes(trimmed)) { yield trimmed; return; }
        const lns = content.split('\n'), fL = find.split('\n');
        for (let i=0; i<=lns.length-fL.length; i++) {
            const b = lns.slice(i, i+fL.length).join('\n');
            if (b.trim() === trimmed) yield b;
        }
    }

    private *contextAwareReplacer(content: string, find: string): Generator<string> {
        const fL = find.split('\n');
        if (fL.length < 3) return;
        if (fL[fL.length-1] === '') fL.pop();
        const cL = content.split('\n');
        const fl = fL[0].trim(), ll = fL[fL.length-1].trim();
        for (let i=0; i<cL.length; i++) {
            if (cL[i].trim() !== fl) continue;
            for (let j=i+2; j<cL.length; j++) {
                if (cL[j].trim() !== ll) continue;
                const b = cL.slice(i, j+1);
                if (b.length !== fL.length) break;
                let hit=0, tot=0;
                for (let k=1; k<b.length-1; k++) {
                    if (b[k].trim().length || fL[k].trim().length) { tot++; if (b[k].trim()===fL[k].trim()) hit++; }
                }
                if (tot===0 || hit/tot >= 0.5) { yield b.join('\n'); break; }
                break;
            }
        }
    }

    /** Main replace: try each of the 8 Replacers in order, first match wins */
    private replace(content: string, oldString: string, newString: string, replaceAll: boolean): string {
        if (oldString === newString) throw new Error('oldString 与 newString 完全相同，无需修改');
        const replacers = [
            this.simpleReplacer.bind(this),
            this.lineTrimmedReplacer.bind(this),
            this.blockAnchorReplacer.bind(this),
            this.whitespaceNormalizedReplacer.bind(this),
            this.indentationFlexibleReplacer.bind(this),
            this.escapeNormalizedReplacer.bind(this),
            this.trimmedBoundaryReplacer.bind(this),
            this.contextAwareReplacer.bind(this),
        ] as const;
        for (const replacer of replacers) {
            for (const search of replacer(content, oldString)) {
                const idx = content.indexOf(search);
                if (idx === -1) continue;
                if (replaceAll) return search.length > 0 ? content.split(search).join(newString) : content;
                const lastIdx = content.lastIndexOf(search);
                if (idx !== lastIdx) throw new Error(
                    '在文件中找到多个匹配项。请在 oldString 中提供更多上下文使其唯一，或使用 replaceAll=true。'
                );
                return content.substring(0, idx) + newString + content.substring(idx + search.length);
            }
        }
        throw new Error(
            '在文件中找不到 oldString。必须精确匹配（包括空白符、缩进和行尾符）。\n' +
            '提示：先使用 read_file 读取文件内容，再将读取到的确切文本作为 oldString。'
        );
    }

    private buildUnifiedDiff(filePath: string, original: string, modified: string): string {
        const name = path.basename(filePath);
        const oL = original.split('\n'), mL = modified.split('\n');
        let diff = `--- ${name}\n+++ ${name}\n`, changed = 0;
        let i=0, j=0;
        while ((i < oL.length || j < mL.length) && changed < 80) {
            if (oL[i] === mL[j]) { i++; j++; }
            else { changed++; if (i<oL.length) { diff += `- ${oL[i++]}\n`; } if (j<mL.length) { diff += `+ ${mL[j++]}\n`; } }
        }
        return changed === 0 ? diff + '(无变更)\n' : diff;
    }

    /** @deprecated kept for compatibility with writeFile's existing call */
    private generateSimpleDiff(filePath: string, original: string, modified: string): string {
        return this.buildUnifiedDiff(filePath, original, modified);
    }

    private async listDirectory(args: { directory: string; recursive?: boolean }): Promise<import('./types').ListDirectoryResult> {
        try {
            // Resolve relative paths against workspace root
            const dirPath = path.isAbsolute(args.directory)
                ? args.directory
                : path.join(this.workspaceRoot, args.directory);

            if (!fs.existsSync(dirPath)) {
                return { entries: [], path: dirPath };
            }

            const entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }> = [];
            this._listDir(dirPath, dirPath, entries, args.recursive ?? false, 0, 3);

            return { entries: entries.slice(0, 200), path: dirPath };
        } catch (e) {
            return { entries: [], path: args.directory };
        }
    }

    private _listDir(
        baseDir: string,
        currentDir: string,
        results: Array<{ name: string; type: 'file' | 'directory'; size?: number }>,
        recursive: boolean,
        depth: number,
        maxDepth: number
    ): void {
        if (depth > maxDepth || results.length >= 200) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= 200) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const relPath = path.relative(baseDir, path.join(currentDir, entry.name)).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                results.push({ name: relPath + '/', type: 'directory' });
                if (recursive) {
                    this._listDir(baseDir, path.join(currentDir, entry.name), results, recursive, depth + 1, maxDepth);
                }
            } else {
                const stat = fs.statSync(path.join(currentDir, entry.name));
                results.push({ name: relPath, type: 'file', size: stat.size });
            }
        }
    }

    // ─── Helper Methods ──────────────────────────────────────────────────────

    private findFiles(dir: string, ext: string, maxFiles = 500): string[] {
        const results: string[] = [];
        try {
            this._walkDir(dir, ext, results, maxFiles);
        } catch { /* skip */ }
        return results;
    }

    private _walkDir(dir: string, ext: string, results: string[], maxFiles: number): void {
        if (results.length >= maxFiles) return;
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxFiles) return;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Skip hidden directories and node_modules
                if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    this._walkDir(fullPath, ext, results, maxFiles);
                }
            } else if (entry.name.endsWith(ext)) {
                results.push(fullPath);
            }
        }
    }

    /**
     * Load and parse CWT rule definitions from the config directory.
     */
    private async loadCWTRules(): Promise<{ triggers: RuleInfo[]; effects: RuleInfo[] }> {
        const triggers: RuleInfo[] = [];
        const effects: RuleInfo[] = [];

        // Find config directory (in submodules or workspace)
        const configPaths = [
            path.join(this.workspaceRoot, 'submodules', 'cwtools-stellaris-config', 'config'),
            // Also check common extension installation paths
        ];

        // Try to find the extension's own config
        const ext = vs.extensions.getExtension('tboby.cwtools-vscode') ??
                    vs.extensions.getExtension('cwtools.cwtools-vscode');
        if (ext) {
            configPaths.push(path.join(ext.extensionPath, 'config'));
        }

        for (const configPath of configPaths) {
            const triggersFile = path.join(configPath, 'triggers.cwt');
            const effectsFile = path.join(configPath, 'effects.cwt');

            if (fs.existsSync(triggersFile)) {
                this.parseCWTFile(triggersFile, triggers);
            }
            if (fs.existsSync(effectsFile)) {
                this.parseCWTFile(effectsFile, effects);
            }

            if (triggers.length > 0 || effects.length > 0) break;
        }

        return { triggers, effects };
    }

    /**
     * Simple CWT file parser that extracts alias definitions.
     * Parses lines like: alias[trigger:xxx] = { ... }
     */
    private parseCWTFile(filePath: string, results: RuleInfo[]): void {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');

            // Pattern: alias[trigger:name] or alias[effect:name]
            const aliasPattern = /^##\s*scope\s*=\s*\{?\s*([^}]*)\}?\s*$/i;
            const namePattern = /^alias\[(?:trigger|effect):(\w+)\]\s*=\s*(.*)/;

            let currentScopes: string[] = [];
            let currentDesc = '';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                // Capture scope comment
                const scopeMatch = line.match(aliasPattern);
                if (scopeMatch) {
                    currentScopes = scopeMatch[1].split(/\s+/).filter(s => s.length > 0);
                    continue;
                }

                // Capture description comment
                if (line.startsWith('## ') && !line.startsWith('## scope')) {
                    currentDesc = line.substring(3).trim();
                    continue;
                }

                // Capture alias definition
                const nameMatch = line.match(namePattern);
                if (nameMatch) {
                    const [, name, syntax] = nameMatch;
                    results.push({
                        name,
                        description: currentDesc,
                        scopes: [...currentScopes],
                        syntax: syntax.trim(),
                    });
                    currentDesc = '';
                    // Don't reset scopes - they persist until next scope comment
                }
            }
        } catch { /* skip */ }
    }
}
