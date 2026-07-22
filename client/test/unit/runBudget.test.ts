import { expect } from 'chai';
import {
    RunBudgetTracker,
    normalizeHardBudgetMultiplier,
    normalizeRunBudgetLimits,
    shouldAutoExtendRunBudget,
    shouldPersistResumeSnapshot,
    shouldRetainResumeState,
} from '../../extension/ai/runner/runBudget';

describe('RunBudgetTracker', () => {
    it('reports independent model-call, wall-time, and uncached-token soft limits', () => {
        const tracker = new RunBudgetTracker({ modelCalls: 10, wallTimeMs: 1_000, uncachedInputTokens: 100 }, 5_000);
        expect(tracker.evaluate(9, 99, 5_999).state).to.equal('within');
        expect(tracker.evaluate(10, 99, 5_999)).to.include({ state: 'soft' });
        expect(tracker.evaluate(9, 100, 5_999).exceeded).to.deep.equal(['uncachedInputTokens']);
        expect(tracker.evaluate(9, 99, 6_000).exceeded).to.deep.equal(['wallTimeMs']);
    });

    it('uses a fixed non-renewable emergency hard limit', () => {
        const tracker = new RunBudgetTracker({ modelCalls: 10, wallTimeMs: 1_000, uncachedInputTokens: 100 }, 0, 4);
        tracker.extend();
        tracker.extend();
        tracker.extend();
        const result = tracker.evaluate(40, 0, 0);
        expect(result.state).to.equal('hard');
        expect(result.exceeded).to.deep.equal(['modelCalls']);
        expect(result.hardLimits.modelCalls).to.equal(40);
    });

    it('extends every limit after explicit continuation approval', () => {
        const tracker = new RunBudgetTracker({ modelCalls: 10, wallTimeMs: 1_000, uncachedInputTokens: 100 }, 0);
        expect(tracker.evaluate(10, 0, 0).state).to.equal('soft');
        tracker.extend();
        expect(tracker.evaluate(10, 0, 0).state).to.equal('within');
        expect(tracker.evaluate(20, 0, 0).state).to.equal('soft');
    });

    it('normalizes untrusted non-positive configuration values', () => {
        expect(normalizeRunBudgetLimits({ modelCalls: 0, wallTimeMs: Number.NaN, uncachedInputTokens: -1 }))
            .to.deep.equal({ modelCalls: 64, wallTimeMs: 1_200_000, uncachedInputTokens: 300_000 });
        expect(normalizeHardBudgetMultiplier(Number.NaN)).to.equal(4);
        expect(normalizeHardBudgetMultiplier(1)).to.equal(2);
        expect(normalizeHardBudgetMultiplier(1_000)).to.equal(100);
    });

    it('auto-extends only when durable progress is healthy', () => {
        expect(shouldAutoExtendRunBudget({
            progressRevision: 2,
            lastExtendedProgressRevision: 1,
            consecutiveErrors: 0,
            blockingValidationIssues: 0,
        })).to.equal(true);
        expect(shouldAutoExtendRunBudget({
            progressRevision: 1,
            lastExtendedProgressRevision: 1,
            consecutiveErrors: 0,
            blockingValidationIssues: 0,
        })).to.equal(false);
        expect(shouldAutoExtendRunBudget({
            progressRevision: 2,
            lastExtendedProgressRevision: 1,
            consecutiveErrors: 1,
            blockingValidationIssues: 0,
        })).to.equal(false);
        expect(shouldAutoExtendRunBudget({
            progressRevision: 2,
            lastExtendedProgressRevision: 1,
            consecutiveErrors: 0,
            blockingValidationIssues: 1,
        })).to.equal(false);
    });

    it('persists resume snapshots periodically or on forced terminal boundaries', () => {
        const base = {
            iteration: 9,
            lastIteration: 0,
            intervalIterations: 10,
            now: 29_999,
            lastSavedAt: 0,
            minIntervalMs: 30_000,
        };
        expect(shouldPersistResumeSnapshot(base)).to.equal(false);
        expect(shouldPersistResumeSnapshot({ ...base, iteration: 10 })).to.equal(true);
        expect(shouldPersistResumeSnapshot({ ...base, now: 30_000 })).to.equal(true);
        expect(shouldPersistResumeSnapshot({ ...base, force: true })).to.equal(true);
    });

    it('retains resume state for budget/doom-loop pauses and max-iteration summaries', () => {
        expect(shouldRetainResumeState(true, [])).to.equal(true);
        expect(shouldRetainResumeState(false, [{ type: 'error', content: 'Max tool iterations reached (10/10).' }])).to.equal(true);
        expect(shouldRetainResumeState(false, [{ type: 'thinking', content: 'done' }])).to.equal(false);
    });
});
