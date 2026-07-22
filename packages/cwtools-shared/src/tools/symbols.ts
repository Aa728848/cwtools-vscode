import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import { isPathInsideOrEqual, resolveWorkspacePath } from '../safety/paths';
import { toolDenied, type SharedToolResult } from './schema';

interface PositionLike {
  line?: number;
  character?: number;
}

interface RangeLike {
  start?: PositionLike;
  end?: PositionLike;
}

interface LocationLike {
  uri?: string;
  range?: RangeLike;
}

interface LspDocumentSymbolLike {
  name?: string;
  kind?: number | string;
  range?: RangeLike;
  selectionRange?: RangeLike;
  children?: LspDocumentSymbolLike[];
}

interface LspSymbolInformationLike {
  name?: string;
  kind?: number | string;
  location?: LocationLike;
  containerName?: string;
}

export interface DocumentSymbolInfo {
  name: string;
  kind: string;
  range: {
    startLine: number;
    endLine: number;
    startColumn?: number;
    endColumn?: number;
  };
  children?: DocumentSymbolInfo[];
  _hasDeeper?: boolean;
}

export interface WorkspaceSymbolInfo {
  name: string;
  kind: string;
  file: string;
  line: number;
  column?: number;
  containerName?: string;
  source?: string;
}

export type SymbolOrigin = 'workspace' | 'vanilla' | 'generated' | 'external';

const SYMBOL_KINDS = [
  'Unknown',
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
];

export async function getCompletionAtWithHost(
  host: HostServices,
  args: { file: string; line: number; column: number; limit?: number },
): Promise<SharedToolResult> {
  const resolution = resolveReadableFile(host, args.file);
  if ('error' in resolution) return resolution.error;

  const limit = clampNumber(args.limit, 30, 1, 200);
  const fileUri = toFileUri(resolution.resolvedPath);
  const localContext = await buildLocalCompletionContext(host, resolution.resolvedPath, args.line, args.column);
  const rawContext = await host.lsp.executeCommand<Record<string, unknown>>(
    'cwtools.ai.getCompletionContext',
    [fileUri, args.line, args.column],
    { timeoutMs: 5_000 },
  );
  const contextUnavailable = isUnavailable(rawContext);
  const context = !contextUnavailable && rawContext && typeof rawContext === 'object' && rawContext.ok === true
    ? { ...localContext, ...rawContext, source: 'cwtools.ai.getCompletionContext' }
    : localContext;
  const diagnostics = await host.diagnostics.getDiagnostics({ file: resolution.resolvedPath }).catch(() => undefined);

  const completionResult = await requestLsp(host, 'textDocument/completion', {
    textDocument: { uri: fileUri },
    position: { line: args.line, character: args.column },
    context: { triggerKind: 1 },
  }, 10_000);
  const completions = normalizeCompletions(completionResult.data).slice(0, limit);

  return {
    ok: !completionResult.unavailable || completions.length > 0,
    status: completionResult.unavailable && completions.length === 0 ? 'unavailable' : 'ready',
    source: completionResult.unavailable ? 'cwtools-completion-context' : 'cwtools-lsp-completion',
    data: {
      completions,
      context,
      totalAvailable: normalizeCompletions(completionResult.data).length,
      freshness: diagnostics?.freshness,
      diagnosticsStatus: diagnostics?.status,
      candidateSource: completionResult.unavailable ? 'local_context_only' : 'textDocument/completion',
      ...(completionResult.unavailable ? {
        _warning: 'Completion provider is unavailable; returning local position context only.',
        _nextSteps: ['Start CWTools LSP, wait for diagnostics to become fresh, then retry get_completion_at.'],
      } : {}),
    },
    error: completionResult.unavailable && completions.length === 0
      ? { code: 'lsp_unavailable', message: completionResult.message ?? 'Completion provider is unavailable.' }
      : undefined,
  };
}

