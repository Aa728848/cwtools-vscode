import type { CustomApiFormat } from '../types';

export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';

export interface ProviderCapabilities {
    prefixContinuation: CapabilitySupport;
    reasoningReplay: CapabilitySupport;
    promptCaching: CapabilitySupport;
    nativeConversationState: CapabilitySupport;
    structuredOutput: CapabilitySupport;
}

export interface ResolvedProviderCapabilities extends ProviderCapabilities {
    /** Provider-owned endpoint used only for the supported continuation protocol. */
    prefixContinuationEndpoint?: string;
}

const UNKNOWN_CAPABILITIES: ProviderCapabilities = {
    prefixContinuation: 'unknown',
    reasoningReplay: 'unknown',
    promptCaching: 'unknown',
    nativeConversationState: 'unknown',
    structuredOutput: 'unknown',
};

function isOfficialDeepSeekEndpoint(endpoint: string): boolean {
    try {
        const url = new URL(endpoint);
        return url.protocol === 'https:' && url.hostname.toLowerCase() === 'api.deepseek.com';
    } catch {
        return false;
    }
}

/**
 * Resolve transport capabilities from the effective adapter and endpoint.
 * Provider ids alone are deliberately insufficient: a compatible relay may
 * implement a different subset of the upstream protocol.
 */
export function resolveProviderCapabilities(
    providerId: string,
    endpoint: string,
    apiFormat: CustomApiFormat,
): ResolvedProviderCapabilities {
    const normalizedProvider = providerId.toLowerCase();
    if (normalizedProvider === 'deepseek'
        && apiFormat === 'openai-chat-completions'
        && isOfficialDeepSeekEndpoint(endpoint)) {
        return {
            prefixContinuation: 'supported',
            reasoningReplay: 'supported',
            promptCaching: 'supported',
            nativeConversationState: 'unsupported',
            structuredOutput: 'unknown',
            prefixContinuationEndpoint: 'https://api.deepseek.com/beta',
        };
    }

    if (normalizedProvider === 'custom' || !isOfficialDeepSeekEndpoint(endpoint)) {
        return { ...UNKNOWN_CAPABILITIES };
    }

    return {
        ...UNKNOWN_CAPABILITIES,
        prefixContinuation: 'unsupported',
    };
}

