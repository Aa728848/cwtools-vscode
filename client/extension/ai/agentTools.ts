/**
 * Eddy CWTool Code Module — Agent Tools
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
            description: '\u26a0\ufe0f MANDATORY before using any game ID for the first time. Query defined instances of a specific Stellaris type. Searches BOTH the current mod AND the vanilla game cache loaded by the CWTools language server. PDXscript IDs are routinely hallucinated by LLMs — always verify through this tool before using any technology, building, trait, scripted_trigger, scripted_effect, event, or archaeological_site ID in generated code. Set filter to narrow results and avoid token waste. Never call read_file on vanilla game files — this cache is faster and more complete.',
            parameters: {
                type: 'object',
                properties: {
                    typeName: { type: 'string', description: 'Type name, e.g. "technology", "building", "trait", "ethic", "authority", "pop_job", "static_modifier", "scripted_trigger", "scripted_effect", "event", "archaeological_site"' },
                    filter: { type: 'string', description: 'Prefix or substring filter, e.g. "tech_" to return only matching results. ALWAYS use when looking up a specific vanilla ID to avoid getting hundreds of unrelated results.' },
                    limit: { type: 'number', description: 'Max results to return (default 30, keep low for token efficiency)' },
                    vanilla: { type: 'boolean', description: 'If true, return ONLY vanilla game definitions. If false (default), return mod + vanilla combined.' },
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
            description: 'Get auto-completion suggestions at a specific position. The CWTools language server returns completions from BOTH the current mod AND the vanilla game cache — this is the most token-efficient way to discover valid vanilla identifiers at a given position. Use it to answer "what values can go here?"',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path (must be in the workspace)' },
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
            description: 'Search for symbol definitions by name, across the ENTIRE workspace including the vanilla game cache loaded by CWTools. Use this to locate where any vanilla event, decision, starbase module, ship section, etc. is defined. For token efficiency, always use a specific query (e.g. "tech_energy_grid" not "tech"). Results include the origin file path — vanilla files will show their game install path.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Symbol name or partial name to search for. Be specific to avoid large result sets.' },
                    limit: { type: 'number', description: 'Max results (default 20, keep low for vanilla searches to avoid token waste)' },
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
            description: 'Read file content with optional line range. Always returns line numbers. **For large files (>150 lines), you MUST use startLine+endLine to read only the section you need.** Recommended workflow for unknown files: (1) call document_symbols to get structure and line ranges, (2) call read_file with the specific startLine/endLine for the symbol you want. Never read the entire file just to find one function. Max output is ~12000 chars; if truncated, the response includes totalLines and a hint telling you how to read the next section.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    startLine: { type: 'number', description: 'Start line (1-based). Required for large files.' },
                    endLine: { type: 'number', description: 'End line (1-based inclusive). Keep the range under 150 lines where possible.' },
                },
                required: ['file'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write content to a file, replacing its entire content. Use this for creating brand-new files (do NOT use validate_code for this). If agentFileWriteMode is "confirm", shows a diff view for user approval.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    content: { type: 'string', description: 'New file content' },
                    encoding: { type: 'string', enum: ['utf8', 'utf8bom'], description: 'File encoding. Use utf8bom if sibling files in the same directory have a BOM header (\uFEFF). Default: utf8bom (Stellaris files typically use UTF-8 BOM).' },
                },
                required: ['file', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Make precise string substitutions in files. **To create a new file, set oldString to empty string ""** — this writes newString as the entire file content directly (no temp files). To edit existing files, provide exact oldString to replace. After writing, returns real-time LSP diagnostics. Subject to agentFileWriteMode.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute path to the file to modify' },
                    oldString: { type: 'string', description: 'The exact text to replace. **Use empty string "" to create a new file.**' },
                    newString: { type: 'string', description: 'The replacement text (must differ from oldString)' },
                    replaceAll: { type: 'boolean', description: 'If true, replace all occurrences. Default: false.' },
                    encoding: { type: 'string', enum: ['utf8', 'utf8bom'], description: 'File encoding for new files. Use utf8bom if sibling files have BOM. Default: utf8bom.' },
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
    {
        type: 'function',
        function: {
            name: 'glob_files',
            description: 'Find files in the workspace using glob patterns (e.g. "**/*.txt", "common/scripted_triggers/*.txt"). Faster than list_directory for targeted file discovery. Returns absolute paths.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern relative to workspace root, e.g. "events/**/*.txt" or "common/scripted_triggers/*.txt"' },
                    limit: { type: 'number', description: 'Max files to return (default 200)' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lsp_operation',
            description: 'Perform a Language Server Protocol (LSP) operation on a file position. Supports: goToDefinition (find where an identifier is defined), findReferences (find all usages), hover (get type/scope info at position), rename (preview rename refactor). Requires an open or cached file.',
            parameters: {
                type: 'object',
                properties: {
                    operation: { type: 'string', enum: ['goToDefinition', 'findReferences', 'hover', 'rename'], description: 'LSP operation to perform' },
                    file: { type: 'string', description: 'Absolute file path' },
                    line: { type: 'number', description: 'Line number (0-based)' },
                    column: { type: 'number', description: 'Column number (0-based)' },
                    newName: { type: 'string', description: 'For rename operation: the new identifier name' },
                },
                required: ['operation', 'file', 'line', 'column'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch the text content of a public URL (e.g. Stellaris wiki pages, GitHub raw files). Converts HTML to plain text. Use for looking up game mechanics, modding documentation, or locating vanilla definitions online.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to fetch (must be http:// or https://)' },
                    maxChars: { type: 'number', description: 'Max characters to return (default 8000)' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command in the workspace directory. REQUIRES user permission for each new command. Safe commands (e.g. npm run lint, git status) are allowed; destructive commands are denied. Always explain what the command does before running it.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The shell command to execute' },
                    cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' },
                    timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 15000, max 60000)' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Search the web for information about Stellaris modding, PDXScript syntax, game mechanics, or any topic. Uses Brave Search API if configured (cwtools.ai.braveSearchApiKey), otherwise falls back to DuckDuckGo. Returns result summaries with URLs.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query. Be specific. Example: "Stellaris relic activation trigger conditions"' },
                    maxResults: { type: 'number', description: 'Max results to return (default 5, max 10)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'apply_patch',
            description: 'Apply a unified diff patch to one or more files atomically. Use this instead of multiple edit_file calls when you have a git-style patch. All hunks must succeed or none are written.',
            parameters: {
                type: 'object',
                properties: {
                    patch: { type: 'string', description: 'Unified diff patch string (--- a/file ... +++ b/file ... @@ ...). File paths relative to workspace root or absolute.' },
                    cwd: { type: 'string', description: 'Working directory for resolving relative paths (defaults to workspace root)' },
                },
                required: ['patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'multiedit',
            description: 'Apply multiple edits to a SINGLE file in one atomic operation. All edits applied in sequence; only written to disk if ALL succeed. More efficient than multiple edit_file calls. Uses same fuzzy-matching as edit_file. **IMPORTANT**: if oldString appears multiple times in the file, either (a) add more surrounding context lines to make it unique, or (b) set `replaceAll=true` on that edit item.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute path to the file to modify' },
                    edits: {
                        type: 'array',
                        description: 'List of edits to apply in order',
                        items: {
                            type: 'object',
                            properties: {
                                oldString: { type: 'string', description: 'The exact text to replace. Must be unique in the file, OR set replaceAll=true.' },
                                newString: { type: 'string', description: 'The replacement text' },
                                replaceAll: { type: 'boolean', description: 'If true, replace ALL occurrences of oldString. Use when the same pattern appears multiple times and you want to change all of them. Default: false.' },
                            },
                            required: ['oldString', 'newString'],
                        },
                    },
                    encoding: { type: 'string', enum: ['utf8', 'utf8bom'], description: 'File encoding. Default: utf8bom.' },
                },
                required: ['filePath', 'edits'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'task',
            description: 'Dispatch a sub-task to a specialized sub-agent for research/exploration. The sub-agent runs independently and returns findings as text. Sub-agents CANNOT write files. Use "explore" for codebase exploration (read-only), "general" for research (all read + web tools).',
            parameters: {
                type: 'object',
                properties: {
                    description: { type: 'string', description: 'Short label for this sub-task (shown in UI)' },
                    prompt: { type: 'string', description: 'Detailed prompt for the sub-agent. Include all context it needs — it has no access to the parent conversation.' },
                    subagent_type: { type: 'string', enum: ['explore', 'general'], description: 'Sub-agent mode. Default: "general"' },
                },
                required: ['description', 'prompt'],
            },
        },
    },
    // ─── CWTools Deep API tools ──────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'query_definition',
            description: 'Jump to the definition of the symbol under a position (GoToType), or find all references if no definition exists (FindAllRefs). This uses the CWTools AST directly — far faster and more accurate than file-system grep. Use it to locate where any scripted_trigger, scripted_effect, event, or type is defined before reading or editing it.',
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
            name: 'query_definition_by_name',
            description: 'Find where a named symbol is defined by searching the CWTools AST — no file/position needed, just the symbol name. Works for: scripted_trigger, scripted_effect, event IDs, character names, and any other top-level PDXScript key. Much easier than query_definition when you know the name but not the location. Returns file path and line number of the definition.',
            parameters: {
                type: 'object',
                properties: {
                    symbolName: { type: 'string', description: 'The exact name of the symbol to find (e.g. "kuat_has_psionic_research", "distar.001")' },
                },
                required: ['symbolName'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_scripted_effects',
            description: '\u26a0\ufe0f MANDATORY before calling any scripted_effect. List all scripted effects in the current game/mod with their name, valid scope constraints, and effect type. PDXscript training data for LLMs is extremely sparse — scripted_effect names are frequently hallucinated. You MUST call this before using any scripted_effect to verify the exact name and that the call is valid in the current scope. Prevents hallucinated effect names that would cause silent failures.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Optional substring filter on effect name' },
                    limit: { type: 'number', description: 'Max results (default 200)' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_scripted_triggers',
            description: '\u26a0\ufe0f MANDATORY before using any scripted_trigger. List all scripted triggers in the current game/mod with their name, valid scope constraints, and trigger type. PDXscript training data for LLMs is extremely sparse — scripted_trigger names are frequently hallucinated. You MUST call this before using any scripted_trigger to verify the exact name and scope validity. Prevents hallucinated trigger names that would cause silent failures.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Optional substring filter on trigger name' },
                    limit: { type: 'number', description: 'Max results (default 200)' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_enums',
            description: '\u26a0\ufe0f MANDATORY before using any enum field value. Query enum values from the CWTools rule engine. Call with no enumName (or empty string) to list all available enum names. Then query a specific enum to get all valid values. PDXscript enum values are domain-specific and not reliably known to LLMs — always verify before using an enum field to prevent hallucinated values that silently break scripts.',
            parameters: {
                type: 'object',
                properties: {
                    enumName: { type: 'string', description: 'Enum name to query (e.g. "anomaly_category"). Leave empty to list all enum names.' },
                    limit: { type: 'number', description: 'Max values to return (default 500)' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_entity_info',
            description: 'Get deep structural info for a file from the CWTools ComputedData cache: referenced types, defined scripted variables, effect blocks, trigger blocks, and saved event_targets. Use this when you need to understand what a file references before deciding how to modify it, or to get a list of event_targets saved in a scripted_effect.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path (must be a parsed mod file)' },
                },
                required: ['file'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_static_modifiers',
            description: '\u26a0\ufe0f MANDATORY before using any modifier tag in add_modifier. List all static modifiers (from static_modifiers/*.txt files) with their modifier categories. PDXscript modifier tag names are domain-specific and frequently hallucinated by LLMs — always verify that a modifier tag exists and check which scope categories it applies to before using it in generated code.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Optional substring filter on modifier tag' },
                    limit: { type: 'number', description: 'Max results (default 300)' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_variables',
            description: 'List all scripted variables (@variable_name = value) defined across the mod and vanilla. Use this to look up numeric constant values defined with @-prefix before using them in generated code.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Optional substring filter on variable name' },
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
    /** 5-second TTL cache for heavy read-only LSP commands (scripted effects/triggers, enums, modifiers) */
    private lspReadCache = new Map<string, { data: unknown; expiresAt: number }>();
    private currentTodos: TodoItem[] = [];
    /** Callback when todos are updated (for UI) */
    public onTodoUpdate?: (todos: TodoItem[]) => void;
    /** Callback when a file write needs user confirmation (confirm mode).
     * Receives the target file path, the proposed new content, and a messageId.
     * Returns true = confirmed, false = cancelled. */
    public onPendingWrite?: (file: string, newContent: string, messageId: string) => Promise<boolean>;
    /**
     * Callback fired BEFORE any file is written or created.
     * Receives the absolute file path and the file's content BEFORE the write
     * (null if the file did not previously exist — i.e. it is being created).
     * Used by the retract system to snapshot file state for later restoration.
     */
    public onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    /** Agent file write mode from config */
    public fileWriteMode: 'confirm' | 'auto' = 'confirm';
    /**
     * Reference to the parent AgentRunner for task sub-agent dispatch.
     * Set by the owning AgentRunner after construction.
     * L8 Fix: signature includes the optional parentAccumulator parameter.
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

    /**
     * Tracks whether the LSP server has finished loading game data.
     * Set to true when cwtools/serverReady notification arrives.
     */
    private lspServerReady: boolean = false;

    private readonly clientGetter: () => LanguageClient;

    constructor(
        clientOrGetter: LanguageClient | (() => LanguageClient),
        private workspaceRoot: string
    ) {
        // Accept either a direct client or a lazy getter (for early registration before LSP starts)
        this.clientGetter = typeof clientOrGetter === 'function'
            ? clientOrGetter
            : () => clientOrGetter;

        // Listen for LSP server-ready notification
        // The notification fires when game data + vanilla cache are fully loaded
        vs.commands.executeCommand('setContext', 'cwtools.lspReady', false);
        // Register the notification handler. We retry politely since the LanguageClient
        // may not be fully started yet when the executor is constructed.
        const tryRegisterNotif = () => {
            try {
                const c = this.clientGetter();
                if (c) {
                    // vscode-languageclient 8+ removed onReady(); use the client directly.
                    // The registration is idempotent if called multiple times.
                    try {
                        // New API (v8+): no onReady needed, just register directly
                        c.onNotification('cwtools/serverReady', (_params: any) => {
                            this.lspServerReady = true;
                            vs.commands.executeCommand('setContext', 'cwtools.lspReady', true);
                        });
                    } catch {
                        // Old API (v7): wrap in onReady
                        (c as any).onReady?.().then?.(() => {
                            c.onNotification('cwtools/serverReady', (_params: any) => {
                                this.lspServerReady = true;
                                vs.commands.executeCommand('setContext', 'cwtools.lspReady', true);
                            });
                        });
                    }
                }
            } catch { /* ignore, clientGetter not ready yet */ }
        };
        // Try immediately and retry if client not yet started
        tryRegisterNotif();
        setTimeout(tryRegisterNotif, 2000);
        setTimeout(tryRegisterNotif, 5000);
    }

    private get client(): LanguageClient {
        return this.clientGetter();
    }

    /**
     * Execute a tool by name with the given arguments.
     * Results are automatically truncated if too large.
     */
    async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
        let result: unknown;
        switch (toolName as AgentToolName | 'glob_files' | 'lsp_operation' | 'web_fetch' | 'run_command' | 'search_web' | 'apply_patch' | 'multiedit' | 'task') {
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
            // ── New OpenCode-ported tools ─────────────────────────────────────
            case 'glob_files':
                result = await this.globFiles(args as any); break;
            case 'lsp_operation':
                result = await this.lspOperation(args as any); break;
            case 'web_fetch':
                result = await this.webFetch(args as any); break;
            case 'run_command':
                result = await this.runCommand(args as any); break;
            // ── New extended tools ─────────────────────────────────────────────
            case 'search_web':
                result = await this.searchWeb(args as any); break;
            case 'apply_patch':
                result = await this.applyPatch(args as any); break;
            case 'multiedit':
                result = await this.multiEdit(args as any); break;
            case 'task':
                result = await this.dispatchSubTask(args as any); break;
            // ─── CWTools Deep API tools ─────────────────────────────────────
            case 'query_definition':
                result = await this.queryDefinition(args as any); break;
            case 'query_definition_by_name':
                result = await this.queryDefinitionByName(args as any); break;
            case 'query_scripted_effects':
                result = await this.queryScriptedEffects(args as any); break;
            case 'query_scripted_triggers':
                result = await this.queryScriptedTriggers(args as any); break;
            case 'query_enums':
                result = await this.queryEnums(args as any); break;
            case 'get_entity_info':
                result = await this.getEntityInfo(args as any); break;
            case 'query_static_modifiers':
                result = await this.queryStaticModifiers(args as any); break;
            case 'query_variables':
                result = await this.queryVariables(args as any); break;
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
        const unknown: QueryScopeResult = {
            currentScope: 'unknown',
            root: 'unknown',
            thisScope: 'unknown',
            prevChain: [],
            fromChain: [],
        };
        try {
            // ── Strategy 1: Use the structured LSP command (fast, stable, no Markdown parsing) ──
            const uri = vs.Uri.file(args.file);
            try {
                const structResult = await vs.commands.executeCommand<any>(
                    'cwtools.executeServerCommand',
                    'cwtools.ai.getScopeAtPosition',
                    [uri.toString(), args.line, args.column]
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
            } catch { /* structured command not available, fall through to Hover */ }

            // ── Strategy 2: Execute the server command directly via LanguageClient ──
            try {
                const client = this.client;
                if (client) {
                    const raw = await client.sendRequest('workspace/executeCommand', {
                        command: 'cwtools.ai.getScopeAtPosition',
                        arguments: [uri.toString(), args.line, args.column],
                    }) as any;
                    if (raw && raw.ok === true) {
                        return {
                            currentScope: raw.thisScope ?? 'unknown',
                            root: raw.root ?? 'unknown',
                            thisScope: raw.thisScope ?? 'unknown',
                            prevChain: Array.isArray(raw.prevChain) ? raw.prevChain : [],
                            fromChain: Array.isArray(raw.fromChain) ? raw.fromChain : [],
                        };
                    }
                }
            } catch { /* fall through */ }

            // ── Fallback: Hover Markdown parsing (original behaviour, kept for safety) ──
            const position = new vs.Position(args.line, args.column);
            const hovers = await vs.commands.executeCommand<vs.Hover[]>(
                'vscode.executeHoverProvider', uri, position
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
            return unknown;
        }
    }

    // ─── CWTools Deep API tool implementations ───────────────────────────────

    /** Generic TTL-based cache for expensive LSP reads (5s default). */
    private async cachedLspRead<T>(key: string, fetcher: () => Promise<T>, ttlMs = 5000): Promise<T> {
        const now = Date.now();
        const cached = this.lspReadCache.get(key);
        if (cached && cached.expiresAt > now) return cached.data as T;
        const freshData = await fetcher();
        this.lspReadCache.set(key, { data: freshData, expiresAt: now + ttlMs });
        return freshData;
    }

    /** GoToType + FindAllRefs via LSP command — replaces file-system grep */
    private async queryDefinition(args: { file: string; line: number; column: number }): Promise<unknown> {
        try {
            const uri = vs.Uri.file(args.file);
            const raw = await this.client.sendRequest('workspace/executeCommand', {
                command: 'cwtools.ai.queryDefinition',
                arguments: [uri.toString(), args.line, args.column],
            }) as any;
            if (raw && raw.ok === true) return raw;
            return { ok: false, error: 'No definition found' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    /** Find symbol definition by name — searches AllEntities AST, no position needed */
    private async queryDefinitionByName(args: { symbolName?: string }): Promise<unknown> {
        const name = args?.symbolName?.trim();
        if (!name) {
            return {
                ok: false,
                error: 'Missing required parameter: symbolName. You must pass the exact symbol name as a string. Example: query_definition_by_name({ "symbolName": "kuat_has_psionic_research" })',
            };
        }
        try {
            const raw = await this.client.sendRequest('workspace/executeCommand', {
                command: 'cwtools.ai.queryDefinitionByName',
                arguments: [name],
            }) as any;
            return raw ?? { ok: false, error: 'No response from LSP' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    /** All scripted effects with scope constraints */
    private async queryScriptedEffects(args: { filter?: string; limit?: number }): Promise<unknown> {
        // Encode args as JSON to avoid ':' collisions in filter values
        const cacheKey = `sfx:${JSON.stringify([args.filter ?? '', args.limit ?? 200])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.client.sendRequest('workspace/executeCommand', {
                    command: 'cwtools.ai.queryScriptedEffects',
                    arguments: [args.filter ?? '', args.limit ?? 200],
                }) as any;
                return raw ?? { ok: false, error: 'No response' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    /** All scripted triggers with scope constraints */
    private async queryScriptedTriggers(args: { filter?: string; limit?: number }): Promise<unknown> {
        // Encode args as JSON to avoid ':' collisions in filter values
        const cacheKey = `stx:${JSON.stringify([args.filter ?? '', args.limit ?? 200])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.client.sendRequest('workspace/executeCommand', {
                    command: 'cwtools.ai.queryScriptedTriggers',
                    arguments: [args.filter ?? '', args.limit ?? 200],
                }) as any;
                return raw ?? { ok: false, error: 'No response' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    /** Enum values from CachedRuleMetadata */
    private async queryEnums(args: { enumName?: string; limit?: number }): Promise<unknown> {
        // Encode args as JSON to avoid ':' collisions in enumName values
        const cacheKey = `enm:${JSON.stringify([args.enumName ?? '', args.limit ?? 500])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.client.sendRequest('workspace/executeCommand', {
                    command: 'cwtools.ai.queryEnums',
                    arguments: [args.enumName ?? '', args.limit ?? 500],
                }) as any;
                return raw ?? { ok: false, error: 'No response' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    /** Deep entity info from ComputedData cache (refs, vars, effect/trigger blocks, event_targets) */
    private async getEntityInfo(args: { file: string }): Promise<unknown> {
        try {
            const uri = vs.Uri.file(args.file);
            const raw = await this.client.sendRequest('workspace/executeCommand', {
                command: 'cwtools.ai.getEntityInfo',
                arguments: [uri.toString()],
            }) as any;
            return raw ?? { ok: false, error: 'No response' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    /** Static modifiers with category info */
    private async queryStaticModifiers(args: { filter?: string; limit?: number }): Promise<unknown> {
        // Encode args as JSON to avoid ':' collisions in filter values
        const cacheKey = `smod:${JSON.stringify([args.filter ?? '', args.limit ?? 300])}`;
        return this.cachedLspRead(cacheKey, async () => {
            try {
                const raw = await this.client.sendRequest('workspace/executeCommand', {
                    command: 'cwtools.ai.queryStaticModifiers',
                    arguments: [args.filter ?? '', args.limit ?? 300],
                }) as any;
                return raw ?? { ok: false, error: 'No response' };
            } catch (e) { return { ok: false, error: String(e) }; }
        });
    }

    /** Scripted @variable definitions across mod + vanilla */
    private async queryVariables(args: { filter?: string }): Promise<unknown> {
        try {
            const raw = await this.client.sendRequest('workspace/executeCommand', {
                command: 'cwtools.ai.queryVariables',
                arguments: [args.filter ?? ''],
            }) as any;
            return raw ?? { ok: false, error: 'No response' };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────

    private async queryTypes(args: { typeName: string; filter?: string; limit?: number; vanillaOnly?: boolean }): Promise<QueryTypesResult> {
        try {
            const limit = args.limit ?? 50;

            // ── Strategy 1: Use the new structured LSP command (includes vanilla cache) ──
            try {
                const client = this.client;
                if (client) {
                    const raw = await client.sendRequest('workspace/executeCommand', {
                        command: 'cwtools.ai.queryTypes',
                        arguments: [
                            args.typeName,
                            args.filter ?? '',
                            limit,
                            args.vanillaOnly ?? false,
                        ],
                    }) as any;
                    if (raw && raw.ok === true) {
                        const instances = Array.isArray(raw.instances)
                            ? raw.instances.map((i: any) => ({
                                id: i.id ?? '',
                                file: i.file ?? '',
                                line: i.line,
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

            // ── Fallback: File-system scan of local mod files ──
            const instances: Array<{ id: string; file: string; vanilla?: boolean }> = [];

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
                            const keyPattern = /^(\w[\w.-]*)\s*=/gm;
                            let match;
                            while ((match = keyPattern.exec(content)) !== null && instances.length < limit) {
                                const id = match[1];
                                // Use substring match to align with the tool description ("Prefix or substring filter")
                                if (!args.filter || id.includes(args.filter)) {
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
        // Load and parse CWT rule files (lazy cache)
        if (!this.cwtRulesCache) {
            this.cwtRulesCache = await this._loadCWTRules();
        }

        const cache = this.cwtRulesCache;
        let rules: RuleInfo[];
        if (args.category === 'trigger') {
            rules = cache.triggers;
        } else if (args.category === 'effect') {
            rules = cache.effects;
        } else {
            rules = [...cache.triggers, ...cache.effects];
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

    /** Load and parse CWT rule definitions from the config directory. */
    private async _loadCWTRules(): Promise<{ triggers: RuleInfo[]; effects: RuleInfo[] }> {
        const triggers: RuleInfo[] = [];
        const effects: RuleInfo[] = [];

        const configPaths: string[] = [
            path.join(this.workspaceRoot, 'submodules', 'cwtools-stellaris-config', 'config'),
        ];

        // Also check the extension's own config directory
        const ext = vs.extensions.getExtension('tboby.cwtools-vscode') ??
            vs.extensions.getExtension('cwtools.cwtools-vscode');
        if (ext) {
            configPaths.push(path.join(ext.extensionPath, 'config'));
        }

        for (const configPath of configPaths) {
            const triggersFile = path.join(configPath, 'triggers.cwt');
            const effectsFile = path.join(configPath, 'effects.cwt');
            if (fs.existsSync(triggersFile)) { this.parseCWTFile(triggersFile, triggers); }
            if (fs.existsSync(effectsFile)) { this.parseCWTFile(effectsFile, effects); }
            if (triggers.length > 0 || effects.length > 0) break;
        }

        return { triggers, effects };
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
        const errors: import('./types').ValidationError[] = [];

        try {
            const wsFolders = vs.workspace.workspaceFolders;
            const wsRoot = wsFolders && wsFolders.length > 0
                ? wsFolders[0].uri.fsPath
                : this.workspaceRoot;

            // ── Strategy 1: In-memory validation via LSP server command ──────────────────
            // No temp files, no 3s wait. Direct access to CWTools game engine.
            try {
                const client = this.client;
                if (client) {
                    const raw = await client.sendRequest('workspace/executeCommand', {
                        command: 'cwtools.ai.validateCode',
                        arguments: [args.code, args.targetFile ?? ''],
                    }) as any;

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
            } catch { /* fall through to temp-file validation */ }

            // ── Fallback: Temp-file approach (original behaviour) ─────────────────────────
            // Used when LSP server command is unavailable.
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
                const doc = await vs.workspace.openTextDocument(tempUri);
                // Wait briefly so LSP processes didOpen before we set up the listener
                await new Promise(r => setTimeout(r, 80));

                const diags = await new Promise<vs.Diagnostic[]>((resolve) => {
                    const existing = vs.languages.getDiagnostics(tempUri);
                    if (existing.length > 0) { resolve(existing); return; }

                    const timeout = setTimeout(() => {
                        disposable.dispose();
                        resolve(vs.languages.getDiagnostics(tempUri));
                    }, 3000);

                    const disposable = vs.languages.onDidChangeDiagnostics((e) => {
                        const changedForUs = e.uris.some(u => u.fsPath === tempUri.fsPath);
                        if (changedForUs) {
                            clearTimeout(timeout);
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
                // Close the temp document to prevent it from accumulating in the LSP buffer.
                // We use a show+close sequence since VSCode has no direct "closeDocument" API.
                try {
                    await vs.window.showTextDocument(vs.Uri.file(tempPath), { preserveFocus: true, preview: true });
                    await vs.commands.executeCommand('workbench.action.closeActiveEditor');
                } catch { /* ignore if document was never shown or already closed */ }
                // Delete temp file from disk
                try {
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    try {
                        const remaining = fs.readdirSync(tempDir);
                        if (remaining.length === 0) fs.rmdirSync(tempDir);
                    } catch { /* ignore */ }
                } catch { /* ignore */ }
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
            errors: entries.filter(e => e.severity === 'error').length,
            warnings: entries.filter(e => e.severity === 'warning').length,
            info: entries.filter(e => e.severity === 'info').length,
            hints: entries.filter(e => e.severity === 'hint').length,
        };

        // Total count across all pairs — only matching files, for accurate 'truncated' signal
        let totalDiagCount = 0;
        for (const [uri, diags] of allPairs) {
            if (uri.fsPath.includes('.cwtools-ai-tmp')) continue;
            if (args.file) {
                const fileNorm = args.file.replace(/\\/g, '/').toLowerCase();
                if (!uri.fsPath.replace(/\\/g, '/').toLowerCase().includes(fileNorm)) continue;
            }
            // Only count matching severity, mirroring the main loop filter
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

            // ── Large-file guard: warn if no range given and file is large ──
            const LARGE_FILE_THRESHOLD = 150;
            if (totalLines > LARGE_FILE_THRESHOLD && !args.startLine && !args.endLine) {
                return {
                    content: '',
                    totalLines,
                    truncated: true,
                    _hint: `File has ${totalLines} lines — too large to read in full. ` +
                        `Recommended: call document_symbols("${args.file}") first to identify the section you need, ` +
                        `then re-call read_file with startLine and endLine (max 150 lines per call).`,
                };
            }

            const start = args.startLine ? Math.max(1, args.startLine) - 1 : 0;
            const end = args.endLine ? Math.min(totalLines, args.endLine) : totalLines;
            const slice = lines.slice(start, end);

            // Prepend line numbers
            const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');

            const MAX_READ_CHARS = 12000;
            const truncated = numbered.length > MAX_READ_CHARS;
            const resultContent = truncated
                ? numbered.substring(0, MAX_READ_CHARS)
                : numbered;

            // Calculate the last line actually returned
            const lastLineReturned = start + (truncated
                ? resultContent.split('\n').length
                : slice.length);

            return {
                content: truncated
                    ? resultContent + `\n[... truncated at char ${MAX_READ_CHARS} ...]`
                    : resultContent,
                totalLines,
                truncated,
                ...(truncated ? {
                    _hint: `Output truncated. File has ${totalLines} lines total. ` +
                        `Last line shown: ~${lastLineReturned}. ` +
                        `To read the next section, call read_file with startLine=${lastLineReturned + 1}.`,
                } : {}),
            };
        } catch (e) {
            return { content: `Error reading file: ${String(e)}`, totalLines: 0, truncated: false };
        }
    }

    private async writeFile(args: { file: string; content: string; encoding?: string }): Promise<import('./types').WriteFileResult> {
        try {
            // Snapshot original content for retract support (before any confirmation)
            let originalContent: string | null = null;
            try { originalContent = fs.readFileSync(args.file, 'utf-8'); } catch { /* new file — leave null */ }
            this.onBeforeFileWrite?.(args.file, originalContent);

            const diff = this.generateSimpleDiff(args.file, originalContent ?? '', args.content);

            if (this.fileWriteMode === 'confirm' && this.onPendingWrite && !(args as any)._autoApply) {
                const messageId = `write_${crypto.randomUUID()}`;
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

            // Write with optional UTF-8 BOM (default: utf8bom for Stellaris compatibility)
            const useBom = (args.encoding ?? 'utf8bom') !== 'utf8';
            const writeContent = useBom ? '\uFEFF' + args.content : args.content;
            fs.writeFileSync(args.file, writeContent, 'utf-8');
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
        encoding?: string;
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

        // Snapshot original content for retract support
        // (null = new file being created via oldString === '')
        this.onBeforeFileWrite?.(filePath, args.oldString === '' ? null : originalContent);

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
            // Write with optional UTF-8 BOM (default: utf8bom for Stellaris compatibility)
            const useBom = (args.encoding ?? 'utf8bom') !== 'utf8';
            const writeContent = (useBom && args.oldString === '') ? '\uFEFF' + newContent : newContent;
            fs.writeFileSync(filePath, writeContent, 'utf-8');
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
            // Fix #6: await openTextDocument instead of fire-and-forget (void).
            // VS Code needs the file loaded in its document model for diagnostics to appear.
            // Already-open files return immediately without duplication.
            try { await vs.workspace.openTextDocument(uri); } catch { /* may already be open */ }
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
                const c = a[i - 1] === b[j - 1] ? 0 : 1;
                m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + c);
            }
        return m[a.length][b.length];
    }

    private *simpleReplacer(_c: string, find: string): Generator<string> { yield find; }

    private *lineTrimmedReplacer(content: string, find: string): Generator<string> {
        const oL = content.split('\n'), sL = find.split('\n');
        if (sL[sL.length - 1] === '') sL.pop();
        for (let i = 0; i <= oL.length - sL.length; i++) {
            if (sL.every((s, j) => oL[i + j].trim() === s.trim())) {
                let st = 0; for (let k = 0; k < i; k++) st += oL[k].length + 1;
                let en = st; for (let k = 0; k < sL.length; k++) { en += oL[i + k].length; if (k < sL.length - 1) en += 1; }
                yield content.substring(st, en);
            }
        }
    }

    private *blockAnchorReplacer(content: string, find: string): Generator<string> {
        const oL = content.split('\n'), sL = find.split('\n');
        if (sL.length < 3) return;
        if (sL[sL.length - 1] === '') sL.pop();
        const first = sL[0].trim(), last = sL[sL.length - 1].trim();
        const cands: { s: number; e: number }[] = [];
        for (let i = 0; i < oL.length; i++) {
            if (oL[i].trim() !== first) continue;
            for (let j = i + 2; j < oL.length; j++) { if (oL[j].trim() === last) { cands.push({ s: i, e: j }); break; } }
        }
        if (!cands.length) return;
        const score = (s: number, e: number) => {
            const check = Math.min(sL.length - 2, e - s - 1);
            if (check <= 0) return 1.0;
            let sim = 0;
            for (let j = 1; j < sL.length - 1 && j < e - s; j++) {
                const mx = Math.max(oL[s + j].trim().length, sL[j].trim().length);
                if (mx) sim += (1 - this.levenshtein(oL[s + j].trim(), sL[j].trim()) / mx) / check;
            }
            return sim;
        };
        const extract = (s: number, e: number) => {
            let st = 0; for (let k = 0; k < s; k++) st += oL[k].length + 1;
            let en = st; for (let k = s; k <= e; k++) { en += oL[k].length; if (k < e) en += 1; }
            return content.substring(st, en);
        };
        if (cands.length === 1) { if (score(cands[0].s, cands[0].e) >= 0) yield extract(cands[0].s, cands[0].e); return; }
        let best = cands[0], bestSim = -1;
        for (const { s, e } of cands) { const sim = score(s, e); if (sim > bestSim) { bestSim = sim; best = { s, e }; } }
        if (bestSim >= 0.3) yield extract(best.s, best.e);
    }

    private *whitespaceNormalizedReplacer(content: string, find: string): Generator<string> {
        const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
        const nF = norm(find), lns = content.split('\n'), fL = find.split('\n');
        if (fL.length === 1) { for (const l of lns) { if (norm(l) === nF) yield l; } return; }
        for (let i = 0; i <= lns.length - fL.length; i++)
            if (norm(lns.slice(i, i + fL.length).join('\n')) === nF) yield lns.slice(i, i + fL.length).join('\n');
    }

    private *indentationFlexibleReplacer(content: string, find: string): Generator<string> {
        const strip = (text: string) => {
            const lns = text.split('\n'), ne = lns.filter(l => l.trim().length > 0);
            if (!ne.length) return text;
            const min = Math.min(...ne.map(l => { const m = l.match(/^(\s*)/); return m ? m[1].length : 0; }));
            return lns.map(l => l.trim().length === 0 ? l : l.slice(min)).join('\n');
        };
        const nF = strip(find), lns = content.split('\n'), fL = find.split('\n');
        for (let i = 0; i <= lns.length - fL.length; i++) {
            const b = lns.slice(i, i + fL.length).join('\n');
            if (strip(b) === nF) yield b;
        }
    }

    private *escapeNormalizedReplacer(content: string, find: string): Generator<string> {
        const un = (s: string) => s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_m, c: string) =>
            ({ n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\', '\n': '\n', '$': '$' }[c] ?? _m));
        const uF = un(find);
        if (content.includes(uF)) { yield uF; return; }
        const lns = content.split('\n'), fL = uF.split('\n');
        if (fL.length > 1) for (let i = 0; i <= lns.length - fL.length; i++) {
            const b = lns.slice(i, i + fL.length).join('\n');
            if (un(b) === uF) yield b;
        }
    }

    private *trimmedBoundaryReplacer(content: string, find: string): Generator<string> {
        const trimmed = find.trim();
        if (trimmed === find) return;
        if (content.includes(trimmed)) { yield trimmed; return; }
        const lns = content.split('\n'), fL = find.split('\n');
        for (let i = 0; i <= lns.length - fL.length; i++) {
            const b = lns.slice(i, i + fL.length).join('\n');
            if (b.trim() === trimmed) yield b;
        }
    }

    private *contextAwareReplacer(content: string, find: string): Generator<string> {
        const fL = find.split('\n');
        if (fL.length < 3) return;
        if (fL[fL.length - 1] === '') fL.pop();
        const cL = content.split('\n');
        const fl = fL[0].trim(), ll = fL[fL.length - 1].trim();
        for (let i = 0; i < cL.length; i++) {
            if (cL[i].trim() !== fl) continue;
            for (let j = i + 2; j < cL.length; j++) {
                if (cL[j].trim() !== ll) continue;
                const b = cL.slice(i, j + 1);
                if (b.length !== fL.length) break;
                let hit = 0, tot = 0;
                for (let k = 1; k < b.length - 1; k++) {
                    if (b[k].trim().length || fL[k].trim().length) { tot++; if (b[k].trim() === fL[k].trim()) hit++; }
                }
                if (tot === 0 || hit / tot >= 0.5) { yield b.join('\n'); break; }
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
        let i = 0, j = 0;
        while ((i < oL.length || j < mL.length) && changed < 80) {
            if (oL[i] === mL[j]) { i++; j++; }
            else { changed++; if (i < oL.length) { diff += `- ${oL[i++]}\n`; } if (j < mL.length) { diff += `+ ${mL[j++]}\n`; } }
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

    // ─── New OpenCode-Ported Tools ────────────────────────────────────────────

    /**
     * glob_files: find files matching a glob pattern across the workspace.
     * Mirrors OpenCode's glob tool but scoped to the mod workspace.
     */
    private async globFiles(args: { pattern: string; limit?: number }): Promise<{ files: string[]; total: number }> {
        try {
            const limit = Math.min(args.limit ?? 200, 500);
            const uris = await vs.workspace.findFiles(args.pattern, '**/node_modules/**', limit);
            const files = uris.map(u => u.fsPath);
            return { files, total: files.length };
        } catch (e) {
            return { files: [], total: 0 };
        }
    }

    /**
     * lsp_operation: perform LSP operations (goToDefinition, findReferences, hover, rename).
     * Mirrors OpenCode's lsp.ts tool, adapted for VSCode command API.
     */
    private async lspOperation(args: {
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
                    const defs = await vs.commands.executeCommand<vs.Location[]>(
                        'vscode.executeDefinitionProvider', uri, position
                    );
                    if (!defs || defs.length === 0) return { locations: [], message: 'No definition found' };
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
                    const refs = await vs.commands.executeCommand<vs.Location[]>(
                        'vscode.executeReferenceProvider', uri, position
                    );
                    if (!refs || refs.length === 0) return { references: [], message: 'No references found' };
                    return {
                        references: refs.slice(0, 50).map(r => ({
                            file: path.relative(this.workspaceRoot, r.uri.fsPath).replace(/\\/g, '/'),
                            line: r.range.start.line,
                            column: r.range.start.character,
                        })),
                        total: refs.length,
                    };
                }
                case 'hover': {
                    const hovers = await vs.commands.executeCommand<vs.Hover[]>(
                        'vscode.executeHoverProvider', uri, position
                    );
                    if (!hovers || hovers.length === 0) return { text: '', message: 'No hover info' };
                    const text = hovers.flatMap(h =>
                        h.contents.map(c => typeof c === 'string' ? c : (c as vs.MarkdownString).value)
                    ).join('\n\n');
                    return { text };
                }
                case 'rename': {
                    if (!args.newName) return { error: 'newName required for rename operation' };
                    const edit = await vs.commands.executeCommand<vs.WorkspaceEdit>(
                        'vscode.executeDocumentRenameProvider', uri, position, args.newName
                    );
                    if (!edit) return { error: 'Rename not supported at this position' };
                    const changes: Array<{ file: string; edits: number }> = [];
                    edit.entries().forEach(([u, edits]) => {
                        changes.push({ file: path.relative(this.workspaceRoot, u.fsPath).replace(/\\/g, '/'), edits: edits.length });
                    });
                    // Apply the rename edit to the workspace (not just a preview)
                    const applied = await vs.workspace.applyEdit(edit);
                    if (!applied) return { error: 'Rename apply failed — workspace rejected the edit' };
                    return {
                        changes,
                        message: `Rename applied: ${changes.length} file(s) affected, ${changes.reduce((s, c) => s + c.edits, 0)} edit(s) total`,
                    };
                }
                default:
                    return { error: `Unknown LSP operation: ${args.operation}` };
            }
        } catch (e) {
            return { error: `LSP operation failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    /**
     * web_fetch: fetch a public URL and return its text content.
     * Mirrors OpenCode's webfetch tool. HTML → plain text via regex stripping.
     */
    private async webFetch(args: { url: string; maxChars?: number }): Promise<{ content: string; url: string; truncated: boolean }> {
        const maxChars = Math.min(args.maxChars ?? 8000, 16000);

        if (!args.url.startsWith('http://') && !args.url.startsWith('https://')) {
            return { content: 'Error: only http/https URLs are supported', url: args.url, truncated: false };
        }

        try {
            const response = await fetch(args.url, {
                headers: { 'User-Agent': 'CWTools-AI/1.0 (Stellaris Mod Assistant)' },
            });
            if (!response.ok) {
                return { content: `HTTP ${response.status}: ${response.statusText}`, url: args.url, truncated: false };
            }

            const contentType = response.headers.get('content-type') ?? '';
            let text = await response.text();

            // Strip HTML tags for readability
            if (contentType.includes('html')) {
                text = text
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/\s{3,}/g, '\n\n')
                    .trim();
            }

            const truncated = text.length > maxChars;
            return {
                content: truncated ? text.substring(0, maxChars) + '\n... [truncated]' : text,
                url: args.url,
                truncated,
            };
        } catch (e) {
            return {
                content: `Fetch error: ${e instanceof Error ? e.message : String(e)}`,
                url: args.url,
                truncated: false,
            };
        }
    }

    /**
     * run_command: execute a shell command in the workspace.
     * OpenCode strategy: every command requires explicit user permission.
     * The onPermissionRequest callback suspends execution until the user responds.
     */
    public onPermissionRequest?: (
        id: string,
        tool: string,
        description: string,
        command?: string
    ) => Promise<boolean>;

    private async runCommand(args: { command: string; cwd?: string; timeoutMs?: number }): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut?: boolean;
    }> {
        // Safety: deny obviously dangerous commands
        const BLOCKED_PATTERNS = [
            /\brm\s+-rf\b/i, /\bdel\s+\/[fqs]/i, /\bformat\b/i,
            /\brmdir\b.*\/s/i, /\bshutdown\b/i, /\breboot\b/i,
            /\bpowershell\b.*-enc/i, /\bcurl\b.*\|\s*bash/i,
            /\bwget\b.*\|\s*sh/i,
        ];
        for (const pat of BLOCKED_PATTERNS) {
            if (pat.test(args.command)) {
                return { stdout: '', stderr: `Blocked: command matched safety pattern (${pat.source})`, exitCode: 1 };
            }
        }

        // Request user permission (OpenCode strategy: ask for every new command)
        if (this.onPermissionRequest) {
            const permId = `perm_${Date.now()}`;
            const allowed = await this.onPermissionRequest(
                permId,
                'run_command',
                `AI wants to run: ${args.command}`,
                args.command
            );
            if (!allowed) {
                return { stdout: '', stderr: '用户拒绝了此命令的执行权限', exitCode: 1 };
            }
        } else {
            // No permission handler = deny by default
            return { stdout: '', stderr: 'run_command: no permission handler configured', exitCode: 1 };
        }

        // Execute
        const cwd = args.cwd ?? this.workspaceRoot;
        const timeoutMs = Math.min(args.timeoutMs ?? 15000, 60000);
        const { exec } = await import('child_process');

        return new Promise(resolve => {
            const proc = exec(
                args.command,
                { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
                (error, stdout, stderr) => {
                    resolve({
                        stdout: stdout.substring(0, 4000),
                        stderr: stderr.substring(0, 2000),
                        exitCode: error?.code ?? 0,
                        timedOut: error?.signal === 'SIGTERM',
                    });
                }
            );
            void proc;
        });
    }

    // ─── search_web ──────────────────────────────────────────────────────────

    /**
     * Web search: uses Brave Search API if a key is configured in VSCode settings,
     * otherwise falls back to DuckDuckGo HTML scraping.
     * Aligned with opencode's web search approach.
     */
    private async searchWeb(args: { query: string; maxResults?: number }): Promise<{
        results: Array<{ title: string; url: string; description: string }>;
        source: 'brave' | 'duckduckgo';
        query: string;
    }> {
        const maxResults = Math.min(args.maxResults ?? 5, 10);
        const query = args.query.trim();

        // Try Brave Search API first (if configured)
        const braveKey = vs.workspace.getConfiguration('cwtools.ai').get<string>('braveSearchApiKey') ?? '';
        if (braveKey) {
            try {
                const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
                const resp = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'Accept-Encoding': 'gzip',
                        'X-Subscription-Token': braveKey,
                    },
                });
                if (resp.ok) {
                    const data = await resp.json() as {
                        web?: { results?: Array<{ title: string; url: string; description?: string }> }
                    };
                    const results = (data.web?.results ?? []).slice(0, maxResults).map(r => ({
                        title: r.title,
                        url: r.url,
                        description: r.description ?? '',
                    }));
                    return { results, source: 'brave', query };
                }
            } catch { /* fall through to DuckDuckGo */ }
        }

        // Fallback: DuckDuckGo HTML scraping (no API key required)
        try {
            const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const resp = await fetch(ddgUrl, {
                headers: { 'User-Agent': 'CWTools-AI/1.0 (Stellaris Mod Assistant)' },
            });
            const html = await resp.text();

            // Parse result links and snippets from DuckDuckGo HTML
            const results: Array<{ title: string; url: string; description: string }> = [];
            // Extract links like: <a class="result__a" href="...">Title</a>
            const linkRe = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi;
            const snippetRe = /<a class="result__snippet"[^>]*>([^<]+)<\/a>/gi;
            const links: Array<{ url: string; title: string }> = [];
            const snippets: string[] = [];
            let m: RegExpExecArray | null;
            while ((m = linkRe.exec(html)) !== null && links.length < maxResults) {
                let url = m[1];
                // DuckDuckGo redirects — extract real URL
                if (url.startsWith('/l/?uddg=')) {
                    try { url = decodeURIComponent(url.replace('/l/?uddg=', '')); } catch { /* keep */ }
                }
                links.push({ url, title: m[2].trim() });
            }
            while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
                snippets.push(m[1].trim());
            }
            for (let i = 0; i < links.length; i++) {
                results.push({
                    title: links[i].title,
                    url: links[i].url,
                    description: snippets[i] ?? '',
                });
            }
            return { results, source: 'duckduckgo', query };
        } catch (e) {
            return { results: [], source: 'duckduckgo', query };
        }
    }

    // ─── apply_patch ─────────────────────────────────────────────────────────

    /**
     * Apply a unified diff patch atomically.
     * Parses standard git-format patches (--- a/file / +++ b/file / @@ hunks).
     * If ALL hunks succeed, files are written; otherwise nothing is written.
     */
    private async applyPatch(args: { patch: string; cwd?: string }): Promise<{
        success: boolean;
        filesChanged: string[];
        errors: string[];
    }> {
        const cwd = args.cwd ?? this.workspaceRoot;

        // ── Parse unified diff ────────────────────────────────────────────────
        interface HunkPatch {
            filePath: string;
            oldString: string;
            newString: string;
        }
        const hunks: HunkPatch[] = [];

        const lines = args.patch.split('\n');
        let currentFile: string | null = null;
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            // Detect file header: --- a/file or --- file
            if (line.startsWith('--- ')) {
                const nextLine = lines[i + 1] ?? '';
                if (nextLine.startsWith('+++ ')) {
                    // Extract file path from +++ line (remove b/ prefix)
                    let filePath = nextLine.slice(4).trim();
                    if (filePath.startsWith('b/')) filePath = filePath.slice(2);
                    // Make absolute
                    currentFile = path.isAbsolute(filePath)
                        ? filePath
                        : path.join(cwd, filePath);
                    i += 2;
                    continue;
                }
            }
            // Detect hunk header: @@ -a,b +c,d @@
            if (line.startsWith('@@') && currentFile) {
                // Collect hunk lines
                i++;
                const oldLines: string[] = [];
                const newLines: string[] = [];
                while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ')) {
                    const hunkLine = lines[i];
                    if (hunkLine.startsWith('-')) {
                        oldLines.push(hunkLine.slice(1));
                    } else if (hunkLine.startsWith('+')) {
                        newLines.push(hunkLine.slice(1));
                    } else {
                        // Context line — appears in both
                        oldLines.push(hunkLine.startsWith(' ') ? hunkLine.slice(1) : hunkLine);
                        newLines.push(hunkLine.startsWith(' ') ? hunkLine.slice(1) : hunkLine);
                    }
                    i++;
                }
                hunks.push({
                    filePath: currentFile,
                    oldString: oldLines.join('\n'),
                    newString: newLines.join('\n'),
                });
                continue;
            }
            i++;
        }

        if (hunks.length === 0) {
            return { success: false, filesChanged: [], errors: ['No valid hunks found in patch'] };
        }

        // ── Apply all hunks (simulate first, then commit) ─────────────────────
        // Group hunks by file
        const byFile = new Map<string, { content: string; hunks: HunkPatch[] }>();
        for (const hunk of hunks) {
            if (!byFile.has(hunk.filePath)) {
                let content = '';
                try { content = fs.readFileSync(hunk.filePath, 'utf-8'); } catch { /* new file */ }
                byFile.set(hunk.filePath, { content, hunks: [] });
            }
            byFile.get(hunk.filePath)!.hunks.push(hunk);
        }

        const errors: string[] = [];
        const pendingWrites: Array<{ filePath: string; newContent: string }> = [];

        for (const [filePath, { content, hunks: fileHunks }] of byFile) {
            let currentContent = content;
            const ending = this.detectLineEnding(currentContent);
            for (const hunk of fileHunks) {
                const old = this.convertLineEnding(this.normalizeLineEndings(hunk.oldString), ending);
                const next = this.convertLineEnding(this.normalizeLineEndings(hunk.newString), ending);
                try {
                    currentContent = this.replace(currentContent, old, next, false);
                } catch (e) {
                    errors.push(`${path.basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (errors.length === 0) {
                pendingWrites.push({ filePath, newContent: currentContent });
            }
        }

        if (errors.length > 0) {
            return { success: false, filesChanged: [], errors };
        }

        // All hunks succeeded — commit writes
        // Respect fileWriteMode='confirm': if multiple files changed, show a combined diff view
        // and request confirmation for each file, same as edit_file does.
        const filesChanged: string[] = [];
        for (const { filePath, newContent } of pendingWrites) {
            const prevContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
            this.onBeforeFileWrite?.(filePath, prevContent);

            if (this.fileWriteMode === 'confirm' && this.onPendingWrite) {
                const messageId = `patch_${crypto.randomUUID()}`;
                const confirmed = await this.onPendingWrite(filePath, newContent, messageId);
                if (!confirmed) {
                    errors.push(`${path.basename(filePath)}: 用户取消了写入操作`);
                    continue;
                }
            }

            try {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, newContent, 'utf-8');
                filesChanged.push(path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/'));
            } catch (e) {
                errors.push(`Write ${path.basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        return {
            success: errors.length === 0,
            filesChanged,
            errors,
        };
    }

    // ─── multiedit ───────────────────────────────────────────────────────────

    /**
     * Apply multiple edit operations to a single file atomically.
     * If any edit fails, no changes are written.
     * Uses the same 8-strategy fuzzy matching as editFile().
     */
    private async multiEdit(args: {
        filePath: string;
        edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>;
        encoding?: string;
    }): Promise<import('./types').EditFileResult> {
        const filePath = args.filePath;
        let content = '';
        try {
            if (fs.existsSync(filePath)) {
                content = fs.readFileSync(filePath, 'utf-8');
            }
        } catch (e) {
            return { success: false, message: `无法读取文件: ${String(e)}` };
        }

        const originalContent = content;
        this.onBeforeFileWrite?.(filePath, originalContent || null);

        const ending = this.detectLineEnding(content);
        const errors: string[] = [];

        // Apply all edits sequentially, accumulating into current content
        for (let i = 0; i < args.edits.length; i++) {
            const edit = args.edits[i];
            if (edit.oldString === edit.newString) continue; // skip no-ops
            const old = this.convertLineEnding(this.normalizeLineEndings(edit.oldString), ending);
            const next = this.convertLineEnding(this.normalizeLineEndings(edit.newString), ending);
            try {
                content = this.replace(content, old, next, edit.replaceAll ?? false);
            } catch (e) {
                errors.push(`Edit #${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        if (errors.length > 0) {
            return {
                success: false,
                message: `${errors.length} 个编辑失败，文件未修改:\n${errors.join('\n')}`,
            };
        }

        // All edits succeeded — write file, respecting fileWriteMode='confirm'
        const diff = this.buildUnifiedDiff(filePath, originalContent, content);
        if (this.fileWriteMode === 'confirm' && this.onPendingWrite) {
            const messageId = `multiedit_${crypto.randomUUID()}`;
            const confirmed = await this.onPendingWrite(filePath, content, messageId);
            if (!confirmed) {
                return { success: false, message: '用户取消了编辑操作', pendingDiff: diff };
            }
        }

        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const useBom = (args.encoding ?? 'utf8bom') !== 'utf8';
            fs.writeFileSync(filePath, useBom ? '\uFEFF' + content : content, 'utf-8');
        } catch (e) {
            return { success: false, message: `写入失败: ${String(e)}` };
        }

        const diagnostics = await this.getLspDiagnosticsForFile(filePath);
        // diff is already computed above (for confirm mode); reuse it here
        let message = `multiedit: ${args.edits.length} 个编辑已应用到 ${path.basename(filePath)}`;
        const errorDiags = diagnostics.filter(d => d.severity === 'error');
        if (errorDiags.length > 0) {
            message += `\n\nLSP 检测到 ${errorDiags.length} 个错误:\n` +
                errorDiags.slice(0, 5).map(e => `  第 ${e.line + 1} 行: ${e.message}`).join('\n');
        }
        return { success: true, message, diff, diagnostics };
    }

    // ─── task (sub-agent dispatch) ────────────────────────────────────────────

    /**
     * Dispatch a sub-task to a specialized sub-agent.
     * Delegates to AgentRunner.runSubAgent() via agentRunnerRef.
     * The sub-agent runs in 'explore' or 'general' mode (read-only or research).
     */
    private async dispatchSubTask(args: {
        description: string;
        prompt: string;
        subagent_type?: 'explore' | 'general';
    }): Promise<{ result: string; description: string }> {
        const mode = (args.subagent_type ?? 'general') as 'explore' | 'general';

        if (!this.agentRunnerRef) {
            return {
                description: args.description,
                result: 'Sub-agent dispatch not available: agentRunnerRef not set',
            };
        }

        try {
            const result = await this.agentRunnerRef.runSubAgent(
                args.prompt,
                mode,
                this.parentRunnerOptions,
                undefined,
                // L8 Fix: pass parent accumulator so sub-agent token costs merge into parent UI
                this.parentTokenAccumulator
            );
            return { description: args.description, result };
        } catch (e) {
            return {
                description: args.description,
                result: `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }
}
