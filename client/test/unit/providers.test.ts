import { expect } from 'chai';
import {
    isModelVisionCapable,
    isModelFIMCapable,
    clampConfiguredContextTokens,
    getModelContextTokens,
    getModelOutputTokens,
    getProvider,
    getEffectiveEndpoint,
    getEffectiveModel,
    getEffectiveTemperature,
    getOpenCodeApiFormat,
    getOpenCodeGoApiFormat,
    getProviderApiFormat,
    getEffectiveReasoningEffort,
    getDisableThinkingParams,
    getEnableThinkingParams,
    toClaudeRequest,
    suggestOllamaConfig,
    BUILTIN_PROVIDERS,
    MODEL_CONTEXT_TOKENS,
    VISION_CAPABLE_MODELS,
    FIM_CAPABLE_MODELS,
    ALWAYS_THINKING_PREFIXES,
    OPENCODE_MODEL_LIMITS,
    OPENCODE_GO_MODEL_LIMITS,
} from '../../extension/ai/providers';
import type { ChatCompletionRequest, ChatMessage } from '../../extension/ai/types';

describe('Antigravity provider support', () => {
    it('keeps OAuth chat and editor model catalogs separate', () => {
        const provider = getProvider('antigravity');
        expect(provider).to.include({ authKind: 'antigravity-oauth', requiresApiKey: false, supportsFIM: true, supportsUtilityCalls: false });
        expect(provider.inlineModels).to.deep.equal(['tab_flash_lite_preview']);
        expect(provider.models).not.to.include('tab_flash_lite_preview');
        expect(isModelFIMCapable('', 'antigravity')).to.equal(true);
        expect(isModelFIMCapable('tab_flash_lite_preview', 'antigravity')).to.equal(true);
        expect(isModelFIMCapable('tab_jump_flash_lite_preview', 'antigravity')).to.equal(false);
        expect(isModelFIMCapable('gemini-3.1-pro', 'antigravity')).to.equal(false);
        expect(provider.models).to.include(provider.defaultModel);
        expect(getProviderApiFormat('antigravity', 'claude-opus-4-6')).to.equal('gemini-generate-content');
        expect(getModelContextTokens('claude-opus-4-6', 'antigravity')).to.equal(1048576);
        expect(getModelContextTokens('gpt-oss-120b', 'antigravity')).to.equal(262144);
        expect(getModelOutputTokens('claude-opus-4-6', 'antigravity')).to.equal(64000);
    });
});

describe('GPT-6 Astra provider support', () => {
    it('offers Astra on both providers while preserving their defaults and context limits', () => {
        for (const providerId of ['openai', 'codex-chatgpt']) {
            expect(getProvider(providerId).models).to.include('gpt-6-astra');
            expect(getProviderApiFormat(providerId, 'gpt-6-astra')).to.equal('openai-responses');
            expect(getModelOutputTokens('gpt-6-astra', providerId)).to.equal(128000);
        }
        expect(getEffectiveModel('openai')).to.equal('gpt-5.5');
        expect(getEffectiveModel('codex-chatgpt')).to.equal('gpt-5.6-sol');
        expect(getModelContextTokens('gpt-6-astra', 'openai')).to.equal(1050000);
        expect(getModelContextTokens('gpt-6-astra', 'codex-chatgpt')).to.equal(272000);
        expect(clampConfiguredContextTokens('codex-chatgpt', 'gpt-6-astra', 1050000)).to.equal(272000);
    });

    it('recognizes vision and output limits for direct and namespaced Astra IDs', () => {
        for (const model of ['gpt-6-astra', 'openai/gpt-6-astra']) {
            expect(isModelVisionCapable(model), model).to.equal(true);
            expect(getModelOutputTokens(model), model).to.equal(128000);
            expect(getEffectiveTemperature(model, 0.2), model).to.equal(undefined);
            expect(getEffectiveReasoningEffort(model, 'max', 'openai-responses'), model).to.equal('max');
            expect(getEffectiveReasoningEffort(model, 'minimal', 'openai-responses'), model).to.equal('low');
            expect(getEffectiveReasoningEffort(model, 'none', 'openai-responses'), model).to.equal('low');
        }
    });
});

// ─── isModelVisionCapable ────────────────────────────────────────────────────

