import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

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
        expect(service.getConfig().responseVerbosity).to.equal('default');
        expect(service.getConfig().codexServiceTier).to.equal('default');
    });
});

describe('AIService inline provider isolation', () => {
    it('uses the inline provider default instead of leaking the chat model into FIM', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.getConfig = () => ({
            provider: 'codex-chatgpt',
            model: 'gpt-5.6-sol',
            inlineCompletion: {
                provider: 'deepseek',
                model: '',
                endpoint: '',
            },
        });
        service.getKeyForProvider = async () => 'inline-key';
        service.getEndpointForProvider = () => '';

        const originalFetch = globalThis.fetch;
        const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            requests.push({
                url: String(input),
                body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            });
            return {
                ok: true,
                status: 200,
                json: async () => ({ choices: [{ text: 'fleet_event' }] }),
            } as Response;
        }) as typeof fetch;

        try {
            const completion = await service.fimCompletion('prefix', 'suffix');
            expect(completion).to.equal('fleet_event');
            expect(requests).to.deep.equal([{
                url: 'https://api.deepseek.com/beta/completions',
                body: {
                    model: 'deepseek-v4-pro',
                    prompt: 'prefix',
                    suffix: 'suffix',
                    max_tokens: 256,
                    temperature: 0.2,
                    stream: false,
                },
            }]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('AIService provider protocol routing', () => {
    it('routes the built-in OpenAI provider through the Responses API', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const routes: Array<{ endpoint: string; providerId: string; model: string }> = [];
        service.callOpenAIResponses = async (endpoint: string, _apiKey: string, request: any, providerId: string) => {
            routes.push({ endpoint, providerId, model: request.model });
            return completionResponse(request.model);
        };
        service.callOpenAICompatibleStreaming = async () => {
            throw new Error('OpenAI must not use Chat Completions.');
        };

        const response = await service.chatCompletion(
            [{ role: 'user', content: 'Hello' }],
            {
                providerId: 'openai',
                model: 'gpt-5.5',
                apiKey: 'test-key',
                endpoint: 'https://api.openai.com/v1',
                customApiFormat: 'openai-chat-completions',
            },
        );

        expect(routes).to.deep.equal([{
            endpoint: 'https://api.openai.com/v1',
            providerId: 'openai',
            model: 'gpt-5.5',
        }]);
        expect(response.choices[0].message.content).to.equal('ok');
    });

    it('routes the ChatGPT subscription provider through the fixed Codex Responses endpoint', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const baseConfig = service.getConfig.bind(service);
        service.getConfig = () => ({ ...baseConfig(), codexServiceTier: 'fast' });
        const routes: Array<{ endpoint: string; providerId: string; model: string; reasoning?: string; verbosity?: string; serviceTier?: string }> = [];
        service.callOpenAIResponses = async (endpoint: string, _apiKey: string, request: any, providerId: string) => {
            routes.push({
                endpoint,
                providerId,
                model: request.model,
                reasoning: request.reasoning_effort,
                verbosity: request.response_verbosity,
                serviceTier: request.service_tier,
            });
            return completionResponse(request.model);
        };

        await service.chatCompletion([{ role: 'user', content: 'Hello' }], {
            providerId: 'codex-chatgpt',
            model: 'gpt-5.6-sol',
            reasoningEffort: 'max',
            responseVerbosity: 'high',
            endpoint: 'https://malicious-relay.example/v1',
        });

        expect(routes).to.deep.equal([{
            endpoint: 'https://chatgpt.com/backend-api/codex',
            providerId: 'codex-chatgpt',
            model: 'gpt-5.6-sol',
            reasoning: 'xhigh',
            verbosity: 'high',
            serviceTier: 'fast',
        }]);
    });

    it('keeps the selected protocol for custom OpenAI-compatible channels', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        let chatCompletionsCalls = 0;
        service.callOpenAIResponses = async () => {
            throw new Error('Custom Chat Completions channel must not use Responses.');
        };
        service.callOpenAICompatibleStreaming = async (_endpoint: string, _apiKey: string, request: any) => {
            chatCompletionsCalls++;
            return completionResponse(request.model);
        };

        await service.chatCompletion(
            [{ role: 'user', content: 'Hello' }],
            {
                providerId: 'custom',
                model: 'relay-model',
                apiKey: 'test-key',
                endpoint: 'https://relay.example/v1',
                customApiFormat: 'openai-chat-completions',
            },
        );

        expect(chatCompletionsCalls).to.equal(1);
    });

    it('applies provider-specific thinking levels before Chat Completions routing', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const requests: any[] = [];
        service.callOpenAICompatibleStreaming = async (_endpoint: string, _apiKey: string, request: any) => {
            requests.push(request);
            return completionResponse(request.model);
        };

        await service.chatCompletion([{ role: 'user', content: 'Hello' }], {
            providerId: 'qwen', model: 'qwen3.7-plus', apiKey: 'test-key', reasoningEffort: 'medium',
        });
        await service.chatCompletion([{ role: 'user', content: 'Hello' }], {
            providerId: 'openrouter', model: 'google/gemini-3.5-flash', apiKey: 'test-key', reasoningEffort: 'max',
        });
        await service.chatCompletion([{ role: 'user', content: 'Hello' }], {
            providerId: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Pro', apiKey: 'test-key', reasoningEffort: 'high',
        });
        await service.chatCompletion([{ role: 'user', content: 'Hello' }], {
            providerId: 'ollama', model: 'gpt-oss:120b', reasoningEffort: 'max',
        });

        expect(requests[0]).to.include({ enable_thinking: true, thinking_budget: 8192 });
        expect(requests[1].reasoning).to.deep.equal({ effort: 'high' });
        expect(requests[2]).to.include({ enable_thinking: true, thinking_budget: 16384 });
        expect(requests[3].reasoning_effort).to.equal('high');
    });

    it('turns off thinking for switch-based models instead of inventing a low effort', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const requests: any[] = [];
        service.callOpenAICompatibleStreaming = async (_endpoint: string, _apiKey: string, request: any) => {
            requests.push(request);
            return completionResponse(request.model);
        };

        await service.chatCompletion([{ role: 'user', content: 'Hello' }], {
            providerId: 'deepseek',
            model: 'deepseek-v4-pro',
            apiKey: 'test-key',
            reasoningEffort: 'none',
        });
        await service.chatCompletion([{ role: 'user', content: 'Hello' }], {
            providerId: 'mimo',
            model: 'mimo-v2.5-pro',
            apiKey: 'test-key',
            reasoningEffort: 'none',
        });

        expect(requests[0].thinking).to.deep.equal({ type: 'disabled' });
        expect(requests[0]).to.not.have.property('reasoning_effort');
        expect(requests[1].thinking).to.deep.equal({ type: 'disabled' });
        expect(requests[1]).to.not.have.property('reasoning_effort');
    });

    it('routes MiniMax Token Plan through Anthropic Messages without side-channel checks', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        let claudeCalls = 0;
        service.callClaude = async (_endpoint: string, _key: string, request: any) => {
            claudeCalls++;
            return completionResponse(request.model);
        };
        service.callOpenAICompatibleStreaming = async () => {
            throw new Error('MiniMax Token Plan must not use Chat Completions.');
        };

        await service.chatCompletion([{ role: 'user', content: 'Hello' }], {
            providerId: 'minimax-token-plan',
            model: 'MiniMax-M3',
            apiKey: 'test-key',
            endpoint: 'https://api.minimaxi.com/anthropic/v1',
        });

        expect(claudeCalls).to.equal(1);
    });
});

