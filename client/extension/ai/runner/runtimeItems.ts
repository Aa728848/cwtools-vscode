export type RuntimeItemType = 'commandExecution' | 'permission' | 'fileChange' | 'process' | 'toolCall';
export type RuntimeItemStatus = 'inProgress' | 'awaitingApproval' | 'completed' | 'failed' | 'declined' | 'cancelled';

export interface RuntimeItem {
    itemId: string;
    threadId?: string;
    turnId?: string;
    type: RuntimeItemType;
    status: RuntimeItemStatus;
    title?: string;
    command?: string;
    cwd?: string;
    startedAt: number;
    completedAt?: number;
    metadata?: Record<string, unknown>;
}

export function completeRuntimeItem(item: RuntimeItem, status: Exclude<RuntimeItemStatus, 'inProgress' | 'awaitingApproval'>, metadata?: Record<string, unknown>): RuntimeItem {
    return {
        ...item,
        status,
        completedAt: Date.now(),
        metadata: { ...(item.metadata ?? {}), ...(metadata ?? {}) },
    };
}

