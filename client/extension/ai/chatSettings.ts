/**
 * Eddy CWTool Code — Settings Manager
 *
 * Manages Provider configuration, API Key storage, model detection,
 * dynamic model management, and connection testing.
 * Extracted from chatPanel.ts for maintainability.
 */

import * as vs from 'vscode';
import type { PanelSettings, HostMessage } from './types';
import type { AIService } from './aiService';

type PostMessageFn = (msg: HostMessage) => void;

export let lastAISettingsWriteTime = 0;

export class ChatSettingsManager {
    constructor(
        private aiService: AIService,
        private postMessage: PostMessageFn
    ) {}

    /** Build the settingsData payload and send it to the WebView */
    async buildAndSendSettingsData(showPanel = false): Promise<void> {
        const { BUILTIN_PROVIDERS, fetchOllamaModels, MODEL_CONTEXT_TOKENS } = await import('./providers');
        const config = this.aiService.getConfig();

        const providers = Object.values(BUILTIN_PROVIDERS).map(p => ({
            id: p.id,
            name: p.name,
            models: p.models,
            defaultModel: p.defaultModel,
            requiresApiKey: p.id !== 'ollama',
            defaultEndpoint: p.endpoint,
            maxContextTokens: p.maxContextTokens,
            supportsFIM: p.supportsFIM,
            registerUrl: p.registerUrl,
        }));

        const hasKeyMap: Record<string, boolean> = {};
        for (const p of providers) {
            hasKeyMap[p.id] = !!(await this.aiService.getKeyForProvider(p.id));
        }

        const current: PanelSettings = {
            provider: config.provider,
            model: config.model,
            apiKey: '',
            endpoint: config.endpoint || '',
            maxContextTokens: config.maxContextTokens,
            agentFileWriteMode: config.agentFileWriteMode,
            forcedThinkingMode: config.forcedThinkingMode,
            reasoningEffort: config.reasoningEffort,
            braveSearchApiKey: (() => {
                const k = vs.workspace.getConfiguration('cwtools.ai').get<string>('braveSearchApiKey') ?? '';
                return k ? '••••••••' : '';
            })(),
            exaApiKey: (() => {
                const k = vs.workspace.getConfiguration('cwtools.ai').get<string>('exaApiKey') ?? '';
                return k ? '••••••••' : '';
            })(),
            inlineCompletion: {
                enabled: config.inlineCompletion.enabled,
                provider: config.inlineCompletion.provider,
                model: config.inlineCompletion.model,
                endpoint: config.inlineCompletion.endpoint,
                debounceMs: config.inlineCompletion.debounceMs,
                overlapStripping: config.inlineCompletion.overlapStripping,
            },
            mcp: {
                servers: config.mcp.servers
            }
        };

        let ollamaModels: Array<{ name: string; size: string; parameterSize?: string }> | undefined;
        if (config.provider === 'ollama') {
            const ep = config.endpoint || BUILTIN_PROVIDERS['ollama']?.endpoint;
            if (ep) ollamaModels = await fetchOllamaModels(ep);
        }

        const vscodeConfig = vs.workspace.getConfiguration('cwtools.ai');
        const dynamicModelsConfig = vscodeConfig.get<Record<string, string[]>>('dynamicModels') || {};
        const dynamicContexts = vscodeConfig.get<Record<string, number>>('dynamicModelsContext') || {};

        const { ALWAYS_THINKING_PREFIXES } = await import('./providers');

        this.postMessage({
            type: 'settingsData',
            providers: providers.map(p => ({
                ...p,
                hasKey: hasKeyMap[p.id] ?? false,
                models: Array.from(new Set([...p.models, ...(dynamicModelsConfig[p.id] || [])]))
            })) as any,
            current,
            ollamaModels,
            showPanel,
            modelContextTokens: { ...MODEL_CONTEXT_TOKENS, ...dynamicContexts },
            thinkingModelPrefixes: ALWAYS_THINKING_PREFIXES,
        });
    }

    async openSettingsPage(): Promise<void> {
        await this.buildAndSendSettingsData(true);
    }

    /** Quickly switch model from the input-area selector without opening settings page */
    async quickChangeModel(model: string): Promise<void> {
        if (!model) return;
        this.aiService.setModelOverride(model);
        await this.buildAndSendSettingsData();
    }

