import {
    fileBaseName,
    formatDuration,
    READ_TOOL_NAMES,
    VALIDATION_TOOL_NAMES,
    WRITE_TOOL_NAMES,
} from './formatters';
import type {
    CodexActivityEvent,
    CodexActivityGroup,
    CodexActivityStatus,
    CodexBuildOptions,
    CodexCommandDetail,
    CodexGroupKind,
    CodexI18nText,
    CodexTextSegment,
    CodexTurnItem,
    CodexTurnModel,
    CodexTurnSummary,
} from './codexTypes';

const COMMAND_TOOL_NAMES = new Set(['run_command', 'shell_command']);
const WRITE_LIKE_TOOL_NAMES = new Set([
    ...WRITE_TOOL_NAMES,
    'edit_file',
    'write_file',
    'write_localisation',
    'replace_lines',
    'multi_replace_file_content',
    'ast_mutate',
]);
const READ_LIKE_TOOL_NAMES = new Set([
    ...READ_TOOL_NAMES,
    'read_file',
    'open_file',
    'list_directory',
    'rg',
    'grep',
    'codegraph_explore',
]);

type StepLike = Record<string, unknown>;

function asString(value: unknown): string {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatCount(template: string, count: number): string {
    return template.replace('{count}', String(count));
}

function timestampOf(step: StepLike, fallback: number): number {
    const value = Number(step.timestamp || 0);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function invocationIdOf(step: StepLike): string | undefined {
    return asString(step.invocationId || step.toolCallId || step.callId || step.id) || undefined;
}

function commandFromArgs(args: Record<string, unknown>, step?: StepLike): string {
    return asString(args.command || args.cmd || args.script || step?.content).trim();
}

function queryFromArgs(args: Record<string, unknown>): string {
    return asString(args.query || args.q || args.pattern || args.symbol || args.search || args.path).trim();
}

function targetPathFromArgs(args: Record<string, unknown>): string {
    return asString(args.filePath || args.file || args.path || args.directory || args.targetPath || args.uri).trim();
}

function getResultObject(step: StepLike): Record<string, unknown> {
    return asRecord(step.toolResult || step.result);
}

function resultFailed(result: Record<string, unknown>): boolean {
    return result.success === false || !!result.error || !!result.stderr && result.exitCode !== 0;
}

function resultSkipped(result: Record<string, unknown>): boolean {
    return result.skipped === true || result.status === 'skipped';
}

function statusFromResult(result: Record<string, unknown>): CodexActivityStatus {
    if (resultSkipped(result)) return 'skipped';
    if (resultFailed(result)) return 'failed';
    return 'success';
}

function compactPreview(value: unknown, max = 220): string {
    if (value == null) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return '';
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > max ? normalized.slice(0, max - 3) + '...' : normalized;
}

function resultSummary(result: Record<string, unknown>, isCommand: boolean): string {
    if (isCommand) {
        const exitCode = result.exitCode ?? result.exit_code ?? result.code;
        if (exitCode !== undefined && exitCode !== null && String(exitCode) !== '0') return `exit ${exitCode}`;
        if (result.success === false) return compactPreview(result.status || result.message || result.error);
        return compactPreview(result.status);
    }
    return compactPreview(result.status || result.message || result.error || result.preview);
}

function isInternalThinkingNote(content: string): boolean {
    const text = content.trim();
    return /^\[(?:Tool Arg Repair|Tool Name Repair|VLM Image|SYSTEM)\]/i.test(text)
        || /^Repaired tool name:/i.test(text)
        || /^Authorized execution continued automatically from .* after a premature final response\.?$/i.test(text);
}

function lastActivityKind(items: CodexTurnItem[]): CodexActivityEvent['kind'] | undefined {
    for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item?.type === 'activity') return item.event.kind;
        if (item?.type === 'group' && item.group.events.length) return item.group.events[item.group.events.length - 1]?.kind;
        if (item?.type === 'text' && item.text.content.trim()) return undefined;
    }
    return undefined;
}

