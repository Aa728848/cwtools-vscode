import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectProjectSupport } from '../hosts/projectDetect';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cwt-det-${prefix}-`));
}

describe('MCP project detection contract', () => {
  it('detects a mod at the workspace root via a content dir', () => {
    const ws = tmp('root');
    fs.mkdirSync(path.join(ws, 'common'));
    const r = detectProjectSupport(ws);
    expect(r.supported).to.equal(true);
    expect(r.matchedAt).to.equal(ws);
  });

  it('detects a mod root above the workspace (cwd is a subfolder)', () => {
    const root = tmp('anc');
    fs.writeFileSync(path.join(root, 'descriptor.mod'), '');
    const sub = path.join(root, 'common', 'buildings');
    fs.mkdirSync(sub, { recursive: true });
    const r = detectProjectSupport(sub);
    expect(r.supported).to.equal(true);
    expect(r.matchedAt).to.equal(root);
  });

  it('detects a mod in an immediate subfolder (cwd is a parent)', () => {
    const parent = tmp('child');
    fs.mkdirSync(path.join(parent, 'MyMod', '.cwtools-ai'), { recursive: true });
    const r = detectProjectSupport(parent);
    expect(r.supported).to.equal(true);
    expect(r.matchedAt).to.equal(path.join(parent, 'MyMod'));
  });

  it('does not flag an unrelated project', () => {
    const ws = tmp('plain');
    fs.writeFileSync(path.join(ws, 'index.js'), '');
    expect(detectProjectSupport(ws).supported).to.equal(false);
  });

  it('does not treat a generic content dir in a far ancestor as a mod', () => {
    // A bare gfx/ or interface/ must not match; only strong root markers count above cwd.
    const root = tmp('weak');
    fs.mkdirSync(path.join(root, 'gfx'));
    const deep = path.join(root, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    expect(detectProjectSupport(deep).supported).to.equal(false);
  });
});