describe('AIService OpenAI Responses payload', () => {
    it('builds the Codex-compatible payload while keeping system instructions outside input', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.6-sol',
            messages: [
                { role: 'system', content: 'Follow the native Agent policy.' },
                { role: 'user', content: 'Inspect the workspace.' },
            ],
            reasoning_effort: 'max',
            response_verbosity: 'high',
            max_tokens: 8192,
            tools: [{
                type: 'function',
                function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
            }],
        }, {
            fastPath: true,
            promptCacheKey: 'agent-thread:codex-1',
            reasoningSummary: 'auto',
            codexCompatibility: true,
        });

        expect(payload).to.deep.include({
            model: 'gpt-5.6-sol',
            instructions: 'Follow the native Agent policy.',
            stream: true,
            store: false,
            parallel_tool_calls: true,
        });
        expect(payload.include).to.deep.equal(['reasoning.encrypted_content']);
        expect(payload.input).to.deep.equal([{
            role: 'user',
            content: [{ type: 'input_text', text: 'Inspect the workspace.' }],
        }]);
        expect(payload.reasoning).to.deep.equal({ effort: 'max', summary: 'auto' });
        expect(payload.text).to.deep.equal({ verbosity: 'high' });
        expect(payload).to.not.have.property('temperature');
        expect(payload).to.not.have.property('max_output_tokens');
    });

    it('omits temperature from Codex-compatible payloads even without reasoning', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.6-sol',
            messages: [{ role: 'user', content: 'Implement the change.' }],
            temperature: 0.2,
        }, { fastPath: true, codexCompatibility: true });

        expect(payload).to.not.have.property('temperature');
        expect(payload).to.not.have.property('text');
    });

    it('keeps temperature for non-Codex Responses models without reasoning', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: 'Hello' }],
            temperature: 0.2,
        });

        expect(payload.temperature).to.equal(0.2);
    });

    it('enables the native Responses image_generation tool for explicit image requests', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.6-sol',
            messages: [{ role: 'user', content: '$imagegen 生成一张像素风星舰图标' }],
        }, {
            fastPath: true,
            codexCompatibility: true,
        });

        expect(payload.tools).to.deep.equal([{ type: 'image_generation' }]);
        expect(payload.tool_choice).to.equal('auto');
        expect(payload.parallel_tool_calls).to.equal(true);
    });

    it('does not keep image_generation enabled from older user turns', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.6-sol',
            messages: [
                { role: 'user', content: '$imagegen icon' },
                { role: 'assistant', content: '![Generated image](C:/tmp/icon.png)' },
                { role: 'user', content: 'Thanks, now explain the prompt.' },
            ],
        }, { fastPath: true, codexCompatibility: true });

        expect(payload).to.not.have.property('tools');
        expect(payload).to.not.have.property('tool_choice');
    });

    it('refreshes ChatGPT OAuth once after a Codex Responses 401', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const refreshFlags: boolean[] = [];
        const requests: Array<{ url: string; authorization: string | null }> = [];
        service.chatGptOAuth = {
            getRequestHeaders: async (forceRefresh: boolean) => {
                refreshFlags.push(forceRefresh);
                return { Authorization: forceRefresh ? 'Bearer fresh' : 'Bearer stale' };
            },
        };
        service.fetchWithRetry = async (url: string, init: RequestInit) => {
            requests.push({
                url,
                authorization: new Headers(init.headers).get('Authorization'),
            });
            if (requests.length === 1) {
                return {
                    ok: false,
                    status: 401,
                    body: { cancel: async () => undefined },
                };
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: async () => ({ id: 'resp_codex', model: 'gpt-5.6-sol', output_text: 'ok', usage: {} }),
            };
        };

        const response = await service.callOpenAIResponses(
            'https://chatgpt.com/backend-api/codex',
            '',
            { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'Hello' }], reasoning_effort: 'max' },
            'codex-chatgpt',
            new AbortController(),
        );

        expect(refreshFlags).to.deep.equal([false, true]);
        expect(requests).to.deep.equal([
            { url: 'https://chatgpt.com/backend-api/codex/responses', authorization: 'Bearer stale' },
            { url: 'https://chatgpt.com/backend-api/codex/responses', authorization: 'Bearer fresh' },
        ]);
        expect(response.choices[0].message.content).to.equal('ok');
    });

    it('enables the isolated Responses fast path with streaming, parallel tools, summaries, and a hashed cache key', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.5',
            messages: [{ role: 'user', content: 'Run checks' }],
            reasoning_effort: 'medium',
            temperature: 0.3,
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
        expect(payload).to.not.have.property('temperature');
    });

    it('replays raw Responses output items instead of lossy synthesized messages', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const rawItems = [{ type: 'reasoning', id: 'rs_1', summary: [] }, {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'Checking.' }],
        }, {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"filePath":"a.txt"}',
        }];

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.5',
            messages: [{
                role: 'assistant',
                content: 'Checking.',
                responses_output_items: rawItems,
                tool_calls: [{
                    id: 'call_1',
                    responseItemId: 'fc_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"filePath":"a.txt"}' },
                }],
            }, { role: 'tool', content: 'ok', tool_call_id: 'call_1' }],
        });

        expect(payload.input.slice(0, 3)).to.deep.equal(rawItems);
        expect(payload.input[3]).to.deep.equal({ type: 'function_call_output', call_id: 'call_1', output: 'ok' });
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

    it('encodes replayed assistant text as Responses output_text before tool results', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;

        const payload = service.buildOpenAIResponsesPayload({
            model: 'gpt-5.5',
            messages: [{
                role: 'system',
                content: 'Follow the project instructions.',
            }, {
                role: 'user',
                content: [{ type: 'text', text: 'Inspect this file.' }],
            }, {
                role: 'assistant',
                content: 'I will inspect it.',
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

        expect(payload.input).to.deep.equal([{
            role: 'system',
            content: [{ type: 'input_text', text: 'Follow the project instructions.' }],
        }, {
            role: 'user',
            content: [{ type: 'input_text', text: 'Inspect this file.' }],
        }, {
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will inspect it.' }],
        }, {
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"filePath":"test.txt"}',
        }, {
            type: 'function_call_output',
            call_id: 'call_1',
            output: '{"success":true}',
        }]);
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

    it('preserves refusal text and the complete typed output for the next turn', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const output = [{ type: 'reasoning', id: 'rs_1', summary: [] }, {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        }];
        service.fetchWithRetry = async () => ({
            ok: true,
            json: async () => ({ id: 'resp_refusal', model: 'gpt-5.5', output, usage: {} }),
        });

        const response = await service.callOpenAIResponses(
            'https://relay.example/v1/responses',
            'test-key',
            { model: 'gpt-5.5', messages: [{ role: 'user', content: 'request' }] },
            'custom',
            new AbortController(),
        );

        expect(response.choices[0].message.content).to.equal('I cannot help with that.');
        expect(response.choices[0].message.responses_output_items).to.deep.equal(output);
    });

    it('persists Responses image_generation_call results and redacts base64 from replay items', async () => {
        const { AIService } = loadAIService();
        const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-ai-images-'));
        const service = new AIService({
            secrets: {},
            globalStorageUri: { fsPath: storageRoot },
        } as any) as any;
        const output = [{
            type: 'image_generation_call',
            id: 'ig_test',
            result: ONE_PIXEL_PNG_BASE64,
            output_format: 'png',
        }];
        service.fetchWithRetry = async () => ({
            ok: true,
            json: async () => ({ id: 'resp_image', model: 'gpt-5.6-sol', output, usage: {} }),
        });

        try {
            const response = await service.callOpenAIResponses(
                'https://api.openai.com/v1',
                'test-key',
                { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: '$imagegen icon' }] },
                'custom',
                new AbortController(),
            );

            const content = response.choices[0].message.content as string;
            const imageRef = content.match(/!\[Generated image\]\(([^)]+)\)/)?.[1];
            expect(imageRef).to.equal('cwtools-generated-image:ig_test-1.png');
            expect(fs.existsSync(path.join(storageRoot, 'ai-generated-images', 'ig_test-1.png'))).to.equal(true);
            expect(response.choices[0].message.responses_output_items![0]).to.deep.equal({
                type: 'image_generation_call',
                id: 'ig_test',
                output_format: 'png',
            });
        } finally {
            fs.rmSync(storageRoot, { recursive: true, force: true });
        }
    });

    it('rejects oversized or mismatched image payloads before writing files', async () => {
        const { AIService } = loadAIService();
        const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-ai-images-invalid-'));
        const service = new AIService({ secrets: {}, globalStorageUri: { fsPath: storageRoot } } as any) as any;
        const output = [{
            type: 'image_generation_call',
            id: 'ig_invalid',
            result: Buffer.from('not a png').toString('base64'),
            output_format: 'png',
        }];
        service.fetchWithRetry = async () => ({
            ok: true,
            json: async () => ({ id: 'resp_image', model: 'gpt-5.6-sol', output, usage: {} }),
        });
        try {
            const response = await service.callOpenAIResponses(
                'https://api.openai.com/v1', 'test-key',
                { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: '$imagegen icon' }] },
                'custom', new AbortController(),
            );
            expect(response.choices[0].message.content).to.equal(null);
            expect(fs.existsSync(path.join(storageRoot, 'ai-generated-images', 'ig_invalid-1.png'))).to.equal(false);
        } finally {
            fs.rmSync(storageRoot, { recursive: true, force: true });
        }
    });

    it('retries OpenAI Responses without an explicitly rejected prompt_cache_key', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const bodies: any[] = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            if (bodies.length === 1) {
                return { ok: false, status: 400, text: async () => 'Unknown parameter: prompt_cache_key' };
            }
            return {
                ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
                json: async () => ({ id: 'resp_retry', model: 'gpt-5.5', output_text: 'ok', usage: {} }),
            };
        };
        await service.callOpenAIResponses(
            'https://api.openai.com/v1', 'test-key',
            { model: 'gpt-5.5', messages: [{ role: 'user', content: 'request' }] },
            'openai', new AbortController(), { promptCacheKey: 'agent-thread:thread-1' },
        );
        expect(bodies).to.have.length(2);
        expect(bodies[0].prompt_cache_key).to.match(/^cwtools:[a-f0-9]{32}$/);
        expect(bodies[1]).to.not.have.property('prompt_cache_key');
    });

    it('retries OpenAI Responses without summaries when account verification blocks them', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const bodies: any[] = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            if (bodies.length === 1) {
                return { ok: false, status: 400, text: async () => 'reasoning summary requires organization verification' };
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: async () => ({ id: 'resp_retry', model: 'gpt-5.5', output_text: 'ok', usage: {} }),
            };
        };

        const response = await service.callOpenAIResponses(
            'https://api.openai.com/v1',
            'test-key',
            { model: 'gpt-5.5', messages: [{ role: 'user', content: 'request' }], reasoning_effort: 'high' },
            'openai',
            new AbortController(),
            { reasoningSummary: 'auto' },
        );

        expect(bodies).to.have.length(2);
        expect(bodies[0].reasoning.summary).to.equal('auto');
        expect(bodies[1].reasoning).to.deep.equal({ effort: 'high' });
        expect(response.choices[0].message.content).to.equal('ok');
    });

    it('retries compatible Responses relays without explicitly unsupported reasoning options', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const bodies: any[] = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            if (bodies.length === 1) {
                return { ok: false, status: 400, text: async () => 'Unknown parameter: reasoning' };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ id: 'resp_compat', model: 'relay-model', output_text: 'ok', usage: {} }),
            };
        };

        await service.callOpenAIResponses(
            'https://relay.example/v1',
            'test-key',
            {
                model: 'relay-model',
                messages: [{ role: 'user', content: 'request' }],
                reasoning_effort: 'high',
                temperature: 0.3,
            },
            'custom',
            new AbortController(),
        );

        expect(bodies[0].reasoning).to.deep.equal({ effort: 'high' });
        expect(bodies[0]).to.not.have.property('temperature');
        expect(bodies[1]).to.not.have.property('reasoning');
        expect(bodies[1].temperature).to.equal(0.3);
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
        expect(response.choices[0].message.responses_output_items![0]).to.deep.include({
            type: 'function_call',
            id: 'fc_stream',
            call_id: 'call_stream',
            arguments: '{"filePath":"test.txt"}',
        });
        expect(response.usage!.cached_tokens).to.equal(40);
    });
});

