import type { AgentMode, AgentRuntimeDomain, AgentToolFocus, ToolDefinition } from './types';
import { domainForExecutionMode } from './runner/scheduling';
import { TOOL_REGISTRY } from './tools/registry';
import { evaluateEffectiveToolPolicy } from './runner/effectiveToolPolicy';
import { agentProfileCatalog } from './runner/agentProfileCatalog';

export interface ToolFilterOptions {
    domain?: AgentRuntimeDomain;
    useSlimPrompt?: boolean;
    excludeTools?: string[];
    profileName?: string;
}

export type { AgentToolFocus } from './types';

const WRITE_EXECUTION_MODES = new Set<AgentMode>([
    'build',
    'utility',
    'gui_expert',
    'loc_translator',
    'loc_writer',
    'orchestrator',
    'script',
]);

const NON_DELIVERY_WRITE_TOOLS = new Set([
    'write_design_blueprint',
    'save_workflow',
]);

const BUILD_LIFECYCLE_MODES = new Set<AgentMode>([
    'build', 'gui_expert', 'loc_translator', 'loc_writer', 'script',
]);

const READ_FOCUSED_MODES = new Set<AgentMode>([
    'plan', 'orchestrator', 'explore', 'review', 'script_reviewer',
]);

export function initialToolFocusForMode(mode: AgentMode): AgentToolFocus | undefined {
    if (BUILD_LIFECYCLE_MODES.has(mode) || mode === 'utility') return 'write';
    return READ_FOCUSED_MODES.has(mode) ? 'discovery' : undefined;
}

/**
 * Writable modes keep discovery narrow, then expose execution-critical deferred
 * schemas without depending on the model to discover the disclosure protocol.
 */
export function shouldAutoDiscloseExecutionTools(
    mode: AgentMode,
    authorization: import('./types').AgentAuthorization,
): boolean {
    return authorization === 'workspace_write' && WRITE_EXECUTION_MODES.has(mode);
}

/**
 * A workspace-write admission must not turn an internal validation checkpoint
 * into a second user approval boundary.
 */
export function shouldContinueAuthorizedExecution(
    mode: AgentMode,
    authorization: import('./types').AgentAuthorization,
    executionActionObserved: boolean,
): boolean {
    return authorization === 'workspace_write'
        && WRITE_EXECUTION_MODES.has(mode)
        && !executionActionObserved;
}

