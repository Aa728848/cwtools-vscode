import { expect } from 'chai';
import type { ExtensionContext } from 'vscode';
import type { TokenUsage } from '../../extension/ai/types';
import { buildProviderCallTokenUsage } from '../../extension/ai/providerCallUsage';
import { appendCacheRequestUsage } from '../../extension/ai/cacheCapability';

const STORAGE_KEY = 'cwtools.ai.usageStats.v2';

class MockGlobalState {
    private store = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.store.get(key) as T | undefined;
    }

    update(key: string, value: unknown): Thenable<void> {
        if (value === undefined) this.store.delete(key);
        else this.store.set(key, value);
        return Promise.resolve();
    }

    seed(value: unknown): void {
        this.store.set(STORAGE_KEY, value);
    }
}

function makeContext(): { context: ExtensionContext; state: MockGlobalState } {
    const state = new MockGlobalState();
    const context = { globalState: state } as unknown as ExtensionContext;
    return { context, state };
}

function makeUsage(
    input: number,
    output: number,
    cachedTokens?: number,
    extra?: Partial<TokenUsage>,
): TokenUsage {
    return {
        input,
        output,
        total: input + output,
        estimatedCostCny: 0,
        cachedTokens,
        ...extra,
    };
}

describe('Auxiliary provider-call usage', () => {
    it('normalizes tokens, cache savings, purpose, and mode for non-runner calls', () => {
        const sample = buildProviderCallTokenUsage({
            id: 'route-1',
            object: 'chat.completion',
            created: 1,
            model: 'deepseek-v4-pro',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: '{"mode":"plan"}' },
                finish_reason: 'stop',
            }],
            usage: {
                prompt_tokens: 1000,
                completion_tokens: 100,
                total_tokens: 1100,
                cached_tokens: 400,
            },
        }, [
            { role: 'system', content: 'route' },
            { role: 'user', content: 'explain this project' },
        ], {
            providerId: 'deepseek',
            requestedModel: 'deepseek-v4-pro',
            agentMode: 'routing',
            purpose: 'routing',
        });

        expect(sample.providerId).to.equal('deepseek');
        expect(sample.usage).to.include({
            input: 1000,
            output: 100,
            total: 1100,
            cachedTokens: 400,
            netInput: 600,
            netTotal: 700,
            apiCalls: 1,
            agentMode: 'routing',
        });
        expect(sample.usage.cacheSavedCostCny).to.be.greaterThan(0);
        expect(sample.usage.cacheRequests?.[0]).to.deep.include({
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            inputTokens: 1000,
            cachedTokens: 400,
            cacheCapable: true,
            agentMode: 'routing',
            purpose: 'routing',
        });
    });

    it('falls back to deterministic estimates when a provider omits usage', () => {
        const sample = buildProviderCallTokenUsage({
            id: 'title-1',
            object: 'chat.completion',
            created: 1,
            model: 'unknown-local-model',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: 'Short title' },
                finish_reason: 'stop',
            }],
        }, [{ role: 'user', content: 'Generate a title for this task.' }], {
            providerId: 'custom',
            requestedModel: 'unknown-local-model',
            agentMode: 'title',
            purpose: 'title',
        });

        expect(sample.usage.input).to.be.greaterThan(0);
        expect(sample.usage.output).to.be.greaterThan(0);
        expect(sample.usage.total).to.equal(sample.usage.input + sample.usage.output);
        expect(sample.usage.apiCalls).to.equal(1);
    });
});

