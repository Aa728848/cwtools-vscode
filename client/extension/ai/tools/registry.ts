import type { ToolDefinition, AgentMode } from '../types';
import { DESIGN_BLUEPRINT_DISCLOSED_TOOL, TOOL_DEFINITIONS as SCHEMA_DEFINITIONS } from './definitions';
import { analyzeSchema, flattenSchema } from './schemaFlatten';

export type AgentToolName =
    | 'ask_user_question' | 'select_tools' | 'manage_goal'
    | 'query_scope' | 'query_types' | 'query_rules' | 'query_cwt_schema' | 'query_override_modes' | 'search_rule_capabilities' | 'explain_scope' | 'parse_pdx_fragment' | 'remove_ignored_diagnostic'
    | 'query_localisation_index' | 'query_workspace_index' | 'explore_pdx_project' | 'query_inline_instantiation' | 'analyze_pdx_flow' | 'compare_definition_with_vanilla' | 'query_project_profile' | 'query_project_knowledge' | 'query_interface_knowledge' | 'query_targeting_weight' | 'run_skill' | 'get_ignored_diagnostics' | 'get_pdx_block'
    | 'find_sprite_candidates' | 'find_sound_candidates'
    | 'grep' | 'get_completion_at' | 'document_symbols' | 'workspace_symbols'
    | 'go_to_definition' | 'find_references' | 'hover_symbol' | 'rename_symbol'
    | 'verify_pdx_identifier' | 'find_scope_bridge' | 'extract_archetype_slots' | 'instantiate_archetype' | 'todo_write' | 'read_file' | 'write_file' | 'edit_file'
    | 'replace_lines' | 'typed_pdx_write' | 'candidate_transaction' | 'list_directory' | 'get_lsp_status' | 'get_diagnostics' | 'analyze_diagnostic_error'
    | 'glob_files' | 'web_search' | 'web_open' | 'web_find'
    | 'query_scripted_effects'
    | 'query_scripted_triggers' | 'query_enums' | 'get_entity_info'
    | 'query_static_modifiers' | 'query_variables' | 'set_memory'
    | 'history' | 'save_memory' | 'forget_memory' | 'memory_recall_trace'
    | 'convert_image_to_dds' | 'convert_audio' | 'deploy_mod_asset' | 'mcp_call'
    | 'write_localisation' | 'write_design_blueprint' | 'save_skill' | 'git_ops'
    | 'enter_plan_mode' | 'exit_plan_mode'
    | 'get_ide_context' | 'open_in_visual_editor'
    | 'query_shader_symbol' | 'query_shader_compile_unit' | 'query_shader_platform_variants' | 'query_shader_callers'
    | 'explain_shader_reachability' | 'validate_shader' | 'compare_shader_with_vanilla';

export type ToolEffect =
    | 'none'
    | 'memory'
    | 'workspace_read'
    | 'workspace_write'
    | 'network'
    | 'git'
    | 'media'
    | 'mcp';

export type ToolConcurrencyClass =
    | 'parallel'
    | 'lsp-limited'
    | 'network-limited'
    | 'per-file-write'
    | 'global-exclusive'
    | 'interactive';

export type ToolDomain = 'shared' | 'paradox';
export type ToolDisclosure = 'always' | 'deferred';
export type ToolIdempotency = 'none' | 'read' | 'deterministic' | 'effect-keyed';

export interface ToolRegistryEntry {
    name: AgentToolName;
    schema: ToolDefinition;
    isWrite: boolean;
    isReadOnly: boolean;
    allowSubAgent: boolean;
    allowedModes: Set<AgentMode>;
    effect: ToolEffect;
    riskLevel: 0 | 1 | 2 | 3;
    concurrencyClass: ToolConcurrencyClass;
    /** Capability domain. Every tool is classified explicitly and exhaustively. */
    domain: ToolDomain;
    mutating?: boolean;
    stormExempt?: boolean;
    noFlatten?: boolean;
    flatSchema?: ToolDefinition;
    /** Full schema substituted only after this deferred capability is selected. */
    disclosedSchema?: ToolDefinition;
    disclosure: ToolDisclosure;
    group?: string;
    providerCapability?: string;
    estimatedSchemaTokens: number;
    idempotency: ToolIdempotency;
}

export const TOOL_REGISTRY = new Map<AgentToolName, ToolRegistryEntry>();

/**
 * Explicit classification is intentionally exhaustive.
 */
