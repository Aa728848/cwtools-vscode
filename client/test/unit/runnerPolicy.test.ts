import { expect } from 'chai';
import {
    filterToolDefinitionsForMode,
    filterToolDefinitionsForStage,
    extendStageToolPoolWithSupport,
    getWorkflowStageSupportTools,
    initialToolStageForMode,
    normalizeToolStageForMode,
    advanceToolStage,
    buildToolStageReminder,
    isExecutionActionTool,
    resolveMaxToolIterations,
    resolveRunMaxOutputTokens,
    shouldAutoDiscloseExecutionTools,
    shouldContinueAuthorizedExecution,
    finalResponseRequiresUserInput,
    isTruncationInducedStop,
    shouldRenewIterationLimit,
    SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS,
    TOP_LEVEL_ITERATION_SAFETY_CAP,
} from '../../extension/ai/runnerPolicy';
import type { ToolDefinition } from '../../extension/ai/types';
import { TOOL_DEFINITIONS as registeredTools, TOOL_REGISTRY } from '../../extension/ai/tools/registry';
import { validateToolAccess } from '../../extension/ai/tools/permissions';

const toolDefinitions = [
    'select_tools',
    'read_file',
    'replace_lines',
    'query_workspace_index',
    'dispatch_agents',
    'query_blackboard',
    'mcp_call',
    'run_command',
    'write_file',
    'write_localisation',
    'run_code',
].map(name => ({
    type: 'function',
    function: { name, description: '', parameters: {} },
})) as ToolDefinition[];

