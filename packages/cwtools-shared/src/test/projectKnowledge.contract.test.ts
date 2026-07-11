import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  queryProjectKnowledgeWithHost,
  type HostServices,
} from 'cwtools-shared';

describe('project knowledge contract', () => {
  const tempBase = path.resolve(__dirname, '..', '..', '..', '..', '.tmp-project-knowledge');

  it('returns ranked project and vanilla evidence from the /init knowledge pack', async () => {
    const workspaceRoot = fs.mkdtempSync(`${tempBase}-`);
    try {
      const knowledgeRoot = path.join(workspaceRoot, '.cwtools-ai', 'project', 'knowledge');
      fs.mkdirSync(path.join(knowledgeRoot, 'capabilities'), { recursive: true });
      fs.writeFileSync(path.join(knowledgeRoot, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        generatedAt: '2026-01-01T00:00:00.000Z',
        game: 'stellaris',
        graphVersion: 4,
        domains: ['events'],
        staleReasons: [],
      }), 'utf8');
      fs.writeFileSync(path.join(knowledgeRoot, 'capabilities', 'events.json'), JSON.stringify({
        summary: { id: 'events', definitionCount: 2 },
        definitions: [
          { id: 'my_mod.1', entityType: 'event', origin: 'workspace', file: 'events/my_mod.txt' },
          { id: 'vanilla.1', entityType: 'event', origin: 'vanilla', file: 'events/vanilla.txt' },
        ],
        projectExamples: [{ id: 'my_mod.1', origin: 'workspace' }],
        vanillaArchetypes: [{ id: 'vanilla.1', origin: 'vanilla' }],
        topology: { edges: [{ sourceFile: 'events/my_mod.txt', targetId: 'vanilla.1' }] },
      }), 'utf8');
      fs.writeFileSync(path.join(knowledgeRoot, 'unresolved.json'), JSON.stringify({ entries: [] }), 'utf8');

      const result = await queryProjectKnowledgeWithHost(createFsHost(workspaceRoot), {
        intent: 'connect my_mod.1 to vanilla.1',
        domains: ['events'],
      });

      expect(result.ok).to.equal(true);
      expect(result.status).to.equal('ready');
      const data = result.data as Record<string, any>;
      expect(data.game).to.equal('stellaris');
      expect(data.evidence.some((item: Record<string, unknown>) => item.id === 'my_mod.1')).to.equal(true);
      expect(data.evidence.some((item: Record<string, unknown>) => item.id === 'vanilla.1')).to.equal(true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports a missing pack without falling back to guessed knowledge', async () => {
    const workspaceRoot = fs.mkdtempSync(`${tempBase}-`);
    try {
      const result = await queryProjectKnowledgeWithHost(createFsHost(workspaceRoot), {});
      expect(result.ok).to.equal(false);
      expect(result.status).to.equal('unavailable');
      expect((result.data as Record<string, unknown>).status).to.equal('missing');
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