describe('isModelVisionCapable', () => {
    it('returns false for empty string', () => {
        expect(isModelVisionCapable('')).to.equal(false);
    });

    it('returns true for known vision model (gpt-4o)', () => {
        expect(isModelVisionCapable('gpt-4o')).to.equal(true);
    });

    it('returns true for every GPT-5.6 tier', () => {
        expect(isModelVisionCapable('gpt-5.6')).to.equal(true);
        expect(isModelVisionCapable('gpt-5.6-sol')).to.equal(true);
        expect(isModelVisionCapable('gpt-5.6-terra')).to.equal(true);
        expect(isModelVisionCapable('gpt-5.6-luna')).to.equal(true);
    });

    it('returns true for claude model with vision', () => {
        expect(isModelVisionCapable('claude-opus-4-7')).to.equal(true);
    });

    it('returns true for dated model tag via substring match', () => {
        expect(isModelVisionCapable('gpt-4o-2024-08-06')).to.equal(true);
    });

    it('returns false for non-vision model', () => {
        expect(isModelVisionCapable('deepseek-v4-pro')).to.equal(false);
    });

    it('is case insensitive', () => {
        expect(isModelVisionCapable('GPT-4O')).to.equal(true);
    });

    it('tracks MiMo v2.5 vision variants', () => {
        expect(isModelVisionCapable('mimo-v2.5-pro')).to.equal(false);
        expect(isModelVisionCapable('mimo-v2.5-free')).to.equal(true);
        expect(isModelVisionCapable('mimo-v2.5')).to.equal(true);
    });

    it('returns false for deprecated mimo-v2-flash', () => {
        expect(isModelVisionCapable('mimo-v2-flash')).to.equal(false);
    });

    it('returns false for glm text-only models', () => {
        expect(isModelVisionCapable('glm-5-turbo')).to.equal(false);
    });

    it('returns true for glm vision models', () => {
        expect(isModelVisionCapable('glm-5v-turbo')).to.equal(true);
    });

    it('tracks newly multimodal MiniMax, Qwen, and Kimi models', () => {
        expect(isModelVisionCapable('MiniMax-M3')).to.equal(true);
        expect(isModelVisionCapable('qwen3.7-max-2026-06-08')).to.equal(true);
        expect(isModelVisionCapable('qwen3.7-plus')).to.equal(true);
        expect(isModelVisionCapable('kimi-k2.7-code-highspeed')).to.equal(true);
        expect(isModelVisionCapable('kimi-k3')).to.equal(true);
    });
});

// ─── isModelFIMCapable ───────────────────────────────────────────────────────

describe('isModelFIMCapable', () => {
    it('returns true for deepseek-v4-pro (explicit FIM model)', () => {
        expect(isModelFIMCapable('deepseek-v4-pro', 'deepseek')).to.equal(true);
    });

    it('returns true for deepseek-coder', () => {
        expect(isModelFIMCapable('deepseek-coder', 'deepseek')).to.equal(true);
    });

    it('returns false for gpt models (explicitly disabled)', () => {
        expect(isModelFIMCapable('gpt-5.5', 'openai')).to.equal(false);
    });

    it('returns false for claude models (explicitly disabled)', () => {
        expect(isModelFIMCapable('claude-opus-4-7', 'claude')).to.equal(false);
    });

    it('falls back to provider default for unlisted model', () => {
        // deepseek provider supports FIM by default
        expect(isModelFIMCapable('unknown-model', 'deepseek')).to.equal(true);
    });

    it('falls back to provider default for empty model', () => {
        expect(isModelFIMCapable('', 'deepseek')).to.equal(true);
    });

    it('returns false when provider does not support FIM and model is unlisted', () => {
        expect(isModelFIMCapable('unknown-model', 'openai')).to.equal(false);
    });
});

// ─── getModelContextTokens ───────────────────────────────────────────────────

describe('getModelContextTokens', () => {
    it('returns 0 for empty model', () => {
        expect(getModelContextTokens('')).to.equal(0);
    });

    it('exact match for known model', () => {
        const result = getModelContextTokens('gpt-5.5');
        expect(result).to.be.a('number').and.greaterThan(0);
    });

    it('prefix match: dated model resolves to base', () => {
        const base = getModelContextTokens('claude-opus-4-7');
        const dated = getModelContextTokens('claude-opus-4-7-20251101');
        expect(dated).to.equal(base);
    });

    it('falls back to provider maxContextTokens when model unknown', () => {
        const provider = getProvider('openai');
        expect(getModelContextTokens('nonexistent-model', 'openai')).to.equal(provider.maxContextTokens);
    });

    it('uses provider-specific context override when available', () => {
        expect(getModelContextTokens('google/gemini-3.1-pro-preview', 'openrouter')).to.equal(1048576);
        expect(getModelContextTokens('gemini-3.1-pro', 'google')).to.equal(2097152);
    });

    it('keeps ChatGPT Codex context separate from the public API model limit', () => {
        expect(getModelContextTokens('gpt-5.6-sol', 'codex-chatgpt')).to.equal(272000);
        expect(getModelContextTokens('gpt-5.6-sol', 'openai')).to.equal(1050000);
        expect(clampConfiguredContextTokens('codex-chatgpt', 'gpt-5.6-sol', 1050000)).to.equal(272000);
        expect(clampConfiguredContextTokens('codex-chatgpt', 'gpt-5.6-sol', 200000)).to.equal(200000);
        expect(clampConfiguredContextTokens('openai', 'gpt-5.6-sol', 1050000)).to.equal(1050000);
    });

    it('uses current GLM and Kimi context windows', () => {
        expect(getModelContextTokens('glm-5.2', 'glm')).to.equal(1000000);
        expect(getModelContextTokens('glm-5v-turbo', 'glm')).to.equal(200000);
        expect(getModelContextTokens('kimi-k2.7-code', 'kimi')).to.equal(262144);
        expect(getModelContextTokens('kimi-k3', 'kimi')).to.equal(1048576);
    });

    it('uses OpenCode-specific limits', () => {
        expect(getModelContextTokens('gpt-5.3-codex-spark', 'opencode')).to.equal(128000);
        expect(getModelContextTokens('claude-sonnet-5', 'opencode')).to.equal(1000000);
        expect(getModelContextTokens('glm-5.2', 'opencode')).to.equal(1000000);
        expect(getModelContextTokens('hy3-free', 'opencode')).to.equal(256000);
        expect(getModelContextTokens('qwen3.6-plus', 'opencode')).to.equal(262144);
        expect(getModelContextTokens('nemotron-3-ultra-free', 'opencode')).to.equal(1000000);
        expect(getModelContextTokens('mimo-v2.5-pro', 'opencode-go')).to.equal(1048576);
    });

    it('uses current direct-provider context metadata', () => {
        expect(getModelContextTokens('deepseek-v4-pro', 'deepseek')).to.equal(1000000);
        expect(getModelContextTokens('claude-sonnet-5', 'claude')).to.equal(1000000);
        expect(getModelContextTokens('MiniMax-M2.7', 'minimax')).to.equal(204800);
        expect(getModelContextTokens('glm-4.7-flashx', 'glm')).to.equal(200000);
        expect(getModelContextTokens('glm-4.6v', 'glm')).to.equal(128000);
        expect(getModelContextTokens('mimo-v2.5', 'mimo')).to.equal(1048576);
    });

    it('returns 0 for completely unknown model and provider', () => {
        expect(getModelContextTokens('nonexistent-model')).to.equal(0);
    });
});