export async function documentSymbolsWithHost(
  host: HostServices,
  args: { file: string },
): Promise<SharedToolResult<{ symbols: DocumentSymbolInfo[]; lineNumberBase: 0; source: string; warnings?: string[] }>> {
  const resolution = resolveReadableFile(host, args.file);
  if ('error' in resolution) {
    return resolution.error as SharedToolResult<{ symbols: DocumentSymbolInfo[]; lineNumberBase: 0; source: string; warnings?: string[] }>;
  }

  const requested = await requestLsp(host, 'textDocument/documentSymbol', {
    textDocument: { uri: toFileUri(resolution.resolvedPath) },
  }, 10_000);
  const lspSymbols = normalizeDocumentSymbols(requested.data, host.workspaceRoot);
  if (!requested.unavailable && lspSymbols.length > 0) {
    return {
      ok: true,
      status: 'ready',
      source: 'cwtools-lsp-symbols',
      data: { symbols: lspSymbols, lineNumberBase: 0, source: 'cwtools-lsp-symbols' },
    };
  }

  const read = await host.filesystem.readTextFile(resolution.resolvedPath);
  const symbols = read.exists ? inferDocumentSymbolsFromText(read.hasBom ? read.content.slice(1) : read.content) : [];
  return {
    ok: true,
    status: 'ready',
    source: 'cwtools-node-symbols',
    data: {
      symbols,
      lineNumberBase: 0,
      source: 'cwtools-node-symbols',
      warnings: [
        requested.unavailable
          ? 'LSP document symbols are unavailable; returned Node-inferred block symbols.'
          : 'LSP returned no document symbols; returned Node-inferred block symbols.',
      ],
    },
  };
}

export async function workspaceSymbolsWithHost(
  host: HostServices,
  args: { query: string; limit?: number },
): Promise<SharedToolResult<{ symbols: WorkspaceSymbolInfo[]; source: string; warnings?: string[] }>> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return toolDenied('invalid_arguments', 'workspace_symbols requires a non-empty query.') as SharedToolResult<{ symbols: WorkspaceSymbolInfo[]; source: string }>;
  }

  const limit = clampNumber(args.limit, 20, 1, 100);
  const requested = await requestLsp(host, 'workspace/symbol', { query }, 10_000);
  const symbols = normalizeWorkspaceSymbols(requested.data, host.workspaceRoot).slice(0, limit);
  if (!requested.unavailable && symbols.length > 0) {
    return {
      ok: true,
      status: 'ready',
      source: 'cwtools-lsp-symbols',
      data: { symbols, source: 'cwtools-lsp-symbols' },
    };
  }

  if (host.indexing) {
    const indexed = await host.indexing.queryWorkspace({ name: query, limit });
    const status: SharedToolResult['status'] = indexed.status === 'ready'
      ? 'ready'
      : indexed.status === 'partial'
        ? 'partial'
        : indexed.status === 'error'
          ? 'error'
          : indexed.status === 'unavailable'
            ? 'unavailable'
            : 'loading';
    return {
      ok: true,
      status,
      source: 'cwtools-index',
      data: {
        symbols: indexed.entries.map(entry => ({
          name: entry.name,
          kind: entry.kind,
          file: entry.file,
          line: entry.line,
          source: entry.source,
          containerName: entry.container,
        })),
        source: 'cwtools-index',
        warnings: [indexed._hint ?? 'LSP workspace symbols unavailable; returned thin index matches.'],
      },
    };
  }

  return {
    ok: false,
    status: 'unavailable',
    source: 'cwtools-lsp-symbols',
    data: {
      symbols: [],
      source: 'cwtools-lsp-symbols',
      warnings: ['No LSP or workspace index is available for workspace_symbols.'],
    },
    error: { code: 'lsp_unavailable', message: requested.message ?? 'Workspace symbol provider is unavailable.' },
  };
}

