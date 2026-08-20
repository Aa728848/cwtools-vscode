/**
 * Eddy CWTool Code — Delegation-depth accounting.
 *
 * The recursion budget a coordinator passes to the children it dispatches.
 * Kept in its own module so the dispatch gate, the orchestrator and the durable
 * store can all agree on one arithmetic without importing each other.
 *
 * Two properties matter and are the whole reason this is not an inline number:
 *
 * 1. **Monotone.** The persisted graph depth is a floor. A runtime value may
 *    DEEPEN the count but can never lower it, because a resumed coordinator
 *    arrives with fresh options and counting it from zero would let a nested
 *    coordinator delegate as if it were top level.
 * 2. **Explicit.** Sub-agents are additionally denied the orchestration tools
 *    by `SUB_AGENT_EXCLUDES`, which makes deeper delegation impossible today.
 *    That is a tool-visibility policy, not a budget: it cannot express "read-only
 *    evidence children may fan out one more level" and it is invisible to the
 *    model. This module is the budget; the exclusion list stays as defence in
 *    depth behind it.
 */

/**
 * Default recursion cap: a top-level coordinator may dispatch children, and
 * those children may not dispatch further.
 *
 * This is intentionally NOT raised to match a general-purpose harness. The
 * Paradox write contract depends on `plannedFiles ∩ parentWritableRoots`
 * clamping and on write-intent conflict detection covering every writer in the
 * wave; a grandchild writer the coordinator never declared would escape both.
 */
export const DEFAULT_MAX_DELEGATION_DEPTH = 1;

/** Absolute ceiling accepted from configuration, independent of the default. */
export const MAX_CONFIGURABLE_DELEGATION_DEPTH = 4;

/**
 * Reject a depth that cannot represent an exact delegation level.
 * @param value Candidate depth from runtime options or a persisted record.
 * @param label Field name used in the thrown message.
 */
export function assertDelegationDepth(value: unknown, label = 'delegationDepth'): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer, received ${JSON.stringify(value)}.`);
    }
}

/**
 * Read a depth, treating absence as top-level depth zero.
 * Invalid values are treated as absent rather than thrown so a corrupted stored
 * record can never take down a dispatch; the monotone fold below still keeps the
 * larger of the two candidates, so an unreadable value cannot lower the count.
 */
export function normalizeDelegationDepth(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 0;
    return value;
}

/**
 * Fold the runtime depth with a persisted floor. The result is the larger of the
 * two, so a resume can only ever be counted deeper, never shallower.
 */
export function monotoneDelegationDepth(runtimeValue: unknown, persistedFloor?: unknown): number {
    return Math.max(normalizeDelegationDepth(runtimeValue), normalizeDelegationDepth(persistedFloor));
}

/** Clamp a configured cap into the supported range, falling back to the default. */
export function resolveMaxDelegationDepth(configured: unknown): number {
    if (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured < 0) {
        return DEFAULT_MAX_DELEGATION_DEPTH;
    }
    return Math.min(configured, MAX_CONFIGURABLE_DELEGATION_DEPTH);
}

export interface DelegationBudgetDecision {
    /** Whether this coordinator may dispatch children at all. */
    allowed: boolean;
    /** Monotone depth of the coordinator that asked. */
    parentDepth: number;
    /** Depth every child of this wave would run at. */
    childDepth: number;
    /** Effective cap applied to the decision. */
    maxDepth: number;
    /** Model-facing explanation, present only when rejected. */
    reason?: string;
}

/**
 * Decide whether a coordinator at `parentDepth` may open one more delegation
 * level. `maxDepth` counts delegation levels, so `0` forbids delegation and the
 * default `1` allows exactly one level of children.
 */
export function evaluateDelegationBudget(input: {
    parentDepth: unknown;
    persistedFloor?: unknown;
    maxDepth?: unknown;
}): DelegationBudgetDecision {
    const parentDepth = monotoneDelegationDepth(input.parentDepth, input.persistedFloor);
    const maxDepth = resolveMaxDelegationDepth(input.maxDepth);
    const childDepth = parentDepth + 1;
    if (childDepth > maxDepth) {
        return {
            allowed: false,
            parentDepth,
            childDepth,
            maxDepth,
            reason: maxDepth === 0
                ? 'Delegation is disabled for this workspace (maxDelegationDepth = 0). Do the work directly in this agent.'
                : `Delegation depth budget exhausted: this agent already runs at delegation depth ${parentDepth} and the cap is ${maxDepth}. `
                    + 'A dispatched sub-agent cannot dispatch further — finish this slice yourself and report what remains, '
                    + 'so the coordinator that started you keeps one accountable write contract.',
        };
    }
    return { allowed: true, parentDepth, childDepth, maxDepth };
}
