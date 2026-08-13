import type { AgentMode, AgentRuntimeDomain, AgentToolStage, ToolDefinition } from './types';
import { defaultDomainForMode } from './agentProfile';
import { TOOL_REGISTRY } from './tools/registry';
import { evaluateEffectiveToolPolicy } from './runner/effectiveToolPolicy';

export interface ToolFilterOptions {
    domain?: AgentRuntimeDomain;
    useSlimPrompt?: boolean;
    excludeTools?: string[];
    legacyFullToolset?: boolean;
}

export type { AgentToolStage } from './types';

const BUILD_STAGE_TOOLS: Partial<Record<AgentToolStage, ReadonlySet<string>>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'workspace_symbols', 'document_symbols',
        'todo_write', 'mcp_call',
        'dispatch_agents',
    ]),
    evidence: new Set([
        'query_project_knowledge', 'query_rules', 'query_cwt_schema', 'query_scope',
        'search_rule_capabilities', 'get_file_context', 'read_file', 'get_pdx_block',
        'get_design_blueprint_contract', 'todo_write',
        'grep', 'workspace_symbols', 'query_blackboard', 'merge_results',
    ]),
    validation: new Set([
        'query_rules', 'query_cwt_schema', 'query_scope', 'explain_scope',
        'parse_pdx_fragment', 'query_references', 'query_definition_by_name',
        'verify_pdx_identifier', 'get_diagnostics', 'get_completion_at', 'get_pdx_block',
        'get_file_context', 'read_file', 'todo_write',
    ]),
    write: new Set([
        'query_rules', 'query_scope', 'parse_pdx_fragment', 'verify_pdx_identifier',
        'get_diagnostics', 'read_file', 'get_file_context', 'get_pdx_block',
        'write_file', 'edit_file', 'replace_lines',
        'rename_symbol',
        'write_localisation', 'todo_write', 'run_code',
    ]),
    finalize: new Set([
        'get_diagnostics', 'analyze_diagnostic_error', 'query_references',
        'verify_pdx_identifier', 'read_file', 'get_file_context', 'get_pdx_block',
        'write_file', 'edit_file', 'replace_lines', 'todo_write', 'run_code',
    ]),
};

