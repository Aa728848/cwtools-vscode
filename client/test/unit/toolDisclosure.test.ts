import { expect } from 'chai';
import { sortToolDefinitionsForStableRequest, ToolDisclosureService, type ToolDisclosureContext } from '../../extension/ai/runner/toolDisclosure';
import type { AgentMode, AgentRuntimeDomain } from '../../extension/ai/types';

const service = new ToolDisclosureService();

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
    it('reports stage-hidden deferred tools as unavailable without deferStageGating', () => {
        const result = service.select(
            { tools: ['edit_file', 'replace_lines', 'get_goal'], reason: 'test' },
            [],
            context('build'),
        );
        expect(result.loaded).to.deep.equal([]);
        expect(result.unavailable).to.include('edit_file');
        expect(result.unavailable).to.include('replace_lines');
        // Non-deferred tools are already visible and are not "loaded" again.
        expect(result.alreadyLoaded).to.include('get_goal');
    });

    it('loads stage-hidden but mode-allowed tools when deferStageGating is enabled', () => {
        const ctx = context('build');
        const result = service.select(
            { tools: ['edit_file', 'replace_lines'], reason: 'continue task' },
            [],
            ctx,
            { deferStageGating: true },
        );
        expect(result.loaded).to.include('edit_file');
        expect(result.loaded).to.include('replace_lines');
        expect(result.unavailable).to.deep.equal([]);
        expect(ctx.loaded.has('edit_file')).to.equal(true);
        expect(ctx.loaded.has('replace_lines')).to.equal(true);
    });

    it('never lifts mode or domain denials through deferStageGating', () => {
        // explore mode does not allow edit_file → denied, not loaded.
        const exploreCtx = context('explore');
        const modeDenied = service.select(
            { tools: ['edit_file'], reason: 'test' },
            [],
            exploreCtx,
            { deferStageGating: true },
        );
        expect(modeDenied.denied).to.include('edit_file');
        expect(modeDenied.loaded).to.deep.equal([]);
        expect(exploreCtx.loaded.has('edit_file')).to.equal(false);

        // Stage-disclosure Paradox tools are never added to `loaded` in a
        // General Coding run — deferStageGating only affects deferred tools
        // that are mode- and domain-allowed.
        const generalCtx = context('build');
        const paradoxStage = service.select(
            { tools: ['query_types'], reason: 'test' },
            [],
            generalCtx,
            { deferStageGating: true },
        );
        expect(paradoxStage.loaded).to.deep.equal([]);
        expect(generalCtx.loaded.has('query_types')).to.equal(false);
    });

    it('keeps unknown tool names unknown regardless of deferStageGating', () => {
        const result = service.select(
            { tools: ['does_not_exist'], reason: 'test' },
            [],
            context('build'),
            { deferStageGating: true },
        );
        expect(result.unknown).to.include('does_not_exist');
        expect(result.loaded).to.deep.equal([]);
    });
});
