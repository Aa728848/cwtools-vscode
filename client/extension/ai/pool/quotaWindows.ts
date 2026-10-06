/**
 * 把各线路的「按比例计费的窗口」收敛成统一的额度仪表。
 *
 * Codex、Claude 订阅、Kimi 的用量面形状不同，但表达的是同一件事：一个有名有重置时刻的
 * 已用比例。收敛在一处可以保证四条线路的卡片读数不会各自漂移（尤其是**百分比与分数两种
 * 单位**——Claude 的 `utilization` 在用量负载里是 0-100，在响应头里是 0-1）。
 */

import type { SubscriptionQuotaMeter } from '../../../shared/subscriptionQuota';

/** 一个窗口的归一化输入；比例一律是 0-1 的**已用**。 */
export interface QuotaWindow {
    id: string;
    label: string;
    /** 已用比例 [0,1]；与 usedPercent 二选一。 */
    usedFraction?: number;
    /** 已用百分数 [0,100]；与 usedFraction 二选一。 */
    usedPercent?: number;
    used?: string;
    limit?: string;
    /** Unix 毫秒重置时刻。 */
    resetsAt?: number;
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/**
 * 把一个窗口变成仪表。
 *
 * 比例缺失但**有金额**时仍然产出仪表：一个只报余额（没有分母）的额度是真实事实，卡片把它
 * 画成一个数值。两者都没有才返回 undefined——宁可不画，也不画一个编出来的 0。
 */
export function quotaWindowMeter(window: QuotaWindow): SubscriptionQuotaMeter | undefined {
    const raw = window.usedFraction ?? (window.usedPercent === undefined ? undefined : window.usedPercent / 100);
    if (raw === undefined || !Number.isFinite(raw)) {
        if (window.used === undefined && window.limit === undefined) return undefined;
        return {
            id: window.id,
            label: window.label,
            ...(window.used === undefined ? {} : { used: window.used }),
            ...(window.limit === undefined ? {} : { limit: window.limit }),
            ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        };
    }
    const usedPercent = clamp01(raw);
    return {
        id: window.id,
        label: window.label,
        usedPercent,
        remainingPercent: Math.max(0, 1 - usedPercent),
        ...(window.used === undefined ? {} : { used: window.used }),
        ...(window.limit === undefined ? {} : { limit: window.limit }),
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    };
}

/** 批量转换，丢弃无法画的窗口。 */
export function quotaWindowMeters(windows: readonly QuotaWindow[]): SubscriptionQuotaMeter[] {
    const meters: SubscriptionQuotaMeter[] = [];
    for (const window of windows) {
        const meter = quotaWindowMeter(window);
        if (meter !== undefined) meters.push(meter);
    }
    return meters;
}

/**
 * 解析一个重置时刻。
 *
 * 上游三种写法都出现过：Unix 秒、Unix 毫秒、ISO 字符串。三种都读，读不出就返回 undefined。
 */
export function quotaResetInstant(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        // Below 1e11 is a second-precision stamp (1e11 ms is year 5138).
        return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
}
