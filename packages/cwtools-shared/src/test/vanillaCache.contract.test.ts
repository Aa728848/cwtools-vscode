import { expect } from 'chai';
import {
  annotateVanillaCache,
  VANILLA_DEPENDENT_TOOLS,
  VANILLA_UNAVAILABLE_WARNING,
  vanillaCacheFileName,
  type SharedToolResult,
  type VanillaCacheStatus,
} from 'cwtools-shared';

const READY: SharedToolResult = { ok: true, status: 'ready', source: 'test', data: { hit: 1 } };

describe('vanilla cache annotation contract', () => {
  it('maps known games to their .cwb cache file names', () => {
    expect(vanillaCacheFileName('stellaris')).to.equal('stl.cwb');
    expect(vanillaCacheFileName('imperator')).to.equal('ir.cwb');
    expect(vanillaCacheFileName('ck3')).to.equal('ck3.cwb');
    expect(vanillaCacheFileName(undefined)).to.equal('stl.cwb');
    expect(vanillaCacheFileName('not-a-game')).to.equal(undefined);
  });

  it('warns and tags provenance when vanilla data is unavailable for a dependent tool', () => {
    const status: VanillaCacheStatus = { available: false, source: 'mod_only', reason: 'none' };
    const result = annotateVanillaCache('query_types', READY, status) as SharedToolResult & {
      vanillaCache?: VanillaCacheStatus;
    };
    expect(result.vanillaCache).to.deep.equal(status);
    expect(result.warnings).to.include(VANILLA_UNAVAILABLE_WARNING);
    expect(result.ok).to.equal(true);
  });

  it('tags provenance without a warning when vanilla data is available', () => {
    const status: VanillaCacheStatus = { available: true, source: 'mod_plus_vanilla' };
    const result = annotateVanillaCache('query_scope', READY, status) as SharedToolResult & {
      vanillaCache?: VanillaCacheStatus;
    };
    expect(result.vanillaCache).to.deep.equal(status);
    expect(result.warnings ?? []).to.not.include(VANILLA_UNAVAILABLE_WARNING);
  });

  it('does not annotate tools that do not depend on vanilla data', () => {
    expect(VANILLA_DEPENDENT_TOOLS.has('query_rules')).to.equal(false);
    const status: VanillaCacheStatus = { available: false, source: 'mod_only' };
    const result = annotateVanillaCache('query_rules', READY, status) as SharedToolResult & {
      vanillaCache?: VanillaCacheStatus;
    };
    expect(result.vanillaCache).to.equal(undefined);
    expect(result).to.deep.equal(READY);
  });

  it('is a no-op when the host reports no vanilla cache status', () => {
    const result = annotateVanillaCache('query_types', READY, undefined);
    expect(result).to.deep.equal(READY);
  });
});
