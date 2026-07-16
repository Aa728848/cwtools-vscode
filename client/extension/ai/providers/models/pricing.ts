/**
 * CWTools AI Module — Model Pricing Table
 */

import pricingData from './pricingData.json';

export const MODEL_PRICING: Record<string, number[]> = pricingData;

/** Look up per-million-token CNY cost for a model. Falls back to [0, 0] if unknown. */
export function getModelPricing(model: string, providerId?: string): [number, number] {
    if (!model) return [0, 0];
    const providerEntry = providerId ? MODEL_PRICING[`${providerId}:${model}`] : undefined;
    if (providerEntry) return [providerEntry[0]!, providerEntry[1]!];

    const entry = MODEL_PRICING[model];
    if (entry) return [entry[0]!, entry[1]!];
    // Case-insensitive matching for model names like "DeepSeek-V4-Pro" vs "deepseek-v4-pro"
    const lower = model.toLowerCase();
    const providerPrefix = providerId ? `${providerId.toLowerCase()}:` : '';
    if (lower.includes('free') || lower.includes('pickle')) return [0, 0];
    for (const key of Object.keys(MODEL_PRICING)) {
        const normalizedKey = key.toLowerCase();
        if (providerPrefix && !normalizedKey.startsWith(providerPrefix)) continue;
        const modelKey = providerPrefix ? normalizedKey.slice(providerPrefix.length) : normalizedKey;
        if (lower.startsWith(modelKey)) { const v = MODEL_PRICING[key]!; return [v[0]!, v[1]!]; }
    }
    for (const key of Object.keys(MODEL_PRICING)) {
        const normalizedKey = key.toLowerCase();
        if (providerPrefix && !normalizedKey.startsWith(providerPrefix)) continue;
        const modelKey = providerPrefix ? normalizedKey.slice(providerPrefix.length) : normalizedKey;
        if (lower.includes(modelKey)) { const v = MODEL_PRICING[key]!; return [v[0]!, v[1]!]; }
    }
    if (providerId) {
        return getModelPricing(model);
    }
    return [0, 0];
}

/**
 * Get cache-hit discount factor for a model.
 * The factor represents the fraction of full input price charged for cached tokens.
 * e.g. 0.1 means cached tokens cost 10% of full price, saving 90%.
 *
 * Sources (2026-06):
 *  - DeepSeek V4:  cache hit ≈ 0.83% of full price → 0.01
 *  - Claude:       cache_read = 10% of input price → 0.1
 *  - OpenAI GPT:   cached = 50% of input price → 0.5
 *  - Gemini:       current text models cache input at 10% → 0.1
 *  - Qwen:         implicit cache = 20% of input price → 0.2
 *  - GLM (Zhipu):  GLM-5.2 cached input $0.26/$1.40 → 0.19
 *  - Kimi:         model-specific cache read ratio → 0.17–0.20
 *  - MiniMax:      M3/M2.7 = 20%, M2.5 and older = 10%
 *  - MiMo:         V2.5 Pro ≈ 0.8%, V2.5 = 2%
 */
export function getCacheDiscountFactor(model: string, providerId?: string): number {
    if (!model) return 1.0;
    const lower = model.toLowerCase();
    if (providerId?.toLowerCase() === 'opencode') {
        if (lower.includes('free') || lower.includes('pickle')) return 0;
        if (lower === 'gpt-5.4-pro' || lower === 'gpt-5.5-pro') return 1;
        if (lower.startsWith('minimax-') || lower === 'glm-5' || lower.startsWith('deepseek-v4-flash') || lower.startsWith('grok-')) return 0.2;
        if (lower === 'glm-5.1') return 0.19;
        if (lower.startsWith('kimi-')) return 0.17;
        if (lower.startsWith('deepseek-v4-pro')) return 0.08;
        return 0.1;
    }
    // OpenCode Go — per-model cached-read ratios from Go pricing (cached/input).
    if (providerId?.toLowerCase() === 'opencode-go') {
        if (lower.includes('free') || lower.includes('pickle')) return 0;
        if (lower.startsWith('mimo-v2.5-pro')) return 0.0083;
        if (lower.startsWith('mimo-v2.5')) return 0.02;
        if (lower.startsWith('deepseek-v4-pro')) return 0.01;
        if (lower.startsWith('deepseek-v4-flash')) return 0.02;
        if (lower.startsWith('kimi-k2.7')) return 0.2;
        if (lower.startsWith('kimi')) return 0.17;
        if (lower.startsWith('minimax')) return 0.2;
        if (lower.startsWith('qwen3.7-max')) return 0.2;
        if (lower.startsWith('qwen')) return 0.1;
        if (lower.startsWith('glm')) return 0.19;
        return 0.1;
    }
    // DeepSeek — extremely aggressive cache pricing
    if (lower.includes('deepseek')) return 0.01;
    // Anthropic Claude
    if (lower.includes('claude')) return 0.1;
    // OpenAI GPT series
    if (lower.includes('gpt-') || lower.includes('gpt5')) return 0.5;
    // Google Gemini
    if (lower.includes('gemini')) return 0.1;
    // Alibaba Qwen (implicit cache default)
    if (lower.includes('qwen')) return 0.2;
    // Zhipu GLM
    if (lower.includes('glm')) return 0.19;
    // Moonshot Kimi
    if (lower.includes('kimi-k3') || lower.includes('kimi-for-coding')) return 0.1;
    if (lower.includes('kimi-k2.7')) return 0.2;
    if (lower.includes('kimi-k2.5')) return 0.18;
    if (lower.includes('kimi')) return 0.17;
    // MiniMax
    if (lower.includes('minimax-m3') || lower.includes('minimax-m2.7')) return 0.2;
    if (lower.includes('minimax')) return 0.1;
    // Xiaomi MiMo — extremely aggressive cache pricing
    if (lower.includes('mimo-v2.5-pro')) return 0.0083;
    if (lower.includes('mimo-v2.5')) return 0.02;
    if (lower.includes('mimo')) return 0.01;
    // Unknown model — assume no discount (conservative)
    return 1.0;
}
