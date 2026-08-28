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
    const regEntry = TOOL_REGISTRY.get(toolName as AgentToolName)
        ?? [...TOOL_REGISTRY.values()].find(entry => entry.name.toLowerCase() === toolName.toLowerCase());
    if (regEntry) {
        return {
            effect: regEntry.effect,
            riskLevel: regEntry.riskLevel,
            concurrencyClass: regEntry.concurrencyClass
        };
    }
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

    if (!parseError) {
        const entry = TOOL_REGISTRY.get(name as AgentToolName);
        if (entry?.flatSchema) {
            args = nestArguments(args);
            argRepairs.push('Nested schema reconstructed');
        }
    }

    if (!parseError) {
        const semanticResult = repairToolArgs(name as AgentToolName, args);
        if (semanticResult.repaired) {
            args = semanticResult.args;
            argRepairs.push(...semanticResult.repairs);
        }
    }

    const targetPaths = parseError
        ? []
        : getAgentToolTargetFiles(name, args, input.workspaceRoot, input.topicId);

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
