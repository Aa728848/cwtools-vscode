/**
 * run_code: model-scripted tool fan-out.
 *
 * A run_code call chains a bounded sequence of ordinary tool steps in ONE
 * model round trip, exploiting long output windows (DeepSeek V4) and cutting
 * per-turn input resends. The runner executes every step through the same
 * pipeline as a direct tool call — policy, plan-mode guard, git guard,
 * scheduler and write queue — so run_code is a transport optimization, never
 * a permission or domain bypass. The runner derives the step allowlist from
 * the model-visible catalog it already filtered by mode/domain; agentTools
 * only validates shape here.
 */

import type { ToolDefinition } from '../types';

export const RUN_CODE_MAX_STEPS = 32;
/** Per-step serialized result cap; keeps the aggregate inside tool-result archives. */
export const RUN_CODE_STEP_RESULT_CHARS = 4_000;
/** Serialized argument cap per step (rejects accidental file dumps). */
export const RUN_CODE_STEP_ARGS_CHARS = 32_000;
/** Aggregate wall-clock budget for one run_code fan-out; aborts remaining steps. */
export const RUN_CODE_FANOUT_TIMEOUT_MS = 300_000;

export interface RunCodeStep {
    tool: string;
    args: Record<string, unknown>;
}

/**
 * Tools a run_code step may never target, even when the current mode/domain
 * would otherwise admit them: interactive, orchestration and goal tools are
 * turn-driven and would deadlock or corrupt loop state when nested.
 */
export const RUN_CODE_BLOCKED_STEPS: ReadonlySet<string> = new Set([
    'run_code',
    'ask_user_question',
    'select_tools',
    'run_skill',
    'dispatch_agents',
    'merge_results',
    'query_blackboard',
    'cancel_dispatch',
    'save_workflow',
    'create_goal',
    'update_goal',
    'set_goal_budget',
    'get_goal',
    'write_design_blueprint',
    'get_design_blueprint_contract',
    'history',
    'web_open',
    'web_find',
    'list_processes',
    'read_process',
    'write_process_stdin',
    'terminate_process',
    'convert_image_to_dds',
    'convert_audio',
    'deploy_mod_asset',
]);

/**
 * Derive the step allowlist from the runner's model-visible catalog. The
 * catalog is already filtered by mode, domain, workflow policy and web
 * access, so this set can never admit a tool the model could not call
 * directly in the same run.
 */
export function computeRunCodeAllowedStepNames(tools: readonly ToolDefinition[]): Set<string> {
    const names = new Set<string>();
    for (const tool of tools) {
        const name = tool.function.name;
        if (typeof name === 'string' && name.length > 0 && !RUN_CODE_BLOCKED_STEPS.has(name)) {
            names.add(name);
        }
    }
    return names;
}

export type RunCodeStepPlanResult =
    | { ok: true; steps: RunCodeStep[] }
    | { ok: false; error: string };

/**
 * Validate the model-supplied step plan against the runner-provided allowlist.
 * Errors name the offending step so the model can repair in one round trip.
 */
export function validateRunCodeStepPlan(
    rawSteps: unknown,
    allowedToolNames: ReadonlySet<string>,
): RunCodeStepPlanResult {
    if (!Array.isArray(rawSteps)) return { ok: false, error: 'run_code requires a steps array.' };
    if (rawSteps.length === 0) return { ok: false, error: 'run_code requires at least one step.' };
    if (rawSteps.length > RUN_CODE_MAX_STEPS) {
        return { ok: false, error: `run_code supports at most ${RUN_CODE_MAX_STEPS} steps; split the work into multiple run_code calls.` };
    }
    const steps: RunCodeStep[] = [];
    for (let index = 0; index < rawSteps.length; index++) {
        const problem = (message: string): string => `Step ${index + 1}: ${message}`;
        const raw = rawSteps[index];
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            return { ok: false, error: problem('must be an object with tool and args.') };
        }
        const record = raw as Record<string, unknown>;
        if (typeof record.tool !== 'string' || record.tool.trim().length === 0) {
            return { ok: false, error: problem('tool must be a non-empty string.') };
        }
        const tool = record.tool.trim();
        if (RUN_CODE_BLOCKED_STEPS.has(tool)) {
            return { ok: false, error: problem(`tool '${tool}' cannot run inside run_code.`) };
        }
        if (!allowedToolNames.has(tool)) {
            return { ok: false, error: problem(`tool '${tool}' is not available in the current mode/domain.`) };
        }
        if (record.args === undefined) {
            steps.push({ tool, args: {} });
            continue;
        }
        if (typeof record.args !== 'object' || record.args === null || Array.isArray(record.args)) {
            return { ok: false, error: problem('args must be an object.') };
        }
        try {
            if (JSON.stringify(record.args).length > RUN_CODE_STEP_ARGS_CHARS) {
                return { ok: false, error: problem(`args exceed the ${RUN_CODE_STEP_ARGS_CHARS} character bound.`) };
            }
        } catch {
            return { ok: false, error: problem('args must be JSON-serializable.') };
        }
        steps.push({ tool, args: record.args as Record<string, unknown> });
    }
    return { ok: true, steps };
}

