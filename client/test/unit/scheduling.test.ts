import { expect } from 'chai';
import {
    AdaptiveConcurrencyController,
    authorizationAllowsEffect,
    executionModeForSchedulingState,
    evaluateDispatchAdmission,
    normalizeSchedulingState,
    schedulingStateFromAdmission,
    transitionSchedulingState,
} from '../../extension/ai/runner/scheduling';
import { AgentInputQueue } from '../../extension/ai/runner/inputQueue';

describe('Agent runtime scheduling', () => {
    it('projects execution labels without creating a second persisted state', () => {
        const state = schedulingStateFromAdmission({
            domainProfile: 'general', authorization: 'workspace_write', initialPhase: 'execute',
            explicitDelegation: false, confidence: 1, evidence: ['test'],
        });
        expect(state).to.include({
            domainProfile: 'general',
            authorization: 'workspace_write',
            phase: 'execute',
            dispatch: 'single',
        });
        expect(executionModeForSchedulingState(state)).to.equal('utility');
        expect(executionModeForSchedulingState({ ...state, dispatch: 'parallel' })).to.equal('orchestrator');
    });

    it('rejects missing or invalid scheduling state instead of reconstructing it', () => {
        expect(() => normalizeSchedulingState(undefined)).to.throw('required');
        expect(() => normalizeSchedulingState({
            domainProfile: 'general',
            authorization: 'root',
            phase: 'execute',
            dispatch: 'single',
        })).to.throw('invalid');
        const restored = normalizeSchedulingState({
            domainProfile: 'general',
            authorization: 'read_only',
            phase: 'execute',
            dispatch: 'single',
            routeEvidence: [],
        });
        expect(restored).to.include({
            domainProfile: 'general', authorization: 'read_only', phase: 'execute', dispatch: 'single',
        });
    });

    it('never expands authorization during a runtime transition', () => {
        const readOnly = schedulingStateFromAdmission({
            domainProfile: 'general', authorization: 'read_only', initialPhase: 'verify',
            explicitDelegation: false, confidence: 1, evidence: ['test'],
        });
        expect(() => transitionSchedulingState(readOnly, {
            phase: 'execute',
            authorization: 'workspace_write',
            reason: 'invalid expansion',
        })).to.throw('cannot expand authorization');
    });

    it('allows read-only orchestration state while blocking external mutation effects', () => {
        expect(authorizationAllowsEffect('read_only', 'none', true)).to.equal(true);
        expect(authorizationAllowsEffect('read_only', 'memory', true)).to.equal(true);
        expect(authorizationAllowsEffect('read_only', 'workspace_write', true)).to.equal(false);
        expect(authorizationAllowsEffect('read_only', 'shell', false)).to.equal(false);
    });

    it('admits independent tasks and rejects duplicate or conflicting work', () => {
        const accepted = evaluateDispatchAdmission([
            { id: 'a', objective: 'inspect parser', role: 'explore', acceptanceCriteria: ['report'] },
            { id: 'b', objective: 'inspect runner', role: 'review', acceptanceCriteria: ['report'] },
        ]);
        expect(accepted.accepted).to.equal(true);

        const conflict = evaluateDispatchAdmission([
            { id: 'a', objective: 'edit a', expectedWrites: ['src/a.ts'] },
            { id: 'b', objective: 'edit b', expectedWrites: ['src/a.ts'] },
        ], { explicitDelegation: true });
        expect(conflict.accepted).to.equal(false);
        expect(conflict.conflicts).to.have.length(1);
    });

    it('admits a single task only through explicit delegation and still validates it', () => {
        const task = [{ id: 'focused', objective: 'inspect one isolated subsystem', role: 'explore' }];
        const implicit = evaluateDispatchAdmission(task);
        expect(implicit.accepted).to.equal(false);
        expect(implicit.reason).to.contain('explicit delegation');

        const explicit = evaluateDispatchAdmission(task, { explicitDelegation: true });
        expect(explicit.accepted).to.equal(true);

        const invalid = evaluateDispatchAdmission([
            { id: 'focused', objective: 'inspect one isolated subsystem', dependencies: ['missing'] },
        ], { explicitDelegation: true });
        expect(invalid.accepted).to.equal(false);
        expect(invalid.reason).to.contain('missing task');
    });

    it('allows explicitly ordered writers to share a resource', () => {
        const result = evaluateDispatchAdmission([
            { id: 'a', objective: 'prepare a', expectedWrites: ['src/a.ts'] },
            { id: 'b', objective: 'finish a', expectedWrites: ['src/a.ts'], dependencies: ['a'] },
        ], { explicitDelegation: true });
        expect(result.conflicts).to.deep.equal([]);
        expect(result.accepted).to.equal(true);

        const transitive = evaluateDispatchAdmission([
            { id: 'a', objective: 'prepare a', expectedWrites: ['src/a.ts'] },
            { id: 'b', objective: 'check a', dependencies: ['a'] },
            { id: 'c', objective: 'finish a', expectedWrites: ['src/a.ts'], dependencies: ['b'] },
        ], { explicitDelegation: true });
        expect(transitive.conflicts).to.deep.equal([]);
        expect(transitive.accepted).to.equal(true);
    });

    it('rejects task graphs with missing dependencies during admission', () => {
        const result = evaluateDispatchAdmission([
            { id: 'a', objective: 'prepare a', dependencies: ['missing'] },
            { id: 'b', objective: 'inspect b' },
        ], { explicitDelegation: true });
        expect(result.accepted).to.equal(false);
        expect(result.reason).to.contain('missing task');

        const cyclic = evaluateDispatchAdmission([
            { id: 'a', objective: 'prepare a', dependencies: ['b'] },
            { id: 'b', objective: 'inspect b', dependencies: ['a'] },
        ], { explicitDelegation: true });
        expect(cyclic.accepted).to.equal(false);
        expect(cyclic.reason).to.contain('cycle');
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
