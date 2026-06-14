import type { HostServices } from '../host/hostServices';
import { resolveWorkspacePath } from '../safety/paths';
import { toolDenied, type SharedToolResult } from './schema';
import { documentSymbolsWithHost, type DocumentSymbolInfo } from './symbols';

export interface GetPdxBlockArgs {
  file: string;
  symbol: string;
}

export interface GetPdxBlockResult {
  content: string;
  truncated: boolean;
  startLine?: number;
  endLine?: number;
  lineNumberBase: 1;
  source: 'cwtools-lsp-symbols' | 'cwtools-node-block';
  warnings?: string[];
  error?: string;
}

export async function getPdxBlockWithHost(
  host: HostServices,
  args: GetPdxBlockArgs,
): Promise<SharedToolResult<GetPdxBlockResult>> {
  const resolution = resolveWorkspacePath(host.workspaceRoot, args.file);
  if (!resolution.ok || !resolution.resolvedPath) {
    return toolDenied('outside_workspace', `Path '${args.file}' is outside the workspace root.`) as SharedToolResult<GetPdxBlockResult>;
  }

  const read = await host.filesystem.readTextFile(resolution.resolvedPath);
  if (!read.exists) {
    return {
      ok: false,
      status: 'error',
      source: 'cwtools-node-block',
      error: { code: 'file_not_found', message: `File not found: ${args.file}` },
    };
  }

  const content = read.hasBom ? read.content.slice(1) : read.content;
  const lines = content.split(/\r?\n/);
  const symbolRange = await resolveSymbolRange(host, resolution.resolvedPath, args.symbol);
  const startLine = symbolRange?.startLine ?? findBlockStart(lines, args.symbol);
  if (startLine === undefined) {
    return {
      ok: false,
      status: 'error',
      source: 'cwtools-node-block',
      error: { code: 'symbol_not_found', message: `Symbol '${args.symbol}' not found in file.` },
      data: {
        content: `Error: Symbol '${args.symbol}' not found in file.`,
        truncated: false,
        lineNumberBase: 1,
        source: 'cwtools-node-block',
        error: `Symbol '${args.symbol}' not found in file.`,
      },
    };
  }

  const endLine = symbolRange?.endLine ?? findBlockEnd(lines, startLine);
  const blockLines = lines.slice(startLine, endLine + 1);
  const fullText = blockLines.join('\n');
  const maxChars = 16_000;
  const truncated = fullText.length > maxChars;
  const source = symbolRange?.source === 'cwtools-lsp-symbols' ? 'cwtools-lsp-symbols' : 'cwtools-node-block';
  return {
    ok: true,
    status: 'ready',
    source,
    data: {
      content: truncated ? `${fullText.slice(0, maxChars)}\n... [Block truncated due to size]` : fullText,
      truncated,
      startLine: startLine + 1,
      endLine: endLine + 1,
      lineNumberBase: 1,
      source,
      warnings: source === 'cwtools-node-block'
        ? ['LSP document symbols were unavailable or did not contain this symbol; block boundaries were inferred in Node.']
        : undefined,
    },
  };
}

async function resolveSymbolRange(
  host: HostServices,
  file: string,
  symbolName: string,
): Promise<{ startLine: number; endLine: number; source: string } | undefined> {
  const symbolsResult = await documentSymbolsWithHost(host, { file }).catch(() => undefined);
  const symbol = symbolsResult?.data ? findSymbol(symbolsResult.data.symbols, symbolName) : undefined;
  if (!symbol) return undefined;
  return {
    startLine: symbol.range.startLine,
    endLine: symbol.range.endLine,
    source: symbolsResult!.source,
  };
}

function findSymbol(symbols: DocumentSymbolInfo[], targetName: string): DocumentSymbolInfo | undefined {
  for (const symbol of symbols) {
    if (symbol.name === targetName) return symbol;
    const child = symbol.children ? findSymbol(symbol.children, targetName) : undefined;
    if (child) return child;
  }
  return undefined;
}

function findBlockStart(lines: string[], symbol: string): number | undefined {
  const escaped = escapeRegExp(symbol);
  const topLevelPattern = new RegExp(`^\\s*${escaped}\\s*=`);
  const idPattern = new RegExp(`\\bid\\s*=\\s*"?${escaped}"?\\b`);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (topLevelPattern.test(line)) return index;
    if (idPattern.test(line)) {
      for (let back = index; back >= 0; back--) {
        if (/\w+\s*=\s*\{/.test(lines[back] ?? '')) return back;
      }
      return index;
    }
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
    if (char === '"' && !escaped) {
      inString = !inString;
    } else if (!inString && char === '{') {
      open++;
    } else if (!inString && char === '}') {
      close++;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  return { open, close };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
