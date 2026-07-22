import { expect } from 'chai';
import { AgentSessionCoordinator } from '../../extension/ai/agentSessionCoordinator';
import type { AgentArtifact } from '../../extension/ai/types';

describe('AgentSessionCoordinator', () => {
    it('starts with expected defaults', () => {
        const session = new AgentSessionCoordinator();

        expect(session.currentMode).to.equal('build');
        expect(session.previousMode).to.equal('build');
        expect(session.currentWorkflowId).to.equal(null);
        expect(session.agentProfile).to.deep.equal({ domain: 'auto', intent: 'auto', strategy: 'auto' });
        expect(session.previousAgentProfile).to.deep.equal({ domain: 'auto', intent: 'auto', strategy: 'auto' });
        expect(session.liveSteps).to.deep.equal([]);
        expect(session.isGenerating).to.equal(false);
        expect([...session.artifacts.values()]).to.deep.equal([]);
    });

    it('stores and returns mutable session state', () => {
        const session = new AgentSessionCoordinator();
        const artifact: AgentArtifact = {
            id: 'a1',
            kind: 'plan',
            title: 'Plan',
            createdAt: 1,
        };
        const artifacts = new Map<string, AgentArtifact>([[artifact.id, artifact]]);

        session.currentMode = 'plan';
        session.previousMode = 'build';
        session.currentWorkflowId = 'workflow.plan';
        session.agentProfile = { domain: 'general', intent: 'execute', strategy: 'multi' };
        session.previousAgentProfile = { domain: 'auto', intent: 'review', strategy: 'single' };
        session.liveSteps = [{ type: 'thinking', content: 'drafting', timestamp: 1 }];
        session.isGenerating = true;
        session.artifacts = artifacts;

        expect(session.currentMode).to.equal('plan');
        expect(session.previousMode).to.equal('build');
        expect(session.currentWorkflowId).to.equal('workflow.plan');
        expect(session.agentProfile).to.deep.equal({ domain: 'general', intent: 'execute', strategy: 'multi' });
        expect(session.previousAgentProfile).to.deep.equal({ domain: 'auto', intent: 'review', strategy: 'single' });
        expect(session.liveSteps).to.have.length(1);
        expect(session.isGenerating).to.equal(true);
        expect(session.artifacts.get('a1')?.title).to.equal('Plan');
    });

    it('returns profile copies so turn and workflow snapshots cannot be mutated indirectly', () => {
        const session = new AgentSessionCoordinator();
        session.agentProfile = { domain: 'general', intent: 'execute', strategy: 'single' };
        const snapshot = session.agentProfile;
        snapshot.domain = 'paradox';
        expect(session.agentProfile.domain).to.equal('general');
    });

    it('restores the original profile and mode after switching between workflows', () => {
        const session = new AgentSessionCoordinator();
        session.currentMode = 'utility';
        session.agentProfile = { domain: 'general', intent: 'execute', strategy: 'single' };

        session.activateWorkflow(
            'diagnostic-fix',
            'build',
            { domain: 'paradox', intent: 'execute', strategy: 'single' },
        );
        session.activateWorkflow(
            'event-chain-design',
            'plan',
            { domain: 'auto', intent: 'plan', strategy: 'single' },
        );

        expect(session.currentWorkflowId).to.equal('event-chain-design');
        expect(session.previousMode).to.equal('utility');
        expect(session.previousAgentProfile).to.deep.equal({ domain: 'general', intent: 'execute', strategy: 'single' });
        expect(session.deactivateWorkflow()).to.equal(true);
        expect(session.currentWorkflowId).to.equal(null);
        expect(session.currentMode).to.equal('utility');
        expect(session.agentProfile).to.deep.equal({ domain: 'general', intent: 'execute', strategy: 'single' });
    });

    it('does not alter the selected profile when no workflow is active', () => {
        const session = new AgentSessionCoordinator();
        session.currentMode = 'review';
        session.agentProfile = { domain: 'paradox', intent: 'review', strategy: 'single' };

        expect(session.deactivateWorkflow()).to.equal(false);
        expect(session.currentMode).to.equal('review');
        expect(session.agentProfile).to.deep.equal({ domain: 'paradox', intent: 'review', strategy: 'single' });
    });
});
