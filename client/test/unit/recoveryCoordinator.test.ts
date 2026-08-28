import { expect } from 'chai';
import { AgentAbortError } from '../../extension/ai/runner/cancellation';
import { RecoveryCoordinator, classifyRecoveryError } from '../../extension/ai/runner/recoveryCoordinator';

describe('RecoveryCoordinator', () => {
    it('classifies typed recovery causes without discarding the original cause', () => {
        const overflow = new Error('maximum context length exceeded');
        expect(classifyRecoveryError(overflow).kind).to.equal('context_overflow');
        expect(classifyRecoveryError(overflow).cause).to.equal(overflow);
        expect(classifyRecoveryError(Object.assign(new Error('slow down'), { status: 429 })).kind).to.equal('rate_limit');
        expect(classifyRecoveryError(new Error('socket hang up')).kind).to.equal('transport');
        expect(classifyRecoveryError(new Error('request timed out')).kind).to.equal('transport');
        expect(classifyRecoveryError(new Error('OpenAI API error (500): upstream error')).kind).to.equal('provider');
        expect(classifyRecoveryError(new AgentAbortError()).kind).to.equal('cancelled');
    });

    it('uses token proximity to interpret an HTTP 413 safely', () => {
        const error = Object.assign(new Error('payload too large'), { statusCode: 413 });
        expect(classifyRecoveryError(error, { estimatedTokens: 8_000, contextLimit: 10_000 }).kind).to.equal('context_overflow');
        expect(classifyRecoveryError(error, { estimatedTokens: 1_000, contextLimit: 10_000 }).kind).to.equal('provider');
    });

    it('bounds each recovery kind and the run as a whole', () => {
        const coordinator = new RecoveryCoordinator();
        expect(coordinator.claim('transport')).to.include({ attempt: 1, limit: 1, totalAttempt: 1, totalLimit: 6 });
        expect(coordinator.claim('transport')).to.equal(undefined);
        expect(coordinator.claim('context_overflow')).to.include({ attempt: 1, limit: 2, totalAttempt: 2 });
        expect(coordinator.claim('context_overflow')).to.include({ attempt: 2, limit: 2, totalAttempt: 3 });
        expect(coordinator.claim('context_overflow')).to.equal(undefined);
    });

    it('stops unrelated recovery paths when the shared budget is exhausted', () => {
        const coordinator = new RecoveryCoordinator(2, {
            transport: 2,
            output_truncated: 2,
        });
        expect(coordinator.claim('transport')?.totalAttempt).to.equal(1);
        expect(coordinator.claim('output_truncated')?.totalAttempt).to.equal(2);
        expect(coordinator.claim('transport')).to.equal(undefined);
        expect(coordinator.claim('output_truncated')).to.equal(undefined);
        expect(coordinator.total).to.equal(2);
    });

    it('does not grant recovery to terminal safety failures', () => {
        const coordinator = new RecoveryCoordinator();
        expect(coordinator.claim('permission_denied')).to.equal(undefined);
        expect(coordinator.claim('sandbox_unavailable')).to.equal(undefined);
        expect(coordinator.claim('unknown')).to.equal(undefined);
    });
});
