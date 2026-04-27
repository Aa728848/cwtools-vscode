/**
 * Tool JSON Schema Definitions for AI function calling.
 * Pure data — no runtime dependencies.
 */

import type { ToolDefinition } from '../types';

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
            description: 'Query the syntax rules for triggers, effects, scope changes, or modifiers. Returns the valid syntax, required parameters, and supported scopes for each rule. If a specific name is not found, it returns intelligent fuzzy suggestions. Use this to understand the correct syntax before generating code.',
            parameters: {
                type: 'object',
                properties: {
                    category: { type: 'string', enum: ['trigger', 'effect', 'scope_change', 'modifier'], description: 'Rule category' },
                    name: { type: 'string', description: 'Specific rule name (optional, lists all if omitted or returns fuzzy matches if exact miss)' },
                    scope: { type: 'string', description: 'Filter by supported scope (e.g. "planet", "country"). Optional, but heavily recommended. Use query_scope to find your current context first.' },
                },
                required: ['category'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'ignore_validation_error',
            description: 'Provide an explicit override to ignore a CWTools LSP validation error if you are confident the code is structurally correct (e.g. newer game specific syntax or valid dynamic modifier). This will prompt the human user for Permission. If granted, the rule is saved to local memory permanently.',
            parameters: {
                type: 'object',
                properties: {
                    errorId: { type: 'string', description: 'The exact error ID, rule name, or text snippet being falsely flagged by the LSP.' },
                    reason: { type: 'string', description: 'A brief technical explanation of why this error is a false positive and should be ignored.' },
                },
                required: ['errorId', 'reason'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_pdx_block',
            description: 'Extract exactly one complete AST block (including all its nested {...} brackets) instead of blindly guessing line numbers. Useful when trying to read long vanilla files without exhausting context. Provide the exact symbol name if available.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    symbol: { type: 'string', description: 'Name of the top-level block/identifier to extract (e.g. event id "anomaly.1" or "ship_size_corvette")' },
                },
                required: ['file', 'symbol'],
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
            description: 'Search for files containing specific text patterns. By default, searches the mod workspace. To search vanilla code precisely, change searchContext to "vanilla" and set exactMatch to true.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for' },
                    directory: { type: 'string', description: 'Optional subdirectory to restrict search, e.g. "common/scripted_triggers" or "events"' },
                    fileExtension: { type: 'string', description: 'File extension filter, default ".txt". Use ".yml" for localisation.' },
                    exactMatch: { type: 'boolean', description: 'If true, searches exactly matching complete words using RegEx boundaries. Default: false (wide .includes match)' },
                    searchContext: { type: 'string', enum: ['mod', 'vanilla', 'both'], description: 'Context to search. "mod" searches workspace. "vanilla" searches the base game directory cached by CWTools. Default "mod".' }
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
                    limit: { type: 'number', description: 'Max completions to return (default 30). Increase if you need to see more options.' },
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
            description: 'Write content to a file. **CRITICAL: You are ONLY allowed to use this tool to create BRAND-NEW files.** If you try to overwrite an existing file with this tool, it will crash and block you. To edit an existing file, you MUST use `edit_file` or `multiedit`.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    content: { type: 'string', description: 'New file content' },
                    encoding: { type: 'string', enum: ['utf8', 'utf8bom'], description: 'File encoding. Localisation files (.yml) MUST use utf8bom. All other code files (.txt, .gui, etc.) MUST use utf8. Omit to let the system auto-detect.' },
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
                    encoding: { type: 'string', enum: ['utf8', 'utf8bom'], description: 'File encoding for new files. Localisation (.yml) MUST be utf8bom, other code MUST be utf8. Omit to let the system auto-detect.' },
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
                    limit: { type: 'number', description: 'Max diagnostics to return (default 500, max 2000). For full project reviews, omit this parameter to get all diagnostics. Only set a low limit when you want a quick summary.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'analyze_diagnostic_error',
            description: 'MANDATORY when an error occurs during file modification. Use this tool to perform a deep reflection on the error before attempting another fix. Explain what the error means, trace its root cause in the context of the current file or workspace, and outline a planned solution. The tool will simply acknowledge the reflection, forcing the engine into a thinking step.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'File where the error occurred' },
                    errorCode: { type: 'string', description: 'The error code or message' },
                    reflection: { type: 'string', description: 'Detailed analysis of why the error occurred and how to fix it' }
                },
                required: ['file', 'reflection'],
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
            description: '⚠️ PERMISSION REQUIRED — Run a shell command in the workspace directory. Every invocation ALWAYS requires explicit user approval regardless of the current mode, even for seemingly safe commands like "git status" or "npm run lint". You must explain in your chat output what the command does and why it is needed BEFORE calling this tool. Destructive commands (rm, del, format, shutdown) and pipe/chain operators (|, &&, ;, >, <) are permanently blocked. The user can deny any command.',
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
            name: 'codesearch',
            description: 'Search code repositories and developer documentation semantically (powered by Exa API if configured). Use for finding examples of PDXScript patterns, mod implementation references, or any code-level search. Falls back to Brave Search with code-specific query modifiers if no Exa key configured.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Code search query. Be specific about the pattern, API, or function name. Example: "Stellaris on_action on_fleet_combat implementation"' },
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
                    encoding: { type: 'string', enum: ['utf8', 'utf8bom'], description: 'File encoding. Localisation (.yml) MUST be utf8bom, other code MUST be utf8. Omit to auto-detect.' },
                },
                required: ['filePath', 'edits'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'spawn_sub_agents',
            description: 'Dispatch one or more sub-tasks to specialized sub-agents. They run independently and in parallel (up to 3). They return findings as text. Use "build" for editing code directly, "explore" for codebase exploration (read-only), "general" for research (all read + web tools).',
            parameters: {
                type: 'object',
                properties: {
                    tasks: {
                        type: 'array',
                        description: 'List of sub-tasks to run in parallel',
                        items: {
                            type: 'object',
                            properties: {
                                description: { type: 'string', description: 'Short label for this sub-task (shown in UI)' },
                                prompt: { type: 'string', description: 'Detailed prompt for the sub-agent. Include all context it needs.' },
                                subagent_type: { type: 'string', enum: ['build', 'explore', 'general'], description: 'Sub-agent mode. Default: "build"' },
                            },
                            required: ['description', 'prompt'],
                        },
                    },
                },
                required: ['tasks'],
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
                    filter: { type: 'string', description: 'Optional substring filter on effect name. Without filter, results are limited to 50; with filter, up to 200.' },
                    limit: { type: 'number', description: 'Max results (default 50 without filter, 200 with filter)' },
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
                    filter: { type: 'string', description: 'Optional substring filter on trigger name. Without filter, results are limited to 50; with filter, up to 200.' },
                    limit: { type: 'number', description: 'Max results (default 50 without filter, 200 with filter)' },
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
            description: '\u26a0\ufe0f MANDATORY before using any modifier tag in add_modifier. List all static modifiers (from static_modifiers/*.txt files) with their modifier categories. PDXscript modifier tag names are domain-specific and frequently hallucinated by LLMs — always verify that a modifier tag exists. Note: Dynamic or engine-hardcoded modifiers (e.g. planet_storm_*) do NOT appear in static modifiers. If not found here, ALWAYS verify them using `query_rules` with category="modifier" before concluding they are invalid.',
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
    // ─── Blackboard Memory Tools ────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'set_memory',
            description: 'Store a string in the shared Agent Blackboard memory. Extremely useful for storing parsed ASTs, file manifests, or data maps that would otherwise overwhelm the prompt context. The data is available to all sub-agents running in the current session. Max length: 50,000 characters per value.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Unique string identifier for this data.' },
                    value: { type: 'string', description: 'The string data to store.' },
                },
                required: ['key', 'value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_memory',
            description: 'Retrieve a string from the shared Agent Blackboard memory by its key. Useful to read data stored by other parallel or sequential sub-agents without passing it through prompt context strings.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Unique string identifier.' },
                },
                required: ['key'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_memory',
            description: 'Search through the Blackboard memory keys and values using a keyword query. Returns all matching keys and a brief preview of their contents. Useful to discover what data other sub-agents have stored.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query or keyword.' },
                },
                required: ['query'],
            },
        },
    },
    // ─── MCP Tools ──────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'mcp_call',
            description: 'Call a tool on a configured MCP (Model Context Protocol) server. MCP servers extend AI capabilities with external tools. Requires a server name (from cwtools.ai.mcp.servers config) and the tool name to call.',
            parameters: {
                type: 'object',
                properties: {
                    server: { type: 'string', description: 'Name of the MCP server to call (must match a configured server name)' },
                    tool: { type: 'string', description: 'Name of the tool to invoke on the MCP server' },
                    arguments: {
                        type: 'object',
                        description: 'Arguments to pass to the MCP tool (schema depends on the tool)',
                    },
                },
                required: ['server', 'tool'],
            },
        },
    },
];
