import { expect } from 'chai';
import {
    filterToolDefinitionsForMode,
    filterToolDefinitionsForStage,
    initialToolStageForMode,
    advanceToolStage,
    buildToolStageReminder,
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

    });

    it('starts build runs with a narrow discovery tool stage', () => {
        const stage = initialToolStageForMode('build');
        const filtered = filterToolDefinitionsForStage(toolDefinitions, 'build', stage);
        const names = filtered.map(t => t.function.name);
        expect(stage).to.equal('discovery');
        expect(names).to.include('read_file');
        expect(names).to.include('query_workspace_index');
        expect(names).to.not.include('write_file');
        expect(names).to.not.include('replace_lines');
        expect(filterToolDefinitionsForStage(toolDefinitions, 'build', stage, true)).to.have.lengthOf(toolDefinitions.length);
    });

    it('advances build stages only after successful evidence and write steps', () => {
        expect(advanceToolStage('build', 'discovery', 'read_file', { success: true })).to.equal('design');
        expect(advanceToolStage('build', 'design', 'query_rules', { success: true })).to.equal('validation');
        expect(advanceToolStage('build', 'validation', 'parse_pdx_fragment', { success: true })).to.equal('write');
        expect(advanceToolStage('build', 'write', 'edit_file', { success: false })).to.equal('validation');
        expect(advanceToolStage('build', 'write', 'edit_file', { success: true })).to.equal('finalize');
        expect(advanceToolStage('build', 'finalize', 'get_diagnostics', { success: true, hasValidationErrors: true })).to.equal('validation');
    });

    it('describes the current stage with a deterministic tool list', () => {
        const reminder = buildToolStageReminder('build', 'validation', [toolDefinitions[2]!, toolDefinitions[0]!]);
        expect(reminder).to.include('Current build tool stage: validation');
        expect(reminder).to.include('query_workspace_index, read_file');
        expect(reminder).to.include('before writing');
        expect(buildToolStageReminder('build', undefined, toolDefinitions)).to.equal('');
    });

    it('stages plan, explore, and review without exposing project write tools', () => {
        for (const mode of ['plan', 'explore', 'review'] as const) {
            const stage = initialToolStageForMode(mode);
            const filtered = filterToolDefinitionsForStage(toolDefinitions, mode, stage);
            const names = filtered.map(t => t.function.name);
            expect(stage, `${mode} initial stage`).to.equal('discovery');
            expect(names, `${mode} read tools`).to.include('read_file');
            expect(names, `${mode} write_file`).to.not.include('write_file');
            expect(names, `${mode} replace_lines`).to.not.include('replace_lines');
        }

        expect(advanceToolStage('plan', 'discovery', 'read_file', { success: true })).to.equal('design');
        expect(advanceToolStage('plan', 'validation', 'get_diagnostics', { success: true })).to.equal('finalize');
        expect(advanceToolStage('explore', 'discovery', 'read_file', { success: true })).to.equal('validation');
        expect(advanceToolStage('review', 'discovery', 'get_diagnostics', { success: true })).to.equal('validation');
    });

    it('keeps orchestration tools in coordinator modes', () => {
        const filtered = filterToolDefinitionsForMode(toolDefinitions, 'orchestrator');
        const names = filtered.map(t => t.function.name);
        expect(names).to.include('dispatch_agents');
        expect(names).to.include('query_blackboard');

        const scriptFiltered = filterToolDefinitionsForMode(toolDefinitions, 'script');
        const scriptNames = scriptFiltered.map(t => t.function.name);
        expect(scriptNames).to.include('dispatch_agents');
        expect(scriptNames).to.include('query_blackboard');
        expect(scriptNames).to.not.include('write_file');
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

    it('keeps an emergency ceiling above the normal build soft budget', () => {
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000 })).to.equal(120);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, isSubAgent: true })).to.equal(40);
    });

    it('keeps an emergency ceiling above the orchestrator soft budget', () => {
        expect(resolveMaxToolIterations({ mode: 'orchestrator', baseContextLimit: 128000 })).to.equal(160);
        expect(resolveMaxToolIterations({ mode: 'orchestrator', baseContextLimit: 128000, isSubAgent: true })).to.equal(48);
        expect(resolveMaxToolIterations({ mode: 'orchestrator', baseContextLimit: 200000, isSubAgent: true })).to.equal(60);
    });

    it('keeps an emergency ceiling above the script soft budget', () => {
        expect(resolveMaxToolIterations({ mode: 'script', baseContextLimit: 128000 })).to.equal(192);
        expect(resolveMaxToolIterations({ mode: 'script', baseContextLimit: 128000, isSubAgent: true })).to.equal(64);
        expect(resolveMaxToolIterations({ mode: 'script', baseContextLimit: 200000, isSubAgent: true })).to.equal(80);
    });

    it('honors bounded overrides without letting sandbox bypass remove resource ceilings', () => {
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, override: 17 })).to.equal(17);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, override: 10_000 })).to.equal(256);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, bypassSandbox: true })).to.equal(120);
    });
});
