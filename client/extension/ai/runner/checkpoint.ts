import * as fs from 'fs';
import * as pathModule from 'path';
import { getProjectWorkspaceRoot, getTopicStorageDir, getTopicStorageDirCandidates } from '../workspacePaths';
import type { AgentResumeState, ChatMessage, AgentMode } from '../types';
import type { AgentToolExecutor } from '../agentTools';

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

/** 
* Save the current Agent state to disk for recovery in the event of an IDE restart or crash. 
* (Checkpoint/Resume) 
*/
export async function saveResumeState(
    topicId: string,
    mode: AgentMode,
    messages: ChatMessage[],
    toolExecutor: AgentToolExecutor
): Promise<void> {
    try {
        const wsRoot = getProjectWorkspaceRoot();
        if (!topicId) return;

        const resumeDir = getTopicStorageDir(topicId, wsRoot);
        if (!resumeDir) return;
        if (!fs.existsSync(resumeDir)) fs.mkdirSync(resumeDir, { recursive: true });

        const resumeState: AgentResumeState = {
            timestamp: Date.now(),
            mode,
            messages: prepareMessagesForResume(messages),
            todos: toolExecutor.getTodos(),
            topicId,
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
* Read the resumable download status under the specified topicId. 
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
