import type { AgentMode, AgentRuntimeDomain, ToolDefinition } from '../types';
import { TOOL_REGISTRY, type AgentToolName } from '../tools/registry';

export interface ToolSelectionRequest {
    tools?: string[];
    groups?: string[];
    reason: string;
}

export interface ToolSelectionResult {
    loaded: string[];
    alreadyLoaded: string[];
    unknown: string[];
    denied: string[];
    unavailable: string[];
}

export interface ToolDisclosureContext {
    mode: AgentMode;
    domain: AgentRuntimeDomain;
    dynamicSupported: boolean;
    loaded: Set<string>;
}

export class ToolDisclosureService {
    initialTools(tools: readonly ToolDefinition[], context: ToolDisclosureContext): ToolDefinition[] {
        if (!context.dynamicSupported) return [...tools];
        return tools.filter(tool => {
            const entry = TOOL_REGISTRY.get(tool.function.name as AgentToolName);
            return (entry ? entry.disclosure !== 'deferred' : false) || context.loaded.has(tool.function.name);
        });
    }

    select(
        request: ToolSelectionRequest,
        pool: readonly ToolDefinition[],
        context: ToolDisclosureContext,
    ): ToolSelectionResult {
        const result: ToolSelectionResult = {
            loaded: [],
            alreadyLoaded: [],
            unknown: [],
            denied: [],
            unavailable: [],
        };
        const poolByName = new Map(pool.map(tool => [tool.function.name, tool]));
        const requested = new Set(request.tools ?? []);
        for (const group of request.groups ?? []) {
            for (const entry of TOOL_REGISTRY.values()) {
                if (entry.group === group) requested.add(entry.name);
            }
            if (group === 'mcp') {
                for (const tool of pool) {
                    if (!TOOL_REGISTRY.has(tool.function.name as AgentToolName)) requested.add(tool.function.name);
                }
            }
        }
        for (const name of [...requested].sort()) {
            const entry = TOOL_REGISTRY.get(name as AgentToolName);
            if (!entry && !poolByName.has(name)) {
                result.unknown.push(name);
            } else if (!entry) {
                if (context.loaded.has(name)) result.alreadyLoaded.push(name);
                else {
                    context.loaded.add(name);
                    result.loaded.push(name);
                }
            } else if (context.loaded.has(name) || entry.disclosure !== 'deferred') {
                result.alreadyLoaded.push(name);
            } else if (context.domain === 'general' && entry.domain === 'paradox') {
                result.denied.push(name);
            } else if (!entry.allowedModes.has(context.mode)) {
                result.denied.push(name);
            } else if (!poolByName.has(name)) {
                result.unavailable.push(name);
            } else {
                context.loaded.add(name);
                result.loaded.push(name);
            }
        }
        return result;
    }
}

export const toolDisclosureService = new ToolDisclosureService();
