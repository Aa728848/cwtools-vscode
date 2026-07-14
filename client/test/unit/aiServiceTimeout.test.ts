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

describe('AIService session overrides', () => {
    it('applies model and reasoning overrides without persisting configuration', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any);
        service.setModelOverride('session-model');
        service.setReasoningEffortOverride('medium');

        expect(service.getModelOverride()).to.equal('session-model');
        expect(service.getReasoningEffortOverride()).to.equal('medium');
        expect(service.getConfig().model).to.equal('session-model');
        expect(service.getConfig().reasoningEffort).to.equal('medium');
    });
});

describe('AIService OpenAI Responses payload', () => {
    it('enables the isolated Responses fast path with streaming, parallel tools, summaries, and a hashed cache key', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.5',
            messages: [{ role: 'user', content: 'Run checks' }],
            reasoning_effort: 'medium',
            tools: [{
                type: 'function',
                function: { name: 'run_command', description: 'Run a command', parameters: { type: 'object' } },
            }],
        }, {
            fastPath: true,
            promptCacheKey: 'agent-thread:thread-1',
            reasoningSummary: 'auto',
        });

        expect(payload.stream).to.equal(true);
        expect(payload.parallel_tool_calls).to.equal(true);
        expect(payload.reasoning).to.deep.equal({ effort: 'medium', summary: 'auto' });
        expect(payload.prompt_cache_key).to.match(/^cwtools:[a-f0-9]{32}$/);
    });

    it('keeps non-OpenAI Responses-compatible providers on the legacy JSON payload shape', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const payload = service.buildOpenAIResponsesPayload({
            model: 'relay-model',
            messages: [{ role: 'user', content: 'Hello' }],
            tools: [{
                type: 'function',
                function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
            }],
        });

        expect(payload).to.not.have.property('stream');
        expect(payload).to.not.have.property('parallel_tool_calls');
        expect(payload).to.not.have.property('prompt_cache_key');
    });

    it('does not replay call_id as the Responses function_call item id', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.5',
            messages: [{
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"filePath":"test.txt"}' },
                }],
            }, {
                role: 'tool',
                content: '{"success":true}',
                tool_call_id: 'call_1',
                name: 'read_file',
            }],
        });

        expect(payload.input[0]).to.deep.equal({
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"filePath":"test.txt"}',
        });
        expect(payload.input[1]).to.deep.equal({
            type: 'function_call_output',
            call_id: 'call_1',
            output: '{"success":true}',
        });
    });

    it('replays the Responses fc item id when it was preserved', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.5',
            messages: [{
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    responseItemId: 'fc_abc123',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{}' },
                }],
            }],
        });

        expect(payload.input[0]).to.deep.equal({
            type: 'function_call',
            id: 'fc_abc123',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{}',
        });
    });

    it('preserves the Responses function_call item id from API output', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.fetchWithRetry = async () => ({
            ok: true,
            json: async () => ({
                id: 'resp_1',
                model: 'gpt-5.5',
                output: [{
                    type: 'function_call',
                    id: 'fc_abc123',
                    call_id: 'call_1',
                    name: 'read_file',
                    arguments: '{}',
                }],
                usage: {},
            }),
        });

        const response = await service.callOpenAIResponses(
            'https://api.openai.com/v1',
            'test-key',
            { model: 'gpt-5.5', messages: [{ role: 'user', content: 'read' }] },
            'custom',
            new AbortController(),
        );

        expect(response.choices[0].message.tool_calls[0].id).to.equal('call_1');
        expect(response.choices[0].message.tool_calls[0].responseItemId).to.equal('fc_abc123');
    });

    it('normalizes Responses cached token usage from known provider fields', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const cases = [
            {
                usage: { input_tokens: 2000, output_tokens: 50, input_tokens_details: { cached_tokens: 512, cache_creation_tokens: 128 } },
                cached: 512,
                created: 128,
            },
            {
                usage: { prompt_tokens: 2000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 768, cache_creation_tokens: 64 } },
                cached: 768,
                created: 64,
            },
            {
                usage: { input_tokens: 2000, output_tokens: 50, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 976 },
                cached: 1024,
                created: 976,
            },
        ];

        for (const testCase of cases) {
            service.fetchWithRetry = async () => ({
                ok: true,
                json: async () => ({
                    id: 'resp_usage',
                    model: 'gpt-5.5',
                    output_text: 'ok',
                    usage: testCase.usage,
                }),
            });

            const response = await service.callOpenAIResponses(
                'https://api.openai.com/v1',
                'test-key',
                { model: 'gpt-5.5', messages: [{ role: 'user', content: 'read' }] },
                'custom',
                new AbortController(),
            );

            expect(response.usage!.cached_tokens).to.equal(testCase.cached);
            expect(response.usage!.cache_creation_tokens).to.equal(testCase.created);
        }
    });

    it('streams Responses text, reasoning summaries, and function arguments incrementally', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const requestBodies: Record<string, any>[] = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            requestBodies.push(JSON.parse(init.body as string));
            return responsesSseResponse([
                { type: 'response.created', response: { id: 'resp_stream', model: 'gpt-5.5', status: 'in_progress' } },
                { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_stream', call_id: 'call_stream', name: 'read_file', arguments: '' } },
                { type: 'response.reasoning_summary_text.delta', delta: 'Checking context. ' },
                { type: 'response.output_text.delta', delta: 'I will read it.' },
                { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_stream', delta: '{"filePath":' },
                { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_stream', delta: '"test.txt"}' },
                { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_stream', arguments: '{"filePath":"test.txt"}' },
                { type: 'response.completed', response: { id: 'resp_stream', model: 'gpt-5.5', status: 'completed', usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } } } },
            ]);
        };
        const textDeltas: string[] = [];
        const thinkingDeltas: string[] = [];
        const toolDeltas: Array<{ name: string; args: string }> = [];

        const response = await service.callOpenAIResponses(
            'https://api.openai.com/v1',
            'test-key',
            { model: 'gpt-5.5', messages: [{ role: 'user', content: 'read' }] },
            'openai',
            new AbortController(),
            {
                onTextDelta: (delta: string) => textDeltas.push(delta),
                onThinking: (delta: string) => thinkingDeltas.push(delta),
                onToolCallDelta: (name: string, args: string) => toolDeltas.push({ name, args }),
                promptCacheKey: 'agent-thread:thread-1',
                reasoningSummary: 'auto',
            },
        );

        expect(requestBodies[0]!.stream).to.equal(true);
        expect(textDeltas).to.deep.equal(['I will read it.']);
        expect(thinkingDeltas).to.deep.equal(['Checking context. ']);
        expect(toolDeltas.at(-1)).to.deep.equal({ name: 'read_file', args: '{"filePath":"test.txt"}' });
        expect(response.choices[0].message.content).to.equal('I will read it.');
        expect(response.choices[0].message.tool_calls![0]).to.deep.include({ id: 'call_stream', responseItemId: 'fc_stream' });
        expect(response.choices[0].message.tool_calls![0]!.function.arguments).to.equal('{"filePath":"test.txt"}');
        expect(response.usage!.cached_tokens).to.equal(40);
    });
});

