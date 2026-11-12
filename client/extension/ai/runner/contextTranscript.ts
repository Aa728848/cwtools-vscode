import type { ChatMessage, ToolCall } from '../types';

export interface TranscriptIntegrity {
    valid: boolean;
    missingToolResultIds: string[];
    orphanToolResultIds: string[];
    duplicateToolCallIds: string[];
    duplicateToolResultIds: string[];
}

export interface CompactionTranscriptSplit {
    persistentSystemMessages: ChatMessage[];
    olderMessages: ChatMessage[];
    recentMessages: ChatMessage[];
}

export interface ResumeTranscriptSelection {
    persistentSystemMessages: ChatMessage[];
    recentMessages: ChatMessage[];
}

export function cloneChatMessage(message: ChatMessage): ChatMessage {
    return {
        ...message,
        content: Array.isArray(message.content)
            ? message.content.map(part => part.type === 'image_url'
                ? { ...part, image_url: { ...part.image_url } }
                : { ...part })
            : message.content,
        tool_calls: message.tool_calls?.map(call => ({
            ...call,
            function: { ...call.function },
        })),
        responses_output_items: message.responses_output_items
            ? JSON.parse(JSON.stringify(message.responses_output_items)) as Array<Record<string, unknown>>
            : undefined,
        anthropic_thinking_blocks: message.anthropic_thinking_blocks
            ? JSON.parse(JSON.stringify(message.anthropic_thinking_blocks)) as Array<Record<string, unknown>>
            : undefined,
    };
}

function interruptedToolResult(call: ToolCall): ChatMessage {
    return {
        role: 'tool',
        content: JSON.stringify({
            success: false,
            interrupted: true,
            error: `Tool '${call.function.name}' did not return before the previous run stopped. Re-read current state before retrying.`,
        }),
        tool_call_id: call.id,
        name: call.function.name,
    };
}

/**
 * Produce a provider-safe canonical transcript. Tool call groups are closed
 * before any non-tool message, duplicate call/results are removed, and orphan
 * tool responses are omitted because OpenAI-compatible providers reject them.
 */
export function normalizeTranscriptForPersistence(messages: ChatMessage[]): ChatMessage[] {
    const output: ChatMessage[] = [];
    const pending = new Map<string, ToolCall>();
    const seenCallIds = new Set<string>();
    const seenResultIds = new Set<string>();

    const flushPending = () => {
        for (const call of pending.values()) output.push(interruptedToolResult(call));
        pending.clear();
    };

    for (const source of messages) {
        const message = cloneChatMessage(source);

        if (message.role === 'tool') {
            const callId = message.tool_call_id;
            if (!callId || !pending.has(callId) || seenResultIds.has(callId)) continue;
            output.push(message);
            pending.delete(callId);
            seenResultIds.add(callId);
            continue;
        }

        flushPending();

        if (message.role === 'assistant' && message.tool_calls?.length) {
            const uniqueCalls: ToolCall[] = [];
            for (const call of message.tool_calls) {
                if (!call.id || seenCallIds.has(call.id)) continue;
                seenCallIds.add(call.id);
                uniqueCalls.push(call);
                pending.set(call.id, call);
            }
            message.tool_calls = uniqueCalls.length > 0 ? uniqueCalls : undefined;
        }

        output.push(message);
    }

    flushPending();
    return output;
}

export function inspectTranscriptIntegrity(messages: ChatMessage[]): TranscriptIntegrity {
    const pending = new Set<string>();
    const seenCalls = new Set<string>();
    const seenResults = new Set<string>();
    const missingToolResultIds: string[] = [];
    const orphanToolResultIds: string[] = [];
    const duplicateToolCallIds: string[] = [];
    const duplicateToolResultIds: string[] = [];

    const closePending = () => {
        missingToolResultIds.push(...pending);
        pending.clear();
    };

    for (const message of messages) {
        if (message.role === 'tool') {
            const id = message.tool_call_id ?? '';
            if (!id || !pending.has(id)) {
                if (id && seenResults.has(id)) duplicateToolResultIds.push(id);
                else orphanToolResultIds.push(id || '<missing-id>');
            } else {
                pending.delete(id);
                seenResults.add(id);
            }
            continue;
        }

        closePending();
        if (message.role === 'assistant') {
            for (const call of message.tool_calls ?? []) {
                if (seenCalls.has(call.id)) duplicateToolCallIds.push(call.id);
                else {
                    seenCalls.add(call.id);
                    pending.add(call.id);
                }
            }
        }
    }
    closePending();

    return {
        valid: missingToolResultIds.length === 0
            && orphanToolResultIds.length === 0
            && duplicateToolCallIds.length === 0
            && duplicateToolResultIds.length === 0,
        missingToolResultIds,
        orphanToolResultIds,
        duplicateToolCallIds,
        duplicateToolResultIds,
    };
}

