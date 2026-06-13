import * as fs from 'fs';
import * as pathModule from 'path';
import { getProjectWorkspaceRoot, getTopicStorageDir, getTopicStorageDirCandidates } from '../workspacePaths';
import type { AgentResumeState, ChatMessage, AgentMode } from '../types';
import type { AgentToolExecutor } from '../agentTools';
import { PermissionPolicyStore } from './permissionPolicy';

export const RESUME_TAIL_MESSAGE_LIMIT = 24;
const RESUME_SUMMARY_CHAR_LIMIT = 12000;

function cloneChatMessage(message: ChatMessage): ChatMessage {
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
    };
}

/**
 * Return a provider-safe resume transcript.
 *
 * OpenAI-compatible APIs reject an assistant message that contains tool_calls
 * unless every tool call is followed by a matching tool response. A crash or
 * abort can happen after the assistant tool_calls are appended but before the
 * tool results are recorded. Fill those gaps with explicit interrupted tool
 * results so the next run can continue from the latest transcript instead of
 * failing before the model sees the recovery context.
 */
export function prepareMessagesForResume(messages: ChatMessage[]): ChatMessage[] {
    const normalized = messages.map(cloneChatMessage);

    for (let i = 0; i < normalized.length; i++) {
        const message = normalized[i];
        const toolCalls = message?.role === 'assistant' ? message.tool_calls : undefined;
        if (!toolCalls || toolCalls.length === 0) continue;

        let cursor = i + 1;
        const answeredCallIds = new Set<string>();
        while (cursor < normalized.length && normalized[cursor]?.role === 'tool') {
            const toolCallId = normalized[cursor]?.tool_call_id;
            if (toolCallId) answeredCallIds.add(toolCallId);
            cursor++;
        }

        const missingResults = toolCalls
            .filter(call => !answeredCallIds.has(call.id))
            .map(call => ({
                role: 'tool' as const,
                content: JSON.stringify({
                    success: false,
                    interrupted: true,
                    error: `Tool '${call.function.name}' did not return before the previous run stopped. Re-read current state before retrying.`,
                }),
                tool_call_id: call.id,
                name: call.function.name,
            }));

        if (missingResults.length > 0) {
            normalized.splice(cursor, 0, ...missingResults);
            i = cursor + missingResults.length - 1;
        }
    }

    return normalized;
}

function findLatestSummaryRef(resumeDir: string, runId?: string): string | undefined {
    if (runId) {
        const currentSummary = pathModule.join(resumeDir, 'runs', runId, 'summary.md');
        if (fs.existsSync(currentSummary)) return currentSummary;
        const currentJson = pathModule.join(resumeDir, 'runs', runId, 'summary.json');
        if (fs.existsSync(currentJson)) return currentJson;
    }

    const runsDir = pathModule.join(resumeDir, 'runs');
    if (!fs.existsSync(runsDir)) return undefined;
    try {
        return fs.readdirSync(runsDir)
            .map(name => {
                const summaryMd = pathModule.join(runsDir, name, 'summary.md');
                const summaryJson = pathModule.join(runsDir, name, 'summary.json');
                const summaryPath = fs.existsSync(summaryMd) ? summaryMd : fs.existsSync(summaryJson) ? summaryJson : undefined;
                if (!summaryPath) return undefined;
                return { summaryPath, time: fs.statSync(summaryPath).mtimeMs };
            })
            .filter((entry): entry is { summaryPath: string; time: number } => !!entry)
            .sort((a, b) => b.time - a.time)[0]?.summaryPath;
    } catch {
        return undefined;
    }
}

function readSummarySnippet(summaryRef?: string): string {
    if (!summaryRef || !fs.existsSync(summaryRef)) return '';
    try {
        const raw = fs.readFileSync(summaryRef, 'utf-8').trim();
        return raw.length > RESUME_SUMMARY_CHAR_LIMIT
            ? raw.slice(0, RESUME_SUMMARY_CHAR_LIMIT) + '\n\n[summary truncated for resume]'
            : raw;
    } catch {
        return '';
    }
}

function findTailStart(messages: ChatMessage[], tailLimit: number): number {
    if (messages.length <= tailLimit) return 0;
    let start = Math.max(0, messages.length - tailLimit);
    while (start < messages.length && messages[start]?.role === 'tool') {
        start++;
    }
    return Math.min(start, messages.length);
}

