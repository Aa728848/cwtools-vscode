import { expect } from 'chai';
import { getModelPricing, MODEL_PRICING, getCacheDiscountFactor } from '../../extension/ai/pricing';

describe('getModelPricing', () => {
    it('returns [0, 0] for empty model', () => {
        expect(getModelPricing('')).to.deep.equal([0, 0]);
    });

    it('exact match: claude-sonnet-4-6', () => {
        expect(getModelPricing('claude-sonnet-4-6')).to.deep.equal([20.46, 102.30]);
    });

    it('exact match: gpt-5.5', () => {
        expect(getModelPricing('gpt-5.5')).to.deep.equal([34.10, 204.59]);
    });

    it('exact match: deepseek-v4-pro', () => {
        expect(getModelPricing('deepseek-v4-pro')).to.deep.equal([9.00, 27.01]);
    });

    it('uses current direct-provider pricing', () => {
        expect(getModelPricing('claude-sonnet-5')).to.deep.equal([13.64, 68.20]);
        expect(getModelPricing('glm-5.2')).to.deep.equal([9.56, 30.05]);
        expect(getModelPricing('glm-4.7-flashx')).to.deep.equal([0.48, 2.73]);
        expect(getModelPricing('glm-4.6')).to.deep.equal([4.10, 15.02]);
        expect(getModelPricing('MiniMax-M3')).to.deep.equal([2.10, 8.40]);
        expect(getModelPricing('qwen3.7-max-2026-06-08')).to.deep.equal([12.00, 36.00]);
        expect(getModelPricing('qwen3.8-max')).to.deep.equal([12.00, 36.00]);
        expect(getModelPricing('gpt-5.6')).to.deep.equal([34.10, 204.59]);
        expect(getModelPricing('gpt-5.6-sol')).to.deep.equal([34.10, 204.59]);
        expect(getModelPricing('gpt-5.6-terra')).to.deep.equal([13.64, 81.84]);
        expect(getModelPricing('gpt-5.6-luna')).to.deep.equal([1.36, 8.18]);
        expect(getModelPricing('gemini-3.5-flash')).to.deep.equal([10.23, 61.38]);
        expect(getModelPricing('gemini-3.6-flash')).to.deep.equal([10.23, 51.15]);
        expect(getModelPricing('mimo-v2.5-pro')).to.deep.equal([3.00, 6.00]);
        expect(getModelPricing('kimi-k2.7-code')).to.deep.equal([6.50, 27.00]);
        expect(getModelPricing('kimi-k3')).to.deep.equal([20.00, 100.00]);
    });

    it('uses DeepSeek peak pricing by default and off-peak pricing when timestamped', () => {
        const peak = new Date('2026-08-16T02:30:00.000Z');
        const offPeak = new Date('2026-08-16T05:00:00.000Z');
        expect(getModelPricing('deepseek-v4-pro', 'deepseek', peak)).to.deep.equal([9.00, 27.01]);
        expect(getModelPricing('deepseek-v4-pro', 'deepseek', offPeak)).to.deep.equal([4.50, 13.50]);
        expect(getModelPricing('deepseek-v4-flash', 'deepseek', peak)).to.deep.equal([3.00, 9.00]);
        expect(getModelPricing('deepseek-v4-flash', 'deepseek', offPeak)).to.deep.equal([1.50, 4.50]);
    });

    it('prefix match: dated model tag', () => {
        expect(getModelPricing('claude-opus-4-7-20251101')).to.deep.equal([34.10, 170.50]);
    });

    it('contains match: substring', () => {
        const result = getModelPricing('some-prefix-claude-sonnet-4-6-suffix');
        expect(result).to.deep.equal([20.46, 102.30]);
    });

    it('provider-specific override beats base model pricing', () => {
        expect(getModelPricing('deepseek-ai/DeepSeek-V4-Pro', 'siliconflow')).to.deep.equal([3.00, 6.00]);
        expect(getModelPricing('deepseek-ai/DeepSeek-V4-Pro', 'deepinfra')).to.deep.equal([8.87, 17.73]);
        expect(getModelPricing('z-ai/glm-5.2', 'openrouter')).to.deep.equal([8.18, 27.96]);
        expect(getModelPricing('gpt-5.5', 'opencode')).to.deep.equal([34.10, 204.60]);
        expect(getModelPricing('deepseek-v4-pro', 'opencode')).to.deep.equal([11.87, 23.73]);
        expect(getModelPricing('minimax-m3-free', 'opencode')).to.deep.equal([0, 0]);
    });

    it('unknown model returns [0, 0]', () => {
        expect(getModelPricing('nonexistent-model-v99')).to.deep.equal([0, 0]);
    });

    it('subscription plan models are not billed per token', () => {
        expect(getModelPricing('kimi-for-coding')).to.deep.equal([0, 0]);
    });

    it('free models return [0, 0]', () => {
        expect(getModelPricing('deepseek-v4-flash-free')).to.deep.equal([0, 0]);
        expect(getModelPricing('qwen3.6-plus-free')).to.deep.equal([0, 0]);
        expect(getModelPricing('mimo-v2.5-free')).to.deep.equal([0, 0]);
        expect(getModelPricing('big-pickle')).to.deep.equal([0, 0]);
    });

    it('all pricing entries are valid tuples', () => {
        for (const val of Object.values(MODEL_PRICING)) {
            expect(val).to.be.an('array').with.lengthOf(2);
            expect(val[0]).to.be.a('number');
            expect(val[1]).to.be.a('number');
        }
    });
});

