/**
 * CWTools AI Module — Unified AI Service
 *
 * Handles API calls to all supported providers through a unified interface.
 * Supports both streaming and non-streaming modes.
 * Uses SecretStorage for API key management.
 */

import * as vs from 'vscode';
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    ToolDefinition,
    AIUserConfig,
    StreamChunk,
} from './types';
import {
    getProvider,
    getEffectiveEndpoint,
    getEffectiveModel,
    toClaudeRequest,
    fromClaudeResponse,
    fetchOllamaModels,
    BUILTIN_PROVIDERS,
} from './providers';

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
    private abortController: AbortController | null = null;
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
            maxRetries: cfg.get<number>('maxRetries', 3),
            maxContextTokens: cfg.get<number>('maxContextTokens', 0),
            agentFileWriteMode: cfg.get<'confirm' | 'auto'>('agentFileWriteMode', 'confirm'),
            inlineCompletion: {
                enabled: cfg.get<boolean>('inlineCompletion.enabled', false),
                debounceMs: cfg.get<number>('inlineCompletion.debounceMs', 1500),
                provider: cfg.get<string>('inlineCompletion.provider', ''),
                model: cfg.get<string>('inlineCompletion.model', ''),
                endpoint: cfg.get<string>('inlineCompletion.endpoint', ''),
            },
        };
    }

    /**
     * Get API key for a provider: SecretStorage first, then migrate from settings.json.
     */
    async getKeyForProvider(providerId: string): Promise<string> {
        // 1. Try SecretStorage
        let key = await this.keyManager.getKey(providerId);
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
     * Cancel any in-progress generation.
     */
    cancel(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
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
        const model = options?.model ?? getEffectiveModel(providerId, config.model);

        const request: ChatCompletionRequest = {
            model,
            messages,
            tools: options?.tools,
            tool_choice: options?.tools && options.tools.length > 0 ? 'auto' : undefined,
            temperature: options?.temperature ?? 0.3,
            max_tokens: options?.maxTokens ?? 4096,
            stream: false,
        };

        this.abortController = new AbortController();

        try {
            if (provider.isOpenAICompatible) {
                return await this.callOpenAICompatible(endpoint, apiKey, request, providerId);
            } else if (providerId === 'claude') {
                return await this.callClaude(endpoint, apiKey, request);
            } else {
                // Fallback to OpenAI-compatible
                return await this.callOpenAICompatible(endpoint, apiKey, request, providerId);
            }
        } finally {
            this.abortController = null;
        }
    }

    /**
     * Stream a chat completion. Yields partial content tokens.
     */
    async *chatCompletionStream(
        messages: ChatMessage[],
        options?: {
            tools?: ToolDefinition[];
            temperature?: number;
            maxTokens?: number;
            providerId?: string;
            model?: string;
        }
    ): AsyncGenerator<StreamChunk | ChatCompletionResponse> {
        const config = this.getConfig();
        const providerId = options?.providerId ?? config.provider;
        const provider = getProvider(providerId);

        // Ollama doesn't require an API key
        let apiKey = '';
        if (providerId !== 'ollama') {
            const key = await this.getKeyForProvider(providerId);
            if (!key) {
                throw new Error(`No API key configured for ${provider.name}.`);
            }
            apiKey = key;
        }

        const endpoint = getEffectiveEndpoint(providerId, config.endpoint);
        const model = options?.model ?? getEffectiveModel(providerId, config.model);

        // If provider doesn't support streaming or has tool calls, fall back to non-streaming
        if (!provider.supportsStreaming || (options?.tools && options.tools.length > 0)) {
            const response = await this.chatCompletion(messages, options);
            yield response;
            return;
        }

        const request: ChatCompletionRequest = {
            model,
            messages,
            temperature: options?.temperature ?? 0.3,
            max_tokens: options?.maxTokens ?? 4096,
            stream: true,
        };

        this.abortController = new AbortController();

        try {
            const url = providerId === 'claude'
                ? `${endpoint}/messages`
                : `${endpoint}/chat/completions`;

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };

            if (providerId === 'claude') {
                headers['x-api-key'] = apiKey;
                headers['anthropic-version'] = '2023-06-01';
            } else {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const body = providerId === 'claude'
                ? JSON.stringify(toClaudeRequest(request))
                : JSON.stringify(request);

            const response = await fetch(url, {
                method: 'POST',
                headers,
                body,
                signal: this.abortController.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AI API error (${response.status}): ${errorText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();
            let buffer = '';

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

                    try {
                        const data = JSON.parse(trimmed.slice(6));
                        yield data as StreamChunk;
                    } catch {
                        // Skip malformed chunks
                    }
                }
            }
        } finally {
            this.abortController = null;
        }
    }

    // ─── Private API callers ─────────────────────────────────────────────────

    private async callOpenAICompatible(
        endpoint: string,
        apiKey: string,
        request: ChatCompletionRequest,
        providerId: string
    ): Promise<ChatCompletionResponse> {
        const url = `${endpoint}/chat/completions`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        };

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
            signal: this.abortController?.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${getProvider(providerId).name} API error (${response.status}): ${errorText}`);
        }

        return await response.json() as ChatCompletionResponse;
    }

    private async callClaude(
        endpoint: string,
        apiKey: string,
        request: ChatCompletionRequest
    ): Promise<ChatCompletionResponse> {
        const url = `${endpoint}/messages`;
        const claudeRequest = toClaudeRequest(request);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(claudeRequest),
            signal: this.abortController?.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Claude API error (${response.status}): ${errorText}`);
        }

        const claudeResponse = await response.json() as Record<string, unknown>;
        return fromClaudeResponse(claudeResponse);
    }

    // ─── Provider quick-configure UI ─────────────────────────────────────────

    /**
     * Show a quick-pick to let the user select and configure a provider.
     */
    async quickConfigureProvider(): Promise<void> {
        const items = Object.values(BUILTIN_PROVIDERS)
            .filter(p => p.id !== 'custom')
            .map(p => ({
                label: p.name,
                description: p.defaultModel,
                detail: `${p.models.length} models, up to ${(p.maxContextTokens / 1000).toFixed(0)}K context`,
                providerId: p.id,
            }));

        items.push({
            label: '🔧 自定义 (OpenAI Compatible)',
            description: 'Custom endpoint',
            detail: 'Configure a custom OpenAI-compatible API endpoint',
            providerId: 'custom',
        });

        const selected = await vs.window.showQuickPick(items, {
            title: 'Select AI Provider',
            placeHolder: 'Choose your AI provider...',
        });

        if (!selected) return;

        const providerId = selected.providerId;
        const provider = getProvider(providerId);

        // Set provider in config
        await vs.workspace.getConfiguration('cwtools.ai').update('provider', providerId, vs.ConfigurationTarget.Global);

        // For custom, also prompt for endpoint
        if (providerId === 'custom') {
            const endpoint = await vs.window.showInputBox({
                title: 'Custom API Endpoint',
                prompt: 'Enter your OpenAI-compatible API endpoint',
                placeHolder: 'https://your-server.com/v1',
                ignoreFocusOut: true,
            });
            if (endpoint) {
                await vs.workspace.getConfiguration('cwtools.ai').update('endpoint', endpoint, vs.ConfigurationTarget.Global);
            }
        }

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

            // For custom, allow manual entry too
            if (providerId === 'custom') {
                modelItems.push({
                    label: '✏️ 手动输入模型名...',
                    description: '',
                });
            }

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
        } else {
            // Custom provider: ask user to type model name
            const modelName = await vs.window.showInputBox({
                title: 'Model Name',
                prompt: 'Enter the model name',
                placeHolder: 'gpt-5.4',
                ignoreFocusOut: true,
            });
            if (modelName) {
                await vs.workspace.getConfiguration('cwtools.ai').update('model', modelName, vs.ConfigurationTarget.Global);
            }
        }

        // For Ollama/custom: ask context size
        if (providerId === 'ollama' || providerId === 'custom') {
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

        vs.window.showInformationMessage(`CWTools AI configured: ${provider.name} (${getEffectiveModel(providerId, '')})`);
    }
}
