import { expect } from 'chai';
import { BUILTIN_PROVIDERS } from '../../extension/ai/providers/models/defaults';
import {
    getModelContextTokens,
    getModelOutputTokens,
    isModelVisionCapable,
    isModelVisionCapableFor,
} from '../../extension/ai/providers/models/capabilities';
import { getCacheDiscountFactor, getModelPricing } from '../../extension/ai/providers/models/pricing';

describe('Kimi dual-line model metadata', () => {
    it('ships K3.1 Pro at the top of the open-platform line', () => {
        const provider = BUILTIN_PROVIDERS['kimi']!;
        expect(provider.defaultModel).to.equal('kimi-k3.1-pro');
        expect(provider.models).to.include('kimi-k3.1-pro');
        expect(provider.models).to.include('kimi-k3.1-pro-highspeed');
        // K2.6 and the K2.7 code pair stay selectable.
        expect(provider.models).to.include('kimi-k2.6');
        expect(provider.models).to.include('kimi-k2.7-code');
        expect(provider.models).to.include('kimi-k2.7-code-highspeed');
        // K2.5 is retired from THIS line only.
        expect(provider.models).to.not.include('kimi-k2.5');
        expect(provider.maxContextTokens).to.equal(1_048_576);
    });

    it('ships the K3.1 Pro pair on the Kimi Code plan line and keeps the alias', () => {
        const provider = BUILTIN_PROVIDERS['kimi-code-plan']!;
        expect(provider.defaultModel).to.equal('k3.1-pro');
        expect(provider.models).to.deep.equal([
            'k3.1-pro',
            'k3.1-pro-highspeed',
            'k3',
            'k3-256k',
            'kimi-for-coding',
            'kimi-for-coding-highspeed',
        ]);
    });

    it('keeps K2.5 on the other lines that still serve it', () => {
        // The removal is scoped to the kimi line: at least one relay still lists the
        // id, and the shared capability/pricing rules for it are untouched.
        const otherLines = Object.values(BUILTIN_PROVIDERS).filter(provider => provider.id !== 'kimi');
        expect(otherLines.some(provider => provider.models.includes('kimi-k2.5'))).to.equal(true);
        expect(BUILTIN_PROVIDERS['kimi']!.models.includes('kimi-k2.5')).to.equal(false);
    });

    it('reports the official 1M window for both K3.1 Pro lines', () => {
        expect(getModelContextTokens('kimi-k3.1-pro', 'kimi')).to.equal(1_048_576);
        expect(getModelContextTokens('kimi-k3.1-pro-highspeed', 'kimi')).to.equal(1_048_576);
        // The subscription line keeps the published 256K default for the regular id;
        // 1M is the unlock, not the budget.
        expect(getModelContextTokens('k3.1-pro', 'kimi-code-plan')).to.equal(262_144);
        expect(getModelContextTokens('k3.1-pro-highspeed', 'kimi-code-plan')).to.equal(1_048_576);
        // Existing lines are untouched.
        expect(getModelContextTokens('k3', 'kimi-code-plan')).to.equal(262_144);
        expect(getModelContextTokens('kimi-k3', 'kimi')).to.equal(1_048_576);
        expect(getModelContextTokens('glm-5.2', 'glm')).to.equal(1_000_000);
    });

    it('reports the official completion budget for each line', () => {
        // Open platform: max_completion_tokens defaults to 131,072.
        expect(getModelOutputTokens('kimi-k3.1-pro', 'kimi')).to.equal(131_072);
        expect(getModelOutputTokens('kimi-k3.1-pro-highspeed', 'kimi')).to.equal(131_072);
        // Subscription: the plan metadata states 32,768.
        expect(getModelOutputTokens('k3.1-pro', 'kimi-code-plan')).to.equal(32_768);
        expect(getModelOutputTokens('k3.1-pro-highspeed', 'kimi-code-plan')).to.equal(32_768);
        expect(getModelOutputTokens('glm-5.2', 'glm')).to.equal(128_000);
    });

    it('treats K3.1 Pro as vision capable', () => {
        expect(isModelVisionCapable('kimi-k3.1-pro')).to.equal(true);
        expect(isModelVisionCapableFor('kimi', 'kimi-k3.1-pro')).to.equal(true);
        expect(isModelVisionCapableFor('kimi', 'k3.1-pro-highspeed')).to.equal(true);
    });
});

describe('Kimi pricing data', () => {
    it('prices the official K3.1 Pro rates per MTok', () => {
        for (const model of ['kimi-k3.1-pro']) {
            expect(getModelPricing(model)).to.deep.equal([13.00, 68.00]);
            expect(getModelPricing(model, 'kimi')).to.deep.equal([13.00, 68.00]);
        }
        expect(getModelPricing('kimi-k3.1-pro-highspeed')).to.deep.equal([26.00, 136.00]);
        expect(getModelPricing('kimi-k3.1-pro-highspeed', 'kimi')).to.deep.equal([26.00, 136.00]);
    });

    it('derives the cache ratio from the ¥1.30 cache-hit price', () => {
        // ¥1.30 of ¥13 input = 10%; the same cache price against the ¥26 highspeed
        // input rate is 5%.
        expect(getCacheDiscountFactor('kimi-k3.1-pro')).to.equal(0.1);
        expect(getCacheDiscountFactor('kimi-k3.1-pro-highspeed')).to.equal(0.05);
        // Existing Kimi ratios are preserved.
        expect(getCacheDiscountFactor('kimi-k3')).to.equal(0.1);
        expect(getCacheDiscountFactor('kimi-for-coding')).to.equal(0.1);
        expect(getCacheDiscountFactor('kimi-k2.7-code')).to.equal(0.2);
        expect(getCacheDiscountFactor('kimi-k2.6')).to.equal(0.17);
        expect(getCacheDiscountFactor('kimi-k2.5')).to.equal(0.18);
    });

    it('keeps the retired open-platform price so other lines still estimate', () => {
        expect(getModelPricing('kimi-k2.5')).to.deep.equal([4.00, 21.00]);
        expect(getModelPricing('kimi-k3')).to.deep.equal([20.00, 100.00]);
    });

    it('leaves non-Kimi pricing untouched', () => {
        expect(getModelPricing('claude-sonnet-4-6')).to.deep.equal([20.46, 102.30]);
        expect(getCacheDiscountFactor('gpt-6.1-sol', 'openai')).to.equal(0.05);
        expect(getCacheDiscountFactor('glm-5.2')).to.equal(0.19);
    });
});
