/**
 * Eddy CWTool Code — Message Renderer (Pure Functions)
 *
 * Extracted from chatPanel.ts to enable unit testing without DOM dependencies.
 * All functions are pure: they accept data and return HTML strings or structured objects.
 * The WebView chatPanel.ts consumes these via `element.innerHTML = buildXxx(...)`.
 *
 * @module messageRenderer
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal step shape matching AgentStep (avoids importing vscode-dependent types) */
export interface RendererStep {
    type: string;
    content: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: unknown;
    timestamp: number;
    stepIndex?: number;
    durationMs?: number;
    iterationInfo?: string;
    permissionId?: string;
}

export interface ClassifiedSteps {
    /** thinking + thinking_content steps (NOT text_delta!) */
    thinkingSteps: RendererStep[];
    /** text_delta steps — final streaming reply tokens */
    textDeltaSteps: RendererStep[];
    /** tool_call steps */
    toolCalls: RendererStep[];
    /** tool_result steps */
    toolResults: RendererStep[];
    /** error, validation, compaction, and other special steps */
    specialSteps: RendererStep[];
}

/**
 * Routing target for a live (streaming) step.
 * - 'thinking'    → render into the collapsible thinking block
 * - 'text_bubble' → render into the streaming final-reply bubble
 * - 'tool_call'   → append a new tool-pair entry to the timeline
 * - 'tool_result' → update an existing tool-pair entry with result
 * - 'special'     → append a special-step div (error/validation/compaction)
 */
export type LiveStepTarget = 'thinking' | 'text_bubble' | 'tool_call' | 'tool_result' | 'special';

export interface ToolPairOptions {
    /** Display execution duration (call timestamp → result timestamp) */
    showDuration?: boolean;
    /** Display parameter summary (oldString/newString preview) */
    showParams?: boolean;
    /** Display inline diff preview for edit_file results */
    showDiff?: boolean;
    /** Max characters for parameter preview (default: 40) */
    paramPreviewLen?: number;
    /** Step index to display (1-based numbering: "1.", "2.", ...) */
    stepIndex?: number;
    /** Max diff lines to render inline (default: 20) */
    maxDiffLines?: number;
}

// ── Tool icon map (text-only, no SVG — SVG injected by WebView consumer) ─────

const TOOL_ICON_LABELS: Record<string, string> = {
    read_file: '📂', write_file: '💾', edit_file: '✏️', multiedit: '✏️',
    list_directory: '📁', search_mod_files: '🔍', validate_code: '✅',
    get_file_context: '📄', get_diagnostics: '🩺', get_completion_at: '💡',
    document_symbols: '🔖', workspace_symbols: '🔖', query_scope: '🔭',
    query_types: '📏', query_rules: '📏', query_references: '🔗',
    todo_write: '📋', run_command: '⚡', search_web: '🌐', codesearch: '🔎',
    glob_files: '📁', delete_file: '🗑️', apply_patch: '🩹',
    spawn_sub_agents: '🤖', web_fetch: '🌐',
    permission_request: '🔑',
};

const DEFAULT_MAX_DIFF_LINES = 20;
const DEFAULT_PARAM_PREVIEW_LEN = 40;

// ── Core Pure Functions ──────────────────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(t: unknown): string {
    return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * - < 1000ms → "45ms"
 * - < 60000ms → "2.5s"
 * - >= 60000ms → "2m 5s"
 */