    async saveSettings(settings: PanelSettings): Promise<void> {
        const cfg = vs.workspace.getConfiguration('cwtools.ai');
        const { BUILTIN_PROVIDERS } = await import('./providers');

        const handleDynamicModel = async (providerId: string, modelId: string, contextTokens: number) => {
            const provider = BUILTIN_PROVIDERS[providerId];
            if (provider && providerId !== 'ollama' && modelId) {
                if (!provider.models.includes(modelId)) {
                    let currentDynamic = cfg.get<Record<string, string[]>>('dynamicModels') || {};
                    const providerDyns = currentDynamic[providerId] || [];
                    if (!providerDyns.includes(modelId)) {
                        providerDyns.push(modelId);
                        currentDynamic = { ...currentDynamic, [providerId]: providerDyns };
                        await cfg.update('dynamicModels', currentDynamic, vs.ConfigurationTarget.Global);
                    }
                    if (contextTokens > 0) {
                        let currContexts = cfg.get<Record<string, number>>('dynamicModelsContext') || {};
                        if (currContexts[modelId] !== contextTokens) {
                            currContexts = { ...currContexts, [modelId]: contextTokens };
                            await cfg.update('dynamicModelsContext', currContexts, vs.ConfigurationTarget.Global);
                        }
                    }
                }
            }
        };

        if (settings.model) {
            await handleDynamicModel(settings.provider, settings.model, settings.maxContextTokens || 0);
        }
        if (settings.inlineCompletion && settings.inlineCompletion.model) {
            await handleDynamicModel(settings.inlineCompletion.provider, settings.inlineCompletion.model, 0);
        }

        lastAISettingsWriteTime = Date.now();
        await cfg.update('provider', settings.provider, vs.ConfigurationTarget.Global);
        await cfg.update('model', settings.model, vs.ConfigurationTarget.Global);
        if (settings.apiKey && settings.apiKey.trim().length > 0) {
            await this.aiService.getKeyManager().setKey(settings.provider, settings.apiKey.trim());
            await cfg.update('apiKey', '', vs.ConfigurationTarget.Global);
        }
        if (settings.braveSearchApiKey && settings.braveSearchApiKey.trim().length > 0
            && !settings.braveSearchApiKey.startsWith('•')) {
            await cfg.update('braveSearchApiKey', settings.braveSearchApiKey.trim(), vs.ConfigurationTarget.Global);
        }
        if (settings.exaApiKey && settings.exaApiKey.trim().length > 0
            && !settings.exaApiKey.startsWith('•')) {
            await cfg.update('exaApiKey', settings.exaApiKey.trim(), vs.ConfigurationTarget.Global);
        }
        await cfg.update('endpoint', settings.endpoint, vs.ConfigurationTarget.Global);
        await cfg.update('maxContextTokens', settings.maxContextTokens, vs.ConfigurationTarget.Global);
        await cfg.update('agentFileWriteMode', settings.agentFileWriteMode, vs.ConfigurationTarget.Global);
        await cfg.update('forcedThinkingMode', settings.forcedThinkingMode, vs.ConfigurationTarget.Global);
        await cfg.update('reasoningEffort', settings.reasoningEffort, vs.ConfigurationTarget.Global);
        await cfg.update('enabled', true, vs.ConfigurationTarget.Global);
        if (settings.inlineCompletion) {
            await cfg.update('inlineCompletion.enabled', settings.inlineCompletion.enabled, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.provider', settings.inlineCompletion.provider, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.model', settings.inlineCompletion.model, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.endpoint', settings.inlineCompletion.endpoint, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.debounceMs', settings.inlineCompletion.debounceMs, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.overlapStripping', settings.inlineCompletion.overlapStripping, vs.ConfigurationTarget.Global);
        }

        if (settings.mcp?.servers) {
            await cfg.update('mcp.servers', settings.mcp.servers, vs.ConfigurationTarget.Global);
        }

        lastAISettingsWriteTime = Date.now();
        vs.window.showInformationMessage('Eddy CWTool Code 设置已保存，部分 MCP 连接更改可能需要重载窗口生效');
        await this.openSettingsPage();
    }

    async detectOllamaModels(endpoint: string): Promise<void> {
        const { fetchOllamaModels } = await import('./providers');
        const models = await fetchOllamaModels(endpoint || 'http://localhost:11434/v1');
        if (models.length > 0) {
            this.postMessage({ type: 'ollamaModels', models });
        } else {
            this.postMessage({ type: 'ollamaModels', models: [], error: '未检测到 Ollama 模型，请确认 Ollama 正在运行' });
        }
    }

    async fetchApiModels(providerId: string, endpointOverride: string, apiKeyOverride: string): Promise<void> {
        const { getEffectiveEndpoint } = await import('./providers');
        const saved = this.aiService.getConfig();
        const endpoint = endpointOverride || getEffectiveEndpoint(providerId, saved.endpoint);

        let apiKey = apiKeyOverride;
        if (!apiKey) apiKey = await this.aiService.getKeyForProvider(providerId) || '';

        if (!apiKey) {
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: '需要 API Key 才能拉取模型列表' });
            return;
        }

