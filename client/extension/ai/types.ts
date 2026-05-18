/**
 * CWTools AI Module — Core Type Definitions
 */

// ─── Agent Modes ─────────────────────────────────────────────────────────────

/**
 * Agent modes — aligned with OpenCode's agent configuration.
 * - build:   Full tool access including file writes + validation loop (default)
 * - plan:    Read-only analysis, no writes, structured plan output
 * - explore: Parallel read-only exploration; focuses on understanding codebase, no validation
 * - general: Legacy read-only Q&A mode kept for saved-topic compatibility.
 * - utility: General-purpose workspace task mode for non-PDXScript scripts/tools.
 * - review:  Read-only mode focused on code review, finding issues, and providing feedback.
 * - loc_translator: Specialized for translating YML localisation files between languages.
 * - loc_writer: Specialized for writing new YML localisation entries from scratch.
 * - orchestrator: Multi-Agent coordinator mode — decomposes tasks and dispatches sub-agents.
 */
export type AgentMode = 'build' | 'plan' | 'explore' | 'general' | 'utility' | 'review' | 'gui_expert' | 'script_reviewer' | 'loc_translator' | 'loc_writer' | 'orchestrator';

// ─── MCP Settings ────────────────────────────────────────────────────────────

export interface MCPServerConfig {
    name: string;
    type: 'stdio' | 'sse';
    // For stdio
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    // For sse
    url?: string;
}

// ─── Provider & Configuration ────────────────────────────────────────────────

export interface AIProviderConfig {
    id: string;
    name: string;
    endpoint: string;
    defaultModel: string;
    models: string[];
    supportsToolUse: boolean;
    /** Whether this provider supports API keys */
    requiresApiKey: boolean;
    /** Whether this provider supports the streaming API */
    supportsStreaming: boolean;
    maxContextTokens: number;
    /** Whether this provider conforms strictly to OpenAI API response formats (determines adapter usage) */
    isOpenAICompatible: boolean;
    /** Whether this provider supports generic FIM API (typically /completions with prompt+suffix) */
    supportsFIM: boolean;
    /**
     * Expected tool call OUTPUT format from the model.
     * 'openai'    – standard JSON tool_calls field (all major official APIs)
     * 'dsml'      – DeepSeek <｜DSML｜function_calls> (raw/local DeepSeek V3+)
     * 'tool_call' – Qwen/Hermes <tool_call>{JSON}</tool_call> (Ollama local models)
     * Default: 'openai'
     */
    toolCallStyle?: 'openai' | 'dsml' | 'tool_call';
    /**
     * Whether this provider supports multimodal vision input (images).
     * For providers where only specific model variants are vision-capable
     * (e.g. glm-4.1v but not glm-5), use isModelVisionCapable() for model-level check.
     */
    supportsVision: boolean;
    /** URL to register an API key for this provider (displayed in Settings UI) */
    registerUrl?: string;
}

export interface AIProviderUserConfig {
    /** Provider ID, e.g. 'deepseek', 'openai' */
    providerId: string;
    /** User-specified model override */
    model: string;
    /** User-specified endpoint override */
    endpoint: string;
    /** Whether a key is stored in SecretStorage (never stored here in plaintext) */
    hasKey?: boolean;
}

export interface AIUserConfig {
    enabled: boolean;
    provider: string;
    model: string;
    endpoint: string;
    /** Legacy plaintext key — only read for migration; write via SecretStorage */
    apiKey: string;
    maxRetries: number;
    /** Absolute wall-clock timeout for one chat completion request. */
    requestTimeoutMs: number;
    /** User override for context window size (0 = use provider default) */
    maxContextTokens: number;
    /** Agent file write mode */
    agentFileWriteMode: 'confirm' | 'auto';
    /** Forced Reflection/Thinking Mode */
    forcedThinkingMode: boolean;
    /** Reasoning effort / thinking depth (used by DeepSeek, OpenAI, Qwen, Gemini etc.) */
    reasoningEffort: 'low' | 'medium' | 'high' | 'max';
    inlineCompletion: {
        enabled: boolean;
        debounceMs: number;
        provider: string;
        model: string;
        endpoint: string;
        overlapStripping: boolean;
    };
    mcp: {
        servers: MCPServerConfig[];
    };
}

// ─── API Request/Response (OpenAI-compatible format) ─────────────────────────

/**
 * A single part of a multimodal content array.
 * Supports text and image_url (OpenAI vision format).
 */
export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** String for text-only; ContentPart[] for multimodal (vision) messages */
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    /**
     * Extended reasoning / thinking content (DeepSeek V4, Qwen3+, etc.).
     * Must be preserved and sent back on ALL assistant messages when
     * using DeepSeek's thinking mode, otherwise API returns 400.
     */
    reasoning_content?: string | null;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;  // JSON string
    };
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;  // JSON Schema
    };
}

export interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    stop?: string[];
    /** Supported by DeepSeek and OpenAI for thinking depth */
    reasoning_effort?: 'low' | 'medium' | 'high' | 'max';
    /** Extra provider-specific params to merge into the request body (e.g. thinking config) */
     
    [key: string]: any;
}

