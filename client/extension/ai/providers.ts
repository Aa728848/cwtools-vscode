/**
 * CWTools AI Module — Provider Definitions & Quick Configurations
 *
 * Supports: OpenAI, Claude, Google Gemini, DeepSeek,
 *   MiniMax (pay-as-you-go, OpenAI compat),
 *   MiniMax Token Plan (Anthropic compat, api.minimaxi.com),
 *   GLM (Zhipu), Qwen (Tongyi), MiMo (Xiaomi), Ollama, Custom
 */

import type { AIProviderConfig, ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ContentPart } from './types';

// ─── Built-in Provider Definitions ────────────────────────────────────────────

export const BUILTIN_PROVIDERS: Record<string, AIProviderConfig> = {
    openai: {
        id: 'openai',
        name: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        defaultModel: 'gpt-5.5',
        models: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano'],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 400000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        // All gpt-4o+ and gpt-5+ models support vision (image_url in content)
        supportsFIM: false,
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
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: false,   // needs adapter
        toolCallStyle: 'openai',     // adapter normalises to openai format
        supportsFIM: false,
        supportsVision: true,
    },
    deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        endpoint: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-v4-pro',
        models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 1048576,
        isOpenAICompatible: true,
        // Official API → standard openai tool_calls JSON.
        // Raw/local via vLLM → <｜DSML｜function_calls> (handled as fallback).
        toolCallStyle: 'openai',
        supportsFIM: true,
        supportsVision: false,
    },
    minimax: {
        id: 'minimax',
        name: 'MiniMax (按量计费)',
        // Pay-as-you-go: standard OpenAI-compatible endpoint
        endpoint: 'https://api.minimaxi.com/v1',
        defaultModel: 'MiniMax-M2.7',
        models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2'],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        // MiniMax M2/M2.5/M2.7 are natively multimodal (docs: minimax.io)
        // IMPORTANT: MiniMax's OpenAI-compatible endpoint currently does NOT support image or audio inputs.
        // Official docs (2026-04): "当前不支持图像和音频类型的输入"
        // IMPORTANT: MiniMax does NOT support tool_choice — also stripped in sanitizeRequest.
        supportsFIM: false,
        supportsVision: false,
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
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        isOpenAICompatible: false,   // uses Anthropic Messages API
        toolCallStyle: 'openai',     // adapter normalises to openai format
        // IMPORTANT: MiniMax Token Plan Anthropic-compat endpoint does NOT support image inputs.
        // Official docs (2026-04): "Image and document type inputs are not currently supported"
        // Use the pay-as-you-go 'minimax' provider (OpenAI-compat) if you need vision.
        supportsFIM: false,
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
            'glm-5v-turbo',
            'glm-4.1v-thinking',
            'glm-4.1v-thinking-flash',
            // Flash / free tier
            'glm-z1-flash',
            'glm-4-flash',
        ],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        // GLM-4.1v-thinking* are vision-capable; text models (glm-5, glm-z1-flash) are not.
        // Use isModelVisionCapable(model) to check at runtime.
        supportsFIM: false,
        supportsVision: true,
    },
    qwen: {
        id: 'qwen',
        name: 'Qwen (通义千问)',
        // Standard OpenAI-compat, Bearer sk-xxx auth, supports tool_choice
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen3.6-plus',
        models: [
            'qwen3.6-max-preview',
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
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        // Current listed models are text-only (qwen3.6-plus etc). VL models
        // (qwen-vl, qwen2.5-vl) must be specified manually; use isModelVisionCapable().
        supportsFIM: false,
        supportsVision: false,
    },
    mimo: {
        id: 'mimo',
        name: 'MiMo (小米)',
        endpoint: 'https://api.xiaomimimo.com/v1',
        defaultModel: 'mimo-v2.5-pro',
        models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash'],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        supportsFIM: false,
        supportsVision: true,
    },
    'mimo-token-plan': {
        id: 'mimo-token-plan',
        name: 'MiMo Token Plan (小米)',
        endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
        defaultModel: 'mimo-v2.5-pro',
        models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash'],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 1000000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        supportsFIM: false,
        supportsVision: true,
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
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 1048576,   // 1M token context window
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        // All Gemini models are natively multimodal (docs: ai.google.dev)
        supportsFIM: false,
        supportsVision: true,
    },
    ollama: {
        id: 'ollama',
        name: 'Ollama (本地模型)',
        endpoint: 'http://localhost:11434/v1',
        defaultModel: '',
        models: [],  // Auto-detected from running Ollama instance
        supportsToolUse: true,
        requiresApiKey: false,
        supportsStreaming: true,
        maxContextTokens: 32768,
        isOpenAICompatible: true,
        // Ollama normalises tool_calls to openai format for most models.
        // If the model outputs raw <tool_call> text, fallback parser handles it.
        toolCallStyle: 'openai',
        // Vision depends on local model; allow and let API return error if unsupported.
        supportsFIM: true,
        supportsVision: true,
    },
    siliconflow: {
        id: 'siliconflow',
        name: 'SiliconFlow (硅基流动)',
        endpoint: 'https://api.siliconflow.cn/v1',
        defaultModel: 'deepseek-ai/DeepSeek-V3',
        models: [
            'deepseek-ai/DeepSeek-V3',
            'deepseek-ai/DeepSeek-R1',
            'Qwen/Qwen2.5-Coder-32B-Instruct',
            'Qwen/Qwen2.5-7B-Instruct',
            'THUDM/glm-4-9b-chat'
        ],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 64000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        supportsFIM: true,
        supportsVision: false,
    },
    openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        endpoint: 'https://openrouter.ai/api/v1',
        defaultModel: 'deepseek/deepseek-v4-pro',
        models: [
            'deepseek/deepseek-v4-pro',
            'deepseek/deepseek-r1',
            'anthropic/claude-3.5-sonnet',
            'google/gemini-2.5-pro',
            'openai/gpt-4o',
            'openai/o3-mini'
        ],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 128000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        supportsFIM: true,
        supportsVision: true,
    },
    github: {
        id: 'github',
        name: 'GitHub Models',
        endpoint: 'https://models.inference.ai.azure.com',
        defaultModel: 'DeepSeek-V3',
        models: [
            'DeepSeek-V3',
            'DeepSeek-R1',
            'gpt-4o',
            'o3-mini'
        ],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 128000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        supportsFIM: false,
        supportsVision: true,
    },
    together: {
        id: 'together',
        name: 'Together AI',
        endpoint: 'https://api.together.xyz/v1',
        defaultModel: 'deepseek-ai/DeepSeek-V3',
        models: [
            'deepseek-ai/DeepSeek-V3',
            'deepseek-ai/DeepSeek-R1',
            'meta-llama/Llama-3.3-70B-Instruct-Turbo'
        ],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 128000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        supportsFIM: true,
        supportsVision: false,
    },
    deepinfra: {
        id: 'deepinfra',
        name: 'DeepInfra',
        endpoint: 'https://api.deepinfra.com/v1/openai',
        defaultModel: 'deepseek-ai/DeepSeek-V3',
        models: [
            'deepseek-ai/DeepSeek-V3',
            'deepseek-ai/DeepSeek-R1',
            'meta-llama/Llama-3.3-70B-Instruct'
        ],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 128000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        supportsFIM: true,
        supportsVision: false,
    },
    opencode: {
        id: 'opencode',
        name: 'OpenCode Zen',
        // OpenCode Zen — managed model gateway (opencode.ai)
        // Models are referenced as opencode/<model-id> (e.g. opencode/claude-sonnet-4-6)
        endpoint: 'https://opencode.ai/zen/v1',
        defaultModel: 'big-pickle (免费)',
        models: [
            // OpenCode Zen Free Models
            'big-pickle (免费)',
            'minimax-m2.5-free (免费)',
            'ling-2.6-flash-free (免费)',
            'trinity-large-preview-free (免费)',
            'nemotron-3-super-free (免费)',
            'hy3-preview-free (免费)',
            'gpt-5-nano (免费)',
            // Other Supported Models
            'claude-sonnet-4-6',
            'claude-sonnet-4-5',
            'claude-sonnet-4',
            'claude-opus-4-6',
            'claude-opus-4-5',
            'claude-opus-4-1',
            'claude-3-5-haiku',
            'claude-haiku-4-5',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.4-pro',
            'gpt-5.4-mini',
            'gpt-5.4-nano',
            'gpt-5.1',
            'gpt-5',
            'gpt-5-codex',
            'gemini-3.1-pro',
            'gemini-3-pro',
            'gemini-3-flash',
            'glm-5.1',
            'glm-5',
            'kimi-k2.6',
            'kimi-k2.5',
            'minimax-m2.7',
            'minimax-m2.5',
            'qwen3.6-plus',
            'qwen3.5-plus'
        ],
        supportsToolUse: true,
        requiresApiKey: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        isOpenAICompatible: true,
        toolCallStyle: 'openai',
        supportsFIM: false,
        supportsVision: true,
    }
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
    // M2 series is multimodal in its native API, but their OpenAI-compatible endpoint
    // and Anthropic-compatible endpoint explicitly state they do NOT support images.
    // NOTE: The Token Plan Anthropic-compat endpoint ('minimax-token-plan') does NOT support
    //   images — agentRunner guards against sending images to provider with supportsVision:false.
    // Listed models: MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5,
    //   MiniMax-M2.5-highspeed, MiniMax-M2.1, MiniMax-M2
    'MiniMax-M2': false,     // Both Token Plan and pay-as-you-go APIs reject image inputs

    // ── GLM (Zhipu / Z.ai) ────────────────────────────────────────────────────
    // Only the -v (vision) suffix models support images.
    // Listed vision models: glm-5v-turbo, glm-4.1v-thinking, glm-4.1v-thinking-flash
    // Listed text-only:     glm-5.1, glm-5, glm-5-turbo, glm-z1-flash, glm-4-flash
    'glm-5v-turbo': true,
    'glm-4.1v-thinking': true,
    'glm-4.1v-thinking-flash': true,
    // Future-proof aliases for GLM vision variants
    'glm-5v': true,
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
    // Listed: deepseek-v4-pro, deepseek-v4-flash
    'deepseek-v4-pro': false,
    'deepseek-v4-flash': false,

    // ── MiMo (Xiaomi) ────────────────────────────────────────────────────────
    // mimo-v2.5-pro and mimo-v2-omni are multimodal (support image input).
    // mimo-v2.5, mimo-v2-pro, mimo-v2-flash are text-only.
    'mimo-v2.5-pro': true,
    'mimo-v2-omni': true,
    'mimo-v2-pro': false,
    'mimo-v2.5': false,
    'mimo-v2-flash': false,
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
 * Model-level FIM (Fill-in-the-Middle) capability map.
 * Entries here filter the available models when FIM mode is enabled.
 */
