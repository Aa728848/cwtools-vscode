import type { ToolDefinition, AgentMode } from '../types';
import { TOOL_DEFINITIONS as SCHEMA_DEFINITIONS } from './definitions';
import { analyzeSchema, flattenSchema } from './schemaFlatten';

export type AgentToolName =
    | 'select_tools' | 'create_goal' | 'get_goal' | 'update_goal' | 'set_goal_budget'
    | 'query_scope' | 'query_types' | 'query_rules' | 'query_cwt_schema' | 'query_override_modes' | 'search_rule_capabilities' | 'explain_scope' | 'parse_pdx_fragment' | 'remove_ignored_diagnostic'
    | 'query_localisation_index' | 'query_workspace_index' | 'explore_pdx_project' | 'query_project_profile' | 'query_project_knowledge' | 'query_interface_knowledge' | 'run_skill' | 'get_ignored_diagnostics' | 'get_pdx_block' | 'query_references'
    | 'get_file_context' | 'search_mod_files' | 'find_sprite_candidates' | 'find_sound_candidates'
    | 'grep' | 'get_completion_at' | 'document_symbols' | 'workspace_symbols'
    | 'go_to_definition' | 'find_references' | 'hover_symbol' | 'rename_symbol'
    | 'verify_pdx_identifier' | 'todo_write' | 'read_file' | 'write_file' | 'edit_file'
    | 'replace_lines' | 'list_directory' | 'get_lsp_status' | 'get_diagnostics' | 'analyze_diagnostic_error'
    | 'glob_files' | 'lsp_operation' | 'web_search' | 'web_open' | 'web_find' | 'run_command' | 'list_processes' | 'read_process' | 'write_process_stdin' | 'terminate_process'
    | 'query_definition' | 'query_definition_by_name' | 'query_scripted_effects'
    | 'query_scripted_triggers' | 'query_enums' | 'get_entity_info'
    | 'query_static_modifiers' | 'query_variables' | 'set_memory'
    | 'get_memory' | 'search_memory' | 'save_memory'
    | 'convert_image_to_dds' | 'convert_audio' | 'deploy_mod_asset' | 'mcp_call'
    | 'write_localisation' | 'write_design_blueprint' | 'save_workflow' | 'git_ops' | 'dispatch_agents'
    | 'query_blackboard' | 'merge_results' | 'get_design_blueprint_contract'
    | 'query_shader_symbol' | 'query_shader_compile_unit' | 'query_shader_platform_variants' | 'query_shader_callers'
    | 'explain_shader_reachability' | 'validate_shader' | 'compare_shader_with_vanilla';

export type ToolEffect =
    | 'none'
    | 'memory'
    | 'workspace_read'
    | 'workspace_write'
    | 'network'
    | 'shell'
    | 'git'
    | 'media'
    | 'mcp'
    | 'process';

export type ToolConcurrencyClass =
    | 'parallel'
    | 'lsp-limited'
    | 'network-limited'
    | 'per-file-write'
    | 'global-exclusive'
    | 'interactive';

export type ToolDomain = 'shared' | 'paradox';
export type ToolDisclosure = 'always' | 'stage' | 'deferred';
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
    /** Domain-safe schema used when a shared tool has mixed-domain parameters. */
    generalSchema?: ToolDefinition;
    disclosure: ToolDisclosure;
    group?: string;
    providerCapability?: string;
    estimatedSchemaTokens: number;
    idempotency: ToolIdempotency;
}

export const TOOL_REGISTRY = new Map<AgentToolName, ToolRegistryEntry>();

/**
 * Explicit classification is intentionally exhaustive: adding a tool without
 * deciding whether General Coding may receive it is a compile error.
 */
