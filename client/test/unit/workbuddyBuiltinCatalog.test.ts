import { expect } from 'chai';
import {
    DEFAULT_VISIBLE_MODEL_IDS,
    FALLBACK_MODELS,
    UNPUBLISHED_MODELS,
    WORKBUDDY_MODEL_IDS,
    builtinWorkBuddyModelsForRegion,
    resolveWorkBuddyModelEntry,
    withUnpublishedWorkBuddyModels,
} from '../../extension/ai/workbuddy/fallbackModels';
import {
    clearCachedWorkBuddyCatalog,
    loadWorkBuddyCatalog,
    workBuddyCatalogForSettings,
    workBuddyContextWindows,
    workBuddyEffortForRequest,
    workBuddyEffortsFor,
    workBuddyMaxOutputTokens,
    type WorkBuddyModelEntry,
} from '../../extension/ai/workbuddy/modelCatalog';

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function idsOf(models: readonly WorkBuddyModelEntry[]): string[] {
    return models.map(model => model.id);
}

/** Every id the shipped table holds, used as the ground truth for region filtering. */
const ALL_BUILTIN_IDS = FALLBACK_MODELS.map(model => model.id);

describe('WorkBuddy builtin model table', () => {
    afterEach(() => clearCachedWorkBuddyCatalog());

    it('transcribes every id the reference catalog holds, without duplicates', () => {
        // The three served-but-unpublished ids are also published in the fallback, so
        // the merged builtin list is 47 ids rather than 50.
        expect(FALLBACK_MODELS).to.have.length(47);
        expect(UNPUBLISHED_MODELS).to.have.length(3);
        expect(WORKBUDDY_MODEL_IDS).to.have.length(47);
        expect(new Set(WORKBUDDY_MODEL_IDS).size).to.equal(47);
        // glm-5.3 leads the shipped selection and is served by both regions.
        expect(DEFAULT_VISIBLE_MODEL_IDS[0]).to.equal('glm-5.3');
        expect(WORKBUDDY_MODEL_IDS).to.include(DEFAULT_VISIBLE_MODEL_IDS[0]);
    });

    it('filters the shipped table by region', () => {
        const cn = idsOf(builtinWorkBuddyModelsForRegion('cn'));
        const intl = idsOf(builtinWorkBuddyModelsForRegion('intl'));
        // The two region lists are not nested in either direction.
        expect(cn).to.include('glm-5.1');
        expect(cn).to.include('deepseek-v4-pro');
        expect(cn).to.include('kimi-k2.5');
        expect(cn).to.include('hy4-preview-f');
        expect(cn).to.include('space-bunny');
        expect(cn).to.include('minimax-m3');
        expect(cn).to.not.include('gpt-6-astra');
        expect(cn).to.not.include('gemini-3.5-flash');
        expect(cn).to.not.include('kimi-k3');

        expect(intl).to.include('gpt-6-astra');
        expect(intl).to.include('gemini-3.5-flash');
        expect(intl).to.include('kimi-k3');
        expect(intl).to.include('deepseek-v4.1-flash-sg');
        expect(intl).to.not.include('glm-5.1');
        expect(intl).to.not.include('deepseek-v4-pro');
        expect(intl).to.not.include('kimi-k2.5');
        expect(intl).to.not.include('space-bunny');
        expect(intl).to.not.include('minimax-m3');

        // 30 / 25 with 8 shared, so the union is the full 47.
        expect(cn).to.have.length(30);
        expect(intl).to.have.length(25);
        expect(idsOf(builtinWorkBuddyModelsForRegion())).to.have.length(47);
        expect(idsOf(builtinWorkBuddyModelsForRegion()).sort()).to.deep.equal([...ALL_BUILTIN_IDS].sort());
    });

    it('merges the served-but-unpublished models into a live catalog once', () => {
        const live: WorkBuddyModelEntry[] = [{
            id: 'live-only', name: 'Live', contextWindow: 10, maxContextWindow: 20, maxTokens: 1,
            regions: ['intl'], supportsImage: false, reasoningEfforts: [], defaultReasoningEffort: null,
            canDisableThinking: false, description: '',
        }];
        const ids = idsOf(withUnpublishedWorkBuddyModels(live, 'intl'));
        expect(ids).to.include('live-only');
        expect(ids).to.include('gemini-3.8-flash');
        // gemini-3.8-flash is declared by both tables; a merged catalog must not list it twice.
        expect(ids.filter(id => id === 'gemini-3.8-flash')).to.have.length(1);
        // A row the region does not serve never appears.
        expect(idsOf(withUnpublishedWorkBuddyModels(live, 'cn'))).to.deep.equal(['live-only']);
        // A published entry always wins over the shipped row of the same id.
        const published: WorkBuddyModelEntry = { ...live[0]!, id: 'gemini-3.8-flash', name: 'From gateway' };
        const merged = withUnpublishedWorkBuddyModels([published], 'intl');
        expect(merged.find(model => model.id === 'gemini-3.8-flash')!.name).to.equal('From gateway');
    });

    it('converges a default level the shipped ladder does not contain', () => {
        // The gateway names defaults from a wider vocabulary than the ladder it
        // publishes; medium on a low/high/max model is the measured case. Left
        // unconverged the level resolver drops it, no reasoning_effort is sent, and the
        // model answers with empty reasoning.
        const raw = FALLBACK_MODELS.find(model => model.id === 'kimi-k2.6')!;
        expect(raw.reasoningEfforts).to.not.include('medium');
        expect(raw.defaultReasoningEffort).to.equal('medium');
        // The table keeps the transcription verbatim; convergence happens on read.
        expect(resolveWorkBuddyModelEntry('kimi-k2.6')!.defaultReasoningEffort).to.equal('high');
        expect(resolveWorkBuddyModelEntry('kimi-k2.6')!.reasoningEfforts).to.deep.equal(raw.reasoningEfforts);
    });
});

