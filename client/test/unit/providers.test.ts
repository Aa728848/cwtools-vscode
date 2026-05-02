import { expect } from 'chai';
import {
    isModelVisionCapable,
    isModelFIMCapable,
    getModelContextTokens,
    getModelOutputTokens,
    getProvider,
    getEffectiveEndpoint,
    getEffectiveModel,
    getDisableThinkingParams,
    toClaudeRequest,
    suggestOllamaConfig,
    BUILTIN_PROVIDERS,
    MODEL_CONTEXT_TOKENS,
    VISION_CAPABLE_MODELS,
    FIM_CAPABLE_MODELS,
} from '../../extension/ai/providers';
import type { ChatCompletionRequest, ChatMessage } from '../../extension/ai/types';

// ─── isModelVisionCapable ────────────────────────────────────────────────────

describe('isModelVisionCapable', () => {
    it('returns false for empty string', () => {
        expect(isModelVisionCapable('')).to.equal(false);
    });

    it('returns true for known vision model (gpt-4o)', () => {
        expect(isModelVisionCapable('gpt-4o')).to.equal(true);
    });

    it('returns true for claude model with vision', () => {
        expect(isModelVisionCapable('claude-opus-4-7')).to.equal(true);
    });

    it('returns true for dated model tag via substring match', () => {
        expect(isModelVisionCapable('gpt-4o-2024-08-06')).to.equal(true);
    });

    it('returns false for non-vision model', () => {
        expect(isModelVisionCapable('deepseek-v4-pro')).to.equal(false);
    });

    it('is case insensitive', () => {
        expect(isModelVisionCapable('GPT-4O')).to.equal(true);
    });

    it('returns true for mimo-v2.5-pro (multimodal)', () => {
        expect(isModelVisionCapable('mimo-v2.5-pro')).to.equal(true);
    });

    it('returns false for mimo-v2-flash (text-only)', () => {
        expect(isModelVisionCapable('mimo-v2-flash')).to.equal(false);
    });

    it('returns false for glm text-only models', () => {
        expect(isModelVisionCapable('glm-5-turbo')).to.equal(false);
    });

    it('returns true for glm vision models', () => {
        expect(isModelVisionCapable('glm-5v-turbo')).to.equal(true);
    });
});

// ─── isModelFIMCapable ───────────────────────────────────────────────────────

describe('isModelFIMCapable', () => {
    it('returns true for deepseek-v4-pro (explicit FIM model)', () => {
        expect(isModelFIMCapable('deepseek-v4-pro', 'deepseek')).to.equal(true);
    });

    it('returns true for deepseek-coder', () => {
        expect(isModelFIMCapable('deepseek-coder', 'deepseek')).to.equal(true);
    });

    it('returns false for gpt models (explicitly disabled)', () => {
        expect(isModelFIMCapable('gpt-5.5', 'openai')).to.equal(false);
    });

    it('returns false for claude models (explicitly disabled)', () => {
        expect(isModelFIMCapable('claude-opus-4-7', 'claude')).to.equal(false);
    });

    it('falls back to provider default for unlisted model', () => {
        // deepseek provider supports FIM by default
        expect(isModelFIMCapable('unknown-model', 'deepseek')).to.equal(true);
    });

    it('falls back to provider default for empty model', () => {
        expect(isModelFIMCapable('', 'deepseek')).to.equal(true);
    });

    it('returns false when provider does not support FIM and model is unlisted', () => {
        expect(isModelFIMCapable('unknown-model', 'openai')).to.equal(false);
    });
});

// ─── getModelContextTokens ───────────────────────────────────────────────────

describe('getModelContextTokens', () => {
    it('returns 0 for empty model', () => {
        expect(getModelContextTokens('')).to.equal(0);
    });

    it('exact match for known model', () => {
        const result = getModelContextTokens('gpt-5.5');
        expect(result).to.be.a('number').and.greaterThan(0);
    });

    it('prefix match: dated model resolves to base', () => {
        const base = getModelContextTokens('claude-opus-4-7');
        const dated = getModelContextTokens('claude-opus-4-7-20251101');
        expect(dated).to.equal(base);
    });

    it('falls back to provider maxContextTokens when model unknown', () => {
        const provider = getProvider('openai');
        expect(getModelContextTokens('nonexistent-model', 'openai')).to.equal(provider.maxContextTokens);
    });

    it('returns 0 for completely unknown model and provider', () => {
        expect(getModelContextTokens('nonexistent-model')).to.equal(0);
    });
});

