import { expect } from 'chai';
import { TOOL_DEFINITIONS } from '../../extension/ai/tools/definitions';
import { TOOL_REGISTRY } from '../../extension/ai/tools/registry';

describe('tool definitions', () => {
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
