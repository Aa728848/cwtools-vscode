import { escapeHtml } from './formatters';

export interface CommandCodeQuotaLabels {
    used: string;
    remaining: string;
    resets: string;
    unknownReset: string;
    unavailable: string;
    fiveHourLimit: string;
    weeklyLimit: string;
    plan: string;
    monthlyCredits: string;
    purchasedCredits: string;
    freeCredits: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
    const num = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(num) ? num : undefined;
}

function formatCredits(val: unknown): string | undefined {
    const num = finiteNumber(val);
    if (num === undefined) return undefined;
    return Number.isInteger(num) ? String(num) : num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function resetTime(value: unknown, locale: string | undefined, unknownLabel: string): string {
    const ms = finiteNumber(value);
    if (ms === undefined || ms <= 0) return unknownLabel;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? unknownLabel : date.toLocaleString(locale);
}

interface WindowLimitInfo {
    used: number;
    cap: number;
    exceeded?: boolean;
    resetAt?: number;
}

function renderWindowProgress(
    limit: WindowLimitInfo,
    title: string,
    labels: CommandCodeQuotaLabels,
    locale?: string,
): string {
    const usedRatio = limit.cap > 0 ? (limit.used / limit.cap) * 100 : 0;
    const usedPercent = Math.min(100, Math.max(0, Math.round(usedRatio)));
    const remainingPercent = Math.max(0, 100 - usedPercent);
    const usedText = `${usedPercent}% ${labels.used}`;
    const tone = limit.exceeded || usedPercent >= 90 ? 'critical' : usedPercent >= 70 ? 'warning' : 'normal';
    const reset = resetTime(limit.resetAt, locale, labels.unknownReset);

    return (
        `<div class="codex-quota-item">`
        + `<div class="codex-quota-header"><span>${escapeHtml(title)}</span><strong>${escapeHtml(usedText)}</strong></div>`
        + `<div class="codex-quota-track" role="progressbar" aria-label="${escapeHtml(`${title}: ${usedText}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${usedPercent}">`
        + `<span class="codex-quota-fill codex-quota-fill-${tone}" style="width:${usedPercent}%"></span>`
        + `</div>`
        + `<div class="codex-quota-meta"><span>${remainingPercent}% ${escapeHtml(labels.remaining)}</span><span>${escapeHtml(labels.resets)} ${escapeHtml(reset)}</span></div>`
        + `</div>`
    );
}

/** Render sanitized Command Code account usage, window limits, and credits as accessible progress bars and meta tags. */
export function buildCommandCodeQuotaHtml(
    account: unknown,
    labels: CommandCodeQuotaLabels,
    locale?: string,
): string {
    if (!isRecord(account) || account.available === false) {
        return escapeHtml(labels.unavailable);
    }

    const items: string[] = [];

    // 1. 套餐名行 (Plan row)
    const planId = typeof account.planId === 'string' ? account.planId.trim() : '';
    const sub = isRecord(account.subscription) ? account.subscription : undefined;
    const subPlan = typeof sub?.planId === 'string' ? sub.planId.trim() : '';
    const subStatus = typeof sub?.status === 'string' ? sub.status.trim() : '';
    const effectivePlan = planId || subPlan;
    if (effectivePlan || subStatus) {
        const planDisplay = [effectivePlan, subStatus].filter(Boolean).join(' · ');
        items.push(
            `<div class="codex-quota-item">`
            + `<div class="codex-quota-meta"><span>${escapeHtml(labels.plan)}</span><strong>${escapeHtml(planDisplay)}</strong></div>`
            + `</div>`
        );
    }

    // 2. 5 小时窗口 + 每周窗口进度条 (Window limits)
    // 缺省表示未上报，绝不画成 0
    const windowLimits = isRecord(account.windowLimits) ? account.windowLimits : undefined;
    if (windowLimits) {
        if (isRecord(windowLimits.fiveHour)) {
            const used = finiteNumber(windowLimits.fiveHour.used);
            const cap = finiteNumber(windowLimits.fiveHour.cap);
            if (used !== undefined && cap !== undefined) {
                items.push(renderWindowProgress({
                    used,
                    cap,
                    exceeded: typeof windowLimits.fiveHour.exceeded === 'boolean' ? windowLimits.fiveHour.exceeded : undefined,
                    resetAt: finiteNumber(windowLimits.fiveHour.resetAt),
                }, labels.fiveHourLimit, labels, locale));
            }
        }

        if (isRecord(windowLimits.weekly)) {
            const used = finiteNumber(windowLimits.weekly.used);
            const cap = finiteNumber(windowLimits.weekly.cap);
            if (used !== undefined && cap !== undefined) {
                items.push(renderWindowProgress({
                    used,
                    cap,
                    exceeded: typeof windowLimits.weekly.exceeded === 'boolean' ? windowLimits.weekly.exceeded : undefined,
                    resetAt: finiteNumber(windowLimits.weekly.resetAt),
                }, labels.weeklyLimit, labels, locale));
            }
        }
    }

    // 3. 信用额度行 (Credits row: monthly / purchased / free)
    // 未上报的字段不显示
    const credits = isRecord(account.credits) ? account.credits : undefined;
    if (credits) {
        const creditBadges: string[] = [];
        const monthly = formatCredits(credits.monthlyCredits);
        if (monthly !== undefined) {
            creditBadges.push(`${labels.monthlyCredits}: ${monthly}`);
        }
        const purchased = formatCredits(credits.purchasedCredits);
        if (purchased !== undefined) {
            creditBadges.push(`${labels.purchasedCredits}: ${purchased}`);
        }
        const free = formatCredits(credits.freeCredits);
        if (free !== undefined) {
            creditBadges.push(`${labels.freeCredits}: ${free}`);
        }
        if (creditBadges.length > 0) {
            items.push(
                `<div class="codex-quota-item">`
                + `<div class="codex-quota-meta">${creditBadges.map(b => `<span>${escapeHtml(b)}</span>`).join(' · ')}</div>`
                + `</div>`
            );
        }
    }

    if (items.length === 0) {
        return escapeHtml(labels.unavailable);
    }

    return `<div class="codex-quota-list">${items.join('')}</div>`;
}
