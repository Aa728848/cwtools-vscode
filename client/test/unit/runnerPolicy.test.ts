import { expect } from 'chai';
import {
    filterToolDefinitionsForMode,
    filterToolDefinitionsForStage,
    initialToolStageForMode,
    normalizeToolStageForMode,
    advanceToolStage,
    buildToolStageReminder,
    resolveMaxToolIterations,
    resolveRunMaxOutputTokens,
    shouldRenewIterationLimit,
    SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS,
    TOP_LEVEL_ITERATION_SAFETY_CAP,
} from '../../extension/ai/runnerPolicy';
import type { ToolDefinition } from '../../extension/ai/types';
import { TOOL_DEFINITIONS as registeredTools, TOOL_REGISTRY } from '../../extension/ai/tools/registry';
import { validateToolAccess } from '../../extension/ai/tools/permissions';

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
        expect(names).to.include('mcp_call');
        expect(names).to.not.include.members(['apply_patch', 'multi_replace_file_content']);

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

    it('keeps Paradox MCP tools in discovery while General removes them before staging', () => {
        const dynamicMcp = {
            type: 'function',
            function: { name: 'mcp_cwtools_query_rules', description: '', parameters: {} },
        } as ToolDefinition;
        const paradox = filterToolDefinitionsForMode(registeredTools, 'build', { domain: 'paradox' });
        const staged = filterToolDefinitionsForStage([...paradox, dynamicMcp], 'build', 'discovery')
            .map(tool => tool.function.name);
        expect(staged).to.include.members(['mcp_call', 'mcp_cwtools_query_rules']);

        const general = filterToolDefinitionsForMode(registeredTools, 'utility', { domain: 'general' })
            .map(tool => tool.function.name);
        expect(general).to.not.include('mcp_call');
    });

    it('advances build stages only after successful evidence and write steps', () => {
        expect(advanceToolStage('build', 'discovery', 'read_file', { success: true })).to.equal('evidence');
        expect(advanceToolStage('build', 'evidence', 'query_rules', { success: true })).to.equal('validation');
        expect(advanceToolStage('build', 'validation', 'parse_pdx_fragment', { success: true })).to.equal('write');
        expect(advanceToolStage('build', 'write', 'edit_file', { success: false })).to.equal('validation');
        expect(advanceToolStage('build', 'write', 'edit_file', { success: true })).to.equal('finalize');
        expect(advanceToolStage('build', 'finalize', 'get_diagnostics', { success: true, hasValidationErrors: true })).to.equal('validation');
    });

    it('maps persisted Build design checkpoints to the renamed evidence stage', () => {
        expect(normalizeToolStageForMode('build', 'design')).to.equal('evidence');
        expect(normalizeToolStageForMode('plan', 'design')).to.equal('design');
        expect(advanceToolStage('build', 'design', 'query_rules', { success: true })).to.equal('validation');
        expect(buildToolStageReminder('build', 'design', [])).to.include('Current build tool stage: evidence');
        expect(filterToolDefinitionsForStage(toolDefinitions, 'plan', 'evidence')).to.deep.equal([]);
    });

    it('describes the current stage with a deterministic tool list', () => {
        const reminder = buildToolStageReminder('build', 'validation', [toolDefinitions[2]!, toolDefinitions[0]!]);
        expect(reminder).to.include('Current build tool stage: validation');
        expect(reminder).to.include('query_workspace_index, read_file');
        expect(reminder).to.include('before writing');
        expect(buildToolStageReminder('build', undefined, toolDefinitions)).to.equal('');
    });

    it('advances ordinary Build evidence internally while keeping project writes out of design', () => {
        expect(advanceToolStage('build', 'discovery', 'read_file', { success: true })).to.equal('evidence');
        expect(advanceToolStage('build', 'evidence', 'read_file', { success: true })).to.equal('validation');
        expect(advanceToolStage('build', 'validation', 'todo_write', { success: true })).to.equal('write');

        const evidenceTools = filterToolDefinitionsForStage(registeredTools, 'build', 'evidence')
            .map(tool => tool.function.name);
        expect(evidenceTools).to.not.include.members(['write_file', 'replace_lines', 'write_localisation']);
        const planDesignTools = filterToolDefinitionsForStage(registeredTools, 'plan', 'design')
            .map(tool => tool.function.name);
        expect(planDesignTools).to.not.include('write_localisation');
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

    it('lets Plan mode fan out read-only planning work without exposing project writes', () => {
        const modeTools = filterToolDefinitionsForMode(registeredTools, 'plan');
        const discoveryNames = filterToolDefinitionsForStage(modeTools, 'plan', 'discovery')
            .map(tool => tool.function.name);
        expect(discoveryNames).to.include.members(['dispatch_agents', 'query_blackboard', 'merge_results']);
        expect(discoveryNames).to.not.include.members(['write_localisation', 'edit_pdx_block']);
        expect(validateToolAccess('dispatch_agents', { mode: 'plan' }).allowed).to.equal(true);
        expect(advanceToolStage('plan', 'discovery', 'dispatch_agents', { success: true })).to.equal('design');
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

    it('keeps legacy general mode read-only and gives utility an explicit coding surface', () => {
        const general = filterToolDefinitionsForMode(toolDefinitions, 'general').map(t => t.function.name);
        expect(general).to.include('read_file');
        expect(general).to.not.include.members(['write_file', 'run_command', 'mcp_call']);

        const utility = filterToolDefinitionsForMode(toolDefinitions, 'utility').map(t => t.function.name);
        expect(utility).to.include.members(['read_file', 'write_file', 'run_command']);
        const utilityChild = filterToolDefinitionsForMode(toolDefinitions, 'utility', { useSlimPrompt: true }).map(t => t.function.name);
        expect(utilityChild).to.include('run_command');
    });

    it('strictly removes every Paradox-only capability from all General Coding intents', () => {
        for (const mode of ['utility', 'plan', 'explore', 'review', 'orchestrator'] as const) {
            const filtered = filterToolDefinitionsForMode(registeredTools, mode, { domain: 'general' });
            const leaked = filtered
                .map(tool => TOOL_REGISTRY.get(tool.function.name as any))
                .filter(entry => entry?.domain === 'paradox')
                .map(entry => entry!.name);
            expect(leaked, `${mode} leaked Paradox tools`).to.deep.equal([]);
        }

        const generalUtility = filterToolDefinitionsForMode(registeredTools, 'utility', { domain: 'general' })
            .map(tool => tool.function.name);
        expect(generalUtility).to.include.members([
            'read_file', 'write_file', 'grep', 'document_symbols', 'workspace_symbols',
            'get_diagnostics', 'run_command', 'git_ops',
        ]);
        expect(generalUtility).to.not.include.members([
            'query_cwt_schema', 'query_scope', 'query_types', 'verify_pdx_identifier',
            'query_localisation_index', 'find_sprite_candidates', 'find_sound_candidates',
            'write_localisation', 'write_design_blueprint', 'get_pdx_block', 'edit_pdx_block',
            'mcp_call', 'apply_patch', 'multi_replace_file_content',
            'set_memory', 'get_memory', 'search_memory', 'save_memory',
        ]);

        const paradoxPlan = filterToolDefinitionsForMode(registeredTools, 'plan', { domain: 'paradox' })
            .map(tool => tool.function.name);
        expect(paradoxPlan).to.include.members(['query_cwt_schema', 'query_scope', 'query_types', 'mcp_call']);

        const legacyGeneral = filterToolDefinitionsForMode(registeredTools, 'utility', {
            domain: 'general',
            legacyFullToolset: true,
        }).map(tool => tool.function.name);
        expect(legacyGeneral).to.not.include.members([
            'query_cwt_schema', 'mcp_call', 'apply_patch', 'multi_replace_file_content',
        ]);

        for (const domain of ['general', 'paradox'] as const) {
            for (const mode of ['utility', 'build', 'plan', 'explore', 'review', 'orchestrator', 'script'] as const) {
                const visible = filterToolDefinitionsForMode(registeredTools, mode, {
                    domain,
                    legacyFullToolset: true,
                }).map(tool => tool.function.name);
                expect(visible, `${domain}/${mode} retired tool exposure`).to.not.include.members([
                    'apply_patch', 'multi_replace_file_content',
                ]);
            }
        }

        const generalDispatch = filterToolDefinitionsForMode(registeredTools, 'orchestrator', { domain: 'general' })
            .find(tool => tool.function.name === 'dispatch_agents');
        const serializedDispatch = JSON.stringify(generalDispatch);
        expect(serializedDispatch).to.not.include('Paradox');
        expect(serializedDispatch).to.not.include('loc_writer');
        expect(serializedDispatch).to.not.include('blueprintFile');
        expect(serializedDispatch).to.not.include('CWT');
    });

    it('rejects hallucinated Paradox calls at the execution boundary for General Coding', () => {
        expect(validateToolAccess('query_cwt_schema', { mode: 'utility', domain: 'general' }).allowed).to.equal(false);
        expect(validateToolAccess('write_localisation', { mode: 'utility', domain: 'general' }).allowed).to.equal(false);
        expect(validateToolAccess('mcp_call', { mode: 'utility', domain: 'general' }).allowed).to.equal(false);
        expect(validateToolAccess('mcp_filesystem_read_file', { mode: 'utility', domain: 'general' }).allowed).to.equal(false);
        expect(validateToolAccess('get_diagnostics', { mode: 'utility', domain: 'general' }).allowed).to.equal(true);
        expect(validateToolAccess('run_command', {
            mode: 'utility',
            domain: 'general',
            isSubAgent: true,
        }).allowed).to.equal(true);
        expect(validateToolAccess('run_command', {
            mode: 'build',
            domain: 'paradox',
            isSubAgent: true,
        }).allowed).to.equal(false);
    });

    it('uses discovery, write, and finalize stages for general coding', () => {
        expect(initialToolStageForMode('utility')).to.equal('discovery');
        const discovery = filterToolDefinitionsForStage(toolDefinitions, 'utility', 'discovery').map(t => t.function.name);
        expect(discovery).to.include('read_file');
        expect(discovery).to.not.include('write_file');
        expect(advanceToolStage('utility', 'discovery', 'read_file', { success: true })).to.equal('write');
        expect(advanceToolStage('utility', 'write', 'edit_file', { success: false })).to.equal('write');
        expect(advanceToolStage('utility', 'write', 'edit_file', { success: true })).to.equal('finalize');
        const finalize = filterToolDefinitionsForStage(toolDefinitions, 'utility', 'finalize').map(t => t.function.name);
        expect(finalize).to.include.members(['read_file', 'run_command', 'write_file']);
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

    it('lets top-level build runs rely on soft and hard runtime budgets', () => {
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000 })).to.equal(TOP_LEVEL_ITERATION_SAFETY_CAP);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, isSubAgent: true })).to.equal(40);
    });

    it('keeps orchestrator sub-agents bounded independently of top-level runs', () => {
        expect(resolveMaxToolIterations({ mode: 'orchestrator', baseContextLimit: 128000 })).to.equal(TOP_LEVEL_ITERATION_SAFETY_CAP);
        expect(resolveMaxToolIterations({ mode: 'orchestrator', baseContextLimit: 128000, isSubAgent: true })).to.equal(48);
        expect(resolveMaxToolIterations({ mode: 'orchestrator', baseContextLimit: 200000, isSubAgent: true })).to.equal(60);
    });

    it('keeps script sub-agents bounded independently of top-level runs', () => {
        expect(resolveMaxToolIterations({ mode: 'script', baseContextLimit: 128000 })).to.equal(TOP_LEVEL_ITERATION_SAFETY_CAP);
        expect(resolveMaxToolIterations({ mode: 'script', baseContextLimit: 128000, isSubAgent: true })).to.equal(64);
        expect(resolveMaxToolIterations({ mode: 'script', baseContextLimit: 200000, isSubAgent: true })).to.equal(80);
    });

    it('honors bounded overrides without letting sandbox bypass remove resource ceilings', () => {
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, override: 17 })).to.equal(17);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, override: 10_000 })).to.equal(256);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128000, bypassSandbox: true })).to.equal(TOP_LEVEL_ITERATION_SAFETY_CAP);
    });

    it('renews role iteration windows only for healthy default sub-agent runs', () => {
        expect(shouldRenewIterationLimit({
            renewable: true,
            iteration: 40,
            limit: 40,
            consecutiveErrors: 0,
            blockingValidationIssues: 0,
        })).to.equal(true);
        expect(shouldRenewIterationLimit({
            renewable: false,
            iteration: 40,
            limit: 40,
            consecutiveErrors: 0,
            blockingValidationIssues: 0,
        })).to.equal(false);
        expect(shouldRenewIterationLimit({
            renewable: true,
            iteration: 40,
            limit: 40,
            consecutiveErrors: 1,
            blockingValidationIssues: 0,
        })).to.equal(false);
    });
});