// ─── getModelOutputTokens ────────────────────────────────────────────────────

describe('getModelOutputTokens', () => {
    it('returns 16384 for empty model', () => {
        expect(getModelOutputTokens('')).to.equal(16384);
    });

    it('returns 128000 for openai provider', () => {
        expect(getModelOutputTokens('gpt-5.5', 'openai')).to.equal(128000);
    });

    it('returns high value for deepseek provider', () => {
        const result = getModelOutputTokens('deepseek-v4-pro', 'deepseek');
        expect(result).to.be.a('number').and.greaterThan(100000);
    });

    it('returns reasonable default for unknown provider', () => {
        const result = getModelOutputTokens('some-model');
        expect(result).to.be.a('number').and.greaterThan(0);
    });
});

// ─── getProvider ─────────────────────────────────────────────────────────────

describe('getProvider', () => {
    it('returns openai for "openai"', () => {
        const p = getProvider('openai');
        expect(p.id).to.equal('openai');
        expect(p.endpoint).to.include('openai');
    });

    it('returns claude for "claude"', () => {
        const p = getProvider('claude');
        expect(p.id).to.equal('claude');
    });

    it('falls back to openai for unknown provider', () => {
        const p = getProvider('nonexistent-provider');
        expect(p.id).to.equal('openai');
    });

    it('falls back to openai for empty string', () => {
        const p = getProvider('');
        expect(p.id).to.equal('openai');
    });
});

// ─── getEffectiveEndpoint ────────────────────────────────────────────────────

describe('getEffectiveEndpoint', () => {
    it('returns user override when provided', () => {
        expect(getEffectiveEndpoint('openai', 'https://custom.api.com/v1'))
            .to.equal('https://custom.api.com/v1');
    });

    it('strips trailing slash from user override', () => {
        expect(getEffectiveEndpoint('openai', 'https://custom.api.com/v1/'))
            .to.equal('https://custom.api.com/v1');
    });

    it('returns default endpoint when no override', () => {
        const p = getProvider('openai');
        expect(getEffectiveEndpoint('openai')).to.equal(p.endpoint);
    });

    it('ignores empty string override', () => {
        const p = getProvider('openai');
        expect(getEffectiveEndpoint('openai', '')).to.equal(p.endpoint);
    });

    it('ignores whitespace-only override', () => {
        const p = getProvider('openai');
        expect(getEffectiveEndpoint('openai', '   ')).to.equal(p.endpoint);
    });
});

// ─── getEffectiveModel ───────────────────────────────────────────────────────

describe('getEffectiveModel', () => {
    it('returns user override when provided', () => {
        expect(getEffectiveModel('openai', 'gpt-5.4-mini')).to.equal('gpt-5.4-mini');
    });

    it('returns default model when no override', () => {
        const p = getProvider('openai');
        expect(getEffectiveModel('openai')).to.equal(p.defaultModel);
    });

    it('ignores empty string override', () => {
        const p = getProvider('claude');
        expect(getEffectiveModel('claude', '')).to.equal(p.defaultModel);
    });

    it('trims whitespace from override', () => {
        expect(getEffectiveModel('openai', '  gpt-5.4  ')).to.equal('gpt-5.4');
    });
});

// ─── getDisableThinkingParams ────────────────────────────────────────────────

describe('getDisableThinkingParams', () => {
    it('returns undefined for unknown model', () => {
        expect(getDisableThinkingParams('unknown-model')).to.equal(undefined);
    });

    it('returns params for qwen3 model', () => {
        const result = getDisableThinkingParams('qwen3.6-plus');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ enable_thinking: false });
        expect(result!.injectPrompt).to.equal(true);
    });

    it('returns params for GLM thinking model', () => {
        const result = getDisableThinkingParams('glm-4.1v-thinking');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking: { type: 'disabled' } });
    });

    it('returns params for gemini-2.5-flash', () => {
        const result = getDisableThinkingParams('gemini-2.5-flash');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking_config: { thinking_budget: 0 } });
    });

    it('returns params for gemini-3 model', () => {
        const result = getDisableThinkingParams('gemini-3-pro');
        expect(result).to.not.equal(undefined);
        expect(result!.extraBody).to.deep.equal({ thinking_config: { thinking_level: 'minimal' } });
    });

    it('returns undefined for standard GPT model', () => {
        expect(getDisableThinkingParams('gpt-5.5')).to.equal(undefined);
    });

    it('returns undefined for Claude model', () => {
        expect(getDisableThinkingParams('claude-opus-4-7')).to.equal(undefined);
    });
});

