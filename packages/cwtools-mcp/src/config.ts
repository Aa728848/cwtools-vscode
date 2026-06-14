import * as path from 'path';

export interface CwtoolsMcpConfig {
  workspaceRoot: string;
  game?: string;
  serverPath?: string;
  stdio: boolean;
  http: boolean;
  host: string;
  port: number;
  enableWrites: boolean;
  allowedTools: string[];
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
  ].join('\n');
}
