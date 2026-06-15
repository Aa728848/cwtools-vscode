import * as fs from 'fs';
import * as path from 'path';
import type { LspHost } from 'cwtools-shared';
import { pathToFileUri } from './lspProcessHost';

// File extensions the language server validates — only these are worth revalidating.
const REVALIDATE_EXTS = new Set(['.txt', '.yml', '.gui', '.gfx', '.asset', '.shader', '.fxh']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.cwtools', '.cwtools-ai', '.vscode']);
const MAX_WALK_FILES = 20000;
const MAX_BATCH = 200;

interface Changed {
  path: string;
  mtimeMs: number;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class RevalidationCoordinator {
  private readonly lastReval = new Map<string, number>();

  constructor(
    private readonly lsp: LspHost,
    private readonly workspaceRoot: string,
    private readonly readyAt: () => number | undefined,
  ) {}

  // absFile: absolute path for a single-file query, or undefined for whole-project.
  async ensureFresh(absFile?: string): Promise<void> {
    const baseline = this.readyAt();
    if (baseline === undefined) return; // server still loading; its load is the freshest state we have
    const changed = absFile ? this.changedSingle(absFile, baseline) : this.changedAll(baseline);
    if (changed.length === 0) return;

    const batch = changed.slice(0, MAX_BATCH);
    const uris = batch.map(c => pathToFileUri(c.path));
    let baselineEpoch = 0;
    try {
      const res = await this.lsp.executeCommand<Record<string, unknown>>(
        'cwtools.ai.revalidateFiles', [uris], { timeoutMs: 10_000 },
      );
      if (!res || res.ok !== true) return; // older server without the command → plain read
      baselineEpoch = numberOr(res.baselineEpoch, 0);
    } catch {
      return;
    }
    // Mark seen so unchanged files are skipped next time.
    for (const c of batch) this.lastReval.set(c.path, c.mtimeMs);
    await this.waitDrained(baselineEpoch);
  }

  private changedSingle(absFile: string, baseline: number): Changed[] {
    let mtimeMs: number;
    try {
      const st = fs.statSync(absFile);
      if (!st.isFile()) return [];
      mtimeMs = st.mtimeMs;
    } catch {
      return [];
    }
    const threshold = Math.max(baseline, this.lastReval.get(absFile) ?? 0);
    return mtimeMs > threshold ? [{ path: absFile, mtimeMs }] : [];
  }

  private changedAll(baseline: number): Changed[] {
    const out: Changed[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      if (out.length >= MAX_BATCH || scanned >= MAX_WALK_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_BATCH || scanned >= MAX_WALK_FILES) return;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name));
          continue;
        }
        if (!e.isFile()) continue;
        if (!REVALIDATE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
        scanned++;
        const abs = path.join(dir, e.name);
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(abs).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs > Math.max(baseline, this.lastReval.get(abs) ?? 0)) out.push({ path: abs, mtimeMs });
      }
    };
    walk(this.workspaceRoot);
    return out;
  }

  // Wait until the lint queue drains and the epoch advanced past the revalidation
  // baseline (so the posted re-lints have completed). Bounded; best-effort.
  private async waitDrained(baselineEpoch: number): Promise<void> {
    const timeoutMs = 5000;
    const intervalMs = 50;
    let elapsed = 0;
    await sleep(30); // head start so the lint agent picks up the posted requests
    while (elapsed < timeoutMs) {
      const s = await this.lsp.executeCommand<Record<string, unknown>>(
        'cwtools.ai.getValidationStatus', [], { timeoutMs: 5000 },
      ).catch(() => null);
      if (!s || typeof s !== 'object') return;
      const epoch = numberOr(s.epoch, 0);
      const inProgress = s.inProgress === true;
      const queue = numberOr(s.queueDepth, 0) + numberOr(s.debounceQueueDepth, 0);
      if (epoch > baselineEpoch && !inProgress && queue === 0) return;
      await sleep(intervalMs);
      elapsed += intervalMs;
    }
  }
}
