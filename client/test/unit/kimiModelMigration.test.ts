import { expect } from 'chai';
import {
    KIMI_RETIRED_MODEL_IDS,
    isKimiK31Model,
    isKimiK31ProviderModel,
    isKimiProviderId,
    migrateKimiModelId,
    migrateKimiReasoningEffort,
} from '../../extension/ai/kimi/modelMigration';

describe('Kimi retired model migration', () => {
    it('maps the retired K2.5 id to its successor on the kimi line only', () => {
        expect(KIMI_RETIRED_MODEL_IDS['kimi-k2.5']).to.equal('kimi-k3.1-pro');
        expect(migrateKimiModelId('kimi', 'kimi-k2.5')).to.equal('kimi-k3.1-pro');
        // Case and a UI suffix must not defeat the match.
        expect(migrateKimiModelId('kimi', ' KIMI-K2.5 ')).to.equal('kimi-k3.1-pro');
        expect(migrateKimiModelId('kimi', 'kimi-k2.5 (1M)')).to.equal('kimi-k3.1-pro');
        // The surviving Kimi ids, another provider, and a custom id are untouched.
        expect(migrateKimiModelId('kimi', 'kimi-k2.6')).to.equal('kimi-k2.6');
        expect(migrateKimiModelId('kimi', 'kimi-k3.1-pro')).to.equal('kimi-k3.1-pro');
        expect(migrateKimiModelId('openrouter', 'kimi-k2.5')).to.equal('kimi-k2.5');
        expect(migrateKimiModelId('kimi', 'my-relay-k2.5')).to.equal('my-relay-k2.5');
        expect(migrateKimiModelId(undefined, 'kimi-k2.5')).to.equal('kimi-k2.5');
    });

    it('matches the K3.1 family by shape without catching K3 or K2', () => {
        for (const model of ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'k3.1-pro', 'k3.1-pro-highspeed']) {
            expect(isKimiK31Model(model), model).to.equal(true);
        }
        for (const model of ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k3', 'k3.1-pro-preview']) {
            expect(isKimiK31Model(model), model).to.equal(false);
        }
        expect(isKimiK31ProviderModel('kimi', 'kimi-k3.1-pro')).to.equal(true);
        expect(isKimiK31ProviderModel('kimi-code-plan', 'k3.1-pro-highspeed')).to.equal(true);
        // The same id elsewhere is somebody else's model.
        expect(isKimiK31ProviderModel('openrouter', 'kimi-k3.1-pro')).to.equal(false);
        expect(isKimiK31ProviderModel('custom', 'k3.1-pro')).to.equal(false);
        expect(isKimiProviderId('kimi')).to.equal(true);
        expect(isKimiProviderId('kimi-code-plan')).to.equal(true);
        expect(isKimiProviderId('opencode')).to.equal(false);
    });

    it('keeps compatible efforts and floors none on K3.1', () => {
        // K3.1 cannot stop thinking, so none becomes the lowest rung rather than being sent.
        expect(migrateKimiReasoningEffort('kimi', 'kimi-k3.1-pro', 'none')).to.equal('low');
        expect(migrateKimiReasoningEffort('kimi-code-plan', 'k3.1-pro', 'none')).to.equal('low');
        expect(migrateKimiReasoningEffort('kimi', 'kimi-k3.1-pro', 'high')).to.equal('high');
        expect(migrateKimiReasoningEffort('kimi', 'kimi-k3.1-pro', 'max')).to.equal('max');
        // The K2 toggle keeps its own none, and another provider is not this family.
        expect(migrateKimiReasoningEffort('kimi', 'kimi-k2.6', 'none')).to.equal('none');
        expect(migrateKimiReasoningEffort('openrouter', 'kimi-k3.1-pro', 'none')).to.equal('none');
    });
});