const TOOL_DOMAINS = {
    ask_user_question: 'shared',
    select_tools: 'shared',
    manage_goal: 'shared',
    query_scope: 'paradox',
    query_types: 'paradox',
    query_rules: 'paradox',
    query_cwt_schema: 'paradox',
    query_override_modes: 'paradox',
    search_rule_capabilities: 'paradox',
    explain_scope: 'paradox',
    parse_pdx_fragment: 'paradox',
    remove_ignored_diagnostic: 'paradox',
    query_localisation_index: 'paradox',
    query_workspace_index: 'paradox',
    explore_pdx_project: 'paradox',
    query_inline_instantiation: 'paradox',
    analyze_pdx_flow: 'paradox',
    compare_definition_with_vanilla: 'paradox',
    query_project_profile: 'paradox',
    query_project_knowledge: 'paradox',
    query_interface_knowledge: 'paradox',
    query_targeting_weight: 'paradox',
    run_skill: 'shared',
    get_ignored_diagnostics: 'paradox',
    get_pdx_block: 'paradox',
    find_sprite_candidates: 'paradox',
    find_sound_candidates: 'paradox',
    grep: 'shared',
    get_completion_at: 'shared',
    document_symbols: 'shared',
    workspace_symbols: 'shared',
    go_to_definition: 'shared',
    find_references: 'shared',
    hover_symbol: 'shared',
    rename_symbol: 'shared',
    verify_pdx_identifier: 'paradox',
    find_scope_bridge: 'paradox',
    extract_archetype_slots: 'paradox',
    instantiate_archetype: 'paradox',
    todo_write: 'shared',
    read_file: 'shared',
    write_file: 'shared',
    edit_file: 'shared',
    replace_lines: 'shared',
    typed_pdx_write: 'paradox',
    candidate_transaction: 'paradox',
    list_directory: 'shared',
    get_lsp_status: 'paradox',
    get_diagnostics: 'shared',
    analyze_diagnostic_error: 'paradox',
    glob_files: 'shared',
    web_search: 'shared',
    web_open: 'shared',
    web_find: 'shared',
    query_scripted_effects: 'paradox',
    query_scripted_triggers: 'paradox',
    query_enums: 'paradox',
    get_entity_info: 'paradox',
    query_static_modifiers: 'paradox',
    query_variables: 'paradox',
    set_memory: 'shared',
    history: 'shared',
    save_memory: 'shared',
    forget_memory: 'shared',
    memory_recall_trace: 'shared',
    convert_image_to_dds: 'paradox',
    convert_audio: 'paradox',
    deploy_mod_asset: 'paradox',
    mcp_call: 'shared',
    write_localisation: 'paradox',
    write_design_blueprint: 'paradox',
    save_skill: 'shared',
    git_ops: 'shared',
    enter_plan_mode: 'shared',
    exit_plan_mode: 'shared',
    get_ide_context: 'paradox',
    open_in_visual_editor: 'paradox',
    query_shader_symbol: 'paradox',
    query_shader_compile_unit: 'paradox',
    query_shader_platform_variants: 'paradox',
    query_shader_callers: 'paradox',
    explain_shader_reachability: 'paradox',
    validate_shader: 'paradox',
    compare_shader_with_vanilla: 'paradox',
} satisfies Record<AgentToolName, ToolDomain>;

// Categories to help assign modes
const BASE_READ: AgentToolName[] = [
    'select_tools', 'manage_goal',
    'query_scope', 'query_types', 'query_rules', 'query_cwt_schema', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'query_localisation_index', 'query_workspace_index', 'explore_pdx_project', 'query_inline_instantiation', 'analyze_pdx_flow', 'compare_definition_with_vanilla',
    'query_project_profile', 'query_project_knowledge', 'query_interface_knowledge', 'query_targeting_weight', 'run_skill', 'history', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'go_to_definition', 'find_references', 'hover_symbol',
    'verify_pdx_identifier', 'find_scope_bridge', 'extract_archetype_slots', 'instantiate_archetype', 'read_file', 'list_directory', 'glob_files',
    'get_lsp_status', 'get_diagnostics', 'web_find',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables', 'get_pdx_block', 'get_ignored_diagnostics',
    'query_shader_symbol', 'query_shader_compile_unit', 'query_shader_platform_variants', 'query_shader_callers',
    'explain_shader_reachability', 'validate_shader', 'compare_shader_with_vanilla',
    'get_ide_context', 'open_in_visual_editor'
];
const EDIT: AgentToolName[] = [
    'write_file', 'edit_file', 'replace_lines', 'typed_pdx_write', 'candidate_transaction', 'rename_symbol',
    'write_localisation', 'write_design_blueprint', 'save_skill', 'remove_ignored_diagnostic'
];
const MEMORY: AgentToolName[] = ['todo_write', 'manage_goal', 'set_memory', 'save_memory', 'forget_memory', 'memory_recall_trace'];
const NETWORK: AgentToolName[] = ['web_search', 'web_open'];
const UTILITY: AgentToolName[] = ['git_ops', 'analyze_diagnostic_error'];
const MEDIA: AgentToolName[] = ['convert_image_to_dds', 'convert_audio', 'deploy_mod_asset'];
const _MCP: AgentToolName[] = ['mcp_call'];
// Mode control: the Agent's own escape hatch into/out of Plan mode. Available
// wherever ordinary execution is, since that is exactly when it is needed.
const MODE_CONTROL: AgentToolName[] = ['enter_plan_mode', 'exit_plan_mode'];
const INTERACTION: AgentToolName[] = ['ask_user_question'];

