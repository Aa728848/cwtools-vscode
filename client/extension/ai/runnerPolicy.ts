import type { AgentMode, AgentToolStage, ToolDefinition } from './types';
import { TOOL_REGISTRY } from './tools/registry';

export interface ToolFilterOptions {
    useSlimPrompt?: boolean;
    excludeTools?: string[];
    legacyFullToolset?: boolean;
}

export type { AgentToolStage } from './types';

const BUILD_STAGE_TOOLS: Record<AgentToolStage, ReadonlySet<string>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'glob_files', 'workspace_symbols', 'document_symbols',
        'get_lsp_status', 'todo_write', 'run_skill',
    ]),
    design: new Set([
        'query_project_knowledge', 'explore_pdx_project',
        'query_rules', 'query_cwt_schema', 'query_scope', 'query_override_modes',
        'search_rule_capabilities', 'get_file_context', 'read_file', 'get_pdx_block',
        'query_scripted_effects', 'query_scripted_triggers', 'get_design_blueprint_contract', 'write_design_blueprint', 'todo_write',
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
        'write_file', 'edit_file', 'replace_lines', 'edit_pdx_block',
        'write_localisation', 'todo_write',
    ]),
    finalize: new Set([
        'get_diagnostics', 'analyze_diagnostic_error', 'query_references',
        'verify_pdx_identifier', 'read_file', 'get_file_context', 'get_pdx_block',
        'write_file', 'edit_file', 'replace_lines', 'edit_pdx_block', 'todo_write',
    ]),
};

const PLAN_STAGE_TOOLS: Record<AgentToolStage, ReadonlySet<string>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'glob_files', 'workspace_symbols', 'document_symbols', 'get_lsp_status',
        'web_search', 'web_open', 'web_find', 'todo_write',
    ]),
    design: BUILD_STAGE_TOOLS.design,
    validation: new Set([
        'query_rules', 'query_cwt_schema', 'query_scope', 'explain_scope',
        'parse_pdx_fragment', 'query_references', 'query_definition_by_name',
        'verify_pdx_identifier', 'get_diagnostics', 'get_pdx_block',
        'get_file_context', 'read_file', 'get_design_blueprint_contract',
        'write_design_blueprint', 'todo_write',
    ]),
    write: new Set(),
    finalize: new Set([
        'get_diagnostics', 'query_references', 'verify_pdx_identifier',
        'get_pdx_block', 'get_file_context', 'read_file',
        'get_design_blueprint_contract', 'write_design_blueprint', 'todo_write',
    ]),
};

const EXPLORE_STAGE_TOOLS: Record<AgentToolStage, ReadonlySet<string>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'glob_files', 'workspace_symbols', 'document_symbols', 'get_lsp_status',
        'web_search', 'web_open', 'web_find',
    ]),
    design: new Set(),
    validation: new Set([
        'query_rules', 'query_cwt_schema', 'query_scope', 'explain_scope',
        'query_references', 'query_definition_by_name', 'verify_pdx_identifier',
        'get_diagnostics', 'get_pdx_block', 'get_file_context', 'read_file',
        'search_mod_files', 'workspace_symbols', 'document_symbols', 'explore_pdx_project',
    ]),
    write: new Set(),
    finalize: new Set([
        'query_references', 'verify_pdx_identifier', 'get_diagnostics',
        'get_pdx_block', 'get_file_context', 'read_file',
        'search_mod_files', 'workspace_symbols', 'document_symbols',
    ]),
};