export function formatDuration(ms: number): string {
    if (ms <= 0) return '0ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

/**
 * Extract a concise summary from tool arguments for display.
 */
export function summarizeToolArgs(toolName: string, args: Record<string, unknown>, maxLen?: number): string {
    const limit = maxLen ?? DEFAULT_PARAM_PREVIEW_LEN;

    // File path extraction
    const fp = args.filePath ?? args.file ?? args.path ?? args.directory;
    if (fp && typeof fp === 'string') {
        const basename = fp.split(/[\\/]/).pop() || fp;
        // For file tools, just show the basename
        if (['read_file', 'write_file', 'edit_file', 'multiedit', 'delete_file',
            'get_file_context', 'list_directory', 'apply_patch', 'glob_files'].includes(toolName)) {
            return basename;
        }
    }

    // Command tools
    if (toolName === 'run_command' && args.command) {
        const cmd = String(args.command);
        return cmd.length > limit ? cmd.substring(0, limit) + '...' : cmd;
    }

    // Search tools
    if ((toolName === 'search_web' || toolName === 'codesearch' || toolName === 'search_mod_files') && args.query) {
        const q = String(args.query);
        return q.length > limit ? q.substring(0, limit) + '...' : q;
    }

    // Todo tools
    if (toolName === 'todo_write') {
        const todos = Array.isArray(args.todos) ? args.todos : [];
        return `${todos.length} items`;
    }

    // Fallback: file basename if available
    if (fp && typeof fp === 'string') {
        return fp.split(/[\\/]/).pop() || '';
    }

    return '';
}

/**
 * Classify an array of agent steps into semantic groups.
 * CRITICAL: text_delta goes into textDeltaSteps, NOT thinkingSteps.
 */
export function classifySteps(steps: RendererStep[]): ClassifiedSteps {
    const result: ClassifiedSteps = {
        thinkingSteps: [],
        textDeltaSteps: [],
        toolCalls: [],
        toolResults: [],
        specialSteps: [],
    };

    for (const s of steps) {
        switch (s.type) {
            case 'thinking':
            case 'thinking_content':
                result.thinkingSteps.push(s);
                break;
            case 'text_delta':
                result.textDeltaSteps.push(s);
                break;
            case 'tool_call':
                result.toolCalls.push(s);
                break;
            case 'tool_result':
                result.toolResults.push(s);
                break;
            default:
                // error, validation, compaction, subtask_start, subtask_complete, etc.
                result.specialSteps.push(s);
                break;
        }
    }

    return result;
}

/**
 * Determine the rendering target for a live (streaming) step.
 * This is the CORRECTED routing logic — text_delta goes to text_bubble, not thinking.
 */
export function routeLiveStep(step: RendererStep): LiveStepTarget {
    switch (step.type) {
        case 'thinking':
        case 'thinking_content':
            return 'thinking';
        case 'text_delta':
            return 'text_bubble';
        case 'tool_call':
            return 'tool_call';
        case 'tool_result':
            return 'tool_result';
        default:
            return 'special';
    }
}

// ── Diff rendering ───────────────────────────────────────────────────────────

interface DiffLine {
    type: string; // 'add' | 'remove' | 'context'
    content: string;
    oldLineNo?: number;
    newLineNo?: number;
}

interface DiffData {
    additions: number;
    deletions: number;
    lines: DiffLine[];
}

function renderInlineDiff(diff: DiffData, maxLines: number): string {
    const lines = diff.lines.slice(0, maxLines);
    let html = '<div class="inline-diff">';
    for (const line of lines) {
        const cls = line.type === 'add' ? 'diff-add' : line.type === 'remove' ? 'diff-remove' : 'diff-ctx';
        const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        const lineNo = line.type === 'remove' ? (line.oldLineNo ?? '') : (line.newLineNo ?? '');
        html += `<div class="diff-line ${cls}"><span class="diff-ln">${lineNo}</span><span class="diff-prefix">${prefix}</span>${escapeHtml(line.content)}</div>`;
    }
    if (diff.lines.length > maxLines) {
        html += `<div class="diff-line diff-more">... ${diff.lines.length - maxLines} more lines</div>`;
    }
    html += '</div>';
    return html;
}

/** Parse a plain text unified diff string into structured DiffData. */
function parseUnifiedDiffString(text: string): DiffData {
    const lines: DiffLine[] = [];
    let additions = 0, deletions = 0;
    let oldLn = 1, newLn = 1;
    for (const raw of text.split('\n')) {
        if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('@@')) continue;
        if (raw === '(no changes)') continue;
        if (raw.startsWith('+ ') || raw.startsWith('+\t') || raw === '+') {
            lines.push({ type: 'add', content: raw.slice(2), newLineNo: newLn++ });
            additions++;
        } else if (raw.startsWith('- ') || raw.startsWith('-\t') || raw === '-') {
            lines.push({ type: 'remove', content: raw.slice(2), oldLineNo: oldLn++ });
            deletions++;
        } else if (raw.trim()) {
            lines.push({ type: 'context', content: raw, oldLineNo: oldLn++, newLineNo: newLn++ });
        }
    }
    return { additions, deletions, lines };
}

