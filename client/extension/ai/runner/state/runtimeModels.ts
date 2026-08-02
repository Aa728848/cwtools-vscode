import type { AgentSchedulingState } from '../../types';
import type { DurableAgentGoal } from '../goalStore';
import type { AgentTaskRecord } from '../taskManager';
import type { RuntimeInteraction, RuntimePrompt } from '../promptInteraction';
import type { PermissionTraceEntry } from '../permissionTrace';
import {
    applyTranscriptBatch,
    boundTranscriptSnapshot,
    type AgentTranscriptSnapshot,
    type TranscriptOpBatch,
} from '../../../../shared/agentTranscript';
import { DomainStateStore } from './domainStateStore';

export interface SchedulingDomainState {
    revision: number;
    state: AgentSchedulingState | null;
    providerCapacity?: number;
}

export interface GoalDomainState {
    revision: number;
    goal: DurableAgentGoal | null;
}

export interface TaskDomainState {
    revision: number;
    tasks: AgentTaskRecord[];
}

export interface ContextDomainState {
    revision: number;
    turns: Array<{ turnId: string; runId?: string; status: 'started' | 'completed' | 'interrupted' }>;
    toolSchemas: string[];
    mutations?: Array<{
        action: 'append' | 'splice' | 'compaction' | 'background_result';
        turnId?: string;
        ref?: string;
    }>;
    compactionBoundarySequence?: number;
}

export interface PromptDomainState {
    revision: number;
    prompts: RuntimePrompt[];
}

export interface InteractionDomainState {
    revision: number;
    interactions: RuntimeInteraction[];
}

export interface TranscriptDomainState {
    revision: number;
    transcript: AgentTranscriptSnapshot;
}

