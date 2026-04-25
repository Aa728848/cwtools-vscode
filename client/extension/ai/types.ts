/**
 * CWTools AI Module — Core Type Definitions
 */

// ─── Agent Modes ─────────────────────────────────────────────────────────────

/**
 * Agent modes — aligned with OpenCode's agent configuration.
 * - build:   Full tool access including file writes + validation loop (default)
 * - plan:    Read-only analysis, no writes, structured plan output
 * - explore: Parallel read-only exploration; focuses on understanding codebase, no validation
 * - general: Full tool access like build, but no todo_write; suited for research tasks
 * - review:  Read-only mode focused on code review, finding issues, and providing feedback.
 */
export type AgentMode = 'build' | 'plan' | 'explore' | 'general' | 'review';

export interface AgentModeConfig {
    mode: AgentMode;
    label: string;
    description: string;
    /** Tools allowed in this mode (null = all) */
    allowedTools: AgentToolName[] | null;
    /** Whether this mode can modify files */
    canModifyFiles: boolean;
    /** Whether validation loop runs */
    runValidation: boolean;
}

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
    /** User override for context window size (0 = use provider default) */
    maxContextTokens: number;
    /** Agent file write mode */
    agentFileWriteMode: 'confirm' | 'auto';
    /** Reasoning effort / thinking depth (used by DeepSeek, OpenAI, Qwen, Gemini etc.) */
    reasoningEffort: 'low' | 'medium' | 'high' | 'max';
    inlineCompletion: {
        enabled: boolean;
        debounceMs: number;
        provider: string;
        model: string;
        endpoint: string;
        overlapStripping: boolean;
        fimMode: boolean;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export interface ValidateCodeArgs {
    code: string;
    targetFile: string;
    insertPosition?: {
        line: number;
        column: number;
    };
}

export interface ValidationError {
    code: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    line: number;
    column: number;
}

export interface ValidateCodeResult {
    isValid: boolean;
    errors: ValidationError[];
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

// Union type for all tool args/results
export type ToolArgs =
    | QueryScopeArgs
    | QueryTypesArgs
    | QueryRulesArgs
    | QueryReferencesArgs
    | ValidateCodeArgs
    | GetFileContextArgs
    | SearchModFilesArgs
    | GetCompletionAtArgs
    | DocumentSymbolsArgs
    | WorkspaceSymbolsArgs
    | TodoWriteArgs
    | ReadFileArgs
    | WriteFileArgs
    | EditFileArgs
    | ListDirectoryArgs
    | TaskArgs;

export type ToolResult =
    | QueryScopeResult
    | QueryTypesResult
    | QueryRulesResult
    | QueryReferencesResult
    | ValidateCodeResult
    | GetFileContextResult
    | SearchModFilesResult
    | GetCompletionAtResult
    | DocumentSymbolsResult
    | WorkspaceSymbolsResult
    | TodoWriteResult
    | ReadFileResult
    | WriteFileResult
    | EditFileResult
    | ListDirectoryResult
    | TaskResult;

export type AgentToolName =
    | 'query_scope'
    | 'query_types'
    | 'query_rules'
    | 'query_references'
    | 'validate_code'
    | 'get_diagnostics'
    | 'get_file_context'
    | 'search_mod_files'
    | 'get_completion_at'
    | 'document_symbols'
    | 'workspace_symbols'
    | 'todo_write'
    | 'read_file'
    | 'write_file'
    | 'edit_file'
    | 'list_directory'
    | 'glob_files'
    | 'lsp_operation'
    | 'web_fetch'
    | 'search_web'
    | 'run_command'
    | 'apply_patch'
    | 'multiedit'
    | 'task'
    // ── CWTools Deep API tools ──
    | 'query_definition'
    | 'query_definition_by_name'
    | 'query_scripted_effects'
    | 'query_scripted_triggers'
    | 'query_enums'
    | 'get_entity_info'
    | 'query_static_modifiers'
    | 'query_variables'
    // ── MCP tools ──
    | 'mcp_call';

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
}

export interface WriteFileResult {
    success: boolean;
    message: string;
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
}

export interface EditFileResult {
    success: boolean;
    message: string;
    /** Unified diff of the change */
    diff?: string;
    /** LSP diagnostics detected after the edit */
    diagnostics?: ValidationError[];
    /** If agentFileWriteMode === 'confirm', write was queued, not yet applied */
    pendingDiff?: string;
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

export interface TaskArgs {
    tasks?: Array<{
        description: string;
        prompt: string;
        subagent_type?: 'explore' | 'general';
    }>;
    // Legacy single task support
    description?: string;
    prompt?: string;
    subagent_type?: 'explore' | 'general';
}

export interface TaskResult {
    results: Array<{
        description: string;
        result: string;
    }>;
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
}

// ─── Token Usage & Cost ──────────────────────────────────────────────────────

export interface TokenUsage {
    /** Total tokens used across all API calls in this generation */
    total: number;
    /** Input/prompt tokens */
    input: number;
    /** Output/completion tokens */
    output: number;
    /** Estimated cost in USD (based on provider pricing table) */
    estimatedCostUsd: number;
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
    | 'subtask_start' | 'subtask_complete' | 'diff_summary';
    content: string;
    toolName?: AgentToolName | string;
    toolArgs?: Record<string, unknown>;
    toolResult?: unknown;
    timestamp: number;
    /** For permission_request: identifier so UI can respond */
    permissionId?: string;
    /** For subtask steps: the sub-agent type */
    subagentType?: string;
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
}

export interface ChatHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
    code?: string;
    isValid?: boolean;
    timestamp: number;
    steps?: AgentStep[];
    /** Base64 data-URL images attached to this user message (persisted with topic) */
    images?: string[];
}

// ─── WebView Communication ───────────────────────────────────────────────────

export type WebViewMessage =
    | { type: 'sendMessage'; text: string; attachedFiles?: string[]; images?: string[] }
    | { type: 'insertCode'; code: string }
    | { type: 'copyCode'; code: string }
    | { type: 'regenerate' }
    | { type: 'newTopic' }
    | { type: 'loadTopic'; topicId: string }
    | { type: 'deleteTopic'; topicId: string }
    | { type: 'forkTopic'; topicId: string; messageIndex: number }
    | { type: 'archiveTopic'; topicId: string }
    | { type: 'configureProvider' }
    | { type: 'cancelGeneration' }
    | { type: 'switchMode'; mode: AgentMode }
    | { type: 'openSettings' }
    | { type: 'saveSettings'; settings: PanelSettings }
    | { type: 'detectOllamaModels'; endpoint: string }
    | { type: 'fetchApiModels'; providerId: string; endpoint: string; apiKey: string }
    | { type: 'testConnection'; settings: PanelSettings } | { type: 'deleteDynamicModel'; providerId: string; modelId: string }
    | { type: 'retractMessage'; messageIndex: number }
    | { type: 'confirmWriteFile'; messageId: string }
    | { type: 'cancelWriteFile'; messageId: string }
    | { type: 'quickChangeModel'; model: string }
    | { type: 'slashCommand'; command: string }
    | { type: 'permissionResponse'; permissionId: string; allowed: boolean; always: boolean }
    /** Submit inline annotations collected in the webview back to AI for revision */
    | { type: 'submitPlanAnnotations'; annotations: Array<{ section: string; note: string }> }
    | { type: 'revisePlanWithAnnotations'; annotations: Array<{ section: string; note: string }> }
    | { type: 'reviseWalkthroughWithAnnotations'; annotations: Array<{ section: string; note: string }> }
    /** Open the plan .md file in the VS Code editor */
    | { type: 'openPlanFile'; filePath: string }
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
    | { type: 'clearUsageStats' };

export type HostMessage =
    | { type: 'addUserMessage'; text: string; messageIndex: number; images?: string[] }
    | { type: 'agentStep'; step: AgentStep }
    | { type: 'generationComplete'; result: GenerationResult }
    | { type: 'generationError'; error: string }
    | { type: 'topicList'; topics: Array<{ id: string; title: string; updatedAt: number; archived?: boolean }> }
    | { type: 'loadTopicMessages'; messages: ChatHistoryMessage[] }
    | { type: 'streamToken'; token: string }
    | { type: 'clearChat' }
    | { type: 'modeChanged'; mode: AgentMode; label?: string }
    | { type: 'todoUpdate'; todos: TodoItem[] }
    | { type: 'settingsData'; providers: ProviderMeta[]; current: PanelSettings; ollamaModels?: OllamaModelInfo[]; showPanel?: boolean; modelContextTokens?: Record<string, number>; thinkingModelPrefixes?: string[] }
    | { type: 'ollamaModels'; models: OllamaModelInfo[]; error?: string }
    | { type: 'apiModelsFetched'; providerId: string; models: Array<{ id: string }>; dynContexts?: Record<string, number>; error?: string; ctxNote?: string }
    | { type: 'testConnectionResult'; ok: boolean; message: string }
    | { type: 'messageRetracted'; messageIndex: number }
    | { type: 'pendingWriteFile'; file: string; messageId: string; isNewFile: boolean }
    | { type: 'autoWriteFile'; file: string; isNewFile: boolean }
    | { type: 'topicTitleGenerated'; topicId: string; title: string }
    | { type: 'topicForked'; newTopicId: string; title: string }
    | { type: 'permissionRequest'; permissionId: string; tool: string; description: string; command?: string }
    /** Restore mode state after webview rebuild (panel visibility change) */
    | { type: 'setMode'; mode: AgentMode }
    /** Replay all AI steps accumulated while the panel was hidden; isGenerating=true means still running */
    | { type: 'replaySteps'; steps: AgentStep[]; isGenerating: boolean }
    /** Plan file saved to disk — tells webview to show the Open/Submit card */
    | { type: 'planFileSaved'; filePath: string; relPath: string }
    | { type: 'walkthroughFileSaved'; filePath: string; relPath: string }
    /** Send plan sections to webview for interactive inline annotation */
    | { type: 'renderPlan'; sections: string[]; planText?: string }
    | { type: 'renderWalkthrough'; sections: string[] }
    /** Return workspace file list for @ mention popup */
    | { type: 'fileList'; files: string[] }
    /** Token usage stats after generation completes */
    | { type: 'tokenUsage'; usage: TokenUsage; model: string }
    /** Emit a unified diff summary of all files changed in the message */
    | { type: 'diffSummary'; files: Array<{ file: string; status: 'created' | 'modified' | 'deleted'; diffPreview: string }> }
    /** Topic search results */
    | { type: 'topicSearchResults'; results: Array<{ id: string; title: string; updatedAt: number }> }
    /** Topic imported successfully */
    | { type: 'topicImported'; topicId: string; title: string }
    | { type: 'usageStats'; stats: any };

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
    /** Reasoning effort / thinking depth (multi-provider) */
    reasoningEffort: 'low' | 'medium' | 'high' | 'max';
    /** Brave Search API key for web_search tool (optional) */
    braveSearchApiKey?: string;
    inlineCompletion: {
        enabled: boolean;
        provider: string;
        model: string;
        endpoint: string;
        debounceMs: number;
        overlapStripping: boolean;
        fimMode: boolean;
    };
    mcp?: {
        servers: MCPServerConfig[];
    };
}