export interface ChatCompletionChoice {
    index: number;
    message: ChatMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface StreamChunk {
    id: string;
    choices: Array<{
        index: number;
        delta: Partial<ChatMessage>;
        finish_reason: string | null;
    }>;
}

// ─── Agent Tool Types ────────────────────────────────────────────────────────

export interface QueryScopeArgs {
    file: string;
    line: number;
    column: number;
}

export interface QueryScopeResult {
    currentScope: string;
    root: string;
    thisScope: string;
    prevChain: string[];
    fromChain: string[];
}

export interface QueryTypesArgs {
    typeName: string;
    filter?: string;
    limit?: number;
}

export interface QueryTypesResult {
    typeName: string;
    instances: Array<{
        id: string;
        file: string;
        subtypes?: string[];
    }>;
    totalCount: number;
}

export interface QueryLocalisationIndexArgs {
    key?: string;
    language?: string;
    prefix?: boolean;
    limit?: number;
}

export interface QueryLocalisationIndexResult {
    status: 'ready' | 'indexing' | 'idle' | 'error' | 'unavailable';
    totalCount: number;
    entries: Array<{
        key: string;
        value: string;
        file: string;
        line: number;
        language: string;
    }>;
    _hint?: string;
}

export interface QueryWorkspaceIndexArgs {
    name?: string;
    kind?: string;
    category?: string;
    source?: 'script' | 'asset' | 'gui';
    origin?: 'workspace' | 'vanilla' | 'both';
    directory?: string;
    prefix?: boolean;
    exact?: boolean;
    includeReferences?: boolean;
    limit?: number;
}

export interface QueryWorkspaceIndexResult {
    status: 'ready' | 'indexing' | 'idle' | 'error' | 'unavailable';
    totalCount: number;
    entries: Array<{
        name: string;
        kind: string;
        file: string;
        line: number;
        source: 'script' | 'asset' | 'gui';
        origin?: 'workspace' | 'vanilla';
        container?: string;
        category?: string;
        references?: Array<{
            file: string;
            line: number;
            context: string;
        }>;
        updatedAt?: number;
        fileVersion?: number;
    }>;
    indexedSymbolNames?: number;
    indexUpdatedAt?: number;
    _hint?: string;
}

export interface QueryRulesArgs {
    category: 'trigger' | 'effect' | 'scope_change' | 'modifier';
    name?: string;
    scope?: string;
}

export interface RuleInfo {
    name: string;
    description: string;
    scopes: string[];
    syntax: string;
}

export interface QueryRulesResult {
    rules: RuleInfo[];
    totalCount: number;
    truncated: boolean;
}

export interface QueryReferencesArgs {
    identifier: string;
    file?: string;
}

export interface QueryReferencesResult {
    references: Array<{
        file: string;
        line: number;
        context: string;
    }>;
}


export interface ValidationError {
    code: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    line: number;
    column: number;
}


export interface GetFileContextArgs {
    file: string;
    line: number;
    radius?: number;
}

export interface GetFileContextResult {
    code: string;
    symbolInfo?: {
        typename: string;
        name: string;
        ruleDescription?: string;
        requiredScopes: string[];
    };
    fileType: string;
}

export interface SearchModFilesArgs {
    query: string;
    directory?: string;
    fileExtension?: string;
    exactMatch?: boolean;
    searchContext?: 'mod' | 'vanilla' | 'both';
    isRegex?: boolean;
    caseSensitive?: boolean;
    limit?: number;
    fileExtensions?: string[];
}

export interface SearchModFilesResult {
    files: Array<{
        /** Relative path from searchedRoot */
        logicalPath: string;
        matchingLines: Array<{
            line: number;
            content: string;
        }>;
    }>;
    searchedRoot?: string;
    totalFound?: number;
    _warning?: string;
    _nextSteps?: string[];
    _hint?: string;
}

export interface FindSpriteCandidatesArgs {
    /** Free-text search query such as "anomaly" or "force echo". */
    query?: string;
    /** The invalid or desired sprite value, e.g. GFX_evt_analyzing_anomaly. */
    currentValue?: string;
    /** PDXScript field being repaired, e.g. picture, icon, spriteType. */
    fieldName?: string;
    /** Optional file containing the diagnostic, used only for result context. */
    file?: string;
    /** Optional diagnostic line number. */
    line?: number;
    /** Search mod workspace, vanilla cache, or both. Defaults to both. */
    searchContext?: 'mod' | 'vanilla' | 'both';
    /** Maximum candidates to return. Defaults to 20, max 50. */
    limit?: number;
}

export interface FindSpriteCandidatesResult {
    query: string;
    candidates: Array<{
        name: string;
        source: 'mod' | 'vanilla';
        file: string;
        line: number;
        textureFile?: string;
        spriteType?: string;
        score: number;
        matchedBy: string[];
    }>;
    searchedRoots: string[];
    _warning?: string;
    _hint?: string;
}

export interface FindSoundCandidatesArgs {
    /** Free-text search query such as "alien signal" or "ui click". */
    query?: string;
    /** The current invalid or desired sound value, e.g. "event_alien_signal". */
    currentValue?: string;
    /** PDXScript field being repaired, e.g. show_sound or sound. */
    fieldName?: string;
    /** Optional file containing the diagnostic, used only for result context. */
    file?: string;
    /** Optional diagnostic line number. */
    line?: number;
    /** Search mod workspace, vanilla cache, or both. Defaults to both. */
    searchContext?: 'mod' | 'vanilla' | 'both';
    /** Maximum candidates to return. Defaults to 20, max 50. */
    limit?: number;
}

export interface FindSoundCandidatesResult {
    query: string;
    candidates: Array<{
        name: string;
        source: 'mod' | 'vanilla';
        file: string;
        line: number;
        assetType?: string;
        fileRef?: string;
        score: number;
        matchedBy: string[];
    }>;
    searchedRoots: string[];
    _warning?: string;
    _hint?: string;
}

export interface GrepArgs {
    query: string;
    path?: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    include?: string;
    limit?: number;
}

export interface GrepResult {
    matches: Array<{ file: string; line: number; content: string }>;
    totalMatches: number;
    truncated: boolean;
    _warning?: string;
    _nextSteps?: string[];
    _hint?: string;
}

export interface GetCompletionAtArgs {
    file: string;
    line: number;
    column: number;
    fileContent: string;
}

export interface DocumentSymbolsArgs {
    file: string;
}

export interface DocumentSymbolInfo {
    name: string;
    kind: string;
    range: { startLine: number; endLine: number };
    children?: DocumentSymbolInfo[];
    /** True if this node has deeper nested children not shown (depth limit) */
    _hasDeeper?: boolean;
}

export interface DocumentSymbolsResult {
    symbols: DocumentSymbolInfo[];
}

export interface WorkspaceSymbolsArgs {
    query: string;
    limit?: number;
}

export interface WorkspaceSymbolsResult {
    symbols: Array<{
        name: string;
        kind: string;
        file: string;
        line: number;
    }>;
    _warning?: string;
    _hint?: string;
}

export interface VerifyPdxIdentifierArgs {
    identifier: string;
    typeName?: string;
    directory?: string;
    fileExtensions?: string[];
    includeVanilla?: boolean;
    caseSensitive?: boolean;
    limit?: number;
}

export interface VerifyPdxIdentifierResult {
    identifier: string;
    status: 'found' | 'ambiguous' | 'not_found' | 'inconclusive';
    confidence: 'high' | 'medium' | 'low';
    canTreatAsMissing: boolean;
    evidence: Array<{
        source: string;
        status: 'found' | 'partial' | 'not_found' | 'error';
        summary: string;
    }>;
    matches: Array<{
        source: string;
        file: string;
        line?: number;
        name?: string;
        kind?: string;
        content?: string;
        vanilla?: boolean;
    }>;
    nextSteps: string[];
    _warning?: string;
}

// ─── TodoWrite Tool Types ────────────────────────────────────────────────────

export interface TodoItem {
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'done';
    priority?: 'high' | 'medium' | 'low';
}

export interface TodoWriteArgs {
    todos: TodoItem[];
}

export interface TodoWriteResult {
    success: boolean;
    todoCount: number;
}

export interface GetCompletionAtResult {
    completions: Array<{
        label: string;
        kind: string;
        description?: string;
    }>;
    /** Total completions available from the LSP before slicing */
    totalAvailable?: number;
    _note?: string;
}

// ─── Blackboard Memory Tool Types ──────────────────────────────────────────────

export interface SetMemoryArgs {
    key: string;
    value: string;
}

export interface SetMemoryResult {
    success: boolean;
    message: string;
}

export interface GetMemoryArgs {
    key: string;
}

export interface GetMemoryResult {
    found: boolean;
    value?: string;
}

// ─── Agent Tool Context ────────────────────────────────────────────────────────

/** 
* Per-run context passed to tool executor (thread safety/concurrency isolation) 
*/
export interface AgentToolContext {
    runnerOptions?: import('./agentRunner').AgentRunnerOptions;
    agentRunner?: import('./agentRunner').AgentRunner;
    tokenAccumulator?: TokenUsage;
    onStep?: (step: AgentStep) => void;
    onPermissionRequest?: (id: string, tool: string, description: string, command?: string) => Promise<boolean>;
    onBeforeFileWrite?: (filePath: string, previousContent: string | null) => void;
    onTodoUpdate?: (todos: import('./types').TodoItem[]) => void;
}

// Union type for all tool args/results
export type ToolArgs =
    | QueryScopeArgs
    | QueryTypesArgs
    | QueryLocalisationIndexArgs
    | QueryWorkspaceIndexArgs
    | QueryRulesArgs
    | QueryReferencesArgs
    | GetFileContextArgs
    | SearchModFilesArgs
    | FindSpriteCandidatesArgs
    | FindSoundCandidatesArgs
    | GetCompletionAtArgs
    | DocumentSymbolsArgs
    | WorkspaceSymbolsArgs
    | VerifyPdxIdentifierArgs
    | TodoWriteArgs
    | ReadFileArgs
    | WriteFileArgs
    | EditFileArgs
    | ReplaceLinesArgs
    | ListDirectoryArgs
    | CodesearchArgs
    | AnalyzeDiagnosticErrorArgs
    | SetMemoryArgs
    | GetMemoryArgs
    | WriteDesignBlueprintArgs
    | EditPdxBlockArgs
    | GrepArgs;

export type ToolResult =
    | QueryScopeResult
    | QueryTypesResult
    | QueryLocalisationIndexResult
    | QueryWorkspaceIndexResult
    | QueryRulesResult
    | QueryReferencesResult
    | GetFileContextResult
    | SearchModFilesResult
    | FindSpriteCandidatesResult
    | FindSoundCandidatesResult
    | GetCompletionAtResult
    | DocumentSymbolsResult
    | WorkspaceSymbolsResult
    | VerifyPdxIdentifierResult
    | TodoWriteResult
    | ReadFileResult
    | WriteFileResult
    | EditFileResult
    | ReplaceLinesResult
    | ListDirectoryResult
    | AnalyzeDiagnosticErrorResult
    | SetMemoryResult
    | GetMemoryResult
    | WriteDesignBlueprintResult
    | ReplaceLinesResult
    | GrepResult;

export type AgentToolName =
    | 'query_scope'
    | 'query_types'
    | 'query_localisation_index'
    | 'query_workspace_index'
    | 'query_rules'
    | 'query_references'
    // validate_code — REMOVED: replaced by get_diagnostics + multi_replace_file_content inline diagnostics
    | 'get_diagnostics'
    | 'get_file_context'
    | 'search_mod_files'
    | 'find_sprite_candidates'
    | 'find_sound_candidates'
    | 'get_completion_at'
    | 'document_symbols'
    | 'workspace_symbols'
    | 'verify_pdx_identifier'
    | 'todo_write'
    | 'read_file'
    | 'write_file'
    | 'multi_replace_file_content'
    | 'replace_lines'
    | 'list_directory'
    | 'glob_files'
    | 'lsp_operation'
    | 'web_fetch'
    | 'search_web'
    | 'codesearch'
    | 'grep'
    | 'run_command'
    | 'apply_patch'
    | 'analyze_diagnostic_error'
    | 'set_memory'
    | 'get_memory'
    | 'search_memory'
    | 'save_memory'
    // ── CWTools Deep API tools ──
    | 'query_definition'
    | 'query_definition_by_name'
    | 'query_scripted_effects'
    | 'query_scripted_triggers'
    | 'query_enums'
    | 'get_entity_info'
    | 'query_static_modifiers'
    | 'query_variables'
    // ── Error Resolution tools ──
    // ignore_validation_error — REMOVED: AI must fix errors, not suppress them
    | 'remove_ignored_diagnostic'
    | 'get_ignored_diagnostics'
    | 'get_pdx_block'
    | 'edit_pdx_block'
    // ── MiniMax CLI Media tools ──
    | 'mmx_generate_image'
    | 'mmx_generate_video'
    | 'mmx_generate_music'
    | 'mmx_generate_speech'
    // ── Media Asset Conversion tools ──
    | 'convert_image_to_dds'
    | 'convert_audio'
    | 'deploy_mod_asset'
    // ── Localisation tools ──
    | 'write_localisation'
    // ── Design tools ──
    | 'write_design_blueprint'
    // ── Git tools ──
    | 'git_ops'
    // ── MCP tools ──
    | 'mcp_call'
    // ── Orchestrator tools ──
    | 'dispatch_agents'
    | 'query_blackboard'
    | 'merge_results';

// ─── File Tool Types ─────────────────────────────────────────────────────────

export interface ReadFileArgs {
    file: string;
    startLine?: number;
    endLine?: number;
}

export interface ReadFileResult {
    content: string;
    totalLines: number;
    truncated: boolean;
    /** Guidance message returned when file is too large or content is truncated */
    _hint?: string;
}

export interface WriteFileArgs {
    file: string;
    content: string;
    encoding?: 'utf8' | 'utf8bom';
}

export interface WriteFileResult {
    success: boolean;
    message: string;
    /** LSP diagnostics detected after the write */
    diagnostics?: ValidationError[];
    freshness?: 'fresh' | 'pending' | 'stale';
    pendingGlobalKinds?: string[];
    /** If agentFileWriteMode === 'confirm', this is a pending diff, not yet applied */
    pendingDiff?: string;
}

export interface EditFileArgs {
    /** Absolute path to the file to modify */
    filePath: string;
    /** The exact text to find and replace (empty string = create new file) */
    oldString: string;
    /** The replacement text */
    newString: string;
    /** If true, replace all occurrences; default false */
    replaceAll?: boolean;
    encoding?: 'utf8' | 'utf8bom';
}

export interface EditFileResult {
    success: boolean;
    message: string;
    /** Unified diff of the change */
    diff?: string;
    /** LSP diagnostics detected after the edit */
    diagnostics?: ValidationError[];
    freshness?: 'fresh' | 'pending' | 'stale';
    pendingGlobalKinds?: string[];
    fileSyntaxFresh?: boolean;
    localKeyIndexed?: boolean;
    globalLocalisationFresh?: boolean;
    stats?: { linesAdded: number; linesRemoved: number };
    /** If agentFileWriteMode === 'confirm', write was queued, not yet applied */
    pendingDiff?: string;
}

export interface ReplaceLinesArgs {
    /** Absolute path to the file to modify */
    filePath: string;
    /** Start line number (1-based, inclusive) */
    startLine: number;
    /** End line number (1-based, inclusive) */
    endLine: number;
    /** The replacement content for the specified line range */
    newContent: string;
    /** Optional guard: current content of the selected line range must match before replacing */
    expectedContent?: string;
    /** Optional guard: sha256 hash of the normalized current selected line range */
    expectedHash?: string;
    /** Optional guard: current selected range must start with this text after trimming leading whitespace */
    expectedStartText?: string;
    /** Optional guard: current selected range must end with this text after trimming trailing whitespace */
    expectedEndText?: string;
    encoding?: 'utf8' | 'utf8bom';
}

export interface EditPdxBlockArgs {
    /** Absolute path to the file to modify */
    file: string;
    /** Name of the top-level block/identifier to replace */
    symbol: string;
    /** The replacement content for the specified block */
    newContent: string;
}

export interface ReplaceLinesResult {
    success: boolean;
    message: string;
    /** Unified diff of the change */
    diff?: string;
    /** LSP diagnostics detected after the edit */
    diagnostics?: ValidationError[];
    freshness?: 'fresh' | 'pending' | 'stale';
    pendingGlobalKinds?: string[];
    /** If agentFileWriteMode === 'confirm', write was queued, not yet applied */
    pendingDiff?: string;
}

export interface AstMutateArgs {
    filePath: string;
    targetPath: string[];
    action: 'replace' | 'append' | 'prepend' | 'delete';
    payload?: string;
    encoding?: string;
}

export interface AstMutateResult extends EditFileResult {
    nodeFound?: boolean;
}

export interface ListDirectoryArgs {
    directory: string;
    recursive?: boolean;
}

export interface ListDirectoryResult {
    entries: Array<{
        name: string;
        type: 'file' | 'directory';
        size?: number;
    }>;
    path: string;
}

export interface CodesearchArgs {
    query: string;
    maxResults?: number;
}

export interface AnalyzeDiagnosticErrorArgs {
    file: string;
    errorCode: string;
    reflection: string;
}

// ─── Design Blueprint Tool Types ─────────────────────────────────────────────

export interface BlueprintEntity {
    id: string;
    type: string;
    file: string;
    triggeredBy?: string;
    fires?: string[];
    scopeContext?: string;
}

export interface WriteDesignBlueprintArgs {
    title: string;
    entities: BlueprintEntity[];
    eventIdAllocation?: {
        namespace: string;
        ranges: string;
    };
    localisationKeys?: string[];
    dependencyOrder: string[];
    notes?: string;
}

export interface WriteDesignBlueprintResult {
    success: boolean;
    message: string;
    filePath: string;
}

export interface AnalyzeDiagnosticErrorResult {
    success: boolean;
    acknowledged: boolean;
    message: string;
}

/** Single diagnostic entry from CWTools LSP */
export interface DiagnosticEntry {
    file: string;
    /** Relative logical path from workspace root */
    logicalPath: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    line: number;
    column: number;
    code?: string;
}

export interface GetDiagnosticsResult {
    /** All diagnostics, grouped summary by severity */
    summary: { errors: number; warnings: number; info: number; hints: number };
    /** Diagnostics list, truncated to limit */
    diagnostics: DiagnosticEntry[];
    totalFiles: number;
    /** Total number of matching diagnostics before truncation */
    totalDiagnosticCount: number;
    truncated: boolean;
    /** Global diagnostic freshness: fresh=all verification completed, pending=global verification in progress, stale=not verified */
    freshness?: 'fresh' | 'pending' | 'stale';
    /** Currently unfinished global validation types, such as ["localisation", "types"] */
    pendingGlobalKinds?: string[];
    /** Global diagnostic epoch counter */
    lastEpoch?: number;
}

// ─── Token Usage & Cost ──────────────────────────────────────────────────────

export interface TokenUsage {
    /** Total tokens used across all API calls in this generation */
    total: number;
    /** Input/prompt tokens */
    input: number;
    /** Output/completion tokens */
    output: number;
    /** Estimated cost in CNY (based on provider pricing table) */
    estimatedCostCny: number;
    /** Final prompt tokens for the conversation window, used to drive the UI fullness progress bar */
    contextWindowTokens?: number;
}

export interface AgentRunMetrics {
    /** Number of reasoning loop iterations used by this generation. */
    iterations: number;
    /** Maximum reasoning loop iterations allowed for this generation. */
    maxIterations: number;
    /** Total tool calls emitted by the model. */
    toolCallCount: number;
    /** Tool call counts grouped by tool name. */
    toolCallsByName: Record<string, number>;
    /** Number of repeated adjacent tool-call signature pairs observed. */
    repeatedToolSignatureCount: number;
    /** Largest serialized tool result seen before budgeting. */
    maxToolResultChars: number;
    /** Final estimated tokens in the active message window. */
    finalPromptTokens: number;
}

// ─── Tool Result Types (Batch 2.1) ──────────────────────────────────────────


/**
 * Agent checkpoint — serializable snapshot for long-task resilience (Batch 2.3).
 * Saved periodically so the agent can resume after crashes or context resets.
 */
export interface AgentCheckpoint {
    /** Checkpoint version for forward compatibility */
    version: 1;
    /** Timestamp of the checkpoint */
    timestamp: number;
    /** Current iteration index in the reasoning loop */
    iteration: number;
    /** Files written so far (for rollback awareness) */
    writtenFiles: string[];
    /** Compressed summary of conversation up to this point */
    conversationSummary: string;
    /** Current todo list state */
    todoSnapshot: string;
    /** Topic ID for associating with the correct session */
    topicId?: string;
}

/**
 * Agent resume state — fully serializable state of an interrupted agent task.
 * Allows the agent to resume execution from the exact point of interruption
 * with the complete tool call context and reasoning history.
 */
export interface AgentResumeState {
    timestamp: number;
    mode: AgentMode;
    messages: ChatMessage[];
    todos: TodoItem[];
    topicId: string;
}

// ─── Agent Execution ─────────────────────────────────────────────────────────

export interface AgentStep {
    /**
     * Step types (OpenCode-aligned):
     * - thinking          : narrative step description (non-blocking)
     * - thinking_content  : extended reasoning / <think> block content
     * - tool_call         : agent is invoking a tool
     * - tool_result       : tool returned a result
     * - text_delta        : streaming text token (for live render)
     * - step_finish       : agent step completed (mirrors OpenCode finish-step event)
     * - code_generated    : code extraction complete
     * - validation        : inline validation result
     * - error             : recoverable or terminal error
     * - compaction        : context history was compressed
     * - todo_update       : todo list was updated
     * - permission_request: agent is asking user for permission (bash/write)
     * - subtask_start     : a sub-agent task was dispatched
     * - subtask_complete  : a sub-agent task completed
     */
    type: 'thinking' | 'thinking_content' | 'tool_call' | 'tool_result'
    | 'text_delta' | 'step_finish'
    | 'code_generated' | 'validation' | 'error' | 'compaction'
    | 'todo_update' | 'permission_request'
    | 'subtask_start' | 'subtask_complete' | 'diff_summary'
    | 'plan_card' | 'blueprint_card' | 'walkthrough_card' | 'transaction_card' | 'orchestrator_progress';
    content: string;
    toolName?: AgentToolName | string;
    toolArgs?: Record<string, unknown>;
    toolResult?: unknown;
    timestamp: number;
    /** For permission_request: identifier so UI can respond */
    permissionId?: string;
    /** For subtask steps: the sub-agent type */
    subagentType?: string;
    transactionCard?: {
        id: string;
        filesRequested: string[];
        status: 'pending' | 'approved' | 'rejected';
    };
    /** Global 1-based index of this tool call within the reasoning loop */
    stepIndex?: number;
    /** Tool execution duration in milliseconds (tool_result only) */
    durationMs?: number;
    /** Iteration context string, e.g. "Iteration 3/10" */
    iterationInfo?: string;
    /** Child Agent node ID, used for UI group display */
    agentId?: string;
    /** UI-only lifecycle marker for persisted interactive cards restored from history. */
    uiState?: 'pending' | 'approved';
}

export type AgentArtifactKind =
    | 'plan'
    | 'blueprint'
    | 'walkthrough'
    | 'diff'
    | 'diagnostics'
    | 'validation'
    | 'media'
    | 'blackboard';

export type DiffFileStatus = 'created' | 'modified' | 'deleted';

export interface DiffLine {
    type: 'add' | 'remove' | 'context';
    content: string;
    oldLineNo?: number;
    newLineNo?: number;
}

export interface DiffSummaryFile {
    file: string;
    status: DiffFileStatus;
    diffPreview: string;
    additions?: number;
    deletions?: number;
    diffLines?: DiffLine[];
}

export interface DiffArtifactFile extends DiffSummaryFile {
    previousContent?: string | null;
    currentContent?: string | null;
    tooLarge?: boolean;
    currentTooLarge?: boolean;
}

export interface DiffArtifactData {
    files: DiffArtifactFile[];
    additions: number;
    deletions: number;
}

export interface AgentArtifact {
    id: string;
    kind: AgentArtifactKind;
    title: string;
    summary?: string;
    filePath?: string;
    relPath?: string;
    action?: 'openFile' | 'openDiff' | 'preview';
    status?: 'pending' | 'running' | 'done' | 'failed';
    createdAt: number;
    updatedAt?: number;
    data?: unknown;
}

export interface GenerationResult {
    code: string;
    explanation: string;
    validationErrors: ValidationError[];
    isValid: boolean;
    retryCount: number;
    steps: AgentStep[];
    /** Token usage accumulated across all API calls in this generation */
    tokenUsage?: TokenUsage;
    /** Lightweight run metrics used for performance diagnostics. */
    runMetrics?: AgentRunMetrics;
}

// ─── Chat History ────────────────────────────────────────────────────────────

export interface ChatTopic {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ChatHistoryMessage[];
    /** If this topic was forked from another, the parent topic ID */
    parentTopicId?: string;
    /** The message index in the parent topic where the fork occurred */
    forkedFromMessageIndex?: number;
    /** Whether this session is archived (hidden from main list) */
    archived?: boolean;
    /** Whether this topic is pinned in manager/session rail */
    pinned?: boolean;
    /** Optional workspace grouping identifier */
    workspaceId?: string;
    /** Optional workspace display label */
    workspaceLabel?: string;
}

export interface ChatHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
    /** Optional compact UI text when content contains injected context for the model. */
    displayContent?: string;
    /** Structured references attached to this user turn for compact replay in the UI. */
    contexts?: ContextItem[];
    code?: string;
    isValid?: boolean;
    timestamp: number;
    steps?: AgentStep[];
    /** Base64 data-URL images attached to this user message (persisted with topic) */
    images?: string[];
    /** Whether this message should remain hidden from the UI (e.g. system programmatic instructions) */
    isHidden?: boolean;
}