// ─── getModelOutputTokens ────────────────────────────────────────────────────

describe('getModelOutputTokens', () => {
    it('returns 16384 for empty model', () => {
        expect(getModelOutputTokens('')).to.equal(16384);
    });

    it('returns 128000 for openai provider', () => {
        expect(getModelOutputTokens('gpt-5.5', 'openai')).to.equal(128000);
    });

    it('returns high value for deepseek provider', () => {
        const result = getModelOutputTokens('deepseek-v4-pro', 'deepseek');
        expect(result).to.be.a('number').and.greaterThan(100000);
    });

    it('returns the supported Kimi K2.7 output budget', () => {
        expect(getModelOutputTokens('kimi-k2.7-code', 'kimi')).to.equal(32768);
    });

    it('returns the supported Kimi K3 output budget', () => {
        expect(getModelOutputTokens('kimi-k3', 'kimi')).to.equal(131072);
    });

    it('uses OpenCode-specific output limits', () => {
        expect(getModelOutputTokens('claude-opus-4-8', 'opencode')).to.equal(128000);
        expect(getModelOutputTokens('minimax-m3-free', 'opencode')).to.equal(32000);
        expect(getModelOutputTokens('big-pickle (免费)', 'opencode')).to.equal(32000);
        expect(getModelOutputTokens('kimi-k2.7-code', 'opencode')).to.equal(262144);
        expect(getModelOutputTokens('grok-build-0.1', 'opencode')).to.equal(256000);
        expect(getModelOutputTokens('grok-4.5', 'opencode')).to.equal(500000);
        expect(getModelOutputTokens('kimi-k2.7-code', 'opencode-go')).to.equal(262144);
        expect(getModelOutputTokens('mimo-v2.5-pro', 'opencode-go')).to.equal(128000);
    });

    it('uses current direct-provider output limits', () => {
        expect(getModelOutputTokens('claude-sonnet-5', 'claude')).to.equal(128000);
        expect(getModelOutputTokens('MiniMax-M2.7', 'minimax')).to.equal(131072);
        expect(getModelOutputTokens('mimo-v2.5-pro', 'mimo')).to.equal(131072);
    });

    it('returns reasonable default for unknown provider', () => {
        const result = getModelOutputTokens('some-model');
        expect(result).to.be.a('number').and.greaterThan(0);
    });
});

// ─── getProvider ─────────────────────────────────────────────────────────────

describe('getProvider', () => {
    it('returns openai for "openai"', () => {
        const p = getProvider('openai');
        expect(p.id).to.equal('openai');
        expect(p.endpoint).to.include('openai');
    });

    it('returns claude for "claude"', () => {
        const p = getProvider('claude');
        expect(p.id).to.equal('claude');
    });

    it('returns custom for "custom"', () => {
        const p = getProvider('custom');
        expect(p.id).to.equal('custom');
        expect(p.isOpenAICompatible).to.equal(true);
    });

    it('falls back to openai for unknown provider', () => {
        const p = getProvider('nonexistent-provider');
        expect(p.id).to.equal('openai');
    });

    it('falls back to openai for empty string', () => {
        const p = getProvider('');
        expect(p.id).to.equal('openai');
    });

    it('tracks current OpenCode model ids without display suffixes', () => {
        const zen = BUILTIN_PROVIDERS['opencode']!;
        expect(zen.defaultModel).to.equal('big-pickle');
        expect(zen.models).to.include.members([
            'claude-sonnet-5',
            'glm-5.2',
            'kimi-k2.7-code',
            'grok-4.5',
            'hy3-free',
        ]);
        expect(zen.models.some(model => model.includes('('))).to.equal(false);

        const go = BUILTIN_PROVIDERS['opencode-go']!;
        expect(go.models).to.include.members([
            'mimo-v2.5-pro',
        ]);
        expect(go.models).to.not.include.members([
            'mimo-v2-pro',
            'mimo-v2-omni',
            'mimo-v2-flash',
            'kimi-k2.5',
            'glm-5',
            'qwen3.5-plus',
            'hy3-preview',
        ]);
    });
});

// ─── getEffectiveEndpoint ────────────────────────────────────────────────────

