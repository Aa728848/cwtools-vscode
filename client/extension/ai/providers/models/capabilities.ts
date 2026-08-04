/**
 * CWTools AI 模块 — 模型能力判定与参数查询
 */

import { BUILTIN_PROVIDERS } from './defaults';

/**
 * Model-level vision capability map.
 */
export const VISION_CAPABLE_MODELS: Record<string, boolean> = {
    'gpt-5.6': true,
    'gpt-5.6-sol': true,
    'gpt-5.6-terra': true,
    'gpt-5.6-luna': true,
    'gpt-5.5': true,
    'gpt-5.5-pro': true,
    'gpt-5.5-instant': true,
    'gpt-5.3-instant': true,
    'gpt-5.3-codex-spark': false,
    'gpt-5.4-pro': true,
    'gpt-5.4': true,
    'gpt-5.4-mini': true,
    'gpt-5.4-nano': true,
    'gpt-5-mini': true,
    'gpt-5-nano': true,
    'gpt-4o': true,
    'gpt-4-vision': true,
    'gpt-5': true,
    'claude-fable-5': true,
    'claude-opus-4-8': true,
    'claude-opus-4-7': true,
    'claude-opus-4-6': true,
    'claude-sonnet-5': true,
    'claude-sonnet-4-6': true,
    'claude-haiku-4-5': true,
    'claude-3': true,
    'claude-4': true,
    'gemini-3.1-pro-preview': true,
    'gemini-3.1-pro': true,
    'gemini-3-flash-preview': true,
    'gemini-3.1-flash-lite-preview': true,
    'gemini-3.1-flash-lite': true,
    'gemini-3.5-flash': true,
    'gemini-3.6-flash': true,
    'gemini-3.5-flash-lite': true,
    'gemini-2.5-pro': true,
    'gemini-2.5-flash': true,
    'gemini-2.5-flash-lite': true,
    'gemini': true,
    'minimax-m3-free': false,
    'MiniMax-M3': true,
    'MiniMax-M2': false,
    'glm-5v-turbo': true,
    'glm-4.1v-thinking': true,
    'glm-4.1v-thinking-flash': true,
    'glm-5v': true,
    'glm-5v-flash': true,
    'glm-4v': true,
    'glm-4.5v': true,
    'glm-5.2': false,
    'glm-5.1': false,
    'glm-5-air': false,
    'glm-5-flash': false,
    'glm-5-turbo': false,
    'glm-5': false,
    'glm-4.7': false,
    'glm-4.7-flash': false,
    'glm-4.7-flashx': false,
    'glm-4.6': false,
    'glm-4.6v': true,
    'glm-z1-flash': false,
    'glm-4-flash': false,
    'qwen3.7-max-2026-06-08': true,
    'qwen3.6-plus': true,
    'qwen3.5-plus': true,
    'qwen3.6-flash': true,
    'qwen3.7-max': false,
    'qwen3.8-max': true,
    'qwen3.7-plus': true,
    'qwen3.7-flash': false,
    'qwen3.6-27b': true,
    'qwen3-235b-a22b': false,
    'qwen3-32b': false,
    'qwen-max': false,
    'qwen-turbo': false,
    'qwen-long': false,
    'qwen-vl': true,
    'qwen2-vl': true,
    'qwen2.5-vl': true,
    'qwen3-vl': true,
    'deepseek-v4-pro': false,
    'deepseek-v4-flash': false,
    'mimo-v2.5-pro': false,
    'mimo-v2.5-free': true,
    'mimo-v2.5': true,
    'kimi-k3': true,
    'k3': true,
    'kimi-for-coding': true,
    'kimi-for-coding-highspeed': true,
    'kimi-k2.7-code': true,
    'kimi-k2.6': true,
    'kimi-k2.5': true,
    'grok-build-0.1': true,
    'qwen3.7': false,
    'Qwen3.7': false
};

/**
 * Check if a specific model name is vision-capable.
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
 */
export const FIM_CAPABLE_MODELS: Record<string, boolean> = {
    'deepseek-v4-pro': true,
    'deepseek-v4-flash': true,
    'deepseek-coder': true,
    'qwen2.5-coder': true,
    'codellama': true,
    'starcoder': true,
    'qwen': false,
    'gpt-': false,
    'claude-': false,
};

