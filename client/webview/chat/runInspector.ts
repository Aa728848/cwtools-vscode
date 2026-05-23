/**
 * Run Inspector — 渲染选中事件的详情面板 (Phase 1 - P1-2)
 *
 * 职责：
 * - 选中 event 的 JSON payload 详情展示
 * - tool_call 工具输入/输出查看
 * - diff / log inspector
 * - 大结果的 "打开完整内容" 入口
 * - context meter 显示 token 使用率
 */

export interface RunInspectorState {
    selectedEventId?: string;
    selectedEvent?: any;
    contextMeter?: {
        estimatedPromptTokens: number;
        contextLimit: number;
        percentage: number;
    };
}

import type { ChatI18nText } from './i18n';
import { svgIcon } from '../svgIcons';

const INSPECTOR_PREVIEW_CHARS = 3000;

function truncateInspectorText(text: string, maxChars = INSPECTOR_PREVIEW_CHARS): string {
    if (text.length <= maxChars) return text;
    return `${text.substring(0, maxChars)}\n... (${text.length - maxChars} chars truncated)`;
}

function stringifyInspectorPreview(value: unknown, maxChars = INSPECTOR_PREVIEW_CHARS): string {
    try {
        const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return truncateInspectorText(String(raw ?? ''), maxChars);
    } catch {
        return truncateInspectorText(String(value ?? ''), maxChars);
    }
}

/**
 * Formats an event payload for display in the inspector panel.
 */