describe('getEffectiveEndpoint', () => {
    it('returns user override when provided', () => {
        expect(getEffectiveEndpoint('openai', 'https://custom.api.com/v1'))
            .to.equal('https://custom.api.com/v1');
    });

    it('strips trailing slash from user override', () => {
        expect(getEffectiveEndpoint('openai', 'https://custom.api.com/v1/'))
            .to.equal('https://custom.api.com/v1');
    });

    it('returns default endpoint when no override', () => {
        const p = getProvider('openai');
        expect(getEffectiveEndpoint('openai')).to.equal(p.endpoint);
    });

    it('ignores empty string override', () => {
        const p = getProvider('openai');
        expect(getEffectiveEndpoint('openai', '')).to.equal(p.endpoint);
    });

    it('ignores whitespace-only override', () => {
        const p = getProvider('openai');
        expect(getEffectiveEndpoint('openai', '   ')).to.equal(p.endpoint);
    });

    it('returns an empty default endpoint for custom when no override is configured', () => {
        expect(getEffectiveEndpoint('custom')).to.equal('');
    });
});

// ─── getEffectiveModel ───────────────────────────────────────────────────────

describe('getEffectiveModel', () => {
    it('returns user override when provided', () => {
        expect(getEffectiveModel('openai', 'gpt-5.4-mini')).to.equal('gpt-5.4-mini');
    });

    it('returns default model when no override', () => {
        const p = getProvider('openai');
        expect(getEffectiveModel('openai')).to.equal(p.defaultModel);
    });

    it('ignores empty string override', () => {
        const p = getProvider('claude');
        expect(getEffectiveModel('claude', '')).to.equal(p.defaultModel);
    });

    it('returns an empty default model for custom when no override is configured', () => {
        expect(getEffectiveModel('custom')).to.equal('');
    });

    it('trims whitespace from override', () => {
        expect(getEffectiveModel('openai', '  gpt-5.4  ')).to.equal('gpt-5.4');
    });
});

describe('getEffectiveTemperature', () => {
    it('enforces Kimi K2.7 Code fixed sampling temperature', () => {
        expect(getEffectiveTemperature('kimi-k2.7-code', 0.2)).to.equal(1.0);
        expect(getEffectiveTemperature('moonshotai/kimi-k2.7-code-highspeed')).to.equal(1.0);
    });

    it('enforces Kimi K3 fixed sampling temperature', () => {
        expect(getEffectiveTemperature('kimi-k3', 0.2)).to.equal(1.0);
        expect(getEffectiveTemperature('kimi-for-coding', 0.2)).to.equal(1.0);
    });

    it('preserves normal model overrides and defaults', () => {
        expect(getEffectiveTemperature('glm-5.2', 0.7)).to.equal(0.7);
        expect(getEffectiveTemperature('glm-5.2')).to.equal(0.3);
    });
});

describe('getOpenCodeApiFormat', () => {
    it('routes each OpenCode model family to its documented wire protocol', () => {
        expect(getOpenCodeApiFormat('gpt-5.5')).to.equal('openai-responses');
        expect(getOpenCodeApiFormat('claude-opus-4-8')).to.equal('anthropic-messages');
        expect(getOpenCodeApiFormat('qwen3.6-plus-free (免费)')).to.equal('anthropic-messages');
        expect(getOpenCodeApiFormat('gemini-3.5-flash')).to.equal('gemini-generate-content');
        expect(getOpenCodeApiFormat('deepseek-v4-pro')).to.equal('openai-chat-completions');
    });
});

describe('getOpenCodeGoApiFormat', () => {
    it('routes MiniMax and Qwen to Anthropic Messages, the rest to OpenAI chat completions', () => {
        expect(getOpenCodeGoApiFormat('glm-5.2')).to.equal('openai-chat-completions');
        expect(getOpenCodeGoApiFormat('kimi-k2.7-code')).to.equal('openai-chat-completions');
        expect(getOpenCodeGoApiFormat('deepseek-v4-flash')).to.equal('openai-chat-completions');
        expect(getOpenCodeGoApiFormat('mimo-v2.5-pro')).to.equal('openai-chat-completions');
        expect(getOpenCodeGoApiFormat('minimax-m3')).to.equal('anthropic-messages');
        expect(getOpenCodeGoApiFormat('minimax-m2.7')).to.equal('anthropic-messages');
        expect(getOpenCodeGoApiFormat('qwen3.7-max')).to.equal('anthropic-messages');
        expect(getOpenCodeGoApiFormat('qwen3.6-plus')).to.equal('anthropic-messages');
    });
});

