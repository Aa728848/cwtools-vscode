/**
 * Eddy CWTool Code — Agent Teams type definitions.
 *
 * A Team is a bounded peer-collaboration session: named members (runtime
 * profiles) share one mailbox and one CAS task board, steer each other at
 * step boundaries while running, and cold-resume idle teammates with the
 * next queued message. The lead (dispatching agent) is addressable as the
 * reserved member name 'lead'.
 */

import type { TokenUsage } from '../../types';

/** Reserved mailbox recipient that routes to the dispatching lead agent. */
export const TEAM_LEAD = 'lead' as const;

/** Team member lifecycle. Terminal states: none — idle members can be woken. */
export type TeamMemberStatus =
    | 'provisioning'
    | 'running'
    | 'idle';

/** Member registration supplied at dispatch time. */
export interface TeamMemberSpec {
    /** Stable kebab-case member label, unique inside the team. */
    name: string;
    /** Registered runtime profile name (same catalog as dispatch_agents). */
    profileName: string;
    /** Initial task brief sent as the member's first activation. */
    brief: string;
    /** Declared write targets; used for sandboxing and advisory write scopes. */
    plannedFiles?: string[];
    /** Advisory write-scope prefixes surfaced on the shared task board. */
    writeScopes?: string[];
}

/** Live member record tracked by the team runtime. */
export interface TeamMemberState {
    name: string;
    profileName: string;
    brief: string;
    plannedFiles: string[];
    writeScopes: string[];
    status: TeamMemberStatus;
    /** Durable run id of the current activation; set when the run starts. */
    activeRunId?: string;
    /** Durable run id of the latest completed activation (cold-resume source). */
    lastRunId?: string;
    /** Final output preview of the latest activation. */
    lastOutput?: string;
    lastError?: string;
    /** Number of activations (initial + cold-resume wakes). */
    activations: number;
    tokenUsage: TokenUsage;
    lastActivityAt: number;
}

/** One mailbox entry. Delivery is recorded, never removed, for auditability. */
export interface TeamMessage {
    id: string;
    teamId: string;
    /** Member name or TEAM_LEAD. */
    from: string;
    /** Member name or TEAM_LEAD. */
    to: string;
    content: string;
    timestamp: number;
    deliveredAt?: number;
    /** How the message reached (or will reach) its target. */
    delivery?: 'steered' | 'wake' | 'lead_notification' | 'settle_summary';
}

/**
 * Shared task board status set (deleted tasks are removed from the board).
 * 'failed' and 'cancelled' are reachable only on pipeline boards driven by
 * GraphTeamExecutor; the peer-facing CAS tool never sets them.
 */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/**
 * Static execution contract of a pipeline (compiled-DAG) board task. These
 * fields mirror the dispatch_agents TaskNode declaration so one board task
 * carries everything a one-shot sub-agent activation needs. Peer-collaboration
 * tasks leave this undefined; the peer CAS tool never populates it.
 */
export interface TeamPipelineContract {
    /** Runtime Agent profile that performs this task. */
    profileName: string;
    /** Full subtask prompt (unbounded; tool-facing caps do not apply here). */
    prompt: string;
    contextFiles?: string[];
    plannedFiles?: string[];
    plannedEntities?: string[];
    produces?: import('../types').TaskEntityContract[];
    consumes?: import('../types').TaskEntityContract[];
    acceptanceChecks?: import('../../types').AcceptanceCheck[];
    priority?: import('../types').TaskPriority;
    maxIterations?: number;
    maxRetries?: number;
    modelOverride?: string;
    providerOverride?: string;
    reasoningEffort?: import('../../types').ReasoningEffort;
}

/** CAS actions accepted by team_task_update. */
export type TeamTaskAction = 'claim' | 'release' | 'complete' | 'edit';

export interface TeamTask {
    /** Monotonically allocated per team: task-<n>. */
    id: string;
    subject: string;
    description: string;
    status: TeamTaskStatus;
    /** Owning member name; undefined while unclaimed. */
    owner?: string;
    /** Compare-and-set value; increments by one per mutation. */
    revision: number;
    /** Task ids that must complete first. */
    blockedBy: string[];
    /** Advisory workspace-relative write-scope prefixes (not locks). */
    writeScopes: string[];
    /** Pipeline execution contract; present only on compiled-DAG boards. */
    pipeline?: TeamPipelineContract;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
}

export interface TeamTaskListFilter {
    status?: TeamTaskStatus;
    owner?: string;
}

/** Board view row: the stored task plus derived readiness and conflicts. */
export interface TeamTaskView extends TeamTask {
    /** True when every blockedBy task is completed. */
    ready: boolean;
    /** Advisory write-scope overlaps with other open tasks. */
    writeScopeWarnings: string[];
}

/** Result of a CAS board mutation. */
export interface TeamTaskUpdateResult {
    success: boolean;
    task?: TeamTaskView;
    error?: string;
    /** Present on a revision mismatch so the caller can re-read and retry. */
    currentRevision?: number;
}

/** Final team report handed back to the lead when the team settles. */
export interface TeamSummary {
    teamId: string;
    teamName?: string;
    objective: string;
    settledAt: number;
    settleReason: 'quiet' | 'closed' | 'lifetime_cap' | 'aborted';
    /** Optional free-text reason supplied by the lead on team_close. */
    closeNote?: string;
    members: Array<{
        name: string;
        profileName: string;
        activations: number;
        tokenUsage: TokenUsage;
        lastOutput?: string;
        lastError?: string;
    }>;
    tasks: {
        total: number;
        completed: number;
        open: Array<{ id: string; subject: string; status: TeamTaskStatus; owner?: string }>;
    };
    /** Messages still undelivered when the team settled. */
    undeliveredMessages: Array<{ from: string; to: string; preview: string }>;
    totalTokenUsage: TokenUsage;
}

/** Serializable team snapshot persisted best-effort at settle time. */
export interface TeamSnapshot {
    version: 1;
    teamId: string;
    teamName?: string;
    objective: string;
    topicId?: string;
    domain: string;
    createdAt: number;
    members: Array<Pick<TeamMemberState, 'name' | 'profileName' | 'brief' | 'status' | 'activations' | 'lastOutput' | 'lastError' | 'lastRunId'>>;
    messages: TeamMessage[];
    tasks: TeamTask[];
    summary?: TeamSummary;
}

export const TEAM_MEMBER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const TEAM_MIN_MEMBERS = 2;
export const TEAM_MAX_MEMBERS = 6;
export const TEAM_MAX_BRIEF_CHARS = 4000;
export const TEAM_MAX_MESSAGE_CHARS = 8000;
export const TEAM_MAX_MESSAGES = 400;
export const TEAM_MAX_PENDING_PER_MEMBER = 50;
export const TEAM_MAX_SUBJECT_CHARS = 200;
export const TEAM_MAX_DESCRIPTION_CHARS = 4000;
export const TEAM_MAX_WRITE_SCOPES = 8;
export const TEAM_MAX_WRITE_SCOPE_CHARS = 200;