// ─── toClaudeRequest ─────────────────────────────────────────────────────────

describe('toClaudeRequest', () => {
    it('extracts system message into system field', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hello' },
            ],
        };
        const result = toClaudeRequest(req);
        expect(result.system).to.equal('You are helpful.');
        expect(result.messages).to.have.length(1);
        expect((result.messages as ChatMessage[])[0]!.role).to.equal('user');
    });

    it('converts plain text user message', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = toClaudeRequest(req);
        const msgs = result.messages as Array<Record<string, unknown>>;
        expect(msgs).to.have.length(1);
        expect(msgs[0]!.role).to.equal('user');
        expect(msgs[0]!.content).to.equal('Hi');
    });

    it('converts assistant text message', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'assistant', content: 'Hello!' }],
        };
        const result = toClaudeRequest(req);
        const msgs = result.messages as Array<Record<string, unknown>>;
        expect(msgs[0]!.role).to.equal('assistant');
        expect(msgs[0]!.content).to.equal('Hello!');
    });

    it('converts tool call message to tool_use blocks', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' },
                }],
            }],
        };
        const result = toClaudeRequest(req);
        const msgs = result.messages as Array<Record<string, unknown>>;
        const content = msgs[0]!.content as Array<Record<string, unknown>>;
        expect(content[0]!.type).to.equal('tool_use');
        expect(content[0]!.name).to.equal('read_file');
        expect(content[0]!.id).to.equal('call_1');
    });

    it('converts tool result message', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{
                role: 'tool',
                content: 'file contents here',
                tool_call_id: 'call_1',
            }],
        };
        const result = toClaudeRequest(req);
        const msgs = result.messages as Array<Record<string, unknown>>;
        expect(msgs[0]!.role).to.equal('user');
        const content = msgs[0]!.content as Array<Record<string, unknown>>;
        expect(content[0]!.type).to.equal('tool_result');
        expect(content[0]!.tool_use_id).to.equal('call_1');
    });

    it('sets max_tokens with default 4096', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = toClaudeRequest(req);
        expect(result.max_tokens).to.equal(4096);
    });

    it('uses provided max_tokens', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 8192,
        };
        const result = toClaudeRequest(req);
        expect(result.max_tokens).to.equal(8192);
    });

    it('converts tools to Claude format', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
            tools: [{
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read a file',
                    parameters: { type: 'object', properties: { path: { type: 'string' } } },
                },
            }],
        };
        const result = toClaudeRequest(req);
        const tools = result.tools as Array<Record<string, unknown>>;
        expect(tools).to.have.length(1);
        expect(tools[0]!.name).to.equal('read_file');
        expect(tools[0]!.description).to.equal('Read a file');
    });

    it('omits system field when no system messages', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'Hi' }],
        };
        const result = toClaudeRequest(req);
        expect(result.system).to.equal(undefined);
    });

    it('concatenates multiple system messages', () => {
        const req: ChatCompletionRequest = {
            model: 'claude-opus-4-7',
            messages: [
                { role: 'system', content: 'Part 1' },
                { role: 'system', content: 'Part 2' },
                { role: 'user', content: 'Hi' },
            ],
        };
        const result = toClaudeRequest(req);
        expect(result.system).to.equal('Part 1\n\nPart 2');
    });
});

// ─── suggestOllamaConfig ─────────────────────────────────────────────────────

