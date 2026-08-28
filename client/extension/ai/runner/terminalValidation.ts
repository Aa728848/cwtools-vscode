import { diagnosticsPresentInSnapshot, type DiagnosticDelta, type DiagnosticSnapshot, type NormalizedDiagnostic } from './diagnosticSnapshot';

export type TerminalValidationOutcome = 'allow' | 'pending' | 'repair';

export interface TerminalValidationState {
    readonly pendingTargets: Set<string>;
    readonly repairTargets: Set<string>;
    readonly diagnosticErrorTargets: Set<string>;
    readonly introducedErrorsByTarget: Map<string, NormalizedDiagnostic[]>;
    readonly coveragePendingTargets: Set<string>;
}

export function createTerminalValidationState(): TerminalValidationState {
    return {
        pendingTargets: new Set<string>(),
        repairTargets: new Set<string>(),
        diagnosticErrorTargets: new Set<string>(),
        introducedErrorsByTarget: new Map<string, NormalizedDiagnostic[]>(),
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
        const diagnosticSnapshot = record.diagnosticSnapshot && typeof record.diagnosticSnapshot === 'object'
            ? record.diagnosticSnapshot as DiagnosticSnapshot
            : undefined;
        const fallbackHasErrors = diagnostics.some(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            const severity = (item as Record<string, unknown>).severity;
            return severity === 'error' || severity === 0;
        });
        for (const target of targetKeys) {
            if (freshness === 'fresh') {
                const previous = state.introducedErrorsByTarget.get(target) ?? [];
                const added = diagnosticDelta?.comparable === true
                    ? diagnosticDelta.added.filter(item => item.severity === 'error')
                    : previous.length === 0 && fallbackHasErrors ? undefined : [];
                if (added) {
                    const candidates = [...previous, ...added];
                    const introduced = diagnosticSnapshot
                        ? diagnosticsPresentInSnapshot(candidates, diagnosticSnapshot) ?? previous
                        : candidates;
                    if (introduced.length > 0) {
                        state.introducedErrorsByTarget.set(target, introduced);
                        state.diagnosticErrorTargets.add(target);
                    } else {
                        state.introducedErrorsByTarget.delete(target);
                        state.diagnosticErrorTargets.delete(target);
                    }
                } else {
                    state.diagnosticErrorTargets.add(target);
                }
                if (!state.diagnosticErrorTargets.has(target) && state.coveragePendingTargets.has(target)) {
                    state.coveragePendingTargets.delete(target);
                    state.pendingTargets.delete(target);
                }
            } else if (freshness === 'pending' || freshness === 'stale') {
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

/** Compact deterministic feedback suitable for the next step of the main loop. */
export function formatTerminalValidationFeedback(state: TerminalValidationState): string {
    const outcome = terminalValidationOutcome(state);
    if (outcome === 'allow') return 'Post-write validation passed.';

    const targets = [...new Set([
        ...state.repairTargets,
        ...state.diagnosticErrorTargets,
        ...state.pendingTargets,
    ])].sort();
    const diagnostics = [...state.introducedErrorsByTarget.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([target, errors]) => errors.map(error => {
            const location = error.line !== undefined
                ? `:${error.line + 1}${error.column !== undefined ? `:${error.column + 1}` : ''}`
                : '';
            return `${target}${location} ${error.message}`;
        }))
        .slice(0, 12);
    const status = outcome === 'pending'
        ? 'Post-write validation is pending and requires fresh diagnostics.'
        : 'Post-write validation requires repair.';
    return [
        status,
        targets.length > 0 ? `Affected targets: ${targets.join(', ')}.` : '',
        diagnostics.length > 0 ? `Introduced errors:\n- ${diagnostics.join('\n- ')}` : '',
    ].filter(Boolean).join('\n');
}
