import type { AntigravityAccountStatus } from '../../shared/antigravityAccount';
import { isAntigravityAccountStatus } from '../../shared/antigravityAccount';
import { escapeHtml } from './formatters';
import { buildCodexQuotaHtml } from './codexQuota';

export { isAntigravityAccountStatus, type AntigravityAccountStatus };

export function buildAntigravityAccountHtml(account: AntigravityAccountStatus | undefined, chinese: boolean): string {
    const text = (en: string, zh: string) => chinese ? zh : en;
    const identity = [account?.email, account?.projectId].filter(Boolean).join(' · ');
    const status = account?.signedIn
        ? `${text('Signed in', '已登录')}${identity ? ` · ${identity}` : ''}`
        : text('Not signed in to Antigravity', '尚未登录 Antigravity');
    const quota = account?.signedIn || account?.quota.length ? buildCodexQuotaHtml(account.quota.map(bucket => ({
        limitName: bucket.name,
        primary: {
            usedPercent: 100 - bucket.remainingPercent,
            ...(bucket.resetsAt ? { resetsAt: Date.parse(bucket.resetsAt) / 1000 } : {}),
        },
    })), {
        used: text('used', '已用'),
        remaining: text('remaining', '剩余'),
        resets: text('Resets', '重置'),
        window: text('Window', '窗口'),
        weekly: text('Weekly limit', '周额度'),
        unknownReset: text('unknown reset time', '重置时间未知'),
        unavailable: text('Quota details are unavailable.', '暂未返回额度详情。'),
    }, chinese ? 'zh-CN' : 'en') : '';
    return `<div class="settings-hint">${escapeHtml(status)}</div>${account?.error ? `<div style="color:var(--vscode-errorForeground)">${escapeHtml(account.error)}</div>` : ''}<div class="codex-quota-status">${quota}</div>`;
}