describe('AIService OpenAI Chat Completions compatibility', () => {
    it('strips Responses, Anthropic, and Gemini continuation metadata from Chat Completions', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const sanitized = service.sanitizeRequest('custom', {
            model: 'relay-model',
            messages: [{
                role: 'assistant',
                content: null,
                responses_output_items: [{ type: 'reasoning', id: 'rs_1' }],
                anthropic_thinking_blocks: [{ type: 'thinking', thinking: 'secret', signature: 'sig' }],
                tool_calls: [{
                    id: 'call_1',
                    responseItemId: 'fc_1',
                    thoughtSignature: 'gemini-sig',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{}' },
                }],
            }],
        });

        expect(sanitized.messages[0]).to.not.have.property('responses_output_items');
        expect(sanitized.messages[0]).to.not.have.property('anthropic_thinking_blocks');
        expect(sanitized.messages[0].tool_calls![0]).to.not.have.property('responseItemId');
        expect(sanitized.messages[0].tool_calls![0]).to.not.have.property('thoughtSignature');
    });

    it('accepts a full chat/completions endpoint and omits stream_options for unknown relays', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const calls: Array<{ url: string; body: any }> = [];
        service.fetchWithRetry = async (url: string, init: RequestInit) => {
            calls.push({ url, body: JSON.parse(init.body as string) });
            return chatCompletionsSseResponse([
                { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }] },
            ]);
        };

        const response = await service.callOpenAICompatibleStreaming(
            'https://relay.example/v1/chat/completions',
            'test-key',
            { model: 'relay-model', messages: [{ role: 'user', content: 'Hi' }] },
            'custom',
            undefined,
            new AbortController(),
        );

        expect(calls[0]!.url).to.equal('https://relay.example/v1/chat/completions');
        expect(calls[0]!.body).to.not.have.property('stream_options');
        expect(response.choices[0].message.content).to.equal('ok');
    });

    it('finishes on the DONE frame even when a relay keeps the HTTP stream open', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.fetchWithRetry = async () => openChatCompletionsSseResponse([
            `data:${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: null }] })}\n\n`,
            'data: [DONE]\n\n',
        ]);

        const response = await service.callOpenAICompatibleStreaming(
            'https://relay.example/v1',
            'test-key',
            { model: 'relay-model', messages: [{ role: 'user', content: 'Hi' }] },
            'custom',
            undefined,
            new AbortController(),
        );

        expect(response.choices[0].message.content).to.equal('done');
    });

    it('requests and parses MiMo streaming usage trailers', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        let body: any;
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            body = JSON.parse(init.body as string);
            return openChatCompletionsSseResponse([
                `data:${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: null }] })}\n\n`,
                `data:${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 80 } })}\n\n`,
            ]);
        };
        const response = await service.callOpenAICompatibleStreaming(
            'https://api.xiaomimimo.com/v1', 'test-key',
            { model: 'mimo-v2.5-pro', messages: [{ role: 'user', content: 'Hi' }] },
            'mimo', undefined, new AbortController(),
        );
        expect(body.stream_options).to.deep.equal({ include_usage: true });
        expect(response.usage!.cached_tokens).to.equal(80);
    });

    it('finishes on a DeepSeek usage trailer without finish markers when the stream stays open', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.fetchWithRetry = async () => openChatCompletionsSseResponse([
            `data:${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: null }] })}\n\n`,
            `data:${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 80 } })}\n\n`,
        ]);

        const response = await service.callOpenAICompatibleStreaming(
            'https://api.deepseek.com/v1',
            'test-key',
            { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Hi' }] },
            'deepseek',
            undefined,
            new AbortController(),
        );

        expect(response.choices[0].message.content).to.equal('done');
        expect(response.usage!.cached_tokens).to.equal(80);
    });

    it('retries once without an explicitly rejected optional field', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const bodies: any[] = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            if (bodies.length === 1) {
                return { ok: false, status: 400, text: async () => 'Unrecognized request argument: stream_options' };
            }
            return chatCompletionsSseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
        };

        await service.callOpenAICompatibleStreaming(
            'https://api.deepseek.com/v1',
            'test-key',
            { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'Hi' }] },
            'deepseek',
            undefined,
            new AbortController(),
        );

        expect(bodies).to.have.length(2);
        expect(bodies[0]).to.have.property('stream_options');
        expect(bodies[1]).to.not.have.property('stream_options');
    });

    for (const provider of [
        { id: 'kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
        { id: 'kimi-code-plan', endpoint: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding' },
        { id: 'minimax', endpoint: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
    ]) {
        it(`requests usage and safely falls back for ${provider.id}`, async () => {
            const { AIService } = loadAIService();
            const service = new AIService({ secrets: {} } as any) as any;
            const bodies: any[] = [];
            service.fetchWithRetry = async (_url: string, init: RequestInit) => {
                bodies.push(JSON.parse(init.body as string));
                if (bodies.length === 1) {
                    return { ok: false, status: 400, text: async () => 'Unrecognized request argument: stream_options' };
                }
                return chatCompletionsSseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
            };
            await service.callOpenAICompatibleStreaming(
                provider.endpoint, 'test-key',
                { model: provider.model, messages: [{ role: 'user', content: 'Hi' }] },
                provider.id, undefined, new AbortController(),
            );
            expect(bodies).to.have.length(2);
            expect(bodies[0].stream_options).to.deep.equal({ include_usage: true });
            expect(bodies[1]).to.not.have.property('stream_options');
        });
    }

    it('canonicalizes official TokenRhythm endpoint variants', () => {
        const { normalizeOpenAIActionUrl } = loadAIService();
        for (const endpoint of [
            'https://tokenrhythm.studio',
            'https://tokenrhythm.studio/v1',
            'https://tokenrhythm.studio/v1/v1',
            'https://tokenrhythm.studio/v1/chat/completions',
        ]) {
            expect(normalizeOpenAIActionUrl(endpoint, 'chat/completions'))
                .to.equal('https://tokenrhythm.studio/v1/chat/completions');
        }
        expect(normalizeOpenAIActionUrl('https://gateway.example/v1', 'chat/completions'))
            .to.equal('https://gateway.example/v1/chat/completions');
    });

    it('can remove explicitly rejected reasoning_content from replayed messages', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const bodies: any[] = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            if (bodies.length === 1) {
                return { ok: false, status: 400, text: async () => 'message.reasoning_content is not supported' };
            }
            return chatCompletionsSseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
        };

        await service.callOpenAICompatibleStreaming(
            'https://relay.example/v1',
            'test-key',
            {
                model: 'relay-model',
                messages: [{ role: 'assistant', content: 'prior', reasoning_content: 'hidden' },
                    { role: 'user', content: 'continue' }],
            },
            'custom',
            undefined,
            new AbortController(),
        );

        expect(bodies[0].messages[0].reasoning_content).to.equal('hidden');
        expect(bodies[1].messages[0]).to.not.have.property('reasoning_content');
    });

    it('omits reasoning_content from replayed messages when reasoning_content is null or empty', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const bodies: any[] = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            return chatCompletionsSseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
        };

        await service.callOpenAICompatibleStreaming(
            'https://relay.example/v1',
            'test-key',
            {
                model: 'relay-model',
                messages: [
                    { role: 'assistant', content: 'msg1', reasoning_content: null },
                    { role: 'assistant', content: 'msg2', reasoning_content: '' },
                    { role: 'assistant', content: 'msg3', reasoning_content: 'valid thinking' },
                    { role: 'user', content: 'continue' },
                ],
            },
            'custom',
            undefined,
            new AbortController(),
        );

        expect(bodies[0].messages[0]).to.not.have.property('reasoning_content');
        expect(bodies[0].messages[1]).to.not.have.property('reasoning_content');
        expect(bodies[0].messages[2].reasoning_content).to.equal('valid thinking');
    });

    it('can remove reasoning_content and retry when provider returns Chinese type error', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const bodies: any[] = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(init.body as string));
            if (bodies.length === 1) {
                return {
                    ok: false,
                    status: 400,
                    text: async () => '{"code":"BAD_REQUEST","message":"messages.52.reasoning_content 类型错误","traceId":"trace_test"}',
                };
            }
            return chatCompletionsSseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
        };

        await service.callOpenAICompatibleStreaming(
            'https://relay.example/v1',
            'test-key',
            {
                model: 'relay-model',
                messages: [
                    { role: 'assistant', content: 'prior', reasoning_content: 'think' },
                    { role: 'user', content: 'continue' },
                ],
            },
            'custom',
            undefined,
            new AbortController(),
        );

        expect(bodies[0].messages[0].reasoning_content).to.equal('think');
        expect(bodies[1].messages[0]).to.not.have.property('reasoning_content');
    });

    it('keeps no-index tool argument fragments on the same tool call', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.fetchWithRetry = async () => chatCompletionsSseResponse([
            { choices: [{ delta: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
        ]);

        const metadata: Array<{ id?: string; index?: number }> = [];
        const response = await service.callOpenAICompatibleStreaming(
            'https://relay.example/v1',
            'test-key',
            { model: 'relay-model', messages: [{ role: 'user', content: 'Read' }] },
            'custom',
            undefined,
            new AbortController(),
            undefined,
            (_name: string, _args: string, value?: { id?: string; index?: number }) => {
                if (value) metadata.push(value);
            },
        );

        expect(response.choices[0].message.tool_calls).to.have.length(1);
        expect(response.choices[0].message.tool_calls![0]!.function.arguments).to.equal('{"path":"a.txt"}');
        expect(metadata[0]).to.deep.equal({ id: 'call_1', index: 0 });
        expect(metadata.at(-1)).to.deep.equal({ id: 'call_1', index: 0 });
    });
});

