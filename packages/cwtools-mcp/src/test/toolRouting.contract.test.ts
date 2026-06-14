import { expect } from 'chai';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  type HostServices,
  type SharedToolDispatcher,
} from 'cwtools-shared';
import { createToolCallHandler, toMcpCallToolResult } from '../mcp/toolHandlers';

describe('MCP tool routing contract', () => {
  it('passes tool name and arguments to the shared dispatcher', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const dispatcher: SharedToolDispatcher = async (_host, name, args) => {
      calls.push({ name, args });
      return {
        ok: true,
        status: 'ready',
        source: 'test',
        data: { routed: true },
      };
    };
    const handler = createToolCallHandler(createTestHost(), dispatcher);

    const result = await handler('query_scope', { file: 'events/test.txt', line: 0, column: 1 });

    expect(result.ok).to.equal(true);
    expect(calls).to.deep.equal([
      { name: 'query_scope', args: { file: 'events/test.txt', line: 0, column: 1 } },
    ]);
  });

  it('formats stable JSON text results for MCP callTool responses', () => {
    const response = toMcpCallToolResult({
      ok: false,
      status: 'unavailable',
      source: 'test',
      error: { code: 'lsp_unavailable', message: 'No LSP' },
    });

    expect(response.isError).to.equal(true);
    expect(response.content[0]?.type).to.equal('text');
    expect(response.content[0]?.text).to.include('"code": "lsp_unavailable"');
  });
});

function createTestHost(): HostServices {
  return {
    workspaceRoot: process.cwd(),
    readonlyMode: true,
    writesEnabled: false,
    lsp: createUnavailableLspHost(),
    diagnostics: createUnavailableDiagnosticsHost(),
    filesystem: {
      async readTextFile() { return { content: '', hasBom: false, exists: false }; },
      async writeTextFile() { throw new Error('unexpected write'); },
      async list() { return []; },
      async glob() { return []; },
    },
    now: () => Date.now(),
    log: () => undefined,
  };
}
