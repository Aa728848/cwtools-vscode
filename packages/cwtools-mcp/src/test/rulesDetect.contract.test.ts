import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectExtensionRulesDir } from '../hosts/vscodeCache';

describe('MCP extension rules detection contract', () => {
  let tmp: string;
  // globalStorageBases() reads these; point them at an empty tree so an
  // extension actually installed on the test machine can't leak into results.
  const ENV_KEYS = ['APPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-rules-'));
    saved = {};
    const empty = path.join(tmp, '_no_global_storage');
    fs.mkdirSync(empty, { recursive: true });
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      process.env[key] = empty;
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the <game>/config dir when it holds .cwt files', () => {
    const config = path.join(tmp, 'stellaris', 'config');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'effects.cwt'), 'x');
    expect(detectExtensionRulesDir(tmp, 'stellaris')).to.equal(config);
  });

  it('falls back to the bare <game> dir when rules sit there without a config subdir', () => {
    const bare = path.join(tmp, 'hoi4');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'effects.cwt'), 'x');
    expect(detectExtensionRulesDir(tmp, 'hoi4')).to.equal(bare);
  });

  it('ignores an empty rules dir (no .cwt) so callers fall through to bundled rules', () => {
    fs.mkdirSync(path.join(tmp, 'stellaris', 'config'), { recursive: true });
    expect(detectExtensionRulesDir(tmp, 'stellaris')).to.equal(undefined);
  });

  it('defaults to stellaris when game is undefined', () => {
    const config = path.join(tmp, 'stellaris', 'config');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'effects.cwt'), 'x');
    expect(detectExtensionRulesDir(tmp, undefined)).to.equal(config);
  });
});
