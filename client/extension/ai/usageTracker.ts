import * as vs from 'vscode';
import { CacheRequestUsage, TokenUsage } from './types';
import { ErrorReporter } from './errorReporter';
import { getModelPricing, getCacheDiscountFactor } from './providers/models/pricing';
import { isCacheCapableUsage } from './cacheCapability';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface UsageRecord {
    timestamp: number;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCny: number;
    /** Input tokens that hit prefix cache (0 if not applicable) */
    cachedTokens?: number;
    /** Net input tokens excluding cache hits */
    netInputTokens?: number;
    /** Net total tokens excluding cache hits */
    netTotalTokens?: number;
    /** Pre-computed cost saved by cache hits (from agentRunner) */
    cacheSavedCostCny?: number;
    /**
     * Whether this request was cache-capable (prefix cache supported by the
     * provider/format). Records without this flag are inferred at read time.
     */
    cacheCapable?: boolean;
    /** Tool calls made in this request (Batch 4.2) */
    toolCalls?: Record<string, number>;
    /** Response latency in ms (Batch 4.2) */
    durationMs?: number;
    /** Topic/session ID for grouping (Batch 4.2) */
    topicId?: string;
    /** Agent mode that produced this request (plan §7.3 per-mode cache aggregation) */
    agentMode?: string;
    /** Short frozen-prompt fingerprint hash for cache grouping (plan §7.3) */
    promptFingerprint?: string;
    /** Completed provider-call samples for request-accurate cache metrics. */
    cacheRequests?: CacheRequestUsage[];
    /** Aggregated provider calls beyond the persisted per-call sample cap. */
    cacheRequestOverflow?: CacheRequestUsage[];
    /** Exact aggregate tail whose high-cardinality dimensions were dropped. */
    cacheRequestRemainder?: CacheRequestUsage[];
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

export interface CacheDimensionStats {
    requests: number;
    hitRequests: number;
    requestHitRate: number;
    cacheHitRate: number;
}

export interface UsageStats {
    totalTokens: number;
    /** Net total tokens excluding cache hits */
    totalNetTokens?: number;
    totalCostCny: number;
    totalCalls: number;
    byProvider: Record<string, ProviderStats>;
    dailyStats: DailyStats[];
    modelDistribution: ModelDistribution[];
    /** Batch 4.2: Aggregated tool call frequencies */
    toolFrequency: { tool: string; count: number; percentage: number }[];
    /** Batch 4.2: Average response time in ms */
    avgResponseMs: number;
    /** Aggregate cache hit statistics */
    cacheStats: {
        totalCachedTokens: number;
        totalInputTokens: number;
        /** Input tokens from cache-capable requests, including zero-hit requests */
        cacheCapableInputTokens: number;
        /** cachedTokens / cacheCapableInputTokens (0-100 percentage) */
        cacheHitRate: number;
        /** cachedTokens / totalInputTokens across all requests (0-100 percentage) */
        cachedInputTokenRatio: number;
        /**
         * Share of cache-capable requests that observed any cached tokens
         * (0-100 percentage). Distinguishes "provider did not hit at all"
         * (cacheCapable but cachedTokens=0) from token-level partial hits.
         */
        requestHitRate: number;
        byProvider: Record<string, CacheDimensionStats>;
        byModel: Record<string, CacheDimensionStats>;
        byAgentMode: Record<string, CacheDimensionStats>;
        byToolStage: Record<string, CacheDimensionStats>;
        byPromptFingerprint: Record<string, CacheDimensionStats>;
        /** Cache-capable zero-hit request count by explicit invalidation/miss reason. */
        invalidationReasons: Record<string, number>;
        estimatedSavingsCny: number; // cost saved by cache hits
    };
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
        // agentMode/promptFingerprint arrive as extra fields on the runner's
        // token accumulator (see agentRunner); chatPanel passes it through unchanged.
        usage: TokenUsage,
        options?: {
            toolCalls?: Record<string, number>;
            durationMs?: number;
            topicId?: string;
            /** Caller-computed cache capability (provider + wire format). Inferred from providerId when omitted. */
            cacheCapable?: boolean;
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
            cachedTokens: usage.cachedTokens ?? 0,
            netInputTokens: usage.netInput ?? (usage.input - (usage.cachedTokens ?? 0)),
            netTotalTokens: usage.netTotal ?? (usage.input - (usage.cachedTokens ?? 0) + usage.output),
            cacheSavedCostCny: usage.cacheSavedCostCny,
            cacheCapable: options?.cacheCapable ?? isCacheCapableUsage(providerId, usage.cachedTokens),
            toolCalls: options?.toolCalls,
            durationMs: options?.durationMs,
            topicId: options?.topicId,
            agentMode: usage.agentMode,
            promptFingerprint: usage.promptFingerprint,
            cacheRequests: usage.cacheRequests?.slice(0, 256).map(request => ({ ...request })),
            cacheRequestOverflow: usage.cacheRequestOverflow?.slice(0, 64).map(request => ({ ...request })),
            cacheRequestRemainder: usage.cacheRequestRemainder?.slice(0, 2).map(request => ({ ...request })),
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
        let totalNetTokens = 0;
        let totalCostCny = 0;
        const byProvider: Record<string, ProviderStats> = {};
        const dailyMap = new Map<string, { tokens: number; costCny: number; callCount: number }>();
        const modelMap = new Map<string, { tokens: number; costCny: number; callCount: number }>();

        for (const r of records) {
            totalTokens += r.totalTokens;
            totalNetTokens += r.netTotalTokens ?? r.totalTokens;
            totalCostCny += r.costCny;

            // By provider
            if (!byProvider[r.provider]) {
                byProvider[r.provider] = { tokens: 0, costCny: 0 };
            }

            byProvider[r.provider]!.tokens += r.netTotalTokens ?? r.totalTokens;

            byProvider[r.provider]!.costCny += r.costCny;

            // By day
            let day = 'unknown';
            try {
                if (r.timestamp) day = new Date(r.timestamp).toISOString().slice(0, 10);
            } catch { /* ignore invalid dates */ }
            const d = dailyMap.get(day) ?? { tokens: 0, costCny: 0, callCount: 0 };
            d.tokens += r.netTotalTokens ?? r.totalTokens;
            d.costCny += r.costCny;
            d.callCount += 1;
            dailyMap.set(day, d);

            // By model
            const m = modelMap.get(r.model) ?? { tokens: 0, costCny: 0, callCount: 0 };
            m.tokens += r.netTotalTokens ?? r.totalTokens;
            m.costCny += r.costCny;
            m.callCount += 1;
            modelMap.set(r.model, m);
        }

        // Daily stats sorted by date descending
        const dailyStats: DailyStats[] = Array.from(dailyMap.entries())
            .map(([date, v]) => ({ date, ...v }))
            .sort((a, b) => b.date.localeCompare(a.date));

        // Model distribution sorted by tokens descending
        const totalForPct = totalNetTokens || 1;
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

        // Cache hit statistics.
        // The hit-rate denominator covers every cache-capable request, including
        // zero-hit requests (e.g. cache warm-up calls); counting only requests
        // with observed hits would systematically inflate the rate.
        const cacheSamples = records.flatMap((record): CacheRequestUsage[] => {
            if ((Array.isArray(record.cacheRequests) && record.cacheRequests.length > 0)
                || (Array.isArray(record.cacheRequestOverflow) && record.cacheRequestOverflow.length > 0)
                || (Array.isArray(record.cacheRequestRemainder) && record.cacheRequestRemainder.length > 0)) {
                return [
                    ...(record.cacheRequests ?? []),
                    ...(record.cacheRequestOverflow ?? []),
                    ...(record.cacheRequestRemainder ?? []),
                ];
            }
            const cacheCapable = record.cacheCapable ?? isCacheCapableUsage(record.provider, record.cachedTokens);
            return [{
                provider: record.provider,
                model: record.model,
                inputTokens: record.inputTokens,
                cachedTokens: record.cachedTokens ?? 0,
                cacheCapable,
                agentMode: record.agentMode,
                promptFingerprint: record.promptFingerprint,
                invalidationReason: cacheCapable && (record.cachedTokens ?? 0) === 0
                    ? 'provider_miss'
                    : undefined,
            }];
        });
        let totalCachedTokens = 0;
        let totalInputTokens = 0;
        let cacheCapableInputTokens = 0;
        let cacheCapableRequests = 0;
        let cacheHitRequests = 0;
        type MutableCacheBucket = { requests: number; hitRequests: number; cachedTokens: number; inputTokens: number };
        const byProviderMap = new Map<string, MutableCacheBucket>();
        const byModelMap = new Map<string, MutableCacheBucket>();
        const byAgentModeMap = new Map<string, MutableCacheBucket>();
        const byToolStageMap = new Map<string, MutableCacheBucket>();
        const byPromptFingerprintMap = new Map<string, MutableCacheBucket>();
        const invalidationReasons = new Map<string, number>();
        const addBucket = (map: Map<string, MutableCacheBucket>, key: string, sample: CacheRequestUsage, hit: boolean) => {
            const bucket = map.get(key) ?? { requests: 0, hitRequests: 0, cachedTokens: 0, inputTokens: 0 };
            const requestCount = sample.requestCount ?? 1;
            bucket.requests += requestCount;
            bucket.hitRequests += sample.hitRequestCount ?? (hit ? requestCount : 0);
            bucket.cachedTokens += sample.cachedTokens;
            bucket.inputTokens += sample.inputTokens;
            map.set(key, bucket);
        };
        for (const sample of cacheSamples) {
            const requestCount = sample.requestCount ?? 1;
            const hitRequestCount = sample.hitRequestCount ?? (sample.cachedTokens > 0 ? requestCount : 0);
            totalCachedTokens += sample.cachedTokens;
            totalInputTokens += sample.inputTokens;
            if (!sample.cacheCapable) continue;
            cacheCapableInputTokens += sample.inputTokens;
            cacheCapableRequests += requestCount;
            const hit = sample.cachedTokens > 0;
            cacheHitRequests += hitRequestCount;
            addBucket(byProviderMap, sample.provider || 'unknown', sample, hit);
            addBucket(byModelMap, sample.model || 'unknown', sample, hit);
            addBucket(byAgentModeMap, sample.agentMode ?? 'unspecified', sample, hit);
            addBucket(byToolStageMap, sample.toolStage ?? 'unspecified', sample, hit);
            addBucket(byPromptFingerprintMap, sample.promptFingerprint ?? 'unspecified', sample, hit);
            const missRequestCount = Math.max(0, requestCount - hitRequestCount);
            if (missRequestCount > 0) {
                const reason = sample.invalidationReason ?? 'provider_miss';
                invalidationReasons.set(reason, (invalidationReasons.get(reason) ?? 0) + missRequestCount);
            }
        }
        const cacheHitRate = cacheCapableInputTokens > 0
            ? Math.round((totalCachedTokens / cacheCapableInputTokens) * 10000) / 100
            : 0;
        const cachedInputTokenRatio = totalInputTokens > 0
            ? Math.round((totalCachedTokens / totalInputTokens) * 10000) / 100
            : 0;
        const requestHitRate = cacheCapableRequests > 0
            ? Math.round((cacheHitRequests / cacheCapableRequests) * 10000) / 100
            : 0;
        // Sorted keys keep the aggregated output deterministic.
        const finishBuckets = (map: Map<string, MutableCacheBucket>): Record<string, CacheDimensionStats> => {
            const result: Record<string, CacheDimensionStats> = {};
            for (const [key, bucket] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
                result[key] = {
                    requests: bucket.requests,
                    hitRequests: bucket.hitRequests,
                    requestHitRate: bucket.requests > 0
                        ? Math.round((bucket.hitRequests / bucket.requests) * 10000) / 100
                        : 0,
                    cacheHitRate: bucket.inputTokens > 0
                        ? Math.round((bucket.cachedTokens / bucket.inputTokens) * 10000) / 100
                        : 0,
                };
            }
            return result;
        };
        const cacheByProvider = finishBuckets(byProviderMap);
        const cacheByModel = finishBuckets(byModelMap);
        const cacheByAgentMode = finishBuckets(byAgentModeMap);
        const cacheByToolStage = finishBuckets(byToolStageMap);
        const cacheByPromptFingerprint = finishBuckets(byPromptFingerprintMap);
        const invalidationReasonCounts: Record<string, number> = {};
        for (const [reason, count] of [...invalidationReasons.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            invalidationReasonCounts[reason] = count;
        }
        // Estimated savings: cached tokens billed at discounted rate vs full price
        // Use actual cost data per record for more accurate savings calculation
        let estimatedSavingsCny = 0;
        for (const r of records) {
            if (r.cachedTokens && r.cachedTokens > 0) {
                // Prefer pre-computed savings from agentRunner (uses accurate response.model)
                if (r.cacheSavedCostCny !== undefined && r.cacheSavedCostCny > 0) {
                    estimatedSavingsCny += r.cacheSavedCostCny;
                } else {
                    // Fallback: re-compute from pricing table (may fail if model name doesn't match)
                    const model = r.model;
                    const pricing = getModelPricing(model, r.provider);
                    const cacheDiscount = getCacheDiscountFactor(model, r.provider);
                    // Savings = cached tokens * full price * (1 - discount factor)
                    estimatedSavingsCny += (r.cachedTokens / 1_000_000) * pricing[0] * (1 - cacheDiscount);
                }
            }
        }
        estimatedSavingsCny = Math.round(estimatedSavingsCny * 1000000) / 1000000;

        return {
            totalTokens: totalTokens,  // Total including cache hits
            totalNetTokens,             // Net total excluding cache hits
            totalCostCny,
            totalCalls: records.length,
            byProvider,
            dailyStats,
            modelDistribution,
            toolFrequency,
            avgResponseMs,
            cacheStats: {
                totalCachedTokens,
                totalInputTokens,
                cacheCapableInputTokens,
                cacheHitRate,
                cachedInputTokenRatio,
                requestHitRate,
                byProvider: cacheByProvider,
                byModel: cacheByModel,
                byAgentMode: cacheByAgentMode,
                byToolStage: cacheByToolStage,
                byPromptFingerprint: cacheByPromptFingerprint,
                invalidationReasons: invalidationReasonCounts,
                estimatedSavingsCny,
            },
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
            let day = 'unknown';
            try {
                if (r.timestamp) day = new Date(r.timestamp).toISOString().slice(0, 10);
            } catch { /* ignore invalid dates */ }
            const d = dailyMap.get(day) ?? { tokens: 0, costCny: 0, callCount: 0 };
            d.tokens += r.netTotalTokens ?? r.totalTokens;
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
            const netTokens = r.netTotalTokens ?? r.totalTokens;
            total += netTokens;
            const m = modelMap.get(r.model) ?? { tokens: 0, costCny: 0, callCount: 0 };
            m.tokens += netTokens;
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
        const headers = ['timestamp', 'date', 'provider', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'costCny', 'durationMs', 'topicId', 'toolCalls'];
        const rows = records.map(r => [
            r.timestamp,
            (function(){ try { return new Date(r.timestamp).toISOString(); } catch { return 'unknown'; } })(),
            r.provider,
            r.model,
            r.inputTokens,
            r.outputTokens,
            r.totalTokens,
            r.cachedTokens ?? 0,
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
            ErrorReporter.debug('UsageTracker', `Purged ${before - data.records.length} records older than ${AUTO_CLEANUP_DAYS} days`);
        }
    }
}
