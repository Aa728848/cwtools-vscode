import { expect } from 'chai';
import { getModelPricing, MODEL_PRICING, getCacheDiscountFactor } from '../../extension/ai/pricing';

describe('getModelPricing', () => {
    it('returns [0, 0] for empty model', () => {
        expect(getModelPricing('')).to.deep.equal([0, 0]);
    });

    it('exact match: claude-sonnet-4-6', () => {
        expect(getModelPricing('claude-sonnet-4-6')).to.deep.equal([21.6, 108]);
    });

    it('exact match: gpt-5.5', () => {
        expect(getModelPricing('gpt-5.5')).to.deep.equal([36, 216]);
    });

    it('exact match: deepseek-v4-pro', () => {
        expect(getModelPricing('deepseek-v4-pro')).to.deep.equal([3.00, 6.00]);
    });

    it('prefix match: dated model tag', () => {
        expect(getModelPricing('claude-opus-4-7-20251101')).to.deep.equal([36, 180]);
    });

    it('contains match: substring', () => {
        const result = getModelPricing('some-prefix-claude-sonnet-4-6-suffix');
        expect(result).to.deep.equal([21.6, 108]);
    });

    it('unknown model returns [0, 0]', () => {
        expect(getModelPricing('nonexistent-model-v99')).to.deep.equal([0, 0]);
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
    it('returns 0.1 for DeepSeek models', () => {
        expect(getCacheDiscountFactor('deepseek-v4-pro')).to.equal(0.1);
        expect(getCacheDiscountFactor('deepseek-chat')).to.equal(0.1);
    });

    it('returns 0.1 for Claude models', () => {
        expect(getCacheDiscountFactor('claude-sonnet-4-6')).to.equal(0.1);
        expect(getCacheDiscountFactor('claude-opus-4-7-20251101')).to.equal(0.1);
    });

    it('returns 0.5 for OpenAI models', () => {
        expect(getCacheDiscountFactor('gpt-5.5')).to.equal(0.5);
        expect(getCacheDiscountFactor('gpt-5.4-mini')).to.equal(0.5);
        expect(getCacheDiscountFactor('gpt-5-nano')).to.equal(0.5);
    });

    it('returns 1.0 for providers without cache discount', () => {
        expect(getCacheDiscountFactor('gemini-2.5-pro')).to.equal(1.0);
        expect(getCacheDiscountFactor('qwen-max')).to.equal(1.0);
        expect(getCacheDiscountFactor('unknown-model')).to.equal(1.0);
    });
});
