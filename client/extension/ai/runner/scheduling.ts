import type {
    AdmissionDecision,
    AgentAuthorization,
    AgentDispatchMode,
    AgentMode,
    AgentExecutionStrategy,
    AgentIntent,
    AgentRunPhase,
    AgentRuntimeDomain,
    AgentSchedulingState,
    ToolEffect,
} from '../types';

/** Monotone authorization ladder. Transitions may narrow, never widen. */
export const AUTHORITY_RANK: Record<AgentAuthorization, number> = {
    read_only: 0,
    plan_write_only: 1,
    workspace_write: 2,
};

const PHASES = new Set<AgentRunPhase>(['inspect', 'plan', 'execute', 'verify', 'finalize']);
const AUTHORIZATIONS = new Set<AgentAuthorization>(['read_only', 'plan_write_only', 'workspace_write']);
const LEGACY_DOMAINS = new Set<string>(['paradox', 'general', 'hybrid']);
const LEGACY_DISPATCH_MODES = new Set<string>(['single', 'parallel', 'specialist']);
const ROUTING_SOURCES = new Set<string>(['model', 'deterministic', 'user']);
/**
 * Topics persisted while the removed AI Workflow subsystem was still active can
 * carry `routingSource: 'workflow'`. The origin no longer exists, so such a
 * value is tolerated on read and degraded to "unknown" instead of rejecting
 * the whole topic.
 */
const LEGACY_ROUTING_SOURCES = new Set<string>(['workflow']);

export function admissionFromResolvedProfile(profile: {
    domain: AgentRuntimeDomain;
    intent: Exclude<AgentIntent, 'auto'>;
    strategy: Exclude<AgentExecutionStrategy, 'auto'>;
    reason: string;
}, confidence = 1, evidence: readonly string[] = [], authorizationOverride?: AgentAuthorization): AdmissionDecision {
    const authorization: AgentAuthorization = authorizationOverride ?? (profile.intent === 'execute'
        ? 'workspace_write'
        : profile.intent === 'plan'
            ? 'plan_write_only'
            : 'read_only');
    const initialPhase: AdmissionDecision['initialPhase'] = profile.intent === 'execute'
        ? 'execute'
        : profile.intent === 'plan'
            ? 'plan'
            : profile.intent === 'review'
                ? 'verify'
                : 'inspect';
    return {
        domainProfile: 'paradox',
        authorization,
        initialPhase,
        explicitDelegation: false,
        confidence: clampConfidence(confidence),
        evidence: uniqueEvidence(evidence.length > 0 ? evidence : [profile.reason]),
    };
}

export function schedulingStateFromAdmission(
    admission: AdmissionDecision,
    reason = 'turn admission',
): AgentSchedulingState {
    const profileName = profileNameForAdmission(admission);
    return {
        profileName,
        domainProfile: 'paradox',
        authorization: admission.authorization,
        phase: admission.initialPhase,
        dispatch: 'single',
        overlays: schedulingOverlays(admission.initialPhase),
        routeConfidence: clampConfidence(admission.confidence),
        routeEvidence: uniqueEvidence(admission.evidence),
        phaseReason: reason,
        dispatchReason: 'single agent',
        revision: 0,
    };
}

/** Project the canonical scheduler axes into the prompt/tool execution label. */
export function executionModeForSchedulingState(state: AgentSchedulingState): AgentMode {
    if (state.profileName === 'localization-writer') return 'loc_writer';
    if (state.profileName === 'localization-translator') return 'loc_translator';
    if (state.profileName === 'gui-expert') return 'gui_expert';
    if (state.profileName === 'reviewer') return 'script_reviewer';
    if (state.phase === 'plan') return 'plan';
    if (state.phase === 'verify') return 'review';
    if (state.phase === 'inspect' && state.authorization === 'read_only') return 'explore';
    return 'build';
}

