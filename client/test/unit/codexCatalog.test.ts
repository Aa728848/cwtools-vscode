import { expect } from 'chai';
import {
    CODEX_CLIENT_VERSION,
    CODEX_DEFAULT_OUTPUT_VERBOSITY,
    CODEX_MODELS_URL,
    CODEX_OPENAI_BETA,
    CODEX_TURN_STATE_HEADER,
    clearCachedCodexCatalog,
    codexDefaultOutputVerbosity,
    getCachedCodexCatalog,
    isCodexCatalogFallback,
    loadCodexCatalog,
    parseCodexCatalog,
    parseCodexCatalogSnapshot,
} from '../../extension/ai/codex/modelCatalog';
import {
    CodexTurnStateTracker,
    MAX_TRACKED_TURN_STATES,
} from '../../extension/ai/codex/turnState';

// The catalog cache is process-global by design (one listing per account per
// process), so every suite here resets it and leaves nothing behind.
afterEach(() => clearCachedCodexCatalog());

describe('Codex subscription model catalog', () => {
    it('pins the subscription wire contract the official CLI sends', () => {
        expect(CODEX_OPENAI_BETA).to.equal('responses=experimental');
        expect(CODEX_TURN_STATE_HEADER).to.equal('x-codex-turn-state');
        expect(CODEX_MODELS_URL).to.equal(
            `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
        );
    });

    it('reads the documented envelope and a bare array alike', () => {
        const entry = { slug: 'gpt-6-astra', display_name: '6 Astra', context_window: 272000 };
        expect(parseCodexCatalog({ models: [entry] })).to.have.length(1);
        expect(parseCodexCatalog([entry])).to.have.length(1);
        expect(parseCodexCatalog({ models: 'nope' })).to.deep.equal([]);
    });

    it('takes the listing context window and reasoning levels as stated', () => {
        const [model] = parseCodexCatalog({
            models: [{
                slug: 'gpt-6-astra',
                display_name: '6 Astra',
                context_window: 384000,
                input_modalities: ['text', 'image'],
                supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, 'max'],
                default_reasoning_level: 'high',
                default_verbosity: 'low',
            }],
        });
        expect(model).to.deep.include({
            id: 'gpt-6-astra',
            name: '6 Astra',
            contextWindow: 384000,
            inputModalities: ['text', 'image'],
            reasoningEfforts: ['low', 'high', 'max'],
            defaultReasoningEffort: 'high',
            supportsVerbosity: true,
            defaultVerbosity: 'low',
        });
    });

    // An unlisted model must not inherit capabilities the listing never stated:
    // declaring a capability that is not there is worse than declaring none.
    it('falls back to conservative capabilities for an unknown model', () => {
        const [model] = parseCodexCatalog({ models: [{ slug: 'gpt-9-experimental' }] });
        expect(model).to.deep.include({
            id: 'gpt-9-experimental',
            contextWindow: null,
            inputModalities: ['text'],
            defaultReasoningEffort: null,
        });
        expect(model!.reasoningEfforts).to.equal(undefined);
    });

    it('rejects entries without an id and caps the entry count', () => {
        expect(parseCodexCatalog({ models: [{ display_name: 'no id' }] })).to.deep.equal([]);
        const many = Array.from({ length: 900 }, (_, index) => ({ slug: `model-${index}` }));
        expect(parseCodexCatalog({ models: many })).to.have.length(500);
    });

    it('treats a malformed snapshot as absent rather than as an empty catalog', () => {
        expect(parseCodexCatalogSnapshot({ models: [] })).to.equal(undefined);
        expect(parseCodexCatalogSnapshot([{ slug: 'gpt-6-sol' }])).to.have.length(1);
    });
});

describe('Codex catalog loading', () => {
    const snapshot = { value: undefined as unknown, writes: 0 };

    beforeEach(() => {
        clearCachedCodexCatalog();
        snapshot.value = undefined;
        snapshot.writes = 0;
    });

    const store = {
        read: async () => snapshot.value,
        write: async (value: unknown) => { snapshot.value = value; snapshot.writes += 1; },
    };

    it('uses a live listing and persists only that listing', async () => {
        const models = await loadCodexCatalog({
            accountKey: 'acct-1',
            headers: {},
            fetchFn: async () => new Response(JSON.stringify({
                models: [{ slug: 'gpt-6-sol', context_window: 384000 }],
            })),
            snapshot: store,
        });
        expect(models.map(entry => entry.id)).to.deep.equal(['gpt-6-sol']);
        expect(isCodexCatalogFallback()).to.equal(false);
        expect(snapshot.writes).to.equal(1);
    });

    // A failed call must not overwrite a good snapshot with nothing.
    it('answers a failed listing from the held catalog without persisting', async () => {
        await loadCodexCatalog({
            accountKey: 'acct-1',
            headers: {},
            fetchFn: async () => new Response(JSON.stringify({ models: [{ slug: 'gpt-6-sol' }] })),
            snapshot: store,
        });
        const writesAfterLive = snapshot.writes;
        const failed = await loadCodexCatalog({
            accountKey: 'acct-1',
            headers: {},
            force: true,
            fetchFn: async () => new Response('nope', { status: 500 }),
            snapshot: store,
        });
        expect(failed.map(entry => entry.id)).to.deep.equal(['gpt-6-sol']);
        expect(isCodexCatalogFallback()).to.equal(true);
        expect(snapshot.writes).to.equal(writesAfterLive);
    });

    it('keeps one account listing from answering another account', async () => {
        await loadCodexCatalog({
            accountKey: 'acct-1',
            headers: {},
            fetchFn: async () => new Response(JSON.stringify({ models: [{ slug: 'gpt-6-sol' }] })),
        });
        const other = await loadCodexCatalog({
            accountKey: 'acct-2',
            headers: {},
            fetchFn: async () => new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-terra' }] })),
        });
        expect(other.map(entry => entry.id)).to.deep.equal(['gpt-5.6-terra']);
        expect(getCachedCodexCatalog()!.map(entry => entry.id)).to.deep.equal(['gpt-5.6-terra']);
    });

    it('single-flights concurrent loads for the same account', async () => {
        let calls = 0;
        const fetchFn = async () => {
            calls += 1;
            return new Response(JSON.stringify({ models: [{ slug: 'gpt-6-sol' }] }));
        };
        await Promise.all([
            loadCodexCatalog({ accountKey: 'acct-1', headers: {}, fetchFn }),
            loadCodexCatalog({ accountKey: 'acct-1', headers: {}, fetchFn }),
            loadCodexCatalog({ accountKey: 'acct-1', headers: {}, fetchFn }),
        ]);
        expect(calls).to.equal(1);
    });

    it('sends the subscription headers it was handed', async () => {
        let seen: Headers | undefined;
        await loadCodexCatalog({
            accountKey: 'acct-1',
            headers: { Authorization: 'Bearer token-1', 'openai-beta': CODEX_OPENAI_BETA },
            fetchFn: async (_input, init) => {
                seen = new Headers(init?.headers);
                return new Response(JSON.stringify({ models: [{ slug: 'gpt-6-sol' }] }));
            },
        });
        expect(seen!.get('Authorization')).to.equal('Bearer token-1');
        expect(seen!.get('openai-beta')).to.equal('responses=experimental');
        expect(seen!.get('accept')).to.equal('application/json');
    });
});

describe('Codex default output verbosity', () => {
    beforeEach(() => clearCachedCodexCatalog());

    it('defaults a shipped model to the catalog default the official client sends', () => {
        expect(codexDefaultOutputVerbosity('gpt-6-astra')).to.equal(CODEX_DEFAULT_OUTPUT_VERBOSITY);
    });

    it('does not invent a verbosity for a model the shipped table does not list', () => {
        expect(codexDefaultOutputVerbosity('gpt-9-experimental')).to.equal(undefined);
    });

    // The listing is the authority: a model it lists without a stated default
    // gets no `text` field, because the catalog gates the field per model.
    it('honours the live listing over the shipped table', async () => {
        await loadCodexCatalog({
            accountKey: 'acct-1',
            headers: {},
            fetchFn: async () => new Response(JSON.stringify({
                models: [{ slug: 'gpt-9-experimental' }],
            })),
        });
        expect(codexDefaultOutputVerbosity('gpt-9-experimental')).to.equal(undefined);
        expect(codexDefaultOutputVerbosity('gpt-6-astra')).to.equal(CODEX_DEFAULT_OUTPUT_VERBOSITY);
    });
});

describe('Codex turn state tracker', () => {
    const response = (value?: string) => ({
        headers: { get: (name: string) => (name === CODEX_TURN_STATE_HEADER ? value ?? null : null) },
    });

    it('replays state only to the signer that minted it', () => {
        const tracker = new CodexTurnStateTracker();
        tracker.remember('turn-1', response('state-1'), 'owner-a');
        expect(tracker.take('turn-1', 'owner-a')).to.equal('state-1');
        tracker.remember('turn-1', response('state-1'), 'owner-a');
        expect(tracker.take('turn-1', 'owner-b')).to.equal(undefined);
        // The mismatched owner drops the entry rather than keeping it around.
        expect(tracker.take('turn-1', 'owner-a')).to.equal(undefined);
    });

    // A backend that stopped sending the header has stopped honouring it, and
    // replaying a stale value would be guessing.
    it('clears the entry when a response carries no state', () => {
        const tracker = new CodexTurnStateTracker();
        tracker.remember('turn-1', response('state-1'), 'owner-a');
        tracker.remember('turn-1', response(), 'owner-a');
        expect(tracker.take('turn-1', 'owner-a')).to.equal(undefined);
        tracker.remember('turn-1', response('   '), 'owner-a');
        expect(tracker.take('turn-1', 'owner-a')).to.equal(undefined);
    });

    it('keeps the store bounded and evicts the oldest turn first', () => {
        const tracker = new CodexTurnStateTracker(2);
        tracker.remember('turn-1', response('state-1'), 'owner-a');
        tracker.remember('turn-2', response('state-2'), 'owner-a');
        tracker.remember('turn-3', response('state-3'), 'owner-a');
        expect(tracker.size).to.equal(2);
        expect(tracker.take('turn-1', 'owner-a')).to.equal(undefined);
        expect(tracker.take('turn-2', 'owner-a')).to.equal('state-2');
    });

    it('refreshes age when the same turn is recorded again', () => {
        const tracker = new CodexTurnStateTracker(2);
        tracker.remember('turn-1', response('state-1'), 'owner-a');
        tracker.remember('turn-2', response('state-2'), 'owner-a');
        tracker.remember('turn-1', response('state-1b'), 'owner-a');
        tracker.remember('turn-3', response('state-3'), 'owner-a');
        expect(tracker.take('turn-1', 'owner-a')).to.equal('state-1b');
        expect(tracker.take('turn-2', 'owner-a')).to.equal(undefined);
    });

    it('defaults to a bounded table', () => {
        const tracker = new CodexTurnStateTracker();
        for (let index = 0; index < MAX_TRACKED_TURN_STATES + 10; index += 1) {
            tracker.remember(`turn-${index}`, response(`state-${index}`), 'owner-a');
        }
        expect(tracker.size).to.equal(MAX_TRACKED_TURN_STATES);
    });

    it('tolerates a response with no headers at all', () => {
        const tracker = new CodexTurnStateTracker();
        tracker.remember('turn-1', {}, 'owner-a');
        expect(tracker.take('turn-1', 'owner-a')).to.equal(undefined);
    });
});
