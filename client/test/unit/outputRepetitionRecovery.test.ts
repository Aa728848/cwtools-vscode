import { expect } from 'chai';
import { AGENT, setAiMessageLocale } from '../../extension/ai/messages';
import { planOutputRepetitionRetry } from '../../extension/ai/runner/outputRepetitionRecovery';

describe('planOutputRepetitionRetry', () => {
    it('retries a reasoning loop with the lowest thinking shape', () => {
        const plan = planOutputRepetitionRetry('reasoning');
        expect(plan.lowThinking).to.equal(true);
        expect(plan.directive).to.contain('Thinking is disabled for this retry');
        expect(plan.directive).to.contain('Do not restate the abandoned reasoning');
    });

    it('keeps thinking for a repeated visible response and discards the repeated answer', () => {
        const plan = planOutputRepetitionRetry('response');
        expect(plan.lowThinking).to.equal(false);
        expect(plan.directive).to.contain('one concrete tool call');
    });

    it('tells the user that the reasoning retry runs without thinking', () => {
        setAiMessageLocale('en');
        expect(AGENT.OUTPUT_REPETITION_RETRY('reasoning', 320, true)).to.contain('thinking disabled');
        expect(AGENT.OUTPUT_REPETITION_RETRY('reasoning', 320, false)).to.not.contain('thinking disabled');
        setAiMessageLocale('zh-cn');
        expect(AGENT.OUTPUT_REPETITION_RETRY('reasoning', 320, true)).to.contain('关闭思考');
        expect(AGENT.OUTPUT_REPETITION_BUDGET('reasoning')).to.contain('共享恢复预算已用尽');
        setAiMessageLocale('en');
    });
});
