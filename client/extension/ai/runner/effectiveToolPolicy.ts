import type {
    AgentMode,
    AgentRuntimeDomain,
} from '../types';
import { TOOL_REGISTRY, type AgentToolName } from '../tools/registry';
import type { RuntimeAgentProfile } from './agentProfileCatalog';

export interface EffectiveToolPolicyContext {
    mode: AgentMode;
    domain: AgentRuntimeDomain;
    isSubAgent?: boolean;
    profile?: RuntimeAgentProfile;
}

export interface EffectiveToolPolicyDecision {
    allowed: boolean;
    reason?: 'unknown' | 'domain' | 'mode' | 'profile-domain' | 'profile' | 'subagent';
}

export function matchesToolPattern(name: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (!pattern.includes('*')) return name === pattern;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Compile the static capability layers into one decision. Target/path policy,
 * approvals, workspace trust, and sandbox enforcement remain later runtime
 * gates because they depend on invocation arguments or current host state.
 */
export function evaluateEffectiveToolPolicy(
    toolName: string,
    context: EffectiveToolPolicyContext,
): EffectiveToolPolicyDecision {
    const entry = TOOL_REGISTRY.get(toolName as AgentToolName);
    if (!entry) return { allowed: false, reason: 'unknown' };

    if (context.domain === 'general' && entry.domain === 'paradox') {
        return { allowed: false, reason: 'domain' };
    }
    if (!entry.allowedModes.has(context.mode)) {
        return { allowed: false, reason: 'mode' };
    }

    const profile = context.profile;
    if (profile?.domain && profile.domain !== context.domain) {
        return { allowed: false, reason: 'profile-domain' };
    }
    if (profile) {
        const allow = profile.tools ?? ['*'];
        const deny = profile.disallowedTools ?? [];
        if (!allow.some(pattern => matchesToolPattern(toolName, pattern))
            || deny.some(pattern => matchesToolPattern(toolName, pattern))) {
            return { allowed: false, reason: 'profile' };
        }
    }

    const declaredChildCapability = entry.name === 'run_code'
        ? context.profile?.subagentCapabilities?.runCode === true
        : entry.name === 'run_command'
            ? context.profile?.subagentCapabilities?.command === true
            : false;
    if (context.isSubAgent && !entry.allowSubAgent && !declaredChildCapability) {
        return { allowed: false, reason: 'subagent' };
    }

    return { allowed: true };
}
