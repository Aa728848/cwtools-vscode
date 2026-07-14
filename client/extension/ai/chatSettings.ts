/**
 * Eddy CWTool Code — Settings Manager
 *
 * Manages Provider configuration, API Key storage, model detection,
 * dynamic model management, and connection testing.
 * Extracted from chatPanel.ts for maintainability.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { promisify } from 'util';
import type { PanelSettings, HostMessage, CustomApiFormat } from './types';
import type { AIService } from './aiService';
import { aiText } from './messages';
import { getProjectWorkspaceRoot } from './workspacePaths';
import {
    getSessionPermissionMode,
    isSessionFullAccess,
    sessionApprovalsReviewer,
    sessionFileWriteMode,
    setSessionPermissionMode,
} from './runner/sessionPermissions';
import { detectSandboxBackendAsync } from './runner/sandboxRunner';

const execAsync = promisify(cp.exec);

type PostMessageFn = (msg: HostMessage) => void;
const DEFAULT_CUSTOM_API_FORMAT: CustomApiFormat = 'openai-chat-completions';

function normalizeCustomApiFormatSetting(value: unknown): CustomApiFormat {
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

interface ModelsRequestCandidate {
    url: string;
    headers: Record<string, string>;
    label: string;
    providerFilter?: string;
    filterDeprecated?: boolean;
    merge?: boolean;
}

function normalizeModelEndpointBase(endpoint: string): string {
    return endpoint
        .replace(/\/chat\/completions\/?(?:\?.*)?$/i, '')
        .replace(/\/responses\/?(?:\?.*)?$/i, '')
        .replace(/\/messages\/?(?:\?.*)?$/i, '')
        .replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)(?:\?.*)?$/i, '')
        .replace(/\/models\/?(?:\?.*)?$/i, '')
        .replace(/\/+$/, '');
}

function uniqueModelRequests(candidates: ModelsRequestCandidate[]): ModelsRequestCandidate[] {
    const seen = new Set<string>();
    const result: ModelsRequestCandidate[] = [];
    for (const candidate of candidates) {
        const key = `${candidate.url}|${JSON.stringify(candidate.headers)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(candidate);
    }
    return result;
}

function buildVersionedModelEndpointBases(endpoint: string, versionPath = 'v1'): string[] {
    const cleanEndpoint = normalizeModelEndpointBase(endpoint);
    const isVersioned = /\/v\d+(?:beta|alpha)?$/i.test(cleanEndpoint);
    return isVersioned
        ? [cleanEndpoint]
        : [`${cleanEndpoint}/${versionPath}`, cleanEndpoint];
}

function buildModelsRequests(
    providerId: string,
    endpoint: string,
    apiKey: string,
    customApiFormat: CustomApiFormat
): ModelsRequestCandidate[] {
    const cleanEndpoint = normalizeModelEndpointBase(endpoint);
    if (providerId === 'opencode' || providerId === 'opencode-go') {
        return uniqueModelRequests([
            {
                url: 'https://models.dev/api.json',
                headers: { Accept: 'application/json' },
                label: 'models.dev metadata',
                providerFilter: providerId,
                filterDeprecated: true,
                merge: true,
            },
            {
                url: `${cleanEndpoint}/models`,
                headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
                label: 'OpenCode /models',
                merge: true,
            },
        ]);
    }
    if (providerId === 'github') {
        return [{
            url: 'https://models.github.ai/catalog/models',
            headers: { Accept: 'application/json' },
            label: 'GitHub Models catalog',
        }];
    }
    if (providerId === 'custom' && customApiFormat === 'gemini-generate-content') {
        const url = `${cleanEndpoint.endsWith('/models') ? cleanEndpoint : `${cleanEndpoint}/models`}${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
        return [{ url, headers: apiKey ? { 'x-goog-api-key': apiKey } : {}, label: 'Gemini /models' }];
    }
    if (providerId === 'custom' && customApiFormat === 'anthropic-messages') {
        const authCandidates = (url: string, route: string): ModelsRequestCandidate[] => {
            if (!apiKey) return [{ url, headers: {}, label: `${route} without auth` }];
            return [
                {
                    url,
                    headers: { Accept: 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                    label: `${route} with x-api-key`,
                },
                {
                    url,
                    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' },
                    label: `${route} with bearer`,
                },
                { url, headers: { Accept: 'application/json' }, label: `${route} without auth` },
            ];
        };
        return uniqueModelRequests(buildVersionedModelEndpointBases(endpoint)
            .flatMap(base => [
                ...authCandidates(`${base}/models`, `Anthropic ${base.replace(cleanEndpoint, '') || ''}/models`),
                ...authCandidates(`${base}/providers`, `Anthropic ${base.replace(cleanEndpoint, '') || ''}/providers`),
            ]));
    }
    return [{
        url: `${cleanEndpoint}/models`,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        label: 'OpenAI /models',
    }];
}

function normalizeModelList(data: any, customApiFormat: CustomApiFormat, providerFilter?: string): any[] {
    if (providerFilter && data && typeof data === 'object' && data[providerFilter]) {
        return normalizeModelList(data[providerFilter], customApiFormat);
    }
    const normalizeModel = (m: any): any => {
        if (typeof m === 'string') return { id: m };
        if (m && typeof m === 'object') {
            return {
                ...m,
                id: m.id ?? (typeof m.name === 'string' ? m.name.replace(/^models\//, '') : undefined) ?? m.model,
            };
        }
        return {};
    };
    const normalizeProviderModels = (providers: any): any[] => {
        const entries = Array.isArray(providers)
            ? providers.map((p: any) => [p?.name ?? p?.id, p] as const)
            : (providers && typeof providers === 'object' ? Object.entries(providers) : []);
        const modelsFromProvider = (providerValue: any): any[] => {
            if (Array.isArray(providerValue)) return providerValue;
            if (Array.isArray(providerValue?.models)) return providerValue.models;
            if (providerValue?.models && typeof providerValue.models === 'object') return Object.values(providerValue.models);
            if (Array.isArray(providerValue?.data)) return providerValue.data;
            return [];
        };
        return entries
            .flatMap(([providerName, providerValue]: any) => {
                const models = modelsFromProvider(providerValue);
                return models.map((m: any) => typeof m === 'string'
                    ? { id: m, provider: providerName }
                    : { ...m, provider: m.provider ?? providerName });
            })
            .map(normalizeModel)
            .filter((m: any) => m.id);
    };

    const list = Array.isArray(data)
        ? data
        : (Array.isArray(data?.data) ? data.data : undefined);
    if (list && list.some((p: any) => Array.isArray(p?.models))) {
        return normalizeProviderModels(list);
    }
    if (list) return list.map(normalizeModel).filter((m: any) => m.id);
    if (Array.isArray(data?.models)) {
        if (customApiFormat === 'gemini-generate-content') {
            return data.models
                .filter((m: any) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
                .map(normalizeModel)
                .filter((m: any) => m.id);
        }
        return data.models.map(normalizeModel).filter((m: any) => m.id);
    }
    if (data?.models && typeof data.models === 'object') {
        return Object.values(data.models).map(normalizeModel).filter((m: any) => m.id);
    }
    const providerModels = normalizeProviderModels(data?.providers ?? data?.provider);
    if (providerModels.length > 0) return providerModels;
    return [];
}

function readModelContextTokens(model: any): number {
    const raw = model?.context_length
        ?? model?.context_window
        ?? model?.max_context_length
        ?? model?.limit?.context
        ?? model?.limits?.context
        ?? model?.limits?.max_input_tokens
        ?? model?.top_provider?.context_length
        ?? 0;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

const OPENCODE_GO_DEPRECATED_MODELS = new Set([
    'glm-5',
    'hy3-preview',
    'kimi-k2.5',
    'mimo-v2-pro',
    'mimo-v2-omni',
    'mimo-v2-flash',
    'minimax-m2.5',
    'qwen3.5-plus',
]);

function isDeprecatedProviderModel(providerId: string, modelId: string): boolean {
    if (providerId === 'opencode-go') {
        return OPENCODE_GO_DEPRECATED_MODELS.has(modelId.toLowerCase());
    }
    return false;
}

export let lastAISettingsWriteTime = 0;

export class ChatSettingsManager {
    constructor(
        private aiService: AIService,
        private postMessage: PostMessageFn,
        private globalStoragePath?: string
    ) {}

    /** Build the settingsData payload and send it to the WebView */
    async buildAndSendSettingsData(showPanel = false, targetSurface?: 'chat' | 'manager'): Promise<void> {
        const { BUILTIN_PROVIDERS, fetchOllamaModels, MODEL_CONTEXT_TOKENS } = await import('./providers');
        // Fold any legacy global endpoint into the per-provider map before reading config.
        await this.aiService.migrateLegacyEndpoint();
        const config = this.aiService.getConfig();
        const detectedSandbox = await detectSandboxBackendAsync();

        const providers = Object.values(BUILTIN_PROVIDERS).map(p => {
            const customNonFim = p.id === 'custom' && config.customApiFormat !== 'openai-chat-completions';
            return {
                id: p.id,
                name: p.name,
                models: p.models,
                defaultModel: p.defaultModel,
                requiresApiKey: p.requiresApiKey,
                defaultEndpoint: p.endpoint,
                userEndpoint: this.aiService.getEndpointForProvider(p.id),
                maxContextTokens: p.maxContextTokens,
                supportsFIM: customNonFim ? false : p.supportsFIM,
                registerUrl: p.registerUrl,
            };
        });

        const hasKeyMap: Record<string, boolean> = {};
        for (const p of providers) {
            hasKeyMap[p.id] = !!(await this.aiService.getKeyForProvider(p.id));
        }

        await this.migrateLegacyWebSearchKeys();
        const webConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai.web');
        const webKeys: Partial<Record<'brave' | 'exa' | 'tavily' | 'serper' | 'serpapi', string>> = {};
        for (const provider of ['brave', 'exa', 'tavily', 'serper', 'serpapi'] as const) {
            webKeys[provider] = await this.aiService.getKeyManager().getKey(`web.${provider}`) ? '••••••••' : '';
        }

        const current: PanelSettings = {
            provider: config.provider,
            model: config.model,
            apiKey: '',
            endpoint: config.endpoint || '',
            customApiFormat: config.customApiFormat,
            maxContextTokens: config.maxContextTokens,
            agentFileWriteMode: sessionFileWriteMode(getProjectWorkspaceRoot()) ?? config.agentFileWriteMode,
            approvals: {
                reviewer: sessionApprovalsReviewer(getProjectWorkspaceRoot())
                    ?? vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<'user' | 'auto_review'>('approvals.reviewer', 'user'),
            },
            securitySandboxDisabled: getSessionPermissionMode(getProjectWorkspaceRoot())
                ? isSessionFullAccess(getProjectWorkspaceRoot())
                : vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<boolean>('developer.disableSecuritySandbox') === true,
            sandboxBackend: detectedSandbox
                ? { available: true, backend: detectedSandbox.backend, message: aiText(`Enforced command sandbox: ${detectedSandbox.backend}`, `强制命令沙箱：${detectedSandbox.backend}`) }
                : { available: false, message: process.platform === 'win32'
                    ? aiText('No enforced Windows command backend is ready. Install bubblewrap in WSL2, use a Dev Container, configure a verified native helper, or explicitly approve a terminal run.', 'Windows 强制命令后端尚未就绪。请在 WSL2 中安装 bubblewrap、使用开发容器、配置已验证的原生 helper，或明确批准终端运行。')
                    : aiText('No supported OS command sandbox backend is available. Captured commands fail closed.', '没有可用的操作系统命令沙箱后端。捕获命令将安全拒绝。') },
            reasoningEffort: config.reasoningEffort,
            webAccess: {
                mode: webConfig.get<'disabled' | 'indexed' | 'live'>('mode', 'indexed'),
                provider: webConfig.get<NonNullable<PanelSettings['webAccess']>['provider']>('provider', 'auto'),
                contextSize: webConfig.get<'low' | 'medium' | 'high'>('contextSize', 'medium'),
                fallbackProviders: webConfig.get<string[]>('fallbackProviders', []).join(', '),
                allowedDomains: webConfig.get<string[]>('allowedDomains', []).join(', '),
                blockedDomains: webConfig.get<string[]>('blockedDomains', []).join(', '),
                country: webConfig.get<string>('country', ''),
                searxngEndpoint: webConfig.get<string>('searxngEndpoint', ''),
                openaiModel: webConfig.get<string>('openaiModel', ''),
                cacheTtlMs: webConfig.get<number>('cacheTtlMs', 300_000),
                allowSyntheticProxyAddresses: webConfig.get<boolean>('allowSyntheticProxyAddresses', false),
                keys: webKeys,
            },
            inlineCompletion: {
                enabled: config.inlineCompletion.enabled,
                provider: config.inlineCompletion.provider,
                model: config.inlineCompletion.model,
                endpoint: config.inlineCompletion.endpoint,
                debounceMs: config.inlineCompletion.debounceMs,
                maxTokens: config.inlineCompletion.maxTokens,
                contextBeforeLines: config.inlineCompletion.contextBeforeLines,
                contextAfterLines: config.inlineCompletion.contextAfterLines,
                includeMcpContext: config.inlineCompletion.includeMcpContext,
                mcpCacheTtlMs: config.inlineCompletion.mcpCacheTtlMs,
                requestTimeoutMs: config.inlineCompletion.requestTimeoutMs,
                lspFastPath: config.inlineCompletion.lspFastPath,
                overlapStripping: config.inlineCompletion.overlapStripping,
            },
            translationPreview: {
                provider: config.translationPreview.provider,
                model: config.translationPreview.model,
            },
            mcp: {
                servers: config.mcp.servers
            },
            orchestrator: {
                agentModels: vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<Record<string, { provider: string; model: string }>>('orchestrator.agentModels') || undefined,
            },
        };

        let ollamaModels: Array<{ name: string; size: string; parameterSize?: string }> | undefined;
        if (config.provider === 'ollama') {
            const ep = config.endpoint || BUILTIN_PROVIDERS['ollama']?.endpoint;
            if (ep) ollamaModels = await fetchOllamaModels(ep);
        }

        const vscodeConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
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
            targetSurface,
            modelContextTokens: { ...MODEL_CONTEXT_TOKENS, ...dynamicContexts },
            thinkingModelPrefixes: ALWAYS_THINKING_PREFIXES,
        });
    }

    async openSettingsPage(targetSurface?: 'chat' | 'manager'): Promise<void> {
        await this.buildAndSendSettingsData(true, targetSurface);
    }

    /** Quickly switch model from the input-area selector without opening settings page */
    async quickChangeModel(model: string): Promise<void> {
        if (!model) return;
        this.aiService.setModelOverride(model);
        await this.buildAndSendSettingsData();
    }

    /** Quickly switch reasoning effort for the active extension session. */
    async quickChangeReasoningEffort(effort: 'low' | 'medium' | 'high' | 'max'): Promise<void> {
        this.aiService.setReasoningEffortOverride(effort);
        await this.buildAndSendSettingsData();
    }

    /**
     * Quick ladder from the chat composer: confirm < auto < auto_review < full.
     * auto_review = auto write + read-only LLM reviewer at the approval boundary.
     * full = sandbox and approval boundaries removed for this workspace
     * (stellarisLanguageServices.ai.developer.disableSecuritySandbox); calls are still logged.
     * The tier fully determines all underlying settings.
     */
    async quickChangeWriteMode(mode: 'confirm' | 'auto' | 'auto_review' | 'full'): Promise<void> {
        setSessionPermissionMode(getProjectWorkspaceRoot(), mode);
        await this.buildAndSendSettingsData();
    }

    async saveSettings(settings: PanelSettings, targetSurface?: 'chat' | 'manager'): Promise<void> {
        const cfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
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
        if (settings.translationPreview?.provider && settings.translationPreview.model) {
            await handleDynamicModel(settings.translationPreview.provider, settings.translationPreview.model, 0);
        }

        lastAISettingsWriteTime = Date.now();
        await cfg.update('provider', settings.provider, vs.ConfigurationTarget.Global);
        await cfg.update('model', settings.model, vs.ConfigurationTarget.Global);
        await cfg.update('customApiFormat', normalizeCustomApiFormatSetting(settings.customApiFormat), vs.ConfigurationTarget.Global);
        if (settings.apiKey !== undefined) {
            const trimmedKey = settings.apiKey.trim();
            if (trimmedKey.length > 0 && !trimmedKey.startsWith('•')) {
                await this.aiService.getKeyManager().setKey(settings.provider, trimmedKey);
                await this.clearLegacyApiKeySettings();
            }
        }
        if (settings.webAccess) {
            const webCfg = vs.workspace.getConfiguration('stellarisLanguageServices.ai.web');
            const splitList = (value: string) => Array.from(new Set(value.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean)));
            await webCfg.update('mode', settings.webAccess.mode, vs.ConfigurationTarget.Global);
            await webCfg.update('provider', settings.webAccess.provider, vs.ConfigurationTarget.Global);
            await webCfg.update('contextSize', settings.webAccess.contextSize, vs.ConfigurationTarget.Global);
            await webCfg.update('fallbackProviders', splitList(settings.webAccess.fallbackProviders), vs.ConfigurationTarget.Global);
            await webCfg.update('allowedDomains', splitList(settings.webAccess.allowedDomains), vs.ConfigurationTarget.Global);
            await webCfg.update('blockedDomains', splitList(settings.webAccess.blockedDomains), vs.ConfigurationTarget.Global);
            await webCfg.update('country', settings.webAccess.country.trim(), vs.ConfigurationTarget.Global);
            await webCfg.update('searxngEndpoint', settings.webAccess.searxngEndpoint.trim(), vs.ConfigurationTarget.Global);
            await webCfg.update('openaiModel', settings.webAccess.openaiModel.trim(), vs.ConfigurationTarget.Global);
            await webCfg.update('cacheTtlMs', Math.max(0, settings.webAccess.cacheTtlMs || 0), vs.ConfigurationTarget.Global);
            await webCfg.update('allowSyntheticProxyAddresses', settings.webAccess.allowSyntheticProxyAddresses === true, vs.ConfigurationTarget.Global);
            for (const provider of ['brave', 'exa', 'tavily', 'serper', 'serpapi'] as const) {
                const key = settings.webAccess.keys?.[provider]?.trim() ?? '';
                if (key === '__DELETE__') await this.aiService.getKeyManager().deleteKey(`web.${provider}`);
                else if (key && !key.startsWith('•')) await this.aiService.getKeyManager().setKey(`web.${provider}`, key);
            }
        }
        // Endpoints are stored per-provider so switching providers cannot leak an
        // endpoint into another provider. The legacy global `endpoint` is retired.
        {
            const map = { ...(cfg.get<Record<string, string>>('providerEndpoints', {}) || {}) };
            const trimmed = (settings.endpoint || '').trim();
            if (trimmed) map[settings.provider] = trimmed; else delete map[settings.provider];
            await cfg.update('providerEndpoints', map, vs.ConfigurationTarget.Global);
            await cfg.update('endpoint', undefined, vs.ConfigurationTarget.Global);
        }
        await cfg.update('maxContextTokens', settings.maxContextTokens, vs.ConfigurationTarget.Global);
        await cfg.update('agentFileWriteMode', settings.agentFileWriteMode, vs.ConfigurationTarget.Global);
        if (settings.approvals?.reviewer) {
            await cfg.update('approvals.reviewer', settings.approvals.reviewer, vs.ConfigurationTarget.Global);
        }
        await cfg.update('reasoningEffort', settings.reasoningEffort, vs.ConfigurationTarget.Global);
        await cfg.update('enabled', true, vs.ConfigurationTarget.Global);
        if (settings.inlineCompletion) {
            await cfg.update('inlineCompletion.enabled', settings.inlineCompletion.enabled, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.provider', settings.inlineCompletion.provider, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.model', settings.inlineCompletion.model, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.endpoint', settings.inlineCompletion.endpoint, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.debounceMs', settings.inlineCompletion.debounceMs, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.maxTokens', settings.inlineCompletion.maxTokens, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.contextBeforeLines', settings.inlineCompletion.contextBeforeLines, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.contextAfterLines', settings.inlineCompletion.contextAfterLines, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.includeMcpContext', settings.inlineCompletion.includeMcpContext, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.mcpCacheTtlMs', settings.inlineCompletion.mcpCacheTtlMs, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.requestTimeoutMs', settings.inlineCompletion.requestTimeoutMs, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.lspFastPath', settings.inlineCompletion.lspFastPath, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.overlapStripping', settings.inlineCompletion.overlapStripping, vs.ConfigurationTarget.Global);
        }
        if (settings.translationPreview) {
            const translationProvider = settings.translationPreview.provider || '';
            await cfg.update('translationPreview.provider', translationProvider, vs.ConfigurationTarget.Global);
            await cfg.update('translationPreview.model', translationProvider ? (settings.translationPreview.model || '') : '', vs.ConfigurationTarget.Global);
        }

        if (settings.mcp?.servers) {
            await cfg.update('mcp.servers', settings.mcp.servers, vs.ConfigurationTarget.Global);
        }

        //Coordination mode sub-Agent model configuration persistence
        if (settings.orchestrator?.agentModels) {
            await cfg.update('orchestrator.agentModels', settings.orchestrator.agentModels, vs.ConfigurationTarget.Global);
        } else {
            //Clear existing configurations (users revert to all inheritance)
            await cfg.update('orchestrator.agentModels', undefined, vs.ConfigurationTarget.Global);
        }

        lastAISettingsWriteTime = Date.now();
        vs.window.showInformationMessage(aiText(
            'Eddy CWTool Code settings saved. Some MCP connection changes may require reloading the window.',
            'Eddy CWTool Code 设置已保存，部分 MCP 连接更改可能需要重载窗口生效',
        ));
        await this.openSettingsPage(targetSurface);
    }

    async deleteApiKey(providerId: string, targetSurface?: 'chat' | 'manager'): Promise<void> {
        if (!providerId) return;
        const { getProvider } = await import('./providers');
        const provider = getProvider(providerId);
        const removeKeyLabel = aiText('Remove Key', '移除 Key');
        const confirmed = await vs.window.showWarningMessage(
            aiText(`Remove the saved API key for ${provider.name}?`, `确定移除 ${provider.name} 已保存的 API Key？`),
            { modal: true },
            removeKeyLabel
        );
        if (confirmed !== removeKeyLabel) {
            await this.openSettingsPage(targetSurface);
            return;
        }

        await this.aiService.getKeyManager().deleteKey(providerId);
        await this.clearLegacyApiKeySettings();

        vs.window.showInformationMessage(aiText(`${provider.name} API key removed.`, `${provider.name} API Key 已移除。`));
        await this.openSettingsPage(targetSurface);
    }

    private async migrateLegacyWebSearchKeys(): Promise<void> {
        const mappings = [
            { setting: 'braveSearchApiKey', secret: 'web.brave' },
            { setting: 'exaApiKey', secret: 'web.exa' },
        ] as const;
        const keyManager = this.aiService.getKeyManager();
        const configs: Array<{ config: vs.WorkspaceConfiguration; target: vs.ConfigurationTarget }> = [
            { config: vs.workspace.getConfiguration('stellarisLanguageServices.ai'), target: vs.ConfigurationTarget.Global },
            { config: vs.workspace.getConfiguration('stellarisLanguageServices.ai'), target: vs.ConfigurationTarget.Workspace },
            ...(vs.workspace.workspaceFolders ?? []).map(folder => ({
                config: vs.workspace.getConfiguration('stellarisLanguageServices.ai', folder.uri),
                target: vs.ConfigurationTarget.WorkspaceFolder,
            })),
        ];
        for (const mapping of mappings) {
            let stored = await keyManager.getKey(mapping.secret);
            for (const { config } of configs) {
                const legacy = config.get<string>(mapping.setting, '').trim();
                if (legacy && !stored) {
                    await keyManager.setKey(mapping.secret, legacy);
                    stored = legacy;
                }
            }
            await Promise.all(configs.map(async ({ config, target }) => {
                try { await config.update(mapping.setting, undefined, target); } catch { /* scope may not exist */ }
            }));
        }
    }

    private async clearLegacyApiKeySettings(): Promise<void> {
        const baseConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
        const clear = async (config: vs.WorkspaceConfiguration, target: vs.ConfigurationTarget): Promise<void> => {
            try {
                await config.update('apiKey', undefined, target);
            } catch {
                // Some targets may be unavailable depending on whether a workspace/folder is open.
            }
        };

        const updates: Promise<void>[] = [
            clear(baseConfig, vs.ConfigurationTarget.Global),
            clear(baseConfig, vs.ConfigurationTarget.Workspace),
        ];

        for (const folder of vs.workspace.workspaceFolders ?? []) {
            const folderConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai', folder.uri);
            updates.push(clear(folderConfig, vs.ConfigurationTarget.WorkspaceFolder));
        }

        await Promise.all(updates);
    }

    async detectOllamaModels(endpoint: string): Promise<void> {
        const { fetchOllamaModels } = await import('./providers');
        const models = await fetchOllamaModels(endpoint || 'http://localhost:11434/v1');
        if (models.length > 0) {
            this.postMessage({ type: 'ollamaModels', models });
        } else {
            this.postMessage({
                type: 'ollamaModels',
                models: [],
                error: aiText('No Ollama models detected. Make sure Ollama is running.', '未检测到 Ollama 模型，请确认 Ollama 正在运行'),
            });
        }
    }

    async fetchApiModels(providerId: string, endpointOverride: string, apiKeyOverride: string, customApiFormatOverride?: CustomApiFormat): Promise<void> {
        const { getEffectiveEndpoint, getProvider } = await import('./providers');
        const saved = this.aiService.getConfig();
        const provider = getProvider(providerId);
        const endpoint = endpointOverride || getEffectiveEndpoint(providerId, this.aiService.getEndpointForProvider(providerId));
        const customApiFormat = normalizeCustomApiFormatSetting(customApiFormatOverride ?? saved.customApiFormat);

        let apiKey = apiKeyOverride;
        if (!apiKey) apiKey = await this.aiService.getKeyForProvider(providerId) || '';

        if (!endpoint) {
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: aiText('Please enter an endpoint first', '请先填写 Endpoint') });
            return;
        }

        if (provider.requiresApiKey && !apiKey && providerId !== 'custom' && providerId !== 'opencode' && providerId !== 'opencode-go') {
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: 'API Key is required to fetch models' });
            return;
        }

        try {
            const candidates = buildModelsRequests(providerId, endpoint, apiKey, customApiFormat);
            const errors: string[] = [];
            const aggregateModels = new Map<string, any>();
            const aggregateContexts: Record<string, number> = {};
            const aggregateLabels: string[] = [];
            const deprecatedModelIds = new Set<string>();
            let aggregateHasApiContext = false;
            const { getModelContextTokens } = await import('./providers');

            const collectModels = (modelList: any[], candidate: ModelsRequestCandidate) => {
                const uniqueById = new Map<string, any>();
                for (const model of modelList) {
                    if (model.id && !uniqueById.has(model.id)) uniqueById.set(model.id, model);
                }
                const normalizedModelList = Array.from(uniqueById.values());
                const dynContexts: Record<string, number> = {};
                let apiHasContext = false;

                normalizedModelList.forEach((m: any) => {
                    let c = readModelContextTokens(m);
                    const builtinContext = m.id ? getModelContextTokens(m.id, providerId) : 0;
                    if (c) apiHasContext = true;

                    if (builtinContext > c) {
                        c = builtinContext;
                    }

                    if (c) dynContexts[m.id] = c;
                });

                if (candidate.merge) {
                    for (const model of normalizedModelList) {
                        if (!aggregateModels.has(model.id)) aggregateModels.set(model.id, model);
                    }
                    for (const [modelId, contextTokens] of Object.entries(dynContexts)) {
                        if (!(modelId in aggregateContexts)) aggregateContexts[modelId] = contextTokens;
                    }
                    if (apiHasContext) aggregateHasApiContext = true;
                    aggregateLabels.push(candidate.label);
                }

                return { normalizedModelList, dynContexts, apiHasContext };
            };

            for (const candidate of candidates) {
                let res: Response;
                try {
                    res = await fetch(candidate.url, { headers: candidate.headers });
                } catch (e: unknown) {
                    errors.push(`${candidate.label}: ${e instanceof Error ? e.message : String(e)}`);
                    continue;
                }
                if (!res.ok) {
                    errors.push(`${candidate.label}: ${res.status}`);
                    continue;
                }
                let data: any;
                try {
                    data = await res.json() as any;
                } catch {
                    errors.push(`${candidate.label}: non-JSON response`);
                    continue;
                }
                let modelList: any[] = normalizeModelList(data, customApiFormat, candidate.providerFilter);
                if (candidate.filterDeprecated) {
                    for (const model of modelList) {
                        if (model?.status === 'deprecated' && model.id) deprecatedModelIds.add(model.id);
                    }
                    modelList = modelList.filter((m: any) => m.status !== 'deprecated');
                }
                modelList = modelList.filter((m: any) => !deprecatedModelIds.has(m.id) && !isDeprecatedProviderModel(providerId, m.id));
                if (modelList.length === 0) {
                    errors.push(`${candidate.label}: empty or unknown response`);
                    continue;
                }
                const { normalizedModelList, dynContexts, apiHasContext } = collectModels(modelList, candidate);
                if (candidate.merge) continue;

                const dynModels = normalizedModelList.map((m: any) => m.id).filter(Boolean);
                const inferredCount = Object.keys(dynContexts).length;
                const ctxNote = apiHasContext
                    ? `(context tokens from API for ${inferredCount} models; ${candidate.label})`
                    : `(context tokens inferred for ${inferredCount}/${dynModels.length} models; ${candidate.label})`;

                this.postMessage({ type: 'apiModelsFetched', providerId, models: normalizedModelList, dynContexts, ctxNote });
                return;
            }
            if (aggregateModels.size > 0) {
                const normalizedModelList = Array.from(aggregateModels.values());
                const dynModels = normalizedModelList.map((m: any) => m.id).filter(Boolean);
                const inferredCount = Object.keys(aggregateContexts).length;
                const labels = aggregateLabels.join(' + ');
                const ctxNote = aggregateHasApiContext
                    ? `(context tokens from API for ${inferredCount} models; ${labels})`
                    : `(context tokens inferred for ${inferredCount}/${dynModels.length} models; ${labels})`;
                this.postMessage({ type: 'apiModelsFetched', providerId, models: normalizedModelList, dynContexts: aggregateContexts, ctxNote });
                return;
            }
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: `Could not fetch model list from discovery endpoints: ${errors.join('; ')}` });
        } catch (e: unknown) {
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: String(e) });
        }
    }

    async deleteDynamicModel(providerId: string, modelId: string): Promise<void> {
        const vscodeConfig = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
        const dynamicModelsConfig = vscodeConfig.get<Record<string, string[]>>('dynamicModels') || {};
        if (dynamicModelsConfig[providerId]) {
            dynamicModelsConfig[providerId] = dynamicModelsConfig[providerId].filter(m => m !== modelId);
            await vscodeConfig.update('dynamicModels', dynamicModelsConfig, vs.ConfigurationTarget.Global);
            vs.window.showInformationMessage(aiText(`Deleted fetched model: ${modelId}`, `已删除动态拉取的模型: ${modelId}`));
            await this.openSettingsPage();
        }
    }

    async testConnection(settings?: PanelSettings): Promise<void> {
        const { getEffectiveEndpoint, getProvider } = await import('./providers');
        const saved = this.aiService.getConfig();
        const providerId = settings?.provider ?? saved.provider;
        const provider = getProvider(providerId);
        const rawSettingsKey = settings?.apiKey ?? '';
        const apiKey = (rawSettingsKey && !rawSettingsKey.startsWith('\u2022'))
            ? rawSettingsKey
            : await this.aiService.getKeyForProvider(providerId);
        const endpoint = settings?.endpoint || getEffectiveEndpoint(providerId, this.aiService.getEndpointForProvider(providerId));
        const customApiFormat = normalizeCustomApiFormatSetting(settings?.customApiFormat ?? saved.customApiFormat);
        const model = settings?.model || undefined;

        if (!providerId) {
            this.postMessage({ type: 'testConnectionResult', ok: false, message: aiText('Select a provider first', '请先选择 Provider') });
            return;
        }
        if (!endpoint) {
            this.postMessage({ type: 'testConnectionResult', ok: false, message: aiText('Enter an endpoint', '请填写 Endpoint') });
            return;
        }
        if (provider.requiresApiKey && !apiKey) {
            this.postMessage({ type: 'testConnectionResult', ok: false, message: aiText('Enter an API key', '请填写 API Key') });
            return;
        }

        try {
            await this.aiService.chatCompletion(
                [{ role: 'user', content: 'Hi' }],
                { maxTokens: 5, providerId, model, apiKey, endpoint, customApiFormat }
            );
            this.postMessage({ type: 'testConnectionResult', ok: true, message: aiText('Connection successful', '连接成功 ✓') });
        } catch (e: unknown) {
            const raw = e instanceof Error ? e.message : String(e);
            let friendly = raw;
            if (raw.includes('fetch failed') || raw.includes('ECONNREFUSED') || raw.includes('ETIMEDOUT')) {
                friendly = aiText('Network connection failed - check the network or endpoint URL', '网络连接失败 — 请检查网络或 Endpoint 地址是否正确');
            } else if (raw.includes('401') || raw.includes('Unauthorized') || raw.includes('invalid_api_key')) {
                friendly = aiText('API key is invalid or expired', 'API Key 无效或已过期');
            } else if (raw.includes('403') || raw.includes('Forbidden')) {
                friendly = aiText('API key does not have sufficient permissions', 'API Key 权限不足');
            } else if (raw.includes('429')) {
                friendly = aiText('Too many requests (429) - the key is valid', '请求过于频繁 (429) — Key 有效 ✓');
            } else if (raw.includes('404')) {
                friendly = aiText('Endpoint not found (404) - check the URL', 'Endpoint 地址不存在 (404) — 请检查 URL');
            }
            this.postMessage({ type: 'testConnectionResult', ok: false, message: aiText('Connection failed: ', '连接失败: ') + friendly });
        }
    }

    async getSkillsList(): Promise<void> {
        if (!this.globalStoragePath) {
            this.postMessage({ type: 'skillsList', skills: [] });
            return;
        }
        try {
            const skillsDir = path.join(this.globalStoragePath, '.agents', 'skills');
            if (!fs.existsSync(skillsDir)) {
                this.postMessage({ type: 'skillsList', skills: [] });
                return;
            }
            const dirs = await fs.promises.readdir(skillsDir, { withFileTypes: true });
            const skills = dirs.filter(d => d.isDirectory()).map(d => d.name);
            this.postMessage({ type: 'skillsList', skills });
        } catch {
            this.postMessage({ type: 'skillsList', skills: [] });
        }
    }

    async installSkill(source: string): Promise<void> {
        if (!this.globalStoragePath) {
            vs.window.showErrorMessage(aiText('Could not access extension storage path; installation failed', '无法获取插件存储路径，安装失败'));
            this.postMessage({ type: 'skillInstallComplete', success: false });
            return;
        }
        try {
            // Ensure global storage exists
            const agentsSkillsDir = path.join(this.globalStoragePath, '.agents', 'skills');
            if (!fs.existsSync(agentsSkillsDir)) {
                await fs.promises.mkdir(agentsSkillsDir, { recursive: true });
            }

            if (path.isAbsolute(source) && fs.existsSync(source)) {
                const stat = await fs.promises.stat(source);
                if (stat.isDirectory()) {
                    const skillName = path.basename(source);
                    const destDir = path.join(agentsSkillsDir, skillName);
                    await fs.promises.cp(source, destDir, { recursive: true, force: true });
                    vs.window.showInformationMessage(aiText(`Local agent skill [${skillName}] installed`, `本地 Agent 技能 [${skillName}] 已成功安装`));
                } else {
                    throw new Error(aiText('Local path must be a folder containing SKILL.md', '本地路径必须是一个包含 SKILL.md 的文件夹'));
                }
            } else {
                // Run npx skills add. npx will create .agents/skills in the cwd (without -g)
                await execAsync(`npx skills add ${source} -y`, { cwd: this.globalStoragePath });
                vs.window.showInformationMessage(aiText(`Agent skill ${source} installed`, `Agent 技能 ${source} 已成功安装`));
            }
            this.postMessage({ type: 'skillInstallComplete', success: true });
            await this.getSkillsList();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vs.window.showErrorMessage(aiText(`Installation failed: ${msg}`, `安装失败: ${msg}`));
            this.postMessage({ type: 'skillInstallComplete', success: false });
        }
    }

    async deleteSkill(skill: string): Promise<void> {
        if (!this.globalStoragePath) return;
        try {
            const skillPath = path.join(this.globalStoragePath, '.agents', 'skills', skill);
            if (fs.existsSync(skillPath)) {
                await fs.promises.rm(skillPath, { recursive: true, force: true });
                vs.window.showInformationMessage(aiText(`Agent skill ${skill} deleted`, `Agent 技能 ${skill} 已删除`));
                await this.getSkillsList();
            }
        } catch (e) {
            vs.window.showErrorMessage(aiText(`Delete failed: ${e}`, `删除失败: ${e}`));
        }
    }
}
