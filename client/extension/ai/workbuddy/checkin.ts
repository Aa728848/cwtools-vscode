/**
 * WorkBuddy 国区每日签到线协议与幂等状态流转。
 *
 * 纪律：
 * - 先问 `/billing/meter/checkin-activity-status`，已签仅记录 `done: true`；
 * - 重复提交若被上游回复 `"already"` / `"已签"` / `"今日"`，按成功计而非重试；
 * - 活动暂未开放（`active === false`）独立记入 `inactive`，按 1 小时节流复查，不假称已签；
 * - 自动调度单账号单日失败最多 3 次；手动点击立即签到（`manual: true`）忽略每日重试上限与节流；
 * - 多账号批跑之间加 2~5s 随机抖动，减少同一出口突发请求导致的风控风险。
 */

import { isRecord } from '../../../shared/protocolValidation';
import type { WorkBuddyCredentials } from './credentials';
import { workBuddyHeaders } from './client';
import {
    WORKBUDDY_CHECKIN_PATH,
    WORKBUDDY_CHECKIN_STATUS_PATH,
} from './types';

export const WORKBUDDY_CHECKIN_TICK_MS = 10 * 60 * 1000;
export const WORKBUDDY_CHECKIN_ATTEMPT_CAP = 3;
export const WORKBUDDY_CHECKIN_TIMEOUT_MS = 20_000;
export const WORKBUDDY_CHECKIN_INACTIVE_RECHECK_MS = 60 * 60 * 1000;
export const WORKBUDDY_CHECKIN_JITTER_MIN_MS = 2_000;
export const WORKBUDDY_CHECKIN_JITTER_MAX_MS = 5_000;

/** 返回时间戳所在本地日历日 `YYYY-MM-DD`。 */
export function localDateString(nowMs: number): string {
    const date = new Date(nowMs);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function readBool(data: Record<string, unknown>, ...keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'boolean') return value;
        if (value === 1 || value === '1' || value === 'true') return true;
        if (value === 0 || value === '0' || value === 'false') return false;
    }
    return undefined;
}

function readCount(data: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return undefined;
}

function isAlreadySignedInMessage(result: Record<string, unknown> | null): boolean {
    if (result === null) return false;
    const message = typeof result.msg === 'string'
        ? result.msg
        : (typeof result.message === 'string' ? result.message : '');
    const lower = message.toLowerCase();
    return lower.includes('already') || message.includes('已签') || message.includes('今日');
}

export interface WorkBuddyCheckinEntry {
    date: string;
    done: boolean;
    attempts: number;
    inactive?: boolean;
    inactiveAt?: number;
    streakDays?: number;
    totalCredits?: number;
    lastError?: string;
    lastRunAt?: number;
}

export type WorkBuddyCheckinState = Record<string, WorkBuddyCheckinEntry>;

export interface WorkBuddyCheckinResult {
    accountId: string;
    signedIn: boolean;
    inactive: boolean;
    streakDays?: number;
    totalCredits?: number;
    error?: string;
}

export interface WorkBuddyCheckinOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** 若为 true（如设置页手动点击立即签到），忽略当天失败上限与 inactive 1 小时节流。 */
    manual?: boolean;
    /** 多账号间抖动暂停器；单元测试可传入空操作或自定义实现避免耗时等待。 */
    pauseFn?: (ms: number) => Promise<void>;
    randomFn?: () => number;
    /** 按常规刷新凭据，并可选传入 `force: true` 在遇到 401 时强制刷新一次。 */
    ensureFresh(credentials: WorkBuddyCredentials, force?: boolean): Promise<WorkBuddyCredentials>;
    isUnauthorized?(response: { code?: unknown; msg?: string } | null): boolean;
    readState(): Promise<WorkBuddyCheckinState>;
    writeState(state: WorkBuddyCheckinState): Promise<void>;
}

