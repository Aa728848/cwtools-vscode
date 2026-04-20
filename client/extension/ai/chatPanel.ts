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
    /** Live snapshot of agent steps emitted during the current generation */
    private _liveSteps: AgentStep[] = [];
    /** Whether an AI generation is currently running */
    private _isGenerating = false;
    /** Pending plan file that hasn't been submitted yet (shown as a persistent card) */
    private _pendingPlanFile: { filePath: string; relPath: string } | null = null;

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

        // ── Restore state when panel becomes visible again ────────────────────
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._restoreViewState();
            }
        });

        // Send topic list and initial model data on load
        this.sendTopicList();
        // Push provider/model list immediately so the quick selector is populated
        this.buildAndSendSettingsData().catch(() => { /* ignore on startup */ });
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
        if (this.currentTopic && this.currentTopic.messages.length > 0) {
            this.postMessage({ type: 'loadTopicMessages', messages: this.currentTopic.messages });
        }
        // 2. Restore current mode
        this.postMessage({ type: 'setMode', mode: this.currentMode });
        // 3. If a generation was running when the panel was hidden, replay steps
        //    so the user can see what the AI has done so far and cancel if needed
        if (this._isGenerating && this._liveSteps.length > 0) {
            this.postMessage({ type: 'replaySteps', steps: this._liveSteps, isGenerating: true });
        }
        // 4. If a plan is pending approval, re-show the plan card so it's always visible
        if (this._pendingPlanFile) {
            this.postMessage({ type: 'planFileSaved', ...this._pendingPlanFile });
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
            case 'forkTopic':
                this.forkTopic(msg.topicId, msg.messageIndex);
                break;
            case 'archiveTopic':
                this.archiveTopic(msg.topicId);
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
            case 'slashCommand':
                await this.handleSlashCommand(msg.command);
                break;
            case 'permissionResponse':
                this.resolvePermissionRequest(msg.permissionId, msg.allowed);
                break;
            case 'submitPlanAnnotations':
                await this.submitPlanAnnotations(msg.annotations);
                break;
            case 'openPlanFile':
                this.openPlanAnnotationPanel(msg.filePath);
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
        vs.window.showInformationMessage('Eddy CWTool Code 设置已保存');
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
        this._isGenerating = true;
        this._liveSteps = [];

        try {
            const result = await this.agentRunner.run(
                text,
                context,
                this.conversationMessages,
                {
                    mode: this.currentMode,
                    onStep: (step) => {
                        this._liveSteps.push(step);
                        this.postMessage({ type: 'agentStep', step });
                    },
                    abortSignal: this.abortController.signal,
                    // Permission callback for run_command tool (OpenCode strategy)
                    onPermissionRequest: (id, tool, description, command) =>
                        this.requestPermission(id, tool, description, command),
                }
            );

            // ── Update conversation history ────────────────────────────────────────
            const assistantContent = result.code
                ? `${result.explanation}\n\`\`\`pdx\n${result.code}\n\`\`\``
                : result.explanation;
            this.conversationMessages.push(
                { role: 'user', content: text },
                { role: 'assistant', content: assistantContent }
            );

            // ── Plan mode: suppress explanation in chat, auto-open annotation panel ──
            if (this.currentMode === 'plan' && result.explanation) {
                // Chat shows only tool-call steps (no full plan text)
                this.postMessage({ type: 'generationComplete', result: { ...result, explanation: '', code: '' } });
                this.addHistoryMessage({
                    role: 'assistant',
                    content: '📋 计划已生成，已在批注视图中打开',
                    timestamp: Date.now(),
                    steps: result.steps,
                });
                this.savePlanFile(result.explanation, text);
            } else {
                this.postMessage({ type: 'generationComplete', result });
                this.addHistoryMessage({
                    role: 'assistant',
                    content: result.explanation,
                    code: result.code || undefined,
                    isValid: result.isValid,
                    timestamp: Date.now(),
                    steps: result.steps,
                });
            }
            this.saveTopics();

            // ── Auto-title: generate a short AI title after the first exchange ─
            // Matches OpenCode's title-agent pattern: fire-and-forget, no blocking
            const isFirstExchange = this.currentTopic &&
                this.currentTopic.messages.filter(m => m.role === 'user').length === 1;
            if (isFirstExchange && this.currentTopic) {
                const topicId = this.currentTopic.id;
                const replyText = result.explanation || (result.code ? result.code.substring(0, 400) : '');
                // Non-blocking: run in background, update UI when done
                this.agentRunner.generateTopicTitle(text, replyText).then(title => {
                    if (!title) return;
                    const topic = this.topics.find(t => t.id === topicId);
                    if (topic) {
                        topic.title = title;
                        this.saveTopics();
                        this.postMessage({ type: 'topicTitleGenerated', topicId, title });
                    }
                }).catch(() => { /* ignore title generation failures silently */ });
            }
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            this.postMessage({ type: 'generationError', error: errorMsg });
        } finally {
            this.abortController = null;
            this._isGenerating = false;
            this._liveSteps = [];
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

    // ─── Plan File ───────────────────────────────────────────────────────────

    /**
     * Save plan as .md for export, and emit renderPlan so the webview can
     * display an interactive inline annotation interface.
     */
    private savePlanFile(planText: string, userPrompt: string): void {
        // ── Persist .md export ──────────────────────────────────────────────
        const wsRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let filePath = '';
        let relPath = '';
        if (wsRoot) {
            const planDir = path.join(wsRoot, '.cwtools-ai');
            if (!fs.existsSync(planDir)) fs.mkdirSync(planDir, { recursive: true });
            const slug = userPrompt
                .replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '_')
                .substring(0, 30)
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const fileName = `plan_${slug}_${timestamp}.md`;
            filePath = path.join(planDir, fileName);
            relPath = path.relative(wsRoot, filePath).replace(/\\/g, '/');
            fs.writeFileSync(filePath, '\uFEFF' + planText, 'utf-8');
        }
        // ── Notify webview: show file card (open button) ────────────────────
        if (filePath) {
            this._pendingPlanFile = { filePath, relPath };
            this.postMessage({ type: 'planFileSaved', filePath, relPath });
        }
        // ── Auto-open annotation WebviewPanel ───────────────────────────────
        this.openPlanAnnotationPanel(filePath, planText);
    }

    /**
     * Open the plan file in a dedicated WebviewPanel that renders
     * the markdown with an interactive inline annotation interface.
     * When the user submits annotations, they're sent back to the AI.
     */
    private openPlanAnnotationPanel(filePath: string, planContent?: string): void {
        const content = planContent
            ?? (fs.existsSync(filePath)
                ? fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '')
                : null);
        if (!content) {
            vs.window.showErrorMessage(`计划文件不存在: ${filePath}`);
            return;
        }
        const fileName = path.basename(filePath);
        const panel = vs.window.createWebviewPanel(
            'eddyPlanAnnotation',
            `批注 — ${fileName}`,
            vs.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [] }
        );
        panel.webview.html = this.getPlanAnnotationHtml(content, fileName);
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'submitAnnotations' && msg.annotations?.length > 0) {
                panel.dispose();
                await new Promise<void>(r => setTimeout(r, 120));
                await this.submitPlanAnnotations(msg.annotations);
            } else if (msg.type === 'openRawFile') {
                vs.commands.executeCommand('vscode.open', vs.Uri.file(filePath));
            }
        });
    }

    /** Generate the HTML for the plan annotation WebviewPanel */
    /** Generate the HTML for the plan annotation WebviewPanel */
    private getPlanAnnotationHtml(content: string, fileName: string): string {
        const escTitle = fileName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Escape </script> to prevent premature script-tag termination
        const safeJson = JSON.stringify(content).replace(/<\/script>/gi, '<\\/script>');
        const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:#1e1e2e;color:#cdd6f4;font-size:14px;line-height:1.7;}
.toolbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:10px;padding:9px 20px;background:#181825;border-bottom:1px solid rgba(255,255,255,0.08);}
.toolbar-title{flex:1;font-size:13px;font-weight:600;opacity:0.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.raw-btn{background:none;border:1px solid rgba(255,255,255,0.12);color:#cdd6f4;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;opacity:0.6;transition:opacity .15s;}
.raw-btn:hover{opacity:1;}
.submit-btn{background:#a6e3a1;color:#1e1e2e;border:none;border-radius:6px;padding:5px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:opacity .15s;}
.submit-btn:disabled{opacity:0.3;cursor:default;}
.submit-btn:not(:disabled):hover{opacity:0.85;}
.content{max-width:800px;margin:0 auto;padding:28px 24px 80px;}
.block{position:relative;margin:2px 0;padding:6px 44px 6px 14px;border-radius:6px;cursor:pointer;transition:background .12s;border-left:3px solid transparent;}
.block:hover{background:rgba(137,220,235,0.06);}
.block.annotated{background:rgba(249,226,175,0.05);border-left-color:#f9e2af;}
.block.active{background:rgba(137,220,235,0.07);}
.add-btn{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:1px solid rgba(137,220,235,0.35);color:#89dceb;border-radius:4px;width:26px;height:26px;font-size:14px;cursor:pointer;opacity:0;transition:opacity .15s;display:flex;align-items:center;justify-content:center;}
.block:hover .add-btn,.block.active .add-btn{opacity:1;}
.block.annotated .add-btn{display:none;}
.block h1{color:#cba6f7;font-size:22px;font-weight:700;margin-bottom:2px;}
.block h2{color:#89b4fa;font-size:18px;font-weight:600;padding-top:6px;margin-bottom:2px;}
.block h3{color:#94e2d5;font-size:15px;font-weight:600;}
.block h4{font-size:14px;font-weight:600;opacity:0.85;}
.block code{background:rgba(255,255,255,0.07);border-radius:3px;padding:1px 5px;font-family:monospace;font-size:12px;}
.block pre{background:rgba(0,0,0,0.3);border-radius:6px;padding:12px;overflow-x:auto;margin:4px 0;}
.block pre code{background:none;padding:0;}
.block ul,.block ol{padding-left:20px;}
.block li{margin:2px 0;}
.block strong{color:#fab387;}
.block hr{border:none;border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;}
.ann-input{margin-top:6px;border:1px solid rgba(137,220,235,0.3);border-radius:8px;overflow:hidden;background:#313244;}
.ann-textarea{display:block;width:100%;background:transparent;border:none;color:#cdd6f4;font-size:13px;font-family:inherit;padding:10px 12px;resize:none;outline:none;min-height:66px;line-height:1.5;}
.ann-actions{display:flex;gap:6px;padding:6px 10px;border-top:1px solid rgba(137,220,235,0.15);background:rgba(0,0,0,0.15);align-items:center;}
.ann-hint{flex:1;font-size:11px;opacity:0.4;}
.ann-confirm{background:#89dceb;color:#1e1e2e;border:none;border-radius:4px;padding:4px 14px;font-size:12px;cursor:pointer;font-weight:700;font-family:inherit;}
.ann-cancel{background:none;border:1px solid rgba(255,255,255,0.12);color:#cdd6f4;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;}
.ann-bubble{display:flex;align-items:flex-start;gap:6px;margin-top:6px;padding:8px 10px;background:rgba(249,226,175,0.07);border-left:3px solid #f9e2af;border-radius:0 6px 6px 0;}
.ann-bubble-icon{font-size:13px;flex-shrink:0;}
.ann-bubble-text{flex:1;font-size:12px;opacity:0.9;word-break:break-word;line-height:1.5;}
.ann-bubble-edit{background:none;border:none;color:#89b4fa;cursor:pointer;font-size:11px;opacity:0.7;font-family:inherit;padding:0 2px;}
.ann-bubble-edit:hover{opacity:1;}`.trim();

        // JS is kept as a separate string to avoid template literal nesting issues
        const js = `
(function(){
try {
  var vscode = acquireVsCodeApi();
  var annotations = {};
  var PLAN = ${safeJson};

  function parseBlocks(md) {
    var lines = md.split('\n'), blocks = [], buf = [];
    function flush() { var s = buf.join('\n').trim(); if (s) blocks.push(s); buf = []; }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^#{1,6}\s/.test(l)) { flush(); blocks.push(l); }
      else if (l.trim() === '') { flush(); }
      else buf.push(l);
    }
    flush();
    return blocks;
  }

  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function mdHtml(t) {
    var h = esc(t);
    // headings
    h = h.replace(/^(#{1,4}) (.+)$/gm, function(_, hh, tx) {
      return '<h' + hh.length + '>' + tx + '</h' + hh.length + '>';
    });
    // bold
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // list items
    h = h.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // hr
    h = h.replace(/^---+$/gm, '<hr>');
    // line breaks
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  var blocks = parseBlocks(PLAN);
  var contentEl = document.getElementById('content');
  var submitBtn = document.getElementById('submitBtn');

  function updateSubmit() {
    var n = Object.keys(annotations).length;
    submitBtn.textContent = '\uD83D\uDCE4 \u63D0\u4EA4\u6279\u6CE8\u7ED9 AI (' + n + ')';
    submitBtn.disabled = n === 0;
  }

  blocks.forEach(function(block, idx) {
    var el = document.createElement('div');
    el.className = 'block';

    var txt = document.createElement('div');
    txt.innerHTML = mdHtml(block);
    el.appendChild(txt);

    var addBtn = document.createElement('button');
    addBtn.className = 'add-btn';
    addBtn.title = '\u6DFB\u52A0\u6279\u6CE8';
    addBtn.textContent = '\uD83D\uDCAC';
    el.appendChild(addBtn);

    var bubble = document.createElement('div');
    bubble.className = 'ann-bubble';
    bubble.style.display = 'none';
    el.appendChild(bubble);

    var box = document.createElement('div');
    box.className = 'ann-input';
    box.style.display = 'none';
    box.innerHTML = '<textarea class="ann-textarea" placeholder="\u8F93\u5165\u6279\u6CE8\u5185\u5BB9\u2026"></textarea>'
      + '<div class="ann-actions"><span class="ann-hint">Ctrl+Enter \u786E\u8BA4\uFF0CEsc \u53D6\u6D88</span>'
      + '<button class="ann-cancel">\u53D6\u6D88</button><button class="ann-confirm">\u786E\u5B9A</button></div>';
    el.appendChild(box);

    function openInput() {
      box.querySelector('.ann-textarea').value = annotations[idx] || '';
      box.style.display = 'block'; bubble.style.display = 'none';
      el.classList.add('active');
      setTimeout(function() { box.querySelector('.ann-textarea').focus(); }, 0);
    }
    function closeInput() { box.style.display = 'none'; el.classList.remove('active'); }
    function confirmAnnotation() {
      var v = box.querySelector('.ann-textarea').value.trim();
      closeInput();
      if (!v) {
        delete annotations[idx];
        bubble.style.display = 'none'; el.classList.remove('annotated');
      } else {
        annotations[idx] = v;
        bubble.innerHTML = '<span class="ann-bubble-icon">\uD83D\uDCAC</span>'
          + '<span class="ann-bubble-text">' + esc(v) + '</span>'
          + '<button class="ann-bubble-edit">\u7F16\u8F91</button>';
        bubble.querySelector('.ann-bubble-edit').addEventListener('click', function(e) {
          e.stopPropagation(); openInput();
        });
        bubble.style.display = 'flex'; el.classList.add('annotated');
      }
      updateSubmit();
    }

    el.addEventListener('click', function() {
      if (box.style.display === 'none' && bubble.style.display === 'none') openInput();
    });
    addBtn.addEventListener('click', function(e) { e.stopPropagation(); openInput(); });
    box.addEventListener('click', function(e) { e.stopPropagation(); });
    box.querySelector('.ann-confirm').addEventListener('click', confirmAnnotation);
    box.querySelector('.ann-cancel').addEventListener('click', closeInput);
    box.querySelector('.ann-textarea').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmAnnotation();
      if (e.key === 'Escape') closeInput();
    });

    contentEl.appendChild(el);
  });

  submitBtn.addEventListener('click', function() {
    var keys = Object.keys(annotations);
    if (!keys.length) return;
    var data = keys.map(function(k) { return { section: blocks[+k], note: annotations[k] }; });
    vscode.postMessage({ type: 'submitAnnotations', annotations: data });
    submitBtn.textContent = '\u2705 \u5DF2\u63D0\u4EA4\u7ED9 AI';
    submitBtn.disabled = true;
  });

  document.getElementById('rawBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'openRawFile' });
  });

  document.addEventListener('click', function() {
    document.querySelectorAll('.ann-input').forEach(function(el) {
      if (el.style.display !== 'none') {
        el.style.display = 'none';
        var b = el.closest('.block');
        if (b) b.classList.remove('active');
      }
    });
  });

} catch(err) {
  document.getElementById('content').innerHTML =
    '<div style="color:#f38ba8;padding:20px;font-family:monospace">Error: ' + err.message + '</div>';
}
})();`.trim();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<title>\u6279\u6CE8 \u2014 ${escTitle}</title>
<style>${css}</style>
</head>
<body>
<div class="toolbar">
  <span class="toolbar-title">&#x270F;&#xFE0F; \u8BA1\u5212\u6279\u6CE8 \u2014 ${escTitle}</span>
  <button class="raw-btn" id="rawBtn">&#x1F4C4; \u67E5\u770B\u539F\u59CB\u6587\u4EF6</button>
  <button class="submit-btn" id="submitBtn" disabled>&#x1F4E4; \u63D0\u4EA4\u6279\u6CE8\u7ED9 AI (0)</button>
</div>
<div class="content" id="content"></div>
<script>${js}</script>
</body>
</html>`;
    }


    /**
     * Receive inline annotations collected in the webview and generate
     * a follow-up AI message requesting plan revisions.
     */
    private async submitPlanAnnotations(
        annotations: Array<{ section: string; note: string }>
    ): Promise<void> {
        if (!annotations || annotations.length === 0) {
            vs.window.showInformationMessage('没有批注需要提交');
            return;
        }
        const followUp = [
            '请根据以下批注修改计划：',
            ...annotations.map((a, i) => {
                const ctx = a.section.replace(/^#+\s*/, '').substring(0, 60);
                return `${i + 1}. 在"${ctx}"处：${a.note}`;
            }),
        ].join('\n');
        // Plan has been reviewed — clear the pending state so the card stops persisting
        this._pendingPlanFile = null;
        await this.handleUserMessage(followUp);
    }

    // ─── File Write Confirmation ──────────────────────────────────────────────

    private pendingWriteResolvers = new Map<string, (confirmed: boolean) => void>();
    /** Maps messageId → temp file path used for the diff view (for cleanup) */
    private pendingDiffTempFiles = new Map<string, string>();
    /** Auto-confirm timeout (120 s) — prevents hangs if WebView is hidden */
    private static readonly WRITE_CONFIRM_TIMEOUT_MS = 120_000;

    handlePendingWrite(file: string, newContent: string, messageId: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            // ── Timeout guard: auto-confirm after 120 s ───────────────────────
            // Prevents the agent reasoning loop from hanging indefinitely if the
            // WebView is hidden or the user ignores the confirmation card.
            const timeout = setTimeout(() => {
                if (this.pendingWriteResolvers.has(messageId)) {
                    console.warn(`[Eddy CWTool Code] Write confirm timeout for ${file} — auto-confirming`);
                    this.resolveWriteConfirmation(messageId, true);
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
                console.error('[Eddy CWTool Code] Failed to open diff view:', e);
            }

            // Tell the WebView to show a simple Accept/Reject card
            this.postMessage({ type: 'pendingWriteFile', file, messageId, isNewFile });
        });
    }

    resolveWriteConfirmation(messageId: string, confirmed: boolean): void {
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

            // Delete temp file
            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        }
    }

    /** Push todo update to the WebView (called by toolExecutor.onTodoUpdate) */
    sendTodoUpdate(todos: import('./types').TodoItem[]): void {
        this.postMessage({ type: 'todoUpdate', todos });
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

    /**
     * Fork a topic at a specific message index (OpenCode-style session fork).
     * Creates a new topic with messages[0..messageIndex], switches to it.
     */
    private forkTopic(topicId: string, messageIndex: number): void {
        const source = this.topics.find(t => t.id === topicId);
        if (!source) return;

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
        this.conversationMessages = forkedMessages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: m.code ? `${m.content}\n\`\`\`pdx\n${m.code}\n\`\`\`` : m.content }));

        this.postMessage({ type: 'clearChat' });
        this.postMessage({ type: 'loadTopicMessages', messages: forkedMessages });
        this.postMessage({ type: 'topicForked', newTopicId: forked.id, title: forked.title });
        this.saveTopics();
        this.sendTopicList();
    }

    /** Archive/unarchive a topic (hidden from main list but not deleted) */
    private archiveTopic(topicId: string): void {
        const topic = this.topics.find(t => t.id === topicId);
        if (!topic) return;
        topic.archived = !topic.archived;
        if (this.currentTopic?.id === topicId && topic.archived) {
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

    /**
     * Handle slash commands from the WebView e.g. /clear, /fork, /mode:build, /init.
     */
    private async handleSlashCommand(command: string): Promise<void> {
        const cmd = command.trim().toLowerCase();
        if (cmd === 'clear' || cmd === '/clear') {
            this.startNewTopic();
        } else if (cmd.startsWith('mode:') || cmd.startsWith('/mode:')) {
            const mode = cmd.split(':')[1] as AgentMode;
            if (['build', 'plan', 'explore', 'general'].includes(mode)) {
                this.switchMode(mode);
            }
        } else if (cmd === 'fork' || cmd === '/fork') {
            if (this.currentTopic && this.currentTopic.messages.length > 0) {
                this.forkTopic(this.currentTopic.id, this.currentTopic.messages.length - 1);
            }
        } else if (cmd === 'archive' || cmd === '/archive') {
            if (this.currentTopic) {
                this.archiveTopic(this.currentTopic.id);
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
        const folders = vs.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vs.window.showWarningMessage('Eddy CWTool Code /init: 当前没有打开的工作区');
            return;
        }
        const root = folders[0].uri.fsPath;

        // Notify WebView that init is running
        this.postMessage({ type: 'agentStep', step: { type: 'thinking', content: '正在扫描工作区，生成项目规则文件...', timestamp: Date.now() } });

        try {
            // ── 1. Collect directory structure (top 2 levels) ──────────────────
            const topLevel = this.listDirShallow(root, 2);

            // ── 2. Detect mod descriptor ──────────────────────────────────────
            let modName = path.basename(root);
            let modVersion = '';
            let modTags = '';
            const descriptorPath = path.join(root, 'descriptor.mod');
            if (fs.existsSync(descriptorPath)) {
                const desc = fs.readFileSync(descriptorPath, 'utf-8');
                const nameMatch = desc.match(/^name\s*=\s*"?([^"\r\n]+)"?/m);
                const versionMatch = desc.match(/^version\s*=\s*"?([^"\r\n]+)"?/m);
                const tagsMatch = desc.match(/^tags\s*=\s*\{([^}]+)\}/ms);
                if (nameMatch) modName = nameMatch[1].trim();
                if (versionMatch) modVersion = versionMatch[1].trim();
                if (tagsMatch) modTags = tagsMatch[1].replace(/\s+/g, ' ').trim();
            }

            // ── 3. Sample key identifiers (scripted triggers & effects) ────────
            const triggerIds = this.sampleIds(path.join(root, 'common', 'scripted_triggers'), 20);
            const effectIds  = this.sampleIds(path.join(root, 'common', 'scripted_effects'), 20);
            const eventIds   = this.sampleIds(path.join(root, 'events'), 10);

            // ── 4. Build CWTOOLS.md content ───────────────────────────────────
            const now = new Date().toISOString().split('T')[0];
            const lines: string[] = [
                `# Eddy CWTool Code Project Rules — ${modName}`,
                ``,
                `> Auto-generated by \`/init\` on ${now}. Edit freely.`,
                ``,
                `## Mod Info`,
                `- **Name**: ${modName}`,
                modVersion ? `- **Version**: ${modVersion}` : '',
                modTags    ? `- **Tags**: ${modTags}` : '',
                `- **Root**: \`${root}\``,
                ``,
                `## Project Structure`,
                '```',
                topLevel,
                '```',
                ``,
                `## Known Identifiers`,
                `When generating code that references these IDs, verify they exist before use.`,
                ``,
                triggerIds.length > 0
                    ? `### Scripted Triggers (sample)
${triggerIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                effectIds.length > 0
                    ? `\n### Scripted Effects (sample)
${effectIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                eventIds.length > 0
                    ? `\n### Events (sample)
${eventIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                ``,
                `## Agent Guidelines`,
                `- Always call \`query_types\` before using an identifier not listed above.`,
                `- Distinguish Type A (code bug) from Type B (reference not yet defined) errors.`,
                `- For multi-file tasks, check if referenced IDs are planned to be created later.`,
                `- Prefer \`edit_file\` over \`write_file\` for existing files.`,
                ``,
                `## Custom Rules`,
                `<!-- Add your project-specific rules here. This section survives /init re-runs. -->`,
            ];

            const content = lines.filter(l => l !== undefined && l !== null).join('\n');
            const outPath = path.join(root, 'CWTOOLS.md');

            // Preserve the "Custom Rules" section if file already exists
            let finalContent = content;
            if (fs.existsSync(outPath)) {
                const existing = fs.readFileSync(outPath, 'utf-8');
                const customMatch = existing.match(/## Custom Rules\n([\s\S]*)/);
                if (customMatch && customMatch[1].trim().length > 0 && !customMatch[1].includes('<!-- Add')) {
                    finalContent = content.replace(
                        /## Custom Rules\n<!-- Add[^]*$/,
                        `## Custom Rules\n${customMatch[1]}`
                    );
                }
            }

            fs.writeFileSync(outPath, finalContent, 'utf-8');

            // Open the file in editor
            const doc = await vs.workspace.openTextDocument(vs.Uri.file(outPath));
            await vs.window.showTextDocument(doc, { preview: false });

            // Notify in chat
            this.postMessage({
                type: 'agentStep',
                step: { type: 'validation', content: `CWTOOLS.md 已生成 → ${outPath}`, timestamp: Date.now() }
            });

            vs.window.showInformationMessage(`Eddy CWTool Code: CWTOOLS.md 已写入 ${path.basename(root)} 根目录`);

        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.postMessage({ type: 'agentStep', step: { type: 'error', content: `/init 失败: ${msg}`, timestamp: Date.now() } });
        }
    }

    /** List directory shallowly (max depth), return tree string */
    private listDirShallow(dir: string, maxDepth: number, depth = 0, prefix = ''): string {
        if (!fs.existsSync(dir) || depth > maxDepth) return '';
        const IGNORE = new Set(['node_modules', '.git', '.cwtools', '__pycache__', 'bin', 'obj', 'release']);
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
            .slice(0, 30); // cap at 30 per level
        const lines: string[] = [];
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            lines.push(prefix + connector + e.name + (e.isDirectory() ? '/' : ''));
            if (e.isDirectory() && depth < maxDepth) {
                const childPrefix = prefix + (isLast ? '    ' : '│   ');
                lines.push(this.listDirShallow(path.join(dir, e.name), maxDepth, depth + 1, childPrefix));
            }
        }
        return lines.filter(Boolean).join('\n');
    }

    /** Sample identifier keys from .txt files in a directory */
    private sampleIds(dir: string, maxCount: number): string[] {
        if (!fs.existsSync(dir)) return [];
        const ids: string[] = [];
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.txt')).slice(0, 10)) {
            try {
                const content = fs.readFileSync(path.join(dir, file), 'utf-8');
                // Match top-level identifier keys: key = {...} or key = value
                const matches = content.match(/^(\w[\w.:-]*)\s*=/gm) || [];
                for (const m of matches) {
                    const id = m.replace(/\s*=$/, '').trim();
                    if (id && !ids.includes(id) && id.length > 2) ids.push(id);
                    if (ids.length >= maxCount) break;
                }
            } catch { /* skip unreadable file */ }
            if (ids.length >= maxCount) break;
        }
        return ids.slice(0, maxCount);
    }

    // ─── Permission System (OpenCode-aligned) ────────────────────────────────────

    private pendingPermissionResolvers = new Map<string, (allowed: boolean) => void>();

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
        return new Promise<boolean>((resolve) => {
            // Auto-deny after 60s to prevent hangs
            const timeout = setTimeout(() => {
                if (this.pendingPermissionResolvers.has(id)) {
                    this.pendingPermissionResolvers.delete(id);
                    resolve(false);
                }
            }, 60_000);

            this.pendingPermissionResolvers.set(id, (allowed: boolean) => {
                clearTimeout(timeout);
                resolve(allowed);
            });

            this.postMessage({ type: 'permissionRequest', permissionId: id, tool, description, command });
        });
    }

    private resolvePermissionRequest(permissionId: string, allowed: boolean): void {
        const resolver = this.pendingPermissionResolvers.get(permissionId);
        if (resolver) {
            this.pendingPermissionResolvers.delete(permissionId);
            resolver(allowed);
        }
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
<title>Eddy CWTool Code</title>
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

.header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.header-title { display: flex; align-items: center; gap: 8px; }
.header-brand-icon { width: 18px; height: 18px; flex-shrink: 0; filter: drop-shadow(0 0 3px rgba(232,200,64,0.4)); }
.brand-text { font-family: Georgia, Cambria, serif; font-size: 15px; font-weight: 600; letter-spacing: 0.3px; color: #f0f0f0; }
.header-actions { display: flex; gap: 4px; }
.icon-btn { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: var(--fg); cursor: pointer; padding: 5px 9px; border-radius: 6px; font-size: 14px; opacity: 0.75; transition: opacity 0.15s, background 0.15s, border-color 0.15s; font-weight: 400; }
.icon-btn:hover { opacity: 1; background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); }

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

.chat-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 20px; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes spin { to { transform: rotate(360deg); } }
.message { display: flex; flex-direction: column; animation: fadeIn 0.2s ease; gap: 4px; }
.msg-header { display: flex; align-items: center; gap: 6px; font-size: 11.5px; opacity: 0.65; }
.msg-role { font-family: Georgia, serif; font-weight: 500; }
.user-role { opacity: 0.7; }
.ai-star { flex-shrink: 0; }
.msg-bubble { line-height: 1.65; word-break: break-word; padding: 1px 0; }
.user-bubble { background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin-left: 0; white-space: pre-wrap; }
.msg-bubble code { background: rgba(255,255,255,0.1); border-radius: 3px; padding: 0 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.msg-bubble pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; overflow-x: auto; margin: 6px 0; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
.msg-bubble pre code { background: none; padding: 0; }
.retract-btn { display: none; background: none; border: none; cursor: pointer; font-size: 11px; opacity: 0.35; padding: 2px 5px; border-radius: 3px; color: var(--fg); }
.message.user:hover .retract-btn { display: inline-flex; }
.retract-btn:hover { opacity: 1; background: var(--btn-hover); }
.message.retracted .msg-bubble { opacity: 0.4; font-style: italic; pointer-events: none; }
.message.retracted .retract-btn { display: none !important; }

/* ── Thinking block (OpenCode style) ── */
.thinking-block { margin: 6px 0; border: 1px solid var(--thinking-border); border-radius: 8px; overflow: hidden; background: var(--thinking-bg); }
.thinking-block > summary { cursor: pointer; padding: 7px 12px; user-select: none; display: flex; align-items: center; gap: 7px; list-style: none; color: cornflowerblue; font-size: 11.5px; }
.thinking-block > summary::-webkit-details-marker { display: none; }
.thinking-block > summary::before { content: '▶'; font-size: 8px; opacity: 0.45; transition: transform 0.15s; flex-shrink: 0; }
.thinking-block[open] > summary::before { transform: rotate(90deg); }
.think-pulse { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: cornflowerblue; flex-shrink: 0; opacity: 0.8; }
.think-pulse.spinning { animation: spin 1s linear infinite; border: 2px solid rgba(100,149,237,0.3); background: none; border-top-color: cornflowerblue; }
.think-tokens { font-size: 10px; opacity: 0.5; }
.thinking-body { padding: 10px 12px; border-top: 1px solid var(--thinking-border); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; opacity: 0.7; max-height: 320px; overflow-y: auto; }

/* ── Tool group (OpenCode paired style) ── */
.tool-group { margin: 4px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.tool-group > summary { cursor: pointer; padding: 7px 12px; background: rgba(255,255,255,0.025); user-select: none; display: flex; align-items: center; gap: 7px; list-style: none; font-size: 11.5px; opacity: 0.75; }
.tool-group > summary::-webkit-details-marker { display: none; }
.tool-group > summary::before { content: '▶'; font-size: 8px; opacity: 0.4; transition: transform 0.15s; flex-shrink: 0; }
.tool-group[open] > summary::before { transform: rotate(90deg); }
.tg-icon { opacity: 0.6; }
.tool-group-body { padding: 4px 0; border-top: 1px solid var(--border); }
/* Tool pair row */
.tool-pair { display: flex; align-items: center; justify-content: space-between; padding: 4px 12px; gap: 8px; }
.tool-pair:not(:last-child) { border-bottom: 1px solid rgba(255,255,255,0.04); }
.tp-call { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.75; min-width: 0; flex: 1; }
.tp-icon { flex-shrink: 0; font-size: 12px; }
.tp-name { font-family: var(--vscode-editor-font-family, monospace); }
.tp-file { color: #7ab4d4; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.tp-result { font-size: 10.5px; flex-shrink: 0; padding: 1px 6px; border-radius: 4px; }
.tp-result.ok { color: var(--success); }
.tp-result.err { color: var(--error); }
.tp-result.skip { opacity: 0.35; }
/* Special steps (errors, compaction) */
.special-step { font-size: 11px; padding: 3px 0; opacity: 0.65; }

/* ── Code block ── */
.code-block { background: var(--code-bg); border: 1px solid var(--border); border-radius: 4px; margin: 6px 0; overflow: hidden; }
.code-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: rgba(255,255,255,0.04); border-bottom: 1px solid var(--border); font-size: 11px; }
.code-status.valid { color: var(--success); }
.code-status.invalid { color: var(--error); }
.code-actions { display: flex; gap: 4px; }
.code-btn { background: none; color: var(--fg); border: 1px solid var(--border); padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 10px; opacity: 0.7; }
.code-btn:hover { opacity: 1; background: var(--btn-hover); }
.code-content { padding: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow-x: auto; white-space: pre; }

/* ── Markdown rendering (inside .msg-bubble) ── */
.msg-bubble h1,.msg-bubble h2,.msg-bubble h3,.msg-bubble h4,.msg-bubble h5,.msg-bubble h6 { font-family: Georgia,serif; font-weight:600; margin:10px 0 4px; line-height:1.3; }
.msg-bubble h1 { font-size:1.2em; border-bottom:1px solid var(--border); padding-bottom:4px; }
.msg-bubble h2 { font-size:1.1em; }
.msg-bubble h3 { font-size:1.0em; }
.msg-bubble h4,.msg-bubble h5,.msg-bubble h6 { font-size:0.95em; opacity:0.85; }
.msg-bubble p  { margin:5px 0; }
.msg-bubble ul,.msg-bubble ol { margin:5px 0 5px 18px; padding:0; }
.msg-bubble li { margin:2px 0; }
.msg-bubble blockquote { margin:6px 0; padding:4px 10px; border-left:3px solid var(--accent); background:rgba(255,255,255,0.04); border-radius:0 4px 4px 0; opacity:0.85; }
.msg-bubble hr { border:none; border-top:1px solid var(--border); margin:8px 0; }
.msg-bubble table { border-collapse:collapse; width:100%; margin:6px 0; font-size:12px; }
.msg-bubble th,.msg-bubble td { border:1px solid var(--border); padding:4px 8px; text-align:left; }
.msg-bubble th { background:rgba(255,255,255,0.05); font-weight:600; }
.msg-bubble strong { font-weight:700; }
.msg-bubble em { font-style:italic; }
.msg-bubble del { text-decoration:line-through; opacity:0.6; }
.msg-bubble a { color:#7ab4d4; text-decoration:none; }
.msg-bubble a:hover { text-decoration:underline; }
.msg-bubble .md-codeblock { background:var(--code-bg); border:1px solid var(--border); border-radius:6px; overflow:hidden; margin:6px 0; }
.msg-bubble .md-codeblock-lang { font-size:10px; opacity:0.5; padding:2px 8px; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border); letter-spacing:0.05em; text-transform:uppercase; }
.msg-bubble .md-codeblock-lang:empty { display:none; }
.msg-bubble .md-codeblock code { display:block; padding:8px 10px; font-family:var(--vscode-editor-font-family,monospace); font-size:12px; white-space:pre; overflow-x:auto; background:none; border-radius:0; }
.msg-bubble code { background:rgba(255,255,255,0.1); border-radius:3px; padding:1px 4px; font-family:var(--vscode-editor-font-family,monospace); font-size:11px; }

/* ── Diff card ── */
.diff-card { border: 1px solid var(--warning); border-radius: 6px; overflow: hidden; margin: 4px 0; font-size: 11px; }
.diff-card-header { background: rgba(255,152,0,0.12); padding: 8px 12px; font-size: 12px; display:flex; align-items:center; gap:6px; }
.diff-card-hint { font-size:11px; opacity:0.6; flex:1; }
.diff-card-actions { padding: 6px 10px; display: flex; gap: 6px; background: var(--bg); border-top:1px solid var(--border); }
.diff-accept-btn { background: #4caf50; color: #fff; border: none; border-radius: 4px; padding: 4px 14px; cursor: pointer; font-size: 11px; }
.diff-reject-btn { background: none; border: 1px solid var(--border); color: var(--fg); border-radius: 4px; padding: 4px 14px; cursor: pointer; font-size: 11px; }

/* ── Empty state + Suggestion cards ── */
.empty-state { margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 32px 16px; gap: 6px; }
.empty-icon { font-size: 40px; color: var(--accent); margin-bottom: 8px; }
.empty-tagline { font-size: 11px; opacity: 0.45; margin-bottom: 16px; }
.suggest-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; width: 100%; max-width: 280px; }
.suggest-card { background: var(--input-bg); border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; cursor: pointer; text-align: left; font-size: 11px; color: var(--fg); opacity: 0.7; transition: all 0.15s; line-height: 1.4; font-family: inherit; }
.suggest-card:hover { opacity: 1; border-color: #555; background: var(--btn-hover); transform: translateY(-1px); }
.suggest-card-icon { font-size: 14px; display: block; margin-bottom: 3px; }
.mode-select { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); color: var(--fg); cursor: pointer; padding: 4px 8px; font-size: 11px; border-radius: 6px; outline: none; font-family: inherit; transition: all 0.15s; flex-shrink: 0; max-width: 160px; }
.mode-select:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.25); }
.mode-select option { background: var(--input-bg); color: var(--fg); }
.model-selector { flex: 1; min-width: 0; max-width: 170px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); color: var(--fg); cursor: pointer; padding: 4px 8px; font-size: 11px; border-radius: 6px; outline: none; font-family: inherit; transition: all 0.15s; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-selector:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.25); }
.model-selector option { background: var(--input-bg); color: var(--fg); }

/* ── Input area ── */
.input-wrapper { padding: 10px 12px 12px; flex-shrink: 0; }
.input-container { background: var(--input-bg); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; overflow: hidden; transition: border-color 0.15s; }
.input-container:focus-within { border-color: rgba(255,255,255,0.25); }
.input-row { display: flex; padding: 10px 12px 4px; }
.input-row textarea { flex: 1; background: transparent; color: var(--input-fg); border: none; padding: 2px 0; font-family: inherit; font-size: 13px; resize: none; min-height: 22px; max-height: 180px; outline: none; line-height: 1.55; }
.input-row textarea::placeholder { opacity: 0.3; transition: opacity 0.3s; }
.input-controls { display: flex; justify-content: space-between; align-items: center; padding: 4px 10px 8px; gap: 6px; }
.ctrl-group { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
/* Gold send button matching reference image */
.send-btn { background: var(--accent); color: #1a1a1a; border: none; border-radius: 6px; width: 32px; height: 32px; cursor: pointer; font-size: 16px; line-height: 1; transition: opacity 0.15s, background 0.15s; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.send-btn:hover { opacity: 0.85; }
.send-btn.cancel-mode { background: rgba(244,67,54,0.15); color: var(--error); border: 1px solid rgba(244,67,54,0.35); }
.send-icon { font-weight: 700; }
.stop-icon { display: inline-block; width: 9px; height: 9px; background: var(--error); border-radius: 2px; }
/* Token usage bar */
.token-usage-bar { height: 2px; background: var(--border); overflow: hidden; margin: 2px 0 4px; }
.token-usage-fill { height: 100%; background: var(--accent); transition: width 0.4s; border-radius: 1px; }
.token-usage-label { font-size: 10px; opacity: 0.35; text-align: right; padding: 0 8px 4px; }
/* Message timestamp */
.msg-time { font-size: 10px; opacity: 0.3; margin-left: auto; font-family: monospace; }
/* Topic date groups */
.topic-date-group { font-size: 10px; opacity: 0.38; padding: 8px 8px 3px; letter-spacing: 0.05em; text-transform: uppercase; font-weight: 600; }
.topic-date-group:first-child { padding-top: 4px; }
/* Retract confirm */
.retract-confirm { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 999; display: flex; align-items: center; justify-content: center; }
.retract-confirm-box { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px 22px; max-width: 260px; text-align: center; }
.retract-confirm-title { font-size: 13px; margin-bottom: 8px; }
.retract-confirm-hint { font-size: 11px; opacity: 0.5; margin-bottom: 14px; }
.retract-confirm-btns { display: flex; gap: 8px; justify-content: center; }
.retract-ok { background: var(--error); color: #fff; border: none; border-radius: 6px; padding: 6px 18px; cursor: pointer; font-size: 12px; }
.retract-cancel { background: none; border: 1px solid var(--border); color: var(--fg); border-radius: 6px; padding: 6px 18px; cursor: pointer; font-size: 12px; }

/* ── Permission request card ── */
.permission-card { border: 1px solid #d9a020; border-radius: 8px; overflow: hidden; margin: 6px 0; }
.permission-card-header { background: rgba(217,160,32,0.12); padding: 9px 13px; font-size: 12px; display: flex; align-items: flex-start; gap: 8px; }
.permission-card-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
.permission-card-body { flex: 1; }
.permission-card-title { font-weight: 600; margin-bottom: 3px; }
.permission-card-cmd { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; background: rgba(0,0,0,0.25); border-radius: 4px; padding: 3px 6px; margin-top: 4px; opacity: 0.9; word-break: break-all; }
.permission-card-actions { padding: 7px 10px; display: flex; gap: 6px; background: var(--bg); border-top: 1px solid rgba(255,255,255,0.07); }
.permission-allow-btn { background: #4caf50; color: #fff; border: none; border-radius: 4px; padding: 4px 14px; cursor: pointer; font-size: 11px; }
.permission-deny-btn { background: none; border: 1px solid var(--border); color: var(--fg); border-radius: 4px; padding: 4px 14px; cursor: pointer; font-size: 11px; }

/* ── Plan file card ── */
.plan-file-card { display: flex; align-items: flex-start; gap: 10px; background: rgba(100,149,237,0.07); border: 1px solid rgba(100,149,237,0.25); border-radius: 8px; padding: 10px 12px; margin: 6px 0; }
.plan-file-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
.plan-file-info { flex: 1; min-width: 0; }
.plan-file-title { font-size: 12px; font-weight: 600; color: cornflowerblue; margin-bottom: 2px; }
.plan-file-path { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.65; word-break: break-all; margin-bottom: 4px; }
.plan-file-hint { font-size: 11px; opacity: 0.5; }
.plan-file-hint code { background: rgba(255,255,255,0.08); border-radius: 3px; padding: 1px 4px; font-family: inherit; }
.plan-file-actions { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
.plan-open-btn, .plan-submit-btn { font-size: 11px; border-radius: 5px; padding: 4px 10px; cursor: pointer; border: none; font-family: inherit; white-space: nowrap; transition: opacity 0.15s; }
.plan-open-btn { background: rgba(100,149,237,0.2); color: cornflowerblue; border: 1px solid rgba(100,149,237,0.3); }
.plan-open-btn:hover { background: rgba(100,149,237,0.35); }
.plan-submit-btn { background: var(--accent); color: #1a1a1a; font-weight: 600; }
.plan-submit-btn:hover { opacity: 0.85; }

/* ── Annotatable plan view ── */
.annotatable-plan { border: 1px solid rgba(100,149,237,0.2); border-radius: 8px; overflow: hidden; margin: 8px 0; font-size: 12px; }
.ap-header { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: rgba(100,149,237,0.08); border-bottom: 1px solid rgba(100,149,237,0.15); }
.ap-header-title { font-weight: 600; color: cornflowerblue; font-size: 12px; }
.ap-header-hint { flex: 1; font-size: 11px; opacity: 0.5; }
.ap-submit-btn { font-size: 11px; border-radius: 5px; padding: 4px 12px; cursor: pointer; border: none; background: var(--accent); color: #1a1a1a; font-weight: 600; font-family: inherit; transition: opacity 0.15s; }
.ap-submit-btn:disabled { opacity: 0.35; cursor: default; }
.ap-submit-btn:not(:disabled):hover { opacity: 0.85; }
.ap-sections { display: flex; flex-direction: column; }
.ap-row { position: relative; padding: 7px 36px 7px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer; transition: background 0.12s; }
.ap-row:last-child { border-bottom: none; }
.ap-row:hover, .ap-row-active { background: rgba(100,149,237,0.06); }
.ap-row-annotated { background: rgba(255,200,50,0.05); }
.ap-section-text { font-size: 12px; line-height: 1.55; color: var(--fg); opacity: 0.9; pointer-events: none; }
.ap-heading { display: block; margin-bottom: 2px; }
.ap-h1 { font-size: 13px; color: var(--fg); }
.ap-h2 { font-size: 12px; opacity: 0.9; }
.ap-h3 { font-size: 11px; opacity: 0.75; }
.ap-add-btn { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 14px; opacity: 0; transition: opacity 0.15s; line-height: 1; padding: 2px; }
.ap-row:hover .ap-add-btn, .ap-row-active .ap-add-btn { opacity: 0.6; }
.ap-row.ap-row-annotated .ap-add-btn { opacity: 0; }
.ap-bubble { display: flex; align-items: flex-start; gap: 5px; margin-top: 5px; padding: 5px 8px; background: rgba(255,200,50,0.1); border-left: 2px solid #ffc832; border-radius: 0 4px 4px 0; font-size: 11px; }
.ap-bubble-icon { flex-shrink: 0; font-size: 12px; }
.ap-bubble-text { flex: 1; color: var(--fg); opacity: 0.85; word-break: break-word; }
.ap-bubble-edit { flex-shrink: 0; background: none; border: none; color: cornflowerblue; cursor: pointer; font-size: 10px; opacity: 0.7; padding: 0 2px; font-family: inherit; }
.ap-bubble-edit:hover { opacity: 1; }
.ap-input-box { margin-top: 6px; border: 1px solid rgba(100,149,237,0.3); border-radius: 6px; overflow: hidden; background: var(--input-bg); }
.ap-textarea { display: block; width: 100%; box-sizing: border-box; background: transparent; border: none; color: var(--fg); font-size: 12px; font-family: inherit; padding: 7px 10px; resize: vertical; outline: none; min-height: 56px; line-height: 1.5; }
.ap-input-actions { display: flex; gap: 5px; padding: 5px 8px; border-top: 1px solid rgba(100,149,237,0.15); background: rgba(0,0,0,0.1); }
.ap-confirm-btn { background: var(--accent); color: #1a1a1a; border: none; border-radius: 4px; padding: 3px 14px; font-size: 11px; cursor: pointer; font-family: inherit; font-weight: 600; }
.ap-confirm-btn:hover { opacity: 0.85; }
.ap-cancel-btn { background: none; border: 1px solid var(--border); color: var(--fg); border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit; }

/* ── Streaming text cursor ── */
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
.stream-cursor::after { content: '|'; display: inline-block; animation: blink 0.8s ease-in-out infinite; color: var(--accent); margin-left: 1px; font-weight: 300; }

/* ── Topic action buttons ── */
.topic-actions { display: flex; gap: 2px; flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }
.topic-item:hover .topic-actions { opacity: 1; }
.topic-action-btn { padding: 2px 5px; font-size: 11px; border-radius: 3px; background: none; border: none; cursor: pointer; color: var(--fg); opacity: 0.55; }
.topic-action-btn:hover { opacity: 1; background: var(--btn-hover); }
.topic-fork-btn:hover { color: cornflowerblue; }
.topic-archive-btn:hover { color: var(--warning); }

/* ── Mode indicator (replaces plan-indicator) ── */
.mode-indicator { display: none; padding: 4px 16px; font-size: 11px; background: rgba(100,149,237,0.07); border-bottom: 1px solid var(--border); text-align: center; }
body.plan-mode .mode-indicator,
body.explore-mode .mode-indicator,
body.general-mode .mode-indicator { display: block; }
body.plan-mode .mode-indicator { color: cornflowerblue; }
body.explore-mode .mode-indicator { color: #7dbb7d; }
body.general-mode .mode-indicator { color: #c792ea; }

/* ── Slash command popup ── */
.slash-popup { display: none; position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; z-index: 200; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
.slash-popup.show { display: block; }
.slash-popup-item { padding: 7px 12px; cursor: pointer; display: flex; gap: 10px; align-items: center; font-size: 12px; }
.slash-popup-item:hover { background: var(--btn-hover); }
.slash-popup-cmd { font-family: var(--vscode-editor-font-family, monospace); color: var(--accent); font-weight: 600; flex-shrink: 0; }
.slash-popup-desc { opacity: 0.55; font-size: 11px; }

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
        <span class="brand-text">Eddy CWTool Code</span>
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
<div class="mode-indicator" id="modeIndicator">📋 Plan Mode — 只读分析，不修改文件</div>
<div class="todo-panel" id="todoPanel">
    <div class="todo-panel-title">Tasks</div>
    <div id="todoList"></div>
</div>

<div class="chat-area" id="chatArea">
    <div class="empty-state" id="emptyState">
        <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg></div>
        <div style="font-size:13px;font-family:Georgia,serif;">Eddy CWTool Code Assistant</div>
        <div class="empty-tagline">描述你的需求，AI 将生成并验证 Paradox 脚本</div>
        <div class="suggest-cards">
            <button class="suggest-card" data-suggest="检查当前文件的 LSP 错误并修复"><span class="suggest-card-icon">🔍</span>检查 LSP 错误</button>
            <button class="suggest-card" data-suggest="解释 from、root、prev 这三个作用域的区别和用法"><span class="suggest-card-icon">📖</span>作用域解释</button>
            <button class="suggest-card" data-suggest="为当前触发器添加详细注释说明其逻辑"><span class="suggest-card-icon">✏️</span>添加注释</button>
            <button class="suggest-card" data-suggest="分析当前文件并列出潜在的语法和逻辑问题"><span class="suggest-card-icon">🛡️</span>代码审查</button>
        </div>
    </div>
</div>

<div class="input-wrapper" style="position:relative">
    <div id="slashPopup" class="slash-popup"></div>
    <div class="input-container">
        <div class="input-row">
            <textarea id="input" placeholder="描述你的需求... (/ 输入命令)" rows="1"></textarea>
        </div>
        <div id="tokenUsageBar" style="display:none">
            <div class="token-usage-bar"><div class="token-usage-fill" id="tokenUsageFill" style="width:0%"></div></div>
            <div class="token-usage-label" id="tokenUsageLabel"></div>
        </div>
        <div class="input-controls">
            <div class="ctrl-group">
                <select class="mode-select" id="modeSel" title="切换模式">
                    <option value="build">📝 Build — 生成代码</option>
                    <option value="plan">📋 Plan — 只读规划</option>
                    <option value="explore">🔭 Explore — 探索代码库</option>
                    <option value="general">💬 General — 通用问答</option>
                </select>
                <select class="model-selector" id="quickModelSelect" title="当前模型"></select>
            </div>
            <button class="send-btn" id="sendBtn" title="发送 (Enter)">↑</button>
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
