import { expect } from 'chai';
import {
  annotateReadiness,
  LOAD_DEPENDENT_TOOLS,
  parseReadiness,
  READINESS_LOADING_WARNING,
  type LspReadiness,
  type SharedToolResult,
} from 'cwtools-shared';

const EMPTY_OK: SharedToolResult = { ok: true, status: 'ready', source: 'test', data: { totalCount: 0 } };

describe('lsp readiness contract', () => {
  it('parses a loading game state as not ready', () => {
    const r = parseReadiness({ ok: true, loading: { inProgress: true, phase: 'vanilla_cache' } });
    expect(r.ready).to.equal(false);
    expect(r.phase).to.equal('vanilla_cache');
  });

  it('parses a completed load as ready', () => {
    const r = parseReadiness({ ok: true, loading: { inProgress: false, phase: 'loading_project' } });
    expect(r.ready).to.equal(true);
  });

  it('treats never-started and unavailable as not ready', () => {
    expect(parseReadiness({ ok: true, loading: { inProgress: false, phase: 'not_started' } }).ready).to.equal(false);
    expect(parseReadiness({ ok: false, status: 'unavailable' }).ready).to.equal(false);
  });

  it('rewrites an empty load-dependent result to loading while not ready', () => {
    const notReady: LspReadiness = { ready: false, phase: 'vanilla_cache', inProgress: true };
    const r = annotateReadiness('query_types', EMPTY_OK, notReady) as SharedToolResult & { readiness?: LspReadiness };
    expect(r.status).to.equal('loading');
    expect(r.readiness).to.deep.equal(notReady);
    expect(r.warnings).to.include(READINESS_LOADING_WARNING);
  });

  it('passes through an empty result once ready (empty means empty)', () => {
    const r = annotateReadiness('query_types', EMPTY_OK, { ready: true }) as SharedToolResult & { readiness?: LspReadiness };
    expect(r.status).to.equal('ready');
    expect(r.readiness?.ready).to.equal(true);
    expect(r.warnings ?? []).to.not.include(READINESS_LOADING_WARNING);
  });

  it('does not touch tools that do not depend on the game load', () => {
    expect(LOAD_DEPENDENT_TOOLS.has('get_pdx_block')).to.equal(false);
    const r = annotateReadiness('get_pdx_block', EMPTY_OK, { ready: false });
    expect(r).to.deep.equal(EMPTY_OK);
  });
});
