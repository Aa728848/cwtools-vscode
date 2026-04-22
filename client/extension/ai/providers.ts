/**
 * CWTools AI Module — Provider Definitions & Quick Configurations
 *
 * Supports: OpenAI, Claude, Google Gemini, DeepSeek,
 *   MiniMax (pay-as-you-go, OpenAI compat),
 *   MiniMax Token Plan (Anthropic compat, api.minimaxi.com),
 *   GLM (Zhipu), Qwen (Tongyi), Ollama, Custom
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
        // All gpt-4o+ and gpt-5+ models support vision (image_url in content)
        supportsVision: true,
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
        supportsVision: true,
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
        supportsVision: false,
    },
    minimax: {
        id: 'minimax',
        name: 'MiniMax (按量计费)',
        // Pay-as-you-go: standard OpenAI-compatible endpoint
        endpoint: 'https://api.minimax.chat/v1',
        defaultModel: 'MiniMax-M2.7',
        models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2'],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        // MiniMax M2/M2.5/M2.7 are natively multimodal (docs: minimax.io)
        // IMPORTANT: MiniMax does NOT support image_url.detail (causes error 2013 / "cannot read URL").
        //   aiService.sanitizeRequest() strips the `detail` field automatically for this provider.
        // IMPORTANT: MiniMax does NOT support tool_choice — also stripped in sanitizeRequest.
        supportsVision: true,
    },
    'minimax-token-plan': {
        id: 'minimax-token-plan',
        name: 'MiniMax Token Plan',
        // Token Plan: Anthropic Messages API compatible endpoint
        // Docs: https://platform.minimax.io/docs/api-reference/text-anthropic-api
        endpoint: 'https://api.minimaxi.com/anthropic/v1',
        defaultModel: 'MiniMax-M2.7',
        models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2'],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: false,   // uses Anthropic Messages API
        toolCallStyle: 'openai',     // adapter normalises to openai format
        // IMPORTANT: MiniMax Token Plan Anthropic-compat endpoint does NOT support image inputs.
        // Official docs (2026-04): "Image and document type inputs are not currently supported"
        // Use the pay-as-you-go 'minimax' provider (OpenAI-compat) if you need vision.
        supportsVision: false,
    },
    glm: {
        id: 'glm',
        name: 'GLM (智谱 Zhipu)',
        // Standard OpenAI-compat endpoint
        // Auth: API key is "{id}.{secret}" — buildAuthHeaders() auto-generates HS256 JWT
        endpoint: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-5.1',
        models: [
            // Text / Agent series (latest)
            'glm-5.1',
            'glm-5',
            'glm-5-turbo',
            // Multimodal reasoning series
            'glm-4.1v-thinking',
            'glm-4.1v-thinking-flash',
            // Flash / free tier
            'glm-z1-flash',
            'glm-4-flash',
        ],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        // GLM-4.1v-thinking* are vision-capable; text models (glm-5, glm-z1-flash) are not.
        // Use isModelVisionCapable(model) to check at runtime.
        supportsVision: true,
    },
    qwen: {
        id: 'qwen',
        name: 'Qwen (通义千问)',
        // Standard OpenAI-compat, Bearer sk-xxx auth, supports tool_choice
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen3.6-plus',
        models: [
            'qwen3.6-plus',
            'qwen3.5-plus',
            'qwen3.6-flash',
            'qwen3-235b-a22b',
            'qwen3-32b',
            'qwen-max',
            'qwen-turbo',
            'qwen-long',
        ],
        supportsToolUse: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        // Current listed models are text-only (qwen3.6-plus etc). VL models
        // (qwen-vl, qwen2.5-vl) must be specified manually; use isModelVisionCapable().
        supportsVision: false,
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
        // All Gemini models are natively multimodal (docs: ai.google.dev)
        supportsVision: true,
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
        // Vision depends on local model; allow and let API return error if unsupported.
        supportsVision: true,
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
        // Custom endpoint: assume vision capable; user responsible for model choice.
        supportsVision: true,
    },
};

/**
 * Model-level vision capability map.
 * Entries here override the provider-level `supportsVision` flag.
 * A model is vision-capable if its name starts with or contains any key.
 *
 * Sources (verified 2026-04):
 *   OpenAI:    gpt-4o and later — all vision-capable
 *   Claude:    All Claude 3+ models support vision
 *   Gemini:    All Gemini models are natively multimodal
 *   MiniMax:   M2 series — all native multimodal
 *   GLM:       Only glm-4Xv / glm-4.1v / glm-4.5v variants; text models do not support images
 *   Qwen:      Only qwen-vl / qwen2.5-vl / qwen3-vl variants; qwen-long/turbo/max are text-only
 *   DeepSeek:  Official API (chat/reasoner) is text-only; Janus-Pro is not in the chat API
 *   Ollama:    Depends on local model — use 'auto' detection via model name
 */
