const { expect } = require('chai') as typeof import('chai');

const vscodeStub = {
    env: { language: 'en' },
    window: {
        showErrorMessage: () => undefined,
        showWarningMessage: () => undefined,
        showInformationMessage: () => undefined,
    },
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
    },
    commands: {},
};

function loadProviders() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/providers') as typeof import('../../extension/ai/providers');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('provider thinking params', () => {
    it('exposes every current Kimi Code Plan model', () => {
        const { BUILTIN_PROVIDERS, getModelOutputTokens } = loadProviders();
        expect(BUILTIN_PROVIDERS['kimi-code-plan']!.models)
            .to.deep.equal(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed']);
        expect(getModelOutputTokens('k3', 'kimi-code-plan')).to.equal(131072);
    });

    it('keeps model-specific hard-disable params before provider fallbacks', () => {
        const { getReducedThinkingParams } = loadProviders();
        const result = getReducedThinkingParams('qwen3.6-plus', 'openai', 'openai-responses');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ enable_thinking: false });
        expect(result!.injectPrompt).to.equal(true);
        expect(result!.reasoningEffort).to.equal(undefined);
    });

    it('disables OpenAI reasoning with the supported none effort', () => {
        const { getReducedThinkingParams } = loadProviders();
        const result = getReducedThinkingParams('gpt-5.5', 'openai', 'openai-responses');
        expect(result).to.deep.equal({ reasoningEffort: 'none' });
    });

    it('lowers DeepSeek reasoning effort when thinking cannot be fully disabled', () => {
        const { getReducedThinkingParams } = loadProviders();
        const result = getReducedThinkingParams('deepseek-v4-pro', 'deepseek', 'openai-chat-completions');
        expect(result).to.deep.equal({ extraBody: { thinking: { type: 'disabled' } } });
    });

    it('keeps older Claude models fast by omitting optional thinking params', () => {
        const { getReducedThinkingParams } = loadProviders();
        const result = getReducedThinkingParams('claude-opus-4-8', 'claude', 'anthropic-messages');
        expect(result).to.equal(undefined);
    });

    it('uses the supported fast path for default-thinking Claude 5 models', () => {
        const { getReducedThinkingParams, toClaudeRequest } = loadProviders();
        const sonnet = getReducedThinkingParams('claude-sonnet-5', 'claude', 'anthropic-messages');
        expect(sonnet).to.deep.equal({ extraBody: { thinking: { type: 'disabled' } } });
        expect(toClaudeRequest({
            model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Hello' }], ...(sonnet?.extraBody ?? {}),
        }).thinking).to.deep.equal({ type: 'disabled' });
        expect(getReducedThinkingParams('claude-fable-5', 'claude', 'anthropic-messages'))
            .to.deep.equal({ reasoningEffort: 'low' });
    });

    it('maps OpenRouter reasoning models to its normalized effort object', () => {
        const { getThinkingParams } = loadProviders();
        expect(getThinkingParams('google/gemini-3.5-flash', 'openrouter', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { reasoning: { effort: 'high' } } });
        expect(getThinkingParams('deepseek/deepseek-v4-pro', 'openrouter', 'openai-chat-completions', 'medium'))
            .to.deep.equal({ extraBody: { reasoning: { effort: 'high' } } });
        expect(getThinkingParams('moonshotai/kimi-k2.7-code', 'openrouter', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { reasoning: { enabled: true } } });
    });

    it('maps Qwen levels to thinking budgets', () => {
        const { getThinkingParams } = loadProviders();
        expect(getThinkingParams('qwen3.7-plus', 'qwen', 'openai-chat-completions', 'low'))
            .to.deep.equal({ extraBody: { enable_thinking: true, thinking_budget: 2048 } });
        expect(getThinkingParams('qwen3.7-plus', 'qwen', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { enable_thinking: true, thinking_budget: 262144 } });
    });

    it('uses Gemini 3 levels and Gemini 2.5 budgets', () => {
        const { getThinkingParams } = loadProviders();
        expect(getThinkingParams('gemini-3.5-flash', 'google', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { google: { thinking_config: { thinking_level: 'high' } } } });
        expect(getThinkingParams('gemini-2.5-flash', 'google', 'openai-chat-completions', 'high'))
            .to.deep.equal({ extraBody: { google: { thinking_config: { thinking_budget: 24576 } } } });
    });

    it('maps GLM 5.2 and DeepSeek V4 effort controls', () => {
        const { getThinkingParams } = loadProviders();
        expect(getThinkingParams('glm-5.2', 'glm', 'openai-chat-completions', 'medium'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: 'high' });
        expect(getThinkingParams('deepseek-v4-pro', 'deepseek', 'openai-chat-completions', 'medium'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: 'high' });
        expect(getThinkingParams('deepseek-v4-pro', 'deepseek', 'openai-chat-completions', 'high'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: 'high' });
        expect(getThinkingParams('deepseek-v4-pro', 'deepseek', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: 'max' });
    });

    it('caps providers that do not accept max effort', () => {
        const { getThinkingParams } = loadProviders();
        expect(getThinkingParams('gpt-oss:120b', 'ollama', 'openai-chat-completions', 'max'))
            .to.deep.equal({ reasoningEffort: 'high' });
        expect(getThinkingParams('deepseek-ai/DeepSeek-R1', 'deepinfra', 'openai-chat-completions', 'max'))
            .to.deep.equal({ reasoningEffort: 'high' });
    });

    it('maps the remaining compatible gateway controls', () => {
        const { getThinkingParams } = loadProviders();
        expect(getThinkingParams('deepseek-ai/DeepSeek-V4-Pro', 'together', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { reasoning: { enabled: true } }, reasoningEffort: 'max' });
        expect(getThinkingParams('openai/gpt-5', 'github', 'openai-chat-completions', 'max')).to.equal(undefined);
        expect(getThinkingParams('Qwen/Qwen3.6-27B', 'siliconflow', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { enable_thinking: true, thinking_budget: 32768 } });
        expect(getThinkingParams('qwen3.7-plus', 'custom', 'openai-chat-completions', 'medium'))
            .to.deep.equal({ extraBody: { enable_thinking: true, thinking_budget: 8192 } });
    });

    it('does not invent levels for models that only expose a switch or no control', () => {
        const { getThinkingParams } = loadProviders();
        expect(getThinkingParams('mimo-v2.5-pro', 'mimo', 'openai-chat-completions', 'low'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } } });
        expect(getThinkingParams('MiniMax-M3', 'minimax', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { thinking: { type: 'adaptive' } } });
        expect(getThinkingParams('meta-llama/Llama-3.3-70B-Instruct', 'together', 'openai-chat-completions', 'max'))
            .to.equal(undefined);
    });

    it('maps Kimi controls by model family', () => {
        const { getThinkingParams, getReducedThinkingParams } = loadProviders();
        expect(getThinkingParams('kimi-k3', 'kimi', 'openai-chat-completions', 'low'))
            .to.deep.equal({ reasoningEffort: 'low' });
        expect(getThinkingParams('kimi-k3', 'kimi', 'openai-chat-completions', 'medium'))
            .to.deep.equal({ reasoningEffort: 'high' });
        expect(getThinkingParams('kimi-k3', 'kimi', 'openai-chat-completions', 'max'))
            .to.deep.equal({ reasoningEffort: 'max' });
        expect(getThinkingParams('k3', 'kimi-code-plan', 'openai-chat-completions', 'medium'))
            .to.deep.equal({ reasoningEffort: 'high' });
        expect(getThinkingParams('kimi-k2.6', 'kimi', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } } });
        expect(getThinkingParams('kimi-k2.7-code', 'kimi', 'openai-chat-completions', 'max')).to.equal(undefined);
        expect(getReducedThinkingParams('kimi-k2.6', 'kimi', 'openai-chat-completions'))
            .to.deep.equal({ extraBody: { thinking: { type: 'disabled' } } });
        expect(getReducedThinkingParams('kimi-k3', 'kimi', 'openai-chat-completions'))
            .to.deep.equal({ reasoningEffort: 'low' });
    });

    it('passes MiniMax M3 adaptive thinking through the Anthropic adapter', () => {
        const { getThinkingParams, toClaudeRequest } = loadProviders();
        const params = getThinkingParams('MiniMax-M3', 'minimax-token-plan', 'anthropic-messages', 'high');
        const request = toClaudeRequest({
            model: 'MiniMax-M3', messages: [{ role: 'user', content: 'Hello' }], ...(params?.extraBody ?? {}),
        });
        expect(request.thinking).to.deep.equal({ type: 'adaptive' });
        expect(request).to.not.have.property('temperature');
    });

    it('applies upstream controls on OpenCode gateway models', () => {
        const { getThinkingParams, getReducedThinkingParams } = loadProviders();
        expect(getThinkingParams('deepseek-v4-pro', 'opencode-go', 'openai-chat-completions', 'medium'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: 'high' });
        expect(getThinkingParams('glm-5.2', 'opencode-go', 'openai-chat-completions', 'max'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: 'max' });
        expect(getReducedThinkingParams('glm-5.2', 'opencode-go', 'openai-chat-completions'))
            .to.deep.equal({ extraBody: { thinking: { type: 'disabled' } } });
        expect(getThinkingParams('kimi-k2.6', 'opencode-go', 'openai-chat-completions', 'high'))
            .to.deep.equal({ extraBody: { thinking: { type: 'enabled' } } });
        expect(getThinkingParams('minimax-m2.7', 'opencode-go', 'anthropic-messages', 'max')).to.equal(undefined);
    });

    it('uses manual Anthropic thinking budgets for Qwen gateways', () => {
        const { getThinkingParams, toClaudeRequest } = loadProviders();
        const params = getThinkingParams('qwen3.7-plus', 'opencode', 'anthropic-messages', 'medium');
        expect(params).to.deep.equal({ extraBody: { thinking_budget: 8192 } });
        const request = toClaudeRequest({
            model: 'qwen3.7-plus',
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 16384,
            ...(params?.extraBody ?? {}),
        });
        expect(request.thinking).to.deep.equal({ type: 'enabled', budget_tokens: 8192 });
        expect(request).to.not.have.property('temperature');
    });

    it('uses manual thinking budgets for Claude models without effort support', () => {
        const { getThinkingParams, toClaudeRequest } = loadProviders();
        const params = getThinkingParams('claude-haiku-4-5', 'claude', 'anthropic-messages', 'medium');
        expect(params).to.deep.equal({ extraBody: { thinking_budget: 8192 } });
        const request = toClaudeRequest({
            model: 'claude-haiku-4-5',
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 64000,
            ...(params?.extraBody ?? {}),
        });
        expect(request.thinking).to.deep.equal({ type: 'enabled', budget_tokens: 8192 });
    });

    it('recognizes unversioned Claude 5 model names', () => {
        const { getAnthropicModelFeatures } = loadProviders();
        expect(getAnthropicModelFeatures('claude-sonnet-5')).to.deep.equal({
            adaptiveThinking: false,
            thinkingDisplay: false,
            effort: true,
            samplingRemoved: true,
        });
    });

    it('describes the exact controls for representative model families', () => {
        const { getModelReasoningCapability } = loadProviders();
        expect(getModelReasoningCapability('openai', 'gpt-5.5', 'openai-responses')).to.deep.equal({
            kind: 'effort',
            options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
            defaultValue: 'high',
        });
        expect(getModelReasoningCapability('deepseek', 'deepseek-v4-pro', 'openai-chat-completions')).to.deep.equal({
            kind: 'effort',
            options: ['none', 'high', 'max'],
            defaultValue: 'high',
        });
        expect(getModelReasoningCapability('glm', 'glm-5.1', 'openai-chat-completions')).to.deep.equal({
            kind: 'toggle',
            options: ['none', 'high'],
            defaultValue: 'high',
        });
        expect(getModelReasoningCapability('kimi', 'kimi-k2.7-code', 'openai-chat-completions')).to.deep.equal({
            kind: 'fixed',
            options: ['high'],
            defaultValue: 'high',
        });
        expect(getModelReasoningCapability('together', 'meta-llama/Llama-3.3-70B-Instruct', 'openai-chat-completions')).to.deep.equal({
            kind: 'none',
            options: [],
            defaultValue: 'high',
        });
    });

    it('returns a deterministic capability for every built-in model', () => {
        const { BUILTIN_PROVIDERS, getModelReasoningCapability, getProviderApiFormat } = loadProviders();
        for (const provider of Object.values(BUILTIN_PROVIDERS)) {
            for (const model of provider.models) {
                const capability = getModelReasoningCapability(
                    provider.id,
                    model,
                    getProviderApiFormat(provider.id, model)
                );
                expect(capability.kind).to.be.oneOf(['none', 'fixed', 'toggle', 'budget', 'effort']);
                expect(capability.options).to.deep.equal(Array.from(new Set(capability.options)));
                if (capability.kind !== 'none') {
                    expect(capability.options).to.include(capability.defaultValue);
                }
            }
        }
    });

    it('uses live gateway metadata when it advertises supported efforts', () => {
        const { parseAdvertisedReasoningCapability } = loadProviders();
        expect(parseAdvertisedReasoningCapability({
            supported_efforts: ['high', 'medium', 'low', 'minimal'],
            default_effort: 'medium',
            default_enabled: true,
            mandatory: true,
        })).to.deep.equal({
            kind: 'effort',
            options: ['high', 'medium', 'low', 'minimal'],
            defaultValue: 'medium',
        });
        expect(parseAdvertisedReasoningCapability({
            default_enabled: false,
        })).to.deep.equal({
            kind: 'toggle',
            options: ['none', 'high'],
            defaultValue: 'none',
        });
        expect(parseAdvertisedReasoningCapability({
            supported_efforts: ['high', 'low'],
            default_effort: 'high',
            default_enabled: true,
            mandatory: false,
        })).to.deep.equal({
            kind: 'effort',
            options: ['none', 'high', 'low'],
            defaultValue: 'high',
        });
        expect(parseAdvertisedReasoningCapability({
            supported_efforts: null,
            default_effort: 'none',
            default_enabled: false,
            mandatory: false,
        })).to.deep.equal({
            kind: 'effort',
            options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
            defaultValue: 'none',
        });
        expect(parseAdvertisedReasoningCapability({
            supports_max_tokens: true,
            default_enabled: true,
            mandatory: false,
        })).to.deep.equal({
            kind: 'budget',
            options: ['none', 'low', 'medium', 'high', 'max'],
            defaultValue: 'high',
        });
    });
});
