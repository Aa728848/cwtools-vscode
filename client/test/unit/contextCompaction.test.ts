import { expect } from 'chai';
import type { ChatMessage } from '../../extension/ai/types';

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

function loadCompaction() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/compaction') as typeof import('../../extension/ai/runner/compaction');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('context compaction', () => {
    it('uses explicit settings before model and provider defaults', () => {
        const { resolveCompactionContextLimit } = loadCompaction();
        expect(resolveCompactionContextLimit('ollama', 'unknown-local-model', 24_000)).to.equal(24_000);
        expect(resolveCompactionContextLimit('ollama', 'unknown-local-model', 0)).to.equal(32_768);
        expect(resolveCompactionContextLimit('openai', 'gpt-5.5', 0)).to.equal(1_050_000);
    });

    it('replaces an older rolling summary instead of accumulating summary pairs', async () => {
        const { maybeCompactHistory } = loadCompaction();
        const history: ChatMessage[] = [
            { role: 'user', content: '[Context Recovery] old summary' },
            { role: 'assistant', content: '## Conversation Summary (compacted)\nOLD_SUMMARY' },
            ...Array.from({ length: 4 }, (_, index): ChatMessage => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `message-${index} ${'context '.repeat(80)}`,
            })),
        ];
        const aiService = {
            getConfig: () => ({
                provider: 'openai',
                model: 'gpt-test',
                maxContextTokens: 4_000,
                customApiFormat: 'openai-chat-completions',
            }),
            chatCompletion: async () => ({
                choices: [{ message: { role: 'assistant', content: 'NEW_SUMMARY' }, finish_reason: 'stop' }],
            }),
        };
        const steps: any[] = [];
        const result = await maybeCompactHistory(
            history,
            step => steps.push(step),
            { aiService: aiService as any, promptBuilder: { buildCompactionPrompt: () => 'compact' } as any },
            { providerId: 'openai', model: 'gpt-test' },
            undefined,
            undefined,
            { force: true },
        );

        expect(result.filter(message => String(message.content).includes('[Context Recovery]'))).to.have.length(1);
        expect(result.some(message => String(message.content).includes('OLD_SUMMARY'))).to.equal(false);
        expect(result.some(message => String(message.content).includes('NEW_SUMMARY'))).to.equal(true);
        expect(steps.map(step => step.compactionInfo?.state)).to.deep.equal(['start', 'complete']);
    });

    it('preserves leading system instructions for providers without OpenAI prefix caching', async () => {
        const { maybeCompactHistory } = loadCompaction();
        const history: ChatMessage[] = [
            { role: 'system', content: 'base system prompt' },
            { role: 'system', content: 'workspace safety policy' },
            ...Array.from({ length: 12 }, (_, index): ChatMessage => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `message-${index} ${'context '.repeat(80)}`,
            })),
        ];
        const aiService = {
            getConfig: () => ({
                provider: 'anthropic',
                model: 'claude-test',
                maxContextTokens: 4_000,
            }),
            chatCompletion: async () => ({
                choices: [{ message: { role: 'assistant', content: 'SAFE_SUMMARY' }, finish_reason: 'stop' }],
            }),
        };

        const result = await maybeCompactHistory(
            history,
            () => undefined,
            { aiService: aiService as any, promptBuilder: { buildCompactionPrompt: () => 'compact' } as any },
            { providerId: 'anthropic', model: 'claude-test' },
            undefined,
            undefined,
            { force: true },
        );

        expect(result.slice(0, 2).map(message => message.content)).to.deep.equal([
            'base system prompt',
            'workspace safety policy',
        ]);
        expect(result.some(message => String(message.content).includes('SAFE_SUMMARY'))).to.equal(true);
    });
});
