import type { AgentTaskRecord } from './taskManager';
import type { DurableAgentGoal } from './goalStore';

export type ActivityKind = 'goal' | 'task' | 'tool' | 'compaction' | 'validation' | 'side_question';
export type ActivityStatus = 'queued' | 'running' | 'blocked' | 'complete' | 'failed' | 'attention';

export interface AgentActivity {
    id: string;
    kind: ActivityKind;
    label: string;
    status: ActivityStatus;
    startedAt?: number;
    endedAt?: number;
    parentId?: string;
    detail?: string;
    outputRef?: string;
}

export interface ActivityProjection {
    version: 1;
    lifecycle: 'ready' | 'disposed';
    turn?: {
        turnId: string;
        phase: 'running' | 'streaming' | 'tool_call' | 'retrying' | 'waiting';
        stream?: 'assistant' | 'thinking' | 'tool_call';
        step: number;
        retry?: { attempt: number; maxAttempts: number; delayMs: number; statusCode?: number };
        pendingApprovals: string[];
        activeToolCalls: Array<{ invocationId: string; name: string }>;
        since: number;
    };
    background: Array<{ taskId: string; kind: string; status: string; since: number }>;
    lastTurn?: { reason: string; durationMs?: number; at: number };
    items: AgentActivity[];
}

function goalDetail(goal: DurableAgentGoal): string | undefined {
    const parts: string[] = [];
    if (goal.budgetLimits.tokens !== undefined) parts.push(`tokens ${goal.tokensUsed}/${goal.budgetLimits.tokens}`);
    else if (goal.tokensUsed > 0) parts.push(`tokens ${goal.tokensUsed}`);
    if (goal.turnsUsed > 0 || goal.budgetLimits.turns !== undefined) {
        parts.push(goal.budgetLimits.turns !== undefined ? `turns ${goal.turnsUsed}/${goal.budgetLimits.turns}` : `turns ${goal.turnsUsed}`);
    }
    if (goal.budgetLimits.wallClockMs !== undefined && goal.wallClockMs > 0) {
        parts.push(`time ${Math.round(goal.wallClockMs / 60000)}/${Math.round(goal.budgetLimits.wallClockMs / 60000)}m`);
    }
    return goal.terminalReason || parts.join(' · ') || undefined;
}

export function projectActivities(input: {
    goal?: DurableAgentGoal;
    tasks?: readonly AgentTaskRecord[];
    events?: readonly {
        id?: string;
        eventId?: string;
        invocationId?: string;
        type: string;
        timestamp?: number;
        payload?: Record<string, unknown>;
    }[];
}): ActivityProjection {
    const items: AgentActivity[] = [];
    const background: ActivityProjection['background'] = [];
    if (input.goal) {
        items.push({
            id: input.goal.goalId,
            kind: 'goal',
            label: input.goal.objective,
            status: input.goal.status === 'active' ? 'running'
                : input.goal.status === 'blocked' || input.goal.status === 'paused' ? 'blocked'
                    : input.goal.status === 'complete' ? 'complete'
                        : 'failed',
            startedAt: input.goal.createdAt,
            endedAt: ['complete', 'cancelled'].includes(input.goal.status) ? input.goal.updatedAt : undefined,
            detail: goalDetail(input.goal),
        });
    }
    for (const task of input.tasks ?? []) {
        if (task.status === 'queued' || task.status === 'running' || task.status === 'detached' || task.status === 'suspended') {
            background.push({
                taskId: task.taskId,
                kind: task.kind,
                status: task.status,
                since: task.startedAt ?? task.createdAt,
            });
        }
        items.push({
            id: task.taskId,
            kind: task.kind === 'compaction' ? 'compaction' : task.kind === 'validation' ? 'validation' : 'task',
            label: task.resultSummary ?? `${task.kind} task`,
            status: ['queued', 'suspended'].includes(task.status) ? 'queued'
                : ['running', 'detached'].includes(task.status) ? 'running'
                    : task.status === 'completed' ? 'complete'
                        : task.status === 'lost' ? 'attention'
                            : 'failed',
            startedAt: task.startedAt ?? task.createdAt,
            endedAt: task.endedAt,
            parentId: task.parentTaskId,
            outputRef: task.outputRef,
        });
    }
    const activeTools = new Map<string, { invocationId: string; name: string }>();
    const pendingApprovals = new Set<string>();
    let turnSince: number | undefined;
    let step = 0;
    let phase: NonNullable<ActivityProjection['turn']>['phase'] = 'running';
    let stream: NonNullable<ActivityProjection['turn']>['stream'];
    let retry: NonNullable<ActivityProjection['turn']>['retry'];
    let lastTurn: ActivityProjection['lastTurn'];
    for (const event of input.events ?? []) {
        const eventId = event.invocationId ?? event.eventId ?? event.id;
        turnSince ??= event.timestamp;
        if (event.type === 'tool_call_start' && eventId) {
            activeTools.set(eventId, {
                invocationId: eventId,
                name: typeof event.payload?.toolName === 'string' ? event.payload.toolName : 'tool',
            });
            phase = 'tool_call';
            stream = 'tool_call';
        } else if (event.type === 'tool_call_end' && eventId) {
            activeTools.delete(eventId);
        } else if (event.type === 'permission_requested' && eventId) {
            pendingApprovals.add(eventId);
            phase = 'waiting';
        } else if (event.type === 'permission_resolved' && eventId) {
            pendingApprovals.delete(eventId);
        } else if (event.type === 'model_call_delta') {
            phase = 'streaming';
            stream = event.payload?.kind === 'thinking' ? 'thinking' : 'assistant';
            step += 1;
        } else if (event.type === 'compaction_retry') {
            phase = 'retrying';
            retry = {
                attempt: typeof event.payload?.attempt === 'number' ? event.payload.attempt : 1,
                maxAttempts: 3,
                delayMs: typeof event.payload?.delayMs === 'number' ? event.payload.delayMs : 0,
                statusCode: typeof event.payload?.statusCode === 'number' ? event.payload.statusCode : undefined,
            };
        } else if (event.type === 'status_changed') {
            const status = event.payload?.status;
            if (status === 'completed' || status === 'done' || status === 'failed' || status === 'cancelled') {
                lastTurn = {
                    reason: status,
                    at: event.timestamp ?? Date.now(),
                    durationMs: turnSince === undefined || event.timestamp === undefined
                        ? undefined
                        : Math.max(0, event.timestamp - turnSince),
                };
            }
        }
        if (!['compaction_started', 'compaction_completed', 'validation_completed', 'side_question_started', 'side_question_completed'].includes(event.type)) continue;
        items.push({
            id: eventId ?? `${event.type}_${event.timestamp ?? 0}`,
            kind: event.type.startsWith('compaction') ? 'compaction'
                : event.type.startsWith('side_question') ? 'side_question'
                    : 'validation',
            label: event.type.replace(/_/g, ' '),
            status: event.type.endsWith('started') ? 'running' : 'complete',
            startedAt: event.timestamp,
        });
    }
    items.sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0) || left.id.localeCompare(right.id));
    background.sort((left, right) => left.since - right.since || left.taskId.localeCompare(right.taskId));
    return {
        version: 1,
        lifecycle: 'ready',
        turn: lastTurn ? undefined : turnSince === undefined ? undefined : {
            turnId: 'active',
            phase,
            stream,
            step,
            retry,
            pendingApprovals: [...pendingApprovals].sort(),
            activeToolCalls: [...activeTools.values()].sort((left, right) => left.invocationId.localeCompare(right.invocationId)),
            since: turnSince,
        },
        background,
        lastTurn,
        items,
    };
}
