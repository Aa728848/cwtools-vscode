import { expect } from 'chai';
import { TOOL_DEFINITIONS as UPSTREAM_TOOL_DEFINITIONS } from '../../../../client/extension/ai/tools/definitions';
import { TOOL_REGISTRY as UPSTREAM_TOOL_REGISTRY } from '../../../../client/extension/ai/tools/registry';
import { getGeneratedMcpTools } from '../tools/mcpSchema';
import { MCP_TOOL_NAMES } from '../tools/names';

describe('MCP schema contract', () => {
  it('generates the MCP tool schemas from upstream tool definitions', () => {
    const generated = getGeneratedMcpTools();
    expect(generated.map(entry => entry.tool.name)).to.deep.equal([...MCP_TOOL_NAMES]);
    expect(generated.map(entry => entry.tool.name)).to.include.members([
      'get_completion_at',
      'document_symbols',
      'workspace_symbols',
      'query_definition',
      'query_definition_by_name',
      'query_references',
    ]);

    for (const toolName of MCP_TOOL_NAMES) {
      const upstream = UPSTREAM_TOOL_DEFINITIONS.find(definition => definition.function.name === toolName);
      const entry = generated.find(item => item.tool.name === toolName);

      expect(upstream, `missing upstream definition for ${toolName}`).to.not.equal(undefined);
      expect(entry, `missing generated definition for ${toolName}`).to.not.equal(undefined);
      expect(entry!.tool.description).to.equal(upstream!.function.description);
      expect(entry!.tool.inputSchema).to.deep.equal(upstream!.function.parameters);
    }
  });

  it('keeps generated registry metadata aligned with upstream registry', () => {
    for (const entry of getGeneratedMcpTools()) {
      const upstream = UPSTREAM_TOOL_REGISTRY.get(entry.registry.name as never);
      expect(upstream, `missing upstream registry entry for ${entry.registry.name}`).to.not.equal(undefined);
      expect(entry.registry).to.deep.equal({
        name: upstream!.name,
        isWrite: upstream!.isWrite,
        isReadOnly: upstream!.isReadOnly,
        effect: upstream!.effect,
        riskLevel: upstream!.riskLevel,
        concurrencyClass: upstream!.concurrencyClass,
      });
    }
  });
});
