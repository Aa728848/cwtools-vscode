/**
 * WorkBuddy 每日签到。
 *
 * 网关的签到面是 `POST /billing/meter/checkin-activity-status`（问今天是否已签）与
 * `POST /billing/meter/daily-checkin`（真正签到换额度）。两个请求都用**本扩展已经在发的那套
 * 诚实请求头**（bearer + 账号身份头），不伪造任何第一方标记——因此这个功能可以照常实现。
 *
 * 调度纪律（与参照实现一致，且每一条都有理由）：
 * - **幂等**：先问状态；已签到只记录。重复提交被上游拒绝算**成功**，不是重试。
 * - **对当天有耐心**：今天既不可签也未签（活动未开放）时按小时复查，而不是放弃——活动
 *   按自己的时间开放，而宿主机通常比它先启动。
 * - **有界**：失败一天最多重试 CHECKIN_ATTEMPT_CAP 次，一个坏账号不会把定时器变成请求循环。
 * - `inactive` 与 `done` **分开记**：把两者混为一谈会让卡片声称一次根本没发生的签到。
 */

import { isRecord } from '../../../shared/protocolValidation';
import type { WorkBuddyCredentials } from './credentials';
import { workBuddyHeaders } from './client';

/** 活动状态面：今天是否已经签过。 */
export const WORKBUDDY_CHECKIN_STATUS_PATH = '/billing/meter/checkin-activity-status';
/** 签到面：额度在这里发放。 */
export const WORKBUDDY_CHECKIN_PATH = '/billing/meter/daily-checkin';

/** 调度节奏。启动时的第一拍就是当天的运行；之后每十分钟一拍，空拍不产生任何请求。 */
export const WORKBUDDY_CHECKIN_TICK_MS = 10 * 60 * 1000;
/** 一个账号当天的自动重试上限。 */
export const WORKBUDDY_CHECKIN_ATTEMPT_CAP = 3;
export const WORKBUDDY_CHECKIN_TIMEOUT_MS = 20_000;
/**
 * 一个没有活动权益的账号多久后再问一次。
 *
 * 活动按自己的时间开放，所以当天第一次「还没开」通常不是「今天没有」。按小时复查让早启动的
 * 宿主不至于错过当天，同时每个账号每小时至多一次状态请求。
 */
export const WORKBUDDY_CHECKIN_INACTIVE_RECHECK_MS = 60 * 60 * 1000;

/** 一个时刻属于哪个本地日历日；状态条目按它归类。 */
export function localDateString(nowMs: number): string {
    const date = new Date(nowMs);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function asBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
}

function readFlag(data: Record<string, unknown>, ...keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = asBoolean(data[key]);
        if (value !== undefined) return value;
    }
    return undefined;
}

function asNumberField(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 一个账号在一个本地日的签到记账。 */
export interface WorkBuddyCheckinEntry {
    /** 本条目描述的本地日期；更早的条目是昨天的新闻。 */
    date: string;
    /** 今天确认已签到——到明天之前无事可做。 */
    done: boolean;
    /** 当天已用掉的尝试次数，自动运行受 CHECKIN_ATTEMPT_CAP 约束。 */
    attempts: number;
    /** 活动回答「今天没有权益」。非终局：过一会儿再问，可能已经开放。 */
    inactive?: boolean;
    inactiveAt?: number;
    /** 上游在成功时一并回传的总额度，便于卡片展示。 */
    totalCredits?: number;
    lastError?: string;
    lastRunAt?: number;
}

export type WorkBuddyCheckinState = Record<string, WorkBuddyCheckinEntry>;

/** 一个账号当天的签到结果。 */
export interface WorkBuddyCheckinResult {
    accountId: string;
    /** true 表示今天已签到（含「本来就已签」）。 */
    signedIn: boolean;
    /** 今天没有活动权益，需要稍后复查。 */
    inactive: boolean;
    totalCredits?: number;
    error?: string;
}

export interface WorkBuddyCheckinOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** 已续期并写回存储的凭据；签到本身不负责轮换。 */
    ensureFresh(credentials: WorkBuddyCredentials): Promise<WorkBuddyCredentials>;
    /** 上一次结果是否为 401。 */
    isUnauthorized(response: { code?: unknown; msg?: string } | null): boolean;
    /** 今天是否已经跑过。 */
    readState(): Promise<WorkBuddyCheckinState>;
    writeState(state: WorkBuddyCheckinState): Promise<void>;
}

async function postJson(
    url: string,
    credentials: WorkBuddyCredentials,
    options: WorkBuddyCheckinOptions,
): Promise<Record<string, unknown> | null> {
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
    if (!response.ok) {
        throw new Error('WorkBuddy check-in request failed (' + response.status + ').');
    }
    const payload: unknown = await response.json().catch(() => undefined);
    return isRecord(payload) ? payload : null;
}

