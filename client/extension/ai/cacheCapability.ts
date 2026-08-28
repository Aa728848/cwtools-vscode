/** Shared provider/model cache capability and bounded usage samples. */

import type { CacheRequestUsage, CustomApiFormat, TokenUsage } from './types';

export type CacheCapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type CacheRequestMode = 'implicit-prefix' | 'openai-prompt-cache-key' | 'anthropic-breakpoints' | 'gemini-implicit' | 'none';

export interface EffectiveCacheCapability {
    status: CacheCapabilityStatus;
    requestMode: CacheRequestMode;
    supportsUsageTrailer: boolean;
}

const OFFICIAL_OPENAI_PREFIX_PROVIDERS = new Set([
    'deepseek', 'qwen', 'glm', 'mimo', 'mimo-token-plan', 'kimi', 'kimi-code-plan', 'minimax',
]);
const ANTHROPIC_BREAKPOINT_PROVIDERS = new Set(['claude', 'minimax-token-plan']);
const GATEWAY_PROVIDERS = new Set([
    'openrouter', 'siliconflow', 'github', 'together', 'deepinfra', 'opencode', 'opencode-go',
]);

function normalizedEndpointHost(endpoint?: string): string {
    if (!endpoint) return '';
    try { return new URL(endpoint).hostname.toLowerCase(); } catch { return endpoint.toLowerCase(); }
}

function officialTransportOrUnspecified(host: string, expected: RegExp): boolean {
    return host.length === 0 || expected.test(host);
}

function modelImpliesPrefixCache(model?: string): boolean {
    const normalized = model?.toLowerCase() ?? '';
    return /deepseek|qwen|glm|mimo|kimi|moonshot|minimax|claude|gemini|gpt-[45]|o[134]-/.test(normalized);
}

/** One authoritative cache decision for request construction, metrics, and budgets. */
export function resolveEffectiveCacheCapability(options: {
    providerId: string;
    model?: string;
    endpoint?: string;
    apiFormat?: CustomApiFormat;
}): EffectiveCacheCapability {
    const provider = options.providerId.toLowerCase();
    const host = normalizedEndpointHost(options.endpoint);
    const format = options.apiFormat;

    if (provider === 'ollama') return { status: 'unknown', requestMode: 'none', supportsUsageTrailer: false };
    if (provider === 'codex-chatgpt') return { status: 'supported', requestMode: 'openai-prompt-cache-key', supportsUsageTrailer: true };
    if (provider === 'openai') {
        const official = officialTransportOrUnspecified(host, /(^|\.)api\.openai\.com$/);
        return { status: official ? 'supported' : 'unknown', requestMode: 'openai-prompt-cache-key', supportsUsageTrailer: official };
    }
    if (provider === 'google') {
        const official = officialTransportOrUnspecified(host, /(^|\.)generativelanguage\.googleapis\.com$/);
        return { status: official ? 'supported' : 'unknown', requestMode: 'gemini-implicit', supportsUsageTrailer: false };
    }
    if (provider === 'claude') {
        const official = officialTransportOrUnspecified(host, /(^|\.)api\.anthropic\.com$/);
        return { status: official ? 'supported' : 'unknown', requestMode: 'anthropic-breakpoints', supportsUsageTrailer: false };
    }
    if (provider === 'minimax-token-plan') {
        const official = officialTransportOrUnspecified(host, /(^|\.)api\.minimaxi\.com$/);
        return { status: official ? 'supported' : 'unknown', requestMode: 'anthropic-breakpoints', supportsUsageTrailer: false };
    }
    if (OFFICIAL_OPENAI_PREFIX_PROVIDERS.has(provider)) {
        const hostPatterns: Record<string, RegExp> = {
            deepseek: /(^|\.)api\.deepseek\.com$/, qwen: /(^|\.)dashscope\.aliyuncs\.com$/,
            glm: /(^|\.)open\.bigmodel\.cn$/, mimo: /(^|\.)api\.xiaomimimo\.com$/,
            'mimo-token-plan': /(^|\.)token-plan-cn\.xiaomimimo\.com$/,
            kimi: /(^|\.)api\.moonshot\.cn$/, 'kimi-code-plan': /(^|\.)api\.kimi\.com$/,
            minimax: /(^|\.)api\.minimaxi\.com$/,
        };
        const official = officialTransportOrUnspecified(host, hostPatterns[provider] ?? /$a/);
        return { status: official ? 'supported' : 'unknown', requestMode: 'implicit-prefix', supportsUsageTrailer: official };
    }
    if (provider === 'custom') {
        if (format === 'openai-responses') return { status: 'unknown', requestMode: 'openai-prompt-cache-key', supportsUsageTrailer: false };
        if (format === 'openai-chat-completions') return { status: 'unknown', requestMode: 'implicit-prefix', supportsUsageTrailer: false };
        if (format === 'anthropic-messages') return { status: 'unknown', requestMode: 'anthropic-breakpoints', supportsUsageTrailer: false };
        if (format === 'gemini-generate-content') return { status: 'unknown', requestMode: 'gemini-implicit', supportsUsageTrailer: false };
        return { status: 'unknown', requestMode: 'none', supportsUsageTrailer: false };
    }
    if (GATEWAY_PROVIDERS.has(provider)) {
        const supported = modelImpliesPrefixCache(options.model);
        const anthropic = /claude/.test(options.model?.toLowerCase() ?? '') && format === 'anthropic-messages';
        return {
            status: supported ? 'supported' : 'unknown',
            requestMode: anthropic ? 'anthropic-breakpoints' : supported ? 'implicit-prefix' : 'none',
            supportsUsageTrailer: format === 'openai-chat-completions',
        };
    }
    // Endpoint hints improve official aliases without turning arbitrary relays into assumed support.
    if (/deepseek|dashscope|bigmodel|moonshot|kimi|minimaxi|xiaomimimo/.test(host)) {
        return { status: 'supported', requestMode: 'implicit-prefix', supportsUsageTrailer: true };
    }
    return { status: 'unknown', requestMode: 'none', supportsUsageTrailer: false };
}

