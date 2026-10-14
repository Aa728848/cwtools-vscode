/**
 * Shared helpers for asking the CWTools server to (re)validate files.
 *
 * Neutral module: no vscode / LSP dependency, so the Extension Host command,
 * the AI tool layer and unit tests all share one definition of "which files can
 * produce diagnostics" and "how a revalidation request is batched".
 */

import * as path from 'path';

/** File extensions whose diagnostics the CWTools server is able to produce. */
export const DIAGNOSTIC_REVALIDATE_EXTENSIONS: readonly string[] = [
    '.txt', '.gui', '.yml', '.gfx', '.asset', '.cwt', '.entity', '.shader', '.fxh',
];

/** Upper bound on the URIs sent in one `cwtools.ai.revalidateFiles` request. */
export const DIAGNOSTIC_REVALIDATE_BATCH_SIZE = 200;

/**
 * Upper bound on the files scanned for the "revalidate everything" fallback.
 * Keeps a workspace-wide scan bounded; the command reports how many files it
 * queued so a truncated scan is visible instead of silently partial.
 */
export const DIAGNOSTIC_REVALIDATE_SCAN_LIMIT = 5000;

/** True when the CWTools server can report diagnostics for `filePath`. */
export function isDiagnosticRelevantFile(filePath: string): boolean {
    return DIAGNOSTIC_REVALIDATE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * Deduplicated, sorted and extension-filtered target list for a revalidation
 * request. Sorted so that request order never depends on file-system
 * enumeration order, which AGENTS.md requires to stay deterministic.
 */
export function selectRevalidateTargets(files: readonly string[], limit = DIAGNOSTIC_REVALIDATE_BATCH_SIZE): string[] {
    const targets = Array.from(new Set(files.filter(file => isDiagnosticRelevantFile(file)))).sort();
    return targets.length > limit ? targets.slice(0, limit) : targets;
}

/** Split `items` into batches of at most `size` entries. */
export function chunkRevalidateBatches<T>(items: readonly T[], size = DIAGNOSTIC_REVALIDATE_BATCH_SIZE): T[][] {
    const batchSize = Math.max(1, Math.floor(size));
    const batches: T[][] = [];
    for (let index = 0; index < items.length; index += batchSize) {
        batches.push(items.slice(index, index + batchSize));
    }
    return batches;
}

/**
 * One `cwtools.ai.getDiagnosticsFresh` sample, narrowed at the wire boundary.
 * `validated` is absent on servers older than the field; `hasDiagnosticsField`
 * records whether the response carried a `diagnostics` array at all (an empty
 * array is a real "validated, no errors" answer, a missing one is not).
 */
export interface DiagnosticsFreshnessState {
    freshness: string;
    epoch: number;
    validated?: boolean;
    hasDiagnosticsField: boolean;
}

/**
 * Distinguish "validated against an older revision" from "never validated".
 *
 * The server answers `freshness: "stale"` for both: a file it has seen but not
 * re-linted yet, and a file it has no entry for at all. Waiting on the second
 * one is futile — its epoch stays 0 forever — so the post-write wait loop used
 * to burn its whole budget and then report the untouched Problems panel, which
 * made a brand-new file look clean. Newer servers mark the second case with
 * `validated: false`; older ones only report `epoch: 0` and omit
 * `diagnostics`, so both spellings are accepted here.
 */
export function isNeverValidatedState(state: DiagnosticsFreshnessState): boolean {
    if (typeof state.validated === 'boolean') return !state.validated;
    return state.epoch === 0 && state.freshness === 'stale' && !state.hasDiagnosticsField;
}

/**
 * Whether the client still has to open the document to drive a didOpen.
 *
 * `cwtools.ai.revalidateFiles` only re-lints files the server already tracks,
 * so a file it never opened — typically one the AI just created — is never
 * validated by that call alone. Opening it is safe: `openTextDocument` does
 * not take focus, it only makes VS Code send didOpen to the server.
 */
export function shouldOpenDocumentForRevalidate(revalidateTriggered: boolean, documentAlreadyOpen: boolean): boolean {
    return !revalidateTriggered || !documentAlreadyOpen;
}
