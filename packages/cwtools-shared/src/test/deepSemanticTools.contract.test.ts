import { expect } from 'chai';
import {
  defaultSharedToolDispatcher,
  type HostServices,
  type LspHost,
} from 'cwtools-shared';

// A host that records the LSP command + args each tool dispatches, returning a
// ready-looking payload so the dispatcher treats it as a normal result.
function recordingHost(calls: Array<{ command: string; args: unknown[] }>): HostServices {
  const lsp: LspHost = {
    async executeCommand(command: string, args: unknown[] = []) {
      calls.push({ command, args });
      if (command === 'cwtools.ai.getValidationStatus') {
        return { ok: true, loading: { inProgress: false, phase: 'idle' } } as never;
      }
      return { ok: true, instances: [], totalCount: 0 } as never;
    },
  };
  return {
    workspaceRoot: process.cwd(),
    readonlyMode: true,
    writesEnabled: false,
    lsp,
    diagnostics: { async getDiagnostics() { return { ok: true, status: 'fresh', diagnostics: [] }; } },
    filesystem: {
      async readTextFile() { return { content: '', hasBom: false, exists: false }; },
      async writeTextFile() { throw new Error('no'); },
      async list() { return []; },
      async glob() { return []; },
    },
    now: () => Date.now(),
    log: () => undefined,
  };
}

describe('deep semantic tools routing contract', () => {
  const cases: Array<[string, Record<string, unknown>, string, unknown[]]> = [
    ['query_scripted_effects', { filter: 'create_', limit: 10 }, 'cwtools.ai.queryScriptedEffects', ['create_', 10]],
    ['query_scripted_triggers', { filter: 'has_' }, 'cwtools.ai.queryScriptedTriggers', ['has_', 50]],
    ['query_enums', { enumName: 'anomaly_category' }, 'cwtools.ai.queryEnums', ['anomaly_category', 500]],
    ['query_static_modifiers', { filter: 'planet_' }, 'cwtools.ai.queryStaticModifiers', ['planet_', 300]],
    ['query_variables', { filter: '@base' }, 'cwtools.ai.queryVariables', ['@base']],
    ['parse_pdx_fragment', { code: 'every_owned_ship = { limit = { always = yes } }' }, 'cwtools.ai.parseFragment', ['every_owned_ship = { limit = { always = yes } }']],
  ];

  for (const [tool, args, command, expectedArgs] of cases) {
    it(`${tool} routes to ${command}`, async () => {
      const calls: Array<{ command: string; args: unknown[] }> = [];
      await defaultSharedToolDispatcher(recordingHost(calls), tool, args);
      const hit = calls.find(c => c.command === command);
      expect(hit, `expected a call to ${command}`).to.not.equal(undefined);
      expect(hit!.args).to.deep.equal(expectedArgs);
    });
  }

  it('get_entity_info routes to cwtools.ai.getEntityInfo with a file URI', async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(calls), 'get_entity_info', { file: 'common/traits/x.txt' });
    const hit = calls.find(c => c.command === 'cwtools.ai.getEntityInfo');
    expect(hit).to.not.equal(undefined);
    expect(String(hit!.args[0])).to.match(/^file:\/\/\//);
  });
});
