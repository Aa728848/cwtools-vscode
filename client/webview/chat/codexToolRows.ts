import { Icons, svgIconNoMargin } from '../svgIcons';
import { escapeHtml, formatDuration } from './formatters';
import type {
    CodexActivityEvent,
    CodexActivityGroup,
    CodexI18nText,
    CodexTurnItem,
} from './codexTypes';

export interface CodexRenderOptions {
    labels: CodexI18nText;
    renderMarkdown?: (content: string) => string;
}

function iconNameFor(event: CodexActivityEvent | CodexActivityGroup): keyof typeof Icons {
    const kind = 'events' in event ? event.kind : event.kind;
    if (kind === 'command') return 'code';
    if (kind === 'read' || kind === 'file') return 'file';
    if (kind === 'validation') return 'stethoscope';
    if (kind === 'permission') return 'shield';
    if (kind === 'context') return 'package';
    if (kind === 'subagent') return 'bot';
    if (kind === 'artifact') return 'layers';
    if (kind === 'thinking') return 'messageSquare';
    if (kind === 'message') return 'messageSquare';
    return 'gear';
}

function statusIcon(status: string): string {
    if (status === 'success') return svgIconNoMargin('check');
    if (status === 'failed') return svgIconNoMargin('x');
    if (status === 'waiting') return svgIconNoMargin('shield');
    if (status === 'skipped') return svgIconNoMargin('eyeOff');
    return svgIconNoMargin('refresh');
}

function hasDetailValue(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
    return true;
}

function detailText(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value ?? '');
    }
}

function clippedDetailText(value: unknown, max = 12000): string {
    const text = detailText(value);
    return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

function withoutLargeOutput(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const outputKeys = new Set(['stdout', 'stderr', 'output']);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (!outputKeys.has(key)) result[key] = entry;
    }
    return result;
}

function renderInlineDetail(label: string, value: unknown): string {
    if (!hasDetailValue(value)) return '';
    return `<div class="codex-detail-row">
        <span class="codex-detail-label">${escapeHtml(label)}</span>
        <code class="codex-detail-inline">${escapeHtml(detailText(value))}</code>
    </div>`;
}

function renderBlockDetail(label: string, value: unknown, className = ''): string {
    if (!hasDetailValue(value)) return '';
    const extraClass = className ? ` ${escapeHtml(className)}` : '';
    return `<div class="codex-detail-row codex-detail-row-block">
        <span class="codex-detail-label">${escapeHtml(label)}</span>
        <pre class="codex-detail-block${extraClass}"><code>${escapeHtml(clippedDetailText(value))}</code></pre>
    </div>`;
}

function renderActivityDetails(event: CodexActivityEvent, options: CodexRenderOptions): string {
    const details = event.detailModel;
    if (!details) return '';
    const labels = options.labels.details;
    const command = details.command;
    const rows = [
        renderBlockDetail(labels.command, command?.command, 'codex-command-text'),
        renderInlineDetail(labels.cwd, command?.cwd),
        renderInlineDetail(labels.exitCode, command?.exitCode),
        renderInlineDetail(labels.target, details.targetPath),
        renderInlineDetail(labels.status, details.statusText && details.statusText !== event.detail ? details.statusText : ''),
        renderBlockDetail(labels.stdout, command?.stdout, 'codex-command-output'),
        renderBlockDetail(labels.stderr, command?.stderr, 'codex-command-error'),
        renderBlockDetail(labels.output, command?.output, 'codex-command-output'),
        renderBlockDetail(labels.preview, !command && details.preview && details.preview !== event.detail ? details.preview : ''),
        renderBlockDetail(labels.arguments, command ? '' : details.args),
        renderBlockDetail(labels.result, withoutLargeOutput(details.result)),
    ].filter(Boolean);
    if (!rows.length) return '';
    return `<div class="codex-activity-row-details">${rows.join('')}</div>`;
}

