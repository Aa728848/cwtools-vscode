import { escapeHtml, formatNum } from './formatters';
import { getChatI18n, type ChatI18nText } from './i18n';

export interface SettingsProviderView {
    id: string;
    name?: string;
    defaultEndpoint?: string;
    defaultModel?: string;
    hasKey?: boolean;
    requiresApiKey?: boolean;
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
    writeMode?: 'auto' | 'confirm' | 'auto_review' | 'full' | string;
    reasoningEffort?: string;
    accountStatus?: string;
}

export interface SettingsOverviewModel {
    title: string;
    subtitle: string;
    headerSubtitle: string;
    chipsHtml: string;
}

function findModelContextTokens(
    model: string,
    entries: Array<readonly [string, number]>,
): number {
    const exact = entries.find(([key]) => key === model)?.[1];
    if (exact) return exact;
    const sorted = [...entries].sort(([left], [right]) => right.length - left.length);
    for (const [key, tokens] of sorted) {
        if (model.startsWith(key)) return tokens;
    }
    for (const [key, tokens] of sorted) {
        if (model.includes(key)) return tokens;
    }
    return 0;
}

/** Resolve settings context with provider-scoped metadata taking precedence. */
export function resolveSettingsModelContextTokens(
    model: string,
    providerId: string,
    modelContextTokens: Readonly<Record<string, number>>,
    providerFallback = 0,
): number {
    if (!model) return 0;
    const providerPrefix = `${providerId}:`;
    const entries = Object.entries(modelContextTokens);
    const providerEntries = entries
        .filter(([key]) => key.startsWith(providerPrefix))
        .map(([key, tokens]) => [key.slice(providerPrefix.length), tokens] as const);
    const providerMatch = findModelContextTokens(model, providerEntries);
    if (providerMatch > 0) return providerMatch;
    const genericEntries = entries.filter(([key]) => !key.includes(':'));
    return findModelContextTokens(model, genericEntries) || providerFallback;
}

export function buildSettingsOverviewModel(input: SettingsOverviewInput, i18n: ChatI18nText = getChatI18n('zh-cn')): SettingsOverviewModel {
    const labels = i18n.settings;
    const provider = input.providers.find(providerView => providerView.id === input.providerId);
    const providerName = provider?.name || input.providerId || labels.unselectedProvider;
    const model = input.model?.trim() || provider?.defaultModel || labels.unsetModel;
    const endpoint = input.endpoint?.trim() || provider?.defaultEndpoint || labels.defaultEndpoint;
    const contextTokens = input.contextTokens || 0;
    const contextLabel = contextTokens > 0 ? `${formatNum(contextTokens)} tokens` : labels.automatic;
    const apiState = input.accountStatus ?? (provider?.requiresApiKey === false
        ? labels.localModel
        : (provider?.hasKey ? labels.apiKeyConfigured : labels.apiKeyMissing));
    const inlineState = input.inlineEnabled
        ? `${labels.inlinePrefix}: ${input.inlineProviderName || labels.inlineSameProvider}`
        : labels.inlineOff;
    const mcpCount = input.mcpCount ?? 0;
    const writeMode = input.writeMode === 'full'
        ? labels.writeFull
        : input.writeMode === 'auto_review'
            ? labels.writeAutoReview
            : input.writeMode === 'auto' ? labels.writeAuto : labels.writeConfirm;
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