// ── Parameter preview ────────────────────────────────────────────────────────

function renderParamPreview(toolName: string, args: Record<string, unknown>, maxLen: number): string {
    if (toolName !== 'edit_file' && toolName !== 'multiedit') return '';
    const oldStr = args.oldString ?? args.old_string;
    const newStr = args.newString ?? args.new_string;
    if (!oldStr && !newStr) return '';

    let html = '<div class="tp-params">';
    if (oldStr) {
        const preview = String(oldStr).substring(0, maxLen);
        html += `<div class="tp-param"><span class="tp-param-label">old:</span> <code>${escapeHtml(preview)}${String(oldStr).length > maxLen ? '…' : ''}</code></div>`;
    }
    if (newStr) {
        const preview = String(newStr).substring(0, maxLen);
        html += `<div class="tp-param"><span class="tp-param-label">new:</span> <code>${escapeHtml(preview)}${String(newStr).length > maxLen ? '…' : ''}</code></div>`;
    }
    html += '</div>';
    return html;
}

// ── Main HTML builders ───────────────────────────────────────────────────────

/**
 * Build HTML for one tool-call / tool-result pair in the timeline.
 * Supports step indexing, duration display, parameter preview, and inline diff.
 */
export function buildToolPairHtml(
    callStep: RendererStep,
    resultStep?: RendererStep,
    opts?: ToolPairOptions
): string {
    const toolName: string = callStep.toolName || '';
    const args = (callStep.toolArgs || {}) as Record<string, unknown>;
    const icon = TOOL_ICON_LABELS[callStep.type === 'permission_request' ? 'permission_request' : toolName] || '⚙';
    const showDuration = opts?.showDuration ?? true;
    const showParams = opts?.showParams ?? false;
    const showDiff = opts?.showDiff ?? false;
    const paramLen = opts?.paramPreviewLen ?? DEFAULT_PARAM_PREVIEW_LEN;
    const maxDiffLines = opts?.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;

    // ── Permission request: special rendering with inline buttons ──
    if (callStep.type === 'permission_request') {
        const permId = callStep.permissionId || '';
        const cmd = escapeHtml(callStep.content || toolName);
        let html = `<div class="tool-pair tp-permission" data-perm-id="${escapeHtml(permId)}">`;
        if (opts?.stepIndex != null) html += `<span class="tp-idx">${opts.stepIndex}.</span>`;
        html += `<span class="tp-icon">${icon}</span>`;
        html += `<span class="tp-name">${escapeHtml(toolName)}</span>`;
        html += `<span class="tp-file">${cmd}</span>`;
        html += `<div class="tp-perm-actions">`;
        html += `<button class="tp-perm-btn tp-perm-allow" data-perm="${escapeHtml(permId)}" data-action="allow">允许</button>`;
        html += `<button class="tp-perm-btn tp-perm-deny" data-perm="${escapeHtml(permId)}" data-action="deny">拒绝</button>`;
        html += `<button class="tp-perm-btn tp-perm-always" data-perm="${escapeHtml(permId)}" data-action="always">始终允许</button>`;
        html += `</div></div>`;
        return html;
    }

    // ── Standard tool call ──
    const summary = summarizeToolArgs(toolName, args, paramLen);

    let callHtml = '';
    if (opts?.stepIndex != null) callHtml += `<span class="tp-idx">${opts.stepIndex}.</span>`;
    callHtml += `<span class="tp-icon">${icon}</span>`;
    callHtml += `<span class="tp-name">${escapeHtml(toolName)}</span>`;
    if (summary) callHtml += ` <span class="tp-file">${escapeHtml(summary)}</span>`;

    // Duration
    let durationHtml = '';
    if (showDuration && resultStep && resultStep.timestamp && callStep.timestamp) {
        const dur = resultStep.timestamp - callStep.timestamp;
        if (dur >= 0) {
            durationHtml = `<span class="tp-duration">${formatDuration(dur)}</span>`;
        }
    }

    // Result
    let resultHtml = '';
    if (resultStep && resultStep.toolResult != null) {
        const r = resultStep.toolResult as Record<string, unknown>;
        if (r && r.success === true) {
            const stats = r.stats as Record<string, number> | undefined;
            const added = stats?.linesAdded || 0;
            const removed = stats?.linesRemoved || 0;
            const diffStr = (added || removed) ? ` +${added}/-${removed}` : '';
            resultHtml = `<div class="tp-result ok">✓${escapeHtml(diffStr)}</div>`;
        } else if (r && r.success === false) {
            const errMsg = (r.message || r.error || '') as string;
            resultHtml = `<div class="tp-result err">✗ ${escapeHtml(errMsg)}</div>`;
        } else if (r && r.error) {
            resultHtml = `<div class="tp-result err">✗ ${escapeHtml(r.error as string)}</div>`;
        } else if (r && r.skipped) {
            resultHtml = `<div class="tp-result skip">— skipped</div>`;
        }
    }

    // Parameter preview
    const paramsHtml = showParams ? renderParamPreview(toolName, args, paramLen) : '';

    // Inline diff
    let diffHtml = '';
    if (showDiff && resultStep?.toolResult) {
        const r = resultStep.toolResult as Record<string, unknown>;
        let diff = r.diff as DiffData | string | undefined;
        // Parse plain text unified diff string into structured DiffData
        if (typeof diff === 'string' && diff.trim()) {
            diff = parseUnifiedDiffString(diff);
        }
        if (diff && typeof diff === 'object' && diff.lines && diff.lines.length > 0) {
            const rendered = renderInlineDiff(diff as DiffData, maxDiffLines);
            // Wrap in collapsible <details> for expand/collapse
            const d = diff as DiffData;
            diffHtml = `<details class="tool-diff-details"><summary class="tool-diff-summary">` +
                `<span class="ds-add">+${d.additions}</span> <span class="ds-del">-${d.deletions}</span>` +
                ` · ${d.lines.length} lines</summary>${rendered}</details>`;
        }
    }

    return `<div class="tool-pair"><div class="tp-call">${callHtml}${durationHtml}</div>${resultHtml}${paramsHtml}${diffHtml}</div>`;
}