export interface TruncatedRunCodeStepResult {
    value: unknown;
    truncated: boolean;
}

/** Bound each step's contribution so the aggregate stays archive-friendly. */
export function truncateRunCodeStepResult(result: unknown): TruncatedRunCodeStepResult {
    if (typeof result === 'string') {
        if (result.length <= RUN_CODE_STEP_RESULT_CHARS) return { value: result, truncated: false };
        return {
            value: `${result.slice(0, RUN_CODE_STEP_RESULT_CHARS)}\n...[truncated ${result.length - RUN_CODE_STEP_RESULT_CHARS} chars]`,
            truncated: true,
        };
    }
    try {
        const serialized = JSON.stringify(result);
        if (serialized === undefined || serialized.length <= RUN_CODE_STEP_RESULT_CHARS) {
            return { value: result, truncated: false };
        }
        return { value: `${serialized.slice(0, RUN_CODE_STEP_RESULT_CHARS)}\n...[truncated]`, truncated: true };
    } catch {
        return { value: result, truncated: false };
    }
}

/** Mirror the runner's tool-result failure convention (success/ok/status). */
export function runCodeStepSucceeded(result: unknown): boolean {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return true;
    const record = result as Record<string, unknown>;
    if (record.success === false || record.ok === false) return false;
    const status = record.status;
    return status !== 'error' && status !== 'unavailable';
}

export interface RunCodeStepOutcome {
    index: number;
    tool: string;
    success: boolean;
    error?: string;
    truncated?: boolean;
    result?: unknown;
}

export interface RunCodeAggregateResult {
    success: boolean;
    stepsExecuted: number;
    /** True when the fan-out signal fired before every step completed. */
    aborted?: boolean;
    results: RunCodeStepOutcome[];
}

/**
 * Execute a validated step plan. A failed step aborts nothing: later steps
 * still run and the aggregate reports every outcome, so one bad read never
 * hides the rest of the fan-out. The optional signal is checked before each
 * step; when it fires, the partial aggregate is returned with `aborted`.
 */
export async function executeRunCodeSteps(
    steps: readonly RunCodeStep[],
    runStep: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
    signal?: AbortSignal,
): Promise<RunCodeAggregateResult> {
    const results: RunCodeStepOutcome[] = [];
    let anyFailure = false;
    try {
        for (let index = 0; index < steps.length; index++) {
            signal?.throwIfAborted();
            const step = steps[index]!;
            try {
                const raw = await runStep(step.tool, step.args);
                // Judge success on the raw result BEFORE truncation: a large
                // failure object must not turn into a "successful" string.
                const success = runCodeStepSucceeded(raw);
                if (!success) anyFailure = true;
                const { value, truncated } = truncateRunCodeStepResult(raw);
                results.push({ index, tool: step.tool, success, ...(truncated ? { truncated } : {}), result: value });
            } catch (error) {
                anyFailure = true;
                results.push({
                    index,
                    tool: step.tool,
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    } catch (error) {
        if (signal?.aborted) {
            return { success: false, aborted: true, stepsExecuted: results.length, results };
        }
        throw error;
    }
    // A step that fails because the signal fired (including the final step)
    // must still surface as an aborted fan-out, not an ordinary failure.
    if (signal?.aborted) {
        return { success: false, aborted: true, stepsExecuted: results.length, results };
    }
    return { success: !anyFailure, stepsExecuted: steps.length, results };
}
