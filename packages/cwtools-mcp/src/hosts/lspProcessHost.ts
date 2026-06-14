import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { LspHost } from 'cwtools-shared';

export interface LspProcessHostOptions {
  workspaceRoot: string;
  game?: string;
  serverPath?: string;
  rulesCache?: string;
  // Pre-built cache dir holding <game>.cwb; overrides the default rules-cache
  // root so the server loads it instead of rebuilding.
  cachePath?: string;
  // Vanilla install/data dir, forwarded to `cache.<game>` so the server can
  // build/locate the vanilla cache (otherwise vanilla data is absent).
  gamePath?: string;
  bundledRulesPath?: string;
}

// The rules-cache root (also where the server reads/writes <game>.cwb). Kept as a
// shared helper so the vanilla-cache probe resolves the exact same location.
export function resolveRulesCacheRoot(options: { rulesCache?: string; cachePath?: string; workspaceRoot: string }): string {
  return options.rulesCache ?? options.cachePath ?? path.join(options.workspaceRoot, '.cwtools', 'rules-cache');
}

interface LspErrorResult {
  ok: false;
  status: 'unavailable';
  error: {
    code: 'lsp_unavailable';
    message: string;
  };
}

export class LspProcessHost implements LspHost {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private startPromise?: Promise<void>;
  private startError?: string;

  constructor(private readonly options: LspProcessHostOptions) {}

  async executeCommand<T = unknown>(command: string, args: unknown[] = [], options?: { timeoutMs?: number }): Promise<T> {
    try {
      await this.ensureStarted(options?.timeoutMs);
      const result = await this.withTimeout(
        this.connection!.sendRequest('workspace/executeCommand', {
          command,
          arguments: args,
        }),
        options?.timeoutMs ?? 20_000,
        `LSP command ${command} timed out`,
      );
      return result as T;
    } catch (error) {
      return this.unavailable(error instanceof Error ? error.message : String(error)) as T;
    }
  }

