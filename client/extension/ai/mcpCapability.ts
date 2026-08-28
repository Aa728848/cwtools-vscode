import type { AgentRuntimeDomain, MCPServerConfig } from './types';

export type MCPServerCapabilityDomain = 'paradox' | 'general' | 'both';

export function isMcpServerAllowedForDomain(
    server: Pick<MCPServerConfig, 'capabilityDomain'> | undefined,
    domain: AgentRuntimeDomain,
): boolean {
    const declared = server?.capabilityDomain;
    if (!declared) return false;
    return declared === 'both' || declared === domain;
}