export function formatEventPayload(event: any, i18n?: ChatI18nText): string {
    const t = i18n?.runs?.inspector;
    if (!event) return `<em>${t?.noEvent ?? 'No event selected'}</em>`;

    const payload = event.payload;
    if (!payload) return '<pre>{}</pre>';

    // Special formatting for tool events
    if (event.type === 'tool_call_start' || event.type === 'tool_call_created') {
        const toolName = payload.toolName || payload.name || 'unknown';
        const args = payload.args || payload.arguments || {};
        let html = `<div class="inspector-tool-call">`;
        html += `<h4>${svgIcon('gear')} ${toolName}</h4>`;
        html += `<div class="inspector-section"><strong>${t?.args ?? 'Args'}:</strong><pre>${escapeHtml(stringifyInspectorPreview(args))}</pre></div>`;
        if (payload.argRepairs && payload.argRepairs.length > 0) {
            html += `<div class="inspector-section inspector-repairs"><strong>${t?.argRepairs ?? 'Arg repairs'}:</strong><ul>${payload.argRepairs.map((r: string) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`;
        }
        if (payload.targetPaths && payload.targetPaths.length > 0) {
            html += `<div class="inspector-section"><strong>${t?.targetPaths ?? 'Target paths'}:</strong><ul>${payload.targetPaths.map((p: string) => `<li><code>${escapeHtml(p)}</code></li>`).join('')}</ul></div>`;
        }
        html += `</div>`;
        return html;
    }

    if (event.type === 'tool_call_end') {
        let html = `<div class="inspector-tool-result">`;
        const success = payload.success !== false;
        html += `<h4>${success ? svgIcon('check') : svgIcon('x')} ${t?.toolResult ?? 'Tool result'}</h4>`;
        if (payload.resultRef) {
            html += `<div class="inspector-section"><strong>${t?.fullResult ?? 'Full result'}:</strong> <a class="open-result-link" data-path="${escapeHtml(payload.resultRef)}" href="#">${svgIcon('folder')} ${t?.openFullContent ?? 'Open full content'}</a></div>`;
        }
        if (payload.error) {
            html += `<div class="inspector-section inspector-error"><strong>${t?.error ?? 'Error'}:</strong> <pre>${escapeHtml(String(payload.error))}</pre></div>`;
        }
        const preview = payload.preview || payload.result;
        if (preview) {
            const str = stringifyInspectorPreview(preview, 2000);
            html += `<div class="inspector-section"><strong>${t?.preview ?? 'Preview'}:</strong><pre>${escapeHtml(str)}</pre></div>`;
        }
        html += `</div>`;
        return html;
    }

    if (event.type === 'file_change') {
        let html = `<div class="inspector-file-change">`;
        html += `<h4>${svgIcon('file')} ${t?.fileChange ?? 'File change'}</h4>`;
        html += `<div class="inspector-section"><strong>${t?.path ?? 'Path'}:</strong> <code>${escapeHtml(payload.filePath || '')}</code></div>`;
        if (payload.diff) {
            html += `<div class="inspector-section"><strong>${t?.diff ?? 'Diff'}:</strong><pre class="diff-block">${escapeHtml(payload.diff)}</pre></div>`;
        }
        html += `</div>`;
        return html;
    }

    if (event.type === 'subagent_end') {
        let html = `<div class="inspector-subagent-result">`;
        html += `<h4>${payload.success ? svgIcon('check') : svgIcon('x')} ${t?.subagentResult ?? 'Sub-agent result'}</h4>`;
        html += `<div class="inspector-section"><strong>${t?.task ?? 'Task'}:</strong> <code>${escapeHtml(payload.taskNodeId || event.agentId || '')}</code></div>`;
        if (Array.isArray(payload.filesWritten) && payload.filesWritten.length > 0) {
            html += `<div class="inspector-section"><strong>${t?.changeset ?? 'Changeset'}:</strong><ul>${payload.filesWritten.map((file: string) => `<li><code>${escapeHtml(file)}</code></li>`).join('')}</ul></div>`;
        }
        if (payload.error) {
            html += `<div class="inspector-section inspector-error"><strong>${t?.error ?? 'Error'}:</strong><pre>${escapeHtml(truncateInspectorText(String(payload.error)))}</pre></div>`;
        }
        html += `<div class="inspector-section"><strong>${t?.steps ?? 'Steps'}:</strong> ${Number(payload.stepCount || 0)} / <strong>${t?.tokens ?? 'Tokens'}:</strong> ${Number(payload.tokenUsage?.total || 0)}</div>`;
        html += `</div>`;
        return html;
    }

    if (event.type === 'compaction_end') {
        let html = `<div class="inspector-compaction">`;
        html += `<h4>${svgIcon('package')} ${t?.compactionDone ?? 'Context compaction complete'}</h4>`;
        if (payload.summary) {
            const summary = payload.summary;
            html += `<div class="inspector-section"><strong>${t?.goal ?? 'Goal'}:</strong> ${escapeHtml(summary.goal || '')}</div>`;
            if (summary.nextSteps && summary.nextSteps.length > 0) {
                html += `<div class="inspector-section"><strong>${t?.nextSteps ?? 'Next steps'}:</strong><ul>${summary.nextSteps.map((s: string) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>`;
            }
        }
        html += `</div>`;
        return html;
    }

    if (event.type === 'cache_stats') {
        const payload = event.payload || {};
        const cs = event.cacheStats || payload.cacheStats || {};
        const cached = cs.cachedTokens || 0;
        const created = cs.cacheCreationTokens || 0;
        const total = cs.totalTokens || 0;
        const miss = Math.max(0, total - cached - created);

        const cachedPct = total > 0 ? (cached / total) * 100 : 0;
        const createdPct = total > 0 ? (created / total) * 100 : 0;
        const missPct = total > 0 ? (miss / total) * 100 : 0;

        let html = `<div class="inspector-cache-stats">`;
        html += `<h4>${svgIcon('sparkles')} 前缀缓存效能审计</h4>`;
        
        // 三柱图
        html += `<div class="inspector-section">`;
        html += `<strong>缓存效能分布:</strong>`;
        html += `<div class="cache-sparkline" style="max-width: 100%; height: 10px; margin: 8px 0;" title="缓存命中: ${cached} | 缓存新建: ${created} | 穿透/未命中: ${miss}">`;
        if (cachedPct > 0) html += `<div class="spark-bar spark-hit" style="width: ${cachedPct}%"></div>`;
        if (createdPct > 0) html += `<div class="spark-bar spark-create" style="width: ${createdPct}%"></div>`;
        if (missPct > 0) html += `<div class="spark-bar spark-miss" style="width: ${missPct}%"></div>`;
        html += `</div>`;
        html += `</div>`;

        // 细节列表
        html += `<div class="inspector-section">`;
        html += `<strong>详细统计:</strong>`;
        html += `<ul>`;
        html += `<li><strong>缓存命中 (Hit):</strong> <code style="color:var(--vscode-charts-green); font-weight:bold;">${cached} tokens</code> (${cachedPct.toFixed(1)}%)</li>`;
        html += `<li><strong>缓存新建 (Create):</strong> <code style="color:var(--vscode-charts-blue); font-weight:bold;">${created} tokens</code> (${createdPct.toFixed(1)}%)</li>`;
        html += `<li><strong>缓存穿透 (Miss):</strong> <code style="color:var(--vscode-charts-orange); font-weight:bold;">${miss} tokens</code> (${missPct.toFixed(1)}%)</li>`;
        html += `<li><strong>总上下文大小:</strong> <code>${total} tokens</code></li>`;
        html += `<li><strong>本次推断成本节省:</strong> <span class="cache-savings" style="color:var(--vscode-charts-green); font-weight:bold;">¥${(cs.savedCostCny || 0).toFixed(6)}</span></li>`;
        html += `</ul>`;
        html += `</div>`;

        // 原生日志内容
        html += `<div class="inspector-section"><strong>审计日志:</strong><pre>${escapeHtml(event.content || '')}</pre></div>`;
        html += `</div>`;
        return html;
    }

    // Default: JSON dump
    return `<pre>${escapeHtml(stringifyInspectorPreview(payload))}</pre>`;
}

