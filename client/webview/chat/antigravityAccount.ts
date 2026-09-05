import type { AntigravityAccountStatus } from '../../shared/antigravityAccount';
import { isAntigravityAccountStatus } from '../../shared/antigravityAccount';
import { escapeHtml } from './formatters';

export { isAntigravityAccountStatus, type AntigravityAccountStatus };

export function buildAntigravityAccountHtml(account: AntigravityAccountStatus | undefined, chinese: boolean): string {
    const text = (en: string, zh: string) => chinese ? zh : en;
    const identity = [account?.email, account?.projectId].filter(Boolean).join(' · ');
    const status = account?.signedIn
        ? `${text('Signed in', '已登录')}${identity ? ` · ${identity}` : ''}`
        : text('Not signed in to Antigravity', '尚未登录 Antigravity');
    const quota = account?.quota.map(bucket => {
        const reset = bucket.resetsAt ? ` · ${text('Resets', '重置')} ${new Date(bucket.resetsAt).toLocaleString(chinese ? 'zh-CN' : 'en')}` : '';
        return `<div>${escapeHtml(`${bucket.name}: ${bucket.remainingPercent}% ${text('remaining', '剩余')}${reset}`)}</div>`;
    }).join('') || (account?.signedIn ? escapeHtml(text('Quota details are unavailable.', '暂未返回额度详情。')) : '');
    return `<div>${escapeHtml(status)}</div>${account?.error ? `<div style="color:var(--vscode-errorForeground)">${escapeHtml(account.error)}</div>` : ''}<div class="codex-quota-status">${quota}</div>`;
}
