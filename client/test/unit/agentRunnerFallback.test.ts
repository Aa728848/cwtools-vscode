import { expect } from 'chai';

describe('AgentRunner fallback eligibility', () => {
    it('treats upstream 5xx and timeout phrasing as fallback-eligible', () => {
        const { isFallbackEligibleApiError } = loadAgentRunner();

        expect(isFallbackEligibleApiError(new Error('OpenAI API error (500): upstream error: do request failed'))).to.equal(true);
        expect(isFallbackEligibleApiError(new Error('OpenAI API request timed out after 20m'))).to.equal(true);
    });
});

function loadAgentRunner() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/agentRunner') as typeof import('../../extension/ai/agentRunner');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
        workspaceFolders: [],
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
