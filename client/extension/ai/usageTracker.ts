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
    costCny: number;
    /** Tool calls made in this request (Batch 4.2) */
    toolCalls?: Record<string, number>;
    /** Response latency in ms (Batch 4.2) */
    durationMs?: number;
    /** Topic/session ID for grouping (Batch 4.2) */
    topicId?: string;
}

export interface ProviderStats {
    tokens: number;
    costCny: number;
}

export interface DailyStats {
    date: string; // YYYY-MM-DD
    tokens: number;
    costCny: number;
    callCount: number;
}

export interface ModelDistribution {
    model: string;
    tokens: number;
    costCny: number;
    callCount: number;
    percentage: number; // 0-100
}

export interface UsageStats {
    totalTokens: number;
    totalCostCny: number;
    totalCalls: number;
    byProvider: Record<string, ProviderStats>;
    dailyStats: DailyStats[];
    modelDistribution: ModelDistribution[];
    /** Batch 4.2: Aggregated tool call frequencies */
    toolFrequency: { tool: string; count: number; percentage: number }[];
    /** Batch 4.2: Average response time in ms */
    avgResponseMs: number;
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

    addUsage(
        providerId: string,
        model: string,
        usage: TokenUsage,
        options?: {
            toolCalls?: Record<string, number>;
            durationMs?: number;
            topicId?: string;
        }
    ) {
        if (!usage || typeof usage.total !== 'number') return;

        const data = this.loadData();

        data.records.push({
            timestamp: Date.now(),
            provider: providerId,
            model: model || 'unknown',
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            totalTokens: usage.total,
            costCny: usage.estimatedCostCny ?? 0,
            toolCalls: options?.toolCalls,
            durationMs: options?.durationMs,
            topicId: options?.topicId,
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
        let totalCostCny = 0;
        const byProvider: Record<string, ProviderStats> = {};
        const dailyMap = new Map<string, { tokens: number; costCny: number; callCount: number }>();
        const modelMap = new Map<string, { tokens: number; costCny: number; callCount: number }>();

        for (const r of records) {
            totalTokens += r.totalTokens;
            totalCostCny += r.costCny;

            // By provider
            if (!byProvider[r.provider]) {
                byProvider[r.provider] = { tokens: 0, costCny: 0 };
            }
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            byProvider[r.provider]!.tokens += r.totalTokens;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            byProvider[r.provider]!.costCny += r.costCny;

            // By day
            const day = new Date(r.timestamp).toISOString().slice(0, 10);
            const d = dailyMap.get(day) ?? { tokens: 0, costCny: 0, callCount: 0 };
            d.tokens += r.totalTokens;
            d.costCny += r.costCny;
            d.callCount += 1;
            dailyMap.set(day, d);

            // By model
            const m = modelMap.get(r.model) ?? { tokens: 0, costCny: 0, callCount: 0 };
            m.tokens += r.totalTokens;
            m.costCny += r.costCny;
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

        // Batch 4.2: Tool frequency aggregation
        const toolMap = new Map<string, number>();
        let totalDurationMs = 0;
        let durationCount = 0;
        for (const r of records) {
            if (r.toolCalls) {
                for (const [tool, count] of Object.entries(r.toolCalls)) {
                    toolMap.set(tool, (toolMap.get(tool) ?? 0) + count);
                }
            }
            if (r.durationMs && r.durationMs > 0) {
                totalDurationMs += r.durationMs;
                durationCount++;
            }
        }
        const totalToolCalls = Array.from(toolMap.values()).reduce((a, b) => a + b, 0) || 1;
        const toolFrequency = Array.from(toolMap.entries())
            .map(([tool, count]) => ({
                tool,
                count,
                percentage: Math.round((count / totalToolCalls) * 10000) / 100,
            }))
            .sort((a, b) => b.count - a.count);
        const avgResponseMs = durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0;

        return {
            totalTokens,
            totalCostCny,
            totalCalls: records.length,
            byProvider,
            dailyStats,
            modelDistribution,
            toolFrequency,
            avgResponseMs,
        };
    }

    /**
     * Return per-day aggregated stats for the last N days.
     */
    getDailyStats(days: number = 30): DailyStats[] {
        const cutoff = Date.now() - days * 86_400_000;
        const data = this.loadData();
        const dailyMap = new Map<string, { tokens: number; costCny: number; callCount: number }>();

        for (const r of data.records) {
            if (r.timestamp < cutoff) continue;
            const day = new Date(r.timestamp).toISOString().slice(0, 10);
            const d = dailyMap.get(day) ?? { tokens: 0, costCny: 0, callCount: 0 };
            d.tokens += r.totalTokens;
            d.costCny += r.costCny;
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
        const modelMap = new Map<string, { tokens: number; costCny: number; callCount: number }>();
        let total = 0;

        for (const r of data.records) {
            total += r.totalTokens;
            const m = modelMap.get(r.model) ?? { tokens: 0, costCny: 0, callCount: 0 };
            m.tokens += r.totalTokens;
            m.costCny += r.costCny;
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
        return data.records.reduce((acc, r) => acc + r.costCny, 0);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Batch 4.2: Export all usage records as CSV or JSON.
     * Supports optional date range filtering.
     */
    exportStats(format: 'csv' | 'json', options?: { fromDate?: number; toDate?: number }): string {
        const data = this.loadData();
        let records = data.records;

        // Filter by date range if specified
        if (options?.fromDate) {
            records = records.filter(r => r.timestamp >= options.fromDate!);
        }
        if (options?.toDate) {
            records = records.filter(r => r.timestamp <= options.toDate!);
        }

        if (format === 'json') {
            return JSON.stringify(records, null, 2);
        }

        // CSV format
        const headers = ['timestamp', 'date', 'provider', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'costCny', 'durationMs', 'topicId', 'toolCalls'];
        const rows = records.map(r => [
            r.timestamp,
            new Date(r.timestamp).toISOString(),
            r.provider,
            r.model,
            r.inputTokens,
            r.outputTokens,
            r.totalTokens,
            r.costCny.toFixed(6),
            r.durationMs ?? '',
            r.topicId ?? '',
            r.toolCalls ? Object.entries(r.toolCalls).map(([k, v]) => `${k}:${v}`).join(';') : '',
        ].join(','));

        return [headers.join(','), ...rows].join('\n');
    }

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