describe('runnerPolicy', () => {
    it('keeps core edit tools and runtime dispatch in build mode', () => {
        const filtered = filterToolDefinitionsForMode(toolDefinitions, 'build');
        const names = filtered.map(t => t.function.name);
        expect(names).to.include('read_file');
        expect(names).to.include('query_workspace_index');
        expect(names).to.include('replace_lines');
        expect(names).to.include('dispatch_agents');
        expect(names).to.include('mcp_call');
    });

    it('registers only the shared core source editors plus domain-specific writes', () => {
        const names = registeredTools.map(tool => tool.function.name);
        expect(names).to.not.include.members(['apply_patch', 'multi_replace_file_content', 'edit_pdx_block']);
        expect([...TOOL_REGISTRY.keys()]).to.not.include.members(['apply_patch', 'multi_replace_file_content', 'edit_pdx_block']);

        for (const name of ['write_file', 'edit_file', 'replace_lines'] as const) {
            expect(TOOL_REGISTRY.get(name)?.domain, name).to.equal('shared');
        }
        expect(TOOL_REGISTRY.get('write_localisation')?.domain).to.equal('paradox');
    });

    it('starts build runs with a narrow discovery tool stage', () => {
        const stage = initialToolStageForMode('build');
        const filtered = filterToolDefinitionsForStage(toolDefinitions, 'build', stage);
        const names = filtered.map(t => t.function.name);
        expect(stage).to.equal('discovery');
        expect(names).to.include('select_tools');
        expect(names).to.include('read_file');
        expect(names).to.include('query_workspace_index');
        expect(names).to.include('run_code');
        expect(names).to.not.include('write_file');
        expect(names).to.not.include('replace_lines');
        expect(filterToolDefinitionsForStage(toolDefinitions, 'build', stage, true)).to.have.lengthOf(toolDefinitions.length);
    });

    it('keeps programmable Code Mode available throughout Paradox evidence stages', () => {
        const buildTools = filterToolDefinitionsForMode(registeredTools, 'build', { domain: 'paradox' });
        for (const stage of ['discovery', 'evidence', 'validation', 'write', 'finalize'] as const) {
            const names = filterToolDefinitionsForStage(buildTools, 'build', stage).map(tool => tool.function.name);
            expect(names, stage).to.include('run_code');
        }
    });

    it('keeps structured user questions available during discovery and evidence', () => {
        const buildTools = filterToolDefinitionsForMode(registeredTools, 'build', { domain: 'paradox' });
        for (const stage of ['discovery', 'evidence'] as const) {
            const names = filterToolDefinitionsForStage(buildTools, 'build', stage).map(tool => tool.function.name);
            expect(names, stage).to.include('ask_user_question');
        }

        const planTools = filterToolDefinitionsForMode(registeredTools, 'plan', { domain: 'paradox' });
        expect(filterToolDefinitionsForStage(planTools, 'plan', 'discovery').map(tool => tool.function.name))
            .to.include('ask_user_question');
    });

    it('keeps deferred-tool selection reachable throughout every valid staged mode', () => {
        const stagesByMode = {
            build: ['discovery', 'evidence', 'validation', 'write', 'finalize'],
            plan: ['discovery', 'design', 'validation', 'write', 'finalize'],
            explore: ['discovery', 'validation', 'write', 'finalize'],
            review: ['discovery', 'validation', 'write', 'finalize'],
            utility: ['discovery', 'validation', 'write', 'finalize'],
        } as const;

        for (const [mode, stages] of Object.entries(stagesByMode)) {
            for (const stage of stages) {
                const names = filterToolDefinitionsForStage(
                    toolDefinitions,
                    mode as keyof typeof stagesByMode,
                    stage,
                ).map(tool => tool.function.name);
                expect(names, `${mode}:${stage}`).to.include('select_tools');
            }
        }
    });

    it('keeps Paradox skill, memory, goal, and MCP support reachable across staged runs', () => {
        const supportNames = [
            'run_skill', 'get_goal', 'create_goal', 'update_goal', 'set_goal_budget',
            'set_memory', 'get_memory', 'search_memory', 'save_memory', 'mcp_call',
        ];
        const supportDefinitions = registeredTools.filter(tool => supportNames.includes(tool.function.name));
        const dynamicMcp = {
            type: 'function',
            function: { name: 'mcp_cwtools_query_rules', description: '', parameters: {} },
        } as ToolDefinition;
        const stagesByMode = {
            build: ['discovery', 'evidence', 'validation', 'write', 'finalize'],
            plan: ['discovery', 'design', 'validation', 'finalize'],
            explore: ['discovery', 'validation', 'finalize'],
            review: ['discovery', 'validation', 'finalize'],
        } as const;

        for (const [mode, stages] of Object.entries(stagesByMode)) {
            const modeTools = filterToolDefinitionsForMode(
                [...supportDefinitions, dynamicMcp],
                mode as keyof typeof stagesByMode,
                { domain: 'paradox' },
            );
            const modeNames = new Set(modeTools.map(tool => tool.function.name));
            for (const stage of stages) {
                const stageTools = filterToolDefinitionsForStage(
                    modeTools,
                    mode as keyof typeof stagesByMode,
                    stage,
                );
                const stagedNames = extendStageToolPoolWithSupport(
                    stageTools,
                    modeTools,
                    mode as keyof typeof stagesByMode,
                    stage,
                ).map(tool => tool.function.name);
                for (const name of modeNames) {
                    expect(stagedNames, `${mode}:${stage}:${name}`).to.include(name);
                }
            }
        }
    });

    it('keeps workflow-declared read tools reachable without releasing workflow writes early', () => {
        const workflowContracts = {
            'loc-generation': ['query_localisation_index', 'read_file', 'write_file', 'write_localisation'],
            'asset-wiring': ['query_localisation_index', 'find_sprite_candidates', 'find_sound_candidates', 'read_file', 'write_file'],
        } as const;
        for (const [workflowId, workflowTools] of Object.entries(workflowContracts)) {
            const allowed = new Set<string>(workflowTools);
            const modeTools = filterToolDefinitionsForMode(registeredTools, 'build', { domain: 'paradox' })
                .filter(tool => allowed.has(tool.function.name));
            const support = getWorkflowStageSupportTools(workflowTools);
            const discovery = filterToolDefinitionsForStage(
                modeTools,
                'build',
                'discovery',
                false,
                support,
            ).map(tool => tool.function.name);

            expect(discovery, workflowId).to.include('query_localisation_index');
            expect(discovery, workflowId).to.not.include.members(['write_file', 'write_localisation']);
        }

        const assetAllowed = new Set<string>(workflowContracts['asset-wiring']);
        const assetTools = filterToolDefinitionsForMode(registeredTools, 'build', { domain: 'paradox' })
            .filter(tool => assetAllowed.has(tool.function.name));
        const assetDiscovery = filterToolDefinitionsForStage(
            assetTools,
            'build',
            'discovery',
            false,
            getWorkflowStageSupportTools(workflowContracts['asset-wiring']),
        ).map(tool => tool.function.name);
        expect(assetDiscovery).to.include.members(['find_sprite_candidates', 'find_sound_candidates']);
    });

    it('makes Paradox media tools available only at the write boundary', () => {
        const mediaTools = ['convert_image_to_dds', 'convert_audio', 'deploy_mod_asset'];
        const paradoxBuild = filterToolDefinitionsForMode(registeredTools, 'build', { domain: 'paradox' });
        const paradoxGui = filterToolDefinitionsForMode(registeredTools, 'gui_expert', { domain: 'paradox' })
            .map(tool => tool.function.name);
        const discovery = filterToolDefinitionsForStage(paradoxBuild, 'build', 'discovery')
            .map(tool => tool.function.name);
        const writeBase = filterToolDefinitionsForStage(paradoxBuild, 'build', 'write');
        const write = extendStageToolPoolWithSupport(writeBase, paradoxBuild, 'build', 'write')
            .map(tool => tool.function.name);
        const general = filterToolDefinitionsForMode(registeredTools, 'utility', { domain: 'general' })
            .map(tool => tool.function.name);

        expect(paradoxGui).to.include.members(mediaTools);
        expect(discovery).to.not.include.members(mediaTools);
        expect(write).to.include.members(mediaTools);
        expect(general).to.not.include.members(mediaTools);
    });

    it('auto-discloses execution schemas for every writable runtime mode at the correct boundary', () => {
        expect(shouldAutoDiscloseExecutionTools('build', 'discovery', 'workspace_write')).to.equal(false);
        expect(shouldAutoDiscloseExecutionTools('build', 'write', 'workspace_write')).to.equal(true);
        expect(shouldAutoDiscloseExecutionTools('utility', 'finalize', 'workspace_write')).to.equal(true);

        for (const mode of ['gui_expert', 'loc_translator', 'loc_writer', 'orchestrator', 'script'] as const) {
            expect(shouldAutoDiscloseExecutionTools(mode, undefined, 'workspace_write'), mode).to.equal(true);
        }
        for (const mode of ['plan', 'explore', 'review', 'script_reviewer', 'general'] as const) {
            expect(shouldAutoDiscloseExecutionTools(mode, undefined, 'workspace_write'), mode).to.equal(false);
        }
        expect(shouldAutoDiscloseExecutionTools('script', undefined, 'read_only')).to.equal(false);
    });

    it('continues authorized execution across internal evidence stages without adding an approval stop', () => {
        for (const stage of ['discovery', 'evidence', 'validation', 'write'] as const) {
            expect(shouldContinueAuthorizedExecution('build', stage, 'workspace_write', false), stage).to.equal(true);
        }
        expect(shouldContinueAuthorizedExecution('build', 'finalize', 'workspace_write', true)).to.equal(false);
        expect(shouldContinueAuthorizedExecution('script', undefined, 'workspace_write', false)).to.equal(true);
        expect(shouldContinueAuthorizedExecution('script', undefined, 'workspace_write', true)).to.equal(false);
        expect(shouldContinueAuthorizedExecution('plan', 'validation', 'workspace_write', false)).to.equal(false);
        expect(shouldContinueAuthorizedExecution('utility', 'write', 'read_only', false)).to.equal(false);
    });

    it('recognizes plain-language clarification finals so writable runs do not replay them', () => {
        expect(finalResponseRequiresUserInput('What should be changed?')).to.equal(false);
        expect(finalResponseRequiresUserInput(
            '当前没有具体的修改目标或代码变更要求。请说明你希望执行的具体操作。',
        )).to.equal(true);
        expect(finalResponseRequiresUserInput(
            'I cannot safely modify the project without a concrete target. Please specify the desired change.',
        )).to.equal(true);
        expect(finalResponseRequiresUserInput(
            'Implementation and verification are complete. Three files were changed.',
        )).to.equal(false);
    });

    it('distinguishes delivery execution from planning artifacts', () => {
        expect(isExecutionActionTool('write_file')).to.equal(true);
        expect(isExecutionActionTool('write_localisation')).to.equal(true);
        expect(isExecutionActionTool('run_command')).to.equal(true);
        expect(isExecutionActionTool('dispatch_agents')).to.equal(true);
        expect(isExecutionActionTool('write_design_blueprint')).to.equal(false);
        expect(isExecutionActionTool('save_workflow')).to.equal(false);
        expect(isExecutionActionTool('read_file')).to.equal(false);
    });

    it('keeps MCP schemas domain-neutral while execution enforces each server declaration', () => {
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
        expect(general).to.include('mcp_call');
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
        const reminder = buildToolStageReminder('build', 'validation', [toolDefinitions[3]!, toolDefinitions[1]!]);
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
        expect(discoveryNames).to.not.include('write_localisation');
        expect(validateToolAccess('dispatch_agents', { mode: 'plan' }).allowed).to.equal(true);
        expect(advanceToolStage('plan', 'discovery', 'dispatch_agents', { success: true })).to.equal('design');
    });

    it('lets Explore mode fan out bounded read-only evidence work', () => {
        const modeTools = filterToolDefinitionsForMode(registeredTools, 'explore');
        const discoveryNames = filterToolDefinitionsForStage(modeTools, 'explore', 'discovery')
            .map(tool => tool.function.name);
        expect(discoveryNames).to.include.members(['dispatch_agents', 'query_blackboard', 'merge_results']);
        expect(discoveryNames).to.not.include.members(['write_file', 'write_localisation']);
        expect(validateToolAccess('dispatch_agents', { mode: 'explore' }).allowed).to.equal(true);
        expect(advanceToolStage('explore', 'discovery', 'dispatch_agents', { success: true })).to.equal('validation');
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
        expect(scriptNames).to.include('write_file');
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
            'read_file', 'write_file', 'edit_file', 'replace_lines', 'grep', 'document_symbols', 'workspace_symbols',
            'go_to_definition', 'find_references', 'hover_symbol', 'get_completion_at', 'rename_symbol',
            'get_diagnostics', 'run_command', 'git_ops', 'run_skill',
            'set_memory', 'get_memory', 'search_memory', 'save_memory', 'mcp_call',
        ]);
        expect(generalUtility).to.not.include.members([
            'query_cwt_schema', 'query_scope', 'query_types', 'verify_pdx_identifier',
            'query_localisation_index', 'find_sprite_candidates', 'find_sound_candidates',
            'write_localisation', 'write_design_blueprint', 'get_pdx_block',
        ]);

        const paradoxPlan = filterToolDefinitionsForMode(registeredTools, 'plan', { domain: 'paradox' })
            .map(tool => tool.function.name);
        expect(paradoxPlan).to.include.members(['query_cwt_schema', 'query_scope', 'query_types', 'mcp_call']);

        const legacyGeneral = filterToolDefinitionsForMode(registeredTools, 'utility', {
            domain: 'general',
            legacyFullToolset: true,
        }).map(tool => tool.function.name);
        expect(legacyGeneral).to.not.include('query_cwt_schema');
        expect(legacyGeneral).to.include('mcp_call');

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
        expect(validateToolAccess('mcp_call', { mode: 'utility', domain: 'general' }).allowed).to.equal(true);
        expect(validateToolAccess('mcp_filesystem_read_file', { mode: 'utility', domain: 'general' }).allowed).to.equal(true);
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
        expect(discovery).to.include.members(['read_file', 'run_code']);
        expect(discovery).to.not.include('write_file');
        expect(advanceToolStage('utility', 'discovery', 'read_file', { success: true })).to.equal('write');
        expect(advanceToolStage('utility', 'write', 'edit_file', { success: false })).to.equal('write');
        expect(advanceToolStage('utility', 'write', 'edit_file', { success: true })).to.equal('finalize');
        const finalize = filterToolDefinitionsForStage(toolDefinitions, 'utility', 'finalize').map(t => t.function.name);
        expect(finalize).to.include.members(['read_file', 'run_command', 'write_file']);
    });

    it('keeps a read-only utility validation surface available for dynamic planning', () => {
        const modeTools = filterToolDefinitionsForMode(registeredTools, 'utility', { domain: 'general' });
        const validation = filterToolDefinitionsForStage(modeTools, 'utility', 'validation')
            .map(tool => tool.function.name);
        expect(validation).to.include.members(['read_file', 'get_diagnostics', 'todo_write', 'run_code']);
        expect(validation).to.not.include.members(['write_file', 'edit_file', 'run_command']);
    });

    it('keeps localisation modes off generic yml patch paths', () => {
        const filtered = filterToolDefinitionsForMode(toolDefinitions, 'loc_writer', { useSlimPrompt: true });
        const names = filtered.map(t => t.function.name);
        expect(names).to.include('write_localisation');
        expect(names).to.include('write_file');
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

    it('keeps explicitly loaded tools visible even when their stage pool omits them', () => {
        // A write-authorized continuation starts at discovery; after select_tools
        // loads edit_file, the visible pool must include it even though the
        // discovery stage pool does not.
        const buildTools = filterToolDefinitionsForMode(registeredTools, 'build', { domain: 'general' });
        const discoveryBase = filterToolDefinitionsForStage(buildTools, 'build', 'discovery');
        expect(discoveryBase.map(tool => tool.function.name)).to.not.include('edit_file');

        const loaded = new Set(['edit_file', 'replace_lines']);
        const visible = extendStageToolPoolWithSupport(discoveryBase, buildTools, 'build', 'discovery', loaded)
            .map(tool => tool.function.name);
        expect(visible).to.include('edit_file');
        expect(visible).to.include('replace_lines');
    });

    it('detects truncation-induced stops without flagging ordinary prose or questions', () => {
        // 问题 3 的实际案例:模型把展示截断误读为部分应用而中止。
        expect(isTruncationInducedStop(
            '由于本轮工具调用在大型差异预览和诊断结果上发生截断，不能安全继续批量替换，否则可能破坏整个脚本文件。',
        )).to.equal(true);
        expect(isTruncationInducedStop(
            '由于当前剩余诊断被工具截断，继续盲目批量删除会有破坏脚本行为和括号结构的风险；本轮已完成所有能被明确验证并安全修复的核心问题。',
        )).to.equal(true);
        expect(isTruncationInducedStop(
            'The remaining diagnostics were truncated, so I cannot safely continue batch replacements without risking the script file.',
        )).to.equal(true);

        // 普通散文和无截断词的文本不得触发。
        expect(isTruncationInducedStop('计划已分析完成，需要你确认目标范围后才能继续。')).to.equal(false);
        expect(isTruncationInducedStop('需要确认错误文件清单后才能继续')).to.equal(false);
        expect(isTruncationInducedStop('已完成全部修复并通过验证。')).to.equal(false);
        expect(isTruncationInducedStop('')).to.equal(false);
    });
});