export const VISION_CAPABLE_MODELS: Record<string, boolean> = {
    // ── OpenAI ─────────────────────────────────────────────────────────────────
    // All gpt-5.x and gpt-4o+ models support vision (image_url content type).
    // Listed models: gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5-mini, gpt-5-nano
    'gpt-5.4': true,
    'gpt-5.4-mini': true,
    'gpt-5.4-nano': true,
    'gpt-5-mini': true,
    'gpt-5-nano': true,
    // Legacy / alias prefixes (covers user-specified custom OpenAI vision models)
    'gpt-4o': true,
    'gpt-4-vision': true,
    'gpt-5': true,           // prefix catch-all for future gpt-5.x variants

    // ── Anthropic Claude ───────────────────────────────────────────────────────
    // All Claude 3+ models support vision.
    // Listed models: claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
    'claude-opus-4-7': true,
    'claude-opus-4-6': true,
    'claude-sonnet-4-6': true,
    'claude-haiku-4-5': true,
    // Prefix catch-alls for future claude-3.x / claude-4.x variants
    'claude-3': true,
    'claude-4': true,

    // ── Google Gemini ──────────────────────────────────────────────────────────
    // All Gemini models are natively multimodal.
    // Listed models: gemini-3.1-pro-preview, gemini-3-flash-preview,
    //   gemini-3.1-flash-lite-preview, gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite
    'gemini-3.1-pro-preview': true,
    'gemini-3-flash-preview': true,
    'gemini-3.1-flash-lite-preview': true,
    'gemini-2.5-pro': true,
    'gemini-2.5-flash': true,
    'gemini-2.5-flash-lite': true,
    // Prefix catch-all (covers any gemini-* the user types in manually)
    'gemini': true,

    // ── MiniMax ────────────────────────────────────────────────────────────────
    // M2 series is natively multimodal (text + image + document) on the pay-as-you-go
    // OpenAI-compat endpoint ('minimax' provider, api.minimax.chat).
    // NOTE: The Token Plan Anthropic-compat endpoint ('minimax-token-plan') does NOT support
    //   images — agentRunner guards against sending images to provider with supportsVision:false.
    // Listed models: MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5,
    //   MiniMax-M2.5-highspeed, MiniMax-M2.1, MiniMax-M2
    'MiniMax-M2': true,      // prefix covers M2, M2.1, M2.5, M2.7 and highspeed variants

    // ── GLM (Zhipu / Z.ai) ────────────────────────────────────────────────────
    // Only the -v (vision) suffix models support images.
    // Listed vision models: glm-4.1v-thinking, glm-4.1v-thinking-flash
    // Listed text-only:     glm-5.1, glm-5, glm-5-turbo, glm-z1-flash, glm-4-flash
    'glm-4.1v-thinking': true,
    'glm-4.1v-thinking-flash': true,
    // Future-proof aliases for GLM vision variants
    'glm-4v': true,
    'glm-4.5v': true,
    // Explicitly mark text-only GLM models as false (prevents false-positive prefix match)
    'glm-5.1': false,
    'glm-5-turbo': false,
    'glm-5': false,
    'glm-z1-flash': false,
    'glm-4-flash': false,

    // ── Qwen (DashScope) ──────────────────────────────────────────────────────
    // Current listed models are all text-only.
    // Listed: qwen3.6-plus, qwen3.5-plus, qwen3.6-flash, qwen3-235b-a22b,
    //         qwen3-32b, qwen-max, qwen-turbo, qwen-long
    'qwen3.6-plus': false,
    'qwen3.5-plus': false,
    'qwen3.6-flash': false,
    'qwen3-235b-a22b': false,
    'qwen3-32b': false,
    'qwen-max': false,
    'qwen-turbo': false,
    'qwen-long': false,
    // VL variants (user must specify manually, not in default list)
    'qwen-vl': true,
    'qwen2-vl': true,
    'qwen2.5-vl': true,
    'qwen3-vl': true,

    // ── DeepSeek ──────────────────────────────────────────────────────────────
    // Official API models are text-only (Janus-Pro vision is not exposed via chat API).
    // Listed: deepseek-chat, deepseek-reasoner
    'deepseek-chat': false,
    'deepseek-reasoner': false,
};

/**
 * Check if a specific model name is vision-capable.
 * Uses VISION_CAPABLE_MODELS prefix/substring matching for flexibility.
 */
export function isModelVisionCapable(model: string): boolean {
    if (!model) return false;
    const lower = model.toLowerCase();
    for (const [key, capable] of Object.entries(VISION_CAPABLE_MODELS)) {
        if (lower.includes(key.toLowerCase())) return capable;
    }
    return false;
}

