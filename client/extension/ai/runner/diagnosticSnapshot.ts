import type { ValidationError } from '../types';

export type DiagnosticStatus = 'fresh' | 'pending' | 'stale' | 'unavailable';

export interface NormalizedDiagnostic {
    readonly message: string;
    readonly severity: ValidationError['severity'];
    readonly code: string;
    readonly source: string;
    readonly line: number;
    readonly column: number;
}

export interface DiagnosticSnapshot {
    readonly status: DiagnosticStatus;
    readonly complete: boolean;
    readonly diagnostics: readonly NormalizedDiagnostic[];
}

export interface DiagnosticDelta {
    readonly comparable: boolean;
    readonly added: readonly NormalizedDiagnostic[];
    readonly removed: readonly NormalizedDiagnostic[];
}

export interface DiagnosticSnapshotOptions {
    readonly status?: DiagnosticStatus;
    readonly complete?: boolean;
}

const STATUS: readonly DiagnosticStatus[] = ['fresh', 'pending', 'stale', 'unavailable'];

function normalizedText(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizedDiagnostic(error: ValidationError): NormalizedDiagnostic {
    const data = dataRecord(error.data);
    const code = normalizedText(data?.code) || normalizedText(error.code);
    const source = normalizedText(data?.source) || normalizedText(data?.origin) || 'cwtools';
    const line = numberOr(error.line, 0);
    const column = numberOr(error.column, 0);
    return { message: normalizedText(error.message), severity: error.severity, code, source, line, column };
}

function diagnosticKey(diagnostic: NormalizedDiagnostic): string {
    // Position is intentionally excluded: inserting lines before a pre-existing
    // diagnostic must not turn the same problem into a newly introduced error.
    // Duplicate identical diagnostics are still preserved by the multiset diff.
    return JSON.stringify([
        diagnostic.message, diagnostic.severity, diagnostic.code, diagnostic.source,
    ]);
}

function compareDiagnostics(left: NormalizedDiagnostic, right: NormalizedDiagnostic): number {
    const a = diagnosticKey(left);
    const b = diagnosticKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

function isStatus(value: unknown): value is DiagnosticStatus {
    return typeof value === 'string' && STATUS.includes(value as DiagnosticStatus);
}

/** Create an immutable, deterministically sorted diagnostic snapshot. */
export function createDiagnosticSnapshot(
    errors: readonly ValidationError[],
    options: DiagnosticSnapshotOptions = {},
): DiagnosticSnapshot {
    const status = options.status ?? 'fresh';
    const complete = options.complete ?? status === 'fresh';
    const diagnostics = errors.map(normalizedDiagnostic).sort(compareDiagnostics);
    return Object.freeze({
        status,
        complete,
        diagnostics: Object.freeze(diagnostics),
    });
}

/**
 * Compare snapshots as multisets. Diagnostics are only comparable when both
 * snapshots are complete fresh observations; duplicates therefore matter.
 */
export function diffDiagnosticSnapshots(
    before: DiagnosticSnapshot,
    after: DiagnosticSnapshot,
): DiagnosticDelta {
    const comparable = before.status === 'fresh' && after.status === 'fresh'
        && before.complete && after.complete;
    if (!comparable) return { comparable: false, added: [], removed: [] };

    const remainingBefore = new Map<string, number>();
    for (const item of before.diagnostics) {
        const key = diagnosticKey(item);
        remainingBefore.set(key, (remainingBefore.get(key) ?? 0) + 1);
    }
    const added: NormalizedDiagnostic[] = [];
    for (const item of after.diagnostics) {
        const key = diagnosticKey(item);
        const count = remainingBefore.get(key) ?? 0;
        if (count > 0) remainingBefore.set(key, count - 1);
        else added.push(item);
    }

    const remainingAfter = new Map<string, number>();
    for (const item of after.diagnostics) {
        const key = diagnosticKey(item);
        remainingAfter.set(key, (remainingAfter.get(key) ?? 0) + 1);
    }
    const removed: NormalizedDiagnostic[] = [];
    for (const item of before.diagnostics) {
        const key = diagnosticKey(item);
        const count = remainingAfter.get(key) ?? 0;
        if (count > 0) remainingAfter.set(key, count - 1);
        else removed.push(item);
    }
    return { comparable: true, added, removed };
}

/** Return true only when a comparable delta introduced an error diagnostic. */
export function hasAddedErrors(delta: DiagnosticDelta): boolean {
    return delta.comparable && delta.added.some(diagnostic => diagnostic.severity === 'error');
}

// Keep these guards available to callers validating persisted/untrusted data.
export function isDiagnosticStatus(value: unknown): value is DiagnosticStatus {
    return isStatus(value);
}
