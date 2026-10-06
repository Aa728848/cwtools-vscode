/**
 * WorkBuddy 账号额度（账单额度）。
 *
 * 网关的账单面是 `/billing/meter/get-user-resource`（POST，空 body），响应嵌套为
 * `data.Response.Data.Accounts[]`，每个条目描述一个已购套餐及其容量计数。实测要点：
 *
 * - 用户可能同时持有多个套餐，因此各项容量**按全部条目求和**，而不是只取第一条；
 * - 容量（total/remaining）与周期计数（cycle used/size）是**两套独立数字**，只报周期
 *   数字的账号仍然有有意义的余额，因此两者各成一个仪表；
 * - 周期边界以**无时区的本地时间字符串**下发（`2026-09-01 00:00:00`），按本地时间解析，
 *   与 IDE 自己的面板读数一致。
 *
 * 额度读取失败**不是**凭据失败：它只让这一次快照少一个数字，绝不写任何东西、也不让账号
 * 退出轮转。
 */

import { isRecord } from '../../../shared/protocolValidation';
import type { SubscriptionAccountQuota, SubscriptionQuotaMeter } from '../../../shared/subscriptionQuota';
import {
    WORKBUDDY_BILLING_PATH,
    WORKBUDDY_DISCOVERY_TIMEOUT_MS,
    WORKBUDDY_PROVIDER_NAME,
    WORKBUDDY_QUOTA_CACHE_TTL_MS,
} from './types';
import { workBuddyHeaders } from './client';
import type { WorkBuddyCredentials } from './credentials';