const TOOL_DOMAINS = {
    select_tools: 'shared',
    create_goal: 'shared',
    get_goal: 'shared',
    update_goal: 'shared',
    set_goal_budget: 'shared',
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
    query_project_profile: 'paradox',
    query_project_knowledge: 'paradox',
    query_interface_knowledge: 'paradox',
    run_skill: 'shared',
    get_ignored_diagnostics: 'paradox',
    get_pdx_block: 'paradox',
    query_references: 'shared',
    get_file_context: 'shared',
    search_mod_files: 'paradox',
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
    todo_write: 'shared',
    read_file: 'shared',
    write_file: 'shared',
    edit_file: 'shared',
    replace_lines: 'shared',
    list_directory: 'shared',
    get_lsp_status: 'paradox',
    get_diagnostics: 'shared',
    analyze_diagnostic_error: 'paradox',
    glob_files: 'shared',
    lsp_operation: 'paradox',
    web_search: 'shared',
    web_open: 'shared',
    web_find: 'shared',
    run_command: 'shared',
    list_processes: 'shared',
    read_process: 'shared',
    write_process_stdin: 'shared',
    terminate_process: 'shared',
    query_definition: 'paradox',
    query_definition_by_name: 'paradox',
    query_scripted_effects: 'paradox',
    query_scripted_triggers: 'paradox',
    query_enums: 'paradox',
    get_entity_info: 'paradox',
    query_static_modifiers: 'paradox',
    query_variables: 'paradox',
    set_memory: 'shared',
    get_memory: 'shared',
    search_memory: 'shared',
    save_memory: 'shared',
    convert_image_to_dds: 'paradox',
    convert_audio: 'paradox',
    deploy_mod_asset: 'paradox',
    // Per-server capability metadata is enforced again immediately before
    // listing or executing a configured MCP tool.
    mcp_call: 'shared',
    write_localisation: 'paradox',
    write_design_blueprint: 'paradox',
    save_workflow: 'shared',
    git_ops: 'shared',
    dispatch_agents: 'shared',
    query_blackboard: 'shared',
    merge_results: 'shared',
    get_design_blueprint_contract: 'paradox',
    query_shader_symbol: 'paradox',
    query_shader_compile_unit: 'paradox',
    query_shader_platform_variants: 'paradox',
    query_shader_callers: 'paradox',
    explain_shader_reachability: 'paradox',
    validate_shader: 'paradox',
    compare_shader_with_vanilla: 'paradox',
} satisfies Record<AgentToolName, ToolDomain>;

const GENERAL_DISPATCH_SCHEMA: ToolDefinition = {
    type: 'function',
    function: {
        name: 'dispatch_agents',
        description: 'Dispatch up to four ordinary repository tasks as a bounded dependency graph. Declare dependencies and planned files so overlapping writes are serialized safely.',
        parameters: {
            type: 'object',
            properties: {
                tasks: {
                    type: 'array',
                    maxItems: 4,
                    description: 'Repository sub-tasks ordered by dependencies. Split larger work into bounded waves.',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Unique sub-task ID.' },
                            agentType: {
                                type: 'string',
                                enum: ['explore', 'plan', 'utility', 'review'],
                                description: 'Repository role. Use utility for scoped implementation and verification commands.',
                            },
                            prompt: { type: 'string', description: 'Concise sub-task description.' },
                            dependencies: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Prerequisite task IDs that must complete first.',
                            },
                            contextFiles: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Optional repository paths or Blackboard keys containing required context.',
                            },
                            plannedFiles: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Expected files this task may modify. Provide exact paths whenever known.',
                            },
                            priority: { type: 'string', enum: ['critical', 'normal', 'low'] },
                            maxIterations: { type: 'integer', minimum: 1, maximum: 100 },
                        },
                        required: ['id', 'agentType', 'prompt'],
                    },
                },
            },
            required: ['tasks'],
        },
    },
};

const GENERAL_BLACKBOARD_SCHEMA: ToolDefinition = {
    type: 'function',
    function: {
        name: 'query_blackboard',
        description: 'Query the shared cross-agent store by exact key, prefix, or ordinary repository record type.',
        parameters: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Exact key to look up.' },
                prefix: { type: 'string', description: 'Key prefix for bounded range queries.' },
                type: {
                    type: 'string',
                    enum: ['file_snapshot', 'diag_result', 'write_intent', 'free_text'],
                    description: 'Optional repository record type filter.',
                },
            },
            required: [],
        },
    },
};