describe('AIService Gemini generateContent compatibility', () => {
    it('uses native camelCase fields, groups parallel results, and replays thought signatures', () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const payload = service.buildGeminiPayload({
            model: 'gemini-3.5-flash',
            messages: [{ role: 'system', content: 'System' }, {
                role: 'assistant',
                content: 'Checking',
                tool_calls: [{
                    id: 'gemini_call_0',
                    thoughtSignature: 'signed-thought',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
                }, {
                    id: 'gemini_call_1',
                    type: 'function',
                    function: { name: 'list_files', arguments: '{}' },
                }],
            }, { role: 'tool', content: 'one', tool_call_id: 'gemini_call_0' },
            { role: 'tool', content: 'two', tool_call_id: 'gemini_call_1' }],
            thinking_config: { thinking_level: 'high' },
            tools: [{
                type: 'function',
                function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
            }],
        });

        expect(payload).to.have.property('systemInstruction');
        expect(payload).to.have.property('generationConfig');
        expect(payload).to.have.property('toolConfig');
        expect(payload).to.not.have.property('generation_config');
        expect((payload.generationConfig as any).thinkingConfig).to.deep.equal({ thinkingLevel: 'high' });
        const contents = payload.contents as any[];
        expect(contents).to.have.length(2);
        expect(contents[0].parts[1].functionCall.name).to.equal('read_file');
        expect(contents[0].parts[1].thoughtSignature).to.equal('signed-thought');
        expect(contents[1].parts.map((part: any) => part.functionResponse.name)).to.deep.equal(['read_file', 'list_files']);
    });

    it('uses one Google API-key header and preserves returned thought signatures', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const calls: Array<{ url: string; headers: Record<string, string> }> = [];
        service.fetchWithRetry = async (url: string, init: RequestInit) => {
            calls.push({ url, headers: init.headers as Record<string, string> });
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'sig-1' }] },
                        finishReason: 'STOP',
                    }],
                    usageMetadata: {},
                }),
            };
        };

        const response = await service.callGeminiGenerateContent(
            'https://generativelanguage.googleapis.com/v1beta',
            'google-key',
            { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'Read' }] },
            'custom',
            new AbortController(),
        );

        expect(calls[0]!.url).to.equal('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
        expect(calls[0]!.url).to.not.include('key=');
        expect(calls[0]!.headers['x-goog-api-key']).to.equal('google-key');
        expect(calls[0]!.headers).to.not.have.property('Authorization');
        expect(response.choices[0].message.tool_calls![0]!.thoughtSignature).to.equal('sig-1');
    });

    it('surfaces blocked prompts instead of returning an empty assistant message', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.fetchWithRetry = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
        });

        let error: Error | undefined;
        try {
            await service.callGeminiGenerateContent(
                'https://generativelanguage.googleapis.com/v1beta',
                'google-key',
                { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'blocked' }] },
                'custom',
                new AbortController(),
            );
        } catch (caught) {
            error = caught as Error;
        }
        expect(error?.message).to.include('blocked: SAFETY');
    });

    it('streams native Gemini text and thought parts through streamGenerateContent', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const urls: string[] = [];
        service.fetchWithRetry = async (url: string) => {
            urls.push(url);
            return geminiSseResponse([{
                candidates: [{ content: { parts: [{ text: 'Thinking.', thought: true }] } }],
            }, {
                candidates: [{ content: { parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6, cachedContentTokenCount: 3 },
            }]);
        };
        const text: string[] = [];
        const thinking: string[] = [];

        const response = await service.callGeminiGenerateContent(
            'https://generativelanguage.googleapis.com/v1beta',
            'google-key',
            { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'Hi' }] },
            'custom',
            new AbortController(),
            (delta: string) => text.push(delta),
            undefined,
            (delta: string) => thinking.push(delta),
        );

        expect(urls[0]).to.equal('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
        expect(text).to.deep.equal(['Done.']);
        expect(thinking).to.deep.equal(['Thinking.']);
        expect(response.choices[0].message.content).to.equal('Done.');
        expect(response.choices[0].message.reasoning_content).to.equal('Thinking.');
        expect(response.usage!.total_tokens).to.equal(6);
        expect(response.usage!.cached_tokens).to.equal(3);
    });
});