// ─── Context Tray Types ──────────────────────────────────────────────────────

export type ContextItemType = 'code_selection' | 'image' | 'diagnostics' | 'file' | 'folder' | 'scope' | 'symbol' | 'vanilla' | 'blackboard';

export interface BaseContextItem {
    id: string;
    type: ContextItemType;
    label: string;
    description?: string;
    tokenEstimate?: number;
    cacheStatus?: 'live' | 'disk' | 'cached' | 'large' | 'missing' | 'external' | 'unknown';
}

export interface CodeSelectionContext extends BaseContextItem {
    type: 'code_selection';
    uri: string;
    startLine: number;
    endLine: number;
}

export interface FileContext extends BaseContextItem {
    type: 'file';
    uri: string;
}

export interface FolderContext extends BaseContextItem {
    type: 'folder';
    uri: string;
}

export interface DiagnosticsContext extends BaseContextItem {
    type: 'diagnostics';
    uri?: string;
}

export interface ScopeContext extends BaseContextItem {
    type: 'scope';
    uri?: string;
    line?: number;
    column?: number;
}

export interface SymbolContext extends BaseContextItem {
    type: 'symbol';
    name: string;
    kind?: string;
    uri?: string;
    line?: number;
    column?: number;
}

export interface VanillaContext extends BaseContextItem {
    type: 'vanilla';
    vanillaType: string;
    vanillaId: string;
    uri?: string;
}

