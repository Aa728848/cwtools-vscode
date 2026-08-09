import { escapeHtml } from './formatters';
import { buildCodexTurnModel } from './codexActivity';
import { renderCodexTurnItems } from './codexToolRows';
import type { ChatI18nText } from './i18n';
import type { CodexTurnItem, CodexTurnModel, CodexTurnSummary } from './codexTypes';

export interface RenderCodexAssistantTurnOptions {
    i18n: ChatI18nText;
    live?: boolean;
    msgTime?: number | string | null;
    renderMarkdown: (content: string) => string;
    isSubagentView?: boolean;
}

export function buildCodexAssistantTurnModel(content: string, steps: Record<string, unknown>[] | undefined, options: RenderCodexAssistantTurnOptions): CodexTurnModel {
    return buildCodexTurnModel(content, steps, {
        locale: options.i18n.locale,
        labels: options.i18n.codex,
        live: options.live,
        fallbackStatus: content,
    });
}

export function renderTurnStatus(summary: CodexTurnSummary, options: RenderCodexAssistantTurnOptions): string {
    // Completed turns render collapsed by default: the process (activity stream)
    // is hidden and only the status bar and final answer are visible until the
    // user expands the turn. Live turns stay expanded while streaming.
    const collapsed = !options.live;
    return `<button type="button" class="codex-turn-status codex-turn-status-${summary.status}" data-codex-turn-toggle aria-expanded="${collapsed ? 'false' : 'true'}">
        <span class="codex-turn-status-label">${escapeHtml(summary.label)}</span>
        <span class="codex-turn-status-chevron" aria-hidden="true">›</span>
        <span class="codex-turn-status-line" aria-hidden="true"></span>
    </button>`;
}

export function renderFinalAnswer(content: string, options: RenderCodexAssistantTurnOptions): string {
    if (!content.trim()) return '';
    return `<div class="codex-final-answer msg-bubble markdown-body">${options.renderMarkdown(content)}</div>`;
}

function firstActivityKind(items: CodexTurnItem[]): string {
    for (const item of items) {
        if (item.type === 'group') return item.group.kind;
        if (item.type === 'activity') return item.event.groupKind || item.event.kind;
    }
    return 'working';
}

function hasProcessText(items: CodexTurnItem[]): boolean {
    return items.some(item => item.type === 'text' && item.text.content.trim().length > 0);
}

function renderAutoProgress(model: CodexTurnModel, options: RenderCodexAssistantTurnOptions): string {
    if (hasProcessText(model.items) || model.items.length === 0) return '';
    const progress = options.i18n.codex.progress;
    const kind = firstActivityKind(model.items);
    const text = kind === 'command'
        ? progress.command
        : kind === 'read'
            ? progress.read
            : kind === 'validation'
                ? progress.validation
                : kind === 'tool'
                    ? progress.tool
                    : progress.working;
    return `<div class="codex-process-text codex-auto-progress markdown-body">${options.renderMarkdown(text)}</div>`;
}

export function renderAssistantTurnCodex(content: string, steps: Record<string, unknown>[] | undefined, options: RenderCodexAssistantTurnOptions): string {
    const model = buildCodexAssistantTurnModel(content, steps, options);
    const streamClass = options.live ? ' codex-turn-live' : '';
    const collapsedClass = options.live ? '' : ' codex-turn-collapsed';
    const subagentClass = options.isSubagentView ? ' codex-turn-subagent' : '';
    const activity = model.items.length > 0
        ? `<div class="codex-activity-stream">${renderAutoProgress(model, options)}${renderCodexTurnItems(model.items, {
            labels: options.i18n.codex,
            renderMarkdown: options.renderMarkdown,
        })}</div>`
        : '';
    return `<section class="codex-turn${streamClass}${subagentClass}${collapsedClass}" data-codex-turn-status="${escapeHtml(model.summary.status)}">
        ${renderTurnStatus(model.summary, options)}
        <div class="codex-assistant-body">
            ${activity}
            ${renderFinalAnswer(model.finalText, options)}
        </div>
    </section>`;
}
