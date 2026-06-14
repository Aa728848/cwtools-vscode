import { expect } from 'chai';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  VANILLA_UNAVAILABLE_WARNING,
  type HostServices,
  type SharedToolDispatcher,
  type VanillaCacheStatus,
} from 'cwtools-shared';
import { parseCliArgs } from '../config';
import { createToolCallHandler } from '../mcp/toolHandlers';

describe('MCP vanilla cache contract', () => {
  it('parses --game-path and --cache (space and = forms)', () => {
    const a = parseCliArgs(['--workspace', '.', '--game-path', '/games/stellaris', '--cache', '/store/.cwtools']);
    expect(a.gamePath).to.match(/stellaris$/);
    expect(a.cachePath).to.match(/\.cwtools$/);

    const b = parseCliArgs(['--workspace=.', '--game-path=/games/stellaris', '--cache=/store/.cwtools']);
    expect(b.gamePath).to.match(/stellaris$/);
    expect(b.cachePath).to.match(/\.cwtools$/);
  });

  it('annotates vanilla-dependent results with the host cache status and a warning when mod-only', async () => {
    const status: VanillaCacheStatus = { available: false, source: 'mod_only', reason: 'no cache' };
    const dispatcher: SharedToolDispatcher = async () => ({ ok: true, status: 'ready', source: 'test', data: {} });
    const handler = createToolCallHandler(createTestHost(status), dispatcher);

    const result = await handler('query_types', { typeName: 'building' }) as { vanillaCache?: VanillaCacheStatus; warnings?: string[] };
    expect(result.vanillaCache).to.deep.equal(status);
    expect(result.warnings).to.include(VANILLA_UNAVAILABLE_WARNING);
  });

  it('leaves vanilla-independent tools untouched', async () => {
    const status: VanillaCacheStatus = { available: false, source: 'mod_only' };
    const dispatcher: SharedToolDispatcher = async () => ({ ok: true, status: 'ready', source: 'test', data: {} });
    const handler = createToolCallHandler(createTestHost(status), dispatcher);

    const result = await handler('query_rules', { category: 'trigger' }) as { vanillaCache?: VanillaCacheStatus };
    expect(result.vanillaCache).to.equal(undefined);
  });
});

function createTestHost(vanillaCache: VanillaCacheStatus): HostServices {
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
    vanillaCache,
    now: () => Date.now(),
    log: () => undefined,
  };
}
