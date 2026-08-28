import type {
    AdmissionDecision,
    AgentAuthorization,
    AgentDispatchMode,
    AgentMode,
    AgentRunPhase,
    AgentRuntimeDomain,
    AgentSchedulingState,
    ResolvedAgentProfile,
    ToolEffect,
} from '../types';

const AUTHORITY_RANK: Record<AgentAuthorization, number> = {
    read_only: 0,
    plan_write_only: 1,
    workspace_write: 2,
};

const PHASES = new Set<AgentRunPhase>(['inspect', 'plan', 'execute', 'verify', 'finalize']);
const AUTHORIZATIONS = new Set<AgentAuthorization>(['read_only', 'plan_write_only', 'workspace_write']);
const DISPATCH_MODES = new Set<AgentDispatchMode>(['single', 'parallel', 'specialist']);

export function admissionFromResolvedProfile(profile: Pick<
    ResolvedAgentProfile,
    'domain' | 'intent' | 'strategy' | 'reason'
>, confidence = 1, evidence: readonly string[] = [], authorizationOverride?: AgentAuthorization): AdmissionDecision {
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
        domainProfile: profile.domain,
        authorization,
        initialPhase,
        explicitDelegation: profile.strategy === 'multi',
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
        domainProfile: admission.domainProfile,
        authorization: admission.authorization,
        phase: admission.initialPhase,
        dispatch: admission.explicitDelegation ? 'parallel' : 'single',
        overlays: schedulingOverlays(admission.initialPhase, admission.explicitDelegation ? 'parallel' : 'single'),
        routeConfidence: clampConfidence(admission.confidence),
        routeEvidence: uniqueEvidence(admission.evidence),
        phaseReason: reason,
        dispatchReason: admission.explicitDelegation ? 'explicit user delegation' : 'runtime dispatch pending',
        revision: 0,
    };
}

export function deriveLegacyMode(state: AgentSchedulingState): AgentMode {
    if (state.dispatch !== 'single') {
        return state.domainProfile === 'paradox' ? 'script' : 'orchestrator';
    }
    if (state.phase === 'plan') return 'plan';
    if (state.phase === 'verify') return 'review';
    if (state.phase === 'inspect' && state.authorization === 'read_only') return 'explore';
    return state.domainProfile === 'paradox' ? 'build' : 'utility';
}

export function schedulingStateFromLegacyMode(
    mode: AgentMode,
    domain: AgentRuntimeDomain = defaultDomainForLegacyMode(mode),
): AgentSchedulingState {
    const authorization: AgentAuthorization = mode === 'plan'
        ? 'plan_write_only'
        : ['explore', 'general', 'review', 'script_reviewer'].includes(mode)
            ? 'read_only'
            : 'workspace_write';
    const phase: AgentRunPhase = mode === 'plan'
        ? 'plan'
        : mode === 'review' || mode === 'script_reviewer'
            ? 'verify'
            : ['build', 'utility', 'orchestrator', 'script', 'gui_expert', 'loc_translator', 'loc_writer'].includes(mode)
                ? 'execute'
                : 'inspect';
    return {
        profileName: profileNameForLegacyMode(mode, domain),
        domainProfile: domain,
        authorization,
        phase,
        dispatch: mode === 'orchestrator' || mode === 'script' ? 'parallel' : 'single',
        overlays: schedulingOverlays(phase, mode === 'orchestrator' || mode === 'script' ? 'parallel' : 'single'),
        routeConfidence: 0,
        routeEvidence: ['legacy mode compatibility'],
        phaseReason: 'restored from legacy mode',
        dispatchReason: mode === 'orchestrator' || mode === 'script' ? 'legacy coordinator mode' : 'legacy single mode',
        revision: 0,
    };
}