export interface BlackboardContext extends BaseContextItem {
    type: 'blackboard';
    key: string;
}

export type ContextItem = CodeSelectionContext | FileContext | FolderContext | DiagnosticsContext | ScopeContext | SymbolContext | VanillaContext | BlackboardContext | BaseContextItem;

// ─── WebView Communication ───────────────────────────────────────────────────

export type WebViewMessage =
    | { type: 'sendMessage'; text: string; attachedFiles?: string[]; images?: string[] }
    | { type: 'sendMessageWithReference'; text: string; contexts: ContextItem[]; images?: string[] }
    | { type: 'openContextReference'; context: ContextItem }
    | { type: 'insertCode'; code: string }
    | { type: 'copyCode'; code: string }
    | { type: 'regenerate' }
    | { type: 'resumeGeneration' }
    | { type: 'newTopic' }
    | { type: 'loadTopic'; topicId: string }
    | { type: 'deleteTopic'; topicId: string }
    | { type: 'renameTopic'; topicId: string; title: string }
    | { type: 'forkTopic'; topicId: string; messageIndex: number }
    | { type: 'archiveTopic'; topicId: string }
    | { type: 'pinTopic'; topicId: string; pinned?: boolean }
    | { type: 'setTopicWorkspace'; topicId: string; workspaceId?: string | null; workspaceLabel?: string | null }
    | { type: 'setShowArchived'; show: boolean }
    | { type: 'configureProvider' }
    | { type: 'cancelGeneration' }
    | { type: 'switchMode'; mode: AgentMode }
    | { type: 'switchWorkflow'; workflowId?: string | null }
    | { type: 'openSettings' }
    | { type: 'saveSettings'; settings: PanelSettings }
    | { type: 'detectOllamaModels'; endpoint: string }
    | { type: 'fetchApiModels'; providerId: string; endpoint: string; apiKey: string }
    | { type: 'testConnection'; settings: PanelSettings } | { type: 'deleteDynamicModel'; providerId: string; modelId: string }
    | { type: 'installSkill'; source: string }
    | { type: 'deleteSkill'; skill: string }
    | { type: 'retractMessage'; messageIndex: number }
    | { type: 'confirmWriteFile'; messageId: string }
    | { type: 'cancelWriteFile'; messageId: string }
    | { type: 'quickChangeModel'; model: string }
    | { type: 'slashCommand'; command: string }
    | { type: 'permissionResponse'; permissionId: string; allowed: boolean; alwaysAllow?: boolean }
    /** Submit inline annotations collected in the webview back to AI for revision */
    | { type: 'submitPlanAnnotations'; annotations: Array<{ section: string; note: string }> }
    | { type: 'revisePlanWithAnnotations'; annotations: Array<{ section: string; note: string }> }
    | { type: 'reviseWalkthroughWithAnnotations'; annotations: Array<{ section: string; note: string }> }
    | { type: 'approveWalkthrough' }
    /** Open the plan .md file in the VS Code editor */
    | { type: 'openPlanFile'; filePath: string }
    /** Open an artifact action, such as a native diff for file-change artifacts */
    | { type: 'openArtifact'; artifactId: string; file?: string }
    /** WebView is fully loaded and ready to receive messages */
    | { type: 'ready' }
    /** Request the list of workspace files for @ mention */
    | { type: 'requestFileList' }
    /** Search topics by keyword */
    | { type: 'searchTopics'; query: string }
    /** Export current or specified topic as Markdown */
    | { type: 'exportTopic'; topicId?: string }
    /** Export current or specified topic as JSON */
    | { type: 'exportTopicJson'; topicId?: string }
    /** Import topic from JSON */
    | { type: 'importTopic'; data: string }
    | { type: 'requestUsageStats' }
    | { type: 'promptClearUsageStats' }
    | { type: 'approveTransaction'; txId: string }
    | { type: 'rejectTransaction'; txId: string }
    | { type: 'clearUsageStats' }
    | { type: 'requestMentionSearch'; query: string }
    | { type: 'requestManagerSnapshot' };

