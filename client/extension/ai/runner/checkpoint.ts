import * as fs from 'fs';
import * as pathModule from 'path';
import { getProjectWorkspaceRoot, getPrivateTopicStorageDir, getPrivateTopicStorageDirCandidates } from '../workspacePaths';
import type { AgentResumeState, ChatMessage, AgentMode, AgentRuntimeDomain } from '../types';
import { defaultDomainForMode } from '../agentProfile';
import type { AgentToolExecutor } from '../agentTools';
import { isPathInsideOrEqual } from '../../pathScope';
import { ErrorReporter } from '../errorReporter';
import { PermissionPolicyStore } from './permissionPolicy';
import {
    cloneChatMessage,
    normalizeTranscriptForPersistence,
    selectTranscriptForResume,
} from './contextTranscript';
import { atomicWriteJson, readJsonWithBackup, sha256Text } from './durableStorage';
import { runLedger } from './runLedger';
import { getHistoryPolicy } from './historyPolicy';

export const RESUME_TAIL_MESSAGE_LIMIT = 24;
const RESUME_SUMMARY_CHAR_LIMIT = 12000;

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
    return normalizeTranscriptForPersistence(messages);
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
    } catch (error) {
        ErrorReporter.warn('Checkpoint', 'Failed to archive the full resume transcript', error);
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

export function buildResumeMessages(
    messages: ChatMessage[],
    summaryText = '',
    tailLimit = RESUME_TAIL_MESSAGE_LIMIT
): ChatMessage[] {
    const normalized = prepareMessagesForResume(messages);
    const split = selectTranscriptForResume(normalized, tailLimit);
    const tail = split.recentMessages.map(cloneChatMessage);

    const resumeMessages: ChatMessage[] = split.persistentSystemMessages.map(cloneChatMessage);
    const hasLegacySystemSummary = split.persistentSystemMessages.some(message => (
        message.role === 'system'
        && String(message.content).includes('## Conversation Summary (compacted)')
    ));
    if (summaryText.trim() && !hasLegacySystemSummary) {
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

interface ArchivedTranscript {
    path: string;
    sha256: string;
    messageCount: number;
}

async function archiveFullTranscript(
    resumeDir: string,
    runId: string | undefined,
    normalizedMessages: ChatMessage[],
): Promise<ArchivedTranscript | undefined> {
    if (!runId) return undefined;
    try {
        const runDir = pathModule.join(resumeDir, 'runs', runId);
        const transcriptPath = pathModule.join(runDir, 'resume_transcript.json');
        const serialized = JSON.stringify(normalizedMessages, null, 2);
        await atomicWriteJson(transcriptPath, normalizedMessages);
        return {
            path: transcriptPath,
            sha256: sha256Text(serialized),
            messageCount: normalizedMessages.length,
        };
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
    pendingToolCalls?: any[],
    domain: AgentRuntimeDomain = defaultDomainForMode(mode),
): Promise<void> {
    if (getHistoryPolicy().persistence !== 'full') return;
    try {
        const wsRoot = getProjectWorkspaceRoot();
        if (!topicId) return;

        const resumeDir = getPrivateTopicStorageDir(topicId, wsRoot);
        if (!resumeDir) return;
        if (!fs.existsSync(resumeDir)) fs.mkdirSync(resumeDir, { recursive: true });

        const normalizedMessages = prepareMessagesForResume(messages);
        const summaryRef = findLatestSummaryRef(resumeDir, runId);
        const summaryText = readSummarySnippet(summaryRef);
        const compactedMessages = buildResumeMessages(normalizedMessages, summaryText);
        const transcript = await archiveFullTranscript(resumeDir, runId, normalizedMessages);
        const latestEvent = runId ? runLedger.getLatestEvent(runId) : undefined;
        const durablePermissionRules = PermissionPolicyStore.getInstance().serialize({ includeSessionOnly: false });

        const resumeState: AgentResumeState = {
            version: 3,
            timestamp: Date.now(),
            mode,
            domain,
            messages: compactedMessages,
            todos: toolExecutor.getTodos(),
            topicId,
            runId,
            summaryRef,
            fullTranscriptRef: transcript?.path,
            pendingToolCalls,
            lastStableEventId: latestEvent?.eventId,
            lastStableSequence: latestEvent?.sequence,
            tailMessageCount: compactedMessages.length,
            compacted: true,
            transcriptSha256: transcript?.sha256,
            transcriptMessageCount: transcript?.messageCount,
            ...(durablePermissionRules.length > 0 ? { permissionRules: durablePermissionRules } : {}),
        };

        await atomicWriteJson(pathModule.join(resumeDir, 'resume_state.json'), resumeState);
    } catch (error) {
        ErrorReporter.warn('Checkpoint', `Failed to save resume state for topic ${topicId}`, error);
    }
}

/**
 * Read the resumable state under the specified topicId.
 * Supports V3, V2, and the legacy unversioned format.
 */
export async function loadResumeState(topicId: string): Promise<AgentResumeState | null> {
    try {
        const wsRoot = getProjectWorkspaceRoot();
        const resumePath = getPrivateTopicStorageDirCandidates(topicId, wsRoot)
            .map(dir => pathModule.join(dir, 'resume_state.json'))
            .find(candidate => fs.existsSync(candidate) || fs.existsSync(`${candidate}.bak`));
        if (!resumePath) return null;
        const loaded = readJsonWithBackup<AgentResumeState>(resumePath, (value): value is AgentResumeState => (
            !!value && typeof value === 'object' && typeof (value as AgentResumeState).timestamp === 'number'
        ));
        if (!loaded) return null;
        const raw = loaded.value;

        if (
            !Array.isArray(raw.messages)
            && raw.fullTranscriptRef
            && isPathInsideOrEqual(raw.fullTranscriptRef, pathModule.dirname(resumePath))
        ) {
            const transcript = readJsonWithBackup<ChatMessage[]>(
                raw.fullTranscriptRef,
                (value): value is ChatMessage[] => {
                    if (!Array.isArray(value)) return false;
                    const serialized = JSON.stringify(value, null, 2);
                    return !raw.transcriptSha256 || sha256Text(serialized) === raw.transcriptSha256;
                },
            );
            if (transcript) {
                raw.messages = buildResumeMessages(transcript.value, readSummarySnippet(raw.summaryRef));
            }
        }
        if (!Array.isArray(raw.messages)) return null;
        if (raw.runId) {
            const replayed = await runLedger.readLatestModelRequestMessages(
                raw.runId,
                raw.topicId || topicId,
                raw.lastStableSequence ?? 0,
            );
            if (replayed) {
                raw.messages = buildResumeMessages(replayed.messages, readSummarySnippet(raw.summaryRef));
                raw.lastStableEventId = replayed.eventId;
                raw.lastStableSequence = replayed.sequence;
                raw.recoveredFromEventLog = true;
            }
        }
        raw.messages = prepareMessagesForResume(raw.messages);
        raw.domain = raw.domain ?? defaultDomainForMode(raw.mode);
        raw.recoveredFromBackup = loaded.recoveredFromBackup;
        // A process restart ends the approval session. Only explicitly durable
        // rules may be restored; legacy V2 session-only approvals are ignored.
        PermissionPolicyStore.getInstance().restore(raw.permissionRules, { allowSessionOnly: false });
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
        return getPrivateTopicStorageDirCandidates(topicId, wsRoot)
            .map(dir => pathModule.join(dir, 'resume_state.json'))
            .some(candidate => fs.existsSync(candidate) || fs.existsSync(`${candidate}.bak`));
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
        const resumePaths = getPrivateTopicStorageDirCandidates(topicId, wsRoot)
            .map(dir => pathModule.join(dir, 'resume_state.json'));
        for (const candidate of resumePaths) {
            for (const file of [candidate, `${candidate}.bak`]) {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            }
        }
    } catch {
        // Ignore
    }
}