const GENERIC_FILE_WRITE_TOOLS = new Set<AgentToolName>([
    'write_file', 'edit_file', 'replace_lines', 'rename_symbol', 'save_skill',
]);
const PDX_WRITE_TOOLS = new Set<AgentToolName>([
    'typed_pdx_write', 'candidate_transaction', 'write_localisation',
    'write_design_blueprint', 'remove_ignored_diagnostic',
]);
const SHADER_TOOLS = new Set<AgentToolName>([
    'query_shader_symbol', 'query_shader_compile_unit', 'query_shader_platform_variants',
    'query_shader_callers', 'explain_shader_reachability', 'validate_shader',
    'compare_shader_with_vanilla',
]);
const PDX_PROJECT_TOOLS = new Set<AgentToolName>([
    'query_project_profile', 'query_project_knowledge', 'query_interface_knowledge',
    'query_workspace_index', 'query_localisation_index', 'explore_pdx_project',
    'query_inline_instantiation', 'analyze_pdx_flow', 'compare_definition_with_vanilla',
    'get_ide_context', 'open_in_visual_editor',
]);
const PDX_RULE_TOOLS = new Set<AgentToolName>([
    'query_scope', 'query_rules', 'query_cwt_schema', 'query_override_modes',
    'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment',
    'verify_pdx_identifier', 'find_scope_bridge',
]);
const PDX_CATALOG_TOOLS = new Set<AgentToolName>([
    'query_types', 'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables',
]);
const NAVIGATION_TOOLS = new Set<AgentToolName>([
    'read_file', 'list_directory', 'glob_files', 'grep', 'get_pdx_block',
    'get_completion_at', 'document_symbols', 'workspace_symbols',
    'go_to_definition', 'find_references', 'hover_symbol',
]);
const DIAGNOSTIC_TOOLS = new Set<AgentToolName>([
    'get_lsp_status', 'get_diagnostics', 'analyze_diagnostic_error',
    'get_ignored_diagnostics', 'remove_ignored_diagnostic',
]);
const ASSET_TOOLS = new Set<AgentToolName>([
    'find_sprite_candidates', 'find_sound_candidates',
]);
const ALWAYS_DISCLOSED_TOOLS = new Set<AgentToolName>([
    'ask_user_question', 'todo_write', 'read_file', 'grep', 'manage_goal', 'select_tools',
]);
const WRITE_TOOLS_SET = new Set<string>([...EDIT, 'deploy_mod_asset', 'git_ops']);
const SUB_AGENT_EXCLUDES_SET = new Set<string>([
    'ask_user_question',
    'web_search', 'web_open', 'web_find',
    'git_ops', 'save_skill',
    'rename_symbol',
    'typed_pdx_write', 'candidate_transaction',
    ...MEDIA,
]);
const FILE_SCOPED_WRITE_TOOLS_SET = new Set<string>([
    'write_file',
    'edit_file',
    'replace_lines',
    'typed_pdx_write',
    'candidate_transaction',
    'write_localisation',
    'write_design_blueprint',
    'deploy_mod_asset',
    'save_skill',
]);

// Mutating tools: 改变工作区 / 记忆状态的工具。doom-loop 检测见到 mutating 成功
// 后会清空对应文件的 pairFrequency 窗口,避免把 verify-after-write 误判为重复。
const MUTATING_TOOLS_SET = new Set<string>([
    ...EDIT,
    'deploy_mod_asset',
    'git_ops',
    'set_memory',
    'save_memory',
    'forget_memory',
    'manage_goal',
]);