export function buildResumeMessages(
    messages: ChatMessage[],
    summaryText = '',
    tailLimit = RESUME_TAIL_MESSAGE_LIMIT
): ChatMessage[] {
    const normalized = prepareMessagesForResume(messages);
    const firstSystem = normalized.find(message => message.role === 'system');
    const tailStart = findTailStart(normalized, tailLimit);
    const tail = normalized
        .slice(tailStart)
        .filter((message, index) => !(index === 0 && message.role === 'system'))
        .map(cloneChatMessage);

    const resumeMessages: ChatMessage[] = [];
    if (firstSystem) {
        resumeMessages.push(cloneChatMessage(firstSystem));
    }
    if (summaryText.trim()) {
        resumeMessages.push({
            role: 'user',
            content: [
                '[SYSTEM RESUME MEMORY]',
                'Use this compacted memory as the authoritative summary of earlier work, then continue from the recent transcript tail below.',
                summaryText.trim()
            ].join('\n\n')
        });
    }
    resumeMessages.push(...tail);
    return prepareMessagesForResume(resumeMessages);
}

function archiveFullTranscript(resumeDir: string, runId: string | undefined, normalizedMessages: ChatMessage[]): string | undefined {
    if (!runId) return undefined;
    try {
        const runDir = pathModule.join(resumeDir, 'runs', runId);
        if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
        const transcriptPath = pathModule.join(runDir, 'resume_transcript.json');
        fs.writeFileSync(transcriptPath, JSON.stringify(normalizedMessages, null, 2), 'utf-8');
        return transcriptPath;
    } catch {
        return undefined;
    }
}

/** 
* Save the current Agent state to disk for recovery in the event of an IDE restart or crash. 
* (Checkpoint/Resume) 
*/
export async function saveResumeState(
    topicId: string,
    mode: AgentMode,
    messages: ChatMessage[],
    toolExecutor: AgentToolExecutor,
    runId?: string,
    pendingToolCalls?: any[]
): Promise<void> {
    try {
        const wsRoot = getProjectWorkspaceRoot();
        if (!topicId) return;

        const resumeDir = getTopicStorageDir(topicId, wsRoot);
        if (!resumeDir) return;
        if (!fs.existsSync(resumeDir)) fs.mkdirSync(resumeDir, { recursive: true });

        const normalizedMessages = prepareMessagesForResume(messages);
        const summaryRef = findLatestSummaryRef(resumeDir, runId);
        const summaryText = readSummarySnippet(summaryRef);
        const compactedMessages = buildResumeMessages(normalizedMessages, summaryText);
        const fullTranscriptRef = archiveFullTranscript(resumeDir, runId, normalizedMessages);

        const resumeState: AgentResumeState = {
            version: 2,
            timestamp: Date.now(),
            mode,
            messages: compactedMessages,
            todos: toolExecutor.getTodos(),
            topicId,
            runId,
            summaryRef,
            fullTranscriptRef,
            pendingToolCalls,
            lastStableEventId: 'evt_latest',
            tailMessageCount: compactedMessages.length,
            compacted: true,
            permissionRules: PermissionPolicyStore.getInstance().serialize(),
        };

        fs.writeFileSync(
            pathModule.join(resumeDir, 'resume_state.json'),
            JSON.stringify(resumeState),
            'utf-8'
        );
    } catch {
        // Non-critical — silently ignore save failures
    }
}

/**
 * Read the resumable state under the specified topicId.
 * Supports both V2 (with version: 2) and legacy format.
 */
export async function loadResumeState(topicId: string): Promise<AgentResumeState | null> {
    try {
        const wsRoot = getProjectWorkspaceRoot();
        const resumePath = getTopicStorageDirCandidates(topicId, wsRoot)
            .map(dir => pathModule.join(dir, 'resume_state.json'))
            .find(candidate => fs.existsSync(candidate));
        if (!resumePath) return null;
        const raw = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
        if (!raw || !raw.messages || !Array.isArray(raw.messages)) return null;
        raw.messages = prepareMessagesForResume(raw.messages);
        // Re-arm learned approval rules so resumed runs do not re-prompt.
        PermissionPolicyStore.getInstance().restore(raw.permissionRules);
        return raw as AgentResumeState;
    } catch {
        return null;
    }
}

/**
 * Determine whether there is a breakpoint resume state.
 */
export async function hasResumeState(topicId: string): Promise<boolean> {
    if (!topicId) return false;
    try {
        const wsRoot = getProjectWorkspaceRoot();
        return getTopicStorageDirCandidates(topicId, wsRoot)
            .map(dir => pathModule.join(dir, 'resume_state.json'))
            .some(candidate => fs.existsSync(candidate));
    } catch {
        return false;
    }
}

/**
 * Clean up the resumption status (when a new task starts).
 */
export async function clearResumeState(topicId: string): Promise<void> {
    if (!topicId) return;
    try {
        const wsRoot = getProjectWorkspaceRoot();
        const resumePaths = getTopicStorageDirCandidates(topicId, wsRoot)
            .map(dir => pathModule.join(dir, 'resume_state.json'));
        for (const candidate of resumePaths) {
            if (fs.existsSync(candidate)) {
                fs.unlinkSync(candidate);
            }
        }
    } catch {
        // Ignore
    }
}
