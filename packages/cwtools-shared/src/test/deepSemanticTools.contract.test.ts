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

  it('explore_pdx_project routes bounded graph options to cwtools.ai.exploreProject', async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(calls), 'explore_pdx_project', {
      query: 'my_chain.10',
      file: 'events/my_chain.txt',
      typeName: 'event',
      exact: true,
      depth: 2,
      maxNodes: 24,
      maxEdges: 60,
      includeMetadata: false,
    });
    const hit = calls.find(c => c.command === 'cwtools.ai.exploreProject');
    expect(hit).to.not.equal(undefined);
    expect(String(hit!.args[1])).to.match(/^file:\/\/\//);
    expect(hit!.args.slice(0, 1)).to.deep.equal(['my_chain.10']);
    expect(hit!.args.slice(2)).to.deep.equal(['event', true, 2, 24, 60, false]);
  });

  it('query_shader_symbol routes a single record to cwtools.ai.shader.symbols', async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(calls), 'query_shader_symbol', {
      filter: 'pdx',
      kind: 'effect',
      limit: 50,
      cursor: 100,
    });
    const hit = calls.find(c => c.command === 'cwtools.ai.shader.symbols');
    expect(hit).to.not.equal(undefined);
    expect(hit!.args).to.deep.equal([{ filter: 'pdx', kind: 'effect', limit: 50, cursor: 100 }]);
  });

  it('query_shader_compile_unit routes a file URI record to cwtools.ai.shader.compileUnit', async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(calls), 'query_shader_compile_unit', { file: 'gfx/FX/test.shader' });
    const hit = calls.find(c => c.command === 'cwtools.ai.shader.compileUnit');
    expect(hit).to.not.equal(undefined);
    const record = hit!.args[0] as Record<string, unknown>;
    expect(String(record.uri)).to.match(/^file:\/\/\//);
    expect(String(record.uri)).to.include('gfx/FX/test.shader');
  });

  it('query_shader_platform_variants routes a file URI record to cwtools.ai.shader.variants', async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(calls), 'query_shader_platform_variants', { file: 'gfx/FX/test.shader' });
    const hit = calls.find(c => c.command === 'cwtools.ai.shader.variants');
    expect(hit).to.not.equal(undefined);
    expect(String((hit!.args[0] as Record<string, unknown>).uri)).to.include('gfx/FX/test.shader');
  });

  it('query_shader_callers routes effectName and limit to cwtools.ai.shader.callers', async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(calls), 'query_shader_callers', { effectName: 'my_effect', limit: 10 });
    const hit = calls.find(c => c.command === 'cwtools.ai.shader.callers');
    expect(hit).to.not.equal(undefined);
    expect(hit!.args).to.deep.equal([{ effectName: 'my_effect', limit: 10 }]);
  });

  it('explain_shader_reachability routes effectName or file forms to cwtools.ai.shader.reachability', async () => {
    const byName: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(byName), 'explain_shader_reachability', { effectName: 'my_effect' });
    expect(byName.find(c => c.command === 'cwtools.ai.shader.reachability')!.args).to.deep.equal([{ effectName: 'my_effect' }]);

    const byFile: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(byFile), 'explain_shader_reachability', { file: 'gfx/FX/test.shader', limit: 25 });
    const hit = byFile.find(c => c.command === 'cwtools.ai.shader.reachability');
    expect(hit).to.not.equal(undefined);
    const record = hit!.args[0] as Record<string, unknown>;
    expect(String(record.uri)).to.include('gfx/FX/test.shader');
    expect(record.limit).to.equal(25);
  });

  it('validate_shader routes a file URI record to cwtools.ai.shader.validate', async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(calls), 'validate_shader', { file: 'gfx/FX/test.fxh' });
    const hit = calls.find(c => c.command === 'cwtools.ai.shader.validate');
    expect(hit).to.not.equal(undefined);
    expect(String((hit!.args[0] as Record<string, unknown>).uri)).to.include('gfx/FX/test.fxh');
  });

  it('compare_shader_with_vanilla routes effectName or file forms to cwtools.ai.shader.compareVanilla', async () => {
    const byName: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(byName), 'compare_shader_with_vanilla', { effectName: 'my_effect' });
    expect(byName.find(c => c.command === 'cwtools.ai.shader.compareVanilla')!.args).to.deep.equal([{ effectName: 'my_effect' }]);

    const byFile: Array<{ command: string; args: unknown[] }> = [];
    await defaultSharedToolDispatcher(recordingHost(byFile), 'compare_shader_with_vanilla', { file: 'gfx/FX/test.shader' });
    const hit = byFile.find(c => c.command === 'cwtools.ai.shader.compareVanilla');
    expect(hit).to.not.equal(undefined);
    expect(String((hit!.args[0] as Record<string, unknown>).uri)).to.include('gfx/FX/test.shader');
  });
});
