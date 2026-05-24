import type { ToolDefinition, AgentMode } from '../types';
import { TOOL_DEFINITIONS as SCHEMA_DEFINITIONS } from './definitions';
import { analyzeSchema, flattenSchema } from './schemaFlatten';

export type AgentToolName =
    | 'query_scope' | 'query_types' | 'query_rules' | 'remove_ignored_diagnostic'
    | 'query_localisation_index' | 'query_workspace_index' | 'query_project_profile' | 'get_ignored_diagnostics' | 'get_pdx_block' | 'edit_pdx_block' | 'query_references'
    | 'get_file_context' | 'search_mod_files' | 'find_sprite_candidates' | 'find_sound_candidates'
    | 'grep' | 'get_completion_at' | 'document_symbols' | 'workspace_symbols'
    | 'verify_pdx_identifier' | 'todo_write' | 'read_file' | 'write_file'
    | 'replace_lines' | 'list_directory' | 'get_diagnostics' | 'analyze_diagnostic_error'
    | 'glob_files' | 'lsp_operation' | 'web_fetch' | 'run_command'
    | 'search_web' | 'codesearch' | 'apply_patch' | 'multi_replace_file_content'
    | 'query_definition' | 'query_definition_by_name' | 'query_scripted_effects'
    | 'query_scripted_triggers' | 'query_enums' | 'get_entity_info'
    | 'query_static_modifiers' | 'query_variables' | 'set_memory'
    | 'get_memory' | 'search_memory' | 'save_memory' | 'mmx_generate_image'
    | 'mmx_generate_video' | 'mmx_generate_music' | 'mmx_generate_speech'
    | 'convert_image_to_dds' | 'convert_audio' | 'deploy_mod_asset' | 'mcp_call'
    | 'write_localisation' | 'write_design_blueprint' | 'git_ops' | 'dispatch_agents'
    | 'query_blackboard' | 'merge_results';

export type ToolEffect =
    | 'none'
    | 'memory'
    | 'workspace_read'
    | 'workspace_write'
    | 'network'
    | 'shell'
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
    mutating?: boolean;
    stormExempt?: boolean;
    noFlatten?: boolean;
    flatSchema?: ToolDefinition;
}

export const TOOL_REGISTRY = new Map<AgentToolName, ToolRegistryEntry>();

// Categories to help assign modes
const BASE_READ: AgentToolName[] = [
    'query_scope', 'query_types', 'query_rules', 'query_localisation_index', 'query_workspace_index', 'query_references',
    'query_project_profile', 'get_file_context', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep', 'get_completion_at',
    'document_symbols', 'workspace_symbols', 'verify_pdx_identifier', 'read_file', 'list_directory', 'glob_files',
    'lsp_operation', 'get_diagnostics', 'query_definition', 'query_definition_by_name',
    'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
    'get_entity_info', 'query_static_modifiers', 'query_variables', 'get_pdx_block', 'get_ignored_diagnostics'
];
const EDIT: AgentToolName[] = [
    'write_file', 'multi_replace_file_content', 'replace_lines', 'apply_patch',
    'edit_pdx_block', 'write_localisation', 'write_design_blueprint', 'remove_ignored_diagnostic'
];
const MEMORY: AgentToolName[] = ['todo_write', 'set_memory', 'get_memory', 'search_memory', 'save_memory'];
const NETWORK: AgentToolName[] = ['web_fetch', 'search_web', 'codesearch'];
const UTILITY: AgentToolName[] = ['run_command', 'git_ops', 'analyze_diagnostic_error'];
const MEDIA: AgentToolName[] = ['mmx_generate_image', 'mmx_generate_video', 'mmx_generate_music', 'mmx_generate_speech', 'convert_image_to_dds', 'convert_audio', 'deploy_mod_asset'];
const _MCP: AgentToolName[] = ['mcp_call'];
const ORCHESTRATION: AgentToolName[] = ['dispatch_agents', 'query_blackboard', 'merge_results'];

const WRITE_TOOLS_SET = new Set<string>([...EDIT, 'deploy_mod_asset', 'git_ops']);
const SUB_AGENT_EXCLUDES_SET = new Set<string>(['web_fetch', 'search_web', 'codesearch', 'run_command', 'git_ops', ...MEDIA]);