        if (providerId.startsWith('minimax') || providerId.startsWith('mimo') || providerId === 'opencode') {
            const { BUILTIN_PROVIDERS } = await import('./providers');
            const models = (BUILTIN_PROVIDERS[providerId]?.models || []).map(m => ({ id: m }));
            this.postMessage({ type: 'apiModelsFetched', providerId, models, error: '' });
            return;
        }

        try {
            const modelsUrl = endpoint.replace(/\/chat\/completions$/, '').replace(/\/+$/, '') + '/models';
            const res = await fetch(modelsUrl, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (res.ok) {
                const data = await res.json() as any;
                const modelList: any[] = Array.isArray(data)
                    ? data
                    : (Array.isArray(data?.data) ? data.data : null);
                if (modelList) {
                    const dynModels = modelList.map((m: any) => m.id);
                    const dynContexts: Record<string, number> = {};
                    const { getModelContextTokens } = await import('./providers');

                    modelList.forEach((m: any) => {
                        let c = m.context_length
                            || m.context_window
                            || m.max_context_length
                            || m.top_provider?.context_length
                            || 0;

                        if (!c && m.id) {
                            c = getModelContextTokens(m.id, providerId);
                        }

                        if (c) dynContexts[m.id] = c;
                    });

                    const apiHasContext = modelList.some((m: any) => m.context_length || m.context_window || m.top_provider?.context_length);
                    const inferredCount = Object.keys(dynContexts).length;
                    const ctxNote = apiHasContext
                        ? `（已从 API 获取 ${inferredCount} 个模型的上下文大小）`
                        : `（API 未返回上下文大小，已通过模型族推断 ${inferredCount}/${dynModels.length} 个）`;

                    this.postMessage({ type: 'apiModelsFetched', providerId, models: modelList, dynContexts, ctxNote });
                    return;
                }
            }
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: `接口返回未知数据结构 (状态码: ${res.status})` });
        } catch (e: unknown) {
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: String(e) });
        }
    }

    async deleteDynamicModel(providerId: string, modelId: string): Promise<void> {
        const vscodeConfig = vs.workspace.getConfiguration('cwtools.ai');
        const dynamicModelsConfig = vscodeConfig.get<Record<string, string[]>>('dynamicModels') || {};
        if (dynamicModelsConfig[providerId]) {
            dynamicModelsConfig[providerId] = dynamicModelsConfig[providerId].filter(m => m !== modelId);
            await vscodeConfig.update('dynamicModels', dynamicModelsConfig, vs.ConfigurationTarget.Global);
            vs.window.showInformationMessage(`✅ 已删除动态拉取的模型: ${modelId}`);
            await this.openSettingsPage();
        }
    }

    async testConnection(settings?: PanelSettings): Promise<void> {
        const { getEffectiveEndpoint } = await import('./providers');
        const saved = this.aiService.getConfig();
        const providerId = settings?.provider ?? saved.provider;
        const rawSettingsKey = settings?.apiKey ?? '';
        const apiKey = (rawSettingsKey && !rawSettingsKey.startsWith('\u2022'))
            ? rawSettingsKey
            : await this.aiService.getKeyForProvider(providerId);
        const endpoint = settings?.endpoint || getEffectiveEndpoint(providerId, saved.endpoint);
        const model = settings?.model || undefined;

        if (!providerId) {
            this.postMessage({ type: 'testConnectionResult', ok: false, message: '请先选择 Provider' });
            return;
        }
        if (providerId !== 'ollama' && !apiKey) {
            this.postMessage({ type: 'testConnectionResult', ok: false, message: '请填写 API Key' });
            return;
        }

        try {
            await this.aiService.chatCompletion(
                [{ role: 'user', content: 'Hi' }],
                { maxTokens: 5, providerId, model, apiKey, endpoint }
            );
            this.postMessage({ type: 'testConnectionResult', ok: true, message: '连接成功 ✅' });
        } catch (e: unknown) {
            const raw = e instanceof Error ? e.message : String(e);
            let friendly = raw;
            if (raw.includes('fetch failed') || raw.includes('ECONNREFUSED') || raw.includes('ETIMEDOUT')) {
                friendly = '网络连接失败 — 请检查网络或 Endpoint 地址是否正确';
            } else if (raw.includes('401') || raw.includes('Unauthorized') || raw.includes('invalid_api_key')) {
                friendly = 'API Key 无效或已过期';
            } else if (raw.includes('403') || raw.includes('Forbidden')) {
                friendly = 'API Key 权限不足';
            } else if (raw.includes('429')) {
                friendly = '请求过于频繁 (429) — Key 有效 ✅';
            } else if (raw.includes('404')) {
                friendly = 'Endpoint 地址不存在 (404) — 请检查 URL';
            }
            this.postMessage({ type: 'testConnectionResult', ok: false, message: '连接失败: ' + friendly });
        }
    }
}
