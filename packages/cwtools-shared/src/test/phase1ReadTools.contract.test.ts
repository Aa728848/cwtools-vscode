import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  getPdxBlockWithHost,
  queryRulesWithHost,
  type HostServices,
} from '../index';

describe('phase 1 read tool contracts', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

  it('queries CWT trigger/effect rules from the configured rules source', async () => {
    const host = createFsHost(repoRoot);
    const result = await queryRulesWithHost(host, {
      category: 'trigger',
    });

    expect(result.ok).to.equal(true);
    expect(result.source).to.equal('cwtools-node-rules');
    expect(result.data!.rules.length).to.be.greaterThan(0);
    expect(result.data!.warnings?.[0]).to.include('Phase 1 fallback');
  });

  it('extracts a complete PDX block by top-level symbol without leaving the workspace', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-pdx-block-'));
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

      const result = await getPdxBlockWithHost(createFsHost(workspaceRoot), {
        file: 'common/scripted_triggers/test.txt',
        symbol: 'second_trigger',
      });

      expect(result.ok).to.equal(true);
      expect(result.data!.content).to.equal('second_trigger = {\n  always = no\n}');
      expect(result.data!.startLine).to.equal(4);
      expect(result.data!.endLine).to.equal(6);
      expect(result.data!.source).to.equal('cwtools-node-block');
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