describe('AIService Anthropic Messages compatibility', () => {
    it('offers cache breakpoints to custom Messages relays with fallback support', async () => {
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
        expect(firstCall.body.system[0].text).to.equal('System prompt');
        expect(JSON.stringify(firstCall.body)).to.include('cache_control');
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

    it('keeps Bearer auth while removing an explicitly unsupported Messages option', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const calls: Array<{ headers: Record<string, string>; body: any }> = [];
        service.fetchWithRetry = async (_url: string, init: RequestInit) => {
            calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
            if (calls.length === 1) return { ok: false, status: 401, text: async () => 'Unauthorized' };
            if (calls.length === 2) return { ok: false, status: 400, text: async () => 'output_config is unsupported' };
            return anthropicSseResponse();
        };

        await service.callClaude(
            'https://relay.example/v1',
            'test-key',
            {
                model: 'claude-opus-4-7',
                messages: [{ role: 'user', content: 'Hi' }],
                reasoning_effort: 'high',
            },
            new AbortController(),
            undefined,
            undefined,
            undefined,
            'custom',
        );

        expect(calls).to.have.length(3);
        expect(calls[1]!.headers.Authorization).to.equal('Bearer test-key');
        expect(calls[2]!.headers.Authorization).to.equal('Bearer test-key');
        expect(calls[1]!.body).to.have.property('output_config');
        expect(calls[2]!.body).to.not.have.property('output_config');
    });

    it('preserves streamed thinking signatures even when event and data cross chunks', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.fetchWithRetry = async () => anthropicSseChunksResponse([
            'event: message_start\ndata: {"message":{"model":"claude-opus-4-8","usage":{"input_tokens":1}}}\n\n',
            'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"index":0,"delta":{"type":"thinking_delta","thinking":"Checking."}}\n\n',
            'event: content_block_delta\ndata: {"index":0,"delta":{"type":"signature_delta","signature":"signed-1"}}\n\n',
            'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n',
            'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}\n\n',
            'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
        ]);

        const response = await service.callClaude(
            'https://api.anthropic.com/v1',
            'test-key',
            { model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'Read' }] },
            new AbortController(),
            undefined,
            undefined,
            undefined,
            'claude',
        );

        expect(response.choices[0].message.reasoning_content).to.equal('Checking.');
        expect(response.choices[0].message.anthropic_thinking_blocks).to.deep.equal([{
            type: 'thinking',
            thinking: 'Checking.',
            signature: 'signed-1',
        }]);
        expect(response.choices[0].message.tool_calls![0]!.function.arguments).to.equal('{"path":"a.txt"}');
    });

    it('accepts a non-streaming JSON Messages response from compatible relays', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.fetchWithRetry = async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
                id: 'msg_1',
                model: 'claude-opus-4-8',
                content: [
                    { type: 'thinking', thinking: 'Checking.', signature: 'sig-json' },
                    { type: 'tool_use', id: 'toolu_json', name: 'read_file', input: { path: 'a.txt' } },
                ],
                stop_reason: 'tool_use',
                usage: { input_tokens: 5, output_tokens: 2 },
            }),
        });

        const response = await service.callClaude(
            'https://relay.example/v1',
            'test-key',
            { model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'Read' }] },
            new AbortController(),
            undefined,
            undefined,
            undefined,
            'custom',
        );

        expect(response.choices[0].finish_reason).to.equal('tool_calls');
        expect(response.choices[0].message.anthropic_thinking_blocks![0]!.signature).to.equal('sig-json');
        expect(response.choices[0].message.tool_calls![0]!.function.arguments).to.equal('{"path":"a.txt"}');
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

