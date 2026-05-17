import type { AgentMode, AgentToolName, ToolDefinition } from './types';

export interface ToolFilterOptions {
    useSlimPrompt?: boolean;
    excludeTools?: string[];
    legacyFullToolset?: boolean;
}

export interface IterationLimitOptions {
    mode: AgentMode;
    baseContextLimit: number;
    bypassSandbox?: boolean;
    override?: number;
}

const ORCHESTRATION_TOOLS: AgentToolName[] = ['dispatch_agents', 'query_blackboard', 'merge_results'];
const MEDIA_TOOLS: AgentToolName[] = [
    'mmx_generate_image',
    'mmx_generate_video',
    'mmx_generate_music',
    'mmx_generate_speech',
    'convert_image_to_dds',
    'convert_audio',
    'deploy_mod_asset',
];
const MCP_TOOLS: AgentToolName[] = ['mcp_call'];

const BASE_READ_TOOLS: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_references',
    'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory', 'glob_files',
    'lsp_operation',
    'get_diagnostics', 'query_definition', 'query_definition_by_name',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
    'get_pdx_block', 'get_ignored_diagnostics',
];

const EDIT_TOOLS: AgentToolName[] = [
    'write_file', 'multi_replace_file_content', 'replace_lines', 'apply_patch',
    'edit_pdx_block', 'write_localisation', 'write_design_blueprint',
    'remove_ignored_diagnostic',
];

const MEMORY_TOOLS: AgentToolName[] = ['todo_write', 'set_memory', 'get_memory', 'search_memory', 'save_memory'];
const NETWORK_TOOLS: AgentToolName[] = ['web_fetch', 'search_web', 'codesearch'];
const UTILITY_TOOLS: AgentToolName[] = ['run_command', 'git_ops', 'analyze_diagnostic_error'];

const PLAN_TOOLS = new Set<AgentToolName>([
    ...BASE_READ_TOOLS,
    ...NETWORK_TOOLS,
    'todo_write',
    'write_design_blueprint',
    'set_memory', 'get_memory', 'search_memory',
    'git_ops',
]);

const EXPLORE_TOOLS = new Set<AgentToolName>([
    ...BASE_READ_TOOLS,
    ...NETWORK_TOOLS,
    'git_ops',
]);

const REVIEW_TOOLS = new Set<AgentToolName>([
    ...BASE_READ_TOOLS,
    ...NETWORK_TOOLS,
    'git_ops',
]);

const BUILD_TOOLS = new Set<AgentToolName>([
    ...BASE_READ_TOOLS,
    ...EDIT_TOOLS,
    ...MEMORY_TOOLS,
    ...NETWORK_TOOLS,
    ...UTILITY_TOOLS,
]);

const LOC_TOOLS = new Set<AgentToolName>([
    'read_file', 'write_file', 'multi_replace_file_content', 'replace_lines', 'apply_patch',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep',
    'workspace_symbols', 'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_diagnostics',
    'query_types', 'query_rules', 'query_references',
    'todo_write', 'write_localisation', 'git_ops',
]);

const ORCHESTRATOR_TOOLS = new Set<AgentToolName>([
    ...BASE_READ_TOOLS,
    ...NETWORK_TOOLS,
    'set_memory', 'get_memory', 'search_memory', 'todo_write',
    'dispatch_agents', 'query_blackboard', 'merge_results',
    'git_ops',
]);

const UTILITY_EXCLUDED_TOOLS = new Set<string>(ORCHESTRATION_TOOLS);
const GENERAL_EXCLUDED_TOOLS = new Set<string>(['todo_write', ...ORCHESTRATION_TOOLS]);
const BUILD_EXCLUDED_BY_DEFAULT = new Set<string>([
    ...ORCHESTRATION_TOOLS,
    ...MEDIA_TOOLS,
    ...MCP_TOOLS,
]);

function namesForMode(mode: AgentMode): Set<string> | null {
    switch (mode) {
        case 'plan': return PLAN_TOOLS;
        case 'explore': return EXPLORE_TOOLS;
        case 'review':
        case 'script_reviewer':
            return REVIEW_TOOLS;
        case 'loc_translator':
        case 'loc_writer':
            return LOC_TOOLS;
        case 'orchestrator':
            return ORCHESTRATOR_TOOLS;
        case 'build':
        case 'gui_expert':
            return BUILD_TOOLS;
        case 'general':
        case 'utility':
            return null;
    }
}

export function filterToolDefinitionsForMode(
    tools: readonly ToolDefinition[],
    mode: AgentMode,
    options: ToolFilterOptions = {},
): ToolDefinition[] {
    let filtered: ToolDefinition[];
    if (options.legacyFullToolset) {
        filtered = tools.filter(t => !(ORCHESTRATION_TOOLS as readonly string[]).includes(t.function.name));
    } else {
        const names = namesForMode(mode);
        if (names) {
            filtered = tools.filter(t => names.has(t.function.name));
        } else if (mode === 'general') {
            filtered = tools.filter(t => !GENERAL_EXCLUDED_TOOLS.has(t.function.name));
        } else {
            filtered = tools.filter(t => !UTILITY_EXCLUDED_TOOLS.has(t.function.name));
        }

        if (mode === 'build' || mode === 'gui_expert') {
            filtered = filtered.filter(t => !BUILD_EXCLUDED_BY_DEFAULT.has(t.function.name));
        }
    }

    if (options.useSlimPrompt) {
        filtered = filtered.filter(t => t.function.name !== 'git_ops');
    }

    if (options.excludeTools && options.excludeTools.length > 0) {
        const excluded = new Set(options.excludeTools);
        filtered = filtered.filter(t => !excluded.has(t.function.name));
    }

    return filtered;
}

const MODE_ITERATION_LIMITS: Record<AgentMode, { min: number; base: number; cap: number }> = {
    build: { min: 20, base: 40, cap: 55 },
    plan: { min: 10, base: 18, cap: 25 },
    explore: { min: 8, base: 16, cap: 24 },
    general: { min: 8, base: 18, cap: 25 },
    utility: { min: 15, base: 30, cap: 45 },
    review: { min: 8, base: 15, cap: 22 },
    gui_expert: { min: 18, base: 30, cap: 45 },
    script_reviewer: { min: 8, base: 15, cap: 22 },
    loc_translator: { min: 10, base: 20, cap: 30 },
    loc_writer: { min: 10, base: 20, cap: 30 },
    orchestrator: { min: 8, base: 18, cap: 28 },
};

export function resolveMaxToolIterations(options: IterationLimitOptions): number {
    if (options.bypassSandbox) return 10000;
    if (options.override !== undefined && Number.isFinite(options.override)) {
        return Math.max(1, Math.min(1000, Math.floor(options.override)));
    }

    const limits = MODE_ITERATION_LIMITS[options.mode] ?? MODE_ITERATION_LIMITS.build;
    const scale = Math.max(0.8, Math.min(1.25, options.baseContextLimit / 128000));
    const scaled = Math.floor(limits.base * scale);
    return Math.min(limits.cap, Math.max(limits.min, scaled));
}