/**
 * Per-model context window sizes (tokens).
 * Used by the settings UI to auto-fill the context size field when the user selects a model.
 * Falls back to the provider-level maxContextTokens if a model is not listed here.
 *
 * Sources (verified 2026-04):
 *   OpenAI:    https://platform.openai.com/docs/models
 *   Anthropic: https://www.anthropic.com/api
 *   DeepSeek:  https://platform.deepseek.com/
 *   Google:    https://ai.google.dev/gemini-api/docs/models
 *   MiniMax:   https://www.minimax.io/
 *   Zhipu:     https://bigmodel.cn / z.ai
 *   DashScope: https://www.alibabacloud.com/help/en/model-studio/
 */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
    // ── OpenAI ──────────────────────────────────────────────────────────────────
    'gpt-5.4':         400000,
    'gpt-5.4-mini':    200000,
    'gpt-5.4-nano':    128000,
    'gpt-5-mini':      200000,
    'gpt-5-nano':      128000,
    'gpt-4o':          128000,
    'gpt-4-vision':    128000,

    // ── Anthropic Claude ─────────────────────────────────────────────────────────
    'claude-opus-4-7':   1000000,
    'claude-opus-4-6':   1000000,
    'claude-sonnet-4-6': 1000000,
    'claude-haiku-4-5':   200000,

    // ── DeepSeek ────────────────────────────────────────────────────────────────
    'deepseek-chat':     128000,
    'deepseek-reasoner': 128000,

    // ── MiniMax ──────────────────────────────────────────────────────────────────
    'MiniMax-M2.7':              1000000,
    'MiniMax-M2.7-highspeed':    1000000,
    'MiniMax-M2.5':              1000000,
    'MiniMax-M2.5-highspeed':    1000000,
    'MiniMax-M2.1':              1000000,
    'MiniMax-M2':                1000000,

    // ── GLM (Zhipu / Z.ai) ───────────────────────────────────────────────────────
    'glm-5.1':                200000,
    'glm-5':                  200000,
    'glm-5-turbo':            128000,
    'glm-4.1v-thinking':      128000,
    'glm-4.1v-thinking-flash': 128000,
    'glm-z1-flash':            128000,
    'glm-4-flash':             128000,

    // ── Qwen (DashScope) ─────────────────────────────────────────────────────────
    'qwen3.6-plus':       1000000,
    'qwen3.5-plus':       1000000,
    'qwen3.6-flash':       128000,
    'qwen3-235b-a22b':     128000,
    'qwen3-32b':           128000,
    'qwen-max':            128000,
    'qwen-turbo':           32000,
    'qwen-long':          1000000,

    // ── Google Gemini ────────────────────────────────────────────────────────────
    'gemini-3.1-pro-preview':       1048576,
    'gemini-3-flash-preview':       1048576,
    'gemini-3.1-flash-lite-preview': 1048576,
    'gemini-2.5-pro':               1048576,
    'gemini-2.5-flash':             1048576,
    'gemini-2.5-flash-lite':        1048576,
};

/**
 * Get the context window size for a specific model.
 * Tries exact match first, then prefix/substring match, then falls back to
 * the provider's maxContextTokens, or 0 (meaning "use provider default").
 */
export function getModelContextTokens(model: string, providerId?: string): number {
    if (!model) return 0;
    // 1. Exact match
    if (model in MODEL_CONTEXT_TOKENS) return MODEL_CONTEXT_TOKENS[model];
    // 2. Prefix match (e.g. "claude-sonnet-4-6-20251020" → "claude-sonnet-4-6")
    for (const key of Object.keys(MODEL_CONTEXT_TOKENS)) {
        if (model.startsWith(key)) return MODEL_CONTEXT_TOKENS[key];
    }
    // 3. Substring match
    for (const key of Object.keys(MODEL_CONTEXT_TOKENS)) {
        if (model.includes(key)) return MODEL_CONTEXT_TOKENS[key];
    }
    // 4. Fall back to provider-level context limit
    if (providerId) {
        const provider = BUILTIN_PROVIDERS[providerId];
        if (provider) return provider.maxContextTokens;
    }
    return 0;
}

/**
 * Get a provider config by ID, falling back to custom.
 */
export function getProvider(id: string): AIProviderConfig {
    if (id && !(id in BUILTIN_PROVIDERS)) {
        console.warn(`[Eddy AI] Unknown provider "${id}", falling back to custom.`);
    }
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
    // L5 Fix: content may be string | ContentPart[] | null — use helper to avoid
    // .join() on an array (which produces "[object Object]" for ContentPart items).
    const contentToStr = (c: string | ContentPart[] | null | undefined): string => {
        if (!c) return '';
        if (typeof c === 'string') return c;
        return (c as ContentPart[])
            .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
            .map(p => p.text)
            .join('');
    };

    // Extract system message
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => contentToStr(m.content)).join('\n\n');

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
                // Guard against malformed/truncated arguments from streaming
                let toolInput: unknown = {};
                try { toolInput = JSON.parse(tc.function.arguments); }
                catch { toolInput = {}; /* Degraded: empty args better than a crash */ }
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: toolInput,
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
                        // Convert data URL to Claude's base64 source format.
                        // Regex accepts full MIME type charset (e.g. image/svg+xml, image/webp)
                        // and does NOT anchor at $ to tolerate data URLs with no padding issues.
                        const url = part.image_url.url;
                        const mediaMatch = url.match(/^data:(image\/[a-zA-Z+.-]+);base64,([A-Za-z0-9+/=]+)/);
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
                        // If URL is an HTTPS URL (not data:), pass as url type instead
                        else if (url.startsWith('http')) {
                            claudeContent.push({
                                type: 'image',
                                source: { type: 'url', url },
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
