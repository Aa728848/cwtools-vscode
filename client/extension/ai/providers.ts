/**
 * CWTools AI Module — Provider Definitions & Quick Configurations
 *
 * Supports: OpenAI, Claude, Google Gemini, DeepSeek, MiniMax, GLM (Zhipu), Qwen (Tongyi), Ollama, Custom
 * All providers are called via OpenAI-compatible API format (with adapters where needed).
 */

import type { AIProviderConfig, ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ContentPart } from './types';

// ─── Built-in Provider Definitions ────────────────────────────────────────────

export const BUILTIN_PROVIDERS: Record<string, AIProviderConfig> = {
    openai: {
        id: 'openai',
        name: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        defaultModel: 'gpt-5.4',
        models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano'],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 400000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
    },
    claude: {
        id: 'claude',
        name: 'Claude (Anthropic)',
        endpoint: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-opus-4-7',
        models: [
            'claude-opus-4-7',
            'claude-opus-4-6',
            'claude-sonnet-4-6',
            'claude-haiku-4-5',
        ],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: false,   // needs adapter
        toolCallStyle: 'openai',     // adapter normalises to openai format
    },
    deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        endpoint: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 128000,
        isOpenAICompatible: true,
        // Official API → standard openai tool_calls JSON.
        // Raw/local via vLLM → <｜DSML｜function_calls> (handled as fallback).
        toolCallStyle: 'openai',
    },
    minimax: {
        id: 'minimax',
        name: 'MiniMax',
        endpoint: 'https://api.minimax.chat/v1',
        defaultModel: 'MiniMax-M2.7',
        models: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.5-Lightning'],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 204800,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
    },
    glm: {
        id: 'glm',
        name: 'GLM (智谱 Zhipu)',
        endpoint: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-5.1',
        models: ['glm-5.1', 'glm-5', 'glm-5v-turbo'],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
    },
    qwen: {
        id: 'qwen',
        name: 'Qwen (通义千问)',
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen3.6-plus',
        models: ['qwen3.6-plus', 'qwen3.5-plus', 'qwen3.6-flash'],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: true,
        // DashScope OpenAI-compat endpoint → standard tool_calls JSON.
        // Local Qwen3 via Ollama → <tool_call>{JSON}</tool_call> (Hermes, handled as fallback).
        toolCallStyle: 'openai',
    },
    google: {
        id: 'google',
        name: 'Google (Gemini)',
        // Google provides an OpenAI-compatible endpoint (no trailing /v1 needed — it's included)
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-2.5-pro',
        models: [
            'gemini-3.1-pro-preview',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
        ],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 1048576,   // 1M token context window
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
    },
    ollama: {
        id: 'ollama',
        name: 'Ollama (本地模型)',
        endpoint: 'http://localhost:11434/v1',
        defaultModel: '',
        models: [],  // Auto-detected from running Ollama instance
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 32768,
        isOpenAICompatible: true,
        // Ollama normalises tool_calls to openai format for most models.
        // If the model outputs raw <tool_call> text, fallback parser handles it.
        toolCallStyle: 'openai',
    },
    custom: {
        id: 'custom',
        name: '自定义 (OpenAI Compatible)',
        endpoint: '',
        defaultModel: '',
        models: [],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 32000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
    },
};

/**
 * Get a provider config by ID, falling back to custom.
 */
export function getProvider(id: string): AIProviderConfig {
    return BUILTIN_PROVIDERS[id] ?? BUILTIN_PROVIDERS['custom'];
}

/**
 * Fetch available models from a running Ollama instance.
 * Queries GET /api/tags and returns model names with metadata.
 * Returns empty array if Ollama is not reachable.
 */
export async function fetchOllamaModels(
    endpoint?: string
): Promise<Array<{ name: string; size: string; parameterSize?: string }>> {
    // Ollama API root is at port 11434, not /v1
    const baseUrl = (endpoint || 'http://localhost:11434/v1')
        .replace(/\/v1\/?$/, '');

    try {
        const response = await fetch(`${baseUrl}/api/tags`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000), // 5s timeout
        });

        if (!response.ok) return [];

        const data = await response.json() as {
            models?: Array<{
                name: string;
                size: number;
                details?: {
                    parameter_size?: string;
                    family?: string;
                };
            }>;
        };

        if (!data.models || data.models.length === 0) return [];

        return data.models.map(m => ({
            name: m.name,
            size: formatBytes(m.size),
            parameterSize: m.details?.parameter_size,
        }));
    } catch {
        return [];
    }
}

