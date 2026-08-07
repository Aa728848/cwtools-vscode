export type LocatorVector3 = [number, number, number];

export interface LocatorTextBlock {
    startLine: number;
    endLine: number;
}

function braceDelta(line: string): { delta: number; opened: boolean } {
    let delta = 0;
    let opened = false;
    let quoted = false;
    let escaped = false;
    for (const ch of line) {
        if (!quoted && ch === '#') break;
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quoted && ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            quoted = !quoted;
            continue;
        }
        if (quoted) continue;
        if (ch === '{') {
            delta++;
            opened = true;
        } else if (ch === '}') {
            delta--;
        }
    }
    return { delta, opened };
}

/** Find the locator block anchored by the parser's one-based locator line. */
export function findLocatorTextBlock(lines: readonly string[], locatorLine: number): LocatorTextBlock | undefined {
    if (!Number.isInteger(locatorLine) || locatorLine < 1 || locatorLine > lines.length) return undefined;
    const anchor = locatorLine - 1;
    let startLine = anchor;
    while (startLine >= Math.max(0, anchor - 8) && !/\blocator\s*=/.test(lines[startLine]!)) startLine--;
    if (startLine < 0 || !/\blocator\s*=/.test(lines[startLine]!)) return undefined;

    let depth = 0;
    let opened = false;
    for (let endLine = startLine; endLine < lines.length; endLine++) {
        const braces = braceDelta(lines[endLine]!);
        depth += braces.delta;
        opened ||= braces.opened;
        if (opened && depth <= 0) return { startLine, endLine };
    }
    return undefined;
}

function formatVector(vector: LocatorVector3, digits: number): string {
    return vector.map(value => value.toFixed(digits)).join(' ');
}

function upsertVector(block: string, key: 'position' | 'rotation', value: string): string {
    const expression = new RegExp(`\\b${key}\\s*=\\s*\\{[^{}]*\\}`, 'i');
    const replacement = `${key} = { ${value} }`;
    if (expression.test(block)) return block.replace(expression, replacement);

    const close = block.lastIndexOf('}');
    if (close < 0) return block;
    if (!block.includes('\n')) return `${block.slice(0, close).trimEnd()} ${replacement} ${block.slice(close)}`;

    const indent = block.match(/^(\s*)/)?.[1] ?? '';
    return `${block.slice(0, close).trimEnd()}\n${indent}\t${replacement}\n${block.slice(close)}`;
}

/** Update only transform fields while preserving scale, parent_joint and unknown fields. */
export function updateLocatorTransformBlock(
    block: string,
    position: LocatorVector3,
    rotation: LocatorVector3,
): string {
    const withPosition = upsertVector(block, 'position', formatVector(position, 6));
    return upsertVector(withPosition, 'rotation', formatVector(rotation, 2));
}
