import { createToolExecutionHooks, type ToolExecutionHookSlots, type ToolPipelineContext } from './toolExecutionHooks';

export type ToolPipelineStage =
    | 'parse'
    | 'registry'
    | 'scheduling'
    | 'sandbox'
    | 'policy'
    | 'plan_guard'
    | 'permission'
    | 'hook_veto'
    | 'dedupe'
    | 'scheduler'
    | 'execute'
    | 'normalize'
    | 'archive'
    | 'hook_result'
    | 'ledger'
    | 'model_result';

export interface ToolPipelineGuardResult {
    allowed: boolean;
    reason?: string;
}

export interface ToolExecutionPipelineOptions {
    guard?: (stage: ToolPipelineStage, context: ToolPipelineContext) =>
        ToolPipelineGuardResult | Promise<ToolPipelineGuardResult>;
    execute: (context: ToolPipelineContext) => Promise<unknown>;
    normalize?: (result: unknown, context: ToolPipelineContext) => unknown | Promise<unknown>;
    archive?: (result: unknown, context: ToolPipelineContext) => unknown | Promise<unknown>;
    record?: (stage: ToolPipelineStage, context: ToolPipelineContext) => void | Promise<void>;
    hooks?: ToolExecutionHookSlots;
}

const GUARDED_STAGES: readonly ToolPipelineStage[] = [
    'parse',
    'registry',
    'scheduling',
    'sandbox',
    'policy',
    'plan_guard',
    'permission',
    'hook_veto',
    'dedupe',
    'scheduler',
];

/**
 * One fail-closed execution path for every tool. Domain-specific services are
 * injected as guards so their order is fixed without creating import cycles.
 */
export class ToolExecutionPipeline {
    readonly hooks: ToolExecutionHookSlots;

    constructor(private readonly options: ToolExecutionPipelineOptions) {
        this.hooks = options.hooks ?? createToolExecutionHooks();
    }

    async run(input: ToolPipelineContext): Promise<unknown> {
        const context: ToolPipelineContext = {
            ...input,
            args: { ...input.args },
            metadata: { ...(input.metadata ?? {}) },
        };
        context.signal?.throwIfAborted();
        await this.hooks.beforePolicy.run(context, context.signal);
        for (const stage of GUARDED_STAGES) {
            context.signal?.throwIfAborted();
            const check = await this.options.guard?.(stage, context) ?? { allowed: true };
            await this.options.record?.(stage, context);
            if (!check.allowed) {
                return { success: false, error: check.reason ?? `Tool rejected at ${stage}.`, rejectedAt: stage };
            }
        }
        await this.hooks.beforeExecute.run(context, context.signal);
        await this.options.record?.('execute', context);
        let result = await this.options.execute(context);
        await this.options.record?.('normalize', context);
        result = await this.options.normalize?.(result, context) ?? result;
        await this.options.record?.('archive', context);
        result = await this.options.archive?.(result, context) ?? result;
        context.result = result;
        await this.hooks.afterExecute.run(context, context.signal);
        await this.options.record?.('hook_result', context);
        await this.options.record?.('ledger', context);
        await this.options.record?.('model_result', context);
        return result;
    }
}