describe('getProviderApiFormat', () => {
    it('covers every built-in provider with its effective default-model protocol', () => {
        const expected = {
            'codex-chatgpt': 'openai-responses',
            antigravity: 'gemini-generate-content',
            openai: 'openai-responses',
            claude: 'anthropic-messages',
            tokenrhythm: 'openai-chat-completions',
            deepseek: 'openai-chat-completions',
            minimax: 'openai-chat-completions',
            'minimax-token-plan': 'anthropic-messages',
            glm: 'openai-chat-completions',
            qwen: 'openai-chat-completions',
            mimo: 'openai-chat-completions',
            'mimo-token-plan': 'openai-chat-completions',
            google: 'openai-chat-completions',
            ollama: 'openai-chat-completions',
            custom: 'openai-chat-completions',
            siliconflow: 'openai-chat-completions',
            openrouter: 'openai-chat-completions',
            github: 'openai-chat-completions',
            together: 'openai-chat-completions',
            deepinfra: 'openai-chat-completions',
            opencode: 'openai-chat-completions',
            'opencode-go': 'openai-chat-completions',
            kimi: 'openai-chat-completions',
            'kimi-code-plan': 'openai-chat-completions',
        } as const;

        const httpProviderIds = Object.values(BUILTIN_PROVIDERS).map(provider => provider.id).sort();
        expect(Object.keys(expected).sort()).to.deep.equal(httpProviderIds);
        for (const [providerId, apiFormat] of Object.entries(expected)) {
            expect(getProviderApiFormat(providerId, BUILTIN_PROVIDERS[providerId]!.defaultModel)).to.equal(apiFormat);
        }
    });

    it('keeps all four user-selected custom protocols', () => {
        for (const format of [
            'openai-chat-completions',
            'openai-responses',
            'anthropic-messages',
            'gemini-generate-content',
        ] as const) {
            expect(getProviderApiFormat('custom', 'relay-model', format)).to.equal(format);
        }
    });
});

describe('getEffectiveReasoningEffort', () => {
    it('maps the common maximum selection to OpenAI Responses xhigh', () => {
        expect(getEffectiveReasoningEffort('gpt-5.6', 'max', 'openai-responses')).to.equal('xhigh');
        expect(getEffectiveReasoningEffort('gpt-5.6-sol', 'max', 'openai-responses')).to.equal('xhigh');
        expect(getEffectiveReasoningEffort('gpt-5.5', 'max', 'openai-responses')).to.equal('xhigh');
    });

    it('does not alter other protocols or supported values', () => {
        expect(getEffectiveReasoningEffort('claude-opus-4-8', 'max', 'anthropic-messages')).to.equal('max');
        expect(getEffectiveReasoningEffort('gpt-5.5', 'medium', 'openai-responses')).to.equal('medium');
    });
});

// ─── getDisableThinkingParams ────────────────────────────────────────────────

describe('getDisableThinkingParams', () => {
    it('returns undefined for unknown model', () => {
        expect(getDisableThinkingParams('unknown-model')).to.equal(undefined);
    });

    it('returns params for qwen3 model', () => {
        const result = getDisableThinkingParams('qwen3.6-plus');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ enable_thinking: false });
        expect(result!.injectPrompt).to.equal(true);
    });

    it('returns params for GLM thinking model', () => {
        const result = getDisableThinkingParams('glm-4.1v-thinking');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking: { type: 'disabled' } });
    });

    it('returns params for gemini-2.5-flash', () => {
        const result = getDisableThinkingParams('gemini-2.5-flash');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking_config: { thinking_budget: 0 } });
    });

    it('returns params for gemini-3 model', () => {
        const result = getDisableThinkingParams('gemini-3-pro');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking_config: { thinking_level: 'minimal' } });
    });

    it('returns undefined for standard GPT model', () => {
        expect(getDisableThinkingParams('gpt-5.5')).to.equal(undefined);
    });

    it('returns undefined for Claude model', () => {
        expect(getDisableThinkingParams('claude-opus-4-7')).to.equal(undefined);
    });
});

// ─── toClaudeRequest ─────────────────────────────────────────────────────────

describe('getEnableThinkingParams', () => {
    it('returns MiMo thinking params for MiMo provider', () => {
        const result = getEnableThinkingParams('mimo-v2.5-pro', 'mimo');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking: { type: 'enabled' } });
    });

    it('returns MiMo thinking params for token-plan provider', () => {
        const result = getEnableThinkingParams('mimo-v2.5', 'mimo-token-plan');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking: { type: 'enabled' } });
    });

    it('infers MiMo thinking params from model name', () => {
        const result = getEnableThinkingParams('mimo-v2.5-pro', 'custom');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking: { type: 'enabled' } });
    });

    it('returns undefined for non-MiMo models', () => {
        expect(getEnableThinkingParams('qwen3.6-plus', 'qwen')).to.equal(undefined);
    });
});

