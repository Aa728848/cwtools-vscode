import { expect } from 'chai';

describe('provider model discovery protocol matrix', () => {
    it('uses Anthropic discovery and auth candidates for native and token-plan channels', () => {
        const { buildModelsRequests } = loadChatSettings();
        for (const [providerId, endpoint] of [
            ['claude', 'https://api.anthropic.com/v1'],
            ['minimax-token-plan', 'https://api.minimaxi.com/anthropic/v1'],
        ] as const) {
            const requests = buildModelsRequests(providerId, endpoint, 'test-key', 'openai-chat-completions');
            expect(requests.some(request => request.url === `${endpoint}/models` && request.headers['x-api-key'] === 'test-key')).to.equal(true);
            expect(requests.some(request => request.url === `${endpoint}/models` && request.headers.Authorization === 'Bearer test-key')).to.equal(true);
        }
    });

    it('normalizes a copied Google OpenAI endpoint back to native Gemini model discovery', () => {
        const { buildModelsRequests } = loadChatSettings();
        const requests = buildModelsRequests(
            'custom',
            'https://generativelanguage.googleapis.com/v1beta/openai',
            'google-key',
            'gemini-generate-content',
        );

        expect(requests).to.deep.equal([{
            url: 'https://generativelanguage.googleapis.com/v1beta/models',
            headers: { 'x-goog-api-key': 'google-key' },
            label: 'Gemini /models',
        }]);
    });

    it('keeps Bearer auth for non-Google Gemini-compatible gateways', () => {
        const { buildModelsRequests } = loadChatSettings();
        const requests = buildModelsRequests(
            'custom',
            'https://relay.example/v1',
            'relay-key',
            'gemini-generate-content',
        );
        expect(requests[0]!.headers).to.deep.equal({ Authorization: 'Bearer relay-key' });
    });
});

function loadChatSettings() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/chatSettings') as typeof import('../../extension/ai/chatSettings');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({ get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue }),
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
