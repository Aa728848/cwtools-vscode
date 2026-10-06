import { expect } from 'chai';
import { codexWireReasoningEffort } from '../../extension/ai/codex/oauthService';

describe('Codex wire reasoning effort', () => {
    // The GPT-6 family dropped none/minimal. The picker omits them, but a session that
    // started on an older model - or a hand-edited setting - can still carry one, and
    // the subscription endpoint refuses that request.
    it('translates a rejected rung to the family floor', () => {
        expect(codexWireReasoningEffort('gpt-6.1-sol', 'none')).to.equal('low');
        expect(codexWireReasoningEffort('gpt-6-astra', 'minimal')).to.equal('low');
    });

    it('leaves a supported rung untouched', () => {
        expect(codexWireReasoningEffort('gpt-6.1-sol', 'max')).to.equal('max');
        expect(codexWireReasoningEffort('gpt-6.1-sol', 'xhigh')).to.equal('xhigh');
    });

    // The rule belongs to the GPT-6 family only; older models still take the rungs.
    it('does not touch other families', () => {
        expect(codexWireReasoningEffort('gpt-5.6-sol', 'none')).to.equal('none');
        expect(codexWireReasoningEffort('gpt-5.6-sol', 'minimal')).to.equal('minimal');
    });
});
