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
];

// ─── Tool Executor ───────────────────────────────────────────────────────────

/**
 * Executes Agent tools by communicating with the CWTools Language Server
 * and directly reading workspace files.
 */
export class AgentToolExecutor {
    private cwtRulesCache: { triggers: RuleInfo[]; effects: RuleInfo[] } | null = null;
    private currentTodos: TodoItem[] = [];
    /** Callback when todos are updated (for UI) */
    public onTodoUpdate?: (todos: TodoItem[]) => void;

    constructor(
        private client: LanguageClient,
        private workspaceRoot: string
    ) {}

    /**
     * Execute a tool by name with the given arguments.
     */
    async execute(toolName: AgentToolName, args: Record<string, unknown>): Promise<unknown> {
        switch (toolName) {
            case 'query_scope':
                return this.queryScope(args as any);
            case 'query_types':
                return this.queryTypes(args as any);
            case 'query_rules':
                return this.queryRules(args as any);
            case 'query_references':
                return this.queryReferences(args as any);
            case 'validate_code':
                return this.validateCode(args as any);
            case 'get_file_context':
                return this.getFileContext(args as any);
            case 'search_mod_files':
                return this.searchModFiles(args as any);
            case 'get_completion_at':
                return this.getCompletionAt(args as any);
            case 'document_symbols':
                return this.documentSymbols(args as any);
            case 'workspace_symbols':
                return this.workspaceSymbols(args as any);
            case 'todo_write':
                return this.todoWrite(args as any);
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
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
        try {
            const errors: ValidationError[] = [];

            // Write to system temp dir (NOT workspace) to avoid CWTools rescanning it
            const os = await import('os');
            const tempDir = os.tmpdir();
            const tempName = `cwtools_ai_validate_${Date.now()}.txt`;
            const tempPath = path.join(tempDir, tempName);

            try {
                // If target exists, include surrounding context for better validation
                let originalContent = '';
                try { originalContent = fs.readFileSync(args.targetFile, 'utf-8'); } catch { /* ok */ }

                const contentToValidate = originalContent
                    ? originalContent + '\n' + args.code
                    : args.code;

                fs.writeFileSync(tempPath, contentToValidate, 'utf-8');

                // Open as untitled in VSCode so LSP can see it without scanning workspace
                const tempUri = vs.Uri.file(tempPath);
                await new Promise(resolve => setTimeout(resolve, 800));

                const diags = vs.languages.getDiagnostics(tempUri);
                for (const d of diags) {
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
            } finally {
                try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
            }

            return {
                isValid: errors.filter(e => e.severity === 'error').length === 0,
                errors,
            };
        } catch (e) {
            return {
                isValid: false,
                errors: [{ code: 'VALIDATION_ERROR', severity: 'error', message: String(e), line: 0, column: 0 }],
            };
        }
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
