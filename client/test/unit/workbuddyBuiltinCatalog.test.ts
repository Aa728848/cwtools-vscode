import { expect } from 'chai';
import {
    DEFAULT_VISIBLE_MODEL_IDS,
    FALLBACK_MODELS,
    WORKBUDDY_MODEL_IDS,
    builtinWorkBuddyModelsForRegion,
} from '../../extension/ai/workbuddy/fallbackModels';
import {
    clearCachedWorkBuddyCatalog,
    loadWorkBuddyCatalog,
    workBuddyCatalogForSettings,
    workBuddyEffortForRequest,
    workBuddyEffortsFor,
} from '../../extension/ai/workbuddy/modelCatalog';
import {
    parseWorkBuddyCreditMultiplier,
    workBuddyModelRoute,
} from '../../extension/ai/workbuddy/types';

describe('WorkBuddy built-in fallback catalog & regional routing', () => {
    beforeEach(() => clearCachedWorkBuddyCatalog());

    it('keeps FALLBACK_MODELS invariants (non-empty unique ids, valid windows, valid default visible ids)', () => {
        expect(FALLBACK_MODELS.length).to.be.greaterThanOrEqual(40);
        expect(new Set(WORKBUDDY_MODEL_IDS).size).to.equal(FALLBACK_MODELS.length);
        for (const model of FALLBACK_MODELS) {
            expect(model.id.trim()).to.not.equal('');
            expect(model.contextWindow).to.be.a('number').and.greaterThan(0);
            expect(model.maxContextWindow).to.be.at.least(model.contextWindow);
            expect(model.maxTokens).to.be.a('number').and.greaterThan(0);
            expect(model.regions.length).to.be.greaterThan(0);
        }
        for (const id of DEFAULT_VISIBLE_MODEL_IDS) {
            expect(WORKBUDDY_MODEL_IDS, `default visible id ${id}`).to.include(id);
        }
    });

    it('separates CN vs INTL catalogs and routes CN claude-* models to /v1/messages', () => {
        const cnModels = builtinWorkBuddyModelsForRegion('cn').map(m => m.id);
        const intlModels = builtinWorkBuddyModelsForRegion('intl').map(m => m.id);
        expect(cnModels).to.include('hy4std');
        expect(cnModels).to.not.include('gpt-6-astra');
        expect(intlModels).to.include('gpt-6-astra');
        expect(intlModels).to.not.include('hy4std');

        expect(workBuddyModelRoute('claude-sonnet-4.6', 'cn')).to.equal('anthropic-messages');
        expect(workBuddyModelRoute('claude-sonnet-4.6', 'intl')).to.equal('openai-chat-completions');
        expect(workBuddyModelRoute('glm-5.3', 'cn')).to.equal('openai-chat-completions');
        expect(workBuddyModelRoute('gpt-5.6-sol', 'intl')).to.equal('openai-chat-completions');

        expect(workBuddyCatalogForSettings('cn').source).to.equal('builtin');
        expect(parseWorkBuddyCreditMultiplier('x0.79 credits')).to.equal('0.79');
        expect(parseWorkBuddyCreditMultiplier('')).to.equal(null);
    });

    it('maps WorkBuddy efforts cleanly and upgrades settings catalog after live load', async () => {
        expect(workBuddyEffortsFor('gpt-6-astra')).to.deep.equal(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
        expect(workBuddyEffortsFor('glm-5.3')).to.deep.equal(['low', 'high', 'max']);

        // Disallowed 'medium' on glm-5.3 falls back to the declared default ('high') instead of sending invalid 11150 rung
        expect(workBuddyEffortForRequest('glm-5.3', 'medium')).to.equal('high');
        expect(workBuddyEffortForRequest('glm-5.3', 'none')).to.equal('high');
        expect(workBuddyEffortForRequest('gpt-6-astra', 'none')).to.equal('none');

        const loaded = await loadWorkBuddyCatalog({
            backend: 'https://copilot.tencent.com',
            region: 'cn',
            headers: {},
            force: true,
            fetchFn: async () => new Response(JSON.stringify({
                code: 0,
                data: {
                    models: [
                        {
                            id: 'claude-sonnet-4.6',
                            name: 'Claude Sonnet 4.6',
                            maxAllowedSize: 200000,
                            maxOutputTokens: 64000,
                            contextWindow: { defaultLength: 200000 },
                            supportsImages: true,
                            credits: 'x1.5',
                            reasoning: { supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high', canDisableThinking: true },
                        },
                    ],
                },
            }), { status: 200 }),
        });

        expect(loaded).to.have.length(1);
        expect(workBuddyCatalogForSettings('cn').source).to.equal('live');
        expect(workBuddyEffortsFor('claude-sonnet-4.6')).to.deep.equal(['none', 'low', 'medium', 'high']);
    });
});
