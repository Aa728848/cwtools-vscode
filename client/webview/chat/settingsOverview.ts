import { escapeHtml, formatNum } from './formatters';
import type { ChatI18nText } from './i18n';

export interface SettingsProviderView {
    id: string;
    name?: string;
    defaultEndpoint?: string;
    defaultModel?: string;
    hasKey?: boolean;
}

export interface SettingsOverviewInput {
    providers: SettingsProviderView[];
    providerId: string;
    model?: string;
    endpoint?: string;
    contextTokens?: number;
    inlineEnabled?: boolean;
    inlineProviderName?: string;
    mcpCount?: number;
    writeMode?: 'auto' | 'confirm' | string;
    reasoningEffort?: string;
}

export interface SettingsOverviewModel {
    title: string;
    subtitle: string;
    headerSubtitle: string;
    chipsHtml: string;
}

export function buildSettingsOverviewModel(input: SettingsOverviewInput, _i18n?: ChatI18nText): SettingsOverviewModel {
    const provider = input.providers.find(providerView => providerView.id === input.providerId);
    const providerName = provider?.name || input.providerId || '未选择 Provider';
    const model = input.model?.trim() || provider?.defaultModel || '未设置模型';
    const endpoint = input.endpoint?.trim() || provider?.defaultEndpoint || '默认端点';
    const contextTokens = input.contextTokens || 0;
    const contextLabel = contextTokens > 0 ? `${formatNum(contextTokens)} tokens` : '自动';
    const apiState = input.providerId === 'ollama'
        ? '本地模型'
        : (provider?.hasKey ? 'API Key 已配置' : 'API Key 未配置');
    const inlineState = input.inlineEnabled
        ? `补全: ${input.inlineProviderName || '同主模型'}`
        : '补全: 关闭';
    const mcpCount = input.mcpCount ?? 0;
    const writeMode = input.writeMode === 'auto' ? '写入自动' : '写入确认';
    const reasoning = input.reasoningEffort || 'high';

    return {
        title: `${providerName} · ${model}`,
        subtitle: `${endpoint} · 上下文 ${contextLabel} · ${apiState}`,
        headerSubtitle: `${apiState} · ${mcpCount} 个 MCP · ${writeMode}`,
        chipsHtml: [
            `<span class="settings-overview-chip">Provider <strong>${escapeHtml(providerName)}</strong></span>`,
            `<span class="settings-overview-chip">MCP <strong>${mcpCount}</strong></span>`,
            `<span class="settings-overview-chip">${escapeHtml(inlineState)}</span>`,
            `<span class="settings-overview-chip">写入 <strong>${escapeHtml(writeMode)}</strong></span>`,
            `<span class="settings-overview-chip">推理 <strong>${escapeHtml(reasoning)}</strong></span>`,
        ].join(''),
    };
}

export function applySettingsOverview(
    elements: {
        title: HTMLElement | null;
        subtitle: HTMLElement | null;
        chips: HTMLElement | null;
        headerSubtitle: HTMLElement | null;
    },
    model: SettingsOverviewModel,
): void {
    if (elements.title) elements.title.textContent = model.title;
    if (elements.subtitle) elements.subtitle.textContent = model.subtitle;
    if (elements.headerSubtitle) elements.headerSubtitle.textContent = model.headerSubtitle;
    if (elements.chips) elements.chips.innerHTML = model.chipsHtml;
}
