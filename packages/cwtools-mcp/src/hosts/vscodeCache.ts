import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { vanillaCacheFileName } from 'cwtools-shared';

// The VS Code cwtools extension stores its built vanilla cache + extracted rules
// under globalStorage. When the user doesn't pass --cache, reuse that dir so the
// MCP rides on the cache the extension already built.
const EXTENSION_DIR = 'eddy.eddy-stellaris-cwt';
const VSCODE_APP_DIRS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor'];

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
    const dir = path.join(base, EXTENSION_DIR, '.cwtools');
    if (fs.existsSync(path.join(dir, cacheFile))) return dir;
  }
  return undefined;
}
