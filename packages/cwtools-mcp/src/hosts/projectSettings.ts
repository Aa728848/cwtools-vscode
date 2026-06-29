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

interface CachedSettings {
  mtimeMs: number;
  settings: Record<string, unknown> | undefined;
}

const cache = new Map<string, CachedSettings>();
const SETTINGS_NAMESPACE = 'stellarisLanguageServices';
const LEGACY_SETTINGS_NAMESPACE = 'cwtools';

function readSettingsObject(workspaceRoot: string): Record<string, unknown> | undefined {
  const file = path.join(workspaceRoot, '.vscode', 'settings.json');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return undefined;
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.settings;

  let settings: Record<string, unknown> | undefined;
  try {
    const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
    settings = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    settings = undefined;
  }
  cache.set(file, { mtimeMs, settings });
  return settings;
}


function resolveDotted(obj: Record<string, unknown>, fullKey: string): unknown {
  if (fullKey in obj) return obj[fullKey];
  const segs = fullKey.split('.');
  for (let i = 1; i < segs.length; i++) {
    const head = segs.slice(0, i).join('.');
    if (head in obj) {
      const child = obj[head];
      if (child && typeof child === 'object') {
        const r = resolveDotted(child as Record<string, unknown>, segs.slice(i).join('.'));
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}


export function getExtensionSetting(workspaceRoot: string, subKey: string): unknown {
  const settings = readSettingsObject(workspaceRoot);
  if (!settings) return undefined;
  const current = resolveDotted(settings, `${SETTINGS_NAMESPACE}.${subKey}`);
  return current !== undefined
    ? current
    : resolveDotted(settings, `${LEGACY_SETTINGS_NAMESPACE}.${subKey}`);
}

function asNonEmptyStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
}

export function readIgnoredDiagnostics(workspaceRoot: string): string[] {
  return asNonEmptyStringArray(getExtensionSetting(workspaceRoot, 'ai.ignoredDiagnostics'));
}


const LANG_TAG_MAP: ReadonlyArray<readonly [string, string]> = [
  ['English', 'english'],
  ['French', 'french'],
  ['German', 'german'],
  ['Spanish', 'spanish'],
  ['Russian', 'russian'],
  ['Braz_Por', 'braz_por'],
  ['Polish', 'polish'],
  ['Chinese', 'simp_chinese'],
  ['Korean', 'korean'],
  ['Japanese', 'japanese'],
  ['Turkish', 'turkish'],
];

const LOC_DIRS = ['localisation', 'localisation_synced', 'localization'];
const MAX_LOC_FILES = 5000;

// Count localisation files by language tag and return the dominant non-English
// language, or undefined (English is the server default). Bounded recursive scan.
function detectLocalisationLanguage(workspaceRoot: string): string | undefined {
  const counts = new Map<string, number>();
  let scanned = 0;
  const visit = (dir: string): void => {
    if (scanned >= MAX_LOC_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= MAX_LOC_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        visit(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.yml')) {
        scanned++;
        const base = e.name.toLowerCase();
        for (const [name, tag] of LANG_TAG_MAP) {
          if (base.endsWith(`l_${tag}.yml`)) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
            break;
          }
        }
      }
    }
  };
  for (const d of LOC_DIRS) visit(path.join(workspaceRoot, d));

  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) { bestCount = count; best = name; }
  }
  return best && best !== 'English' ? best : undefined;
}

export interface LocalisationConfig {
  languages: string[];
  source: 'settings' | 'detected' | 'default';
}

export function resolveLocalisationLanguages(workspaceRoot: string): LocalisationConfig {
  const fromSettings = asNonEmptyStringArray(getExtensionSetting(workspaceRoot, 'localisation.languages'));
  if (fromSettings.length > 0) return { languages: fromSettings, source: 'settings' };

  const detected = detectLocalisationLanguage(workspaceRoot);
  if (detected) return { languages: [detected], source: 'detected' };

  return { languages: ['English'], source: 'default' };
}

export function resolveGeneratedStrings(workspaceRoot: string): string {
  const v = getExtensionSetting(workspaceRoot, 'localisation.generated_strings');
  return typeof v === 'string' && v.length > 0 ? v : 'replace';
}

// `stellarisLanguageServices.experimental` setting. Defaults ON for the MCP: it gates the incremental
// scripted-type refresh, which lets revalidation of scripted_triggers/effects/values
// patch the type index in milliseconds instead of triggering a full reload — so
// definition-file edits don't mis-report references. Honor an explicit opt-out.
export function resolveExperimental(workspaceRoot: string): boolean {
  const v = getExtensionSetting(workspaceRoot, 'experimental');
  return typeof v === 'boolean' ? v : true;
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
