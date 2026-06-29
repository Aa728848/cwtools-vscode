/**
 * CWTools AI Module — Unified AI Service
 *
 * Handles API calls to all supported providers through a unified interface.
 * Supports both streaming and non-streaming modes.
 * Uses SecretStorage for API key management.
 */

import * as vs from 'vscode';
import * as crypto from 'crypto';
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    ToolDefinition,
    AIUserConfig,
    CustomApiFormat,
    ContentPart,
} from './types';
import {
    getProvider,
    getEffectiveEndpoint,
    getEffectiveModel,
    toClaudeRequest,
    fetchOllamaModels,
    BUILTIN_PROVIDERS,
    getModelOutputTokens,
    getDisableThinkingParams,
    getEnableThinkingParams,
    getEffectiveTemperature,
    getOpenCodeApiFormat,
} from './providers';
import { ErrorReporter } from './errorReporter';
import { SOURCE, aiText } from './messages';

// ─── Module-level constants ──────────────────────────────────────────────────

/** Providers that reject the `detail` sub-field inside `image_url` objects. */
const STRIP_IMAGE_DETAIL_PROVIDERS = new Set(['minimax', 'glm', 'qwen']);
const DEFAULT_CHAT_COMPLETION_TIMEOUT_MS = 20 * 60 * 1000;
const MIN_CHAT_COMPLETION_TIMEOUT_MS = 60 * 1000;
const MAX_CHAT_COMPLETION_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_CUSTOM_API_FORMAT: CustomApiFormat = 'openai-chat-completions';

export function normalizeChatCompletionTimeoutMs(value: unknown): number {
    const raw = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CHAT_COMPLETION_TIMEOUT_MS;
    return Math.min(MAX_CHAT_COMPLETION_TIMEOUT_MS, Math.max(MIN_CHAT_COMPLETION_TIMEOUT_MS, Math.floor(raw)));
}

