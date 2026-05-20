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

/**
 * Formats an event payload for display in the inspector panel.
 */
export function formatEventPayload(event: any): string {
    if (!event) return '<em>无选中事件</em>';

    const payload = event.payload;
    if (!payload) return '<pre>{}</pre>';

    // Special formatting for tool events
    if (event.type === 'tool_call_start' || event.type === 'tool_call_created') {
        const toolName = payload.toolName || payload.name || 'unknown';
        const args = payload.args || payload.arguments || {};
        let html = `<div class="inspector-tool-call">`;
        html += `<h4>🔧 ${toolName}</h4>`;
        html += `<div class="inspector-section"><strong>参数:</strong><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></div>`;
        if (payload.argRepairs && payload.argRepairs.length > 0) {
            html += `<div class="inspector-section inspector-repairs"><strong>参数修复:</strong><ul>${payload.argRepairs.map((r: string) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`;
        }
        if (payload.targetPaths && payload.targetPaths.length > 0) {
            html += `<div class="inspector-section"><strong>影响路径:</strong><ul>${payload.targetPaths.map((p: string) => `<li><code>${escapeHtml(p)}</code></li>`).join('')}</ul></div>`;
        }
        html += `</div>`;
        return html;
    }

    if (event.type === 'tool_call_end') {
        let html = `<div class="inspector-tool-result">`;
        const success = payload.success !== false;
        html += `<h4>${success ? '✅' : '❌'} 工具结果</h4>`;
        if (payload.resultRef) {
            html += `<div class="inspector-section"><strong>完整结果:</strong> <a class="open-result-link" data-path="${escapeHtml(payload.resultRef)}" href="#">📂 打开完整内容</a></div>`;
        }
        if (payload.error) {
            html += `<div class="inspector-section inspector-error"><strong>错误:</strong> <pre>${escapeHtml(String(payload.error))}</pre></div>`;
        }
        const preview = payload.preview || payload.result;
        if (preview) {
            const str = typeof preview === 'string' ? preview : JSON.stringify(preview, null, 2);
            html += `<div class="inspector-section"><strong>预览:</strong><pre>${escapeHtml(str.substring(0, 2000))}${str.length > 2000 ? '\n... (已截断)' : ''}</pre></div>`;
        }
        html += `</div>`;
        return html;
    }

    if (event.type === 'file_change') {
        let html = `<div class="inspector-file-change">`;
        html += `<h4>📁 文件变更</h4>`;
        html += `<div class="inspector-section"><strong>路径:</strong> <code>${escapeHtml(payload.filePath || '')}</code></div>`;
        if (payload.diff) {
            html += `<div class="inspector-section"><strong>Diff:</strong><pre class="diff-block">${escapeHtml(payload.diff)}</pre></div>`;
        }
        html += `</div>`;
        return html;
    }

    if (event.type === 'subagent_end') {
        let html = `<div class="inspector-subagent-result">`;
        html += `<h4>${payload.success ? '✅' : '❌'} 子 Agent 结果</h4>`;
        html += `<div class="inspector-section"><strong>任务:</strong> <code>${escapeHtml(payload.taskNodeId || event.agentId || '')}</code></div>`;
        if (Array.isArray(payload.filesWritten) && payload.filesWritten.length > 0) {
            html += `<div class="inspector-section"><strong>变更集:</strong><ul>${payload.filesWritten.map((file: string) => `<li><code>${escapeHtml(file)}</code></li>`).join('')}</ul></div>`;
        }
        if (payload.error) {
            html += `<div class="inspector-section inspector-error"><strong>错误:</strong><pre>${escapeHtml(String(payload.error))}</pre></div>`;
        }
        html += `<div class="inspector-section"><strong>步骤:</strong> ${Number(payload.stepCount || 0)} / <strong>Tokens:</strong> ${Number(payload.tokenUsage?.total || 0)}</div>`;
        html += `</div>`;
        return html;
    }

    if (event.type === 'compaction_end') {
        let html = `<div class="inspector-compaction">`;
        html += `<h4>📦 上下文压缩完成</h4>`;
        if (payload.summary) {
            const summary = payload.summary;
            html += `<div class="inspector-section"><strong>目标:</strong> ${escapeHtml(summary.goal || '')}</div>`;
            if (summary.nextSteps && summary.nextSteps.length > 0) {
                html += `<div class="inspector-section"><strong>下一步:</strong><ul>${summary.nextSteps.map((s: string) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>`;
            }
        }
        html += `</div>`;
        return html;
    }

    // Default: JSON dump
    return `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
}

/**
 * Renders context meter showing token usage percentage.
 */
export function renderContextMeter(estimated: number, limit: number): string {
    if (limit <= 0) return '';
    const pct = Math.min(100, Math.round((estimated / limit) * 100));
    const color = pct > 90 ? 'var(--vscode-errorForeground)' : pct > 70 ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-charts-green)';
    return `
        <div class="context-meter" title="上下文使用率: ${pct}% (${estimated}/${limit} tokens)">
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
export function renderInspectorHTML(state: RunInspectorState): string {
    let html = '<div class="run-inspector">';

    // Context meter
    if (state.contextMeter) {
        html += renderContextMeter(state.contextMeter.estimatedPromptTokens, state.contextMeter.contextLimit);
    }

    // Selected event details
    if (state.selectedEvent) {
        const evt = state.selectedEvent;
        const time = new Date(evt.timestamp).toLocaleString();
        html += `<div class="inspector-header">`;
        html += `<span class="event-type-badge">${evt.type}</span>`;
        html += `<span class="event-time">${time}</span>`;
        if (evt.invocationId) html += ` <code>${evt.invocationId}</code>`;
        if (evt.agentId) html += ` <span class="agent-badge">Agent: ${evt.agentId}</span>`;
        html += `</div>`;
        html += formatEventPayload(evt);
    } else {
        html += '<div class="inspector-empty">选择一个事件以查看详情</div>';
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
