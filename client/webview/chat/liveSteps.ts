import { svgIconNoMargin } from '../svgIcons';
import { escapeHtml, formatDuration, formatNum, type RunSummary } from './formatters';

export interface AgentStreamStateLike {
    liveSteps: Array<{ type?: string; toolName?: string }>;
    startedAt: number;
    lastStepAt: number;
    completedAt: number | null;
    isComplete: boolean;
}

export function latestLiveToolName(steps: Array<{ type?: string; toolName?: string }>, fallback = '等待输出'): string {
    for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if ((step?.type === 'tool_call' || step?.type === 'tool_result') && step.toolName) {
            return String(step.toolName);
        }
    }
    return fallback;
}

export function buildLiveProcessSummaryHtml(
    iconName: string,
    title: string,
    meta: string,
): string {
    return `${svgIconNoMargin(iconName as any)} <span class="process-title">${escapeHtml(title)}</span><span class="process-meta">${escapeHtml(meta)}</span>`;
}

export function buildLiveProcessMeta(steps: Array<{ type?: string }>): string {
    const toolCount = steps.filter(step => step.type === 'tool_call').length;
    const thinkingCount = steps.filter(step => step.type === 'thinking' || step.type === 'thinking_content').length;
    const textCount = steps.filter(step => step.type === 'text_delta').length;
    return `${thinkingCount} 思考 · ${toolCount} 工具 · ${textCount} 文本`;
}

export function buildSubagentCardHtml(agentId: string, _uniqueId: string): string {
    return `
        <div class="lane-header">
            <span class="lane-icon">${svgIconNoMargin('bot')}</span>
            <span class="lane-role">子任务 ${escapeHtml(agentId)}</span>
            <span class="lane-status" style="margin-left:auto;">•</span>
        </div>
        <div class="lane-status-text">正在启动...</div>
        <div class="lane-meta lane-live-meta">
            <span data-lane-elapsed>0s</span>
            <span data-lane-tool>等待输出</span>
        </div>
    `;
}

export function buildSubagentFullscreenHtml(agentId: string, uniqueId: string): string {
    return `
        <div class="subagent-header">
            <button class="subagent-back-btn" data-target-id="${escapeHtml(uniqueId)}">← 返回</button>
            <div class="subagent-title-wrap">
                <span class="subagent-title">子代理 ${escapeHtml(agentId)}</span>
                <span class="subagent-subtitle">实时过程集中显示</span>
            </div>
            <div class="subagent-header-metrics">
                <span>0s</span>
                <span>0 工具</span>
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
): string {
    const elapsedMs = Math.max(0, (state.completedAt || now) - state.startedAt);
    return `
        <span data-lane-elapsed>${escapeHtml(formatDuration(elapsedMs))}</span>
        <span data-lane-tool>${escapeHtml(toolName)}</span>
        <span>${summary.toolCallCount} 工具</span>
        ${summary.readCount ? `<span>${summary.readCount} 读取</span>` : ''}
        ${summary.writeCount ? `<span>${summary.writeCount} 写入</span>` : ''}
    `;
}

export function buildSubagentHeaderMetricsHtml(
    state: AgentStreamStateLike,
    summary: Pick<RunSummary, 'toolCallCount' | 'readCount' | 'writeCount'>,
    now = Date.now(),
): string {
    const elapsedMs = Math.max(0, (state.completedAt || now) - state.startedAt);
    return `
        <span>${escapeHtml(formatDuration(elapsedMs))}</span>
        <span>${summary.toolCallCount} 工具</span>
        <span>${summary.readCount} 读</span>
        <span>${summary.writeCount} 写</span>
    `;
}

export function buildThinkingSummaryHtml(content: string): string {
    const est = Math.ceil(content.length / 4);
    return '<span class="think-pulse spinning"></span>思考详情 &nbsp;<span class="think-tokens">~' + formatNum(est) + ' tokens</span>';
}
