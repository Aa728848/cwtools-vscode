import { expect } from 'chai';
import { filterToolDefinitionsForMode, resolveMaxToolIterations } from '../../extension/ai/runnerPolicy';
import type { ToolDefinition } from '../../extension/ai/types';

const toolDefinitions = [
    'read_file',
    'replace_lines',
    'dispatch_agents',
    'query_blackboard',
    'mcp_call',
    'mmx_generate_image',
].map(name => ({
    type: 'function',
    function: { name, description: '', parameters: {} },
})) as ToolDefinition[];

describe('runnerPolicy', () => {
    it('keeps core edit tools in build mode and excludes orchestration/media tools', () => {
        const filtered = filterToolDefinitionsForMode(toolDefinitions, 'build');
        const names = filtered.map(t => t.function.name);
        expect(names).to.include('read_file');
        expect(names).to.include('replace_lines');
        expect(names).to.not.include('dispatch_agents');
        expect(names).to.not.include('mcp_call');
        expect(names).to.not.include('mmx_generate_image');
    });

    it('keeps orchestration tools only in orchestrator mode', () => {
        const filtered = filterToolDefinitionsForMode(toolDefinitions, 'orchestrator');
        const names = filtered.map(t => t.function.name);
        expect(names).to.include('dispatch_agents');
        expect(names).to.include('query_blackboard');
    });

    it('resolves conservative build iteration caps', () => {
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000 })).to.equal(40);
    });

    it('honors override and bypass sandbox', () => {
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, override: 17 })).to.equal(17);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, bypassSandbox: true })).to.equal(10000);
    });
});