async function postJson(
    url: string,
    credentials: WorkBuddyCredentials,
    options: WorkBuddyCheckinOptions,
): Promise<{ httpStatus: number; body: Record<string, unknown> | null }> {
    const fetchFn = options.fetchFn ?? fetch;
    const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(WORKBUDDY_CHECKIN_TIMEOUT_MS)])
        : AbortSignal.timeout(WORKBUDDY_CHECKIN_TIMEOUT_MS);
    const response = await fetchFn(url, {
        method: 'POST',
        headers: workBuddyHeaders(credentials),
        body: '{}',
        signal,
    });
    const payload: unknown = await response.json().catch(() => undefined);
    return {
        httpStatus: response.status,
        body: isRecord(payload) ? payload : null,
    };
}

function defaultIsUnauthorized(httpStatus: number, body: Record<string, unknown> | null, custom?: WorkBuddyCheckinOptions['isUnauthorized']): boolean {
    if (httpStatus === 401 || httpStatus === 403) return true;
    if (custom) return custom(body);
    return body !== null && (body.code === 401 || body.code === 403);
}

function markSignedIn(entry: WorkBuddyCheckinEntry, data: Record<string, unknown>): void {
    entry.done = true;
    entry.inactive = false;
    delete entry.inactiveAt;
    delete entry.lastError;
    const streakDays = readCount(data, 'streak_days', 'streakDays');
    if (streakDays !== undefined) entry.streakDays = streakDays;
    const totalCredits = readCount(data, 'total_credits', 'totalCredits');
    if (totalCredits !== undefined) entry.totalCredits = totalCredits;
}

/** 为单个国区账号执行当天的一次签到检查与领取。 */
export async function runWorkBuddyCheckinOnce(
    accountId: string,
    credentials: WorkBuddyCredentials,
    state: WorkBuddyCheckinState,
    options: WorkBuddyCheckinOptions,
    nowMs: number = Date.now(),
): Promise<WorkBuddyCheckinResult> {
    const today = localDateString(nowMs);
    const previous = state[accountId];
    const entry: WorkBuddyCheckinEntry = previous !== undefined && previous.date === today
        ? previous
        : { date: today, done: false, attempts: 0 };
    state[accountId] = entry;

    if (entry.done) {
        return {
            accountId,
            signedIn: true,
            inactive: false,
            ...(entry.streakDays === undefined ? {} : { streakDays: entry.streakDays }),
            ...(entry.totalCredits === undefined ? {} : { totalCredits: entry.totalCredits }),
        };
    }

    const manual = options.manual === true;
    if (!manual && entry.attempts >= WORKBUDDY_CHECKIN_ATTEMPT_CAP) {
        return {
            accountId,
            signedIn: false,
            inactive: entry.inactive === true,
            ...(entry.lastError ? { error: entry.lastError } : {}),
        };
    }

    if (!manual
        && entry.inactive === true
        && entry.inactiveAt !== undefined
        && nowMs - entry.inactiveAt < WORKBUDDY_CHECKIN_INACTIVE_RECHECK_MS) {
        return { accountId, signedIn: false, inactive: true };
    }

    entry.lastRunAt = nowMs;
    try {
        let fresh = await options.ensureFresh(credentials, false);
        let statusRes = await postJson(`${fresh.backend}${WORKBUDDY_CHECKIN_STATUS_PATH}`, fresh, options);
        if (defaultIsUnauthorized(statusRes.httpStatus, statusRes.body, options.isUnauthorized)) {
            fresh = await options.ensureFresh(fresh, true);
            statusRes = await postJson(`${fresh.backend}${WORKBUDDY_CHECKIN_STATUS_PATH}`, fresh, options);
        }
        if (statusRes.httpStatus < 200 || statusRes.httpStatus >= 300) {
            throw new Error(`WorkBuddy check-in status failed (${statusRes.httpStatus}).`);
        }

        const statusData = isRecord(statusRes.body?.data) ? statusRes.body.data : {};
        if (readBool(statusData, 'today_checked_in', 'todayCheckedIn') === true) {
            markSignedIn(entry, statusData);
            return {
                accountId,
                signedIn: true,
                inactive: false,
                ...(entry.streakDays === undefined ? {} : { streakDays: entry.streakDays }),
                ...(entry.totalCredits === undefined ? {} : { totalCredits: entry.totalCredits }),
            };
        }
        if (readBool(statusData, 'active', 'Active') === false) {
            entry.inactive = true;
            entry.inactiveAt = nowMs;
            delete entry.lastError;
            return { accountId, signedIn: false, inactive: true };
        }

        entry.inactive = false;
        delete entry.inactiveAt;

        let checkinRes = await postJson(`${fresh.backend}${WORKBUDDY_CHECKIN_PATH}`, fresh, options);
        if (defaultIsUnauthorized(checkinRes.httpStatus, checkinRes.body, options.isUnauthorized)) {
            fresh = await options.ensureFresh(fresh, true);
            checkinRes = await postJson(`${fresh.backend}${WORKBUDDY_CHECKIN_PATH}`, fresh, options);
        }
        if (checkinRes.httpStatus < 200 || checkinRes.httpStatus >= 300) {
            throw new Error(`WorkBuddy check-in request failed (${checkinRes.httpStatus}).`);
        }

        const result = checkinRes.body;
        const payload = isRecord(result?.data) ? result.data : {};
        if (result !== null && result.code === 0) {
            markSignedIn(entry, payload);
            return {
                accountId,
                signedIn: true,
                inactive: false,
                ...(entry.streakDays === undefined ? {} : { streakDays: entry.streakDays }),
                ...(entry.totalCredits === undefined ? {} : { totalCredits: entry.totalCredits }),
            };
        }
        if (isAlreadySignedInMessage(result)) {
            markSignedIn(entry, payload);
            return {
                accountId,
                signedIn: true,
                inactive: false,
                ...(entry.streakDays === undefined ? {} : { streakDays: entry.streakDays }),
                ...(entry.totalCredits === undefined ? {} : { totalCredits: entry.totalCredits }),
            };
        }

        entry.attempts += 1;
        const detail = typeof result?.msg === 'string'
            ? result.msg
            : (typeof result?.message === 'string' ? result.message : 'check-in rejected');
        entry.lastError = `code ${String(result?.code ?? 'no-response')}: ${detail}`;
        return { accountId, signedIn: false, inactive: false, error: entry.lastError };
    } catch (error) {
        entry.attempts += 1;
        entry.lastError = error instanceof Error ? error.message : String(error);
        return { accountId, signedIn: false, inactive: false, error: entry.lastError };
    }
}

