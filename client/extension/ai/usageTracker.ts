import * as vs from 'vscode';
import { TokenUsage } from './types';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface UsageRecord {
    timestamp: number;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
}

export interface ProviderStats {
    tokens: number;
    costUsd: number;
}

export interface DailyStats {
    date: string; // YYYY-MM-DD
    tokens: number;
    costUsd: number;
    callCount: number;
}

export interface ModelDistribution {
    model: string;
    tokens: number;
    costUsd: number;
    callCount: number;
    percentage: number; // 0-100
}

export interface UsageStats {
    totalTokens: number;
    totalCostUsd: number;
    totalCalls: number;
    byProvider: Record<string, ProviderStats>;
    dailyStats: DailyStats[];
    modelDistribution: ModelDistribution[];
}

// ─── Internal persisted shape ────────────────────────────────────────────────

interface PersistedUsageData {
    records: UsageRecord[];
    /** Version tag for future migration support */
    version: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Automatically purge records older than this many days */
const AUTO_CLEANUP_DAYS = 90;

// ─── UsageTracker ────────────────────────────────────────────────────────────

export class UsageTracker {
    private static readonly STORAGE_KEY = 'cwtools.ai.usageStats.v2';

    constructor(private context: vs.ExtensionContext) {}

    // ── Write ────────────────────────────────────────────────────────────────

    addUsage(providerId: string, model: string, usage: TokenUsage) {
        if (!usage || typeof usage.total !== 'number') return;

        const data = this.loadData();

        data.records.push({
            timestamp: Date.now(),
            provider: providerId,
            model: model || 'unknown',
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            totalTokens: usage.total,
            costUsd: usage.estimatedCostUsd ?? 0,
        });

        // Auto-cleanup stale records
        this.purgeOldRecords(data);

        this.saveData(data);
    }

    // ── Read  ────────────────────────────────────────────────────────────────

    getStats(): UsageStats {
        const data = this.loadData();
        const records = data.records;

        // Aggregates
        let totalTokens = 0;
        let totalCostUsd = 0;
        const byProvider: Record<string, ProviderStats> = {};
        const dailyMap = new Map<string, { tokens: number; costUsd: number; callCount: number }>();
        const modelMap = new Map<string, { tokens: number; costUsd: number; callCount: number }>();

        for (const r of records) {
            totalTokens += r.totalTokens;
            totalCostUsd += r.costUsd;

            // By provider
            if (!byProvider[r.provider]) {
                byProvider[r.provider] = { tokens: 0, costUsd: 0 };
            }
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            byProvider[r.provider]!.tokens += r.totalTokens;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            byProvider[r.provider]!.costUsd += r.costUsd;

            // By day
            const day = new Date(r.timestamp).toISOString().slice(0, 10);
            const d = dailyMap.get(day) ?? { tokens: 0, costUsd: 0, callCount: 0 };
            d.tokens += r.totalTokens;
            d.costUsd += r.costUsd;
            d.callCount += 1;
            dailyMap.set(day, d);

            // By model
            const m = modelMap.get(r.model) ?? { tokens: 0, costUsd: 0, callCount: 0 };
            m.tokens += r.totalTokens;
            m.costUsd += r.costUsd;
            m.callCount += 1;
            modelMap.set(r.model, m);
        }

        // Daily stats sorted by date descending
        const dailyStats: DailyStats[] = Array.from(dailyMap.entries())
            .map(([date, v]) => ({ date, ...v }))
            .sort((a, b) => b.date.localeCompare(a.date));

        // Model distribution sorted by tokens descending
        const totalForPct = totalTokens || 1;
        const modelDistribution: ModelDistribution[] = Array.from(modelMap.entries())
            .map(([model, v]) => ({
                model,
                ...v,
                percentage: Math.round((v.tokens / totalForPct) * 10000) / 100,
            }))
            .sort((a, b) => b.tokens - a.tokens);

        return {
            totalTokens,
            totalCostUsd,
            totalCalls: records.length,
            byProvider,
            dailyStats,
            modelDistribution,
        };
    }

    /**
     * Return per-day aggregated stats for the last N days.
     */
    getDailyStats(days: number = 30): DailyStats[] {
        const cutoff = Date.now() - days * 86_400_000;
        const data = this.loadData();
        const dailyMap = new Map<string, { tokens: number; costUsd: number; callCount: number }>();

        for (const r of data.records) {
            if (r.timestamp < cutoff) continue;
            const day = new Date(r.timestamp).toISOString().slice(0, 10);
            const d = dailyMap.get(day) ?? { tokens: 0, costUsd: 0, callCount: 0 };
            d.tokens += r.totalTokens;
            d.costUsd += r.costUsd;
            d.callCount += 1;
            dailyMap.set(day, d);
        }

        return Array.from(dailyMap.entries())
            .map(([date, v]) => ({ date, ...v }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }

    /**
     * Return token usage grouped by model.
     */
    getModelDistribution(): ModelDistribution[] {
        const data = this.loadData();
        const modelMap = new Map<string, { tokens: number; costUsd: number; callCount: number }>();
        let total = 0;

        for (const r of data.records) {
            total += r.totalTokens;
            const m = modelMap.get(r.model) ?? { tokens: 0, costUsd: 0, callCount: 0 };
            m.tokens += r.totalTokens;
            m.costUsd += r.costUsd;
            m.callCount += 1;
            modelMap.set(r.model, m);
        }

        const totalForPct = total || 1;
        return Array.from(modelMap.entries())
            .map(([model, v]) => ({
                model,
                ...v,
                percentage: Math.round((v.tokens / totalForPct) * 10000) / 100,
            }))
            .sort((a, b) => b.tokens - a.tokens);
    }

    /**
     * Return total cost across all records.
     */
    getTotalCost(): number {
        const data = this.loadData();
        return data.records.reduce((acc, r) => acc + r.costUsd, 0);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    clearStats() {
        this.context.globalState.update(UsageTracker.STORAGE_KEY, undefined);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    private loadData(): PersistedUsageData {
        const raw = this.context.globalState.get<PersistedUsageData>(UsageTracker.STORAGE_KEY);
        if (!raw || !Array.isArray(raw.records)) {
            return { records: [], version: 1 };
        }
        return raw;
    }

    private saveData(data: PersistedUsageData) {
        this.context.globalState.update(UsageTracker.STORAGE_KEY, data);
    }

    /**
     * Remove records older than AUTO_CLEANUP_DAYS.
     */
    private purgeOldRecords(data: PersistedUsageData) {
        const cutoff = Date.now() - AUTO_CLEANUP_DAYS * 86_400_000;
        const before = data.records.length;
        data.records = data.records.filter(r => r.timestamp >= cutoff);
        if (data.records.length < before) {
            console.log(`[UsageTracker] Purged ${before - data.records.length} records older than ${AUTO_CLEANUP_DAYS} days`);
        }
    }
}
