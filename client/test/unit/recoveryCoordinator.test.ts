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
        expect(classifyRecoveryError(new AgentAbortError()).kind).to.equal('cancelled');
    });

    it('uses token proximity to interpret an HTTP 413 safely', () => {
        const error = Object.assign(new Error('payload too large'), { statusCode: 413 });
        expect(classifyRecoveryError(error, { estimatedTokens: 8_000, contextLimit: 10_000 }).kind).to.equal('context_overflow');
        expect(classifyRecoveryError(error, { estimatedTokens: 1_000, contextLimit: 10_000 }).kind).to.equal('provider');
    });

    it('bounds each recovery mechanism independently', () => {
        const coordinator = new RecoveryCoordinator();
        expect(coordinator.claim('transport', 2)).to.equal(1);
        expect(coordinator.claim('transport', 2)).to.equal(2);
        expect(coordinator.claim('transport', 2)).to.equal(undefined);
        expect(coordinator.claim('context_overflow', 1)).to.equal(1);
    });
});
