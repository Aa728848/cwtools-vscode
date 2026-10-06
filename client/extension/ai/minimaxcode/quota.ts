/**
 * MiniMax Code 的 Token Plan 额度。
 *
 * 用量面是 GET /v1/api/openplatform/coding_plan/remains（官方 CLI 读的正是这一个），服务在
 * **API 主机**上，而不是本线路发 Messages 的 agent 主机。
 *
 * **不伪造第一方身份**：官方客户端会附带 yy / x-timestamp / x-signature 三个头，其注释直说是
 * 「把请求标记为来自 MiniMax 第一方客户端」。另有一份说明记录了冒用官方应用是**封号理由**。
 * 因此这里只带 bearer 诚实地读：服务若坚持要那个标记，得到的是被拒而不是一个伪造的身份，
 * 卡片如实显示「读不到」而不是编造数字。
 */

import { isRecord } from '../../../shared/protocolValidation';
import type { SubscriptionAccountQuota } from '../../../shared/subscriptionQuota';
import { quotaWindowMeters, type QuotaWindow } from '../pool/quotaWindows';
import type { MinimaxCodeRegion } from './types';

/** 用量面路径；官方 CLI 用的那个。 */
export const MINIMAX_CODE_REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains';

/**
 * 用量主机候选，按区域。
 *
 * **实测**而非推断：该路径在 API 主机上；agent 主机对它答 404（有的还回一个 HTML 聊天壳），
 * 因此不能拿 agent 主机去碰。
 */
const REMAINS_HOSTS: Record<MinimaxCodeRegion, readonly string[]> = {
    cn: ['https://api.minimax.cn', 'https://api.minimaxi.com'],
    global: ['https://api.minimax.io'],
};

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function numberOr(value: unknown, fallback: number): number {
    return asNumber(value) ?? fallback;
}

/** 周窗口携带的展示倍数（千分数）。 */
function boostFactor(permille: unknown): number {
    const value = asNumber(permille);
    return value !== undefined && value > 0 ? value / 1000 : 1;
}

/**
 * 解析用量负载。
 *
 * `model_remains[]` 每行一个模型，各有 interval 与 weekly 两个窗口。`general` 是覆盖聊天与
 * 编程的那个桶；只画它，其余（视频等）是另外的资源，混在一起会让头条数字失去意义。
 */
export function parseMinimaxCodeQuota(payload: unknown): QuotaWindow[] {
    const rows = isRecord(payload) && Array.isArray(payload.model_remains) ? payload.model_remains : [];
    const windows: QuotaWindow[] = [];
    for (const raw of rows) {
        if (!isRecord(raw)) continue;
        const name = typeof raw.model_name === 'string' && raw.model_name !== '' ? raw.model_name : 'quota';
        if (name !== 'general') continue;
        const intervalTotal = numberOr(raw.current_interval_total_count, 0);
        const weeklyTotal = numberOr(raw.current_weekly_total_count, 0);
        const intervalStatus = numberOr(raw.current_interval_status, 0);
        const weeklyStatus = numberOr(raw.current_weekly_status, 0);
        // Status 3 means "unlimited" - EXCEPT when both totals are zero, where the
        // service reuses it for a model with no quota bucket. Drawing that as
        // unlimited would promise quota the user does not have.
        if (intervalTotal === 0 && weeklyTotal === 0 && intervalStatus === 3 && weeklyStatus === 3) continue;

        const push = (
            id: string,
            label: string,
            total: number,
            usedCount: number,
            remainingPercent: number | undefined,
            boost: number,
            unlimited: boolean,
            resetsAt: number | undefined,
        ): void => {
            if (unlimited) return;
            // The service caps a boosted weekly window above 100%, so the ceiling is
            // 200 rather than 100; clamping at 100 would understate a boosted plan.
            const percent = remainingPercent !== undefined
                ? Math.min(200, remainingPercent * boost)
                : (total > 0 ? Math.min(200, (usedCount / total) * 100 * boost) : undefined);
            const window: QuotaWindow = {
                id,
                label: name + ' · ' + label,
                ...(percent === undefined
                    ? (total > 0 ? { used: String(usedCount), limit: String(total) } : {})
                    : { usedPercent: Math.max(0, 100 - percent) }),
                ...(total > 0 ? { used: String(usedCount), limit: String(total) } : {}),
                ...(resetsAt === undefined ? {} : { resetsAt }),
            };
            windows.push(window);
        };

        push('interval', '5-hour', intervalTotal, numberOr(raw.current_interval_usage_count, 0),
            asNumber(raw.current_interval_remaining_percent), 1, intervalStatus === 3, asNumber(raw.end_time));
        push('weekly', 'Weekly', weeklyTotal, numberOr(raw.current_weekly_usage_count, 0),
            asNumber(raw.current_weekly_remaining_percent), boostFactor(raw.weekly_boost_permille),
            weeklyStatus === 3, asNumber(raw.weekly_end_time));
    }
    return windows;
}

export interface MinimaxCodeQuotaOptions {
    region: MinimaxCodeRegion;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** 测试用；生产按区域的候选主机依次尝试。 */
    hosts?: readonly string[];
}

/**
 * 读取一个 MiniMax Code 账号的额度。
 *
 * 主机逐个尝试；任何一个返回可用文档就采用。全部失败时抛错，由调用方转成「读不到」。
 */
export async function fetchMinimaxCodeQuota(
    credentials: { accessToken: string },
    options: MinimaxCodeQuotaOptions,
): Promise<SubscriptionAccountQuota> {
    const fetchFn = options.fetchFn ?? fetch;
    const hosts = options.hosts ?? REMAINS_HOSTS[options.region];
    let lastError: unknown;
    for (const host of hosts) {
        try {
            const response = await fetchFn(host.replace(/\/+$/, '') + MINIMAX_CODE_REMAINS_PATH, {
                method: 'GET',
                headers: {
                    // Bearer only: the first-party attribution headers are deliberately
                    // NOT sent (see the module header).
                    authorization: 'Bearer ' + credentials.accessToken,
                    accept: 'application/json',
                },
                signal: options.signal,
            });
            if (!response.ok) { lastError = new Error('MiniMax usage lookup failed (' + response.status + ').'); continue; }
            const payload: unknown = await response.json().catch(() => undefined);
            const base = isRecord(payload) && isRecord(payload.base_resp) ? payload.base_resp : undefined;
            const code = base === undefined ? undefined : asNumber(base.status_code);
            if (code !== undefined && code !== 0) {
                lastError = new Error('MiniMax usage lookup was rejected: ' + (typeof base?.status_msg === 'string' ? base.status_msg : 'no detail'));
                continue;
            }
            const meters = quotaWindowMeters(parseMinimaxCodeQuota(payload));
            if (meters.length === 0) { lastError = new Error('MiniMax usage response named no windows.'); continue; }
            return { meters, fetchedAt: Date.now() };
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('MiniMax usage lookup failed.');
}
