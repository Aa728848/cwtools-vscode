import * as fs from 'fs';
import * as path from 'path';
import { isPathInsideOrEqual } from './pathScope';

export const TECH_TREE_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function realPathOrResolved(target: string): string {
    try {
        return fs.realpathSync(target);
    } catch {
        return path.resolve(target);
    }
}

export function resolveAllowedTechTreeSourcePath(
    input: unknown,
    allowedRoots: readonly string[],
): string | undefined {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) return undefined;
    const roots = [...new Set(allowedRoots.filter(Boolean).map(root => path.resolve(root)))];
    const realRoots = roots.map(realPathOrResolved);
    const candidates = path.isAbsolute(input)
        ? [path.resolve(input)]
        : roots.map(root => path.resolve(root, input));

    for (const candidate of candidates) {
        if (!roots.some(root => isPathInsideOrEqual(candidate, root))) continue;
        let stat: fs.Stats;
        let realCandidate: string;
        try {
            stat = fs.statSync(candidate);
            realCandidate = fs.realpathSync(candidate);
        } catch {
            continue;
        }
        if (!stat.isFile()) continue;
        if (realRoots.some(root => isPathInsideOrEqual(realCandidate, root))) return realCandidate;
    }
    return undefined;
}

export function decodeTechTreePngDataUri(
    input: unknown,
    maxBytes = TECH_TREE_EXPORT_MAX_BYTES,
): Buffer | undefined {
    if (typeof input !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return undefined;
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
    const encoded = match?.[1];
    if (!encoded || encoded.length % 4 !== 0) return undefined;
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const decodedLength = (encoded.length / 4) * 3 - padding;
    if (decodedLength > maxBytes) return undefined;
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== decodedLength || decoded.length < PNG_SIGNATURE.length) return undefined;
    return decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? decoded : undefined;
}

export function normalizeTechTreeLine(input: unknown, lineCount: number): number | undefined {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) return undefined;
    if (!Number.isSafeInteger(lineCount) || lineCount < 1) return undefined;
    return Math.min(input - 1, lineCount - 1);
}
