/**
 * CWTools AI Module — Model Pricing Table
 */

import pricingData from './pricingData.json';

export const MODEL_PRICING: Record<string, number[]> = pricingData;

/** Look up per-million-token cost for a model. Falls back to [0, 0] if unknown. */
export function getModelPricing(model: string): [number, number] {
    if (!model) return [0, 0];
    const entry = MODEL_PRICING[model];
    if (entry) return [entry[0]!, entry[1]!];
    // Case-insensitive matching for model names like "DeepSeek-V4-Pro" vs "deepseek-v4-pro"
    const lower = model.toLowerCase();
    for (const key of Object.keys(MODEL_PRICING)) {
        if (lower.startsWith(key.toLowerCase())) { const v = MODEL_PRICING[key]!; return [v[0]!, v[1]!]; }
    }
    for (const key of Object.keys(MODEL_PRICING)) {
        if (lower.includes(key.toLowerCase())) { const v = MODEL_PRICING[key]!; return [v[0]!, v[1]!]; }
    }
    return [0, 0];
}

/**
 * Get cache-hit discount factor for a model.
 * The factor represents the fraction of full input price charged for cached tokens.
 * e.g. 0.1 means cached tokens cost 10% of full price, saving 90%.
 *
 * Sources (2026-05):
 *  - DeepSeek V4:  cache hit ≈ 0.83% of full price → 0.01
 *  - Claude:       cache_read = 10% of input price → 0.1
 *  - OpenAI GPT:   cached = 50% of input price → 0.5
 *  - Gemini:       cached = 25% of input price → 0.25
 *  - Qwen:         implicit cache = 20% of input price → 0.2
 *  - GLM (Zhipu):  cached ≈ 10% (estimated) → 0.1
 *  - Kimi:         cached ≈ 17% ($0.16/$0.95) → 0.17
 *  - MiniMax:      cached ≈ 10% (estimated) → 0.1
 *  - MiMo:         cached ≈ 0.8% (0.025/3.00 CNY) → 0.01
 */
export function getCacheDiscountFactor(model: string): number {
    if (!model) return 1.0;
    const lower = model.toLowerCase();
    // DeepSeek — extremely aggressive cache pricing
    if (lower.includes('deepseek')) return 0.01;
    // Anthropic Claude
    if (lower.includes('claude')) return 0.1;
    // OpenAI GPT series
    if (lower.includes('gpt-') || lower.includes('gpt5')) return 0.5;
    // Google Gemini
    if (lower.includes('gemini')) return 0.25;
    // Alibaba Qwen (implicit cache default)
    if (lower.includes('qwen')) return 0.2;
    // Zhipu GLM
    if (lower.includes('glm')) return 0.1;
    // Moonshot Kimi
    if (lower.includes('kimi')) return 0.17;
    // MiniMax
    if (lower.includes('minimax')) return 0.1;
    // Xiaomi MiMo — extremely aggressive cache pricing
    if (lower.includes('mimo')) return 0.01;
    // Unknown model — assume no discount (conservative)
    return 1.0;
}