/**
 * Check if a specific model name is FIM-capable.
 */
export function isModelFIMCapable(model: string, providerId: string): boolean {
    if (!model) {
        const provider = BUILTIN_PROVIDERS[providerId];
        return provider ? provider.supportsFIM : false;
    }

    const lower = model.toLowerCase();
    for (const [key, capable] of Object.entries(FIM_CAPABLE_MODELS)) {
        if (lower.includes(key.toLowerCase())) return capable;
    }

    const provider = BUILTIN_PROVIDERS[providerId];
    return provider ? provider.supportsFIM : false;
}

/**
 * Single source of truth for thinking models that CANNOT disable thinking.
 */
export const ALWAYS_THINKING_PREFIXES: string[] = [
    'deepseek-r1', 'DeepSeek-R1',
    'o1', 'o3', 'o4-mini',
    'glm-z1', 'GLM-Z1',
    'gemini-2.5-pro', 'gemini-3.1-pro',
    'QwQ', 'qwq',
    'Thinking', 'thinking',
    'kimi-k3',
    'k3',
    'kimi-for-coding',
    'kimi-for-coding-highspeed',
    'kimi-k2.7-code',
    'phi-4-reasoning',
];

/** OpenCode Zen limits from its current model metadata. */
export const OPENCODE_MODEL_LIMITS: Record<string, { context: number; output: number }> = {
    'claude-fable-5': { context: 1000000, output: 128000 },
    'claude-haiku-4-5': { context: 200000, output: 64000 },
    'claude-opus-4-1': { context: 200000, output: 32000 },
    'claude-opus-4-5': { context: 200000, output: 64000 },
    'claude-opus-4-6': { context: 1000000, output: 128000 },
    'claude-opus-4-7': { context: 1000000, output: 128000 },
    'claude-opus-4-8': { context: 1000000, output: 128000 },
    'claude-sonnet-5': { context: 1000000, output: 128000 },
    'claude-sonnet-4': { context: 1000000, output: 64000 },
    'claude-sonnet-4-5': { context: 1000000, output: 64000 },
    'claude-sonnet-4-6': { context: 1000000, output: 64000 },
    'gpt-5': { context: 400000, output: 128000 },
    'gpt-5-codex': { context: 400000, output: 128000 },
    'gpt-5-nano': { context: 400000, output: 128000 },
    'gpt-5.1': { context: 400000, output: 128000 },
    'gpt-5.1-codex': { context: 400000, output: 128000 },
    'gpt-5.1-codex-max': { context: 400000, output: 128000 },
    'gpt-5.1-codex-mini': { context: 400000, output: 128000 },
    'gpt-5.2': { context: 400000, output: 128000 },
    'gpt-5.2-codex': { context: 400000, output: 128000 },
    'gpt-5.3-codex': { context: 400000, output: 128000 },
    'gpt-5.3-codex-spark': { context: 128000, output: 128000 },
    'gpt-5.4': { context: 1050000, output: 128000 },
    'gpt-5.4-mini': { context: 400000, output: 128000 },
    'gpt-5.4-nano': { context: 400000, output: 128000 },
    'gpt-5.4-pro': { context: 1050000, output: 128000 },
    'gpt-5.5': { context: 1050000, output: 128000 },
    'gpt-5.5-pro': { context: 1050000, output: 128000 },
    'gemini-3-flash': { context: 1048576, output: 65536 },
    'gemini-3.1-pro': { context: 1048576, output: 65536 },
    'gemini-3.5-flash': { context: 1048576, output: 65536 },
    'deepseek-v4-flash': { context: 1000000, output: 384000 },
    'big-pickle': { context: 200000, output: 32000 },
    'deepseek-v4-flash-free': { context: 200000, output: 128000 },
    'deepseek-v4-pro': { context: 1000000, output: 384000 },
    'glm-5': { context: 204800, output: 131072 },
    'glm-5.1': { context: 204800, output: 131072 },
    'glm-5.2': { context: 1000000, output: 131072 },
    'kimi-k2.7-code': { context: 262144, output: 262144 },
    'kimi-k2.5': { context: 262144, output: 65536 },
    'kimi-k2.6': { context: 262144, output: 65536 },
    'qwen3.5-plus': { context: 262144, output: 65536 },
    'qwen3.6-plus': { context: 262144, output: 65536 },
    'qwen3.6-plus-free': { context: 262144, output: 65536 },
    'qwen3.7-max': { context: 1000000, output: 65536 },
    'qwen3.7-plus': { context: 1000000, output: 65536 },
    'grok-build-0.1': { context: 256000, output: 256000 },
    'grok-4.5': { context: 500000, output: 500000 },
    'minimax-m2.5': { context: 204800, output: 131072 },
    'minimax-m2.7': { context: 204800, output: 131072 },
    'minimax-m3': { context: 1000000, output: 128000 },
    'minimax-m3-free': { context: 200000, output: 32000 },
    'mimo-v2.5-free': { context: 200000, output: 32000 },
    'hy3-free': { context: 256000, output: 64000 },
    'nemotron-3-ultra-free': { context: 1000000, output: 128000 },
    'north-mini-code-free': { context: 256000, output: 64000 },
};