export async function queryDefinitionWithHost(
  host: HostServices,
  args: { file: string; line: number; column: number },
): Promise<SharedToolResult> {
  const resolution = resolveReadableFile(host, args.file);
  if ('error' in resolution) return resolution.error;
  const fileUri = toFileUri(resolution.resolvedPath);

  const commandResult = await host.lsp.executeCommand<unknown>(
    'cwtools.ai.queryDefinition',
    [fileUri, args.line, args.column],
    { timeoutMs: 10_000 },
  );
  if (!isUnavailable(commandResult)) {
    return {
      ok: true,
      status: 'ready',
      source: 'cwtools-lsp-definition',
      data: commandResult,
    };
  }

  const requested = await requestLsp(host, 'textDocument/definition', {
    textDocument: { uri: fileUri },
    position: { line: args.line, character: args.column },
  }, 10_000);
  const locations = normalizeLocations(requested.data, host.workspaceRoot);
  return {
    ok: !requested.unavailable,
    status: requested.unavailable ? 'unavailable' : 'ready',
    source: 'cwtools-lsp-definition',
    data: { locations },
    error: requested.unavailable
      ? { code: 'lsp_unavailable', message: requested.message ?? 'Definition provider is unavailable.' }
      : undefined,
  };
}

export async function queryDefinitionByNameWithHost(
  host: HostServices,
  args: { symbolName: string },
): Promise<SharedToolResult> {
  const symbolName = String(args.symbolName ?? '').trim();
  if (!symbolName) return toolDenied('invalid_arguments', 'query_definition_by_name requires symbolName.');

  const commandResult = await host.lsp.executeCommand<unknown>(
    'cwtools.ai.queryDefinitionByName',
    [symbolName],
    { timeoutMs: 10_000 },
  );
  if (!isUnavailable(commandResult)) {
    return {
      ok: true,
      status: 'ready',
      source: 'cwtools-lsp-definition',
      data: commandResult,
    };
  }

  const symbols = await workspaceSymbolsWithHost(host, { query: symbolName, limit: 20 });
  const matches = symbols.data?.symbols.filter(symbol => symbol.name === symbolName) ?? [];
  return {
    ok: matches.length > 0,
    status: symbols.status,
    source: symbols.source,
    data: {
      symbolName,
      matches,
      _warning: matches.length === 0 ? 'No exact definition match found in the fallback workspace symbol index.' : undefined,
    },
    error: matches.length === 0
      ? { code: 'definition_not_found', message: `No definition found for '${symbolName}'.` }
      : undefined,
  };
}

export async function queryReferencesWithHost(
  host: HostServices,
  args: { identifier: string; file?: string; limit?: number },
): Promise<SharedToolResult> {
  const identifier = String(args.identifier ?? '').trim();
  if (!identifier) return toolDenied('invalid_arguments', 'query_references requires identifier.');
  const limit = clampNumber(args.limit, 50, 1, 200);

  const definition = await queryDefinitionByNameWithHost(host, { symbolName: identifier });
  const firstMatch = definition.data && typeof definition.data === 'object'
    ? getFirstDefinitionMatch(definition.data as Record<string, unknown>)
    : undefined;
  if (firstMatch?.file !== undefined && firstMatch.line !== undefined && host.lsp.request) {
    const absolute = path.isAbsolute(firstMatch.file)
      ? firstMatch.file
      : path.resolve(host.workspaceRoot, firstMatch.file);
    const requested = await requestLsp(host, 'textDocument/references', {
      textDocument: { uri: toFileUri(absolute) },
      position: { line: firstMatch.line, character: firstMatch.column ?? 0 },
      context: { includeDeclaration: true },
    }, 10_000);
    const references = normalizeLocations(requested.data, host.workspaceRoot).slice(0, limit);
    if (!requested.unavailable && references.length > 0) {
      return {
        ok: true,
        status: 'ready',
        source: 'cwtools-lsp-references',
        data: { identifier, references, total: references.length },
      };
    }
  }

  const references = await textSearchReferences(host, identifier, args.file, limit);
  return {
    ok: true,
    status: 'ready',
    source: 'cwtools-text-references',
    data: {
      identifier,
      references,
      total: references.length,
      _warning: 'Fallback text references are lexical evidence, not semantic CWTools reference resolution.',
    },
  };
}

