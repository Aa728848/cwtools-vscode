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
        }
    }

    private async openSettingsPage(): Promise<void> {
        const { BUILTIN_PROVIDERS, fetchOllamaModels } = await import('./providers');
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

        // Build hasKey map: never send plaintext keys to WebView
        const hasKeyMap: Record<string, boolean> = {};
        for (const p of providers) {
            hasKeyMap[p.id] = !!(await this.aiService.getKeyForProvider(p.id));
        }

        // Current settings to pre-fill the form (apiKey is never sent)
        const current: import('./types').PanelSettings = {
            provider: config.provider,
            model: config.model,
            apiKey: '',  // NEVER send actual key to WebView
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

        // If Ollama is selected, prefetch models
        let ollamaModels: Array<{ name: string; size: string; parameterSize?: string }> | undefined;
        if (config.provider === 'ollama') {
            const ep = config.endpoint || BUILTIN_PROVIDERS['ollama']?.endpoint;
            if (ep) ollamaModels = await fetchOllamaModels(ep);
        }

        this.postMessage({
            type: 'settingsData', providers: providers.map(p => ({
                ...p,
                hasKey: hasKeyMap[p.id] ?? false,
            })) as any, current, ollamaModels
        });
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
        const nonce = (() => {
            let t = '';
            const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
            return t;
        })();
        const csp = webview.cspSource;
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>CWTools AI</title>
<style nonce="${nonce}">
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
.header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.header-title { display: flex; align-items: center; gap: 6px; }
.asterisk { color: var(--accent); font-size: 18px; line-height: 1; }
.brand-text { font-family: Georgia, Cambria, serif; font-size: 14px; font-weight: 500; letter-spacing: 0.5px; color: #ececec; }
.header-actions { display: flex; gap: 2px; }
.icon-btn { background: none; border: none; color: var(--fg); cursor: pointer; padding: 4px 7px; border-radius: 4px; font-size: 13px; opacity: 0.6; transition: opacity 0.15s, background 0.15s; }
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
.ctrl-group { display: flex; align-items: center; gap: 2px; }
.send-btn { background: none; color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 15px; line-height: 1; transition: background 0.1s; }
.send-btn:hover { background: var(--btn-hover); }
.send-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.cancel-btn { color: var(--error); border-color: var(--error); }
.mode-btn { background: none; border: 1px solid transparent; color: var(--fg); cursor: pointer; padding: 3px 8px; font-size: 11px; border-radius: 3px; opacity: 0.5; display: flex; align-items: center; gap: 3px; transition: all 0.15s; }
.mode-btn:hover { opacity: 0.85; background: var(--btn-hover); }
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
        <span class="asterisk">✳</span>
        <span class="brand-text">CWTools AI</span>
    </div>
    <div class="header-actions">
        <button class="icon-btn" id="btnTopics" title="历史话题">☰</button>
        <button class="icon-btn" id="btnSettings" title="设置">⚙</button>
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
        <div class="empty-icon">✳</div>
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
                    <input class="settings-input" id="inlineModel" type="text" placeholder="留空与对话相同" />
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

<script nonce="${nonce}">
(function() {
    const vscode = acquireVsCodeApi();
    const chatArea = document.getElementById('chatArea');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const emptyState = document.getElementById('emptyState');
    const topicsPanel = document.getElementById('topicsPanel');
    const settingsPage = document.getElementById('settingsPage');
    const chatHeader = document.querySelector('.header');
    const inputWrapper = document.querySelector('.input-wrapper');
    const planIndicator = document.getElementById('planIndicator');
    const todoPanel = document.getElementById('todoPanel');

    let isGenerating = false;
    let currentAssistantDiv = null;
    let currentMode = 'build';
    const messageIndexMap = new Map();
    let settingsProviders = [];
    let settingsOllamaModels = [];

    // ── Button bindings ──
    document.getElementById('btnTopics').addEventListener('click', () => topicsPanel.classList.toggle('show'));
    document.getElementById('btnNewTopicPanel').addEventListener('click', () => {
        vscode.postMessage({ type: 'newTopic' });
        topicsPanel.classList.remove('show');
    });
    document.getElementById('btnSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('buildModeBtn').addEventListener('click', () => switchMode('build'));
    document.getElementById('planModeBtn').addEventListener('click', () => switchMode('plan'));
    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; });
    document.getElementById('settingsBackBtn').addEventListener('click', closeSettings);
    document.getElementById('testConnBtn').addEventListener('click', testConnection);
    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
    document.getElementById('keyToggleBtn').addEventListener('click', () => { const k = document.getElementById('settingsApiKey'); k.type = k.type === 'password' ? 'text' : 'password'; });
    document.getElementById('detectBtn').addEventListener('click', detectOllamaModels);
    document.getElementById('accChat').addEventListener('click', () => toggleAccordion('chatModelSection'));
    document.getElementById('accInline').addEventListener('click', () => toggleAccordion('inlineSection'));
    document.getElementById('accAgent').addEventListener('click', () => toggleAccordion('agentSection'));
    document.getElementById('settingsProvider').addEventListener('change', onProviderChange);
    document.getElementById('settingsEndpoint').addEventListener('input', onEndpointChange);

    function sendMessage() {
        const text = input.value.trim();
        if (!text || isGenerating) return;
        vscode.postMessage({ type: 'sendMessage', text });
        input.value = '';
        input.style.height = 'auto';
    }

    function switchMode(mode) {
        currentMode = mode;
        vscode.postMessage({ type: 'switchMode', mode });
        const build = document.getElementById('buildModeBtn');
        const plan = document.getElementById('planModeBtn');
        build.classList.toggle('active', mode === 'build');
        plan.classList.toggle('active', mode === 'plan');
        document.body.classList.toggle('plan-mode', mode === 'plan');
    }

    function setGenerating(val) {
        isGenerating = val;
        sendBtn.innerHTML = val ? '⬛' : '↑';
        sendBtn.className = val ? 'send-btn cancel-btn' : 'send-btn';
        sendBtn.onclick = val ? () => vscode.postMessage({ type: 'cancelGeneration' }) : sendMessage;
    }

    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = String(t ?? ''); return d.innerHTML; }

    function renderMarkdown(text) {
        let h = escapeHtml(text);
        h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        h = h.split('\n').join('<br>');
        return h;
    }

    function scrollBottom() { chatArea.scrollTop = chatArea.scrollHeight; }

    function addUserMessage(text, msgIdx) {
        emptyState.style.display = 'none';
        const div = document.createElement('div');
        div.className = 'message user';
        const idx = msgIdx !== undefined ? msgIdx : -1;
        if (idx >= 0) div.dataset.msgIndex = idx;
        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<span style="opacity:0.5;font-size:11px;">You</span>';
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = text;
        div.appendChild(hdr);
        div.appendChild(bubble);
        if (idx >= 0) {
            const rb = document.createElement('button');
            rb.className = 'retract-btn';
            rb.textContent = '↩ 撤回';
            rb.addEventListener('click', () => vscode.postMessage({ type: 'retractMessage', messageIndex: idx }));
            div.appendChild(rb);
            messageIndexMap.set(idx, div);
        }
        chatArea.appendChild(div);
        scrollBottom();
        return div;
    }

    const STEP_ICONS = {
        tool_call: '⚙', tool_result: '📦', thinking: '💭',
        thinking_content: '🧠', validation: '✅', error: '❌',
        code_generated: '📝', compaction: '🗄', todo_update: '📝'
    };

    function addAssistantMessage(content, code, isValid, steps) {
        const div = document.createElement('div');
        div.className = 'message assistant';
        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<span style="color:#d95a43;font-size:15px;">✳</span><span style="font-family:Georgia,serif;">CWTools AI</span>';
        div.appendChild(hdr);

        if (steps && steps.length > 0) {
            // Thinking block (thinking_content steps)
            const thinkSteps = steps.filter(s => s.type === 'thinking_content');
            if (thinkSteps.length > 0) {
                const det = document.createElement('details');
                det.className = 'thinking-block';
                const sum = document.createElement('summary');
                sum.textContent = '🧠 Thinking · ' + thinkSteps.length + ' block(s)';
                det.appendChild(sum);
                const body = document.createElement('div');
                body.className = 'thinking-body';
                body.textContent = thinkSteps.map(s => s.content).join('\n\n---\n\n');
                det.appendChild(body);
                div.appendChild(det);
            }

            // Tool calls group (all non-thinking steps)
            const toolSteps = steps.filter(s => s.type !== 'thinking_content');
            if (toolSteps.length > 0) {
                const toolCallCount = toolSteps.filter(s => s.type === 'tool_call').length;
                const det = document.createElement('details');
                det.className = 'tool-group';
                const sum = document.createElement('summary');
                sum.textContent = toolCallCount > 0
                    ? '🔧 工具调用 · ' + toolCallCount
                    : '📋 Agent 步骤';
                det.appendChild(sum);
                const body = document.createElement('div');
                body.className = 'tool-group-body';
                for (const s of toolSteps) {
                    const el = document.createElement('div');
                    el.className = 'step ' + s.type;
                    el.innerHTML = '<span class="step-icon">' + (STEP_ICONS[s.type] || '·') + '</span>' + escapeHtml(s.content);
                    body.appendChild(el);
                }
                det.appendChild(body);
                div.appendChild(det);
            }
        }

        if (content && content.trim()) {
            const b = document.createElement('div');
            b.className = 'msg-bubble';
            b.innerHTML = renderMarkdown(content);
            div.appendChild(b);
        }
        if (code) {
            const cb = document.createElement('div');
            cb.className = 'code-block';
            const ch = document.createElement('div');
            ch.className = 'code-header';
            const valid = isValid ? 'valid' : 'invalid';
            const vtext = isValid ? '✅ 验证通过' : '⚠ 存在问题';
            ch.innerHTML = '<span class="code-status ' + valid + '">' + vtext + '</span>';
            const ca = document.createElement('div');
            ca.className = 'code-actions';
            const cpBtn = document.createElement('button');
            cpBtn.className = 'code-btn'; cpBtn.textContent = '复制';
            cpBtn.addEventListener('click', () => vscode.postMessage({ type: 'copyCode', code: cb.querySelector('.code-content').textContent }));
            const inBtn = document.createElement('button');
            inBtn.className = 'code-btn'; inBtn.textContent = '插入';
            inBtn.addEventListener('click', () => vscode.postMessage({ type: 'insertCode', code: cb.querySelector('.code-content').textContent }));
            ca.appendChild(cpBtn); ca.appendChild(inBtn); ch.appendChild(ca);
            const cc = document.createElement('div');
            cc.className = 'code-content'; cc.textContent = code;
            cb.appendChild(ch); cb.appendChild(cc);
            div.appendChild(cb);
        }
        chatArea.appendChild(div);
        scrollBottom();
        return div;
    }

    function showDiffCard(file, diff, messageId) {
        const div = document.createElement('div');
        const fileName = (file || '').split(/[\\\/]/).pop() || file;
        const lines = (diff || '').split('\n');
        const diffHtml = lines.map(line => {
            if (line.startsWith('+') && !line.startsWith('+++')) return '<span class="diff-add">' + escapeHtml(line) + '</span>';
            if (line.startsWith('-') && !line.startsWith('---')) return '<span class="diff-del">' + escapeHtml(line) + '</span>';
            return escapeHtml(line);
        }).join('\n');
        const safeId = escapeHtml(messageId);
        const card = document.createElement('div');
        card.className = 'diff-card';
        card.innerHTML =
            '<div class="diff-card-header">Requesting to modify: ' + escapeHtml(fileName) + '</div>' +
            '<div class="diff-card-body">' + diffHtml + '</div>' +
            '<div class="diff-card-actions">' +
            '<button class="diff-accept-btn" data-msgid="' + safeId + '">Accept</button>' +
            '<button class="diff-reject-btn" data-msgid="' + safeId + '">Reject</button>' +
            '</div>';
        card.querySelector('.diff-accept-btn').addEventListener('click', function() {
            card.querySelectorAll('button').forEach(b => b.disabled = true);
            this.textContent = 'Accepted';
            vscode.postMessage({ type: 'confirmWriteFile', messageId });
        });
        card.querySelector('.diff-reject-btn').addEventListener('click', function() {
            card.querySelectorAll('button').forEach(b => b.disabled = true);
            this.textContent = 'Rejected';
            vscode.postMessage({ type: 'cancelWriteFile', messageId });
        });
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
    }

    // ── Messages from host ──
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
            case 'addUserMessage':
                setGenerating(true);
                addUserMessage(msg.text, msg.messageIndex);
                currentAssistantDiv = document.createElement('div');
                currentAssistantDiv.className = 'message assistant';
                currentAssistantDiv.innerHTML =
                    '<div class="msg-header"><span style="color:#d95a43;font-size:15px;">✳</span><span style="font-family:Georgia,serif;">CWTools AI</span></div>' +
                    '<details class="thinking-block" id="liveThinkingBlock" style="display:none"><summary>🧠 Thinking...</summary><div class="thinking-body" id="liveThinkingBody"></div></details>' +
                    '<details class="tool-group" id="liveToolGroup" style="display:none"><summary id="liveToolSummary">💭 처리중...</summary><div class="tool-group-body" id="liveToolBody"></div></details>';
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom();
                break;

            case 'agentStep': {
                if (!currentAssistantDiv) break;
                const s = msg.step;

                if (s.type === 'thinking_content') {
                    // Show in dedicated thinking block
                    const tb = currentAssistantDiv.querySelector('#liveThinkingBlock');
                    const tbd = currentAssistantDiv.querySelector('#liveThinkingBody');
                    if (tb) tb.style.display = '';
                    if (tbd) {
                        if (tbd.textContent) tbd.textContent += '\n\n---\n\n' + s.content;
                        else tbd.textContent = s.content;
                    }
                } else {
                    // All other steps go in tool group
                    const tg = currentAssistantDiv.querySelector('#liveToolGroup');
                    const tb = currentAssistantDiv.querySelector('#liveToolBody');
                    const ts = currentAssistantDiv.querySelector('#liveToolSummary');
                    if (tg) tg.style.display = '';
                    if (ts) {
                        // Update summary with most recent step type
                        const toolCallCount = currentAssistantDiv.querySelectorAll('.step.tool_call').length
                            + (s.type === 'tool_call' ? 1 : 0);
                        ts.textContent = toolCallCount > 0
                            ? '🔧 工具调用 · ' + toolCallCount
                            : '📋 处理中...';
                    }
                    if (tb) {
                        const el = document.createElement('div');
                        el.className = 'step ' + s.type;
                        el.innerHTML = '<span class="step-icon">' + (STEP_ICONS[s.type] || '·') + '</span>' + escapeHtml(s.content);
                        tb.appendChild(el);
                    }
                }
                scrollBottom();
                break;
            }

            case 'generationComplete':
                setGenerating(false);
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                { const r = msg.result; addAssistantMessage(r.explanation || '完成', r.code, r.isValid, r.steps); }
                break;

            case 'generationError':
                setGenerating(false);
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                addAssistantMessage('❌ ' + msg.error);
                break;

            case 'clearChat':
                chatArea.innerHTML = '';
                emptyState.style.display = '';
                chatArea.appendChild(emptyState);
                messageIndexMap.clear();
                break;

            case 'topicList': renderTopics(msg.topics); break;

            case 'loadTopicMessages':
                for (const m of msg.messages) {
                    if (m.role === 'user') addUserMessage(m.content);
                    else addAssistantMessage(m.content, m.code, m.isValid, m.steps);
                }
                break;

            case 'messageRetracted': {
                const rd = messageIndexMap.get(msg.messageIndex);
                if (rd) { rd.classList.add('retracted'); const b = rd.querySelector('.msg-bubble'); if (b) b.textContent = '(已撤回)'; }
                const nx = rd ? rd.nextElementSibling : null;
                if (nx && nx.classList.contains('assistant')) nx.remove();
                break;
            }

            case 'pendingWriteFile': showDiffCard(msg.file, msg.diff, msg.messageId); break;

            case 'modeChanged':
                currentMode = msg.mode;
                document.getElementById('buildModeBtn').classList.toggle('active', msg.mode === 'build');
                document.getElementById('planModeBtn').classList.toggle('active', msg.mode === 'plan');
                document.body.classList.toggle('plan-mode', msg.mode === 'plan');
                break;

            case 'todoUpdate': renderTodos(msg.todos); break;
            case 'settingsData': showSettingsPage(msg.providers, msg.current, msg.ollamaModels); break;

            case 'ollamaModels': {
                const db = document.getElementById('detectBtn');
                db.disabled = false; db.textContent = '🔍 检测';
                if (msg.error) { document.getElementById('modelHint').textContent = msg.error; }
                else { settingsOllamaModels = msg.models; updateModelUI(document.getElementById('settingsProvider').value, '', msg.models); }
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
        const list = document.getElementById('topicsList');
        if (!topics.length) {
            list.innerHTML = '<div style="text-align:center;opacity:0.5;padding:20px;font-size:12px;">暂无历史话题</div>';
            return;
        }
        list.innerHTML = '';
        for (const t of topics) {
            const item = document.createElement('div');
            item.className = 'topic-item';
            const title = document.createElement('span');
            title.className = 'topic-title';
            title.textContent = t.title;
            const del = document.createElement('button');
            del.className = 'topic-delete';
            del.textContent = '✕';
            del.title = '删除此话题';
            del.addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({ type: 'deleteTopic', topicId: t.id });
            });
            item.appendChild(title);
            item.appendChild(del);
            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'loadTopic', topicId: t.id });
                topicsPanel.classList.remove('show');
            });
            list.appendChild(item);
        }
    }

    function renderTodos(todos) {
        if (!todos || !todos.length) { todoPanel.classList.remove('has-items'); document.getElementById('todoList').innerHTML = ''; return; }
        todoPanel.classList.add('has-items');
        const icons = { pending:'○', in_progress:'●', done:'✓' };
        document.getElementById('todoList').innerHTML = todos.map(t => {
            const cls = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in_progress' : '';
            return '<div class="todo-item ' + cls + '"><span>' + (icons[t.status]||'○') + '</span>' + escapeHtml(t.content) + '</div>';
        }).join('');
    }

    function showSettingsPage(providers, current, ollamaModels) {
        settingsProviders = providers;
        settingsOllamaModels = ollamaModels || [];
        const sel = document.getElementById('settingsProvider');
        sel.innerHTML = providers.map(p => '<option value="' + p.id + '"' + (p.id === current.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        const inlineSel = document.getElementById('inlineProvider');
        inlineSel.innerHTML = '<option value="">- 与对话相同 -</option>' + providers.map(p => '<option value="' + p.id + '"' + (p.id === current.inlineCompletion?.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        document.getElementById('settingsApiKey').value = '';
        document.getElementById('settingsEndpoint').value = current.endpoint || '';
        document.getElementById('settingsCtx').value = current.maxContextTokens || 0;
        document.getElementById('inlineEnabled').checked = current.inlineCompletion?.enabled ?? false;
        document.getElementById('inlineModel').value = current.inlineCompletion?.model || '';
        document.getElementById('inlineEndpoint').value = current.inlineCompletion?.endpoint || '';
        document.getElementById('inlineDebounce').value = current.inlineCompletion?.debounceMs || 1500;
        document.getElementById('agentWriteMode').value = current.agentFileWriteMode || 'confirm';
        updateModelUI(current.provider, current.model, ollamaModels);
        updateApiKeyStatus(current.provider, providers);
        chatHeader.style.display = 'none';
        document.getElementById('chatArea').style.display = 'none';
        if (inputWrapper) inputWrapper.style.display = 'none';
        if (planIndicator) planIndicator.style.display = 'none';
        if (todoPanel) todoPanel.style.display = 'none';
        settingsPage.classList.add('active');
        document.getElementById('testResult').className = 'test-result';
        document.getElementById('testResult').textContent = '';
    }

    function closeSettings() {
        settingsPage.classList.remove('active');
        chatHeader.style.display = '';
        document.getElementById('chatArea').style.display = 'flex';
        if (inputWrapper) inputWrapper.style.display = '';
        if (planIndicator) planIndicator.style.display = '';
        if (todoPanel) todoPanel.style.display = '';
    }

    /** Update the API key status label for the given provider */
    function updateApiKeyStatus(providerId, providers) {
        const p = (providers || settingsProviders).find(x => x.id === providerId);
        const status = document.getElementById('apiKeyStatus');
        const group = document.getElementById('apiKeyGroup');
        if (providerId === 'ollama') {
            group.style.display = 'none';
            return;
        }
        group.style.display = '';
        if (p && p.hasKey) {
            status.textContent = '✅ 已配置 API Key';
            status.style.color = '#4caf50';
        } else {
            status.textContent = '⚠️ 尚未配置 API Key';
            status.style.color = '#ff9800';
        }
    }

    function onProviderChange() {
        const id = document.getElementById('settingsProvider').value;
        updateModelUI(id, '', settingsOllamaModels);
        updateEndpointHint(id);
        updateApiKeyStatus(id, settingsProviders);
    }

    function updateModelUI(providerId, currentModel, ollamaModels) {
        const provider = settingsProviders.find(p => p.id === providerId);
        const modelSel = document.getElementById('settingsModelSelect');
        const modelInput = document.getElementById('settingsModelInput');
        const detectBtn = document.getElementById('detectBtn');
        const modelHint = document.getElementById('modelHint');
        if (providerId === 'ollama') {
            document.getElementById('apiKeyGroup').style.display = 'none';
            if (ollamaModels && ollamaModels.length > 0) {
                modelSel.innerHTML = ollamaModels.map(m => '<option value="' + escapeHtml(m.name) + '"' + (m.name === currentModel ? ' selected' : '') + '>' + escapeHtml(m.name) + (m.parameterSize ? ' (' + m.parameterSize + ')' : '') + ' — ' + m.size + '</option>').join('');
                modelSel.style.display = ''; modelInput.style.display = 'none';
                modelHint.textContent = '已检测到 ' + ollamaModels.length + ' 个本地模型';
            } else {
                modelSel.style.display = 'none'; modelInput.style.display = ''; detectBtn.style.display = '';
                modelInput.value = currentModel || '';
                modelHint.textContent = '点击「检测」自动获取正在运行的 Ollama 模型';
            }
            detectBtn.style.display = '';
        } else if (provider && provider.models.length > 0) {
            modelSel.innerHTML = provider.models.map(m => '<option value="' + escapeHtml(m) + '"' + (m === currentModel ? ' selected' : '') + '>' + escapeHtml(m) + '</option>').join('');
            if (!currentModel || !provider.models.includes(currentModel)) {
                modelSel.style.display = 'none'; modelInput.style.display = '';
                modelInput.value = currentModel || provider.defaultModel || '';
                modelHint.textContent = '也可直接输入模型名称';
            } else {
                modelSel.style.display = ''; modelInput.style.display = 'none';
                modelHint.textContent = '或直接输入自定义模型名';
            }
            detectBtn.style.display = 'none';
        } else {
            modelSel.style.display = 'none'; modelInput.style.display = ''; detectBtn.style.display = 'none';
            modelInput.value = currentModel || ''; modelHint.textContent = '';
        }
        updateEndpointHint(providerId);
    }

    function updateEndpointHint(providerId) {
        const provider = settingsProviders.find(p => p.id === providerId);
        const hint = document.getElementById('endpointHint');
        const ep = document.getElementById('settingsEndpoint');
        if (provider) { hint.textContent = '默认: ' + (provider.defaultEndpoint || '由 provider 决定'); if (!ep.value) ep.placeholder = provider.defaultEndpoint || '留空使用默认'; }
    }

    function onEndpointChange() {
        if (document.getElementById('settingsProvider').value === 'ollama') {
            settingsOllamaModels = [];
            document.getElementById('settingsModelSelect').style.display = 'none';
            document.getElementById('settingsModelInput').style.display = '';
            document.getElementById('modelHint').textContent = '端点已更改，点击「检测」重新获取模型';
        }
    }

    function detectOllamaModels() {
        const btn = document.getElementById('detectBtn');
        const ep = document.getElementById('settingsEndpoint').value.trim();
        btn.disabled = true; btn.textContent = '检测中...';
        document.getElementById('modelHint').textContent = '正在连接 Ollama...';
        vscode.postMessage({ type: 'detectOllamaModels', endpoint: ep || 'http://localhost:11434/v1' });
    }

    function getSelectedModel() {
        const sel = document.getElementById('settingsModelSelect');
        const inp = document.getElementById('settingsModelInput');
        return sel.style.display !== 'none' ? sel.value : inp.value.trim();
    }

    function toggleAccordion(id) { document.getElementById(id).classList.toggle('open'); }

    function saveSettings() {
        vscode.postMessage({ type: 'saveSettings', settings: {
            provider: document.getElementById('settingsProvider').value,
            model: getSelectedModel(),
            apiKey: document.getElementById('settingsApiKey').value,
            endpoint: document.getElementById('settingsEndpoint').value.trim(),
            maxContextTokens: parseInt(document.getElementById('settingsCtx').value) || 0,
            agentFileWriteMode: document.getElementById('agentWriteMode').value,
            inlineCompletion: {
                enabled: document.getElementById('inlineEnabled').checked,
                provider: document.getElementById('inlineProvider').value,
                model: document.getElementById('inlineModel').value.trim(),
                endpoint: document.getElementById('inlineEndpoint').value.trim(),
                debounceMs: parseInt(document.getElementById('inlineDebounce').value) || 1500,
            },
        }});
        // Don't close — backend will push fresh settingsData with updated hasKey
    }

    function testConnection() {
        const tr = document.getElementById('testResult');
        tr.className = 'test-result'; tr.textContent = '测试中...'; tr.style.display = 'block';
        vscode.postMessage({ type: 'testConnection', settings: {
            provider: document.getElementById('settingsProvider').value,
            model: getSelectedModel(),
            apiKey: document.getElementById('settingsApiKey').value,
            endpoint: document.getElementById('settingsEndpoint').value.trim(),
            maxContextTokens: 0, agentFileWriteMode: 'confirm',
            inlineCompletion: { enabled: false, provider: '', model: '', endpoint: '', debounceMs: 1500 },
        }});
    }
})();
</script>
</body>
</html>`;
    }
}