function looksLikeMeasureObjectOutput(lines: string[]): boolean {
    const keys = new Set<string>();
    for (const line of lines.slice(0, 10)) {
        const match = /^\s*(Count|Average|Sum|Maximum|Minimum|Property)\s*:/i.exec(line);
        if (match) keys.add(match[1]!.toLowerCase());
    }
    return keys.has('count') && (keys.has('average') || keys.has('sum') || keys.has('property'));
}

function looksLikeFileCountOutput(lines: string[]): boolean {
    const matches = lines.filter(line => /^\s*[\w .-]+\.txt\s*:\s*\d+\s*$/i.test(line)).length;
    return matches >= 2;
}

function isLikelyCommandOutputText(content: string): boolean {
    const text = content.trim();
    if (!text) return false;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return false;
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    if (/Traceback \(most recent call last\)|Unicode(?:Encode|Decode)Error|SyntaxError|ReferenceError|TypeError/i.test(text)) return true;
    if (looksLikeMeasureObjectOutput(lines)) return true;
    if (looksLikeFileCountOutput(lines)) return true;
    return replacementCount >= 8 && lines.length >= 2;
}

function shouldSuppressTextSegment(content: string, items: CodexTurnItem[]): boolean {
    const text = content.trim();
    if (/^\[WARNING:\s*The result of tool .* was automatically truncated to 1000 characters/i.test(text)) {
        return true;
    }
    if (/^Tool stage advanced:\s*[^\n]+$/i.test(text)
        || /^工具阶段(?:已)?(?:从|由).*(?:推进|进入|切换)/.test(text)) {
        return true;
    }
    return lastActivityKind(items) === 'command' && isLikelyCommandOutputText(content);
}

function commandDetailFrom(args: Record<string, unknown>, result: Record<string, unknown>, step?: StepLike): CodexCommandDetail {
    return {
        command: commandFromArgs(args, step),
        cwd: asString(args.cwd || args.workdir || result.cwd || result.workingDirectory) || undefined,
        exitCode: (result.exitCode ?? result.exit_code ?? result.code) as number | string | undefined,
        stdout: asString(result.stdout) || undefined,
        stderr: asString(result.stderr) || undefined,
        output: asString(result.output || result.preview || result.message) || undefined,
        preflight: result.preflight || result.policy || result.classification,
        riskLevel: asString(result.riskLevel || result.risk) || undefined,
        resultRef: asString(result.resultRef || result.fullResultRef || result.outputRef || result.file) || undefined,
    };
}

function toolSubject(toolName: string, args: Record<string, unknown>, _step: StepLike): string {
    if (COMMAND_TOOL_NAMES.has(toolName)) return '';
    const target = targetPathFromArgs(args);
    if (target) return fileBaseName(target);
    const query = queryFromArgs(args);
    if (query) return query;
    if (toolName === 'codegraph_explore') return 'CodeGraph explore';
    return toolName;
}

function createToolEvent(step: StepLike, labels: CodexI18nText, index: number): CodexActivityEvent {
    const toolName = asString(step.toolName || step.name || 'tool');
    const args = asRecord(step.toolArgs || step.args);
    const targetPath = targetPathFromArgs(args);
    const timestamp = timestampOf(step, Date.now() + index);
    let kind: CodexActivityEvent['kind'] = 'tool';
    let label = labels.activity.tool;
    let groupKind: CodexGroupKind = 'tool';

    if (COMMAND_TOOL_NAMES.has(toolName)) {
        kind = 'command';
        label = labels.activity.ranCommand;
        groupKind = 'command';
    } else if (WRITE_LIKE_TOOL_NAMES.has(toolName)) {
        kind = 'file';
        label = toolName.includes('write') ? labels.activity.wroteFile : labels.activity.editedFile;
    } else if (READ_LIKE_TOOL_NAMES.has(toolName)) {
        kind = 'file';
        label = toolName === 'codegraph_explore' ? 'CodeGraph explore' : labels.activity.readFile;
        groupKind = 'read';
    } else if (VALIDATION_TOOL_NAMES.has(toolName)) {
        kind = 'validation';
        label = labels.activity.validation;
    }

    return {
        id: invocationIdOf(step) || `tool-${index}-${timestamp}`,
        kind,
        status: step.type === 'permission_request' ? 'waiting' : 'running',
        label: step.type === 'permission_request' ? labels.activity.waitingPermission : label,
        subject: toolSubject(toolName, args, step),
        timestamp,
        toolName,
        invocationId: invocationIdOf(step),
        agentId: asString(step.agentId) || undefined,
        groupKind,
        sourceStep: step,
        detailModel: {
            args,
            targetPath: targetPath || undefined,
            command: COMMAND_TOOL_NAMES.has(toolName) ? commandDetailFrom(args, {}, step) : undefined,
        },
    };
}

function applyToolResult(event: CodexActivityEvent, resultStep: StepLike): void {
    const result = getResultObject(resultStep);
    const args = asRecord((event.detailModel?.args as Record<string, unknown>) || {});
    const isCommand = COMMAND_TOOL_NAMES.has(event.toolName || '');
    event.status = statusFromResult(result);
    event.durationMs = Number(resultStep.durationMs || 0) || Math.max(0, timestampOf(resultStep, event.timestamp) - event.timestamp);
    event.detail = resultSummary(result, isCommand);
    event.sourceStep = event.sourceStep || resultStep;
    event.detailModel = {
        ...event.detailModel,
        result,
        preview: compactPreview(result.preview || result.message || result.error || result.output),
        command: isCommand ? commandDetailFrom(args, result, event.sourceStep as StepLike) : event.detailModel?.command,
        statusText: asString(result.status || result.message || result.error) || undefined,
    };
}

function createStandaloneResult(step: StepLike, labels: CodexI18nText, index: number): CodexActivityEvent {
    const event = createToolEvent({ ...step, type: 'tool_call' }, labels, index);
    applyToolResult(event, step);
    return event;
}

function createSpecialEvent(step: StepLike, labels: CodexI18nText, index: number): CodexActivityEvent | undefined {
    const type = asString(step.type);
    const timestamp = timestampOf(step, Date.now() + index);
    const content = asString(step.content);
    if (type === 'validation') {
        return {
            id: `validation-${index}-${timestamp}`,
            kind: 'validation',
            status: /fail|error|失败|错误/i.test(content) ? 'failed' : 'success',
            label: labels.activity.validation,
            subject: content,
            timestamp,
            sourceStep: step,
            groupKind: 'tool',
            detailModel: { preview: content },
        };
    }
    if (type === 'error') {
        return {
            id: `error-${index}-${timestamp}`,
            kind: 'tool',
            status: 'failed',
            label: labels.status.issues,
            subject: content,
            timestamp,
            sourceStep: step,
            detailModel: { preview: content },
        };
    }
    if (type === 'compaction') {
        const info = asRecord(step.compactionInfo);
        const state = asString(info.state);
        return {
            id: `compaction-${index}-${timestamp}`,
            kind: 'context',
            status: state === 'failed' ? 'failed' : state === 'start' ? 'running' : 'success',
            label: labels.activity.contextCompaction,
            subject: content,
            timestamp,
            sourceStep: step,
            detailModel: { result: info, preview: content },
        };
    }
    if (type === 'orchestrator_progress' || type === 'subtask_start' || type === 'subtask_complete') {
        return {
            id: `subagent-${index}-${timestamp}`,
            kind: 'subagent',
            status: type === 'subtask_complete' ? 'success' : 'running',
            label: labels.activity.subtask,
            subject: content,
            timestamp,
            agentId: asString(step.agentId) || undefined,
            groupKind: 'subagent',
            sourceStep: step,
            detailModel: { preview: content },
        };
    }
    if (type === 'permission_request') {
        return createToolEvent(step, labels, index);
    }
    if (type === 'write_confirmation_request' || type === 'pending_write') {
        const args = asRecord(step.toolArgs || step.args);
        const targetPath = targetPathFromArgs(args) || content;
        return {
            id: invocationIdOf(step) || `write-confirm-${index}-${timestamp}`,
            kind: 'file',
            status: 'waiting',
            label: labels.activity.waitingWrite,
            subject: targetPath ? fileBaseName(targetPath) : undefined,
            detail: targetPath || undefined,
            timestamp,
            toolName: asString(step.toolName || 'write_file'),
            invocationId: invocationIdOf(step),
            groupKind: 'tool',
            sourceStep: step,
            detailModel: {
                args,
                targetPath: targetPath || undefined,
                result: step.toolResult || step.result,
                statusText: labels.activity.waitingWrite,
            },
        };
    }
    if (type.endsWith('_card') || type === 'artifact_created') {
        return {
            id: `artifact-${index}-${timestamp}`,
            kind: 'artifact',
            status: 'success',
            label: labels.activity.artifact,
            subject: content,
            timestamp,
            sourceStep: step,
            detailModel: { result: step.toolResult || step.result, preview: content },
        };
    }
    return undefined;
}

function groupStatus(events: CodexActivityEvent[]): CodexActivityStatus {
    if (events.some(e => e.status === 'failed')) return 'failed';
    if (events.some(e => e.status === 'waiting')) return 'waiting';
    if (events.some(e => e.status === 'running' || e.status === 'pending')) return 'running';
    if (events.every(e => e.status === 'skipped')) return 'skipped';
    return 'success';
}

function labelForGroup(kind: CodexGroupKind, count: number, labels: CodexI18nText): string {
    if (kind === 'command') return count === 1 ? labels.activity.ranCommand : formatCount(labels.activity.ranCommands, count);
    if (kind === 'read') return count === 1 ? labels.activity.readFile : formatCount(labels.activity.readFiles, count);
    if (kind === 'subagent') return `${count} ${labels.activity.subtask}`;
    if (kind === 'thinking') return count === 1 ? labels.activity.thinking : `${labels.activity.thinking} (${count})`;
    if (kind === 'steps') return formatCount(labels.activity.stepsCount, count);
    return formatCount(labels.activity.toolCallsCount, count);
}

function itemTimestamp(item: CodexTurnItem): number {
    if (item.type === 'group') return item.group.timestamp;
    if (item.type === 'activity') return item.event.timestamp;
    return item.text.timestamp;
}

function itemProgressText(item: CodexTurnItem, labels: CodexI18nText): string {
    const progress = labels.progress;
    if (item.type === 'group') {
        if (item.group.kind === 'thinking') return progress.thinking;
        if (item.group.kind === 'command') return progress.command;
        if (item.group.kind === 'read') return progress.read;
        if (item.group.events.some(event => event.kind === 'validation')) return progress.validation;
        if (item.group.kind === 'steps') {
            const first = item.group.events[0];
            if (first) return itemProgressText({ type: 'activity', event: first }, labels);
            return progress.working;
        }
        return item.group.kind === 'tool' || item.group.kind === 'subagent'
            ? progress.tool
            : progress.working;
    }
    if (item.type === 'activity') {
        if (item.event.kind === 'thinking' || item.event.groupKind === 'thinking') return progress.thinking;
        if (item.event.kind === 'command' || item.event.groupKind === 'command') return progress.command;
        if (item.event.groupKind === 'read') return progress.read;
        if (item.event.kind === 'validation') return progress.validation;
        return item.event.kind === 'tool' || item.event.kind === 'file' || item.event.kind === 'subagent'
            ? progress.tool
            : progress.working;
    }
    return progress.working;
}

function isActivityLikeItem(item: CodexTurnItem): boolean {
    if (item.type === 'group') return true;
    if (item.type === 'activity') return item.event.kind !== 'permission';
    return false;
}

function isGenericProcessText(content: string): boolean {
    const text = content.trim().replace(/\s+/g, ' ');
    if (!text) return false;
    return /^(?:Analyzing request|Analyzing|Processing request|Processing utility engineering task|Reviewing code|Exploring codebase|Coordinating multi-agent work|Running (?:Script mode|Paradox Multi-Agent) pipeline)\.{0,3}$/i.test(text)
        || /^(?:I am checking the result before answering|I am checking the request and gathering the context I need)\.{0,3}$/i.test(text)
        || /^(?:我正在检查结果后再回复|我正在分析需求，并收集需要的上下文)\.{0,3}$/.test(text)
        || /^(?:分析需求中|分析中|探索代码库中|处理请求中|处理泛用工程任务中|代码审查中|多 Agent 协调中|脚本模式运行中|Paradox 多 Agent 流水线运行中)(?:（动态流水线并行）)?\.{0,3}$/.test(text);
}

function hasUsefulProcessTextImmediatelyBefore(items: CodexTurnItem[]): boolean {
    const previous = items[items.length - 1];
    return previous?.type === 'text'
        && previous.text.content.trim().length > 0
        && !isGenericProcessText(previous.text.content);
}

function injectAutoProcessText(items: CodexTurnItem[], labels: CodexI18nText): CodexTurnItem[] {
    const output: CodexTurnItem[] = [];
    let hasProcessNarrative = false;
    for (const item of items) {
        if (isActivityLikeItem(item) && !hasProcessNarrative && !hasUsefulProcessTextImmediatelyBefore(output)) {
            const timestamp = itemTimestamp(item);
            output.push({
                type: 'text',
                text: {
                    id: `auto-progress-${timestamp}-${output.length}`,
                    content: itemProgressText(item, labels),
                    timestamp: Math.max(0, timestamp - 1),
                    source: 'auto',
                },
            });
            hasProcessNarrative = true;
        }
        output.push(item);
        if (item.type === 'text' && item.text.content.trim()) {
            hasProcessNarrative = true;
        }
    }
    return output;
}

function shouldGroup(kind: CodexGroupKind, count: number): boolean {
    void kind;
    return count >= 1;
}

function groupTurnItems(items: CodexTurnItem[], labels: CodexI18nText): CodexTurnItem[] {
    const output: CodexTurnItem[] = [];
    let pending: CodexActivityEvent[] = [];

    const flush = () => {
        if (!pending.length) return;
        // Consecutive activity rows between text segments collapse into one group,
        // even when their kinds differ (thinking, reads, edits, commands, tools).
        const kinds = new Set(pending.map(event => event.groupKind));
        const pendingKind: CodexGroupKind = kinds.size === 1 ? pending[0]!.groupKind! : 'steps';
        if (shouldGroup(pendingKind, pending.length)) {
            const startedAt = pending[0]!.timestamp;
            const endedAt = Math.max(...pending.map(event => event.timestamp + (event.durationMs || 0)));
            const group: CodexActivityGroup = {
                // Keep the identity stable while a live group grows or changes from a
                // single-kind group into a mixed "steps" group.
                id: `group-${startedAt}-${pending.length}`,
                kind: pendingKind,
                status: groupStatus(pending),
                label: labelForGroup(pendingKind, pending.length, labels),
                timestamp: startedAt,
                durationMs: Math.max(0, endedAt - startedAt),
                events: pending,
            };
            output.push({ type: 'group', group });
        } else {
            for (const event of pending) output.push({ type: 'activity', event });
        }
        pending = [];
    };

    for (const item of items) {
        if (item.type !== 'activity' || !item.event.groupKind) {
            flush();
            output.push(item);
            continue;
        }
        pending.push(item.event);
    }
    flush();
    return output;
}

function summarize(items: CodexTurnItem[], finalText: string, options: CodexBuildOptions): CodexTurnSummary {
    const events = items.flatMap(item => item.type === 'activity' ? [item.event] : item.type === 'group' ? item.group.events : []);
    const timestamps = [
        ...events.map(event => event.timestamp),
        ...items.filter((item): item is { type: 'text'; text: CodexTextSegment } => item.type === 'text').map(item => item.text.timestamp),
    ].filter(value => Number.isFinite(value) && value > 0);
    const startedAt = timestamps.length ? Math.min(...timestamps) : undefined;
    const completedAt = timestamps.length ? Math.max(...timestamps) : undefined;
    const issueCount = events.filter(event => event.status === 'failed').length;
    const running = options.live || events.some(event => event.status === 'running' || event.status === 'waiting' || event.status === 'pending');
    const status: CodexTurnSummary['status'] = issueCount > 0 ? 'failed' : running ? 'running' : 'complete';
    const durationMs = startedAt && completedAt ? Math.max(0, completedAt - startedAt) : 0;
    const durationLabel = durationMs > 0 ? formatDuration(durationMs) : (running ? '' : options.labels.status.shortTask);
    const base = status === 'running'
        ? options.labels.status.processing
        : status === 'failed'
            ? options.labels.status.processed
            : options.labels.status.processed;
    const label = durationLabel
        ? `${base} ${durationLabel}`
        : status === 'running'
            ? base
            : `${base}${finalText ? '' : ` ${options.labels.status.preparing}`}`;
    return {
        status,
        startedAt,
        completedAt,
        durationMs,
        label,
        toolCount: events.filter(event => event.kind === 'tool' || event.kind === 'command' || event.kind === 'file').length,
        commandCount: events.filter(event => event.kind === 'command').length,
        readCount: events.filter(event => event.groupKind === 'read').length,
        writeCount: events.filter(event => event.kind === 'file' && event.groupKind !== 'read').length,
        validationCount: events.filter(event => event.kind === 'validation').length,
        issueCount,
    };
}

export function buildCodexTurnModel(content: string, steps: StepLike[] | undefined, options: CodexBuildOptions): CodexTurnModel {
    const labels = options.labels;
    const sorted = [...(steps || [])].sort((a, b) => timestampOf(a, 0) - timestampOf(b, 0));
    const rawItems: CodexTurnItem[] = [];
    const pendingByInvocation = new Map<string, CodexActivityEvent>();
    const pendingByTool = new Map<string, CodexActivityEvent[]>();
    let textBuffer = '';
    let textStartedAt = 0;
    let streamedText = '';
    let thinkingBuffer = '';
    let thinkingStartedAt = 0;
    let thinkingLastAt = 0;
    let thinkingSourceStep: StepLike | undefined;
    let processTextBuffer = '';
    let processTextStartedAt = 0;
    let lastStreamingType: 'text' | 'thinking' | undefined;

    const flushText = () => {
        if (!textBuffer.trim()) {
            textBuffer = '';
            textStartedAt = 0;
            return;
        }
        if (shouldSuppressTextSegment(textBuffer, rawItems)) {
            textBuffer = '';
            textStartedAt = 0;
            return;
        }
        rawItems.push({
            type: 'text',
            text: {
                id: `text-${textStartedAt}-${rawItems.length}`,
                content: textBuffer,
                timestamp: textStartedAt || Date.now(),
                source: 'text_delta',
            },
        });
        streamedText += textBuffer;
        textBuffer = '';
        textStartedAt = 0;
    };

    const flushProcessText = () => {
        if (!processTextBuffer.trim()) {
            processTextBuffer = '';
            processTextStartedAt = 0;
            return;
        }
        if (shouldSuppressTextSegment(processTextBuffer, rawItems)) {
            processTextBuffer = '';
            processTextStartedAt = 0;
            return;
        }
        rawItems.push({
            type: 'text',
            text: {
                id: `message-${processTextStartedAt}-${rawItems.length}`,
                content: processTextBuffer,
                timestamp: processTextStartedAt || Date.now(),
                source: 'message',
            },
        });
        processTextBuffer = '';
        processTextStartedAt = 0;
    };

    const flushThinking = (stillStreaming = false) => {
        const content = thinkingBuffer.trim();
        if (content && !shouldSuppressTextSegment(content, rawItems) && !isInternalThinkingNote(content)) {
            rawItems.push({
                type: 'activity',
                event: {
                    id: `thinking-${thinkingStartedAt || Date.now()}-${rawItems.length}`,
                    kind: 'thinking',
                    status: options.live && stillStreaming ? 'running' : 'success',
                    label: labels.activity.thinking,
                    timestamp: thinkingStartedAt || Date.now(),
                    durationMs: thinkingLastAt && thinkingStartedAt ? Math.max(0, thinkingLastAt - thinkingStartedAt) : undefined,
                    groupKind: 'thinking',
                    sourceStep: thinkingSourceStep,
                    detailModel: {
                        preview: content,
                        statusText: options.live && stillStreaming ? labels.status.processing : labels.status.processed,
                    },
                },
            });
        }
        thinkingBuffer = '';
        thinkingStartedAt = 0;
        thinkingLastAt = 0;
        thinkingSourceStep = undefined;
    };

    const flushStreaming = (stillThinking = false) => {
        const thinkingFirst = thinkingStartedAt > 0
            && (textStartedAt === 0 || thinkingStartedAt <= textStartedAt);
        if (thinkingFirst) {
            flushThinking(stillThinking);
            flushText();
        } else {
            flushText();
            flushThinking(stillThinking);
        }
        lastStreamingType = undefined;
    };

    const rememberPending = (event: CodexActivityEvent) => {
        if (event.invocationId) pendingByInvocation.set(event.invocationId, event);
        const key = event.toolName || '';
        if (!key) return;
        const list = pendingByTool.get(key) || [];
        list.push(event);
        pendingByTool.set(key, list);
    };

    const takePending = (step: StepLike): CodexActivityEvent | undefined => {
        const invocationId = invocationIdOf(step);
        if (invocationId) {
            const match = pendingByInvocation.get(invocationId);
            if (match) {
                pendingByInvocation.delete(invocationId);
                const list = pendingByTool.get(match.toolName || '') || [];
                pendingByTool.set(match.toolName || '', list.filter(item => item !== match));
                return match;
            }
        }
        const toolName = asString(step.toolName || step.name || 'tool');
        const list = pendingByTool.get(toolName) || [];
        const match = list.shift();
        pendingByTool.set(toolName, list);
        return match;
    };

    sorted.forEach((step, index) => {
        const type = asString(step.type);
        if (type === 'text_delta') {
            flushProcessText();
            const ts = timestampOf(step, Date.now() + index);
            if (!textBuffer) textStartedAt = ts;
            textBuffer += asString(step.content);
            lastStreamingType = 'text';
            return;
        }
        if (type === 'thinking_content') {
            flushProcessText();
            const ts = timestampOf(step, Date.now() + index);
            if (!thinkingBuffer) {
                thinkingStartedAt = ts;
                thinkingSourceStep = step;
            }
            thinkingLastAt = ts;
            thinkingBuffer += asString(step.content);
            lastStreamingType = 'thinking';
            return;
        }
        if (type === 'thinking') {
            flushStreaming();
            const ts = timestampOf(step, Date.now() + index);
            const content = asString(step.content);
            if (content && !isInternalThinkingNote(content)) {
                if (!processTextBuffer) processTextStartedAt = ts;
                processTextBuffer += content;
            }
            return;
        }
        if (type === 'cache_stats') {
            flushStreaming();
            flushProcessText();
            return;
        }
        flushStreaming();
        flushProcessText();

        if (type === 'permission_request') {
            return;
        }
        if (type === 'tool_call') {
            const event = createToolEvent(step, labels, index);
            rawItems.push({ type: 'activity', event });
            rememberPending(event);
            return;
        }
        if (type === 'tool_result') {
            const event = takePending(step);
            if (event) {
                applyToolResult(event, step);
            } else {
                rawItems.push({ type: 'activity', event: createStandaloneResult(step, labels, index) });
            }
            return;
        }
        const special = createSpecialEvent(step, labels, index);
        if (special) rawItems.push({ type: 'activity', event: special });
        else {
            const content = asString(step.content);
            if (content) {
                rawItems.push({
                    type: 'text',
                    text: {
                        id: `message-${timestampOf(step, Date.now() + index)}-${rawItems.length}`,
                        content,
                        timestamp: timestampOf(step, Date.now() + index),
                        source: 'message',
                    },
                });
            }
        }
    });
    flushStreaming(options.live && lastStreamingType === 'thinking');
    flushProcessText();

    let finalText = (content || '').trim();
    const normalizedStream = streamedText.trim();
    if (normalizedStream && finalText) {
        if (finalText === normalizedStream) finalText = '';
        else if (finalText.startsWith(normalizedStream)) finalText = finalText.slice(normalizedStream.length).trim();
    }

    const items = injectAutoProcessText(groupTurnItems(rawItems, labels), labels);
    return {
        summary: summarize(items, finalText, options),
        items,
        finalText,
        streamedText: normalizedStream,
    };
}
