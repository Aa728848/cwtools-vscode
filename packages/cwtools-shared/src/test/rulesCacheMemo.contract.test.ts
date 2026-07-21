import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  queryRulesWithHost,
  type HostServices,
} from 'cwtools-shared';

describe('CWT rules memoization (plan §7.4)', () => {
  it('memoizes parsed rules per host and invalidates on rule file changes', async () => {
    const workspaceRoot = fs.mkdtempSync(path.resolve(__dirname, '..', '..', '..', '..', '.tmp-rules-memo-'));
    try {
      const configDir = path.join(workspaceRoot, 'rules', 'config');
      fs.mkdirSync(configDir, { recursive: true });
      writeEffects(configDir, ['alpha_effect']);

      let readCount = 0;
      const host = createCountingFsHost(workspaceRoot, [path.join(workspaceRoot, 'rules')], () => { readCount += 1; });

      const first = await queryRulesWithHost(host, { category: 'effect' });
      expect(first.ok).to.equal(true);
      expect(first.data!.rules.map(rule => rule.name)).to.include('alpha_effect');
      expect(first.data!.rulesGeneration).to.equal(1);
      expect(first.data!.rulesContentHash).to.be.a('string').with.lengthOf(16);
      const readsAfterFirst = readCount;
      expect(readsAfterFirst).to.be.greaterThan(0);

      // Second call: memo hit — the signature check uses fs.statSync only, so
      // the host must not re-read any rule file.
      readCount = 0;
      const second = await queryRulesWithHost(host, { category: 'effect' });
      expect(second.data!.rulesGeneration).to.equal(1);
      expect(second.data!.rulesContentHash).to.equal(first.data!.rulesContentHash);
      expect(readCount).to.equal(0);

      // Rule content change (different size, so the mtime/size signature moves
      // regardless of filesystem timestamp granularity): reload + generation bump.
      writeEffects(configDir, ['alpha_effect', 'beta_effect']);
      const third = await queryRulesWithHost(host, { category: 'effect' });
      expect(third.data!.rulesGeneration).to.equal(2);
      expect(third.data!.rulesContentHash).to.not.equal(first.data!.rulesContentHash);
      expect(third.data!.rules.map(rule => rule.name)).to.include.members(['alpha_effect', 'beta_effect']);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('memoizes independently per rules source (host identity)', async () => {
    const workspaceRoot = fs.mkdtempSync(path.resolve(__dirname, '..', '..', '..', '..', '.tmp-rules-memo-'));
    try {
      const configDirA = path.join(workspaceRoot, 'rules-a', 'config');
      const configDirB = path.join(workspaceRoot, 'rules-b', 'config');
      fs.mkdirSync(configDirA, { recursive: true });
      fs.mkdirSync(configDirB, { recursive: true });
      writeEffects(configDirA, ['effect_from_a']);
      writeEffects(configDirB, ['effect_from_b']);

      const hostA = createCountingFsHost(workspaceRoot, [path.join(workspaceRoot, 'rules-a')], () => undefined);
      const hostB = createCountingFsHost(workspaceRoot, [path.join(workspaceRoot, 'rules-b')], () => undefined);

      const resultA = await queryRulesWithHost(hostA, { category: 'effect' });
      const resultB = await queryRulesWithHost(hostB, { category: 'effect' });

      expect(resultA.data!.rules.map(rule => rule.name)).to.include('effect_from_a');
      expect(resultB.data!.rules.map(rule => rule.name)).to.include('effect_from_b');
      expect(resultA.data!.rulesContentHash).to.not.equal(resultB.data!.rulesContentHash);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function writeEffects(configDir: string, names: string[]): void {
  const body = names
    .map(name => `## supported_scopes = country\nalias[effect:${name}] = {\n}\n`)
    .join('\n');
  fs.writeFileSync(path.join(configDir, 'effects.cwt'), body, 'utf8');
}

function createCountingFsHost(workspaceRoot: string, configDirs: string[], onRead: () => void): HostServices {
  return {
    workspaceRoot,
    readonlyMode: true,
    writesEnabled: false,
    rules: {
      gameId: 'stellaris',
      configDirs,
      async readTextFile(filePath) {
        onRead();
        if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
        const content = fs.readFileSync(filePath, 'utf8');
        return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
      },
    },
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
