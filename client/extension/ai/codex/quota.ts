/**
 * Codex（ChatGPT 订阅）的额度窗口。
 *
 * 用量面是 GET https://chatgpt.com/backend-api/wham/usage（与对话同一套订阅头）。响应按
 * 「额度桶」组织，每个桶两个窗口（短窗与周窗），各自报**已用百分数**。
 *
 * 账号状态卡片已经解析过同一份负载（用于配额条），这里复用它的 rateLimits 形状，避免
 * 同一份数据在两处各解析一次而漂移。
 */

import type { CodexRateLimitBucket } from '../types';
import type { SubscriptionAccountQuota } from '../../../shared/subscriptionQuota';
import { quotaWindowMeters, type QuotaWindow } from '../pool/quotaWindows';

/** 一个窗口的名义时长（分钟）→ 展示名。 */
function durationLabel(minutes: number | null | undefined): string | undefined {
    if (minutes === undefined || minutes === null || minutes <= 0) return undefined;
    if (Math.abs(minutes - 7 * 24 * 60) < 0.5) return 'Weekly limit';
    if (minutes >= 1440) return Math.round(minutes / 1440) + '-day';
    if (minutes >= 60) return Math.round(minutes / 60) + '-hour';
    return Math.round(minutes) + '-minute';
}

/**
 * 把账号状态里的额度桶变成仪表。
 *
 * 桶名来自服务（例如 codex、code-review）；两个窗口都画，因为短窗与周窗是不同的额度。
 */
export function codexRateLimitMeters(rateLimits: readonly CodexRateLimitBucket[] | undefined): SubscriptionAccountQuota['meters'] {
    if (!Array.isArray(rateLimits) || rateLimits.length === 0) return [];
    const windows: QuotaWindow[] = [];
    for (const bucket of rateLimits) {
        const bucketLabel = bucket.limitName || bucket.limitId || 'Codex';
        const entries: Array<[string, CodexRateLimitBucket['primary']]> = [
            ['primary', bucket.primary],
            ['secondary', bucket.secondary],
        ];
        for (const [position, window] of entries) {
            if (window === null || window === undefined) continue;
            const percent = window.usedPercent;
            if (typeof percent !== 'number' || !Number.isFinite(percent)) continue;
            const duration = durationLabel(window.windowDurationMins);
            const name = duration === undefined ? bucketLabel : bucketLabel + ' · ' + duration;
            windows.push({
                id: bucket.limitId + '-' + position,
                label: name,
                usedPercent: Math.max(0, Math.min(100, percent)),
                ...(typeof window.resetsAt === 'number' && window.resetsAt > 0
                    ? { resetsAt: Math.round(window.resetsAt * 1000) } : {}),
            });
        }
    }
    return quotaWindowMeters(windows);
}

/**
 * 把已经取到的账号状态包成额度快照。
 *
 * Codex 的额度随账号状态一起返回，因此这里**不再发一次请求**：号池只需要把同一份负载转成
 * 额度的形状。
 */
export function codexQuotaFromRateLimits(
    rateLimits: readonly CodexRateLimitBucket[] | undefined,
): SubscriptionAccountQuota {
    return { meters: codexRateLimitMeters(rateLimits), fetchedAt: Date.now() };
}
