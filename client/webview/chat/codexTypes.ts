import type { ChatI18nText, ChatLocale } from './i18n';

export type CodexActivityStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'waiting';

export type CodexActivityKind =
    | 'thinking'
    | 'tool'
    | 'command'
    | 'file'
    | 'validation'
    | 'permission'
    | 'context'
    | 'subagent'
    | 'artifact'
    | 'message';

export type CodexGroupKind = 'command' | 'read' | 'subagent' | 'thinking' | 'tool';

export interface CodexCommandDetail {
    command?: string;
    cwd?: string;
    exitCode?: number | string;
    stdout?: string;
    stderr?: string;
    output?: string;
    preflight?: unknown;
    riskLevel?: string;
    resultRef?: string;
}

export interface CodexActivityDetail {
    args?: unknown;
    result?: unknown;
    preview?: string;
    command?: CodexCommandDetail;
    targetPath?: string;
    statusText?: string;
}

export interface CodexActivityEvent {
    id: string;
    kind: CodexActivityKind;
    status: CodexActivityStatus;
    label: string;
    subject?: string;
    detail?: string;
    timestamp: number;
    durationMs?: number;
    toolName?: string;
    invocationId?: string;
    agentId?: string;
    groupKind?: CodexGroupKind;
    sourceStep?: unknown;
    sourceEvent?: unknown;
    detailModel?: CodexActivityDetail;
}

export interface CodexActivityGroup {
    id: string;
    kind: CodexGroupKind;
    status: CodexActivityStatus;
    label: string;
    subject?: string;
    timestamp: number;
    durationMs?: number;
    events: CodexActivityEvent[];
}

export interface CodexTextSegment {
    id: string;
    content: string;
    timestamp: number;
    source: 'text_delta' | 'message' | 'auto';
}

export type CodexTurnItem =
    | { type: 'activity'; event: CodexActivityEvent }
    | { type: 'group'; group: CodexActivityGroup }
    | { type: 'text'; text: CodexTextSegment };

export interface CodexTurnSummary {
    status: 'running' | 'complete' | 'failed' | 'blocked';
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    label: string;
    toolCount: number;
    commandCount: number;
    readCount: number;
    writeCount: number;
    validationCount: number;
    issueCount: number;
}

export interface CodexTurnModel {
    summary: CodexTurnSummary;
    items: CodexTurnItem[];
    finalText: string;
    streamedText: string;
}

export type CodexI18nText = ChatI18nText['codex'];

export interface CodexBuildOptions {
    locale: ChatLocale;
    labels: CodexI18nText;
    live?: boolean;
    fallbackStatus?: string;
}