export const FIM_CAPABLE_MODELS: Record<string, boolean> = {
    // DeepSeek
    'deepseek-v4-pro': true,
    'deepseek-v4-flash': true,
    'deepseek-coder': true,
    // Provide general suffixes/substrings for code models
    'qwen2.5-coder': true,
    'codellama': true,
    'starcoder': true,
    'qwen': false, // by default qwen text models not FIM
    // Add models which explicitly don't support FIM
    'gpt-': false,
    'claude-': false,
};

/**
 * Check if a specific model name is FIM-capable.
 * Uses provider default if model-level override is not defined.
 */
export function isModelFIMCapable(model: string, providerId: string): boolean {
    const provider = getProvider(providerId);
    if (!model) return provider.supportsFIM;

    const lower = model.toLowerCase();
    for (const [key, capable] of Object.entries(FIM_CAPABLE_MODELS)) {
        if (lower.includes(key.toLowerCase())) return capable;
    }

    // Fallback to provider default if not explicitly listed
    return provider.supportsFIM;
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
/**
 * Fix #4: Single source of truth for thinking models that CANNOT disable thinking.
 * Used by both chatPanel.ts (settings UI filter) and inlineProvider.ts (blocking).
 * Models on this list are too slow for inline completion.
 */
export const ALWAYS_THINKING_PREFIXES: string[] = [
    'deepseek-reasoner', 'deepseek-r1', 'DeepSeek-R1',
    'o1', 'o3', 'o4-mini',
    'glm-z1', 'GLM-Z1',
    'gemini-2.5-pro', 'gemini-3.1-pro',
    'minimax-m2',
    'QwQ', 'qwq',
    'Thinking', 'thinking',
];

export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
    // ── OpenAI ──────────────────────────────────────────────────────────────────
    'gpt-5.5': 1000000,
    'gpt-5.5-pro': 1000000,
    'gpt-5.4': 1000000,
    'gpt-5.4-mini': 200000,
    'gpt-5.4-nano': 128000,
    'gpt-5-mini': 200000,
    'gpt-5-nano': 400000,
    'gpt-4-vision': 128000,

    // ── Anthropic Claude ─────────────────────────────────────────────────────────
    'claude-opus-4-7': 1000000,
    'claude-opus-4-6': 1000000,
    'claude-sonnet-4-6': 1000000,
    'claude-haiku-4-5': 200000,

    // ── DeepSeek ────────────────────────────────────────────────────────────────
    // (moved to Model Family Fallbacks section below)

    // ── MiniMax ──────────────────────────────────────────────────────────────────
    'MiniMax-M2.7': 200000,
    'MiniMax-M2.7-highspeed': 200000,
    'MiniMax-M2.5': 200000,
    'MiniMax-M2.5-highspeed': 200000,
    'MiniMax-M2.1': 200000,
    'MiniMax-M2': 200000,

    // ── GLM (Zhipu / Z.ai) ───────────────────────────────────────────────────────
    'glm-5.1': 200000,
    'glm-5': 200000,
    'glm-5-turbo': 128000,
    'glm-5v-turbo': 128000,
    'glm-4.1v-thinking': 128000,
    'glm-4.1v-thinking-flash': 128000,
    'glm-z1-flash': 128000,
    'glm-4-flash': 128000,

    // ── Qwen (DashScope) ─────────────────────────────────────────────────────────
    'qwen3.6-max-preview': 1000000,
    'qwen3.6-plus': 1000000,
    'qwen3.5-plus': 1000000,
    'qwen3.6-flash': 128000,
    'qwen3-235b-a22b': 128000,
    'qwen3-32b': 128000,

    // ── Google Gemini ────────────────────────────────────────────────────────────
    'gemini-3.1-pro-preview': 1048576,
    'gemini-3-flash-preview': 1048576,
    'gemini-3.1-flash-lite-preview': 1048576,
    'gemini-2.5-pro': 1048576,
    'gemini-2.5-flash': 1048576,
    'gemini-2.5-flash-lite': 1048576,

    // ── MiMo (Xiaomi) ─────────────────────────────────────────────────────────
    'mimo-v2.5-pro': 1000000,
    'mimo-v2.5': 1000000,
    'mimo-v2-pro': 1000000,
    'mimo-v2-omni': 1000000,
    'mimo-v2-flash': 1000000,

    // ── Model Family Fallbacks ────────────────────────────────────────────────────
    // These are used as Tier-2 inference when the API doesn't return context_length
    // (e.g. SiliconFlow, GitHub Models). Matched via substring/prefix in getModelContextTokens().
    // Sources: official model docs, verified 2026-04.

    // OpenAI family
    'gpt-4o': 128000,
    'gpt-4': 128000,
    'gpt-3': 16000,
    'o3': 200000,
    'o1': 200000,

    // Anthropic family
    'claude-opus': 1000000,
    'claude-sonnet': 1000000,
    'claude-haiku': 200000,
    'claude-3.5': 200000,
    'claude-3': 200000,

    // DeepSeek family (deepseek.com — 1M for V4, 128K for earlier)
    'DeepSeek-V3': 128000,
    'DeepSeek-V4': 1048576,
    'DeepSeek-V2': 128000,
    'DeepSeek-R1': 128000,
    'DeepSeek-Coder': 128000,
    'DeepSeek-OCR': 32000,
    'deepseek-v4-pro': 1048576,
    'deepseek-v4-flash': 1048576,
    'deepseek': 128000,

    // Qwen family (dashscope — context varies by variant)
    'Qwen3.6': 1000000,
    'Qwen3.5': 128000,
    'Qwen3-Coder': 128000,
    'Qwen3-VL': 128000,
    'Qwen3-Omni': 128000,
    'Qwen3-235': 128000,
    'Qwen3-32': 128000,
    'Qwen3-14': 128000,
    'Qwen3-8': 128000,
    'Qwen2.5-VL': 128000,
    'Qwen2.5-Coder': 128000,
    'Qwen2.5-72B-Instruct-128K': 128000,
    'Qwen2.5': 32000,
    'Qwen2-VL': 32000,
    'QwQ': 128000,
    'qwen-max': 128000,
    'qwen-turbo': 32000,
    'qwen-long': 1000000,
    'qwen': 128000,

    // GLM / Zhipu / Z.ai family
    'GLM-5.1': 200000,
    'GLM-5': 200000,
    'GLM-4.6': 128000,
    'GLM-4.5': 128000,
    'GLM-4.1': 128000,
    'GLM-Z1': 128000,
    'GLM-4': 128000,
    'glm': 128000,

    // Kimi / Moonshot family (moonshot.cn — K2 uses 128K)
    'Kimi-K2': 128000,
    'moonshot': 128000,
    'kimi': 128000,

    // MiniMax family
    'MiniMax': 200000,
    'minimax': 200000,

    // MiMo family (Xiaomi)
    'mimo': 1000000,

    // Meta Llama family
    'Llama-3.3': 128000,
    'Llama-3.2': 128000,
    'Llama-3.1': 128000,
    'Llama-3': 128000,
    'llama': 128000,

    // Yi / 01.AI family
    'yi-': 128000,

    // InternLM family
    'internlm2': 128000,
    'internlm': 32000,

    // ERNIE / Baidu family
    'ERNIE-4': 128000,
    'ERNIE': 32000,

    // StepFun family
    'Step-3': 128000,
    'Step-2': 128000,

    // Google Gemini family
    'gemini': 1048576,
};

