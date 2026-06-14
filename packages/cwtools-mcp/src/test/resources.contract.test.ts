import { expect } from 'chai';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  type HostServices,
} from 'cwtools-shared';
import { listResources, readResource } from '../mcp/resources';

describe('MCP resources contract', () => {
  it('lists project and knowledge resources', () => {
    const resources = listResources();
    expect(resources.map(resource => resource.uri)).to.deep.equal([
      'cwtools://knowledge/game',
      'cwtools://knowledge/diagnostic-routing',
      'cwtools://knowledge/workflow-hints',
      'cwtools://project/profile',
    ]);
  });

  it('reads workflow hints as JSON resource content', async () => {
    const result = await readResource(createHost(), 'cwtools://knowledge/workflow-hints');
    expect(result.contents[0]?.mimeType).to.equal('application/json');
    expect(result.contents[0]?.text).to.include('diagnostic-fix');
  });
});

function createHost(): HostServices {
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
