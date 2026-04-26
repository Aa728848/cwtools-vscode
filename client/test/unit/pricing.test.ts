import { expect } from 'chai';
import { getModelPricing, MODEL_PRICING } from '../../extension/ai/pricing';

describe('getModelPricing', () => {
    it('returns [0, 0] for empty model', () => {
        expect(getModelPricing('')).to.deep.equal([0, 0]);
    });

    it('exact match: claude-sonnet-4-6', () => {
        expect(getModelPricing('claude-sonnet-4-6')).to.deep.equal([3.00, 15.00]);
    });

    it('exact match: gpt-5.5', () => {
        expect(getModelPricing('gpt-5.5')).to.deep.equal([5.00, 30.00]);
    });

    it('exact match: deepseek-v4-pro', () => {
        expect(getModelPricing('deepseek-v4-pro')).to.deep.equal([1.67, 3.33]);
    });

    it('prefix match: dated model tag', () => {
        expect(getModelPricing('claude-opus-4-7-20251101')).to.deep.equal([5.00, 25.00]);
    });

    it('contains match: substring', () => {
        const result = getModelPricing('some-prefix-claude-sonnet-4-6-suffix');
        expect(result).to.deep.equal([3.00, 15.00]);
    });

    it('unknown model returns [0, 0]', () => {
        expect(getModelPricing('nonexistent-model-v99')).to.deep.equal([0, 0]);
    });

    it('all pricing entries are valid tuples', () => {
        for (const [key, val] of Object.entries(MODEL_PRICING)) {
            expect(val).to.be.an('array').with.lengthOf(2);
            expect(val[0]).to.be.a('number');
            expect(val[1]).to.be.a('number');
        }
    });
});
