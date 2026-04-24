/**
 * CWTools AI Module — Model Pricing Table
 *
 * Per-model cost table (USD per 1M tokens, [input, output]).
 * Uses cache-miss (standard) input rate as the representative figure.
 *
 * Sources (verified 2026-04):
 *   OpenAI:    https://openai.com/api/pricing
 *   Anthropic: https://www.anthropic.com/api
 *   DeepSeek:  https://platform.deepseek.com/  (V3.2 pricing, post 2025-09-29)
 *   Google:    https://ai.google.dev/pricing
 *   MiniMax:   https://www.minimax.io/
 *   Zhipu:     https://bigmodel.cn / z.ai
 *   DashScope: https://www.alibabacloud.com/help/en/model-studio/
 */

export const MODEL_PRICING: Record<string, [number, number]> = {
    // ── Anthropic Claude ─────────────────────────────────────────────────────
    'claude-opus-4-7': [5.00, 25.00],
    'claude-opus-4-6': [5.00, 25.00],   // same tier as 4-7
    'claude-sonnet-4-6': [3.00, 15.00],
    'claude-haiku-4-5': [1.00, 5.00],

    // ── OpenAI GPT-5.5 / GPT-5.4 series ─────────────────────────────────────────────────
    'gpt-5.5-pro': [30.00, 180.00],
    'gpt-5.5': [5.00, 30.00],
    'gpt-5.4': [2.50, 15.00],
    'gpt-5.4-mini': [0.75, 4.50],
    'gpt-5.4-nano': [0.20, 1.25],
    'gpt-5-mini': [0.75, 4.50],   // alias, same tier
    'gpt-5-nano': [0.20, 1.25],   // alias, same tier

    // ── DeepSeek V4 / V3.2 (unified, post 2026-04) ─────────────────────────────
    'deepseek-v4-pro': [1.67, 3.33],
    'deepseek-v4-flash': [0.14, 0.28],
    // ── MiniMax ───────────────────────────────────────────────────────────────
    'MiniMax-M2.7': [0.30, 1.20],
    'MiniMax-M2.5': [0.12, 0.95],
    'MiniMax-M2.5-Lightning': [0.12, 2.40],

    // ── Zhipu GLM ─────────────────────────────────────────────────────────────
    'glm-5.1': [1.40, 4.40],
    'glm-5': [1.00, 3.20],
    'glm-5v-turbo': [0.50, 1.50],   // estimated visual-turbo tier

    // ── Qwen / DashScope ──────────────────────────────────────────────────────
    'qwen3.6-plus': [0.33, 1.95],
    'qwen3.5-plus': [0.30, 1.80],
    'qwen3.6-flash': [0.06, 0.25],   // flash tier (estimated)

    // ── Google Gemini 2.5 ─────────────────────────────────────────────────────
    'gemini-2.5-pro': [1.25, 10.00],
    'gemini-2.5-flash': [0.30, 2.50],
    'gemini-2.5-flash-lite': [0.10, 0.40],

    // ── Google Gemini 3 / 3.1 (preview, as of 2026-04) ────────────────────────
    'gemini-3.1-pro-preview': [2.00, 12.00],   // ≤200K ctx tier
    'gemini-3-flash-preview': [0.50, 3.00],
    'gemini-3.1-flash-lite-preview': [0.25, 1.50],
};

/** Look up per-million-token cost for a model. Falls back to [0, 0] if unknown. */
export function getModelPricing(model: string): [number, number] {
    if (!model) return [0, 0];
    // 1. Exact match
    if (model in MODEL_PRICING) return MODEL_PRICING[model];
    // 2. Prefix match (e.g. "claude-opus-4-5-20251101" -> "claude-opus-4-5")
    for (const key of Object.keys(MODEL_PRICING)) {
        if (model.startsWith(key)) return MODEL_PRICING[key];
    }
    // 3. Contains match (e.g. "deepseek-chat-v3" contains "deepseek-chat")
    for (const key of Object.keys(MODEL_PRICING)) {
        if (model.includes(key)) return MODEL_PRICING[key];
    }
    return [0, 0];
}
