import { escapeHtml } from './formatters';
import type { SubscriptionAccountQuota, SubscriptionQuotaMeter } from '../../shared/subscriptionQuota';

export interface SubscriptionQuotaLabels {
    creditsUsed: string;
    creditsRemaining: string;
    resets: string;
    cycle: string;
    package: string;
    unavailable: string;
    unknownReset: string;
}

function resetText(resetsAt: number | undefined, locale: string | undefined, unknownLabel: string): string {
    if (resetsAt === undefined || resetsAt <= 0) return unknownLabel;
    const date = new Date(resetsAt);
    return Number.isNaN(date.getTime()) ? unknownLabel : date.toLocaleString(locale);
}

/** One meter's localized name: an upstream package name wins, else a known key. */
function meterLabel(meter: SubscriptionQuotaMeter, labels: SubscriptionQuotaLabels): string {
    if (meter.label !== undefined) return meter.label;
    if (meter.labelKey === 'cycle') return labels.cycle;
    if (meter.labelKey === 'package') return labels.package;
    return '';
}

function renderMeter(meter: SubscriptionQuotaMeter, labels: SubscriptionQuotaLabels, locale?: string): string {
    const label = meterLabel(meter, labels);
    if (label === '') return '';
    // Prefer the reported used fraction; fall back to its complement so a meter
    // that only states remaining is still drawn at the right width.
    const used = meter.usedPercent ?? (meter.remainingPercent === undefined ? undefined : 1 - meter.remainingPercent);
    // A meter that reports an amount but no denominator (a bare credit balance) is
    // stated as a value: inventing a fraction would draw a bar out of no evidence.
    if (used === undefined) {
        const amount = meter.limit === undefined ? meter.used : meter.used + ' / ' + meter.limit;
        if (amount === undefined) return '';
        return '<div class="codex-quota-item pool-quota-value"><div class="codex-quota-header">'
            + '<span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(amount) + '</strong></div></div>';
    }
    const usedPercent = Math.round(Math.max(0, Math.min(1, used)) * 100);
    const remainingPercent = Math.max(0, 100 - usedPercent);
    const tone = usedPercent >= 90 ? 'critical' : usedPercent >= 70 ? 'warning' : 'normal';
    const amounts = meter.used !== undefined
        ? (meter.limit === undefined ? meter.used : meter.used + ' / ' + meter.limit)
        : meter.limit;
    const usedText = amounts === undefined
        ? usedPercent + '% ' + labels.creditsUsed
        : amounts + ' · ' + usedPercent + '% ' + labels.creditsUsed;
    const reset = resetText(meter.resetsAt, locale, labels.unknownReset);
    return (
        '<div class="codex-quota-item">'
        + '<div class="codex-quota-header"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(usedText) + '</strong></div>'
        + '<div class="codex-quota-track" role="progressbar" aria-label="' + escapeHtml(label + ': ' + usedText) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + usedPercent + '">'
        + '<span class="codex-quota-fill codex-quota-fill-' + tone + '" style="width:' + usedPercent + '%"></span>'
        + '</div>'
        + '<div class="codex-quota-meta"><span>' + remainingPercent + '% ' + escapeHtml(labels.creditsRemaining) + '</span>'
        + '<span>' + escapeHtml(labels.resets) + ' ' + escapeHtml(reset) + '</span></div>'
        + '</div>'
    );
}

/**
 * Render one pooled account's quota under its row.
 *
 * A line with no quota surface (or a read that has not answered yet) renders nothing at all:
 * an "unavailable" line under every account would be noise, and the row itself already says
 * whether the account is usable.
 */
export function buildSubscriptionQuotaHtml(
    quota: SubscriptionAccountQuota | undefined,
    labels: SubscriptionQuotaLabels,
    locale?: string,
): string {
    if (quota === undefined) return '';
    const meters = quota.meters
        .map((meter: SubscriptionQuotaMeter) => renderMeter(meter, labels, locale))
        .filter((html: string) => html !== '');
    if (meters.length === 0) {
        return quota.failed === true
            ? '<div class="pool-quota-error">' + escapeHtml(labels.unavailable) + '</div>'
            : '';
    }
    return '<div class="pool-quota">' + meters.join('') + '</div>';
}
