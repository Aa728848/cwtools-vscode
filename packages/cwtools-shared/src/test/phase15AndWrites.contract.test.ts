import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  documentSymbolsWithHost,
  editPdxBlockWithHost,
  getCompletionAtWithHost,
  workspaceSymbolsWithHost,
  type HostServices,
} from 'cwtools-shared';

describe('phase 1.5 symbols and phase 2 write contracts', () => {
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

  it('replaces a PDX block only when writes are explicitly enabled', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-mcp-edit-'));
    try {
      const filePath = path.join(workspaceRoot, 'common', 'scripted_triggers', 'test.txt');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        'first_trigger = {',
        '  always = yes',
        '}',
        'second_trigger = {',
        '  always = no',
        '}',
        '',
      ].join('\n'), 'utf8');
      const host = createFsHost(workspaceRoot, { writesEnabled: true });
      const invalidated: string[] = [];
      host.indexing = {
        async invalidate(file) { invalidated.push(file); },
        async queryWorkspace() { return { status: 'ready', totalCount: 0, entries: [] }; },
        async queryLocalisation() { return { status: 'ready', totalCount: 0, entries: [] }; },
      };

      const result = await editPdxBlockWithHost(host, {
        file: 'common/scripted_triggers/test.txt',
        symbol: 'second_trigger',
        newContent: [
          'second_trigger = {',
          '  always = yes',
          '}',
        ].join('\n'),
      });

      expect(result.ok).to.equal(true);
      expect(fs.readFileSync(filePath, 'utf8')).to.include('second_trigger = {\n  always = yes\n}');
      expect(invalidated).to.deep.equal([filePath]);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects brace-breaking PDX block edits before writing', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-mcp-edit-deny-'));
    try {
      const filePath = path.join(workspaceRoot, 'common', 'scripted_triggers', 'test.txt');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'second_trigger = {\n  always = no\n}\n', 'utf8');
      const host = createFsHost(workspaceRoot, { writesEnabled: true });

      const result = await editPdxBlockWithHost(host, {
        file: 'common/scripted_triggers/test.txt',
        symbol: 'second_trigger',
        newContent: 'second_trigger = {\n  always = yes',
      });

      expect(result.ok).to.equal(false);
      expect(result.status).to.equal('denied');
      expect(fs.readFileSync(filePath, 'utf8')).to.equal('second_trigger = {\n  always = no\n}\n');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function createFsHost(workspaceRoot: string, options: { writesEnabled?: boolean } = {}): HostServices {
  return {
    workspaceRoot,
    readonlyMode: !options.writesEnabled,
    writesEnabled: options.writesEnabled === true,
    allowedWriteTools: new Set(['write_localisation', 'edit_pdx_block']),
    lsp: createUnavailableLspHost(),
    diagnostics: createUnavailableDiagnosticsHost(),
    filesystem: {
      async readTextFile(filePath) {
        if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
        const content = fs.readFileSync(filePath, 'utf8');
        return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
      },
      async writeTextFile(filePath, content) {
        if (!options.writesEnabled) throw new Error('unexpected write');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
      },
      async list() { return []; },
      async glob() { return []; },
    },
    now: () => Date.now(),
    log: () => undefined,
  };
}
