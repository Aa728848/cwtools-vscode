import { expect } from 'chai';
import {
    classifySubscriptionFailure,
    shouldRotateAccount,
    shouldRetrySameAccount,
} from '../../extension/ai/subscriptionFailure';

describe('Subscription failure classification', () => {
    // A revoked token answers 403 on several deployments, so the credential test has
    // to come FIRST: judging it as an account limit parks nothing and it keeps serving.
    it('calls a dead credential a dead credential', () => {
        expect(classifySubscriptionFailure(401, 'unauthorized').kind).to.equal('invalid_credential');
        expect(classifySubscriptionFailure(403, '{"code":401,"message":"token is invalid"}').kind)
            .to.equal('invalid_credential');
    });

    // An account-level limit is not a credential problem: the account is fine, it is
    // simply capped, and the pool should cool it for a long while and move on.
    it('separates an account limit from a dead credential', () => {
        const failure = classifySubscriptionFailure(429, 'too many requests for this account');
        expect(failure.kind).to.equal('account_limit');
        expect(shouldRotateAccount(failure.kind)).to.equal(true);
        // Billing-cycle scale, not second-scale back-pressure.
        expect(failure.cooldownMs).to.be.greaterThan(60 * 60 * 1000);
    });

    // A spent plan is an account fact: retrying the same account can never succeed.
    it('treats an exhausted plan as the account, not back-pressure', () => {
        const failure = classifySubscriptionFailure(429, 'quota exhausted for this key');
        expect(failure.kind).to.equal('account_quota_exhausted');
        expect(shouldRetrySameAccount(failure.kind)).to.equal(false);
    });

    // A plain 429 with no account wording stays global: rotating against a global
    // limit would burn the whole pool on one wall.
    it('keeps an unlabelled 429 global', () => {
        const failure = classifySubscriptionFailure(429, 'slow down');
        expect(failure.kind).to.equal('rate_limit');
        expect(shouldRotateAccount(failure.kind)).to.equal(false);
    });

    it('routes a context overflow to compaction, not to routing', () => {
        expect(classifySubscriptionFailure(400, 'Your request exceeded model token limit: 262144').kind)
            .to.equal('context_overflow');
        expect(classifySubscriptionFailure(400, 'maximum context length is 200000 tokens').kind)
            .to.equal('context_overflow');
    });

    it('reads the business code out of the body', () => {
        expect(classifySubscriptionFailure(400, '{"code":11102,"message":"model not served"}').code)
            .to.equal(11102);
    });

    it('classifies a server fault as retryable on the same account', () => {
        const failure = classifySubscriptionFailure(503, 'upstream');
        expect(failure.kind).to.equal('server');
        expect(shouldRetrySameAccount(failure.kind)).to.equal(true);
        expect(shouldRotateAccount(failure.kind)).to.equal(false);
    });
});