export function normalizeSchedulingState(
    value: unknown,
    fallbackMode: AgentMode,
    fallbackDomain?: AgentRuntimeDomain,
): AgentSchedulingState {
    if (!value || typeof value !== 'object') {
        return schedulingStateFromLegacyMode(fallbackMode, fallbackDomain);
    }
    const candidate = value as Partial<AgentSchedulingState>;
    if ((candidate.domainProfile !== 'general' && candidate.domainProfile !== 'paradox')
        || !AUTHORIZATIONS.has(candidate.authorization as AgentAuthorization)
        || !PHASES.has(candidate.phase as AgentRunPhase)
        || !DISPATCH_MODES.has(candidate.dispatch as AgentDispatchMode)) {
        const legacy = schedulingStateFromLegacyMode(fallbackMode, fallbackDomain);
        return {
            ...legacy,
            authorization: 'read_only',
            phase: legacy.phase === 'verify' ? 'verify' : 'inspect',
            dispatch: 'single',
            phaseReason: 'invalid persisted scheduling state rejected',
            dispatchReason: 'invalid persisted dispatch state rejected',
        };
    }
    return {
        profileName: typeof candidate.profileName === 'string' && candidate.profileName.trim()
            ? candidate.profileName.trim().slice(0, 100)
            : profileNameForLegacyMode(fallbackMode, candidate.domainProfile),
        domainProfile: candidate.domainProfile,
        authorization: candidate.authorization as AgentAuthorization,
        phase: candidate.phase as AgentRunPhase,
        dispatch: candidate.dispatch as AgentDispatchMode,
        overlays: Array.isArray(candidate.overlays)
            ? [...new Set(candidate.overlays.filter((value): value is string => typeof value === 'string' && !!value.trim())
                .map(value => value.trim().slice(0, 80)))].slice(0, 12)
            : schedulingOverlays(candidate.phase as AgentRunPhase, candidate.dispatch as AgentDispatchMode),
        routeConfidence: clampConfidence(candidate.routeConfidence),
        routeEvidence: uniqueEvidence(candidate.routeEvidence ?? []),
        phaseReason: typeof candidate.phaseReason === 'string' ? candidate.phaseReason.slice(0, 500) : 'restored state',
        dispatchReason: typeof candidate.dispatchReason === 'string' ? candidate.dispatchReason.slice(0, 500) : undefined,
        revision: Number.isSafeInteger(candidate.revision) && (candidate.revision ?? -1) >= 0 ? candidate.revision! : 0,
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
        dispatch: update.dispatch ?? current.dispatch,
        overlays: schedulingOverlays(update.phase ?? current.phase, update.dispatch ?? current.dispatch),
        phaseReason: update.phase !== undefined || update.authorization !== undefined
            ? update.reason.slice(0, 500)
            : current.phaseReason,
        dispatchReason: update.dispatchReason ?? current.dispatchReason,
        revision: current.revision + 1,
    };
}

export interface DispatchCandidate {
    id: string;
    objective: string;
    dependencies?: readonly string[];
    expectedWrites?: readonly string[];
    acceptanceCriteria?: readonly string[];
    role?: string;
}

export interface DispatchAdmissionResult {
    accepted: boolean;
    score: number;
    reason: string;
    conflicts: Array<{ resource: string; taskIds: string[] }>;
}