/** OpenCode Go limits from each vendor's official model documentation. */
export const OPENCODE_GO_MODEL_LIMITS: Record<string, { context: number; output: number }> = {
    'glm-5.2': { context: 1000000, output: 131072 },
    'glm-5.1': { context: 202752, output: 32768 },
    'kimi-k2.7-code': { context: 262144, output: 262144 },
    'kimi-k2.6': { context: 262144, output: 65536 },
    'mimo-v2.5': { context: 1000000, output: 128000 },
    'mimo-v2.5-pro': { context: 1048576, output: 128000 },
    'minimax-m3': { context: 1000000, output: 131072 },
    'minimax-m2.7': { context: 204800, output: 131072 },
    'qwen3.7-max': { context: 1000000, output: 65536 },
    'qwen3.7-plus': { context: 1000000, output: 65536 },
    'qwen3.6-plus': { context: 1000000, output: 65536 },
    'deepseek-v4-pro': { context: 1000000, output: 384000 },
    'deepseek-v4-flash': { context: 1000000, output: 384000 },
};

/**
 * Per-model context window sizes (tokens).
 */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
    'gpt-5.6': 1050000,
    'gpt-5.6-sol': 1050000,
    'gpt-5.6-terra': 1050000,
    'gpt-5.6-luna': 400000,
    'gpt-5.5': 1050000,
    'gpt-5.5-pro': 1050000,
    'gpt-5.5-instant': 200000,
    'gpt-5.3-instant': 128000,
    'gpt-5.4-pro': 1050000,
    'gpt-5.4': 1050000,
    'gpt-5.4-mini': 400000,
    'gpt-5.4-nano': 400000,
    'gpt-5-mini': 200000,
    'gpt-5-nano': 400000,
    'gpt-4-vision': 128000,
    'claude-fable-5': 1000000,
    'claude-sonnet-5': 1000000,
    'claude-opus-4-7': 1000000,
    'claude-opus-4-6': 1000000,
    'claude-sonnet-4-6': 1000000,
    'claude-haiku-4-5': 200000,
    'MiniMax-M3': 1000000,
    'MiniMax-M2.7': 204800,
    'MiniMax-M2.7-highspeed': 204800,
    'MiniMax-M2.5': 204800,
    'MiniMax-M2.5-highspeed': 204800,
    'MiniMax-M2.1': 204800,
    'MiniMax-M2': 196608,
    'glm-5.2': 1000000,
    'glm-5.1': 200000,
    'glm-5.1-highspeed': 200000,
    'glm-5': 200000,
    'glm-5-air': 200000,
    'glm-5-flash': 200000,
    'glm-5-turbo': 200000,
    'glm-5v': 128000,
    'glm-5v-flash': 128000,
    'glm-5v-turbo': 200000,
    'glm-4.1v-thinking': 128000,
    'glm-4.1v-thinking-flash': 128000,
    'glm-4.7': 200000,
    'glm-4.7-flash': 200000,
    'glm-4.7-flashx': 200000,
    'glm-4.6': 204800,
    'glm-4.6v': 128000,
    'glm-z1-flash': 128000,
    'glm-4-flash': 128000,
    'qwen3.7-max-2026-06-08': 1000000,
    'qwen3.7-max': 1000000,
    'qwen3.7-plus': 1000000,
    'qwen3.7-flash': 1000000,
    'qwen3.7-flash-thinking': 1000000,
    'qwen3.6-max': 1000000,
    'qwen3.6-max-preview': 1000000,
    'qwen3.6-plus': 1000000,
    'qwen3.5-plus': 1000000,
    'qwen3.6-flash': 1000000,
    'qwen3.6-27b': 262144,
    'qwen3-235b-a22b': 128000,
    'qwen3-32b': 128000,
    'gemini-3.1-pro-preview': 1048576,
    'gemini-3-flash-preview': 1048576,
    'gemini-3.1-flash-lite-preview': 1048576,
    'gemini-3.5-flash': 1048576,
    'gemini-3.5-flash-lite': 1048576,
    'gemini-3.1-pro': 2097152,
    'gemini-3.1-flash-lite': 1048576,
    'gemini-2.5-pro': 1048576,
    'gemini-2.5-flash': 1048576,
    'gemini-2.5-flash-lite': 1048576,
    'mimo-v2.5-pro': 1048576,
    'mimo-v2.5': 1048576,
    'gpt-4o': 128000,
    'gpt-4': 128000,
    'gpt-3': 16000,
    'o3': 200000,
    'o1': 200000,
    'claude-opus': 1000000,
    'claude-sonnet': 1000000,
    'claude-haiku': 200000,
    'claude-3.5': 200000,
    'claude-3': 200000,
    'DeepSeek-V3': 128000,
    'DeepSeek-V4': 1000000,
    'DeepSeek-V2': 128000,
    'DeepSeek-R1': 128000,
    'DeepSeek-Coder': 128000,
    'DeepSeek-OCR': 32000,
    'deepseek-v4-pro': 1000000,
    'deepseek-v4-flash': 1000000,
    'deepseek': 128000,
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
    'GLM-5.2': 1000000,
    'GLM-5.1': 200000,
    'GLM-5': 200000,
    'GLM-4.6': 200000,
    'GLM-4.5': 128000,
    'GLM-4.1': 128000,
    'GLM-Z1': 128000,
    'GLM-4': 128000,
    'glm': 128000,
    'kimi-for-coding': 1048576,
    'k3': 1048576,
    'kimi-k3': 1048576,
    'kimi-k2.7-code-highspeed': 262144,
    'kimi-k2.7-code': 262144,
    'kimi-k2.6': 262144,
    'kimi-k2.5': 262144,
    'Kimi-K2': 128000,
    'moonshot': 128000,
    'kimi': 128000,
    'MiniMax': 1000000,
    'minimax': 1000000,
    'mimo': 1048576,
    'Llama-3.3': 128000,
    'Llama-3.2': 128000,
    'Llama-3.1': 128000,
    'Llama-3': 128000,
    'llama': 128000,
    'yi-': 128000,
    'internlm2': 128000,
    'internlm': 32000,
    'ERNIE-4': 128000,
    'ERNIE': 32000,
    'Step-3': 128000,
    'Step-2': 128000,
    'gemini': 1048576,
    'claude-opus-4-8': 1000000,
    'grok-build-8.1': 131072,
    'qwen3.6-plus-free': 1000000,
    'qwen3.7-max-free': 1000000,
    'nemotron-3-super-free': 131072,
    'phi-4-reasoning': 16384,
    'Qwen3.7-Max': 1000000,
    'openrouter:deepseek/deepseek-v4-pro': 1048576,
    'openrouter:z-ai/glm-5.2': 1048576,
    'openrouter:moonshotai/kimi-k2.7-code': 262144,
    'openrouter:minimax/minimax-m3': 1048576,
    'openrouter:anthropic/claude-opus-4.8': 1000000,
    'openrouter:anthropic/claude-sonnet-4.6': 1000000,
    'openrouter:anthropic/claude-haiku-4.5': 200000,
    'openrouter:google/gemini-3.1-pro-preview': 1048576,
    'openrouter:google/gemini-3.5-flash': 1048576,
    'openrouter:openai/gpt-5.5': 1050000,
    'openrouter:qwen/qwen3.7-max': 1000000,
    'openrouter:qwen/qwen3.7-plus': 1000000,
    'openrouter:moonshotai/kimi-k2.6': 262144,
    'siliconflow:deepseek-ai/DeepSeek-V4-Pro': 1048576,
    'siliconflow:deepseek-ai/DeepSeek-V4-Flash': 1048576,
    'siliconflow:Pro/zai-org/GLM-5.1': 202752,
    'siliconflow:Pro/zai-org/GLM-5': 202752,
    'siliconflow:Pro/moonshotai/Kimi-K2.6': 262144,
    'siliconflow:Qwen/Qwen3.6-27B': 262144,
    'deepinfra:deepseek-ai/DeepSeek-V4-Pro': 1048576,
    'deepinfra:deepseek-ai/DeepSeek-V4-Flash': 1048576,
    'deepinfra:deepseek-ai/DeepSeek-V3.2': 163840,
    'deepinfra:Qwen/Qwen3.7-Max': 256000,
    'deepinfra:Qwen/Qwen3.6-35B-A3B': 262144,
    'deepinfra:meta-llama/Llama-3.3-70B-Instruct-Turbo': 131072,
    'together:deepseek-ai/DeepSeek-V4-Pro': 1048576,
    'together:Qwen/Qwen3.7-Max': 1000000,
    'together:meta-llama/Llama-3.3-70B-Instruct': 131072,
    ...Object.fromEntries(
        Object.entries(OPENCODE_MODEL_LIMITS).map(([model, limits]) => [`opencode:${model}`, limits.context])
    ),
    ...Object.fromEntries(
        Object.entries(OPENCODE_GO_MODEL_LIMITS).map(([model, limits]) => [`opencode-go:${model}`, limits.context])
    ),
};

