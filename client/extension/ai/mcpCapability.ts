import type { AgentRuntimeDomain, MCPServerConfig } from './types';

export type MCPServerCapabilityDomain = 'paradox' | 'general' | 'both';

/**
 * Legacy servers remain Paradox-only. General Coding receives a server only
 * after the user explicitly classifies it as general or both.
 */
export function isMcpServerAllowedForDomain(
    server: Pick<MCPServerConfig, 'capabilityDomain'> | undefined,
    domain: AgentRuntimeDomain,
): boolean {
    const declared = server?.capabilityDomain ?? 'paradox';
    return declared === 'both' || declared === domain;
}