/**
 * Renders context meter showing token usage percentage.
 */
export function renderContextMeter(estimated: number, limit: number, i18n?: ChatI18nText): string {
    if (limit <= 0) return '';
    const t = i18n?.runs?.inspector;
    const pct = Math.min(100, Math.round((estimated / limit) * 100));
    const color = pct > 90 ? 'var(--vscode-errorForeground)' : pct > 70 ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-charts-green)';
    const title = (t?.contextUsage ?? 'Context usage: {pct}% ({estimated}/{limit} tokens)')
        .replace('{pct}', String(pct))
        .replace('{estimated}', String(estimated))
        .replace('{limit}', String(limit));
    return `
        <div class="context-meter" title="${title}">
            <div class="meter-label">Context</div>
            <div class="meter-bar-container">
                <div class="meter-bar" style="width: ${pct}%; background: ${color};"></div>
            </div>
            <div class="meter-value">${pct}%</div>
        </div>
    `;
}

/**
 * Renders the full inspector panel HTML.
 */
export function renderInspectorHTML(state: RunInspectorState, i18n?: ChatI18nText): string {
    const t = i18n?.runs?.inspector;
    let html = '<div class="run-inspector">';

    // Context meter
    if (state.contextMeter) {
        html += renderContextMeter(state.contextMeter.estimatedPromptTokens, state.contextMeter.contextLimit, i18n);
    }

    // Selected event details
    if (state.selectedEvent) {
        const evt = state.selectedEvent;
        const time = new Date(evt.timestamp).toLocaleString();
        html += `<div class="inspector-header">`;
        html += `<span class="event-type-badge">${evt.type}</span>`;
        html += `<span class="event-time">${time}</span>`;
        if (evt.invocationId) html += ` <code>${evt.invocationId}</code>`;
        if (evt.agentId) html += ` <span class="agent-badge">${t?.agentLabel ?? 'Agent'}: ${evt.agentId}</span>`;
        html += `</div>`;
        html += formatEventPayload(evt, i18n);
    } else {
        html += `<div class="inspector-empty">${t?.selectEventHint ?? 'Select an event to view details'}</div>`;
    }

    html += '</div>';
    return html;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