export type HostMessage =
    | { type: 'addUserMessage'; text: string; messageIndex: number; images?: string[]; contexts?: ContextItem[] }
    | { type: 'startBackgroundGeneration' }
    | { type: 'agentStep'; step: AgentStep }
    | { type: 'generationComplete'; result: GenerationResult }
    | { type: 'generationError'; error: string; canResume?: boolean }
    | { type: 'insertSelectionReference'; relPath: string; startLine: number; endLine: number }
    | { type: 'topicList'; topics: Array<{ id: string; title: string; updatedAt: number; createdAt?: number; archived?: boolean; pinned?: boolean; workspaceId?: string; workspaceLabel?: string; messageCount?: number; parentTopicId?: string; forkedFromMessageIndex?: number }>; stats?: { total: number; visible: number; archived: number; currentTopicId?: string | null; currentTopicTitle?: string | null } }
    | { type: 'loadTopicMessages'; messages: ChatHistoryMessage[] }
    | { type: 'streamToken'; token: string }
    | { type: 'clearChat' }
    | { type: 'modeChanged'; mode: AgentMode; label?: string }
    | { type: 'workflowList'; workflows: Array<{ id: string; title: string; description: string; mode: string; locale?: string; phases: Array<{ id: string; title: string; description: string }>; verification: Array<{ id: string; description: string; required: boolean; verificationTool?: string }> }>; currentWorkflowId?: string | null; labels?: { selectorPlaceholder: string; noWorkflowSelected: string; phaseUnit: string; phasesUnit: string; requiredCheckUnit: string; requiredChecksUnit: string } }
    | { type: 'workflowChanged'; workflowId?: string | null; workflow?: { id: string; title: string; description: string; mode: string; locale?: string; phases: Array<{ id: string; title: string; description: string }>; verification: Array<{ id: string; description: string; required: boolean; verificationTool?: string }> }; labels?: { selectorPlaceholder: string; noWorkflowSelected: string; phaseUnit: string; phasesUnit: string; requiredCheckUnit: string; requiredChecksUnit: string } }
    | { type: 'todoUpdate'; todos: TodoItem[] }
    | { type: 'settingsData'; providers: ProviderMeta[]; current: PanelSettings; ollamaModels?: OllamaModelInfo[]; showPanel?: boolean; targetSurface?: 'chat' | 'manager'; modelContextTokens?: Record<string, number>; thinkingModelPrefixes?: string[] }
    | { type: 'ollamaModels'; models: OllamaModelInfo[]; error?: string }
    | { type: 'apiModelsFetched'; providerId: string; models: Array<{ id: string }>; dynContexts?: Record<string, number>; error?: string; ctxNote?: string }
    | { type: 'testConnectionResult'; ok: boolean; message: string }
    | { type: 'messageRetracted'; messageIndex: number }
    | { type: 'pendingWriteFile'; file: string; messageId: string; isNewFile: boolean; diffPreview?: string; additions?: number; deletions?: number; diffLines?: DiffLine[] }
    | { type: 'autoWriteFile'; file: string; isNewFile: boolean }
    | { type: 'topicTitleGenerated'; topicId: string; title: string }
    | { type: 'topicForked'; newTopicId: string; title: string }
    | { type: 'permissionRequest'; permissionId: string; tool: string; description: string; command?: string; allowAlways?: boolean }
    /** Restore mode state after webview rebuild (panel visibility change) */
    | { type: 'setMode'; mode: AgentMode }
    /** Replay all AI steps accumulated while the panel was hidden; isGenerating=true means still running */
    | { type: 'replaySteps'; steps: AgentStep[]; isGenerating: boolean }
    /** Plan file saved to disk — tells webview to show the Open/Submit card */
    | { type: 'planFileSaved'; filePath: string; relPath: string; mode?: AgentMode }
    | { type: 'walkthroughFileSaved'; filePath: string; relPath: string }
    | { type: 'blueprintFileSaved'; filePath: string; relPath: string }
    /** Send plan sections to webview for interactive inline annotation */
    | { type: 'renderPlan'; sections: string[]; planText?: string; mode?: AgentMode }
    | { type: 'renderWalkthrough'; sections: string[] }
    | { type: 'renderBlueprint'; sections: string[]; planText?: string }
    /** Return workspace file list for @ mention popup */
    | { type: 'fileList'; files: string[] }
    /** Token usage stats after generation completes */
    | { type: 'tokenUsage'; usage: TokenUsage; model: string }
    /** Emit a unified diff summary of all files changed in the message */
    | { type: 'diffSummary'; files: DiffSummaryFile[]; summaryId?: string }
    /** Topic search results */
    | { type: 'topicSearchResults'; results: Array<{ id: string; title: string; updatedAt: number; createdAt?: number; archived?: boolean; pinned?: boolean; workspaceId?: string; workspaceLabel?: string; messageCount?: number; matchContext?: string; score?: number; parentTopicId?: string; forkedFromMessageIndex?: number }>; query?: string; totalCount?: number; stats?: { total: number; visible: number; archived: number; currentTopicId?: string | null; currentTopicTitle?: string | null } }
    /** Topic imported successfully */
    | { type: 'topicImported'; topicId: string; title: string }
    | { type: 'skillsList'; skills: string[] }
    | { type: 'skillInstallComplete'; success: boolean }
    | { type: 'usageStats'; stats: any }
    | { type: 'artifactList'; artifacts: AgentArtifact[] }
    /** Multi-Agent coordinator progress push — Agent Lane UI */
    | { type: 'orchestratorProgress'; progress: OrchestratorProgressPayload }
    | { type: 'mentionSearchResults'; results: Array<{
        type?: ContextItemType;
        uri?: string;
        label: string;
        desc: string;
        startLine?: number;
        endLine?: number;
        line?: number;
        column?: number;
        name?: string;
        kind?: string;
        vanillaType?: string;
        vanillaId?: string;
        key?: string;
        tokenEstimate?: number;
        cacheStatus?: BaseContextItem['cacheStatus'];
    }> }
    | {
        type: 'managerSnapshot';
        topics: Array<{ id: string; title: string; updatedAt: number; createdAt?: number; archived?: boolean; pinned?: boolean; workspaceId?: string; workspaceLabel?: string; messageCount?: number; parentTopicId?: string; forkedFromMessageIndex?: number }>;
        stats?: { total: number; visible: number; archived: number; currentTopicId?: string | null; currentTopicTitle?: string | null };
        messages: ChatHistoryMessage[];
        mode: AgentMode;
        workflowId?: string | null;
        isGenerating: boolean;
        liveStepCount: number;
        artifacts: AgentArtifact[];
    };

