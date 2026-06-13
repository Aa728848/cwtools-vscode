/**
 * CWTools AI Module — Tool Execution Permissions
 *
 * Centralizes permission checks, mode validation, and sandbox/sub-agent boundary logic.
 */

import { TOOL_REGISTRY, WRITE_TOOLS, SUB_AGENT_EXCLUDES } from './registry';
import type { AgentMode, AgentToolName } from '../types';

/**
 * Check if a tool is allowed under the current Agent operation mode.
 */
export function isToolAllowedForMode(toolName: string, mode: AgentMode): boolean {
    const entry = TOOL_REGISTRY.get(toolName as AgentToolName);
    if (!entry) return false;
    return entry.allowedModes.has(mode);
}

/**
 * Check if a tool is marked as a write (mutating) operation.
 */
export function isToolWritable(toolName: string): boolean {
    return WRITE_TOOLS.has(toolName);
}

/**
 * Check if a tool is permitted to be invoked inside sub-agents (Orchestrator context).
 */
export function isToolAllowedForSubAgent(toolName: string): boolean {
    return !SUB_AGENT_EXCLUDES.has(toolName);
}

export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
    if (toolName === 'mcp_call') return undefined;
    const match = /^mcp_(.+?)_(.+)$/.exec(toolName);
    if (!match || !match[1] || !match[2]) return undefined;
    return { server: match[1], tool: match[2] };
}

export function validateToolAccess(
    toolName: string,
    options: {
        mode: AgentMode;
        isSubAgent?: boolean;
    }
): { allowed: boolean; reason?: string } {
    let entry = TOOL_REGISTRY.get(toolName as AgentToolName);
    let governedByMcpCall = false;
    if (!entry && parseMcpToolName(toolName)) {
        entry = TOOL_REGISTRY.get('mcp_call');
        governedByMcpCall = true;
    }
    if (!entry) {
        return { allowed: false, reason: `Unknown tool: ${toolName}` };
    }

    // 1. Mode check
    if (!entry.allowedModes.has(options.mode)) {
        const governedNote = governedByMcpCall
            ? ' Dynamic MCP tools follow the mcp_call policy.'
            : '';
        return {
            allowed: false,
            reason: `Tool '${toolName}' is not allowed in current mode '${options.mode}'.${governedNote} Allowed modes: ${[...entry.allowedModes].sort().join(', ')}.`
        };
    }

    // 2. Sub-agent sandbox check
    if (options.isSubAgent && !entry.allowSubAgent) {
        return {
            allowed: false,
            reason: `Tool '${toolName}' is disabled in sub-agent sandbox context to enforce safety bounds.`
        };
    }

    return { allowed: true };
}

export type McpPermissionAction = 'allow' | 'ask' | 'deny';

export interface McpPermissionDecision {
    allowed: boolean;
    action: McpPermissionAction;
    matchedPattern?: string;
    reason?: string;
}

/** Convert a simple `*` glob into an anchored RegExp. Identifiers only — no path semantics. */
function mcpGlobToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '.*' : `\\${ch}`));
    return new RegExp(`^${escaped}$`);
}

/** Unknown/invalid actions fall back to 'ask' (fail closed, never silently 'allow'). */
function normalizeMcpAction(value: unknown): McpPermissionAction {
    return value === 'allow' || value === 'deny' ? value : 'ask';
}

interface MatchedMcpRule {
    pattern: string;
    action: McpPermissionAction;
    wildcards: number;
}

/** More specific wins: fewer wildcards, then longer pattern; on full tie deny > ask > allow. */
function isMoreSpecificMcpRule(a: MatchedMcpRule, b: MatchedMcpRule): boolean {
    if (a.wildcards !== b.wildcards) return a.wildcards < b.wildcards;
    if (a.pattern.length !== b.pattern.length) return a.pattern.length > b.pattern.length;
    const severity: Record<McpPermissionAction, number> = { deny: 2, ask: 1, allow: 0 };
    return severity[a.action] > severity[b.action];
}

export function evaluateMcpPermission(
    server: string,
    tool: string,
    options: { isSubAgent?: boolean; rules?: Record<string, string> }
): McpPermissionDecision {
    const id = `${server}_${tool}`;
    const settingHint = `"cwtools.ai.permissions": { "mcp": { "${id}": "allow" } }`;

    let matched: MatchedMcpRule | undefined;
    for (const [pattern, rawAction] of Object.entries(options.rules ?? {})) {
        if (!mcpGlobToRegExp(pattern).test(id)) continue;
        const candidate: MatchedMcpRule = {
            pattern,
            action: normalizeMcpAction(rawAction),
            wildcards: (pattern.match(/\*/g) ?? []).length,
        };
        if (!matched || isMoreSpecificMcpRule(candidate, matched)) {
            matched = candidate;
        }
    }

    if (options.isSubAgent) {
        if (matched?.action === 'allow') {
            return { allowed: true, action: 'allow', matchedPattern: matched.pattern };
        }
        const why = matched
            ? `permission pattern '${matched.pattern}' resolves to '${matched.action}'`
            : 'no allow rule matches it';
        return {
            allowed: false,
            action: matched?.action ?? 'deny',
            matchedPattern: matched?.pattern,
            reason: `MCP tool '${server}/${tool}' is denied for orchestrator sub-agents by default (${why}). Report what you need back to the main agent instead, or the user can grant it via ${settingHint}.`,
        };
    }

    if (!matched || matched.action === 'allow') {
        return { allowed: true, action: 'allow', matchedPattern: matched?.pattern };
    }
    if (matched.action === 'deny') {
        return {
            allowed: false,
            action: 'deny',
            matchedPattern: matched.pattern,
            reason: `MCP tool '${server}/${tool}' is denied by permission pattern '${matched.pattern}'. Do not retry this tool; if the call is required, the user must change the rule in cwtools.ai.permissions.mcp.`,
        };
    }
    // 'ask': interactive MCP approval is not implemented yet — fail closed with guidance.
    return {
        allowed: false,
        action: 'ask',
        matchedPattern: matched.pattern,
        reason: `MCP tool '${server}/${tool}' matches permission pattern '${matched.pattern}' which requires approval, and interactive MCP approval is not implemented yet. Failing closed; the user can permit it via ${settingHint}.`,
    };
}
