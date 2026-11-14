/**
 * WorkBuddy / CodeBuddy 订阅账号额度与账单查询。
 *
 * 读取 `/billing/meter/get-user-resource`（POST `{}`），对 `data.Response.Data.Accounts[]`
 * 全部套餐条目的总容量、剩余容量、周期用量与周期上限求和，映射为统一的两条进度仪表：
 * `cycle`（当期用量）与 `package`（资源包余量）。缓存按账号 ID 隔离并限制最大条目数。
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

/** 内存中最多缓存的账号额度条数，防止长期运行中无界增长。 */
export const WORKBUDDY_QUOTA_CACHE_LIMIT = 20;

export interface WorkBuddyBilling {
    packageName: string | null;
    totalCredits: number | null;
    remainingCredits: number | null;
    cycleUsedCredits: number | null;
    cycleCredits: number | null;
    cycleStartsAt: number | null;
    cycleEndsAt: number | null;
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

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function formatAmount(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 解析网关返回的本地时间字符串（`YYYY-MM-DD HH:mm:ss`）或 Unix 秒/毫秒时间戳。 */
export function parseWorkBuddyCycleTime(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 0 && value < 1e11 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Date.parse(value.trim().replace(' ', 'T'));
    return Number.isFinite(parsed) ? parsed : null;
}

/** 将账单响应中多份套餐容量汇总为单一 `WorkBuddyBilling` 快照。 */
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

/** 把账单事实转换为共享号池可渲染的 `SubscriptionQuotaMeter[]`。 */
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

const cachedQuotaEntries = new Map<string, SubscriptionAccountQuota>();
const inFlightQuotaRequests = new Map<string, Promise<SubscriptionAccountQuota>>();
let quotaCacheEpoch = 0;

function rememberQuotaSnapshot(accountKey: string, quota: SubscriptionAccountQuota): void {
    cachedQuotaEntries.set(accountKey, quota);
    while (cachedQuotaEntries.size > WORKBUDDY_QUOTA_CACHE_LIMIT) {
        const oldest = [...cachedQuotaEntries.entries()]
            .sort((left, right) => left[1].fetchedAt - right[1].fetchedAt)[0];
        if (!oldest) break;
        cachedQuotaEntries.delete(oldest[0]);
    }
}

/** 读取指定账号键的最近缓存额度（只读内存，不触发网络）。 */
export function getCachedWorkBuddyQuotaFor(accountKey?: string | null): SubscriptionAccountQuota | undefined {
    if (accountKey) return cachedQuotaEntries.get(accountKey);
    return getCachedWorkBuddyQuota();
}

/** 读取最近一次写入缓存的 WorkBuddy 账号额度。 */
export function getCachedWorkBuddyQuota(): SubscriptionAccountQuota | undefined {
    let newest: SubscriptionAccountQuota | undefined;
    for (const snapshot of cachedQuotaEntries.values()) {
        if (!newest || snapshot.fetchedAt > newest.fetchedAt) newest = snapshot;
    }
    return newest;
}

/** 清空内存中的 WorkBuddy 额度缓存。 */
export function clearCachedWorkBuddyQuota(): void {
    quotaCacheEpoch += 1;
    cachedQuotaEntries.clear();
    inFlightQuotaRequests.clear();
}

/**
 * 查询单个 WorkBuddy 账号额度，按 `accountKey` 做单飞合流与有界 TTL 缓存。
 * 失败仅向上抛出供卡片标注读取失败，不引发凭据停用。
 */
export async function fetchWorkBuddyQuota(
    credentials: WorkBuddyCredentials,
    accountKey: string,
    options: WorkBuddyQuotaOptions = {},
    force = false,
): Promise<SubscriptionAccountQuota> {
    const cached = cachedQuotaEntries.get(accountKey);
    if (!force && cached && Date.now() - cached.fetchedAt < WORKBUDDY_QUOTA_CACHE_TTL_MS) {
        return cached;
    }
    const existingFlight = inFlightQuotaRequests.get(accountKey);
    if (existingFlight) return existingFlight;

    const epoch = quotaCacheEpoch;
    const fetchFn = options.fetchFn ?? fetch;
    const timeout = AbortSignal.timeout(WORKBUDDY_DISCOVERY_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    const promise = (async (): Promise<SubscriptionAccountQuota> => {
        const response = await fetchFn(`${credentials.backend}${WORKBUDDY_BILLING_PATH}`, {
            method: 'POST',
            headers: workBuddyHeaders(credentials),
            body: '{}',
            signal,
        });
        const text = await response.text().catch(() => '');
        if (!response.ok) {
            throw new Error(
                `${WORKBUDDY_PROVIDER_NAME} billing lookup failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
            );
        }
        let payload: unknown;
        try {
            payload = JSON.parse(text);
        } catch {
            throw new Error(`${WORKBUDDY_PROVIDER_NAME} billing lookup returned non-JSON.`);
        }
        const root = isRecord(payload) ? payload : undefined;
        if (root !== undefined && typeof root.code === 'number' && root.code !== 0) {
            throw new Error(
                `${WORKBUDDY_PROVIDER_NAME} billing lookup was rejected: ${asString(root.msg) ?? 'no detail'}`,
            );
        }
        const billing = parseWorkBuddyBilling(payload);
        const quota: SubscriptionAccountQuota = {
            meters: workBuddyBillingMeters(billing),
            fetchedAt: Date.now(),
        };
        if (epoch === quotaCacheEpoch) {
            rememberQuotaSnapshot(accountKey, quota);
        }
        return quota;
    })();

    inFlightQuotaRequests.set(accountKey, promise);
    try {
        return await promise;
    } finally {
        if (inFlightQuotaRequests.get(accountKey) === promise) {
            inFlightQuotaRequests.delete(accountKey);
        }
    }
}
