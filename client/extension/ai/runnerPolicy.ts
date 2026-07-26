import type { AgentMode, AgentRuntimeDomain, AgentToolStage, ToolDefinition } from './types';
import { defaultDomainForMode } from './agentProfile';
import { TOOL_REGISTRY } from './tools/registry';

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
        'glob_files', 'workspace_symbols', 'document_symbols',
        'get_lsp_status', 'todo_write', 'run_skill', 'mcp_call',
    ]),
    evidence: new Set([
        'query_project_knowledge', 'query_rules', 'query_cwt_schema', 'query_scope',
        'search_rule_capabilities', 'get_file_context', 'read_file', 'get_pdx_block',
        'get_design_blueprint_contract', 'write_design_blueprint', 'todo_write',
        'glob_files', 'grep', 'workspace_symbols', 'document_symbols',
    ]),
    validation: new Set([
        'query_rules', 'query_cwt_schema', 'query_scope', 'explain_scope',
        'parse_pdx_fragment', 'query_references', 'query_definition_by_name',
        'verify_pdx_identifier', 'get_diagnostics', 'get_completion_at', 'get_pdx_block',
        'get_file_context', 'read_file', 'analyze_diagnostic_error', 'todo_write',
    ]),
    write: new Set([
        'query_rules', 'query_scope', 'parse_pdx_fragment', 'verify_pdx_identifier',
        'get_diagnostics', 'read_file', 'get_file_context', 'get_pdx_block',
        'write_file', 'edit_file', 'replace_lines',
        'write_localisation', 'todo_write',
    ]),
    finalize: new Set([
        'get_diagnostics', 'analyze_diagnostic_error', 'query_references',
        'verify_pdx_identifier', 'read_file', 'get_file_context', 'get_pdx_block',
        'write_file', 'edit_file', 'replace_lines', 'todo_write',
    ]),
};

const PLAN_STAGE_TOOLS: Partial<Record<AgentToolStage, ReadonlySet<string>>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'glob_files', 'workspace_symbols', 'document_symbols', 'get_lsp_status',
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
        'write_design_blueprint', 'todo_write', 'grep', 'document_symbols',
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
        'glob_files', 'workspace_symbols', 'document_symbols', 'get_lsp_status',
        'web_search', 'web_open', 'web_find', 'mcp_call',
        'dispatch_agents', 'query_blackboard', 'merge_results',
    ]),
    design: new Set(),
    validation: new Set([
        'query_rules', 'query_cwt_schema', 'query_scope', 'explain_scope',
        'query_references', 'query_definition_by_name', 'verify_pdx_identifier',
        'get_diagnostics', 'get_pdx_block', 'get_file_context', 'read_file',
        'search_mod_files', 'workspace_symbols', 'document_symbols', 'explore_pdx_project',
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
        'glob_files', 'workspace_symbols', 'document_symbols', 'get_lsp_status',
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
        'document_symbols', 'workspace_symbols', 'get_diagnostics', 'get_lsp_status',
        'query_workspace_index', 'query_project_profile', 'web_search', 'web_open',
        'web_find', 'todo_write', 'run_skill',
    ]),
    design: new Set(),
    validation: new Set(),
    write: new Set([
        'read_file', 'list_directory', 'glob_files', 'grep', 'get_file_context',
        'document_symbols', 'workspace_symbols', 'get_diagnostics',
        'write_file', 'edit_file', 'replace_lines',
        'run_command', 'list_processes', 'read_process',
        'write_process_stdin', 'terminate_process', 'git_ops', 'todo_write',
    ]),
    finalize: new Set([
        'read_file', 'get_file_context', 'grep', 'document_symbols', 'workspace_symbols',
        'get_diagnostics', 'write_file', 'edit_file', 'replace_lines',
        'run_command', 'list_processes', 'read_process', 'write_process_stdin',
        'terminate_process', 'git_ops', 'todo_write',
    ]),
};

const MODE_STAGE_TOOLS: Partial<Record<AgentMode, Partial<Record<AgentToolStage, ReadonlySet<string>>>>> = {
    build: BUILD_STAGE_TOOLS,
    plan: PLAN_STAGE_TOOLS,
    explore: EXPLORE_STAGE_TOOLS,
    review: REVIEW_STAGE_TOOLS,
    utility: UTILITY_STAGE_TOOLS,
};

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
    'write_file', 'edit_file', 'replace_lines', 'write_localisation',
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
): ToolDefinition[] {
    if (legacyFullToolset || !stage) return [...tools];
    const normalizedStage = normalizeToolStageForMode(mode, stage);
    const modeStages = MODE_STAGE_TOOLS[mode];
    if (!modeStages) return [...tools];
    const allowed = normalizedStage ? modeStages[normalizedStage] : undefined;
    if (!allowed) return [];
    return tools.filter(tool =>
        allowed.has(tool.function.name)
        || (allowed.has('mcp_call') && tool.function.name.startsWith('mcp_')));
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
        
        return entry.allowedModes.has(mode);
    });

    if (options.useSlimPrompt) {
        filtered = filtered.filter(t => {
            const entry = TOOL_REGISTRY.get(t.function.name as import('./types').AgentToolName);
            return entry?.allowSubAgent === true || (mode === 'utility' && entry?.name === 'run_command');
        });
    }

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
