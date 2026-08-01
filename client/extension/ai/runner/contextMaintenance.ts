/**
 * Context Maintenance Coordinator (P0 design 2).
 *
 * Single decision point for "free in-place prune before paid summarization".
 * Every paid-compaction entry (admission / manual / mid-loop / overflow /
 * emergency) runs the same ladder:
 *
 *   estimate (unified) -> free prune -> re-estimate -> decide
 *
 * …but the *decision* is reason-aware:
 * - admission: histories under threshold are returned untouched (no mutation);
 * - manual / overflow: always summarize — a manual request is explicit and a
 *   provider-reported overflow is authoritative; the prune only shrinks the
 *   summarizer input;
 * - mid_loop: escalate to paid only when still over threshold AND the prune
 *   freed < 10% (preserves the pre-existing anti-thrash gate);
 * - emergency: summarize when still over the emergency threshold.
 *
 * The per-message estimate is the unified `estimateChatMessageTokens` (counts
 * tool_calls / reasoning / provider continuation state), replacing the older
 * content-only estimate at the decision layer. `extraTokens` keeps each
 * caller's existing accounting convention (tool schemas, reserved output),
 * so thresholds stay comparable to their pre-refactor values.
 */
import type { ChatMessage } from '../types';
import { compactMessagesInPlace, type CompactMessagesOptions } from '../contextBudget';
import { estimateChatMessagesTokens } from './tokenEstimation';

export type MaintenanceReason = 'admission' | 'manual' | 'mid_loop' | 'overflow' | 'emergency';

export type MaintenanceAction =
    /** admission only: below threshold, history returned unmodified. */
    | 'untouched'
    /** Free prune brought the estimate under threshold; skip the paid summarizer. */
    | 'pruned-below-threshold'
    /** Paid summarization should run. */
    | 'summarize';

export interface MaintenanceDeps {
    /** Squeeze aggressiveness for old tool results (see contextBudget). */
    toolResultBudget: number;
    compactionOptions?: CompactMessagesOptions;
    /**
     * Caller-calibrated extra tokens added to the per-message estimate
     * (tool schemas / reserved output / fixed prompt, per call-site convention).
     */
    extraTokens: number;
    /**
     * Paid-summarization threshold in the same units as the estimate.
     * Ignored for manual/overflow (they always summarize).
     */
    summarizeThreshold: number;
    /**
     * When true, escalate to paid only if the prune freed < 10% of tokens
     * (mid_loop anti-thrash gate, preserved from the pre-refactor behavior).
     */
    ineffectivenessGate?: boolean;
    /**
     * Optional real-usage calibration (runner/tokenCalibration). Applied to
     * the before/after estimates so thresholds compare calibrated values.
     */
    calibrateEstimate?: (tokens: number) => number;
}

export interface MaintenanceResult {
    /** The (possibly in-place pruned) history. Same array reference as the input. */
    messages: ChatMessage[];
    beforeTokens: number;
    afterTokens: number;
    action: MaintenanceAction;
}

/** Unified request-size estimate: per-message tokens (incl. tool_calls/reasoning) + extras. */
export function estimateContextRequestTokens(messages: readonly ChatMessage[], extraTokens = 0): number {
    return estimateChatMessagesTokens(messages) + extraTokens;
}

/**
 * Run the free-prune ladder over `messages` (mutated in place when pruned) and
 * decide whether paid summarization should follow. This function never calls
 * the model; the caller is responsible for the paid path when the action is
 * 'summarize'.
 */
export function runContextMaintenance(
    messages: ChatMessage[],
    reason: MaintenanceReason,
    deps: MaintenanceDeps,
): MaintenanceResult {
    const calibrate = deps.calibrateEstimate ?? ((tokens: number) => tokens);
    const beforeTokens = calibrate(estimateContextRequestTokens(messages, deps.extraTokens));
    if (reason === 'admission' && beforeTokens <= deps.summarizeThreshold) {
        return { messages, beforeTokens, afterTokens: beforeTokens, action: 'untouched' };
    }

    compactMessagesInPlace(messages, deps.toolResultBudget, deps.compactionOptions);
    const afterTokens = calibrate(estimateContextRequestTokens(messages, deps.extraTokens));

    let summarize: boolean;
    switch (reason) {
        case 'manual':
        case 'overflow':
            // Manual compaction is an explicit user request; a provider-reported
            // overflow is authoritative. Both must produce a summary — the prune
            // only shrinks the summarizer input.
            summarize = true;
            break;
        case 'mid_loop':
            summarize = afterTokens > deps.summarizeThreshold
                && (!deps.ineffectivenessGate || afterTokens >= beforeTokens * 0.90);
            break;
        default:
            summarize = afterTokens > deps.summarizeThreshold;
            break;
    }

    return {
        messages,
        beforeTokens,
        afterTokens,
        action: summarize ? 'summarize' : 'pruned-below-threshold',
    };
}
