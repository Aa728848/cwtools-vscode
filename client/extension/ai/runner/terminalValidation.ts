import { hasAddedErrors, type DiagnosticDelta } from './diagnosticSnapshot';

export type TerminalValidationOutcome = 'allow' | 'pending' | 'repair';

export interface TerminalValidationState {
    readonly pendingTargets: Set<string>;
    readonly repairTargets: Set<string>;
    readonly diagnosticErrorTargets: Set<string>;
    readonly coveragePendingTargets: Set<string>;
}

export function createTerminalValidationState(): TerminalValidationState {
    return {
        pendingTargets: new Set<string>(),
        repairTargets: new Set<string>(),
        diagnosticErrorTargets: new Set<string>(),
        coveragePendingTargets: new Set<string>(),
    };
}

function postWriteVerdict(record: Record<string, unknown>): TerminalValidationOutcome | undefined {
    const validation = record.postWriteValidation;
    if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return undefined;
    const verdict = (validation as Record<string, unknown>).verdict;
    return verdict === 'allow' || verdict === 'pending' || verdict === 'repair' ? verdict : undefined;
}

/**
 * Fold one tool result into the run-level deterministic validation state.
 * A later result for the same target supersedes the earlier write verdict.
 */
export function updateTerminalValidationState(
    state: TerminalValidationState,
    targetKeys: readonly string[],
    record: Record<string, unknown> | undefined,
): void {
    if (!record) return;
    const verdict = postWriteVerdict(record);
    const repair = verdict === 'repair' || record.requiresRepair === true;
    const pending = verdict === 'pending' || record.requiresValidation === true;
    const allow = verdict === 'allow' || record.postWriteValidationPassed === true;

    const diagnostics = Array.isArray(record.diagnostics) ? record.diagnostics : undefined;
    const freshness = record.freshness === 'fresh' || record.freshness === 'pending' || record.freshness === 'stale'
        ? record.freshness
        : undefined;
    if (diagnostics) {
        const diagnosticDelta = record.diagnosticDelta && typeof record.diagnosticDelta === 'object'
            ? record.diagnosticDelta as DiagnosticDelta
            : undefined;
        const hasErrors = diagnosticDelta?.comparable === true
            ? hasAddedErrors(diagnosticDelta)
            : diagnostics.some(item => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
                const severity = (item as Record<string, unknown>).severity;
                return severity === 'error' || severity === 0;
            });
        for (const target of targetKeys) {
            if (freshness === 'fresh' && hasErrors) {
                state.diagnosticErrorTargets.add(target);
            } else if (freshness === 'fresh') {
                state.diagnosticErrorTargets.delete(target);
                if (state.coveragePendingTargets.has(target)) {
                    state.coveragePendingTargets.delete(target);
                    state.pendingTargets.delete(target);
                }
            } else if (freshness === 'pending' || freshness === 'stale') {
                state.diagnosticErrorTargets.delete(target);
                state.pendingTargets.add(target);
            }
        }
    }

    if (!repair && !pending && !allow) return;
    const postWriteEvidence = record.postWriteEvidence;
    const missingEvidence = postWriteEvidence && typeof postWriteEvidence === 'object' && !Array.isArray(postWriteEvidence)
        ? (postWriteEvidence as Record<string, unknown>).missingEvidence
        : undefined;
    const coverageOnly = pending
        && Array.isArray(missingEvidence)
        && missingEvidence.length > 0
        && missingEvidence.every(item => !!item
            && typeof item === 'object'
            && !Array.isArray(item)
            && (item as Record<string, unknown>).claim === 'semantic evidence extraction covers the complete written file');
    for (const target of targetKeys) {
        if (repair) {
            state.repairTargets.add(target);
            state.pendingTargets.delete(target);
            state.coveragePendingTargets.delete(target);
        } else if (pending) {
            state.pendingTargets.add(target);
            state.repairTargets.delete(target);
            if (coverageOnly) state.coveragePendingTargets.add(target);
            else state.coveragePendingTargets.delete(target);
        } else {
            state.pendingTargets.delete(target);
            state.repairTargets.delete(target);
            state.coveragePendingTargets.delete(target);
        }
    }
}

export function terminalValidationOutcome(state: TerminalValidationState): TerminalValidationOutcome {
    if (state.repairTargets.size > 0 || state.diagnosticErrorTargets.size > 0) return 'repair';
    if (state.pendingTargets.size > 0) return 'pending';
    return 'allow';
}

export function hasOnlyPendingValidationErrors(
    errors: readonly { code: string; severity?: string }[],
): boolean {
    return errors.some(error => error.code === 'VALIDATION_PENDING')
        && errors.every(error => error.code === 'VALIDATION_PENDING' || error.severity !== 'error');
}
