/**
 * CWTools AI Module — Chat Panel (WebView Host)
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
    ChatTopic,
    ChatHistoryMessage,
    WebViewMessage,
    HostMessage,
    AgentStep,
    AgentMode,
    GenerationResult,
} from './types';
import { AgentRunner } from './agentRunner';
import { AIService } from './aiService';

export class AIChatPanelProvider implements vs.WebviewViewProvider {
    public static readonly viewType = 'cwtools.aiChat';

    private view?: vs.WebviewView;
    private currentTopic: ChatTopic | null = null;
    private topics: ChatTopic[] = [];
    private conversationMessages: ChatMessage[] = [];
    private abortController: AbortController | null = null;
    private currentMode: AgentMode = 'build';

    constructor(
        private extensionUri: vs.Uri,
        private agentRunner: AgentRunner,
        private aiService: AIService,
        private storageUri: vs.Uri | undefined
    ) {
        this.loadTopics();
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
        webviewView.webview.onDidReceiveMessage((msg: WebViewMessage) => {
            this.handleWebViewMessage(msg);
        });

        // Send topic list and initial model data on load
        this.sendTopicList();
        // Push provider/model list immediately so the quick selector is populated
        this.buildAndSendSettingsData().catch(() => { /* ignore on startup */ });
        // Restore current conversation if any
        if (this.currentTopic && this.currentTopic.messages.length > 0) {
            this.postMessage({ type: 'loadTopicMessages', messages: this.currentTopic.messages });
        }
    }

    // ─── Message Handling ────────────────────────────────────────────────────

    private async handleWebViewMessage(msg: WebViewMessage): Promise<void> {
        switch (msg.type) {
            case 'sendMessage':
                await this.handleUserMessage(msg.text);
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
            case 'configureProvider':
            case 'openSettings':
                await this.openSettingsPage();
                break;
            case 'saveSettings':
                await this.saveSettings(msg.settings);
                break;
            case 'detectOllamaModels':
                await this.detectOllamaModels(msg.endpoint);
                break;
            case 'testConnection':
                await this.testConnection(msg.settings);
                break;
            case 'cancelGeneration':
                this.cancelGeneration();
                break;
            case 'switchMode':
                this.switchMode(msg.mode);
                break;
            case 'retractMessage':
                this.retractMessage(msg.messageIndex);
                break;
            case 'confirmWriteFile':
                this.resolveWriteConfirmation(msg.messageId, true);
                break;
            case 'cancelWriteFile':
                this.resolveWriteConfirmation(msg.messageId, false);
                break;
            case 'quickChangeModel':
                await this.quickChangeModel(msg.model);
                break;
        }
    }

    /** Build the settingsData payload and send it to the WebView (no UI activation side-effect) */
    private async buildAndSendSettingsData(showPanel = false): Promise<void> {
        const { BUILTIN_PROVIDERS, fetchOllamaModels } = await import('./providers');
        const config = this.aiService.getConfig();

        const providers = Object.values(BUILTIN_PROVIDERS).map(p => ({
            id: p.id,
            name: p.name,
            models: p.models,
            defaultModel: p.defaultModel,
            requiresApiKey: p.id !== 'ollama',
            defaultEndpoint: p.endpoint,
        }));

        const hasKeyMap: Record<string, boolean> = {};
        for (const p of providers) {
            hasKeyMap[p.id] = !!(await this.aiService.getKeyForProvider(p.id));
        }

        const current: import('./types').PanelSettings = {
            provider: config.provider,
            model: config.model,
            apiKey: '',
            endpoint: config.endpoint || '',
            maxContextTokens: config.maxContextTokens,
            agentFileWriteMode: config.agentFileWriteMode,
            inlineCompletion: {
                enabled: config.inlineCompletion.enabled,
                provider: config.inlineCompletion.provider,
                model: config.inlineCompletion.model,
                endpoint: config.inlineCompletion.endpoint,
                debounceMs: config.inlineCompletion.debounceMs,
            },
        };

        let ollamaModels: Array<{ name: string; size: string; parameterSize?: string }> | undefined;
        if (config.provider === 'ollama') {
            const ep = config.endpoint || BUILTIN_PROVIDERS['ollama']?.endpoint;
            if (ep) ollamaModels = await fetchOllamaModels(ep);
        }

        this.postMessage({
            type: 'settingsData', providers: providers.map(p => ({
                ...p,
                hasKey: hasKeyMap[p.id] ?? false,
            })) as any, current, ollamaModels, showPanel
        });
    }

    private async openSettingsPage(): Promise<void> {
        await this.buildAndSendSettingsData(true);
    }

    /** Quickly switch model from the input-area selector without opening settings page */
    private async quickChangeModel(model: string): Promise<void> {
        if (!model) return;
        // Use in-memory override ONLY — writing to workspace config triggers cwtools LS restart
        this.aiService.setModelOverride(model);
        // Sync selector UI without opening settings page
        await this.buildAndSendSettingsData();
    }

    private async saveSettings(settings: import('./types').PanelSettings): Promise<void> {
        const cfg = vs.workspace.getConfiguration('cwtools.ai');
        await cfg.update('provider', settings.provider, vs.ConfigurationTarget.Global);
        await cfg.update('model', settings.model, vs.ConfigurationTarget.Global);
        // API key: store in SecretStorage, NEVER in settings.json
        if (settings.apiKey && settings.apiKey.trim().length > 0) {
            await this.aiService.getKeyManager().setKey(settings.provider, settings.apiKey.trim());
            // Ensure plaintext key is cleared from settings.json
            await cfg.update('apiKey', '', vs.ConfigurationTarget.Global);
        }
        await cfg.update('endpoint', settings.endpoint, vs.ConfigurationTarget.Global);
        await cfg.update('maxContextTokens', settings.maxContextTokens, vs.ConfigurationTarget.Global);
        await cfg.update('agentFileWriteMode', settings.agentFileWriteMode, vs.ConfigurationTarget.Global);
        await cfg.update('enabled', true, vs.ConfigurationTarget.Global);
        // Inline completion settings
        if (settings.inlineCompletion) {
            await cfg.update('inlineCompletion.enabled', settings.inlineCompletion.enabled, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.provider', settings.inlineCompletion.provider, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.model', settings.inlineCompletion.model, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.endpoint', settings.inlineCompletion.endpoint, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.debounceMs', settings.inlineCompletion.debounceMs, vs.ConfigurationTarget.Global);
        }
        vs.window.showInformationMessage('CWTools AI 设置已保存');
        // Immediately push fresh settings data (with updated hasKey) back to the WebView
        await this.openSettingsPage();
    }

    private async detectOllamaModels(endpoint: string): Promise<void> {
        const { fetchOllamaModels } = await import('./providers');
        const models = await fetchOllamaModels(endpoint || 'http://localhost:11434/v1');
        if (models.length > 0) {
            this.postMessage({ type: 'ollamaModels', models });
        } else {
            this.postMessage({ type: 'ollamaModels', models: [], error: '未检测到 Ollama 模型，请确认 Ollama 正在运行' });
        }
    }

    private async testConnection(settings?: import('./types').PanelSettings): Promise<void> {
        const { getEffectiveEndpoint } = await import('./providers');
        const saved = this.aiService.getConfig();
        const providerId = settings?.provider ?? saved.provider;
        const apiKey = settings?.apiKey ?? saved.apiKey;
        const endpoint = settings?.endpoint || getEffectiveEndpoint(providerId, saved.endpoint);
        const model = settings?.model || undefined;

        if (!providerId) {
            this.postMessage({ type: 'testConnectionResult', ok: false, message: '请先选择 Provider' });
            return;
        }
        if (providerId !== 'ollama' && !apiKey) {
            this.postMessage({ type: 'testConnectionResult', ok: false, message: '请填写 API Key' });
            return;
        }

        try {
            await this.aiService.chatCompletion(
                [{ role: 'user', content: 'Hi' }],
                { maxTokens: 5, providerId, model, apiKey, endpoint }
            );
            this.postMessage({ type: 'testConnectionResult', ok: true, message: '连接成功 ✅' });
        } catch (e: unknown) {
            const raw = e instanceof Error ? e.message : String(e);
            let friendly = raw;
            if (raw.includes('fetch failed') || raw.includes('ECONNREFUSED') || raw.includes('ETIMEDOUT')) {
                friendly = '网络连接失败 — 请检查网络或 Endpoint 地址是否正确';
            } else if (raw.includes('401') || raw.includes('Unauthorized') || raw.includes('invalid_api_key')) {
                friendly = 'API Key 无效或已过期';
            } else if (raw.includes('403') || raw.includes('Forbidden')) {
                friendly = 'API Key 权限不足';
            } else if (raw.includes('429')) {
                friendly = '请求过于频繁 (429) — Key 有效 ✅';
            } else if (raw.includes('404')) {
                friendly = 'Endpoint 地址不存在 (404) — 请检查 URL';
            }
            this.postMessage({ type: 'testConnectionResult', ok: false, message: '连接失败: ' + friendly });
        }
    }

    private async handleUserMessage(text: string): Promise<void> {
        if (!text.trim()) return;

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
        if (!this.currentTopic) {
            this.createNewTopic(text);
        }

        // Track message index for retract support
        const messageIndex = this.currentTopic!.messages.length;

        // Add user message to UI (with message index for retract)
        this.postMessage({ type: 'addUserMessage', text, messageIndex });

        // Add to history
        this.addHistoryMessage({ role: 'user', content: text, timestamp: Date.now() });

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

        try {
            const result = await this.agentRunner.run(
                text,
                context,
                this.conversationMessages,
                {
                    mode: this.currentMode,
                    onStep: (step) => this.postMessage({ type: 'agentStep', step }),
                    abortSignal: this.abortController.signal,
                }
            );

            this.postMessage({ type: 'generationComplete', result });

            // Update conversation history
            const assistantContent = result.code
                ? `${result.explanation}\n\`\`\`pdx\n${result.code}\n\`\`\``
                : result.explanation;

            this.conversationMessages.push(
                { role: 'user', content: text },
                { role: 'assistant', content: assistantContent }
            );

            this.addHistoryMessage({
                role: 'assistant',
                content: result.explanation,
                code: result.code || undefined,
                isValid: result.isValid,
                timestamp: Date.now(),
                steps: result.steps,
            });

            this.saveTopics();
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            this.postMessage({ type: 'generationError', error: errorMsg });
        } finally {
            this.abortController = null;
        }
    }

    /** Retract a user message and its subsequent AI response */
    private retractMessage(messageIndex: number): void {
        if (!this.currentTopic) return;

        // Remove messages from messageIndex onwards in the topic
        this.currentTopic.messages = this.currentTopic.messages.slice(0, messageIndex);
        // Also roll back conversationMessages
        this.conversationMessages = this.conversationMessages.slice(0, messageIndex);

        this.postMessage({ type: 'messageRetracted', messageIndex });
        this.saveTopics();
    }

    // ─── File Write Confirmation (提供给 AgentToolExecutor onPendingWrite) ───────────

    private pendingWriteResolvers = new Map<string, (confirmed: boolean) => void>();

    handlePendingWrite(file: string, diff: string, messageId: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.pendingWriteResolvers.set(messageId, resolve);
            this.postMessage({ type: 'pendingWriteFile', file, diff, messageId });
        });
    }

    resolveWriteConfirmation(messageId: string, confirmed: boolean): void {
        const resolver = this.pendingWriteResolvers.get(messageId);
        if (resolver) {
            this.pendingWriteResolvers.delete(messageId);
            resolver(confirmed);
        }
    }

    // ─── Code Insertion ──────────────────────────────────────────────────────

    private async insertCodeWithDiff(code: string): Promise<void> {
        const editor = vs.window.activeTextEditor;
        if (!editor) {
            vs.window.showWarningMessage('没有打开的编辑器');
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

        // Show diff in a virtual document
        const originalUri = document.uri;
        const scheme = 'cwtools-ai-preview';
        const previewUri = vs.Uri.parse(`${scheme}:${document.uri.fsPath}?preview`);

        // Register a content provider for the preview
        const provider = new (class implements vs.TextDocumentContentProvider {
            provideTextDocumentContent(): string {
                return newContent;
            }
        })();
        const registration = vs.workspace.registerTextDocumentContentProvider(scheme, provider);

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
                vs.window.showInformationMessage('已取消插入');
            }
        } finally {
            registration.dispose();
            // Close the diff editor
            await vs.commands.executeCommand('workbench.action.closeActiveEditor');
        }
    }

    // ─── Topic Management ────────────────────────────────────────────────────

    private createNewTopic(firstMessage: string): void {
        const title = firstMessage.substring(0, 40) + (firstMessage.length > 40 ? '...' : '');
        this.currentTopic = {
            id: `topic_${Date.now()}`,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
        };
        this.conversationMessages = [];
        this.topics.unshift(this.currentTopic);
    }

    private startNewTopic(): void {
        this.currentTopic = null;
        this.conversationMessages = [];
        this.postMessage({ type: 'clearChat' });
        this.sendTopicList();
    }

    private loadTopic(topicId: string): void {
        const topic = this.topics.find(t => t.id === topicId);
        if (!topic) return;

        this.currentTopic = topic;
        this.conversationMessages = topic.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({
                role: m.role,
                content: m.code ? `${m.content}\n\`\`\`pdx\n${m.code}\n\`\`\`` : m.content,
            }));

        this.postMessage({ type: 'clearChat' });
        this.postMessage({ type: 'loadTopicMessages', messages: topic.messages });
    }

    private deleteTopic(topicId: string): void {
        this.topics = this.topics.filter(t => t.id !== topicId);
        if (this.currentTopic?.id === topicId) {
            this.startNewTopic();
        }
        this.saveTopics();
        this.sendTopicList();
    }

    private addHistoryMessage(msg: ChatHistoryMessage): void {
        if (this.currentTopic) {
            this.currentTopic.messages.push(msg);
            this.currentTopic.updatedAt = Date.now();
        }
    }

    private async regenerateLastResponse(): Promise<void> {
        if (!this.currentTopic || this.currentTopic.messages.length < 2) return;

        // Remove last assistant message
        const lastMsg = this.currentTopic.messages[this.currentTopic.messages.length - 1];
        if (lastMsg.role === 'assistant') {
            this.currentTopic.messages.pop();
            this.conversationMessages.pop();
        }

        // Re-send the last user message
        const lastUserMsg = this.currentTopic.messages[this.currentTopic.messages.length - 1];
        if (lastUserMsg?.role === 'user') {
            this.currentTopic.messages.pop();
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

    private switchMode(mode: AgentMode): void {
        this.currentMode = mode;
        this.postMessage({ type: 'modeChanged', mode });
    }

    // ─── Persistence ─────────────────────────────────────────────────────────

    private get topicsFilePath(): string | undefined {
        if (!this.storageUri) return undefined;
        return path.join(this.storageUri.fsPath, 'ai-chat-topics.json');
    }

    private loadTopics(): void {
        const filePath = this.topicsFilePath;
        if (!filePath) return;
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                this.topics = JSON.parse(data);
            }
        } catch { /* ignore */ }
    }

    private saveTopics(): void {
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

    private sendTopicList(): void {
        this.postMessage({
            type: 'topicList',
            topics: this.topics.map(t => ({
                id: t.id,
                title: t.title,
                updatedAt: t.updatedAt,
            })),
        });
    }

    private postMessage(msg: HostMessage): void {
        this.view?.webview.postMessage(msg);
    }

    // ─── HTML Content ────────────────────────────────────────────────────────

    private getHtmlContent(webview: vs.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vs.Uri.joinPath(this.extensionUri, 'bin', 'client', 'webview', 'chatPanel.js')
        );
        const csp = webview.cspSource;
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp};">
<title>CWTools AI</title>
<style>
:root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #cccccc);
    --border: var(--vscode-panel-border, #333);
    --input-bg: var(--vscode-input-background, #252525);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --btn-hover: var(--vscode-list-hoverBackground, #2a2d2e);
    --accent: #d95a43;
    --success: #4caf50;
    --error: #f44336;
    --warning: #ff9800;
    --code-bg: var(--vscode-textCodeBlock-background, #1a1a1a);
    --thinking-bg: rgba(100,149,237,0.06);
    --thinking-border: rgba(100,149,237,0.25);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: var(--vscode-font-size, 13px); color: var(--fg); background: var(--bg); height: 100vh; display: flex; flex-direction: column; overflow: hidden; line-height: 1.5; }

/* ── Header ── */
.header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.header-title { display: flex; align-items: center; gap: 6px; }
.header-brand-icon { width: 16px; height: 16px; flex-shrink: 0; }
.brand-text { font-family: Georgia, Cambria, serif; font-size: 14px; font-weight: 500; letter-spacing: 0.5px; color: #ececec; }
.header-actions { display: flex; gap: 2px; }
.icon-btn { background: none; border: none; color: var(--fg); cursor: pointer; padding: 4px 7px; border-radius: 4px; font-size: 14px; opacity: 0.6; transition: opacity 0.15s, background 0.15s; font-weight: 300; }
.icon-btn:hover { opacity: 1; background: var(--btn-hover); }

/* ── Topics panel ── */
.topics-panel { display: none; position: absolute; top: 41px; left: 0; right: 0; bottom: 70px; background: var(--bg); border: 1px solid var(--border); z-index: 100; overflow-y: auto; }
.topics-panel.show { display: flex; flex-direction: column; }
.topics-panel-header { padding: 8px 8px 4px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.new-topic-btn { width: 100%; background: none; border: 1px dashed var(--border); border-radius: 5px; color: var(--fg); cursor: pointer; padding: 6px 10px; font-size: 12px; text-align: left; opacity: 0.7; display: flex; align-items: center; gap: 5px; transition: opacity 0.15s, background 0.15s; }
.new-topic-btn:hover { opacity: 1; background: var(--btn-hover); border-color: var(--accent); }
.topics-list { flex: 1; overflow-y: auto; padding: 6px 8px 8px; }
.topic-item { padding: 8px; cursor: pointer; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
.topic-item:hover { background: var(--btn-hover); }
.topic-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.topic-delete { opacity: 0; cursor: pointer; color: var(--error); padding: 2px 6px; font-size: 12px; border-radius: 3px; background: none; border: none; }
.topic-item:hover .topic-delete { opacity: 0.7; }
.topic-delete:hover { opacity: 1 !important; background: rgba(244,67,54,0.1); }

/* ── Indicators ── */
.plan-indicator { display: none; padding: 5px 16px; font-size: 11px; color: cornflowerblue; background: rgba(100,149,237,0.07); border-bottom: 1px solid var(--border); text-align: center; }
body.plan-mode .plan-indicator { display: block; }
.todo-panel { display: none; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.todo-panel.has-items { display: block; }
.todo-panel-title { font-size: 10px; font-weight: 600; opacity: 0.5; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
.todo-item { font-size: 12px; padding: 2px 0; display: flex; align-items: flex-start; gap: 6px; }
.todo-item.done { opacity: 0.4; text-decoration: line-through; }
.todo-item.in_progress { color: var(--accent); }

/* ── Chat area ── */
.chat-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.message { display: flex; flex-direction: column; animation: fadeIn 0.2s ease; }
.msg-header { display: flex; align-items: center; gap: 5px; margin-bottom: 5px; font-size: 12px; font-family: Georgia, serif; opacity: 0.8; }
.msg-bubble { line-height: 1.6; word-break: break-word; }
.msg-bubble code { background: rgba(255,255,255,0.1); border-radius: 3px; padding: 0 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.msg-bubble pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; overflow-x: auto; margin: 6px 0; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
.msg-bubble pre code { background: none; padding: 0; }
.retract-btn { display: none; background: none; border: none; cursor: pointer; font-size: 11px; opacity: 0.4; padding: 2px 5px; border-radius: 3px; color: var(--fg); margin-top: 3px; }
.message.user:hover .retract-btn { display: inline-flex; }
.retract-btn:hover { opacity: 1; background: var(--btn-hover); }
.message.retracted .msg-bubble { opacity: 0.4; font-style: italic; pointer-events: none; }
.message.retracted .retract-btn { display: none !important; }

/* ── Thinking block ── */
.thinking-block { margin: 4px 0; border: 1px solid var(--thinking-border); border-radius: 6px; overflow: hidden; font-size: 11px; background: var(--thinking-bg); }
.thinking-block > summary { cursor: pointer; padding: 5px 10px; user-select: none; display: flex; align-items: center; gap: 6px; list-style: none; color: cornflowerblue; opacity: 0.85; }
.thinking-block > summary::-webkit-details-marker { display: none; }
.thinking-block > summary::before { content: '▶'; font-size: 9px; opacity: 0.5; transition: transform 0.15s; flex-shrink: 0; }
.thinking-block[open] > summary::before { transform: rotate(90deg); }
.thinking-body { padding: 8px 10px; border-top: 1px solid var(--thinking-border); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; opacity: 0.75; max-height: 300px; overflow-y: auto; }

/* ── Tool group ── */
.tool-group { margin: 4px 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; font-size: 11px; }
.tool-group > summary { cursor: pointer; padding: 5px 10px; background: rgba(255,255,255,0.03); user-select: none; display: flex; align-items: center; gap: 6px; list-style: none; }
.tool-group > summary::-webkit-details-marker { display: none; }
.tool-group > summary::before { content: '▶'; font-size: 9px; opacity: 0.4; transition: transform 0.15s; flex-shrink: 0; }
.tool-group[open] > summary::before { transform: rotate(90deg); }
.tool-group-body { padding: 6px 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 3px; }
.step { font-size: 11px; padding: 2px 0; opacity: 0.7; display: flex; align-items: flex-start; gap: 5px; }
.step.tool_call .step-icon { color: var(--accent); }
.step.error .step-icon { color: var(--error); }
.step.validation .step-icon { color: var(--success); }

/* ── Code block ── */
.code-block { background: var(--code-bg); border: 1px solid var(--border); border-radius: 4px; margin: 6px 0; overflow: hidden; }
.code-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: rgba(255,255,255,0.04); border-bottom: 1px solid var(--border); font-size: 11px; }
.code-status.valid { color: var(--success); }
.code-status.invalid { color: var(--error); }
.code-actions { display: flex; gap: 4px; }
.code-btn { background: none; color: var(--fg); border: 1px solid var(--border); padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 10px; opacity: 0.7; }
.code-btn:hover { opacity: 1; background: var(--btn-hover); }
.code-content { padding: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow-x: auto; white-space: pre; }

/* ── Diff card ── */
.diff-card { border: 1px solid var(--warning); border-radius: 6px; overflow: hidden; margin: 4px 0; font-size: 11px; }
.diff-card-header { background: rgba(255,152,0,0.12); padding: 6px 10px; font-size: 11px; font-family: Georgia, serif; opacity: 0.85; }
.diff-card-body { padding: 8px 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; background: var(--code-bg); max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
.diff-add { color: #4caf50; }
.diff-del { color: #f44336; }
.diff-card-actions { padding: 6px 10px; display: flex; gap: 6px; background: var(--bg); }
.diff-accept-btn { background: #4caf50; color: #fff; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 11px; }
.diff-reject-btn { background: none; border: 1px solid var(--border); color: var(--fg); border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 11px; }

/* ── Empty state ── */
.empty-state { margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; opacity: 0.65; padding: 40px 20px; gap: 6px; }
.empty-icon { font-size: 40px; color: var(--accent); margin-bottom: 12px; }

/* ── Input area ── */
.input-wrapper { padding: 10px 12px; flex-shrink: 0; }
.input-container { background: var(--input-bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; transition: border-color 0.15s; }
.input-container:focus-within { border-color: #555; }
.input-row { display: flex; padding: 6px 10px 2px; }
.input-row textarea { flex: 1; background: transparent; color: var(--input-fg); border: none; padding: 4px 0; font-family: inherit; font-size: 13px; resize: none; min-height: 22px; max-height: 150px; outline: none; line-height: 1.5; }
.input-row textarea::placeholder { opacity: 0.35; }
.input-controls { display: flex; justify-content: space-between; align-items: center; padding: 2px 8px 8px; }
.ctrl-group { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
.send-btn { background: none; color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 15px; line-height: 1; transition: background 0.1s; }
.send-btn:hover { background: var(--btn-hover); }
.send-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.cancel-btn { color: var(--error); border-color: var(--error); }
.mode-btn { background: none; border: 1px solid transparent; color: var(--fg); cursor: pointer; padding: 3px 8px; font-size: 11px; border-radius: 3px; opacity: 0.5; display: flex; align-items: center; gap: 3px; transition: all 0.15s; flex-shrink: 0; }
.mode-btn:hover { opacity: 0.85; background: var(--btn-hover); }
.model-selector { flex: 1; min-width: 0; max-width: 160px; background: transparent; color: var(--fg); border: none; font-size: 11px; cursor: pointer; opacity: 0.55; padding: 2px 2px; outline: none; font-family: inherit; overflow: hidden; text-overflow: ellipsis; transition: opacity 0.15s; }
.model-selector:hover { opacity: 0.9; }
.model-selector option { background: var(--input-bg); color: var(--fg); }
.mode-btn.active { opacity: 1; border-color: var(--border); background: var(--btn-hover); }

/* ── Settings page ── */
.settings-page { display: none; flex-direction: column; height: 100%; overflow: hidden; }
.settings-page.active { display: flex; }
.settings-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.settings-back-btn { background: none; border: none; color: var(--fg); cursor: pointer; font-size: 16px; padding: 0 4px; opacity: 0.7; line-height: 1; }
.settings-back-btn:hover { opacity: 1; }
.settings-body { padding: 12px; display: flex; flex-direction: column; gap: 12px; flex: 1; overflow-y: auto; }
.settings-title { font-size: 13px; font-weight: 600; }
.settings-group { display: flex; flex-direction: column; gap: 5px; }
.settings-label { font-size: 11px; font-weight: 600; opacity: 0.75; letter-spacing: 0.03em; }
.settings-input, .settings-select { background: var(--input-bg); border: 1px solid var(--border); color: var(--fg); border-radius: 5px; padding: 6px 8px; font-size: 12px; width: 100%; outline: none; font-family: inherit; }
.settings-input:focus, .settings-select:focus { border-color: var(--accent); }
.settings-select option { background: var(--bg); }
.settings-key-row { display: flex; gap: 6px; }
.settings-key-row .settings-input { flex: 1; }
.key-toggle-btn { background: var(--input-bg); border: 1px solid var(--border); color: var(--fg); border-radius: 5px; padding: 0 8px; cursor: pointer; font-size: 13px; flex-shrink: 0; }
.model-row { display: flex; gap: 6px; }
.model-row .settings-input, .model-row .settings-select { flex: 1; }
.detect-btn { background: none; color: var(--fg); border: 1px solid var(--border); border-radius: 5px; padding: 0 10px; cursor: pointer; font-size: 11px; flex-shrink: 0; white-space: nowrap; }
.detect-btn:hover { background: var(--btn-hover); }
.detect-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.settings-hint { font-size: 10px; opacity: 0.45; margin-top: 2px; }
.settings-footer { padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; border-top: 1px solid var(--border); flex-shrink: 0; }
.settings-save-btn { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 8px; cursor: pointer; font-size: 13px; font-weight: 600; width: 100%; }
.settings-save-btn:hover { opacity: 0.9; }
.settings-test-btn { background: none; color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 7px; cursor: pointer; font-size: 12px; width: 100%; }
.settings-test-btn:hover { border-color: var(--accent); }
.test-result { font-size: 11px; text-align: center; padding: 4px; border-radius: 4px; display: none; }
.test-result.ok { background: rgba(80,200,80,0.15); color: #5c5; display: block; }
.test-result.fail { background: rgba(200,80,80,0.15); color: #e66; display: block; }
.accordion-section { border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
.accordion-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; cursor: pointer; font-size: 12px; font-weight: 600; user-select: none; background: rgba(255,255,255,0.02); }
.accordion-header:hover { background: rgba(255,255,255,0.05); }
.accordion-arrow { font-size: 9px; opacity: 0.4; transition: transform 0.15s; }
.accordion-section.open .accordion-arrow { transform: rotate(90deg); }
.accordion-body { display: none; padding: 10px 12px; border-top: 1px solid var(--border); flex-direction: column; gap: 10px; }
.accordion-section.open .accordion-body { display: flex; }
.settings-toggle-row { display: flex; align-items: center; justify-content: space-between; }
.settings-toggle-label { font-size: 12px; }
.toggle-switch { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
.toggle-switch input { opacity: 0; width: 0; height: 0; }
.toggle-track { position: absolute; cursor: pointer; inset: 0; background: var(--border); border-radius: 20px; transition: 0.2s; }
.toggle-switch input:checked + .toggle-track { background: var(--accent); }
.toggle-track::before { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
.toggle-switch input:checked + .toggle-track::before { transform: translateX(16px); }
</style>
</head>
<body>
<div class="header">
    <div class="header-title">
        <svg class="header-brand-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
            <path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/>
            <circle fill="#e8c840" cx="13" cy="3" r="1"/>
        </svg>
        <span class="brand-text">CWTools AI</span>
    </div>
    <div class="header-actions">
        <button class="icon-btn" id="btnNewTopic" title="新话题">+</button>
        <button class="icon-btn" id="btnTopics" title="历史话题">≡</button>
        <button class="icon-btn" id="btnSettings" title="设置">⋯</button>
    </div>
</div>

<div class="topics-panel" id="topicsPanel">
    <div class="topics-panel-header">
        <button class="new-topic-btn" id="btnNewTopicPanel">＋ 新话题</button>
    </div>
    <div class="topics-list" id="topicsList"></div>
</div>
<div class="plan-indicator" id="planIndicator">📋 Plan Mode — 只读分析，不修改文件</div>
<div class="todo-panel" id="todoPanel">
    <div class="todo-panel-title">Tasks</div>
    <div id="todoList"></div>
</div>

<div class="chat-area" id="chatArea">
    <div class="empty-state" id="emptyState">
        <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg></div>
        <div style="font-size:13px;font-family:Georgia,serif;">CWTools AI Assistant</div>
        <div style="font-size:11px;margin-top:2px;">描述你的需求，AI 将生成并验证 Paradox 脚本</div>
    </div>
</div>

<div class="input-wrapper">
    <div class="input-container">
        <div class="input-row">
            <textarea id="input" placeholder="描述你的需求..." rows="1"></textarea>
        </div>
        <div class="input-controls">
            <div class="ctrl-group">
                <button class="mode-btn active" id="buildModeBtn" title="Build 模式 — 生成并修改代码">📝 Build</button>
                <button class="mode-btn" id="planModeBtn" title="Plan 模式 — 只读分析">📋 Plan</button>
                <select class="model-selector" id="quickModelSelect" title="当前模型"></select>
            </div>
            <button class="send-btn" id="sendBtn">↑</button>
        </div>
    </div>
</div>

<!-- Settings Page -->
<div class="settings-page" id="settingsPage">
    <div class="settings-header">
        <button class="settings-back-btn" id="settingsBackBtn">←</button>
        <span class="settings-title">⚙ AI 设置</span>
    </div>
    <div class="settings-body">
        <div class="accordion-section open" id="chatModelSection">
            <div class="accordion-header" id="accChat"><span>🤖 对话模型</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <label class="settings-label">Provider</label>
                    <select class="settings-select" id="settingsProvider"></select>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Model</label>
                    <div class="model-row">
                        <select class="settings-select" id="settingsModelSelect" style="display:none"></select>
                        <input class="settings-input" id="settingsModelInput" type="text" placeholder="model-name" />
                        <button class="detect-btn" id="detectBtn" style="display:none">🔍 检测</button>
                    </div>
                    <div class="settings-hint" id="modelHint"></div>
                </div>
                <div class="settings-group" id="apiKeyGroup">
                    <label class="settings-label">🔑 API Key</label>
                    <div class="settings-hint" id="apiKeyStatus" style="color:#4caf50;margin-bottom:3px;"></div>
                    <div class="settings-key-row">
                        <input class="settings-input" id="settingsApiKey" type="password" placeholder="输入新 Key（留空保留已有）" autocomplete="off" />
                        <button class="key-toggle-btn" id="keyToggleBtn">👁</button>
                    </div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">🌐 Endpoint <span style="opacity:0.5;font-weight:400">(可选)</span></label>
                    <input class="settings-input" id="settingsEndpoint" type="text" placeholder="留空使用默认" />
                    <div class="settings-hint" id="endpointHint"></div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">📏 上下文大小 (tokens)</label>
                    <input class="settings-input" id="settingsCtx" type="number" min="0" placeholder="0 = provider 默认" />
                </div>
            </div>
        </div>
        <div class="accordion-section" id="inlineSection">
            <div class="accordion-header" id="accInline"><span>✏️ 补全模型</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-toggle-row">
                    <span class="settings-toggle-label">启用 AI 补全</span>
                    <label class="toggle-switch"><input type="checkbox" id="inlineEnabled"><span class="toggle-track"></span></label>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Provider</label>
                    <select class="settings-select" id="inlineProvider"><option value="">- 与对话相同 -</option></select>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Model</label>
                    <select class="settings-select" id="inlineModel"></select>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Endpoint</label>
                    <input class="settings-input" id="inlineEndpoint" type="text" placeholder="留空与对话相同" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">防抖延迟 (ms)</label>
                    <input class="settings-input" id="inlineDebounce" type="number" min="100" step="100" placeholder="1500" />
                </div>
            </div>
        </div>
        <div class="accordion-section" id="agentSection">
            <div class="accordion-header" id="accAgent"><span>🛡️ Agent 设置</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <label class="settings-label">文件写入模式</label>
                    <select class="settings-select" id="agentWriteMode">
                        <option value="confirm">确认模式 — 写操作前 diff 确认（推荐）</option>
                        <option value="auto">自动模式 — 直接写入（高级）</option>
                    </select>
                </div>
            </div>
        </div>
    </div>
    <div class="settings-footer">
        <div class="test-result" id="testResult"></div>
        <button class="settings-test-btn" id="testConnBtn">🧪 测试连接</button>
        <button class="settings-save-btn" id="saveSettingsBtn">💾 保存设置</button>
    </div>
</div>

<script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
