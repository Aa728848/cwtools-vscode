import type { DomainSnapshot } from './domainModel';

export interface LegacyRuntimeState {
    agentId: string;
    mode?: unknown;
    schedulingState?: unknown;
    goal?: unknown;
    tasks?: unknown;
    context?: unknown;
}

/** Fail-closed adapter used when V2/V3 checkpoints do not contain domain state. */
export function migrateLegacyRuntimeState(value: LegacyRuntimeState): DomainSnapshot {
    const schedulingState = value.schedulingState && typeof value.schedulingState === 'object'
        ? value.schedulingState
        : null;
    const goal = value.goal && typeof value.goal === 'object' ? value.goal : null;
    const tasks = Array.isArray(value.tasks) ? value.tasks : [];
    const context = value.context && typeof value.context === 'object'
        ? value.context as Record<string, unknown>
        : {};
    const toolSchemas = Array.isArray(context.toolSchemas)
        ? context.toolSchemas.filter((item): item is string => typeof item === 'string')
        : [];
    return {
        version: 1,
        agentId: value.agentId,
        sequence: 0,
        models: {
            scheduling: {
                revision: 0,
                state: schedulingState,
            },
            goal: { revision: 0, goal },
            task: { revision: 0, tasks },
            context: {
                revision: 0,
                turns: [],
                toolSchemas: [...new Set(toolSchemas)].sort(),
            },
        },
    };
}
