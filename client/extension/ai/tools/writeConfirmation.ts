/**
 * Unified decision logic for whether a file write requires user confirmation.
 * Single source of truth for the 4-switch resolution:
 *   1. fileWriteMode: 'auto' bypasses confirmation entirely.
 *   2. vfsOverlay: in-memory speculative writes bypass confirmation.
 *   3. args._autoApply: caller-requested bypass (e.g. reviewed transaction / subagent).
 *   4. runnerOptions.forceAutoApplyWrites: orchestrator or autonomous mode bypass.
 *   5. runnerOptions.useSlimPrompt: low-latency slim prompt bypass.
 */

export interface WriteConfirmationDecisionParams {
    fileWriteMode?: 'auto' | 'confirm';
    args?: unknown;
    runnerOptions?: {
        forceAutoApplyWrites?: boolean;
        useSlimPrompt?: boolean;
    };
    vfsOverlay?: boolean | unknown;
}

/**
 * Returns true if the pending write should bypass confirmation (i.e. apply automatically).
 * Returns false only if the environment requires an interactive confirmation card.
 */
export function shouldBypassWriteConfirmation(params: WriteConfirmationDecisionParams): boolean {
    if (params.fileWriteMode === 'auto') return true;
    if (Boolean(params.vfsOverlay)) return true;
    const record = (params.args && typeof params.args === 'object') ? params.args as Record<string, unknown> : {};
    if (record._autoApply === true) return true;
    if (params.runnerOptions?.forceAutoApplyWrites === true) return true;
    if (params.runnerOptions?.useSlimPrompt === true) return true;
    return false;
}
