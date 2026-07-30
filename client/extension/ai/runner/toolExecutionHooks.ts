import { OrderedHookSlot } from './loopHooks';

export interface ToolPipelineContext {
    invocationId: string;
    toolName: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    result?: unknown;
}

export interface ToolExecutionHookSlots {
    beforePolicy: OrderedHookSlot<ToolPipelineContext>;
    beforeExecute: OrderedHookSlot<ToolPipelineContext>;
    afterExecute: OrderedHookSlot<ToolPipelineContext>;
}

export function createToolExecutionHooks(): ToolExecutionHookSlots {
    return {
        beforePolicy: new OrderedHookSlot<ToolPipelineContext>(),
        beforeExecute: new OrderedHookSlot<ToolPipelineContext>(),
        afterExecute: new OrderedHookSlot<ToolPipelineContext>(),
    };
}
