import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import {
  type DirectoryEntry,
  type DiagnosticRecord,
  type DiagnosticsHost,
  type DiagnosticsQueryResult,
  type FilesystemHost,
  type HostServices,
  type IndexHost,
  type IndexQueryResult,
  type LocalisationIndexEntry,
  type LocalisationIndexQuery,
  MCP_WRITE_TOOL_NAMES,
  resolveWorkspacePath,
  type VanillaCacheStatus,
  vanillaCacheFileName,
  type WorkspaceIndexEntry,
  type WorkspaceIndexQuery,
} from 'cwtools-shared';
import type { CwtoolsMcpConfig } from '../config';
import { createLspProcessHost, pathToFileUri, resolveRulesCacheRoot, type LspProcessHost } from './lspProcessHost';
import { detectExtensionCacheDir } from './vscodeCache';

export function createNodeHostServices(config: CwtoolsMcpConfig): HostServices {
  const workspaceRoot = path.resolve(config.workspaceRoot);
  const allowlist = config.allowedTools.length > 0
    ? new Set(config.allowedTools)
    : new Set<string>(MCP_WRITE_TOOL_NAMES);
  const filesystem = new NodeFilesystemHost(workspaceRoot, config.enableWrites);
  // Fall back to the VS Code cwtools extension's globalStorage cache when --cache
  // is omitted, so the MCP reuses the vanilla cache the extension already built.
  const autoCache = config.cachePath ?? detectExtensionCacheDir(config.game);
  const lsp = createLspProcessHost({
    workspaceRoot,
    game: config.game,
    serverPath: config.serverPath,
    cachePath: autoCache,
    gamePath: config.gamePath,
  });
  if (!config.cachePath && autoCache) {
    console.error(`[cwtools-mcp] info: auto-detected VS Code extension cache at ${autoCache}`);
  }
  // Surface the resolved workspace so it's clear which mod is analysed — when
  // --workspace is omitted this is the process cwd Codex launched the server in.
  console.error(`[cwtools-mcp] info: workspace = ${workspaceRoot}${config.workspaceRoot === process.cwd() ? ' (inherited cwd)' : ''}`);
  return {
    workspaceRoot,
    readonlyMode: !config.enableWrites,
    writesEnabled: config.enableWrites,
    allowedWriteTools: allowlist,
    lsp,
    diagnostics: new LspDiagnosticsHost(lsp, workspaceRoot),
    filesystem,
    indexing: new ThinNodeIndexHost(workspaceRoot),
    vanillaCache: probeVanillaCache(workspaceRoot, { ...config, cachePath: autoCache }),
    now: () => Date.now(),
    log: (level, message, data) => {
      if (level === 'debug') return;
      const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
      console.error(`[cwtools-mcp] ${level}: ${message}${suffix}`);
    },
  };
}

// Resolve vanilla-cache availability up front: a pre-built <game>.cwb under the
// rules-cache root means vanilla data loads; a valid --game-path means the server
// can build it; otherwise results are mod-only. Mirrors GameLoader.getCachedFiles
// (cache file lives at the rules-cache root) and Program.fs cache.<game> handling.
function probeVanillaCache(workspaceRoot: string, config: CwtoolsMcpConfig): VanillaCacheStatus {
  const cacheFileName = vanillaCacheFileName(config.game);
  const rulesCacheRoot = resolveRulesCacheRoot({ cachePath: config.cachePath, workspaceRoot });
  const cacheFile = cacheFileName ? path.join(rulesCacheRoot, cacheFileName) : undefined;
  const cacheExists = !!cacheFile && fssync.existsSync(cacheFile);
  const gamePathValid = !!config.gamePath && fssync.existsSync(config.gamePath);
  if (cacheExists) {
    return { available: true, source: 'mod_plus_vanilla', cacheFile, reason: 'Loaded a pre-built vanilla cache.' };
  }
  if (gamePathValid) {
    return {
      available: true,
      source: 'mod_plus_vanilla',
      cacheFile,
      gamePath: config.gamePath,
      reason: 'No pre-built cache; the server will build one from --game-path on first load (slow).',
    };
  }
  return {
    available: false,
    source: 'mod_only',
    cacheFile,
    reason: 'No vanilla cache and no --game-path/--cache; results reflect mod files only.',
  };
}

class LspDiagnosticsHost implements DiagnosticsHost {
  constructor(private readonly lsp: LspProcessHost, private readonly workspaceRoot: string) {}