/** Boolean helper for stable-prefix prompt construction. */
export function supportsOpenAiStylePrefixCache(
    providerId: string,
    customApiFormat?: CustomApiFormat,
    model?: string,
    endpoint?: string,
): boolean {
    const capability = resolveEffectiveCacheCapability({ providerId, model, endpoint, apiFormat: customApiFormat });
    return capability.status === 'supported'
        && (capability.requestMode === 'implicit-prefix' || capability.requestMode === 'openai-prompt-cache-key');
}

export function isCacheCapableUsage(
    providerId: string,
    cachedTokens?: number,
    customApiFormat?: CustomApiFormat,
    model?: string,
    endpoint?: string,
): boolean {
    if ((cachedTokens ?? 0) > 0) return true;
    return resolveEffectiveCacheCapability({ providerId, model, endpoint, apiFormat: customApiFormat }).status === 'supported';
}

const MAX_CACHE_REQUEST_SAMPLES = 256;
const MAX_CACHE_REQUEST_OVERFLOW_BUCKETS = 64;

function normalizedRequestCount(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 1;
    return Math.max(1, Math.floor(value));
}

function overflowKey(sample: CacheRequestUsage): string {
    return [sample.provider, sample.model, sample.cacheCapable ? '1' : '0', sample.agentMode ?? '',
        sample.toolFocus ?? '', sample.promptFingerprint ?? '', sample.purpose ?? '', sample.invalidationReason ?? ''].join('\u0000');
}