describe('UsageTracker cache hit-rate denominator', () => {
    it('counts zero-hit cache-capable requests in the hit-rate denominator', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);

        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 0));
        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 500));

        const stats = tracker.getStats();
        expect(stats.cacheStats.cacheCapableInputTokens).to.equal(2000);
        // 500 / 2000 = 25 — the old denominator (only hit requests) would report 50.
        expect(stats.cacheStats.cacheHitRate).to.equal(25);
        expect(stats.cacheStats.cachedInputTokenRatio).to.equal(25);
    });

    it('excludes non-cache-capable providers from the denominator but keeps them in the ratio', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);

        tracker.addUsage('anthropic', 'claude-sonnet', makeUsage(4000, 100, 0));
        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 500));

        const stats = tracker.getStats();
        expect(stats.cacheStats.cacheCapableInputTokens).to.equal(1000);
        expect(stats.cacheStats.cacheHitRate).to.equal(50);
        expect(stats.cacheStats.totalInputTokens).to.equal(5000);
        expect(stats.cacheStats.cachedInputTokenRatio).to.equal(10);
    });

    it('honours an explicit cacheCapable flag and persists it on the record', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context, state } = makeContext();
        const tracker = new UsageTracker(context);

        // Custom endpoint speaking an OpenAI wire format: the caller (chatPanel)
        // passes the format-aware flag because the provider id alone is ambiguous.
        tracker.addUsage('custom', 'my-model', makeUsage(2000, 100, 0), { cacheCapable: true });
        // Same provider id without the flag: inference cannot prove capability.
        tracker.addUsage('custom', 'my-model', makeUsage(8000, 100, 0));

        const stats = tracker.getStats();
        expect(stats.cacheStats.cacheCapableInputTokens).to.equal(2000);
        expect(stats.cacheStats.cacheHitRate).to.equal(0);

        const persisted = state.get<{ records: Array<{ cacheCapable?: boolean }> }>(STORAGE_KEY);
        expect(persisted?.records[0]?.cacheCapable).to.equal(true);
        expect(persisted?.records[1]?.cacheCapable).to.equal(false);
    });

    it('infers capability for legacy records without the flag', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context, state } = makeContext();
        state.seed({
            version: 1,
            records: [
                legacyRecord({ provider: 'deepseek', inputTokens: 1000, cachedTokens: 0 }),
                legacyRecord({ provider: 'gemini', inputTokens: 1000, cachedTokens: 300 }),
                legacyRecord({ provider: 'anthropic', inputTokens: 2000, cachedTokens: 0 }),
            ],
        });
        const tracker = new UsageTracker(context);

        const stats = tracker.getStats();
        // deepseek is capable by provider rule; the gemini hit proves capability;
        // the zero-hit anthropic record stays excluded.
        expect(stats.cacheStats.cacheCapableInputTokens).to.equal(2000);
        expect(stats.cacheStats.cacheHitRate).to.equal(15);
        expect(stats.cacheStats.cachedInputTokenRatio).to.equal(7.5);
    });

    it('keeps estimatedSavingsCny additive over pre-computed record savings', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);

        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 500, { cacheSavedCostCny: 0.25 }));
        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 500, { cacheSavedCostCny: 0.75 }));

        expect(tracker.getStats().cacheStats.estimatedSavingsCny).to.equal(1);
    });
});

