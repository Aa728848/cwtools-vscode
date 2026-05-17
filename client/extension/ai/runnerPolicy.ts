import type { AgentMode, ToolDefinition } from './types';
import { TOOL_REGISTRY } from './tools/registry';

export interface ToolFilterOptions {
    useSlimPrompt?: boolean;
    excludeTools?: string[];
    legacyFullToolset?: boolean;
}

export interface IterationLimitOptions {
    mode: AgentMode;
    baseContextLimit: number;
    bypassSandbox?: boolean;
    override?: number;
}

export function filterToolDefinitionsForMode(
    tools: readonly ToolDefinition[],
    mode: AgentMode,
    options: ToolFilterOptions = {},
): ToolDefinition[] {
    let filtered = tools.filter(t => {
        const entry = TOOL_REGISTRY.get(t.function.name as import('./types').AgentToolName);
        if (!entry) return false;
        
        if (options.legacyFullToolset) {
            return !['dispatch_agents', 'query_blackboard', 'merge_results'].includes(entry.name);
        }
        
        return entry.allowedModes.has(mode);
    });

    if (options.useSlimPrompt) {
        filtered = filtered.filter(t => t.function.name !== 'git_ops');
    }

    if (options.excludeTools && options.excludeTools.length > 0) {
        const excluded = new Set(options.excludeTools);
        filtered = filtered.filter(t => !excluded.has(t.function.name));
    }

    return filtered;
}

const MODE_ITERATION_LIMITS: Record<AgentMode, { min: number; base: number; cap: number }> = {
    build: { min: 20, base: 40, cap: 55 },
    plan: { min: 10, base: 18, cap: 25 },
    explore: { min: 8, base: 16, cap: 24 },
    general: { min: 8, base: 18, cap: 25 },
    utility: { min: 15, base: 30, cap: 45 },
    review: { min: 8, base: 15, cap: 22 },
    gui_expert: { min: 18, base: 30, cap: 45 },
    script_reviewer: { min: 8, base: 15, cap: 22 },
    loc_translator: { min: 10, base: 20, cap: 30 },
    loc_writer: { min: 10, base: 20, cap: 30 },
    orchestrator: { min: 8, base: 18, cap: 28 },
};

export function resolveMaxToolIterations(options: IterationLimitOptions): number {
    if (options.bypassSandbox) return 10000;
    if (options.override !== undefined && Number.isFinite(options.override)) {
        return Math.max(1, Math.min(1000, Math.floor(options.override)));
    }

    const limits = MODE_ITERATION_LIMITS[options.mode] ?? MODE_ITERATION_LIMITS.build;
    const scale = Math.max(0.8, Math.min(1.25, options.baseContextLimit / 128000));
    const scaled = Math.floor(limits.base * scale);
    return Math.min(limits.cap, Math.max(limits.min, scaled));
}