const REVIEW_STAGE_TOOLS: Record<AgentToolStage, ReadonlySet<string>> = {
    discovery: new Set([
        'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
        'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
        'glob_files', 'workspace_symbols', 'document_symbols', 'get_lsp_status',
        'get_diagnostics', 'analyze_diagnostic_error', 'find_sprite_candidates',
        'query_localisation_index',
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

const MODE_STAGE_TOOLS: Partial<Record<AgentMode, Record<AgentToolStage, ReadonlySet<string>>>> = {
    build: BUILD_STAGE_TOOLS,
    plan: PLAN_STAGE_TOOLS,
    explore: EXPLORE_STAGE_TOOLS,
    review: REVIEW_STAGE_TOOLS,
};

const DISCOVERY_PROGRESS_TOOLS = new Set([
    'query_project_profile', 'query_project_knowledge', 'explore_pdx_project',
    'query_workspace_index', 'get_file_context', 'read_file', 'search_mod_files',
    'workspace_symbols', 'document_symbols',
]);
const DESIGN_PROGRESS_TOOLS = new Set([
    'query_rules', 'query_cwt_schema', 'query_scope', 'query_override_modes',
    'search_rule_capabilities', 'query_scripted_effects', 'query_scripted_triggers',
    'write_design_blueprint',
]);
const VALIDATION_PROGRESS_TOOLS = new Set([
    'parse_pdx_fragment', 'verify_pdx_identifier', 'get_diagnostics',
    'query_definition_by_name', 'query_references', 'explain_scope',
]);
const STAGED_WRITE_TOOLS = new Set([
    'write_file', 'edit_file', 'replace_lines', 'edit_pdx_block', 'write_localisation',
]);

export function initialToolStageForMode(mode: AgentMode): AgentToolStage | undefined {
    return MODE_STAGE_TOOLS[mode] ? 'discovery' : undefined;
}

export function filterToolDefinitionsForStage(
    tools: readonly ToolDefinition[],
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    legacyFullToolset = false,
): ToolDefinition[] {
    if (legacyFullToolset || !stage) return [...tools];
    const allowed = MODE_STAGE_TOOLS[mode]?.[stage];
    if (!allowed) return [...tools];
    return tools.filter(tool => allowed.has(tool.function.name));
}

const STAGE_GUIDANCE: Record<AgentToolStage, string> = {
    discovery: 'Locate the relevant project area and evidence source; do not attempt writes yet.',
    design: 'Obtain the applicable rules, scopes, and bounded archetype evidence.',
    validation: 'Prove candidate syntax, scope, identifiers, and references before writing.',
    write: 'Apply the narrowest guarded edit; host-side semantic preflight remains authoritative.',
    finalize: 'Inspect fresh diagnostics and affected references; repair any post-write failure.',
};

/** Dynamic reminder kept outside the frozen prompt so the model sees the real stage/tool surface. */
export function buildToolStageReminder(
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    tools: readonly ToolDefinition[],
): string {
    if (!stage) return '';
    const names = tools.map(tool => tool.function.name).sort();
    return `<system-reminder>Current ${mode} tool stage: ${stage}. ${STAGE_GUIDANCE[stage]} `
        + `Only these stage tools are available: ${names.join(', ')}.</system-reminder>`;
}

export function advanceToolStage(
    mode: AgentMode,
    stage: AgentToolStage | undefined,
    toolName: string,
    result: { success: boolean; hasValidationErrors?: boolean },
): AgentToolStage | undefined {
    if (!stage) return undefined;
    if (mode === 'build' && STAGED_WRITE_TOOLS.has(toolName)) {
        return result.success && !result.hasValidationErrors ? 'finalize' : 'validation';
    }
    switch (stage) {
        case 'discovery':
            if (!result.success || (!DISCOVERY_PROGRESS_TOOLS.has(toolName) && !VALIDATION_PROGRESS_TOOLS.has(toolName))) return stage;
            return mode === 'build' || mode === 'plan' ? 'design' : 'validation';
        case 'design': return result.success && DESIGN_PROGRESS_TOOLS.has(toolName) ? 'validation' : stage;
        case 'validation':
            if (!result.success || !VALIDATION_PROGRESS_TOOLS.has(toolName)) return stage;
            return mode === 'build' ? 'write' : 'finalize';
        case 'write': return stage;
        case 'finalize': return result.hasValidationErrors ? 'validation' : stage;
    }
}

export interface IterationLimitOptions {
    mode: AgentMode;
    baseContextLimit: number;
    bypassSandbox?: boolean;
    override?: number;
    /** When true, apply MODE_ITERATION_LIMITS caps. Top-level agents run uncapped. */
    isSubAgent?: boolean;
}

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
    let filtered = tools.filter(t => {
        const entry = TOOL_REGISTRY.get(t.function.name as import('./types').AgentToolName);
        if (!entry) return false;
        
        if (options.legacyFullToolset) {
            return !['dispatch_agents', 'query_blackboard', 'merge_results'].includes(entry.name);
        }
        
        return entry.allowedModes.has(mode);
    });

    if (options.useSlimPrompt) {
        filtered = filtered.filter(t => {
            const entry = TOOL_REGISTRY.get(t.function.name as import('./types').AgentToolName);
            return entry?.allowSubAgent === true;
        });
    }

    if (options.excludeTools && options.excludeTools.length > 0) {
        const excluded = new Set(options.excludeTools);
        filtered = filtered.filter(t => !excluded.has(t.function.name));
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

    // Permission/sandbox bypasses never disable resource safety. Top-level
    // Agents normally stop at the configurable soft runtime budget; this is
    // the independent emergency ceiling if approval/accounting fails.
    if (!options.isSubAgent) return Math.min(256, limits.cap * 2);

    const scale = Math.max(0.8, Math.min(1.25, options.baseContextLimit / 128000));
    const scaled = Math.floor(limits.base * scale);
    return Math.min(limits.cap, Math.max(limits.min, scaled));
}