describe('AIService Anthropic Messages compatibility', () => {
    it('sends a plain Messages body for custom compatible relays', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const calls: Array<{ headers: Record<string, string>; body: Record<string, any> }> = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            calls.push({
                headers: init.headers as Record<string, string>,
                body: JSON.parse(init.body as string),
            });
            return anthropicSseResponse();
        };

        await service.callClaude(
            'https://relay.example/v1',
            'test-key',
            {
                model: 'claude-opus-4-7',
                messages: [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'Hi' },
                ],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'read_file',
                        description: 'Read a file',
                        parameters: { type: 'object', properties: {} },
                    },
                }],
            },
            new AbortController(),
            undefined,
            undefined,
            undefined,
            'custom',
        );

        expect(calls).to.have.length(1);
        const firstCall = calls[0]!;
        expect(firstCall.headers['x-api-key']).to.equal('test-key');
        expect(firstCall.body.system).to.equal('System prompt');
        expect(JSON.stringify(firstCall.body)).to.not.include('cache_control');
    });

    it('retries custom Messages requests with Bearer auth after auth failure', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const headers: Array<Record<string, string>> = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            headers.push(init.headers as Record<string, string>);
            if (headers.length === 1) {
                return {
                    ok: false,
                    status: 401,
                    text: async () => 'Unauthorized',
                };
            }
            return anthropicSseResponse();
        };

        await service.callClaude(
            'https://relay.example/v1',
            'test-key',
            { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'Hi' }] },
            new AbortController(),
            undefined,
            undefined,
            undefined,
            'custom',
        );

        expect(headers).to.have.length(2);
        const firstHeaders = headers[0]!;
        const secondHeaders = headers[1]!;
        expect(firstHeaders['x-api-key']).to.equal('test-key');
        expect(secondHeaders.Authorization).to.equal('Bearer test-key');
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

function anthropicSseResponse(): Response {
    const encoder = new TextEncoder();
    const chunk = [
        'event: message_start',
        'data: {"message":{"model":"claude-test","usage":{"input_tokens":1}}}',
        '',
        'event: content_block_start',
        'data: {"index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"index":0,"delta":{"type":"text_delta","text":"ok"}}',
        '',
        'event: message_delta',
        'data: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        '',
    ].join('\n');
    return {
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(chunk));
                controller.close();
            },
        }),
    } as Response;
}

function responsesSseResponse(events: Record<string, unknown>[]): Response {
    const encoder = new TextEncoder();
    const chunks = events.map(event => `data: ${JSON.stringify(event)}\n\n`);
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            },
        }),
    } as Response;
}
