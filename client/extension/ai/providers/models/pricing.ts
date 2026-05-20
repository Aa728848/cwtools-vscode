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
    for (const key of Object.keys(MODEL_PRICING)) {
        if (model.startsWith(key)) { const v = MODEL_PRICING[key]!; return [v[0]!, v[1]!]; }
    }
    for (const key of Object.keys(MODEL_PRICING)) {
        if (model.includes(key)) { const v = MODEL_PRICING[key]!; return [v[0]!, v[1]!]; }
    }
    return [0, 0];
}

/** Get cache-hit discount factor for a model. DeepSeek/Claude: 0.1×, OpenAI: 0.5×. */
export function getCacheDiscountFactor(model: string): number {
    if (model.startsWith('deepseek')) return 0.1;
    if (model.startsWith('claude')) return 0.1;
    if (model.startsWith('gpt-')) return 0.5;
    return 1.0;
}
