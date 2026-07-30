import { createLoopHookSlots, type LoopHookSlots } from './loopHooks';
import type { LoopStepContext } from './loopKernel';
import { ModelRequestService } from './modelRequestService';
import { StepRetryPolicy } from './stepRetryPolicy';
import { ToolExecutionPipeline, type ToolExecutionPipelineOptions } from './toolExecutionPipeline';

/** Explicit dependency bundle used by the runner adapters and tests. */
export interface AgentRuntimeServices {
    loopHooks: LoopHookSlots<LoopStepContext>;
    retryPolicy: StepRetryPolicy;
    modelRequests: ModelRequestService;
    createToolPipeline(options: ToolExecutionPipelineOptions): ToolExecutionPipeline;
}

export function createAgentRuntimeServices(): AgentRuntimeServices {
    return {
        loopHooks: createLoopHookSlots<LoopStepContext>(),
        retryPolicy: new StepRetryPolicy(),
        modelRequests: new ModelRequestService(),
        createToolPipeline: options => new ToolExecutionPipeline(options),
    };
}
