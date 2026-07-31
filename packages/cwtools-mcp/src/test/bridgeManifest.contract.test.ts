import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectExtensionBridgeManifestPath } from '../hosts/vscodeCache';

describe('MCP bridge manifest detection contract', () => {
  let tmp: string;
  // globalStorageBases() reads these; point them at an empty tree so an
  // extension actually installed on the test machine can't leak into results.
  const ENV_KEYS = ['APPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-manifest-'));
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

  it('finds the manifest the extension writes under host globalStorage', () => {
    const manifestDir = path.join(globalStorageRoot('Code'), 'foreverskywalker.foreverskywalker-stellaris-cwtools', 'mcp');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifest = path.join(manifestDir, 'bridge-manifest.json');
    fs.writeFileSync(manifest, '{}');
    expect(detectExtensionBridgeManifestPath()).to.equal(manifest);
  });

  it('finds the manifest in non-Code hosts (e.g. Cursor)', () => {
    const manifestDir = path.join(globalStorageRoot('Cursor'), 'foreverskywalker.foreverskywalker-stellaris-cwtools', 'mcp');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifest = path.join(manifestDir, 'bridge-manifest.json');
    fs.writeFileSync(manifest, '{}');
    expect(detectExtensionBridgeManifestPath()).to.equal(manifest);
  });

  it('returns undefined when no host globalStorage holds a manifest', () => {
    expect(detectExtensionBridgeManifestPath()).to.equal(undefined);
  });
});

function globalStorageRoot(app: string): string {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, app, 'User', 'globalStorage');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', app, 'User', 'globalStorage');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(xdg, app, 'User', 'globalStorage');
}