export function inferDocumentSymbolsFromText(content: string): DocumentSymbolInfo[] {
  const lines = content.split(/\r?\n/);
  const symbols: DocumentSymbolInfo[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const topLevel = line.match(/^([@\w][\w.:-]*)\s*=\s*\{/);
    if (!topLevel?.[1]) continue;
    const startLine = index;
    if (startLine === undefined || symbols.some(symbol => symbol.range.startLine === startLine)) continue;
    const endLine = findBlockEnd(lines, startLine);
    const id = findIdInRange(lines, startLine, endLine);
    const name = id ?? topLevel[1];
    symbols.push({
      name,
      kind: id ? 'Event' : 'Object',
      range: { startLine, endLine, startColumn: 0, endColumn: lines[endLine]?.length ?? 0 },
    });
    index = endLine;
  }
  return symbols;
}

function resolveReadableFile(host: HostServices, file: string): {
  ok: true;
  resolvedPath: string;
} | {
  ok: false;
  error: SharedToolResult;
} {
  const resolution = resolveWorkspacePath(host.workspaceRoot, file);
  if (!resolution.ok || !resolution.resolvedPath) {
    return {
      ok: false,
      error: toolDenied('outside_workspace', `Path '${file}' is outside the workspace root.`),
    };
  }
  return { ok: true, resolvedPath: resolution.resolvedPath };
}

async function buildLocalCompletionContext(
  host: HostServices,
  filePath: string,
  line: number,
  column: number,
): Promise<Record<string, unknown>> {
  const read = await host.filesystem.readTextFile(filePath);
  const content = read.hasBom ? read.content.slice(1) : read.content;
  const lines = content.split(/\r?\n/);
  const lineText = lines[line] ?? '';
  const boundedColumn = Math.max(0, Math.min(column, lineText.length));
  const linePrefix = lineText.slice(0, boundedColumn);
  return {
    file: filePath,
    line,
    column,
    linePrefix,
    tokenPrefix: linePrefix.match(/[A-Za-z0-9_.:-]+$/)?.[0],
    source: 'local_text_context',
  };
}

async function requestLsp(
  host: HostServices,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<{ unavailable: boolean; data?: unknown; message?: string }> {
  if (!host.lsp.request) {
    return { unavailable: true, message: 'LSP host does not expose generic request support.' };
  }
  const data = await host.lsp.request(method, params, { timeoutMs });
  if (isUnavailable(data)) {
    const record = asRecord(data);
    const error = asRecord(record.error);
    return { unavailable: true, data, message: String(error.message ?? `${method} is unavailable.`) };
  }
  return { unavailable: false, data };
}

function normalizeDocumentSymbols(value: unknown, workspaceRoot: string): DocumentSymbolInfo[] {
  if (!Array.isArray(value)) return [];
  if (value.some(item => asRecord(item).location)) {
    return normalizeWorkspaceSymbols(value, workspaceRoot).map(symbol => ({
      name: symbol.name,
      kind: symbol.kind,
      range: {
        startLine: symbol.line,
        endLine: symbol.line,
        startColumn: symbol.column,
        endColumn: symbol.column,
      },
    }));
  }
  const mapSymbol = (symbol: LspDocumentSymbolLike, depth: number): DocumentSymbolInfo | undefined => {
    if (!symbol.name || !symbol.range) return undefined;
    const children = depth < 2 && Array.isArray(symbol.children)
      ? symbol.children.map(child => mapSymbol(child, depth + 1)).filter(isDefined)
      : undefined;
    return {
      name: symbol.name,
      kind: kindName(symbol.kind),
      range: {
        startLine: numberOr(symbol.range.start?.line, 0),
        endLine: numberOr(symbol.range.end?.line, numberOr(symbol.range.start?.line, 0)),
        startColumn: numberOrUndefined(symbol.range.start?.character),
        endColumn: numberOrUndefined(symbol.range.end?.character),
      },
      children: children && children.length > 0 ? children : undefined,
      _hasDeeper: depth >= 2 && Array.isArray(symbol.children) && symbol.children.length > 0 ? true : undefined,
    };
  };
  return value.map(item => mapSymbol(item as LspDocumentSymbolLike, 0)).filter(isDefined);
}

function normalizeWorkspaceSymbols(value: unknown, workspaceRoot: string): WorkspaceSymbolInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const symbol = item as LspSymbolInformationLike;
    const location = symbol.location;
    const filePath = location?.uri ? uriToPath(location.uri) : '';
    return {
      name: String(symbol.name ?? ''),
      kind: kindName(symbol.kind),
      file: filePath ? path.relative(workspaceRoot, filePath).replace(/\\/g, '/') : '',
      line: numberOr(location?.range?.start?.line, 0),
      column: numberOrUndefined(location?.range?.start?.character),
      containerName: typeof symbol.containerName === 'string' ? symbol.containerName : undefined,
    };
  }).filter(symbol => symbol.name.length > 0);
}

