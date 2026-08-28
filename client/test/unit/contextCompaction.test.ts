import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, TokenUsage } from '../../extension/ai/types';
import { runContextMaintenance } from '../../extension/ai/runner/contextMaintenance';

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
        const completed = steps.find(step => step.compactionInfo?.state === 'complete');
        expect(completed.compactionInfo.afterTokens).to.be.greaterThan(0);
        expect(completed.compactionInfo.afterTokens).to.be.lessThan(completed.compactionInfo.beforeTokens);
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


describe('compaction efficiency (unified summary plan §5.1)', () => {
    const promptBuilderStub = { buildCompactionPrompt: () => 'compact' } as any;
    const defaultResponse = () => ({
        choices: [{ message: { role: 'assistant', content: 'SUMMARY' }, finish_reason: 'stop' }],
    });
    const runnerOptions = { providerId: 'openai', model: 'gpt-test' } as any;

    function makeSpacedHistory(messageCount: number, charsPerMessage: number): ChatMessage[] {
        return Array.from({ length: messageCount }, (_, index): ChatMessage => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message-${index} ${'word '.repeat(Math.max(1, Math.floor(charsPerMessage / 5)))}`,
        }));
    }

    function makeAiServiceStub(maxContextTokens: number, respond: (opts: any) => any = defaultResponse) {
        let calls = 0;
        const aiService = {
            getConfig: () => ({
                provider: 'openai',
                model: 'gpt-test',
                maxContextTokens,
                customApiFormat: 'openai-chat-completions',
            }),
            chatCompletion: async (_messages: ChatMessage[], opts: any) => {
                calls++;
                return respond(opts);
            },
        };
        return { aiService: aiService as any, getCalls: () => calls };
    }

    it('honors a coordinator request estimate even when history-only tokens are below the legacy minimum', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const { aiService, getCalls } = makeAiServiceStub(4_000);
        const result = await maybeCompactHistory(
            makeSpacedHistory(2, 1_000),
            () => undefined,
            { aiService, promptBuilder: promptBuilderStub },
            runnerOptions,
            undefined,
            undefined,
            {
                // Full request (fixed prompt + schemas + history) is over the
                // 80% threshold even though history alone is under 2,048.
                precomputedRequestTokens: 3_500,
            },
        );
        expect(getCalls()).to.equal(1);
        expect(result.some(message => String(message.content).includes('SUMMARY'))).to.equal(true);
    });

    it('turns an authoritative overflow decision into an actual summarizer request', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const history = makeSpacedHistory(2, 600);
        const maintenance = runContextMaintenance(history, 'overflow', {
            toolResultBudget: 2_000,
            extraTokens: 0,
            summarizeThreshold: 1_000_000,
        });
        expect(maintenance.action).to.equal('summarize');

        const { aiService, getCalls } = makeAiServiceStub(128_000);
        const result = maintenance.action === 'summarize'
            ? await maybeCompactHistory(
                maintenance.messages,
                () => undefined,
                { aiService, promptBuilder: promptBuilderStub },
                runnerOptions,
                undefined,
                undefined,
                { force: true },
            )
            : maintenance.messages;

        expect(getCalls()).to.equal(1);
        expect(result.some(message => String(message.content).includes('SUMMARY'))).to.equal(true);
    });

    it('passes the caller abort signal to the paid summarization request', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const controller = new AbortController();
        let seenSignal: unknown;
        const { aiService, getCalls } = makeAiServiceStub(4_000, opts => {
            seenSignal = opts?.abortSignal;
            return defaultResponse();
        });
        const result = await maybeCompactHistory(
            makeSpacedHistory(8, 2_000),
            () => undefined,
            { aiService, promptBuilder: promptBuilderStub },
            runnerOptions,
            undefined,
            undefined,
            { force: true, abortSignal: controller.signal },
        );
        expect(getCalls()).to.equal(1);
        expect(seenSignal).to.equal(controller.signal);
        expect(result.some(m => String(m.content).includes('SUMMARY'))).to.equal(true);
    });

    it('aborts before the paid call when the turn was already cancelled', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const controller = new AbortController();
        controller.abort();
        const steps: any[] = [];
        const { aiService, getCalls } = makeAiServiceStub(4_000);
        const result = await maybeCompactHistory(
            makeSpacedHistory(8, 2_000),
            step => steps.push(step),
            { aiService, promptBuilder: promptBuilderStub },
            runnerOptions,
            undefined,
            undefined,
            { force: true, abortSignal: controller.signal },
        );
        expect(getCalls()).to.equal(0);
        expect(steps.some(step => step.compactionInfo?.state === 'failed')).to.equal(true);
        expect(result.some(m => String(m.content).includes('## Conversation Summary (compacted)'))).to.equal(false);
    });

    it('adds summarization usage into the provided token accumulator', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const accumulator: TokenUsage = {
            total: 0,
            input: 0,
            output: 0,
            estimatedCostCny: 0,
            agentMode: 'build',
            toolFocus: 'discovery',
        };
        const { aiService, getCalls } = makeAiServiceStub(4_000, () => ({
            ...defaultResponse(),
            usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, cached_tokens: 30 },
            model: 'gpt-test',
        }));
        await maybeCompactHistory(
            makeSpacedHistory(8, 2_000),
            () => undefined,
            { aiService, promptBuilder: promptBuilderStub },
            runnerOptions,
            accumulator,
            undefined,
            { force: true },
        );
        expect(getCalls()).to.equal(1);
        expect(accumulator.input).to.equal(120);
        expect(accumulator.output).to.equal(40);
        expect(accumulator.total).to.equal(160);
        expect(accumulator.cachedTokens).to.equal(30);
        expect(accumulator.netInput).to.equal(90);
        expect(accumulator.cacheRequests).to.deep.include({
            provider: 'openai',
            model: 'gpt-test',
            inputTokens: 120,
            cachedTokens: 30,
            cacheCapable: true,
            agentMode: 'build',
            toolFocus: 'discovery',
            promptFingerprint: accumulator.cacheRequests?.[0]?.promptFingerprint,
            purpose: 'compaction',
            invalidationReason: undefined,
        });
        expect(accumulator.estimatedCostCny).to.be.greaterThanOrEqual(0);
    });

    it('reuses the previous summary when the transcript has not changed', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const { aiService, getCalls } = makeAiServiceStub(4_000);
        const run = (history: ChatMessage[]) => maybeCompactHistory(
            history,
            () => undefined,
            { aiService, promptBuilder: promptBuilderStub },
            runnerOptions,
            undefined,
            undefined,
            { force: true },
        );

        const first = await run(makeSpacedHistory(8, 2_000));
        expect(getCalls()).to.equal(1);
        const second = await run(makeSpacedHistory(8, 2_000));
        expect(getCalls()).to.equal(1);
        expect(second.map(m => m.content)).to.deep.equal(first.map(m => m.content));

        // The cached copy is isolated from caller-side mutation of a previous result.
        first.push({ role: 'user', content: 'caller-side mutation' });
        const third = await run(makeSpacedHistory(8, 2_000));
        expect(getCalls()).to.equal(1);
        expect(third.some(m => m.content === 'caller-side mutation')).to.equal(false);

        // New content invalidates the fingerprint and pays for a fresh summary.
        await run([...makeSpacedHistory(8, 2_000), { role: 'user', content: 'new evidence' }]);
        expect(getCalls()).to.equal(2);
    });

    it('throttles automatic compactions inside the minimum interval', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const { aiService, getCalls } = makeAiServiceStub(4_000);
        const throttle = { lastAutoCompactionAt: Date.now(), minIntervalMs: 60_000 };
        const runAuto = (history: ChatMessage[]) => maybeCompactHistory(
            history,
            () => undefined,
            { aiService, promptBuilder: promptBuilderStub },
            runnerOptions,
            undefined,
            undefined,
            { autoThrottle: throttle },
        );

        // Compacted 0 ms ago: the follow-up auto compaction is skipped entirely.
        const history = makeSpacedHistory(8, 2_000);
        const skipped = await runAuto(history);
        expect(getCalls()).to.equal(0);
        expect(skipped.map(m => m.content)).to.deep.equal(history.map(m => m.content));

        // After the interval, the auto compaction runs and re-arms the throttle.
        throttle.lastAutoCompactionAt = 0;
        const compacted = await runAuto(history);
        expect(getCalls()).to.equal(1);
        expect(throttle.lastAutoCompactionAt).to.be.greaterThan(0);
        expect(compacted.some(m => String(m.content).includes('## Conversation Summary (compacted)'))).to.equal(true);

        // A changed transcript within the interval is still throttled (no cache reuse, no paid call).
        const changed = await runAuto([...makeSpacedHistory(8, 2_000), { role: 'user', content: 'extra evidence' }]);
        expect(getCalls()).to.equal(1);
        expect(changed.some(m => String(m.content).includes('## Conversation Summary (compacted)'))).to.equal(false);
    });

    it('bypasses the minimum interval when the context is nearly full', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const { aiService, getCalls } = makeAiServiceStub(4_000);
        const throttle = { lastAutoCompactionAt: Date.now(), minIntervalMs: 60_000 };
        // ~5000 estimated tokens > 0.92 * 4000, so the throttle must not skip.
        await maybeCompactHistory(
            makeSpacedHistory(10, 2_000),
            () => undefined,
            { aiService, promptBuilder: promptBuilderStub },
            runnerOptions,
            undefined,
            undefined,
            { autoThrottle: throttle },
        );
        expect(getCalls()).to.equal(1);
    });

    it('trims the retained tail toward the low-watermark target', async () => {
        const { maybeCompactHistory, clearCompactionSummaryCache } = loadCompaction();
        clearCompactionSummaryCache();
        const history = makeSpacedHistory(10, 2_000);
        const { aiService: tightService } = makeAiServiceStub(4_000);
        const tight = await maybeCompactHistory(
            history,
            () => undefined,
            { aiService: tightService, promptBuilder: promptBuilderStub },
            runnerOptions,
            undefined,
            undefined,
            { force: true },
        );
        // target = 4000 * 0.60 = 2400 and the summary reserve is 2048, so only
        // one recent message fits under the low watermark (summary pair + tail).
        expect(tight.length).to.equal(3);

        clearCompactionSummaryCache();
        const { aiService: roomyService } = makeAiServiceStub(1_000_000);
        const roomy = await maybeCompactHistory(
            history,
            () => undefined,
            { aiService: roomyService, promptBuilder: promptBuilderStub },
            runnerOptions,
            undefined,
            undefined,
            { force: true },
        );
        // Same transcript with a large window keeps the full COMPACTION_KEEP_LAST_N tail.
        expect(roomy.length).to.equal(2 + 8);
    });

    it('run() no longer schedules the retired per-turn background summary', () => {
        // §5.1 removed the background compactHistory trigger from AgentRunner.run().
        // Constructing a full AgentRunner here is impractical, so guard the removal
        // by asserting the runner no longer references the contextMemory module.
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'ai', 'agentRunner.ts'), 'utf-8');
        expect(source.includes('contextMemory')).to.equal(false);
    });
});