describe('toClaudeRequest', () => {
    it('extracts system message into system field', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hello' },
            ],
        };
        const result = toClaudeRequest(req);
        expect(result.system).to.be.an('array');
        const systemArray = result.system as any[];
        expect(systemArray[0].text).to.equal('You are helpful.');
        expect(result.messages).to.have.length(1);
        expect((result.messages as ChatMessage[])[0]!.role).to.equal('user');
    });

    it('converts plain text user message', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = toClaudeRequest(req);
        const msgs = result.messages as Array<Record<string, unknown>>;
        expect(msgs).to.have.length(1);
        expect(msgs[0]!.role).to.equal('user');
        expect(msgs[0]!.content).to.equal('Hi');
    });

    it('converts assistant text message', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'assistant', content: 'Hello!' }],
        };
        const result = toClaudeRequest(req);
        const msgs = result.messages as Array<Record<string, unknown>>;
        expect(msgs[0]!.role).to.equal('assistant');
        expect(msgs[0]!.content).to.equal('Hello!');
    });

    it('converts tool call message to tool_use blocks', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' },
                }],
            }],
        };
        const result = toClaudeRequest(req);
        const msgs = result.messages as Array<Record<string, unknown>>;
        const content = msgs[0]!.content as Array<Record<string, unknown>>;
        expect(content[0]!.type).to.equal('tool_use');
        expect(content[0]!.name).to.equal('read_file');
        expect(content[0]!.id).to.equal('call_1');
    });

    it('converts tool result message', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{
                role: 'tool',
                content: 'file contents here',
                tool_call_id: 'call_1',
            }],
        };
        const result = toClaudeRequest(req);
        const msgs = result.messages as Array<Record<string, unknown>>;
        expect(msgs[0]!.role).to.equal('user');
        const content = msgs[0]!.content as Array<Record<string, unknown>>;
        expect(content[0]!.type).to.equal('tool_result');
        expect(content[0]!.tool_use_id).to.equal('call_1');
    });

    it('sets max_tokens with default 4096', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = toClaudeRequest(req);
        expect(result.max_tokens).to.equal(4096);
    });

    it('uses provided max_tokens', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 8192,
        };
        const result = toClaudeRequest(req);
        expect(result.max_tokens).to.equal(8192);
    });

    it('converts tools to Claude format', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
            tools: [{
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read a file',
                    parameters: { type: 'object', properties: { path: { type: 'string' } } },
                },
            }],
        };
        const result = toClaudeRequest(req);
        const tools = result.tools as Array<Record<string, unknown>>;
        expect(tools).to.have.length(1);
        expect(tools[0]!.name).to.equal('read_file');
        expect(tools[0]!.description).to.equal('Read a file');
    });

    it('omits system field when no system messages', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = toClaudeRequest(req);
        expect(result.system).to.equal(undefined);
    });

    it('concatenates multiple system messages', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [
                { role: 'system', content: 'Part 1' },
                { role: 'system', content: 'Part 2' },
                { role: 'user', content: 'Hi' },
            ],
        };
        const result = toClaudeRequest(req);
        expect(result.system).to.be.an('array');
        const systemArray = result.system as any[];
        expect(systemArray[0].text).to.equal('Part 1\n\nPart 2');
    });

    it('can omit Anthropic cache_control blocks for compatible relays', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [
                { role: 'system', content: 'System prompt' },
                { role: 'user', content: '[Context Recovery]\nHi' },
                { role: 'assistant', content: 'Hello' },
                { role: 'user', content: 'Continue' },
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read a file',
                    parameters: { type: 'object', properties: { path: { type: 'string' } } },
                },
            }],
        };

        const result = toClaudeRequest(req, { cacheControl: false });
        expect(result.system).to.equal('System prompt');
        expect(JSON.stringify(result)).to.not.include('cache_control');
    });

    it('preserves signed thinking blocks and multimodal assistant content before tool_use', () => {
        const result = toClaudeRequest({
            model: 'claude-opus-4-8',
            messages: [{
                role: 'assistant',
                content: [{ type: 'text', text: 'I will inspect it.' }],
                reasoning_content: 'Inspecting.',
                anthropic_thinking_blocks: [{ type: 'thinking', thinking: 'Inspecting.', signature: 'signed-value' }],
                tool_calls: [{
                    id: 'toolu_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
                }],
            }],
        });

        const content = (result.messages as any[])[0]!.content;
        expect(content.map((block: any) => block.type)).to.deep.equal(['thinking', 'text', 'tool_use']);
        expect(content[0].signature).to.equal('signed-value');
        expect(content[1].text).to.equal('I will inspect it.');
    });

    it('groups parallel tool results into one Anthropic user turn', () => {
        const result = toClaudeRequest({
            model: 'claude-opus-4-8',
            messages: [{ role: 'tool', content: 'one', tool_call_id: 'toolu_1' },
                { role: 'tool', content: [{ type: 'text', text: 'two' }], tool_call_id: 'toolu_2' }],
        });

        const messages = result.messages as any[];
        expect(messages).to.have.length(1);
        expect(messages[0].content.map((block: any) => block.tool_use_id)).to.deep.equal(['toolu_1', 'toolu_2']);
        expect(messages[0].content[1].content).to.equal('two');
    });

    it('fails clearly instead of replaying malformed tool arguments as an empty object', () => {
        expect(() => toClaudeRequest({
            model: 'claude-opus-4-8',
            messages: [{
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'toolu_bad',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{broken' },
                }],
            }],
        })).to.throw("Cannot replay Anthropic tool call 'read_file'");
    });
});

// ─── suggestOllamaConfig ─────────────────────────────────────────────────────

describe('suggestOllamaConfig', () => {
    it('returns null for empty array', () => {
        expect(suggestOllamaConfig([])).to.equal(null);
    });

    it('suggests config for single model', () => {
        const result = suggestOllamaConfig([
            { name: 'llama3:70b', size: '40 GB', parameterSize: '70B' },
        ]);
        expect(result).to.not.equal(null);
        expect(result!.chatModel).to.equal('llama3:70b');
        expect(result!.contextTokens).to.equal(32768);
    });

    it('prefers coding model for chat', () => {
        const result = suggestOllamaConfig([
            { name: 'llama3:7b', size: '4 GB', parameterSize: '7B' },
            { name: 'qwen2.5-coder:32b', size: '19 GB', parameterSize: '32B' },
        ]);
        expect(result).to.not.equal(null);
        expect(result!.chatModel).to.equal('qwen2.5-coder:32b');
    });

    it('selects smaller model for inline', () => {
        const result = suggestOllamaConfig([
            { name: 'qwen2.5-coder:32b', size: '19 GB', parameterSize: '32B' },
            { name: 'deepseek-coder:6.7b', size: '3.8 GB', parameterSize: '6.7B' },
        ]);
        expect(result).to.not.equal(null);
        expect(result!.inlineModel).to.equal('deepseek-coder:6.7b');
    });

    it('scales context tokens by param size', () => {
        const small = suggestOllamaConfig([
            { name: 'tiny:3b', size: '2 GB', parameterSize: '3B' },
        ]);
        expect(small!.contextTokens).to.equal(4096);

        const medium = suggestOllamaConfig([
            { name: 'mid:13b', size: '7 GB', parameterSize: '13B' },
        ]);
        expect(medium!.contextTokens).to.equal(8192);
    });
});