  async sendRequest<T = unknown>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    try {
      await this.ensureStarted(timeoutMs);
      return await this.withTimeout(
        this.connection!.sendRequest(method, params),
        timeoutMs,
        `LSP request ${method} timed out`,
      ) as T;
    } catch (error) {
      return this.unavailable(error instanceof Error ? error.message : String(error)) as T;
    }
  }

  async request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> {
    return this.sendRequest(method, params, options?.timeoutMs);
  }

  dispose(): void {
    try {
      this.connection?.dispose();
    } catch {
      // ignore disposal failures
    }
    this.process?.kill();
    this.connection = undefined;
    this.process = undefined;
    this.startPromise = undefined;
  }

  private async ensureStarted(timeoutMs = 30_000): Promise<void> {
    if (this.connection && !this.startError) return;
    if (!this.startPromise) {
      this.startPromise = this.start();
    }
    await this.withTimeout(this.startPromise, timeoutMs, 'CWTools LSP startup timed out');
    if (this.startError) throw new Error(this.startError);
  }

  private async start(): Promise<void> {
    const serverPath = this.options.serverPath ?? resolveDefaultServerPath();
    if (!serverPath || !fs.existsSync(serverPath)) {
      this.startError = `CWTools server binary was not found. Checked: ${serverPath ?? '(none)'}`;
      throw new Error(this.startError);
    }

    this.process = spawn(serverPath, [], {
      cwd: this.options.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process.stderr.on('data', chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (text.trim()) {
        process.stderr.write(`[cwtools-lsp] ${text}`);
      }
    });
    this.process.on('exit', (code, signal) => {
      this.startError = `CWTools LSP exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`;
      this.connection = undefined;
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    );
    this.connection.listen();

    // Forward server log/diagnostics to stderr when CWTOOLS_MCP_DEBUG is set, so
    // load/cache problems are visible (the server logs via window/logMessage).
    if (process.env.CWTOOLS_MCP_DEBUG) {
      this.connection.onNotification('window/logMessage', (p: { message?: string } = {}) => {
        if (p.message) process.stderr.write(`[cwtools-lsp] ${String(p.message).slice(0, 240)}\n`);
      });
    }

    const rootUri = pathToFileUri(this.options.workspaceRoot);
    await this.connection.sendRequest('initialize', {
      processId: process.pid,
      rootPath: this.options.workspaceRoot,
      rootUri,
      workspaceFolders: [
        {
          uri: rootUri,
          name: path.basename(this.options.workspaceRoot),
        },
      ],
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
        },
        textDocument: {
          synchronization: {
            didSave: true,
          },
        },
      },
      initializationOptions: {
        language: this.options.game ?? 'stellaris',
        uiLanguage: 'en',
        isVanillaFolder: false,
        rulesCache: resolveRulesCacheRoot(this.options),
        bundledRulesPath: this.options.bundledRulesPath ?? resolveBundledRulesPath(this.options.game ?? 'stellaris'),
        rules_version: 'manual',
        repoPath: '',
        diagnosticLogging: false,
      },
      trace: 'off',
    });
    this.connection.sendNotification('initialized', {});
    this.connection.sendNotification('workspace/didChangeConfiguration', {
      settings: {
        cwtools: buildCwtoolsConfiguration(this.options.game ?? 'stellaris', this.options.gamePath),
      },
    });
    await this.waitForExecuteCommandsReady(20_000);
  }

  private unavailable(message: string): LspErrorResult {
    return {
      ok: false,
      status: 'unavailable',
      error: {
        code: 'lsp_unavailable',
        message,
      },
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async waitForExecuteCommandsReady(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.connection!.sendRequest('workspace/executeCommand', {
        command: 'cwtools.ai.getValidationStatus',
        arguments: [],
      }).catch(() => null);
      if (result && typeof result === 'object') return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

function buildCwtoolsConfiguration(game: string, gamePath?: string): Record<string, unknown> {
  // `cache.<game>` is the vanilla install/data dir (the server reads vanilla data
  // from here and serializes the .cwb cache). Empty string => no vanilla data.
  const vanillaDir = gamePath ?? '';
  return {
    localisation: {
      languages: ['English'],
      generated_strings: 'replace',
    },
    errors: {
      vanilla: false,
      ignore: [],
      ignorefiles: [],
    },
    experimental: false,
    debug_mode: false,
    ignore_patterns: [],
    trace: {
      server: 'off',
    },
    cache: {
      stellaris: '',
      hoi4: '',
      eu4: '',
      ck2: '',
      imperator: '',
      vic2: '',
      ck3: '',
      vic3: '',
      eu5: '',
      [game]: vanillaDir,
    },
    rules_folder: resolveBundledRulesPath(game),
    showInlineText: false,
    maxFileSize: 2,
    diagnostics: {
      deferDynamicParameterDiagnostics: true,
      dynamicPreflightTimeoutMs: 250,
      dynamicPreflightMaxEntities: 300,
      dynamicDeferDelayMs: 800,
    },
  };
}

export function createLspProcessHost(options: LspProcessHostOptions): LspProcessHost {
  return new LspProcessHost(options);
}

export function resolveDefaultServerPath(): string | undefined {
  const platform = os.platform();
  const executable = platform === 'win32'
    ? path.join('win-x64', 'CWTools Server.exe')
    : platform === 'darwin'
      ? path.join('osx-x64', 'CWTools Server')
      : path.join('linux-x64', 'CWTools Server');

  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const candidates = [
    path.join(process.cwd(), 'release', 'bin', 'server', executable),
    path.join(process.cwd(), 'bin', 'server', executable),
    path.join(repoRoot, 'release', 'bin', 'server', executable),
    path.join(repoRoot, 'bin', 'server', executable),
    path.join(repoRoot, 'src', 'Main', 'output', platform === 'win32' ? 'CWTools Server.exe' : 'CWTools Server'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

function resolveBundledRulesPath(game: string): string {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  // Prefer an extracted rules DIRECTORY; the server cannot load rules from the
  // packaged .zip directly (the extension extracts it first). The zip is a last
  // resort only so a path is always returned.
  const candidates = [
    path.join(process.cwd(), 'release', 'rules', game, 'config'),
    path.join(process.cwd(), 'submodules', `cwtools-${game}-config`, 'config'),
    game === 'stellaris' ? path.join(process.cwd(), 'submodules', 'cwtools-stellaris-config', 'config') : '',
    path.join(repoRoot, 'release', 'rules', game, 'config'),
    path.join(repoRoot, 'submodules', `cwtools-${game}-config`, 'config'),
    game === 'stellaris' ? path.join(repoRoot, 'submodules', 'cwtools-stellaris-config', 'config') : '',
    path.join(process.cwd(), 'release', 'rules', `${game}-rules.zip`),
    path.join(repoRoot, 'release', 'rules', `${game}-rules.zip`),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0]!;
}

export function pathToFileUri(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  const withLeadingSlash = resolved.startsWith('/') ? resolved : `/${resolved}`;
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23')}`;
}
