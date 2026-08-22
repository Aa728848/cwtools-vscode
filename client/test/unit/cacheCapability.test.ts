import { expect } from 'chai';
import { isCacheCapableUsage, resolveEffectiveCacheCapability, supportsOpenAiStylePrefixCache } from '../../extension/ai/cacheCapability';
import { getCachedInputTokens, getCacheCreationInputTokens } from '../../extension/ai/providerUsage';

describe('MiMo prefix cache capability', () => {
    it('recognizes both MiMo provider endpoints', () => {
        expect(supportsOpenAiStylePrefixCache('mimo')).to.equal(true);
        expect(supportsOpenAiStylePrefixCache('mimo-token-plan')).to.equal(true);
        expect(isCacheCapableUsage('mimo', 0)).to.equal(true);
    });

    it('keeps unknown providers non-capable without observed hits', () => {
        expect(supportsOpenAiStylePrefixCache('custom')).to.equal(false);
        expect(isCacheCapableUsage('other', 0)).to.equal(false);
    });

    it('normalizes every supported cached-token response shape', () => {
        expect(getCachedInputTokens({ prompt_tokens_details: { cached_tokens: 40 } })).to.equal(40);
        expect(getCachedInputTokens({ input_tokens_details: { cached_tokens: 50 } })).to.equal(50);
        expect(getCachedInputTokens({ cache_read_input_tokens: 60 })).to.equal(60);
        expect(getCachedInputTokens({ cached_tokens: 70, prompt_cache_hit_tokens: 65 })).to.equal(70);
        expect(getCachedInputTokens({ cached_content_token_count: 80 })).to.equal(80);
        expect(getCacheCreationInputTokens({ prompt_cache_miss_tokens: 30 }, 100, 70)).to.equal(30);
    });

    it('resolves official, gateway, custom, and local cache policies consistently', () => {
        expect(resolveEffectiveCacheCapability({ providerId: 'qwen', model: 'qwen3.8-max', apiFormat: 'openai-chat-completions' }))
            .to.include({ status: 'supported', requestMode: 'implicit-prefix', supportsUsageTrailer: true });
        expect(resolveEffectiveCacheCapability({ providerId: 'minimax-token-plan', model: 'MiniMax-M3', apiFormat: 'anthropic-messages' }))
            .to.include({ status: 'supported', requestMode: 'anthropic-breakpoints' });
        expect(resolveEffectiveCacheCapability({ providerId: 'openrouter', model: 'deepseek/deepseek-v4-pro', apiFormat: 'openai-chat-completions' }))
            .to.include({ status: 'supported', requestMode: 'implicit-prefix' });
        expect(resolveEffectiveCacheCapability({ providerId: 'custom', model: 'relay', apiFormat: 'openai-chat-completions' }))
            .to.include({ status: 'unknown', requestMode: 'implicit-prefix' });
        expect(resolveEffectiveCacheCapability({ providerId: 'ollama', model: 'local' }))
            .to.include({ status: 'unknown', requestMode: 'none' });
        expect(resolveEffectiveCacheCapability({
            providerId: 'deepseek', model: 'deepseek-v4-pro',
            endpoint: 'https://relay.example/v1', apiFormat: 'openai-chat-completions',
        })).to.include({ status: 'unknown', requestMode: 'implicit-prefix', supportsUsageTrailer: false });
        expect(isCacheCapableUsage('custom', 10, 'openai-chat-completions')).to.equal(true);
        expect(isCacheCapableUsage('custom', 0, 'openai-chat-completions')).to.equal(false);
    });
});
