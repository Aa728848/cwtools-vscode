export type StepRequestKind =
    | 'user_prompt'
    | 'steer'
    | 'approval_result'
    | 'tool_result'
    | 'retry'
    | 'continuation'
    | 'goal_continuation'
    | 'background_result'
    | 'side_question_result';

export interface StepRequest<T = unknown> {
    id: string;
    kind: StepRequestKind;
    payload: T;
    priority: number;
    createdAt: number;
    sourceId?: string;
}

export interface RetryStepPayload {
    pendingToolCalls: ToolCall[];
}

export type RetryStepRequest = StepRequest<RetryStepPayload> & { kind: 'retry' };

function isToolCall(value: unknown): value is ToolCall {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ToolCall>;
    return typeof candidate.id === 'string'
        && candidate.type === 'function'
        && !!candidate.function
        && typeof candidate.function.name === 'string'
        && typeof candidate.function.arguments === 'string';
}

/** Validate persisted retry work before it re-enters the tool policy pipeline. */
export function isRetryStepRequest(value: unknown): value is RetryStepRequest {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<StepRequest<Partial<RetryStepPayload>>>;
    return candidate.kind === 'retry'
        && typeof candidate.id === 'string'
        && Number.isFinite(candidate.priority)
        && Number.isFinite(candidate.createdAt)
        && !!candidate.payload
        && Array.isArray(candidate.payload.pendingToolCalls)
        && candidate.payload.pendingToolCalls.every(isToolCall);
}

const PRIORITY: Record<StepRequestKind, number> = {
    approval_result: 100,
    steer: 90,
    user_prompt: 80,
    side_question_result: 70,
    tool_result: 60,
    background_result: 50,
    retry: 40,
    continuation: 30,
    goal_continuation: 20,
};

let nextRequestSequence = 0;

export function createStepRequest<T>(
    kind: StepRequestKind,
    payload: T,
    options: { id?: string; priority?: number; createdAt?: number; sourceId?: string } = {},
): StepRequest<T> {
    const createdAt = options.createdAt ?? Date.now();
    nextRequestSequence += 1;
    return {
        id: options.id ?? `step_${createdAt}_${nextRequestSequence}`,
        kind,
        payload,
        priority: options.priority ?? PRIORITY[kind],
        createdAt,
        sourceId: options.sourceId,
    };
}

export function compareStepRequests(left: StepRequest, right: StepRequest): number {
    return right.priority - left.priority
        || left.createdAt - right.createdAt
        || left.id.localeCompare(right.id);
}
import type { ToolCall } from '../types';