/** 串行跑完一轮全部候选国区账号签到（含多账号随机抖动延迟并持久保存状态）。 */
export async function runWorkBuddyCheckinPass(
    accounts: readonly { id: string; credentials: WorkBuddyCredentials }[],
    options: WorkBuddyCheckinOptions,
    nowMs: number = Date.now(),
): Promise<WorkBuddyCheckinResult[]> {
    const state = await options.readState();
    const pauseFn = options.pauseFn ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const randomFn = options.randomFn ?? Math.random;
    const results: WorkBuddyCheckinResult[] = [];
    let executedNetworkCount = 0;

    for (const account of accounts) {
        const today = localDateString(nowMs);
        const existing = state[account.id];
        const sameDay = existing?.date === today;
        const willHitNetwork = !sameDay
            || (!existing.done
                && (options.manual === true
                    || (existing.attempts < WORKBUDDY_CHECKIN_ATTEMPT_CAP
                        && !(existing.inactive === true
                            && nowMs - (existing.inactiveAt ?? 0) < WORKBUDDY_CHECKIN_INACTIVE_RECHECK_MS))));
        if (willHitNetwork && executedNetworkCount > 0) {
            const jitter = WORKBUDDY_CHECKIN_JITTER_MIN_MS
                + Math.floor(randomFn() * (WORKBUDDY_CHECKIN_JITTER_MAX_MS - WORKBUDDY_CHECKIN_JITTER_MIN_MS));
            if (jitter > 0) await pauseFn(jitter);
        }
        const res = await runWorkBuddyCheckinOnce(account.id, account.credentials, state, options, nowMs);
        if (willHitNetwork) executedNetworkCount += 1;
        results.push(res);
    }

    await options.writeState(state);
    return results;
}
