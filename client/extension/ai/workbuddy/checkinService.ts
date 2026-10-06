/**
 * WorkBuddy 每日签到的调度与状态。
 *
 * 签到是「当天一次」的额度动作，因此这个服务只做三件事：按时机跑一遍、把当天的事实记到磁盘、
 * 把结果报给设置卡片。请求的线协议在 `checkin.ts`；这里只管**什么时候跑**与**跑过什么**。
 *
 * 关键纪律（与请求层同样重要）：
 * - **空拍不产生请求**。当天状态已经确认签到时，定时拍直接短路。
 * - **失败有界**。一个坏账号一天最多试三次，否则一个坏账号就把十分钟一拍变成请求循环。
 * - **写盘是原子的**。中途被打断时原文件逐字节不变，否则第二天会以为已经签过而漏掉当天。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorReporter } from '../errorReporter';
import { SOURCE } from '../messages';
import { isWorkBuddyIntlDomain } from './types';
import type { WorkBuddyCredentials } from './credentials';
import {
    localDateString,
    runWorkBuddyCheckinPass,
    WORKBUDDY_CHECKIN_ATTEMPT_CAP,
    WORKBUDDY_CHECKIN_TICK_MS,
    type WorkBuddyCheckinEntry,
    type WorkBuddyCheckinOptions,
    type WorkBuddyCheckinResult,
    type WorkBuddyCheckinState,
} from './checkin';

/** 状态文档的文件名。 */
const STATE_FILE = 'workbuddy-checkin.json';

function emptyState(): WorkBuddyCheckinState {
    return {};
}

function parseState(raw: string | undefined): WorkBuddyCheckinState {
    if (!raw) return emptyState();
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyState();
        return parsed as WorkBuddyCheckinState;
    } catch {
        return emptyState();
    }
}

export interface WorkBuddyCheckinSummary {
    /** 当天有任何一个账号签到成功。 */
    signedInToday: boolean;
    /** 今天成功签到的账号数。 */
    signedInCount: number;
    /** 参与的账号数（不含隐藏的桌面账号）。 */
    accountCount: number;
    /** 上一次运行时刻（Unix 毫秒）。 */
    lastRunAt?: number;
    /** 最近一次失败原因，供卡片显示。 */
    lastError?: string;
}

export interface WorkBuddyCheckinServiceOptions {
    /** 状态目录；生产是扩展的 globalStorage。 */
    storageDir: string;
    /** 当前可调度的账号。 */
    accounts(): Promise<{ id: string; credentials: WorkBuddyCredentials }[]>;
    /** 已续期并写回存储的凭据。 */
    ensureFresh(credentials: WorkBuddyCredentials): Promise<WorkBuddyCredentials>;
    fetchFn?: typeof fetch;
}

export class WorkBuddyCheckinService {
    private readonly statePath: string;
    private timer?: ReturnType<typeof setInterval>;
    private inFlight?: Promise<WorkBuddyCheckinResult[]>;
    private lastSummary: WorkBuddyCheckinSummary = {
        signedInToday: false,
        signedInCount: 0,
        accountCount: 0,
    };

    constructor(private readonly options: WorkBuddyCheckinServiceOptions) {
        this.statePath = path.join(options.storageDir, STATE_FILE);
    }

    /** 卡片当前显示的汇总。 */
    summary(): WorkBuddyCheckinSummary {
        return { ...this.lastSummary };
    }

    private readState(): Promise<WorkBuddyCheckinState> {
        try {
            return Promise.resolve(parseState(fs.readFileSync(this.statePath, 'utf8')));
        } catch {
            return Promise.resolve(emptyState());
        }
    }

    private writeState(state: WorkBuddyCheckinState): Promise<void> {
        // 原子替换：临时文件 + rename。中途被打断时原文件逐字节不变，否则一个半截的
        // 状态文件会让第二天以为当天已经签过而漏掉签到。
        const temporary = `${this.statePath}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
            fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(temporary, this.statePath);
        } catch (error) {
            try { fs.unlinkSync(temporary); } catch { /* best effort */ }
            ErrorReporter.debug(SOURCE.AI_SERVICE, 'WorkBuddy check-in state could not be written.', error);
        }
        return Promise.resolve();
    }

    /**
     * 跑一次当天的签到。
     *
     * 进行中的运行会被**复用**而不是并发：手动点击和定时拍可能撞在一起，而签到是当天一次的
     * 额度动作，重复提交只是浪费往返。
     */
    run(nowMs: number = Date.now()): Promise<WorkBuddyCheckinResult[]> {
        if (this.inFlight !== undefined) return this.inFlight;
        const task = this.runOnce(nowMs).finally(() => {
            if (this.inFlight === task) this.inFlight = undefined;
        });
        this.inFlight = task;
        return task;
    }

    private async runOnce(nowMs: number): Promise<WorkBuddyCheckinResult[]> {
        const today = localDateString(nowMs);
        // The activity is a CN-only billing surface. An international account has no
        // day to claim, so it is not even counted: a card that showed "signed in" for a
        // region that never had an activity would be claiming something that never
        // happened.
        const all = await this.options.accounts().catch(() => []);
        const eligible = all.filter(account => !isWorkBuddyIntlDomain(account.credentials.domain));
        if (eligible.length === 0) {
            this.lastSummary = { signedInToday: false, signedInCount: 0, accountCount: 0 };
            return [];
        }
        const state = await this.readState();
        // A bounded run: a failing account is retried at most a few times a day, so one
        // broken account cannot turn the ten-minute tick into a request loop.
        const runnable = eligible.filter(account => {
            const entry = state[account.id];
            if (entry === undefined || entry.date !== today) return true;
            if (entry.done) return false;
            return entry.inactive !== true || entry.attempts < WORKBUDDY_CHECKIN_ATTEMPT_CAP;
        });

        const runOptions: WorkBuddyCheckinOptions = {
            ...(this.options.fetchFn === undefined ? {} : { fetchFn: this.options.fetchFn }),
            ensureFresh: this.options.ensureFresh,
            isUnauthorized: result => result !== null && (result.code === 401 || result.code === 403),
            readState: () => this.readState(),
            writeState: value => this.writeState(value),
        };
        const results = await runWorkBuddyCheckinPass(runnable, runOptions, nowMs);

        const settled: WorkBuddyCheckinResult[] = eligible.map(account => {
            const entry = state[account.id];
            const done = entry !== undefined && entry.date === today && entry.done;
            return { accountId: account.id, signedIn: done, inactive: false };
        });
        const byId = new Map([...settled, ...results].map(result => [result.accountId, result]));
        const signedIn = [...byId.values()].filter(result => result.signedIn).length;
        const lastError = [...byId.values()].find(result => result.error !== undefined)?.error;
        this.lastSummary = {
            signedInToday: signedIn > 0,
            signedInCount: signedIn,
            accountCount: eligible.length,
            lastRunAt: nowMs,
            ...(lastError === undefined ? {} : { lastError }),
        };
        return results;
    }

    /**
     * 开始定时签到。
     *
     * 启动时的第一拍就是当天的运行；之后每十分钟一拍，而空拍不产生任何请求。
     */
    start(): void {
        if (this.timer !== undefined) return;
        void this.run().catch(() => undefined);
        this.timer = setInterval(() => {
            void this.run().catch(error => {
                ErrorReporter.debug(SOURCE.AI_SERVICE, 'WorkBuddy check-in pass failed.', error);
            });
        }, WORKBUDDY_CHECKIN_TICK_MS);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    dispose(): void {
        this.stop();
    }
}
export type { WorkBuddyCheckinEntry };
