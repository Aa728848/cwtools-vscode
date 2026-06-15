import * as fs from 'fs';
import * as path from 'path';
import type { DiagnosticsQueryResult } from 'cwtools-shared';

function parseJsonc(text: string): unknown {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let i = 0;
  const n = s.length;
  let pendingCommaAt = -1; // index in `out` of a comma that may be trailing
  const dropPendingIfClosing = (ch: string): void => {
    if (pendingCommaAt >= 0) {
      if (ch === '}' || ch === ']') out = out.slice(0, pendingCommaAt) + out.slice(pendingCommaAt + 1);
      pendingCommaAt = -1;
    }
  };
  while (i < n) {
    const c = s[i] as string;
    if (c === '"') {
      dropPendingIfClosing(c);
      out += c;
      i++;
      while (i < n) {
        const d = s[i];
        out += d;
        i++;
        if (d === '\\') { out += s[i] ?? ''; i++; continue; }
        if (d === '"') break;
      }
      continue;
    }
    if (c === '/' && s[i + 1] === '/') { i += 2; while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { out += c; i++; continue; }
    if (c === ',') { pendingCommaAt = out.length; out += c; i++; continue; }
    dropPendingIfClosing(c);
    out += c;
    i++;
  }
  return JSON.parse(out);
}

// Mirrors the in-extension whitelist key written by `cwtools.ai.ignoredDiagnostics`
// (VS Code stores workspace-folder settings as a flat dotted key).
const FLAT_KEY = 'cwtools.ai.ignoredDiagnostics';

interface CachedSettings {
  mtimeMs: number;
  ignored: string[];
}

const cache = new Map<string, CachedSettings>();

export function readIgnoredDiagnostics(workspaceRoot: string): string[] {
  const file = path.join(workspaceRoot, '.vscode', 'settings.json');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return [];
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.ignored;

  let ignored: string[] = [];
  try {
    const value = readIgnoreValue(parseJsonc(fs.readFileSync(file, 'utf8')));
    if (Array.isArray(value)) {
      ignored = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
  } catch {
    ignored = [];
  }
  cache.set(file, { mtimeMs, ignored });
  return ignored;
}

function readIgnoreValue(json: unknown): unknown {
  if (!json || typeof json !== 'object') return undefined;
  const obj = json as Record<string, unknown>;
  if (FLAT_KEY in obj) return obj[FLAT_KEY];
  const ai = obj['cwtools.ai'];
  if (ai && typeof ai === 'object' && 'ignoredDiagnostics' in (ai as Record<string, unknown>)) {
    return (ai as Record<string, unknown>).ignoredDiagnostics;
  }
  const cwtools = obj['cwtools'];
  const nestedAi = cwtools && typeof cwtools === 'object' ? (cwtools as Record<string, unknown>).ai : undefined;
  if (nestedAi && typeof nestedAi === 'object') {
    return (nestedAi as Record<string, unknown>).ignoredDiagnostics;
  }
  return undefined;
}

export function applyDiagnosticIgnoreList(
  result: DiagnosticsQueryResult,
  ignored: readonly string[],
): DiagnosticsQueryResult {
  if (!result.ok || result.diagnostics.length === 0 || ignored.length === 0) return result;
  const kept = result.diagnostics.filter(d => !ignored.some(key => d.message.includes(key)));
  const suppressed = result.diagnostics.length - kept.length;
  if (suppressed === 0) return result;
  return {
    ...result,
    diagnostics: kept,
    suppressedCount: (result.suppressedCount ?? 0) + suppressed,
    totalCount: typeof result.totalCount === 'number'
      ? Math.max(0, result.totalCount - suppressed)
      : result.totalCount,
  };
}
