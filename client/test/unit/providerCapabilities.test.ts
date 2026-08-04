import { expect } from 'chai';
import { resolveProviderCapabilities } from '../../extension/ai/providers/capabilities';

describe('provider capabilities', () => {
    it('recognizes provider-native capabilities only on the official DeepSeek transport', () => {
        const official = resolveProviderCapabilities('deepseek', 'https://api.deepseek.com', 'openai-chat-completions');
        expect(official.reasoningReplay).to.equal('supported');
        expect(official.promptCaching).to.equal('supported');

        const relay = resolveProviderCapabilities('deepseek', 'https://relay.example/v1', 'openai-chat-completions');
        expect(relay.reasoningReplay).to.equal('unknown');
        expect(relay.promptCaching).to.equal('unknown');

        expect(resolveProviderCapabilities('custom', 'https://api.deepseek.com', 'openai-chat-completions'))
            .to.deep.equal({
                reasoningReplay: 'unknown',
                promptCaching: 'unknown',
                nativeConversationState: 'unknown',
                structuredOutput: 'unknown',
            });
    });
});
