import type { AntigravityAccountStatus } from '../../extension/ai/types';
import { isRecord } from '../../shared/protocolValidation';
import { escapeHtml } from './formatters';

export function isAntigravityAccountStatus(value: unknown): value is AntigravityAccountStatus {
    return isRecord(value) && typeof value.signedIn === 'boolean' && typeof value.hasCredentials === 'boolean'
        && [value.email, value.projectId, value.error].every(field => field === undefined || typeof field === 'string')
        && Array.isArray(value.models) && value.models.every(model => typeof model === 'string')
        && Array.isArray(value.quota) && value.quota.every(bucket => isRecord(bucket)
            && typeof bucket.name === 'string' && typeof bucket.remainingPercent === 'number'
            && Number.isFinite(bucket.remainingPercent) && bucket.remainingPercent >= 0 && bucket.remainingPercent <= 100
            && (bucket.resetsAt === undefined || typeof bucket.resetsAt === 'string' && Number.isFinite(Date.parse(bucket.resetsAt))));
}

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