/**
 * Build HTML for the collapsible thinking block.
 * Concatenates thinking_content and thinking steps, using separators for distinct blocks.
 */
export function buildThinkingBlockHtml(steps: RendererStep[]): string {
    if (steps.length === 0) return '';

    let thinkText = '';
    for (const s of steps) {
        if (s.type === 'thinking' && thinkText) {
            thinkText += '\n\n---\n\n' + (s.content || '');
        } else {
            thinkText += (s.content || '');
        }
    }
    thinkText = thinkText.trim();
    if (!thinkText) return '';

    const estTokens = Math.ceil(thinkText.length / 4);
    const formattedTokens = estTokens >= 1000 ? `${(estTokens / 1000).toFixed(1)}k` : String(estTokens);

    // Note: the content is escaped here. The WebView consumer may re-render
    // through its own markdown pipeline if desired.
    return `<details class="thinking-block"><summary><span class="think-pulse"></span>Thinking · ${steps.length} block(s) &nbsp;<span class="think-tokens">~${formattedTokens} tokens</span></summary><div class="thinking-body">${escapeHtml(thinkText)}</div></details>`;
}

/**
 * Determine the "phase" category for chronological grouping.
 */
function stepPhase(type: string): 'thinking' | 'tool' | 'text' | 'special' {
    if (type === 'thinking' || type === 'thinking_content') return 'thinking';
    if (type === 'tool_call' || type === 'tool_result') return 'tool';
    if (type === 'text_delta') return 'text';
    return 'special';
}

