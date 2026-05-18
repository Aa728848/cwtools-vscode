import { expect } from 'chai';
import { AgentSessionCoordinator } from '../../extension/ai/agentSessionCoordinator';
import type { AgentArtifact } from '../../extension/ai/types';

describe('AgentSessionCoordinator', () => {
    it('starts with expected defaults', () => {
        const session = new AgentSessionCoordinator();

        expect(session.currentMode).to.equal('build');
        expect(session.previousMode).to.equal('build');
        expect(session.currentWorkflowId).to.equal(null);
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
        session.liveSteps = [{ type: 'thinking', content: 'drafting', timestamp: 1 }];
        session.isGenerating = true;
        session.artifacts = artifacts;

        expect(session.currentMode).to.equal('plan');
        expect(session.previousMode).to.equal('build');
        expect(session.currentWorkflowId).to.equal('workflow.plan');
        expect(session.liveSteps).to.have.length(1);
        expect(session.isGenerating).to.equal(true);
        expect(session.artifacts.get('a1')?.title).to.equal('Plan');
    });
});