/**
 * Get the context window size for a specific model.
 */
export function getModelContextTokens(model: string, providerId?: string): number {
    if (!model) return 0;
    const providerKey = providerId ? `${providerId}:${model}` : '';
    if (providerKey && providerKey in MODEL_CONTEXT_TOKENS) return MODEL_CONTEXT_TOKENS[providerKey]!;
    if (model in MODEL_CONTEXT_TOKENS) return MODEL_CONTEXT_TOKENS[model]!;
    
    const keys = Object.keys(MODEL_CONTEXT_TOKENS).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        if (providerId && !key.startsWith(`${providerId}:`)) continue;
        const modelKey = providerId && key.startsWith(`${providerId}:`) ? key.slice(providerId.length + 1) : key;
        if (model.startsWith(modelKey)) return MODEL_CONTEXT_TOKENS[key]!;
    }
    for (const key of keys) {
        if (providerId && !key.startsWith(`${providerId}:`)) continue;
        const modelKey = providerId && key.startsWith(`${providerId}:`) ? key.slice(providerId.length + 1) : key;
        if (model.includes(modelKey)) return MODEL_CONTEXT_TOKENS[key]!;
    }
    if (providerId) {
        for (const key of keys) {
            if (key.includes(':')) continue;
            if (model.startsWith(key) || model.includes(key)) return MODEL_CONTEXT_TOKENS[key]!;
        }
    }
    
    if (providerId) {
        const provider = BUILTIN_PROVIDERS[providerId];
        if (provider) return provider.maxContextTokens;
    }
    return 0;
}