/** Provider metadata sent to the settings WebView */
export interface ProviderMeta {
    id: string;
    name: string;
    models: string[];
    defaultModel: string;
    requiresApiKey: boolean;
    defaultEndpoint: string;
    supportsFIM: boolean;
}

/** Ollama model info for the settings UI */
export interface OllamaModelInfo {
    name: string;
    size: string;
    parameterSize?: string;
}

/** Settings state managed by the WebView settings page */
export interface PanelSettings {
    provider: string;
    model: string;
    apiKey: string;
    endpoint: string;
    maxContextTokens: number;
    agentFileWriteMode: 'confirm' | 'auto';
    forcedThinkingMode: boolean;
    /** Reasoning effort / thinking depth (multi-provider) */
    reasoningEffort: 'low' | 'medium' | 'high' | 'max';
    /** Brave Search API key for web_search tool (optional) */
    braveSearchApiKey?: string;
    exaApiKey?: string;
    inlineCompletion: {
        enabled: boolean;
        provider: string;
        model: string;
        endpoint: string;
        debounceMs: number;
        overlapStripping: boolean;
    };
    mcp?: {
        servers: MCPServerConfig[];
    };
    /** Coordination mode sub-Agent model coverage configuration */
    orchestrator?: {
        /** Role → { provider, model } mapping ('__inherit__' means inheriting the main settings) */
        agentModels?: Record<string, { provider: string; model: string }>;
    };
}

