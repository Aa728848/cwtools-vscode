import { expect } from 'chai';

describe('AIService request timeout policy', () => {
    it('normalizes missing and invalid request timeouts to 20 minutes', () => {
        const { normalizeChatCompletionTimeoutMs } = loadAIService();
        expect(normalizeChatCompletionTimeoutMs(undefined)).to.equal(20 * 60 * 1000);
        expect(normalizeChatCompletionTimeoutMs(-1)).to.equal(20 * 60 * 1000);
    });

    it('clamps request timeouts to the supported range', () => {
        const { normalizeChatCompletionTimeoutMs } = loadAIService();
        expect(normalizeChatCompletionTimeoutMs(1)).to.equal(60 * 1000);
        expect(normalizeChatCompletionTimeoutMs(90_000)).to.equal(90_000);
        expect(normalizeChatCompletionTimeoutMs(90 * 60 * 1000)).to.equal(60 * 60 * 1000);
    });
});

function loadAIService() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/aiService') as typeof import('../../extension/ai/aiService');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};
