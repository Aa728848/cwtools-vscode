/**
 * CWTools AI Module — Runner Fallback Policy
 * 
 * Handles API failure detection (5xx, timeouts, network issues, capacity limits)
 * and determines provider fallback routing chains.
 */

import type { ChatMessage, ChatCompletionResponse, AgentStep, ToolDefinition } from '../types';
import type { AIService } from '../aiService';

export const PROVIDER_FALLBACK: Record<string, { providerId: string; model: string }[]> = {
    // If the primary provider fails, try these in order:
    openai:     [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    deepseek:   [{ providerId: 'minimax-token-plan',  model: 'MiniMax-M3' }],
    claude:     [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    qwen:       [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    glm:        [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    google:     [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
    minimax:    [{ providerId: 'deepseek', model: 'deepseek-v4-flash' }],
};

export function isFallbackEligibleApiError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /\b(5\d{2})\b/.test(msg) ||          // 5xx server errors
           /timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(msg) ||  // Network failures
           /overloaded|capacity|unavailable/i.test(msg); // Capacity issues
}

export async function executeFallbackRetry(
    aiService: AIService,
    messages: ChatMessage[],
    originalProviderId: string,
    options?: { tools?: ToolDefinition[]; model?: string },
    emitStep?: (step: AgentStep) => void
): Promise<ChatCompletionResponse | null> {
    const fallbacks = PROVIDER_FALLBACK[originalProviderId];
    if (!fallbacks || fallbacks.length === 0) return null;

    for (const fb of fallbacks) {
        try {
            emitStep?.({
                type: 'compaction',
                content: `Provider fallback: ${originalProviderId} → ${fb.providerId} (${fb.model})`,
                timestamp: Date.now(),
            });
            const response = await aiService.chatCompletion(messages, {
                tools: options?.tools,
                providerId: fb.providerId,
                model: fb.model,
            });
            (response as any).__providerId = fb.providerId;
            return response;
        } catch {
            // This fallback also failed — try the next one
            continue;
        }
    }
    return null;
}
