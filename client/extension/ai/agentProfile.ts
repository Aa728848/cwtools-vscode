import type {
    AgentDomain,
    AgentExecutionStrategy,
    AgentIntent,
    AgentProfileSelection,
    AgentRuntimeDomain,
    ResolvedSchedulingDecision,
} from './types';
import {
    admissionFromResolvedProfile,
    schedulingStateFromAdmission,
} from './runner/scheduling';

export const DEFAULT_AGENT_PROFILE: Readonly<AgentProfileSelection> = Object.freeze({
    domain: 'paradox',
    intent: 'auto',
    strategy: 'auto',
});

const DOMAINS = new Set<string>(['paradox', 'general', 'hybrid']);
const INTENTS = new Set<AgentIntent>(['auto', 'execute', 'plan', 'explore', 'review']);
const STRATEGIES = new Set<string>(['auto', 'single', 'multi']);

export function cloneAgentProfile(profile: AgentProfileSelection = DEFAULT_AGENT_PROFILE): AgentProfileSelection {
    return {
        domain: 'paradox',
        intent: profile.intent,
        strategy: profile.strategy === 'auto' ? 'auto' : 'single',
        ...(profile.profileName ? { profileName: profile.profileName } : {}),
    };
}

/** Build the default Paradox profile exposed by the composer; routing stays automatic. */
export function profileForUserDomain(_domain: AgentDomain = 'paradox'): AgentProfileSelection {
    return { domain: 'paradox', intent: 'auto', strategy: 'auto' };
}

export function sameAgentProfile(left: AgentProfileSelection, right: AgentProfileSelection): boolean {
    return left.domain === right.domain
        && left.intent === right.intent
        && left.strategy === right.strategy
        && left.profileName === right.profileName;
}

export function isAgentProfileSelection(value: unknown): value is AgentProfileSelection {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<AgentProfileSelection>;
    return DOMAINS.has(candidate.domain as string)
        && INTENTS.has(candidate.intent as AgentIntent)
        && STRATEGIES.has(candidate.strategy as string)
        && (candidate.profileName === undefined
            || (typeof candidate.profileName === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(candidate.profileName)));
}

function schedulingForSelection(
    admission: import('./types').AdmissionDecision,
    selection: AgentProfileSelection,
): import('./types').AgentSchedulingState {
    const schedulingState = schedulingStateFromAdmission(admission);
    return selection.profileName ? { ...schedulingState, profileName: selection.profileName } : schedulingState;
}

export function normalizeAgentProfile(value: unknown): AgentProfileSelection {
    return isAgentProfileSelection(value) ? cloneAgentProfile(value) : cloneAgentProfile();
}

/**
 * Resolve the turn's scheduling state from the user-owned selection alone.
 *
 * Task mode is decided by the Agent, not by a classifier: nothing here reads
 * the request text to route the turn into Plan, Explore, or Review. Mode
 * selection has exactly two legitimate sources, and both of them are explicit:
 *
 * - the user pins a mode for the topic (`/plan`, `/execute`, `/explore`,
 *   `/review`, the mode control, or a rehydrated topic pin), which arrives here
 *   as a non-`auto` `selection.intent`; and
 * - the Agent escalates by calling `enter_plan_mode` (or `exit_plan_mode`)
 *   during the run, which the runner applies as a scheduling transition.
 *
 * The built-in Agent focuses exclusively on Paradox / CWTools semantics as a
 * single-Agent assistant.
 */
export function resolveAgentProfile(
    _text: string,
    profile: AgentProfileSelection = cloneAgentProfile(),
): ResolvedSchedulingDecision {
    const selection = normalizeAgentProfile(profile);
    const domain: AgentRuntimeDomain = 'paradox';

    // 'auto' is only reachable on the normal composer path, where no explicit
    // user pin exists. It means "let the run start writable and let the Agent
    // decide", so it resolves to an ordinary execution turn.
    const intent: Exclude<AgentIntent, 'auto'> = selection.intent === 'auto' ? 'execute' : selection.intent;
    const strategy: Exclude<AgentExecutionStrategy, 'auto'> = 'single';

    const intentReason = selection.intent === 'auto' ? 'user selection (auto)' : 'user selection';
    const strategyReason = selection.strategy === 'auto' ? 'task scope' : 'user selection';
    const base = {
        selection,
        intent,
        strategy,
        reason: `domain: paradox; intent: ${intentReason}; strategy: ${strategyReason}`,
        requiresUserDecision: false,
        routingSource: selection.intent === 'auto' ? 'deterministic' as const : 'manual' as const,
    };
    const evidence = [
        'domain: paradox',
        `intent: ${intentReason}`,
        `strategy: ${strategyReason}`,
    ];
    const admission = admissionFromResolvedProfile({ ...base, domain }, 1, evidence);
    return {
        schedulingState: {
            ...schedulingForSelection(admission, selection),
            routingSource: 'deterministic',
            phaseReason: base.reason,
        },
    };
}
