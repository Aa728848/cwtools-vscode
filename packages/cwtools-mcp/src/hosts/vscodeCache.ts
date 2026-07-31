import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { vanillaCacheFileName } from 'cwtools-shared';

// VS Code-compatible hosts store the extension's built vanilla cache + extracted
// rules under globalStorage. In standalone mode, when the user doesn't pass
// --cache, reuse that dir so the MCP rides on a cache the extension already built.
const PRIMARY_EXTENSION_ID = 'ForeverSkywalker.foreverskywalker-stellaris-cwtools';
const PRIMARY_EXTENSION_DIR = PRIMARY_EXTENSION_ID.toLowerCase();
const VSCODE_APP_DIRS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Antigravity'];

function globalStorageBases(): string[] {
  const home = os.homedir();
  const platform = os.platform();
  return VSCODE_APP_DIRS.map(app => {
    if (platform === 'win32') {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appData, app, 'User', 'globalStorage');
    }
    if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', app, 'User', 'globalStorage');
    }
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
    return path.join(xdg, app, 'User', 'globalStorage');
  });
}

// The extension's `.cwtools` dir if it holds the built <game>.cwb, else undefined.
export function detectExtensionCacheDir(game: string | undefined): string | undefined {
  const cacheFile = vanillaCacheFileName(game);
  if (!cacheFile) return undefined;
  for (const base of globalStorageBases()) {
    const dir = path.join(base, PRIMARY_EXTENSION_DIR, '.cwtools');
    if (fs.existsSync(path.join(dir, cacheFile))) return dir;
  }
  return undefined;
}

// Installed-extension roots (`~/.vscode/extensions` and variants), where the
// packaged CWTools server binary lives — so the MCP rides on the same server the
// user already installed, with no dev checkout required.
function extensionInstallRoots(): string[] {
  const home = os.homedir();
  return ['.vscode', '.vscode-insiders', '.vscode-oss', '.cursor', '.vscode-server', '.antigravity'].map(d =>
    path.join(home, d, 'extensions'),
  );
}

// Newest installed main extension dir, else undefined.
export function detectInstalledExtensionDir(): string | undefined {
  let best: { dir: string; version: string } | undefined;
  for (const root of extensionInstallRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.toLowerCase().startsWith(`${PRIMARY_EXTENSION_DIR}-`)) continue;
      const version = name.slice(PRIMARY_EXTENSION_DIR.length + 1);
      // String compare is enough to pick the highest semver-ish folder name.
      if (!best || version > best.version) {
        best = { dir: path.join(root, name), version };
      }
    }
  }
  return best?.dir;
}

// The packaged server binary inside the installed extension, else undefined.
export function detectExtensionServerPath(): string | undefined {
  const ext = detectInstalledExtensionDir();
  if (!ext) return undefined;
  const platform = os.platform();
  const exe = platform === 'win32'
    ? path.join('win-x64', 'CWTools Server.exe')
    : platform === 'darwin'
      ? path.join('osx-x64', 'CWTools Server')
      : path.join('linux-x64', 'CWTools Server');
  const candidate = path.join(ext, 'bin', 'server', exe);
  return fs.existsSync(candidate) ? candidate : undefined;
}

// The bridge manifest the active extension host writes under
// globalStorage/<extension>/mcp/bridge-manifest.json. Lets an independently
// installed (npx / global npm) cwtools-mcp discover the running extension
// without a --bridge-manifest override.
export function detectExtensionBridgeManifestPath(): string | undefined {
  for (const base of globalStorageBases()) {
    const candidate = path.join(base, PRIMARY_EXTENSION_DIR, 'mcp', 'bridge-manifest.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// True when dir holds at least one .cwt rule file at its top level.
function containsRuleFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some(name => name.toLowerCase().endsWith('.cwt'));
  } catch {
    return false;
  }
}

export function detectExtensionRulesDir(cacheDir: string | undefined, game: string | undefined): string | undefined {
  const g = (game ?? 'stellaris').toLowerCase();
  const roots = [
    ...(cacheDir ? [cacheDir] : []),
    ...globalStorageBases().map(base => path.join(base, PRIMARY_EXTENSION_DIR, '.cwtools')),
  ];
  for (const root of roots) {
    const config = path.join(root, g, 'config');
    if (containsRuleFiles(config)) return config;
    const bare = path.join(root, g);
    if (containsRuleFiles(bare)) return bare;
  }
  return undefined;
}
