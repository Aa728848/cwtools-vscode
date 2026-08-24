import { expect } from 'chai';
import {
    RunBudgetTracker,
    normalizeHardBudgetMultiplier,
    normalizeRunBudgetLimits,
    selectHardBudgetMultiplier,
    shouldAutoExtendRunBudget,
    shouldAutoExtendSubAgentBudget,
    shouldPersistResumeSnapshot,
    shouldRetainResumeState,
} from '../../extension/ai/runner/runBudget';
import {
    createTerminalValidationState,
    hasOnlyPendingValidationErrors,
    terminalValidationOutcome,
    updateTerminalValidationState,
} from '../../extension/ai/runner/terminalValidation';

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
        expect(normalizeHardBudgetMultiplier(Number.NaN)).to.equal(8);
        expect(normalizeHardBudgetMultiplier(1)).to.equal(2);
        expect(normalizeHardBudgetMultiplier(1_000)).to.equal(100);
    });

    it('uses a much higher emergency ceiling for active durable goals', () => {
        expect(selectHardBudgetMultiplier({
            durableGoal: false,
            regularMultiplier: Number.NaN,
            goalMultiplier: Number.NaN,
        })).to.equal(8);
        expect(selectHardBudgetMultiplier({
            durableGoal: true,
            regularMultiplier: 6,
            goalMultiplier: Number.NaN,
        })).to.equal(32);
        expect(selectHardBudgetMultiplier({
            durableGoal: true,
            regularMultiplier: 6,
            goalMultiplier: 2,
        })).to.equal(8);
        expect(selectHardBudgetMultiplier({
            durableGoal: true,
            regularMultiplier: 6,
            goalMultiplier: 64,
        })).to.equal(64);
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

    it('auto-extends an active healthy sub-agent even when its work is read-only', () => {
        expect(shouldAutoExtendSubAgentBudget({
            isSubAgent: true,
            iteration: 24,
            lastExtendedIteration: 0,
            consecutiveErrors: 0,
            blockingValidationIssues: 0,
        })).to.equal(true);
        expect(shouldAutoExtendSubAgentBudget({
            isSubAgent: true,
            iteration: 24,
            lastExtendedIteration: 24,
            consecutiveErrors: 0,
            blockingValidationIssues: 0,
        })).to.equal(false);
        expect(shouldAutoExtendSubAgentBudget({
            isSubAgent: true,
            iteration: 24,
            lastExtendedIteration: 0,
            consecutiveErrors: 1,
            blockingValidationIssues: 0,
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

describe('terminal validation state', () => {
    it('keeps pending writes out of the completed path until a later allow supersedes them', () => {
        const state = createTerminalValidationState();
        updateTerminalValidationState(state, ['events/test.txt'], {
            requiresValidation: true,
            postWriteValidation: { verdict: 'pending' },
        });
        expect(terminalValidationOutcome(state)).to.equal('pending');

        updateTerminalValidationState(state, ['events/test.txt'], {
            postWriteValidationPassed: true,
            postWriteValidation: { verdict: 'allow' },
        });
        expect(terminalValidationOutcome(state)).to.equal('allow');
    });

    it('prioritizes repair over pending across different targets', () => {
        const state = createTerminalValidationState();
        updateTerminalValidationState(state, ['events/pending.txt'], { requiresValidation: true });
        updateTerminalValidationState(state, ['events/broken.txt'], { requiresRepair: true });
        expect(terminalValidationOutcome(state)).to.equal('repair');
    });

    it('resolves coverage-only pending after fresh full-file diagnostics', () => {
        const state = createTerminalValidationState();
        updateTerminalValidationState(state, ['interface/large.gfx'], {
            requiresValidation: true,
            postWriteValidation: { verdict: 'pending' },
            postWriteEvidence: {
                missingEvidence: [{
                    claim: 'semantic evidence extraction covers the complete written file',
                    status: 'unknown',
                }],
            },
        });
        expect(terminalValidationOutcome(state)).to.equal('pending');

        updateTerminalValidationState(state, ['interface/large.gfx'], {
            diagnostics: [],
            freshness: 'fresh',
        });
        expect(terminalValidationOutcome(state)).to.equal('allow');
    });

    it('treats fresh diagnostic errors as terminal repair work', () => {
        const state = createTerminalValidationState();
        updateTerminalValidationState(state, ['events/test.txt'], {
            diagnostics: [{ severity: 'error', message: 'broken' }],
            freshness: 'fresh',
        });
        expect(terminalValidationOutcome(state)).to.equal('repair');
    });

    it('does not treat comparable pre-existing diagnostic errors as new repair work', () => {
        const state = createTerminalValidationState();
        updateTerminalValidationState(state, ['events/test.txt'], {
            diagnostics: [{ severity: 'error', message: 'pre-existing' }],
            freshness: 'fresh',
            diagnosticDelta: { comparable: true, added: [], removed: [] },
        });
        expect(terminalValidationOutcome(state)).to.equal('allow');
    });

    it('treats only newly introduced delta errors as repair work', () => {
        const state = createTerminalValidationState();
        updateTerminalValidationState(state, ['events/test.txt'], {
            diagnostics: [{ severity: 'error', message: 'old' }, { severity: 'error', message: 'new' }],
            freshness: 'fresh',
            diagnosticDelta: {
                comparable: true,
                added: [{ severity: 'error', message: 'new', code: 'new', source: 'cwtools', line: 2, column: 1 }],
                removed: [],
            },
        });
        expect(terminalValidationOutcome(state)).to.equal('repair');
    });

    it('retains a run-introduced error until a fresh snapshot removes its identity', () => {
        const state = createTerminalValidationState();
        const introduced = { severity: 'error', message: 'new', code: 'new', source: 'cwtools', line: 2, column: 1 };
        const snapshot = (diagnostics: typeof introduced[]) => ({ status: 'fresh' as const, complete: true, diagnostics });

        updateTerminalValidationState(state, ['events/test.txt'], {
            diagnostics: [introduced], freshness: 'fresh', diagnosticSnapshot: snapshot([introduced]),
            diagnosticDelta: { comparable: true, added: [introduced], removed: [] },
        });
        expect(terminalValidationOutcome(state)).to.equal('repair');

        updateTerminalValidationState(state, ['events/test.txt'], {
            diagnostics: [introduced], freshness: 'fresh', diagnosticSnapshot: snapshot([introduced]),
            diagnosticDelta: { comparable: true, added: [], removed: [] },
        });
        expect(terminalValidationOutcome(state)).to.equal('repair');

        updateTerminalValidationState(state, ['events/test.txt'], {
            diagnostics: [], freshness: 'fresh', diagnosticSnapshot: snapshot([]),
            diagnosticDelta: { comparable: true, added: [], removed: [introduced] },
        });
        expect(terminalValidationOutcome(state)).to.equal('allow');
    });

    it('keeps pre-existing errors non-blocking while reconciling introduced errors', () => {
        const state = createTerminalValidationState();
        const oldError = { severity: 'error', message: 'old', code: 'old', source: 'cwtools', line: 1, column: 1 };
        updateTerminalValidationState(state, ['events/test.txt'], {
            diagnostics: [oldError], freshness: 'fresh',
            diagnosticSnapshot: { status: 'fresh', complete: true, diagnostics: [oldError] },
            diagnosticDelta: { comparable: true, added: [], removed: [] },
        });
        expect(terminalValidationOutcome(state)).to.equal('allow');
    });

    it('keeps stale diagnostic errors pending instead of treating them as repair', () => {
        const state = createTerminalValidationState();
        updateTerminalValidationState(state, ['events/test.txt'], {
            diagnostics: [{ severity: 'error', message: 'old broken state' }],
            freshness: 'stale',
        });
        expect(terminalValidationOutcome(state)).to.equal('pending');
    });

    it('pauses only when pending is not accompanied by a real validation error', () => {
        expect(hasOnlyPendingValidationErrors([
            { code: 'VALIDATION_PENDING', severity: 'error' },
            { code: 'advisory', severity: 'warning' },
        ])).to.equal(true);
        expect(hasOnlyPendingValidationErrors([
            { code: 'VALIDATION_PENDING', severity: 'error' },
            { code: 'syntax_error', severity: 'error' },
        ])).to.equal(false);
    });
});
