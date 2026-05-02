/**
 * CWTools AI Module — Model Pricing Table
 *
 * Per-model cost table (CNY per 1M tokens, [input, output]).
 * Uses cache-miss (standard) input rate as the representative figure.
 *
 * Sources (verified 2026-05):
 *   OpenAI:    https://developers.openai.com/api/docs/pricing.md
 *   Anthropic: https://platform.claude.com/docs/en/docs/about-claude/models
 *   DeepSeek:  https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   MiniMax:   https://platform.minimaxi.com/docs/guides/pricing-paygo.md
 *   GLM:       https://open.bigmodel.cn/pricing
 *   Qwen:      https://help.aliyun.com/zh/model-studio/billing-for-model-studio
 *   Google:    https://ai.google.dev/pricing
 *   MiMo:      https://platform.xiaomimimo.com/static/docs/pricing.md
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
