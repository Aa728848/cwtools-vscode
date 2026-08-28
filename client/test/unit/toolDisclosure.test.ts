import { expect } from 'chai';
import { sortToolDefinitionsForStableRequest, ToolDisclosureService, type ToolDisclosureContext } from '../../extension/ai/runner/toolDisclosure';
import { TOOL_DEFINITIONS } from '../../extension/ai/tools/definitions';
import type { AgentMode, AgentRuntimeDomain } from '../../extension/ai/types';

const service = new ToolDisclosureService();
const eligibleTool = (name: string) => ({
    type: 'function' as const,
    function: { name, description: '', parameters: { type: 'object', properties: {} } },
});

function context(
    mode: AgentMode,
    domain: AgentRuntimeDomain = 'general',
    loaded: string[] = [],
): ToolDisclosureContext {
    return { mode, domain, dynamicSupported: true, loaded: new Set(loaded) };
}

describe('toolDisclosure', () => {
    it('sorts model-visible schemas deterministically by name', () => {
        const makeTool = (name: string) => ({
            type: 'function' as const,
            function: { name, description: '', parameters: { type: 'object', properties: {} } },
        });
        expect(sortToolDefinitionsForStableRequest([makeTool('z'), makeTool('a')])
            .map(tool => tool.function.name)).to.deep.equal(['a', 'z']);
    });
    it('reports tools excluded by the effective workflow pool as unavailable', () => {
        const result = service.select(
            { tools: ['edit_file', 'replace_lines', 'manage_goal'], reason: 'test' },
            [],
            context('build'),
        );
        expect(result.loaded).to.deep.equal([]);
        expect(result.unavailable).to.include('edit_file');
        expect(result.unavailable).to.include('replace_lines');
        // Always-disclosed tools absent from the effective pool are not falsely
        // reported as already visible.
        expect(result.unavailable).to.include('manage_goal');
        expect(result.alreadyLoaded).to.deep.equal([]);
    });

    it('loads deferred tools from the effective mode/domain/workflow pool', () => {
        const ctx = context('build');
        const result = service.select(
            { tools: ['edit_file', 'replace_lines'], reason: 'continue task' },
            [],
            ctx,
            { eligibleTools: [eligibleTool('edit_file'), eligibleTool('replace_lines')] },
        );
        expect(result.loaded).to.include('edit_file');
        expect(result.loaded).to.include('replace_lines');
        expect(result.unavailable).to.deep.equal([]);
        expect(ctx.loaded.has('edit_file')).to.equal(true);
        expect(ctx.loaded.has('replace_lines')).to.equal(true);
    });

    it('reveals advisory blueprint sections without nested completeness requirements', () => {
        const blueprint = TOOL_DEFINITIONS.find(tool => tool.function.name === 'write_design_blueprint')!;
        const ctx = context('plan', 'paradox');
        const selected = service.select(
            { tools: ['write_design_blueprint'], reason: 'author connected design' },
            [blueprint],
            ctx,
            { eligibleTools: [blueprint] },
        );
        const [revealed] = service.initialTools([blueprint], ctx);

        expect(selected.loaded).to.deep.equal(['write_design_blueprint']);
        expect(revealed?.function.parameters.required).to.deep.equal(['title']);
        const properties = revealed?.function.parameters.properties as Record<string, any>;
        expect(properties.entities.items.required).to.equal(undefined);
        expect(properties.featureManifest.required).to.equal(undefined);
        expect(properties.taskPlan.items.required).to.equal(undefined);
        expect(JSON.stringify(revealed).length).to.be.greaterThan(1_500);
        expect(TOOL_DEFINITIONS.some(tool => tool.function.name === 'get_design_blueprint_contract')).to.equal(false);
    });

    it('never lifts mode or domain denials through dynamic disclosure', () => {
        // explore mode does not allow edit_file → denied, not loaded.
        const exploreCtx = context('explore');
        const modeDenied = service.select(
            { tools: ['edit_file'], reason: 'test' },
            [],
            exploreCtx,
            { eligibleTools: [eligibleTool('edit_file')] },
        );
        expect(modeDenied.denied).to.include('edit_file');
        expect(modeDenied.loaded).to.deep.equal([]);
        expect(exploreCtx.loaded.has('edit_file')).to.equal(false);

        // Domain-specific schemas remain denied in a General Coding run.
        const generalCtx = context('build');
        const paradoxSelection = service.select(
            { tools: ['query_types'], reason: 'test' },
            [],
            generalCtx,
            { eligibleTools: [eligibleTool('query_types')] },
        );
        expect(paradoxSelection.loaded).to.deep.equal([]);
        expect(generalCtx.loaded.has('query_types')).to.equal(false);
    });

    it('keeps unknown tool names unknown', () => {
        const result = service.select(
            { tools: ['does_not_exist'], reason: 'test' },
            [],
            context('build'),
            { eligibleTools: [] },
        );
        expect(result.unknown).to.include('does_not_exist');
        expect(result.loaded).to.deep.equal([]);
    });
});
