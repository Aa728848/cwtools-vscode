import { expect } from 'chai';
import {
    AdaptiveConcurrencyController,
    authorizationAllowsEffect,
    executionModeForSchedulingState,
    normalizeSchedulingState,
    schedulingStateFromAdmission,
    transitionSchedulingState,
} from '../../extension/ai/runner/scheduling';
import { AgentInputQueue } from '../../extension/ai/runner/inputQueue';

describe('Agent runtime scheduling', () => {
    it('projects execution labels without creating a second persisted state', () => {
        const state = schedulingStateFromAdmission({
            domainProfile: 'paradox', authorization: 'workspace_write', initialPhase: 'execute',
            explicitDelegation: false, confidence: 1, evidence: ['test'],
        });
        expect(state).to.include({
            domainProfile: 'paradox',
            authorization: 'workspace_write',
            phase: 'execute',
            dispatch: 'single',
        });
        expect(executionModeForSchedulingState(state)).to.equal('build');
    });

    it('rejects missing or invalid scheduling state and migrates legacy domain/dispatch', () => {
        expect(() => normalizeSchedulingState(undefined)).to.throw('required');
        expect(() => normalizeSchedulingState({
            domainProfile: 'general',
            authorization: 'root',
            phase: 'execute',
            dispatch: 'single',
        })).to.throw('invalid');
        const restored = normalizeSchedulingState({
            profileName: 'reviewer',
            domainProfile: 'general',
            authorization: 'read_only',
            phase: 'execute',
            dispatch: 'single',
            overlays: [],
            routeConfidence: 1,
            routeEvidence: [],
            phaseReason: 'test',
            revision: 0,
        });
        expect(restored).to.include({
            domainProfile: 'paradox', authorization: 'read_only', phase: 'execute', dispatch: 'single',
        });
    });

    it('degrades a persisted routingSource:workflow to unknown instead of throwing', () => {
        const legacy = normalizeSchedulingState({
            profileName: 'paradox-agent',
            domainProfile: 'paradox',
            authorization: 'workspace_write',
            phase: 'execute',
            dispatch: 'single',
            overlays: [],
            routeConfidence: 1,
            routeEvidence: [],
            routingSource: 'workflow',
            phaseReason: 'AI workflow diagnostic-fix active',
            revision: 3,
        });
        expect(legacy.routingSource).to.equal(undefined);
        expect(legacy).to.include({ domainProfile: 'paradox', phase: 'execute', revision: 3 });

        for (const source of ['model', 'deterministic', 'user'] as const) {
            expect(normalizeSchedulingState({ ...legacy, routingSource: source }).routingSource).to.equal(source);
        }

        expect(() => normalizeSchedulingState({ ...legacy, routingSource: 'telepathy' })).to.throw('invalid');
    });

    it('never expands authorization during a runtime transition', () => {
        const readOnly = schedulingStateFromAdmission({
            domainProfile: 'paradox', authorization: 'read_only', initialPhase: 'verify',
            explicitDelegation: false, confidence: 1, evidence: ['test'],
        });
        expect(() => transitionSchedulingState(readOnly, {
            phase: 'execute',
            authorization: 'workspace_write',
            reason: 'invalid expansion',
        })).to.throw('cannot expand authorization');
    });

    it('allows read-only internal state while blocking external mutation effects', () => {
        expect(authorizationAllowsEffect('read_only', 'none', true)).to.equal(true);
        expect(authorizationAllowsEffect('read_only', 'memory', true)).to.equal(true);
        expect(authorizationAllowsEffect('read_only', 'workspace_write', true)).to.equal(false);
        expect(authorizationAllowsEffect('read_only', 'git', false)).to.equal(false);
    });

    it('contracts provider capacity on rate limits and recovers after stability', () => {
        const capacity = new AdaptiveConcurrencyController(4, 1, 2);
        expect(capacity.onRateLimit()).to.deep.equal({ previous: 4, current: 2 });
        expect(capacity.onSuccess()).to.deep.equal({ previous: 2, current: 2 });
        expect(capacity.onSuccess()).to.deep.equal({ previous: 2, current: 3 });
    });

    it('orders queued input by semantic priority while retaining FIFO within a kind', () => {
        const queue = new AgentInputQueue('run_1');
        queue.enqueue('later', undefined, undefined, 'pending');
        queue.enqueue('steer 1', undefined, undefined, 'steer');
        queue.enqueue('approve', undefined, undefined, 'approval', 'op_1');
        queue.enqueue('steer 2', undefined, undefined, 'steer');
        expect(queue.drain().map(item => item.message)).to.deep.equal([
            'approve', 'steer 1', 'steer 2', 'later',
        ]);
    });

});
