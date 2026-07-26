import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  documentSymbolsWithHost,
  getCompletionAtWithHost,
  workspaceSymbolsWithHost,
  type HostServices,
} from 'cwtools-shared';

describe('phase 1.5 symbol contracts', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

  it('infers document symbols without reading through VS Code', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-mcp-symbols-'));
    try {
      const filePath = path.join(workspaceRoot, 'events', 'test.txt');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        'namespace = test',
        'country_event = {',
        '  id = test.1',
        '  is_triggered_only = yes',
        '}',
        '',
      ].join('\n'), 'utf8');

      const result = await documentSymbolsWithHost(createFsHost(workspaceRoot), { file: 'events/test.txt' });

      expect(result.ok).to.equal(true);
      expect(result.source).to.equal('cwtools-node-symbols');
      expect(result.data!.symbols.map(symbol => symbol.name)).to.include('test.1');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the workspace index for workspace symbol search', async () => {
    const host = createFsHost(repoRoot);
    host.indexing = {
      async queryWorkspace() {
        return {
          status: 'ready',
          totalCount: 1,
          entries: [{
            name: 'test_symbol',
            kind: 'event',
            file: 'events/test.txt',
            line: 2,
            source: 'script',
            origin: 'workspace',
          }],
        };
      },
      async queryLocalisation() {
        return { status: 'ready', totalCount: 0, entries: [] };
      },
    };

    const result = await workspaceSymbolsWithHost(host, { query: 'test_symbol' });

    expect(result.ok).to.equal(true);
    expect(result.source).to.equal('cwtools-index');
    expect(result.data!.symbols[0]!.name).to.equal('test_symbol');
  });

  it('does not promote a partial workspace index fallback to ready', async () => {
    const host = createFsHost(repoRoot);
    host.indexing = {
      async queryWorkspace() {
        return { status: 'partial', totalCount: 0, entries: [], _hint: 'file limit reached' };
      },
      async queryLocalisation() {
        return { status: 'ready', totalCount: 0, entries: [] };
      },
    };

    const result = await workspaceSymbolsWithHost(host, { query: 'possibly_missing' });

    expect(result.status).to.equal('partial');
  });

  it('returns completion context with diagnostics freshness metadata', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-mcp-completion-'));
    try {
      const filePath = path.join(workspaceRoot, 'events', 'test.txt');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'country_event = {\n  id = test.1\n}\n', 'utf8');
      const host = createFsHost(workspaceRoot);
      host.diagnostics = {
        async getDiagnostics() {
          return {
            ok: true,
            status: 'fresh',
            diagnostics: [],
            freshness: {
              value: 'fresh',
              pendingKinds: [],
              validatedVersion: 1,
              epoch: 2,
              updatedAt: 3,
            },
          };
        },
      };

      const result = await getCompletionAtWithHost(host, {
        file: 'events/test.txt',
        line: 1,
        column: 4,
      });

      expect(result.data).to.be.an('object');
      expect((result.data as { diagnosticsStatus?: string }).diagnosticsStatus).to.equal('fresh');
      expect((result.data as { freshness?: { value: string } }).freshness!.value).to.equal('fresh');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

});

function createFsHost(workspaceRoot: string): HostServices {
  return {
    workspaceRoot,
    readonlyMode: true,
    writesEnabled: false,
    lsp: createUnavailableLspHost(),
    diagnostics: createUnavailableDiagnosticsHost(),
    filesystem: {
      async readTextFile(filePath) {
        if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
        const content = fs.readFileSync(filePath, 'utf8');
        return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
      },
      async writeTextFile() { throw new Error('unexpected write'); },
      async list() { return []; },
      async glob() { return []; },
    },
    now: () => Date.now(),
    log: () => undefined,
  };
}