export function normalizeSchedulingState(
    value: unknown,
): AgentSchedulingState {
    if (!value || typeof value !== 'object') {
        throw new Error('Agent scheduling state is required.');
    }
    const candidate = value as Partial<AgentSchedulingState>;
    const revision = candidate.revision;
    if (!LEGACY_DOMAINS.has(candidate.domainProfile as string)
        || !AUTHORIZATIONS.has(candidate.authorization as AgentAuthorization)
        || !PHASES.has(candidate.phase as AgentRunPhase)
        || !LEGACY_DISPATCH_MODES.has(candidate.dispatch as string)
        || typeof candidate.profileName !== 'string'
        || !candidate.profileName.trim()
        || !Array.isArray(candidate.overlays)
        || !candidate.overlays.every(item => typeof item === 'string')
        || typeof candidate.routeConfidence !== 'number'
        || !Number.isFinite(candidate.routeConfidence)
        || !Array.isArray(candidate.routeEvidence)
        || !candidate.routeEvidence.every(item => typeof item === 'string')
        || typeof candidate.phaseReason !== 'string'
        || typeof revision !== 'number'
        || !Number.isSafeInteger(revision)
        || revision < 0
        || (candidate.awaitingUserDecision !== undefined && typeof candidate.awaitingUserDecision !== 'boolean')
        || (candidate.routingSource !== undefined
            && !ROUTING_SOURCES.has(candidate.routingSource as string)
            && !LEGACY_ROUTING_SOURCES.has(candidate.routingSource))
        || (candidate.dispatchReason !== undefined && typeof candidate.dispatchReason !== 'string')) {
        throw new Error('Agent scheduling state is invalid.');
    }
    const authorization = candidate.authorization as AgentAuthorization;
    const phase = candidate.phase as AgentRunPhase;
    const rawProfileName = candidate.profileName.trim().slice(0, 100);
    const profileName = rawProfileName === 'general-agent' || rawProfileName === 'hybrid-agent' || rawProfileName === 'general-coder'
        ? 'paradox-agent'
        : rawProfileName;
    return {
        profileName,
        domainProfile: 'paradox',
        authorization,
        phase,
        dispatch: 'single',
        overlays: [...new Set(candidate.overlays.filter(value => !!value.trim())
            .map(value => value.trim().slice(0, 80)))].slice(0, 12),
        routeConfidence: clampConfidence(candidate.routeConfidence),
        routeEvidence: uniqueEvidence(candidate.routeEvidence),
        awaitingUserDecision: candidate.awaitingUserDecision === true ? true : undefined,
        routingSource: ROUTING_SOURCES.has(candidate.routingSource as string)
            ? candidate.routingSource
            : undefined,
        phaseReason: candidate.phaseReason.slice(0, 500),
        dispatchReason: candidate.dispatchReason?.slice(0, 500),
        revision,
    };
}

export function transitionSchedulingState(
    current: AgentSchedulingState,
    update: {
        phase?: AgentRunPhase;
        authorization?: AgentAuthorization;
        dispatch?: AgentDispatchMode;
        reason: string;
        dispatchReason?: string;
    },
): AgentSchedulingState {
    const nextAuthorization = update.authorization ?? current.authorization;
    if (AUTHORITY_RANK[nextAuthorization] > AUTHORITY_RANK[current.authorization]) {
        throw new Error(`Scheduling transition cannot expand authorization from ${current.authorization} to ${nextAuthorization}.`);
    }
    if (update.phase === 'execute' && nextAuthorization !== 'workspace_write') {
        throw new Error(`Execute phase requires workspace_write authorization; received ${nextAuthorization}.`);
    }
    return {
        ...current,
        authorization: nextAuthorization,
        phase: update.phase ?? current.phase,
        dispatch: 'single',
        overlays: schedulingOverlays(update.phase ?? current.phase),
        phaseReason: update.phase !== undefined || update.authorization !== undefined
            ? update.reason.slice(0, 500)
            : current.phaseReason,
        dispatchReason: update.dispatchReason ?? current.dispatchReason,
        revision: current.revision + 1,
    };
}

export class AdaptiveConcurrencyController {
    private capacity: number;
    private stableSuccesses = 0;

    constructor(
        readonly maximum: number,
        readonly minimum = 1,
        private readonly recoverySuccesses = 3,
    ) {
        this.capacity = Math.max(minimum, maximum);
    }

    get current(): number {
        return this.capacity;
    }

    onRateLimit(): { previous: number; current: number } {
        const previous = this.capacity;
        this.capacity = Math.max(this.minimum, Math.floor(this.capacity / 2));
        this.stableSuccesses = 0;
        return { previous, current: this.capacity };
    }

    onSuccess(): { previous: number; current: number } {
        const previous = this.capacity;
        this.stableSuccesses++;
        if (this.stableSuccesses >= this.recoverySuccesses && this.capacity < this.maximum) {
            this.capacity++;
            this.stableSuccesses = 0;
        }
        return { previous, current: this.capacity };
    }
}

export function isProviderRateLimit(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error ?? '');
    return /\b429\b|rate[ -]?limit|too many requests|quota temporarily|throttl/i.test(text);
}

export function authorizationAllowsEffect(
    authorization: AgentAuthorization,
    effect: ToolEffect,
    mutating: boolean,
): boolean {
    if (authorization === 'workspace_write') return true;
    if (authorization === 'read_only') {
        const internalStateOnly = effect === 'none' || effect === 'memory';
        return !['workspace_write', 'git', 'media'].includes(effect)
            && (!mutating || internalStateOnly);
    }
    // plan_write_only may write only the guarded topic-local plan artifact.
    // The plan-mode path guard performs the target-level decision.
    return !['git', 'media'].includes(effect);
}

function clampConfidence(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(1, value))
        : 0;
}

function uniqueEvidence(values: readonly string[]): string[] {
    return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 300)))].slice(0, 12);
}

function profileNameForAdmission(admission: AdmissionDecision): string {
    if (admission.authorization === 'read_only') {
        return admission.initialPhase === 'verify' ? 'reviewer' : 'explore';
    }
    return 'paradox-agent';
}

function schedulingOverlays(phase: AgentRunPhase): string[] {
    const overlays: string[] = [];
    if (phase === 'plan') overlays.push('planning');
    if (phase === 'verify') overlays.push('verification');
    if (phase === 'finalize') overlays.push('finalization');
    return overlays;
}
