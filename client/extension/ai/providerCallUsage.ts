/**
 * Normalize one completed provider request into the same usage shape used by
 * full agent runs. Auxiliary calls (routing, approval review, title generation)
 * bypass AgentRunner's reasoning loop, so they must be accounted explicitly.
 */

import type { CacheRequestUsage, ChatCompletionResponse, ChatMessage, CustomApiFormat, TokenUsage } from './types';
import { contentToString } from './types';
import { appendCacheRequestUsage, isCacheCapableUsage } from './cacheCapability';
import { getCacheDiscountFactor, getCurrentModelPricing } from './pricing';
import { getCachedInputTokens } from './providerUsage';

export interface ProviderCallUsageOptions {
    providerId: string;
    requestedModel?: string;
    customApiFormat?: CustomApiFormat;
    endpoint?: string;
    agentMode: string;
    purpose: NonNullable<CacheRequestUsage['purpose']>;
    toolStage?: CacheRequestUsage['toolStage'];
    promptFingerprint?: string;
}

function finiteNonNegative(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : undefined;
}

function estimateMessageTokens(message: ChatMessage): number {
    const parts = [contentToString(message.content)];
    if (message.tool_calls?.length) parts.push(JSON.stringify(message.tool_calls));
    if (message.responses_output_items?.length) parts.push(JSON.stringify(message.responses_output_items));
    if (message.anthropic_thinking_blocks?.length) {
        parts.push(JSON.stringify(message.anthropic_thinking_blocks));
    } else if (message.reasoning_content) {
        parts.push(message.reasoning_content);
    }
    return Math.ceil(parts.join('\n').length / 4) + 4;
}

export function buildProviderCallTokenUsage(
    response: ChatCompletionResponse,
    messages: ChatMessage[],
    options: ProviderCallUsageOptions,
): { usage: TokenUsage; providerId: string; model: string; cacheCapable: boolean } {
    const providerId = (response as ChatCompletionResponse & { __providerId?: string }).__providerId
        ?? options.providerId
        ?? 'unknown';
    const model = response.model || options.requestedModel || 'unknown';
    const promptTokens = finiteNonNegative(response.usage?.prompt_tokens)
        ?? messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const completionText = response.choices[0]?.message
        ? contentToString(response.choices[0].message.content)
        : '';
    const completionTokens = finiteNonNegative(response.usage?.completion_tokens)
        ?? Math.ceil(completionText.length / 4);
    const totalTokens = finiteNonNegative(response.usage?.total_tokens)
        ?? promptTokens + completionTokens;
    const cachedTokens = Math.min(promptTokens, getCachedInputTokens(response.usage));
    const netInput = Math.max(0, promptTokens - cachedTokens);
    const pricing = getCurrentModelPricing(model, providerId);
    const cacheDiscount = getCacheDiscountFactor(model, providerId);
    const estimatedCostCny = (cachedTokens / 1_000_000) * pricing[0] * cacheDiscount
        + (netInput / 1_000_000) * pricing[0]
        + (completionTokens / 1_000_000) * pricing[1];
    const cacheSavedCostCny = (cachedTokens / 1_000_000) * pricing[0] * (1 - cacheDiscount);
    const cacheCapable = isCacheCapableUsage(
        providerId, cachedTokens, options.customApiFormat, model, options.endpoint,
    );
    const usage: TokenUsage = {
        input: promptTokens,
        output: completionTokens,
        total: totalTokens,
        estimatedCostCny,
        cachedTokens,
        netInput,
        netTotal: netInput + completionTokens,
        cacheSavedCostCny,
        apiCalls: 1,
        agentMode: options.agentMode,
        promptFingerprint: options.promptFingerprint,
    };
    appendCacheRequestUsage(usage, {
        provider: providerId,
        model,
        inputTokens: promptTokens,
        cachedTokens,
        cacheCapable,
        agentMode: options.agentMode,
        toolStage: options.toolStage,
        promptFingerprint: options.promptFingerprint,
        purpose: options.purpose,
        invalidationReason: cacheCapable && cachedTokens === 0 ? 'provider_miss' : undefined,
    });
    return { usage, providerId, model, cacheCapable };
}
