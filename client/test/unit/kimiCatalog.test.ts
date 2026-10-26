import { expect } from 'chai';
import {
    kimiCatalogContextBudget,
    kimiCatalogDefaultModel,
    kimiCatalogModelIds,
    kimiCatalogReasoningCapability,
    loadKimiCatalog,
    parseKimiCatalog,
    type KimiCodeCatalogModel,
} from '../../extension/ai/kimi/catalog';

import type { ModelReasoningCapability } from '../../extension/ai/types';

const OFFLINE = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;

/** The static table's answer for K3.1: three levels, `max` documented as the default. */
const K31_STATIC: ModelReasoningCapability = {
    kind: 'effort',
    options: ['low', 'high', 'max'],
    defaultValue: 'max',
};

function model(overrides: Partial<KimiCodeCatalogModel> = {}): KimiCodeCatalogModel {
    return {
        id: 'kimi-k3.1-pro',
        name: 'kimi-k3.1-pro',
        contextWindow: 1_048_576,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'max',
        inputModalities: ['text', 'image'],
        ...overrides,
    };
}

describe('parseKimiCatalog', () => {
    it('accepts both listing envelopes', () => {
        const entry = { id: 'kimi-k3.1-pro', context_length: 1_048_576 };
        expect(parseKimiCatalog([entry]).map(item => item.id)).to.deep.equal(['kimi-k3.1-pro']);
        expect(parseKimiCatalog({ models: [entry] }).map(item => item.id)).to.deep.equal(['kimi-k3.1-pro']);
        expect(parseKimiCatalog({ data: [entry] }).map(item => item.id)).to.deep.equal(['kimi-k3.1-pro']);
    });

    it('reads the window from limit.context as well as the top level', () => {
        const fromLimit = parseKimiCatalog([{ id: 'k3.1-pro', limit: { context: 1_048_576 } }]);
        expect(fromLimit[0]!.contextWindow).to.equal(1_048_576);
        const fromLimits = parseKimiCatalog([{ id: 'k3.1-pro', limits: { context: 262_144 } }]);
        expect(fromLimits[0]!.contextWindow).to.equal(262_144);
    });

    it('tracks an input cap only below the window', () => {
        const capped = parseKimiCatalog([{
            id: 'kimi-k3.1-pro',
            limit: { context: 1_048_576, input: 262_144 },
        }]);
        expect(capped[0]!.maxInputTokens).to.equal(262_144);
        expect(capped[0]!.contextWindow).to.equal(1_048_576);

        // A cap equal to (or above) the window is not a cap.
        expect(parseKimiCatalog([{ id: 'kimi-k3.1-pro', limit: { context: 262_144, input: 262_144 } }])[0]!.maxInputTokens)
            .to.equal(undefined);
        expect(parseKimiCatalog([{ id: 'kimi-k3.1-pro', limit: { context: 262_144, input: 0 } }])[0]!.maxInputTokens)
            .to.equal(undefined);
    });

    it('reads think_efforts in both spellings, with the default', () => {
        const snake = parseKimiCatalog([{
            id: 'k3.1-pro',
            context_length: 262_144,
            think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'max' },
        }])[0]!;
        expect(snake.reasoningEfforts).to.deep.equal(['low', 'high', 'max']);
        expect(snake.defaultReasoningEffort).to.equal('max');

        const camel = parseKimiCatalog([{
            id: 'k3.1-pro',
            contextLength: 262_144,
            thinkEfforts: { validEfforts: ['high'], defaultEffort: 'high' },
        }])[0]!;
        expect(camel.reasoningEfforts).to.deep.equal(['high']);
        expect(camel.defaultReasoningEffort).to.equal('high');
    });

    it('reads the official reasoning_options ladder and its on/off switch', () => {
        const ladder = parseKimiCatalog([{
            id: 'kimi-k3.1-pro',
            context_length: 1_048_576,
            reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        }])[0]!;
        expect(ladder.reasoningEfforts).to.deep.equal(['low', 'high', 'max']);
        expect(ladder.thinkingType).to.equal(undefined);

        const switchable = parseKimiCatalog([{
            id: 'kimi-k3.1-pro',
            context_length: 1_048_576,
            reasoning_options: [{ type: 'effort', values: ['high'] }, { type: 'toggle' }],
        }])[0]!;
        expect(switchable.reasoningEfforts).to.deep.equal(['high', 'none']);

        const offSpelling = parseKimiCatalog([{
            id: 'kimi-k3.1-pro',
            context_length: 1_048_576,
            reasoning_options: [{ type: 'effort', values: ['high'] }, { type: 'off' }],
        }])[0]!;
        expect(offSpelling.reasoningEfforts).to.deep.equal(['high', 'none']);
    });

    it('lets supports_thinking_type correct the effort table', () => {
        const only = parseKimiCatalog([{
            id: 'kimi-k3.1-pro',
            context_length: 1_048_576,
            supports_thinking_type: 'only',
            think_efforts: { valid_efforts: ['none', 'low', 'high', 'max'], default_effort: 'max' },
        }])[0]!;
        expect(only.reasoningEfforts).to.deep.equal(['low', 'high', 'max']);
        expect(only.thinkingType).to.equal('only');

        const never = parseKimiCatalog([{
            id: 'kimi-k3.1-pro',
            context_length: 1_048_576,
            supports_thinking_type: 'no',
            think_efforts: { valid_efforts: ['low', 'high'], default_effort: 'high' },
        }])[0]!;
        expect(never.reasoningEfforts).to.deep.equal([]);
        expect(never.defaultReasoningEffort).to.equal(null);

        const both = parseKimiCatalog([{
            id: 'kimi-k3.1-pro',
            context_length: 1_048_576,
            supportsThinkingType: 'both',
            think_efforts: { valid_efforts: ['none', 'high'], default_effort: 'high' },
        }])[0]!;
        expect(both.reasoningEfforts).to.deep.equal(['none', 'high']);
    });

    it('drops a default the corrected ladder no longer offers', () => {
        const entry = parseKimiCatalog([{
            id: 'kimi-k3.1-pro',
            context_length: 1_048_576,
            supports_thinking_type: 'only',
            think_efforts: { valid_efforts: ['none'], default_effort: 'none' },
        }])[0]!;
        expect(entry.reasoningEfforts).to.deep.equal([]);
        expect(entry.defaultReasoningEffort).to.equal(null);
    });

    it('discards retired and malformed entries', () => {
        const parsed = parseKimiCatalog([
            { id: 'kimi-k3', context_length: 262_144, status: 'deprecated' },
            { id: '', context_length: 262_144 },
            { context_length: 262_144 },
            { id: 'kimi-k3.1-pro', context_length: 0 },
            'not-a-record',
            { id: 'kimi-k3.1-pro', limit: {} },
            { id: 'kimi-k3.1-pro', context_length: 1_048_576 },
        ]);
        expect(parsed.map(item => item.id)).to.deep.equal(['kimi-k3.1-pro']);
    });

    it('keeps the declared tool and modality tri-state', () => {
        const off = parseKimiCatalog([{
            id: 'kimi-for-coding-highspeed',
            context_length: 262_144,
            supports_tool_use: false,
            supports_image_in: true,
            supports_video_in: true,
        }])[0]!;
        expect(off.supportsToolUse).to.equal(false);
        expect(off.inputModalities).to.deep.equal(['text', 'image', 'video']);

        const silent = parseKimiCatalog([{ id: 'kimi-for-coding', context_length: 1_048_576 }])[0]!;
        expect('supportsToolUse' in silent).to.equal(false);
        expect(silent.inputModalities).to.deep.equal(['text']);
    });
});

