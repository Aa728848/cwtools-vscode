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

    it('keeps the pre-override scheduler so an explicit override can be undone', () => {
        const session = new AgentSessionCoordinator();
        session.previousSchedulingState = schedulingState('general', 'workspace_write', 'execute');

        session.schedulingState = schedulingState('paradox', 'plan_write_only', 'plan');
        expect(executionModeForSchedulingState(session.schedulingState)).to.equal('plan');

        // Restoring is a plain assignment: the stored snapshot survives untouched
        // while the live state moved on, which is what approving a walkthrough
        // relies on to hand the scheduler back to the user-owned state.
        session.schedulingState = session.previousSchedulingState;
        expect(executionModeForSchedulingState(session.schedulingState)).to.equal('utility');
        expect(session.previousSchedulingState.domainProfile).to.equal('general');
    });

    it('pins the user-owned task mode independently of the scheduler', () => {
        const session = new AgentSessionCoordinator();
        expect(session.modeOverride).to.equal('auto');
        session.modeOverride = 'plan';
        session.schedulingState = schedulingState('paradox', 'read_only', 'verify');
        expect(session.modeOverride).to.equal('plan');
        expect(executionModeForSchedulingState(session.schedulingState)).to.equal('script_reviewer');
    });
});
