/**
 * Real-usage-calibrated token estimation (P0 design 3).
 *
 * The heuristic estimators in tokenEstimation.ts drive every context-window
 * threshold decision, but their error varies by provider/model/content mix.
 * This table closes the loop: each completed request with a REAL
 * usage.prompt_tokens yields one sample (actual/estimated ratio) folded into
 * a per-key EWMA. Decision paths multiply their raw estimate by the
 * calibrated ratio once enough samples exist.
 *
 * Safety rails:
 * - keys are {providerId, model, customApiFormat, endpoint fingerprint} from
 *   the RESPONSE side — a fallback never pollutes the primary provider's key;
 * - samples outside [0.25, 4] are rejected (truncated/abnormal usage);
 * - the EWMA ratio is clamped to [0.5, 2.0]; cold start (< MIN_SAMPLES)
 *   returns the raw estimate unchanged;
 * - bounded to 50 keys with LRU eviction; samples never cross keys.
 */
import * as crypto from 'crypto';

export interface CalibrationEntry {
    /** EWMA of actual/estimated prompt-token ratios. */
    ratio: number;
    samples: number;
    updatedAt: number;
}

const EWMA_ALPHA = 0.2;
const MIN_SAMPLES = 5;
const MAX_ENTRIES = 50;
const RATIO_MIN = 0.5;
const RATIO_MAX = 2.0;
const SAMPLE_RATIO_MIN = 0.25;
const SAMPLE_RATIO_MAX = 4;
const MAX_KEY_LENGTH = 512;
/** Persist at most once per this many new samples. */
const PERSIST_EVERY_SAMPLES = 20;

/** Fingerprint the endpoint so swapping a compatible relay never reuses stale ratios. */
export function endpointFingerprint(endpoint: string | undefined): string {
    const normalized = (endpoint ?? '').trim().toLowerCase().replace(/\/+$/, '');
    if (!normalized) return '';
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Calibration key. Fields are NUL-joined (never ambiguous concatenation) and
 * contain no paths or user content, so persisted keys are safe by construction.
 */
export function buildCalibrationKey(
    providerId: string,
    model: string,
    customApiFormat?: string,
    endpoint?: string,
): string {
    return [providerId, model.toLowerCase(), customApiFormat ?? '', endpointFingerprint(endpoint)].join('\u0000');
}

/** Narrow a persisted value into a trusted snapshot; anything invalid is dropped. */
export function readCalibrationSnapshot(raw: unknown): Record<string, CalibrationEntry> {
    if (!raw || typeof raw !== 'object') return {};
    const versioned = raw as { version?: unknown; entries?: unknown };
    if (versioned.version !== 1 || !versioned.entries || typeof versioned.entries !== 'object') return {};
    const valid: Array<[string, CalibrationEntry]> = [];
    for (const [key, value] of Object.entries(versioned.entries as Record<string, unknown>)) {
        if (!key || key.length > MAX_KEY_LENGTH) continue;
        if (!value || typeof value !== 'object') continue;
        const entry = value as Record<string, unknown>;
        const { ratio, samples, updatedAt } = entry;
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < RATIO_MIN || ratio > RATIO_MAX) continue;
        if (typeof samples !== 'number' || !Number.isSafeInteger(samples) || samples < 0) continue;
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) continue;
        valid.push([key, { ratio, samples, updatedAt }]);
    }
    valid.sort((a, b) => a[1].updatedAt - b[1].updatedAt || a[0].localeCompare(b[0]));
    const out: Record<string, CalibrationEntry> = {};
    for (const [key, entry] of valid.slice(-MAX_ENTRIES)) out[key] = entry;
    return out;
}

export class TokenCalibrationTable {
    private readonly entries = new Map<string, CalibrationEntry>();
    private samplesSincePersist = 0;
    /** Single-flight chain so concurrent persist calls serialize. */
    private persistChain: Promise<void> = Promise.resolve();

    constructor(
        initial?: Record<string, CalibrationEntry>,
        private readonly persist?: (snapshot: { version: 1; entries: Record<string, CalibrationEntry> }) => Promise<void> | void,
        private readonly onPersistError?: (error: unknown) => void,
    ) {
        if (initial) {
            const bounded = Object.entries(initial)
                .filter(([key]) => key.length > 0 && key.length <= MAX_KEY_LENGTH)
                .sort((a, b) => a[1].updatedAt - b[1].updatedAt || a[0].localeCompare(b[0]))
                .slice(-MAX_ENTRIES);
            for (const [key, entry] of bounded) {
                this.entries.set(key, entry);
            }
        }
    }

    /** Fold one real-usage sample into the key's EWMA. Out-of-band samples are rejected. */
    record(key: string, estimated: number, actual: number): void {
        if (!(estimated > 0) || !(actual > 0)) return;
        const sampleRatio = actual / estimated;
        if (sampleRatio < SAMPLE_RATIO_MIN || sampleRatio > SAMPLE_RATIO_MAX) return;
        const clamped = Math.min(RATIO_MAX, Math.max(RATIO_MIN, sampleRatio));
        const prev = this.entries.get(key);
        if (prev) this.entries.delete(key); // refresh LRU position
        this.entries.set(key, {
            ratio: prev ? prev.ratio + EWMA_ALPHA * (clamped - prev.ratio) : clamped,
            samples: (prev?.samples ?? 0) + 1,
            updatedAt: Date.now(),
        });
        while (this.entries.size > MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        this.samplesSincePersist++;
        if (this.samplesSincePersist >= PERSIST_EVERY_SAMPLES) {
            void this.flush();
        }
    }

    /** Calibrated estimate; raw value when the key has too few samples. */
    apply(key: string, estimated: number): number {
        const entry = this.entries.get(key);
        if (!entry || entry.samples < MIN_SAMPLES) return estimated;
        return Math.round(estimated * entry.ratio);
    }

    sampleCount(key: string): number {
        return this.entries.get(key)?.samples ?? 0;
    }

    snapshot(): Record<string, CalibrationEntry> {
        const out: Record<string, CalibrationEntry> = {};
        for (const [key, entry] of this.entries) out[key] = { ...entry };
        return out;
    }

    /** Persist now (debounced internally by record(); also safe to call at run end). */
    flush(): Promise<void> {
        if (this.samplesSincePersist === 0 || !this.persist) return this.persistChain;
        const pendingSamples = this.samplesSincePersist;
        this.samplesSincePersist = 0;
        const snapshot = { version: 1 as const, entries: this.snapshot() };
        this.persistChain = this.persistChain
            .then(() => this.persist!(snapshot))
            .catch(error => {
                // Keep the table dirty so the next run-end flush retries the
                // latest full snapshot instead of silently losing samples.
                this.samplesSincePersist = Math.max(this.samplesSincePersist, pendingSamples);
                try {
                    this.onPersistError?.(error);
                } catch {
                    // A diagnostic callback must never make heuristic
                    // persistence fail the owning Agent run.
                }
            });
        return this.persistChain;
    }
}