/**
 * Dynamic output token limits for API calls to prevent self-truncation.
 */
export function getModelOutputTokens(model: string, providerId?: string): number {
    if (!model) return 16384;
    const lower = model.toLowerCase();
    const modelId = lower.replace(/\s*\([^)]*\)$/i, '');

    if (providerId === 'opencode') {
        return OPENCODE_MODEL_LIMITS[modelId]?.output ?? 32768;
    }

    if (providerId === 'opencode-go') {
        return OPENCODE_GO_MODEL_LIMITS[modelId]?.output ?? 32768;
    }

    if (providerId === 'openai') {
        return 128000;
    }
    if (providerId === 'deepseek') {
        return 384000;
    }
    if (providerId === 'claude' || lower.includes('claude')) {
        if (lower.includes('haiku-4-5')) return 64000;
        if (lower.includes('opus-4-5') || lower.includes('sonnet-4-5')) return 64000;
        if (lower.includes('fable-5') || lower.includes('opus-4-') || lower.includes('sonnet-5') || lower.includes('sonnet-4-6')) return 128000;
        return 16384;
    }
    if (providerId === 'minimax' || providerId === 'minimax-token-plan' || providerId?.includes('minimax') || lower.includes('minimax')) {
        if (lower.includes('minimax-m3')) return 128000;
        if (lower.includes('minimax-m2.7') || lower.includes('minimax-m2.5') || lower.includes('minimax-m2.1')) return 131072;
        if (lower.includes('minimax-m2')) return 128000;
        return 65536;
    }
    if (providerId === 'glm' || lower.includes('glm')) {
        return 128000;
    }
    if (providerId === 'qwen' || (lower.includes('qwen') && (lower.includes('3') || lower.includes('max') || lower.includes('plus')))) {
        return 65536;
    }
    if (providerId === 'mimo' || providerId === 'mimo-token-plan' || providerId?.includes('mimo') || lower.includes('mimo')) {
        return 131072;
    }
    if (providerId === 'kimi' || providerId === 'kimi-code-plan' || lower.includes('kimi') || lower.includes('moonshot')) {
        if (lower === 'k3' || lower.includes('kimi-k3') || lower.includes('kimi-for-coding')) return 131072;
        return 32768;
    }

    if (lower.includes('deepseek') && lower.includes('v4')) {
        return 384000;
    }
    if (lower.includes('deepseek') || lower.includes('r1')) {
        return 65536;
    }
    if (lower.includes('gpt-5')) {
        return 128000;
    }
    if (lower.includes('gemini')) {
        return 65536;
    }
    if (lower.includes('qwen')) {
        return 65536;
    }
    if (lower.includes('glm')) {
        return 128000;
    }

    return 32768;
}

