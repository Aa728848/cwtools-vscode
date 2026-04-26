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
import { UsageTracker } from './usageTracker';
import { getChatPanelHtml } from './chatHtml';

export class AIChatPanelProvider implements vs.WebviewViewProvider {
    public static readonly viewType = 'cwtools.aiChat';

    private view?: vs.WebviewView;
    private currentTopic: ChatTopic | null = null;
    private topics: ChatTopic[] = [];
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

    constructor(
        private extensionUri: vs.Uri,
        private agentRunner: AgentRunner,
        private aiService: AIService,
        private usageTracker: UsageTracker,
        private storageUri: vs.Uri | undefined
    ) {
        this.loadTopics();
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
            (msg: WebViewMessage) => { this.handleWebViewMessage(msg); },
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
            case 'fetchApiModels':
                await this.fetchApiModels(msg.providerId, msg.endpoint, msg.apiKey);
                break;
            case 'testConnection':
                await this.testConnection(msg.settings);
                break;
            case 'deleteDynamicModel':
                await this.deleteDynamicModel(msg.providerId, msg.modelId);
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
            case 'openPlanFile':
                // Simply open the plan markdown file in the native VSCode editor
                vs.commands.executeCommand('vscode.open', vs.Uri.file(msg.filePath));
                break;
            case 'submitPlanAnnotations':
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
            case 'revisePlanWithAnnotations':
                let reviseContext = '';
                if (msg.annotations && msg.annotations.length > 0) {
                    reviseContext = '\n\n需要修改的地方批注如下:\n' + msg.annotations.map((a: { section: string; note: string }) => `- ${a.section}: ${a.note}`).join('\n');
                }
                const revisePrompt = '请根据我的批注考虑改进现有的执行计划，重新完善计划。' + reviseContext;
                // keep current mode ('plan'), do not auto-switch since it's just revising
                await this.handleUserMessage(revisePrompt, undefined, undefined, true, true);
                break;
            case 'reviseWalkthroughWithAnnotations':
                let reviseWtContext = '';
                if (msg.annotations && msg.annotations.length > 0) {
                    reviseWtContext = '\n\n针对报告中需要修改的地方，我的批注（要求）如下:\n' + msg.annotations.map((a: { section: string; note: string }) => `### 针对片段：\n${a.section}\n**要求**：${a.note}`).join('\n\n');
                }
                const reviseWtPrompt = '请根据我的批注，重新修改并输出一份新的 walkthrough.md 报告。' + reviseWtContext;
                await this.handleUserMessage(reviseWtPrompt, undefined, undefined, true, true);
                break;
            case 'approveWalkthrough':
                if (this.previousMode && this.previousMode !== this.currentMode) {
                    this.switchMode(this.previousMode);
                }
                break;
            case 'searchTopics':
                this.handleSearchTopics(msg.query);
                break;
            case 'exportTopic':
                await this.exportTopicAsMarkdown(msg.topicId);
                break;
            case 'exportTopicJson':
                await this.exportTopicAsJson(msg.topicId);
                break;
            case 'importTopic':
                await this.importTopicFromJson(msg.data);
                break;
            case 'requestFileList':
                this.sendWorkspaceFileList();
                break;
            case 'requestUsageStats':
                this.postMessage({ type: 'usageStats', stats: this.usageTracker.getStats() });
                break;
            case 'clearUsageStats':
                this.usageTracker.clearStats();
                this.postMessage({ type: 'usageStats', stats: this.usageTracker.getStats() });
                break;
        }
    }

    /** Build the settingsData payload and send it to the WebView (no UI activation side-effect) */
    private async buildAndSendSettingsData(showPanel = false): Promise<void> {
        const { BUILTIN_PROVIDERS, fetchOllamaModels, MODEL_CONTEXT_TOKENS } = await import('./providers');
        const config = this.aiService.getConfig();

        const providers = Object.values(BUILTIN_PROVIDERS).map(p => ({
            id: p.id,
            name: p.name,
            models: p.models,
            defaultModel: p.defaultModel,
            requiresApiKey: p.id !== 'ollama',
            defaultEndpoint: p.endpoint,
            maxContextTokens: p.maxContextTokens,
            supportsFIM: p.supportsFIM,
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
            reasoningEffort: config.reasoningEffort,
            braveSearchApiKey: (() => {
                const k = vs.workspace.getConfiguration('cwtools.ai').get<string>('braveSearchApiKey') ?? '';
                return k ? '••••••••' : '';  // mask if set; expose empty string if not
            })(),
            inlineCompletion: {
                enabled: config.inlineCompletion.enabled,
                provider: config.inlineCompletion.provider,
                model: config.inlineCompletion.model,
                endpoint: config.inlineCompletion.endpoint,
                debounceMs: config.inlineCompletion.debounceMs,
                overlapStripping: config.inlineCompletion.overlapStripping,
                fimMode: config.inlineCompletion.fimMode,
            },
            mcp: {
                servers: config.mcp.servers
            }
        };

        let ollamaModels: Array<{ name: string; size: string; parameterSize?: string }> | undefined;
        if (config.provider === 'ollama') {
            const ep = config.endpoint || BUILTIN_PROVIDERS['ollama']?.endpoint;
            if (ep) ollamaModels = await fetchOllamaModels(ep);
        }

        const vscodeConfig = vs.workspace.getConfiguration('cwtools.ai');
        const dynamicModelsConfig = vscodeConfig.get<Record<string, string[]>>('dynamicModels') || {};

        const dynamicContexts = vscodeConfig.get<Record<string, number>>('dynamicModelsContext') || {};

        // Fix #4: import shared list from providers.ts instead of maintaining a duplicate
        const { ALWAYS_THINKING_PREFIXES } = await import('./providers');

        this.postMessage({
            type: 'settingsData',
            providers: providers.map(p => ({
                ...p,
                hasKey: hasKeyMap[p.id] ?? false,
                models: Array.from(new Set([...p.models, ...(dynamicModelsConfig[p.id] || [])]))
            })) as any,
            current,
            ollamaModels,
            showPanel,
            // Merge static MODEL_CONTEXT_TOKENS with any dynamic contexts grabbed from OpenRouter/etc.
            modelContextTokens: { ...MODEL_CONTEXT_TOKENS, ...dynamicContexts },
            thinkingModelPrefixes: ALWAYS_THINKING_PREFIXES,
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
        const { BUILTIN_PROVIDERS } = await import('./providers');

        const handleDynamicModel = async (providerId: string, modelId: string, contextTokens: number) => {
            const provider = BUILTIN_PROVIDERS[providerId];
            if (provider && providerId !== 'ollama' && modelId) {
                if (!provider.models.includes(modelId)) {
                    let currentDynamic = cfg.get<Record<string, string[]>>('dynamicModels') || {};
                    let providerDyns = currentDynamic[providerId] || [];
                    if (!providerDyns.includes(modelId)) {
                        providerDyns.push(modelId);
                        currentDynamic = { ...currentDynamic, [providerId]: providerDyns };
                        await cfg.update('dynamicModels', currentDynamic, vs.ConfigurationTarget.Global);
                    }
                    if (contextTokens > 0) {
                        let currContexts = cfg.get<Record<string, number>>('dynamicModelsContext') || {};
                        if (currContexts[modelId] !== contextTokens) {
                            currContexts = { ...currContexts, [modelId]: contextTokens };
                            await cfg.update('dynamicModelsContext', currContexts, vs.ConfigurationTarget.Global);
                        }
                    }
                }
            }
        };

        if (settings.model) {
            await handleDynamicModel(settings.provider, settings.model, settings.maxContextTokens || 0);
        }
        if (settings.inlineCompletion && settings.inlineCompletion.model) {
            await handleDynamicModel(settings.inlineCompletion.provider, settings.inlineCompletion.model, 0);
        }

        await cfg.update('provider', settings.provider, vs.ConfigurationTarget.Global);
        await cfg.update('model', settings.model, vs.ConfigurationTarget.Global);
        // API key: store in SecretStorage, NEVER in settings.json
        if (settings.apiKey && settings.apiKey.trim().length > 0) {
            await this.aiService.getKeyManager().setKey(settings.provider, settings.apiKey.trim());
            // Ensure plaintext key is cleared from settings.json
            await cfg.update('apiKey', '', vs.ConfigurationTarget.Global);
        }
        // Brave Search API key — stored in workspace config (not secret, not sensitive enough)
        if (settings.braveSearchApiKey && settings.braveSearchApiKey.trim().length > 0
            && !settings.braveSearchApiKey.startsWith('•')) {
            await cfg.update('braveSearchApiKey', settings.braveSearchApiKey.trim(), vs.ConfigurationTarget.Global);
        }
        await cfg.update('endpoint', settings.endpoint, vs.ConfigurationTarget.Global);
        await cfg.update('maxContextTokens', settings.maxContextTokens, vs.ConfigurationTarget.Global);
        await cfg.update('agentFileWriteMode', settings.agentFileWriteMode, vs.ConfigurationTarget.Global);
        await cfg.update('reasoningEffort', settings.reasoningEffort, vs.ConfigurationTarget.Global);
        await cfg.update('enabled', true, vs.ConfigurationTarget.Global);
        // Inline completion settings
        if (settings.inlineCompletion) {
            await cfg.update('inlineCompletion.enabled', settings.inlineCompletion.enabled, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.provider', settings.inlineCompletion.provider, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.model', settings.inlineCompletion.model, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.endpoint', settings.inlineCompletion.endpoint, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.debounceMs', settings.inlineCompletion.debounceMs, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.overlapStripping', settings.inlineCompletion.overlapStripping, vs.ConfigurationTarget.Global);
            await cfg.update('inlineCompletion.fimMode', settings.inlineCompletion.fimMode, vs.ConfigurationTarget.Global);
        }

        // MCP Settings
        if (settings.mcp?.servers) {
            await cfg.update('mcp.servers', settings.mcp.servers, vs.ConfigurationTarget.Global);
        }

        vs.window.showInformationMessage('Eddy CWTool Code 设置已保存，部分 MCP 连接更改可能需要重载窗口生效');
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

    private async fetchApiModels(providerId: string, endpointOverride: string, apiKeyOverride: string): Promise<void> {
        const { getEffectiveEndpoint } = await import('./providers');
        const saved = this.aiService.getConfig();
        const endpoint = endpointOverride || getEffectiveEndpoint(providerId, saved.endpoint);

        let apiKey = apiKeyOverride;
        if (!apiKey) apiKey = await this.aiService.getKeyForProvider(providerId) || '';

        if (!apiKey) {
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: '需要 API Key 才能拉取模型列表' });
            return;
        }

        if (providerId.startsWith('minimax') || providerId === 'opencode') {
            // Minimax API and OpenCode Zen do not currently have a standard /v1/models endpoint for listing.
            // Return the hardcoded fallback list smoothly so the UI doesn't crash.
            const { BUILTIN_PROVIDERS } = await import('./providers');
            const models = (BUILTIN_PROVIDERS[providerId]?.models || []).map(m => ({ id: m }));
            this.postMessage({ type: 'apiModelsFetched', providerId, models, error: '' });
            return;
        }

        try {
            const modelsUrl = endpoint.replace(/\/chat\/completions$/, '').replace(/\/+$/, '') + '/models';
            const res = await fetch(modelsUrl, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (res.ok) {
                const data = await res.json() as any;
                // Some providers return { data: [...] }, others return a flat array
                const modelList: any[] = Array.isArray(data)
                    ? data
                    : (Array.isArray(data?.data) ? data.data : null);
                if (modelList) {
                    const dynModels = modelList.map((m: any) => m.id);
                    const dynContexts: Record<string, number> = {};
                    const { getModelContextTokens } = await import('./providers');

                    modelList.forEach((m: any) => {
                        // Tier 1: Direct from API response (OpenRouter, Together, DeepInfra, etc.)
                        let c = m.context_length
                            || m.context_window
                            || m.max_context_length
                            || m.top_provider?.context_length
                            || 0;

                        // Tier 2: Infer from model family using canonical knowledge base
                        if (!c && m.id) {
                            c = getModelContextTokens(m.id, providerId);
                        }

                        if (c) dynContexts[m.id] = c;
                    });

                    const apiHasContext = modelList.some((m: any) => m.context_length || m.context_window || m.top_provider?.context_length);
                    const inferredCount = Object.keys(dynContexts).length;
                    const ctxNote = apiHasContext
                        ? `（已从 API 获取 ${inferredCount} 个模型的上下文大小）`
                        : `（API 未返回上下文大小，已通过模型族推断 ${inferredCount}/${dynModels.length} 个）`;

                    this.postMessage({ type: 'apiModelsFetched', providerId, models: modelList, dynContexts, ctxNote });
                    return;
                }
            }
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: `接口返回未知数据结构 (状态码: ${res.status})` });
        } catch (e: unknown) {
            this.postMessage({ type: 'apiModelsFetched', providerId, models: [], error: String(e) });
        }
    }

    private async deleteDynamicModel(providerId: string, modelId: string): Promise<void> {
        const vscodeConfig = vs.workspace.getConfiguration('cwtools.ai');
        const dynamicModelsConfig = vscodeConfig.get<Record<string, string[]>>('dynamicModels') || {};
        if (dynamicModelsConfig[providerId]) {
            dynamicModelsConfig[providerId] = dynamicModelsConfig[providerId].filter(m => m !== modelId);
            await vscodeConfig.update('dynamicModels', dynamicModelsConfig, vs.ConfigurationTarget.Global);
            vs.window.showInformationMessage(`✅ 已删除动态拉取的模型: ${modelId}`);
            await this.openSettingsPage(); // Refresh settings data
        }
    }

    private async testConnection(settings?: import('./types').PanelSettings): Promise<void> {
        const { getEffectiveEndpoint } = await import('./providers');
        const saved = this.aiService.getConfig();
        const providerId = settings?.provider ?? saved.provider;
        // If the settings page shows a masked key (starts with '•'), the user hasn't
        // entered a new key — fall back to the one stored in SecretStorage.
        const rawSettingsKey = settings?.apiKey ?? '';
        const apiKey = (rawSettingsKey && !rawSettingsKey.startsWith('\u2022'))
            ? rawSettingsKey
            : await this.aiService.getKeyForProvider(providerId);
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

    /**
     * Public API: Send a message to the AI chat programmatically.
     * Used by keyboard shortcuts and command palette commands.
     * Opens the chat panel if it's not visible.
     */
    async sendProgrammaticMessage(text: string): Promise<void> {
        // Ensure the panel is visible
        await vs.commands.executeCommand('cwtools.aiChat.focus');
        // Short delay to allow panel to initialize if just opened
        await new Promise(r => setTimeout(r, 200));
        await this.handleUserMessage(text);
    }

    private async handleUserMessage(text: string, images?: string[], _attachedFiles?: string[], skipAutoModeSwitch = false, isBackground = false): Promise<void> {
        if (!text.trim() && (!images || images.length === 0)) return;

        // Auto-switch from Plan to Build mode if user gives approval implicit keywords
        if (this.currentMode === 'plan' && !skipAutoModeSwitch) {
            const lowerText = text.toLowerCase();
            const approvalKeywords = ['同意', '执行', '开始', 'approved', 'go ahead', 'proceed', 'looks good', '可以', '没问题'];
            if (approvalKeywords.some(keyword => lowerText.includes(keyword))) {
                this.switchMode('build');
                // Add a small delay to ensure UI updates before the agent starts processing
                await new Promise(resolve => setTimeout(resolve, 50));
            }
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
        if (!this.currentTopic) {
            this.createNewTopic(text);
        }

        // Track message index for retract support
        const messageIndex = this.currentTopic!.messages.length;

        // Add user message to UI — pass images array directly (not just a bool flag)
        if (!isBackground) {
            this.postMessage({ type: 'addUserMessage', text, messageIndex, images: images?.length ? images : undefined });
        }

        // Add to history — store images for topic persistence
        this.addHistoryMessage({ role: 'user', content: text, timestamp: Date.now(), images: images?.length ? images : undefined, isHidden: isBackground });

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
                { ...context, topicId: this.currentTopic?.id },
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
            if (this.currentMode === 'plan' && result.explanation) {
                // Chat shows only tool-call steps (no full plan text)
                this.postMessage({ type: 'generationComplete', result: { ...result, explanation: '', code: '' } });
                this.addHistoryMessage({
                    role: 'assistant',
                    content: '📋 计划已生成，已在批注视图中打开',
                    timestamp: Date.now(),
                    steps: result.steps,
                });
                this.savePlanFile(result.explanation, text, result.steps);
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

            // ── Check if Walkthrough was generated ──
            const wsRoot = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot) {
                const topicId = this.currentTopic?.id || 'default';
                const wtPath = path.join(wsRoot, '.cwtools-ai', topicId, 'walkthrough.md');
                // Use normalize for safter comparisons
                const normWtPath = path.normalize(wtPath).toLowerCase();
                const wroteWalkthrough = this._currentMessageSnapshots.some(s =>
                    path.normalize(s.filePath).toLowerCase() === normWtPath
                );

                if (wroteWalkthrough) {
                    this.renderWalkthroughUI(wtPath, topicId, result.steps);
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
            // Store file snapshots for this message (keyed by the message index)
            // Also record the conversationMessages length so retractMessage can use the
            // correct slice point (avoids index divergence after fork/load).
            if (messageSnapshots.length > 0) {
                this._messageFileSnapshots.set(messageIndex, {
                    files: messageSnapshots,
                    convLength: this.conversationMessages.length,
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
        if (!this.currentTopic) return;

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
                    console.error(`[Retract] Failed to restore ${snap.filePath}:`, e);
                }
            }
            this._messageFileSnapshots.delete(idx);
        }

        // ── Roll back conversation history ─────────────────────────────────
        // Use the accurately recorded convLength if available; otherwise fall back to
        // using messageIndex (which may diverge from conversationMessages after fork/load).
        this.currentTopic.messages = this.currentTopic.messages.slice(0, messageIndex);
        if (convRollbackLength !== undefined) {
            this.conversationMessages = this.conversationMessages.slice(0, convRollbackLength - 2);
        } else {
            // Fallback: best-effort slice by messageIndex
            this.conversationMessages = this.conversationMessages.slice(0, messageIndex);
        }

        this.postMessage({ type: 'messageRetracted', messageIndex });
        this.saveTopics();

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
            const currentContent = currentContentExists ? await fs.promises.readFile(snap.filePath, 'utf-8').catch(() => null) : null;

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
            const topicId = this.currentTopic?.id || 'default';
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
                this.saveTopics();
            }

        } catch (e) {
            console.error('Failed to parse walkthrough.md', e);
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
                    this.resolveWriteConfirmation(messageId, false);
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
            const topicId = this.currentTopic?.id || 'default';
            const taskPath = path.join(wsRoot, '.cwtools-ai', topicId, 'task.md');

            const lines: string[] = ['# Task List\n'];
            for (const t of todos) {
                const mark = t.status === 'done' ? '[x]' : (t.status === 'in_progress' ? '[/]' : '[ ]');
                lines.push(`- ${mark} ${t.content}`);
            }

            // Register task.md in the current message snapshot so retract can delete/restore it
            this._recordFileSnapshot(taskPath);

            fs.promises.mkdir(path.dirname(taskPath), { recursive: true }).then(() => {
                fs.promises.writeFile(taskPath, lines.join('\n'), 'utf-8').catch(() => { });
            });
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

        // Lazily register a shared ContentProvider (re-registered at most once per panel).
        // Re-using the same scheme+registration avoids accumulating stale providers
        // when the user rapidly clicks "Insert" multiple times.
        const scheme = 'cwtools-ai-preview';
        this._previewContent = newContent;
        if (!this._previewProviderRegistration) {
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
                vs.window.showInformationMessage('已取消插入');
            }
        } finally {
            // Close the diff editor (preview registration kept alive for next use)
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
        // Clear file snapshots associated with the previous topic to prevent memory leaks
        this._messageFileSnapshots.clear();
        this._currentMessageSnapshots = null;
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
            if (['build', 'plan', 'explore', 'general', 'review'].includes(mode)) {
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
            const effectIds = this.sampleIds(path.join(root, 'common', 'scripted_effects'), 20);
            const eventIds = this.sampleIds(path.join(root, 'events'), 10);
            const variableIds = this.sampleIds(path.join(root, 'common', 'scripted_variables'), 20);

            // ── 3.1 Extract Namespaces ────────────────────────────────────────
            const namespaces = new Set<string>();
            const eventsDir = path.join(root, 'events');
            if (fs.existsSync(eventsDir)) {
                for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.txt'))) {
                    try {
                        const content = fs.readFileSync(path.join(eventsDir, file), 'utf-8');
                        const nsMatch = content.match(/^namespace\s*=\s*"?([\w.:-]+)"?/m);
                        if (nsMatch) namespaces.add(nsMatch[1]);
                    } catch { /* skip */ }
                }
            }

            // ── 3.2 Extract Localization Languages ────────────────────────────
            const locLangs = new Set<string>();
            const locDir = path.join(root, 'localisation');
            if (fs.existsSync(locDir)) {
                for (const file of fs.readdirSync(locDir)) {
                    if (file.endsWith('.yml')) {
                        const m = file.match(/([a-z_]+)\.yml$/i);
                        if (m && m[1].includes('chinese')) locLangs.add('simp_chinese');
                        else if (m && m[1].includes('english')) locLangs.add('english');
                        else if (['russian', 'french', 'german', 'spanish', 'polish'].some(l => m && m[1].includes(l))) {
                            const matched = ['russian', 'french', 'german', 'spanish', 'polish'].find(l => m && m[1].includes(l));
                            if (matched) locLangs.add(matched);
                        }
                    } else if (fs.statSync(path.join(locDir, file)).isDirectory()) {
                        locLangs.add(file);
                    }
                }
            }

            // ── 3.3 P5: Detect encoding conventions ─────────────────────────
            // Paradox convention: .txt scripts = UTF-8 (no BOM), .yml localisation = UTF-8 with BOM
            // We verify against actual files to report the project's real convention.
            let scriptEncoding = '';
            let locEncoding = '';
            // Check script files (.txt)
            const scriptCheckDirs = ['events', 'common/scripted_triggers', 'common/scripted_effects'];
            let scriptBom = 0, scriptNoBom = 0;
            for (const relDir of scriptCheckDirs) {
                const dir = path.join(root, ...relDir.split('/'));
                if (!fs.existsSync(dir)) continue;
                for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.txt')).slice(0, 3)) {
                    try {
                        const buf = fs.readFileSync(path.join(dir, file));
                        if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) scriptBom++;
                        else scriptNoBom++;
                    } catch { /* skip */ }
                }
            }
            if (scriptBom > 0 || scriptNoBom > 0) {
                scriptEncoding = scriptNoBom >= scriptBom ? 'UTF-8 without BOM' : 'UTF-8 with BOM';
            }
            // Check localisation files (.yml)
            const locCheckDir = path.join(root, 'localisation');
            let locBom = 0, locNoBom = 0;
            if (fs.existsSync(locCheckDir)) {
                const ymlFiles = this.collectYmlFiles(locCheckDir, 6);
                for (const ymlPath of ymlFiles) {
                    try {
                        const buf = fs.readFileSync(ymlPath);
                        if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) locBom++;
                        else locNoBom++;
                    } catch { /* skip */ }
                }
            }
            if (locBom > 0 || locNoBom > 0) {
                locEncoding = locBom >= locNoBom ? 'UTF-8 with BOM' : 'UTF-8 without BOM';
            }

            // ── 3.4 P5: Detect file naming patterns ──────────────────────────
            const namingPatterns = new Set<string>();
            for (const subDir of ['common/scripted_triggers', 'common/scripted_effects', 'events']) {
                const dir = path.join(root, ...subDir.split('/'));
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
                if (files.length >= 2) {
                    // Extract common prefix from file names
                    const prefixes = files.map(f => f.replace('.txt', '').split('_')[0]).filter(Boolean);
                    const freq = new Map<string, number>();
                    for (const p of prefixes) freq.set(p, (freq.get(p) || 0) + 1);
                    for (const [prefix, count] of freq) {
                        if (count >= 2 && prefix.length > 2) namingPatterns.add(`${prefix}_*.txt (in ${subDir})`);
                    }
                }
            }

            // ── 3.5 P5: Sample on_actions ────────────────────────────────────
            const onActionIds = this.sampleIds(path.join(root, 'common', 'on_actions'), 10);

            // ── 3.6 P5: Sample static_modifiers ──────────────────────────────
            const staticModifierIds = this.sampleIds(path.join(root, 'common', 'static_modifiers'), 10);

            // ── 3.7 P5: Detect @variable prefix patterns ─────────────────────
            const varPrefixes = new Set<string>();
            if (variableIds.length > 0) {
                for (const v of variableIds) {
                    const prefix = v.replace(/^@/, '').split('_').slice(0, 1)[0];
                    if (prefix && prefix.length > 1) varPrefixes.add(`@${prefix}_`);
                }
            }

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
                modTags ? `- **Tags**: ${modTags}` : '',
                `- **Root**: \`${root}\``,
                scriptEncoding ? `- **Script Encoding**: ${scriptEncoding}` : '',
                locEncoding ? `- **Localisation Encoding**: ${locEncoding}` : '',
                ``,
                `## Project Structure`,
                '```',
                topLevel,
                '```',
                ``,
                `## Known Identifiers`,
                `When generating code that references these IDs, verify they exist before use.`,
                ``,
                namespaces.size > 0
                    ? `### Event Namespaces\n${Array.from(namespaces).map(ns => `- \`${ns}\``).join('\n')}`
                    : '',
                variableIds.length > 0
                    ? `\n### Global Variables (sample)\n${variableIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                triggerIds.length > 0
                    ? `\n### Scripted Triggers (sample)\n${triggerIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                effectIds.length > 0
                    ? `\n### Scripted Effects (sample)\n${effectIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                eventIds.length > 0
                    ? `\n### Events (sample)\n${eventIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                onActionIds.length > 0
                    ? `\n### On Actions (sample)\n${onActionIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                staticModifierIds.length > 0
                    ? `\n### Static Modifiers (sample)\n${staticModifierIds.map(id => `- \`${id}\``).join('\n')}`
                    : '',
                ``,
                `## Agent Guidelines`,
                locLangs.size > 0 ? `- **Localization Target**: This project supports [${Array.from(locLangs).join(', ')}]. Always provide localizations for these languages when creating new keys.` : '',
                namespaces.size > 0 ? `- **Namespaces**: Always prefix new events with one of the established namespaces.` : '',
                scriptEncoding ? `- **Script Encoding**: All new .txt script files MUST use ${scriptEncoding}.` : '',
                locEncoding ? `- **Localisation Encoding**: All new .yml localisation files MUST use ${locEncoding}.` : '',
                namingPatterns.size > 0 ? `- **File Naming**: Follow existing patterns: ${Array.from(namingPatterns).join(', ')}.` : '',
                varPrefixes.size > 0 ? `- **Variable Prefixes**: Use established prefixes: ${Array.from(varPrefixes).join(', ')}.` : '',
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

            // Register CWTOOLS.md in the current message snapshot so /init can be retracted.
            // This allows `retractMessage` to delete or restore the file if the user undoes the /init.
            this._recordFileSnapshot(outPath);
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
                // Match top-level identifier keys: key = {...} or @var = value
                const matches = content.match(/^([@\w][\w.:-]*)\s*=/gm) || [];
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

    /** Collect .yml file paths from a directory (recurses one level into subdirs) */
    private collectYmlFiles(dir: string, maxCount: number): string[] {
        const results: string[] = [];
        if (!fs.existsSync(dir)) return results;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (results.length >= maxCount) break;
            if (entry.isFile() && entry.name.endsWith('.yml')) {
                results.push(path.join(dir, entry.name));
            } else if (entry.isDirectory()) {
                // Recurse one level (e.g. localisation/english/)
                for (const sub of fs.readdirSync(path.join(dir, entry.name)).filter(f => f.endsWith('.yml')).slice(0, 2)) {
                    results.push(path.join(dir, entry.name, sub));
                    if (results.length >= maxCount) break;
                }
            }
        }
        return results;
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

    private resolvePermissionRequest(permissionId: string, allowed: boolean): void {
        const resolver = this.pendingPermissionResolvers.get(permissionId);
        if (resolver) {
            this.pendingPermissionResolvers.delete(permissionId);
            resolver(allowed);
        }
    }

    private switchMode(mode: AgentMode): void {
        if (this.currentMode !== mode) this.previousMode = this.currentMode;
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

    // ─── Topic Search ─────────────────────────────────────────────────────────

    /**
     * Search topics by keyword — scans title and full message content.
     * Returns top 20 matches sorted by relevance (title match first, then recency).
     * Includes context preview showing where the match was found.
     */
    private handleSearchTopics(query: string): void {
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

    // ─── Topic Export ─────────────────────────────────────────────────────────

    /**
     * Export a topic (or the current topic) as a Markdown file.
     * Saves to the workspace root and opens in VSCode.
     */
    private async exportTopicAsMarkdown(topicId?: string): Promise<void> {
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
    private async exportTopicAsJson(topicId?: string): Promise<void> {
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
     */
    private async importTopicFromJson(jsonString: string): Promise<void> {
        try {
            const data = JSON.parse(jsonString) as Partial<import('./types').ChatTopic>;

            // Simple schema validation
            if (!data.title || !Array.isArray(data.messages)) {
                throw new Error('无效的会话文件格式 (缺少 title 或 messages 数组)');
            }

            // Generate a new ID to avoid collisions
            const importedTopic: import('./types').ChatTopic = {
                id: `topic_imported_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                title: `${data.title} (导入)`,
                createdAt: data.createdAt || Date.now(),
                updatedAt: Date.now(),
                messages: data.messages as import('./types').ChatHistoryMessage[],
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

            this.loadTopic(importedTopic.id);
            this.postMessage({ type: 'topicImported', topicId: importedTopic.id, title: importedTopic.title });

            vs.window.showInformationMessage(`成功导入会话: ${importedTopic.title}`);
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            vs.window.showErrorMessage(`导入对话失败: ${err}`);
        }
    }

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
