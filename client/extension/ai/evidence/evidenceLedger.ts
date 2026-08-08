/**
 * Durable evidence-decision ledger.
 *
 * The in-memory EvidenceGate cache only spans one AgentToolExecutor lifetime.
 * This ledger persists verified 'allow' decisions per evidence revision so
 * repeated writes across runs and sessions reuse proven claims instead of
 * re-collecting LSP/index evidence. Safety invariants mirror storeInCache:
 * only clean allow decisions (all blocking claims verified, not degraded) are
 * ever persisted, and lookups require an exact revision match.
 */

import * as path from 'path';
import { atomicWriteJson, readJsonWithBackup } from '../runner/durableStorage';
import { isEvidenceGateDecision, type EvidenceGateDecision } from './evidenceTypes';

const LEDGER_FILE = 'evidence-ledger.json';
const DEFAULT_MAX_ENTRIES = 2000;

export interface EvidenceLedgerEntry {
    version: 1;
    key: string;
    evidenceRevision: string;
    decision: EvidenceGateDecision;
    observedAt: number;
}

export interface EvidenceLedgerDeps {
    root: string;
    maxEntries?: number;
    now?: () => number;
}

interface LedgerFile {
    version: 1;
    entries: EvidenceLedgerEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isLedgerEntry(value: unknown): value is EvidenceLedgerEntry {
    if (!isRecord(value)) return false;
    if (value.version !== 1) return false;
    if (typeof value.key !== 'string' || typeof value.evidenceRevision !== 'string') return false;
    if (typeof value.observedAt !== 'number') return false;
    return isEvidenceGateDecision(value.decision);
}

function isLedgerFile(value: unknown): value is LedgerFile {
    return isRecord(value)
        && value.version === 1
        && Array.isArray(value.entries)
        && value.entries.every(isLedgerEntry);
}

export class EvidenceLedger {
    private readonly filePath: string;
    private readonly maxEntries: number;
    private readonly now: () => number;
    private entries = new Map<string, EvidenceLedgerEntry>();
    private loaded = false;
    private readonly writtenKeys = new Set<string>();

    constructor(deps: EvidenceLedgerDeps) {
        this.filePath = path.join(deps.root, LEDGER_FILE);
        this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.now = deps.now ?? Date.now;
    }

    /** Exact-revision lookup; only clean allow decisions are returned. */
    lookup(key: string, evidenceRevision: string): EvidenceGateDecision | undefined {
        this.ensureLoaded();
        const entry = this.entries.get(key);
        if (!entry || entry.evidenceRevision !== evidenceRevision) return undefined;
        const decision = entry.decision;
        if (decision.verdict !== 'allow' || decision.degraded === true) return undefined;
        if (decision.claims.some(claim => claim.blocking && claim.status !== 'verified')) return undefined;
        return decision;
    }

    /** Best-effort persist of a verified allow decision (throttled per key). */
    async store(key: string, decision: EvidenceGateDecision, evidenceRevision: string): Promise<void> {
        if (decision.verdict !== 'allow' || decision.degraded === true) return;
        if (decision.claims.some(claim => claim.blocking && claim.status !== 'verified')) return;
        if (this.writtenKeys.has(key)) return;
        this.ensureLoaded();
        this.writtenKeys.add(key);
        this.entries.set(key, {
            version: 1,
            key,
            evidenceRevision,
            decision,
            observedAt: this.now(),
        });
        this.prune();
        try {
            await atomicWriteJson(this.filePath, this.serialize());
        } catch {
            // Persistence is best-effort; the in-memory cache still serves the session.
        }
    }

    /** Drop all persisted decisions (e.g. after a rules sync). */
    async clearAll(): Promise<void> {
        this.entries.clear();
        this.writtenKeys.clear();
        try {
            await atomicWriteJson(this.filePath, { version: 1, entries: [] });
        } catch {
            // Best-effort.
        }
    }

    private serialize(): LedgerFile {
        return { version: 1, entries: [...this.entries.values()] };
    }

    private ensureLoaded(): void {
        if (this.loaded) return;
        this.loaded = true;
        const loaded = readJsonWithBackup<LedgerFile>(this.filePath, isLedgerFile);
        if (!loaded) return;
        for (const entry of loaded.value.entries) {
            if (entry.observedAt > 0) this.entries.set(entry.key, entry);
        }
        this.prune();
    }

    private prune(): void {
        if (this.entries.size <= this.maxEntries) return;
        const sorted = [...this.entries.values()].sort((a, b) => a.observedAt - b.observedAt);
        const overflow = this.entries.size - this.maxEntries;
        for (const entry of sorted.slice(0, overflow)) {
            this.entries.delete(entry.key);
        }
    }
}