  async getDiagnostics(filter: { file?: string; severity?: string; limit?: number } = {}): Promise<DiagnosticsQueryResult> {
    const file = filter.file;
    if (file) {
      const resolution = resolveWorkspacePath(this.workspaceRoot, file);
      const filePath = resolution.resolvedPath ?? file;
      const raw = asRecord(await this.lsp.executeCommand<unknown>(
        'cwtools.ai.getDiagnosticsFresh',
        [pathToFileUri(filePath)],
        { timeoutMs: 20_000 },
      ));
      return normalizeDiagnosticsFresh(raw);
    }

    // Whole-workspace: aggregate cached per-file diagnostics from the server. The
    // server populated these for every file during load; getValidationStatus alone
    // only reports freshness, never the diagnostics themselves.
    const severity = filter.severity === 'information' ? 'info' : filter.severity ?? 'all';
    const limit = typeof filter.limit === 'number' ? filter.limit : 1000;
    const raw = asRecord(await this.lsp.executeCommand<unknown>(
      'cwtools.ai.getAllDiagnostics',
      [severity, limit],
      { timeoutMs: 30_000 },
    ));
    if (raw.ok === false || raw.status === 'unavailable') {
      return unavailableDiagnostics(raw);
    }
    return {
      ok: true,
      status: 'fresh',
      diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics.map(normalizeDiagnosticRecord) : [],
      totalCount: numberOrUndefined(raw.totalCount),
      truncated: raw.truncated === true,
      freshness: {
        value: 'fresh',
        pendingKinds: [],
        epoch: numberOrUndefined(raw.epoch),
      },
    };
  }
}

function normalizeDiagnosticsFresh(raw: Record<string, unknown>): DiagnosticsQueryResult {
  if (raw.ok === false || raw.status === 'unavailable') {
    return unavailableDiagnostics(raw);
  }
  const freshness = String(raw.freshness ?? 'unavailable') as DiagnosticsQueryResult['status'];
  return {
    ok: true,
    status: freshness,
    diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics.map(normalizeDiagnosticRecord) : [],
    freshness: {
      value: freshness,
      pendingKinds: asStringArray(raw.pendingGlobalKinds),
      validatedVersion: numberOrUndefined(raw.validatedVersion),
      epoch: numberOrUndefined(raw.epoch),
      updatedAt: numberOrUndefined(raw.updatedAtUnixMs),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {
        ok: false,
        status: 'unavailable',
        error: {
          code: 'lsp_no_response',
          message: 'LSP returned no diagnostics response.',
        },
      };
}

function unavailableDiagnostics(raw: Record<string, unknown>): DiagnosticsQueryResult {
  const error = raw.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : {};
  return {
    ok: false,
    status: 'unavailable',
    diagnostics: [],
    error: {
      code: String(error.code ?? 'lsp_unavailable'),
      message: String(error.message ?? 'Diagnostics are unavailable.'),
    },
  };
}

function normalizeDiagnosticRecord(value: unknown): DiagnosticRecord {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const severity = String(record.severity ?? 'information');
  return {
    file: typeof record.file === 'string' ? record.file : undefined,
    line: numberOrUndefined(record.line),
    column: numberOrUndefined(record.column),
    severity: severity === 'error' || severity === 'warning' || severity === 'hint' ? severity : 'information',
    code: typeof record.code === 'string' ? record.code : undefined,
    message: String(record.message ?? ''),
    source: typeof record.source === 'string' ? record.source : 'cwtools',
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

class NodeFilesystemHost implements FilesystemHost {
  constructor(private readonly workspaceRoot: string, private readonly writesEnabled: boolean) {}

  async readTextFile(filePath: string) {
    const resolved = this.resolve(filePath);
    if (!fssync.existsSync(resolved)) {
      return { content: '', hasBom: false, exists: false };
    }
    const content = await fs.readFile(resolved, 'utf8');
    return {
      content,
      hasBom: content.charCodeAt(0) === 0xfeff,
      exists: true,
    };
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    if (!this.writesEnabled) {
      throw new Error('writes_disabled');
    }
    const resolved = this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
  }

  async list(dirPath: string): Promise<DirectoryEntry[]> {
    const resolved = this.resolve(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return entries.map(entry => {
      const fullPath = path.join(resolved, entry.name);
      const stat = fssync.existsSync(fullPath) ? fssync.statSync(fullPath) : undefined;
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stat?.isFile() ? stat.size : undefined,
      };
    });
  }

  async glob(pattern: string, options?: { limit?: number }): Promise<string[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 500, 5000));
    const suffix = pattern.startsWith('**/*') ? pattern.slice(4) : pattern;
    const results: string[] = [];
    await walk(this.workspaceRoot, async filePath => {
      if (results.length >= limit) return;
      if (!suffix || filePath.replace(/\\/g, '/').endsWith(suffix.replace(/\\/g, '/'))) {
        results.push(path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/'));
      }
    });
    return results;
  }

  private resolve(filePath: string): string {
    const resolution = resolveWorkspacePath(this.workspaceRoot, filePath);
    if (!resolution.ok || !resolution.resolvedPath) {
      throw new Error(`Path '${filePath}' is outside the workspace root.`);
    }
    return resolution.resolvedPath;
  }
}

class ThinNodeIndexHost implements IndexHost {
  constructor(private readonly workspaceRoot: string) {}

  async queryWorkspace(query: WorkspaceIndexQuery): Promise<IndexQueryResult<WorkspaceIndexEntry>> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const entries: WorkspaceIndexEntry[] = [];
    await walk(this.workspaceRoot, async filePath => {
      if (entries.length >= limit) return;
      const rel = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
      if (!isWorkspaceIndexFile(rel)) return;
      if (query.directory && !rel.toLowerCase().includes(query.directory.toLowerCase())) return;
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && entries.length < limit; index++) {
        const symbol = parseSymbol(lines[index] ?? '', rel);
        if (!symbol) continue;
        if (!matchesName(symbol.name, query.name, query)) continue;
        if (query.kind && symbol.kind !== query.kind) continue;
        if (query.category && symbol.category !== query.category) continue;
        if (query.source && symbol.source !== query.source) continue;
        entries.push({
          ...symbol,
          file: rel,
          line: index,
          origin: 'workspace',
          updatedAt: fssync.statSync(filePath).mtimeMs,
        });
      }
    });
    return {
      status: 'ready',
      totalCount: entries.length,
      entries,
      indexedSymbolNames: entries.length,
      indexUpdatedAt: Date.now(),
      _hint: 'Phase 0 thin Node index only returns lightweight workspace symbols; LSP/index commands remain the Phase 1 source of truth.',
    };
  }

  async queryLocalisation(query: LocalisationIndexQuery): Promise<IndexQueryResult<LocalisationIndexEntry>> {
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
    const entries: LocalisationIndexEntry[] = [];
    await walk(this.workspaceRoot, async filePath => {
      if (entries.length >= limit) return;
      const rel = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
      if (!isLocalisationFile(rel)) return;
      const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
      const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const lines = content.split(/\r?\n/);
      let language = '';
      for (let index = 0; index < lines.length && entries.length < limit; index++) {
        const line = lines[index] ?? '';
        const header = line.match(/^\s*(l_[a-z_]+):/i);
        if (header?.[1]) language = header[1];
        const match = line.match(/^\s*([\w.-]+):\d*\s*"([^"]*)"/);
        if (!match?.[1]) continue;
        if (query.language && query.language !== language) continue;
        if (!matchesLocalisationKey(match[1], query)) continue;
        entries.push({
          key: match[1],
          value: match[2] ?? '',
          file: rel,
          line: index,
          language,
        });
      }
    });
    return {
      status: 'ready',
      totalCount: entries.length,
      entries,
      indexUpdatedAt: Date.now(),
      _hint: 'Phase 0 thin Node localisation index scans workspace YML files only.',
    };
  }
}

