import { expect } from 'chai';

describe('ContextMemory Compaction Unit Tests', () => {
    it('gracefully handles empty history and steps without crash', async () => {
        const { compactHistory } = loadContextMemoryModule();
        // Mock AIService with a fake summarizer
        const mockAiService: any = {
            chatCompletion: async () => ({
                choices: [{ message: { content: 'Mocked compact summary response' } }]
            }),
            getConfig: () => ({
                provider: 'deepseek-chat',
                maxContextTokens: 2000
            })
        };

        // This should run smoothly and not throw any errors
        await compactHistory(
            'topic_dummy',
            'run_dummy',
            [],
            [],
            mockAiService
        );
        
        // Assert true to indicate no crashes
        expect(true).to.be.true;
    });
});

function loadContextMemoryModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/contextMemory') as typeof import('../../extension/ai/runner/contextMemory');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
    },
};
