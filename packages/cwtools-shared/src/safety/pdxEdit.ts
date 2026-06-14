import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import { documentSymbolsWithHost, type DocumentSymbolInfo } from '../tools/symbols';
import { toolDenied, type SharedToolResult } from '../tools/schema';
import { isScratchRelativePath, resolveWorkspacePath } from './paths';
import { ensureToolWriteAllowed } from './writes';

export interface EditPdxBlockArgs {
  file: string;
  symbol: string;
  newContent: string;
}

export interface EditPdxBlockResult {
  success: boolean;
  message: string;
  filePath?: string;
  relativePath?: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  lineNumberBase?: 1;
}

export async function editPdxBlockWithHost(
  host: HostServices,
  args: EditPdxBlockArgs,
): Promise<SharedToolResult<EditPdxBlockResult>> {
  const denied = ensureToolWriteAllowed(host, 'edit_pdx_block');
  if (denied) return denied as SharedToolResult<EditPdxBlockResult>;

  const resolution = resolveWorkspacePath(host.workspaceRoot, args.file);
  if (!resolution.ok || !resolution.resolvedPath || !resolution.relativePath) {
    return toolDenied('outside_workspace', `Path '${args.file}' is outside the workspace root.`) as SharedToolResult<EditPdxBlockResult>;
  }
  if (isScratchRelativePath(resolution.relativePath)) {
    return toolDenied('scratch_path', 'edit_pdx_block must not write under .cwtools-ai scratch or topic folders.') as SharedToolResult<EditPdxBlockResult>;
  }
  if (path.extname(resolution.resolvedPath).toLowerCase() === '.yml') {
    return toolDenied('localisation_file', 'Use write_localisation for .yml localisation files.') as SharedToolResult<EditPdxBlockResult>;
  }
  if (!args.symbol.trim()) {
    return toolDenied('invalid_arguments', 'edit_pdx_block requires a non-empty symbol.') as SharedToolResult<EditPdxBlockResult>;
  }

  const replacement = stripLineNumberPrefixes(args.newContent).trimEnd();
  const validationError = validateReplacementBlock(replacement, args.symbol);
  if (validationError) {
    return toolDenied('invalid_replacement', validationError) as SharedToolResult<EditPdxBlockResult>;
  }

  const symbolsResult = await documentSymbolsWithHost(host, { file: resolution.resolvedPath });
  const symbols = symbolsResult.data?.symbols ?? [];
  const target = findSymbol(symbols, args.symbol);
  if (!target) {
    return {
      ok: false,
      status: 'error',
      source: 'cwtools-shared',
      error: { code: 'symbol_not_found', message: `Symbol '${args.symbol}' not found in file.` },
      data: {
        success: false,
        message: buildSymbolNotFoundMessage(args.symbol, symbols),
        filePath: resolution.resolvedPath,
        relativePath: resolution.relativePath,
        symbol: args.symbol,
      },
    };
  }

  const read = await host.filesystem.readTextFile(resolution.resolvedPath);
  if (!read.exists) {
    return {
      ok: false,
      status: 'error',
      source: 'cwtools-shared',
      error: { code: 'file_not_found', message: `File not found: ${args.file}` },
    };
  }

  const rawContent = read.hasBom ? read.content.slice(1) : read.content;
  const separator = rawContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawContent.split(separator);
  const startLine = target.range.startLine;
  const endLine = target.range.endLine;
  const targetContent = lines.slice(startLine, endLine + 1).join(separator);
  if (!targetContent.includes(args.symbol)) {
    return {
      ok: false,
      status: 'stale',
      source: 'cwtools-shared',
      error: {
        code: 'stale_symbol_range',
        message: `Resolved range ${startLine + 1}-${endLine + 1} does not contain symbol '${args.symbol}'.`,
      },
      data: {
        success: false,
        message: `edit_pdx_block aborted: current symbol range is stale. Re-run document_symbols and retry '${args.symbol}'.`,
        filePath: resolution.resolvedPath,
        relativePath: resolution.relativePath,
        symbol: args.symbol,
        startLine: startLine + 1,
        endLine: endLine + 1,
        lineNumberBase: 1,
      },
    };
  }

  lines.splice(startLine, endLine - startLine + 1, ...replacement.replace(/\r?\n/g, separator).split(separator));
  const updated = `${read.hasBom ? '\uFEFF' : ''}${lines.join(separator)}`;
  await host.filesystem.writeTextFile(resolution.resolvedPath, updated);
  await host.indexing?.invalidate?.(resolution.resolvedPath);

  return {
    ok: true,
    status: 'success',
    source: 'cwtools-shared',
    data: {
      success: true,
      message: `Updated PDX block '${args.symbol}' at lines ${startLine + 1}-${endLine + 1}.`,
      filePath: resolution.resolvedPath,
      relativePath: resolution.relativePath,
      symbol: args.symbol,
      startLine: startLine + 1,
      endLine: endLine + 1,
      lineNumberBase: 1,
    },
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

function buildSymbolNotFoundMessage(symbol: string, symbols: DocumentSymbolInfo[]): string {
  const names = collectSymbolNames(symbols).slice(0, 30);
  const suffix = collectSymbolNames(symbols).length > 30 ? '\n... more symbols omitted' : '';
  return names.length > 0
    ? `Symbol '${symbol}' not found. Available symbols:\n${names.join('\n')}${suffix}`
    : `Symbol '${symbol}' not found and no symbols were available for this file.`;
}

function collectSymbolNames(symbols: DocumentSymbolInfo[], depth = 0): string[] {
  const names: string[] = [];
  for (const symbol of symbols) {
    names.push(`${depth > 0 ? '  '.repeat(depth) + '- ' : ''}${symbol.name} (L${symbol.range.startLine}-${symbol.range.endLine})`);
    if (symbol.children && depth < 1) names.push(...collectSymbolNames(symbol.children, depth + 1));
  }
  return names;
}

function stripLineNumberPrefixes(content: string): string {
  return content
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\d+\s*[|:]\s?/, ''))
    .join('\n');
}

function validateReplacementBlock(content: string, symbol: string): string | undefined {
  if (!content.trim()) return 'Replacement content must not be empty.';
  if (!content.includes('{') || !content.includes('}')) {
    return 'Replacement content must include the full outer PDX block with braces.';
  }
  if (!content.includes(symbol)) {
    return `Replacement content must include the target symbol '${symbol}' to avoid replacing it with the wrong block.`;
  }
  const balance = braceBalance(content);
  if (balance !== 0) {
    return `Replacement content has unbalanced braces (${balance > 0 ? 'missing closing brace' : 'extra closing brace'}).`;
  }
  return undefined;
}

function braceBalance(content: string): number {
  let balance = 0;
  let inString = false;
  let escaped = false;
  for (const line of content.split(/\r?\n/)) {
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (!inString && char === '#') break;
      if (char === '"' && !escaped) inString = !inString;
      else if (!inString && char === '{') balance++;
      else if (!inString && char === '}') balance--;
      escaped = char === '\\' && !escaped;
      if (char !== '\\') escaped = false;
    }
  }
  return balance;
}
