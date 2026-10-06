/**
 * Command Code 的额度：把账号状态里的额度事实转成号池卡片画的仪表。
 *
 * 这条线路用的是静态 API Key，额度是**按 Key**记账的：同一账号可以有多把 Key，每把有自己
 * 的窗口与余额。因此额度随凭据走（每行一把 Key），而不是按账号聚合。
 *
 * 账号状态服务（accountService.ts）已经解析过同一份负载，这里只做形状转换，避免同一份数据
 * 在两处各解析一次而漂移。
 */

import type { SubscriptionAccountQuota } from '../../../shared/subscriptionQuota';
import { quotaWindowMeters, type QuotaWindow } from '../pool/quotaWindows';
import type { CommandCodeAccountStatus, CommandCodeWindowLimit } from './accountService';

function window(id: string, label: string, limit: CommandCodeWindowLimit | undefined): QuotaWindow | undefined {
    if (limit === undefined) return undefined;
    if (typeof limit.used !== 'number' || typeof limit.cap !== 'number' || limit.cap <= 0) return undefined;
    return {
        id,
        label,
        usedFraction: limit.used / limit.cap,
        used: String(limit.used),
        limit: String(limit.cap),
        ...(typeof limit.resetAt === 'number' && limit.resetAt > 0 ? { resetsAt: limit.resetAt } : {}),
    };
}

/**
 * 把一次账号状态读成额度快照。
 *
 * 只画服务真报了的窗口：一个 Key 没有周额度时报 0% 会凭空多出一根满格进度条。
 */
export function commandCodeQuotaFromStatus(status: CommandCodeAccountStatus): SubscriptionAccountQuota {
    const windows: QuotaWindow[] = [];
    const fiveHour = window('five-hour', '5-hour limit', status.windowLimits?.fiveHour);
    if (fiveHour !== undefined) windows.push(fiveHour);
    const weekly = window('weekly', 'Weekly limit', status.windowLimits?.weekly);
    if (weekly !== undefined) windows.push(weekly);

    const credits = status.credits;
    if (credits !== undefined) {
        // A bare balance with no stated cap is still worth one meter, so it is drawn
        // as a value rather than as a fraction of an amount we were not told.
        // The three pools are additive, so the spendable balance is their sum.
        const balance = credits.totalCredits ?? credits.monthlyCredits ?? credits.purchasedCredits ?? credits.freeCredits;
        if (typeof balance === 'number' && Number.isFinite(balance)) {
            windows.push({ id: 'credits', label: 'Remaining credits', used: String(balance) });
        }
    }

    return { meters: quotaWindowMeters(windows), fetchedAt: Date.now() };
}