function formatDuration(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function errorFromReason(reason: unknown, fallback: string): Error {
    if (reason instanceof Error) return reason;
    return new Error(reason === undefined || reason === null ? fallback : String(reason));
}

export function normalizeCustomApiFormat(value: unknown): CustomApiFormat {
    switch (value) {
        case 'openai-chat-completions':
        case 'openai-responses':
        case 'anthropic-messages':
        case 'gemini-generate-content':
            return value;
        default:
            return DEFAULT_CUSTOM_API_FORMAT;
    }
}

function normalizeAnthropicMessagesEndpoint(endpoint: string): string {
    const cleanEndpoint = endpoint
        .replace(/\/messages\/?(?:\?.*)?$/i, '')
        .replace(/\/+$/, '');
    return /\/v\d+(?:beta|alpha)?$/i.test(cleanEndpoint)
        ? cleanEndpoint
        : `${cleanEndpoint}/v1`;
}

// ─── API Key Management ──────────────────────────────────────────────────────

const KEY_PREFIX = 'cwtools.ai.apiKey.';

export class ApiKeyManager {
    constructor(private secretStorage: vs.SecretStorage) {}

    async getKey(providerId: string): Promise<string | undefined> {
        return this.secretStorage.get(KEY_PREFIX + providerId);
    }

    async setKey(providerId: string, key: string): Promise<void> {
        await this.secretStorage.store(KEY_PREFIX + providerId, key);
    }

    async deleteKey(providerId: string): Promise<void> {
        await this.secretStorage.delete(KEY_PREFIX + providerId);
    }

    /**
     * Prompt the user to enter their API key for a specific provider.
     */
    async promptForKey(providerId: string): Promise<string | undefined> {
        const provider = getProvider(providerId);
        const key = await vs.window.showInputBox({
            title: `Configure ${provider.name} API Key`,
            prompt: `Enter your API key for ${provider.name}`,
            password: true,
            placeHolder: 'sk-...',
            ignoreFocusOut: true,
        });
        if (key && key.trim().length > 0) {
            await this.setKey(providerId, key.trim());
            vs.window.showInformationMessage(`${provider.name} API key saved securely.`);
            return key.trim();
        }
        return undefined;
    }

    /**
     * Ensure we have a key, prompting if necessary.
     */
    async ensureKey(providerId: string): Promise<string | undefined> {
        let key = await this.getKey(providerId);
        if (!key) {
            key = await this.promptForKey(providerId);
        }
        return key;
    }
}

// ─── AI Service ──────────────────────────────────────────────────────────────

export class AIService {
    private keyManager: ApiKeyManager;
    /**
     * C1 Fix: Use a Set instead of a single instance so that concurrent
     * chatCompletion calls (e.g. compaction + main loop running in parallel)
     * each manage their own controller without overwriting each other.
     */
    private activeControllers = new Set<AbortController>();
    /** In-memory model override — avoids writing to workspace config (which triggers LS restart) */
    private modelOverride: string | null = null;


    constructor(private context: vs.ExtensionContext) {
        this.keyManager = new ApiKeyManager(context.secrets);
    }

    getKeyManager(): ApiKeyManager {
        return this.keyManager;
    }

    /** Set model without persisting to workspace config (no LS restart side-effect) */
    setModelOverride(model: string): void {
        this.modelOverride = model || null;
    }

    getModelOverride(): string | null {
        return this.modelOverride;
    }

    private resolveCustomApiFormat(providerId: string, format?: unknown): CustomApiFormat {
        return providerId === 'custom' ? normalizeCustomApiFormat(format) : DEFAULT_CUSTOM_API_FORMAT;
    }

    /**
     * Read the current user configuration for AI.
     */
    getConfig(): AIUserConfig {
        const cfg = vs.workspace.getConfiguration('cwtools.ai');
        const provider = cfg.get<string>('provider', 'openai');
        const providerEndpoints = cfg.get<Record<string, string>>('providerEndpoints', {}) || {};
        // Per-provider endpoint wins; legacy global endpoint only ever applies to the
        const endpoint = (providerEndpoints[provider] || cfg.get<string>('endpoint', '') || '').trim();
        return {
            enabled: cfg.get<boolean>('enabled', false),
            provider,
            // In-memory override wins over persisted setting (avoids LS restart on quick-switch)
            model: this.modelOverride ?? cfg.get<string>('model', ''),
            endpoint,
            providerEndpoints,
            apiKey: '',
            customApiFormat: normalizeCustomApiFormat(cfg.get<string>('customApiFormat', DEFAULT_CUSTOM_API_FORMAT)),
            maxRetries: Math.max(1, cfg.get<number>('maxRetries') || 3),
            requestTimeoutMs: normalizeChatCompletionTimeoutMs(cfg.get<number>('requestTimeoutMs')),
            maxContextTokens: cfg.get<number>('maxContextTokens', 0),
            agentFileWriteMode: cfg.get<'confirm' | 'auto'>('agentFileWriteMode', 'confirm'),
            reasoningEffort: cfg.get<'low' | 'medium' | 'high' | 'max'>('reasoningEffort', 'high'),
            inlineCompletion: {
                enabled: cfg.get<boolean>('inlineCompletion.enabled') || false,
                debounceMs: cfg.get<number>('inlineCompletion.debounceMs', 200),
                maxTokens: cfg.get<number>('inlineCompletion.maxTokens', 128),
                contextBeforeLines: cfg.get<number>('inlineCompletion.contextBeforeLines', 20),
                contextAfterLines: cfg.get<number>('inlineCompletion.contextAfterLines', 10),
                includeMcpContext: cfg.get<boolean>('inlineCompletion.includeMcpContext', false),
                mcpCacheTtlMs: cfg.get<number>('inlineCompletion.mcpCacheTtlMs', 30_000),
                requestTimeoutMs: cfg.get<number>('inlineCompletion.requestTimeoutMs', 1_500),
                lspFastPath: cfg.get<boolean>('inlineCompletion.lspFastPath', true),
                provider: cfg.get<string>('inlineCompletion.provider', ''),
                model: cfg.get<string>('inlineCompletion.model', ''),
                endpoint: cfg.get<string>('inlineCompletion.endpoint', ''),
                overlapStripping: cfg.get<boolean>('inlineCompletion.overlapStripping', true),
            },
            mcp: {
                servers: cfg.get<import('./types').MCPServerConfig[]>('mcp.servers', []),
            },
        };
    }

    /**
     * Resolve the user-configured endpoint override for an arbitrary provider id
     * (no provider default applied — pass the result to getEffectiveEndpoint for that).
     * The legacy global `endpoint` is only honoured for the currently-active provider,
     * so it never leaks into other providers.
     */
    getEndpointForProvider(providerId: string): string {
        const cfg = vs.workspace.getConfiguration('cwtools.ai');
        const map = cfg.get<Record<string, string>>('providerEndpoints', {}) || {};
        const perProvider = (map[providerId] || '').trim();
        if (perProvider) return perProvider;
        const activeProvider = cfg.get<string>('provider', '');
        if (providerId === activeProvider) return (cfg.get<string>('endpoint', '') || '').trim();
        return '';
    }

    /**
     * One-time migration: fold the legacy global `endpoint` into the per-provider
     * map under the active provider, then clear the legacy value. Idempotent —
     * a no-op once the legacy value is empty.
     */
    async migrateLegacyEndpoint(): Promise<void> {
        const cfg = vs.workspace.getConfiguration('cwtools.ai');
        const legacy = (cfg.get<string>('endpoint', '') || '').trim();
        if (!legacy) return;
        const provider = cfg.get<string>('provider', '');
        if (provider) {
            const map = { ...(cfg.get<Record<string, string>>('providerEndpoints', {}) || {}) };
            if (!map[provider]) {
                map[provider] = legacy;
                await cfg.update('providerEndpoints', map, vs.ConfigurationTarget.Global);
            }
        }
        await cfg.update('endpoint', undefined, vs.ConfigurationTarget.Global);
    }

    /**
     * Get API key for a provider: SecretStorage first, then migrate from settings.json.
     */
    async getKeyForProvider(providerId: string): Promise<string> {
        // 1. Try SecretStorage
        const key = await this.keyManager.getKey(providerId);
        if (key) return key;

        // 2. Migration path: read plaintext from settings.json and move to SecretStorage
        const cfg = vs.workspace.getConfiguration('cwtools.ai');
        const legacyKey = cfg.get<string>('apiKey', '');
        if (legacyKey && legacyKey.trim().length > 0) {
            const currentProvider = cfg.get<string>('provider', '');
            // Only migrate if the saved provider matches the one being requested
            if (currentProvider === providerId) {
                await this.keyManager.setKey(providerId, legacyKey.trim());
                // Clear plaintext from settings.json
                await cfg.update('apiKey', '', vs.ConfigurationTarget.Global);
                vs.window.showInformationMessage(
                    aiText(
                        `CWTools AI: API key was migrated securely to SecretStorage (${providerId})`,
                        `CWTools AI: API Key 已安全迁移到 SecretStorage (${providerId})`,
                    )
                );
                return legacyKey.trim();
            }
        }

        return '';
    }

    /**
     * Cancel all in-progress generations.
     * C1 Fix: abort every active controller in the Set.
     */
    cancel(): void {
        for (const ctrl of this.activeControllers) {
            ctrl.abort();
        }
        this.activeControllers.clear();
    }

    /**
     * Send a chat completion request to the configured AI provider.
     * Returns the full response (non-streaming).
     */
    async chatCompletion(
        messages: ChatMessage[],
        options?: {
            tools?: ToolDefinition[];
            temperature?: number;
            maxTokens?: number;
            providerId?: string;   // Override provider
            model?: string;        // Override model
            apiKey?: string;       // Override API key (for test-without-save)
            endpoint?: string;     // Override endpoint
            customApiFormat?: CustomApiFormat; // Override custom provider wire protocol
            /** Real-time callback for incremental reasoning/thinking tokens */
            onThinking?: (text: string) => void;
            /** Real-time callback for incremental text content tokens (streaming typewriter effect) */
            onTextDelta?: (text: string) => void;
            /** Real-time callback for incremental tool call fragments */
            onToolCallDelta?: (toolName: string, argsBuf: string) => void;
            /** External AbortSignal for caller-controlled cancellation */
            abortSignal?: AbortSignal;
            /** Absolute wall-clock timeout for a single chat completion call. */
            requestTimeoutMs?: number;
            /**
             * Disable thinking/reasoning for this call (used by inline completion).
             * Per-provider implementation:
             *   - Qwen3+: enable_thinking=false + /no_think prompt injection
             *   - GLM thinking models: thinking={type:'disabled'}
             *   - Gemini 2.5 Flash: thinking_budget=0 (fully disables)
             *   - Gemini 3.x: thinking_level='minimal' (cannot fully disable)
             *   - Claude: no action needed (thinking not sent by default)
             *   - MiniMax: no API toggle (rely on <think> stripping)
             *   - OpenAI GPT/DeepSeek-chat: non-reasoning, no-op
             * Models that ALWAYS think (o1/o3/deepseek-reasoner/glm-z1/gemini-pro)
             * should be blocked before calling this method.
             */
            disableThinking?: boolean;
        }
    ): Promise<ChatCompletionResponse> {
        const config = this.getConfig();
        const providerId = options?.providerId ?? config.provider;
        const provider = getProvider(providerId);
        const customApiFormat = this.resolveCustomApiFormat(providerId, options?.customApiFormat ?? config.customApiFormat);

        // Some providers (for example Ollama) do not require an API key.
        let apiKey = '';
        if (provider.requiresApiKey) {
            // Priority: options override (for test) > SecretStorage (with migration fallback)
            if (options?.apiKey) {
                apiKey = options.apiKey;
            } else {
                const key = await this.getKeyForProvider(providerId);
                if (!key) {
                    // Prompt to enter key
                    const entered = await this.keyManager.promptForKey(providerId);
                    if (!entered) {
                        throw new Error(`No API key configured for ${provider.name}. Please configure it in the AI Settings panel.`);
                    }
                    apiKey = entered;
                } else {
                    apiKey = key;
                }
            }
        }

        const endpoint = options?.endpoint || getEffectiveEndpoint(providerId, config.endpoint);
        if (!endpoint) {
            throw new Error(`${provider.name} endpoint is not configured. Please set an API endpoint in the AI Settings panel.`);
        }
        const rawModel = options?.model ?? getEffectiveModel(providerId, config.model);
        // Strip the UI '(免费)' suffix from the model ID before sending to the API
        const model = rawModel.replace(/\s*\(免费\)$/i, '');
        const lowerModel = model.toLowerCase();
        const effectiveApiFormat = providerId === 'opencode'
            ? getOpenCodeApiFormat(model)
            : customApiFormat;

        // ── Disable thinking: per-provider API parameters ──
        // Each provider has a different mechanism to disable thinking/reasoning.
        // This is critical for inline completion where latency must be minimal.
        let finalMessages = messages;
         
        let extraBody: Record<string, any> | undefined;

        if (options?.disableThinking) {
            // Data-driven lookup: each provider's disable-thinking params are defined
            // in providers.ts DISABLE_THINKING_PARAMS table instead of inline if-else.
            const thinkingParams = getDisableThinkingParams(model);
            if (thinkingParams) {
                if (thinkingParams.extraBody) {
                    extraBody = thinkingParams.extraBody as Record<string, any>;
                }
                if (thinkingParams.injectPrompt) {
                    // Qwen-style: append /no_think to system prompt as fallback
                    finalMessages = messages.map(m => {
                        if (m.role === 'system' && typeof m.content === 'string') {
                            return { ...m, content: m.content + '\n/no_think' };
                        }
                        return m;
                    });
                }
            }
        } else {
            const thinkingParams = getEnableThinkingParams(model, providerId);
            if (thinkingParams?.extraBody) {
                extraBody = { ...(extraBody ?? {}), ...thinkingParams.extraBody } as Record<string, any>;
            }
        }

        const request: ChatCompletionRequest & Record<string, any> = {
            model,
            messages: finalMessages,
            tools: options?.tools,
            tool_choice: options?.tools && options.tools.length > 0 ? 'auto' : undefined,
            temperature: getEffectiveTemperature(model, options?.temperature),
            // M5 Fix: dynamically set maxTokens based on model/provider.
            // Reasoning models (like DeepSeek-R1) generate >20K thinking tokens 
            // and will self-truncate if capped at 8192.
            max_tokens: options?.maxTokens ?? getModelOutputTokens(model, providerId),
            stream: false,
            ...(extraBody ?? {}),
        };

        // Inject reasoning effort / thinking preferences based on provider
        if (!options?.disableThinking) {
            const rEffort = config.reasoningEffort || 'high';
            if (config.provider === 'deepseek' || config.provider === 'openai' || effectiveApiFormat === 'openai-responses') {
                request.reasoning_effort = rEffort;
            } else if (config.provider === 'claude' || effectiveApiFormat === 'anthropic-messages') {
                // Consumed by toClaudeRequest: mapped to output_config.effort and
                // adaptive thinking on models that support them (Fable 5, Opus/Sonnet 4.6+).
                request.reasoning_effort = rEffort;
            } else if (config.provider === 'qwen' && (lowerModel.includes('qwen3') || lowerModel.includes('qwen-max'))) {
                request.enable_thinking = true;
            } else if (config.provider === 'gemini' && lowerModel.startsWith('gemini-3')) {
                // Map max to high for Gemini
                const mappedLevel = rEffort === 'max' ? 'high' : rEffort;
                request.thinking_config = { thinking_level: mappedLevel };
            }
        }

        // C1 Fix: create a per-call controller; register it so cancel() can abort it.
        const controller = new AbortController();
        let timedOutError: Error | undefined;
        // Also link any external abort signal so the caller can cancel this specific call.
        const externalSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const linkAbort = () => controller.abort(externalSignal?.reason);
        if (externalSignal?.aborted) {
            controller.abort(externalSignal.reason);
        } else {
            externalSignal?.addEventListener('abort', linkAbort);
        }
        this.activeControllers.add(controller);
        const requestTimeoutMs = normalizeChatCompletionTimeoutMs(options?.requestTimeoutMs ?? config.requestTimeoutMs);
        const timeoutId = setTimeout(() => {
            timedOutError = new Error(
                `${provider.name} API request timed out after ${formatDuration(requestTimeoutMs)}. The upstream provider did not complete the chat completion in time.`
            );
            timedOutError.name = 'TimeoutError';
            controller.abort(timedOutError);
        }, requestTimeoutMs);

        try {
            // MiniMax Token Plan uses Anthropic Messages API format
            const isAnthropicCompat = providerId === 'claude' || providerId === 'minimax-token-plan' || effectiveApiFormat === 'anthropic-messages';
            if (effectiveApiFormat === 'openai-responses') {
                return await this.callOpenAIResponses(endpoint, apiKey, request, providerId, controller, options?.onTextDelta);
            }
            if (effectiveApiFormat === 'gemini-generate-content') {
                return await this.callGeminiGenerateContent(endpoint, apiKey, request, providerId, controller, options?.onTextDelta, options?.onToolCallDelta);
            }
            // Use streaming for OpenAI-compat providers when they support it.
            if (provider.supportsStreaming && provider.isOpenAICompatible && !isAnthropicCompat) {
                return await this.callOpenAICompatibleStreaming(endpoint, apiKey, { ...request, stream: true }, providerId, options?.onThinking, controller, options?.onTextDelta, options?.onToolCallDelta);
            } else if (isAnthropicCompat) {
                // L4 Fix: fully migrate callClaude to SSE — enables real-time thinking tokens
                // and eliminates the previous blocking response.json() approach.
                return await this.callClaude(endpoint, apiKey, request, controller, options?.onThinking, options?.onTextDelta, options?.onToolCallDelta, providerId);
            } else {
                return await this.callOpenAICompatible(endpoint, apiKey, request, providerId, controller);
            }
        } catch (err) {
            if (timedOutError) throw timedOutError;
            throw err;
        } finally {
            clearTimeout(timeoutId);
            this.activeControllers.delete(controller);
            externalSignal?.removeEventListener('abort', linkAbort);
        }
    }

    /**
     * Call the completions API for Fill-In-The-Middle (FIM) support.
     * Uses /completions endpoint for compatible APIs and /api/generate for Ollama.
     */
    async fimCompletion(
        prefix: string,
        suffix: string,
        options?: {
            providerId?: string;
            model?: string;
            apiKey?: string;
            endpoint?: string;
            temperature?: number;
            maxTokens?: number;
            abortSignal?: AbortSignal;
        }
    ): Promise<string> {
        const config = this.getConfig();
        const providerId = options?.providerId || config.inlineCompletion.provider || config.provider;
        const provider = getProvider(providerId);

        let apiKey = '';
        if (provider.requiresApiKey) {
            if (options?.apiKey) {
                apiKey = options.apiKey;
            } else {
                const key = await this.getKeyForProvider(providerId);
                if (!key) throw new Error(`No API key configured for ${provider.name}.`);
                apiKey = key;
            }
        }

        const endpoint = options?.endpoint || getEffectiveEndpoint(providerId, config.inlineCompletion.endpoint || this.getEndpointForProvider(providerId));
        if (!endpoint) {
            throw new Error(`${provider.name} endpoint is not configured. Please set an API endpoint in the AI Settings panel.`);
        }
        const rawModel = options?.model ?? getEffectiveModel(providerId, config.inlineCompletion.model || config.model);
        const model = rawModel.replace(/\s*\(免费\)$/i, '');

        const controller = new AbortController();
        const externalSignal = options?.abortSignal;
        const linkAbort = () => controller.abort(externalSignal?.reason);
        if (externalSignal?.aborted) {
            controller.abort(externalSignal.reason);
        } else {
            externalSignal?.addEventListener('abort', linkAbort);
        }
        this.activeControllers.add(controller);

        try {
            if (providerId === 'ollama') {
                // Ollama uses /api/generate instead of /v1/completions for its FIM support
                const url = `${endpoint.replace(/\/v1\/?$/, '')}/api/generate`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        prompt: prefix,
                        suffix: suffix,
                        stream: false,
                        options: {
                            temperature: options?.temperature ?? 0.2,
                            num_predict: options?.maxTokens ?? 256
                        }
                    }),
                    signal: controller.signal
                });
                if (!response.ok) {
                    const err = await response.text();
                    ErrorReporter.warn(SOURCE.AI_SERVICE, `FIM: Ollama API error (${response.status}): ${err}`);
                    throw new Error(`Ollama API error (${response.status}): ${err}`);
                }
                const data = await response.json() as { response?: string };
                return data.response ?? '';
            } else {
                // Build the correct FIM URL per provider:
                // - DeepSeek uses /beta/completions (NOT /v1/completions)
                // - SiliconFlow, OpenRouter, Together, DeepInfra use standard /v1/completions
                let url: string;
                if (providerId === 'deepseek') {
                    // DeepSeek FIM is a beta feature at a different base path
                    url = endpoint.replace(/\/v1\/?$/, '/beta') + '/completions';
                } else {
                    // Standard OpenAI-compatible /completions
                    url = endpoint.replace(/\/$/, '') + '/completions';
                }

                ErrorReporter.debug(SOURCE.AI_SERVICE, `FIM: Requesting: ${url} model=${model}`);

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.buildAuthHeaders(providerId, apiKey)
                    },
                    body: JSON.stringify({
                        model,
                        prompt: prefix,
                        suffix: suffix,
                        max_tokens: options?.maxTokens ?? 256,
                        temperature: options?.temperature ?? 0.2,
                        stream: false
                    }),
                    signal: controller.signal
                });
                if (!response.ok) {
                    const err = await response.text();
                    ErrorReporter.warn(SOURCE.AI_SERVICE, `FIM: ${provider.name} API error (${response.status}): ${err}`);
                    throw new Error(`${provider.name} FIM API error (${response.status}): ${err}`);
                }
                const data = await response.json() as {
                    choices?: Array<{ text?: string; message?: { content?: string } }>;
                };
                // Some providers return choices[].text, some return choices[].message.content
                const choice = data.choices?.[0];
                const text = choice?.text ?? choice?.message?.content ?? '';
                return text;
            }
        } finally {
            this.activeControllers.delete(controller);
            externalSignal?.removeEventListener('abort', linkAbort);
        }
    }


    // ─── Auth header builder ──────────────────────────────────────────────────

    /**
     * Build the Authorization headers for a provider.
     *
     * Special handling:
     * - GLM (Zhipu): API key is "{id}.{secret}". Must generate a short-lived JWT
     *   signed with HS256. The JWT replaces the raw key as Bearer token.
     * - MiniMax Token Plan: API key may be "{groupId}.{rawKey}". The groupId is
     *   extracted and sent as the MM-GroupId header; rawKey is used as Bearer token.
     *   If the key doesn't contain ".", it is used as-is (standard Token Plan JWT).
     * - All other providers: standard "Bearer {apiKey}".
     */
    private buildAuthHeaders(providerId: string, apiKey: string): Record<string, string> {
        if (!apiKey.trim()) {
            return {};
        }

        // GLM (Zhipu AI): generate JWT from "{id}.{secret}" key
        if (providerId === 'glm' && apiKey.includes('.')) {
            const dot = apiKey.indexOf('.');
            const id = apiKey.slice(0, dot);
            const secret = apiKey.slice(dot + 1);
            const now = Date.now();
            const header = Buffer.from(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' })).toString('base64url');
            const payload = Buffer.from(JSON.stringify({ api_key: id, exp: now + 3_600_000, timestamp: now })).toString('base64url');
            const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
            return { 'Authorization': `Bearer ${header}.${payload}.${sig}` };
        }

        // MiniMax Token Plan uses Anthropic Messages API (callClaude path) with x-api-key header,
        // so it does NOT go through this method. All other providers use standard Bearer token.
        return { 'Authorization': `Bearer ${apiKey}` };
    }

    /**
     * Strip image_url.detail from ContentPart[] messages.
     *
     * MiniMax (and several other Chinese-market providers) do NOT support the
     * `detail` sub-field inside `image_url` objects — sending it causes error 2013
     * ("invalid parameter"). The fix is to pass only { url } and drop `detail`.
     *
     * OpenAI, Claude, and Google all support `detail` natively, so we only strip
     * for providers that are known NOT to support it.
     */
    private stripImageDetail(messages: import('./types').ChatMessage[]): import('./types').ChatMessage[] {
        return messages.map(msg => {
            if (!Array.isArray(msg.content)) return msg;
            const cleaned = (msg.content as import('./types').ContentPart[]).map(part => {
                if (part.type !== 'image_url') return part;
                // Drop `detail` — destructure it away so JSON.stringify never sees it
                 
                const { detail: _d, ...urlOnly } = part.image_url;
                return { type: 'image_url' as const, image_url: urlOnly };
            });
            return { ...msg, content: cleaned };
        });
    }

    /**
     * Strip parameters that specific providers do not support.
     * Returns a new request object with offending fields removed.
     *
     * Provider-specific quirks handled here:
     *
     * MiniMax (pay-as-you-go, OpenAI-compat endpoint):
     *   - Does NOT accept `tool_choice` — causes error 2013
     *   - Does NOT accept `image_url.detail` — causes error 2013 / "cannot read URL"
     *   - Recommendation: send only { url } inside image_url objects
     *
     * GLM (Zhipu), Qwen (DashScope):
     *   - `detail` field is NOT documented in their API specs; strip as a precaution
     *     to avoid 400 / parameter-error responses on vision requests
     *
     * OpenAI, Gemini, Ollama, custom:
     *   - Fully support both `url` and `detail` — pass through unchanged
     */
    private sanitizeRequest(providerId: string, request: ChatCompletionRequest): ChatCompletionRequest {
        // ── Providers that reject image_url.detail ────────────────────────────

        // ── MiniMax pay-as-you-go: strict message requirements ──────────────
        // Error 2013 causes: multiple system msgs, developer role, tool_choice, parallel_tool_calls
        // Note: minimax-token-plan uses Anthropic adapter (isOpenAICompatible=false) and doesn't need this
        if (providerId === 'minimax') {
             
            const { tool_choice, parallel_tool_calls, ...rest } = request as unknown as Record<string, unknown>;
            void tool_choice; void parallel_tool_calls;
            const sanitized = rest as unknown as ChatCompletionRequest;
            
            // Merge all system/developer messages into a single system message
            const msgs = sanitized.messages;
            const systemParts: string[] = [];
            const nonSystemMsgs: typeof msgs = [];
            for (const m of msgs) {
                if (m.role === 'system' || (m.role as string) === 'developer') {
                    const txt = typeof m.content === 'string' ? m.content : '';
                    if (txt) systemParts.push(txt);
                } else {
                    nonSystemMsgs.push(m);
                }
            }
            const mergedMsgs: typeof msgs = [];
            if (systemParts.length > 0) {
                mergedMsgs.push({ role: 'system', content: systemParts.join('\n\n') });
            }
            mergedMsgs.push(...nonSystemMsgs);
            
            return {
                ...sanitized,
                messages: this.stripImageDetail(mergedMsgs),
            };
        }

        // ── GLM / Qwen: strip image_url.detail only ───────────────────────────
        if (STRIP_IMAGE_DETAIL_PROVIDERS.has(providerId)) {
            return {
                ...request,
                messages: this.stripImageDetail(request.messages),
            };
        }

        return request;
    }

    // ─── Fetch with Exponential Backoff ──────────────────────────────────────

    private async abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throw errorFromReason(signal.reason, 'Aborted');
        await new Promise<void>((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            let abortListener: (() => void) | undefined;
            const cleanup = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                if (signal && abortListener) {
                    signal.removeEventListener('abort', abortListener);
                    abortListener = undefined;
                }
            };
            abortListener = () => {
                cleanup();
                reject(errorFromReason(signal?.reason, 'Aborted'));
            };
            timeoutId = setTimeout(() => {
                cleanup();
                resolve();
            }, ms);
            signal?.addEventListener('abort', abortListener, { once: true });
        });
    }

    /**
     * Executes fetch with exponential backoff for 429 Too Many Requests.
     * Prevents multi-agent swarms from crashing API limits.
     */
    private async fetchWithRetry(url: string, init: RequestInit, providerId: string): Promise<Response> {
        let retries = 0;
        const maxRetries = 3;
        const delays = [2000, 4000, 8000];

        while (true) {
            let fetchTimeoutId: NodeJS.Timeout | undefined;
            let fetchTimeoutError: Error | undefined;
            const originalSignal = init.signal ?? undefined;
            const fetchController = new AbortController();
            
            const linkAbort = () => fetchController.abort(originalSignal?.reason);
            if (originalSignal) {
                if (originalSignal.aborted) throw new Error('Aborted');
                originalSignal.addEventListener('abort', linkAbort);
            }

            // Hard timeout for the connection/headers phase (300s)
            fetchTimeoutId = setTimeout(() => {
                fetchTimeoutError = new Error('Fetch connection timeout');
                fetchTimeoutError.name = 'TimeoutError';
                fetchController.abort(fetchTimeoutError);
            }, 300000);

            try {
                const response = await fetch(url, { ...init, signal: fetchController.signal });
                
                if (fetchTimeoutId) {
                    clearTimeout(fetchTimeoutId);
                    fetchTimeoutId = undefined;
                }

                // Check for 429 (Rate Limit / Too Many Requests)
                if (response.status === 429 && retries < maxRetries) {
                    const jitter = Math.floor(Math.random() * delays[retries]! * 0.25);
                    const delay = delays[retries]! + jitter;
                    ErrorReporter.debug(SOURCE.AI_SERVICE, `429 Rate Limit hit for ${providerId}. Retrying in ${delay}ms...`);
                    try { await response.body?.cancel(); } catch { /* ignore */ }
                    originalSignal?.removeEventListener('abort', linkAbort);
                    await this.abortableDelay(delay, originalSignal);
                    retries++;
                    continue;
                }

                if (response.status >= 500 && response.status < 600 && retries < maxRetries) {
                    const jitter = Math.floor(Math.random() * delays[retries]! * 0.25);
                    const delay = delays[retries]! + jitter;
                    ErrorReporter.warn(SOURCE.AI_SERVICE, `${providerId} API returned ${response.status}. Retrying in ${delay}ms...`);
                    try { await response.body?.cancel(); } catch { /* ignore */ }
                    originalSignal?.removeEventListener('abort', linkAbort);
                    await this.abortableDelay(delay, originalSignal);
                    retries++;
                    continue;
                }
                
                // Do NOT remove the linkAbort listener here. The originalSignal must 
                // continue to be able to abort the fetchController if the caller is reading the stream.
                return response;
            } catch (err: any) {
                if (fetchTimeoutId) clearTimeout(fetchTimeoutId);
                const effectiveError = fetchTimeoutError ?? err;
                
                // If the user explicitly aborted, do not retry
                if (originalSignal?.aborted) {
                    throw errorFromReason(originalSignal.reason, 'Aborted');
                }

                // Retry on timeout or network errors
                if ((effectiveError.name === 'TimeoutError' || effectiveError.message?.includes('timeout') || effectiveError.code === 'ECONNRESET' || effectiveError.code === 'ETIMEDOUT') && retries < maxRetries) {
                    const delay = delays[retries]! + 1000;
                    ErrorReporter.warn(SOURCE.AI_SERVICE, `Network error/timeout for ${providerId}: ${effectiveError.message}. Retrying in ${delay}ms...`);
                    originalSignal?.removeEventListener('abort', linkAbort);
                    await this.abortableDelay(delay, originalSignal);
                    retries++;
                    continue;
                }
                throw effectiveError;
            }
        }
    }

    /**
     * Reads from a ReadableStream with an idle timeout.
     * If the reader doesn't yield a chunk within the timeout, it aborts the controller to prevent silent hangs.
     */
    private async readWithTimeout<T>(
        reader: ReadableStreamDefaultReader<T>,
        controller: AbortController,
        timeoutMs: number
    ): Promise<ReadableStreamReadResult<T>> {
        let timeoutId: NodeJS.Timeout | undefined;
        let abortListener: (() => void) | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                const err = new Error(`Stream idle timeout: no data received for ${timeoutMs}ms`);
                err.name = 'TimeoutError';
                controller.abort(err);
                reject(err);
            }, timeoutMs);
        });
        const abortPromise = new Promise<never>((_, reject) => {
            abortListener = () => reject(errorFromReason(controller.signal.reason, 'Stream read aborted'));
            if (controller.signal.aborted) {
                abortListener();
            } else {
                controller.signal.addEventListener('abort', abortListener, { once: true });
            }
        });

        try {
            return await Promise.race([reader.read(), timeoutPromise, abortPromise]);
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            if (abortListener) controller.signal.removeEventListener('abort', abortListener);
        }
    }

    // ─── Private API callers ─────────────────────────────────────────────────

    private async callOpenAICompatible(
        endpoint: string,
        apiKey: string,
        request: ChatCompletionRequest,
        providerId: string,
        controller: AbortController
    ): Promise<ChatCompletionResponse> {
        const url = `${endpoint}/chat/completions`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.buildAuthHeaders(providerId, apiKey),
        };

        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(this.sanitizeRequest(providerId, request)),
            signal: controller.signal,   // C1 Fix: use local per-call controller
        }, providerId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${getProvider(providerId).name} API error (${response.status}): ${errorText}`);
        }

        return await response.json() as ChatCompletionResponse;
    }

    /**
     * Like callOpenAICompatible, but uses stream:true to receive SSE chunks.
     * Assembles tool_calls from delta chunks as they arrive, yielding intermediate
     * thinking tokens via onThinking callback. Returns the full ChatCompletionResponse.
     */
    private async callOpenAICompatibleStreaming(
        endpoint: string,
        apiKey: string,
        request: ChatCompletionRequest,
        providerId: string,
        onThinking: ((text: string) => void) | undefined,
        controller: AbortController,
        onTextDelta?: (text: string) => void,
        onToolCallDelta?: (toolName: string, argsBuf: string) => void
    ): Promise<ChatCompletionResponse> {
        const url = `${endpoint}/chat/completions`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.buildAuthHeaders(providerId, apiKey),
        };

        const requestPayload = this.sanitizeRequest(providerId, { ...request, stream: true });
        
        // Inject stream_options for providers that need it to return usage in streams.
        // OpenAI, DeepSeek, GLM, Qwen require it. We omit it for minimax (strict schema).
        if (providerId !== 'minimax') {
            (requestPayload as any).stream_options = { include_usage: true };
        }

        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestPayload),
            signal: controller.signal,
        }, providerId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${getProvider(providerId).name} API error (${response.status}): ${errorText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');
        const decoder = new TextDecoder();
        let buffer = '';

        // Aggregation state
        let contentBuf = '';
        let reasoningBuf = '';
        let finishReason: string | null = null;
        let usageBuf: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number; cache_creation_tokens?: number } | undefined;
        let modelBuf = '';
        // tool_calls reassembly: index → { id, type, function.name, function.arguments(buf) }
        const toolCallMap: Record<number, { id: string; type: string; function: { name: string; arguments: string } }> = {};

        while (true) {
            const { done, value } = await this.readWithTimeout(reader, controller, 600000); // 600s idle timeout (to prevent large models from being disconnected and suspended)
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (!trimmed.startsWith('data: ')) continue;
                let chunk: Record<string, unknown>;
                try { chunk = JSON.parse(trimmed.slice(6)); } catch { continue; }
                const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
                // Capture model name and usage from any chunk
                if (typeof chunk.model === 'string' && chunk.model) modelBuf = chunk.model;
                if (chunk.usage) { const u = chunk.usage as Record<string, any>; const cached = u.prompt_cache_hit_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_content_token_count ?? 0; const promptTk = u.prompt_tokens ?? u.input_tokens ?? 0; const cacheCreation = u.cache_creation_input_tokens ?? u.prompt_cache_miss_tokens ?? (cached > 0 && promptTk > cached ? promptTk - cached : 0); usageBuf = { prompt_tokens: promptTk, completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0, total_tokens: u.total_tokens ?? (promptTk + (u.completion_tokens ?? 0)), cached_tokens: cached, cache_creation_tokens: cacheCreation }; }
                if (!choices || choices.length === 0) continue;
                const delta = choices[0]!.delta as Record<string, unknown> | undefined;  
                if (!delta) { finishReason = (choices[0]!.finish_reason as string) ?? finishReason; continue; }  
                if (choices[0]!.finish_reason) finishReason = choices[0]!.finish_reason as string;  

                // Accumulate text content
                if (typeof delta.content === 'string') {
                    contentBuf += delta.content;
                    if (delta.content && onTextDelta) onTextDelta(delta.content);
                }
                // Accumulate thinking/reasoning content and emit incrementally
                const reasoning = delta.reasoning_content ?? delta.reasoning;
                if (typeof reasoning === 'string' && reasoning) {
                    reasoningBuf += reasoning;
                    onThinking?.(reasoning);
                }
                // Reassemble tool_calls from deltas
                const tcDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
                if (tcDeltas) {
                    for (const tc of tcDeltas) {
                        // M1 Fix: don't blindly cast index to number — if missing,
                        // use the next available slot to avoid overwriting parallel tool_calls.
                        const idx = typeof tc.index === 'number'
                            ? tc.index
                            : Object.keys(toolCallMap).length;
                        if (!toolCallMap[idx]) {
                            toolCallMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                        }
                        if (tc.id) toolCallMap[idx].id = tc.id as string;
                        if (tc.type) toolCallMap[idx].type = tc.type as string;
                        const fn = tc.function as Record<string, string> | undefined;
                        if (fn) {
                            if (fn.name) toolCallMap[idx].function.name += fn.name;
                            if (fn.arguments) {
                                toolCallMap[idx].function.arguments += fn.arguments;
                                if (onToolCallDelta) {
                                    onToolCallDelta(toolCallMap[idx].function.name, toolCallMap[idx].function.arguments);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Build a synthetic ChatCompletionResponse
        const toolCalls = Object.keys(toolCallMap).length > 0
            ? Object.entries(toolCallMap)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([, tc]) => tc)
            : undefined;

        return {
            model: modelBuf || undefined,
            choices: [{
                message: {
                    role: 'assistant',
                    content: contentBuf || null,
                    tool_calls: toolCalls,
                    // DeepSeek-R1 requires reasoning_content on ALL assistant messages
                    // when thinking mode is active — set to null when absent, not omitted
                    reasoning_content: reasoningBuf || null,
                } as ChatMessage & { tool_calls?: typeof toolCalls },
                finish_reason: finishReason ?? 'stop',
            }],
            usage: usageBuf ? {
                prompt_tokens: usageBuf.prompt_tokens,
                completion_tokens: usageBuf.completion_tokens,
                total_tokens: usageBuf.total_tokens,
                cached_tokens: usageBuf.cached_tokens,
                cache_creation_tokens: usageBuf.cache_creation_tokens,
            } : undefined,
        } as ChatCompletionResponse;
    }

    private buildOpenAIResponsesPayload(request: ChatCompletionRequest): Record<string, unknown> {
        const payload: Record<string, unknown> = {
            model: request.model,
            input: this.toResponsesInput(request.messages),
            temperature: request.temperature,
            max_output_tokens: request.max_tokens,
        };
        if (request.tools && request.tools.length > 0) {
            payload.tools = request.tools.map(t => ({
                type: 'function',
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
            }));
            payload.tool_choice = 'auto';
        }
        if (request.reasoning_effort) {
            payload.reasoning = { effort: request.reasoning_effort };
        }
        return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
    }

    private toResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
        const input: Array<Record<string, unknown>> = [];
        for (const msg of messages) {
            if (msg.role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: msg.tool_call_id ?? msg.name ?? 'call_unknown',
                    output: this.messageContentToText(msg.content),
                });
                continue;
            }

            const content = this.toResponsesContent(msg.content);
            if (content.length > 0) {
                input.push({
                    role: msg.role,
                    content,
                });
            }

            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    input.push({
                        type: 'function_call',
                        id: tc.id,
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
            }
        }
        return input;
    }

    private toResponsesContent(content: ChatMessage['content']): Array<Record<string, unknown>> {
        if (!content) return [];
        if (typeof content === 'string') return [{ type: 'input_text', text: content }];
        return content.map(part => {
            if (part.type === 'text') {
                return { type: 'input_text', text: part.text };
            }
            return {
                type: 'input_image',
                image_url: part.image_url.url,
                detail: part.image_url.detail ?? 'auto',
            };
        });
    }

    private async callOpenAIResponses(
        endpoint: string,
        apiKey: string,
        request: ChatCompletionRequest,
        providerId: string,
        controller: AbortController,
        onTextDelta?: (text: string) => void
    ): Promise<ChatCompletionResponse> {
        const cleanEndpoint = endpoint.replace(/\/+$/, '');
        const url = cleanEndpoint.endsWith('/responses') ? cleanEndpoint : `${cleanEndpoint}/responses`;
        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.buildAuthHeaders(providerId, apiKey),
            },
            body: JSON.stringify(this.buildOpenAIResponsesPayload(request)),
            signal: controller.signal,
        }, providerId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${getProvider(providerId).name} Responses API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as any;
        const outputItems: any[] = Array.isArray(data.output) ? data.output : [];
        const contentParts: string[] = [];
        const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];

        const hasAggregateOutputText = typeof data.output_text === 'string' && data.output_text;
        if (hasAggregateOutputText) {
            contentParts.push(data.output_text);
        }

        for (const item of outputItems) {
            if (!hasAggregateOutputText && item?.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                    const text = part?.text ?? part?.content?.[0]?.text;
                    if ((part?.type === 'output_text' || part?.type === 'text') && typeof text === 'string') {
                        contentParts.push(text);
                    }
                }
            } else if (item?.type === 'function_call') {
                toolCalls.push({
                    id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
                    type: 'function',
                    function: {
                        name: item.name ?? '',
                        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
                    },
                });
            }
        }

        const text = contentParts.join('');
        if (text) onTextDelta?.(text);
        const usage = data.usage ?? {};
        return {
            id: data.id,
            object: data.object ?? 'response',
            created: data.created_at ?? Math.floor(Date.now() / 1000),
            model: data.model ?? request.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: text || null,
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: toolCalls.length > 0 ? 'tool_calls' : (data.status === 'incomplete' ? 'length' : 'stop'),
            }],
            usage: {
                prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
                completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
                total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
                cached_tokens: usage.input_tokens_details?.cached_tokens,
            },
        } as ChatCompletionResponse;
    }

    private buildGeminiUrl(endpoint: string, model: string): string {
        const cleanEndpoint = endpoint.replace(/\/+$/, '');
        if (cleanEndpoint.includes(':generateContent')) return cleanEndpoint;
        const encodedModel = encodeURIComponent(model.replace(/^models\//, ''));
        if (cleanEndpoint.endsWith('/models')) {
            return `${cleanEndpoint}/${encodedModel}:generateContent`;
        }
        return `${cleanEndpoint}/models/${encodedModel}:generateContent`;
    }

    private withGeminiKey(url: string, apiKey: string): string {
        if (!apiKey.trim() || /[?&]key=/.test(url)) return url;
        return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
    }

    private buildGeminiPayload(request: ChatCompletionRequest): Record<string, unknown> {
        const systemParts: Array<Record<string, unknown>> = [];
        const contents: Array<Record<string, unknown>> = [];
        const toolCallNames = new Map<string, string>();

        for (const msg of request.messages) {
            if (msg.role === 'system') {
                const text = this.messageContentToText(msg.content);
                if (text) systemParts.push({ text });
                continue;
            }

            if (msg.role === 'tool') {
                const name = toolCallNames.get(msg.tool_call_id ?? '') ?? msg.name ?? msg.tool_call_id ?? 'tool_result';
                contents.push({
                    role: 'user',
                    parts: [{
                        function_response: {
                            name,
                            response: { result: this.messageContentToText(msg.content) },
                        },
                    }],
                });
                continue;
            }

            const parts = this.toGeminiParts(msg.content);
            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    toolCallNames.set(tc.id, tc.function.name);
                    parts.push({
                        function_call: {
                            name: tc.function.name,
                            args: this.parseJsonObject(tc.function.arguments),
                        },
                    });
                }
            }
            if (parts.length > 0) {
                contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts,
                });
            }
        }

        const payload: Record<string, unknown> = {
            contents,
            generation_config: {
                temperature: request.temperature,
                max_output_tokens: request.max_tokens,
                ...(request.thinking_config ? { thinking_config: request.thinking_config } : {}),
            },
        };
        if (systemParts.length > 0) {
            payload.system_instruction = { parts: systemParts };
        }
        if (request.tools && request.tools.length > 0) {
            payload.tools = [{
                function_declarations: request.tools.map(t => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                })),
            }];
            payload.tool_config = {
                function_calling_config: { mode: 'AUTO' },
            };
        }
        return payload;
    }

    private toGeminiParts(content: ChatMessage['content']): Array<Record<string, unknown>> {
        if (!content) return [];
        if (typeof content === 'string') return content ? [{ text: content }] : [];
        return content.map(part => {
            if (part.type === 'text') return { text: part.text };
            return this.toGeminiImagePart(part);
        });
    }

    private toGeminiImagePart(part: Extract<ContentPart, { type: 'image_url' }>): Record<string, unknown> {
        const url = part.image_url.url;
        const dataMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
        if (dataMatch) {
            return {
                inline_data: {
                    mime_type: dataMatch[1],
                    data: dataMatch[2],
                },
            };
        }
        return {
            file_data: {
                file_uri: url,
                mime_type: 'image/*',
            },
        };
    }

    private async callGeminiGenerateContent(
        endpoint: string,
        apiKey: string,
        request: ChatCompletionRequest,
        providerId: string,
        controller: AbortController,
        onTextDelta?: (text: string) => void,
        onToolCallDelta?: (toolName: string, argsBuf: string) => void
    ): Promise<ChatCompletionResponse> {
        const url = this.withGeminiKey(this.buildGeminiUrl(endpoint, request.model), apiKey);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.buildAuthHeaders(providerId, apiKey),
        };
        if (apiKey) headers['x-goog-api-key'] = apiKey;
        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(this.buildGeminiPayload(request)),
            signal: controller.signal,
        }, providerId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${getProvider(providerId).name} Gemini API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as any;
        const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
        const parts: any[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        const textParts: string[] = [];
        const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];

        for (const part of parts) {
            if (typeof part?.text === 'string') {
                textParts.push(part.text);
                continue;
            }
            const fn = part?.functionCall ?? part?.function_call;
            if (fn) {
                const args = typeof fn.args === 'string' ? fn.args : JSON.stringify(fn.args ?? {});
                const id = `gemini_call_${toolCalls.length}`;
                toolCalls.push({
                    id,
                    type: 'function',
                    function: { name: fn.name ?? '', arguments: args },
                });
                onToolCallDelta?.(fn.name ?? '', args);
            }
        }

        const text = textParts.join('');
        if (text) onTextDelta?.(text);
        const usage = data.usageMetadata ?? {};
        const finish = String(candidate?.finishReason ?? '').toUpperCase();
        return {
            id: `gemini-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: text || null,
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: toolCalls.length > 0 ? 'tool_calls' : (finish === 'MAX_TOKENS' ? 'length' : 'stop'),
            }],
            usage: {
                prompt_tokens: usage.promptTokenCount ?? 0,
                completion_tokens: usage.candidatesTokenCount ?? 0,
                total_tokens: usage.totalTokenCount ?? ((usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0)),
            },
        } as ChatCompletionResponse;
    }

    private messageContentToText(content: ChatMessage['content']): string {
        if (!content) return '';
        if (typeof content === 'string') return content;
        return content.map(part => part.type === 'text' ? part.text : `[image] ${part.image_url.url}`).join('\n');
    }

    private parseJsonObject(value: string): Record<string, unknown> {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }

    /**
     * Call Claude Messages API using Server-Sent Events streaming.
     *
     * Claude SSE event types used:
     *  - message_start          → usage (input_tokens)
     *  - content_block_start    → tool_use block started (captures id/name)
     *  - content_block_delta    → text_delta or input_json_delta
     *  - message_delta          → stop_reason, usage.output_tokens
     *
     * Result is assembled into a synthetic ChatCompletionResponse identical
     * to the format returned by callOpenAICompatibleStreaming.
     */
    private async callClaude(
        endpoint: string,
        apiKey: string,
        request: ChatCompletionRequest,
        controller: AbortController,
        onThinking?: (text: string) => void,
        onTextDelta?: (text: string) => void,
        onToolCallDelta?: (toolName: string, argsBuf: string) => void,
        providerId: string = 'claude'
    ): Promise<ChatCompletionResponse> {
        const url = `${normalizeAnthropicMessagesEndpoint(endpoint)}/messages`;
        // Force stream=true so we get SSE — enables thinking tokens and unblocks UI
        const claudeRequest = toClaudeRequest({ ...request, stream: true });
        // Claude Code-style relays often expose models that reject temperature entirely.
        if (providerId === 'custom') {
            delete claudeRequest.temperature;
        }

        const sendClaudeRequest = (): Promise<Response> => this.fetchWithRetry(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                ...(providerId === 'opencode' ? this.buildAuthHeaders(providerId, apiKey) : {}),
            },
            body: JSON.stringify(claudeRequest),
            signal: controller.signal,
        }, providerId);

        let response = await sendClaudeRequest();
        if (!response.ok) {
            const errorText = await response.text();
            if (
                response.status === 400
                && claudeRequest.temperature !== undefined
                && /temperature/i.test(errorText)
                && /deprecated|not supported|unsupported/i.test(errorText)
            ) {
                delete claudeRequest.temperature;
                response = await sendClaudeRequest();
                if (response.ok) {
                    ErrorReporter.debug(SOURCE.AI_SERVICE, `${getProvider(providerId).name}: retried Claude request without deprecated temperature parameter.`);
                } else {
                    const retryErrorText = await response.text();
                    throw new Error(`${getProvider(providerId).name} API error (${response.status}): ${retryErrorText}`);
                }
            } else {
                throw new Error(`${getProvider(providerId).name} API error (${response.status}): ${errorText}`);
            }
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${getProvider(providerId).name} API error (${response.status}): ${errorText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body from Claude SSE');
        const decoder = new TextDecoder();
        let buffer = '';

        // Accumulation state (mirroring callOpenAICompatibleStreaming)
        let textBuf = '';
        let reasoningBuf = '';
        let modelBuf = '';
        let stopReason: string | null = null;
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedTokens = 0;
        let cacheCreationTokens = 0;

        // Tool-use blocks: index → { id, name, argsBuf, startInput }
        const toolBlocks: Record<number, { id: string; name: string; argsBuf: string; startInput?: unknown }> = {};
        let currentBlockIdx = -1;
        let currentBlockType = '';

        while (true) {
            const { done, value } = await this.readWithTimeout(reader, controller, 600000); // 600s idle timeout (to prevent large models from being disconnected and suspended)
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            let eventType = '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('event: ')) {
                    eventType = trimmed.slice(7).trim();
                    continue;
                }
                if (!trimmed.startsWith('data: ')) continue;
                let evt: Record<string, unknown>;
                try { evt = JSON.parse(trimmed.slice(6)); } catch { continue; }

                switch (eventType) {
                    case 'message_start': {
                        const msg = evt.message as Record<string, unknown> | undefined;
                        if (msg?.model) modelBuf = msg.model as string;
                        const u = msg?.usage as Record<string, number> | undefined;
                        if (u) {
                            inputTokens = u.input_tokens ?? 0;
                            cachedTokens = u.cache_read_input_tokens ?? 0;
                            cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
                        }
                        break;
                    }
                    case 'content_block_start': {
                        currentBlockIdx = (evt.index as number) ?? 0;
                        const block = evt.content_block as Record<string, unknown> | undefined;
                        currentBlockType = (block?.type as string) ?? '';
                        if (currentBlockType === 'tool_use') {
                            toolBlocks[currentBlockIdx] = {
                                id: (block?.id as string) ?? '',
                                name: (block?.name as string) ?? '',
                                argsBuf: '',
                                // Some relays put the full input on the start block; Anthropic
                                // sends `input: {}` here and streams the rest as input_json_delta.
                                startInput: block?.input,
                            };
                        }
                        break;
                    }
                    case 'content_block_delta': {
                        const delta = evt.delta as Record<string, unknown> | undefined;
                        const deltaType = delta?.type as string;
                        if (deltaType === 'text_delta') {
                            const chunk = (delta?.text as string) ?? '';
                            // Route thinking vs text based on content block type:
                            // Claude 'thinking' blocks → onThinking (reasoning UI)
                            // Claude 'text' blocks → onTextDelta (response UI)
                            if (currentBlockType === 'thinking') {
                                reasoningBuf += chunk;
                                if (chunk && onThinking) onThinking(chunk);
                            } else {
                                textBuf += chunk;
                                if (chunk && onTextDelta) onTextDelta(chunk);
                            }
                        } else if (deltaType === 'thinking_delta') {
                            // Claude thinking blocks stream as thinking_delta (delta.thinking),
                            // not text_delta — without this branch reasoning text is dropped.
                            const chunk = (delta?.thinking as string) ?? '';
                            reasoningBuf += chunk;
                            if (chunk && onThinking) onThinking(chunk);
                        } else if (deltaType === 'input_json_delta') {
                            const idx = (evt.index as number) ?? currentBlockIdx;
                            if (toolBlocks[idx]) {
                                toolBlocks[idx].argsBuf += (delta?.partial_json as string) ?? '';
                                onToolCallDelta?.(toolBlocks[idx].name, toolBlocks[idx].argsBuf);
                            }
                        }
                        break;
                    }
                    case 'message_delta': {
                        const d = evt.delta as Record<string, unknown> | undefined;
                        if (d?.stop_reason) stopReason = d.stop_reason as string;
                        const u = evt.usage as Record<string, number> | undefined;
                        if (u) outputTokens = u.output_tokens ?? 0;
                        break;
                    }
                    // 'message_stop', 'ping', 'error' — handled implicitly
                }
            }
        }

        // Map Claude stop_reason → OpenAI finish_reason
        let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
        if (stopReason === 'tool_use') finishReason = 'tool_calls';
        else if (stopReason === 'max_tokens') finishReason = 'length';

        // Build synthetic tool_calls array from accumulated blocks.
        // A tool call with no parameters streams zero input_json_delta events, so
        // argsBuf stays '' — fall back to the start-block input, then to '{}', so
        // downstream JSON.parse never sees an empty string.
        const toolCalls = Object.keys(toolBlocks).length > 0
            ? Object.entries(toolBlocks)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([, tb]) => {
                    let args = tb.argsBuf.trim();
                    if (!args) {
                        const si = tb.startInput;
                        args = (si && typeof si === 'object' && Object.keys(si as object).length > 0)
                            ? JSON.stringify(si)
                            : '{}';
                    }
                    return {
                        id: tb.id,
                        type: 'function' as const,
                        function: { name: tb.name, arguments: args },
                    };
                })
            : undefined;

        const message: ChatMessage & { tool_calls?: typeof toolCalls } = {
            role: 'assistant',
            content: textBuf || null,
            // Include thinking tokens in the response (matches OpenAI path's reasoning_content)
            reasoning_content: reasoningBuf || null,
        };
        if (toolCalls && toolCalls.length > 0) message.tool_calls = toolCalls;

        // Anthropic usage semantics: input_tokens is the UNCACHED REMAINDER only.
        // Normalize to OpenAI semantics (prompt_tokens = full prompt) so downstream
        // hit-rate and cost math (cached/prompt) stays in [0, 1].
        const totalPromptTokens = inputTokens + cachedTokens + cacheCreationTokens;
        // Note: the per-call cache_stats ledger event is appended by agentRunner from
        // the returned usage — appending it here too double-counted cache dashboards.

        return {
            model: modelBuf || undefined,
            choices: [{
                message: message as ChatMessage,
                finish_reason: finishReason,
            }],
            usage: {
                prompt_tokens: totalPromptTokens,
                completion_tokens: outputTokens,
                total_tokens: totalPromptTokens + outputTokens,
                cached_tokens: cachedTokens,
                cache_creation_tokens: cacheCreationTokens,
            },
        } as ChatCompletionResponse;
    }

    // ─── Provider quick-configure UI ─────────────────────────────────────────

    /**
     * Show a quick-pick to let the user select and configure a provider.
     */
    async quickConfigureProvider(): Promise<void> {
        const items = Object.values(BUILTIN_PROVIDERS)
            .map(p => ({
                label: p.name,
                description: p.defaultModel,
                detail: `${p.models.length} models, up to ${(p.maxContextTokens / 1000).toFixed(0)}K context`,
                providerId: p.id,
            }));

        const selected = await vs.window.showQuickPick(items, {
            title: 'Select AI Provider',
            placeHolder: 'Choose your AI provider...',
        });

        if (!selected) return;

        const providerId = selected.providerId;
        const provider = getProvider(providerId);

        // Set provider in config
        await vs.workspace.getConfiguration('cwtools.ai').update('provider', providerId, vs.ConfigurationTarget.Global);

        // Prompt for model selection
        if (providerId === 'ollama') {
            // Auto-detect models from running Ollama instance
            const userEndpoint = this.getEndpointForProvider('ollama');
            const ollamaEndpoint = userEndpoint || provider.endpoint;

            await vs.window.withProgress(
                { location: vs.ProgressLocation.Notification, title: aiText('Detecting Ollama models...', '正在检测 Ollama 模型...') },
                async () => {
                    const detectedModels = await fetchOllamaModels(ollamaEndpoint);

                    if (detectedModels.length > 0) {
                        const modelItems = detectedModels.map(m => ({
                            label: m.name,
                            description: m.parameterSize ? `${m.parameterSize}` : '',
                            detail: aiText(`Size: ${m.size}`, `大小: ${m.size}`),
                        }));
                        modelItems.push({
                            label: aiText('$(edit) Enter model name manually...', '$(edit) 手动输入模型名...'),
                            description: '',
                            detail: '',
                        });

                        const selectedModel = await vs.window.showQuickPick(modelItems, {
                            title: aiText(`Ollama local models (${detectedModels.length} detected)`, `Ollama 本地模型 (检测到 ${detectedModels.length} 个)`),
                            placeHolder: aiText('Choose an installed model...', '选择一个已安装的模型...'),
                        });
                        if (selectedModel) {
                            if (selectedModel.label.startsWith('$(edit)')) {
                                const modelName = await vs.window.showInputBox({
                                    title: 'Ollama Model Name',
                                    prompt: 'Enter the model name (e.g. qwen3:32b)',
                                    placeHolder: 'model-name:tag',
                                    ignoreFocusOut: true,
                                });
                                if (modelName) {
                                    await vs.workspace.getConfiguration('cwtools.ai').update('model', modelName, vs.ConfigurationTarget.Global);
                                }
                            } else {
                                await vs.workspace.getConfiguration('cwtools.ai').update('model', selectedModel.label, vs.ConfigurationTarget.Global);
                            }
                        }
                    } else {
                        vs.window.showWarningMessage(aiText(
                            'No Ollama models detected. Make sure Ollama is running and you have pulled a model (ollama pull model-name).',
                            '未检测到 Ollama 模型。请确保 Ollama 正在运行并已拉取模型 (ollama pull model-name)。',
                        ));
                        const modelName = await vs.window.showInputBox({
                            title: 'Ollama Model Name',
                            prompt: 'Enter the model name manually',
                            placeHolder: 'qwen3:32b',
                            ignoreFocusOut: true,
                        });
                        if (modelName) {
                            await vs.workspace.getConfiguration('cwtools.ai').update('model', modelName, vs.ConfigurationTarget.Global);
                        }
                    }
                }
            );
        } else if (providerId === 'custom') {
            const modelName = await vs.window.showInputBox({
                title: 'Custom Model Name',
                prompt: aiText('Enter the model name for the custom OpenAI-compatible provider', '输入自定义 OpenAI 兼容渠道使用的模型名'),
                placeHolder: 'model-name',
                ignoreFocusOut: true,
            });
            if (modelName) {
                await vs.workspace.getConfiguration('cwtools.ai').update('model', modelName, vs.ConfigurationTarget.Global);
            }
        } else if (provider.models.length > 0) {
            const modelItems = provider.models.map(m => ({
                label: m,
                description: m === provider.defaultModel ? '(default)' : '',
            }));

            modelItems.push({
                label: aiText('$(edit) Enter model name manually...', '$(edit) 手动输入模型名...'),
                description: '',
            });

            const selectedModel = await vs.window.showQuickPick(modelItems, {
                title: `Select ${provider.name} Model`,
                placeHolder: 'Choose a model...',
            });
            if (selectedModel) {
                if (selectedModel.label.startsWith('$(edit)')) {
                    const modelName = await vs.window.showInputBox({
                        title: 'Model Name',
                        prompt: 'Enter the model name',
                        placeHolder: provider.defaultModel || 'model-name',
                        ignoreFocusOut: true,
                    });
                    if (modelName) {
                        await vs.workspace.getConfiguration('cwtools.ai').update('model', modelName, vs.ConfigurationTarget.Global);
                    }
                } else {
                    await vs.workspace.getConfiguration('cwtools.ai').update('model', selectedModel.label, vs.ConfigurationTarget.Global);
                }
            }
        }

        // For endpoint-driven providers: ask optional/required custom endpoint.
        if (providerId === 'ollama' || providerId === 'custom') {
            const epInput = await vs.window.showInputBox({
                title: providerId === 'ollama' ? 'Ollama Endpoint' : 'Custom OpenAI-Compatible Endpoint',
                prompt: providerId === 'ollama'
                    ? aiText('Enter the Ollama API endpoint (leave empty for default http://localhost:11434/v1)', '输入 Ollama 的 API 地址 (留空使用默认 http://localhost:11434/v1)')
                    : aiText('Enter the OpenAI-compatible API endpoint for the custom provider, for example https://example.com/v1', '输入自定义渠道的 OpenAI 兼容 API 地址，例如 https://example.com/v1'),
                placeHolder: providerId === 'ollama' ? 'http://localhost:11434/v1' : 'https://example.com/v1',
                value: this.getEndpointForProvider(providerId),
                ignoreFocusOut: true,
            });
            if (epInput !== undefined) {
                const cfg = vs.workspace.getConfiguration('cwtools.ai');
                const map = { ...(cfg.get<Record<string, string>>('providerEndpoints', {}) || {}) };
                const trimmed = epInput.trim();
                if (trimmed) map[providerId] = trimmed; else delete map[providerId];
                await cfg.update('providerEndpoints', map, vs.ConfigurationTarget.Global);
            }
            
            const ctxInput = await vs.window.showInputBox({
                title: aiText('Context size (tokens)', '上下文大小 (tokens)'),
                prompt: aiText('Enter the model maximum context window size (leave empty to use default)', '输入模型的最大上下文窗口大小 (留空使用默认值)'),
                placeHolder: String(provider.maxContextTokens || 32768),
                ignoreFocusOut: true,
            });
            if (ctxInput && parseInt(ctxInput) > 0) {
                await vs.workspace.getConfiguration('cwtools.ai').update(
                    'maxContextTokens', parseInt(ctxInput), vs.ConfigurationTarget.Global
                );
            }
        }

        // Prompt for API key only when the provider needs one.
        if (provider.requiresApiKey) {
            await this.keyManager.promptForKey(providerId);
        }

        // Enable AI
        await vs.workspace.getConfiguration('cwtools.ai').update('enabled', true, vs.ConfigurationTarget.Global);

    }

    /**
     * Show a quick-pick to dynamically fetch and select a model.
     */
    async selectModelCommand(): Promise<void> {
        const config = this.getConfig();
        const providerId = config.provider;
        const provider = getProvider(providerId);

        let endpoint = provider.endpoint;
        // user endpoint override
        if (config.endpoint && (providerId === 'ollama' || provider.isOpenAICompatible)) {
            endpoint = config.endpoint || provider.endpoint;
        } else if (provider.isOpenAICompatible && providerId !== 'ollama') {
            endpoint = getEffectiveEndpoint(providerId, config.endpoint);
        }

        let apiKey = '';
        if (provider.requiresApiKey) {
            apiKey = await this.getKeyForProvider(providerId) || '';
            if (!apiKey) {
                vs.window.showWarningMessage(`No API key configured for ${provider.name}. Showing default models only.`);
            }
        }

        let detectedModels: { id: string }[] = [];

        await vs.window.withProgress({
            location: vs.ProgressLocation.Notification,
            title: `Fetching models for ${provider.name}...`,
            cancellable: false
        }, async () => {
            if (providerId === 'ollama') {
                const ollamaModels = await fetchOllamaModels(endpoint);
                detectedModels = ollamaModels.map(m => ({ id: m.name }));
            } else if (providerId.startsWith('minimax')) {
                detectedModels = provider.models.map(m => ({ id: m }));
            } else if (provider.isOpenAICompatible && endpoint) {
                try {
                    const modelsUrl = endpoint.replace(/\/chat\/completions$/, '').replace(/\/+$/, '') + '/models';
                    const headers: Record<string, string> = {};
                    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
                    const res = await fetch(modelsUrl, {
                        headers
                    });
                    if (res.ok) {
                        const data = await res.json() as any;
                        if (data && Array.isArray(data.data)) {
                            const dynModels = data.data.map((m: any) => m.id); const cfg = vs.workspace.getConfiguration('cwtools.ai'); let currentDynamic = cfg.get('dynamicModels') || {}; currentDynamic = { ...currentDynamic, [providerId]: dynModels }; await cfg.update('dynamicModels', currentDynamic, vs.ConfigurationTarget.Global); detectedModels = dynModels.map((id: string) => ({ id }));
                        }
                    }
                } catch (e) {
                    ErrorReporter.debug(SOURCE.AI_SERVICE, `Failed to fetch models from ${provider.name}`, e);
                }
            }
        });

        const modelItems = provider.models.map(m => ({
            label: m,
            description: m === provider.defaultModel ? '(default)' : aiText('preset model', '预设模型'),
        }));

        const existingSet = new Set(provider.models);
        for (const m of detectedModels) {
            if (!existingSet.has(m.id)) {
                modelItems.push({
                    label: m.id,
                    description: aiText('fetched (API)', '已获取 (API)'),
                });
            }
        }

        modelItems.push({
            label: aiText('$(edit) Enter model name manually...', '$(edit) 手动输入模型名...'),
            description: '',
        });

        const selectedModel = await vs.window.showQuickPick(modelItems, {
            title: `Select ${provider.name} Model (fetched ${detectedModels.length} models)`,
            placeHolder: 'Choose an AI model for completion/chat...',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selectedModel) {
            let modelName: string | undefined;
            if (selectedModel.label.startsWith('$(edit)')) {
                modelName = await vs.window.showInputBox({
                    title: 'Model Name',
                    prompt: 'Enter the model name manually',
                    placeHolder: provider.defaultModel || 'model-name',
                    ignoreFocusOut: true,
                });
            } else {
                modelName = selectedModel.label;
            }
            if (modelName) {
                await this.applyModelSelection(modelName, provider);
            }
        }
    }

    /**
     * P1 Fix: shared helper for applying model selection —
     * sets the model config, infers maxContextTokens, and shows confirmation.
     */
    private async applyModelSelection(modelName: string, provider: { maxContextTokens: number }): Promise<void> {
        await vs.workspace.getConfiguration('cwtools.ai').update('model', modelName, vs.ConfigurationTarget.Global);
        const { MODEL_CONTEXT_TOKENS } = await import('./providers');
        let foundCtx = 0;
        for (const [key, val] of Object.entries(MODEL_CONTEXT_TOKENS)) {
            if (modelName.includes(key)) { foundCtx = val as number; break; }
        }
        if (foundCtx > 0 || provider.maxContextTokens) {
            await vs.workspace.getConfiguration('cwtools.ai').update('maxContextTokens', foundCtx || provider.maxContextTokens, vs.ConfigurationTarget.Global);
        }
        vs.window.showInformationMessage(`AI Model set to: ${modelName}`);
    }
}
