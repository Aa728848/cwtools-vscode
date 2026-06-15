import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DiagnosticsQueryResult } from 'cwtools-shared';
import { applyDiagnosticIgnoreList, readIgnoredDiagnostics, resolveLocalisationLanguages } from '../hosts/projectSettings';

function tmpWorkspace(settings?: string): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-ws-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(ws, '.vscode'));
    fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), settings, 'utf8');
  }
  return ws;
}

function diag(message: string): DiagnosticsQueryResult['diagnostics'][number] {
  return { severity: 'error', message };
}

describe('MCP diagnostic ignore whitelist contract', () => {
  it('reads the flat dotted key from JSONC with comments and trailing commas', () => {
    const ws = tmpWorkspace(`{
      // diagnostics this project intentionally ignores
      "cwtools.ai.ignoredDiagnostics": ["CW274", "unused localisation",],
      "editor.tabSize": 4
    }`);
    expect(readIgnoredDiagnostics(ws)).to.deep.equal(['CW274', 'unused localisation']);
  });

  it('reads the nested object form', () => {
    const ws = tmpWorkspace(JSON.stringify({ 'cwtools.ai': { ignoredDiagnostics: ['nested-key'] } }));
    expect(readIgnoredDiagnostics(ws)).to.deep.equal(['nested-key']);
  });

  it('returns [] when no settings file or key is present', () => {
    expect(readIgnoredDiagnostics(tmpWorkspace())).to.deep.equal([]);
    expect(readIgnoredDiagnostics(tmpWorkspace('{ "editor.tabSize": 2 }'))).to.deep.equal([]);
  });

  it('filters diagnostics by substring and records suppressedCount', () => {
    const result: DiagnosticsQueryResult = {
      ok: true,
      status: 'fresh',
      totalCount: 3,
      diagnostics: [
        diag('CW274 inline_script could not be expanded'),
        diag('CW123 real problem'),
        diag('unused localisation key FOO'),
      ],
    };
    const filtered = applyDiagnosticIgnoreList(result, ['CW274', 'unused localisation']);
    expect(filtered.diagnostics.map(d => d.message)).to.deep.equal(['CW123 real problem']);
    expect(filtered.suppressedCount).to.equal(2);
    expect(filtered.totalCount).to.equal(1);
  });

  it('leaves the result untouched when nothing matches or the list is empty', () => {
    const result: DiagnosticsQueryResult = { ok: true, status: 'fresh', diagnostics: [diag('CW123')] };
    expect(applyDiagnosticIgnoreList(result, [])).to.equal(result);
    expect(applyDiagnosticIgnoreList(result, ['nope'])).to.equal(result);
  });
});

describe('MCP localisation language contract', () => {
  function locFile(ws: string, tag: string): void {
    const dir = path.join(ws, 'localisation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `mymod_l_${tag}.yml`), `l_${tag}:\n`);
  }

  it('uses the explicit cwtools.localisation.languages setting', () => {
    const ws = tmpWorkspace(JSON.stringify({ 'cwtools.localisation.languages': ['Chinese'] }));
    const r = resolveLocalisationLanguages(ws);
    expect(r.languages).to.deep.equal(['Chinese']);
    expect(r.source).to.equal('settings');
  });

  it('auto-detects the dominant language from localisation file names when unset', () => {
    const ws = tmpWorkspace();
    locFile(ws, 'simp_chinese');
    locFile(ws, 'simp_chinese'); // second file via different name
    fs.writeFileSync(path.join(ws, 'localisation', 'b_l_simp_chinese.yml'), 'l_simp_chinese:\n');
    fs.writeFileSync(path.join(ws, 'localisation', 'a_l_english.yml'), 'l_english:\n');
    const r = resolveLocalisationLanguages(ws);
    expect(r.languages).to.deep.equal(['Chinese']);
    expect(r.source).to.equal('detected');
  });

  it('defaults to English when there is no setting and no localisation files', () => {
    const r = resolveLocalisationLanguages(tmpWorkspace());
    expect(r.languages).to.deep.equal(['English']);
    expect(r.source).to.equal('default');
  });

  it('does not override English-dominant projects via detection', () => {
    const ws = tmpWorkspace();
    locFile(ws, 'english');
    const r = resolveLocalisationLanguages(ws);
    expect(r.languages).to.deep.equal(['English']);
    expect(r.source).to.equal('default');
  });
});