/**
 * Get the context window size for a specific model.
 * Tries exact match first, then prefix/substring match, then falls back to
 * the provider's maxContextTokens, or 0 (meaning "use provider default").
 */
export function getModelContextTokens(model: string, providerId?: string): number {
    if (!model) return 0;
    // 1. Exact match
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (model in MODEL_CONTEXT_TOKENS) return MODEL_CONTEXT_TOKENS[model]!;
    // 2. Prefix match (e.g. "claude-sonnet-4-6-20251020" → "claude-sonnet-4-6")
    const keys = Object.keys(MODEL_CONTEXT_TOKENS).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (model.startsWith(key)) return MODEL_CONTEXT_TOKENS[key]!;
    }
    // 3. Substring match
    for (const key of keys) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (model.includes(key)) return MODEL_CONTEXT_TOKENS[key]!;
    }
    // 4. Fall back to provider-level context limit
    if (providerId) {
        const provider = BUILTIN_PROVIDERS[providerId];
        if (provider) return provider.maxContextTokens;
    }
    return 0;
}

/**
 * Dynamic output token limits for API calls to prevent self-truncation.
 * Deep reasoning models (like DeepSeek R1) consume their output budget with 
 * <think> tokens and can easily exceed small boundary limits.
 *
 * Verified limits (2026-04):
 *   OpenAI GPT-5.4/5.5:   128K output
 *   DeepSeek V4 official:  384K output (1M context)
 *   Claude Opus/Sonnet 4:  8K standard, 300K via Batch API beta
 *   Gemini 2.5/3.x:       65K output
 *   GLM-5:                 128K output (200K context)
 *   MiniMax M2.x:          shared 204K budget (input+output)
 *   Qwen3.x:               up to 65K output
 *
 * NOTE: We intentionally set values BELOW the hard maximum to leave headroom
 * and avoid 400 errors on providers that count reasoning/thinking tokens
 * against the output budget. The goal is "large enough for agent loops,
 * small enough to never hit a hard cap".
 */