describe('suggestOllamaConfig', () => {
    it('returns null for empty array', () => {
        expect(suggestOllamaConfig([])).to.equal(null);
    });

    it('suggests config for single model', () => {
        const result = suggestOllamaConfig([
            { name: 'llama3:70b', size: '40 GB', parameterSize: '70B' },
        ]);
        expect(result).to.not.equal(null);
        expect(result!.chatModel).to.equal('llama3:70b');
        expect(result!.contextTokens).to.equal(32768);
    });

    it('prefers coding model for chat', () => {
        const result = suggestOllamaConfig([
            { name: 'llama3:7b', size: '4 GB', parameterSize: '7B' },
            { name: 'qwen2.5-coder:32b', size: '19 GB', parameterSize: '32B' },
        ]);
        expect(result).to.not.equal(null);
        expect(result!.chatModel).to.equal('qwen2.5-coder:32b');
    });

    it('selects smaller model for inline', () => {
        const result = suggestOllamaConfig([
            { name: 'qwen2.5-coder:32b', size: '19 GB', parameterSize: '32B' },
            { name: 'deepseek-coder:6.7b', size: '3.8 GB', parameterSize: '6.7B' },
        ]);
        expect(result).to.not.equal(null);
        expect(result!.inlineModel).to.equal('deepseek-coder:6.7b');
    });

    it('scales context tokens by param size', () => {
        const small = suggestOllamaConfig([
            { name: 'tiny:3b', size: '2 GB', parameterSize: '3B' },
        ]);
        expect(small!.contextTokens).to.equal(4096);

        const medium = suggestOllamaConfig([
            { name: 'mid:13b', size: '7 GB', parameterSize: '13B' },
        ]);
        expect(medium!.contextTokens).to.equal(8192);
    });
});

// ─── Structural validation ───────────────────────────────────────────────────

describe('BUILTIN_PROVIDERS', () => {
    it('has at least 5 providers', () => {
        expect(Object.keys(BUILTIN_PROVIDERS).length).to.be.greaterThanOrEqual(5);
    });

    it('every provider has required fields', () => {
        for (const [key, p] of Object.entries(BUILTIN_PROVIDERS)) {
            expect(p.id, `${key}.id`).to.be.a('string').with.length.greaterThan(0);
            expect(p.name, `${key}.name`).to.be.a('string').with.length.greaterThan(0);
            expect(p.endpoint, `${key}.endpoint`).to.be.a('string').with.length.greaterThan(0);
            expect(p.maxContextTokens, `${key}.maxContextTokens`).to.be.a('number').and.greaterThan(0);
            // ollama has empty defaultModel/models (auto-detected at runtime)
            if (key !== 'ollama') {
                expect(p.defaultModel, `${key}.defaultModel`).to.be.a('string').with.length.greaterThan(0);
                expect(p.models, `${key}.models`).to.be.an('array').with.length.greaterThan(0);
            }
        }
    });

    it('openai provider exists and is OpenAI compatible', () => {
        const openai = BUILTIN_PROVIDERS['openai'];
        expect(openai).to.not.equal(undefined);
        expect(openai!.isOpenAICompatible).to.equal(true);
    });
});

describe('MODEL_CONTEXT_TOKENS', () => {
    it('has at least 20 entries', () => {
        expect(Object.keys(MODEL_CONTEXT_TOKENS).length).to.be.greaterThanOrEqual(20);
    });

    it('all values are positive numbers', () => {
        for (const [key, val] of Object.entries(MODEL_CONTEXT_TOKENS)) {
            expect(val, key).to.be.a('number').and.greaterThan(0);
        }
    });

    it('no duplicate keys', () => {
        const keys = Object.keys(MODEL_CONTEXT_TOKENS);
        expect(keys.length).to.equal(new Set(keys).size);
    });
});

describe('VISION_CAPABLE_MODELS', () => {
    it('has at least 10 entries', () => {
        expect(Object.keys(VISION_CAPABLE_MODELS).length).to.be.greaterThanOrEqual(10);
    });

    it('all values are booleans', () => {
        for (const [key, val] of Object.entries(VISION_CAPABLE_MODELS)) {
            expect(val, key).to.be.a('boolean');
        }
    });
});

describe('FIM_CAPABLE_MODELS', () => {
    it('has at least 5 entries', () => {
        expect(Object.keys(FIM_CAPABLE_MODELS).length).to.be.greaterThanOrEqual(5);
    });

    it('all values are booleans', () => {
        for (const [key, val] of Object.entries(FIM_CAPABLE_MODELS)) {
            expect(val, key).to.be.a('boolean');
        }
    });
});
