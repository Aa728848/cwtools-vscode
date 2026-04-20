/**
 * CWTools AI Module — Core Type Definitions
 */

// ─── Agent Modes ─────────────────────────────────────────────────────────────

export type AgentMode = 'build' | 'plan';

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

// ─── Provider & Configuration ────────────────────────────────────────────────

export interface AIProviderConfig {
    id: string;
    name: string;
    endpoint: string;
    defaultModel: string;
    models: string[];
    supportsToolUse: boolean;
    supportsStreaming: boolean;
    maxContextTokens: number;
    /** Whether this provider uses OpenAI-compatible API format natively */
    isOpenAICompatible: boolean;
    /**
     * Expected tool call OUTPUT format from the model.
     * 'openai'    – standard JSON tool_calls field (all major official APIs)
     * 'dsml'      – DeepSeek <｜DSML｜function_calls> (raw/local DeepSeek V3+)
     * 'tool_call' – Qwen/Hermes <tool_call>{JSON}</tool_call> (Ollama local models)
     * Default: 'openai'
     */
    toolCallStyle?: 'openai' | 'dsml' | 'tool_call';
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
    inlineCompletion: {
        enabled: boolean;
        debounceMs: number;
        provider: string;
        model: string;
        endpoint: string;
    };
}

// ─── API Request/Response (OpenAI-compatible format) ─────────────────────────

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
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
        path: string;
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
    | ListDirectoryArgs;

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
    | ListDirectoryResult;

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
    | 'list_directory';

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
    truncated: boolean;
}

// ─── Agent Execution ─────────────────────────────────────────────────────────

export interface AgentStep {
    type: 'thinking' | 'thinking_content' | 'tool_call' | 'tool_result' | 'code_generated' | 'validation' | 'error' | 'compaction' | 'todo_update';
    content: string;
    toolName?: AgentToolName;
    toolArgs?: Record<string, unknown>;
    toolResult?: unknown;
    timestamp: number;
}

export interface GenerationResult {
    code: string;
    explanation: string;
    validationErrors: ValidationError[];
    isValid: boolean;
    retryCount: number;
    steps: AgentStep[];
}

// ─── Chat History ────────────────────────────────────────────────────────────

export interface ChatTopic {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ChatHistoryMessage[];
}

export interface ChatHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
    code?: string;
    isValid?: boolean;
    timestamp: number;
    steps?: AgentStep[];
}

// ─── WebView Communication ───────────────────────────────────────────────────

export type WebViewMessage =
    | { type: 'sendMessage'; text: string }
    | { type: 'insertCode'; code: string }
    | { type: 'copyCode'; code: string }
    | { type: 'regenerate' }
    | { type: 'newTopic' }
    | { type: 'loadTopic'; topicId: string }
    | { type: 'deleteTopic'; topicId: string }
    | { type: 'configureProvider' }
    | { type: 'cancelGeneration' }
    | { type: 'switchMode'; mode: AgentMode }
    | { type: 'openSettings' }
    | { type: 'saveSettings'; settings: PanelSettings }
    | { type: 'detectOllamaModels'; endpoint: string }
    | { type: 'testConnection'; settings: PanelSettings }
    | { type: 'retractMessage'; messageIndex: number }
    | { type: 'confirmWriteFile'; messageId: string }
    | { type: 'cancelWriteFile'; messageId: string }
    | { type: 'quickChangeModel'; model: string };

export type HostMessage =
    | { type: 'addUserMessage'; text: string; messageIndex: number }
    | { type: 'agentStep'; step: AgentStep }
    | { type: 'generationComplete'; result: GenerationResult }
    | { type: 'generationError'; error: string }
    | { type: 'topicList'; topics: Array<{ id: string; title: string; updatedAt: number }> }
    | { type: 'loadTopicMessages'; messages: ChatHistoryMessage[] }
    | { type: 'streamToken'; token: string }
    | { type: 'clearChat' }
    | { type: 'modeChanged'; mode: AgentMode }
    | { type: 'todoUpdate'; todos: TodoItem[] }
    | { type: 'settingsData'; providers: ProviderMeta[]; current: PanelSettings; ollamaModels?: OllamaModelInfo[]; showPanel?: boolean }
    | { type: 'ollamaModels'; models: OllamaModelInfo[]; error?: string }
    | { type: 'testConnectionResult'; ok: boolean; message: string }
    | { type: 'messageRetracted'; messageIndex: number }
    | { type: 'pendingWriteFile'; file: string; messageId: string; isNewFile: boolean }
    | { type: 'topicTitleGenerated'; topicId: string; title: string };

/** Provider metadata sent to the settings WebView */
export interface ProviderMeta {
    id: string;
    name: string;
    models: string[];
    defaultModel: string;
    requiresApiKey: boolean;
    defaultEndpoint: string;
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
    inlineCompletion: {
        enabled: boolean;
        provider: string;
        model: string;
        endpoint: string;
        debounceMs: number;
    };
}