// ─── Anthropic per-model request feature detection ──────────────────────────

/** Request-shaping features of an Anthropic (Claude) model. */
export interface AnthropicModelFeatures {
    /** Model supports `thinking: {type: 'adaptive'}` (Fable 5, Opus/Sonnet 4.6+). */
    adaptiveThinking: boolean;
    /**
     * Model supports `thinking.display` and omits thinking text by default
     * (Fable 5, Opus 4.7+) — must send `display: 'summarized'` to receive
     * non-empty thinking_delta text.
     */
    thinkingDisplay: boolean;
    /** Model supports `output_config: {effort}` (Fable 5, Opus 4.5+, Sonnet 4.6). */
    effort: boolean;
    /** `temperature`/`top_p`/`top_k` return HTTP 400 (Fable 5, Opus 4.7+). */
    samplingRemoved: boolean;
}

/**
 * Detect Anthropic request features by model ID. Tolerates provider prefixes
 * (`openrouter:anthropic/claude-opus-4.8`), dotted versions and deployment
 * suffixes (`claude-fable-5[1m]`).
 */
export function getAnthropicModelFeatures(model: string): AnthropicModelFeatures {
    const none: AnthropicModelFeatures = { adaptiveThinking: false, thinkingDisplay: false, effort: false, samplingRemoved: false };
    if (!model) return none;
    const lower = model.toLowerCase();
    if (!lower.includes('claude')) return none;

    const opusMinor = lower.match(/claude-opus-(\d+)[.-](\d+)/);
    const opusVer = opusMinor ? Number(opusMinor[1]) + Number(opusMinor[2]) / 10 : 0;
    const sonnetMinor = lower.match(/claude-sonnet-(\d+)(?:[.-](\d+))?/);
    const sonnetVer = sonnetMinor ? Number(sonnetMinor[1]) + Number(sonnetMinor[2] ?? 0) / 10 : 0;
    const isFable = lower.includes('claude-fable');

    // Sonnet 5 has adaptive thinking on by default, rejects sampling parameters,
    // and only needs output_config.effort to control depth.
    if (sonnetVer >= 5) {
        return { adaptiveThinking: false, thinkingDisplay: false, effort: true, samplingRemoved: true };
    }

    // Fable 5 / Opus 4.7+: adaptive-only thinking, display param, sampling params removed
    if (isFable || opusVer >= 4.7) {
        return { adaptiveThinking: true, thinkingDisplay: true, effort: true, samplingRemoved: true };
    }
    // Opus 4.6 / Sonnet 4.6: adaptive thinking + effort; sampling still accepted
    if (opusVer >= 4.6 || sonnetVer >= 4.6) {
        return { adaptiveThinking: true, thinkingDisplay: false, effort: true, samplingRemoved: false };
    }
    // Opus 4.5: effort only (manual extended thinking is not auto-enabled here)
    if (opusVer >= 4.5) {
        return { adaptiveThinking: false, thinkingDisplay: false, effort: true, samplingRemoved: false };
    }
    return none;
}
