import type { HostServices } from '../host/hostServices';
import { validateLocalisationPath } from './paths';
import { ensureToolWriteAllowed } from './writes';
import type { SharedToolResult } from '../tools/schema';
import { toolDenied } from '../tools/schema';

export interface LocalisationEntry {
  key: string;
  value: string;
  number?: number;
  comment?: string;
}

export interface UpsertLocalisationResult {
  content: string;
  added: number;
  updated: number;
  hasBom: boolean;
  language: string;
  keys: string[];
}

export interface WriteLocalisationArgs {
  filePath: string;
  language?: string;
  entries: LocalisationEntry[];
}

export interface WriteLocalisationResult {
  success: boolean;
  message: string;
  filePath?: string;
  relativePath?: string;
  added?: number;
  updated?: number;
  keys?: string[];
}

const BOM = '\uFEFF';

export function sanitizeLocalisationValue(value: string): string {
  return value
    .replace(/\r\n/g, String.raw`\n`)
    .replace(/\n/g, String.raw`\n`)
    .replace(/\r/g, '')
    .replace(/\t/g, String.raw`\t`)
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2018|\u2019/g, "'");
}

export function upsertLocalisationText(
  existingContent: string | null | undefined,
  language = 'l_english',
  entries: LocalisationEntry[],
): UpsertLocalisationResult {
  const raw = existingContent ?? '';
  const existingHasBom = raw.charCodeAt(0) === 0xfeff;
  const isNewFile = raw.length === 0;
  const clean = existingHasBom ? raw.slice(1) : raw;
  const lines = clean.length > 0 ? clean.split(/\r?\n/) : [];
  const header = `${language}:`;

  const firstNonEmpty = lines.findIndex(line => line.trim().length > 0);
  if (firstNonEmpty === -1) {
    lines.splice(0, lines.length, header);
  } else if (!/^l_[a-z_]+:\s*$/i.test(lines[firstNonEmpty]!.trim())) {
    lines.splice(firstNonEmpty, 0, header);
  }

  const keyLineMap = new Map<string, number>();
  const keyRegex = /^\s*([\w.-]+):\d*\s*"/;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(keyRegex);
    if (match?.[1]) keyLineMap.set(match[1], index);
  }

  const appendLines: string[] = [];
  let added = 0;
  let updated = 0;

  for (const entry of entries) {
    const number = entry.number ?? 0;
    const formattedLine = ` ${entry.key}:${number} "${sanitizeLocalisationValue(entry.value)}"`;
    const existingIndex = keyLineMap.get(entry.key);
    if (existingIndex !== undefined) {
      lines[existingIndex] = formattedLine;
      updated++;
    } else {
      if (entry.comment) appendLines.push(` ${entry.comment}`);
      appendLines.push(formattedLine);
      added++;
    }
  }

  if (appendLines.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    lines.push(...appendLines);
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();

  const hasBom = existingHasBom || isNewFile;
  const body = `${lines.join('\n')}\n`;
  return {
    content: `${hasBom ? BOM : ''}${body}`,
    added,
    updated,
    hasBom,
    language,
    keys: entries.map(entry => entry.key),
  };
}

export async function writeLocalisationWithHost(
  host: HostServices,
  args: WriteLocalisationArgs,
): Promise<SharedToolResult<WriteLocalisationResult>> {
  const writeDenied = ensureToolWriteAllowed(host, 'write_localisation');
  if (writeDenied) return writeDenied as SharedToolResult<WriteLocalisationResult>;

  if (!Array.isArray(args.entries) || args.entries.length === 0) {
    return toolDenied('invalid_arguments', 'write_localisation requires at least one entry.') as SharedToolResult<WriteLocalisationResult>;
  }

  const pathValidation = validateLocalisationPath(host.workspaceRoot, args.filePath);
  if (!pathValidation.ok || !pathValidation.resolvedPath) {
    return toolDenied(pathValidation.reason ?? 'invalid_path', pathValidation.message ?? 'Invalid localisation path.') as SharedToolResult<WriteLocalisationResult>;
  }

  const existing = await host.filesystem.readTextFile(pathValidation.resolvedPath);
  const upsert = upsertLocalisationText(existing.exists ? existing.content : null, args.language ?? 'l_english', args.entries);
  await host.filesystem.writeTextFile(pathValidation.resolvedPath, upsert.content);
  await host.indexing?.invalidate?.(pathValidation.resolvedPath);

  return {
    ok: true,
    status: 'success',
    source: 'cwtools-shared',
    data: {
      success: true,
      message: `Localisation updated: ${upsert.added} added, ${upsert.updated} updated.`,
      filePath: pathValidation.resolvedPath,
      relativePath: pathValidation.relativePath,
      added: upsert.added,
      updated: upsert.updated,
      keys: upsert.keys,
    },
  };
}
