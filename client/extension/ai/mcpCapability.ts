import type { AgentRuntimeDomain, MCPServerConfig } from './types';

export type MCPServerCapabilityDomain = 'paradox' | 'general' | 'both';

export function isMcpServerAllowedForDomain(
    server: Pick<MCPServerConfig, 'capabilityDomain'> | undefined,
    _domain: AgentRuntimeDomain = 'paradox',
): boolean {
    const declared = server?.capabilityDomain;
    if (!declared) return false;
    return declared === 'both' || declared === 'paradox';
}
