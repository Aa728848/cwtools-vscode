/** Normalize provider-specific prompt-cache usage fields. */

import type { ChatCompletionResponse } from './types';

type CompletionUsage = Partial<NonNullable<ChatCompletionResponse['usage']>>;

function finiteNonNegative(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : undefined;
}

function maximumUsageValue(...values: unknown[]): number | undefined {
    const numbers = values
        .map(finiteNonNegative)
        .filter((value): value is number => value !== undefined);
    return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

/** Read cached prompt tokens from all provider response shapes supported by CWTools. */
export function getCachedInputTokens(usage: CompletionUsage | undefined): number {
    if (!usage) return 0;
    return maximumUsageValue(
        usage.input_tokens_details?.cached_tokens,
        usage.prompt_tokens_details?.cached_tokens,
        usage.prompt_cache_hit_tokens,
        usage.cached_tokens,
        usage.cache_read_input_tokens,
        usage.cached_content_token_count,
    ) ?? 0;
}

/** Read newly-created cache tokens, with a conservative OpenAI-compatible fallback. */
export function getCacheCreationInputTokens(
    usage: CompletionUsage | undefined,
    promptTokens: number,
    cachedTokens: number,
): number {
    if (!usage) return 0;
    const explicit = maximumUsageValue(
        usage.input_tokens_details?.cache_creation_tokens,
        usage.prompt_tokens_details?.cache_creation_tokens,
        usage.cache_creation_input_tokens,
        usage.prompt_cache_miss_tokens,
        usage.cache_creation_tokens,
    );
    if (explicit !== undefined) return explicit;
    return cachedTokens > 0 && promptTokens > cachedTokens ? promptTokens - cachedTokens : 0;
}