// Only live status polling is exempt. Ordinary reads stay behind
// the result-hash loop detector, which already permits calls whose output changes.
const STORM_EXEMPT_TOOLS_SET = new Set<string>([
    'get_lsp_status',
]);

const PLAN_MODES = new Set([...BASE_READ, ...INTERACTION, ...NETWORK, ..._MCP, ...MODE_CONTROL, 'todo_write', 'write_file', 'edit_file', 'replace_lines', 'typed_pdx_write', 'candidate_transaction', 'write_design_blueprint', 'save_skill', 'set_memory', 'git_ops']);
const EXPLORE_MODES = new Set([...BASE_READ, ...INTERACTION, ...NETWORK, ..._MCP, ...MODE_CONTROL, 'git_ops', 'save_skill']);
const REVIEW_MODES = new Set([...BASE_READ, ...INTERACTION, ...NETWORK, ..._MCP, 'git_ops', 'save_skill']);
const BUILD_MODES = new Set([...BASE_READ, ...INTERACTION, ...EDIT, ...MEMORY, ...NETWORK, ...UTILITY, ...MEDIA, ..._MCP, ...MODE_CONTROL]);
const LOC_MODES = new Set([
    'select_tools', 'read_file', 'write_file',
    'list_directory', 'glob_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep',
    'workspace_symbols', 'document_symbols', 'go_to_definition', 'find_references', 'verify_pdx_identifier', 'get_lsp_status', 'get_diagnostics',
    'query_types', 'query_rules', 'query_cwt_schema', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'todo_write', 'write_localisation', 'git_ops',
    // Localisation runs must be able to manage the candidate transaction that
    // `write_localisation` stages into; otherwise their writes can only land in
    // an overlay they have no way to validate or commit.
    'candidate_transaction',
    'analyze_diagnostic_error', 'save_skill', ...INTERACTION
]);