/** Select a bounded tail without splitting an assistant tool-call/result group. */
export function selectProviderSafeTail(messages: ChatMessage[], tailLimit: number): ChatMessage[] {
    const normalized = normalizeTranscriptForPersistence(messages);
    if (normalized.length <= tailLimit) return normalized.map(cloneChatMessage);

    let start = Math.max(0, normalized.length - Math.max(1, tailLimit));
    while (start > 0 && normalized[start]?.role === 'tool') start--;
    if (
        start > 0
        && normalized[start]?.role === 'assistant'
        && String(normalized[start]?.content).includes('## Conversation Summary (compacted)')
        && normalized[start - 1]?.role === 'user'
        && String(normalized[start - 1]?.content).includes('[Context Recovery]')
    ) {
        start--;
    }
    return normalized.slice(start).map(cloneChatMessage);
}

function isCompactionSummarySystemMessage(message: ChatMessage): boolean {
    return message.role === 'system'
        && String(message.content ?? '').includes('## Conversation Summary (compacted)');
}

function splitPersistentSystemPrefix(messages: ChatMessage[], preserveCompactionSummary = false): {
    persistentSystemMessages: ChatMessage[];
    workingMessages: ChatMessage[];
} {
    let systemEnd = 0;
    while (
        systemEnd < messages.length
        && messages[systemEnd]?.role === 'system'
        && (preserveCompactionSummary || !isCompactionSummarySystemMessage(messages[systemEnd]!))
    ) {
        systemEnd++;
    }
    return {
        persistentSystemMessages: messages.slice(0, systemEnd).map(cloneChatMessage),
        workingMessages: messages.slice(systemEnd),
    };
}

/** Select resume context without discarding an existing rolling-summary pair. */
export function selectTranscriptForResume(
    messages: ChatMessage[],
    tailLimit: number,
): ResumeTranscriptSelection {
    const normalized = normalizeTranscriptForPersistence(messages);
    const split = splitPersistentSystemPrefix(normalized, true);
    return {
        persistentSystemMessages: split.persistentSystemMessages,
        recentMessages: selectProviderSafeTail(split.workingMessages, tailLimit),
    };
}

/**
 * Split canonical history for compaction while keeping stable system
 * instructions outside the summarized/replaced history.
 */
export function splitTranscriptForCompaction(
    messages: ChatMessage[],
    keepRecentMessages: number,
): CompactionTranscriptSplit {
    const normalized = normalizeTranscriptForPersistence(messages);
    const prefix = splitPersistentSystemPrefix(normalized);
    const persistentSystemMessages = prefix.persistentSystemMessages;
    const working = prefix.workingMessages;
    const initialRecent = selectProviderSafeTail(working, keepRecentMessages);
    let splitIndex = Math.max(0, working.length - initialRecent.length);

    // A rolling recovery summary is an atomic pair, but unlike a tool group it
    // belongs on the older side so the compactor can replace it instead of
    // carrying the stale summary into the retained tail.
    const current = working[splitIndex];
    const previous = working[splitIndex - 1];
    if (
        current?.role === 'user'
        && String(current.content).includes('[Context Recovery]')
        && working[splitIndex + 1]?.role === 'assistant'
        && String(working[splitIndex + 1]?.content).includes('## Conversation Summary (compacted)')
    ) {
        splitIndex = Math.min(working.length, splitIndex + 2);
    } else if (
        current?.role === 'assistant'
        && String(current.content).includes('## Conversation Summary (compacted)')
        && previous?.role === 'user'
        && String(previous.content).includes('[Context Recovery]')
    ) {
        splitIndex = Math.min(working.length, splitIndex + 1);
    }

    return {
        persistentSystemMessages,
        olderMessages: working.slice(0, splitIndex).map(cloneChatMessage),
        recentMessages: working.slice(splitIndex).map(cloneChatMessage),
    };
}
