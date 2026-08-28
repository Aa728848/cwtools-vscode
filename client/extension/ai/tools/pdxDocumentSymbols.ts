import * as path from 'path';
import { tokenize, TokenType, type Token } from '../../pdxTokenizer';
import type { DocumentSymbolInfo } from '../types';

const EVENT_BLOCK_KEYS = new Set([
    'event',
    'country_event',
    'fleet_event',
    'observer_event',
    'planet_event',
    'pop_event',
    'ship_event',
]);

function isSymbolName(token: Token | undefined): token is Token {
    return token?.type === TokenType.Identifier
        || token?.type === TokenType.String
        || token?.type === TokenType.Number;
}

function findClosingBrace(tokens: readonly Token[], openingIndex: number): number | undefined {
    let depth = 0;
    for (let i = openingIndex; i < tokens.length; i++) {
        if (tokens[i]!.type === TokenType.LBrace) depth++;
        else if (tokens[i]!.type === TokenType.RBrace && --depth === 0) return i;
    }
    return undefined;
}

function eventId(tokens: readonly Token[], start: number, end: number): string | undefined {
    let depth = 0;
    for (let i = start; i < end; i++) {
        const token = tokens[i]!;
        if (token.type === TokenType.LBrace) {
            depth++;
            continue;
        }
        if (token.type === TokenType.RBrace) {
            depth--;
            continue;
        }
        if (depth !== 0 || token.type !== TokenType.Identifier || token.value.toLowerCase() !== 'id') continue;
        if (tokens[i + 1]?.type === TokenType.Equals && isSymbolName(tokens[i + 2])) return tokens[i + 2]!.value;
    }
    return undefined;
}

/**
 * Structural fallback for PDXScript files when VS Code has no document-symbol
 * provider for an external vanilla file. It intentionally returns top-level
 * definition blocks only; semantic LSP symbols remain preferred when available.
 */
export function parsePdxDocumentSymbols(content: string, filePath: string): DocumentSymbolInfo[] {
    if (path.extname(filePath).toLowerCase() !== '.txt') return [];

    const tokens = tokenize(content);
    const symbols: DocumentSymbolInfo[] = [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.type === TokenType.LBrace) {
            depth++;
            continue;
        }
        if (token.type === TokenType.RBrace) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0 || !isSymbolName(token) || token.value.startsWith('@')) continue;
        if (tokens[i + 1]?.type !== TokenType.Equals || tokens[i + 2]?.type !== TokenType.LBrace) continue;

        const closingIndex = findClosingBrace(tokens, i + 2);
        if (closingIndex === undefined) continue;
        const semanticName = EVENT_BLOCK_KEYS.has(token.value.toLowerCase())
            ? eventId(tokens, i + 3, closingIndex) ?? token.value
            : token.value;
        symbols.push({
            name: semanticName,
            kind: 'Class',
            range: {
                startLine: token.line - 1,
                endLine: tokens[closingIndex]!.line - 1,
            },
        });
        i = closingIndex;
    }
    return symbols;
}
