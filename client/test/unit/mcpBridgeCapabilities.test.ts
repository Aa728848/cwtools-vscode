import { expect } from 'chai';
import {
    bridgeResourceDenied,
    bridgeToolDenied,
    filterBridgeResources,
    filterBridgeTools,
} from '../../extension/ai/mcpBridgeCapabilities';
import type { WorkspaceProjectDetection, WorkspaceProjectKind } from '../../extension/workspaceGameDetection';

function project(kind: WorkspaceProjectKind): WorkspaceProjectDetection {
    return { kind, strength: kind === 'unsupported' || kind === 'ambiguous' ? 'none' : 'strong', evidence: [], reason: kind };
}

describe('MCP bridge project capabilities', () => {
    it('rejects cached tool calls for unsupported and ambiguous projects', () => {
        expect(bridgeToolDenied(project('unsupported'), 'query_types')?.code).to.equal('project_not_supported');
        expect(bridgeToolDenied(project('ambiguous'), 'query_types')?.code).to.equal('project_ambiguous');
    });

    it('allows only the seven CWT-capable tools and rejects cached full-game calls', () => {
        const tools = ['get_diagnostics', 'analyze_diagnostic_error', 'get_completion_at', 'document_symbols', 'workspace_symbols', 'go_to_definition', 'find_references'];
        expect(filterBridgeTools([...tools, 'query_types'], project('cwt-only'))).to.deep.equal(tools);
        expect(bridgeToolDenied(project('cwt-only'), 'get_diagnostics')).to.equal(undefined);
        expect(bridgeToolDenied(project('cwt-only'), 'query_types')?.code).to.equal('tool_not_available_in_cwt_only');
    });

    it('filters resources and maps cached resource denials', () => {
        const resources = [
            { uri: 'cwtools://knowledge/diagnostic-routing' },
            { uri: 'cwtools://knowledge/game' },
        ];
        expect(filterBridgeResources(resources, project('unsupported'))).to.deep.equal([]);
        expect(filterBridgeResources(resources, project('cwt-only'))).to.deep.equal([resources[0]]);
        expect(bridgeResourceDenied(project('cwt-only'), 'cwtools://knowledge/game')?.code)
            .to.equal('resource_not_available_in_cwt_only');
    });
});
