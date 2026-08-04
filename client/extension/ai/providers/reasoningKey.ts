/**
 * Reasoning-content field detection for OpenAI-compatible providers.
 *
 * Most OpenAI-compatible reasoners expose thinking content under
 * `reasoning_content` (DeepSeek, GLM, Qwen...), but gateways and relays may
 * return it under a different field name. A hardcoded field name breaks the
 * next relay that deviates; detecting the key from the first observed
 * response makes new endpoints work without per-provider code changes.
 */

export const KNOWN_REASONING_KEYS = [
    'reasoning_content',
    'reasoning',
    'reasoning_text',
    'thinking',
] as const;

export type ReasoningKey = (typeof KNOWN_REASONING_KEYS)[number];

export const DEFAULT_REASONING_KEY: ReasoningKey = 'reasoning_content';

export function isReasoningKey(value: unknown): value is ReasoningKey {
    return typeof value === 'string' && (KNOWN_REASONING_KEYS as readonly string[]).includes(value);
}

/**
 * Return the first known reasoning key present on the message with a non-empty
 * string value, or undefined when the message carries no thinking content.
 */
export function detectReasoningKey(message: Record<string, unknown>): ReasoningKey | undefined {
    for (const key of KNOWN_REASONING_KEYS) {
        const value = message[key];
        if (typeof value === 'string' && value.trim().length > 0) return key;
    }
    return undefined;
}

/**
 * Read reasoning text from a message, honouring an explicit key when given
 * (e.g. a user-configured gateway field) and falling back to detection.
 */
export function reasoningValue(message: Record<string, unknown>, explicitKey?: string): string | undefined {
    const resolved = explicitKey || detectReasoningKey(message);
    if (!resolved) return undefined;
    const value = message[resolved];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