/** Format bytes to human-readable string */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(1)} GB`;
}

/**
 * Get the effective endpoint for a provider (user override takes precedence).
 */
export function getEffectiveEndpoint(providerId: string, userEndpoint?: string): string {
    if (userEndpoint && userEndpoint.trim().length > 0) {
        return userEndpoint.trim().replace(/\/+$/, '');
    }
    const provider = getProvider(providerId);
    return provider.endpoint;
}

/**
 * Get the effective model for a provider (user override takes precedence).
 */
export function getEffectiveModel(providerId: string, userModel?: string): string {
    if (userModel && userModel.trim().length > 0) {
        return userModel.trim();
    }
    const provider = getProvider(providerId);
    return provider.defaultModel;
}

// ─── Claude API Adapter ──────────────────────────────────────────────────────

/**
 * Converts an OpenAI-format request to Claude Messages API format.
 * Claude uses a different structure for system prompts, tools, and responses.
 */
export function toClaudeRequest(request: ChatCompletionRequest): Record<string, unknown> {
    // Extract system message
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => m.content).join('\n\n');

    // Convert non-system messages
    const claudeMessages: Array<Record<string, unknown>> = [];
    for (const msg of request.messages) {
        if (msg.role === 'system') continue;

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            // Assistant message with tool calls
            const content: Array<Record<string, unknown>> = [];
            if (msg.content) {
                content.push({ type: 'text', text: msg.content });
            }
            for (const tc of msg.tool_calls) {
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: JSON.parse(tc.function.arguments),
                });
            }
            claudeMessages.push({ role: 'assistant', content });
        } else if (msg.role === 'tool') {
            // Tool result message
            claudeMessages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                }],
            });
        } else {
            // Text or multimodal user/assistant message
            const role = msg.role === 'user' ? 'user' : 'assistant';
            if (Array.isArray(msg.content)) {
                // Convert OpenAI ContentPart[] → Claude content blocks
                const claudeContent: Array<Record<string, unknown>> = [];
                for (const part of msg.content as ContentPart[]) {
                    if (part.type === 'text') {
                        claudeContent.push({ type: 'text', text: part.text });
                    } else if (part.type === 'image_url') {
                        // Convert data URL to Claude's base64 format
                        const url = part.image_url.url;
                        const mediaMatch = url.match(/^data:(image\/[a-z]+);base64,(.+)$/);
                        if (mediaMatch) {
                            claudeContent.push({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: mediaMatch[1],
                                    data: mediaMatch[2],
                                },
                            });
                        }
                    }
                }
                claudeMessages.push({ role, content: claudeContent });
            } else {
                claudeMessages.push({ role, content: msg.content ?? '' });
            }
        }
    }

    // Convert tools
    const claudeTools = request.tools?.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));

    const claudeRequest: Record<string, unknown> = {
        model: request.model,
        system: systemPrompt || undefined,
        messages: claudeMessages,
        max_tokens: request.max_tokens ?? 4096,
    };
    if (claudeTools && claudeTools.length > 0) {
        claudeRequest.tools = claudeTools;
    }
    if (request.temperature !== undefined) {
        claudeRequest.temperature = request.temperature;
    }
    if (request.stream) {
        claudeRequest.stream = true;
    }

    return claudeRequest;
}

/**
 * Converts a Claude Messages API response to OpenAI-compatible format.
 */
export function fromClaudeResponse(claudeResp: Record<string, unknown>): ChatCompletionResponse {
    const content = claudeResp.content as Array<Record<string, unknown>> ?? [];

    let textContent = '';
    const toolCalls: ChatMessage['tool_calls'] = [];

    for (const block of content) {
        if (block.type === 'text') {
            textContent += (block.text as string) ?? '';
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id as string,
                type: 'function',
                function: {
                    name: block.name as string,
                    arguments: JSON.stringify(block.input),
                },
            });
        }
    }

    const stopReason = claudeResp.stop_reason as string;
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
    if (stopReason === 'tool_use') finishReason = 'tool_calls';
    else if (stopReason === 'max_tokens') finishReason = 'length';

    const message: ChatMessage = {
        role: 'assistant',
        content: textContent || null,
    };
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    const usage = claudeResp.usage as Record<string, number> | undefined;

    return {
        id: (claudeResp.id as string) ?? '',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: (claudeResp.model as string) ?? '',
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason,
        }],
        usage: usage ? {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        } : undefined,
    };
}
