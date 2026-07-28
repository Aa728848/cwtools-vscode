import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { watch, type FSWatcher } from 'chokidar';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { LspHost } from 'cwtools-shared';
import { detectExtensionServerPath, detectExtensionRulesDir } from './vscodeCache';
import { resolveLocalisationLanguages, resolveGeneratedStrings, resolveExperimental } from './projectSettings';

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
  // Epoch (ms) when the server finished loading/initial validation. Files modified
  // after this are candidates for on-demand revalidation.
  private startedAtMs?: number;
  private fileWatcher?: FSWatcher;
  private watcherFlushTimer?: NodeJS.Timeout;
  private readonly pendingWatchedChanges = new Map<string, 1 | 2 | 3>();

  constructor(private readonly options: LspProcessHostOptions) {}

  get readyAtMs(): number | undefined {
    return this.startedAtMs;
  }

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
    const proc = this.process;
    const connection = this.connection;
    // Null fields first so a second dispose() (e.g. from the process 'exit'
    // safety net) is a no-op and never double-kills.
    this.connection = undefined;
    this.process = undefined;
    this.startPromise = undefined;
    this.stopFileWatcher();
    try {
      connection?.dispose();
    } catch {
      // ignore disposal failures
    }
    // Kill only the child WE spawned. On its stdin closing the F# server also
    // self-exits on EOF, but an explicit kill is the hard guarantee.
    try {
      proc?.kill();
    } catch {
      // process may already be gone
    }
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
      this.stopFileWatcher();
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
    const game = this.options.game ?? 'stellaris';
    const rulesCacheRoot = resolveRulesCacheRoot(this.options);
    const rulesFolder = this.options.bundledRulesPath ?? resolveBundledRulesPath(game, rulesCacheRoot);
    if (!rulesFolder) {
      process.stderr.write('[cwtools-mcp] warning: no CWT rules found — install the VS Code extension or pass --rules <dir>; validation will be limited\n');
    }
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
        language: game,
        uiLanguage: 'en',
        isVanillaFolder: false,
        rulesCache: rulesCacheRoot,
        bundledRulesPath: rulesFolder ?? '',
        rules_version: 'manual',
        defaultRepoPath: '',
        repoPath: '',
        diagnosticLogging: false,
      },
      trace: 'off',
    });
    void this.connection.sendNotification('initialized', {});
    const loc = resolveLocalisationLanguages(this.options.workspaceRoot);
    process.stderr.write(`[cwtools-mcp] info: localisation languages = [${loc.languages.join(', ')}] (${loc.source})\n`);
    void this.connection.sendNotification('workspace/didChangeConfiguration', {
      settings: {
        cwtools: buildCwtoolsConfiguration(game, this.options.gamePath, rulesFolder ?? '', {
          languages: loc.languages,
          generatedStrings: resolveGeneratedStrings(this.options.workspaceRoot),
        }, resolveExperimental(this.options.workspaceRoot)),
      },
    });
    await this.waitForExecuteCommandsReady(20_000);
    this.startFileWatcher();
    this.startedAtMs = Date.now();
  }

  private startFileWatcher(): void {
    if (this.fileWatcher) return;
    const watcher = watch(this.options.workspaceRoot, {
      ignoreInitial: true,
      ignored: [/(^|[\\/])(?:node_modules|\.git|\.cwtools|\.cwtools-ai)(?:[\\/]|$)/],
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    watcher.on('add', filePath => this.queueWatchedFileChange(filePath, 1));
    watcher.on('change', filePath => this.queueWatchedFileChange(filePath, 2));
    watcher.on('unlink', filePath => this.queueWatchedFileChange(filePath, 3));
    watcher.on('error', error => {
      if (process.env.CWTOOLS_MCP_DEBUG) {
        process.stderr.write(`[cwtools-mcp] file watcher error: ${String(error)}\n`);
      }
    });
    this.fileWatcher = watcher;
  }

  private stopFileWatcher(): void {
    if (this.watcherFlushTimer) clearTimeout(this.watcherFlushTimer);
    this.watcherFlushTimer = undefined;
    this.pendingWatchedChanges.clear();
    const watcher = this.fileWatcher;
    this.fileWatcher = undefined;
    void watcher?.close();
  }

  private queueWatchedFileChange(filePath: string, type: 1 | 2 | 3): void {
    if (!isLspWatchedFile(this.options.workspaceRoot, filePath, this.options.game)) return;
    const resolved = path.resolve(filePath);
    const previous = this.pendingWatchedChanges.get(resolved);
    // Preserve a create over its following content-change event; deletion always wins.
    const nextType = type === 3 ? 3 : previous === 1 ? 1 : type;
    this.pendingWatchedChanges.set(resolved, nextType);
    if (this.watcherFlushTimer) clearTimeout(this.watcherFlushTimer);
    this.watcherFlushTimer = setTimeout(() => this.flushWatchedFileChanges(), 100);
  }

  private flushWatchedFileChanges(): void {
    this.watcherFlushTimer = undefined;
    const connection = this.connection;
    if (!connection || this.pendingWatchedChanges.size === 0) return;
    const changes = Array.from(this.pendingWatchedChanges, ([filePath, type]) => ({ filePath, type }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath))
      .map(({ filePath, type }) => ({
        uri: pathToFileUri(filePath),
        type,
      }));
    this.pendingWatchedChanges.clear();
    void connection.sendNotification('workspace/didChangeWatchedFiles', { changes });
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

function buildCwtoolsConfiguration(
  game: string,
  gamePath: string | undefined,
  rulesFolder: string,
  localisation: { languages: string[]; generatedStrings: string },
  experimental: boolean,
): Record<string, unknown> {
  // `cache.<game>` is the vanilla install/data dir (the server reads vanilla data
  // from here and serializes the .cwb cache). Empty string => no vanilla data.
  const vanillaDir = gamePath ?? '';
  return {
    localisation: {
      languages: localisation.languages,
      generated_strings: localisation.generatedStrings,
    },
    errors: {
      vanilla: false,
      ignore: [],
      ignorefiles: [],
    },
    // On by default: enables incremental scripted-type refresh so revalidating a
    // scripted_trigger/effect/value patches the type index fast instead of a full reload.
    experimental,
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
    rules_folder: rulesFolder,
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
  // Prefer the server inside the installed VS Code extension so a user with no dev
  // checkout still gets a working server; fall back to dev-build locations.
  const installed = detectExtensionServerPath();
  const candidates = [
    ...(installed ? [installed] : []),
    path.join(process.cwd(), 'release', 'bin', 'server', executable),
    path.join(process.cwd(), 'bin', 'server', executable),
    path.join(repoRoot, 'release', 'bin', 'server', executable),
    path.join(repoRoot, 'bin', 'server', executable),
    path.join(repoRoot, 'src', 'Main', 'output', platform === 'win32' ? 'CWTools Server.exe' : 'CWTools Server'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

// Resolve a rules *directory* the server can load. Priority: the rules the
// installed extension pulled into globalStorage, then a dev checkout. No bundled
// .zip and no extraction — the only zip-free sources. Returns undefined when none
// is found (the caller warns; --rules is the explicit override).
function resolveBundledRulesPath(game: string, cacheDir?: string): string | undefined {
  const extracted = detectExtensionRulesDir(cacheDir, game);
  if (extracted) return extracted;
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const candidates = [
    path.join(process.cwd(), 'release', 'rules', game, 'config'),
    path.join(process.cwd(), 'submodules', `cwtools-${game}-config`, 'config'),
    game === 'stellaris' ? path.join(process.cwd(), 'submodules', 'cwtools-stellaris-config', 'config') : '',
    path.join(repoRoot, 'release', 'rules', game, 'config'),
    path.join(repoRoot, 'submodules', `cwtools-${game}-config`, 'config'),
    game === 'stellaris' ? path.join(repoRoot, 'submodules', 'cwtools-stellaris-config', 'config') : '',
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

export function pathToFileUri(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  const withLeadingSlash = resolved.startsWith('/') ? resolved : `/${resolved}`;
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23')}`;
}

const LSP_WATCHED_EXTENSIONS = new Set([
  '.txt', '.gui', '.yml', '.csv', '.gfx', '.asset', '.cwt', '.entity', '.shader', '.fxh',
]);

export function isLspWatchedFile(workspaceRoot: string, filePath: string, game?: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const segments = relative.split(/[\\/]+/).map(segment => segment.toLowerCase());
  if (segments.some(segment => segment === 'node_modules'
    || segment === '.git'
    || segment === '.cwtools'
    || segment === '.cwtools-ai')) return false;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv' && game && game.toLowerCase() !== 'ck2') return false;
  return LSP_WATCHED_EXTENSIONS.has(extension);
}
