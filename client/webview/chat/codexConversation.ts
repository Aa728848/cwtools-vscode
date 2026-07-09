import { escapeHtml } from './formatters';
import { buildCodexTurnModel } from './codexActivity';
import { renderCodexTurnItems } from './codexToolRows';
import type { ChatI18nText } from './i18n';
import type { CodexTurnModel, CodexTurnSummary } from './codexTypes';

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
    const issue = summary.issueCount > 0
        ? `<span class="codex-turn-issues">${summary.issueCount} ${escapeHtml(summary.issueCount === 1 ? options.i18n.codex.status.issue : options.i18n.codex.status.issues)}</span>`
        : '';
    return `<button type="button" class="codex-turn-status codex-turn-status-${summary.status}" data-codex-turn-toggle aria-expanded="true">
        <span class="codex-turn-status-label">${escapeHtml(summary.label)}</span>
        ${issue}
        <span class="codex-turn-status-chevron" aria-hidden="true">›</span>
        <span class="codex-turn-status-line" aria-hidden="true"></span>
    </button>`;
}

export function renderFinalAnswer(content: string, options: RenderCodexAssistantTurnOptions): string {
    if (!content.trim()) return '';
    return `<div class="codex-final-answer msg-bubble markdown-body">${options.renderMarkdown(content)}</div>`;
}

export function renderAssistantTurnCodex(content: string, steps: Record<string, unknown>[] | undefined, options: RenderCodexAssistantTurnOptions): string {
    const model = buildCodexAssistantTurnModel(content, steps, options);
    const streamClass = options.live ? ' codex-turn-live' : '';
    const subagentClass = options.isSubagentView ? ' codex-turn-subagent' : '';
    const activity = model.items.length > 0
        ? `<div class="codex-activity-stream">${renderCodexTurnItems(model.items, {
            labels: options.i18n.codex,
            renderMarkdown: options.renderMarkdown,
        })}</div>`
        : '';
    return `<section class="codex-turn${streamClass}${subagentClass}" data-codex-turn-status="${escapeHtml(model.summary.status)}">
        ${renderTurnStatus(model.summary, options)}
        <div class="codex-assistant-body">
            ${activity}
            ${renderFinalAnswer(model.finalText, options)}
        </div>
    </section>`;
}