async function walk(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  if (!fssync.existsSync(root)) return;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.cwtools-ai') continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visit);
    } else {
      await visit(fullPath);
    }
  }
}

function isWorkspaceIndexFile(relativePath: string): boolean {
  return /\.(txt|gfx|asset|gui)$/i.test(relativePath);
}

function isLocalisationFile(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return /\.yml$/.test(normalized)
    && (normalized.startsWith('localisation/')
      || normalized.startsWith('localisation_synced/')
      || normalized.startsWith('localization/'));
}

function parseSymbol(line: string, relativePath: string): Omit<WorkspaceIndexEntry, 'file' | 'line' | 'origin'> | null {
  const namespace = line.match(/^\s*namespace\s*=\s*"?([\w.:-]+)"?/);
  if (namespace?.[1]) {
    return { name: namespace[1], kind: 'namespace', source: 'script', category: 'event' };
  }
  const id = line.match(/^\s*id\s*=\s*"?([\w.:-]+)"?/);
  if (id?.[1]) {
    return { name: id[1], kind: 'event', source: 'script', category: 'event' };
  }
  const topLevel = line.match(/^([@\w][\w.:-]*)\s*=/);
  if (topLevel?.[1]) {
    const source = relativePath.endsWith('.gui') ? 'gui' : relativePath.endsWith('.gfx') || relativePath.endsWith('.asset') ? 'asset' : 'script';
    return { name: topLevel[1], kind: 'symbol', source, category: source === 'script' ? 'script' : source };
  }
  const sprite = line.match(/\bname\s*=\s*"?(GFX_[\w.:-]+)"?/);
  if (sprite?.[1]) {
    return { name: sprite[1], kind: 'sprite', source: 'asset', category: 'asset' };
  }
  return null;
}

function matchesName(name: string, queryName: string | undefined, query: WorkspaceIndexQuery): boolean {
  if (!queryName) return true;
  const needle = queryName.toLowerCase();
  const haystack = name.toLowerCase();
  if (query.exact) return haystack === needle;
  if (query.prefix) return haystack.startsWith(needle);
  return haystack.includes(needle);
}

function matchesLocalisationKey(key: string, query: LocalisationIndexQuery): boolean {
  if (!query.key) return true;
  const haystack = query.caseSensitive ? key : key.toLowerCase();
  const needle = query.caseSensitive ? query.key : query.key.toLowerCase();
  if (query.prefix) return haystack.startsWith(needle);
  if (query.contains) return haystack.includes(needle);
  return haystack === needle || haystack.includes(needle);
}