function completionResponse(model: string) {
    return {
        id: 'response-test',
        object: 'response',
        created: 0,
        model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
        }],
    };
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

function anthropicSseChunksResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            },
        }),
    } as Response;
}

describe('AIService streaming reasoning detection', () => {
    it('detects a non-default reasoning field and replays it on the synthetic message', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        const thinking: string[] = [];
        service.fetchWithRetry = async (_url: string) => chatCompletionsSseResponse([
            { choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'think ' } }] },
            { choices: [{ index: 0, delta: { content: 'answer' } }] },
            {
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
        ]);

        const response = await service.callOpenAICompatibleStreaming(
            'https://api.deepseek.com/v1',
            'test-key',
            { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Hello' }] },
            'deepseek',
            (text: string) => thinking.push(text),
            new AbortController(),
        );

        expect(thinking).to.deep.equal(['think ']);
        expect(response.choices[0].message.content).to.equal('answer');
        expect(response.choices[0].message.reasoning_content).to.equal('think ');
        expect(response.choices[0].message.reasoning_key).to.equal('reasoning');
    });

    it('defaults to reasoning_content when the delta uses the standard key', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        service.fetchWithRetry = async (_url: string) => chatCompletionsSseResponse([
            { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think ' } }] },
            { choices: [{ index: 0, delta: { content: 'answer' } }] },
            {
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
        ]);

        const response = await service.callOpenAICompatibleStreaming(
            'https://api.deepseek.com/v1',
            'test-key',
            { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Hello' }] },
            'deepseek',
            undefined,
            new AbortController(),
        );

        expect(response.choices[0].message.reasoning_content).to.equal('think ');
        expect(response.choices[0].message.reasoning_key).to.equal(undefined);
    });

    it('retries when global fetch fails with TypeError fetch failed and ECONNRESET cause', async () => {
        const { AIService } = loadAIService();
        const service = new AIService({ secrets: {} } as any) as any;
        let fetchCalls = 0;
        const originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = (async () => {
                fetchCalls++;
                if (fetchCalls === 1) {
                    const fetchError = new TypeError('fetch failed');
                    (fetchError as any).cause = new Error('read ECONNRESET');
                    throw fetchError;
                }
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
                } as any;
            }) as any;

            service.abortableDelay = async () => {};
            const res = await service.fetchWithRetry('https://api.test/v1/chat', { method: 'POST' }, 'test');
            expect(fetchCalls).to.equal(2);
            expect(res.ok).to.equal(true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

function chatCompletionsSseResponse(events: Record<string, unknown>[]): Response {
    const encoder = new TextEncoder();
    const chunks = events.map(event => `data:${JSON.stringify(event)}\n\n`);
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

function openChatCompletionsSseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            },
        }),
    } as Response;
}

function geminiSseResponse(events: Record<string, unknown>[]): Response {
    const encoder = new TextEncoder();
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({
            start(controller) {
                for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                controller.close();
            },
        }),
    } as Response;
}