/**
 * Build the complete HTML for a finalized assistant message.
 * Renders steps CHRONOLOGICALLY — thinking, tools, and text from each iteration
 * appear interleaved in their original order (Claude Code style), not grouped by type.
 */
export function buildAssistantMessageHtml(
    content: string,
    classified: ClassifiedSteps,
    msgTime?: number
): string {
    // Recombine all steps in chronological order from the classified groups
    const allSteps = [
        ...classified.thinkingSteps,
        ...classified.textDeltaSteps,
        ...classified.toolCalls,
        ...classified.toolResults,
        ...classified.specialSteps,
    ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // If no steps, just render content
    if (allSteps.length === 0) {
        if (!content?.trim()) return '';
        return `<div class="msg-bubble" data-raw-content="${escapeHtml(content)}">${escapeHtml(content)}</div>`;
    }

    let html = '';
    let currentPhase: string | null = null;
    let thinkingBuf: RendererStep[] = [];
    let textBuf: RendererStep[] = [];
    let toolCallBuf: RendererStep[] = [];
    let toolResultBuf: RendererStep[] = [];
    let globalToolIdx = 0;

    function flushThinking() {
        if (thinkingBuf.length === 0) return;
        html += buildThinkingBlockHtml(thinkingBuf);
        thinkingBuf = [];
    }

    function flushText() {
        if (textBuf.length === 0) return;
        const text = textBuf.map(s => s.content || '').join('').trim();
        if (text) {
            html += `<div class="msg-bubble" data-raw-content="${escapeHtml(text)}">${escapeHtml(text)}</div>`;
        }
        textBuf = [];
    }

    function flushTools() {
        if (toolCallBuf.length === 0) return;
        html += '<div class="tool-timeline">';
        const resultsCopy = [...toolResultBuf];
        for (const call of toolCallBuf) {
            globalToolIdx++;
            const resultIdx = resultsCopy.findIndex(r => r.toolName === call.toolName);
            let result: RendererStep | undefined;
            if (resultIdx >= 0) {
                result = resultsCopy.splice(resultIdx, 1)[0];
            }
            html += buildToolPairHtml(call, result, {
                stepIndex: call.stepIndex || globalToolIdx,
                showDuration: true,
                showParams: true,
                showDiff: true,
            });
        }
        html += '</div>';
        toolCallBuf = [];
        toolResultBuf = [];
    }

    function flushCurrent() {
        if (currentPhase === 'thinking') flushThinking();
        else if (currentPhase === 'text') flushText();
        else if (currentPhase === 'tool') flushTools();
    }

    for (const s of allSteps) {
        const phase = stepPhase(s.type);

        if (phase === 'special') {
            // Special steps render inline without breaking flow
            const icon = s.type === 'error' ? '✗' : s.type === 'validation' ? '✓' : '⚙';
            html += `<div class="special-step"><span class="ss-icon">${icon}</span> ${escapeHtml(s.content || '')}</div>`;
            continue;
        }

        // tool_result doesn't change the phase — it pairs with tool_call
        if (s.type === 'tool_result') {
            toolResultBuf.push(s);
            continue;
        }

        // Phase transition: flush previous group
        if (phase !== currentPhase) {
            flushCurrent();
            currentPhase = phase;
        }

        // Accumulate into current group
        if (phase === 'thinking') thinkingBuf.push(s);
        else if (phase === 'text') textBuf.push(s);
        else if (phase === 'tool') toolCallBuf.push(s);
    }

    // Flush last group
    flushCurrent();

    // Append any explicit content (from the message body, not from steps)
    if (content?.trim()) {
        html += `<div class="msg-bubble" data-raw-content="${escapeHtml(content)}">${escapeHtml(content)}</div>`;
    }

    return html;
}