describe('getCacheDiscountFactor', () => {
    it('returns current DeepSeek GA cache pricing ratios', () => {
        expect(getCacheDiscountFactor('deepseek-v4-pro')).to.equal(1 / 30);
        expect(getCacheDiscountFactor('deepseek-v4-flash')).to.equal(7 / 220);
        expect(getCacheDiscountFactor('deepseek-chat')).to.equal(7 / 220);
    });

    it('returns 0.1 for Claude models', () => {
        expect(getCacheDiscountFactor('claude-sonnet-4-6')).to.equal(0.1);
        expect(getCacheDiscountFactor('claude-opus-4-7-20251101')).to.equal(0.1);
        expect(getCacheDiscountFactor('claude-opus-4-8')).to.equal(0.1);
    });

    it('returns 0.5 for OpenAI models', () => {
        expect(getCacheDiscountFactor('gpt-5.5')).to.equal(0.5);
        expect(getCacheDiscountFactor('gpt-5.4-mini')).to.equal(0.5);
    });

    it('returns 0.1 for Gemini models', () => {
        expect(getCacheDiscountFactor('gemini-3.5-flash')).to.equal(0.1);
    });

    it('returns 0.2 for Qwen models', () => {
        expect(getCacheDiscountFactor('qwen-max')).to.equal(0.2);
    });

    it('uses the documented 12.5% implicit-cache rate for Qwen 3.8-Max', () => {
        expect(getCacheDiscountFactor('qwen3.8-max')).to.equal(0.125);
        expect(getCacheDiscountFactor('qwen3.7-max')).to.equal(0.2);
    });

    it('returns correct factors for other providers', () => {
        expect(getCacheDiscountFactor('glm-5.2')).to.equal(0.19);
        expect(getCacheDiscountFactor('kimi-k2.7-code')).to.equal(0.2);
        expect(getCacheDiscountFactor('kimi-k3')).to.equal(0.1);
        expect(getCacheDiscountFactor('kimi-for-coding')).to.equal(0.1);
        expect(getCacheDiscountFactor('kimi-k2.6')).to.equal(0.17);
        expect(getCacheDiscountFactor('minimax-m2.7')).to.equal(0.2);
        expect(getCacheDiscountFactor('mimo-v2.5-pro')).to.equal(0.0083);
        expect(getCacheDiscountFactor('mimo-v2.5')).to.equal(0.02);
    });

    it('uses OpenCode provider-specific cache rates', () => {
        expect(getCacheDiscountFactor('gpt-5.5', 'opencode')).to.equal(0.1);
        expect(getCacheDiscountFactor('gpt-5.5-pro', 'opencode')).to.equal(1);
        expect(getCacheDiscountFactor('deepseek-v4-pro', 'opencode')).to.equal(0.08);
        expect(getCacheDiscountFactor('deepseek-v4-flash', 'opencode')).to.equal(0.2);
        expect(getCacheDiscountFactor('minimax-m3-free', 'opencode')).to.equal(0);
    });

    it('returns 1.0 for unknown-model without cache discount', () => {
        expect(getCacheDiscountFactor('unknown-model')).to.equal(1.0);
    });
});