for (const schema of SCHEMA_DEFINITIONS) {
    const name = schema.function.name as AgentToolName;
    const allowed = new Set<AgentMode>();
    if (PLAN_MODES.has(name)) allowed.add('plan');
    if (EXPLORE_MODES.has(name)) allowed.add('explore');
    if (REVIEW_MODES.has(name)) { allowed.add('review'); allowed.add('script_reviewer'); }
    if (LOC_MODES.has(name)) { allowed.add('loc_translator'); allowed.add('loc_writer'); }
    if (BUILD_MODES.has(name)) { allowed.add('build'); allowed.add('gui_expert'); }

    // 动态推演 effect、riskLevel 与 concurrencyClass 以维护单一事实源
    let effect: ToolEffect = 'none';
    let riskLevel: 0 | 1 | 2 | 3 = 0;
    let concurrencyClass: ToolConcurrencyClass = 'parallel';

    if (name === 'manage_goal') {
        effect = 'memory';
        riskLevel = 0;
        concurrencyClass = 'parallel';
    } else if (BASE_READ.includes(name)) {
        effect = 'workspace_read';
        riskLevel = 0;
        if (['document_symbols', 'workspace_symbols', 'get_lsp_status', 'get_diagnostics', 'go_to_definition', 'find_references', 'explore_pdx_project',
            'query_shader_symbol', 'query_shader_compile_unit', 'query_shader_platform_variants', 'query_shader_callers', 'explain_shader_reachability', 'validate_shader', 'compare_shader_with_vanilla', 'query_inline_instantiation', 'analyze_pdx_flow', 'compare_definition_with_vanilla'].includes(name)) {
            concurrencyClass = 'lsp-limited';
        } else {
            concurrencyClass = 'parallel';
        }
    } else if (name === 'rename_symbol') {
        effect = 'workspace_write';
        riskLevel = 2;
        concurrencyClass = 'global-exclusive';
    } else if (EDIT.includes(name)) {
        effect = 'workspace_write';
        riskLevel = 2;
        concurrencyClass = 'per-file-write';
    } else if (MEMORY.includes(name)) {
        effect = 'memory';
        riskLevel = 0;
        concurrencyClass = 'parallel';
    } else if (NETWORK.includes(name)) {
        effect = 'network';
        riskLevel = 1;
        concurrencyClass = 'network-limited';
    } else if (name === 'git_ops') {
        effect = 'git';
        riskLevel = 2;
        concurrencyClass = 'global-exclusive';
    } else if (MEDIA.includes(name)) {
        effect = 'media';
        riskLevel = 2;
        concurrencyClass = 'interactive';
    } else if (name === 'mcp_call') {
        effect = 'mcp';
        riskLevel = 1;
        concurrencyClass = 'interactive';
    } else if (MODE_CONTROL.includes(name)) {
        effect = 'none';
        riskLevel = 0;
        concurrencyClass = 'parallel';
    } else if (name === 'ask_user_question') {
        effect = 'none';
        riskLevel = 0;
        concurrencyClass = 'interactive';
    } else {
        effect = 'none';
        riskLevel = 2;
        concurrencyClass = 'global-exclusive';
    }
    
    const mutating = MUTATING_TOOLS_SET.has(name);
    const stormExempt = STORM_EXEMPT_TOOLS_SET.has(name);

    const noFlatten = ['todo_write', 'typed_pdx_write', 'enter_plan_mode', 'exit_plan_mode', 'extract_archetype_slots', 'instantiate_archetype'].includes(name);
    let flatSchema: ToolDefinition | undefined = undefined;
    if (!noFlatten) {
        const analysis = analyzeSchema(schema);
        if (analysis.shouldFlatten) {
            flatSchema = flattenSchema(schema);
        }
    }

    // Mode control mutates session scheduling state, so it is never reported as
    // a read-only tool even though it touches no workspace file.
    const isReadOnly = !MODE_CONTROL.includes(name) && name !== 'ask_user_question' && (effect === 'workspace_read'
        || effect === 'network'
        || (effect === 'none' && !mutating));
    const disclosure: ToolDisclosure = ALWAYS_DISCLOSED_TOOLS.has(name) ? 'always' : 'deferred';
    const group = GENERIC_FILE_WRITE_TOOLS.has(name) ? 'file_write'
        : PDX_WRITE_TOOLS.has(name) ? 'pdx_write'
            : SHADER_TOOLS.has(name) ? 'shader'
                : PDX_PROJECT_TOOLS.has(name) ? 'pdx_project'
                    : PDX_RULE_TOOLS.has(name) ? 'pdx_rules'
                        : PDX_CATALOG_TOOLS.has(name) ? 'pdx_catalog'
                            : NAVIGATION_TOOLS.has(name) ? 'navigation'
                                : DIAGNOSTIC_TOOLS.has(name) ? 'diagnostics'
                                    : ASSET_TOOLS.has(name) ? 'assets'
                                        : effect === 'network' || name === 'web_find' ? 'web'
                                            : effect === 'git' ? 'git'
                                                : effect === 'media' ? 'media'
                                                    : effect === 'mcp' ? 'mcp'
                                                        : MEMORY.includes(name) || name === 'history' ? 'memory'
                                                            : effect === 'workspace_read' ? 'workspace_read'
                                                                : 'support';
    TOOL_REGISTRY.set(name, {
        name,
        schema,
        isWrite: WRITE_TOOLS_SET.has(name),
        isReadOnly,
        allowSubAgent: !SUB_AGENT_EXCLUDES_SET.has(name),
        allowedModes: allowed,
        effect,
        riskLevel,
        concurrencyClass,
        domain: TOOL_DOMAINS[name],
        mutating,
        stormExempt,
        noFlatten,
        flatSchema,
        disclosedSchema: name === 'write_design_blueprint' ? DESIGN_BLUEPRINT_DISCLOSED_TOOL : undefined,
        disclosure,
        group,
        providerCapability: disclosure === 'deferred' ? 'dynamic_tools' : undefined,
        estimatedSchemaTokens: Math.ceil(JSON.stringify(flatSchema ?? schema).length / 4),
        idempotency: name === 'ask_user_question'
            ? 'none'
            : isReadOnly && effect !== 'network'
            ? 'read'
            : effect === 'none' && !mutating
                ? 'deterministic'
                : 'none',
    });
}

export const TOOL_DEFINITIONS = SCHEMA_DEFINITIONS;
export const WRITE_TOOLS = WRITE_TOOLS_SET;
export const MUTATING_TOOLS = MUTATING_TOOLS_SET;
export const FILE_SCOPED_WRITE_TOOLS = FILE_SCOPED_WRITE_TOOLS_SET;
export const SUB_AGENT_EXCLUDES = SUB_AGENT_EXCLUDES_SET;
export const READ_ONLY_TOOLS = new Set([...TOOL_REGISTRY.values()].filter(entry => entry.isReadOnly).map(entry => entry.name));
