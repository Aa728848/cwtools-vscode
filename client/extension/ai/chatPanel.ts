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

        // Send topic list on load
        this.sendTopicList();
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
        }
    }

    private async openSettingsPage(): Promise<void> {
        const { BUILTIN_PROVIDERS } = await import('./providers');
        const { fetchOllamaModels } = await import('./providers');
        const config = this.aiService.getConfig();

        // Build provider metadata list for WebView
        const providers = Object.values(BUILTIN_PROVIDERS).map(p => ({
            id: p.id,
            name: p.name,
            models: p.models,
            defaultModel: p.defaultModel,
            requiresApiKey: p.id !== 'ollama',
            defaultEndpoint: p.endpoint,
        }));

        // Current settings to pre-fill the form
        const current = {
            provider: config.provider,
            model: config.model,
            apiKey: config.apiKey || '',
            endpoint: config.endpoint || '',
            maxContextTokens: config.maxContextTokens,
        };

        // If Ollama is selected, prefetch models
        let ollamaModels: Array<{ name: string; size: string; parameterSize?: string }> | undefined;
        if (config.provider === 'ollama') {
            const ep = config.endpoint || BUILTIN_PROVIDERS['ollama'].endpoint;
            ollamaModels = await fetchOllamaModels(ep);
        }

        this.postMessage({ type: 'settingsData', providers, current, ollamaModels });
    }

    private async saveSettings(settings: import('./types').PanelSettings): Promise<void> {
        const cfg = vs.workspace.getConfiguration('cwtools.ai');
        await cfg.update('provider', settings.provider, vs.ConfigurationTarget.Global);
        await cfg.update('model', settings.model, vs.ConfigurationTarget.Global);
        await cfg.update('apiKey', settings.apiKey, vs.ConfigurationTarget.Global);
        await cfg.update('endpoint', settings.endpoint, vs.ConfigurationTarget.Global);
        await cfg.update('maxContextTokens', settings.maxContextTokens, vs.ConfigurationTarget.Global);
        await cfg.update('enabled', true, vs.ConfigurationTarget.Global);
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

        // Add user message to UI
        this.postMessage({ type: 'addUserMessage', text });

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
        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CWTools AI</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --border: var(--vscode-panel-border, #3c3c3c);
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --input-border: var(--vscode-input-border, #3c3c3c);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --btn-hover: var(--vscode-button-hoverBackground);
            --accent: var(--vscode-focusBorder, #007acc);
            --success: #4caf50;
            --error: #f44336;
            --warning: #ff9800;
            --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
            --plan-bg: rgba(100, 149, 237, 0.15);
            --plan-border: rgba(100, 149, 237, 0.5);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--fg);
            background: var(--bg);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Header */
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
        }
        .header-title {
            font-weight: 600;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .header-actions {
            display: flex;
            gap: 4px;
        }
        .header-btn {
            background: none;
            border: none;
            color: var(--fg);
            cursor: pointer;
            padding: 4px 6px;
            border-radius: 4px;
            font-size: 14px;
            opacity: 0.7;
        }
        .header-btn:hover { opacity: 1; background: var(--input-bg); }

        /* Topics sidebar */
        .topics-panel {
            display: none;
            position: absolute;
            top: 36px;
            left: 0;
            right: 0;
            bottom: 48px;
            background: var(--bg);
            border: 1px solid var(--border);
            z-index: 100;
            overflow-y: auto;
            padding: 8px;
        }
        .topics-panel.show { display: block; }
        .topic-item {
            padding: 8px;
            cursor: pointer;
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2px;
        }
        .topic-item:hover { background: var(--input-bg); }
        .topic-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .topic-delete {
            opacity: 0;
            cursor: pointer;
            color: var(--error);
            padding: 2px 4px;
        }
        .topic-item:hover .topic-delete { opacity: 0.7; }
        .topic-delete:hover { opacity: 1 !important; }

        /* Chat area */
        .chat-area {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
        }

        .message {
            margin-bottom: 16px;
            animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }

        .msg-role {
            font-size: 11px;
            font-weight: 600;
            margin-bottom: 4px;
            opacity: 0.7;
        }
        .msg-role.user { color: var(--accent); }
        .msg-role.assistant { color: var(--success); }

        .msg-content {
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
        }

        /* Code block */
        .code-block {
            background: var(--code-bg);
            border: 1px solid var(--border);
            border-radius: 4px;
            margin: 8px 0;
            overflow: hidden;
        }
        .code-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 8px;
            background: rgba(255,255,255,0.05);
            border-bottom: 1px solid var(--border);
            font-size: 11px;
        }
        .code-status { font-size: 11px; }
        .code-status.valid { color: var(--success); }
        .code-status.invalid { color: var(--error); }
        .code-actions { display: flex; gap: 4px; }
        .code-btn {
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            padding: 2px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .code-btn:hover { background: var(--btn-hover); }
        .code-content {
            padding: 8px;
            font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
            font-size: 12px;
            overflow-x: auto;
            white-space: pre;
        }

        /* Agent steps */
        .step {
            font-size: 11px;
            padding: 2px 0;
            opacity: 0.6;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .step-icon { font-size: 12px; }
        .step.tool_call .step-icon { color: var(--accent); }
        .step.validation .step-icon { color: var(--warning); }
        .step.error .step-icon { color: var(--error); }

        /* Input area */
        .input-area {
            padding: 8px 12px;
            border-top: 1px solid var(--border);
            display: flex;
            gap: 8px;
            flex-shrink: 0;
        }
        .input-area textarea {
            flex: 1;
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            padding: 6px 8px;
            font-family: inherit;
            font-size: 12px;
            resize: none;
            min-height: 32px;
            max-height: 120px;
            outline: none;
        }
        .input-area textarea:focus { border-color: var(--accent); }
        .send-btn {
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            align-self: flex-end;
        }
        .send-btn:hover { background: var(--btn-hover); }
        .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .cancel-btn {
            background: var(--error);
            color: white;
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            opacity: 0.5;
        }
        .empty-state .icon { font-size: 32px; margin-bottom: 8px; }

        /* Mode toggle */
        .mode-toggle {
            display: flex;
            align-items: center;
            gap: 0;
            background: var(--input-bg);
            border-radius: 6px;
            border: 1px solid var(--border);
            overflow: hidden;
        }
        .mode-btn {
            background: none;
            border: none;
            color: var(--fg);
            cursor: pointer;
            padding: 3px 10px;
            font-size: 11px;
            font-weight: 500;
            opacity: 0.5;
            transition: all 0.15s ease;
        }
        .mode-btn.active {
            opacity: 1;
            background: var(--btn-bg);
            color: var(--btn-fg);
        }
        .mode-btn:hover:not(.active) { opacity: 0.8; }
        .plan-indicator {
            display: none;
            padding: 4px 12px;
            background: var(--plan-bg);
            border: 1px solid var(--plan-border);
            border-radius: 4px;
            font-size: 11px;
            text-align: center;
            color: cornflowerblue;
        }
        body.plan-mode .plan-indicator { display: block; }

        /* Todo panel */
        .todo-panel {
            display: none;
            padding: 6px 12px;
            border-bottom: 1px solid var(--border);
        }
        .todo-panel.has-items { display: block; }
        .todo-panel-title {
            font-size: 11px;
            font-weight: 600;
            margin-bottom: 4px;
            opacity: 0.7;
        }
        .todo-item {
            font-size: 11px;
            padding: 2px 0;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .todo-item.done { opacity: 0.5; text-decoration: line-through; }
        .todo-item.in_progress { color: var(--accent); }
        .todo-status { font-size: 10px; }

        /* ── Settings Page ─────────────────────────────────── */
        .settings-page {
            display: none;
            flex-direction: column;
            height: 100%;
            overflow-y: auto;
        }
        .settings-page.active { display: flex; }
        .settings-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
            font-weight: 600;
            font-size: 13px;
        }
        .settings-back-btn {
            background: none;
            border: none;
            color: var(--fg);
            cursor: pointer;
            font-size: 16px;
            padding: 0 4px;
            opacity: 0.7;
            line-height: 1;
        }
        .settings-back-btn:hover { opacity: 1; }
        .settings-body {
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 14px;
            flex: 1;
        }
        .settings-group {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .settings-label {
            font-size: 11px;
            font-weight: 600;
            opacity: 0.8;
            letter-spacing: 0.03em;
        }
        .settings-input, .settings-select {
            background: var(--input-bg);
            border: 1px solid var(--border);
            color: var(--fg);
            border-radius: 5px;
            padding: 6px 8px;
            font-size: 12px;
            width: 100%;
            box-sizing: border-box;
            outline: none;
            font-family: inherit;
        }
        .settings-input:focus, .settings-select:focus {
            border-color: var(--accent);
        }
        .settings-select option { background: var(--bg); }
        .settings-key-row {
            display: flex;
            gap: 6px;
        }
        .settings-key-row .settings-input { flex: 1; }
        .key-toggle-btn {
            background: var(--input-bg);
            border: 1px solid var(--border);
            color: var(--fg);
            border-radius: 5px;
            padding: 0 8px;
            cursor: pointer;
            font-size: 14px;
            flex-shrink: 0;
        }
        .model-row {
            display: flex;
            gap: 6px;
        }
        .model-row .settings-input,
        .model-row .settings-select { flex: 1; }
        .detect-btn {
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            border-radius: 5px;
            padding: 0 10px;
            cursor: pointer;
            font-size: 11px;
            flex-shrink: 0;
            white-space: nowrap;
        }
        .detect-btn:hover { opacity: 0.85; }
        .detect-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .settings-hint {
            font-size: 10px;
            opacity: 0.5;
            margin-top: 2px;
        }
        .settings-footer {
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 7px;
            border-top: 1px solid var(--border);
        }
        .settings-save-btn {
            background: var(--accent);
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 8px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            width: 100%;
        }
        .settings-save-btn:hover { opacity: 0.9; }
        .settings-test-btn {
            background: var(--input-bg);
            color: var(--fg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 7px;
            cursor: pointer;
            font-size: 12px;
            width: 100%;
        }
        .settings-test-btn:hover { border-color: var(--accent); }
        .test-result {
            font-size: 11px;
            text-align: center;
            padding: 4px;
            border-radius: 4px;
            display: none;
        }
        .test-result.ok { background: rgba(80,200,80,0.15); color: #5c5; display: block; }
        .test-result.fail { background: rgba(200,80,80,0.15); color: #e66; display: block; }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-title">
            <span>🤖 CWTools AI</span>
            <div class="mode-toggle" id="modeToggle">
                <button class="mode-btn active" data-mode="build" onclick="switchMode('build')" title="Build 模式: 生成并验证代码">⚡ Build</button>
                <button class="mode-btn" data-mode="plan" onclick="switchMode('plan')" title="Plan 模式: 只读分析与规划">📋 Plan</button>
            </div>
        </div>
        <div class="header-actions">
            <button class="header-btn" onclick="toggleTopics()" title="历史话题">📋</button>
            <button class="header-btn" onclick="newTopic()" title="新话题">➕</button>
            <button class="header-btn" onclick="configureProvider()" title="设置">⚙️</button>
        </div>
    </div>

    <div class="topics-panel" id="topicsPanel"></div>

    <div class="plan-indicator" id="planIndicator">📋 Plan Mode — 只读分析，不修改文件</div>

    <div class="todo-panel" id="todoPanel">
        <div class="todo-panel-title">📝 任务跟踪</div>
        <div id="todoList"></div>
    </div>

    <div class="chat-area" id="chatArea">
        <div class="empty-state" id="emptyState">
            <div class="icon">🛸</div>
            <div>CWTools AI Assistant</div>
            <div style="font-size:11px;margin-top:4px;">描述你的需求，AI 将生成并验证 Stellaris 代码</div>
        </div>
    </div>

    <div class="input-area">
        <textarea id="input" placeholder="描述你的需求..." rows="1"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage();}"></textarea>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()">发送</button>
    </div>

    <!-- ── Settings Page ──────────────────────── -->
    <div class="settings-page" id="settingsPage">
        <div class="settings-header">
            <button class="settings-back-btn" onclick="closeSettings()" title="返回">←</button>
            <span>⚙️ AI 设置</span>
        </div>
        <div class="settings-body">
            <!-- Provider -->
            <div class="settings-group">
                <label class="settings-label">🤖 AI Provider</label>
                <select class="settings-select" id="settingsProvider" onchange="onProviderChange()"></select>
            </div>
            <!-- Model -->
            <div class="settings-group">
                <label class="settings-label">📡 Model</label>
                <div class="model-row">
                    <select class="settings-select" id="settingsModelSelect" style="display:none"></select>
                    <input class="settings-input" id="settingsModelInput" type="text" placeholder="model-name" />
                    <button class="detect-btn" id="detectBtn" onclick="detectOllamaModels()" style="display:none">🔍 检测</button>
                </div>
                <div class="settings-hint" id="modelHint"></div>
            </div>
            <!-- API Key -->
            <div class="settings-group" id="apiKeyGroup">
                <label class="settings-label">🔑 API Key</label>
                <div class="settings-key-row">
                    <input class="settings-input" id="settingsApiKey" type="password" placeholder="sk-..." autocomplete="off" />
                    <button class="key-toggle-btn" onclick="toggleKeyVisibility()" title="显示/隐藏">👁</button>
                </div>
            </div>
            <!-- Endpoint -->
            <div class="settings-group">
                <label class="settings-label">🌐 API Endpoint <span style="opacity:0.5;font-weight:400">(可选)</span></label>
                <input class="settings-input" id="settingsEndpoint" type="text" placeholder="留空使用默认" oninput="onEndpointChange()" />
                <div class="settings-hint" id="endpointHint"></div>
            </div>
            <!-- Context size -->
            <div class="settings-group">
                <label class="settings-label">📏 上下文大小 (tokens)</label>
                <input class="settings-input" id="settingsCtx" type="number" min="0" placeholder="0 = provider 默认值" />
                <div class="settings-hint">0 = 使用 provider 默认值。Ollama 本地模型推荐手动设置。</div>
            </div>
        </div>
        <div class="settings-footer">
            <div class="test-result" id="testResult"></div>
            <button class="settings-test-btn" onclick="testConnection()">🧪 测试连接</button>
            <button class="settings-save-btn" onclick="saveSettings()">💾 保存设置</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatArea = document.getElementById('chatArea');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('sendBtn');
        const emptyState = document.getElementById('emptyState');
        const topicsPanel = document.getElementById('topicsPanel');
        let isGenerating = false;
        let currentStepsDiv = null;

        // Auto-resize textarea
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        });

        function sendMessage() {
            const text = input.value.trim();
            if (!text || isGenerating) return;
            vscode.postMessage({ type: 'sendMessage', text });
            input.value = '';
            input.style.height = 'auto';
        }

        function newTopic() { vscode.postMessage({ type: 'newTopic' }); topicsPanel.classList.remove('show'); }
        function configureProvider() { vscode.postMessage({ type: 'configureProvider' }); }
        function toggleTopics() { topicsPanel.classList.toggle('show'); }
        function cancelGeneration() { vscode.postMessage({ type: 'cancelGeneration' }); }

        let currentMode = 'build';
        function switchMode(mode) {
            currentMode = mode;
            vscode.postMessage({ type: 'switchMode', mode });
            document.querySelectorAll('.mode-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.mode === mode);
            });
            document.body.classList.toggle('plan-mode', mode === 'plan');
            // Update placeholder
            input.placeholder = mode === 'plan' ? '请描述你想分析的内容...' : '描述你的需求...';
        }

        function setGenerating(val) {
            isGenerating = val;
            sendBtn.textContent = val ? '取消' : '发送';
            sendBtn.className = val ? 'send-btn cancel-btn' : 'send-btn';
            sendBtn.onclick = val ? cancelGeneration : sendMessage;
        }

        function scrollToBottom() {
            chatArea.scrollTop = chatArea.scrollHeight;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function addMessage(role, content, code, isValid, steps) {
            emptyState.style.display = 'none';
            const div = document.createElement('div');
            div.className = 'message';

            let html = '<div class="msg-role ' + role + '">' + (role === 'user' ? '👤 你' : '🤖 AI') + '</div>';
            html += '<div class="msg-content">' + escapeHtml(content) + '</div>';

            if (steps && steps.length > 0) {
                html += '<div class="steps">';
                for (const step of steps) {
                    const icons = { thinking:'💭', tool_call:'🔧', tool_result:'📦', validation:'✅', error:'❌', code_generated:'📝' };
                    html += '<div class="step ' + step.type + '"><span class="step-icon">' + (icons[step.type]||'•') + '</span>' + escapeHtml(step.content) + '</div>';
                }
                html += '</div>';
            }

            if (code) {
                const statusClass = isValid ? 'valid' : 'invalid';
                const statusText = isValid ? '✅ 验证通过' : '⚠️ 存在问题';
                html += '<div class="code-block">';
                html += '<div class="code-header"><span class="code-status ' + statusClass + '">' + statusText + '</span>';
                html += '<div class="code-actions">';
                html += '<button class="code-btn" onclick="copyCode(this)">📋 复制</button>';
                html += '<button class="code-btn" onclick="insertCode(this)">📝 插入</button>';
                html += '</div></div>';
                html += '<div class="code-content">' + escapeHtml(code) + '</div>';
                html += '</div>';
            }

            div.innerHTML = html;
            chatArea.appendChild(div);
            scrollToBottom();
        }

        function copyCode(btn) {
            const code = btn.closest('.code-block').querySelector('.code-content').textContent;
            vscode.postMessage({ type: 'copyCode', code });
        }

        function insertCode(btn) {
            const code = btn.closest('.code-block').querySelector('.code-content').textContent;
            vscode.postMessage({ type: 'insertCode', code });
        }

        // Handle messages from extension host
        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'addUserMessage':
                    setGenerating(true);
                    addMessage('user', msg.text);
                    // Create steps container for the upcoming response
                    currentStepsDiv = document.createElement('div');
                    currentStepsDiv.className = 'message';
                    currentStepsDiv.innerHTML = '<div class="msg-role assistant">🤖 AI</div><div class="steps" id="liveSteps"></div>';
                    chatArea.appendChild(currentStepsDiv);
                    scrollToBottom();
                    break;

                case 'agentStep':
                    if (currentStepsDiv) {
                        const stepsDiv = currentStepsDiv.querySelector('.steps');
                        const icons = { thinking:'💭', tool_call:'🔧', tool_result:'📦', validation:'✅', error:'❌', code_generated:'📝', compaction:'🗄️', todo_update:'📝' };
                        const step = msg.step;
                        const stepEl = document.createElement('div');
                        stepEl.className = 'step ' + step.type;
                        stepEl.innerHTML = '<span class="step-icon">' + (icons[step.type]||'•') + '</span>' + escapeHtml(step.content);
                        stepsDiv.appendChild(stepEl);
                        scrollToBottom();
                    }
                    break;

                case 'generationComplete':
                    setGenerating(false);
                    // Remove the live steps container
                    if (currentStepsDiv) { currentStepsDiv.remove(); currentStepsDiv = null; }
                    const r = msg.result;
                    addMessage('assistant', r.explanation || '代码已生成', r.code, r.isValid, r.steps);
                    break;

                case 'generationError':
                    setGenerating(false);
                    if (currentStepsDiv) { currentStepsDiv.remove(); currentStepsDiv = null; }
                    addMessage('assistant', '❌ ' + msg.error);
                    break;

                case 'clearChat':
                    chatArea.innerHTML = '';
                    emptyState.style.display = '';
                    chatArea.appendChild(emptyState);
                    break;

                case 'topicList':
                    renderTopics(msg.topics);
                    break;

                case 'loadTopicMessages':
                    for (const m of msg.messages) {
                        addMessage(m.role, m.content, m.code, m.isValid, m.steps);
                    }
                    break;

                case 'modeChanged':
                    currentMode = msg.mode;
                    document.querySelectorAll('.mode-btn').forEach(b => {
                        b.classList.toggle('active', b.dataset.mode === msg.mode);
                    });
                    document.body.classList.toggle('plan-mode', msg.mode === 'plan');
                    break;

                case 'todoUpdate':
                    renderTodos(msg.todos);
                    break;

                case 'settingsData':
                    showSettingsPage(msg.providers, msg.current, msg.ollamaModels);
                    break;

                case 'ollamaModels': {
                    const detectBtn = document.getElementById('detectBtn');
                    detectBtn.disabled = false;
                    detectBtn.textContent = '🔍 检测';
                    if (msg.error) {
                        document.getElementById('modelHint').textContent = msg.error;
                    } else {
                        settingsOllamaModels = msg.models;
                        const providerId = document.getElementById('settingsProvider').value;
                        updateModelUI(providerId, '', msg.models);
                    }
                    break;
                }

                case 'testConnectionResult': {
                    const tr = document.getElementById('testResult');
                    tr.className = 'test-result ' + (msg.ok ? 'ok' : 'fail');
                    tr.textContent = msg.message;
                    break;
                }
            }
        });

        function renderTopics(topics) {
            if (topics.length === 0) {
                topicsPanel.innerHTML = '<div style="text-align:center;opacity:0.5;padding:20px;">暂无历史话题</div>';
                return;
            }
            let html = '';
            for (const t of topics) {
                const date = new Date(t.updatedAt).toLocaleString();
                html += '<div class="topic-item" onclick="loadTopic(\\'' + t.id + '\\')">';
                html += '<span class="topic-title">' + escapeHtml(t.title) + '</span>';
                html += '<span class="topic-delete" onclick="event.stopPropagation();deleteTopic(\\'' + t.id + '\\')">🗑️</span>';
                html += '</div>';
            }
            topicsPanel.innerHTML = html;
        }

        function loadTopic(id) { vscode.postMessage({ type: 'loadTopic', topicId: id }); topicsPanel.classList.remove('show'); }
        function deleteTopic(id) { vscode.postMessage({ type: 'deleteTopic', topicId: id }); }

        function renderTodos(todos) {
            const panel = document.getElementById('todoPanel');
            const list = document.getElementById('todoList');
            if (!todos || todos.length === 0) {
                panel.classList.remove('has-items');
                list.innerHTML = '';
                return;
            }
            panel.classList.add('has-items');
            const statusIcons = { pending: '⬜', in_progress: '🔄', done: '✅' };
            list.innerHTML = todos.map(t => {
                const icon = statusIcons[t.status] || '⬜';
                const cls = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in_progress' : '';
                return '<div class="todo-item ' + cls + '"><span class="todo-status">' + icon + '</span>' + escapeHtml(t.content) + '</div>';
            }).join('');
        }

        // ── Settings Page ─────────────────────────────────────────

        let settingsProviders = [];
        let settingsOllamaModels = [];
        const chatMain = document.getElementById('chatArea');
        const chatInputArea = document.querySelector('.input-area');
        const settingsPage = document.getElementById('settingsPage');
        const chatHeader = document.querySelector('.header');
        const planIndicator = document.getElementById('planIndicator');
        const todoPanel = document.getElementById('todoPanel');

        function openSettings() {
            vscode.postMessage({ type: 'openSettings' });
        }

        function showSettingsPage(providers, current, ollamaModels) {
            settingsProviders = providers;
            settingsOllamaModels = ollamaModels || [];

            // Populate provider dropdown
            const sel = document.getElementById('settingsProvider');
            sel.innerHTML = providers.map(p =>
                '<option value="' + p.id + '"' + (p.id === current.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>'
            ).join('');

            // Pre-fill values
            document.getElementById('settingsApiKey').value = current.apiKey || '';
            document.getElementById('settingsEndpoint').value = current.endpoint || '';
            document.getElementById('settingsCtx').value = current.maxContextTokens || 0;

            // Set model and refresh UI
            updateModelUI(current.provider, current.model, ollamaModels);

            // Show page
            chatHeader.style.display = 'none';
            chatMain.style.display = 'none';
            chatInputArea.style.display = 'none';
            if (planIndicator) planIndicator.style.display = 'none';
            if (todoPanel) todoPanel.style.display = 'none';
            settingsPage.classList.add('active');

            // Clear test result
            const tr = document.getElementById('testResult');
            tr.className = 'test-result';
            tr.textContent = '';
        }

        function closeSettings() {
            settingsPage.classList.remove('active');
            chatHeader.style.display = '';
            chatMain.style.display = '';
            chatInputArea.style.display = '';
            if (planIndicator) planIndicator.style.display = '';
            if (todoPanel) todoPanel.style.display = '';
        }

        function onProviderChange() {
            const providerId = document.getElementById('settingsProvider').value;
            updateModelUI(providerId, '', settingsOllamaModels);
            updateEndpointHint(providerId);
        }

        function updateModelUI(providerId, currentModel, ollamaModels) {
            const provider = settingsProviders.find(p => p.id === providerId);
            const modelSel = document.getElementById('settingsModelSelect');
            const modelInput = document.getElementById('settingsModelInput');
            const detectBtn = document.getElementById('detectBtn');
            const apiKeyGroup = document.getElementById('apiKeyGroup');
            const modelHint = document.getElementById('modelHint');

            // API key visibility
            apiKeyGroup.style.display = (providerId === 'ollama') ? 'none' : '';

            if (providerId === 'ollama') {
                modelSel.style.display = 'none';
                modelInput.style.display = '';
                detectBtn.style.display = '';
                modelHint.textContent = '点击「检测」自动获取正在运行的 Ollama 模型';

                // If we have ollamaModels, show a select
                if (ollamaModels && ollamaModels.length > 0) {
                    modelSel.innerHTML = ollamaModels.map(m =>
                        '<option value="' + escapeHtml(m.name) + '"' + (m.name === currentModel ? ' selected' : '') + '>' +
                        escapeHtml(m.name) + (m.parameterSize ? ' (' + m.parameterSize + ')' : '') + ' — ' + m.size + '</option>'
                    ).join('');
                    modelSel.style.display = '';
                    modelInput.style.display = 'none';
                    modelHint.textContent = '已检测到 ' + ollamaModels.length + ' 个本地模型';
                } else {
                    modelInput.value = currentModel || '';
                }
            } else if (provider && provider.models.length > 0) {
                modelSel.innerHTML = provider.models.map(m =>
                    '<option value="' + escapeHtml(m) + '"' + (m === currentModel ? ' selected' : '') + '>' + escapeHtml(m) + '</option>'
                ).join('');
                if (!currentModel || !provider.models.includes(currentModel)) {
                    // Also allow custom input: add a text input below
                    modelSel.style.display = 'none';
                    modelInput.style.display = '';
                    modelInput.value = currentModel || provider.defaultModel || '';
                    modelHint.textContent = '也可直接输入模型名称';
                } else {
                    modelSel.style.display = '';
                    modelInput.style.display = 'none';
                    modelHint.textContent = '或直接输入自定义模型名';
                }
                detectBtn.style.display = 'none';
            } else {
                // Custom / empty models
                modelSel.style.display = 'none';
                modelInput.style.display = '';
                modelInput.value = currentModel || '';
                detectBtn.style.display = 'none';
                modelHint.textContent = '';
            }

            updateEndpointHint(providerId);
        }

        function updateEndpointHint(providerId) {
            const provider = settingsProviders.find(p => p.id === providerId);
            const hint = document.getElementById('endpointHint');
            const endpointEl = document.getElementById('settingsEndpoint');
            if (provider) {
                hint.textContent = '默认: ' + (provider.defaultEndpoint || '由 provider 决定');
                if (!endpointEl.value) {
                    endpointEl.placeholder = provider.defaultEndpoint || '留空使用默认';
                }
            }
        }

        function onEndpointChange() {
            const providerId = document.getElementById('settingsProvider').value;
            if (providerId === 'ollama') {
                settingsOllamaModels = [];
                const modelSel = document.getElementById('settingsModelSelect');
                const modelInput = document.getElementById('settingsModelInput');
                modelSel.style.display = 'none';
                modelInput.style.display = '';
                document.getElementById('modelHint').textContent = '端点已更改，点击「检测」重新获取模型';
            }
        }

        function detectOllamaModels() {
            const btn = document.getElementById('detectBtn');
            const endpoint = document.getElementById('settingsEndpoint').value.trim();
            btn.disabled = true;
            btn.textContent = '检测中...';
            document.getElementById('modelHint').textContent = '正在连接 Ollama...';
            vscode.postMessage({ type: 'detectOllamaModels', endpoint: endpoint || 'http://localhost:11434/v1' });
        }

        function toggleKeyVisibility() {
            const input = document.getElementById('settingsApiKey');
            input.type = input.type === 'password' ? 'text' : 'password';
        }

        function getSelectedModel() {
            const modelSel = document.getElementById('settingsModelSelect');
            const modelInput = document.getElementById('settingsModelInput');
            if (modelSel.style.display !== 'none') {
                return modelSel.value;
            }
            return modelInput.value.trim();
        }

        function saveSettings() {
            const settings = {
                provider: document.getElementById('settingsProvider').value,
                model: getSelectedModel(),
                apiKey: document.getElementById('settingsApiKey').value,
                endpoint: document.getElementById('settingsEndpoint').value.trim(),
                maxContextTokens: parseInt(document.getElementById('settingsCtx').value) || 0,
            };
            vscode.postMessage({ type: 'saveSettings', settings });
            closeSettings();
        }

        function testConnection() {
            const tr = document.getElementById('testResult');
            tr.className = 'test-result';
            tr.textContent = '测试中...';
            tr.style.display = 'block';
            // Pass current form values so backend uses them, not old saved config
            const settings = {
                provider: document.getElementById('settingsProvider').value,
                model: getSelectedModel(),
                apiKey: document.getElementById('settingsApiKey').value,
                endpoint: document.getElementById('settingsEndpoint').value.trim(),
                maxContextTokens: parseInt(document.getElementById('settingsCtx').value) || 0,
            };
            vscode.postMessage({ type: 'testConnection', settings });
        }
    </script>
</body>
</html>`;
    }
}
