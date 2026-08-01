/**
 * Typed edit-failure classification and anchor-guard signatures (P0 design 1).
 *
 * The anchor-aware repeated write-failure guard only covers the three
 * `anchor_*` classes: they are the only failures a side-effect-free preview
 * can prove recovered or still-failing. Structure rejections, invalid args
 * and I/O errors are classified for diagnostics but never guarded — blocking
 * them would punish legitimate retries.
 */
import * as crypto from 'crypto';

export type EditErrorClass =
    /** edit_file: oldString has no match in the current content. */
    | 'anchor_not_found'
    /** edit_file: oldString matches more than once. */
    | 'anchor_ambiguous'
    /** replace_lines: expected* guard(s) did not match the current line range. */
    | 'anchor_stale'
    /** PDX structure guard rejected the write. Never guarded. */
    | 'structure_rejected'
    /** Empty oldString, invalid line range, non-numeric lines… Never guarded. */
    | 'invalid_args'
    /** Read/write/lock failure. Never guarded. */
    | 'io_error';

/** Error classes the anchor guard is allowed to intercept. */
export const GUARDED_ERROR_CLASSES: ReadonlySet<EditErrorClass> = new Set([
    'anchor_not_found',
    'anchor_ambiguous',
    'anchor_stale',
]);

/** Thrown by replacerSuite so callers can classify without string matching. */
export class ReplacerError extends Error {
    constructor(
        public readonly kind: 'no_match' | 'multiple_matches',
        message: string,
    ) {
        super(message);
        this.name = 'ReplacerError';
    }
}

/** Map a replacer failure kind to an anchor error class. */
export function replacerKindToErrorClass(kind: ReplacerError['kind']): EditErrorClass {
    return kind === 'multiple_matches' ? 'anchor_ambiguous' : 'anchor_not_found';
}

export interface FailureSignature {
    /** Owning run scope (top-level runId or sub-agent runId) — see AgentToolContext.scopeId. */
    scopeId: string;
    tool: 'edit_file' | 'replace_lines';
    /** Canonical file key (resolved, `/` separators, lowercased on win32). */
    pathKey: string;
    /** sha256[0:16] of the normalized anchor (oldString / expected* / line range). */
    anchorHash: string;
    errorClass: EditErrorClass;
}

export function signatureKey(sig: FailureSignature): string {
    return [sig.scopeId, sig.tool, sig.pathKey, sig.anchorHash, sig.errorClass].join('\u0000');
}

/** Hash an anchor text that has already been normalized by the caller. */
export function hashAnchor(normalizedAnchor: string): string {
    return crypto.createHash('sha256').update(normalizedAnchor, 'utf8').digest('hex').slice(0, 16);
}
