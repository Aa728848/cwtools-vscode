import { expect } from 'chai';
import { MCP_TOOL_NAMES } from 'cwtools-shared';
import { listRegisteredTools } from '../mcp/toolRegistrar';

describe('MCP tools/list contract', () => {
  it('returns the generated MCP tool schemas', () => {
    const tools = listRegisteredTools();
    expect(tools.map(tool => tool.name)).to.deep.equal([...MCP_TOOL_NAMES]);
    expect(tools.map(tool => tool.name)).to.include.members([
      'get_completion_at',
      'document_symbols',
      'workspace_symbols',
      'query_definition',
      'query_definition_by_name',
      'query_references',
    ]);
    for (const tool of tools) {
      expect(tool.description).to.be.a('string').and.not.equal('');
      expect(tool.inputSchema).to.be.an('object');
    }
  });
});
