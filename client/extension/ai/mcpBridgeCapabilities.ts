import { TOOL_REGISTRY } from './tools/registry';
import type { WorkspaceProjectDetection } from '../workspaceGameDetection';

const CWT_ONLY_TOOLS = new Set<string>([...TOOL_REGISTRY.values()]
    .filter(entry => entry.mcpSupportsCwtOnly)
    .map(entry => entry.name));

export interface BridgeCapabilityError {
    code: 'project_not_supported' | 'project_ambiguous' | 'tool_not_available_in_cwt_only' | 'resource_not_available_in_cwt_only';
    message: string;
    nextSteps?: string[];
}

export function bridgeToolDenied(project: WorkspaceProjectDetection, name: string): BridgeCapabilityError | undefined {
    const projectError = bridgeProjectDenied(project);
    if (projectError) return projectError;
    if (project.kind === 'cwt-only' && !CWT_ONLY_TOOLS.has(name)) {
        return {
            code: 'tool_not_available_in_cwt_only',
            message: `Tool '${name}' requires a full Paradox game model and is not available in a CWT-only workspace.`,
        };
    }
    return undefined;
}

export function bridgeResourceDenied(project: WorkspaceProjectDetection, uri: string): BridgeCapabilityError | undefined {
    const projectError = bridgeProjectDenied(project);
    if (projectError) return projectError;
    if (project.kind === 'cwt-only' && uri !== 'cwtools://knowledge/diagnostic-routing') {
        return { code: 'resource_not_available_in_cwt_only', message: project.reason };
    }
    return undefined;
}

export function filterBridgeTools<T extends string>(names: readonly T[], project: WorkspaceProjectDetection): T[] {
    if (bridgeProjectDenied(project)) return [];
    return names.filter(name => project.kind !== 'cwt-only' || CWT_ONLY_TOOLS.has(name));
}

export function filterBridgeResources<T extends { uri: string }>(resources: readonly T[], project: WorkspaceProjectDetection): T[] {
    return resources.filter(resource => !bridgeResourceDenied(project, resource.uri));
}

function bridgeProjectDenied(project: WorkspaceProjectDetection): BridgeCapabilityError | undefined {
    if (project.kind !== 'unsupported' && project.kind !== 'ambiguous') return undefined;
    return {
        code: project.kind === 'ambiguous' ? 'project_ambiguous' : 'project_not_supported',
        message: project.reason,
        nextSteps: project.kind === 'ambiguous'
            ? ['Open the intended project directly or configure the MCP client with an unambiguous workspace root.']
            : ['Open a Paradox mod or CWT rules workspace.'],
    };
}