const GENERAL_WORKFLOW_SCHEMA: ToolDefinition = {
    type: 'function',
    function: {
        name: 'save_workflow',
        description: 'Save a reusable ordinary repository workflow when the user asks to preserve the process.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Optional stable lowercase/kebab-case workflow id.' },
                title: { type: 'string', description: 'User-facing workflow title.' },
                description: { type: 'string', description: 'Short summary shown in the workflow picker.' },
                mode: {
                    type: 'string',
                    enum: ['plan', 'explore', 'utility', 'review', 'orchestrator'],
                    description: 'Ordinary repository Agent mode. Defaults to utility in General Coding.',
                },
                promptSupplement: { type: 'string', description: 'Reusable objective, phases, constraints, and verification steps.' },
                allowedTools: { type: 'array', items: { type: 'string' } },
                blockedTools: { type: 'array', items: { type: 'string' } },
                requiredContext: {
                    type: 'array',
                    items: { type: 'string', enum: ['activeFile', 'activeFile!', 'diagnostics', 'diagnostics!', 'selection', 'selection!', 'workspace', 'workspace!'] },
                },
                verificationTool: { type: 'string' },
                overwrite: { type: 'boolean' },
            },
            required: ['title', 'description', 'promptSupplement'],
        },
    },
};

// Categories to help assign modes
const BASE_READ: AgentToolName[] = [
    'select_tools', 'get_goal',
    'query_scope', 'query_types', 'query_rules', 'query_cwt_schema', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'query_localisation_index', 'query_workspace_index', 'explore_pdx_project', 'query_references', 'get_design_blueprint_contract',
    'query_project_profile', 'query_project_knowledge', 'query_interface_knowledge', 'run_skill', 'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'go_to_definition', 'find_references', 'hover_symbol',
    'verify_pdx_identifier', 'read_file', 'list_directory', 'glob_files',
    'lsp_operation', 'get_lsp_status', 'get_diagnostics', 'query_definition', 'query_definition_by_name', 'web_find',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables', 'get_pdx_block', 'get_ignored_diagnostics',
    'query_shader_symbol', 'query_shader_compile_unit', 'query_shader_platform_variants', 'query_shader_callers',
    'explain_shader_reachability', 'validate_shader', 'compare_shader_with_vanilla'
];
const EDIT: AgentToolName[] = [
    'write_file', 'edit_file', 'replace_lines', 'rename_symbol',
    'write_localisation', 'write_design_blueprint', 'save_workflow', 'remove_ignored_diagnostic'
];
const MEMORY: AgentToolName[] = ['todo_write', 'create_goal', 'update_goal', 'set_goal_budget', 'set_memory', 'get_memory', 'search_memory', 'save_memory'];
const NETWORK: AgentToolName[] = ['web_search', 'web_open'];
const UTILITY: AgentToolName[] = ['run_command', 'list_processes', 'read_process', 'write_process_stdin', 'terminate_process', 'git_ops', 'analyze_diagnostic_error'];
const MEDIA: AgentToolName[] = ['convert_image_to_dds', 'convert_audio', 'deploy_mod_asset'];
const _MCP: AgentToolName[] = ['mcp_call'];
const ORCHESTRATION: AgentToolName[] = ['dispatch_agents', 'query_blackboard', 'merge_results'];

const WRITE_TOOLS_SET = new Set<string>([...EDIT, 'deploy_mod_asset', 'git_ops']);
const SUB_AGENT_EXCLUDES_SET = new Set<string>([
    'web_search', 'web_open', 'web_find',
    'run_command', 'list_processes', 'read_process', 'write_process_stdin', 'terminate_process',
    'git_ops', 'save_workflow',
    'rename_symbol',
    ...MEDIA,
    ...ORCHESTRATION,
]);
const FILE_SCOPED_WRITE_TOOLS_SET = new Set<string>([
    'write_file',
    'edit_file',
    'replace_lines',
    'write_localisation',
    'write_design_blueprint',
    'deploy_mod_asset',
    'save_workflow',
]);

