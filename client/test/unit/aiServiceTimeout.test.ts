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

describe('AIService OpenAI Responses payload', () => {
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
