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
} from './providers';

// ─── Module-level constants ──────────────────────────────────────────────────

/** Providers that reject the `detail` sub-field inside `image_url` objects. */
const STRIP_IMAGE_DETAIL_PROVIDERS = new Set(['minimax', 'glm', 'qwen']);

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

    /**
     * Read the current user configuration for AI.
     */
    getConfig(): AIUserConfig {
        const cfg = vs.workspace.getConfiguration('cwtools.ai');
        return {
            enabled: cfg.get<boolean>('enabled', false),
            provider: cfg.get<string>('provider', 'openai'),
            // In-memory override wins over persisted setting (avoids LS restart on quick-switch)
            model: this.modelOverride ?? cfg.get<string>('model', ''),
            endpoint: cfg.get<string>('endpoint', ''),
            apiKey: '',
            maxRetries: Math.max(1, cfg.get<number>('maxRetries') || 3),
            maxContextTokens: cfg.get<number>('maxContextTokens', 0),
            agentFileWriteMode: cfg.get<'confirm' | 'auto'>('agentFileWriteMode', 'confirm'),
            forcedThinkingMode: cfg.get<boolean>('forcedThinkingMode', false),
            reasoningEffort: cfg.get<'low' | 'medium' | 'high' | 'max'>('reasoningEffort', 'high'),
            inlineCompletion: {
                enabled: cfg.get<boolean>('inlineCompletion.enabled') || false,
                debounceMs: cfg.get<number>('inlineCompletion.debounceMs', 500),
                provider: cfg.get<string>('inlineCompletion.provider', ''),
                model: cfg.get<string>('inlineCompletion.model', ''),
                endpoint: cfg.get<string>('inlineCompletion.endpoint', ''),
                overlapStripping: cfg.get<boolean>('inlineCompletion.overlapStripping', true),
                fimMode: cfg.get<boolean>('inlineCompletion.fimMode', false),
            },
            mcp: {
                servers: cfg.get<import('./types').MCPServerConfig[]>('mcp.servers', []),
            },
        };
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
                    `CWTools AI: API Key 已安全迁移到 SecretStorage (${providerId})`
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
            /** Real-time callback for incremental reasoning/thinking tokens */
            onThinking?: (text: string) => void;
            /** Real-time callback for incremental text content tokens (streaming typewriter effect) */
            onTextDelta?: (text: string) => void;
            /** Real-time callback for incremental tool call fragments */
            onToolCallDelta?: (toolName: string, argsBuf: string) => void;
            /** External AbortSignal for caller-controlled cancellation */
            abortSignal?: AbortSignal;
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

        // Ollama doesn't require an API key
        let apiKey = '';
        if (providerId !== 'ollama') {
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
        const rawModel = options?.model ?? getEffectiveModel(providerId, config.model);
        // Strip the UI '(免费)' suffix from the model ID before sending to the API
        const model = rawModel.replace(/\s*\(免费\)$/i, '');
        const lowerModel = model.toLowerCase();

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
        }

        const request: ChatCompletionRequest & Record<string, any> = {
            model,
            messages: finalMessages,
            tools: options?.tools,
            tool_choice: options?.tools && options.tools.length > 0 ? 'auto' : undefined,
            temperature: options?.temperature ?? 0.3,
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
            if (config.provider === 'deepseek' || config.provider === 'openai') {
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
        // Also link any external abort signal so the caller can cancel this specific call.
        const externalSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const linkAbort = () => controller.abort();
        externalSignal?.addEventListener('abort', linkAbort);
        this.activeControllers.add(controller);

        try {
            // MiniMax Token Plan uses Anthropic Messages API format
            const isAnthropicCompat = providerId === 'claude' || providerId === 'minimax-token-plan';
            // Use streaming for OpenAI-compat providers when they support it.
            if (provider.supportsStreaming && provider.isOpenAICompatible && !isAnthropicCompat) {
                return await this.callOpenAICompatibleStreaming(endpoint, apiKey, { ...request, stream: true }, providerId, options?.onThinking, controller, options?.onTextDelta, options?.onToolCallDelta);
            } else if (isAnthropicCompat) {
                // L4 Fix: fully migrate callClaude to SSE — enables real-time thinking tokens
                // and eliminates the previous blocking response.json() approach.
                return await this.callClaude(endpoint, apiKey, request, controller, options?.onThinking, options?.onTextDelta, options?.onToolCallDelta);
            } else {
                return await this.callOpenAICompatible(endpoint, apiKey, request, providerId, controller);
            }
        } finally {
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
        if (providerId !== 'ollama') {
            if (options?.apiKey) {
                apiKey = options.apiKey;
            } else {
                const key = await this.getKeyForProvider(providerId);
                if (!key) throw new Error(`No API key configured for ${provider.name}.`);
                apiKey = key;
            }
        }

        const endpoint = options?.endpoint || getEffectiveEndpoint(providerId, config.inlineCompletion.endpoint || config.endpoint);
        const rawModel = options?.model ?? getEffectiveModel(providerId, config.inlineCompletion.model || config.model);
        const model = rawModel.replace(/\s*\(免费\)$/i, '');

        const controller = new AbortController();
        const externalSignal = options?.abortSignal;
        const linkAbort = () => controller.abort();
        externalSignal?.addEventListener('abort', linkAbort);
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
                    console.error(`[FIM] Ollama API error (${response.status}): ${err}`);
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

                console.log(`[FIM] Requesting: ${url} model=${model}`);

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
                    console.error(`[FIM] ${provider.name} API error (${response.status}): ${err}`);
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

    /**
     * Executes fetch with exponential backoff for 429 Too Many Requests.
     * Prevents multi-agent swarms from crashing API limits.
     */
    private async fetchWithRetry(url: string, init: RequestInit, providerId: string): Promise<Response> {
        let retries = 0;
        const maxRetries = 3;
        const delays = [2000, 4000, 8000];

        while (true) {
            const response = await fetch(url, init);

            // Check for 429 (Rate Limit / Too Many Requests)
            if (response.status === 429 && retries < maxRetries) {
                const jitter = Math.floor(Math.random() * delays[retries]! * 0.25);
                const delay = delays[retries]! + jitter;
                console.warn(`[AIService] 429 Rate Limit hit for ${providerId}. Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                retries++;
                continue;
            }
            return response;
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

        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(this.sanitizeRequest(providerId, { ...request, stream: true })),
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
        let usageBuf: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
        let modelBuf = '';
        // tool_calls reassembly: index → { id, type, function.name, function.arguments(buf) }
        const toolCallMap: Record<number, { id: string; type: string; function: { name: string; arguments: string } }> = {};

        while (true) {
            const { done, value } = await reader.read();
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
                if (chunk.usage) { const u = chunk.usage as Record<string, number>; usageBuf = { prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0, completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0, total_tokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) }; }
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
            usage: usageBuf,
        } as ChatCompletionResponse;
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
        onToolCallDelta?: (toolName: string, argsBuf: string) => void
    ): Promise<ChatCompletionResponse> {
        const url = `${endpoint}/messages`;
        // Force stream=true so we get SSE — enables thinking tokens and unblocks UI
        const claudeRequest = toClaudeRequest({ ...request, stream: true });

        const response = await this.fetchWithRetry(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(claudeRequest),
            signal: controller.signal,
        }, 'claude');

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Claude API error (${response.status}): ${errorText}`);
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

        // Tool-use blocks: index → { id, name, argsBuf }
        const toolBlocks: Record<number, { id: string; name: string; argsBuf: string }> = {};
        let currentBlockIdx = -1;
        let currentBlockType = '';

        while (true) {
            const { done, value } = await reader.read();
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
                        if (u) inputTokens = u.input_tokens ?? 0;
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

        // Build synthetic tool_calls array from accumulated blocks
        const toolCalls = Object.keys(toolBlocks).length > 0
            ? Object.entries(toolBlocks)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([, tb]) => ({
                    id: tb.id,
                    type: 'function' as const,
                    function: { name: tb.name, arguments: tb.argsBuf },
                }))
            : undefined;

        const message: ChatMessage & { tool_calls?: typeof toolCalls } = {
            role: 'assistant',
            content: textBuf || null,
            // Include thinking tokens in the response (matches OpenAI path's reasoning_content)
            reasoning_content: reasoningBuf || null,
        };
        if (toolCalls && toolCalls.length > 0) message.tool_calls = toolCalls;

        return {
            model: modelBuf || undefined,
            choices: [{
                message: message as ChatMessage,
                finish_reason: finishReason,
            }],
            usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
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
            const userEndpoint = vs.workspace.getConfiguration('cwtools.ai').get<string>('endpoint', '');
            const ollamaEndpoint = userEndpoint || provider.endpoint;

            await vs.window.withProgress(
                { location: vs.ProgressLocation.Notification, title: '正在检测 Ollama 模型...' },
                async () => {
                    const detectedModels = await fetchOllamaModels(ollamaEndpoint);

                    if (detectedModels.length > 0) {
                        const modelItems = detectedModels.map(m => ({
                            label: m.name,
                            description: m.parameterSize ? `${m.parameterSize}` : '',
                            detail: `大小: ${m.size}`,
                        }));
                        modelItems.push({
                            label: '✏️ 手动输入模型名...',
                            description: '',
                            detail: '',
                        });

                        const selectedModel = await vs.window.showQuickPick(modelItems, {
                            title: `Ollama 本地模型 (检测到 ${detectedModels.length} 个)`,
                            placeHolder: '选择一个已安装的模型...',
                        });
                        if (selectedModel) {
                            if (selectedModel.label.startsWith('✏️')) {
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
                        vs.window.showWarningMessage('未检测到 Ollama 模型。请确保 Ollama 正在运行并已拉取模型 (ollama pull model-name)。');
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
        } else if (provider.models.length > 0) {
            const modelItems = provider.models.map(m => ({
                label: m,
                description: m === provider.defaultModel ? '(default)' : '',
            }));

            modelItems.push({
                label: '✏️ 手动输入模型名...',
                description: '',
            });

            const selectedModel = await vs.window.showQuickPick(modelItems, {
                title: `Select ${provider.name} Model`,
                placeHolder: 'Choose a model...',
            });
            if (selectedModel) {
                if (selectedModel.label.startsWith('✏️')) {
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

        // For Ollama: ask optional custom endpoint
        if (providerId === 'ollama') {
            const epInput = await vs.window.showInputBox({
                title: 'Ollama Endpoint',
                prompt: '输入 Ollama 的 API 地址 (留空使用默认 http://localhost:11434/v1)',
                placeHolder: 'http://localhost:11434/v1',
                value: vs.workspace.getConfiguration('cwtools.ai').get<string>('endpoint', ''),
                ignoreFocusOut: true,
            });
            if (epInput !== undefined) {
                await vs.workspace.getConfiguration('cwtools.ai').update(
                    'endpoint', epInput, vs.ConfigurationTarget.Global
                );
            }
            
            const ctxInput = await vs.window.showInputBox({
                title: '上下文大小 (tokens)',
                prompt: '输入模型的最大上下文窗口大小 (留空使用默认值)',
                placeHolder: String(provider.maxContextTokens || 32768),
                ignoreFocusOut: true,
            });
            if (ctxInput && parseInt(ctxInput) > 0) {
                await vs.workspace.getConfiguration('cwtools.ai').update(
                    'maxContextTokens', parseInt(ctxInput), vs.ConfigurationTarget.Global
                );
            }
        }

        // Prompt for API key (skip for Ollama local)
        if (providerId !== 'ollama') {
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
        if (providerId !== 'ollama') {
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
            } else if (provider.isOpenAICompatible) {
                try {
                    const modelsUrl = endpoint.replace(/\/chat\/completions$/, '').replace(/\/+$/, '') + '/models';
                    const res = await fetch(modelsUrl, {
                        headers: {
                            'Authorization': `Bearer ${apiKey}`
                        }
                    });
                    if (res.ok) {
                        const data = await res.json() as any;
                        if (data && Array.isArray(data.data)) {
                            const dynModels = data.data.map((m: any) => m.id); const cfg = vs.workspace.getConfiguration('cwtools.ai'); let currentDynamic = cfg.get('dynamicModels') || {}; currentDynamic = { ...currentDynamic, [providerId]: dynModels }; await cfg.update('dynamicModels', currentDynamic, vs.ConfigurationTarget.Global); detectedModels = dynModels.map((id: string) => ({ id }));
                        }
                    }
                } catch (e) {
                    console.error(`Failed to fetch models from ${provider.name}:`, e);
                }
            }
        });

        const modelItems = provider.models.map(m => ({
            label: m,
            description: m === provider.defaultModel ? '(default)' : '预设模型',
        }));

        const existingSet = new Set(provider.models);
        for (const m of detectedModels) {
            if (!existingSet.has(m.id)) {
                modelItems.push({
                    label: m.id,
                    description: '已获取 (API)',
                });
            }
        }

        modelItems.push({
            label: '✏️ 手动输入模型名...',
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
            if (selectedModel.label.startsWith('✏️')) {
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