describe('loadKimiCatalog fallback', () => {
    it('answers from the shipped table, one window per model', async () => {
        const catalog = await loadKimiCatalog({
            codingBase: 'https://example.invalid/coding',
            headers: {},
            accountKey: 'fallback:shipped',
            fetchFn: OFFLINE,
            force: true,
        });
        const ids = catalog.map(item => item.id);
        expect(ids).to.include('k3.1-pro');
        expect(ids).to.include('k3.1-pro-highspeed');
        expect(ids).to.include('kimi-for-coding');

        const byId = new Map(catalog.map(item => [item.id, item]));
        // 256K and 1M windows coexist on this line; the provider ceiling must not be
        // copied onto every model.
        expect(byId.get('k3.1-pro')!.contextWindow).to.equal(262_144);
        expect(byId.get('k3.1-pro-highspeed')!.contextWindow).to.equal(1_048_576);
        expect(byId.get('kimi-for-coding')!.contextWindow).to.equal(1_048_576);
        expect(byId.get('k3.1-pro')!.reasoningEfforts).to.deep.equal(['low', 'high', 'max']);
        expect(byId.get('k3.1-pro')!.defaultReasoningEffort).to.equal('max');
        expect(byId.get('k3.1-pro')!.thinkingType).to.equal('only');
        // The alias declares no ladder in the shipped table: silence is not "none".
        expect(byId.get('kimi-for-coding')!.reasoningEfforts).to.deep.equal([]);
    });

    it('keeps the held listing when a later refresh fails', async () => {
        const listing = [{ id: 'kimi-k3.1-pro', context_length: 1_048_576 }];
        const fetchFn = (() => Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: listing }),
        })) as unknown as typeof fetch;
        const first = await loadKimiCatalog({
            codingBase: 'https://example.invalid/coding',
            headers: {},
            accountKey: 'fallback:held',
            fetchFn,
            force: true,
        });
        expect(first.map(item => item.id)).to.deep.equal(['kimi-k3.1-pro']);

        const second = await loadKimiCatalog({
            codingBase: 'https://example.invalid/coding',
            headers: {},
            accountKey: 'fallback:held',
            fetchFn: OFFLINE,
            force: true,
        });
        expect(second.map(item => item.id)).to.deep.equal(['kimi-k3.1-pro']);
    });
});

