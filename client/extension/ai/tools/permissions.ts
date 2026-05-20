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

/**
 * Validate comprehensive access rights for a tool call.
 * Returns structured allowed flag with friendly error reason if blocked.
 */
export function validateToolAccess(
    toolName: string,
    options: {
        mode: AgentMode;
        isSubAgent?: boolean;
    }
): { allowed: boolean; reason?: string } {
    const entry = TOOL_REGISTRY.get(toolName as AgentToolName);
    if (!entry) {
        return { allowed: false, reason: `Unknown tool: ${toolName}` };
    }

    // 1. Mode check
    if (!entry.allowedModes.has(options.mode)) {
        return {
            allowed: false,
            reason: `Tool '${toolName}' is not allowed in current mode '${options.mode}'.`
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
