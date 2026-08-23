import { expect } from 'chai';
import { TOOL_DEFINITIONS } from '../../extension/ai/tools/definitions';
import { TOOL_REGISTRY } from '../../extension/ai/tools/registry';

describe('tool definitions', () => {
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

    it('registers task-scoped process inspection and control with explicit effects', () => {
        for (const name of ['list_processes', 'read_process', 'write_process_stdin', 'terminate_process']) {
            expect(TOOL_DEFINITIONS.some(definition => definition.function.name === name), name).to.equal(true);
        }
        expect(TOOL_REGISTRY.get('list_processes')?.isReadOnly).to.equal(true);
        expect(TOOL_REGISTRY.get('read_process')?.isReadOnly).to.equal(true);
        expect(TOOL_REGISTRY.get('write_process_stdin')?.effect).to.equal('process');
        expect(TOOL_REGISTRY.get('write_process_stdin')?.isReadOnly).to.equal(false);
        expect(TOOL_REGISTRY.get('terminate_process')?.effect).to.equal('process');
        expect(TOOL_REGISTRY.get('terminate_process')?.isReadOnly).to.equal(false);
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