/** Detect an unsupported plain-text clarification so execution recovery does not loop. */
export function finalResponseRequiresUserInput(content: string): boolean {
    const text = content.trim();
    if (!text) return false;

    // The decision normally appears at the end of a longer analysis. Keeping
    // this bounded avoids treating an earlier discussion of missing inputs as
    // the final state of an otherwise executable response.
    const tail = text.slice(-2_000);
    return /\b(?:please|could you|can you)\s+(?:clarify|specify|provide|describe|choose|confirm)\b/i.test(tail)
        || /\b(?:cannot|can't|unable to)\s+(?:safely\s+)?(?:continue|proceed|implement|modify|change)[\s\S]{0,160}\b(?:without|until)\b/i.test(tail)
        || /(?:没有|缺少|尚无|未提供|不清楚)[^。！？\n]{0,100}(?:修改目标|变更要求|故障描述|具体需求|具体要求|目标代码|操作范围)/.test(tail)
        || /(?:请|需要)[^。！？\n]{0,40}(?:说明|明确|提供|选择|确认|补充)[^。！？\n]{0,80}(?:修改目标|变更要求|故障|需求|要求|范围|操作)/.test(tail);
}

export function isExecutionActionTool(toolName: string): boolean {
    if (toolName === 'dispatch_agents') return true;
    if (NON_DELIVERY_WRITE_TOOLS.has(toolName)) return false;
    const effect = TOOL_REGISTRY.get(toolName as import('./types').AgentToolName)?.effect;
    return effect === 'workspace_write'
        || effect === 'shell'
        || effect === 'git'
        || effect === 'media'
        || effect === 'process';
}

/**
 * Detect a final answer where the model stops because it misread truncated
 * tool results (large diff previews, diagnostic lists) as partial application.
 * Only meaningful for write-authorized writable runs, where the loop can push
 * a bounded recovery instead of accepting the stop.
 */
export function isTruncationInducedStop(content: string): boolean {
    const text = content.trim();
    if (!text) return false;
    const tail = text.slice(-2_000);
    if (!/(?:截断|truncat)/i.test(tail)) return false;
    return /(?:不能|无法|不应|不会|难以|风险|不再|停止|中止)[^。！？\n]{0,40}(?:继续|批量|替换|修改|写入|修复|执行|安全)/.test(tail)
        || /\b(?:cannot|can'?t|unable|not\s+safe|risks?)\b[\s\S]{0,80}\b(?:continue|proceed|batch|apply|safely|modif|writ)/i.test(tail);
}

const FOCUS_GUIDANCE: Record<AgentToolFocus, string> = {
    discovery: 'Locate the relevant project area and evidence source; do not attempt writes yet.',
    validation: 'Prove candidate syntax, scope, identifiers, and references before writing.',
    write: 'Apply the narrowest guarded edit; host-side semantic preflight remains authoritative.',
    finalize: 'Inspect fresh diagnostics and affected references; repair any post-write failure.',
};

/** Advisory focus only; capabilities are controlled by disclosure and the executor. */
export function buildToolFocusReminder(
    mode: AgentMode,
    focus: AgentToolFocus | undefined,
    domain: AgentRuntimeDomain = domainForExecutionMode(mode),
): string {
    const normalizedFocus = focus;
    if (!normalizedFocus) return '';
    const guidance = domain === 'general'
        ? normalizedFocus === 'discovery'
            ? 'Inspect the repository and identify the exact implementation and verification surface; do not write yet.'
            : normalizedFocus === 'write'
                ? 'Implement the scoped change and run relevant commands through the policy engine.'
                : normalizedFocus === 'validation'
                        ? 'Cross-check the proposed or reviewed behavior against callers, diagnostics, tests, and current implementation.'
                        : 'Synthesize the evidence, review the diff when applicable, and report verification and remaining risks.'
        : FOCUS_GUIDANCE[normalizedFocus];
    return `<system-reminder>Current ${mode} focus: ${normalizedFocus}. ${guidance} `
        + 'This focus is advisory; use select_tools for any capability allowed by the current mode and policy.</system-reminder>';
}

export interface IterationLimitOptions {
    mode: AgentMode;
    baseContextLimit: number;
    bypassSandbox?: boolean;
    override?: number;
    /** When true, apply the bounded role-specific sub-Agent limits. */
    isSubAgent?: boolean;
}

export function shouldRenewIterationLimit(input: {
    renewable: boolean;
    iteration: number;
    limit: number;
    consecutiveErrors: number;
    blockingValidationIssues: number;
}): boolean {
    return input.renewable
        && input.iteration >= input.limit
        && input.consecutiveErrors === 0
        && input.blockingValidationIssues === 0;
}

/** Final guard above the normal hard model-call budget; not a second runtime budget. */
export const TOP_LEVEL_ITERATION_SAFETY_CAP = 256;
export const SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS = 16_384;
export const SLIM_SUB_AGENT_THINKING_CHAR_LIMIT = 24_000;

export function resolveRunMaxOutputTokens(options: Pick<ToolFilterOptions, 'useSlimPrompt'> = {}): number | undefined {
    return options.useSlimPrompt ? SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS : undefined;
}

export function resolveCompactionOutputReserve(desiredTokens: number, contextLimit: number): number {
    const finiteDesired = Number.isFinite(desiredTokens) ? Math.max(0, Math.floor(desiredTokens)) : 0;
    const finiteLimit = Number.isFinite(contextLimit) ? Math.max(1, Math.floor(contextLimit)) : 1;
    return Math.min(finiteDesired, Math.max(4_096, Math.floor(finiteLimit * 0.25)));
}

export interface ContextSafeOutputBudgetOptions {
    desiredTokens: number;
    contextLimit: number;
    promptTokens: number;
    safetyMarginTokens?: number;
    minimumTokens?: number;
}

/** Clamp the advertised output allowance to the request's remaining context window. */
export function resolveContextSafeOutputTokens(options: ContextSafeOutputBudgetOptions): number {
    const desired = Math.max(1, Math.floor(options.desiredTokens));
    const minimum = Math.max(1, Math.floor(options.minimumTokens ?? 1_024));
    const available = Math.floor(options.contextLimit)
        - Math.max(0, Math.ceil(options.promptTokens))
        - Math.max(0, Math.ceil(options.safetyMarginTokens ?? 2_048));
    if (available < minimum) return Math.max(1, Math.min(desired, available));
    return Math.min(desired, available);
}

export function filterToolDefinitionsForMode(
    tools: readonly ToolDefinition[],
    mode: AgentMode,
    options: ToolFilterOptions = {},
): ToolDefinition[] {
    const domain = options.domain ?? domainForExecutionMode(mode);
    let filtered = tools.filter(t => {
        const entry = TOOL_REGISTRY.get(t.function.name as import('./types').AgentToolName);
        if (!entry) return false;
        if (domain === 'general' && entry.domain === 'paradox') return false;
        
        return evaluateEffectiveToolPolicy(entry.name, {
            mode,
            domain,
            isSubAgent: options.useSlimPrompt,
            profile: options.profileName ? agentProfileCatalog.get(options.profileName) : undefined,
        }).allowed;
    });

    if (options.excludeTools && options.excludeTools.length > 0) {
        const excluded = new Set(options.excludeTools);
        filtered = filtered.filter(t => !excluded.has(t.function.name));
    }

    if (domain === 'general') {
        filtered = filtered.map(tool =>
            TOOL_REGISTRY.get(tool.function.name as import('./types').AgentToolName)?.generalSchema ?? tool);
    }

    return filtered;
}

const MODE_ITERATION_LIMITS: Record<AgentMode, { min: number; base: number; cap: number }> = {
    build: { min: 20, base: 40, cap: 60 },
    plan: { min: 10, base: 18, cap: 28 },
    explore: { min: 8, base: 16, cap: 24 },
    utility: { min: 15, base: 30, cap: 45 },
    review: { min: 15, base: 30, cap: 45 },
    gui_expert: { min: 15, base: 30, cap: 45 },
    script_reviewer: { min: 8, base: 15, cap: 23 },
    loc_translator: { min: 10, base: 20, cap: 30 },
    loc_writer: { min: 10, base: 20, cap: 30 },
    orchestrator: { min: 32, base: 48, cap: 80 },
    script: { min: 40, base: 64, cap: 96 },
};

export function resolveMaxToolIterations(options: IterationLimitOptions): number {
    const limits = MODE_ITERATION_LIMITS[options.mode] ?? MODE_ITERATION_LIMITS.build;
    if (options.override !== undefined && Number.isFinite(options.override)) {
        return Math.max(1, Math.min(256, Math.floor(options.override)));
    }

    // Top-level execution is governed by renewable soft budgets and the
    // non-renewable hard budget. Keep only a final loop guard here so it does
    // not stop a healthy long-running task before those policies apply.
    if (!options.isSubAgent) return TOP_LEVEL_ITERATION_SAFETY_CAP;

    const scale = Math.max(0.8, Math.min(1.25, options.baseContextLimit / 128000));
    const scaled = Math.floor(limits.base * scale);
    return Math.min(limits.cap, Math.max(limits.min, scaled));
}
