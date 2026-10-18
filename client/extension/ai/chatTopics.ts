/**
 * Eddy CWTool Code — Chat Topic Manager
 *
 * Manages chat topic CRUD, persistence, search, export/import, and history.
 * Extracted from chatPanel.ts for maintainability.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { AgentModeOverride, ChatTopic, ChatHistoryMessage, HostMessage, ChatMessage } from './types';
import { UI, aiText, getAiMessageLocale } from './messages';
import { getPrivateAiStorageRoot, getProjectWorkspaceRoot } from './workspacePaths';
import { normalizeSchedulingState } from './runner/scheduling';
import { atomicWriteTextSync, readJsonWithBackup } from './runner/durableStorage';
import { ErrorReporter } from './errorReporter';

/**
 * Upper bound on how many topics are written back. Trimming on persist is a
 * deliberate storage bound, but it is applied to what is *stored*, never to
 * what is currently in memory.
 */
const MAX_PERSISTED_TOPICS = 50;

function readSchedulingState(value: unknown) {
    try {
        return normalizeSchedulingState(value);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MODE_OVERRIDES = new Set<AgentModeOverride>(['auto', 'execute', 'plan', 'explore', 'review']);

/**
 * Read the persisted user-pinned task mode. Unknown or malformed values fall
 * back to 'auto' (the Agent decides), never to a pinned mode: a corrupted field
 * must not silently restrict what the Agent may do.
 */
export function readModeOverride(value: unknown): AgentModeOverride {
    return typeof value === 'string' && MODE_OVERRIDES.has(value as AgentModeOverride)
        ? value as AgentModeOverride
        : 'auto';
}

/**
 * Topics the GUI lists and the Agent can resume are the user's only copy of
 * their conversation history: no other subsystem stores them. Validation and
 * storage therefore have to fail loudly and additively rather than quietly
 * dropping entries, and a store that cannot be read must never be replaced.
 */
export interface TopicStoreLoadResult {
    /** Topics recovered from the newest readable generation. */
    topics: ChatTopic[];
    /** Entries present in that generation but rejected by validation. */
    skipped: number;
    /** True when the primary file was unusable and `<file>.bak` was read instead. */
    recoveredFromBackup: boolean;
    /** Entries rejected by validation, kept verbatim so writes preserve them. */
    rejected: unknown[];
    /** True when a store file exists but no generation could be read. */
    unreadable: boolean;
}

interface RejectedTopic { reason: string }

function readStoredTopicWithReason(value: unknown): { topic: ChatTopic } | RejectedTopic {
    if (!isRecord(value)) return { reason: 'entry is not an object' };
    if (typeof value.id !== 'string' || !value.id) return { reason: 'missing id' };
    if (typeof value.title !== 'string') return { reason: `${value.id}: missing title` };
    if (typeof value.createdAt !== 'number') return { reason: `${value.id}: missing createdAt` };
    if (typeof value.updatedAt !== 'number') return { reason: `${value.id}: missing updatedAt` };
    if (!Array.isArray(value.messages)) return { reason: `${value.id}: messages is not an array` };
    const schedulingState = readSchedulingState(value.schedulingState);
    if (!schedulingState) return { reason: `${value.id}: unusable schedulingState` };
    if (!value.messages.every(message => isRecord(message)
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
        && typeof message.timestamp === 'number')) {
        return { reason: `${value.id}: malformed message` };
    }
    // Topics written before the AI Workflow subsystem was removed may still
    // carry `workflowId` / `workflowReturnSchedulingState`. They are dropped
    // here rather than rejected: a legacy field must not make a whole topic
    // unreadable, and the removed concept has nothing left to restore.
    return {
        topic: {
            id: value.id,
            title: value.title,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
            messages: value.messages as ChatHistoryMessage[],
            parentTopicId: typeof value.parentTopicId === 'string' ? value.parentTopicId : undefined,
            forkedFromMessageIndex: Number.isSafeInteger(value.forkedFromMessageIndex) ? value.forkedFromMessageIndex as number : undefined,
            archived: typeof value.archived === 'boolean' ? value.archived : undefined,
            pinned: typeof value.pinned === 'boolean' ? value.pinned : undefined,
            workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : undefined,
            workspaceLabel: typeof value.workspaceLabel === 'string' ? value.workspaceLabel : undefined,
            schedulingState,
            modeOverride: readModeOverride(value.modeOverride),
            approvedPlanArtifact: typeof value.approvedPlanArtifact === 'string' && value.approvedPlanArtifact
                ? value.approvedPlanArtifact
                : undefined,
        },
    };
}

/** Callback type for sending messages to the WebView */
type PostMessageFn = (msg: HostMessage) => void;

/**
 * Folder name of the project root that owns the active editor. Multi-root
 * workspaces use it so a new topic is grouped with the mod it was started from
 * instead of falling into "Ungrouped".
 */
function activeWorkspaceLabel(): string | undefined {
    const root = getProjectWorkspaceRoot();
    return root ? path.basename(root) : undefined;
}

export class ChatTopicManager {
    currentTopic: ChatTopic | null = null;
    topics: ChatTopic[] = [];
    public showArchived: boolean = false;
    /**
     * Set when the store could not be read at all. No write path may run while
     * it is set: the in-memory list is empty only because loading failed, so
     * persisting it would replace the user's history with that emptiness.
     */
    private persistBlockedReason: string | undefined;
    /** Raw entries that failed validation, rewritten verbatim on every save. */
    private preservedEntries: unknown[] = [];

    constructor(
        private storageUri: vs.Uri | undefined,
        private postMessage: PostMessageFn,
        private persistence: 'off' | 'metadata' | 'full' = 'full',
    ) {
        this.loadTopics();
    }

    // ─── Persistence ─────────────────────────────────────────────────────────

    private get topicsFilePath(): string | undefined {
        if (!this.storageUri) return undefined;
        return path.join(this.storageUri.fsPath, 'ai-chat-topics.json');
    }

    /**
     * Read the topic store, preferring the primary file and falling back to
     * the previous complete generation written by {@link atomicWriteTextSync}.
     * Returns an empty list for a genuinely absent store, and a blocked store
     * when generations exist but none can be parsed.
     */
    readStore(): TopicStoreLoadResult {
        const filePath = this.topicsFilePath;
        const absent: TopicStoreLoadResult = {
            topics: [], skipped: 0, rejected: [], recoveredFromBackup: false, unreadable: false,
        };
        if (this.persistence === 'off' || !filePath) return absent;
        if (!fs.existsSync(filePath) && !fs.existsSync(`${filePath}.bak`)) return absent;
        // The validator is part of the read, not a step after it: a primary
        // file that exists but no longer parses must fall through to the
        // previous complete generation instead of blocking recovery.
        const stored = readJsonWithBackup<unknown[]>(filePath, Array.isArray);
        if (!stored) return { ...absent, unreadable: true };
        const parsed = stored.value;
        const topics: ChatTopic[] = [];
        const rejected: unknown[] = [];
        const reasons: string[] = [];
        for (const entry of parsed) {
            const result = readStoredTopicWithReason(entry);
            if ('topic' in result) topics.push(result.topic);
            else {
                rejected.push(entry);
                reasons.push(result.reason);
            }
        }
        return {
            topics,
            skipped: reasons.length,
            rejected,
            recoveredFromBackup: stored.recoveredFromBackup,
            unreadable: false,
        };
    }

    loadTopics(): void {
        if (this.persistence === 'off') return;
        const filePath = this.topicsFilePath;
        if (!filePath) return;
        const result = this.readStore();
        this.persistBlockedReason = undefined;
        this.preservedEntries = result.rejected;
        this.topics = result.topics;
        if (result.unreadable) {
            // Nothing was recovered, so the in-memory list is empty for a
            // reason that has nothing to do with the user deleting topics.
            this.persistBlockedReason = filePath;
            ErrorReporter.warn(
                'ChatTopics',
                `Topic history at ${filePath} could not be read; it will not be overwritten`,
            );
            return;
        }
        if (result.recoveredFromBackup) {
            ErrorReporter.warn('ChatTopics', `Recovered topic history from ${path.basename(filePath)}.bak`);
        }
        if (result.skipped > 0) {
            // A single unreadable entry used to cost the user that topic and,
            // through the next save, the entry itself. It is now hidden from
            // the list but written back verbatim so the data stays recoverable.
            ErrorReporter.warn(
                'ChatTopics',
                `Skipped ${result.skipped} unreadable topic(s) in ${path.basename(filePath)}; the raw entries are preserved`,
            );
        }
    }

    saveTopics(): void {
        if (this.persistence === 'off') return;
        const filePath = this.topicsFilePath;
        if (!filePath) return;
        if (this.persistBlockedReason) {
            // Writing now would replace the user's unreadable-but-present
            // history with an empty list.
            ErrorReporter.debug(
                'ChatTopics',
                `Skipped saving topic history because ${path.basename(this.persistBlockedReason)} could not be read`,
            );
            return;
        }
        try {
            // Keep only the last `MAX_PERSISTED_TOPICS` topics to bound the file;
            // the trimmed tail is still held in memory for this session.
            const retained = this.topics.slice(0, MAX_PERSISTED_TOPICS).map(topic => this.persistence === 'metadata'
                ? { ...topic, messages: [] }
                : topic);
            const payload = this.preservedEntries.length > 0
                ? [...retained, ...this.preservedEntries]
                : retained;
            atomicWriteTextSync(filePath, JSON.stringify(payload, null, 2));
        } catch (error) {
            ErrorReporter.warn('ChatTopics', `Failed to save topic history to ${filePath}`, error);
        }
    }

    // ─── Topic CRUD ──────────────────────────────────────────────────────────

    createNewTopic(firstMessage: string, schedulingState: ChatTopic['schedulingState']): void {
        const title = firstMessage.substring(0, 40) + (firstMessage.length > 40 ? '...' : '');
        const workspaceLabel = activeWorkspaceLabel();
        this.currentTopic = {
            id: `topic_${Date.now()}`,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            workspaceId: workspaceLabel,
            workspaceLabel,
            schedulingState: normalizeSchedulingState(schedulingState),
        };
        this.topics.unshift(this.currentTopic);
        this.sendTopicList();
    }

    /**
     * Start a new (empty) topic, clearing current state.
     * Returns the conversationMessages to be cleared by the coordinator.
     */
    startNewTopic(): void {
        this.currentTopic = null;
        this.postMessage({ type: 'clearChat' });
        this.sendTopicList();
    }

    loadTopic(topicId: string, webviewMessages?: ChatHistoryMessage[]): ChatMessage[] {
        const topic = this.topics.find(t => t.id === topicId);
        if (!topic) return [];

        this.currentTopic = topic;
        const conversationMessages: ChatMessage[] = topic.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({
                role: m.role,
                content: m.code ? `${m.content}\n\`\`\`pdx\n${m.code}\n\`\`\`` : m.content,
            }));

        this.postMessage({ type: 'clearChat' });
        this.postMessage({ type: 'loadTopicMessages', messages: webviewMessages ?? topic.messages });
        this.sendTopicList();
        return conversationMessages;
    }

    deleteTopic(topicId: string): boolean {
        this.topics = this.topics.filter(t => t.id !== topicId);
        const isCurrentDeleted = this.currentTopic?.id === topicId;
        if (isCurrentDeleted) {
            this.startNewTopic();
        }
        this.saveTopics();
        this.sendTopicList();
        return isCurrentDeleted;
    }

    renameTopic(topicId: string, title: string): boolean {
        const nextTitle = title.trim().replace(/\s+/g, ' ').substring(0, 120);
        if (!nextTitle) return false;

        const topic = this.topics.find(t => t.id === topicId);
        if (!topic) return false;

        topic.title = nextTitle;
        topic.updatedAt = Date.now();
        this.saveTopics();
        this.sendTopicList();
        this.postMessage({ type: 'topicTitleGenerated', topicId, title: nextTitle });
        return true;
    }

    /**
     * Fork a topic at a specific message index (OpenCode-style session fork).
     * Creates a new topic with messages[0..messageIndex], switches to it.
     * Returns the new conversationMessages array.
     */
    forkTopic(topicId: string, messageIndex: number): ChatMessage[] {
        const source = this.topics.find(t => t.id === topicId);
        if (!source) return [];

        const forkedMessages = source.messages.slice(0, messageIndex + 1);
        const titlePreview = source.title + aiText(' [fork]', ' [分支]');

        const forked: ChatTopic = {
            id: `topic_${Date.now()}`,
            title: titlePreview,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: forkedMessages,
            parentTopicId: topicId,
            forkedFromMessageIndex: messageIndex,
            schedulingState: normalizeSchedulingState(source.schedulingState),
            // A fork inherits the parent's pinned mode: the user's choice was
            // about how this work is done, not about one particular topic id.
            modeOverride: readModeOverride(source.modeOverride),
            workspaceId: source.workspaceId,
            workspaceLabel: source.workspaceLabel,
        };

        this.topics.unshift(forked);
        this.currentTopic = forked;
        const conversationMessages = forkedMessages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: m.code ? `${m.content}\n\`\`\`pdx\n${m.code}\n\`\`\`` : m.content }));

        this.postMessage({ type: 'clearChat' });
        this.postMessage({ type: 'loadTopicMessages', messages: forkedMessages });
        this.postMessage({ type: 'topicForked', newTopicId: forked.id, title: forked.title });
        this.saveTopics();
        this.sendTopicList();
        return conversationMessages;
    }

    /** Archive/unarchive a topic (hidden from main list but not deleted) */
    archiveTopic(topicId: string): boolean {
        const topic = this.topics.find(t => t.id === topicId);
        if (!topic) return false;
        topic.archived = !topic.archived;
        const shouldStartNew = this.currentTopic?.id === topicId && topic.archived;
        // Persist before switching views: archiving the open topic clears the
        // current topic, and the archive flag must already be on disk when the
        // panel is reopened.
        this.saveTopics();
        if (shouldStartNew) {
            this.startNewTopic();
        }
        this.sendTopicList();
        return shouldStartNew;
    }

    setPinned(topicId: string, pinned?: boolean): boolean {
        const topic = this.topics.find(t => t.id === topicId);
        if (!topic) return false;
        topic.pinned = typeof pinned === 'boolean' ? pinned : !topic.pinned;
        topic.updatedAt = Date.now();
        this.saveTopics();
        this.sendTopicList();
        return true;
    }

    setWorkspace(topicId: string, workspaceId?: string | null, workspaceLabel?: string | null): boolean {
        const topic = this.topics.find(t => t.id === topicId);
        if (!topic) return false;
        const nextId = (workspaceId ?? '').trim();
        const nextLabel = (workspaceLabel ?? '').trim();
        if (!nextId) {
            delete topic.workspaceId;
            delete topic.workspaceLabel;
        } else {
            topic.workspaceId = nextId;
            topic.workspaceLabel = nextLabel || nextId;
        }
        topic.updatedAt = Date.now();
        this.saveTopics();
        this.sendTopicList();
        return true;
    }

    addHistoryMessage(msg: ChatHistoryMessage, targetTopicId?: string): void {
        const topic = targetTopicId ? this.topics.find(t => t.id === targetTopicId) : this.currentTopic;
        if (topic) {
            topic.messages.push(msg);
            topic.updatedAt = Date.now();
        }
    }

    // ─── Topic List & Search ──────────────────────────────────────────────────

    sendTopicList(): void {
        const visibleTopics = this.topics
            .filter(t => this.showArchived || !t.archived);
        const archivedCount = this.topics.filter(t => t.archived).length;
        this.postMessage({
            type: 'topicList',
            topics: visibleTopics.map(t => ({
                id: t.id,
                title: t.title,
                updatedAt: t.updatedAt,
                createdAt: t.createdAt,
                archived: t.archived,
                pinned: t.pinned,
                workspaceId: t.workspaceId,
                workspaceLabel: t.workspaceLabel,
                messageCount: t.messages.length,
                parentTopicId: t.parentTopicId,
                forkedFromMessageIndex: t.forkedFromMessageIndex,
            })),
            stats: {
                total: this.topics.length,
                visible: visibleTopics.length,
                archived: archivedCount,
                currentTopicId: this.currentTopic?.id ?? null,
                currentTopicTitle: this.currentTopic?.title ?? null,
            },
        });
    }

    setShowArchived(show: boolean): void {
        this.showArchived = show;
        this.sendTopicList();
    }

    /**
     * Search topics by keyword — scans title and full message content.
     * Returns top 20 matches sorted by relevance (title match first, then recency).
     * Includes context preview showing where the match was found.
     */
    handleSearchTopics(query: string): void {
        const q = query.toLowerCase().trim();
        if (!q) {
            this.sendTopicList();
            return;
        }

        const scored: Array<{
            id: string; title: string; updatedAt: number;
            matchContext?: string; score: number;
        }> = [];

        for (const t of this.topics) {
            if (t.archived && !this.showArchived) continue;

            let score = 0;
            let matchContext: string | undefined;

            // Title match (highest priority)
            if (t.title.toLowerCase().includes(q)) {
                score += 100;
            }

            // Message content match — find first matching message and extract context
            for (const m of t.messages) {
                const content = m.content.toLowerCase();
                const codeContent = (m.code ?? '').toLowerCase();
                const idx = content.indexOf(q);
                const codeIdx = codeContent.indexOf(q);

                if (idx >= 0) {
                    score += (m.role === 'user' ? 10 : 5);
                    if (!matchContext) {
                        // Extract snippet around match (±40 chars)
                        const start = Math.max(0, idx - 40);
                        const end = Math.min(m.content.length, idx + q.length + 40);
                        matchContext = (start > 0 ? '...' : '') +
                            m.content.substring(start, end).replace(/\n/g, ' ') +
                            (end < m.content.length ? '...' : '');
                    }
                } else if (codeIdx >= 0) {
                    score += 8;
                    if (!matchContext) {
                        const start = Math.max(0, codeIdx - 40);
                        const end = Math.min(m.code!.length, codeIdx + q.length + 40);
                        matchContext = '[code] ' + (start > 0 ? '...' : '') +
                            m.code!.substring(start, end).replace(/\n/g, ' ') +
                            (end < m.code!.length ? '...' : '');
                    }
                }
            }

            if (score > 0) {
                scored.push({ id: t.id, title: t.title, updatedAt: t.updatedAt, matchContext, score });
            }
        }

        // Sort by score descending, then by recency
        scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);

        const results = scored.slice(0, 20).map(s => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            createdAt: this.topics.find(t => t.id === s.id)?.createdAt,
            archived: this.topics.find(t => t.id === s.id)?.archived,
            messageCount: this.topics.find(t => t.id === s.id)?.messages.length || 0,
            matchContext: s.matchContext,
            score: s.score,
            pinned: this.topics.find(t => t.id === s.id)?.pinned,
            workspaceId: this.topics.find(t => t.id === s.id)?.workspaceId,
            workspaceLabel: this.topics.find(t => t.id === s.id)?.workspaceLabel,
            parentTopicId: this.topics.find(t => t.id === s.id)?.parentTopicId,
            forkedFromMessageIndex: this.topics.find(t => t.id === s.id)?.forkedFromMessageIndex,
        }));

        this.postMessage({
            type: 'topicSearchResults',
            results,
            query,
            totalCount: scored.length,
            stats: {
                total: this.topics.length,
                visible: results.length,
                archived: this.topics.filter(t => t.archived).length,
                currentTopicId: this.currentTopic?.id ?? null,
                currentTopicTitle: this.currentTopic?.title ?? null,
            },
        });
    }

    // ─── Topic Export / Import ────────────────────────────────────────────────

    /**
     * Export a topic (or the current topic) as a Markdown file.
     * Saves to the workspace root and opens in VSCode.
     */
    async exportTopicAsMarkdown(topicId?: string): Promise<void> {
        const topic = topicId
            ? this.topics.find(t => t.id === topicId)
            : this.currentTopic;

        if (!topic) {
            vs.window.showWarningMessage(aiText('No conversation to export', '没有可导出的对话'));
            return;
        }

        const dateLocale = getAiMessageLocale() === 'zh-cn' ? 'zh-CN' : 'en-US';
        const lines: string[] = [
            `# ${topic.title}`,
            ``,
            `> ${aiText('Exported', '导出时间')}: ${new Date().toLocaleString(dateLocale)}  `,
            `> ${aiText('Created', '创建时间')}: ${new Date(topic.createdAt).toLocaleString(dateLocale)}`,
            ``,
        ];

        for (const msg of topic.messages) {
            if (msg.role === 'user') {
                lines.push(`## ${aiText('User', '用户')}`);
                lines.push(``);
                lines.push(msg.content);
                lines.push(``);
            } else if (msg.role === 'assistant') {
                lines.push(`## Eddy CWTool Code`);
                lines.push(``);
                if (msg.content) {
                    lines.push(msg.content);
                    lines.push(``);
                }
                if (msg.code) {
                    lines.push('```pdx');
                    lines.push(msg.code);
                    lines.push('```');
                    lines.push(``);
                }
            }
        }

        const content = lines.join('\n');
        const workspaceRoot = getProjectWorkspaceRoot();
        if (!workspaceRoot) {
            vs.window.showWarningMessage(UI.NO_WORKSPACE);
            return;
        }

        const safeName = topic.title
            .replace(/[<>:"/\\|?*\uFF1A\uFF1F\uFF0F\u3000\u300A\u300B]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 60);
        const outPath = path.join(getPrivateAiStorageRoot(workspaceRoot), 'exports', `${safeName || 'chat'}.md`);
        const outDir = path.dirname(outPath);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(outPath, content, 'utf-8');

        const doc = await vs.workspace.openTextDocument(outPath);
        await vs.window.showTextDocument(doc, { preview: true });
        vs.window.showInformationMessage(aiText(`Conversation exported: ${path.basename(outPath)}`, `对话已导出: ${path.basename(outPath)}`));
    }

    /**
     * Export a topic as a full JSON file (preserving all metadata and steps).
     */
    async exportTopicAsJson(topicId?: string): Promise<void> {
        const topic = topicId
            ? this.topics.find(t => t.id === topicId)
            : this.currentTopic;

        if (!topic) {
            vs.window.showWarningMessage(aiText('No conversation to export', '没有可导出的对话'));
            return;
        }

        const workspaceRoot = getProjectWorkspaceRoot();
        if (!workspaceRoot) {
            vs.window.showWarningMessage(UI.NO_WORKSPACE);
            return;
        }

        const safeName = topic.title
            .replace(/[<>:"/\\|?*\uFF1A\uFF1F\uFF0F\u3000\u300A\u300B]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 60);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const outPath = path.join(getPrivateAiStorageRoot(workspaceRoot), 'exports', `${safeName || 'chat'}_${timestamp}.json`);
        const outDir = path.dirname(outPath);

        if (!fs.existsSync(outDir)) {
            await fs.promises.mkdir(outDir, { recursive: true });
        }

        // Export the full topic object, including steps, messages, images, etc.
        const jsonContent = JSON.stringify(topic, null, 2);
        await fs.promises.writeFile(outPath, jsonContent, 'utf-8');

        const doc = await vs.workspace.openTextDocument(outPath);
        await vs.window.showTextDocument(doc, { preview: true });
        vs.window.showInformationMessage(aiText(`Conversation exported as JSON: ${path.basename(outPath)}`, `对话已导出为 JSON: ${path.basename(outPath)}`));
    }

    /**
     * Import a topic from a JSON string, perform schema validation, and load it.
     * Returns the new conversationMessages, or null on failure.
     */
    async importTopicFromJson(jsonString: string): Promise<ChatMessage[] | null> {
        try {
            const data = JSON.parse(jsonString) as Partial<ChatTopic>;

            // Simple schema validation
            if (!data.title || !Array.isArray(data.messages)) {
                throw new Error(aiText('Invalid session file format (missing title or messages array)', '无效的会话文件格式 (缺少 title 或 messages 数组)'));
            }

            // Generate a new ID to avoid collisions
            const schedulingState = readSchedulingState(data.schedulingState);
            if (!schedulingState) {
                throw new Error(aiText('Invalid session file format (missing canonical scheduling state)', '无效的会话文件格式（缺少规范调度状态）'));
            }
            const importedTopic: ChatTopic = {
                id: `topic_imported_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                title: `${data.title} ${aiText('(imported)', '(导入)')}`,
                createdAt: data.createdAt || Date.now(),
                updatedAt: Date.now(),
                messages: data.messages as ChatHistoryMessage[],
                archived: false,
                schedulingState,
            };

            // Validate messages
            for (let i = 0; i < importedTopic.messages.length; i++) {
                const msg = importedTopic.messages[i];
                if (!msg?.role || (msg.role !== 'user' && msg.role !== 'assistant')) {
                    throw new Error(aiText(
                        `Message ${i} is invalid: role must be 'user' or 'assistant'`,
                        `消息 ${i} 格式无效: role 必须为 'user' 或 'assistant'`,
                    ));
                }
                if (msg.content === undefined || msg.content === null) {
                    throw new Error(aiText(
                        `Message ${i} is invalid: missing content field`,
                        `消息 ${i} 格式无效: 缺少 content field`,
                    ));
                }
            }

            this.topics.unshift(importedTopic);
            this.saveTopics();
            this.sendTopicList();

            const conversationMessages = this.loadTopic(importedTopic.id);
            this.postMessage({ type: 'topicImported', topicId: importedTopic.id, title: importedTopic.title });

            vs.window.showInformationMessage(aiText(`Session imported: ${importedTopic.title}`, `成功导入会话: ${importedTopic.title}`));
            return conversationMessages;
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            vs.window.showErrorMessage(aiText(`Failed to import conversation: ${err}`, `导入对话失败: ${err}`));
            return null;
        }
    }
}
