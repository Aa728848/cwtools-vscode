import { expect } from 'chai';
import { resolveProviderCapabilities } from '../../extension/ai/providers/capabilities';

describe('provider capabilities', () => {
    it('enables prefix continuation only for the official DeepSeek transport', () => {
        const official = resolveProviderCapabilities('deepseek', 'https://api.deepseek.com', 'openai-chat-completions');
        expect(official.prefixContinuation).to.equal('supported');
        expect(official.prefixContinuationEndpoint).to.equal('https://api.deepseek.com/beta');

        expect(resolveProviderCapabilities('deepseek', 'https://relay.example/v1', 'openai-chat-completions').prefixContinuation)
            .to.equal('unknown');
        expect(resolveProviderCapabilities('custom', 'https://api.deepseek.com', 'openai-chat-completions').prefixContinuation)
            .to.equal('unknown');
        expect(resolveProviderCapabilities('deepseek', 'https://api.deepseek.com', 'anthropic-messages').prefixContinuation)
            .to.equal('unsupported');
    });
});
