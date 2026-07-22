/** Deterministic soft/hard runtime budget evaluation (plan sections 5.2 and 10). */

export interface RunBudgetLimits {
    modelCalls: number;
    wallTimeMs: number;
    uncachedInputTokens: number;
}

export interface RunBudgetUsage {
    modelCalls: number;
    wallTimeMs: number;
    uncachedInputTokens: number;
}

export type RunBudgetDimension = keyof RunBudgetLimits;

export interface RunBudgetEvaluation {
    state: 'within' | 'soft' | 'hard';
    exceeded: RunBudgetDimension[];
    limits: RunBudgetLimits;
    /** Absolute non-renewable limits for the whole run. */
    hardLimits: RunBudgetLimits;
    usage: RunBudgetUsage;
}

export interface RunBudgetProgressState {
    progressRevision: number;
    lastExtendedProgressRevision: number;
    consecutiveErrors: number;
    blockingValidationIssues: number;
}

function positiveFinite(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeRunBudgetLimits(limits: RunBudgetLimits): RunBudgetLimits {
    return {
        modelCalls: Math.floor(positiveFinite(limits.modelCalls, 64)),
        wallTimeMs: Math.floor(positiveFinite(limits.wallTimeMs, 20 * 60_000)),
        uncachedInputTokens: Math.floor(positiveFinite(limits.uncachedInputTokens, 300_000)),
    };
}

export function normalizeHardBudgetMultiplier(value: number): number {
    if (!Number.isFinite(value)) return 4;
    return Math.min(100, Math.max(2, Math.floor(value)));
}

/**
 * Productive runs may renew a soft window without stopping for approval. Reads
 * alone do not count: the caller advances progressRevision only for durable
 * mutations, completed todos, or an observed diagnostic improvement.
 */
export function shouldAutoExtendRunBudget(state: RunBudgetProgressState): boolean {
    return state.progressRevision > state.lastExtendedProgressRevision
        && state.consecutiveErrors === 0
        && state.blockingValidationIssues === 0;
}

export class RunBudgetTracker {
    private window = 1;

    constructor(
        private readonly baseLimits: RunBudgetLimits,
        private readonly startedAt = Date.now(),
        private readonly hardBudgetMultiplier = 4,
    ) {
        this.baseLimits = normalizeRunBudgetLimits(baseLimits);
        this.hardBudgetMultiplier = normalizeHardBudgetMultiplier(hardBudgetMultiplier);
    }

    public extend(): void {
        this.window++;
    }

    public evaluate(
        modelCalls: number,
        uncachedInputTokens: number,
        now = Date.now(),
    ): RunBudgetEvaluation {
        const limits: RunBudgetLimits = {
            modelCalls: this.baseLimits.modelCalls * this.window,
            wallTimeMs: this.baseLimits.wallTimeMs * this.window,
            uncachedInputTokens: this.baseLimits.uncachedInputTokens * this.window,
        };
        const hardLimits: RunBudgetLimits = {
            modelCalls: this.baseLimits.modelCalls * this.hardBudgetMultiplier,
            wallTimeMs: this.baseLimits.wallTimeMs * this.hardBudgetMultiplier,
            uncachedInputTokens: this.baseLimits.uncachedInputTokens * this.hardBudgetMultiplier,
        };
        const usage: RunBudgetUsage = {
            modelCalls: Math.max(0, modelCalls),
            wallTimeMs: Math.max(0, now - this.startedAt),
            uncachedInputTokens: Math.max(0, uncachedInputTokens),
        };
        const exceeded = (Object.keys(limits) as RunBudgetDimension[])
            .filter(key => usage[key] >= limits[key]);
        const hardExceeded = (Object.keys(hardLimits) as RunBudgetDimension[])
            .filter(key => usage[key] >= hardLimits[key]);
        return {
            state: hardExceeded.length > 0 ? 'hard' : exceeded.length > 0 ? 'soft' : 'within',
            exceeded: hardExceeded.length > 0 ? hardExceeded : exceeded,
            limits,
            hardLimits,
            usage,
        };
    }
}

export function shouldPersistResumeSnapshot(input: {
    force?: boolean;
    iteration: number;
    lastIteration: number;
    intervalIterations: number;
    now: number;
    lastSavedAt: number;
    minIntervalMs: number;
}): boolean {
    if (input.force) return true;
    return input.iteration - input.lastIteration >= input.intervalIterations
        || input.now - input.lastSavedAt >= input.minIntervalMs;
}

/** Preserve a checkpoint when execution paused even if it returned a final-looking summary. */
export function shouldRetainResumeState(
    pauseMarked: boolean,
    steps: ReadonlyArray<{ type: string; content: unknown }>,
): boolean {
    return pauseMarked || steps.some(step =>
        step.type === 'error' && String(step.content).startsWith('Max tool iterations reached'));
}