export function renderActivityRow(event: CodexActivityEvent, options: CodexRenderOptions, nested = false): string {
    const duration = event.durationMs && event.durationMs > 0 ? formatDuration(event.durationMs) : '';
    const subject = event.subject ? `<span class="codex-activity-subject">${escapeHtml(event.subject)}</span>` : '';
    const detail = event.detail ? `<span class="codex-activity-detail">${escapeHtml(event.detail)}</span>` : '';
    const invocationAttr = event.invocationId ? ` data-invocation-id="${escapeHtml(event.invocationId)}"` : '';
    const toolAttr = event.toolName ? ` data-tool-name="${escapeHtml(event.toolName)}"` : '';
    const nestedClass = nested ? ' codex-activity-child-row' : '';
    const details = renderActivityDetails(event, options);
    const detailsClass = details ? ' codex-activity-row-collapsed' : '';
    const summaryTag = details ? 'button' : 'div';
    const summaryAttrs = details
        ? ' type="button" data-codex-activity-row-toggle aria-expanded="false"'
        : '';
    const disclosure = details ? '<span class="codex-activity-disclosure" aria-hidden="true">›</span>' : '';
    return `<div class="codex-activity-row${nestedClass}${detailsClass} codex-activity-${event.kind} codex-status-${event.status}" data-activity-id="${escapeHtml(event.id)}" data-activity-kind="${escapeHtml(event.kind)}"${invocationAttr}${toolAttr}>
        <${summaryTag}${summaryAttrs} class="codex-activity-summary${details ? ' codex-activity-row-toggle' : ''}">
            <span class="codex-activity-icon">${svgIconNoMargin(iconNameFor(event))}</span>
            <span class="codex-activity-main">
                <span class="codex-activity-title">${escapeHtml(event.label)}${subject}</span>
                ${detail}
            </span>
            ${duration ? `<span class="codex-activity-duration">${escapeHtml(duration)}</span>` : ''}
            <span class="codex-activity-status">${statusIcon(event.status)}</span>
            ${disclosure}
        </${summaryTag}>
        ${details}
    </div>`;
}

export function renderActivityGroup(group: CodexActivityGroup, options: CodexRenderOptions): string {
    const duration = group.durationMs && group.durationMs > 0 ? formatDuration(group.durationMs) : '';
    const children = group.events.length > 0
        ? `<div class="codex-activity-group-items">${group.events.map(event => renderActivityRow(event, options, true)).join('')}</div>`
        : '';
    return `<div class="codex-activity-group codex-activity-group-collapsed codex-group-${group.kind} codex-status-${group.status}" data-activity-group-id="${escapeHtml(group.id)}">
        <button type="button" class="codex-activity-summary codex-activity-group-toggle" data-codex-activity-group-toggle aria-expanded="false">
            <span class="codex-activity-icon">${svgIconNoMargin(iconNameFor(group))}</span>
            <span class="codex-activity-main">
                <span class="codex-activity-title">${escapeHtml(group.label)}</span>
            </span>
            ${duration ? `<span class="codex-activity-duration">${escapeHtml(duration)}</span>` : ''}
            <span class="codex-activity-status">${statusIcon(group.status)}</span>
            <span class="codex-activity-disclosure" aria-hidden="true">›</span>
        </button>
        ${children}
    </div>`;
}

export function renderCodexTurnItem(item: CodexTurnItem, options: CodexRenderOptions): string {
    if (item.type === 'group') return renderActivityGroup(item.group, options);
    if (item.type === 'activity') return renderActivityRow(item.event, options);
    const body = options.renderMarkdown ? options.renderMarkdown(item.text.content) : escapeHtml(item.text.content);
    const autoClass = item.text.source === 'auto' ? ' codex-auto-progress' : '';
    return `<div class="codex-process-text${autoClass} markdown-body" data-text-source="${item.text.source}">${body}</div>`;
}

export function renderCodexTurnItems(items: CodexTurnItem[], options: CodexRenderOptions): string {
    return items.map(item => renderCodexTurnItem(item, options)).join('');
}