const PLAN_STAGE_TOOLS: Partial<Record<AgentToolStage, ReadonlySet<string>>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'workspace_symbols', 'document_symbols',
        'web_search', 'web_open', 'web_find', 'mcp_call',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
    design: new Set([
        ...BUILD_STAGE_TOOLS.evidence!,
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
    validation: new Set([
        'query_rules', 'query_cwt_schema', 'query_scope',
        'parse_pdx_fragment', 'query_references', 'query_definition_by_name',
        'verify_pdx_identifier', 'get_diagnostics',
        'get_file_context', 'read_file', 'get_design_blueprint_contract',
        'write_design_blueprint', 'todo_write', 'grep',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
    write: new Set(),
    finalize: new Set([
        'get_diagnostics', 'query_references', 'verify_pdx_identifier',
        'get_pdx_block', 'get_file_context', 'read_file',
        'get_design_blueprint_contract', 'write_design_blueprint', 'todo_write',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
};

const EXPLORE_STAGE_TOOLS: Partial<Record<AgentToolStage, ReadonlySet<string>>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'workspace_symbols', 'document_symbols',
        'web_search', 'web_open', 'web_find', 'mcp_call',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
    design: new Set(),
    validation: new Set([
        'query_rules', 'query_cwt_schema', 'query_scope', 'explain_scope',
        'query_references', 'query_definition_by_name', 'verify_pdx_identifier',
        'get_diagnostics', 'get_pdx_block', 'get_file_context', 'read_file',
        'search_mod_files', 'workspace_symbols', 'explore_pdx_project',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
    write: new Set(),
    finalize: new Set([
        'query_references', 'verify_pdx_identifier', 'get_diagnostics',
        'get_pdx_block', 'get_file_context', 'read_file',
        'search_mod_files', 'workspace_symbols', 'document_symbols',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
};

const REVIEW_STAGE_TOOLS: Partial<Record<AgentToolStage, ReadonlySet<string>>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'workspace_symbols', 'document_symbols',
        'get_diagnostics', 'analyze_diagnostic_error', 'find_sprite_candidates',
        'query_localisation_index', 'mcp_call',
    ]),
    design: new Set(),
    validation: new Set([
        'query_rules', 'query_scope', 'query_references', 'query_definition_by_name',
        'verify_pdx_identifier', 'get_diagnostics', 'analyze_diagnostic_error',
        'get_pdx_block', 'get_file_context', 'read_file', 'search_mod_files',
        'document_symbols', 'workspace_symbols', 'find_sprite_candidates',
        'query_localisation_index',
    ]),
    write: new Set(),
    finalize: new Set([
        'get_diagnostics', 'analyze_diagnostic_error', 'query_references',
        'verify_pdx_identifier', 'read_file', 'get_file_context', 'get_pdx_block',
        'search_mod_files', 'find_sprite_candidates', 'query_localisation_index',
    ]),
};

/** General coding stages deliberately skip the PDX design/evidence pipeline. */
const UTILITY_STAGE_TOOLS: Partial<Record<AgentToolStage, ReadonlySet<string>>> = {
    discovery: new Set([
        'read_file', 'list_directory', 'glob_files', 'grep', 'get_file_context',
        'document_symbols', 'workspace_symbols', 'go_to_definition', 'find_references',
        'hover_symbol', 'get_completion_at', 'get_diagnostics',
        'web_search', 'web_open', 'web_find', 'mcp_call', 'todo_write', 'run_skill',
        'dispatch_agents',
    ]),
    design: new Set(),
    validation: new Set([
        'read_file', 'get_file_context', 'grep', 'document_symbols',
        'workspace_symbols', 'go_to_definition', 'find_references', 'hover_symbol',
        'get_completion_at', 'get_diagnostics', 'mcp_call', 'todo_write', 'run_skill',
        'query_blackboard', 'merge_results',
    ]),
    write: new Set([
        'read_file', 'list_directory', 'glob_files', 'grep', 'get_file_context',
        'document_symbols', 'workspace_symbols', 'go_to_definition', 'find_references',
        'hover_symbol', 'get_completion_at', 'get_diagnostics',
        'write_file', 'edit_file', 'replace_lines', 'rename_symbol',
        'run_command', 'list_processes', 'read_process',
        'write_process_stdin', 'terminate_process', 'git_ops', 'todo_write',
        'mcp_call', 'run_skill', 'run_code',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
    finalize: new Set([
        'read_file', 'get_file_context', 'grep', 'document_symbols', 'workspace_symbols',
        'go_to_definition', 'find_references', 'hover_symbol', 'get_completion_at',
        'get_diagnostics', 'write_file', 'edit_file', 'replace_lines',
        'rename_symbol',
        'run_command', 'list_processes', 'read_process', 'write_process_stdin',
        'terminate_process', 'git_ops', 'todo_write',
        'mcp_call', 'run_skill', 'run_code',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
};

const MODE_STAGE_TOOLS: Partial<Record<AgentMode, Partial<Record<AgentToolStage, ReadonlySet<string>>>>> = {
    build: BUILD_STAGE_TOOLS,
    plan: PLAN_STAGE_TOOLS,
    explore: EXPLORE_STAGE_TOOLS,
    review: REVIEW_STAGE_TOOLS,
    utility: UTILITY_STAGE_TOOLS,
};

/**
 * Cross-stage support capabilities must remain selectable after a run advances.
 * Mode/domain/authorization policy is applied before this filter, so this list
 * cannot grant a capability that the effective run policy already rejected.
 */
const CROSS_STAGE_SUPPORT_TOOLS = new Set([
    'run_skill',
    'history',
    'get_goal', 'create_goal', 'update_goal', 'set_goal_budget',
    'set_memory', 'get_memory', 'search_memory', 'save_memory', 'forget_memory', 'memory_recall_trace',
    'mcp_call',
]);
const BUILD_WRITE_ON_DEMAND_TOOLS = new Set([
    'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
]);

export function isSelectableStageSupportTool(
    toolName: string,
    mode: AgentMode,
    stage: AgentToolStage | undefined,
): boolean {
    if (CROSS_STAGE_SUPPORT_TOOLS.has(toolName) || toolName.startsWith('mcp_')) return true;
    const normalizedStage = normalizeToolStageForMode(mode, stage);
    return mode === 'build'
        && (normalizedStage === 'write' || normalizedStage === 'finalize')
        && BUILD_WRITE_ON_DEMAND_TOOLS.has(toolName);
}

/**
 * Add support schemas to the pool used by select_tools. Passing `loaded`
 * produces the smaller model-visible pool after a selection has succeeded.
 * Tools explicitly loaded via select_tools (or the runtime auto-disclosure)
 * must stay visible even when their current stage pool does not contain them;
 * otherwise a write-authorized run cannot continue after select_tools loads
 * a deferred write tool such as edit_file at the discovery stage.
 */
export function extendStageToolPoolWithSupport(
    stageTools: readonly ToolDefinition[],
    eligibleTools: readonly ToolDefinition[],
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    loaded?: ReadonlySet<string>,
): ToolDefinition[] {
    const merged = new Map(stageTools.map(tool => [tool.function.name, tool]));
    for (const tool of eligibleTools) {
        const name = tool.function.name;
        if (merged.has(name)) continue;
        if (loaded !== undefined && loaded.has(name)) {
            merged.set(name, tool);
            continue;
        }
        if (isSelectableStageSupportTool(name, mode, stage)) {
            merged.set(name, tool);
        }
    }
    return [...merged.values()];
}

/**
 * Workflow allowlists are an explicit, narrower capability contract. Their
 * read-only tools remain usable across internal stages; mutating tools still
 * have to enter through the normal stage and authorization gates.
 */
export function getWorkflowStageSupportTools(toolNames: readonly string[]): ReadonlySet<string> {
    return new Set(toolNames.filter(toolName => {
        const entry = TOOL_REGISTRY.get(toolName as import('./types').AgentToolName);
        return entry?.isReadOnly === true;
    }));
}

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

const DISCOVERY_PROGRESS_TOOLS = new Set([
    'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
    'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
    'workspace_symbols', 'document_symbols', 'dispatch_agents',
]);
const EVIDENCE_PROGRESS_TOOLS = new Set([
    'query_rules', 'query_cwt_schema', 'query_scope', 'query_override_modes',
    'search_rule_capabilities', 'query_scripted_effects', 'query_scripted_triggers',
    'write_design_blueprint', 'read_file', 'get_file_context', 'get_pdx_block',
]);
const VALIDATION_PROGRESS_TOOLS = new Set([
    'parse_pdx_fragment', 'verify_pdx_identifier', 'get_diagnostics',
    'query_definition_by_name', 'query_references', 'explain_scope', 'todo_write',
]);
const STAGED_WRITE_TOOLS = new Set([
    'write_file', 'edit_file', 'replace_lines', 'rename_symbol', 'write_localisation',
    'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset',
]);

export function initialToolStageForMode(mode: AgentMode): AgentToolStage | undefined {
    return MODE_STAGE_TOOLS[mode] ? 'discovery' : undefined;
}

/** V2 resume compatibility: Build's former design checkpoint is now evidence preparation. */
export function normalizeToolStageForMode(
    mode: AgentMode,
    stage: AgentToolStage | undefined,
): AgentToolStage | undefined {
    return mode === 'build' && stage === 'design' ? 'evidence' : stage;
}

export function filterToolDefinitionsForStage(
    tools: readonly ToolDefinition[],
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    legacyFullToolset = false,
    workflowSupportTools?: ReadonlySet<string>,
): ToolDefinition[] {
    if (legacyFullToolset || !stage) return [...tools];
    const normalizedStage = normalizeToolStageForMode(mode, stage);
    const modeStages = MODE_STAGE_TOOLS[mode];
    if (!modeStages) return [...tools];
    const allowed = normalizedStage ? modeStages[normalizedStage] : undefined;
    if (!allowed) return [];
    return tools.filter(tool =>
        tool.function.name === 'select_tools'
        || tool.function.name === 'ask_user_question'
        || workflowSupportTools?.has(tool.function.name) === true
        || allowed.has(tool.function.name)
        || (allowed.has('mcp_call') && tool.function.name.startsWith('mcp_')));
}

/**
 * Writable modes keep discovery narrow, then expose execution-critical deferred
 * schemas without depending on the model to discover the disclosure protocol.
 */
export function shouldAutoDiscloseExecutionTools(
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    authorization: import('./types').AgentAuthorization,
): boolean {
    if (authorization !== 'workspace_write' || !WRITE_EXECUTION_MODES.has(mode)) return false;
    const normalizedStage = normalizeToolStageForMode(mode, stage);
    return normalizedStage === undefined || normalizedStage === 'write' || normalizedStage === 'finalize';
}

/**
 * A workspace-write admission must not turn an internal discovery/evidence
 * checkpoint into a second user approval boundary.
 */
export function shouldContinueAuthorizedExecution(
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    authorization: import('./types').AgentAuthorization,
    executionActionObserved: boolean,
): boolean {
    if (authorization !== 'workspace_write' || !WRITE_EXECUTION_MODES.has(mode)) return false;
    const normalizedStage = normalizeToolStageForMode(mode, stage);
    return normalizedStage ? normalizedStage !== 'finalize' : !executionActionObserved;
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

const STAGE_GUIDANCE: Record<AgentToolStage, string> = {
    discovery: 'Locate the relevant project area and evidence source; do not attempt writes yet.',
    design: 'Resolve the architecture and implementation design before requesting approval.',
    evidence: 'Obtain the applicable rules, scopes, and bounded archetype evidence without revisiting product design.',
    validation: 'Prove candidate syntax, scope, identifiers, and references before writing.',
    write: 'Apply the narrowest guarded edit; host-side semantic preflight remains authoritative.',
    finalize: 'Inspect fresh diagnostics and affected references; repair any post-write failure.',
};

/** Dynamic reminder kept outside the frozen prompt so the model sees the real stage/tool surface. */
export function buildToolStageReminder(
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    tools: readonly ToolDefinition[],
    domain: AgentRuntimeDomain = defaultDomainForMode(mode),
): string {
    const normalizedStage = normalizeToolStageForMode(mode, stage);
    if (!normalizedStage) return '';
    const names = tools.map(tool => tool.function.name).sort();
    const guidance = domain === 'general'
        ? normalizedStage === 'discovery'
            ? 'Inspect the repository and identify the exact implementation and verification surface; do not write yet.'
            : normalizedStage === 'write'
                ? 'Implement the scoped change and run relevant commands through the policy engine.'
                : normalizedStage === 'design' || normalizedStage === 'evidence'
                    ? 'Map the concrete interfaces, dependencies, compatibility constraints, and tests using repository evidence.'
                    : normalizedStage === 'validation'
                        ? 'Cross-check the proposed or reviewed behavior against callers, diagnostics, tests, and current implementation.'
                        : 'Synthesize the evidence, review the diff when applicable, and report verification and remaining risks.'
        : STAGE_GUIDANCE[normalizedStage];
    return `<system-reminder>Current ${mode} tool stage: ${normalizedStage}. ${guidance} `
        + `Only these stage tools are available: ${names.join(', ')}.</system-reminder>`;
}

export function advanceToolStage(
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    toolName: string,
    result: { success: boolean; hasValidationErrors?: boolean },
): AgentToolStage | undefined {
    const normalizedStage = normalizeToolStageForMode(mode, stage);
    if (!normalizedStage) return undefined;
    if (mode === 'utility' && STAGED_WRITE_TOOLS.has(toolName)) {
        return result.success && !result.hasValidationErrors ? 'finalize' : 'write';
    }
    if (mode === 'build' && STAGED_WRITE_TOOLS.has(toolName)) {
        return result.success && !result.hasValidationErrors ? 'finalize' : 'validation';
    }
    switch (normalizedStage) {
        case 'discovery':
            if (mode === 'utility' && result.success && UTILITY_STAGE_TOOLS.discovery!.has(toolName)) return 'write';
            if (!result.success || (!DISCOVERY_PROGRESS_TOOLS.has(toolName) && !VALIDATION_PROGRESS_TOOLS.has(toolName))) return normalizedStage;
            return mode === 'build' ? 'evidence' : mode === 'plan' ? 'design' : 'validation';
        case 'design':
            if (mode === 'plan' && result.success && PLAN_STAGE_TOOLS.design!.has(toolName)) return 'validation';
            return normalizedStage;
        case 'evidence':
            return mode === 'build' && result.success && EVIDENCE_PROGRESS_TOOLS.has(toolName) ? 'validation' : normalizedStage;
        case 'validation':
            if (mode === 'plan' && result.success && PLAN_STAGE_TOOLS.validation!.has(toolName)) return 'finalize';
            if (!result.success || !VALIDATION_PROGRESS_TOOLS.has(toolName)) return normalizedStage;
            return mode === 'build' || mode === 'utility' ? 'write' : 'finalize';
        case 'write': return normalizedStage;
        case 'finalize': return result.hasValidationErrors ? 'validation' : normalizedStage;
    }
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

/** Practical loop guard above the largest configurable hard model-call budget. */
export const TOP_LEVEL_ITERATION_SAFETY_CAP = 10_000;
export const SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS = 16_384;
export const SLIM_SUB_AGENT_THINKING_CHAR_LIMIT = 24_000;
export const SLIM_SUB_AGENT_OUTPUT_BUDGET_RECOVERY_LIMIT = 1;

export function resolveRunMaxOutputTokens(options: Pick<ToolFilterOptions, 'useSlimPrompt'> = {}): number | undefined {
    return options.useSlimPrompt ? SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS : undefined;
}

export function filterToolDefinitionsForMode(
    tools: readonly ToolDefinition[],
    mode: AgentMode,
    options: ToolFilterOptions = {},
): ToolDefinition[] {
    const domain = options.domain ?? defaultDomainForMode(mode);
    let filtered = tools.filter(t => {
        const entry = TOOL_REGISTRY.get(t.function.name as import('./types').AgentToolName);
        if (!entry) return false;
        if (domain === 'general' && entry.domain === 'paradox') return false;
        
        if (options.legacyFullToolset) {
            return !['dispatch_agents', 'query_blackboard', 'merge_results'].includes(entry.name);
        }
        
        return evaluateEffectiveToolPolicy(entry.name, {
            mode,
            domain,
            isSubAgent: options.useSlimPrompt,
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
    general: { min: 8, base: 18, cap: 26 },
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
