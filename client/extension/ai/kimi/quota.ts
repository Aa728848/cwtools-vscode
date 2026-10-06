/**
 * Kimi Code 的额度窗口。
 *
 * 用量面是 `GET {coding}/v1/usages`。服务的形状在一个窗口一个条目（`usages.{limit_5h,…}`），
 * 社区文档过的另一形状是顶层 `usage` 加 `limits[]`；两者都读，形状变了也不会把卡片读空。
 * 无法识别的负载返回**空数组**而不是编一个 0%。
 */

import { isRecord } from '../../../shared/protocolValidation';
import type { SubscriptionAccountQuota } from '../../../shared/subscriptionQuota';
import { quotaWindowMeters, quotaResetInstant, type QuotaWindow } from '../pool/quotaWindows';
import type { KimiCredentials } from './tokenStore';

/** 窗口键 → 展示名与名义长度。服务自己的键名；两个月度池是不同的东西，必须分开标注。 */
const WINDOW_DESCRIPTORS: Record<string, { label: string }> = {
    limit_5h: { label: '5-hour' },
    limit5h: { label: '5-hour' },
    limit_7d: { label: 'Weekly (7-day)' },
    limit7d: { label: 'Weekly (7-day)' },
    limit_month_total: { label: 'Monthly (membership)' },
    monthTotal: { label: 'Monthly (membership)' },
    limit_month_code: { label: 'Monthly (Kimi Code)' },
    monthCode: { label: 'Monthly (Kimi Code)' },
};

const WINDOW_ORDER = [
    'limit_5h', 'limit5h', 'limit_7d', 'limit7d', 'limit_month_total', 'monthTotal', 'limit_month_code', 'monthCode',
];

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function humanizeWindowKey(key: string): string {
    const spaced = key.replace(/^limit[_-]?/i, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    return spaced === '' ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function parseWindow(id: string, record: Record<string, unknown>): QuotaWindow | undefined {
    const limit = asNumber(record.limit);
    const used = asNumber(record.used);
    const reported = asNumber(record.used_ratio) ?? asNumber(record.usedRatio);
    // The service normally reports a ready ratio; the alternative shape reports a
    // used/limit pair, so derive the ratio rather than dropping the window.
    const ratio = reported ?? (limit !== undefined && limit > 0 && used !== undefined ? used / limit : undefined);
    if (ratio === undefined || !Number.isFinite(ratio)) return undefined;
    const descriptor = WINDOW_DESCRIPTORS[id];
    const resetsAt = quotaResetInstant(record.reset_time ?? record.resetTime ?? record.resetsAt);
    return {
        id,
        label: descriptor?.label ?? humanizeWindowKey(id),
        usedFraction: ratio,
        ...(limit === undefined ? {} : { limit: String(limit) }),
        ...(used === undefined ? {} : { used: String(used) }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
    };
}

/** 解析 `/v1/usages` 负载；无法识别时返回空数组。 */
export function parseKimiUsageWindows(payload: unknown): QuotaWindow[] {
    const root = isRecord(payload) ? payload : {};
    const windows: QuotaWindow[] = [];
    const seen = new Set<string>();
    const push = (id: string, record: Record<string, unknown>): void => {
        if (seen.has(id)) return;
        const parsed = parseWindow(id, record);
        if (parsed === undefined) return;
        seen.add(id);
        windows.push(parsed);
    };

    const usages = isRecord(root.usages) ? root.usages : isRecord(root.usageWindows) ? root.usageWindows : undefined;
    if (usages !== undefined) {
        const keys = [
            ...WINDOW_ORDER.filter(key => usages[key] !== undefined),
            ...Object.keys(usages).filter(key => !WINDOW_ORDER.includes(key)),
        ];
        for (const key of keys) {
            const record = isRecord(usages[key]) ? usages[key] : undefined;
            if (record !== undefined) push(key, record);
        }
    }

    const topLevel = isRecord(root.usage) ? root.usage : undefined;
    if (topLevel !== undefined && seen.size === 0) push('limit_7d', topLevel);

    if (Array.isArray(root.limits)) {
        for (const entry of root.limits) {
            if (!isRecord(entry)) continue;
            const detail = isRecord(entry.detail) ? entry.detail : entry;
            push(typeof detail.id === 'string' ? detail.id : 'limit-' + (windows.length + 1), detail);
        }
    }
    return windows;
}

export interface KimiQuotaOptions {
    /** 区域对应的 coding 基址（`https://api.kimi.com/coding`）。 */
    codingBase: string;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
}

/**
 * 读取一个 Kimi Code 账号的额度。
 *
 * 用量面在 **coding** 主机（`api.kimi.com/coding`），不是 OAuth 主机；令牌过期时先续期一次，
 * 否则一个刚过期的账号会读成「没有额度」。
 */
export async function fetchKimiQuota(
    token: KimiCredentials,
    options: KimiQuotaOptions,
): Promise<SubscriptionAccountQuota> {
    const fetchFn = options.fetchFn ?? fetch;
    const base = options.codingBase.replace(/\/+$/, '');
    const response = await fetchFn(base + '/v1/usages', {
        headers: {
            authorization: 'Bearer ' + token.accessToken,
            accept: 'application/json',
            'user-agent': 'cwtools-vscode (+https://github.com/Aa728848/cwtools-vscode)',
        },
        signal: options.signal,
    });
    if (!response.ok) throw new Error('Kimi Code usage lookup failed (' + response.status + ').');
    const payload: unknown = await response.json().catch(() => undefined);
    return {
        meters: quotaWindowMeters(parseKimiUsageWindows(payload)),
        fetchedAt: Date.now(),
    };
}