// Mutating tools: 改变工作区 / 记忆 / 黑板状态的工具。doom-loop 检测见到 mutating 成功
// 后会清空对应文件的 pairFrequency 窗口,避免把 verify-after-write 误判为重复。
const MUTATING_TOOLS_SET = new Set<string>([
    ...EDIT,
    'deploy_mod_asset',
    'git_ops',
    'set_memory',
    'save_memory',
    'merge_results',
    'write_process_stdin',
    'terminate_process',
]);

// Storm-exempt tools: 廉价状态检查 / 协作信号,允许在同一轮反复调用,不计入 doom-loop 窗口。
const STORM_EXEMPT_TOOLS_SET = new Set<string>([
    'get_diagnostics',
    'get_lsp_status',
    'get_ignored_diagnostics',
    'query_scope',
    'document_symbols',
    'workspace_symbols',
    'list_directory',
    'query_blackboard',
]);

const PLAN_MODES = new Set([...BASE_READ, ...NETWORK, ..._MCP, ...ORCHESTRATION, 'todo_write', 'write_file', 'edit_file', 'replace_lines', 'write_design_blueprint', 'save_workflow', 'set_memory', 'get_memory', 'search_memory', 'git_ops']);
const EXPLORE_MODES = new Set([...BASE_READ, ...NETWORK, ..._MCP, ...ORCHESTRATION, 'git_ops', 'save_workflow']);
const REVIEW_MODES = new Set([...BASE_READ, ...NETWORK, ..._MCP, 'git_ops', 'save_workflow']);
const BUILD_MODES = new Set([...BASE_READ, ...EDIT, ...MEMORY, ...NETWORK, ...UTILITY, ...MEDIA, ..._MCP, ...ORCHESTRATION]);
const LOC_MODES = new Set([
    'select_tools', 'read_file', 'write_file',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep',
    'workspace_symbols', 'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_lsp_status', 'get_diagnostics',
    'query_types', 'query_rules', 'query_cwt_schema', 'query_override_modes', 'search_rule_capabilities', 'explain_scope', 'parse_pdx_fragment', 'query_references', 'todo_write', 'write_localisation', 'git_ops',
    'analyze_diagnostic_error', 'save_workflow'
]);
const ORCHESTRATOR_MODES = new Set([...BASE_READ, ...NETWORK, ..._MCP, 'set_memory', 'get_memory', 'search_memory', 'todo_write', 'write_file', 'write_design_blueprint', ...ORCHESTRATION, 'git_ops', 'analyze_diagnostic_error', 'save_workflow']);
const SCRIPT_MODES = new Set([...BASE_READ, ...NETWORK, ..._MCP, 'set_memory', 'get_memory', 'search_memory', 'todo_write', 'write_file', 'write_design_blueprint', ...ORCHESTRATION, 'git_ops', 'analyze_diagnostic_error', 'save_workflow']);
// Legacy General mode is intentionally read-only. Writable general coding work
// belongs to Utility mode, whose staged surface and policy gates are explicit.
const GENERAL_MODES = new Set([...BASE_READ, ...NETWORK]);
const UTILITY_MODES = new Set([...BASE_READ, ...EDIT, ...MEMORY, ...NETWORK, ...UTILITY, ...MEDIA, ...ORCHESTRATION, 'mcp_call']);