export function evaluateDispatchAdmission(
    tasks: readonly DispatchCandidate[],
    options: {
        explicitDelegation?: boolean;
        availableTokenBudget?: number;
        minimumScore?: number;
        /** Valid dependency targets outside the candidate list (resumed graph node ids). */
        knownTaskIds?: string[];
    } = {},
): DispatchAdmissionResult {
    if (tasks.length === 0) {
        return { accepted: false, score: -10, reason: 'Dispatch requires at least one task.', conflicts: [] };
    }
    if (tasks.length === 1 && options.explicitDelegation !== true) {
        return { accepted: false, score: -10, reason: 'Single-agent dispatch requires explicit delegation.', conflicts: [] };
    }
    const knownIds = new Set(options.knownTaskIds ?? []);
    const ids = new Set<string>();
    const objectives = new Set<string>();
    for (const task of tasks) {
        const id = task.id.trim();
        const objective = task.objective.trim().toLowerCase();
        if (!id || !objective) {
            return { accepted: false, score: -10, reason: 'Every task requires a non-empty id and objective.', conflicts: [] };
        }
        if (ids.has(id) || objectives.has(objective)) {
            return { accepted: false, score: -10, reason: `Duplicate task id or objective detected: ${id}.`, conflicts: [] };
        }
        ids.add(id);
        objectives.add(objective);
    }
    const tasksById = new Map(tasks.map(task => [task.id, task]));
    for (const task of tasks) {
        const missing = (task.dependencies ?? []).find(dependency => !tasksById.has(dependency) && !knownIds.has(dependency));
        if (missing) {
            return {
                accepted: false,
                score: -10,
                reason: `Task ${task.id} depends on missing task ${missing}.`,
                conflicts: [],
            };
        }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (taskId: string): boolean => {
        if (visiting.has(taskId)) return true;
        if (visited.has(taskId)) return false;
        visiting.add(taskId);
        const cyclic = (tasksById.get(taskId)?.dependencies ?? []).some(hasCycle);
        visiting.delete(taskId);
        visited.add(taskId);
        return cyclic;
    };
    if (tasks.some(task => hasCycle(task.id))) {
        return {
            accepted: false,
            score: -10,
            reason: 'Task graph contains a dependency cycle.',
            conflicts: [],
        };
    }
    const dependsOn = (taskId: string, targetId: string, visited = new Set<string>()): boolean => {
        if (taskId === targetId) return true;
        if (visited.has(taskId)) return false;
        visited.add(taskId);
        const task = tasksById.get(taskId);
        return (task?.dependencies ?? []).some(dependency =>
            dependency === targetId || dependsOn(dependency, targetId, visited));
    };

    const writers = new Map<string, string[]>();
    for (const task of tasks) {
        for (const resource of task.expectedWrites ?? []) {
            const normalized = resource.replace(/\\/g, '/').toLowerCase();
            if (!normalized) continue;
            const owners = writers.get(normalized) ?? [];
            owners.push(task.id);
            writers.set(normalized, owners);
        }
    }
    const conflicts = [...writers.entries()]
        .filter(([, taskIds]) => {
            if (taskIds.length < 2) return false;
            for (let left = 0; left < taskIds.length; left++) {
                for (let right = left + 1; right < taskIds.length; right++) {
                    const leftId = taskIds[left]!;
                    const rightId = taskIds[right]!;
                    if (!dependsOn(leftId, rightId) && !dependsOn(rightId, leftId)) return true;
                }
            }
            return false;
        })
        .map(([resource, taskIds]) => ({ resource, taskIds }));
    if (conflicts.length > 0) {
        return {
            accepted: false,
            score: -10,
            reason: `Unordered writers target the same resource: ${conflicts.map(item => item.resource).join(', ')}.`,
            conflicts,
        };
    }

    const independent = tasks.filter(task => (task.dependencies?.length ?? 0) === 0).length;
    const specialistRoles = new Set(tasks.map(task => task.role).filter(Boolean)).size;
    const testable = tasks.filter(task => (task.acceptanceCriteria?.length ?? 0) > 0).length;
    const budgetPenalty = options.availableTokenBudget !== undefined
        && options.availableTokenBudget > 0
        && options.availableTokenBudget < tasks.length * 2_000
        ? 4
        : 0;
    const hasDependencyIsolation = tasks.some(task => (task.dependencies?.length ?? 0) > 0);
    const score = independent * 2
        + Math.min(3, specialistRoles)
        + testable
        + (hasDependencyIsolation ? 2 : 0)
        + (options.explicitDelegation ? 6 : 0)
        - Math.max(0, tasks.length - 4)
        - budgetPenalty;
    const threshold = options.minimumScore ?? 2;
    // User-requested delegation bypasses only optimization scoring; every safety
    // rejection above and the minimum token budget remain authoritative.
    const accepted = options.explicitDelegation === true || score >= threshold;
    return {
        accepted,
        score,
        reason: accepted
            ? `Dispatch admitted with ${independent} independent tasks and score ${score}.`
            : `Dispatch benefit score ${score} is below threshold ${threshold}; continue with one Agent.`,
        conflicts: [],
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
        return !['workspace_write', 'shell', 'git', 'media', 'process'].includes(effect)
            && (!mutating || internalStateOnly);
    }
    // plan_write_only may write only the guarded topic-local plan artifact.
    // The plan-mode path guard performs the target-level decision.
    return !['shell', 'git', 'media', 'process'].includes(effect);
}

function clampConfidence(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(1, value))
        : 0;
}

function uniqueEvidence(values: readonly string[]): string[] {
    return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 300)))].slice(0, 12);
}

function defaultDomainForLegacyMode(mode: AgentMode): AgentRuntimeDomain {
    return mode === 'general' || mode === 'utility' || mode === 'orchestrator' ? 'general' : 'paradox';
}

function profileNameForAdmission(admission: AdmissionDecision): string {
    if (admission.authorization === 'read_only') {
        return admission.initialPhase === 'verify' ? 'reviewer' : 'explore';
    }
    return admission.domainProfile === 'paradox' ? 'paradox-agent' : admission.domainProfile === 'hybrid' ? 'hybrid-agent' : 'general-agent';
}

function profileNameForLegacyMode(mode: AgentMode, domain: AgentRuntimeDomain): string {
    if (mode === 'review' || mode === 'script_reviewer') return 'reviewer';
    if (mode === 'explore' || mode === 'general') return 'explore';
    return domain === 'paradox' ? 'paradox-agent' : domain === 'hybrid' ? 'hybrid-agent' : 'general-agent';
}

function schedulingOverlays(phase: AgentRunPhase, dispatch: AgentDispatchMode): string[] {
    const overlays: string[] = [];
    if (phase === 'plan') overlays.push('planning');
    if (phase === 'verify') overlays.push('verification');
    if (phase === 'finalize') overlays.push('finalization');
    if (dispatch !== 'single') overlays.push(dispatch === 'parallel' ? 'swarm' : 'specialist');
    return overlays;
}
