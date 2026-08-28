import { expect } from 'chai';
import { TOOL_DEFINITIONS } from '../../extension/ai/tools/definitions';
import { TOOL_REGISTRY } from '../../extension/ai/tools/registry';

describe('tool definitions', () => {
    it('removes retired aliases and keeps the static schema budget bounded', () => {
        const names = TOOL_DEFINITIONS.map(definition => definition.function.name);
        expect(names).to.not.include.members([
            'lsp_operation',
            'create_goal', 'get_goal', 'update_goal', 'set_goal_budget',
            'get_memory', 'search_memory',
            'list_processes', 'read_process', 'write_process_stdin', 'terminate_process',
            'get_file_context', 'search_mod_files',
            'query_definition', 'query_definition_by_name', 'query_references',
        ]);
        expect(names.length).to.be.lessThan(91);
        const schemaTokens = [...TOOL_REGISTRY.values()]
            .reduce((total, entry) => total + entry.estimatedSchemaTokens, 0);
        expect(schemaTokens).to.be.lessThan(30_000);
    });

    it('registers structured user questions as a host interaction', () => {
        const tool = TOOL_DEFINITIONS.find(definition => definition.function.name === 'ask_user_question');
        const registry = TOOL_REGISTRY.get('ask_user_question');
        expect(tool).to.not.equal(undefined);
        expect(registry?.effect).to.equal('none');
        expect(registry?.riskLevel).to.equal(0);
        expect(registry?.concurrencyClass).to.equal('interactive');
        expect(registry?.allowSubAgent).to.equal(false);
        expect(registry?.idempotency).to.equal('none');
    });

    it('exposes the unified web toolset with explicit network effects', () => {
        const names = TOOL_DEFINITIONS.map(definition => definition.function.name);
        expect(names).to.include.members(['web_search', 'web_open', 'web_find']);
        expect(names).to.not.include.members(['web_fetch', 'search_web', 'codesearch']);
        expect(TOOL_REGISTRY.get('web_search')?.effect).to.equal('network');
        expect(TOOL_REGISTRY.get('web_open')?.effect).to.equal('network');
        expect(TOOL_REGISTRY.get('web_find')?.effect).to.equal('workspace_read');
        expect(TOOL_REGISTRY.get('web_find')?.riskLevel).to.equal(0);
    });

    it('registers one task-scoped process management tool', () => {
        const tool = TOOL_DEFINITIONS.find(definition => definition.function.name === 'manage_process');
        expect(tool).to.not.equal(undefined);
        const parameters = tool!.function.parameters as { properties: { action: { enum: string[] } } };
        expect(parameters.properties.action.enum).to.deep.equal(['list', 'read', 'write', 'terminate']);
        expect(TOOL_REGISTRY.get('manage_process')?.effect).to.equal('process');
        expect(TOOL_REGISTRY.get('manage_process')?.isReadOnly).to.equal(false);
        expect(TOOL_REGISTRY.get('manage_process')?.concurrencyClass).to.equal('interactive');
    });

    it('keeps recursive PDX write schema bounded', () => {
        const tool = TOOL_DEFINITIONS.find(definition => definition.function.name === 'typed_pdx_write');
        expect(JSON.stringify(tool).length).to.be.lessThan(32_000);
    });

    it('keeps expensive specialist schemas behind focused disclosure groups', () => {
        expect(TOOL_REGISTRY.get('typed_pdx_write')?.group).to.equal('pdx_write');
        expect(TOOL_REGISTRY.get('typed_pdx_write')?.disclosure).to.equal('deferred');
        expect(TOOL_REGISTRY.get('run_code')?.disclosure).to.equal('deferred');
        expect(TOOL_REGISTRY.get('query_shader_symbol')?.group).to.equal('shader');
        expect(TOOL_REGISTRY.get('query_shader_symbol')?.disclosure).to.equal('deferred');
        expect(TOOL_REGISTRY.get('write_file')?.group).to.equal('file_write');
        expect(TOOL_REGISTRY.get('write_localisation')?.group).to.equal('pdx_write');
    });

    it('registers project knowledge as a read-only planning evidence tool', () => {
        const tool = TOOL_DEFINITIONS.find(def => def.function.name === 'query_project_knowledge');
        expect(tool).to.not.equal(undefined);
        const parameters = tool!.function.parameters as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(parameters.required).to.deep.equal([]);
        expect(Object.keys(parameters.properties ?? {})).to.include.members([
            'intent',
            'domains',
            'includeVanillaArchetypes',
            'includeTopology',
            'includeUnresolved',
            'includeEventGraph',
        ]);
        const registry = TOOL_REGISTRY.get('query_project_knowledge');
        expect(registry?.isReadOnly).to.equal(true);
        expect(registry?.effect).to.equal('workspace_read');
        expect(registry?.allowedModes.has('plan')).to.equal(true);
    });

    it('registers focused Interface knowledge as a read-only Paradox tool', () => {
        const tool = TOOL_DEFINITIONS.find(def => def.function.name === 'query_interface_knowledge');
        expect(tool).to.not.equal(undefined);
        const parameters = tool!.function.parameters as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(parameters.required).to.deep.equal([]);
        expect(Object.keys(parameters.properties ?? {})).to.have.members([
            'topic',
            'query',
            'elementType',
            'limit',
        ]);
        const registry = TOOL_REGISTRY.get('query_interface_knowledge');
        expect(registry?.domain).to.equal('paradox');
        expect(registry?.isReadOnly).to.equal(true);
        expect(registry?.effect).to.equal('workspace_read');
        expect(registry?.allowedModes.has('gui_expert')).to.equal(true);
    });

    it('keeps get_completion_at arguments aligned with the runtime handler', () => {
        const tool = TOOL_DEFINITIONS.find(def => def.function.name === 'get_completion_at');
        expect(tool).to.not.equal(undefined);

        const parameters = tool!.function.parameters as {
            properties?: Record<string, unknown>;
            required?: string[];
        };

        expect(parameters.required).to.deep.equal(['file', 'line', 'column']);
        expect(Object.keys(parameters.properties ?? {})).to.have.members(['file', 'line', 'column', 'limit']);
        expect(parameters.properties).to.not.have.property('fileContent');
    });

    it('registers provider-neutral navigation and guarded rename tools for both domains', () => {
        for (const name of ['go_to_definition', 'find_references', 'hover_symbol', 'rename_symbol'] as const) {
            expect(TOOL_DEFINITIONS.some(def => def.function.name === name), name).to.equal(true);
            expect(TOOL_REGISTRY.get(name)?.domain, name).to.equal('shared');
        }
        expect(TOOL_REGISTRY.get('rename_symbol')?.isWrite).to.equal(true);
        expect(TOOL_REGISTRY.get('rename_symbol')?.concurrencyClass).to.equal('global-exclusive');
        const rename = TOOL_DEFINITIONS.find(tool => tool.function.name === 'rename_symbol');
        expect(rename?.function.parameters.properties).to.have.property('expectedExpansionPlanHash');
    });

    it('registers get_lsp_status as a lightweight read-only LSP status tool', () => {
        const tool = TOOL_DEFINITIONS.find(def => def.function.name === 'get_lsp_status');
        expect(tool).to.not.equal(undefined);

        const parameters = tool!.function.parameters as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(parameters.required).to.deep.equal([]);
        expect(Object.keys(parameters.properties ?? {})).to.have.members(['timeoutMs']);

        const registry = TOOL_REGISTRY.get('get_lsp_status');
        expect(registry).to.not.equal(undefined);
        expect(registry!.isReadOnly).to.equal(true);
        expect(registry!.isWrite).to.equal(false);
        expect(registry!.concurrencyClass).to.equal('lsp-limited');
        expect(registry!.riskLevel).to.equal(0);
        expect(registry!.stormExempt).to.equal(true);
        expect(TOOL_REGISTRY.get('query_blackboard')!.stormExempt).to.equal(true);
        expect(TOOL_REGISTRY.get('get_diagnostics')!.stormExempt).to.equal(false);
        expect(TOOL_REGISTRY.get('workspace_symbols')!.stormExempt).to.equal(false);
    });

    it('registers typed PDX writes and candidate transactions as Paradox write tools', () => {
        const typed = TOOL_REGISTRY.get('typed_pdx_write');
        const transaction = TOOL_REGISTRY.get('candidate_transaction');
        expect(typed?.effect).to.equal('workspace_write');
        expect(typed?.concurrencyClass).to.equal('per-file-write');
        expect(typed?.domain).to.equal('paradox');
        expect(transaction?.effect).to.equal('workspace_write');
        expect(transaction?.domain).to.equal('paradox');
        const properties = typed?.schema.function.parameters.properties as Record<string, unknown> | undefined;
        expect(properties?.operation).to.exist;
    });

    it('exposes bounded discriminated typed PDX and archetype schemas', () => {
        const typed = TOOL_DEFINITIONS.find(def => def.function.name === 'typed_pdx_write');
        const parameters = typed!.function.parameters as { additionalProperties?: boolean; properties: Record<string, any> };
        expect(parameters.additionalProperties).to.equal(false);
        expect(parameters.properties.expectedHash.pattern).to.equal('^[a-fA-F0-9]{64}$');
        const branches = parameters.properties.operation.oneOf as Array<{ properties: Record<string, any>; required: string[]; additionalProperties: boolean }>;
        expect(branches).to.have.length(14);
        expect(branches.every(branch => branch.additionalProperties === false)).to.equal(true);
        expect(branches.map(branch => branch.properties.operation.const)).to.have.members([
            'clone_definition', 'add_event_call', 'add_event_option', 'append_trigger_condition',
            'instantiate_inline_script', 'set_definition_field', 'delete_definition_field',
            'add_definition_field', 'add_scripted_effect_call', 'add_scripted_trigger_call',
            'add_on_action_entry', 'bind_event_target', 'clear_event_target', 'add_variable_transition',
        ]);
        const setField = branches.find(branch => branch.properties.operation.const === 'set_definition_field')!;
        expect(setField.required).to.include.members(['target', 'path', 'value']);
        expect(setField.properties.path.maxItems).to.equal(8);
        expect(setField.properties.value.oneOf).to.have.length(6);

        const instantiate = TOOL_DEFINITIONS.find(def => def.function.name === 'instantiate_archetype')!;
        const values = (instantiate.function.parameters as any).properties.values;
        expect(values.maxProperties).to.equal(64);
        expect(values.additionalProperties.oneOf).to.have.length(4);
        expect(values.additionalProperties.oneOf.every((branch: any) => branch.additionalProperties === false)).to.equal(true);
    });

    it('keeps scope schemas aligned with runtime integer positions and host-owned bridge evidence', () => {
        const query = TOOL_DEFINITIONS.find(def => def.function.name === 'query_scope')!.function.parameters as any;
        expect(query.additionalProperties).to.equal(false);
        expect(query.properties.line).to.include({ type: 'integer', minimum: 0 });
        expect(query.properties.column).to.include({ type: 'integer', minimum: 0 });
        const bridge = TOOL_DEFINITIONS.find(def => def.function.name === 'find_scope_bridge')!.function.parameters as any;
        expect(Object.keys(bridge.properties)).to.have.members(['fromScope', 'toScope', 'context']);
        expect(bridge.additionalProperties).to.equal(false);
    });

    it('registers edit_file as a first-class per-file write tool', () => {
        const tool = TOOL_DEFINITIONS.find(def => def.function.name === 'edit_file');
        expect(tool).to.not.equal(undefined);

        const parameters = tool!.function.parameters as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(parameters.required).to.deep.equal(['filePath', 'oldString', 'newString']);
        expect(Object.keys(parameters.properties ?? {})).to.have.members([
            'filePath',
            'oldString',
            'newString',
            'replaceAll',
            'encoding',
        ]);

        const registry = TOOL_REGISTRY.get('edit_file');
        expect(registry).to.not.equal(undefined);
        expect(registry!.isWrite).to.equal(true);
        expect(registry!.isReadOnly).to.equal(false);
        expect(registry!.effect).to.equal('workspace_write');
        expect(registry!.concurrencyClass).to.equal('per-file-write');
        expect(registry!.allowedModes.has('build')).to.equal(true);
        expect(registry!.allowedModes.has('plan')).to.equal(true);
    });
});