for (const schema of SCHEMA_DEFINITIONS) {
    const name = schema.function.name as AgentToolName;
    const allowed = new Set<AgentMode>();
    if (PLAN_MODES.has(name)) allowed.add('plan');
    if (EXPLORE_MODES.has(name)) allowed.add('explore');
    if (REVIEW_MODES.has(name)) { allowed.add('review'); allowed.add('script_reviewer'); }
    if (LOC_MODES.has(name)) { allowed.add('loc_translator'); allowed.add('loc_writer'); }
    if (ORCHESTRATOR_MODES.has(name)) allowed.add('orchestrator');
    if (SCRIPT_MODES.has(name)) allowed.add('script');
    if (BUILD_MODES.has(name)) { allowed.add('build'); allowed.add('gui_expert'); }
    
    // Security-sensitive modes use positive allowlists. New tools must be
    // deliberately assigned instead of becoming available by omission.
    if (GENERAL_MODES.has(name)) allowed.add('general');
    if (UTILITY_MODES.has(name)) allowed.add('utility');

    // 动态推演 effect、riskLevel 与 concurrencyClass 以维护单一事实源
    let effect: ToolEffect = 'none';
    let riskLevel: 0 | 1 | 2 | 3 = 0;
    let concurrencyClass: ToolConcurrencyClass = 'parallel';

    if (BASE_READ.includes(name)) {
        effect = 'workspace_read';
        riskLevel = 0;
        if (['document_symbols', 'workspace_symbols', 'get_lsp_status', 'get_diagnostics', 'lsp_operation', 'query_references', 'query_definition', 'explore_pdx_project',
            'query_shader_symbol', 'query_shader_compile_unit', 'query_shader_platform_variants', 'query_shader_callers', 'explain_shader_reachability', 'validate_shader', 'compare_shader_with_vanilla'].includes(name)) {
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
    } else if (name === 'run_command') {
        effect = 'shell';
        riskLevel = 2;
        concurrencyClass = 'interactive';
    } else if (name === 'list_processes' || name === 'read_process') {
        effect = 'none';
        riskLevel = 0;
        concurrencyClass = 'parallel';
    } else if (name === 'write_process_stdin' || name === 'terminate_process') {
        effect = 'process';
        riskLevel = 0;
        concurrencyClass = 'interactive';
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
    } else if (ORCHESTRATION.includes(name)) {
        effect = 'none';
        riskLevel = 0;
        concurrencyClass = 'parallel';
    } else {
        effect = 'none';
        riskLevel = 2;
        concurrencyClass = 'global-exclusive';
    }
    
    const mutating = MUTATING_TOOLS_SET.has(name);
    const stormExempt = STORM_EXEMPT_TOOLS_SET.has(name);

    const noFlatten = ['dispatch_agents', 'merge_results', 'query_blackboard', 'todo_write'].includes(name);
    let flatSchema: ToolDefinition | undefined = undefined;
    if (!noFlatten) {
        const analysis = analyzeSchema(schema);
        if (analysis.shouldFlatten) {
            flatSchema = flattenSchema(schema);
        }
    }

    const isReadOnly = effect === 'workspace_read'
        || effect === 'network'
        || (effect === 'none' && !mutating && !ORCHESTRATION.includes(name));
    const disclosure = ['todo_write', 'read_file', 'grep', 'get_goal', 'select_tools'].includes(name)
        ? 'always'
        : (['write_file', 'edit_file', 'replace_lines', 'run_command', 'git_ops', 'mcp_call', 'dispatch_agents'].includes(name)
            ? 'deferred'
            : 'stage');
    const group = effect === 'workspace_write' ? 'file_write'
        : effect === 'workspace_read' ? (name.includes('shader') ? 'shader' : 'workspace_read')
            : effect === 'network' ? 'web'
                : effect === 'shell' || effect === 'process' ? 'command'
                    : effect === 'git' ? 'git'
                        : effect === 'media' ? 'media'
                            : effect === 'mcp' ? 'mcp'
                                : ORCHESTRATION.includes(name) ? 'orchestrator'
                                    : MEMORY.includes(name) ? 'memory'
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
        generalSchema: name === 'dispatch_agents'
            ? GENERAL_DISPATCH_SCHEMA
            : name === 'query_blackboard'
                ? GENERAL_BLACKBOARD_SCHEMA
                : name === 'save_workflow'
                    ? GENERAL_WORKFLOW_SCHEMA
                    : undefined,
        disclosure,
        group,
        providerCapability: disclosure === 'deferred' ? 'dynamic_tools' : undefined,
        estimatedSchemaTokens: Math.ceil(JSON.stringify(flatSchema ?? schema).length / 4),
        idempotency: isReadOnly && effect !== 'network'
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
