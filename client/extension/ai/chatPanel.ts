/**
 * Eddy CWTool Code Module — Chat Panel (WebView Host)
 *
 * Manages the side panel WebView for AI chat interaction.
 * Handles:
 * - WebView lifecycle
 * - Message routing between WebView and AgentRunner
 * - Chat history management (topics, persistence)
 * - Code insertion with diff view
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type {
    ChatMessage,
    WebViewMessage,
    HostMessage,
    AgentStep,
    AgentMode,
} from './types';
import { AgentRunner } from './agentRunner';
import { AIService } from './aiService';
import { UsageTracker } from './usageTracker';
import { getChatPanelHtml } from './chatHtml';
import { ChatTopicManager } from './chatTopics';
import { generateInitFile } from './chatInit';
import { ChatSettingsManager } from './chatSettings';
import { ErrorReporter } from './errorReporter';
import { UI, SOURCE } from './messages';

export class AIChatPanelProvider implements vs.WebviewViewProvider {
    public static readonly viewType = 'cwtools.aiChat';

    private view?: vs.WebviewView;
    private conversationMessages: ChatMessage[] = [];
    private abortController: AbortController | null = null;
    private currentMode: AgentMode = 'build';
    private previousMode: AgentMode = 'build';
    /** Live snapshot of agent steps emitted during the current generation */
    private _liveSteps: AgentStep[] = [];
    /** Whether an AI generation is currently running */
    private _isGenerating = false;
    /**
     * Per-message file snapshots for retract/undo support.
     * Key = messageIndex (the topic.messages index at the time the user sent the message).
     * Value = { files, convLength } where convLength is the length of conversationMessages
     * at the start of this exchange (used to slice conversationMessages correctly on retract,
     * since its indexing can diverge from topic.messages after fork/load).
     */
    private _messageFileSnapshots = new Map<number, {
        files: Array<{ filePath: string; previousContent: string | null }>;
        convLength: number;
    }>();
    /**
     * Points to the active snapshot array for the currently-running message.
     * Set in handleUserMessage, cleared in finally. Allows non-tool writes
     * (e.g. plan file) to register themselves into the same snapshot.
     */
    private _currentMessageSnapshots: Array<{ filePath: string; previousContent: string | null }> | null = null;

    // ── Shared ContentProvider for insertCodeWithDiff (M5 fix) ───────────────
    // Lazily registered once and reused for all code-insert previews.
    // The mutable `_previewContent` field is updated before each diff view.
    private _previewContent = '';
    private _previewProviderRegistration?: vs.Disposable;
    /** Fix #2: disposables for WebView event listeners, cleaned up on dispose() */
    private _viewDisposables: vs.Disposable[] = [];
    private topicManager!: ChatTopicManager;
    private settingsManager!: ChatSettingsManager;

    constructor(
        private extensionUri: vs.Uri,
        private agentRunner: AgentRunner,
        private aiService: AIService,
        private usageTracker: UsageTracker,
        private storageUri: vs.Uri | undefined
    ) {
        this.topicManager = new ChatTopicManager(storageUri, (msg) => this.postMessage(msg));
        this.settingsManager = new ChatSettingsManager(aiService, (msg) => this.postMessage(msg));
    }

    /**
     * L7 Fix: Clean up the panel on extension reload so the WebView doesn't
     * linger with callbacks pointing at a stale agentRunner.
     */
    dispose(): void {
        // Cancel any in-flight generation
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        // Dispose the shared content provider if registered
        if (this._previewProviderRegistration) {
            this._previewProviderRegistration.dispose();
            this._previewProviderRegistration = undefined;
        }
        // Close the WebView so the user starts fresh after reload
        if (this.view) {
            // WebviewView doesn't expose a direct close(), but we can trigger
            // VS Code to release it by showing nothing.
            // The view reference becomes stale after reload — clear it.
            this.view = undefined;
        }
        this._messageFileSnapshots.clear();
        // Fix #2: dispose WebView event listeners
        this._viewDisposables.forEach(d => d.dispose());
        this._viewDisposables = [];
    }

    resolveWebviewView(
        webviewView: vs.WebviewView,
        _context: vs.WebviewViewResolveContext,
        _token: vs.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Handle messages from WebView
        // Fix #2: capture disposables so they are released with the view
        webviewView.webview.onDidReceiveMessage(
            (msg: WebViewMessage) => { if (msg?.type) void this.handleWebViewMessage(msg); },
            this,
            this._viewDisposables
        );

        // ── Restore state when panel becomes visible again ────────────────────
        webviewView.onDidChangeVisibility(
            () => { if (webviewView.visible) this._restoreViewState(); },
            this,
            this._viewDisposables
        );

        // Send topic list and initial model data on load
        this.topicManager.sendTopicList();
        // Push provider/model list immediately so the quick selector is populated
        this.settingsManager.buildAndSendSettingsData().catch(() => { /* ignore on startup */ });
        // Restore current conversation if any
        this._restoreViewState();
    }

    // ─── View State Restoration ───────────────────────────────────────────────

    /**
     * Restore the full panel state after the WebView is (re)created or becomes
     * visible again. Called on initial load and on every onDidChangeVisibility(true).
     */
    private _restoreViewState(): void {
        // 1. Restore persisted topic messages
        if (this.topicManager.currentTopic && this.topicManager.currentTopic.messages.length > 0) {
            this.postMessage({ type: 'loadTopicMessages', messages: this.topicManager.currentTopic.messages });
        }
        // 2. Restore current mode
        this.postMessage({ type: 'setMode', mode: this.currentMode });
        // 3. If a generation was running when the panel was hidden, replay steps
        //    so the user can see what the AI has done so far and cancel if needed
        if (this._isGenerating && this._liveSteps.length > 0) {
            this.postMessage({ type: 'replaySteps', steps: this._liveSteps, isGenerating: true });
        }
        // 4. Restore model lists and settings bindings
        void this.settingsManager.buildAndSendSettingsData();
    }

    // ─── Message Handling ────────────────────────────────────────────────────

    private async handleWebViewMessage(msg: WebViewMessage): Promise<void> {
        switch (msg.type) {
            case 'sendMessage':
                await this.handleUserMessage(msg.text, msg.images, msg.attachedFiles);
                break;
            case 'insertCode':
                await this.insertCodeWithDiff(msg.code);
                break;
            case 'copyCode':
                await vs.env.clipboard.writeText(msg.code);
                vs.window.showInformationMessage('代码已复制到剪贴板');
                break;
            case 'regenerate':
                await this.regenerateLastResponse();
                break;
            case 'newTopic':
                this.startNewTopic();
                break;
            case 'loadTopic':
                this.loadTopic(msg.topicId);
                break;
            case 'deleteTopic':
                this.deleteTopic(msg.topicId);
                break;
            case 'forkTopic':
                this.forkTopic(msg.topicId, msg.messageIndex);
                break;
            case 'archiveTopic':
                this.archiveTopic(msg.topicId);
                break;
            case 'setShowArchived':
                this.topicManager.setShowArchived(msg.show);
                break;
            case 'configureProvider':
            case 'openSettings':
                await this.settingsManager.openSettingsPage();
                break;
            case 'saveSettings':
                await this.settingsManager.saveSettings(msg.settings);
                break;
            case 'detectOllamaModels':
                await this.settingsManager.detectOllamaModels(msg.endpoint);
                break;
            case 'fetchApiModels':
                await this.settingsManager.fetchApiModels(msg.providerId, msg.endpoint, msg.apiKey);
                break;
            case 'testConnection':
                await this.settingsManager.testConnection(msg.settings);
                break;
            case 'deleteDynamicModel':
                await this.settingsManager.deleteDynamicModel(msg.providerId, msg.modelId);
                break;
            case 'cancelGeneration':
                this.cancelGeneration();
                break;
            case 'switchMode':
                this.switchMode(msg.mode);
                break;
            case 'retractMessage':
                // Fix #3: retractMessage is async — must await to catch errors
                await this.retractMessage(msg.messageIndex);
                break;
            case 'confirmWriteFile':
                void this.resolveWriteConfirmation(msg.messageId, true);
                break;
            case 'cancelWriteFile':
                void this.resolveWriteConfirmation(msg.messageId, false);
                break;
            case 'approveTransaction':
                void this.agentRunner.commitTransaction(msg.txId);
                break;
            case 'rejectTransaction':
                this.agentRunner.discardTransaction(msg.txId);
                break;
            case 'quickChangeModel':
                await this.settingsManager.quickChangeModel(msg.model);
                break;
            case 'slashCommand':
                await this.handleSlashCommand(msg.command);
                break;
            case 'permissionResponse':
                this.resolvePermissionRequest(msg.permissionId, msg.allowed, msg.alwaysAllow);
                break;
            case 'openPlanFile':
                // Simply open the plan markdown file in the native VSCode editor
                vs.commands.executeCommand('vscode.open', vs.Uri.file(msg.filePath));
                break;
            case 'submitPlanAnnotations': {
                // Auto-switch to build mode on plan approval and send execution command
                this.switchMode('build');
                // The annotations array gives context on what the user wants changed
                let contextStr = '';
                if (msg.annotations && msg.annotations.length > 0) {
                    contextStr = '\n\n用户批注:\n' + msg.annotations.map((a: { section: string; note: string }) => `- ${a.section}: ${a.note}`).join('\n');
                }
                const prompt = '同意执行。请根据最新生成的计划进行构建。\n\n⚠️ 重要要求：你必须首先使用 `todo_write` 工具将该计划的所有步骤转化为详细的子任务列表（即 task 线路），在开始任何 `write_file` 或其他构建操作之前完成这一步！' + contextStr;
                await this.handleUserMessage(prompt, undefined, undefined, true, true);
                break;
            }
            case 'revisePlanWithAnnotations': {
                let reviseContext = '';
                if (msg.annotations && msg.annotations.length > 0) {
                    reviseContext = '\n\n需要修改的地方批注如下:\n' + msg.annotations.map((a: { section: string; note: string }) => `- ${a.section}: ${a.note}`).join('\n');
                }
                const revisePrompt = '请根据我的批注考虑改进现有的执行计划，重新完善计划。' + reviseContext;
                // keep current mode ('plan'), do not auto-switch since it's just revising
                await this.handleUserMessage(revisePrompt, undefined, undefined, true, true);
                break;
            }
            case 'reviseWalkthroughWithAnnotations': {
                let reviseWtContext = '';
                if (msg.annotations && msg.annotations.length > 0) {
                    reviseWtContext = '\n\n针对报告中需要修改的地方，我的批注（要求）如下:\n' + msg.annotations.map((a: { section: string; note: string }) => `### 针对片段：\n${a.section}\n**要求**：${a.note}`).join('\n\n');
                }
                const reviseWtPrompt = '请根据我的批注，重新修改并输出一份新的 walkthrough.md 报告。' + reviseWtContext;
                await this.handleUserMessage(reviseWtPrompt, undefined, undefined, true, true);
                break;
            }
            case 'approveWalkthrough':
                if (this.previousMode && this.previousMode !== this.currentMode) {
                    this.switchMode(this.previousMode);
                }
                break;
            case 'searchTopics':
                this.topicManager.handleSearchTopics(msg.query);
                break;
            case 'exportTopic':
                await this.topicManager.exportTopicAsMarkdown(msg.topicId);
                break;
            case 'exportTopicJson':
                await this.topicManager.exportTopicAsJson(msg.topicId);
                break;
            case 'importTopic':
                { const msgs = await this.topicManager.importTopicFromJson(msg.data); if (msgs) this.conversationMessages = msgs; };
                break;
            case 'requestFileList':
                this.sendWorkspaceFileList();
                break;
            case 'requestUsageStats':
                this.postMessage({ type: 'usageStats', stats: this.usageTracker.getStats() });
                break;
            case 'promptClearUsageStats':
                vs.window.showWarningMessage('确定要清空所有 Token 消耗统计吗？此操作不可逆转。', '确定清空', '取消').then(sel => {
                    if (sel === '确定清空') {
                        this.usageTracker.clearStats();
                        this.postMessage({ type: 'usageStats', stats: this.usageTracker.getStats() });
                        vs.window.showInformationMessage('Token 消耗统计已清空');
                    }
                });
                break;
            case 'clearUsageStats':
                this.usageTracker.clearStats();
                this.postMessage({ type: 'usageStats', stats: this.usageTracker.getStats() });
                break;
        }
    }

    /**
     * Public API: Send a message to the AI chat programmatically.
     * Used by keyboard shortcuts and command palette commands.
     * Opens the chat panel if it's not visible.
     */
    async sendProgrammaticMessage(text: string): Promise<void> {
        await vs.commands.executeCommand('cwtools.aiChat.focus');
        if (this.view && !this.view.visible) {
            await new Promise<void>(resolve => {
                const d = vs.Disposable.from(
                    this.view!.onDidChangeVisibility(() => {
                        if (this.view!.visible) { d.dispose(); resolve(); }
                    }),
                );
                setTimeout(() => { d.dispose(); resolve(); }, 5000);
            });
        }
        await this.handleUserMessage(text);
    }

    private async handleUserMessage(text: string, images?: string[], _attachedFiles?: string[], skipAutoModeSwitch = false, isBackground = false): Promise<void> {
        if (!text.trim() && (!images || images.length === 0)) return;

        if (text.trim().startsWith('/')) {
            await this.handleSlashCommand(text.trim());
            return;
        }


        // Check if AI is enabled
        const config = this.aiService.getConfig();
        if (!config.enabled) {
            this.postMessage({
                type: 'generationError',
                error: 'AI 功能未启用。请先点击 ⚙️ 配置 AI Provider。',
            });
            return;
        }

        // Ensure we have a topic
        if (!this.topicManager.currentTopic) {
            this.topicManager.createNewTopic(text);
        }

        // Track message index for retract support
        const messageIndex = this.topicManager.currentTopic!.messages.length;

        // Add user message to UI — pass images array directly (not just a bool flag)
        if (!isBackground) {
            this.postMessage({ type: 'addUserMessage', text, messageIndex, images: images?.length ? images : undefined });
        } else {
            this.postMessage({ type: 'startBackgroundGeneration' });
        }

        // Add to history — store images for topic persistence
        this.topicManager.addHistoryMessage({ role: 'user', content: text, timestamp: Date.now(), images: images?.length ? images : undefined, isHidden: isBackground });

        // Get current editor context
        const editor = vs.window.activeTextEditor;
        const context = {
            activeFile: editor?.document.uri.fsPath,
            cursorLine: editor?.selection.active.line,
            cursorColumn: editor?.selection.active.character,
            selectedText: editor?.document.getText(editor.selection),
            fileContent: editor?.document.getText(),
        };

        // Create abort controller
        this.abortController = new AbortController();
        this._isGenerating = true;
        this._liveSteps = [];

        // Collect file snapshots for retract/undo: wire up the tool executor callback
        // for the duration of this message exchange.
        const messageSnapshots: Array<{ filePath: string; previousContent: string | null; _tooLarge?: boolean }> = [];
        // P1-6 Fix: capture conversation length BEFORE message exchange, so retract
        // can slice directly without the fragile `-2` hardcode.
        const convLengthBeforeExchange = this.conversationMessages.length;
        this._currentMessageSnapshots = messageSnapshots;
        this.agentRunner.toolExecutor.onBeforeFileWrite = (filePath, previousContent) => {
            // Only record the first snapshot for each file (earliest = true "before" state)
            if (!messageSnapshots.some(s => s.filePath === filePath)) {
                if (previousContent && previousContent.length > 500000) {
                    vs.window.showWarningMessage(`文件 ${path.basename(filePath)} 过大 (>${previousContent.length} 字符)。为防止内存耗尽，此文件的撤回快照未保存。`);
                    messageSnapshots.push({ filePath, previousContent: null, _tooLarge: true });
                } else {
                    messageSnapshots.push({ filePath, previousContent });
                }
            }
        };

        try {
            const result = await this.agentRunner.run(
                text,
                { ...context, topicId: this.topicManager.currentTopic?.id },
                this.conversationMessages,
                {
                    mode: this.currentMode,
                    model: this.aiService.getConfig().model || undefined,
                    streaming: true,  // Enable typewriter text effect
                    onStep: (step) => {
                        this._liveSteps.push(step);
                        this.postMessage({ type: 'agentStep', step });
                    },
                    abortSignal: this.abortController!.signal,
                    // Permission callback for run_command tool (OpenCode strategy)
                    onPermissionRequest: (id, tool, description, command) =>
                        this.requestPermission(id, tool, description, command),
                },
                images  // pass images to build ContentPart[] user turn
            );

            // ── Update conversation history ───────────────────────────────────────
            // For the user turn: use ContentPart[] if images were sent, otherwise plain text.
            // This ensures the AI has full context in multi-turn conversations.
            const userHistoryContent: import('./types').ChatMessage['content'] =
                images && images.length > 0
                    ? [
                        { type: 'text' as const, text },
                        ...images.map(url => ({ type: 'image_url' as const, image_url: { url, detail: 'auto' as const } })),
                    ]
                    : text;
            const assistantContent = result.code
                ? `${result.explanation}\n\`\`\`pdx\n${result.code}\n\`\`\``
                : result.explanation;
            this.conversationMessages.push(
                { role: 'user', content: userHistoryContent },
                { role: 'assistant', content: assistantContent }
            );

            // ── Plan mode: suppress explanation in chat, auto-open annotation panel ──
            // If the AI is just asking clarification questions (indicated by :::question syntax),
            // it shouldn't lock into an Implementation Plan yet. Treat it as a conversational turn.
            const isJustAskingQuestions = result.explanation && result.explanation.includes(':::question');

            if (this.currentMode === 'plan' && result.explanation && !isJustAskingQuestions) {
                // Chat shows only tool-call steps (no full plan text)
                this.postMessage({ type: 'generationComplete', result: { ...result, explanation: '', code: '' } });
                this.topicManager.addHistoryMessage({
                    role: 'assistant',
                    content: '📋 计划已生成，已在批注视图中打开',
                    timestamp: Date.now(),
                    steps: result.steps,
                });
                void this.savePlanFile(result.explanation, text, result.steps);
            } else {
                this.postMessage({ type: 'generationComplete', result });
                this.topicManager.addHistoryMessage({
                    role: 'assistant',
                    content: result.explanation,
                    code: result.code || undefined,
                    isValid: result.isValid,
                    timestamp: Date.now(),
                    steps: result.steps,
                });
            }
            this.topicManager.saveTopics();

            // ── Check if Walkthrough was generated ──
            const wsRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot) {
                const topicId = this.topicManager.currentTopic?.id || 'default';
                const wtPath = path.join(wsRoot, '.cwtools-ai', topicId, 'walkthrough.md');
                // Use normalize for safter comparisons
                const normWtPath = path.normalize(wtPath).toLowerCase();
                const wroteWalkthrough = this._currentMessageSnapshots.some(s =>
                    path.normalize(s.filePath).toLowerCase() === normWtPath
                );

                if (wroteWalkthrough) {
                    void this.renderWalkthroughUI(wtPath, topicId, result.steps);
                }
            }

            // ── Send token usage stats to UI ────────────────────────────────────
            if (result.tokenUsage && result.tokenUsage.total > 0) {
                const config = this.aiService.getConfig();
                this.usageTracker.addUsage(config.provider, config.model || 'unknown', result.tokenUsage);
                this.postMessage({
                    type: 'tokenUsage',
                    usage: result.tokenUsage,
                    model: config.model,
                });
            }

            // ── Auto-title: generate a short AI title after the first exchange ─
            // Matches OpenCode's title-agent pattern: fire-and-forget, no blocking
            const isFirstExchange = this.topicManager.currentTopic &&
                this.topicManager.currentTopic.messages.filter(m => m.role === 'user').length === 1;
            if (isFirstExchange && this.topicManager.currentTopic) {
                const topicId = this.topicManager.currentTopic.id;
                const replyText = result.explanation || (result.code ? result.code.substring(0, 400) : '');
                // Non-blocking: run in background, update UI when done
                this.agentRunner.generateTopicTitle(text, replyText).then(title => {
                    if (!title) return;
                    const topic = this.topicManager.topics.find(t => t.id === topicId);
                    if (topic) {
                        topic.title = title;
                        this.topicManager.saveTopics();
                        this.postMessage({ type: 'topicTitleGenerated', topicId, title });
                    }
                }).catch(() => { /* ignore title generation failures silently */ });
            }
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            this.postMessage({ type: 'generationError', error: errorMsg });
        } finally {
            // Store file snapshots for this message (keyed by the message index)
            // Also record the conversationMessages length so retractMessage can use the
            // correct slice point (avoids index divergence after fork/load).
            if (messageSnapshots.length > 0) {
                this._messageFileSnapshots.set(messageIndex, {
                    files: messageSnapshots,
                    convLength: convLengthBeforeExchange,
                });

                const MAX_SNAPSHOTS = 20;
                if (this._messageFileSnapshots.size > MAX_SNAPSHOTS) {
                    const keys = Array.from(this._messageFileSnapshots.keys()).sort((a, b) => a - b);
                    const keysToRemove = keys.slice(0, keys.length - MAX_SNAPSHOTS);
                    for (const key of keysToRemove) {
                        this._messageFileSnapshots.delete(key);
                    }
                }
            }
            // Clean up the per-request callback and snapshot pointer
            this.agentRunner.toolExecutor.onBeforeFileWrite = undefined;
            this._currentMessageSnapshots = null;

            // Send diff summary if files were changed
            if (messageSnapshots.length > 0) {
                await this.sendDiffSummary(messageSnapshots);
            }

            this.abortController = null;
            this._isGenerating = false;
            this._liveSteps = [];
        }
    }

    /** Retract a user message, its AI response, AND any file changes made during that exchange */
    private async retractMessage(messageIndex: number): Promise<void> {
        if (!this.topicManager.currentTopic) return;

        // ── P0 Fix: validate file paths are within workspace boundaries ──────
        const workspaceFolders = vs.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
        const isWithinWorkspace = (filePath: string): boolean => {
            if (workspaceFolders.length === 0) return false;
            const normalised = path.resolve(filePath);
            return workspaceFolders.some(root =>
                normalised.startsWith(path.resolve(root) + path.sep) ||
                normalised === path.resolve(root)
            );
        };

        // ── Restore files changed in this message and all subsequent ones ──────
        // Collect indices of all snapshots to undo (≥ messageIndex), sorted newest-first
        // so that if message N wrote file A and message N+1 wrote it again,
        // we undo message N+1 first (restoring "v1"), then message N (restoring original).
        const indicesToUndo = [...this._messageFileSnapshots.keys()]
            .filter(idx => idx >= messageIndex)
            .sort((a, b) => b - a); // descending = newest-first

        // Track which files we've already restored so we don't double-restore
        const restored = new Set<string>();
        let restoredFiles = 0;
        let skippedFiles = 0;

        // Also collect the earliest convLength from all retained snapshots so we
        // can roll back conversationMessages to the right boundary.
        let convRollbackLength: number | undefined;

        for (const idx of indicesToUndo) {
            const entry = this._messageFileSnapshots.get(idx)!;
            const snapshots = entry.files ?? (entry as any); // back-compat if entry is raw array
            const entryConvLength = (entry as any).convLength as number | undefined;
            // We want the earliest (smallest) convLength across all retracted messages
            if (entryConvLength !== undefined) {
                if (convRollbackLength === undefined || entryConvLength < convRollbackLength) {
                    convRollbackLength = entryConvLength;
                }
            };
            // Process in reverse order within the same message too
            for (const snap of [...snapshots].reverse()) {
                if (restored.has(snap.filePath)) continue;
                restored.add(snap.filePath);

                // P0 Fix: reject paths outside workspace to prevent path traversal
                if (!isWithinWorkspace(snap.filePath)) {
                    console.warn(`[Retract] Skipping file outside workspace: ${snap.filePath}`);
                    skippedFiles++;
                    continue;
                }

                if ((snap as any)._tooLarge) {
                    console.warn(`[Retract] Skipping file due to being too large: ${snap.filePath}`);
                    skippedFiles++;
                    continue;
                }

                try {
                    if (snap.previousContent === null) {
                        // File was newly created by AI — delete it (async to avoid blocking)
                        if (fs.existsSync(snap.filePath)) {
                            await fs.promises.unlink(snap.filePath);
                            restoredFiles++;
                        }
                    } else {
                        // File existed before — restore original content (async)
                        await fs.promises.writeFile(snap.filePath, snap.previousContent, 'utf-8');
                        restoredFiles++;
                    }
                } catch (e) {
                    ErrorReporter.warn(SOURCE.CHAT_PANEL, `Failed to restore ${snap.filePath}`, e);
                }
            }
            this._messageFileSnapshots.delete(idx);
        }

        // ── Roll back conversation history ─────────────────────────────────
        // Use the accurately recorded convLength if available; otherwise fall back to
        // using messageIndex (which may diverge from conversationMessages after fork/load).
        this.topicManager.currentTopic.messages = this.topicManager.currentTopic.messages.slice(0, messageIndex);
        if (convRollbackLength !== undefined) {
            // P1-6 Fix: convLength now records the state BEFORE the message exchange,
            // so we slice directly to it without any offset.
            this.conversationMessages = this.conversationMessages.slice(0, convRollbackLength);
        } else {
            // Fallback: best-effort slice by messageIndex
            this.conversationMessages = this.conversationMessages.slice(0, messageIndex);
        }

        this.postMessage({ type: 'messageRetracted', messageIndex });
        this.topicManager.saveTopics();

        if (restoredFiles > 0 || skippedFiles > 0) {
            const msg = skippedFiles > 0
                ? `已撤回消息并恢复 ${restoredFiles} 个文件的更改（${skippedFiles} 个文件因在工作区外被跳过）。`
                : `已撤回消息并恢复 ${restoredFiles} 个文件的更改。`;
            vs.window.showInformationMessage(msg);
        }
    }

    /**
     * Builds a summary of files changed during the current generation
     * and sends it to the WebView.
     */
    private async sendDiffSummary(snapshots: Array<{ filePath: string; previousContent: string | null }>): Promise<void> {
        if (!snapshots || snapshots.length === 0) return;

        const files: Array<{ file: string; status: 'created' | 'modified' | 'deleted'; diffPreview: string }> = [];

        for (const snap of snapshots) {
            const currentContentExists = fs.existsSync(snap.filePath);
            const currentContent = currentContentExists ? await fs.promises.readFile(snap.filePath, 'utf-8').catch((e: any) => {
                if (e.code !== 'ENOENT') console.debug('[cwtools] snapshot read failed:', snap.filePath, e?.message ?? e);
                return null;
            }) : null;

            if (snap.previousContent === null && currentContent !== null) {
                files.push({
                    file: snap.filePath,
                    status: 'created',
                    diffPreview: `+ ${currentContent.split('\n').length} lines added`,
                });
            } else if (snap.previousContent !== null && currentContent === null) {
                files.push({
                    file: snap.filePath,
                    status: 'deleted',
                    diffPreview: `- ${snap.previousContent.split('\n').length} lines removed`,
                });
            } else if (snap.previousContent !== null && currentContent !== null) {
                if (snap.previousContent !== currentContent) {
                    files.push({
                        file: snap.filePath,
                        status: 'modified',
                        diffPreview: `~ File modified`,
                    });
                }
            }
        }

        if (files.length > 0) {
            this.postMessage({ type: 'diffSummary', files });
        }
    }

    // ─── Plan File ───────────────────────────────────────────────────────────

    /**
     * Register a file write into the current message's snapshot (for retract support).
     * Call this BEFORE writing a file that bypasses AgentToolExecutor
     * (e.g. savePlanFile). The file is treated as newly created (previousContent=null)
     * unless it already exists on disk, in which case its current content is captured.
     */
    private _recordFileSnapshot(filePath: string): void {
        const snapshots = this._currentMessageSnapshots;
        if (!snapshots) return;
        if (snapshots.some(s => s.filePath === filePath)) return; // already recorded
        let previousContent: string | null = null;
        try {
            if (fs.existsSync(filePath)) {
                previousContent = fs.readFileSync(filePath, 'utf-8');
            }
        } catch { /* treat as new file */ }
        snapshots.push({ filePath, previousContent });
    }


    private async savePlanFile(planText: string, userPrompt: string, steps?: any[]): Promise<void> {
        // ── Persist .md export ──────────────────────────────────────────────
        const wsRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let filePath = '';
        let relPath = '';
        if (wsRoot) {
            const baseDir = path.join(wsRoot, '.cwtools-ai');
            const topicId = this.topicManager.currentTopic?.id || 'default';
            // Put under topic folder to scope "同一个对话系列" (same conversation series) while keeping exactly "Implementation_Plan.md"
            const planDir = path.join(baseDir, topicId);
            await fs.promises.mkdir(planDir, { recursive: true });

            const fileName = 'Implementation_Plan.md';
            filePath = path.join(planDir, fileName);
            relPath = path.posix.join('.cwtools-ai', topicId, fileName);

            // Register plan file in the current message snapshot so retract can delete it
            this._recordFileSnapshot(filePath);
            await fs.promises.writeFile(filePath, '\uFEFF' + planText, 'utf-8');
        }

        if (filePath) {
            // Post plan file saved card and render interactive annotation UI
            this.postMessage({ type: 'planFileSaved', filePath, relPath });

            const sections: string[] = [];
            let currentSection = '';
            let inCodeBlock = false;
            for (const line of planText.split(/\r?\n/)) {
                if (line.startsWith('```')) {
                    inCodeBlock = !inCodeBlock;
                }
                if (!inCodeBlock && line.match(/^#{1,3}\s/)) {
                    if (currentSection.trim()) sections.push(currentSection.trim());
                    currentSection = line + '\n';
                } else {
                    currentSection += line + '\n';
                }
            }
            if (currentSection.trim()) sections.push(currentSection.trim());
            if (sections.length === 0 && planText.trim()) sections.push(planText.trim());

            this.postMessage({ type: 'renderPlan', sections, planText });

            if (steps) {
                steps.push({ type: 'plan_card', content: filePath, toolResult: sections, timestamp: Date.now() });
            }

        }
    }

    private async renderWalkthroughUI(filePath: string, topicId: string, steps?: any[]) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const relPath = path.posix.join('.cwtools-ai', topicId, 'walkthrough.md');

            this.postMessage({ type: 'walkthroughFileSaved', filePath, relPath });

            const sections: string[] = [];
            let currentSection = '';
            let inCodeBlock = false;
            for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
                if (line.startsWith('```')) {
                    inCodeBlock = !inCodeBlock;
                }
                if (!inCodeBlock && line.match(/^#{1,3}\s/)) {
                    if (currentSection.trim()) sections.push(currentSection.trim());
                    currentSection = line + '\n';
                } else {
                    currentSection += line + '\n';
                }
            }
            if (currentSection.trim()) sections.push(currentSection.trim());
            if (sections.length === 0 && content.trim()) sections.push(content.trim());
            this.postMessage({ type: 'renderWalkthrough', sections });

            if (steps) {
                steps.push({ type: 'walkthrough_card', content: filePath, toolResult: sections, timestamp: Date.now() });
                this.topicManager.saveTopics();
            }

        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to parse walkthrough.md', e);
        }
    }

    // ─── File Write Confirmation ──────────────────────────────────────────────

    private pendingWriteResolvers = new Map<string, (confirmed: boolean) => void>();
    /** Maps messageId → temp file path used for the diff view (for cleanup) */
    private pendingDiffTempFiles = new Map<string, string>();
    /** Auto-deny on timeout (120 s) — prevents hangs if WebView is hidden or user missed the prompt */
    private static readonly WRITE_CONFIRM_TIMEOUT_MS = 120_000;

    handleAutoWritten(file: string, isNewFile: boolean) {
        this.postMessage({
            type: 'autoWriteFile',
            file,
            isNewFile
        });
    }

    handlePendingWrite(file: string, newContent: string, messageId: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            // ── Timeout guard: auto-deny after 120 s ───────────────────────
            // Prevents the agent reasoning loop from hanging indefinitely if the
            // WebView is hidden or the user ignores the confirmation card.
            const timeout = setTimeout(() => {
                if (this.pendingWriteResolvers.has(messageId)) {
                    console.warn(`[Eddy CWTool Code] Write confirm timeout for ${file} — auto-denying (safety default)`);
                    void this.resolveWriteConfirmation(messageId, false);
                }
            }, AIChatPanelProvider.WRITE_CONFIRM_TIMEOUT_MS);

            // Wrap resolver to clear timeout on response
            this.pendingWriteResolvers.set(messageId, (confirmed: boolean) => {
                clearTimeout(timeout);
                resolve(confirmed);
            });

            const isNewFile = !fs.existsSync(file);

            // ── Open VSCode native diff editor ────────────────────────────────
            const workspaceRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const tmpDir = path.join(workspaceRoot, '.cwtools-ai-tmp');
            const ext = path.extname(file) || '.txt';
            const tempPath = path.join(tmpDir, `__pending_${messageId}${ext}`);

            try {
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                fs.writeFileSync(tempPath, newContent, 'utf-8');
                this.pendingDiffTempFiles.set(messageId, tempPath);

                const tempUri = vs.Uri.file(tempPath);
                const label = `AI Changes → ${path.basename(file)}`;

                if (isNewFile) {
                    vs.commands.executeCommand('vscode.open', tempUri, {
                        preview: true,
                        viewColumn: vs.ViewColumn.Beside,
                    });
                } else {
                    vs.commands.executeCommand('vscode.diff',
                        vs.Uri.file(file), tempUri,
                        label,
                        { preview: true, viewColumn: vs.ViewColumn.Active }
                    );
                }
            } catch (e) {
                ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to open diff view', e);
            }

            // Tell the WebView to show a simple Accept/Reject card
            this.postMessage({ type: 'pendingWriteFile', file, messageId, isNewFile });
        });
    }

    async resolveWriteConfirmation(messageId: string, confirmed: boolean): Promise<void> {
        const resolver = this.pendingWriteResolvers.get(messageId);
        if (resolver) {
            this.pendingWriteResolvers.delete(messageId);
            resolver(confirmed);
        }

        // Close the diff/preview tab and remove the temp file
        const tempPath = this.pendingDiffTempFiles.get(messageId);
        if (tempPath) {
            this.pendingDiffTempFiles.delete(messageId);
            const tempUri = vs.Uri.file(tempPath);

            // Close any editor tab that shows our temp file (as either side of diff)
            vs.window.tabGroups.all.forEach(group => {
                group.tabs.forEach(tab => {
                    const input = tab.input;
                    const isOurTab =
                        (input instanceof vs.TabInputText && input.uri.fsPath === tempUri.fsPath) ||
                        (input instanceof vs.TabInputTextDiff && input.modified.fsPath === tempUri.fsPath);
                    if (isOurTab) vs.window.tabGroups.close(tab, true);
                });
            });

            // Fix #5: async delete to avoid blocking extension host
            try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
        }
    }

    /** Push todo update to the WebView (called by toolExecutor.onTodoUpdate) */
    sendTodoUpdate(todos: import('./types').TodoItem[]): void {
        this.postMessage({ type: 'todoUpdate', todos });

        // Natively save task.md in the topic folder
        const wsRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot && todos.length > 0) {
            const topicId = this.topicManager.currentTopic?.id || 'default';
            const taskPath = path.join(wsRoot, '.cwtools-ai', topicId, 'task.md');

            const lines: string[] = ['# Task List\n'];
            for (const t of todos) {
                const mark = t.status === 'done' ? '[x]' : (t.status === 'in_progress' ? '[/]' : '[ ]');
                lines.push(`- ${mark} ${t.content}`);
            }

            // Register task.md in the current message snapshot so retract can delete/restore it
            this._recordFileSnapshot(taskPath);

            void fs.promises.mkdir(path.dirname(taskPath), { recursive: true }).then(() => {
                fs.promises.writeFile(taskPath, lines.join('\n'), 'utf-8').catch((e: any) => console.debug('[cwtools] task.md write failed:', e?.message ?? e));
            });
        }
    }

    // ─── Code Insertion ──────────────────────────────────────────────────────

    private async insertCodeWithDiff(code: string): Promise<void> {
        const editor = vs.window.activeTextEditor;
        if (!editor) {
            vs.window.showWarningMessage(UI.NO_ACTIVE_EDITOR);
            return;
        }

        const document = editor.document;
        const cursorPos = editor.selection.active;

        // Create a preview of the change
        const originalContent = document.getText();
        const lines = originalContent.split('\n');
        const insertLine = cursorPos.line;

        // Insert code at cursor position
        const newLines = [...lines];
        newLines.splice(insertLine + 1, 0, code);
        const newContent = newLines.join('\n');

        // Lazily register a shared ContentProvider (re-registered at most once per panel).
        // Re-using the same scheme+registration avoids accumulating stale providers
        // when the user rapidly clicks "Insert" multiple times.
        const scheme = 'cwtools-ai-preview';
        this._previewContent = newContent;
        if (!this._previewProviderRegistration) {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const self = this;
            this._previewProviderRegistration = vs.workspace.registerTextDocumentContentProvider(
                scheme,
                { provideTextDocumentContent: () => self._previewContent }
            );
        }

        const originalUri = document.uri;
        const previewUri = vs.Uri.parse(`${scheme}:${document.uri.fsPath}?preview`);

        try {
            // Show diff view
            await vs.commands.executeCommand('vscode.diff',
                originalUri,
                previewUri,
                `AI 代码变更预览 - ${path.basename(document.uri.fsPath)}`,
                { preview: true }
            );

            // Ask for confirmation
            const action = await vs.window.showInformationMessage(
                '是否接受 AI 生成的代码变更？',
                { modal: false },
                '✅ 接受',
                '❌ 拒绝'
            );

            if (action === '✅ 接受') {
                // Apply the edit
                const edit = new vs.WorkspaceEdit();
                edit.insert(document.uri, new vs.Position(insertLine + 1, 0), code + '\n');
                await vs.workspace.applyEdit(edit);
                vs.window.showInformationMessage('代码已插入');
            } else {
                vs.window.showInformationMessage(UI.INSERT_CANCELLED);
            }
        } finally {
            // Close the diff editor (preview registration kept alive for next use)
            await vs.commands.executeCommand('workbench.action.closeActiveEditor');
        }
    }

    // ─── Topic Management ────────────────────────────────────────────────────

    private createNewTopic(firstMessage: string): void {
        const title = firstMessage.substring(0, 40) + (firstMessage.length > 40 ? '...' : '');
        this.topicManager.currentTopic = {
            id: `topic_${Date.now()}`,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
        };
        this.conversationMessages = [];
        this.topicManager.topics.unshift(this.topicManager.currentTopic);
    }

    private startNewTopic(): void {
        this.topicManager.startNewTopic();
        this.conversationMessages = [];
        this._messageFileSnapshots.clear();
        this._currentMessageSnapshots = null;
    }

    private loadTopic(topicId: string): void {
        this.conversationMessages = this.topicManager.loadTopic(topicId);
    }

    private deleteTopic(topicId: string): void {
        const wasCurrentDeleted = this.topicManager.deleteTopic(topicId);
        if (wasCurrentDeleted) {
            this.conversationMessages = [];
            this._messageFileSnapshots.clear();
            this._currentMessageSnapshots = null;
        }
    }

    /**
     * Fork a topic at a specific message index (OpenCode-style session fork).
     * Creates a new topic with messages[0..messageIndex], switches to it.
     */
    private forkTopic(topicId: string, messageIndex: number): void {
        this.conversationMessages = this.topicManager.forkTopic(topicId, messageIndex);
    }

    /** Archive/unarchive a topic (hidden from main list but not deleted) */
    private archiveTopic(topicId: string): void {
        const wasCurrentArchived = this.topicManager.archiveTopic(topicId);
        if (wasCurrentArchived) {
            this.conversationMessages = [];
            this._messageFileSnapshots.clear();
            this._currentMessageSnapshots = null;
        }
    }


    private async regenerateLastResponse(): Promise<void> {
        if (!this.topicManager.currentTopic || this.topicManager.currentTopic.messages.length < 2) return;

        // Remove last assistant message
        const lastMsg = this.topicManager.currentTopic.messages[this.topicManager.currentTopic.messages.length - 1];
        if (lastMsg?.role === 'assistant') {
            this.topicManager.currentTopic.messages.pop();
            this.conversationMessages.pop();
        }

        // Re-send the last user message
        const lastUserMsg = this.topicManager.currentTopic.messages[this.topicManager.currentTopic.messages.length - 1];
        if (lastUserMsg?.role === 'user') {
            this.topicManager.currentTopic.messages.pop();
            this.conversationMessages.pop();
            await this.handleUserMessage(lastUserMsg.content);
        }
    }

    private cancelGeneration(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.aiService.cancel();
    }

    /**
     * Handle slash commands from the WebView e.g. /clear, /fork, /mode:build, /init.
     */
    private async handleSlashCommand(command: string): Promise<void> {
        const cmd = command.trim().toLowerCase();
        if (cmd === 'clear' || cmd === '/clear') {
            this.startNewTopic();
        } else if (cmd.startsWith('mode:') || cmd.startsWith('/mode:')) {
            const mode = cmd.split(':')[1] as AgentMode;
            if (['build', 'plan', 'explore', 'general', 'review'].includes(mode)) {
                this.switchMode(mode);
            }
        } else if (cmd === 'fork' || cmd === '/fork') {
            if (this.topicManager.currentTopic && this.topicManager.currentTopic.messages.length > 0) {
                this.forkTopic(this.topicManager.currentTopic.id, this.topicManager.currentTopic.messages.length - 1);
            }
        } else if (cmd === 'archive' || cmd === '/archive') {
            if (this.topicManager.currentTopic) {
                this.archiveTopic(this.topicManager.currentTopic.id);
            }
        } else if (cmd === 'init' || cmd === '/init') {
            await this.generateInitFile();
        }
    }

    /**
     * /init — scans the workspace and generates a CWTOOLS.md project rules file.
     * Mirrors OpenCode's /init command which generates CLAUDE.md.
     * The file is written to the workspace root and loaded into every future session.
     */
    private async generateInitFile(): Promise<void> {
        await generateInitFile(
            (msg) => this.postMessage(msg),
            (filePath) => this._recordFileSnapshot(filePath)
        );
    }


    // ─── Permission System (OpenCode-aligned) ────────────────────────────────────

    private pendingPermissionResolvers = new Map<string, (allowed: boolean) => void>();
    private alwaysAllowRunCommand = false;

    /**
     * Request permission from the user (for run_command tool).
     * Shows a WebView permission card and suspends until user responds.
     * Includes a 60-second timeout that auto-denies.
     */
    private requestPermission(
        id: string,
        tool: string,
        description: string,
        command?: string
    ): Promise<boolean> {
        if (tool === 'run_command' && this.alwaysAllowRunCommand) {
            // Auto-approve if user clicked "Always Allow" in this session
            return Promise.resolve(true);
        }

        return new Promise<boolean>((resolve) => {
            let resolved = false;
            // Auto-deny after 60s to prevent hangs
            const timeout = setTimeout(() => {
                if (!resolved && this.pendingPermissionResolvers.has(id)) {
                    resolved = true;
                    this.pendingPermissionResolvers.delete(id);
                    resolve(false);
                }
            }, 60_000);

            this.pendingPermissionResolvers.set(id, (allowed: boolean) => {
                if (resolved) return; // Guard: timeout already fired
                resolved = true;
                clearTimeout(timeout);
                resolve(allowed);
            });

            this.postMessage({ type: 'permissionRequest', permissionId: id, tool, description, command });
        });
    }

    private resolvePermissionRequest(permissionId: string, allowed: boolean, alwaysAllow?: boolean): void {
        const resolver = this.pendingPermissionResolvers.get(permissionId);
        if (resolver) {
            this.pendingPermissionResolvers.delete(permissionId);
            if (alwaysAllow && allowed) {
                this.alwaysAllowRunCommand = true;
            }
            resolver(allowed);
        }
    }

    private switchMode(mode: AgentMode): void {
        if (this.currentMode !== mode) this.previousMode = this.currentMode;
        this.currentMode = mode;
        this.postMessage({ type: 'modeChanged', mode });
    }




    /**
     * Export a topic as a full JSON file (preserving all metadata and steps).
     */

    /**
     * Import a topic from a JSON string, perform schema validation, and load it.
     */

    // ─── Workspace File List ──────────────────────────────────────────────────

    /**
     * Send the list of workspace files to the WebView for @ mention autocomplete.
     * Limits to 500 files to avoid UI lag; excludes binary/generated directories.
     */
    private sendWorkspaceFileList(): void {
        const root = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            this.postMessage({ type: 'fileList', files: [] });
            return;
        }

        const IGNORE_DIRS = new Set([
            'node_modules', '.git', '.cwtools', '__pycache__',
            'bin', 'obj', '.cwtools-ai-tmp', '.cwtools-ai-exports',
        ]);

        const files: string[] = [];
        const walk = (dir: string) => {
            if (files.length >= 500) return;
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory()) {
                        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                            walk(path.join(dir, entry.name));
                        }
                    } else {
                        const ext = path.extname(entry.name);
                        if (['.txt', '.yml', '.yaml', '.json', '.md', '.ts', '.js', '.csv', '.gfx', '.gui'].includes(ext)) {
                            files.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/'));
                        }
                    }
                }
            } catch { /* skip unreadable dirs */ }
        };
        walk(root);
        this.postMessage({ type: 'fileList', files: files.slice(0, 500) });
    }

    private postMessage(msg: HostMessage): void {
        this.view?.webview.postMessage(msg);
    }

    // ─── HTML Content ────────────────────────────────────────────────────────

    private getHtmlContent(webview: vs.Webview): string {
        return getChatPanelHtml(webview, this.extensionUri);
    }
}