export function getModelOutputTokens(model: string, providerId?: string): number {
    if (!model) return 16384;
    const lower = model.toLowerCase();

    // ── Direct provider constraints (official API endpoints) ─────────────
    // max_tokens is just a ceiling — model stops when done, no extra cost.
    // Set to actual API hard caps.
    if (providerId === 'openai') {
        return 128000; // GPT-5.4/5.5 hard cap: 128K
    }
    if (providerId === 'deepseek') {
        return 384000; // DeepSeek V4 hard cap: 384K
    }
    if (providerId === 'claude' || lower.includes('claude')) {
        // ⚠ Claude standard Messages API hard cap is 8192.
        // Exceeding returns 400 — do NOT raise without beta header.
        return 8192;
    }
    if (providerId === 'minimax' || providerId === 'minimax-token-plan' || providerId?.includes('minimax') || lower.includes('minimax')) {
        // MiniMax: shared 204K budget (input+output). Leave room for input.
        return 65536;
    }
    if (providerId === 'glm' || lower.includes('glm')) {
        return 128000; // GLM-5 hard cap: 128K
    }
    if (providerId === 'qwen' || (lower.includes('qwen') && (lower.includes('3') || lower.includes('max') || lower.includes('plus')))) {
        return 65536; // Qwen3.x hard cap: 65536
    }
    if (providerId === 'mimo' || providerId === 'mimo-token-plan' || providerId?.includes('mimo') || lower.includes('mimo')) {
        return 65536; // MiMo output limit (conservative; verify against API docs)
    }

    // ── Model-name based inference (proxy/OpenAI-compat providers) ────────
    if (lower.includes('deepseek') && lower.includes('v4')) {
        return 384000; // DeepSeek V4 hard cap: 384K
    }
    if (lower.includes('deepseek') || lower.includes('r1')) {
        return 65536;
    }
    if (lower.includes('gpt-5')) {
        return 128000;
    }
    if (lower.includes('gemini')) {
        return 65536; // Gemini hard cap: 65536
    }
    if (lower.includes('qwen')) {
        return 65536;
    }
    if (lower.includes('glm')) {
        return 128000;
    }
    
    return 32768;
}

