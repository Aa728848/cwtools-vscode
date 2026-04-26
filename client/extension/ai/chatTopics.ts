/**
 * Eddy CWTool Code — Chat Topic Manager
 *
 * Manages chat topic CRUD, persistence, search, export/import, and history.
 * Extracted from chatPanel.ts for maintainability.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ChatTopic, ChatHistoryMessage, HostMessage, ChatMessage } from './types';

/** Callback type for sending messages to the WebView */
type PostMessageFn = (msg: HostMessage) => void;

export class ChatTopicManager {
    currentTopic: ChatTopic | null = null;
    topics: ChatTopic[] = [];

    constructor(
        private storageUri: vs.Uri | undefined,
        private postMessage: PostMessageFn
    ) {
        this.loadTopics();
    }

    // ─── Persistence ─────────────────────────────────────────────────────────

    private get topicsFilePath(): string | undefined {
        if (!this.storageUri) return undefined;
        return path.join(this.storageUri.fsPath, 'ai-chat-topics.json');
    }

    loadTopics(): void {
        const filePath = this.topicsFilePath;
        if (!filePath) return;
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                this.topics = JSON.parse(data);
            }
        } catch { /* ignore */ }
    }

    saveTopics(): void {
        const filePath = this.topicsFilePath;
        if (!filePath) return;
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Keep only the last 50 topics to limit file size
            const toSave = this.topics.slice(0, 50);
            fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf-8');
        } catch { /* ignore */ }
    }

    // ─── Topic CRUD ──────────────────────────────────────────────────────────

    createNewTopic(firstMessage: string): void {
        const title = firstMessage.substring(0, 40) + (firstMessage.length > 40 ? '...' : '');
        this.currentTopic = {
            id: `topic_${Date.now()}`,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
        };
        this.topics.unshift(this.currentTopic);
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

    loadTopic(topicId: string): ChatMessage[] {
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
        this.postMessage({ type: 'loadTopicMessages', messages: topic.messages });
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

    /**
     * Fork a topic at a specific message index (OpenCode-style session fork).
     * Creates a new topic with messages[0..messageIndex], switches to it.
     * Returns the new conversationMessages array.
     */
    forkTopic(topicId: string, messageIndex: number): ChatMessage[] {
        const source = this.topics.find(t => t.id === topicId);
        if (!source) return [];

        const forkedMessages = source.messages.slice(0, messageIndex + 1);
        const titlePreview = source.title + ' [分支]';

        const forked: ChatTopic = {
            id: `topic_${Date.now()}`,
            title: titlePreview,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: forkedMessages,
            parentTopicId: topicId,
            forkedFromMessageIndex: messageIndex,
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
        if (shouldStartNew) {
            this.startNewTopic();
        }
        this.saveTopics();
        this.sendTopicList();
        return shouldStartNew;
    }

    addHistoryMessage(msg: ChatHistoryMessage): void {
        if (this.currentTopic) {
            this.currentTopic.messages.push(msg);
            this.currentTopic.updatedAt = Date.now();
        }
    }

    // ─── Topic List & Search ──────────────────────────────────────────────────

    sendTopicList(): void {
        this.postMessage({
            type: 'topicList',
            topics: this.topics
                .filter(t => !t.archived)
                .map(t => ({
                    id: t.id,
                    title: t.title,
                    updatedAt: t.updatedAt,
                    archived: t.archived,
                })),
        });
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
            if (t.archived) continue;

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
                        matchContext = '📄 ' + (start > 0 ? '...' : '') +
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
            matchContext: s.matchContext,
        }));

        this.postMessage({ type: 'topicSearchResults', results });
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
            vs.window.showWarningMessage('没有可导出的对话');
            return;
        }

        const lines: string[] = [
            `# ${topic.title}`,
            ``,
            `> 导出时间: ${new Date().toLocaleString('zh-CN')}  `,
            `> 创建时间: ${new Date(topic.createdAt).toLocaleString('zh-CN')}`,
            ``,
        ];

        for (const msg of topic.messages) {
            if (msg.role === 'user') {
                lines.push(`## 👤 用户`);
                lines.push(``);
                lines.push(msg.content);
                lines.push(``);
            } else if (msg.role === 'assistant') {
                lines.push(`## 🤖 Eddy CWTool Code`);
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
        const workspaceRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vs.window.showWarningMessage('没有打开的工作区');
            return;
        }

        const safeName = topic.title
            .replace(/[<>:"/\\|?*\uFF1A\uFF1F\uFF0F\u3000\u300A\u300B]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 60);
        const outPath = path.join(workspaceRoot, `.cwtools-ai-exports`, `${safeName || 'chat'}.md`);
        const outDir = path.dirname(outPath);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(outPath, content, 'utf-8');

        const doc = await vs.workspace.openTextDocument(outPath);
        await vs.window.showTextDocument(doc, { preview: true });
        vs.window.showInformationMessage(`对话已导出: ${path.basename(outPath)}`);
    }

    /**
     * Export a topic as a full JSON file (preserving all metadata and steps).
     */
    async exportTopicAsJson(topicId?: string): Promise<void> {
        const topic = topicId
            ? this.topics.find(t => t.id === topicId)
            : this.currentTopic;

        if (!topic) {
            vs.window.showWarningMessage('没有可导出的对话');
            return;
        }

        const workspaceRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vs.window.showWarningMessage('没有打开的工作区');
            return;
        }

        const safeName = topic.title
            .replace(/[<>:"/\\|?*\uFF1A\uFF1F\uFF0F\u3000\u300A\u300B]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 60);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const outPath = path.join(workspaceRoot, `.cwtools-ai-exports`, `${safeName || 'chat'}_${timestamp}.json`);
        const outDir = path.dirname(outPath);

        if (!fs.existsSync(outDir)) {
            await fs.promises.mkdir(outDir, { recursive: true });
        }

        // Export the full topic object, including steps, messages, images, etc.
        const jsonContent = JSON.stringify(topic, null, 2);
        await fs.promises.writeFile(outPath, jsonContent, 'utf-8');

        const doc = await vs.workspace.openTextDocument(outPath);
        await vs.window.showTextDocument(doc, { preview: true });
        vs.window.showInformationMessage(`对话已导出为 JSON: ${path.basename(outPath)}`);
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
                throw new Error('无效的会话文件格式 (缺少 title 或 messages 数组)');
            }

            // Generate a new ID to avoid collisions
            const importedTopic: ChatTopic = {
                id: `topic_imported_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                title: `${data.title} (导入)`,
                createdAt: data.createdAt || Date.now(),
                updatedAt: Date.now(),
                messages: data.messages as ChatHistoryMessage[],
                archived: false,
            };

            // Validate messages
            for (let i = 0; i < importedTopic.messages.length; i++) {
                const msg = importedTopic.messages[i];
                if (!msg.role || (msg.role !== 'user' && msg.role !== 'assistant')) {
                    throw new Error(`消息 ${i} 格式无效: role 必须为 'user' 或 'assistant'`);
                }
                if (msg.content === undefined || msg.content === null) {
                    throw new Error(`消息 ${i} 格式无效: 缺少 content field`);
                }
            }

            this.topics.unshift(importedTopic);
            this.saveTopics();
            this.sendTopicList();

            const conversationMessages = this.loadTopic(importedTopic.id);
            this.postMessage({ type: 'topicImported', topicId: importedTopic.id, title: importedTopic.title });

            vs.window.showInformationMessage(`成功导入会话: ${importedTopic.title}`);
            return conversationMessages;
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            vs.window.showErrorMessage(`导入对话失败: ${err}`);
            return null;
        }
    }
}
