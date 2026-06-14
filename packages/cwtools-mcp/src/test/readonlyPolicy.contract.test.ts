import { expect } from 'chai';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  isMcpToolName,
  MCP_TOOL_NAMES,
  type HostServices,
} from 'cwtools-shared';
import { createToolCallHandler } from '../mcp/toolHandlers';

describe('MCP read-only surface contract', () => {
  it('does not register any write tool', () => {
    expect(isMcpToolName('write_localisation')).to.equal(false);
    expect(isMcpToolName('edit_pdx_block')).to.equal(false);
    expect((MCP_TOOL_NAMES as readonly string[])).to.not.include('write_localisation');
    expect((MCP_TOOL_NAMES as readonly string[])).to.not.include('edit_pdx_block');
  });

  it('rejects write_localisation as not available (read-only server)', async () => {
    const result = await createToolCallHandler(createTestHost())('write_localisation', {
      filePath: 'localisation/english/test_l_english.yml',
      entries: [{ key: 'blocked', value: 'Blocked' }],
    });
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('denied');
    expect(result.error?.code).to.equal('tool_not_available');
  });

  it('rejects edit_pdx_block as not available (read-only server)', async () => {
    const result = await createToolCallHandler(createTestHost())('edit_pdx_block', {
      file: 'events/test.txt',
      symbol: 'test.1',
      newContent: 'country_event = { id = test.1 }',
    });
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('denied');
    expect(result.error?.code).to.equal('tool_not_available');
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