export interface PermissionDomainState {
    revision: number;
    entries: PermissionTraceEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createRuntimeDomainStateStore(topicId: string, agentId: string): DomainStateStore {
    const store = new DomainStateStore(topicId, agentId);
    store.registerModel<SchedulingDomainState>({
        domain: 'scheduling',
        version: 1,
        initialState: () => ({ revision: 0, state: null }),
        validateState: (value): value is SchedulingDomainState => isRecord(value) && typeof value.revision === 'number',
    });
    store.registerModel<GoalDomainState>({
        domain: 'goal',
        version: 1,
        initialState: () => ({ revision: 0, goal: null }),
        validateState: (value): value is GoalDomainState => isRecord(value) && typeof value.revision === 'number',
    });
    store.registerModel<TaskDomainState>({
        domain: 'task',
        version: 1,
        initialState: () => ({ revision: 0, tasks: [] }),
        validateState: (value): value is TaskDomainState =>
            isRecord(value) && typeof value.revision === 'number' && Array.isArray(value.tasks),
    });
    store.registerModel<ContextDomainState>({
        domain: 'context',
        version: 1,
        initialState: () => ({ revision: 0, turns: [], toolSchemas: [], mutations: [] }),
        validateState: (value): value is ContextDomainState =>
            isRecord(value) && typeof value.revision === 'number' && Array.isArray(value.turns) && Array.isArray(value.toolSchemas),
    });
    store.registerModel<PromptDomainState>({
        domain: 'prompt',
        version: 1,
        initialState: () => ({ revision: 0, prompts: [] }),
        validateState: (value): value is PromptDomainState =>
            isRecord(value) && typeof value.revision === 'number' && Array.isArray(value.prompts),
    });
    store.registerModel<InteractionDomainState>({
        domain: 'interaction',
        version: 1,
        initialState: () => ({ revision: 0, interactions: [] }),
        validateState: (value): value is InteractionDomainState =>
            isRecord(value) && typeof value.revision === 'number' && Array.isArray(value.interactions),
    });
    store.registerModel<TranscriptDomainState>({
        domain: 'transcript',
        version: 1,
        initialState: () => ({
            revision: 0,
            transcript: {
                version: 1,
                agentId,
                sequence: 0,
                turns: [],
                entities: [],
                meta: {},
                hasMoreOlder: false,
            },
        }),
        validateState: (value): value is TranscriptDomainState =>
            isRecord(value) && typeof value.revision === 'number'
            && isRecord(value.transcript) && value.transcript.version === 1,
        normalizeState: value => ({
            ...value,
            transcript: boundTranscriptSnapshot(value.transcript),
        }),
    });
    store.registerModel<PermissionDomainState>({
        domain: 'permission',
        version: 1,
        initialState: () => ({ revision: 0, entries: [] }),
        validateState: (value): value is PermissionDomainState =>
            isRecord(value) && typeof value.revision === 'number' && Array.isArray(value.entries),
    });

    store.registry.register<SchedulingDomainState, { state: AgentSchedulingState | null }>({
        type: 'scheduling.state.replaced',
        version: 1,
        domain: 'scheduling',
        validatePayload: (value): value is { state: AgentSchedulingState | null } => isRecord(value) && 'state' in value,
        apply: (state, payload) => ({ ...state, revision: state.revision + 1, state: payload.state }),
    });
    store.registry.register<GoalDomainState, { goal: DurableAgentGoal | null }>({
        type: 'goal.state.replaced',
        version: 1,
        domain: 'goal',
        validatePayload: (value): value is { goal: DurableAgentGoal | null } => isRecord(value) && 'goal' in value,
        apply: (state, payload) => ({ revision: state.revision + 1, goal: payload.goal }),
    });
    store.registry.register<TaskDomainState, { tasks: AgentTaskRecord[] }>({
        type: 'task.state.replaced',
        version: 1,
        domain: 'task',
        validatePayload: (value): value is { tasks: AgentTaskRecord[] } => isRecord(value) && Array.isArray(value.tasks),
        apply: (state, payload) => ({ revision: state.revision + 1, tasks: payload.tasks }),
    });
    store.registry.register<ContextDomainState, { turnId: string; runId?: string; status: 'started' | 'completed' | 'interrupted' }>({
        type: 'context.turn.recorded',
        version: 1,
        domain: 'context',
        validatePayload: (value): value is { turnId: string; runId?: string; status: 'started' | 'completed' | 'interrupted' } =>
            isRecord(value) && typeof value.turnId === 'string'
            && (value.status === 'started' || value.status === 'completed' || value.status === 'interrupted'),
        apply: (state, payload) => ({
            ...state,
            revision: state.revision + 1,
            turns: [...state.turns.filter(turn => turn.turnId !== payload.turnId), payload].slice(-100),
        }),
    });
    store.registry.register<ContextDomainState, { loaded: string[] }>({
        type: 'context.tool_schemas.replaced',
        version: 1,
        domain: 'context',
        validatePayload: (value): value is { loaded: string[] } =>
            isRecord(value) && Array.isArray(value.loaded) && value.loaded.every(item => typeof item === 'string'),
        apply: (state, payload) => ({
            ...state,
            revision: state.revision + 1,
            toolSchemas: [...new Set(payload.loaded)].sort(),
        }),
    });
    store.registry.register<ContextDomainState, { turnId: string }>({
        type: 'context.turn.undone',
        version: 1,
        domain: 'context',
        validatePayload: (value): value is { turnId: string } => isRecord(value) && typeof value.turnId === 'string',
        apply: (state, payload) => ({
            ...state,
            revision: state.revision + 1,
            turns: state.turns.filter(turn => turn.turnId !== payload.turnId),
        }),
    });
    store.registry.register<ContextDomainState, {
        action: 'append' | 'splice' | 'compaction' | 'background_result';
        turnId?: string;
        ref?: string;
    }>({
        type: 'context.transcript.changed',
        version: 1,
        domain: 'context',
        validatePayload: (value): value is {
            action: 'append' | 'splice' | 'compaction' | 'background_result';
            turnId?: string;
            ref?: string;
        } => isRecord(value)
            && (value.action === 'append' || value.action === 'splice'
                || value.action === 'compaction' || value.action === 'background_result')
            && (value.turnId === undefined || typeof value.turnId === 'string')
            && (value.ref === undefined || typeof value.ref === 'string'),
        apply: (state, payload) => ({
            ...state,
            revision: state.revision + 1,
            mutations: [...(state.mutations ?? []), payload].slice(-200),
        }),
    });
    store.registry.register<ContextDomainState, { sequence: number }>({
        type: 'context.compaction.boundary.set',
        version: 1,
        domain: 'context',
        validatePayload: (value): value is { sequence: number } =>
            isRecord(value) && typeof value.sequence === 'number'
            && Number.isSafeInteger(value.sequence) && value.sequence >= 0,
        apply: (state, payload) => ({
            ...state,
            revision: state.revision + 1,
            compactionBoundarySequence: Math.max(state.compactionBoundarySequence ?? 0, payload.sequence),
        }),
    });
    store.registry.register<PromptDomainState, { prompts: RuntimePrompt[] }>({
        type: 'prompt.state.replaced',
        version: 1,
        domain: 'prompt',
        validatePayload: (value): value is { prompts: RuntimePrompt[] } =>
            isRecord(value) && Array.isArray(value.prompts),
        apply: (state, payload) => ({
            revision: state.revision + 1,
            prompts: payload.prompts.slice(-200),
        }),
    });
    store.registry.register<InteractionDomainState, { interactions: RuntimeInteraction[] }>({
        type: 'interaction.state.replaced',
        version: 1,
        domain: 'interaction',
        validatePayload: (value): value is { interactions: RuntimeInteraction[] } =>
            isRecord(value) && Array.isArray(value.interactions),
        apply: (state, payload) => ({
            revision: state.revision + 1,
            interactions: payload.interactions.slice(-300),
        }),
    });
    store.registry.register<TranscriptDomainState, { transcript: AgentTranscriptSnapshot }>({
        type: 'transcript.state.replaced',
        version: 1,
        domain: 'transcript',
        validatePayload: (value): value is { transcript: AgentTranscriptSnapshot } =>
            isRecord(value) && isRecord(value.transcript) && value.transcript.version === 1,
        apply: (state, payload) => ({
            revision: state.revision + 1,
            transcript: boundTranscriptSnapshot(payload.transcript),
        }),
    });
    store.registry.register<TranscriptDomainState, { batch: TranscriptOpBatch }>({
        type: 'transcript.batch.applied',
        version: 1,
        domain: 'transcript',
        validatePayload: (value): value is { batch: TranscriptOpBatch } =>
            isRecord(value) && isRecord(value.batch)
            && value.batch.version === 1
            && typeof value.batch.agentId === 'string'
            && typeof value.batch.sequence === 'number'
            && Array.isArray(value.batch.operations),
        apply: (state, payload) => {
            const result = applyTranscriptBatch(state.transcript, payload.batch);
            if (result.gap) {
                throw new Error(
                    `Transcript operation gap (${result.gap.kind}): expected ${result.gap.expected}, received ${result.gap.received}.`,
                );
            }
            return {
                revision: state.revision + 1,
                transcript: result.snapshot,
            };
        },
    });
    store.registry.register<PermissionDomainState, { entry: PermissionTraceEntry }>({
        type: 'permission.trace.appended',
        version: 1,
        domain: 'permission',
        validatePayload: (value): value is { entry: PermissionTraceEntry } =>
            isRecord(value) && isRecord(value.entry)
            && typeof value.entry.id === 'string'
            && typeof value.entry.topicId === 'string'
            && typeof value.entry.threadId === 'string'
            && typeof value.entry.tool === 'string'
            && typeof value.entry.timestamp === 'number',
        apply: (state, payload) => ({
            revision: state.revision + 1,
            entries: [...state.entries.filter(entry => entry.id !== payload.entry.id), payload.entry]
                .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
                .slice(-500),
        }),
    });
    return store;
}