// ─── Structural validation ───────────────────────────────────────────────────

describe('BUILTIN_PROVIDERS', () => {
    it('has at least 5 providers', () => {
        expect(Object.keys(BUILTIN_PROVIDERS).length).to.be.greaterThanOrEqual(5);
    });

    it('every provider has required fields', () => {
        for (const [key, p] of Object.entries(BUILTIN_PROVIDERS)) {
            expect(p.id, `${key}.id`).to.be.a('string').with.length.greaterThan(0);
            expect(p.name, `${key}.name`).to.be.a('string').with.length.greaterThan(0);
            // Custom endpoints are entered by the user.
            if (key !== 'custom') {
                expect(p.endpoint, `${key}.endpoint`).to.be.a('string').with.length.greaterThan(0);
            }
            expect(p.maxContextTokens, `${key}.maxContextTokens`).to.be.a('number');
            expect(p.maxContextTokens, `${key}.maxContextTokens`).to.be.greaterThan(0);
            // ollama is auto-detected; custom is user-entered.
            if (key !== 'ollama' && key !== 'custom') {
                expect(p.defaultModel, `${key}.defaultModel`).to.be.a('string').with.length.greaterThan(0);
                expect(p.models, `${key}.models`).to.be.an('array').with.length.greaterThan(0);
            }
        }
    });

    it('routes the ChatGPT subscription provider through OAuth Responses', () => {
        const codex = BUILTIN_PROVIDERS['codex-chatgpt']!;
        expect(codex.runtimeKind).to.equal('http');
        expect(codex.authKind).to.equal('chatgpt-oauth');
        expect(codex.endpoint).to.equal('https://chatgpt.com/backend-api/codex');
        expect(codex.requiresApiKey).to.equal(false);
        expect(codex.supportsFIM).to.equal(false);
        expect(codex.supportsUtilityCalls).to.equal(false);
        expect(codex.maxContextTokens).to.equal(272000);
        for (const model of codex.models) {
            expect(getModelContextTokens(model, codex.id), model).to.equal(272000);
        }
        expect(getProviderApiFormat(codex.id, codex.defaultModel)).to.equal('openai-responses');
    });

    it('openai provider exists and is OpenAI compatible', () => {
        const openai = BUILTIN_PROVIDERS['openai'];
        expect(openai).to.not.equal(undefined);
        expect(openai!.isOpenAICompatible).to.equal(true);
    });

    it('uses current direct-provider defaults and supported model IDs', () => {
        expect(BUILTIN_PROVIDERS['openai']!.models).to.include.members([
            'gpt-5.6',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.4-pro',
        ]);
        expect(BUILTIN_PROVIDERS['openai']!.defaultModel).to.equal('gpt-5.5');
        expect(getModelContextTokens('gpt-5.6')).to.equal(1050000);
        expect(getModelContextTokens('gpt-5.6-sol')).to.equal(1050000);
        expect(getModelContextTokens('gpt-5.6-terra')).to.equal(1050000);
        expect(getModelContextTokens('gpt-5.6-luna')).to.equal(400000);
        expect(getModelContextTokens('gpt-5.4-pro')).to.equal(1050000);
        expect(BUILTIN_PROVIDERS['claude']!.models).to.include('claude-sonnet-5');
        expect(BUILTIN_PROVIDERS['glm']!.defaultModel).to.equal('glm-5.2');
        expect(BUILTIN_PROVIDERS['glm']!.models).to.include.members([
            'glm-4.7-flashx',
            'glm-4.6',
            'glm-4.6v',
        ]);
        expect(BUILTIN_PROVIDERS['glm']!.models).to.not.include.members([
            'glm-5-air',
            'glm-5-flash',
            'glm-5v',
            'glm-5v-flash',
        ]);
        expect(BUILTIN_PROVIDERS['qwen']!.defaultModel).to.equal('qwen3.7-max-2026-06-08');
        expect(BUILTIN_PROVIDERS['qwen']!.models).to.not.include('qwen3.7-flash');
        expect(BUILTIN_PROVIDERS['google']!.models).to.deep.equal([
            'gemini-3.5-flash',
            'gemini-3.6-flash',
            'gemini-3.1-pro-preview',
            'gemini-3.1-flash-lite',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
        ]);
        expect(BUILTIN_PROVIDERS['kimi']!.defaultModel).to.equal('kimi-k3');
        expect(BUILTIN_PROVIDERS['kimi']!.endpoint).to.equal('https://api.moonshot.cn/v1');
        expect(ALWAYS_THINKING_PREFIXES).to.include('kimi-k2.7-code');
        expect(ALWAYS_THINKING_PREFIXES).to.include('kimi-k3');
    });

    it('registers the Kimi Code Plan subscription provider', () => {
        const plan = BUILTIN_PROVIDERS['kimi-code-plan']!;
        expect(plan.endpoint).to.equal('https://api.kimi.com/coding/v1');
        expect(plan.defaultModel).to.equal('kimi-for-coding');
        expect(plan.models).to.deep.equal(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed']);
        expect(plan.isOpenAICompatible).to.equal(true);
        expect(ALWAYS_THINKING_PREFIXES).to.include('kimi-for-coding');
        expect(isModelVisionCapable('kimi-for-coding')).to.equal(true);
        expect(getModelContextTokens('kimi-for-coding', 'kimi-code-plan')).to.equal(1048576);
        expect(getModelOutputTokens('kimi-for-coding', 'kimi-code-plan')).to.equal(131072);
    });

    it('uses the current GitHub Models inference endpoint and catalog IDs', () => {
        const github = BUILTIN_PROVIDERS['github']!;
        expect(github.endpoint).to.equal('https://models.github.ai/inference');
        expect(github.defaultModel).to.equal('openai/gpt-5');
        expect(github.models).to.include.members([
            'openai/gpt-5',
            'openai/gpt-5-mini',
            'openai/gpt-4.1',
            'deepseek/deepseek-r1-0528',
            'microsoft/phi-4-reasoning',
        ]);
    });

    it('matches the enabled OpenCode paid and free model list', () => {
        const opencode = BUILTIN_PROVIDERS['opencode']!;
        expect(opencode.defaultModel).to.equal('big-pickle');
        expect(opencode.models).to.have.length(52);
        expect(opencode.models.filter(model => model.includes('('))).to.have.length(0);
        expect(opencode.models).to.include.members([
            'claude-fable-5',
            'claude-opus-4-8',
            'claude-sonnet-5',
            'gpt-5.5-pro',
            'gemini-3.5-flash',
            'deepseek-v4-flash-free',
            'big-pickle',
            'glm-5.2',
            'kimi-k2.7-code',
            'minimax-m3',
            'hy3-free',
            'north-mini-code-free',
        ]);
        expect(opencode.models).to.not.include.members([
            'minimax-m2.5-free',
            'minimax-m3-free',
            'nemotron-3-super-free',
        ]);
        expect(Object.keys(OPENCODE_MODEL_LIMITS)).to.have.length(56);
    });

    it('matches the OpenCode Go model list and limits', () => {
        const go = BUILTIN_PROVIDERS['opencode-go']!;
        expect(go).to.not.equal(undefined);
        expect(go.endpoint).to.equal('https://opencode.ai/zen/go/v1');
        expect(go.defaultModel).to.equal('glm-5.2');
        expect(go.models).to.have.length(13);
        expect(go.models).to.include.members([
            'glm-5.2',
            'kimi-k2.7-code',
            'mimo-v2.5-pro',
            'minimax-m3',
            'qwen3.7-max',
            'deepseek-v4-pro',
        ]);
        expect(go.requiresApiKey).to.equal(true);
        expect(go.supportsVision).to.equal(true);
        expect(Object.keys(OPENCODE_GO_MODEL_LIMITS)).to.have.length(13);
        expect(getModelContextTokens('glm-5.2', 'opencode-go')).to.equal(1000000);
        expect(getModelContextTokens('deepseek-v4-pro', 'opencode-go')).to.equal(1000000);
        expect(getModelContextTokens('minimax-m2.7', 'opencode-go')).to.equal(204800);
        expect(getModelOutputTokens('kimi-k2.7-code', 'opencode-go')).to.equal(262144);
        expect(getModelOutputTokens('deepseek-v4-flash', 'opencode-go')).to.equal(384000);
    });
});

describe('MODEL_CONTEXT_TOKENS', () => {
    it('has at least 20 entries', () => {
        expect(Object.keys(MODEL_CONTEXT_TOKENS).length).to.be.greaterThanOrEqual(20);
    });

    it('all values are positive numbers', () => {
        for (const [key, val] of Object.entries(MODEL_CONTEXT_TOKENS)) {
            expect(val, key).to.be.a('number').and.greaterThan(0);
        }
    });

    it('no duplicate keys', () => {
        const keys = Object.keys(MODEL_CONTEXT_TOKENS);
        expect(keys.length).to.equal(new Set(keys).size);
    });
});

describe('VISION_CAPABLE_MODELS', () => {
    it('has at least 10 entries', () => {
        expect(Object.keys(VISION_CAPABLE_MODELS).length).to.be.greaterThanOrEqual(10);
    });

    it('all values are booleans', () => {
        for (const [key, val] of Object.entries(VISION_CAPABLE_MODELS)) {
            expect(val, key).to.be.a('boolean');
        }
    });
});

describe('FIM_CAPABLE_MODELS', () => {
    it('has at least 5 entries', () => {
        expect(Object.keys(FIM_CAPABLE_MODELS).length).to.be.greaterThanOrEqual(5);
    });

    it('all values are booleans', () => {
        for (const [key, val] of Object.entries(FIM_CAPABLE_MODELS)) {
            expect(val, key).to.be.a('boolean');
        }
    });
});