function markSignedIn(entry: WorkBuddyCheckinEntry, data: Record<string, unknown>): void {
    entry.done = true;
    entry.inactive = false;
    delete entry.inactiveAt;
    delete entry.lastError;
    const credits = asNumberField(data.total_credits) ?? asNumberField(data.totalCredits);
    if (credits !== undefined) entry.totalCredits = credits;
}

/**
 * 为一个账号跑一次当天的签到。
 *
 * 状态先问、已签只记录；401 用一次强制续期回答而不是白白烧掉一次尝试。
 */
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
        return { accountId, signedIn: true, inactive: false, ...(entry.totalCredits === undefined ? {} : { totalCredits: entry.totalCredits }) };
    }
    // 一个既没签到、也不在重试窗口内的「无活动」答案，按小时复查而不是每拍都问。
    if (entry.inactive === true && entry.inactiveAt !== undefined
        && nowMs - entry.inactiveAt < WORKBUDDY_CHECKIN_INACTIVE_RECHECK_MS) {
        return { accountId, signedIn: false, inactive: true };
    }
    entry.lastRunAt = nowMs;
    try {
        const fresh = await options.ensureFresh(credentials);
        let status = await postJson(fresh.backend + WORKBUDDY_CHECKIN_STATUS_PATH, fresh, options);
        // 被服务端提前吊销的令牌在本地看着仍未过期，因此 401 要用一次强制续期回答，
        // 而不是把这次机会烧掉。
        if (options.isUnauthorized(status)) {
            const refreshed = await options.ensureFresh(fresh);
            status = await postJson(refreshed.backend + WORKBUDDY_CHECKIN_STATUS_PATH, refreshed, options);
        }
        const statusData = isRecord(status?.data) ? status.data : {};
        if (readFlag(statusData, 'today_checked_in', 'todayCheckedIn') === true) {
            markSignedIn(entry, statusData);
            return { accountId, signedIn: true, inactive: false, ...(entry.totalCredits === undefined ? {} : { totalCredits: entry.totalCredits }) };
        }
        if (readFlag(statusData, 'active', 'Active') === false) {
            // 记录而非终局：活动按自己的时间开放，宿主机通常比它先启动。
            entry.inactive = true;
            entry.inactiveAt = nowMs;
            delete entry.lastError;
            return { accountId, signedIn: false, inactive: true };
        }
        entry.inactive = false;
        delete entry.inactiveAt;
        let result = await postJson(fresh.backend + WORKBUDDY_CHECKIN_PATH, fresh, options);
        if (options.isUnauthorized(result)) {
            const refreshed = await options.ensureFresh(fresh);
            result = await postJson(refreshed.backend + WORKBUDDY_CHECKIN_PATH, refreshed, options);
        }
        const payload = isRecord(result?.data) ? result.data : {};
        if (result !== null && result.code === 0) {
            markSignedIn(entry, payload);
            return { accountId, signedIn: true, inactive: false, ...(entry.totalCredits === undefined ? {} : { totalCredits: entry.totalCredits }) };
        }
        // 上游因为「今天已经签过」而拒绝，也是一次成功。把它当失败会白白烧掉重试预算。
        if (typeof result?.msg === 'string' && /already|已签|重复/i.test(result.msg)) {
            markSignedIn(entry, payload);
            return { accountId, signedIn: true, inactive: false, ...(entry.totalCredits === undefined ? {} : { totalCredits: entry.totalCredits }) };
        }
        entry.attempts += 1;
        entry.lastError = 'code ' + String(result?.code ?? 'no-response') + ': '
            + String(result?.msg ?? 'check-in rejected');
        return { accountId, signedIn: false, inactive: false, error: entry.lastError };
    } catch (error) {
        entry.attempts += 1;
        entry.lastError = error instanceof Error ? error.message : String(error);
        return { accountId, signedIn: false, inactive: false, error: entry.lastError };
    }
}

/**
 * 为一组账号跑当天的签到，逐个记账。
 *
 * 一个账号失败不影响其他账号：每个账号的结果是独立的，卡片据此分别显示。
 */
export async function runWorkBuddyCheckinPass(
    accounts: readonly { id: string; credentials: WorkBuddyCredentials }[],
    options: WorkBuddyCheckinOptions,
    nowMs: number = Date.now(),
): Promise<WorkBuddyCheckinResult[]> {
    const state = await options.readState();
    const results: WorkBuddyCheckinResult[] = [];
    for (const account of accounts) {
        results.push(await runWorkBuddyCheckinOnce(account.id, account.credentials, state, options, nowMs));
    }
    await options.writeState(state);
    return results;
}