// ─── Shared Utilities ────────────────────────────────────────────────────────

/**
 * Safely coerce ChatMessage.content (string | ContentPart[] | null) to a string.
 * P1-7 Fix: extracted from agentRunner.ts / contextBudget.ts to eliminate duplication.
 */
export function contentToString(content: string | ContentPart[] | null | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    return content.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map(p => p.text)
        .join('');
}

// ─── Orchestrator progress push payload ────────────────────────────────────────────

/** Real-time status of a single Agent lane */
export interface AgentLaneInfo {
    /** Agent instance ID */
    id: string;
    /** Role tag (explorer / builder / reviewer...) */
    role: string;
    /** Corresponding task node ID */
    taskNodeId: string;
    /** Current status */
    status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
    /** Number of steps used */
    stepCount: number;
    /** Number of tokens consumed */
    tokenUsed: number;
    /** Start time */
    startedAt?: number;
    /** Time consuming (ms) */
    duration?: number;
    /** Latest status text */
    statusText?: string;
}

/** Progress data pushed to WebView by Orchestrator */
export interface OrchestratorProgressPayload {
    /** Stage label */
    phase: 'planning' | 'executing' | 'reviewing' | 'complete' | 'failed';
    /** Total number of nodes */
    total: number;
    /** Number of completed nodes */
    done: number;
    /** Number of running nodes */
    running: number;
    /** Number of failed nodes */
    failed: number;
    /** Number of canceled nodes */
    cancelled: number;
    /** Each Agent swim lane information */
    lanes: AgentLaneInfo[];
    /** Latest event description */
    latestEvent?: string;
}
