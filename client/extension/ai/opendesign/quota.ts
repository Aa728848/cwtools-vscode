/**
 * OpenDesign AMR 控制面额度读取。
 *
 * 仅对携带 `controlKey` 的 OAuth 设备码账号开放（静态粘贴 Key 无控制面权限，直接返回
 * `undefined`，由上层设置卡片安静跳过额度区块）：
 * 1. 先查 `GET /workspaces/current`（不足则退 `GET /workspaces`）获取 `workspaceId`；
 * 2. 若拿到 `workspaceId`，依次尝试多种鉴权形态读取 `GET /workspaces/{id}/billing/coding-plan-usage`
 *    获取真实的 5 小时 / 7 天滚动窗口；
 * 3. 同时读取 `/billing/summary`（套餐等级、周期起止、余额美元）与 `/wallet/balance` 补充账户余量。
 *
 * 所有控制面请求失败均返回降级数据，绝不把账号标成 auth_failed。
 */

import { isRecord } from '../../../shared/protocolValidation';
import type { SubscriptionAccountQuota } from '../../../shared/subscriptionQuota';
import { quotaResetInstant, quotaWindowMeters, type QuotaWindow } from '../pool/quotaWindows';
import { aiText } from '../messages';
import {
    OPENDESIGN_AMR_API_BASE,
    OPENDESIGN_BILLING_SUMMARY_PATH,
    OPENDESIGN_CODING_PLAN_USAGE_SUFFIX,
    OPENDESIGN_CURRENT_WORKSPACE_PATH,
    OPENDESIGN_DISCOVERY_TIMEOUT_MS,
    OPENDESIGN_WALLET_BALANCE_PATH,
    OPENDESIGN_WORKSPACES_PATH,
} from './types';
import {
    isOpenDesignOAuthCredentials,
    type OpenDesignCredentials,
} from './credentials';

const WORKSPACE_ID_KEYS: readonly string[] = ['activeWorkspaceId', 'workspaceId', 'id'];

export interface OpenDesignCodingPlanWindow {
    policyId: string;
    durationSeconds: number;
    remainingCredits: number;
    limitCredits: number;
    resetsAt?: number;
}

export interface OpenDesignBillingRead {
    plan?: string;
    status?: string;
    periodEnd?: number;
    totalAvailableCreditsUsd?: string;
    walletBalanceUsd?: string;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return undefined;
}

function asUsd(value: unknown): string | undefined {
    return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? value.trim() : undefined;
}

function withSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timer = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timer]) : timer;
}

