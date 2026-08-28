import { expect } from 'chai';
import { AgentSessionCoordinator } from '../../extension/ai/agentSessionCoordinator';
import { executionModeForSchedulingState, schedulingStateFromAdmission } from '../../extension/ai/runner/scheduling';
import type { AgentArtifact, AgentRuntimeDomain, AgentSchedulingState } from '../../extension/ai/types';

function schedulingState(
    domainProfile: AgentRuntimeDomain,
    authorization: 'read_only' | 'plan_write_only' | 'workspace_write',
    phase: 'inspect' | 'plan' | 'execute' | 'verify',
): AgentSchedulingState {
    return schedulingStateFromAdmission({
        domainProfile,
        authorization,
        initialPhase: phase,
        explicitDelegation: false,
        confidence: 1,
        evidence: ['test'],
    });
}

describe('AgentSessionCoordinator', () => {
    it('starts with one canonical scheduling state', () => {
        const session = new AgentSessionCoordinator();
        expect(executionModeForSchedulingState(session.schedulingState)).to.equal('build');
        expect(session.schedulingState).to.include({ domainProfile: 'paradox', authorization: 'workspace_write', phase: 'execute' });
        expect(session.currentWorkflowId).to.equal(null);
        expect(session.liveSteps).to.deep.equal([]);
        expect(session.isGenerating).to.equal(false);
    });

    it('stores mutable session data without exposing scheduler snapshots by reference', () => {
        const session = new AgentSessionCoordinator();
        const artifact: AgentArtifact = { id: 'a1', kind: 'plan', title: 'Plan', createdAt: 1 };
        session.schedulingState = schedulingState('general', 'read_only', 'verify');
        session.liveSteps = [{ type: 'thinking', content: 'drafting', timestamp: 1 }];
        session.isGenerating = true;
        session.artifacts = new Map([[artifact.id, artifact]]);

        const snapshot = session.schedulingState;
        snapshot.routeEvidence.push('mutated');
        expect(session.schedulingState.routeEvidence).to.deep.equal(['test']);
        expect(executionModeForSchedulingState(session.schedulingState)).to.equal('review');
        expect(session.artifacts.get('a1')?.title).to.equal('Plan');
    });

    it('restores the original scheduler after switching workflows', () => {
        const session = new AgentSessionCoordinator();
        session.schedulingState = schedulingState('general', 'workspace_write', 'execute');

        session.activateWorkflow(
            'diagnostic-fix',
            schedulingState('paradox', 'workspace_write', 'execute'),
        );
        session.activateWorkflow(
            'event-chain-design',
            schedulingState('paradox', 'plan_write_only', 'plan'),
        );

        expect(session.currentWorkflowId).to.equal('event-chain-design');
        expect(executionModeForSchedulingState(session.schedulingState)).to.equal('plan');
        expect(session.deactivateWorkflow()).to.equal(true);
        expect(session.currentWorkflowId).to.equal(null);
        expect(executionModeForSchedulingState(session.schedulingState)).to.equal('utility');
    });

    it('does not alter state when no workflow is active', () => {
        const session = new AgentSessionCoordinator();
        session.schedulingState = schedulingState('paradox', 'read_only', 'verify');
        expect(session.deactivateWorkflow()).to.equal(false);
        expect(executionModeForSchedulingState(session.schedulingState)).to.equal('script_reviewer');
    });
});
