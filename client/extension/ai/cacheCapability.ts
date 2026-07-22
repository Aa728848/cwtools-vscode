/**
 * CWTools AI Module — Prefix-cache capability rules
 *
 * Shared between agentRunner (request path) and usageTracker (metrics path) so
 * cache hit-rate denominators use the same capability definition as the runner.
 */

import type { CacheRequestUsage, CustomApiFormat, TokenUsage } from './types';

export function supportsOpenAiStylePrefixCache(providerId: string, customApiFormat?: CustomApiFormat): boolean {
    if (providerId.startsWith('deepseek') || providerId.startsWith('openai')) return true;
    if (providerId === 'custom') {
        return customApiFormat === 'openai-chat-completions' || customApiFormat === 'openai-responses';
    }
    return false;
}

/**
 * Whether a recorded request belongs in the cache hit-rate denominator.
 * An observed cache hit proves capability even when the provider is not covered
 * by the prefix-cache rule above (e.g. Gemini `cached_content_token_count`),
 * which keeps legacy records without an explicit `cacheCapable` flag countable.
 */
export function isCacheCapableUsage(providerId: string, cachedTokens?: number, customApiFormat?: CustomApiFormat): boolean {
    if ((cachedTokens ?? 0) > 0) return true;
    const normalized = providerId.toLowerCase();
    if (supportsOpenAiStylePrefixCache(normalized, customApiFormat)) return true;
    // Native Anthropic requests carry cache_control breakpoints; native Gemini
    // reports implicit cached_content usage. Count their zero-hit warmups too.
    if (normalized === 'claude' || normalized === 'google' || normalized === 'codex-chatgpt') return true;
    if (normalized === 'custom') {
        return customApiFormat === 'anthropic-messages' || customApiFormat === 'gemini-generate-content';
    }
    return false;
}

const MAX_CACHE_REQUEST_SAMPLES = 256;
const MAX_CACHE_REQUEST_OVERFLOW_BUCKETS = 64;

function normalizedRequestCount(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 1;
    return Math.max(1, Math.floor(value));
}

function overflowKey(sample: CacheRequestUsage): string {
    return [
        sample.provider,
        sample.model,
        sample.cacheCapable ? '1' : '0',
        sample.agentMode ?? '',
        sample.toolStage ?? '',
        sample.promptFingerprint ?? '',
        sample.purpose ?? '',
        sample.invalidationReason ?? '',
    ].join('\u0000');
}

/** Append one bounded, normalized provider-call sample to a run accumulator. */
export function appendCacheRequestUsage(accumulator: TokenUsage | undefined, sample: CacheRequestUsage): void {
    if (!accumulator) return;
    const inputTokens = Number.isFinite(sample.inputTokens) ? Math.max(0, Math.floor(sample.inputTokens)) : 0;
    const cachedTokens = Number.isFinite(sample.cachedTokens)
        ? Math.min(inputTokens, Math.max(0, Math.floor(sample.cachedTokens)))
        : 0;
    const requestCount = normalizedRequestCount(sample.requestCount);
    const hitRequestCount = sample.hitRequestCount !== undefined && Number.isFinite(sample.hitRequestCount)
        ? Math.min(requestCount, Math.max(0, Math.floor(sample.hitRequestCount)))
        : cachedTokens > 0 ? requestCount : 0;
    const requests = accumulator.cacheRequests ?? [];
    const normalized: CacheRequestUsage = {
        ...sample,
        provider: sample.provider || 'unknown',
        model: sample.model || 'unknown',
        inputTokens,
        cachedTokens,
        ...(sample.requestCount !== undefined || requestCount > 1 ? { requestCount } : {}),
        ...(sample.hitRequestCount !== undefined || requestCount > 1 ? { hitRequestCount } : {}),
    };
    if (requests.length < MAX_CACHE_REQUEST_SAMPLES) {
        requests.push(normalized);
        accumulator.cacheRequests = requests;
        return;
    }

    const overflow = accumulator.cacheRequestOverflow ?? [];
    let bucket = overflow.find(item => overflowKey(item) === overflowKey(normalized));
    if (!bucket && overflow.length < MAX_CACHE_REQUEST_OVERFLOW_BUCKETS) {
        bucket = { ...normalized, inputTokens: 0, cachedTokens: 0, requestCount: 0, hitRequestCount: 0 };
        overflow.push(bucket);
    }
    if (bucket) {
        bucket.inputTokens += inputTokens;
        bucket.cachedTokens += cachedTokens;
        bucket.requestCount = (bucket.requestCount ?? 0) + requestCount;
        bucket.hitRequestCount = (bucket.hitRequestCount ?? 0) + hitRequestCount;
        accumulator.cacheRequestOverflow = overflow;
        return;
    }

    // Preserve exact global denominators and hit counts without pretending the
    // tail belongs to the final dimension bucket. At most two remainder rows
    // exist (cache-capable and non-capable); all dropped dimensions are explicit.
    const remainder = accumulator.cacheRequestRemainder ?? [];
    let remainderBucket = remainder.find(item => item.cacheCapable === normalized.cacheCapable);
    if (!remainderBucket) {
        remainderBucket = {
            provider: '__other__',
            model: '__other__',
            inputTokens: 0,
            cachedTokens: 0,
            cacheCapable: normalized.cacheCapable,
            requestCount: 0,
            hitRequestCount: 0,
            invalidationReason: 'dimension_overflow',
            dimensionsDropped: true,
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

/**
 * Merge a completed child/auxiliary run into a wider usage accumulator.
 * Request metadata stays on the individual samples; run-level mode/fingerprint
 * fields deliberately remain owned by the target run.
 */
export function mergeTokenUsageTotals(target: TokenUsage | undefined, source: TokenUsage | undefined): void {
    if (!target || !source || target === source) return;
    target.input += source.input ?? 0;
    target.output += source.output ?? 0;
    target.total += source.total ?? 0;
    target.estimatedCostCny += source.estimatedCostCny ?? 0;

    if (source.cachedTokens !== undefined) {
        target.cachedTokens = (target.cachedTokens ?? 0) + source.cachedTokens;
    }
    if (source.netInput !== undefined) {
        target.netInput = (target.netInput ?? 0) + source.netInput;
    }
    if (source.netTotal !== undefined) {
        target.netTotal = (target.netTotal ?? 0) + source.netTotal;
    }
    if (source.cacheSavedCostCny !== undefined) {
        target.cacheSavedCostCny = (target.cacheSavedCostCny ?? 0) + source.cacheSavedCostCny;
    }
    if (source.apiCalls !== undefined) {
        target.apiCalls = (target.apiCalls ?? 0) + source.apiCalls;
    }
    if (source.compactionCalls !== undefined) {
        target.compactionCalls = (target.compactionCalls ?? 0) + source.compactionCalls;
    }
    if (source.fallbackCalls !== undefined) {
        target.fallbackCalls = (target.fallbackCalls ?? 0) + source.fallbackCalls;
    }
    for (const request of source.cacheRequests ?? []) {
        appendCacheRequestUsage(target, request);
    }
    for (const request of source.cacheRequestOverflow ?? []) {
        appendCacheRequestUsage(target, request);
    }
    for (const request of source.cacheRequestRemainder ?? []) {
        appendCacheRequestUsage(target, request);
    }
}
