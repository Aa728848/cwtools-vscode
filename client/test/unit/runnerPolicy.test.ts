import { expect } from 'chai';
import {
    buildToolFocusReminder,
    filterToolDefinitionsForMode,
    finalResponseRequiresUserInput,
    initialToolFocusForMode,
    isExecutionActionTool,
    isTruncationInducedStop,
    resolveCompactionOutputReserve,
    resolveContextSafeOutputTokens,
    resolveMaxToolIterations,
    resolveRunMaxOutputTokens,
    shouldAutoDiscloseExecutionTools,
    shouldContinueAuthorizedExecution,
    shouldRenewIterationLimit,
    SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS,
    TOP_LEVEL_ITERATION_SAFETY_CAP,
} from '../../extension/ai/runnerPolicy';
import type { ToolDefinition } from '../../extension/ai/types';
import { TOOL_DEFINITIONS as registeredTools, TOOL_REGISTRY } from '../../extension/ai/tools/registry';
import { validateToolCapability } from '../../extension/ai/tools/permissions';
import { toolDisclosureService } from '../../extension/ai/runner/toolDisclosure';

const toolDefinitions = [
    'ask_user_question', 'select_tools', 'read_file', 'replace_lines', 'query_workspace_index',
    'dispatch_agents', 'query_blackboard', 'mcp_call', 'run_command',
    'write_file', 'write_localisation', 'run_code',
].map(name => ({
    type: 'function',
    function: { name, description: '', parameters: {} },
})) as ToolDefinition[];

