import { expect } from 'chai';
import {
    DEFAULT_REASONING_KEY,
    KNOWN_REASONING_KEYS,
    detectReasoningKey,
    isReasoningKey,
    reasoningValue,
} from '../../extension/ai/providers/reasoningKey';

describe('reasoning key detection', () => {
    it('treats reasoning_content as the default key', () => {
        expect(DEFAULT_REASONING_KEY).to.equal('reasoning_content');
        expect(KNOWN_REASONING_KEYS[0]).to.equal('reasoning_content');
        expect(isReasoningKey('reasoning_content')).to.equal(true);
        expect(isReasoningKey('made-up-field')).to.equal(false);
    });

    it('detects the first known key present with non-empty content', () => {
        expect(detectReasoningKey({ reasoning_content: 'thinking' })).to.equal('reasoning_content');
        expect(detectReasoningKey({ reasoning: 'thinking' })).to.equal('reasoning');
        expect(detectReasoningKey({ reasoning_text: 'thinking', reasoning_content: '' })).to.equal('reasoning_text');
        // Empty or non-string values are ignored.
        expect(detectReasoningKey({ reasoning_content: '', reasoning: null })).to.equal(undefined);
        expect(detectReasoningKey({ content: 'no thinking here' })).to.equal(undefined);
    });

    it('prefers an explicit key over detection', () => {
        const message = { custom_field: 'thinking', reasoning_content: 'other' };
        expect(reasoningValue(message)).to.equal('other');
        expect(reasoningValue(message, 'custom_field')).to.equal('thinking');
        expect(reasoningValue(message, 'missing_key')).to.equal(undefined);
    });

    it('reads thinking content under any detected key', () => {
        expect(reasoningValue({ reasoning: 'a' })).to.equal('a');
        expect(reasoningValue({ thinking: 'b' })).to.equal('b');
        expect(reasoningValue({ reasoning_content: '  ' })).to.equal(undefined);
    });
});
