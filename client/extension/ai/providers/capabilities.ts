import type { CustomApiFormat } from '../types';

export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';

export interface ProviderCapabilities {
    reasoningReplay: CapabilitySupport;
    promptCaching: CapabilitySupport;
    nativeConversationState: CapabilitySupport;
    structuredOutput: CapabilitySupport;
}

const UNKNOWN_CAPABILITIES: ProviderCapabilities = {
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
): ProviderCapabilities {
    const normalizedProvider = providerId.toLowerCase();
    if (normalizedProvider === 'deepseek'
        && apiFormat === 'openai-chat-completions'
        && isOfficialDeepSeekEndpoint(endpoint)) {
        return {
            reasoningReplay: 'supported',
            promptCaching: 'supported',
            nativeConversationState: 'unsupported',
            structuredOutput: 'unknown',
        };
    }

    // Custom channels and non-official transports cannot be assumed to
    // implement any provider-native capability.
    return { ...UNKNOWN_CAPABILITIES };
}
