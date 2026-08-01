import { expect } from 'chai';
import { RecoveryStormBudget, classifyStormFailure } from '../../extension/ai/orchestrator/recoveryStormBudget';

describe('RecoveryStormBudget', () => {
    it('requires cross-node evidence for provider storms', () => {
        const budget = new RecoveryStormBudget();
        expect(budget.record('provider_transport', 'a').tripped).to.equal(false);
        expect(budget.record('provider_transport', 'a').tripped).to.equal(false);
        expect(budget.record('provider_transport', 'b').tripped).to.equal(true);
        expect(budget.decision?.reason).to.include('Safe read-only diagnostics');
    });

    it('bounds repeated reviewer repair waves on the parent', () => {
        const budget = new RecoveryStormBudget();
        budget.record('reviewer_rejection', 'review-1');
        budget.record('reviewer_rejection', 'review-2');
        expect(budget.record('reviewer_rejection', 'review-3').tripped).to.equal(true);
    });

    it('does not classify precise edit failures as parent storms', () => {
        expect(classifyStormFailure('anchor_not_found in events/test.txt')).to.equal(undefined);
        expect(classifyStormFailure('maximum context length exceeded')).to.equal('context_overflow');
        expect(classifyStormFailure('socket hang up')).to.equal('provider_transport');
    });
});
