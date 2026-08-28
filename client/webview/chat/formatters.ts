/**
 * Chat Panel — Pure Formatting Helpers
 *
 * Extracted from chatPanel.ts for testability and reuse.
 * These functions are pure (no DOM access, no vscode API).
 *
 * Phase 2 of the Webview Modularization plan:
 *   - Move escaping, formatting, and grouping helpers out
 *   - Add unit tests for extracted helpers
 */

/**
 * HTML-escape a value for safe insertion into HTML.
 * Handles null/undefined gracefully.
 */
export function escapeHtml(t: unknown): string {
    return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Format a number with 'k' suffix for thousands.
 * e.g. 1500 → "2k", 800 → "800"
 */
export function formatNum(n: number): string {
    return n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n);
}

/**
 * Format a timestamp as HH:MM.
 */
export function formatTime(ts: number | string | null): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 500 → "500ms", 2500 → "2.5s", 90000 → "1m 30s"
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
 * Extract the basename of a file path (last segment after / or \).
 */
export function fileBaseName(filePath: string): string {
    return filePath.split(/[\\/]/).pop() || filePath;
}

/**
 * Extract the file target from a tool step's arguments.
 * Returns the basename of the file, or empty string.
 */
export function extractStepFile(step: Record<string, unknown>): string {
    const args = (step?.toolArgs || {}) as Record<string, unknown>;
    const raw = (args.filePath || args.file || args.path || args.directory || '') as string;
    if (!raw) return '';
    return String(raw).split(/[\\/]/).pop() || String(raw);
}

/** Tool classification sets for run summary building. */
export const WRITE_TOOL_NAMES = new Set(['edit_file', 'write_file', 'multiedit', 'apply_patch', 'delete_file']);
export const READ_TOOL_NAMES = new Set(['read_file', 'list_directory', 'glob_files', 'grep', 'web_search', 'web_open', 'web_find', 'document_symbols', 'workspace_symbols']);
export const VALIDATION_TOOL_NAMES = new Set(['validate_code', 'get_diagnostics']);
export const ORCHESTRATOR_TOOL_NAMES = new Set(['dispatch_agents', 'query_blackboard', 'merge_results']);

/** Summary of an agent run, extracted from steps. */
export interface RunSummary {
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number;
    totalSteps: number;
    thinkingCount: number;
    toolCallCount: number;
    toolResultCount: number;
    writeCount: number;
    readCount: number;
    validationCount: number;
    orchestratorCount: number;
    errorCount: number;
    failedToolCount: number;
    changedFiles: string[];
    topTools: Array<{ name: string; count: number }>;
    latestStatus: string;
    hasOrchestrator: boolean;
    alerts: string[];
    validations: string[];
}

/**
 * Build a RunSummary from a list of agent steps.
 * Pure function — no DOM or vscode dependency.
 */
export function makeRunSummary(steps: Record<string, unknown>[] | undefined, fallbackContent?: string, locale: 'en' | 'zh-cn' = 'en'): RunSummary {
    const isZh = locale === 'zh-cn';
    const all = steps || [];
    const timestamps = all.map(s => Number(s.timestamp || 0)).filter(Boolean);
    const startedAt = timestamps.length ? Math.min(...timestamps) : null;
    const endedAt = timestamps.length ? Math.max(...timestamps) : null;
    const toolCounts = new Map<string, number>();
    const files = new Set<string>();
    let thinkingCount = 0;
    let toolCallCount = 0;
    let toolResultCount = 0;
    let writeCount = 0;
    let readCount = 0;
    let validationCount = 0;
    let orchestratorCount = 0;
    let errorCount = 0;
    let failedToolCount = 0;
    let latestStatus = fallbackContent?.trim() ? fallbackContent.trim() : (isZh ? '已完成' : 'Completed');
    const alerts: string[] = [];
    const validations: string[] = [];

    for (const step of all) {
        const type = (step?.type || '') as string;
        if (type === 'thinking' || type === 'thinking_content') thinkingCount++;
        if (type === 'tool_call') {
            const toolName = String(step.toolName || 'tool');
            const file = extractStepFile(step);
            toolCallCount++;
            toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
            if (WRITE_TOOL_NAMES.has(toolName)) {
                writeCount++;
                if (file) files.add(file);
            } else if (READ_TOOL_NAMES.has(toolName)) {
                readCount++;
            } else if (VALIDATION_TOOL_NAMES.has(toolName)) {
                validationCount++;
            } else if (ORCHESTRATOR_TOOL_NAMES.has(toolName)) {
                orchestratorCount++;
            }
            latestStatus = file
                ? (isZh ? `正在调用 ${toolName}: ${file}` : `Calling ${toolName}: ${file}`)
                : (isZh ? `正在调用 ${toolName}` : `Calling ${toolName}`);
        } else if (type === 'tool_result') {
            toolResultCount++;
            const result = step.toolResult as Record<string, unknown> | undefined;
            if (result?.success === false || result?.error) {
                failedToolCount++;
                const msg = String(result?.message || result?.error || (isZh ? `${step.toolName || '工具'} 执行失败` : `${step.toolName || 'tool'} failed`));
                alerts.push(msg);
            }
            latestStatus = result?.success === false || result?.error
                ? (isZh ? `${step.toolName || '工具'} 返回问题` : `${step.toolName || 'Tool'} returned an issue`)
                : (isZh ? `${step.toolName || '工具'} 已返回` : `${step.toolName || 'Tool'} returned`);
        } else if (type === 'validation') {
            validationCount++;
            if (step.content) validations.push(String(step.content));
        } else if (type === 'error') {
            errorCount++;
            if (step.content) alerts.push(String(step.content));
        } else if (type === 'orchestrator_progress' || type === 'subtask_start' || type === 'subtask_complete') {
            orchestratorCount++;
        }
        if (step?.content && ['error', 'validation', 'orchestrator_progress', 'subtask_complete'].includes(type)) {
            latestStatus = String(step.content).replace(/\$\(([\w-]+)\)/g, '').trim() || latestStatus;
        }
    }

    return {
        startedAt,
        endedAt,
        durationMs: startedAt && endedAt ? Math.max(0, endedAt - startedAt) : 0,
        totalSteps: all.length,
        thinkingCount,
        toolCallCount,
        toolResultCount,
        writeCount,
        readCount,
        validationCount,
        orchestratorCount,
        errorCount,
        failedToolCount,
        changedFiles: Array.from(files).slice(0, 8),
        topTools: Array.from(toolCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([name, count]) => ({ name, count })),
        latestStatus,
        hasOrchestrator: orchestratorCount > 0 || all.some(s => !!s.agentId),
        alerts: alerts.slice(0, 3),
        validations: validations.slice(0, 3),
    };
}
