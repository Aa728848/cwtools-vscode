import { svgIconNoMargin } from '../svgIcons';
import { escapeHtml, formatDuration, formatNum, type RunSummary } from './formatters';
import { getChatI18n, type ChatI18nText } from './i18n';

export interface AgentStreamStateLike {
    liveSteps: Array<{ type?: string; toolName?: string }>;
    startedAt: number;
    lastStepAt: number;
    completedAt: number | null;
    isComplete: boolean;
}

export function latestLiveToolName(
    steps: Array<{ type?: string; toolName?: string }>,
    fallback = getChatI18n('zh-cn').live.waitingForOutput
): string {
    for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if ((step?.type === 'tool_call' || step?.type === 'tool_result') && step.toolName) {
            return String(step.toolName);
        }
    }
    return fallback;
}

export function hasVisibleLiveContent(step: { content?: unknown }): boolean {
    return typeof step.content === 'string' && step.content.trim().length > 0;
}

export function buildLiveProcessSummaryHtml(
    iconName: string,
    title: string,
    meta: string,
): string {
    return `${svgIconNoMargin(iconName as any)} <span class="process-title">${escapeHtml(title)}</span><span class="process-meta">${escapeHtml(meta)}</span>`;
}

export function buildLiveProcessMeta(steps: Array<{ type?: string }>, i18n: ChatI18nText = getChatI18n('zh-cn')): string {
    const toolCount = steps.filter(step => step.type === 'tool_call').length;
    const thinkingCount = steps.filter(step => step.type === 'thinking' || step.type === 'thinking_content').length;
    const textCount = steps.filter(step => step.type === 'text_delta').length;
    return `${thinkingCount} ${i18n.live.thoughts} · ${toolCount} ${i18n.live.tools} · ${textCount} ${i18n.live.text}`;
}

export function buildSubagentCardHtml(agentId: string, _uniqueId: string, i18n: ChatI18nText = getChatI18n('zh-cn')): string {
    return `
        <div class="lane-header">
            <span class="lane-icon">${svgIconNoMargin('bot')}</span>
            <span class="lane-role">${escapeHtml(i18n.live.subtask)} ${escapeHtml(agentId)}</span>
            <span class="lane-status" style="margin-left:auto;">•</span>
        </div>
        <div class="lane-status-text">${escapeHtml(i18n.live.starting)}</div>
        <div class="lane-meta lane-live-meta">
            <span data-lane-elapsed>0s</span>
            <span data-lane-tool>${escapeHtml(i18n.live.waitingForOutput)}</span>
        </div>
    `;
}

export function buildSubagentFullscreenHtml(agentId: string, uniqueId: string, i18n: ChatI18nText = getChatI18n('zh-cn')): string {
    return `
        <div class="subagent-header">
            <button class="subagent-back-btn" data-target-id="${escapeHtml(uniqueId)}">← ${escapeHtml(i18n.live.back)}</button>
            <div class="subagent-title-wrap">
                <span class="subagent-title">${escapeHtml(i18n.live.subagent)} ${escapeHtml(agentId)}</span>
                <span class="subagent-subtitle">${escapeHtml(i18n.live.realtimeProcess)}</span>
            </div>
            <div class="subagent-header-metrics">
                <span>0s</span>
                <span>0 ${escapeHtml(i18n.live.tools)}</span>
            </div>
        </div>
        <div class="subagent-body"></div>
    `;
}

export function buildSubagentMetaHtml(
    state: AgentStreamStateLike,
    summary: Pick<RunSummary, 'toolCallCount' | 'readCount' | 'writeCount'>,
    toolName: string,
    now = Date.now(),
    i18n: ChatI18nText = getChatI18n('zh-cn'),
): string {
    const elapsedMs = Math.max(0, (state.completedAt || now) - state.startedAt);
    return `
        <span data-lane-elapsed>${escapeHtml(formatDuration(elapsedMs))}</span>
        <span data-lane-tool>${escapeHtml(toolName)}</span>
        <span>${summary.toolCallCount} ${escapeHtml(i18n.live.tools)}</span>
        ${summary.readCount ? `<span>${summary.readCount} ${escapeHtml(i18n.live.reads)}</span>` : ''}
        ${summary.writeCount ? `<span>${summary.writeCount} ${escapeHtml(i18n.live.writes)}</span>` : ''}
    `;
}

export function buildSubagentHeaderMetricsHtml(
    state: AgentStreamStateLike,
    summary: Pick<RunSummary, 'toolCallCount' | 'readCount' | 'writeCount'>,
    now = Date.now(),
    i18n: ChatI18nText = getChatI18n('zh-cn'),
): string {
    const elapsedMs = Math.max(0, (state.completedAt || now) - state.startedAt);
    return `
        <span>${escapeHtml(formatDuration(elapsedMs))}</span>
        <span>${summary.toolCallCount} ${escapeHtml(i18n.live.tools)}</span>
        <span>${summary.readCount} ${escapeHtml(i18n.live.reads)}</span>
        <span>${summary.writeCount} ${escapeHtml(i18n.live.writes)}</span>
    `;
}

export function buildThinkingSummaryHtml(content: string, i18n: ChatI18nText = getChatI18n('zh-cn')): string {
    const est = Math.ceil(content.length / 4);
    return '<span class="think-pulse spinning"></span>' +
        escapeHtml(i18n.live.thinkingDetails) +
        '&nbsp;<span class="think-tokens">~' +
        formatNum(est) +
        ' tokens</span>';
}
