import * as path from 'path';

export interface CwtoolsMcpConfig {
  workspaceRoot: string;
  game?: string;
  serverPath?: string;
  // Vanilla install/data dir, forwarded to the LSP `cache.<game>` setting so the
  // server can build (or locate) the vanilla cache. Without it, results are mod-only.
  gamePath?: string;
  // Pre-built cache dir (overrides the default rules-cache root), so the server
  // loads an existing `.cwb` instead of rebuilding — e.g. the extension's globalStorage.
  cachePath?: string;
  // Explicit CWT rules source (directory or .zip) overriding auto-detection.
  rulesPath?: string;
  stdio: boolean;
  http: boolean;
  host: string;
  port: number;
  enableWrites: boolean;
  allowedTools: string[];
  forceStart: boolean;
}

export function parseCliArgs(argv: string[]): CwtoolsMcpConfig {
  const config: CwtoolsMcpConfig = {
    workspaceRoot: process.cwd(),
    stdio: true,
    http: false,
    host: '127.0.0.1',
    port: 3000,
    enableWrites: false,
    allowedTools: [],
    forceStart: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--workspace':
        config.workspaceRoot = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--game':
        config.game = readValue(argv, ++index, arg);
        break;
      case '--server-path':
        config.serverPath = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--game-path':
        config.gamePath = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--cache':
        config.cachePath = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--rules':
        config.rulesPath = path.resolve(readValue(argv, ++index, arg));
        break;
      case '--stdio':
        config.stdio = true;
        config.http = false;
        break;
      case '--http':
        config.http = true;
        config.stdio = false;
        break;
      case '--host':
        config.host = readValue(argv, ++index, arg);
        break;
      case '--port':
        config.port = readPort(readValue(argv, ++index, arg));
        break;
      case '--enable-writes':
        config.enableWrites = true;
        break;
      case '--force-start':
        config.forceStart = true;
        break;
      case '--allow-tool':
        config.allowedTools.push(readValue(argv, ++index, arg));
        break;
      case '--help':
      case '-h':
        throw new Error(helpText());
      default:
        if (arg?.startsWith('--allow-tool=')) {
          config.allowedTools.push(arg.slice('--allow-tool='.length));
        } else if (arg?.startsWith('--workspace=')) {
          config.workspaceRoot = path.resolve(arg.slice('--workspace='.length));
        } else if (arg?.startsWith('--game=')) {
          config.game = arg.slice('--game='.length);
        } else if (arg?.startsWith('--server-path=')) {
          config.serverPath = path.resolve(arg.slice('--server-path='.length));
        } else if (arg?.startsWith('--game-path=')) {
          config.gamePath = path.resolve(arg.slice('--game-path='.length));
        } else if (arg?.startsWith('--cache=')) {
          config.cachePath = path.resolve(arg.slice('--cache='.length));
        } else if (arg?.startsWith('--rules=')) {
          config.rulesPath = path.resolve(arg.slice('--rules='.length));
        } else if (arg?.startsWith('--host=')) {
          config.host = arg.slice('--host='.length);
        } else if (arg?.startsWith('--port=')) {
          config.port = readPort(arg.slice('--port='.length));
        } else if (arg === '--http') {
          config.http = true;
          config.stdio = false;
        } else {
          throw new Error(`Unknown argument: ${arg}\n\n${helpText()}`);
        }
    }
  }

  return config;
}

function readPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  return port;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function helpText(): string {
  return [
    'Usage:',
    '  cwtools-mcp --workspace <path> [--game stellaris] [--stdio] [--server-path <path>]',
    '  cwtools-mcp --workspace <path> --http [--host 127.0.0.1] [--port 3000]',
    '  cwtools-mcp --workspace <path> --enable-writes',
    '  cwtools-mcp --workspace <path> --enable-writes --allow-tool write_localisation --allow-tool edit_pdx_block',
    '',
    'Vanilla data (needed for vanilla IDs and correct mod-vs-vanilla diagnostics):',
    '  (auto)              If neither flag is given, the VS Code cwtools extension cache',
    '                      in globalStorage is auto-detected and reused.',
    '  --game-path <dir>   Vanilla install/data dir; the server builds the cache from it (slow first run).',
    '  --cache <dir>       Dir holding a pre-built <game>.cwb cache (overrides auto-detection),',
    '                      loaded directly instead of rebuilding. Without any, results are mod-only.',
    '',
    'Rules source (priority: --rules > installed extension > dev checkout > bundled zip):',
    '  --rules <dir|zip>   Explicit CWT rules dir, or a *-rules.zip (extracted automatically).',
    '',
    'Project gate:',
    '  (default)           Tools are exposed and the language server starts only when the',
    '                      workspace looks like a Paradox mod (descriptor.mod). Otherwise tools are hidden and no server spawns.',
    '  --force-start       Start even without mod markers (escape hatch for unusual layouts).',
  ].join('\n');
}
