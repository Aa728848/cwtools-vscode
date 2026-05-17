import { escapeHtml, formatNum } from './formatters';
import { getChatI18n, type ChatI18nText } from './i18n';

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

export function buildSettingsOverviewModel(input: SettingsOverviewInput, i18n: ChatI18nText = getChatI18n('zh-cn')): SettingsOverviewModel {
    const labels = i18n.settings;
    const provider = input.providers.find(providerView => providerView.id === input.providerId);
    const providerName = provider?.name || input.providerId || labels.unselectedProvider;
    const model = input.model?.trim() || provider?.defaultModel || labels.unsetModel;
    const endpoint = input.endpoint?.trim() || provider?.defaultEndpoint || labels.defaultEndpoint;
    const contextTokens = input.contextTokens || 0;
    const contextLabel = contextTokens > 0 ? `${formatNum(contextTokens)} tokens` : labels.automatic;
    const apiState = input.providerId === 'ollama'
        ? labels.localModel
        : (provider?.hasKey ? labels.apiKeyConfigured : labels.apiKeyMissing);
    const inlineState = input.inlineEnabled
        ? `${labels.inlinePrefix}: ${input.inlineProviderName || labels.inlineSameProvider}`
        : labels.inlineOff;
    const mcpCount = input.mcpCount ?? 0;
    const writeMode = input.writeMode === 'auto' ? labels.writeAuto : labels.writeConfirm;
    const reasoning = input.reasoningEffort || 'high';

    return {
        title: `${providerName} · ${model}`,
        subtitle: `${endpoint} · ${labels.contextPrefix} ${contextLabel} · ${apiState}`,
        headerSubtitle: `${apiState} · ${mcpCount} ${labels.mcpUnit} · ${writeMode}`,
        chipsHtml: [
            `<span class="settings-overview-chip">${escapeHtml(labels.providerChip)} <strong>${escapeHtml(providerName)}</strong></span>`,
            `<span class="settings-overview-chip">${escapeHtml(labels.mcpUnit)} <strong>${mcpCount}</strong></span>`,
            `<span class="settings-overview-chip">${escapeHtml(inlineState)}</span>`,
            `<span class="settings-overview-chip">${escapeHtml(labels.writeChip)} <strong>${escapeHtml(writeMode)}</strong></span>`,
            `<span class="settings-overview-chip">${escapeHtml(labels.reasoningChip)} <strong>${escapeHtml(reasoning)}</strong></span>`,
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