async function sendAmrJson(
    fetchFn: typeof fetch,
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; json: unknown }> {
    const response = await fetchFn(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: withSignal(signal, OPENDESIGN_DISCOVERY_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    let json: unknown = null;
    if (text.length > 0) {
        try { json = JSON.parse(text); } catch { json = null; }
    }
    return { ok: response.ok, status: response.status, json };
}

function workspaceIdIn(record: Record<string, unknown>): string | undefined {
    const direct = pickString(record, WORKSPACE_ID_KEYS);
    if (direct !== undefined) return direct;
    const nested = isRecord(record.workspace) ? record.workspace : undefined;
    return nested ? pickString(nested, WORKSPACE_ID_KEYS) : undefined;
}

function listedWorkspaces(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    if (!isRecord(body)) return [];
    if (Array.isArray(body.workspaces)) return body.workspaces;
    if (Array.isArray(body.items)) return body.items;
    if (Array.isArray(body.data)) return body.data;
    if (isRecord(body.data)) {
        if (Array.isArray(body.data.items)) return body.data.items;
        if (Array.isArray(body.data.workspaces)) return body.data.workspaces;
    }
    return [];
}

/** 依次探测当前工作区与工作区列表获取 `workspaceId`。 */
export async function fetchOpenDesignWorkspaceId(options: {
    controlKey: string;
    amrApiBase?: string;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
}): Promise<string | undefined> {
    const fetchFn = options.fetchFn ?? fetch;
    const base = (options.amrApiBase ?? OPENDESIGN_AMR_API_BASE).replace(/\/+$/, '');
    const auth = { Authorization: `Bearer ${options.controlKey}` };

    try {
        const current = await sendAmrJson(fetchFn, `${base}${OPENDESIGN_CURRENT_WORKSPACE_PATH}`, auth, options.signal);
        if (current.ok && isRecord(current.json)) {
            const id = workspaceIdIn(current.json)
                ?? (isRecord(current.json.data) ? workspaceIdIn(current.json.data) : undefined);
            if (id) return id;
        }
    } catch {
        // 退回到列表接口。
    }

    try {
        const list = await sendAmrJson(fetchFn, `${base}${OPENDESIGN_WORKSPACES_PATH}`, auth, options.signal);
        if (list.ok) {
            for (const entry of listedWorkspaces(list.json)) {
                if (!isRecord(entry)) continue;
                const direct = pickString(entry, ['id', 'workspaceId']);
                if (direct) return direct;
                if (isRecord(entry.workspace)) {
                    const nested = pickString(entry.workspace, ['id', 'workspaceId']);
                    if (nested) return nested;
                }
            }
        }
    } catch {
        // 忽略网络故障。
    }
    return undefined;
}

function parseCodingPlanWindow(raw: unknown): OpenDesignCodingPlanWindow | undefined {
    if (!isRecord(raw)) return undefined;
    const policyId = pickString(raw, ['policyId']) ?? 'window';
    const durationSeconds = raw.durationSeconds;
    if (typeof durationSeconds !== 'number' || !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
        return undefined;
    }
    const remaining = typeof raw.remainingCredits === 'number'
        ? raw.remainingCredits
        : typeof raw.remainingCredits === 'string' && /^\d+$/.test(raw.remainingCredits)
            ? Number(raw.remainingCredits)
            : NaN;
    const limit = typeof raw.limitCredits === 'number'
        ? raw.limitCredits
        : typeof raw.limitCredits === 'string' && /^\d+$/.test(raw.limitCredits)
            ? Number(raw.limitCredits)
            : NaN;
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || remaining < 0) {
        return undefined;
    }
    const resetsAt = quotaResetInstant(raw.resetsAt);
    return {
        policyId,
        durationSeconds,
        remainingCredits: remaining,
        limitCredits: limit,
        ...(resetsAt === undefined ? {} : { resetsAt }),
    };
}

/** 读取 Design Plan 的 5 小时与 7 天额度窗口，按三种凭据格式轮流探测（仅 401/403 换格式）。 */
export async function fetchOpenDesignCodingPlanUsage(options: {
    controlKey: string;
    runtimeKey: string;
    workspaceId: string;
    amrApiBase?: string;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
}): Promise<{ tier?: string; windows: OpenDesignCodingPlanWindow[] } | undefined> {
    const fetchFn = options.fetchFn ?? fetch;
    const base = (options.amrApiBase ?? OPENDESIGN_AMR_API_BASE).replace(/\/+$/, '');
    const url = `${base}${OPENDESIGN_WORKSPACES_PATH}/${encodeURIComponent(options.workspaceId)}${OPENDESIGN_CODING_PLAN_USAGE_SUFFIX}`;
    const attempts: Array<Record<string, string>> = [
        { Authorization: `Bearer ${options.controlKey}`, 'x-vela-workspace-id': options.workspaceId },
    ];
    if (options.runtimeKey.trim() !== '') {
        attempts.push({ Authorization: `Bearer ${options.runtimeKey.trim()}`, 'x-vela-workspace-id': options.workspaceId });
        attempts.push({ 'x-api-key': options.runtimeKey.trim(), 'x-vela-workspace-id': options.workspaceId });
    }

    for (const headers of attempts) {
        try {
            const res = await sendAmrJson(fetchFn, url, headers, options.signal);
            if (res.ok && isRecord(res.json)) {
                const rawWindows = Array.isArray(res.json.windows) ? res.json.windows : [];
                const windows = rawWindows
                    .map(parseCodingPlanWindow)
                    .filter((item): item is OpenDesignCodingPlanWindow => item !== undefined);
                const tier = typeof res.json.tier === 'string' && res.json.tier.trim() !== ''
                    ? res.json.tier.trim().toLowerCase()
                    : undefined;
                return { ...(tier ? { tier } : {}), windows };
            }
            if (res.status !== 401 && res.status !== 403) return undefined;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/** 读取账单与钱包余额作为补充面板展示。 */
export async function fetchOpenDesignBillingAndWallet(options: {
    controlKey: string;
    amrApiBase?: string;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
}): Promise<OpenDesignBillingRead> {
    const fetchFn = options.fetchFn ?? fetch;
    const base = (options.amrApiBase ?? OPENDESIGN_AMR_API_BASE).replace(/\/+$/, '');
    const auth = { Authorization: `Bearer ${options.controlKey}` };
    const out: OpenDesignBillingRead = {};

    const [billingRes, walletRes] = await Promise.all([
        sendAmrJson(fetchFn, `${base}${OPENDESIGN_BILLING_SUMMARY_PATH}`, auth, options.signal).catch(() => undefined),
        sendAmrJson(fetchFn, `${base}${OPENDESIGN_WALLET_BALANCE_PATH}`, auth, options.signal).catch(() => undefined),
    ]);

    if (billingRes?.ok && isRecord(billingRes.json)) {
        const body = billingRes.json;
        if (typeof body.membershipTier === 'string' && body.membershipTier.trim() !== '') {
            out.plan = body.membershipTier.trim();
        }
        if (typeof body.subscriptionStatus === 'string' && body.subscriptionStatus.trim() !== '') {
            out.status = body.subscriptionStatus.trim();
        }
        const periodEnd = quotaResetInstant(body.subscriptionCurrentPeriodEnd);
        if (periodEnd !== undefined) out.periodEnd = periodEnd;
        const availUsd = asUsd(body.totalAvailableCreditsUsd);
        if (availUsd !== undefined) out.totalAvailableCreditsUsd = availUsd;
    }

    if (walletRes?.ok && isRecord(walletRes.json)) {
        const balance = asUsd(walletRes.json.balanceUsd);
        if (balance !== undefined) out.walletBalanceUsd = balance;
    }

    return out;
}

function formatWindowDurationLabel(durationSeconds: number): string {
    const hours = Math.round(durationSeconds / 3600);
    if (hours <= 6) return aiText('5-hour window', '5 小时额度');
    if (hours >= 24 * 6) return aiText('7-day window', '7 天额度');
    if (hours >= 24) {
        const days = Math.round(hours / 24);
        return aiText(`${days}-day window`, `${days} 天额度`);
    }
    return aiText(`${hours}h window`, `${hours} 小时额度`);
}

/** 聚合为共享设置页进度条契约；静态 API Key（无 controlKey）返回 `undefined`。 */
export async function fetchOpenDesignAccountQuota(
    credentials: OpenDesignCredentials,
    options: { fetchFn?: typeof fetch; amrApiBase?: string; signal?: AbortSignal } = {},
): Promise<SubscriptionAccountQuota | undefined> {
    if (!isOpenDesignOAuthCredentials(credentials)) return undefined;
    const fetchFn = options.fetchFn ?? fetch;

    const workspaceId = credentials.workspaceId
        ?? await fetchOpenDesignWorkspaceId({
            controlKey: credentials.controlKey,
            amrApiBase: options.amrApiBase,
            fetchFn,
            signal: options.signal,
        });

    const [planUsage, billing] = await Promise.all([
        workspaceId
            ? fetchOpenDesignCodingPlanUsage({
                controlKey: credentials.controlKey,
                runtimeKey: credentials.runtimeKey,
                workspaceId,
                amrApiBase: options.amrApiBase,
                fetchFn,
                signal: options.signal,
            })
            : Promise.resolve(undefined),
        fetchOpenDesignBillingAndWallet({
            controlKey: credentials.controlKey,
            amrApiBase: options.amrApiBase,
            fetchFn,
            signal: options.signal,
        }),
    ]);

    const windows: QuotaWindow[] = [];
    if (planUsage) {
        const sorted = [...planUsage.windows].sort((a, b) => a.durationSeconds - b.durationSeconds);
        for (const win of sorted) {
            const used = Math.max(0, win.limitCredits - win.remainingCredits);
            const id = win.durationSeconds <= 6 * 3600 ? 'cycle' : 'package';
            windows.push({
                id: windows.some(existing => existing.id === id) ? `${id}:${win.policyId}` : id,
                label: formatWindowDurationLabel(win.durationSeconds),
                usedFraction: used / win.limitCredits,
                used: String(used),
                limit: String(win.limitCredits),
                ...(win.resetsAt === undefined ? {} : { resetsAt: win.resetsAt }),
            });
        }
    }

    const walletOrCreditUsd = billing.walletBalanceUsd ?? billing.totalAvailableCreditsUsd;
    const plan = planUsage?.tier ?? billing.plan ?? credentials.user?.plan;
    if (walletOrCreditUsd !== undefined) {
        windows.push({
            id: 'wallet_usd',
            label: plan
                ? aiText(`Balance (${plan.toUpperCase()})`, `可用余额（${plan.toUpperCase()}）`)
                : aiText('Available balance', '可用余额'),
            used: `$${walletOrCreditUsd}`,
            ...(billing.periodEnd === undefined ? {} : { resetsAt: billing.periodEnd }),
        });
    } else if (plan) {
        windows.push({
            id: 'plan',
            label: aiText('Plan', '套餐'),
            used: plan.toUpperCase(),
        });
    }

    const meters = quotaWindowMeters(windows);
    if (meters.length === 0) return undefined;

    return {
        meters,
        fetchedAt: Date.now(),
    };
}
