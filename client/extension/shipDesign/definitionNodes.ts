/**
 * Lightweight Paradox Definition AST Helpers for Ship Design.
 *
 * Tokenizes `.txt`/`.gfx` definitions into scalar/block trees with `@var`
 * numeric resolution and safe typed field accessors (no vscode dependency).
 */

import { TokenType, tokenize, type Token } from '../pdxTokenizer';

export interface DefinitionScalar {
    kind: 'scalar';
    key: string;
    value: string;
    quoted: boolean;
}

export interface DefinitionBlock {
    kind: 'block';
    key: string;
    fields: DefinitionNode[];
    items: string[];
}

export type DefinitionNode = DefinitionScalar | DefinitionBlock;

export interface DefinitionFile {
    fields: DefinitionNode[];
    variables: Map<string, number>;
}

export interface DefinitionNumber {
    raw: string;
    value?: number;
}

function normalized(key: string): string {
    return key.toLowerCase();
}

function matchingBraces(tokens: readonly Token[]): Map<number, number> {
    const pairs = new Map<number, number>();
    const stack: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!token) continue;
        if (token.type === TokenType.LBrace) stack.push(index);
        else if (token.type === TokenType.RBrace) {
            const open = stack.pop();
            if (open !== undefined) pairs.set(open, index);
        }
    }
    return pairs;
}

function readNodes(
    tokens: readonly Token[],
    from: number,
    to: number,
    pairs: ReadonlyMap<number, number>,
): { fields: DefinitionNode[]; items: string[] } {
    const fields: DefinitionNode[] = [];
    const items: string[] = [];
    let index = from;
    while (index < to) {
        const token = tokens[index];
        if (!token || token.type === TokenType.EOF) break;
        const equals = tokens[index + 1];
        const value = tokens[index + 2];
        if (equals?.type === TokenType.Equals && value) {
            if (value.type === TokenType.LBrace) {
                const closeIndex = pairs.get(index + 2);
                if (closeIndex === undefined || closeIndex > to) break;
                const body = readNodes(tokens, index + 3, closeIndex, pairs);
                fields.push({ kind: 'block', key: token.value, fields: body.fields, items: body.items });
                index = closeIndex + 1;
            } else {
                fields.push({
                    kind: 'scalar',
                    key: token.value,
                    value: value.value,
                    quoted: value.type === TokenType.String,
                });
                index += 3;
            }
            continue;
        }
        if (token.type !== TokenType.LBrace && token.type !== TokenType.RBrace
            && token.type !== TokenType.Equals && token.type !== TokenType.Comma) {
            items.push(token.value);
        }
        index++;
    }
    return { fields, items };
}

export function parseDefinitionFile(text: string): DefinitionFile {
    const tokens = tokenize(text, { comma: true });
    const pairs = matchingBraces(tokens);
    const body = readNodes(tokens, 0, tokens.length - 1, pairs);
    const variables = new Map<string, number>();
    for (const field of body.fields) {
        if (field.kind === 'scalar' && field.key.startsWith('@')) {
            const value = Number.parseFloat(field.value.replace(/%$/, ''));
            if (Number.isFinite(value)) variables.set(normalized(field.key), value);
        }
    }
    return { fields: body.fields, variables };
}

export function definitionScalars(fields: readonly DefinitionNode[], key: string): DefinitionScalar[] {
    const wanted = normalized(key);
    return fields.filter((field): field is DefinitionScalar => field.kind === 'scalar' && normalized(field.key) === wanted);
}

export function definitionBlocks(fields: readonly DefinitionNode[], key: string): DefinitionBlock[] {
    const wanted = normalized(key);
    return fields.filter((field): field is DefinitionBlock => field.kind === 'block' && normalized(field.key) === wanted);
}

export function firstDefinitionScalar(fields: readonly DefinitionNode[], key: string): DefinitionScalar | undefined {
    return definitionScalars(fields, key)[0];
}

export function firstDefinitionBlock(fields: readonly DefinitionNode[], key: string): DefinitionBlock | undefined {
    return definitionBlocks(fields, key)[0];
}

export function definitionString(fields: readonly DefinitionNode[], key: string): string | undefined {
    return firstDefinitionScalar(fields, key)?.value;
}

export function definitionBoolean(fields: readonly DefinitionNode[], key: string): boolean | undefined {
    const value = definitionString(fields, key);
    if (value === undefined) return undefined;
    if (normalized(value) === 'yes') return true;
    if (normalized(value) === 'no') return false;
    return undefined;
}

export function resolveDefinitionNumber(raw: string, variables: ReadonlyMap<string, number>): number | undefined {
    const direct = Number.parseFloat(raw.replace(/%$/, ''));
    if (Number.isFinite(direct) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(raw)) return direct;
    return variables.get(normalized(raw));
}

export function definitionNumber(
    fields: readonly DefinitionNode[],
    key: string,
    variables: ReadonlyMap<string, number>,
): DefinitionNumber | undefined {
    const value = definitionString(fields, key);
    if (value === undefined) return undefined;
    return { raw: value, value: resolveDefinitionNumber(value, variables) };
}

export function definitionNumericFields(
    fields: readonly DefinitionNode[],
    variables: ReadonlyMap<string, number>,
): Record<string, DefinitionNumber> {
    const result: Record<string, DefinitionNumber> = {};
    for (const field of fields) {
        if (field.kind !== 'scalar' || field.key.startsWith('@')) continue;
        result[field.key] = { raw: field.value, value: resolveDefinitionNumber(field.value, variables) };
    }
    return result;
}

export function definitionItems(block: DefinitionBlock | undefined): string[] {
    if (!block) return [];
    const values = new Set<string>();
    for (const item of block.items) values.add(item);
    for (const field of block.fields) {
        if (field.kind === 'scalar') values.add(field.value);
    }
    return [...values];
}

export function collectDefinitionItemsDeep(block: DefinitionBlock | undefined): string[] {
    if (!block) return [];
    const values = new Set<string>();
    const visit = (current: DefinitionBlock): void => {
        for (const item of definitionItems(current)) values.add(item);
        for (const field of current.fields) {
            if (field.kind === 'block') visit(field);
        }
    };
    visit(block);
    return [...values];
}

export function mergeDefinitionVariables(target: Map<string, number>, source: ReadonlyMap<string, number>): void {
    for (const [key, value] of source) {
        if (!target.has(key)) target.set(key, value);
    }
}