describe('WorkBuddy settings catalog', () => {
    afterEach(() => clearCachedWorkBuddyCatalog());

    it('answers a non-empty model list before sign-in, by region or as a union', () => {
        const cn = workBuddyCatalogForSettings('cn');
        expect(cn.source).to.equal('builtin');
        expect(idsOf(cn.models)).to.include('glm-5.1');
        expect(idsOf(cn.models)).to.not.include('kimi-k3');

        const intl = workBuddyCatalogForSettings('intl');
        expect(idsOf(intl.models)).to.include('kimi-k3');
        expect(idsOf(intl.models)).to.not.include('glm-5.1');

        // Region unknown: the union, so neither region's account sees an empty list.
        const union = workBuddyCatalogForSettings();
        expect(idsOf(union.models).sort()).to.deep.equal([...ALL_BUILTIN_IDS].sort());
        expect(Object.keys(workBuddyContextWindows(union.models)).length).to.be.greaterThan(0);
    });

    it('lets the live catalog win over the shipped table, per region', async () => {
        await loadWorkBuddyCatalog({
            backend: 'https://www.codebuddy.cn', region: 'cn', headers: {},
            fetchFn: async () => json({ data: { models: [{ id: 'live-cn', maxAllowedSize: 5000 }] } }),
        });
        const cn = workBuddyCatalogForSettings('cn');
        expect(cn.source).to.equal('live');
        // The live entry, plus the served-but-unpublished rows of that region.
        expect(idsOf(cn.models)).to.include('live-cn');
        expect(idsOf(cn.models)).to.not.include('glm-5.1');
        expect(cn.models.find(model => model.id === 'live-cn')!.regions).to.deep.equal(['cn']);
        // The other region holds no snapshot of its own and falls back instead of borrowing.
        const intl = workBuddyCatalogForSettings('intl');
        expect(intl.source).to.equal('builtin');
        expect(idsOf(intl.models)).to.include('glm-5.3');
        expect(idsOf(intl.models)).to.not.include('live-cn');
    });

    it('answers context windows and output caps from the shipped table offline', () => {
        expect(workBuddyMaxOutputTokens('glm-5.3')).to.equal(48000);
        expect(workBuddyContextWindows(workBuddyCatalogForSettings('cn').models)['glm-5.3'])
            .to.equal(1000000);
        // An id nobody describes declares nothing rather than borrowing a neighbour's.
        expect(workBuddyMaxOutputTokens('no-such-model')).to.equal(undefined);
        expect(workBuddyEffortsFor('no-such-model')).to.deep.equal([]);
    });
});

describe('WorkBuddy effort selection without a live catalog', () => {
    afterEach(() => clearCachedWorkBuddyCatalog());

    it('validates a requested level against the shipped ladder', () => {
        expect(workBuddyEffortForRequest('deepseek-v4.1-flash', 'low')).to.equal('low');
        expect(workBuddyEffortForRequest('deepseek-v4.1-flash', 'max')).to.equal('max');
        // A level this model does not accept falls back to its declared default rather
        // than being sent: the gateway answers 11150.
        expect(workBuddyEffortForRequest('deepseek-v4.1-flash', 'minimal')).to.equal('high');
        // No request: the declared default is materialized, because a request without
        // the field comes back with empty reasoning.
        expect(workBuddyEffortForRequest('deepseek-v4.1-flash')).to.equal('high');
        // A converted default is what gets sent for a medium-declared model.
        expect(workBuddyEffortForRequest('kimi-k2.6')).to.equal('high');
    });

    it('sends nothing for an unknown model or a non-reasoning one', () => {
        // Not the requested value: an id neither source describes has no ladder to
        // validate against, so passing an arbitrary level through is what provokes
        // 400 code 11150.
        expect(workBuddyEffortForRequest('no-such-model', 'high')).to.equal(undefined);
        expect(workBuddyEffortForRequest('no-such-model')).to.equal(undefined);
        expect(workBuddyEffortForRequest('glm-5.0', 'high')).to.equal(undefined);
        expect(workBuddyEffortForRequest('hunyuan-chat', 'low')).to.equal(undefined);
    });
});