describe('kimi catalog settings helpers', () => {
    it('reports no model list for an empty catalog so the caller keeps the shipped table', () => {
        expect(kimiCatalogModelIds([])).to.equal(undefined);
        expect(kimiCatalogModelIds([model()])).to.deep.equal(['kimi-k3.1-pro']);
    });

    it('only honours the shipped default when the account offers it', () => {
        const catalog = [model({ id: 'k3' }), model({ id: 'kimi-for-coding' })];
        expect(kimiCatalogDefaultModel(catalog, 'kimi-for-coding')).to.equal('kimi-for-coding');
        expect(kimiCatalogDefaultModel(catalog, 'k3.1-pro')).to.equal('k3');
        expect(kimiCatalogDefaultModel([], 'k3.1-pro')).to.equal('k3.1-pro');
    });

    it('maps a declared ladder onto the shared capability shape', () => {
        expect(kimiCatalogReasoningCapability(model())).to.deep.equal({
            kind: 'effort',
            options: ['low', 'high', 'max'],
            defaultValue: 'max',
        });
        expect(kimiCatalogReasoningCapability(model({
            reasoningEfforts: ['none', 'high'],
            defaultReasoningEffort: 'high',
        }))).to.deep.equal({ kind: 'toggle', options: ['none', 'high'], defaultValue: 'high' });
        expect(kimiCatalogReasoningCapability(model({
            reasoningEfforts: ['high'],
            defaultReasoningEffort: 'high',
        }))).to.deep.equal({ kind: 'fixed', options: ['high'], defaultValue: 'high' });
        // Unknown levels are not forwarded to the picker.
        expect(kimiCatalogReasoningCapability(model({
            reasoningEfforts: ['turbo', 'high'],
            defaultReasoningEffort: 'turbo',
        }))).to.deep.equal({ kind: 'fixed', options: ['high'], defaultValue: 'high' });
        // Silence keeps the static table in charge.
        expect(kimiCatalogReasoningCapability(model({ reasoningEfforts: [], defaultReasoningEffort: null })))
            .to.equal(undefined);
    });

    it('does not invent a ladder for an explicit empty effort list', () => {
        // A declared "no thinking" is the one empty ladder that keeps a concrete answer.
        const never = parseKimiCatalog([{
            id: 'k3.1-pro',
            context_length: 262_144,
            supports_thinking_type: 'no',
            think_efforts: { valid_efforts: ['low', 'high'], default_effort: 'high' },
        }])[0]!;
        expect(never.thinkingType).to.equal('no');
        expect(kimiCatalogReasoningCapability(never, K31_STATIC)).to.deep.equal({
            kind: 'none',
            options: ['none'],
            defaultValue: 'none',
        });

        // An empty list says nothing about levels. Turning it into a fixed/toggle `high`
        // sends a level the service never offered, so the caller keeps the static answer.
        const emptyLadder = parseKimiCatalog([{
            id: 'k3.1-pro',
            context_length: 262_144,
            reasoning_options: [],
        }])[0]!;
        expect(emptyLadder.reasoningEfforts).to.deep.equal([]);
        expect(kimiCatalogReasoningCapability(emptyLadder, K31_STATIC)).to.equal(undefined);
        // Unknown model: the same empty answer lands the caller on the static NO_REASONING.
        expect(kimiCatalogReasoningCapability(emptyLadder)).to.equal(undefined);

        // Silence and an empty list now answer the same way: no invented level.
        const silent = parseKimiCatalog([{ id: 'kimi-for-coding', context_length: 262_144 }])[0]!;
        expect(kimiCatalogReasoningCapability(silent, K31_STATIC)).to.equal(undefined);
    });

    it('lets an explicit "no thinking" override the static K3.1 ladder', () => {
        const never = parseKimiCatalog([{
            id: 'k3.1-pro',
            context_length: 262_144,
            supports_thinking_type: 'no',
            think_efforts: { valid_efforts: ['low', 'high'], default_effort: 'high' },
        }])[0]!;
        expect(kimiCatalogReasoningCapability(never, K31_STATIC)).to.deep.equal({
            kind: 'none',
            options: ['none'],
            defaultValue: 'none',
        });
    });

    it('falls back to the static ladder for every empty directory answer', () => {
        // Silence: the directory did not speak, so the static table answers.
        expect(kimiCatalogReasoningCapability(
            model({ reasoningEfforts: [], defaultReasoningEffort: null }),
            K31_STATIC,
        )).to.equal(undefined);
        // Neither is an empty ladder a denial of thinking: no `high` is invented for
        // `only`/`both`, and none is accepted on the model's behalf.
        for (const thinkingType of ['only', 'both'] as const) {
            expect(kimiCatalogReasoningCapability(
                model({ reasoningEfforts: [], defaultReasoningEffort: null, thinkingType }),
                K31_STATIC,
            )).to.equal(undefined);
        }
    });

    it('inherits the static default when the live ladder declares none', () => {
        // The directory states the ladder but not the default: K3.1 keeps its documented max.
        expect(kimiCatalogReasoningCapability(
            model({ reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: null }),
            K31_STATIC,
        )).to.deep.equal({ kind: 'effort', options: ['low', 'high', 'max'], defaultValue: 'max' });
        // A declared default still wins over the inherited one.
        expect(kimiCatalogReasoningCapability(
            model({ reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'low' }),
            K31_STATIC,
        )!.defaultValue).to.equal('low');
        // An inherited default the ladder does not offer is discarded, not forwarded.
        expect(kimiCatalogReasoningCapability(
            model({ reasoningEfforts: ['none', 'high'], defaultReasoningEffort: null }),
            K31_STATIC,
        )!.defaultValue).to.equal('high');
        // No static answer available: the old preference stands.
        expect(kimiCatalogReasoningCapability(
            model({ reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: null }),
        )!.defaultValue).to.equal('high');
    });

    it('reads a top-level default effort when reasoning_options supplies the ladder', () => {
        const snake = parseKimiCatalog([{
            id: 'k3.1-pro',
            context_length: 1_048_576,
            reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
            default_effort: 'max',
        }])[0]!;
        expect(snake.defaultReasoningEffort).to.equal('max');

        const camel = parseKimiCatalog([{
            id: 'k3.1-pro',
            context_length: 1_048_576,
            reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
            defaultEffort: 'max',
        }])[0]!;
        expect(camel.reasoningEfforts).to.deep.equal(['low', 'high', 'max']);
        expect(camel.defaultReasoningEffort).to.equal('max');
    });

    it('budgets the prompt against the smaller of window and input cap', () => {
        expect(kimiCatalogContextBudget(model())).to.equal(1_048_576);
        expect(kimiCatalogContextBudget(model({ maxInputTokens: 262_144 }))).to.equal(262_144);
        // A cap that is not below the window is ignored rather than shrinking it.
        expect(kimiCatalogContextBudget(model({ maxInputTokens: 1_048_576 }))).to.equal(1_048_576);
        expect(kimiCatalogContextBudget(model({ maxInputTokens: 0 }))).to.equal(1_048_576);
    });
});
