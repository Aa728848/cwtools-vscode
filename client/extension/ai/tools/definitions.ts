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
            description: '⚠️ MANDATORY before using any game ID. Query defined instances of a Stellaris type from mod + vanilla cache. PDXscript IDs are routinely hallucinated — always verify through this tool. Set filter to narrow results.',
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
            description: 'Query syntax rules for triggers, effects, scope changes, or modifiers. Returns valid syntax, parameters, and scopes. Fuzzy-matches if exact name not found.',
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
    // ignore_validation_error — REMOVED: AI must fix errors, not suppress them
    {
        type: 'function',
        function: {
            name: 'remove_ignored_diagnostic',
            description: "Remove a previously ignored diagnostic key from the user's whitelist. Prompts user for permission. Use when debugging silent failures caused by whitelisted typos.",
            parameters: {
                type: 'object',
                properties: {
                    diagnosticKey: { type: 'string', description: 'The exact string key that is currently being ignored (e.g. "producess").' },
                    reason: { type: 'string', description: 'A brief technical explanation of why you suspect this is a genuine error and should NOT be ignored.' },
                },
                required: ['diagnosticKey', 'reason'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_ignored_diagnostics',
            description: 'List all currently ignored diagnostic keys from the workspace whitelist. More efficient than reading .vscode/settings.json directly.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_pdx_block',
            description: 'Extract exactly one complete AST block by symbol name. Works with .txt (events, common), .gui (containerWindowType by name), and .gfx (pdxmesh by name). If the symbol is not found, the error response includes a full list of available symbols with line ranges so you can retry with the correct name.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    symbol: { type: 'string', description: 'Symbol name varies by file type: events → "namespace.id" (e.g. "anomaly.1"); common/scripted_triggers/effects/technology/buildings/ship_sizes/static_modifiers → top-level identifier (e.g. "tech_kuat_reactor", "kuat_is_crisis_faction"); section_templates → key value (e.g. "X308_Titan_MID1"); on_actions → action name (e.g. "on_entering_battle", but may have duplicates!); .gui → containerWindowType name (e.g. "kuat_bossbar"); .gfx → pdxmesh name (e.g. "sws_turbolaser_red_mesh"). When unsure, call document_symbols first or just try — the error response lists all available symbols.' },
                },
                required: ['file', 'symbol'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_pdx_block',
            description: '🌟 ZERO-READ EDIT: Replace a specific PDX AST block entirely by its symbol name, without needing to read the file first. Works with .txt (events, common), .gui (containerWindowType by name), and .gfx (pdxmesh by name). Uses LSP to find block boundaries automatically. If the symbol is not found, the error response includes a full list of available symbols so you can retry immediately. ⚠️ WARNING: on_actions files may have DUPLICATE top-level names (e.g. multiple "on_entering_battle") — only the FIRST match will be edited. For duplicates, use replaceLines with explicit line ranges instead.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    symbol: { type: 'string', description: 'Symbol name varies by file type: events → "namespace.id" (e.g. "anomaly.1"); common types → top-level identifier (e.g. "tech_kuat_reactor"); section_templates → key value; .gui → containerWindowType name; .gfx → pdxmesh name. If unsure, just try — the error lists all available symbols.' },
                    newContent: { type: 'string', description: 'The completely new code block to replace the old one. Must include the outer block definition (e.g. "my_trigger = { ... }", not just the inner content).' },
                },
                required: ['file', 'symbol', 'newContent'],
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
    // validate_code — REMOVED: 由 get_diagnostics（零副作用）+ multi_replace_file_content 内联诊断替代。
    // get_diagnostics 直接读取诊断面板（~50ms），multi_replace_file_content 写入后自动返回诊断。
    {
        type: 'function',
        function: {
            name: 'get_file_context',
            description: 'Get code context around a specific line, including symbol info. Use when you already know a line number from grep/search results. For extracting entire blocks by name, prefer get_pdx_block instead.',
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
            description: 'Search for files containing text patterns. Default: mod workspace. For vanilla: set searchContext="vanilla" + exactMatch=true. Zero results are NOT proof an ID/key is missing; use verify_pdx_identifier before declaring absence. 💡 After finding a target, use get_pdx_block or edit_pdx_block — NOT read_file.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for' },
                    directory: { type: 'string', description: 'Optional subdirectory to restrict search, e.g. "common/scripted_triggers" or "events"' },
                    fileExtension: { type: 'string', description: 'File extension filter, default ".txt". Use ".yml" for localisation.' },
                    exactMatch: { type: 'boolean', description: 'If true, searches exactly matching complete words using RegEx boundaries. Default: false (wide .includes match)' },
                    searchContext: { type: 'string', enum: ['mod', 'vanilla', 'both'], description: 'Context to search. "mod" searches workspace. "vanilla" searches the base game directory cached by CWTools. Default "mod".' },
                    isRegex: { type: 'boolean', description: 'If true, will treat query as a regular expression. Default: false.' },
                    caseSensitive: { type: 'boolean', description: 'Case sensitive search. Default: false.' },
                    limit: { type: 'number', description: 'Maximum number of files to return (default 30, max 50). Lower values are recommended for exact searches.' },
                    fileExtensions: { type: 'array', items: { type: 'string' }, description: 'Multiple file extensions to filter by, e.g. [".txt", ".gui"]. If provided, overrides the fileExtension parameter.' }
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_sprite_candidates',
            description: 'Find existing PDX spriteType candidates (GFX_*) in the mod workspace and/or vanilla .gfx files. Use this for diagnostics like "Expected value of type sprite" before changing picture/icon/sprite fields. Returns verified sprite names plus texturefile and source; do not guess GFX names.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Semantic search terms, e.g. "anomaly", "archaeology", "force echo", or keywords from the invalid sprite name.' },
                    currentValue: { type: 'string', description: 'The current invalid or desired sprite value, e.g. "GFX_evt_analyzing_anomaly". Used to derive fallback search terms.' },
                    fieldName: { type: 'string', description: 'Field being repaired, e.g. "picture", "icon", "spriteType". Helps rank event pictures vs icons.' },
                    file: { type: 'string', description: 'Optional file containing the diagnostic, for context only.' },
                    line: { type: 'number', description: 'Optional diagnostic line number, for context only.' },
                    searchContext: { type: 'string', enum: ['mod', 'vanilla', 'both'], description: 'Where to search. Defaults to "both"; project sprites are ranked before vanilla.' },
                    limit: { type: 'number', description: 'Maximum candidates to return (default 20, max 50).' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_sound_candidates',
            description: 'Find existing Clausewitz sound/music asset candidates in mod and/or vanilla .asset files. Use this for diagnostics or fields like `show_sound = ...`, `sound = ...`, or missing sound references before editing. Returns verified asset names plus file references and source; do not guess sound asset names.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Semantic search terms, e.g. "alien signal", "anomaly", "ui click", or keywords from the invalid sound name.' },
                    currentValue: { type: 'string', description: 'The current invalid or desired sound asset value, e.g. "event_alien_signal". Used to derive fallback search terms.' },
                    fieldName: { type: 'string', description: 'Field being repaired, e.g. "show_sound", "sound", "music". Helps rank event sounds vs UI sounds.' },
                    file: { type: 'string', description: 'Optional file containing the diagnostic, for context only.' },
                    line: { type: 'number', description: 'Optional diagnostic line number, for context only.' },
                    searchContext: { type: 'string', enum: ['mod', 'vanilla', 'both'], description: 'Where to search. Defaults to "both"; project assets are ranked before vanilla.' },
                    limit: { type: 'number', description: 'Maximum candidates to return (default 20, max 50).' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep',
            description: 'Searches for files matching the specified text/regular expression within the workspace/path. Returns matching lines and line numbers. Zero results are NOT proof an ID/key is missing; use verify_pdx_identifier or an AST lookup before declaring absence. To search for vanilla game files, use `search_mod_files(searchContext="vanilla")`.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search pattern or regex to look for.' },
                    path: { type: 'string', description: 'The path to search within (directory or file), relative to the workspace or absolute.' },
                    isRegex: { type: 'boolean', description: 'If true, the query will be treated as a regular expression. Default: false.' },
                    caseSensitive: { type: 'boolean', description: 'Perform a case-sensitive search. Default: false.' },
                    include: { type: 'string', description: 'Glob pattern to filter files, e.g., "*.txt" or "**/*.{txt,gui}".' },
                    limit: { type: 'number', description: 'Maximum number of matching lines to return (default 50, max 200).' },
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
            description: 'Get all symbols defined in a file as a hierarchical tree with line ranges. Use this FIRST to understand file structure without reading content. Combine with get_pdx_block/edit_pdx_block for zero-read workflows.',
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
            description: 'Search symbol definitions by name across workspace + vanilla cache. Use specific queries (e.g. "tech_energy_grid" not "tech") to avoid large result sets. Empty results can mean the LSP index/type/file kind missed it; verify absence with verify_pdx_identifier before concluding missing.',
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
            name: 'verify_pdx_identifier',
            description: 'Verify whether a PDXScript identifier/localisation key exists using multiple independent sources: AST definition lookup, workspace symbols, optional query_types, and text search across mod + vanilla. Use this before saying a key/ID does not exist, before recreating a missing-looking definition, or after grep/search_mod_files returns zero results.',
            parameters: {
                type: 'object',
                properties: {
                    identifier: { type: 'string', description: 'Exact PDX identifier or localisation key to verify, e.g. "distar.001", "tech_energy_grid", "my_event.1.title".' },
                    typeName: { type: 'string', description: 'Optional CWTools type to verify through query_types, e.g. "event", "technology", "scripted_trigger", "scripted_effect", "static_modifier", "building".' },
                    directory: { type: 'string', description: 'Optional subdirectory for text search, e.g. "events", "common/scripted_triggers", "localisation".' },
                    fileExtensions: { type: 'array', items: { type: 'string' }, description: 'File extensions for text search. Defaults to [".txt", ".yml", ".gui", ".gfx", ".asset"].' },
                    includeVanilla: { type: 'boolean', description: 'Whether to include vanilla cache in text search. Default true.' },
                    caseSensitive: { type: 'boolean', description: 'Case-sensitive exact matching for symbol/type checks. Default false.' },
                    limit: { type: 'number', description: 'Maximum matches to return (default 20, max 50).' },
                },
                required: ['identifier'],
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
            description: 'Read file content with optional line range. ⚠️ Large files are auto-truncated with guidance hints. For .txt: prefer get_pdx_block(symbol) over full reads. For .yml: NEVER read full files — use grep/search_mod_files to find keys. Workflow: document_symbols → read_file(startLine, endLine). Images (.dds/.tga/.png/.jpg) return metadata only.',
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
            description: 'Write/create a non-localisation file. Never use this for .yml localisation files; the tool layer refuses .yml writes. For localisation, use write_localisation with a real path under localisation/, localisation_synced/, or localization/.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'Absolute file path' },
                    content: { type: 'string', description: 'New file content' },
                    encoding: { type: 'string', enum: ['utf8', 'utf8bom'], description: 'File encoding. Non-localisation files should use utf8. Omit to let the system auto-detect.' },
                },
                required: ['file', 'content'],
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'replace_lines',
            description: 'Replace an explicit 1-based line range in a non-localisation file. Prefer this over multi_replace_file_content when you already know exact boundaries from document_symbols/get_file_context, or when multi_replace_file_content reports nearest matching line numbers. To avoid replacing the wrong code after concurrent edits, include expectedContent or expectedStartText/expectedEndText whenever possible. Never use for .yml localisation files; use write_localisation instead.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute or workspace-relative file path.' },
                    startLine: { type: 'number', description: 'Start line number, 1-based and inclusive.' },
                    endLine: { type: 'number', description: 'End line number, 1-based and inclusive.' },
                    newContent: { type: 'string', description: 'Replacement content for the entire line range.' },
                    expectedContent: { type: 'string', description: 'Optional safety guard. The current selected line range must exactly match this content after line-ending normalization, otherwise the tool refuses to write.' },
                    expectedHash: { type: 'string', description: 'Optional safety guard. SHA-256 hash of the normalized current selected line range. Use when passing expectedContent would be too large.' },
                    expectedStartText: { type: 'string', description: 'Optional safety guard. Current selected range must start with this text after trimming leading whitespace.' },
                    expectedEndText: { type: 'string', description: 'Optional safety guard. Current selected range must end with this text after trimming trailing whitespace.' },
                    encoding: { type: 'string', enum: ['utf8', 'utf8bom'], description: 'Optional encoding override. Omit to preserve existing encoding.' },
                },
                required: ['filePath', 'startLine', 'endLine', 'newContent'],
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
            description: 'MANDATORY on file modification errors. Perform deep reflection before retrying: explain root cause, trace context, outline fix plan. Forces a thinking step. ⚠️ Prioritize checking local rules (query_rules) and vanilla examples (workspace_symbols) before using web searches.',
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
            description: 'Fetch the text content of a public URL (e.g. Stellaris wiki pages, GitHub raw files). Converts HTML to plain text. Use for looking up game mechanics, modding documentation, or locating vanilla definitions online. ⚠️ DO NOT use this as your first step for code diagnosis. Always check local rules and vanilla cache first.',
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
            description: 'Run a shell command in the project workspace root by default. Temporary scripts may live under .cwtools-ai/scratch, but commands that need project files should usually keep the default cwd or explicitly pass the project root. The process receives CWT_WORKSPACE_ROOT, CWT_AGENT_WORKSPACE_DIR, CWT_AGENT_SCRATCH_DIR, and CWT_AGENT_MEDIA_DIR environment variables. Read-only safe commands such as "git status", "git diff", version checks, and basic listing/search commands may run automatically. In Utility mode, when Agent file write mode is set to auto/direct-write, normal non-escalated commands are also auto-approved with no permission card. Other commands ask the user through the permission flow, and the user can choose one-time approval, denial, or Always Allow for this session. Utility mode permits broader project-tooling commands, including PowerShell/pwsh hosts, while non-Utility modes still require escalation for those shell hosts. Destructive commands (rm -rf, del /f, format, shutdown, reboot) and unsafe inline execution patterns remain sandboxed unless requestEscalation is explicitly used.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The shell command to execute' },
                    cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' },
                    timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 15000, max 60000)' },
                    requestEscalation: { type: 'boolean', description: 'Set to true ONLY if you previously attempted this command and it was blocked by the security sandbox. This triggers a high-danger prompt asking the user for a one-time privilege override.' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Search the web for information about Stellaris modding, PDXScript syntax, game mechanics, or any topic. Uses Brave Search API if configured (cwtools.ai.braveSearchApiKey), otherwise falls back to DuckDuckGo. Returns result summaries with URLs. ⚠️ DO NOT use this as your first step for code diagnosis. Always check local rules and vanilla cache first.',
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
            description: 'Search code repositories and developer documentation semantically (powered by Exa API if configured). Use for finding examples of PDXScript patterns, mod implementation references, or any code-level search. Falls back to Brave Search with code-specific query modifiers if no Exa key configured. ⚠️ DO NOT use this as your first step for code diagnosis. Always check local rules and vanilla cache first.',
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
            description: 'Apply a unified diff patch to one or more files atomically. Use this when you already have a valid git-style patch, especially for coordinated multi-file changes. For ordinary PDXScript edits with exact line boundaries, prefer replace_lines; for exact current-text snippets in one file, use multi_replace_file_content. All hunks must succeed or none are written.',
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
            name: 'multi_replace_file_content',
            description: 'Perform multiple independent, non-contiguous replacements in an existing non-localisation file. TargetContent must match the current file exactly inside the supplied line range. For exact line boundaries, prefer replace_lines because it does not depend on string matching. Never use for .yml localisation files; use write_localisation instead.',
            parameters: {
                type: 'object',
                properties: {
                    TargetFile: { type: 'string', description: 'Absolute path of the target file to modify.' },
                    Instruction: { type: 'string', description: 'Explanation of why this edit is being made and the reasoning behind it.' },
                    ReplacementChunks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                StartLine: { type: 'number', description: 'The starting line number of the chunk (1-indexed).' },
                                EndLine: { type: 'number', description: 'The ending line number of the chunk (1-indexed).' },
                                TargetContent: { type: 'string', description: 'The exact old code sequence to be replaced, which must strictly match the local file content.' },
                                ReplacementContent: { type: 'string', description: 'The new code content to replace it with.' },
                            },
                            required: ['StartLine', 'EndLine', 'TargetContent', 'ReplacementContent'],
                        },
                    },
                },
                required: ['TargetFile', 'Instruction', 'ReplacementChunks'],
            },
        },
    },
    // ─── CWTools Deep API tools ──────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'query_definition',
            description: 'GoToDefinition at a position, or FindAllRefs if no definition exists. Uses CWTools AST — faster than grep. If you know the symbol name, prefer query_definition_by_name instead.',
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
            description: 'Find where a named symbol is defined — no file/position needed. Returns file path and line number. Works for any top-level PDXScript key (events, triggers, effects, etc.).',
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
            description: '⚠️ MANDATORY before using any scripted_effect. Lists all scripted effects with name, scope constraints, and type. PDXscript effect names are frequently hallucinated — always verify here first.',
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
            description: '⚠️ MANDATORY before using any scripted_trigger. Lists all scripted triggers with name, scope constraints, and type. Trigger names are frequently hallucinated — always verify here first.',
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
            description: '⚠️ MANDATORY before using any enum field. Query enum values from CWTools rules. Call with no enumName to list all enums, then query specific enum for values. Always verify — enum values are domain-specific.',
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
            description: 'Get deep structural info from CWTools cache: referenced types, scripted variables, effect/trigger blocks, and saved event_targets. Use to understand file dependencies before modification.',
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
            description: '⚠️ MANDATORY before using add_modifier. Lists static modifiers with categories. Modifier names are domain-specific — always verify. Dynamic/engine modifiers may not appear here — use query_rules(category="modifier") as fallback.',
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
            description: 'Store a string in the shared Agent Blackboard memory. Extremely useful for storing parsed ASTs, file manifests, or data maps that would otherwise overwhelm the prompt context. The data is available to all sub-agents running in the current session. Max length: 500 characters per value. If the value exceeds 500 characters, it will be automatically saved to a file and the Blackboard will only store the file path.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Unique string identifier for this data.' },
                    value: { type: 'string', description: 'The string data to store. Keep it short (<= 500 chars).' },
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
    // ─── Persistent Memory (Cross-Session) ──────────────────────────────
    {
        type: 'function',
        function: {
            name: 'save_memory',
            description: 'Persist a learned rule, convention, or important discovery to the project-level memory file (.cwtools-ai-memory.md). This memory persists across sessions — the AI will reference it in every future conversation. Use this sparingly for genuinely important, reusable insights (e.g. coding conventions, namespace patterns, recurring user preferences). Do NOT save transient/task-specific data.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Short descriptive label for this memory entry (e.g. "Event namespace convention").' },
                    content: { type: 'string', description: 'The rule or insight to persist. Be concise.' },
                    priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'Priority level. High = never pruned; low = pruned first when file grows too large. Default: normal.' },
                },
                required: ['key', 'content'],
            },
        },
    },
    // ─── MiniMax CLI Media Tools ─────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'mmx_generate_image',
            description: '🎨 Generate image(s) from a text prompt using MiniMax CLI (mmx). Requires `mmx` CLI installed and authenticated. Output is saved to the current topic media directory `.cwtools-ai/<topicId>/media/`. Each invocation requires user permission.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Text description of the image to generate. Be vivid and detailed for best results.' },
                    aspectRatio: { type: 'string', description: 'Aspect ratio, e.g. "1:1", "16:9", "9:16", "4:3". Default: "1:1"' },
                    count: { type: 'number', description: 'Number of images to generate (1-4). Default: 1' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mmx_generate_video',
            description: '🎬 Generate a video from a text prompt using MiniMax CLI (mmx). Video generation is asynchronous and may take 1-3 minutes. Requires `mmx` CLI installed and authenticated. Output is saved to the current topic media directory `.cwtools-ai/<topicId>/media/`. Each invocation requires user permission.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Text description of the video to generate. Be descriptive about motion, scene, and style.' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mmx_generate_music',
            description: '🎵 Generate music from a text prompt using MiniMax CLI (mmx). Supports lyrics, instrumental mode, and auto-lyric generation. Requires `mmx` CLI installed and authenticated. Output is saved to the current topic media directory `.cwtools-ai/<topicId>/media/`. Each invocation requires user permission.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Music style/genre description, e.g. "Upbeat pop, energetic, summer vibes"' },
                    lyrics: { type: 'string', description: 'Optional lyrics text. Use [verse], [chorus], [bridge] tags for structure.' },
                    instrumental: { type: 'boolean', description: 'If true, generate instrumental music without vocals. Default: false' },
                    lyricsOptimizer: { type: 'boolean', description: 'If true, auto-generate lyrics from the prompt. Default: false' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mmx_generate_speech',
            description: '🗣️ Synthesize speech (TTS) from text using MiniMax CLI (mmx). Supports 30+ voices and speed control. Requires `mmx` CLI installed and authenticated. Output is saved to the current topic media directory `.cwtools-ai/<topicId>/media/`. Each invocation requires user permission.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The text to convert to speech.' },
                    voice: { type: 'string', description: 'Voice name, e.g. "English_magnetic_voiced_man", "Chinese_female_sweet". Use `mmx speech voices` to list all available voices.' },
                    speed: { type: 'number', description: 'Speech speed multiplier (0.5 to 2.0). Default: 1.0' },
                },
                required: ['text'],
            },
        },
    },
    // ─── Media Asset Conversion Tools ────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'convert_image_to_dds',
            description: '🖼️ Convert a PNG/JPG/TGA image to DDS format (required by Clausewitz engine for icons, sprites, and textures). Uses ImageMagick. Supports DXT5/BC3 compression with mipmaps. Requires ImageMagick installed and accessible. Custom path can be set via cwtools.ai.imageMagickPath setting.',
            parameters: {
                type: 'object',
                properties: {
                    sourcePath: { type: 'string', description: 'Absolute path to the source image file (PNG, JPG, or TGA).' },
                    outputDir: { type: 'string', description: 'Directory to write the converted DDS file to. Can be absolute or relative to workspace root (e.g. "gfx/interface/icons/").' },
                    compression: { type: 'string', enum: ['dxt5', 'dxt1', 'none'], description: 'DDS compression type. "dxt5" (default): supports alpha channel, use for most icons. "dxt1": no alpha, smaller file size. "none": uncompressed.' },
                    generateMipmaps: { type: 'boolean', description: 'Whether to generate mipmaps (default true). Required for most in-game textures.' },
                },
                required: ['sourcePath'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'convert_audio',
            description: '🔊 Convert audio files between formats (MP3→OGG for BGM/voice, MP3→WAV for UI sound effects). Uses ffmpeg. Clausewitz engine requires .ogg (Vorbis) for music/voice and .wav (16-bit PCM) for UI sounds. Requires ffmpeg installed and accessible. Custom path can be set via cwtools.ai.ffmpegPath setting.',
            parameters: {
                type: 'object',
                properties: {
                    sourcePath: { type: 'string', description: 'Absolute path to the source audio file.' },
                    outputDir: { type: 'string', description: 'Directory to write the converted file to. Can be absolute or relative to workspace root (e.g. "sound/vo/").' },
                    targetFormat: { type: 'string', enum: ['ogg', 'wav'], description: 'Target audio format. "ogg": Vorbis encoding for BGM and voice lines. "wav": 16-bit PCM for UI sound effects.' },
                    sampleRate: { type: 'number', description: 'Output sample rate in Hz (e.g. 44100, 48000). Default: keep original.' },
                    channels: { type: 'number', description: 'Number of audio channels. 1 = mono (recommended for voice/sfx), 2 = stereo (recommended for music). Default: keep original.' },
                },
                required: ['sourcePath', 'targetFormat'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'deploy_mod_asset',
            description: '📦 Copy a generated/converted media asset file to its final location in the mod workspace. Requires user permission. Use this after convert_image_to_dds or convert_audio to place files in the correct game directory (e.g. gfx/interface/icons/, sound/vo/). The retract system can undo this operation.',
            parameters: {
                type: 'object',
                properties: {
                    sourcePath: { type: 'string', description: 'Absolute path to the source file to deploy.' },
                    targetRelativePath: { type: 'string', description: 'Target path relative to workspace root (e.g. "gfx/interface/icons/tech/my_tech.dds" or "sound/vo/my_voice.ogg").' },
                    overwrite: { type: 'boolean', description: 'If true, overwrite existing file at target. Default: false (fails if file exists).' },
                },
                required: ['sourcePath', 'targetRelativePath'],
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
    // ─── Localisation Tools ──────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'write_localisation',
            description: '🌐 MANDATORY for all .yml localisation file operations. Safely write localisation entries to Stellaris .yml files. filePath MUST be a real localisation path under localisation/, localisation_synced/, or localization/; never write localisation YAML into .cwtools-ai scratch/topic folders. This tool handles BOM encoding, key formatting, and correct insertion/update automatically. For new files, creates them with proper BOM + language header. For existing files, appends new keys and updates existing ones by exact key match. NEVER use multi_replace_file_content, apply_patch, or write_file for .yml localisation files — ALWAYS use this tool instead.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Path to the real .yml localisation file (absolute or relative to workspace), under localisation/, localisation_synced/, or localization/. Do not use .cwtools-ai paths.' },
                    language: { type: 'string', description: 'Language header, e.g. "l_english", "l_simp_chinese", "l_braz_por". Used when creating a new file.' },
                    entries: {
                        type: 'array',
                        description: 'List of localisation key-value pairs to write',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', description: 'Localisation key, e.g. "my_event.1.title"' },
                                value: { type: 'string', description: 'Localisation value text. Use \\n for in-game line breaks. Do NOT include surrounding quotes.' },
                                number: { type: 'integer', description: 'Version number after the colon (default: 0). Usually 0.' },
                                comment: { type: 'string', description: 'Optional section header comment to insert before this entry, e.g. "### Site 1 Events ###"' },
                            },
                            required: ['key', 'value'],
                        },
                    },
                },
                required: ['filePath', 'language', 'entries'],
            },
        },
    },
    // ─── Design Blueprint Tools ─────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'write_design_blueprint',
            description: 'Write a structured design blueprint for a game entity pipeline to the Agent Workspace. You MUST use this tool in Plan Mode BEFORE writing any implementation plan when the task involves: (1) event chains (2+ connected events), (2) archaeological sites, special projects, relics, situations, or anomalies, (3) any task producing 2+ game entity files that reference each other. The blueprint documents entity topology, scope chains, ID allocations, branching logic, media asset requirements, and file dependency order. It is saved as design_blueprint.md and displayed to the user for approval before Build phase begins. NOTE: When researching entities for this blueprint, you MUST combine and cross-reference Vanilla AST folders, the CWT code rule base, and mature instance templates from the project.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Blueprint title, e.g. "Ancient Databank Excavation Pipeline"' },
                    entities: {
                        type: 'array',
                        description: 'All game entities in the cascade pipeline, ordered by trigger sequence',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'Entity ID (e.g. "d_ancient_databank", "ns.100", "MY_PROJECT")' },
                                type: { type: 'string', description: 'Entity type (must match CWT type system). Common types: on_action, anomaly_category, archaeological_site_type, special_project, event_chain, situation_type, relic, artifact_action, technology, building, decision, edict, fleet_event, planet_event, country_event, ship_event, scripted_effect, scripted_trigger, static_modifier, deposit, solar_system_initializer' },
                                file: { type: 'string', description: 'Target file path relative to workspace root' },
                                triggeredBy: { type: 'string', description: 'What triggers this entity (e.g. "MTTH", "on_colonized", "stage 2 completion of d_ancient_databank")' },
                                fires: { type: 'array', items: { type: 'string' }, description: 'IDs of downstream entities this one triggers, with scope transition notation. Format each entry as \"targetId via scope_path\" (e.g. \"ns.100 via owner = { country_event }\", \"MY_PROJECT via fleet event_target\"). Plain IDs are accepted but scope paths are STRONGLY recommended to catch scope chain errors early.' },
                                scopeContext: { type: 'string', description: 'Scope context in CWT format: "this=X root=X from=Y fromfrom=Z". MUST be verified against CWT .cwt rules. Example for arc site stage: "this=fleet root=fleet from=archaeological_site". For special_project on_success: depends on event_scope field.' },
                            },
                            required: ['id', 'type', 'file'],
                        },
                    },
                    eventIdAllocation: {
                        type: 'object',
                        description: 'Pre-allocated event ID ranges for the entire pipeline',
                        properties: {
                            namespace: { type: 'string', description: 'Event namespace' },
                            ranges: { type: 'string', description: 'Allocation plan, e.g. "100-109: site stage events, 200-209: reward events, 300-309: special project events"' },
                        },
                    },
                    localisationKeys: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'All localisation key prefixes to be created (e.g. "my_site_name", "my_site.100.title")',
                    },
                    dependencyOrder: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'File creation order (dependencies first). Files listed earlier must be written before later ones.',
                    },
                    notes: { type: 'string', description: 'Additional design notes: scope chain transition warnings, edge cases, branching logic, or vanilla references studied.' },
                },
                required: ['title', 'entities', 'dependencyOrder'],
            },
        },
    },
    // ── Git Operations tool ──────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'git_ops',
            description: 'Execute safe git operations in the workspace. Use this to inspect changes or revert files to their last committed state when edits have gone wrong. Only available when the workspace has a git repository. Actions: "status" (see modified files), "diff" (see changes for a file), "checkout" (revert a file to HEAD — destructive, discards uncommitted changes to that file).',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['status', 'diff', 'checkout'], description: 'Git operation: "status" = list modified files, "diff" = show changes for a specific file, "checkout" = revert a file to HEAD (discard all uncommitted changes)' },
                    file: { type: 'string', description: 'File path (required for "diff" and "checkout" actions). Relative to workspace root or absolute.' },
                },
                required: ['action'],
            },
        },
    },
    // ── Line-Range Replacement tool ──────────────────────────────────────

    // ── Orchestrator Tools (多 Agent 协调器) ────────────────────────────
    {
        type: 'function',
        function: {
            name: 'dispatch_agents',
            description: '🎯 [Orchestrator-only] Decompose the current task into multiple sub-tasks and dispatch them to specialist agents for parallel execution. Available only in Orchestrator mode. Sub-agents include Explorer (read-only exploration), Builder (code generation), LocWriter (localisation), Reviewer (code review), etc. Agents exchange data via the shared Blackboard and execution order is guaranteed by a DAG.',
            parameters: {
                type: 'object',
                properties: {
                    tasks: {
                        type: 'array',
                        maxItems: 4,
                        description: 'List of sub-tasks. Ordered by dependencies. ⚠️ CRITICAL: Maximum 4 tasks allowed per dispatch to prevent API timeouts! If you have more work, dispatch them in sequential batches across multiple turns.',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'Unique sub-task ID (e.g. "explore_structure", "build_events")' },
                                agentType: { type: 'string', enum: ['explore', 'plan', 'build', 'review', 'loc_writer'], description: 'Agent type to execute this task' },
                                prompt: { type: 'string', description: 'Sub-task description (sent as the agent\'s user message). ⚠️ CRITICAL: KEEP THIS CONCISE to prevent JSON truncation errors. Do NOT embed large file contents or massive path lists here. If you need to pass large data, use `set_memory` first and just pass the memory key in this prompt.' },
                                dependencies: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'List of prerequisite task IDs — this task executes only after all dependencies complete',
                                },
                                contextFiles: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: '(可选) 包含详细设计蓝图或上下文的文件路径或 Blackboard Key。**严禁在 prompt 中直接粘贴数百字的蓝图文本**，请将文件路径写在这里，系统会自动预读并注入给子 Agent。',
                                },
                                plannedFiles: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Optional list of files this sub-task expects to modify. Used by the orchestrator to avoid running conflicting write tasks in the same batch.',
                                },
                                plannedEntities: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Optional list of domain entities this sub-task expects to create or modify, such as event IDs or scripted effect names. Used for concurrency conflict avoidance.',
                                },
                                priority: { type: 'string', enum: ['critical', 'normal', 'low'], description: 'Task priority (default: normal)' },
                                maxIterations: { type: 'integer', minimum: 1, maximum: 100, description: 'Optional per-agent reasoning-loop cap. Leave unset to use the role default.' },
                            },
                            required: ['id', 'agentType', 'prompt'],
                        },
                    },
                },
                required: ['tasks'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'query_blackboard',
            description: '📋 Query data from the shared Blackboard. The Blackboard is a cross-agent knowledge store supporting exact key lookup, prefix-based range queries, and type filtering. Types include: file_snapshot, scope_info, diag_result, entity_registry, write_intent, free_text.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Exact key to look up (mutually exclusive with prefix/type)' },
                    prefix: { type: 'string', description: 'Key prefix for range queries (e.g. "entity:" matches all entries starting with "entity:")' },
                    type: { type: 'string', enum: ['file_snapshot', 'scope_info', 'diag_result', 'entity_registry', 'write_intent', 'free_text'], description: 'Filter by data type' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'merge_results',
            description: '🔗 [Orchestrator-only] Merge execution results from multiple sub-agents into a final deliverable. Call after all sub-agents complete to consolidate code generation, localisation, and review report outputs. Available only in Orchestrator mode.',
            parameters: {
                type: 'object',
                properties: {
                    nodeIds: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'List of task node IDs whose results should be merged',
                    },
                    strategy: { type: 'string', enum: ['concatenate', 'structured', 'summary'], description: 'Merge strategy: "concatenate" (raw join), "structured" (group by file), "summary" (generate summary). Default: structured.' },
                },
                required: ['nodeIds'],
            },
        },
    },
];