describe('UsageTracker request-level cache metrics (plan §7.3)', () => {
    it('computes requestHitRate over cache-capable requests including zero-hit ones', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);

        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 600));
        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 0));
        tracker.addUsage('anthropic', 'claude-sonnet', makeUsage(4000, 100, 0));

        const stats = tracker.getStats();
        // Two cache-capable deepseek requests, one with a hit: 50%.
        expect(stats.cacheStats.requestHitRate).to.equal(50);
        // The non-capable anthropic request stays out of the request-level rate too.
        expect(stats.cacheStats.cacheCapableInputTokens).to.equal(2000);
    });

    it('aggregates cache stats by agent mode with an unspecified bucket', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);

        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 800, { agentMode: 'build' }));
        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 0, { agentMode: 'build' }));
        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(500, 100, 250, { agentMode: 'plan' }));
        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(200, 100, 0));

        const byMode = tracker.getStats().cacheStats.byAgentMode;
        expect(Object.keys(byMode)).to.deep.equal(['build', 'plan', 'unspecified']);
        expect(byMode.build).to.deep.equal({ requests: 2, hitRequests: 1, requestHitRate: 50, cacheHitRate: 40 });
        expect(byMode.plan).to.deep.equal({ requests: 1, hitRequests: 1, requestHitRate: 100, cacheHitRate: 50 });
        expect(byMode.unspecified).to.deep.equal({ requests: 1, hitRequests: 0, requestHitRate: 0, cacheHitRate: 0 });
    });

    it('persists agentMode and promptFingerprint on the usage record', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context, state } = makeContext();
        const tracker = new UsageTracker(context);

        tracker.addUsage('deepseek', 'deepseek-chat', makeUsage(1000, 100, 500, {
            agentMode: 'build',
            promptFingerprint: 'abc123def456',
        }));

        const persisted = state.get<{ records: Array<{ agentMode?: string; promptFingerprint?: string }> }>(STORAGE_KEY);
        expect(persisted?.records[0]?.agentMode).to.equal('build');
        expect(persisted?.records[0]?.promptFingerprint).to.equal('abc123def456');
    });

    it('uses provider-call samples for true request rates and every required grouping dimension', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);

        tracker.addUsage('deepseek', 'run-level-model', makeUsage(3000, 300, 1500, {
            cacheRequests: [
                {
                    provider: 'deepseek', model: 'deepseek-chat', inputTokens: 1000, cachedTokens: 800,
                    cacheCapable: true, agentMode: 'build', toolFocus: 'discovery', promptFingerprint: 'fp-a', purpose: 'reasoning',
                },
                {
                    provider: 'deepseek', model: 'deepseek-chat', inputTokens: 1000, cachedTokens: 0,
                    cacheCapable: true, agentMode: 'build', toolFocus: 'validation', promptFingerprint: 'fp-b', purpose: 'reasoning',
                    invalidationReason: 'toolset_changed',
                },
                {
                    provider: 'openai', model: 'gpt-5', inputTokens: 1000, cachedTokens: 700,
                    cacheCapable: true, agentMode: 'build', toolFocus: 'validation', promptFingerprint: 'fp-b', purpose: 'fallback',
                },
            ],
        }));

        const cache = tracker.getStats().cacheStats;
        expect(cache.requestHitRate).to.equal(66.67);
        expect(cache.cacheHitRate).to.equal(50);
        expect(cache.byProvider.deepseek).to.deep.equal({ requests: 2, hitRequests: 1, requestHitRate: 50, cacheHitRate: 40 });
        expect(cache.byProvider.openai).to.deep.equal({ requests: 1, hitRequests: 1, requestHitRate: 100, cacheHitRate: 70 });
        expect(cache.byModel['deepseek-chat']?.requests).to.equal(2);
        expect(cache.byAgentMode.build?.requests).to.equal(3);
        expect(cache.byToolFocus.discovery?.requests).to.equal(1);
        expect(cache.byToolFocus.validation?.requests).to.equal(2);
        expect(cache.byPromptFingerprint['fp-a']?.requests).to.equal(1);
        expect(cache.byPromptFingerprint['fp-b']?.requests).to.equal(2);
        expect(cache.invalidationReasons).to.deep.equal({ toolset_changed: 1 });
    });

    it('counts zero-hit native Claude and Gemini requests as cache-capable warmups', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);

        tracker.addUsage('claude', 'claude-sonnet', makeUsage(1000, 100, 0));
        tracker.addUsage('google', 'gemini-3', makeUsage(1000, 100, 0));

        const cache = tracker.getStats().cacheStats;
        expect(cache.cacheCapableInputTokens).to.equal(2000);
        expect(cache.requestHitRate).to.equal(0);
        expect(cache.invalidationReasons).to.deep.equal({ provider_miss: 2 });
    });

    it('rolls up cache calls beyond the per-request sample cap without losing totals', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);
        const usage = makeUsage(3000, 100, 1500);
        for (let i = 0; i < 300; i++) {
            appendCacheRequestUsage(usage, {
                provider: 'deepseek',
                model: 'deepseek-chat',
                inputTokens: 10,
                cachedTokens: i % 2 === 0 ? 5 : 0,
                cacheCapable: true,
                agentMode: 'script',
                toolFocus: 'write',
                purpose: 'reasoning',
                invalidationReason: i % 2 === 0 ? undefined : 'provider_miss',
            });
        }
        tracker.addUsage('deepseek', 'deepseek-chat', usage);

        const cache = tracker.getStats().cacheStats;
        expect(usage.cacheRequests).to.have.lengthOf(256);
        expect(usage.cacheRequestOverflow).to.not.be.empty;
        expect(cache.byProvider.deepseek?.requests).to.equal(300);
        expect(cache.byProvider.deepseek?.hitRequests).to.equal(150);
        expect(cache.totalInputTokens).to.equal(3000);
        expect(cache.totalCachedTokens).to.equal(750);
    });

    it('uses an explicit remainder instead of attributing the 65th overflow dimension to another provider', () => {
        const { UsageTracker } = loadUsageTrackerModule();
        const { context } = makeContext();
        const tracker = new UsageTracker(context);
        const usage = makeUsage(3220, 10, 5);

        for (let i = 0; i < 256; i++) {
            appendCacheRequestUsage(usage, {
                provider: 'seed-provider',
                model: 'seed-model',
                inputTokens: 10,
                cachedTokens: 0,
                cacheCapable: false,
            });
        }
        for (let i = 0; i < 64; i++) {
            appendCacheRequestUsage(usage, {
                provider: `overflow-${i}`,
                model: `model-${i}`,
                inputTokens: 10,
                cachedTokens: 0,
                cacheCapable: false,
                promptFingerprint: `fp-${i}`,
            });
        }
        appendCacheRequestUsage(usage, {
            provider: 'capable-hit-tail',
            model: 'tail-model',
            inputTokens: 10,
            cachedTokens: 5,
            cacheCapable: true,
            promptFingerprint: 'fp-hit-tail',
        });
        appendCacheRequestUsage(usage, {
            provider: 'capable-miss-tail',
            model: 'tail-model',
            inputTokens: 10,
            cachedTokens: 0,
            cacheCapable: true,
            promptFingerprint: 'fp-miss-tail',
        });
        tracker.addUsage('mixed', 'mixed', usage);

        const cache = tracker.getStats().cacheStats;
        expect(usage.cacheRequestOverflow).to.have.lengthOf(64);
        expect(usage.cacheRequestRemainder).to.have.lengthOf(1);
        expect(cache.byProvider['overflow-63']).to.equal(undefined);
        expect(cache.byProvider.__other__).to.include({ requests: 2, hitRequests: 1, requestHitRate: 50 });
        expect(cache.requestHitRate).to.equal(50);
        expect(cache.invalidationReasons.dimension_overflow).to.equal(1);
    });
});

function legacyRecord(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        timestamp: Date.now(),
        provider: 'unknown',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costCny: 0,
        ...overrides,
    };
}

function loadUsageTrackerModule() {
    const moduleLoader = require('module') as typeof import('module') & {
        _load: (request: string, ...args: unknown[]) => unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: unknown[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/usageTracker')];
        return require('../../extension/ai/usageTracker') as typeof import('../../extension/ai/usageTracker');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    window: {
        activeTextEditor: undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
        showErrorMessage: () => Promise.resolve(undefined),
    },
};
