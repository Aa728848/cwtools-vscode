import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { vanillaCacheFileName } from 'cwtools-shared';

// VS Code-compatible hosts store the extension's built vanilla cache + extracted
// rules under globalStorage. In standalone mode, when the user doesn't pass
// --cache, reuse that dir so the MCP rides on a cache the extension already built.
const PRIMARY_EXTENSION_DIR = 'foreverskywalker.foreverskywalker-stellaris-cwtools';
const LEGACY_EXTENSION_DIRS = [
  'foreverskywalker.eddy-stellaris-cwt',
  'eddy.eddy-stellaris-cwt',
];
const EXTENSION_DIRS = [PRIMARY_EXTENSION_DIR, ...LEGACY_EXTENSION_DIRS];
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
    for (const extensionDir of EXTENSION_DIRS) {
      const dir = path.join(base, extensionDir, '.cwtools');
      if (fs.existsSync(path.join(dir, cacheFile))) return dir;
    }
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

// Newest installed extension dir, falling back to legacy extension IDs, else undefined.
export function detectInstalledExtensionDir(): string | undefined {
  let best: { dir: string; version: string; priority: number } | undefined;
  for (const root of extensionInstallRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      for (const [priority, extensionDir] of EXTENSION_DIRS.entries()) {
        if (!name.startsWith(`${extensionDir}-`)) continue;
        const version = name.slice(extensionDir.length + 1);
        // String compare is enough to pick the highest semver-ish folder name.
        if (!best || version > best.version || (version === best.version && priority < best.priority)) {
          best = { dir: path.join(root, name), version, priority };
        }
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
    ...globalStorageBases().flatMap(base => EXTENSION_DIRS.map(extensionDir => path.join(base, extensionDir, '.cwtools'))),
  ];
  for (const root of roots) {
    const config = path.join(root, g, 'config');
    if (containsRuleFiles(config)) return config;
    const bare = path.join(root, g);
    if (containsRuleFiles(bare)) return bare;
  }
  return undefined;
}
