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
    it('keeps model-specific hard-disable params before provider fallbacks', () => {
        const { getReducedThinkingParams } = loadProviders();
        const result = getReducedThinkingParams('qwen3.6-plus', 'openai', 'openai-responses');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ enable_thinking: false });
        expect(result!.injectPrompt).to.equal(true);
        expect(result!.reasoningEffort).to.equal(undefined);
    });

    it('lowers OpenAI reasoning effort when thinking cannot be fully disabled', () => {
        const { getReducedThinkingParams } = loadProviders();
        const result = getReducedThinkingParams('gpt-5.5', 'openai', 'openai-responses');
        expect(result).to.deep.equal({ reasoningEffort: 'low' });
    });

    it('lowers DeepSeek reasoning effort when thinking cannot be fully disabled', () => {
        const { getReducedThinkingParams } = loadProviders();
        const result = getReducedThinkingParams('deepseek-v4-pro', 'deepseek', 'openai-chat-completions');
        expect(result).to.deep.equal({ reasoningEffort: 'low' });
    });

    it('does not add Claude reasoning params because omitting thinking disables it by default', () => {
        const { getReducedThinkingParams } = loadProviders();
        const result = getReducedThinkingParams('claude-opus-4-8', 'claude', 'anthropic-messages');
        expect(result).to.equal(undefined);
    });
});
