/**
 * WorkBuddy 国区每日签到定时调度、原子状态持久化与汇总统计。
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

const STATE_FILE = 'workbuddy-checkin.json';

function emptyState(): WorkBuddyCheckinState {
    return {};
}

function parseState(raw: string | undefined): { state: WorkBuddyCheckinState; lastRunAt?: number } {
    if (!raw) return { state: emptyState() };
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { state: emptyState() };
        }
        const record = parsed as Record<string, unknown>;
        if ('accounts' in record && typeof record.accounts === 'object' && record.accounts !== null && !Array.isArray(record.accounts)) {
            return {
                state: record.accounts as WorkBuddyCheckinState,
                ...(typeof record.lastRunAt === 'number' && Number.isFinite(record.lastRunAt) ? { lastRunAt: record.lastRunAt } : {}),
            };
        }
        return { state: record as WorkBuddyCheckinState };
    } catch {
        return { state: emptyState() };
    }
}

export interface WorkBuddyCheckinSummary {
    enabled: boolean;
    signedInToday: boolean;
    signedInCount: number;
    skippedCount: number;
    failedCount: number;
    accountCount: number;
    lastRunAt?: number;
    lastError?: string;
}

export interface WorkBuddyCheckinServiceOptions {
    storageDir: string;
    accounts(): Promise<{ id: string; credentials: WorkBuddyCredentials }[]>;
    ensureFresh(credentials: WorkBuddyCredentials, force?: boolean): Promise<WorkBuddyCredentials>;
    isEnabled?: () => boolean;
    fetchFn?: typeof fetch;
    pauseFn?: (ms: number) => Promise<void>;
    randomFn?: () => number;
}

export class WorkBuddyCheckinService {
    private readonly statePath: string;
    private timer?: ReturnType<typeof setInterval>;
    private inFlight?: Promise<WorkBuddyCheckinResult[]>;
    private manualQueued = false;
    private lastRunAt?: number;
    private lastSummary: WorkBuddyCheckinSummary;

    constructor(private readonly options: WorkBuddyCheckinServiceOptions) {
        this.statePath = path.join(options.storageDir, STATE_FILE);
        const initial = this.readStateSync();
        this.lastRunAt = initial.lastRunAt;
        this.lastSummary = {
            enabled: options.isEnabled?.() ?? false,
            signedInToday: false,
            signedInCount: 0,
            skippedCount: 0,
            failedCount: 0,
            accountCount: 0,
            ...(initial.lastRunAt === undefined ? {} : { lastRunAt: initial.lastRunAt }),
        };
    }

    /** 只读最近一次落盘/运行摘要（不产生任何网络请求）。 */
    async summary(nowMs: number = Date.now()): Promise<WorkBuddyCheckinSummary> {
        const enabled = this.options.isEnabled?.() ?? this.lastSummary.enabled;
        const all = await this.options.accounts().catch(() => [] as { id: string; credentials: WorkBuddyCredentials }[]);
        const eligible = all.filter(account => !isWorkBuddyIntlDomain(account.credentials.domain));
        const { state, lastRunAt } = this.readStateSync();
        const today = localDateString(nowMs);
        let signedInCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        let lastError: string | undefined;

        for (const account of eligible) {
            const entry = state[account.id];
            if (entry === undefined || entry.date !== today) continue;
            if (entry.done) signedInCount += 1;
            else if (entry.inactive === true) skippedCount += 1;
            else if (entry.attempts >= WORKBUDDY_CHECKIN_ATTEMPT_CAP) {
                failedCount += 1;
                if (entry.lastError && !lastError) lastError = entry.lastError;
            } else if (entry.lastError && !lastError) {
                lastError = entry.lastError;
            }
        }

        const effectiveRunAt = this.lastRunAt ?? lastRunAt;
        this.lastSummary = {
            enabled,
            signedInToday: signedInCount > 0,
            signedInCount,
            skippedCount,
            failedCount,
            accountCount: eligible.length,
            ...(effectiveRunAt === undefined ? {} : { lastRunAt: effectiveRunAt }),
            ...(lastError === undefined ? {} : { lastError }),
        };
        return { ...this.lastSummary };
    }

    /** 返回同步内存快照（适合不方便等待异步磁盘扫描的路径）。 */
    cachedSummary(): WorkBuddyCheckinSummary {
        return {
            ...this.lastSummary,
            enabled: this.options.isEnabled?.() ?? this.lastSummary.enabled,
        };
    }

    private readStateSync(): { state: WorkBuddyCheckinState; lastRunAt?: number } {
        try {
            return parseState(fs.readFileSync(this.statePath, 'utf8'));
        } catch {
            return { state: emptyState() };
        }
    }

    private writeStateSync(state: WorkBuddyCheckinState, lastRunAt?: number): void {
        const temporary = `${this.statePath}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
            const doc = {
                accounts: state,
                ...(lastRunAt === undefined ? {} : { lastRunAt }),
            };
            fs.writeFileSync(temporary, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(temporary, this.statePath);
        } catch (error) {
            try { fs.unlinkSync(temporary); } catch { /* best effort */ }
            ErrorReporter.debug(SOURCE.AI_SERVICE, 'WorkBuddy check-in state could not be written.', error);
        }
    }

    /**
     * 触发一轮国区账号签到。
     * 手动运行会忽略失败次数上限与 inactive 节流；若正值自动运行则排队保证立即重试一次。
     */
    run(nowMs: number = Date.now(), options: { manual?: boolean } = {}): Promise<WorkBuddyCheckinResult[]> {
        if (this.inFlight !== undefined) {
            if (options.manual) this.manualQueued = true;
            return this.inFlight;
        }
        const promise = this.executePass(nowMs, options.manual === true).finally(() => {
            if (this.inFlight === promise) this.inFlight = undefined;
            if (this.manualQueued) {
                this.manualQueued = false;
                void this.run(Date.now(), { manual: true }).catch(() => undefined);
            }
        });
        this.inFlight = promise;
        return promise;
    }

    private async executePass(nowMs: number, manual: boolean): Promise<WorkBuddyCheckinResult[]> {
        const enabled = this.options.isEnabled?.() ?? this.lastSummary.enabled;
        if (!manual && !enabled) return [];

        const today = localDateString(nowMs);
        const all = await this.options.accounts().catch(() => [] as { id: string; credentials: WorkBuddyCredentials }[]);
        const eligible = all.filter(account => !isWorkBuddyIntlDomain(account.credentials.domain));
        if (eligible.length === 0) {
            this.lastRunAt = nowMs;
            const { state } = this.readStateSync();
            this.writeStateSync(state, nowMs);
            this.lastSummary = {
                enabled,
                signedInToday: false,
                signedInCount: 0,
                skippedCount: 0,
                failedCount: 0,
                accountCount: 0,
                lastRunAt: nowMs,
            };
            return [];
        }

        const { state } = this.readStateSync();
        const runnable = eligible.filter(account => {
            if (manual) return true;
            const entry = state[account.id];
            if (entry === undefined || entry.date !== today) return true;
            if (entry.done) return false;
            return entry.attempts < WORKBUDDY_CHECKIN_ATTEMPT_CAP;
        });

        let latestState = state;
        const runOptions: WorkBuddyCheckinOptions = {
            ...(this.options.fetchFn === undefined ? {} : { fetchFn: this.options.fetchFn }),
            ...(this.options.pauseFn === undefined ? {} : { pauseFn: this.options.pauseFn }),
            ...(this.options.randomFn === undefined ? {} : { randomFn: this.options.randomFn }),
            manual,
            ensureFresh: this.options.ensureFresh,
            readState: () => Promise.resolve(this.readStateSync().state),
            writeState: value => {
                latestState = value;
                this.writeStateSync(value, nowMs);
                return Promise.resolve();
            },
        };

        const results = await runWorkBuddyCheckinPass(runnable, runOptions, nowMs);
        this.lastRunAt = nowMs;
        if (runnable.length === 0) {
            this.writeStateSync(latestState, nowMs);
        }
        await this.summary(nowMs);
        return results;
    }

    /** 按偏好启停 10 分钟定时签到循环。 */
    setEnabled(enabled: boolean): void {
        this.lastSummary.enabled = enabled;
        if (enabled) {
            this.start();
        } else {
            this.stop();
        }
    }

    /** 启动每 10 分钟一拍的定时检查（首拍立即运行；已签状态全短路不发网）。 */
    start(): void {
        if (this.timer !== undefined) return;
        void this.run().catch(error => {
            ErrorReporter.debug(SOURCE.AI_SERVICE, 'WorkBuddy initial check-in pass failed.', error);
        });
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
