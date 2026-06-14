import { expect } from 'chai';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  type HostServices,
} from 'cwtools-shared';
import { createToolCallHandler } from '../mcp/toolHandlers';

describe('MCP readonly policy contract', () => {
  it('fails closed for write_localisation in default read-only mode', async () => {
    const host = createTestHost({ readonlyMode: true, writesEnabled: false });
    const callTool = createToolCallHandler(host);

    const result = await callTool('write_localisation', {
      filePath: 'localisation/english/test_l_english.yml',
      language: 'l_english',
      entries: [{ key: 'blocked', value: 'Blocked' }],
    });

    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('denied');
    expect(result.error?.code).to.equal('read_only');
  });

  it('fails closed for edit_pdx_block in default read-only mode', async () => {
    const host = createTestHost({ readonlyMode: true, writesEnabled: false });
    const callTool = createToolCallHandler(host);

    const result = await callTool('edit_pdx_block', {
      file: 'events/test.txt',
      symbol: 'test.1',
      newContent: 'country_event = { id = test.1 }',
    });

    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('denied');
    expect(result.error?.code).to.equal('read_only');
  });
});

function createTestHost(options: { readonlyMode: boolean; writesEnabled: boolean }): HostServices {
  return {
    workspaceRoot: process.cwd(),
    readonlyMode: options.readonlyMode,
    writesEnabled: options.writesEnabled,
    allowedWriteTools: new Set(['write_localisation', 'edit_pdx_block']),
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