describe('runnerPolicy', () => {
    it('keeps initial disclosure compact without narrowing the eligible pool', () => {
        const modes = [
            'build', 'plan', 'explore', 'utility', 'review',
            'gui_expert', 'script_reviewer', 'loc_translator', 'loc_writer',
            'orchestrator', 'script',
        ] as const;
        for (const mode of modes) {
            const domain = mode === 'utility' || mode === 'orchestrator'
                ? 'general'
                : 'paradox';
            const eligible = filterToolDefinitionsForMode(registeredTools, mode, { domain });
            const visible = toolDisclosureService.initialTools(eligible, {
                mode,
                domain,
                dynamicSupported: true,
                loaded: new Set(),
            });
            const tokens = visible.reduce((total, tool) =>
                total + (TOOL_REGISTRY.get(tool.function.name as any)?.estimatedSchemaTokens ?? 0), 0);
            expect(visible.length, `${mode} visible tools`).to.be.at.most(18);
            expect(tokens, `${mode} visible schema tokens`).to.be.lessThan(4_500);
        }
    });

    it('keeps the mode policy authoritative for execution capabilities', () => {
        const build = filterToolDefinitionsForMode(toolDefinitions, 'build').map(tool => tool.function.name);
        expect(build).to.include.members(['read_file', 'replace_lines', 'dispatch_agents', 'mcp_call']);

        for (const mode of ['plan', 'explore', 'review'] as const) {
            const names = filterToolDefinitionsForMode(registeredTools, mode).map(tool => tool.function.name);
            expect(initialToolFocusForMode(mode)).to.equal('discovery');
            expect(names).to.include('read_file');
            expect(names).to.not.include.members(['write_file', 'replace_lines', 'write_localisation']);
        }
        expect(initialToolFocusForMode('build')).to.equal('write');
        expect(initialToolFocusForMode('utility')).to.equal('write');
    });

    it('uses focus only as advisory guidance', () => {
        const reminder = buildToolFocusReminder('build', 'validation');
        expect(reminder).to.include('Current build focus: validation');
        expect(reminder).to.include('advisory');
        expect(reminder).to.include('select_tools');
        expect(reminder).to.not.include('Only these stage tools');
        expect(buildToolFocusReminder('build', undefined)).to.equal('');
    });

    it('auto-discloses and continues execution from authorization, not stage', () => {
        for (const mode of ['build', 'utility', 'gui_expert', 'loc_translator', 'loc_writer', 'orchestrator', 'script'] as const) {
            expect(shouldAutoDiscloseExecutionTools(mode, 'workspace_write'), mode).to.equal(true);
        }
        for (const mode of ['plan', 'explore', 'review', 'script_reviewer'] as const) {
            expect(shouldAutoDiscloseExecutionTools(mode, 'workspace_write'), mode).to.equal(false);
        }
        expect(shouldAutoDiscloseExecutionTools('build', 'read_only')).to.equal(false);
        expect(shouldContinueAuthorizedExecution('build', 'workspace_write', false)).to.equal(true);
        expect(shouldContinueAuthorizedExecution('build', 'workspace_write', true)).to.equal(false);
        expect(shouldContinueAuthorizedExecution('plan', 'workspace_write', false)).to.equal(false);
    });

    it('keeps guard decisions at the effective mode/domain boundary', () => {
        for (const mode of ['utility', 'plan', 'explore', 'review', 'orchestrator'] as const) {
            const leaked = filterToolDefinitionsForMode(registeredTools, mode, { domain: 'general' })
                .map(tool => TOOL_REGISTRY.get(tool.function.name as any))
                .filter(entry => entry?.domain === 'paradox')
                .map(entry => entry!.name);
            expect(leaked, `${mode} leaked Paradox tools`).to.deep.equal([]);
        }
        expect(validateToolCapability('query_cwt_schema', { mode: 'utility', domain: 'general' }).allowed).to.equal(false);
        expect(validateToolCapability('write_localisation', { mode: 'utility', domain: 'general' }).allowed).to.equal(false);
        expect(validateToolCapability('mcp_call', { mode: 'utility', domain: 'general' }).allowed).to.equal(true);
        expect(validateToolCapability('run_command', {
            mode: 'utility', domain: 'general', isSubAgent: true, profileName: 'general-coder',
        }).allowed).to.equal(true);
        expect(validateToolCapability('run_command', {
            mode: 'build', domain: 'paradox', isSubAgent: true,
        }).allowed).to.equal(false);
        const utilityChildTools = filterToolDefinitionsForMode(toolDefinitions, 'utility', {
            domain: 'general',
            useSlimPrompt: true,
            profileName: 'general-coder',
        }).map(tool => tool.function.name);
        expect(utilityChildTools).to.include('run_command');
        expect(utilityChildTools).to.not.include('ask_user_question');
    });

    it('registers only current source editors and keeps specialised writes scoped', () => {
        const names = registeredTools.map(tool => tool.function.name);
        expect(names).to.not.include.members(['apply_patch', 'multi_replace_file_content', 'edit_pdx_block']);
        for (const name of ['write_file', 'edit_file', 'replace_lines'] as const) {
            expect(TOOL_REGISTRY.get(name)?.domain, name).to.equal('shared');
        }
        expect(TOOL_REGISTRY.get('write_localisation')?.domain).to.equal('paradox');

        const locWriter = filterToolDefinitionsForMode(toolDefinitions, 'loc_writer', { useSlimPrompt: true })
            .map(tool => tool.function.name);
        expect(locWriter).to.include.members(['write_localisation', 'write_file']);
        expect(locWriter).to.not.include('replace_lines');
    });

    it('distinguishes execution, clarification, and truncation stops', () => {
        expect(isExecutionActionTool('write_file')).to.equal(true);
        expect(isExecutionActionTool('run_command')).to.equal(true);
        expect(isExecutionActionTool('dispatch_agents')).to.equal(true);
        expect(isExecutionActionTool('write_design_blueprint')).to.equal(false);
        expect(isExecutionActionTool('read_file')).to.equal(false);
        expect(finalResponseRequiresUserInput(
            'I cannot safely modify the project without a concrete target. Please specify the desired change.',
        )).to.equal(true);
        expect(finalResponseRequiresUserInput('Implementation and verification are complete.')).to.equal(false);
        expect(isTruncationInducedStop(
            'The remaining diagnostics were truncated, so I cannot safely continue batch replacements.',
        )).to.equal(true);
        expect(isTruncationInducedStop('All fixes passed validation.')).to.equal(false);
    });

    it('bounds output, context reserve, and loop resources', () => {
        expect(resolveRunMaxOutputTokens()).to.equal(undefined);
        expect(resolveRunMaxOutputTokens({ useSlimPrompt: true })).to.equal(SLIM_SUB_AGENT_MAX_OUTPUT_TOKENS);
        expect(resolveContextSafeOutputTokens({
            desiredTokens: 400_000,
            contextLimit: 1_000_000,
            promptTokens: 600_000,
            safetyMarginTokens: 4_096,
        })).to.equal(395_904);
        expect(resolveCompactionOutputReserve(384_000, 1_000_000)).to.equal(250_000);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128_000 })).to.equal(TOP_LEVEL_ITERATION_SAFETY_CAP);
        expect(TOP_LEVEL_ITERATION_SAFETY_CAP).to.equal(256);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128_000, isSubAgent: true })).to.equal(40);
        expect(resolveMaxToolIterations({ mode: 'build', baseContextLimit: 128_000, override: 10_000 })).to.equal(256);
    });

    it('renews only healthy explicitly renewable iteration windows', () => {
        expect(shouldRenewIterationLimit({ renewable: true, iteration: 40, limit: 40, consecutiveErrors: 0, blockingValidationIssues: 0 })).to.equal(true);
        expect(shouldRenewIterationLimit({ renewable: false, iteration: 40, limit: 40, consecutiveErrors: 0, blockingValidationIssues: 0 })).to.equal(false);
        expect(shouldRenewIterationLimit({ renewable: true, iteration: 40, limit: 40, consecutiveErrors: 1, blockingValidationIssues: 0 })).to.equal(false);
    });
});