export function appendCacheRequestUsage(accumulator: TokenUsage | undefined, sample: CacheRequestUsage): void {
    if (!accumulator) return;
    const inputTokens = Number.isFinite(sample.inputTokens) ? Math.max(0, Math.floor(sample.inputTokens)) : 0;
    const cachedTokens = Number.isFinite(sample.cachedTokens)
        ? Math.min(inputTokens, Math.max(0, Math.floor(sample.cachedTokens))) : 0;
    const requestCount = normalizedRequestCount(sample.requestCount);
    const hitRequestCount = sample.hitRequestCount !== undefined && Number.isFinite(sample.hitRequestCount)
        ? Math.min(requestCount, Math.max(0, Math.floor(sample.hitRequestCount)))
        : cachedTokens > 0 ? requestCount : 0;
    const normalized: CacheRequestUsage = { ...sample, provider: sample.provider || 'unknown', model: sample.model || 'unknown',
        inputTokens, cachedTokens, ...(sample.requestCount !== undefined || requestCount > 1 ? { requestCount } : {}),
        ...(sample.hitRequestCount !== undefined || requestCount > 1 ? { hitRequestCount } : {}) };
    const requests = accumulator.cacheRequests ?? [];
    if (requests.length < MAX_CACHE_REQUEST_SAMPLES) { requests.push(normalized); accumulator.cacheRequests = requests; return; }
    const overflow = accumulator.cacheRequestOverflow ?? [];
    let bucket = overflow.find(item => overflowKey(item) === overflowKey(normalized));
    if (!bucket && overflow.length < MAX_CACHE_REQUEST_OVERFLOW_BUCKETS) {
        bucket = { ...normalized, inputTokens: 0, cachedTokens: 0, requestCount: 0, hitRequestCount: 0 }; overflow.push(bucket);
    }
    if (bucket) {
        bucket.inputTokens += inputTokens;
        bucket.cachedTokens += cachedTokens;
        bucket.requestCount = (bucket.requestCount ?? 0) + requestCount;
        bucket.hitRequestCount = (bucket.hitRequestCount ?? 0) + hitRequestCount;
        accumulator.cacheRequestOverflow = overflow;
        return;
    }
    const remainder = accumulator.cacheRequestRemainder ?? [];
    let remainderBucket = remainder.find(item => item.cacheCapable === normalized.cacheCapable);
    if (!remainderBucket) {
        remainderBucket = {
            provider: '__other__', model: '__other__', inputTokens: 0, cachedTokens: 0,
            cacheCapable: normalized.cacheCapable, requestCount: 0, hitRequestCount: 0,
            invalidationReason: 'dimension_overflow', dimensionsDropped: true,
        };
        remainder.push(remainderBucket);
    }
    remainderBucket.inputTokens += inputTokens;
    remainderBucket.cachedTokens += cachedTokens;
    remainderBucket.requestCount = (remainderBucket.requestCount ?? 0) + requestCount;
    remainderBucket.hitRequestCount = (remainderBucket.hitRequestCount ?? 0) + hitRequestCount;
    accumulator.cacheRequestOverflow = overflow;
    accumulator.cacheRequestRemainder = remainder;
}

export function mergeTokenUsageTotals(target: TokenUsage | undefined, source: TokenUsage | undefined): void {
    if (!target || !source || target === source) return;
    target.input += source.input ?? 0;
    target.output += source.output ?? 0;
    target.total += source.total ?? 0;
    target.estimatedCostCny += source.estimatedCostCny ?? 0;
    if (source.cachedTokens !== undefined) target.cachedTokens = (target.cachedTokens ?? 0) + source.cachedTokens;
    if (source.netInput !== undefined) target.netInput = (target.netInput ?? 0) + source.netInput;
    if (source.netTotal !== undefined) target.netTotal = (target.netTotal ?? 0) + source.netTotal;
    if (source.cacheSavedCostCny !== undefined) target.cacheSavedCostCny = (target.cacheSavedCostCny ?? 0) + source.cacheSavedCostCny;
    if (source.apiCalls !== undefined) target.apiCalls = (target.apiCalls ?? 0) + source.apiCalls;
    if (source.compactionCalls !== undefined) target.compactionCalls = (target.compactionCalls ?? 0) + source.compactionCalls;
    if (source.fallbackCalls !== undefined) target.fallbackCalls = (target.fallbackCalls ?? 0) + source.fallbackCalls;
    for (const request of source.cacheRequests ?? []) appendCacheRequestUsage(target, request);
    for (const request of source.cacheRequestOverflow ?? []) appendCacheRequestUsage(target, request);
    for (const request of source.cacheRequestRemainder ?? []) appendCacheRequestUsage(target, request);
}