/**
 * Get a provider config by ID, falling back to custom.
 */
export function getProvider(id: string): AIProviderConfig {
    if (id && !(id in BUILTIN_PROVIDERS)) {
        console.warn(`[Eddy AI] Unknown provider "${id}", falling back to openai.`);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return BUILTIN_PROVIDERS[id] ?? BUILTIN_PROVIDERS['openai']!;
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
 * Batch 4.4: Suggest optimal Ollama configuration based on detected models.
 * Analyzes model parameter sizes and names to recommend:
 * - Best model for agent/chat use (largest capable model)
 * - Best model for inline completion (fastest small model)
 * - Recommended context window size
 */
export interface OllamaModelSuggestion {
    /** Recommended model name for chat/agent use */
    chatModel: string;
    /** Recommended model for inline FIM completion (if available) */
    inlineModel?: string;
    /** Recommended context window size */
    contextTokens: number;
    /** Human-readable reasoning for the recommendation */
    reasoning: string;
}

export function suggestOllamaConfig(
    models: Array<{ name: string; size: string; parameterSize?: string }>
): OllamaModelSuggestion | null {
    if (!models.length) return null;

    // Parse parameter sizes to numeric values (e.g., "7B" → 7, "70B" → 70)
    const parsed = models.map(m => {
        let paramB = 0;
        if (m.parameterSize) {
            const match = m.parameterSize.match(/([\d.]+)\s*([BM])/i);
            if (match) {
                paramB = parseFloat(match[1]!);
                if (match[2]!.toUpperCase() === 'M') paramB /= 1000;
            }
        }
        // Fallback: infer from model name (e.g., "llama3:70b", "qwen2.5-coder:32b")
        if (paramB === 0) {
            const nameMatch = m.name.match(/(\d+)[bB]/);
            if (nameMatch) paramB = parseInt(nameMatch[1]!, 10);
        }
        return { ...m, paramB };
    }).sort((a, b) => b.paramB - a.paramB);

    // Identify coding-capable models (prefer those with 'coder', 'code', 'instruct' in name)
    const isCodingModel = (name: string) =>
        /coder|code|instruct|chat/i.test(name);

    // Chat model: largest available coding model, or largest overall
    const codingModels = parsed.filter(m => isCodingModel(m.name));
    const chatModel = codingModels.length > 0 ? codingModels[0]! : parsed[0]!;

    // Inline completion model: smallest model that supports FIM (prefer <14B for speed)
    const smallModels = parsed.filter(m => m.paramB > 0 && m.paramB <= 14);
    const fimCandidates = smallModels.filter(m =>
        /coder|code|deepseek|starcoder|codellama/i.test(m.name)
    );
    const inlineModel = fimCandidates.length > 0
        ? fimCandidates[fimCandidates.length - 1] // smallest FIM-capable
        : (smallModels.length > 0 ? smallModels[smallModels.length - 1] : undefined);

    // Context window: based on largest model's param count
    let contextTokens = 4096; // conservative default
    if (chatModel.paramB >= 70) contextTokens = 32768;
    else if (chatModel.paramB >= 30) contextTokens = 16384;
    else if (chatModel.paramB >= 13) contextTokens = 8192;
    else if (chatModel.paramB >= 7) contextTokens = 4096;

    // Build reasoning
    const parts: string[] = [];
    parts.push(`推荐 "${chatModel.name}" (${chatModel.parameterSize || chatModel.paramB + 'B'}) 作为对话模型`);
    if (inlineModel && inlineModel.name !== chatModel.name) {
        parts.push(`推荐 "${inlineModel.name}" 作为补全模型（较快）`);
    }
    parts.push(`建议上下文窗口: ${contextTokens} tokens`);
    if (chatModel.paramB < 7) {
        parts.push('⚠️ 模型较小，工具调用能力可能有限');
    }

    return {
        chatModel: chatModel.name,
        inlineModel: inlineModel?.name,
        contextTokens,
        reasoning: parts.join('。'),
    };
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

// ─── Disable-Thinking Capability Descriptors ─────────────────────────────────

/**
 * Result of looking up how to disable thinking for a specific model.
 * `extraBody`    → merged into the request body (e.g. enable_thinking, thinking_config)
 * `injectPrompt` → if true, append "/no_think" to system prompt (Qwen fallback)
 */
export interface DisableThinkingResult {
    extraBody?: Record<string, unknown>;
    injectPrompt?: boolean;
}

/**
 * Data-driven table: model-name prefix → disable-thinking parameters.
 * Evaluated top-to-bottom; first match wins.
 * Add new providers here instead of editing aiService.ts if-else trees.
 */
const DISABLE_THINKING_PARAMS: Array<{
    match: (lowerModel: string) => boolean;
    result: DisableThinkingResult;
}> = [
    // ── Qwen: enable_thinking=false + /no_think prompt fallback ──
    {
        match: (m) => m.startsWith('qwen') && (
            m.includes('qwen3') || m.includes('qwen-max') || m.includes('qwen-turbo') || m.includes('qwen-long')
        ),
        result: { extraBody: { enable_thinking: false }, injectPrompt: true },
    },
    // ── GLM thinking models: thinking.type="disabled" ──
    {
        match: (m) => m.startsWith('glm-') && m.includes('thinking'),
        result: { extraBody: { thinking: { type: 'disabled' } } },
    },
    // ── Gemini 2.5 Flash: thinkingBudget=0 (fully disables thinking) ──
    {
        match: (m) => m.startsWith('gemini-2.5-flash'),
        result: { extraBody: { thinking_config: { thinking_budget: 0 } } },
    },
    // ── Gemini 3.x: thinkingLevel="minimal" (cannot fully disable, but minimizes) ──
    {
        match: (m) => m.startsWith('gemini-3'),
        result: { extraBody: { thinking_config: { thinking_level: 'minimal' } } },
    },
    // ── Claude: no special action needed (thinking not sent by default)
    // ── MiniMax: no API toggle (rely on post-processing <think> stripping)
    // ── DeepSeek chat: non-reasoning, no action needed
    // ── OpenAI GPT: non-reasoning, no action needed
];

/**
 * Look up the disable-thinking parameters for a model.
 * Returns undefined if the model doesn't need any special handling.
 */
export function getDisableThinkingParams(model: string): DisableThinkingResult | undefined {
    const lower = model.toLowerCase();
    for (const entry of DISABLE_THINKING_PARAMS) {
        if (entry.match(lower)) return entry.result;
    }
    return undefined;
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