// Mutating tools: 改变工作区 / 记忆 / 黑板状态的工具。doom-loop 检测见到 mutating 成功
// 后会清空对应文件的 pairFrequency 窗口,避免把 verify-after-write 误判为重复。
const MUTATING_TOOLS_SET = new Set<string>([
    ...EDIT,
    'deploy_mod_asset',
    'git_ops',
    'set_memory',
    'save_memory',
    'merge_results',
]);

// Storm-exempt tools: 廉价状态检查 / 协作信号,允许在同一轮反复调用,不计入 doom-loop 窗口。
const STORM_EXEMPT_TOOLS_SET = new Set<string>([
    'get_diagnostics',
    'get_ignored_diagnostics',
    'query_scope',
    'document_symbols',
    'workspace_symbols',
    'list_directory',
    'query_blackboard',
]);

const PLAN_MODES = new Set([...BASE_READ, ...NETWORK, 'todo_write', 'write_design_blueprint', 'set_memory', 'get_memory', 'search_memory', 'git_ops']);
const EXPLORE_MODES = new Set([...BASE_READ, ...NETWORK, 'git_ops']);
const REVIEW_MODES = new Set([...BASE_READ, ...NETWORK, 'git_ops']);
const BUILD_MODES = new Set([...BASE_READ, ...EDIT, ...MEMORY, ...NETWORK, ...UTILITY]);
const LOC_MODES = new Set([
    'read_file', 'write_file',
    'list_directory', 'glob_files', 'search_mod_files', 'find_sprite_candidates', 'find_sound_candidates', 'grep',
    'workspace_symbols', 'document_symbols', 'verify_pdx_identifier', 'get_file_context', 'get_diagnostics',
    'query_types', 'query_rules', 'query_references', 'todo_write', 'write_localisation', 'git_ops',
    'analyze_diagnostic_error'
]);
const ORCHESTRATOR_MODES = new Set([...BASE_READ, ...NETWORK, 'set_memory', 'get_memory', 'search_memory', 'todo_write', ...ORCHESTRATION, 'git_ops', 'analyze_diagnostic_error']);

for (const schema of SCHEMA_DEFINITIONS) {
    const name = schema.function.name as AgentToolName;
    const allowed = new Set<AgentMode>();
    if (PLAN_MODES.has(name)) allowed.add('plan');
    if (EXPLORE_MODES.has(name)) allowed.add('explore');
    if (REVIEW_MODES.has(name)) { allowed.add('review'); allowed.add('script_reviewer'); }
    if (LOC_MODES.has(name)) { allowed.add('loc_translator'); allowed.add('loc_writer'); }
    if (ORCHESTRATOR_MODES.has(name)) allowed.add('orchestrator');
    if (BUILD_MODES.has(name)) { allowed.add('build'); allowed.add('gui_expert'); }
    
    // For general and utility mode, we do inverse exclusions:
    if (!['todo_write', ...ORCHESTRATION].includes(name)) allowed.add('general');
    if (!ORCHESTRATION.includes(name)) allowed.add('utility');

    // 动态推演 effect、riskLevel 与 concurrencyClass 以维护单一事实源
    let effect: ToolEffect = 'none';
    let riskLevel: 0 | 1 | 2 | 3 = 0;
    let concurrencyClass: ToolConcurrencyClass = 'parallel';

    if (BASE_READ.includes(name)) {
        effect = 'workspace_read';
        riskLevel = 0;
        if (['document_symbols', 'workspace_symbols', 'get_diagnostics', 'lsp_operation', 'query_references', 'query_definition'].includes(name)) {
            concurrencyClass = 'lsp-limited';
        } else {
            concurrencyClass = 'parallel';
        }
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

    TOOL_REGISTRY.set(name, {
        name,
        schema,
        isWrite: WRITE_TOOLS_SET.has(name),
        isReadOnly: !WRITE_TOOLS_SET.has(name),
        allowSubAgent: !SUB_AGENT_EXCLUDES_SET.has(name),
        allowedModes: allowed,
        effect,
        riskLevel,
        concurrencyClass,
        mutating,
        stormExempt,
        noFlatten,
        flatSchema
    });
}

export const TOOL_DEFINITIONS = SCHEMA_DEFINITIONS;
export const WRITE_TOOLS = WRITE_TOOLS_SET;
export const SUB_AGENT_EXCLUDES = SUB_AGENT_EXCLUDES_SET;
export const READ_ONLY_TOOLS = new Set(SCHEMA_DEFINITIONS.map(s => s.function.name).filter(n => !WRITE_TOOLS_SET.has(n)));
