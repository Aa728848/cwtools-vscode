/**
 * Eddy CWTool Code — Delegated sub-agent scope statement.
 *
 * A dispatched sub-agent runs inside a permission scope the coordinator fixed
 * when it was started: runtime profile authority, clamped `writeScope`, denied
 * user-owned scopes, and `plannedFiles` that were dropped because they escaped
 * the parent's writable roots.
 *
 * The host already enforces all of that. What the child was never told is WHY a
 * write failed, so its natural next move is to retry — which is exactly the
 * behaviour `RecoveryStormBudget` has to extinguish afterwards. One sentence in
 * the child's own system prompt is far cheaper than that recovery, and it has a
 * structured place to put the outcome: the `Unresolved` section of its handoff.
 *
 * Kept deterministic (sorted, bounded, no timestamps) because it is part of a
 * system prompt: an unstable statement would defeat prefix caching.
 */

/** Scope facts a coordinator already computed for one child. */
export interface DelegationScopeFacts {
    /** True when the runtime profile has no project write tools. */
    readOnly?: boolean;
    /** Workspace-relative or absolute scopes this child may write. */
    writeScope?: readonly string[];
    /** Scopes withheld because the user retained ownership of them. */
    deniedWriteScopes?: readonly string[];
    /** plannedFiles dropped because they escaped the parent writable roots. */
    rejectedScopes?: readonly string[];
}

const MAX_LISTED_SCOPES = 12;
const MAX_SCOPE_CHARS = 160;

function formatScopes(scopes: readonly string[] | undefined): string | undefined {
    if (!scopes || scopes.length === 0) return undefined;
    const unique = [...new Set(
        scopes
            .map(scope => scope.trim())
            .filter(scope => scope.length > 0)
            .map(scope => (scope.length > MAX_SCOPE_CHARS ? `${scope.slice(0, MAX_SCOPE_CHARS)}…` : scope)),
    )].sort((left, right) => left.localeCompare(right));
    if (unique.length === 0) return undefined;
    const listed = unique.slice(0, MAX_LISTED_SCOPES);
    const omitted = unique.length - listed.length;
    return omitted > 0 ? `${listed.join(', ')} (+${omitted} more)` : listed.join(', ');
}

/**
 * Build the delegation-scope statement for a child system prompt.
 * @param facts Scope facts derived from the child's sandbox; omit for a
 *              non-delegated run.
 * @returns The statement, or an empty string when this run is not delegated.
 */
export function buildDelegationScopeStatement(facts?: DelegationScopeFacts): string {
    if (!facts) return '';

    const lines: string[] = [
        '## Delegated scope',
        'You are a delegated sub-agent. Your permission scope was fixed when the coordinator started you and cannot be widened from inside this run.',
    ];

    if (facts.readOnly) {
        lines.push('- This profile is read-only: every file-mutating tool is withheld. Produce evidence and findings, not edits.');
    } else {
        const writable = formatScopes(facts.writeScope);
        lines.push(writable
            ? `- You may write only inside: ${writable}.`
            : '- You may write only inside the coordinator-approved workspace targets for this subtask.');
    }

    const denied = formatScopes(facts.deniedWriteScopes);
    if (denied) {
        lines.push(`- The user retained ownership of these scopes; they are not yours to change: ${denied}.`);
    }

    const rejected = formatScopes(facts.rejectedScopes);
    if (rejected) {
        lines.push(
            `- These planned targets were dropped because they fall outside the parent's writable roots: ${rejected}. `
            + 'Do not try to reach them by another path or tool.',
        );
    }

    lines.push(
        '- Do not retry an operation the host denied, and do not look for a way around it. A denial here is a policy decision, not a transient error.',
        '- When the subtask genuinely needs access beyond this scope, stop and report it in the `Unresolved` section of your handoff so the coordinator can decide. That is a complete, successful answer — not a failure.',
        '- You cannot ask the user directly. To escalate a decision, reply with `BLOCKED_FOR_ORCHESTRATOR:` followed by the single question and, when useful, the concrete options. Your working context is preserved, so the coordinator\'s answer resumes you where you stopped.',
    );

    return lines.join('\n');
}
