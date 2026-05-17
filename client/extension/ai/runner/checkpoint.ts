import * as fs from 'fs';
import * as pathModule from 'path';
import { getProjectWorkspaceRoot, getTopicStorageDir, getTopicStorageDirCandidates } from '../workspacePaths';
import type { AgentResumeState, ChatMessage, AgentMode } from '../types';
import type { AgentToolExecutor } from '../agentTools';

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
            messages,
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