function normalizeLocations(value: unknown, workspaceRoot: string): Array<{
  file: string;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  source: string;
  origin: SymbolOrigin;
}> {
  const array = Array.isArray(value) ? value : value ? [value] : [];
  return array.map(item => {
    const record = asRecord(item);
    const targetUri = typeof record.targetUri === 'string' ? record.targetUri : undefined;
    const uri = typeof record.uri === 'string' ? record.uri : targetUri;
    const rawRange = asRecord(record.range ?? record.targetRange);
    const start = asRecord(rawRange.start);
    const end = asRecord(rawRange.end);
    const filePath = uri ? uriToPath(uri) : '';
    const origin = classifyOrigin(filePath, workspaceRoot);
    return {
      file: filePath ? path.relative(workspaceRoot, filePath).replace(/\\/g, '/') : '',
      range: {
        startLine: numberOr(start.line, 0),
        startColumn: numberOr(start.character, 0),
        endLine: numberOr(end.line, numberOr(start.line, 0)),
        endColumn: numberOr(end.character, numberOr(start.character, 0)),
      },
      source: 'lsp',
      origin,
    };
  }).filter(location => location.file.length > 0);
}

function normalizeCompletions(value: unknown): Array<Record<string, unknown>> {
  const rawItems = Array.isArray(value)
    ? value
    : Array.isArray(asRecord(value).items)
      ? asRecord(value).items as unknown[]
      : [];
  return rawItems.map(item => {
    const record = asRecord(item);
    const labelRecord = asRecord(record.label);
    const textEdit = asRecord(record.textEdit);
    return {
      label: typeof record.label === 'string' ? record.label : String(labelRecord.label ?? ''),
      kind: kindName(record.kind),
      description: typeof record.detail === 'string' ? record.detail : undefined,
      insertText: typeof record.insertText === 'string'
        ? record.insertText
        : typeof textEdit.newText === 'string'
          ? textEdit.newText
          : undefined,
      filterText: typeof record.filterText === 'string' ? record.filterText : undefined,
      sortText: typeof record.sortText === 'string' ? record.sortText : undefined,
    };
  }).filter(item => String(item.label).length > 0);
}