export interface WorkBuddyQuotaOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 已解析的账单事实；字段为 null 表示上游未报。 */
export interface WorkBuddyBilling {
    packageName: string | null;
    totalCredits: number | null;
    remainingCredits: number | null;
    cycleUsedCredits: number | null;
    cycleCredits: number | null;
    cycleStartsAt: number | null;
    cycleEndsAt: number | null;
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function formatAmount(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * 解析周期边界。
 *
 * 服务下发不带时区的本地时间字符串，`Date.parse` 会按本地时间读——这正是 IDE 面板的读法，
 * 因此卡片与官方面板一致。纯数字按 Unix 秒（小于 1e11）或毫秒处理。
 */
export function parseWorkBuddyCycleTime(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 0 && value < 1e11 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Date.parse(value.trim().replace(' ', 'T'));
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 解析账单负载的账号列表。
 *
 * `Accounts[]` 的容量字段**求和**：一个用户可同时持有多个套餐。`PackageName` 取第一个非空值。
 */
export function parseWorkBuddyBilling(payload: unknown): WorkBuddyBilling {
    const root = isRecord(payload) ? payload : {};
    const data = isRecord(root.data) ? root.data : root;
    const response = isRecord(data.Response) ? data.Response : data;
    const body = isRecord(response.Data) ? response.Data : response;
    const accounts = Array.isArray(body.Accounts) ? body.Accounts : [];

    let total: number | undefined;
    let remaining: number | undefined;
    let cycleUsed: number | undefined;
    let cycleTotal: number | undefined;
    let packageName: string | null = null;
    let cycleStart: number | null = null;
    let cycleEnd: number | null = null;

    for (const entry of accounts) {
        if (!isRecord(entry)) continue;
        if (packageName === null) packageName = asString(entry.PackageName) ?? null;
        const size = asNumber(entry.CapacitySize);
        const remain = asNumber(entry.CapacityRemain);
        const used = asNumber(entry.CycleCapacityUsed);
        const cycleSize = asNumber(entry.CycleCapacitySize);
        if (size !== undefined) total = (total ?? 0) + size;
        if (remain !== undefined) remaining = (remaining ?? 0) + remain;
        if (used !== undefined) cycleUsed = (cycleUsed ?? 0) + used;
        if (cycleSize !== undefined) cycleTotal = (cycleTotal ?? 0) + cycleSize;
        cycleStart ??= parseWorkBuddyCycleTime(entry.CycleStartTime);
        cycleEnd ??= parseWorkBuddyCycleTime(entry.CycleEndTime);
    }

    return {
        packageName,
        totalCredits: total ?? null,
        remainingCredits: remaining ?? null,
        cycleUsedCredits: cycleUsed ?? null,
        cycleCredits: cycleTotal ?? null,
        cycleStartsAt: cycleStart,
        cycleEndsAt: cycleEnd,
    };
}

/**
 * 把账单事实变成仪表。
 *
 * 两个数字各成一个仪表：套餐容量（total/remaining）与周期计数（used/size）是独立事实，
 * 只报其一的账号仍然要能画出它有的那一个。
 */
export function workBuddyBillingMeters(billing: WorkBuddyBilling): SubscriptionQuotaMeter[] {
    const meters: SubscriptionQuotaMeter[] = [];
    const { cycleCredits, cycleUsedCredits, totalCredits, remainingCredits } = billing;

    if (cycleCredits !== null && cycleCredits > 0 && cycleUsedCredits !== null) {
        const usedPercent = clamp01(cycleUsedCredits / cycleCredits);
        meters.push({
            id: 'cycle',
            labelKey: 'cycle',
            usedPercent,
            remainingPercent: Math.max(0, 1 - usedPercent),
            used: formatAmount(cycleUsedCredits),
            limit: formatAmount(cycleCredits),
            ...(billing.cycleEndsAt === null ? {} : { resetsAt: billing.cycleEndsAt }),
        });
    }

    if (totalCredits !== null && totalCredits > 0 && remainingCredits !== null) {
        const remainingPercent = clamp01(remainingCredits / totalCredits);
        meters.push({
            id: 'package',
            // A service-named package wins; the generic key localizes otherwise.
            ...(billing.packageName === null ? { labelKey: 'package' as const } : { label: billing.packageName }),
            usedPercent: Math.max(0, 1 - remainingPercent),
            remainingPercent,
            used: formatAmount(totalCredits - remainingCredits),
            limit: formatAmount(totalCredits),
            ...(billing.cycleEndsAt === null ? {} : { resetsAt: billing.cycleEndsAt }),
        });
    }

    return meters;
}

interface QuotaCacheEntry {
    accountKey: string;
    quota: SubscriptionAccountQuota;
}

let quotaCache: QuotaCacheEntry | null = null;
let quotaInFlight: { accountKey: string; promise: Promise<SubscriptionAccountQuota> } | null = null;

/** 丢弃内存中的额度快照，让下一次读取重新访问网关。 */
export function clearCachedWorkBuddyQuota(): void {
    quotaCache = null;
    quotaInFlight = null;
}

/**
 * 读取一个账号的额度。
 *
 * @param accountKey 身份键：缓存与单飞都按账号归类，否则切换账号会拿到上一个账号的数字。
 */
export async function fetchWorkBuddyQuota(
    credentials: WorkBuddyCredentials,
    accountKey: string,
    options: WorkBuddyQuotaOptions = {},
    force = false,
): Promise<SubscriptionAccountQuota> {
    if (!force
        && quotaCache !== null
        && quotaCache.accountKey === accountKey
        && Date.now() - quotaCache.quota.fetchedAt < WORKBUDDY_QUOTA_CACHE_TTL_MS) {
        return quotaCache.quota;
    }
    if (quotaInFlight !== null && quotaInFlight.accountKey === accountKey) return quotaInFlight.promise;

    const fetchFn = options.fetchFn ?? fetch;
    const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(WORKBUDDY_DISCOVERY_TIMEOUT_MS)])
        : AbortSignal.timeout(WORKBUDDY_DISCOVERY_TIMEOUT_MS);

    const promise = (async (): Promise<SubscriptionAccountQuota> => {
        const response = await fetchFn(credentials.backend + WORKBUDDY_BILLING_PATH, {
            method: 'POST',
            headers: workBuddyHeaders(credentials),
            body: '{}',
            signal,
        });
        const text = await response.text().catch(() => '');
        if (!response.ok) {
            throw new Error(WORKBUDDY_PROVIDER_NAME + ' billing lookup failed (' + response.status + ')'
                + (text ? ': ' + text.slice(0, 200) : ''));
        }
        let payload: unknown;
        try { payload = JSON.parse(text); } catch { throw new Error(WORKBUDDY_PROVIDER_NAME + ' billing lookup returned non-JSON.'); }
        const root = isRecord(payload) ? payload : undefined;
        if (root !== undefined && typeof root.code === 'number' && root.code !== 0) {
            throw new Error(WORKBUDDY_PROVIDER_NAME + ' billing lookup was rejected: ' + (asString(root.msg) ?? 'no detail'));
        }
        const billing = parseWorkBuddyBilling(payload);
        const quota: SubscriptionAccountQuota = {
            meters: workBuddyBillingMeters(billing),
            fetchedAt: Date.now(),
        };
        quotaCache = { accountKey, quota };
        return quota;
    })();

    quotaInFlight = { accountKey, promise };
    try {
        return await promise;
    } finally {
        if (quotaInFlight?.promise === promise) quotaInFlight = null;
    }
}
