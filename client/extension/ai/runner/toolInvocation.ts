import { ToolInvocation, ToolEffect, ToolConcurrencyClass } from '../types';
import { tryRepairJson } from '../jsonRepair';
import { repairToolArgs } from '../tools/argRepair';
import { getAgentToolTargetFiles } from './toolScheduler';
import { TOOL_REGISTRY, AgentToolName } from '../tools/registry';
import { nestArguments } from '../tools/schemaFlatten';

/**
 * Derives metadata (effect, riskLevel, concurrencyClass) for a given tool name.
 */
export function getToolMetadata(toolName: string): {
    effect: ToolEffect;
    riskLevel: 0 | 1 | 2 | 3;
    concurrencyClass: ToolConcurrencyClass;
} {
    const name = toolName.toLowerCase();

    // 先从 TOOL_REGISTRY 单一权威事实源读取，实现零硬编码偏差
    const regEntry = TOOL_REGISTRY.get(toolName as AgentToolName) || 
                     [...TOOL_REGISTRY.values()].find(t => t.name.toLowerCase() === name);
    if (regEntry) {
        return {
            effect: regEntry.effect,
            riskLevel: regEntry.riskLevel,
            concurrencyClass: regEntry.concurrencyClass
        };
    }

    // 1. Memory tools
    if (
        name === 'todo_write' ||
        name === 'set_memory' ||
        name === 'get_memory' ||
        name === 'search_memory' ||
        name === 'query_blackboard'
    ) {
        return { effect: 'memory', riskLevel: 0, concurrencyClass: 'parallel' };
    }

    // 2. Network tools
    if (name === 'web_search' || name === 'web_open' || name === 'web_fetch' || name === 'search_web' || name === 'codesearch') {
        return { effect: 'network', riskLevel: 1, concurrencyClass: 'network-limited' };
    }
    if (name === 'web_find') return { effect: 'workspace_read', riskLevel: 0, concurrencyClass: 'parallel' };

    // 3. Command execution (shell)
    if (name === 'run_command' || name === 'dispatch_agents' || name === 'merge_results') {
        return { effect: 'shell', riskLevel: 2, concurrencyClass: 'interactive' };
    }

    // 4. Git operations
    if (name === 'git_ops') {
        return { effect: 'git', riskLevel: 2, concurrencyClass: 'global-exclusive' };
    }

    // 5. High-volume read-only LSP tools (limited concurrency to avoid flooding)
    if (
        name.startsWith('query_') ||
        name === 'document_symbols' ||
        name === 'workspace_symbols' ||
        name === 'get_diagnostics' ||
        name === 'verify_pdx_identifier'
    ) {
        return { effect: 'workspace_read', riskLevel: 0, concurrencyClass: 'lsp-limited' };
    }

    // 6. Ordinary read-only file/scan tools (safe for parallel execution)
    if (
        name === 'read_file' ||
        name === 'list_directory' ||
        name === 'glob_files' ||
        name === 'search_mod_files' ||
        name === 'grep' ||
        name === 'get_file_context' ||
        name === 'get_completion_at' ||
        name === 'find_sprite_candidates' ||
        name === 'find_sound_candidates'
    ) {
        return { effect: 'workspace_read', riskLevel: 0, concurrencyClass: 'parallel' };
    }

    // 7. Core writing tools (per-file partitioned queue)
    if (
        name === 'write_file' ||
        name === 'edit_file' ||
        name === 'replace_lines' ||
        name === 'write_localisation' ||
        name === 'write_design_blueprint'
    ) {
        return { effect: 'workspace_write', riskLevel: 2, concurrencyClass: 'per-file-write' };
    }

    // 8. Default fallback for unknown tools (fail-safe global lock + high risk)
    return { effect: 'workspace_write', riskLevel: 2, concurrencyClass: 'global-exclusive' };
}

/**
 * Builds a standardized ToolInvocation envelope from a raw LLM tool call.
 * Handles name correction, robust JSON parsing, fuzzy arg repairs, and concurrency routing.
 */
export function buildToolInvocation(input: {
    runId: string;
    toolCall: { id?: string; type?: string; function: { name: string; arguments: string } };
    availableTools: Array<{ function: { name: string } }>;
    workspaceRoot: string;
    topicId?: string;
}): ToolInvocation {
    const rawCall = input.toolCall;
    const originalName = rawCall.function.name;
    let name = originalName;

    // 1. Tool name case-insensitive correction
    const knownNames = input.availableTools.map(t => t.function.name);
    if (!knownNames.includes(name)) {
        const matched = knownNames.find(n => n.toLowerCase() === name.toLowerCase());
        if (matched) {
            name = matched;
        }
    }

    // 2. Derive concurrency metadata
    const meta = getToolMetadata(name);

    // 3. Robust JSON argument parsing & repair
    let args: Record<string, any> = {};
    let parseError: string | undefined;
    const argRepairs: string[] = [];

    const rawArgs = rawCall.function.arguments || '{}';
    try {
        args = JSON.parse(rawArgs);
    } catch (e) {
        const repaired = tryRepairJson(rawArgs);
        if (repaired !== null) {
            args = repaired;
            argRepairs.push('JSON syntax repaired');
        } else {
            parseError = `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    // 🌟 Schema Re-nest 还原管线 (T2.1)
    if (!parseError) {
        try {
            const entry = TOOL_REGISTRY.get(name as AgentToolName);
            if (entry && entry.flatSchema) {
                args = nestArguments(args);
                argRepairs.push('Nested schema reconstructed');
            }
        } catch { /* ignore */ }
    }

    // 4. Semantic fuzzy name matching & coercion
    if (!parseError) {
        try {
            const semanticResult = repairToolArgs(name as any, args);
            if (semanticResult.repaired) {
                args = semanticResult.args;
                argRepairs.push(...semanticResult.repairs);
            }
        } catch { /* ignore */ }
    }

    // 5. Extract affected target paths
    let targetPaths: string[] = [];
    if (!parseError) {
        try {
            targetPaths = getAgentToolTargetFiles(name, args, input.workspaceRoot, input.topicId);
        } catch { /* ignore */ }
    }

    const invocationId = `inv_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    return {
        invocationId,
        runId: input.runId,
        modelToolCallId: rawCall.id,
        name,
        originalName,
        rawArgs,
        args,
        argRepairs,
        parseError,
        effect: meta.effect,
        riskLevel: meta.riskLevel,
        concurrencyClass: meta.concurrencyClass,
        targetPaths
    };
}
