import { expect } from 'chai';
import {
    DEFAULT_AGENT_PROFILE,
    isAgentProfileSelection,
    profileForLegacyMode,
    resolveAgentProfile,
} from '../../extension/ai/agentProfile';

describe('agent profile', () => {
    it('validates all three user-facing dimensions at the boundary', () => {
        expect(isAgentProfileSelection(DEFAULT_AGENT_PROFILE)).to.equal(true);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'execute', strategy: 'multi' })).to.equal(true);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'build', strategy: 'multi' })).to.equal(false);
        expect(isAgentProfileSelection({ domain: 'general', intent: 'execute' })).to.equal(false);
    });

    it('honors explicit dimensions while resolving Auto dimensions', () => {
        const resolved = resolveAgentProfile('Review this event chain', {
            domain: 'general', intent: 'auto', strategy: 'single',
        });
        expect(resolved).to.include({ domain: 'general', intent: 'review', strategy: 'single', mode: 'review' });
    });

    it('resolves Auto independently for every turn', () => {
        expect(resolveAgentProfile('Explain this Python API').mode).to.equal('explore');
        expect(resolveAgentProfile('Implement a new scripted effect').mode).to.equal('build');
        expect(resolveAgentProfile('Review the TypeScript cancellation logic').mode).to.equal('review');
    });

    it('uses one Paradox agent for narrow writes and Paradox Multi-Agent for broad writes', () => {
        expect(resolveAgentProfile('修复这个 CWT 诊断报错').mode).to.equal('build');
        expect(resolveAgentProfile('Add one scripted_modifier to this Stellaris mod').mode).to.equal('build');
        expect(resolveAgentProfile('Fix all localisation errors in this Stellaris mod').mode).to.equal('script');
    });

    it('separates general coding from Paradox coordination', () => {
        expect(resolveAgentProfile('Create a Python converter for this CSV file').mode).to.equal('utility');
        expect(resolveAgentProfile('Use multiple agents to refactor this TypeScript API').mode).to.equal('orchestrator');
        expect(resolveAgentProfile('Use multiple agents to repair this Stellaris event chain').mode).to.equal('script');
    });

    it('lets explicit general-code semantics override an unrelated active Paradox file', () => {
        const resolved = resolveAgentProfile('Fix the TypeScript webview state handling', undefined, {
            activeFile: 'events/example.txt',
        });
        expect(resolved.domain).to.equal('general');
        expect(resolved.mode).to.equal('utility');
    });

    it('treats Paradox Agent implementation work as repository coding', () => {
        const resolved = resolveAgentProfile('Fix the TypeScript routing for the Paradox Agent webview');
        expect(resolved.domain).to.equal('general');
        expect(resolved.mode).to.equal('utility');
    });

    it('keeps implementation-only legacy roles out of the user-facing profile', () => {
        expect(profileForLegacyMode('loc_writer')).to.deep.equal({ domain: 'paradox', intent: 'execute', strategy: 'single' });
        expect(profileForLegacyMode('script_reviewer')).to.deep.equal({ domain: 'auto', intent: 'review', strategy: 'single' });
        expect(profileForLegacyMode('orchestrator')).to.deep.equal({ domain: 'general', intent: 'execute', strategy: 'multi' });
    });
});
