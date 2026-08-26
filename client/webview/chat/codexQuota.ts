import { escapeHtml } from './formatters';

export interface CodexQuotaLabels {
    used: string;
    remaining: string;
    resets: string;
    window: string;
    unknownReset: string;
    unavailable: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : undefined;
}

function finiteNumber(value: unknown): number | undefined {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(number) ? number : undefined;
}

function safeLabel(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim()
        ? value.trim().slice(0, 80)
        : fallback;
}

function compactDuration(minutes: unknown): string {
    const value = finiteNumber(minutes);
    if (value === undefined || value <= 0) return '';
    const compact = (amount: number) => Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
    if (value >= 1440) return `${compact(value / 1440)}d`;
    if (value >= 60) return `${compact(value / 60)}h`;
    return `${Math.round(value)}m`;
}

function resetTime(value: unknown, locale: string | undefined, unknownLabel: string): string {
    const seconds = finiteNumber(value);
    if (seconds === undefined || seconds <= 0) return unknownLabel;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? unknownLabel : date.toLocaleString(locale);
}

/** Render sanitized Codex subscription usage windows as accessible progress bars. */
export function buildCodexQuotaHtml(
    rateLimits: unknown,
    labels: CodexQuotaLabels,
    locale?: string,
): string {
    if (!Array.isArray(rateLimits)) return escapeHtml(labels.unavailable);

    const cards: string[] = [];
    for (const rawBucket of rateLimits.slice(0, 8)) {
        const bucket = asRecord(rawBucket);
        if (!bucket) continue;
        const label = safeLabel(bucket.limitName, safeLabel(bucket.limitId, 'Codex'));
        const windows = [bucket.primary, bucket.secondary]
            .map(asRecord)
            .filter((window): window is UnknownRecord => window !== undefined)
            .filter(window => finiteNumber(window.usedPercent) !== undefined);

        windows.forEach((window, index) => {
            const rawUsed = finiteNumber(window.usedPercent) ?? 0;
            const used = Math.max(0, Math.min(100, rawUsed));
            const usedPercent = Math.round(used);
            const remainingPercent = Math.max(0, 100 - usedPercent);
            const duration = compactDuration(window.windowDurationMins);
            const windowName = duration || (windows.length > 1 ? `${labels.window} ${index + 1}` : '');
            const title = windowName ? `${label} · ${windowName}` : label;
            const usedText = `${usedPercent}% ${labels.used}`;
            const tone = used >= 90 ? 'critical' : used >= 70 ? 'warning' : 'normal';
            const reset = resetTime(window.resetsAt, locale, labels.unknownReset);

            cards.push(
                `<div class="codex-quota-item">`
                + `<div class="codex-quota-header"><span>${escapeHtml(title)}</span><strong>${escapeHtml(usedText)}</strong></div>`
                + `<div class="codex-quota-track" role="progressbar" aria-label="${escapeHtml(`${title}: ${usedText}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${usedPercent}">`
                + `<span class="codex-quota-fill codex-quota-fill-${tone}" style="width:${usedPercent}%"></span>`
                + `</div>`
                + `<div class="codex-quota-meta"><span>${remainingPercent}% ${escapeHtml(labels.remaining)}</span><span>${escapeHtml(labels.resets)} ${escapeHtml(reset)}</span></div>`
                + `</div>`,
            );
        });
    }

    return cards.length > 0
        ? `<div class="codex-quota-list">${cards.join('')}</div>`
        : escapeHtml(labels.unavailable);
}
