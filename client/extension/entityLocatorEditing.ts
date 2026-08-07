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

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacementName(source: string, newName: string): string {
    return source.startsWith('"') ? `"${newName}"` : newName;
}

/** Rename the name field of one already-resolved static locator block. */
export function renameLocatorBlock(block: string, oldName: string, newName: string): string {
    const old = escapeRegExp(oldName);
    const expression = new RegExp(`(\\bname\\s*=\\s*)("${old}"|${old})(?=\\s|}|#|$)`, 'i');
    return block.replace(expression, (_match, prefix: string, value: string) =>
        `${prefix}${replacementName(value, newName)}`);
}

/**
 * Rename references that are scoped to an entity: attach keys and particle
 * event nodes. This intentionally does not rename arbitrary script values.
 */
export function renameLocatorReferencesInEntity(entityText: string, oldName: string, newName: string): string {
    const old = escapeRegExp(oldName);
    const renameValue = (value: string) => replacementName(value, newName);
    const attachExpression = /\battach\s*=\s*\{[^{}]*\}/gi;
    const nodeExpression = new RegExp(`(\\bnode\\s*=\\s*)("${old}"|${old})(?=\\s|}|#|$)`, 'gi');

    const withAttach = entityText.replace(attachExpression, attachBlock => {
        const keyExpression = new RegExp(`("${old}"|${old})(\\s*=)`, 'gi');
        return attachBlock.replace(keyExpression, (_match, value: string, suffix: string) =>
            `${renameValue(value)}${suffix}`);
    });
    return withAttach.replace(nodeExpression, (_match, prefix: string, value: string) =>
        `${prefix}${renameValue(value)}`);
}
