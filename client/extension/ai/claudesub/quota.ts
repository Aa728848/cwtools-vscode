/**
 * Claude 订阅的额度窗口。
 *
 * 用量面是 GET /api/oauth/usage（与 Messages API 同一个 bearer 身份）。形状是每个窗口
 * { utilization, resets_at }，其中 utilization 是 **0-100 的已用百分数**。
 *
 * 这一点必须写清楚：同一家服务的**响应头**里 anthropic-ratelimit-unified-…-utilization
 * 是 0-1 的分数。同一个词、两种单位。本模块只读用量面，因此按百分数解释；把两种来源混在
 * 一起读会让卡片上的数字差一百倍。
 */

import { isRecord } from '../../../shared/protocolValidation';
import type { SubscriptionAccountQuota } from '../../../shared/subscriptionQuota';
import { quotaResetInstant, quotaWindowMeters, type QuotaWindow } from '../pool/quotaWindows';
import { CLAUDE_API_BASE, CLAUDE_USAGE_PATH } from './types';

/** 窗口键 → 展示名。服务自己的键名，未知键按原名标注而不是丢弃。 */
const WINDOW_LABELS: Record<string, string> = {
    five_hour: '5-hour',
    seven_day: 'Weekly (7 days)',
    seven_day_sonnet: 'Weekly (Sonnet)',
    seven_day_opus: 'Weekly (Opus)',
};

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

/**
 * 解析用量负载。
 *
 * 只读**已知键**加一个显式的 windows 数组；负载里的其他数字不是额度（例如 extra_usage
 * 的金额），当成窗口会凭空多出几根进度条。
 */
export function parseClaudeUsageWindows(payload: unknown): QuotaWindow[] {
    const root = isRecord(payload) ? payload : {};
    const windows: QuotaWindow[] = [];
    const seen = new Set<string>();

    for (const key of Object.keys(WINDOW_LABELS)) {
        const record = isRecord(root[key]) ? root[key] : undefined;
        if (record === undefined) continue;
        const percent = asNumber(record.utilization);
        // `null` is the documented state of a window the account does not have.
        if (percent === undefined) continue;
        seen.add(key);
        const resetsAt = quotaResetInstant(record.resets_at ?? record.resetsAt);
        windows.push({
            id: key,
            label: WINDOW_LABELS[key]!,
            // Percent used (0-100) on this surface - see the module header.
            usedPercent: Math.max(0, Math.min(100, percent)),
            ...(resetsAt === undefined ? {} : { resetsAt }),
        });
    }

    // An explicit generic list, when a deployment names its windows itself.
    if (Array.isArray(root.windows)) {
        for (const entry of root.windows) {
            if (!isRecord(entry)) continue;
            const kind = asString(entry.kind) ?? asString(entry.name);
            const percent = asNumber(entry.percent) ?? asNumber(entry.utilization);
            if (kind === undefined || percent === undefined) continue;
            const id = kind.toLowerCase();
            if (seen.has(id)) continue;
            seen.add(id);
            const resetsAt = quotaResetInstant(entry.resets_at ?? entry.resetsAt);
            windows.push({
                id,
                label: WINDOW_LABELS[id] ?? kind,
                usedPercent: Math.max(0, Math.min(100, percent)),
                ...(resetsAt === undefined ? {} : { resetsAt }),
            });
        }
    }
    return windows;
}

export interface ClaudeQuotaOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    userAgent?: string;
}

/**
 * 读取一个 Claude 订阅账号的额度。
 *
 * 用量端点用 bearer 认证，且**不能**带 x-api-key（两者并存是文档化的 401 成因）。
 */
export async function fetchClaudeSubscriptionQuota(
    credentials: { accessToken: string },
    options: ClaudeQuotaOptions = {},
): Promise<SubscriptionAccountQuota> {
    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(CLAUDE_API_BASE + CLAUDE_USAGE_PATH, {
        method: 'GET',
        headers: {
            authorization: 'Bearer ' + credentials.accessToken,
            accept: 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20',
            'user-agent': options.userAgent ?? 'claude-cli/2.0.0',
            'x-app': 'cli',
        },
        signal: options.signal,
    });
    if (!response.ok) throw new Error('Claude subscription usage lookup failed (' + response.status + ').');
    const payload: unknown = await response.json().catch(() => undefined);
    return {
        meters: quotaWindowMeters(parseClaudeUsageWindows(payload)),
        fetchedAt: Date.now(),
    };
}
