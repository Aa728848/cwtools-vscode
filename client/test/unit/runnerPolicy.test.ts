import { expect } from 'chai';
import {
    filterToolDefinitionsForMode,
    resolveMaxToolIterations,
    resolveRunMaxOutputTokens,
    SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS,
} from '../../extension/ai/runnerPolicy';
import type { ToolDefinition } from '../../extension/ai/types';

const toolDefinitions = [
    'read_file',
    'replace_lines',
    'query_workspace_index',
    'dispatch_agents',
    'query_blackboard',
    'mcp_call',
    'mmx_generate_image',
    'run_command',
    'write_file',
    'apply_patch',
    'multi_replace_file_content',
    'write_localisation',
].map(name => ({
    type: 'function',
    function: { name, description: '', parameters: {} },
})) as ToolDefinition[];

describe('runnerPolicy', () => {
    it('keeps core edit tools in build mode and excludes orchestration/media tools', () => {
        const filtered = filterToolDefinitionsForMode(toolDefinitions, 'build');
        const names = filtered.map(t => t.function.name);
        expect(names).to.include('read_file');
        expect(names).to.include('query_workspace_index');
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

    it('hides command tools from slim sub-agent toolsets', () => {
        const filtered = filterToolDefinitionsForMode(toolDefinitions, 'build', { useSlimPrompt: true });
        const names = filtered.map(t => t.function.name);
        expect(names).to.include('replace_lines');
        expect(names).to.not.include('run_command');
    });

    it('keeps localisation modes off generic yml patch paths', () => {
        const filtered = filterToolDefinitionsForMode(toolDefinitions, 'loc_writer', { useSlimPrompt: true });
        const names = filtered.map(t => t.function.name);
        expect(names).to.include('write_localisation');
        expect(names).to.include('write_file');
        expect(names).to.not.include('apply_patch');
        expect(names).to.not.include('multi_replace_file_content');
        expect(names).to.not.include('replace_lines');
    });

    it('caps model output only for slim sub-agent runs', () => {
        expect(resolveRunMaxOutputTokens()).to.equal(undefined);
        expect(resolveRunMaxOutputTokens({ useSlimPrompt: true })).to.equal(SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS);
    });

    it('resolves conservative build iteration caps', () => {
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000 })).to.equal(40);
    });

    it('honors override and bypass sandbox', () => {
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, override: 17 })).to.equal(17);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, bypassSandbox: true })).to.equal(10000);
    });
});
