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

export function renderActivityRow(event: CodexActivityEvent, options: CodexRenderOptions, nested = false): string {
    const duration = event.durationMs && event.durationMs > 0 ? formatDuration(event.durationMs) : '';
    const subject = event.subject ? `<span class="codex-activity-subject">${escapeHtml(event.subject)}</span>` : '';
    const detail = event.detail ? `<span class="codex-activity-detail">${escapeHtml(event.detail)}</span>` : '';
    const invocationAttr = event.invocationId ? ` data-invocation-id="${escapeHtml(event.invocationId)}"` : '';
    const toolAttr = event.toolName ? ` data-tool-name="${escapeHtml(event.toolName)}"` : '';
    const nestedClass = nested ? ' codex-activity-child-row' : '';
    void options;
    return `<div class="codex-activity-row${nestedClass} codex-activity-${event.kind} codex-status-${event.status}" data-activity-id="${escapeHtml(event.id)}" data-activity-kind="${escapeHtml(event.kind)}"${invocationAttr}${toolAttr}>
        <div class="codex-activity-summary">
            <span class="codex-activity-icon">${svgIconNoMargin(iconNameFor(event))}</span>
            <span class="codex-activity-main">
                <span class="codex-activity-title">${escapeHtml(event.label)}${subject}</span>
                ${detail}
            </span>
            ${duration ? `<span class="codex-activity-duration">${escapeHtml(duration)}</span>` : ''}
            <span class="codex-activity-status">${statusIcon(event.status)}</span>
        </div>
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
    return `<div class="codex-process-text markdown-body" data-text-source="${item.text.source}">${body}</div>`;
}

export function renderCodexTurnItems(items: CodexTurnItem[], options: CodexRenderOptions): string {
    return items.map(item => renderCodexTurnItem(item, options)).join('');
}
