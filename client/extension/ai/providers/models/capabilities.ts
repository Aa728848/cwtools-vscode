/**
 * CWTools AI 模块 — 模型能力判定与参数查询
 */

import { BUILTIN_PROVIDERS } from './defaults';

/**
 * Model-level vision capability map.
 */
export const VISION_CAPABLE_MODELS: Record<string, boolean> = {
    'gpt-5.5': true,
    'gpt-5.5-pro': true,
    'gpt-5.5-instant': true,
    'gpt-5.3-instant': true,
    'gpt-5.4': true,
    'gpt-5.4-mini': true,
    'gpt-5.4-nano': true,
    'gpt-5-mini': true,
    'gpt-5-nano': true,
    'gpt-4o': true,
    'gpt-4-vision': true,
    'gpt-5': true,
    'claude-opus-4-8': true,
    'claude-opus-4-7': true,
    'claude-opus-4-6': true,
    'claude-sonnet-4-6': true,
    'claude-haiku-4-5': true,
    'claude-3': true,
    'claude-4': true,
    'gemini-3.1-pro-preview': true,
    'gemini-3-flash-preview': true,
    'gemini-3.1-flash-lite-preview': true,
    'gemini-2.5-pro': true,
    'gemini-2.5-flash': true,
    'gemini-2.5-flash-lite': true,
    'gemini': true,
    'MiniMax-M2': false,
    'glm-5v-turbo': true,
    'glm-4.1v-thinking': true,
    'glm-4.1v-thinking-flash': true,
    'glm-5v': true,
    'glm-4v': true,
    'glm-4.5v': true,
    'glm-5.1': false,
    'glm-5-turbo': false,
    'glm-5': false,
    'glm-4.7': false,
    'glm-4.7-flash': false,
    'glm-z1-flash': false,
    'glm-4-flash': false,
    'qwen3.6-plus': false,
    'qwen3.5-plus': false,
    'qwen3.6-flash': false,
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
    'mimo-v2.5-pro': true,
    'mimo-v2-omni': true,
    'mimo-v2-pro': false,
    'mimo-v2.5': false,
    'mimo-v2-flash': false,
    'kimi-k2.6': true,
    'kimi-k2.5': true,
    'qwen3.7': true,
    'Qwen3.7': true
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
    'deepseek-reasoner', 'deepseek-r1', 'DeepSeek-R1',
    'o1', 'o3', 'o4-mini',
    'glm-z1', 'GLM-Z1',
    'gemini-2.5-pro', 'gemini-3.1-pro',
    'QwQ', 'qwq',
    'Thinking', 'thinking',
    'phi-4-reasoning',
];

/**
 * Per-model context window sizes (tokens).
 */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
    'gpt-5.5': 1000000,
    'gpt-5.5-pro': 1000000,
    'gpt-5.5-instant': 200000,
    'gpt-5.3-instant': 128000,
    'gpt-5.4': 1000000,
    'gpt-5.4-mini': 200000,
    'gpt-5.4-nano': 128000,
    'gpt-5-mini': 200000,
    'gpt-5-nano': 400000,
    'gpt-4-vision': 128000,
    'claude-opus-4-7': 1000000,
    'claude-opus-4-6': 1000000,
    'claude-sonnet-4-6': 1000000,
    'claude-haiku-4-5': 200000,
    'MiniMax-M2.7': 200000,
    'MiniMax-M2.7-highspeed': 200000,
    'MiniMax-M2.5': 200000,
    'MiniMax-M2.5-highspeed': 200000,
    'MiniMax-M2.1': 200000,
    'MiniMax-M2': 200000,
    'glm-5.1': 200000,
    'glm-5': 200000,
    'glm-5-turbo': 128000,
    'glm-5v-turbo': 128000,
    'glm-4.1v-thinking': 128000,
    'glm-4.1v-thinking-flash': 128000,
    'glm-4.7': 128000,
    'glm-4.7-flash': 128000,
    'glm-z1-flash': 128000,
    'glm-4-flash': 128000,
    'qwen3.6-max-preview': 1000000,
    'qwen3.6-plus': 1000000,
    'qwen3.5-plus': 1000000,
    'qwen3.6-flash': 128000,
    'qwen3-235b-a22b': 128000,
    'qwen3-32b': 128000,
    'gemini-3.1-pro-preview': 1048576,
    'gemini-3-flash-preview': 1048576,
    'gemini-3.1-flash-lite-preview': 1048576,
    'gemini-2.5-pro': 1048576,
    'gemini-2.5-flash': 1048576,
    'gemini-2.5-flash-lite': 1048576,
    'mimo-v2.5-pro': 1000000,
    'mimo-v2.5': 1000000,
    'mimo-v2-pro': 1000000,
    'mimo-v2-omni': 1000000,
    'mimo-v2-flash': 1000000,
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
    'DeepSeek-V4': 1048576,
    'DeepSeek-V2': 128000,
    'DeepSeek-R1': 128000,
    'DeepSeek-Coder': 128000,
    'DeepSeek-OCR': 32000,
    'deepseek-v4-pro': 1048576,
    'deepseek-v4-flash': 1048576,
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
    'GLM-5.1': 200000,
    'GLM-5': 200000,
    'GLM-4.6': 128000,
    'GLM-4.5': 128000,
    'GLM-4.1': 128000,
    'GLM-Z1': 128000,
    'GLM-4': 128000,
    'glm': 128000,
    'kimi-k2.6': 262144,
    'kimi-k2.5': 262144,
    'Kimi-K2': 128000,
    'moonshot': 128000,
    'kimi': 128000,
    'MiniMax': 200000,
    'minimax': 200000,
    'mimo': 1000000,
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
    'gemini-3.5-flash': 1048576,
    'gemini-3.1-pro': 2097152,
    'gemini-3.1-flash-lite': 1048576,
    'grok-build-8.1': 131072,
    'qwen3.6-plus-free': 1000000,
    'qwen3.7-max-free': 1000000,
    'nemotron-3-super-free': 131072,
    'phi-4-reasoning': 16384,
    'qwen3.7-max': 1000000,
    'Qwen3.7-Max': 1000000,
    'glm-5.1-highspeed': 200000,
};

/**
 * Get the context window size for a specific model.
 */
export function getModelContextTokens(model: string, providerId?: string): number {
    if (!model) return 0;
    if (model in MODEL_CONTEXT_TOKENS) return MODEL_CONTEXT_TOKENS[model]!;
    
    const keys = Object.keys(MODEL_CONTEXT_TOKENS).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        if (model.startsWith(key)) return MODEL_CONTEXT_TOKENS[key]!;
    }
    for (const key of keys) {
        if (model.includes(key)) return MODEL_CONTEXT_TOKENS[key]!;
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

    if (providerId === 'openai') {
        return 128000;
    }
    if (providerId === 'deepseek') {
        return 384000;
    }
    if (providerId === 'claude' || lower.includes('claude')) {
        return 16384;
    }
    if (providerId === 'minimax' || providerId === 'minimax-token-plan' || providerId?.includes('minimax') || lower.includes('minimax')) {
        return 65536;
    }
    if (providerId === 'glm' || lower.includes('glm')) {
        return 128000;
    }
    if (providerId === 'qwen' || (lower.includes('qwen') && (lower.includes('3') || lower.includes('max') || lower.includes('plus')))) {
        return 65536;
    }
    if (providerId === 'mimo' || providerId === 'mimo-token-plan' || providerId?.includes('mimo') || lower.includes('mimo')) {
        return 65536;
    }
    if (providerId === 'kimi' || lower.includes('kimi') || lower.includes('moonshot')) {
        return 16384;
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