async function textSearchReferences(
  host: HostServices,
  identifier: string,
  file: string | undefined,
  limit: number,
): Promise<Array<{ file: string; line: number; column: number; content: string; source: string; origin: SymbolOrigin }>> {
  const files = file ? [file] : await host.filesystem.glob('**/*', { limit: 5000 });
  const references: Array<{ file: string; line: number; column: number; content: string; source: string; origin: SymbolOrigin }> = [];
  for (const candidate of files) {
    if (references.length >= limit) break;
    if (!/\.(txt|yml|gui|gfx|asset)$/i.test(candidate)) continue;
    const resolution = resolveWorkspacePath(host.workspaceRoot, candidate);
    if (!resolution.ok || !resolution.resolvedPath) continue;
    const read = await host.filesystem.readTextFile(resolution.resolvedPath);
    if (!read.exists) continue;
    const content = read.hasBom ? read.content.slice(1) : read.content;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && references.length < limit; index++) {
      const column = (lines[index] ?? '').indexOf(identifier);
      if (column < 0) continue;
      references.push({
        file: resolution.relativePath ?? candidate,
        line: index,
        column,
        content: (lines[index] ?? '').trim().slice(0, 240),
        source: 'text-search',
        origin: classifyOrigin(resolution.resolvedPath, host.workspaceRoot),
      });
    }
  }
  return references;
}

function classifyOrigin(filePath: string, workspaceRoot: string): SymbolOrigin {
  if (!filePath) return 'external';
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (isPathInsideOrEqual(workspaceRoot, filePath)) {
    return normalized.includes('/generated/') || normalized.includes('/.cwtools/') || normalized.includes('/.cwtools-ai/')
      ? 'generated'
      : 'workspace';
  }
  if (normalized.includes('/vanilla/') || normalized.includes('/cache/') || normalized.includes('/steamapps/common/')) {
    return 'vanilla';
  }
  if (normalized.includes('/generated/') || normalized.includes('/.cwtools/') || normalized.includes('/.cwtools-ai/')) return 'generated';
  return 'external';
}

function getFirstDefinitionMatch(data: Record<string, unknown>): { file?: string; line?: number; column?: number } | undefined {
  if (typeof data.file === 'string') {
    return {
      file: data.file,
      line: numberOrUndefined(data.line),
      column: numberOrUndefined(data.column),
    };
  }
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const first = asRecord(matches[0]);
  if (typeof first.file !== 'string') return undefined;
  return {
    file: first.file,
    line: numberOrUndefined(first.line),
    column: numberOrUndefined(first.column),
  };
}

function findIdInRange(lines: string[], startLine: number, endLine: number): string | undefined {
  for (let index = startLine; index <= endLine; index++) {
    const id = (lines[index] ?? '').match(/^\s*id\s*=\s*"?([\w.:-]+)"?/);
    if (id?.[1]) return id[1];
  }
  return undefined;
}

function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let sawOpen = false;
  for (let index = startLine; index < lines.length; index++) {
    const counts = countBraces(lines[index] ?? '');
    depth += counts.open - counts.close;
    sawOpen ||= counts.open > 0;
    if (sawOpen && depth <= 0) return index;
  }
  return startLine;
}

function countBraces(line: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (!inString && char === '#') break;
    if (char === '"' && !escaped) inString = !inString;
    else if (!inString && char === '{') open++;
    else if (!inString && char === '}') close++;
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  return { open, close };
}

function toFileUri(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  const withLeadingSlash = resolved.startsWith('/') ? resolved : `/${resolved}`;
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23')}`;
}

function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let decoded = decodeURIComponent(uri.slice('file://'.length));
  if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
  return decoded.replace(/\//g, path.sep);
}

function isUnavailable(value: unknown): boolean {
  const record = asRecord(value);
  const error = asRecord(record.error);
  return record.status === 'unavailable' || error.code === 'lsp_unavailable';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function kindName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return SYMBOL_KINDS[value] ?? String(value);
  return 'Unknown';
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function numberOr(value: unknown, fallback: number): number {
  return numberOrUndefined(value) ?? fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
