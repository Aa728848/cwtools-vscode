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
    AgentArtifact,
    AgentArtifactKind,
    DiffArtifactData,
    DiffArtifactFile,
    DiffSummaryFile,
    GenerationResult,
    ContextItem,
} from './types';
import { contentToString } from './types';
import { AgentRunner } from './agentRunner';
import { AIService } from './aiService';
import { UsageTracker } from './usageTracker';
import { routeWebviewMessage } from './chat/bridge';
import { getChatPanelHtml } from './chatHtml';
import { getAgentManagerHtml } from './agentManagerHtml';
import { ChatTopicManager } from './chatTopics';
import { generateInitFile } from './chatInit';
import { ChatSettingsManager } from './chatSettings';
import { ErrorReporter } from './errorReporter';
import { UI, SOURCE, aiText } from './messages';
import { ContextReferenceManager } from './contextReferences';
import { AgentSessionCoordinator } from './agentSessionCoordinator';
import { runLedger, type AgentRunEvent } from './runner/runLedger';
import { PermissionPolicyStore, deriveCommandPrefix, hasInlineEvalPayload } from './runner/permissionPolicy';
import { isSecuritySandboxDisabled } from './workspaceSandbox';
import { AutoReviewer } from './runner/autoReviewer';
import { AgentUiBroadcaster } from './agentUiBroadcaster';
import { ArtifactStore } from './artifactStore';
import { getAllWorkflows, getWorkflow } from './workflowRegistry';
import { toWorkflowViewModel } from './workflowViewModel';
import { getWorkflowUiLabels } from './workflowI18n';
import { buildModeRoutingPrompt, inferBuildModeRoute, parseModelRouteResponse } from './modeRouting';
import { computeLineDiff } from './diffEngine';
import { budgetToolResult } from './contextBudget';
import {
    getAiStorageRoot,
    getProjectWorkspaceRoot,
    getTopicFileCandidates,
    getTopicStorageDir,
    getTopicStorageDirCandidates,
} from './workspacePaths';

const activePendingInteractions = new Map<string, string>();

export function getPendingInteractions(): string[] {
    return Array.from(activePendingInteractions.values());
}

type PendingWriteCardMessage = Extract<HostMessage, { type: 'pendingWriteFile' }>;
type PendingPermissionCardMessage = Extract<HostMessage, { type: 'permissionRequest' }>;
type FileSnapshot = { filePath: string; previousContent: string | null; _tooLarge?: boolean };
const MAX_ARTIFACT_DIFF_CONTENT = 500000;
const UI_HISTORY_STEP_LIMIT = 220;
const UI_REPLAY_STEP_LIMIT = 160;
const UI_RUN_EVENT_LIMIT = 220;
const UI_STEP_CONTENT_LIMIT = 4000;
const UI_TOOL_ARG_BUDGET = 6000;
const UI_TOOL_RESULT_BUDGET = 6000;
const RUN_SNAPSHOT_THROTTLE_MS = 1000;
const TEMP_DIFF_SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd', '.cjs', '.js', '.mjs', '.ps1', '.py', '.sh']);
const TEMP_DIFF_SCRIPT_DIR_NAMES = new Set(['.tmp', 'scratch', 'temp', 'tmp']);
const TEMP_DIFF_SCRIPT_NAME_PATTERN = /^(?:agent_helper|helper|tmp|temp|scratch|batch|bulk|replace|rewrite|fix|verify|check|search|scan)(?:[_\-.].*)?\.(?:bat|cmd|cjs|js|mjs|ps1|py|sh)$/i;

function normalizeSnapshotFilePath(filePath: string, workspaceRoot = getProjectWorkspaceRoot()): string {
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
    const normalized = path.normalize(resolved);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isTempScriptSnapshot(snapshot: FileSnapshot, workspaceRoot = getProjectWorkspaceRoot()): boolean {
    const relativePath = path.relative(workspaceRoot, snapshot.filePath).replace(/\\/g, '/');
    const segments = relativePath.split('/').filter(Boolean).map(segment => segment.toLowerCase());
    const basename = path.basename(snapshot.filePath).toLowerCase();
    const ext = path.extname(basename).toLowerCase();
    if (!TEMP_DIFF_SCRIPT_EXTENSIONS.has(ext)) return false;
    if (segments[0] === '.cwtools-ai' && segments[2] === 'scratch') return true;
    if (segments.some(segment => TEMP_DIFF_SCRIPT_DIR_NAMES.has(segment))) return true;
    if (basename === 'agent_helper.py') return true;
    return snapshot.previousContent === null && TEMP_DIFF_SCRIPT_NAME_PATTERN.test(basename);
}

export class AIChatPanelProvider implements vs.WebviewViewProvider {
    public static readonly viewType = 'cwtools.aiChat';

    private view?: vs.WebviewView;
    private managerPanel?: vs.WebviewPanel;
    private currentRunId?: string;
    public readonly session = new AgentSessionCoordinator();
    public readonly broadcaster = new AgentUiBroadcaster();
    public readonly artifactStore = new ArtifactStore(() => this.topicManager.currentTopic?.id ?? 'session');
    public conversationMessages: ChatMessage[] = [];
    private abortController: AbortController | null = null;
    /**
     * Per-message file snapshots for retract/undo support.
     * Key = messageIndex (the topic.messages index at the time the user sent the message).
     * Value = { files, convLength } where convLength is the length of conversationMessages
     * at the start of this exchange (used to slice conversationMessages correctly on retract,
     * since its indexing can diverge from topic.messages after fork/load).
     */
    private _messageFileSnapshots = new Map<number, {
        files: FileSnapshot[];
        convLength: number;
    }>();
    /**
     * Points to the active snapshot array for the currently-running message.
     * Set in handleUserMessage, cleared in finally. Allows non-tool writes
     * (e.g. plan file) to register themselves into the same snapshot.
     */
    private _currentMessageSnapshots: FileSnapshot[] | null = null;
    // ── Shared ContentProvider for insertCodeWithDiff (M5 fix) ───────────────
    // Lazily registered once and reused for all code-insert previews.
    // The mutable `_previewContent` field is updated before each diff view.
    private _previewContent = '';
    private _previewProviderRegistration?: vs.Disposable;
    /** Fix #2: disposables for sidebar WebView event listeners, cleaned up on dispose() */
    private _viewDisposables: vs.Disposable[] = [];
    /** Disposables for detached Agent Manager panel listeners */
    private _managerDisposables: vs.Disposable[] = [];
    private readonly pendingRunSnapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly lastRunSnapshotSentAt = new Map<string, number>();
    public topicManager!: ChatTopicManager;
    public settingsManager!: ChatSettingsManager;
    public contextReferences: ContextReferenceManager;

    private get currentMode(): AgentMode {
        return this.session.currentMode;
    }

    private set currentMode(mode: AgentMode) {
        this.session.currentMode = mode;
    }

    private get previousMode(): AgentMode {
        return this.session.previousMode;
    }

    private set previousMode(mode: AgentMode) {
        this.session.previousMode = mode;
    }

    private get currentWorkflowId(): string | null {
        return this.session.currentWorkflowId;
    }

    private set currentWorkflowId(workflowId: string | null) {
        this.session.currentWorkflowId = workflowId;
    }

    private get _liveSteps(): AgentStep[] {
        return this.session.liveSteps;
    }

    private set _liveSteps(steps: AgentStep[]) {
        this.session.liveSteps = steps;
    }

    private get _isGenerating(): boolean {
        return this.session.isGenerating;
    }

    private set _isGenerating(value: boolean) {
        this.session.isGenerating = value;
    }

    constructor(
        public extensionUri: vs.Uri,
        public agentRunner: AgentRunner,
        public aiService: AIService,
        public usageTracker: UsageTracker,
        public storageUri: vs.Uri | undefined
    ) {
        this.topicManager = new ChatTopicManager(storageUri, (msg) => this.postMessage(msg));
        this.settingsManager = new ChatSettingsManager(aiService, (msg) => this.postMessage(msg), storageUri?.fsPath);
        this.contextReferences = new ContextReferenceManager(() => this.agentRunner.toolExecutor.blackboard);
        this.agentRunner.toolExecutor.onWorkflowSaved = () => this.sendWorkflowState();
        runLedger.onChange((runId) => this.queueRunSnapshot(runId));
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
        if (this.managerPanel) {
            try { this.managerPanel.dispose(); } catch { /* ignore */ }
            this.managerPanel = undefined;
        }
        this._messageFileSnapshots.clear();
        // Fix #2: dispose WebView event listeners
        this._viewDisposables.forEach(d => d.dispose());
        this._viewDisposables = [];
        this._managerDisposables.forEach(d => d.dispose());
        this._managerDisposables = [];
        for (const timer of this.pendingRunSnapshotTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingRunSnapshotTimers.clear();
        this.lastRunSnapshotSentAt.clear();
    }

    resolveWebviewView(
        webviewView: vs.WebviewView,
        _context: vs.WebviewViewResolveContext,
        _token: vs.CancellationToken
    ): void {
        this.view = webviewView;
        this._viewDisposables.forEach(d => d.dispose());
        this._viewDisposables = [];
        this.bindWebview(webviewView.webview, this._viewDisposables, 'chat');

        // ── Restore state when panel becomes visible again ────────────────────
        webviewView.onDidChangeVisibility(
            () => { if (webviewView.visible) this._restoreViewState('chat'); },
            this,
            this._viewDisposables
        );

    }

    // ─── View State Restoration ───────────────────────────────────────────────

    /**
     * Restore the full panel state after the WebView is (re)created or becomes
     * visible again. Called on initial load and on every onDidChangeVisibility(true).
     */
    public restoreViewState(targetSurface?: 'chat' | 'manager', replayLiveSteps = true): void {
        this._restoreViewState(targetSurface, replayLiveSteps);
    }

    private _restoreViewState(targetSurface?: 'chat' | 'manager', replayLiveSteps = true): void {
        const send = (msg: HostMessage) => {
            if (targetSurface) {
                this.postMessageToSurface(targetSurface, msg);
            } else {
                this.postMessage(msg);
            }
        };
        // 1. Restore persisted topic messages with compacted step payloads.
        // Full tool/result history can grow large enough to block WebView startup.
        if (this.topicManager.currentTopic && this.topicManager.currentTopic.messages.length > 0) {
            send({ type: 'loadTopicMessages', messages: this.compactMessagesForWebview(this.topicManager.currentTopic.messages), targetSurface });
        }
        // 2. Restore current mode
        send({ type: 'setMode', mode: this.currentMode });
        // 3. If a generation was running when the panel was hidden, replay steps
        //    so the user can see what the AI has done so far and cancel if needed
        if (replayLiveSteps && this._isGenerating && this._liveSteps.length > 0) {
            send({ type: 'replaySteps', steps: this.compactStepsForUi(this._liveSteps, UI_REPLAY_STEP_LIMIT), isGenerating: true });
        }
        if (this.artifactStore.size > 0) {
            send({ type: 'artifactList', artifacts: this.artifactStore.list() });
        }
        this.sendWorkflowState(send);
        // 4. Restore model lists and settings bindings
        void this.settingsManager.buildAndSendSettingsData(false, targetSurface);
        if (targetSurface === 'manager' && this.topicManager.currentTopic?.id) {
            runLedger.loadLatestRunForTopic(this.topicManager.currentTopic.id).then(record => {
                if (record) {
                    const snapshot = this.buildRunSnapshotMessage(record.runId);
                    if (snapshot) send(snapshot);
                }
            }).catch(() => {});
        }
        this.restorePendingInteractionCards(send);
    }

    private restorePendingInteractionCards(send: (msg: HostMessage) => void): void {
        for (const card of this.pendingWriteCards.values()) {
            send(card);
        }
        for (const card of this.pendingPermissionCards.values()) {
            send(card);
        }
    }

    private clipUiText(value: unknown, maxChars = UI_STEP_CONTENT_LIMIT): string {
        const text = typeof value === 'string' ? value : String(value ?? '');
        if (text.length <= maxChars) return text;
        return `${text.slice(0, maxChars)}\n... (${text.length - maxChars} chars truncated)`;
    }

    private compactObjectForUi(value: unknown, maxChars: number, keepKeys: string[] = []): unknown {
        if (value == null) return value;
        if (typeof value === 'string') return this.clipUiText(value, maxChars);
        let raw = '';
        try {
            raw = JSON.stringify(value);
        } catch {
            return this.clipUiText(String(value), maxChars);
        }
        if (raw.length <= maxChars) return value;
        const kept: Record<string, unknown> = { _truncated: true, preview: budgetToolResult(value, maxChars) };
        if (value && typeof value === 'object') {
            const source = value as Record<string, unknown>;
            for (const key of keepKeys) {
                if (source[key] === undefined) continue;
                kept[key] = typeof source[key] === 'string'
                    ? this.clipUiText(source[key], Math.min(1200, maxChars))
                    : source[key];
            }
        }
        return kept;
    }

    private compactToolResultForUi(value: unknown): unknown {
        return this.compactObjectForUi(value, UI_TOOL_RESULT_BUDGET, [
            'success', 'error', 'message', 'file', 'filePath', 'path', 'files',
            'resultRef', 'preview', 'summary', 'diff', 'changes',
        ]);
    }

    private compactToolArgsForUi(value: unknown): unknown {
        return this.compactObjectForUi(value, UI_TOOL_ARG_BUDGET, [
            'file', 'filePath', 'path', 'TargetFile', 'CommandLine', 'Cwd',
            'query', 'key', 'typeName', 'pattern',
        ]);
    }

    private compactStepForUi(step: any): any | undefined {
        if (!step || typeof step !== 'object') return step;
        const type = String(step.type || '');
        if (type === 'text_delta' || type === 'thinking_content') return undefined;
        if (type === 'orchestrator_progress' && /waiting|等待模型返回/i.test(String(step.content || ''))) return undefined;

        const copy: any = { ...step };
        if (typeof copy.content === 'string') copy.content = this.clipUiText(copy.content);
        if (copy.toolArgs !== undefined) copy.toolArgs = this.compactToolArgsForUi(copy.toolArgs);
        if (copy.toolResult !== undefined) copy.toolResult = this.compactToolResultForUi(copy.toolResult);
        if (copy.transactionCard?.summary) {
            copy.transactionCard = { ...copy.transactionCard, summary: this.clipUiText(copy.transactionCard.summary, 1200) };
        }
        return copy;
    }

    private compactStepsForUi(steps: any[] | undefined, limit = UI_HISTORY_STEP_LIMIT): any[] {
        if (!Array.isArray(steps) || steps.length === 0) return [];
        const cards: any[] = [];
        const regular: any[] = [];
        const latestSubAgentStep = new Map<string, any>();
        for (const step of steps) {
            const compact = this.compactStepForUi(step);
            if (!compact) continue;
            if (['plan_card', 'walkthrough_card', 'blueprint_card'].includes(String(compact.type || ''))) {
                cards.push(compact);
            } else {
                regular.push(compact);
                if (typeof compact.agentId === 'string' && compact.agentId) {
                    latestSubAgentStep.set(compact.agentId, compact);
                }
            }
        }
        const tail = regular.length > limit ? regular.slice(regular.length - limit) : regular;
        const tailedSubAgents = new Set(tail.map(step => step?.agentId).filter(Boolean));
        const subAgentMarkers = [...latestSubAgentStep.entries()]
            .filter(([agentId]) => !tailedSubAgents.has(agentId))
            .map(([, step]) => step);
        return [...cards, ...subAgentMarkers, ...tail].sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
    }

    private compactMessagesForWebview(messages: any[] | undefined): any[] {
        if (!Array.isArray(messages)) return [];
        return messages.map(message => {
            if (!message || typeof message !== 'object' || !Array.isArray(message.steps)) return message;
            return { ...message, steps: this.compactStepsForUi(message.steps) };
        });
    }

    private compactRunEventForUi(event: AgentRunEvent): AgentRunEvent | undefined {
        if (event.type === 'model_call_delta') return undefined;
        if (event.type === 'step_appended') {
            const step = this.compactStepForUi(event.payload?.step);
            if (!step) return undefined;
            return { ...event, payload: { step } };
        }
        let payload = event.payload;
        if (event.type === 'tool_call_start' || event.type === 'tool_call_created') {
            const args = this.compactToolArgsForUi(payload?.args ?? payload?.arguments);
            payload = { ...payload, args, arguments: args };
        } else if (event.type === 'tool_call_end') {
            payload = { ...payload, result: this.compactToolResultForUi(payload?.result) };
        } else if (event.type === 'file_change' && payload?.diff) {
            payload = { ...payload, diff: this.clipUiText(payload.diff, 5000) };
        } else if (event.type === 'subagent_end' && payload?.error) {
            payload = { ...payload, error: this.clipUiText(payload.error, 2000) };
        } else {
            payload = this.compactObjectForUi(payload, UI_TOOL_RESULT_BUDGET) as any;
        }
        return { ...event, payload };
    }

    private buildRunSnapshotMessage(runId: string): Extract<HostMessage, { type: 'runSnapshot' }> | undefined {
        const snapshot = runLedger.getSnapshot(runId);
        if (!snapshot) return undefined;
        const compactEvents = snapshot.events
            .map(event => this.compactRunEventForUi(event))
            .filter((event): event is AgentRunEvent => !!event);
        const events = compactEvents.length > UI_RUN_EVENT_LIMIT
            ? compactEvents.slice(compactEvents.length - UI_RUN_EVENT_LIMIT)
            : compactEvents;
        const run = {
            ...snapshot.run,
            steps: [],
        };
        // T3.3 — derive cache stats from the full event list (not truncated copy)
        // so the badge shows the lifetime hit rate, not just the visible window.
        const { reduceCacheStats } = require('./runner/runReducers') as typeof import('./runner/runReducers');
        const cacheStats = reduceCacheStats(snapshot.events);
        return {
            type: 'runSnapshot',
            snapshot: run,
            events,
            eventCount: snapshot.events.length,
            truncatedEventCount: Math.max(0, compactEvents.length - events.length),
            cacheStats,
        } as any;
    }

    private queueRunSnapshot(runId: string, immediate = false): void {
        if (!this.managerPanel?.visible) return;
        if (this.pendingRunSnapshotTimers.has(runId)) return;
        const elapsed = Date.now() - (this.lastRunSnapshotSentAt.get(runId) ?? 0);
        const delay = immediate ? 0 : Math.max(0, RUN_SNAPSHOT_THROTTLE_MS - elapsed);
        const timer = setTimeout(() => {
            this.pendingRunSnapshotTimers.delete(runId);
            const msg = this.buildRunSnapshotMessage(runId);
            if (!msg) return;
            this.lastRunSnapshotSentAt.set(runId, Date.now());
            this.postMessageToSurface('manager', msg);
        }, delay);
        this.pendingRunSnapshotTimers.set(runId, timer);
    }

    private _syncViewChromeState(targetSurface?: 'chat' | 'manager'): void {
        const send = (msg: HostMessage) => {
            if (targetSurface) {
                this.postMessageToSurface(targetSurface, msg);
            } else {
                this.postMessage(msg);
            }
        };
        send({ type: 'setMode', mode: this.currentMode });
        if (this.artifactStore.size > 0) {
            send({ type: 'artifactList', artifacts: this.artifactStore.list() });
        }
        this.sendWorkflowState(send);
        void this.settingsManager.buildAndSendSettingsData(false, targetSurface);
        if (targetSurface === 'manager') {
            this.sendManagerSnapshot();
        }
    }

    // ─── Message Handling ────────────────────────────────────────────────────

    private async handleWebViewMessage(msg: WebViewMessage, sourceSurface: 'chat' | 'manager' = 'chat'): Promise<void> {
        await routeWebviewMessage(this, msg, sourceSurface);
    }

    /**
     * Public API: Send a message to the AI chat programmatically.
     * Used by keyboard shortcuts and command palette commands.
     * Opens the chat panel if it's not visible.
     */
    async sendProgrammaticMessage(text: string): Promise<void> {
        if (this.managerPanel) {
            this.managerPanel.reveal(this.managerPanel.viewColumn ?? vs.ViewColumn.One, false);
        } else {
            await vs.commands.executeCommand('cwtools.aiChat.focus');
        }
        
        // Wait up to 5 seconds for the view to be both defined and visible
        let attempts = 0;
        while (!this.hasVisibleChatSurface() && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        await this.handleUserMessage(text);
    }

    private ensureDispatchAgentFeedbackVisible(result: GenerationResult): GenerationResult {
        if (this.currentMode !== 'orchestrator' && this.currentMode !== 'script') return result;
        if (!result.steps.some(s => s.toolName === 'dispatch_agents')) return result;

        const existing = (result.explanation || '').trim();
        const additions: string[] = [];

        if (!existing.includes('多 Agent 执行计划') && !existing.includes('Orchestrator Dispatch Plan')) {
            const planText = this.buildDispatchPlanMarkdown(result);
            if (planText) additions.push(planText);
        }

        const escalations = this.extractDispatchClarifications(result);
        if (escalations.length > 0 && !existing) {
            additions.push(this.buildDispatchEscalationMarkdown(escalations));
        }

        if (additions.length === 0) return result;
        return {
            ...result,
            explanation: [existing, ...additions].filter(Boolean).join('\n\n'),
        };
    }

    private buildDispatchPlanMarkdown(result: GenerationResult): string {
        const tasks = this.extractDispatchTasks(result);
        if (tasks.length === 0) return '';

        const lines = [
            aiText('## Orchestrator Dispatch Plan', '## 多 Agent 执行计划'),
            '',
            aiText('The current coordination mode submitted the following DAG subtasks:', '当前协调模式已提交的 DAG 子任务如下：'),
            '',
        ];

        for (const task of tasks) {
            const deps = task.dependencies.length > 0
                ? task.dependencies.map(d => `\`${d}\``).join(', ')
                : aiText('none', '无');
            const contextFiles = task.contextFiles.length > 0
                ? task.contextFiles.map(c => `\`${c}\``).join(', ')
                : aiText('none', '无');
            lines.push(`- \`${task.id}\` (${task.agentType})`);
            lines.push(aiText(`  - Dependencies: ${deps}`, `  - 依赖: ${deps}`));
            lines.push(aiText(`  - Context: ${contextFiles}`, `  - 上下文: ${contextFiles}`));
            lines.push(aiText(`  - Task: ${task.prompt}`, `  - 任务: ${task.prompt}`));
        }

        return lines.join('\n');
    }

    private extractDispatchTasks(result: GenerationResult): Array<{
        id: string;
        agentType: string;
        prompt: string;
        dependencies: string[];
        contextFiles: string[];
    }> {
        const tasks: Array<{
            id: string;
            agentType: string;
            prompt: string;
            dependencies: string[];
            contextFiles: string[];
        }> = [];
        const seen = new Set<string>();

        for (const step of result.steps) {
            if (step.type !== 'tool_call' || step.toolName !== 'dispatch_agents') continue;
            const rawTasks = step.toolArgs?.tasks;
            if (!Array.isArray(rawTasks)) continue;

            for (const rawTask of rawTasks) {
                if (!rawTask || typeof rawTask !== 'object') continue;
                const task = rawTask as Record<string, unknown>;
                const id = this.shortPlainText(task.id, 80) || `task_${tasks.length + 1}`;
                const agentType = this.shortPlainText(task.agentType, 40) || 'agent';
                const prompt = this.shortPlainText(task.prompt, 320) || aiText('No task description provided', '未提供任务描述');
                const dependencies = Array.isArray(task.dependencies)
                    ? task.dependencies.map(d => this.shortPlainText(d, 80)).filter(Boolean)
                    : [];
                const contextFiles = Array.isArray(task.contextFiles)
                    ? task.contextFiles.map(c => this.shortPlainText(c, 120)).filter(Boolean)
                    : [];
                const key = `${id}:${agentType}:${prompt}`;
                if (seen.has(key)) continue;
                seen.add(key);
                tasks.push({ id, agentType, prompt, dependencies, contextFiles });
            }
        }

        return tasks;
    }

    private extractDispatchClarifications(result: GenerationResult): Array<{ id: string; clarification: string }> {
        const clarifications: Array<{ id: string; clarification: string }> = [];
        const seen = new Set<string>();

        const pushClarification = (idValue: unknown, clarificationValue: unknown) => {
            const clarification = this.shortPlainText(clarificationValue, 1200);
            if (!clarification) return;
            const id = this.shortPlainText(idValue, 80) || `subtask_${clarifications.length + 1}`;
            const key = `${id}:${clarification}`;
            if (seen.has(key)) return;
            seen.add(key);
            clarifications.push({ id, clarification });
        };

        for (const step of result.steps) {
            if (step.type !== 'tool_result' || step.toolName !== 'dispatch_agents') continue;
            const toolResult = step.toolResult as Record<string, unknown> | undefined;
            if (!toolResult || typeof toolResult !== 'object') continue;

            const rawClarifications = toolResult.clarifications;
            if (Array.isArray(rawClarifications)) {
                for (const item of rawClarifications) {
                    if (item && typeof item === 'object') {
                        const rec = item as Record<string, unknown>;
                        pushClarification(rec.id, rec.clarification);
                    }
                }
            }

            const rawAgents = toolResult.agents;
            if (Array.isArray(rawAgents)) {
                for (const item of rawAgents) {
                    if (item && typeof item === 'object') {
                        const rec = item as Record<string, unknown>;
                        if (rec.needsClarification) {
                            pushClarification(rec.id, rec.clarification ?? rec.error);
                        }
                    }
                }
            }
        }

        return clarifications;
    }

    private buildDispatchEscalationMarkdown(clarifications: Array<{ id: string; clarification: string }>): string {
        const lines = [
            aiText('## Subtask Items Pending Parent-Agent Decision', '## 子任务上报给父 Agent 的待决事项'),
            '',
            aiText(
                'The following items came from sub-agents. The parent agent should first decide from the approved plan, available context, and conservative defaults; ask the user only when it cannot decide safely.',
                '以下事项来自子 Agent。父 Agent 应先依据已批准计划、上下文和保守默认原则自行决策；只有无法安全决断时，才向用户发起澄清。',
            ),
            '',
        ];

        for (const item of clarifications) {
            const detail = this.shortPlainText(item.clarification, 700);
            lines.push(`- \`${item.id}\`: ${detail}`);
        }

        return lines.join('\n').trim();
    }

    private shortPlainText(value: unknown, maxLength: number): string {
        if (value === undefined || value === null) return '';
        let text: string;
        if (typeof value === 'string') {
            text = value;
        } else {
            try {
                text = JSON.stringify(value);
            } catch {
                text = String(value);
            }
        }
        text = text.replace(/\s+/g, ' ').trim();
        if (text.length <= maxLength) return text;
        return text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + '...';
    }

    private async inferBuildModeRouteWithModel(text: string): Promise<AgentMode | undefined> {
        try {
            const response = await this.aiService.chatCompletion([
                {
                    role: 'system',
                    content: 'You are a fast request router for a VS Code coding agent. Return only the requested JSON.',
                },
                {
                    role: 'user',
                    content: buildModeRoutingPrompt(text),
                },
            ], {
                temperature: 0,
                maxTokens: 80,
                disableThinking: true,
                requestTimeoutMs: 10_000,
            });
            const content = response.choices?.[0]?.message?.content;
            const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '');
            return parseModelRouteResponse(raw) ?? inferBuildModeRoute(text);
        } catch (error) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Mode auto-routing failed; using fallback router.', error);
            return inferBuildModeRoute(text);
        }
    }

    public async handleUserMessage(text: string, images?: string[], _attachedFiles?: string[], _skipAutoModeSwitch = false, isBackground = false, resumeFromState = false, displayText?: string, contexts?: import('./types').ContextItem[]): Promise<void> {
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
                error: aiText('AI is not enabled. Click the gear icon to configure an AI provider first.', 'AI 功能未启用。请先点击⚙配置 AI Provider。'),
            });
            return;
        }

        if (!_skipAutoModeSwitch && text.trim() && this.currentMode === 'build' && !this.currentWorkflowId) {
            const routedMode = await this.inferBuildModeRouteWithModel(text);
            if (routedMode && routedMode !== this.currentMode) {
                this.switchMode(routedMode);
            }
        }

        // Ensure we have a topic
        const visibleUserText = displayText ?? text;

        if (!this.topicManager.currentTopic) {
            this.topicManager.createNewTopic(visibleUserText);
        }

        const normalizedText = text.trim().toLowerCase();
        if (!resumeFromState
            && this.topicManager.currentTopic?.id
            && /^(continue|resume|继续|继续执行)$/.test(normalizedText)
            && await this.agentRunner.hasResumeState(this.topicManager.currentTopic.id)) {
            resumeFromState = true;
        }

        // Track message index for retract support
        const messageIndex = this.topicManager.currentTopic!.messages.length;

        // Add user message to UI — pass images array directly (not just a bool flag)
        if (!resumeFromState) {
            if (!isBackground) {
                this.postMessage({ type: 'addUserMessage', text: visibleUserText, messageIndex, images: images?.length ? images : undefined, contexts });
            } else {
                this.postMessage({ type: 'startBackgroundGeneration' });
            }

            // Add to history — store images for topic persistence
            this.topicManager.addHistoryMessage({ role: 'user', content: text, displayContent: displayText, contexts, timestamp: Date.now(), images: images?.length ? images : undefined, isHidden: isBackground });
            
            // When a new task starts, clean up old breakpoint snapshots to prevent context pollution.
            if (this.topicManager.currentTopic?.id) {
                await this.agentRunner.clearResumeState(this.topicManager.currentTopic.id);
            }
        }

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
        const messageSnapshots: FileSnapshot[] = [];
        // P1-6 Fix: capture conversation length BEFORE message exchange, so retract
        // can slice directly without the fragile `-2` hardcode.
        const convLengthBeforeExchange = this.conversationMessages.length;
        this._currentMessageSnapshots = messageSnapshots;
        this.agentRunner.toolExecutor.onBeforeFileWrite = (filePath, previousContent) => {
            // Only record the first snapshot for each file (earliest = true "before" state)
            if (!messageSnapshots.some(s => s.filePath === filePath)) {
                if (previousContent && previousContent.length > 500000) {
                    vs.window.showWarningMessage(aiText(
                        `File ${path.basename(filePath)} is too large (> ${previousContent.length} characters). Its rollback snapshot was not saved to avoid memory exhaustion.`,
                        `文件 ${path.basename(filePath)} 过大 (>${previousContent.length} 字符)。为防止内存耗尽，此文件的撤回快照未保存。`,
                    ));
                    messageSnapshots.push({ filePath, previousContent: null, _tooLarge: true });
                } else {
                    messageSnapshots.push({ filePath, previousContent });
                }
            }
        };

        try {
            const runPromise = this.agentRunner.run(
                text,
                { ...context, topicId: this.topicManager.currentTopic?.id },
                this.conversationMessages,
                {
                    mode: this.currentMode,
                    model: this.aiService.getConfig().model || undefined,
                    streaming: true,  // Enable typewriter text effect
                    topicId: this.topicManager.currentTopic?.id,
                    onStep: (step) => {
                        const replayStep = this.compactStepForUi(step);
                        if (replayStep) {
                            this._liveSteps.push(replayStep);
                            if (this._liveSteps.length > UI_REPLAY_STEP_LIMIT * 2) {
                                this._liveSteps.splice(0, this._liveSteps.length - UI_REPLAY_STEP_LIMIT * 2);
                            }
                        }
                        this.postMessage({ type: 'agentStep', step });
                    },
                    abortSignal: this.abortController!.signal,
                    // Permission callback for run_command tool (OpenCode strategy)
                    onPermissionRequest: (id: string, tool: string, description: string, command?: string, ctx?: any) =>
                        this.requestPermission(id, tool, description, command, ctx),
                    onTodoUpdate: (todos) => this.sendTodoUpdate(todos),
                    resumeFromState,
                    workflowId: this.currentWorkflowId ?? undefined,
                },
                images  // pass images to build ContentPart[] user turn
            );

            this.agentRunner.getActiveRunRecordPromise()?.then((r: any) => {
                this.currentRunId = r.runId;
            }).catch(() => {});

            const rawResult = await runPromise;
            const result = this.ensureDispatchAgentFeedbackVisible(rawResult);

            // ── Orchestrator 自动生成 Walkthrough 自愈机制 ──
            if ((this.currentMode === 'orchestrator' || this.currentMode === 'script') && result.steps.some(s => s.toolName === 'dispatch_agents')) {
                await this.ensureOrchestratorWalkthrough(result);
            }

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
            const lastConversationMessage = this.conversationMessages[this.conversationMessages.length - 1];
            const shouldAppendUserHistory = !resumeFromState
                || lastConversationMessage?.role !== 'user'
                || contentToString(lastConversationMessage.content) !== text;
            if (shouldAppendUserHistory) {
                this.conversationMessages.push({ role: 'user', content: userHistoryContent });
            }
            this.conversationMessages.push({ role: 'assistant', content: assistantContent });

            // ── Plan/Orchestrator mode: suppress explanation in chat, auto-open annotation panel ──
            // If the AI is just asking clarification questions (indicated by :::question syntax
            // or heuristic question detection), it shouldn't lock into an Implementation Plan yet.
            // Treat it as a conversational turn.
            const isJustAskingQuestions = this.detectClarificationPhase(result);
            const usedDispatchAgents = result.steps.some(s => s.toolName === 'dispatch_agents');
            const uiSteps = this.compactStepsForUi(result.steps);
            const uiResult = { ...result, steps: uiSteps };
            const topicId = this.topicManager.currentTopic?.id || 'default';
            const wtPath = this.findGeneratedTopicFile(topicId, 'walkthrough.md');
            if (wtPath) {
                await this.renderWalkthroughUI(wtPath, topicId, uiSteps);
            }

            if ((this.currentMode === 'plan' || ((this.currentMode === 'orchestrator' || this.currentMode === 'script') && !usedDispatchAgents)) && result.explanation && !isJustAskingQuestions) {
                // Chat shows only tool-call steps (no full plan text)
                this.postMessage({ type: 'generationComplete', result: { ...uiResult, explanation: '', code: '' } });
                this.topicManager.addHistoryMessage({
                    role: 'assistant',
                    content: aiText('The plan has been generated and opened in the annotations view.', '计划已生成，已在批注视图中打开'),
                    timestamp: Date.now(),
                    steps: uiSteps,
                });
                void this.savePlanFile(result.explanation, text, uiSteps);
            } else {
                this.postMessage({ type: 'generationComplete', result: uiResult });
                this.topicManager.addHistoryMessage({
                    role: 'assistant',
                    content: result.explanation,
                    code: result.code || undefined,
                    isValid: result.isValid,
                    timestamp: Date.now(),
                    steps: uiSteps,
                });
            }
            this.topicManager.saveTopics();

            const bpPath = this.findGeneratedTopicFile(topicId, 'design_blueprint.md');
            if (bpPath && this.currentMode !== 'orchestrator' && this.currentMode !== 'script') {
                void this.renderBlueprintUI(bpPath, topicId, uiSteps);
            }

            this.collectArtifactsFromResult(uiResult);

            // ── Send token usage stats to UI ────────────────────────────────────
            if (result.tokenUsage && result.tokenUsage.total > 0) {
                const config = this.aiService.getConfig();
                this.usageTracker.addUsage(config.provider, config.model || 'unknown', result.tokenUsage, {
                    toolCalls: result.runMetrics?.toolCallsByName,
                    topicId: this.topicManager.currentTopic?.id,
                });
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
            let canResume = false;
            if (this.topicManager.currentTopic?.id) {
                canResume = await this.agentRunner.hasResumeState(this.topicManager.currentTopic.id);
            }
            this.postMessage({ type: 'generationError', error: errorMsg, canResume });
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

    private async sendUserMessagePayload(text: string, images?: string[], contexts?: ContextItem[]): Promise<void> {
        if (contexts && contexts.length > 0) {
            const referencePrompt = await this.contextReferences.buildReferencePrompt(contexts);
            const displayText = text.trim();
            const agentText = [
                referencePrompt,
                text || 'Please use the referenced context above.',
            ].filter(Boolean).join('\n\n');
            await this.handleUserMessage(agentText, images, undefined, false, false, false, displayText, contexts);
            return;
        }

        await this.handleUserMessage(text, images);
    }

    public async editAndResendMessage(messageIndex: number, text: string, images?: string[], contexts?: ContextItem[]): Promise<void> {
        if (!this.topicManager.currentTopic) return;
        if (this._isGenerating) {
            vs.window.showWarningMessage(aiText('Wait for the current AI run to finish, or cancel it before editing and resending.', '请先等待当前 AI 运行结束，或取消生成后再编辑重发。'));
            return;
        }
        const retracted = await this.retractMessage(messageIndex, { restoreInput: false, notify: false });
        if (!retracted) return;
        await this.sendUserMessagePayload(text, images, contexts);
    }

    /** Retract a user message, its AI response, AND any file changes made during that exchange */
    public async retractMessage(messageIndex: number, options: { restoreInput?: boolean; notify?: boolean } = {}): Promise<boolean> {
        if (!this.topicManager.currentTopic) return false;
        if (this._isGenerating) {
            vs.window.showWarningMessage(aiText('Wait for the current AI run to finish, or cancel it before rolling back the message.', '请先等待当前 AI 运行结束，或取消生成后再回滚消息。'));
            return false;
        }
        if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= this.topicManager.currentTopic.messages.length) {
            vs.window.showWarningMessage(aiText('Cannot roll back: the message position is no longer valid.', '无法回滚：消息位置已经失效。'));
            return false;
        }
        const messageToRestore = this.topicManager.currentTopic.messages[messageIndex];
        if (messageToRestore?.role !== 'user') {
            vs.window.showWarningMessage(aiText('Rollback can only start from a user message.', '只能从用户消息开始回滚。'));
            return false;
        }
        const shouldRestoreInput = options.restoreInput !== false;
        const shouldNotify = options.notify !== false;
        const restoredInput = shouldRestoreInput ? {
            text: messageToRestore.displayContent ?? messageToRestore.content,
            images: messageToRestore.images?.length ? [...messageToRestore.images] : undefined,
            contexts: messageToRestore.contexts?.length ? [...messageToRestore.contexts] : undefined,
        } : undefined;

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

        let restoredFiles = 0;
        const restoredFilePaths = new Set<string>();
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
                // P0 Fix: reject paths outside workspace to prevent path traversal
                if (!isWithinWorkspace(snap.filePath)) {
                    ErrorReporter.debug(SOURCE.CHAT_PANEL, `Retract: Skipping file outside workspace: ${snap.filePath}`);
                    skippedFiles++;
                    continue;
                }

                if ((snap as any)._tooLarge) {
                    ErrorReporter.debug(SOURCE.CHAT_PANEL, `Retract: Skipping file due to being too large: ${snap.filePath}`);
                    skippedFiles++;
                    continue;
                }

                try {
                    if (snap.previousContent === null) {
                        // File was newly created by AI — delete it (async to avoid blocking)
                        if (fs.existsSync(snap.filePath)) {
                            await fs.promises.unlink(snap.filePath);
                            restoredFiles++;
                            restoredFilePaths.add(snap.filePath);
                        }
                    } else {
                        // File existed before — restore original content (async)
                        await fs.promises.writeFile(snap.filePath, snap.previousContent, 'utf-8');
                        restoredFiles++;
                        restoredFilePaths.add(snap.filePath);
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

        const restoredFileCount = restoredFilePaths.size || restoredFiles;
        this.postMessage({ type: 'messageRetracted', messageIndex, restoredInput, restoredFiles: restoredFileCount, skippedFiles });
        this.topicManager.saveTopics();

        if (shouldNotify) {
            const filePart = skippedFiles > 0
                ? aiText(`${restoredFileCount} file(s) restored; ${skippedFiles} file(s) could not be restored.`, `已恢复 ${restoredFileCount} 个文件，${skippedFiles} 个文件未能恢复。`)
                : restoredFileCount > 0
                    ? aiText(`${restoredFileCount} file(s) restored.`, `已恢复 ${restoredFileCount} 个文件。`)
                    : aiText('No file snapshots needed restoration.', '没有需要恢复的文件快照。');
            const inputPart = restoredInput ? aiText(' The original message was restored to the input box.', '原消息已恢复到输入框。') : '';
            vs.window.showInformationMessage(aiText(`Rolled back to before this message. ${filePart}${inputPart}`, `已回滚到该消息之前。${filePart}${inputPart}`));
        }
        return true;
    }

    /**
     * Builds a summary of files changed during the current generation
     * and sends it to the WebView.
     */
    private async sendDiffSummary(snapshots: FileSnapshot[]): Promise<void> {
        if (!snapshots || snapshots.length === 0) return;

        const files: DiffSummaryFile[] = [];
        const artifactFiles: DiffArtifactFile[] = [];
        const netSnapshots = new Map<string, FileSnapshot>();
        for (const snap of snapshots) {
            const key = normalizeSnapshotFilePath(snap.filePath);
            if (!netSnapshots.has(key)) netSnapshots.set(key, snap);
        }

        for (const snap of netSnapshots.values()) {
            if (isTempScriptSnapshot(snap)) continue;
            const currentContentExists = fs.existsSync(snap.filePath);
            let currentContent: string | null = null;
            let currentTooLarge = false;
            if (currentContentExists) {
                try {
                    const stat = await fs.promises.stat(snap.filePath);
                    if (stat.size > MAX_ARTIFACT_DIFF_CONTENT) {
                        currentTooLarge = true;
                    } else {
                        currentContent = await fs.promises.readFile(snap.filePath, 'utf-8');
                    }
                } catch (e: any) {
                    if (e.code !== 'ENOENT') console.debug('[cwtools] snapshot read failed:', snap.filePath, e?.message ?? e);
                    currentContent = null;
                }
            }

            const pushFile = (file: DiffSummaryFile) => {
                files.push(file);
                artifactFiles.push({
                    ...file,
                    previousContent: snap._tooLarge ? null : snap.previousContent,
                    currentContent: currentTooLarge ? null : currentContent,
                    tooLarge: !!snap._tooLarge,
                    currentTooLarge,
                });
            };

            if (snap._tooLarge) {
                pushFile({
                    file: snap.filePath,
                    status: currentContentExists ? 'modified' : 'deleted',
                    diffPreview: 'Previous snapshot was too large to store',
                    additions: 0,
                    deletions: 0,
                });
            } else if (snap.previousContent === null && currentContentExists) {
                const currentLines = currentContent === null ? undefined : currentContent.split('\n');
                const lineCount = currentLines?.length;
                pushFile({
                    file: snap.filePath,
                    status: 'created',
                    diffPreview: lineCount === undefined ? '+ file added' : `+ ${lineCount} lines added`,
                    additions: lineCount,
                    deletions: 0,
                    diffLines: currentLines?.slice(0, 1200).map((content, index) => ({
                        type: 'add',
                        content,
                        newLineNo: index + 1,
                    })),
                });
            } else if (snap.previousContent !== null && !currentContentExists) {
                const previousLines = snap.previousContent.split('\n');
                pushFile({
                    file: snap.filePath,
                    status: 'deleted',
                    diffPreview: `- ${previousLines.length} lines removed`,
                    additions: 0,
                    deletions: previousLines.length,
                    diffLines: previousLines.slice(0, 1200).map((content, index) => ({
                        type: 'remove',
                        content,
                        oldLineNo: index + 1,
                    })),
                });
            } else if (snap.previousContent !== null && currentContentExists) {
                if (currentTooLarge || currentContent === null) {
                    pushFile({
                        file: snap.filePath,
                        status: 'modified',
                        diffPreview: currentTooLarge ? 'Current snapshot is too large to inline' : 'Current snapshot could not be read',
                        additions: 0,
                        deletions: 0,
                    });
                } else if (snap.previousContent !== currentContent) {
                    const diffResult = computeLineDiff(snap.previousContent, currentContent);
                    pushFile({
                        file: snap.filePath,
                        status: 'modified',
                        diffPreview: `+${diffResult.additions} -${diffResult.deletions}${diffResult.truncated ? ' (truncated)' : ''}`,
                        additions: diffResult.additions,
                        deletions: diffResult.deletions,
                        diffLines: diffResult.lines,
                    });
                }
            }
        }

        if (files.length > 0) {
            const summaryId = this.artifactId('diff', String(Date.now()));
            this.postMessage({ type: 'diffSummary', files, summaryId });
            const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
            const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
            const data: DiffArtifactData = { files: artifactFiles, additions, deletions };
            this.upsertArtifact({
                id: summaryId,
                kind: 'diff',
                title: 'File Changes',
                summary: `${files.length} file(s), +${additions} -${deletions}`,
                action: 'openDiff',
                status: 'done',
                data,
            });
        }
    }

    // ─── Plan File ───────────────────────────────────────────────────────────

    /**
     * Register a file write into the current message's snapshot (for retract support).
     * Call this BEFORE writing a file that bypasses AgentToolExecutor
     * (e.g. savePlanFile). The file is treated as newly created (previousContent=null)
     * unless it already exists on disk, in which case its current content is captured.
     */
    public async openArtifact(artifactId: string, file?: string): Promise<void> {
        const artifact = this.artifactStore.get(artifactId);
        if (!artifact) {
            vs.window.showWarningMessage('Artifact is not available in the current session.');
            return;
        }

        if (artifact.kind === 'diff') {
            await this.openDiffArtifact(artifact, file);
            return;
        }

        if (artifact.filePath) {
            // Shared path compatibility: if the stored filePath does not exist, try to find it in a candidate location
            const resolvedPath = this.resolveArtifactFilePath(artifact.filePath);
            if (!resolvedPath) {
                vs.window.showWarningMessage(aiText(`Could not find file: ${path.basename(artifact.filePath)}`, `无法找到文件: ${path.basename(artifact.filePath)}`));
                return;
            }
            const uri = vs.Uri.file(resolvedPath);
            const ext = path.extname(resolvedPath).toLowerCase();
            if (ext === '.md' || ext === '.markdown') {
                await vs.commands.executeCommand('markdown.showPreview', uri);
            } else {
                await vs.commands.executeCommand('vscode.open', uri, { preview: true });
            }
        }
    }

    private getDiffArtifactFiles(artifact: AgentArtifact): DiffArtifactFile[] {
        const data = artifact.data as DiffArtifactData | DiffArtifactFile[] | undefined;
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.files)) return data.files;
        return [];
    }

    private async openDiffArtifact(artifact: AgentArtifact, file?: string): Promise<void> {
        const files = this.getDiffArtifactFiles(artifact);
        if (files.length === 0) {
            vs.window.showWarningMessage('No file changes were recorded for this artifact.');
            return;
        }

        const requested = file ? files.filter(f => f.file === file) : files;
        if (requested.length === 0) {
            vs.window.showWarningMessage('The requested file change is not available in this artifact.');
            return;
        }

        // Clean up old temporary diff files to prevent new files from accumulating with each click
        await this.cleanupArtifactDiffTempDir();

        const targets = file ? requested.slice(0, 1) : requested.slice(0, 8);
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            if (target) await this.openDiffArtifactFile(target, i);
        }
        if (!file && requested.length > targets.length) {
            vs.window.showInformationMessage(`Opened ${targets.length} of ${requested.length} recorded file changes.`);
        }
    }

    private async openDiffArtifactFile(change: DiffArtifactFile, index: number): Promise<void> {
        if (change.tooLarge && typeof change.previousContent !== 'string') {
            if (change.status !== 'deleted' && fs.existsSync(change.file)) {
                await vs.commands.executeCommand('vscode.open', vs.Uri.file(change.file), { preview: true });
            }
            vs.window.showWarningMessage(`Cannot show a full diff for ${path.basename(change.file)} because the previous snapshot was too large to store.`);
            return;
        }

        const tmpDir = this.getArtifactDiffTempDir();
        await fs.promises.mkdir(tmpDir, { recursive: true });

        const beforeContent = typeof change.previousContent === 'string' ? change.previousContent : '';
        const beforePath = this.makeArtifactDiffTempPath(tmpDir, change.file, 'before', index);
        await fs.promises.writeFile(beforePath, beforeContent, 'utf-8');

        let afterUri: vs.Uri;
        if (change.status !== 'deleted' && typeof change.currentContent !== 'string' && fs.existsSync(change.file)) {
            afterUri = vs.Uri.file(change.file);
        } else {
            const afterContent = change.status === 'deleted'
                ? ''
                : (typeof change.currentContent === 'string' ? change.currentContent : '');
            const afterPath = this.makeArtifactDiffTempPath(tmpDir, change.file, 'after', index);
            await fs.promises.writeFile(afterPath, afterContent, 'utf-8');
            afterUri = vs.Uri.file(afterPath);
        }

        await vs.commands.executeCommand(
            'vscode.diff',
            vs.Uri.file(beforePath),
            afterUri,
            `AI Change: ${path.basename(change.file)}`,
            { preview: false, viewColumn: vs.ViewColumn.Active }
        );
    }

    private getArtifactDiffTempDir(): string {
        const topicDir = getTopicStorageDir(this.topicManager.currentTopic?.id, getProjectWorkspaceRoot());
        const fallbackDir = this.storageUri?.fsPath ?? path.join(path.dirname(this.extensionUri.fsPath), '.cwtools-ai', 'default');
        return path.join(topicDir || fallbackDir, 'tmp', 'artifacts');
    }

    private makeArtifactDiffTempPath(tmpDir: string, filePath: string, side: 'before' | 'after', index: number): string {
        const ext = path.extname(filePath) || '.txt';
        const name = (path.basename(filePath, ext) || 'artifact').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
        // Use deterministic naming (without Date.now()), and when clicking the same artifact repeatedly, the old file will be overwritten instead of accumulated
        return path.join(tmpDir, `${index}_${name}_${side}${ext}`);
    }

    /** 
* Clean up old files in the artifact diff temporary directory. 
* Called every time a diff artifact is opened to prevent unlimited accumulation of temporary files. 
*/
    private async cleanupArtifactDiffTempDir(): Promise<void> {
        const tmpDir = this.getArtifactDiffTempDir();
        try {
            if (!fs.existsSync(tmpDir)) return;
            const entries = await fs.promises.readdir(tmpDir);
            // Delete only temporary diff files (matching deterministic naming format or legacy Date.now format)
            for (const entry of entries) {
                if (/_(before|after)\.[^.]+$/.test(entry)) {
                    await fs.promises.unlink(path.join(tmpDir, entry)).catch(() => { /* neglect */ });
                }
            }
        } catch {
            // Silently ignore the directory if it does not exist or cannot be read.
        }
    }

    /** 
* Parse artifact file paths - compatible with shared paths and multiple candidate locations. 
* Used if direct path exists, otherwise inferred from filename and looked in all topic candidate directories. 
*/
    public resolveArtifactFilePath(filePath: string): string | null {
        // Check direct paths first
        if (fs.existsSync(filePath)) return filePath;
        if (!path.isAbsolute(filePath)) {
            const workspacePath = path.join(getProjectWorkspaceRoot(), filePath);
            if (fs.existsSync(workspacePath)) return workspacePath;
        }

        // Extract the file name from the path and search in the candidate location
        const fileName = path.basename(filePath);
        const topicId = this.topicManager.currentTopic?.id;

        // First try to search from all candidate directories of the current topic
        if (topicId) {
            const candidates = getTopicFileCandidates(topicId, fileName, getProjectWorkspaceRoot());
            const found = candidates.find(c => fs.existsSync(c));
            if (found) return found;
        }

        // Finally try to infer the topicId from the path itself (which may be different from the current topic)
        const parentName = path.basename(path.dirname(filePath));
        if (parentName && parentName !== topicId) {
            const candidates = getTopicFileCandidates(parentName, fileName, getProjectWorkspaceRoot());
            const found = candidates.find(c => fs.existsSync(c));
            if (found) return found;
        }

        return null;
    }

    public async openRunResult(filePath: string): Promise<void> {
        const resolvedPath = this.resolveArtifactFilePath(filePath);
        if (!resolvedPath) {
            vs.window.showWarningMessage(`Unable to find run result: ${path.basename(filePath)}`);
            return;
        }
        await vs.commands.executeCommand('vscode.open', vs.Uri.file(resolvedPath), { preview: true });
    }

    public async cleanupRunArtifacts(maxAgeDays = 14, maxFiles = 50): Promise<void> {
        const topicId = this.topicManager.currentTopic?.id || 'default';
        const result = await runLedger.cleanupLargeResultArtifacts(topicId, { maxAgeDays, maxFiles });
        this.postMessage({
            type: 'runArtifactsCleanupResult',
            deletedCount: result.deletedCount,
            keptCount: result.keptCount,
            reclaimedBytes: result.reclaimedBytes,
        });
        vs.window.showInformationMessage(`Cleaned ${result.deletedCount} large run result file(s).`);
    }

    private findGeneratedTopicFile(topicId: string, fileName: string): string | null {
        const candidates = getTopicFileCandidates(topicId, fileName, getProjectWorkspaceRoot());
        const normalizedCandidates = new Set(candidates.map(candidate => path.normalize(candidate).toLowerCase()));
        const written = this._currentMessageSnapshots?.find(snapshot =>
            normalizedCandidates.has(path.normalize(snapshot.filePath).toLowerCase())
        );
        return written?.filePath ?? null;
    }

    private _recordFileSnapshot(filePath: string): void {
        const snapshots = this._currentMessageSnapshots;
        if (!snapshots) return;
        const workspaceRoot = getProjectWorkspaceRoot();
        const resolvedFilePath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
        const normalizedPath = normalizeSnapshotFilePath(resolvedFilePath, workspaceRoot);
        if (snapshots.some(s => normalizeSnapshotFilePath(s.filePath, workspaceRoot) === normalizedPath)) return; // already recorded
        let previousContent: string | null = null;
        try {
            if (fs.existsSync(resolvedFilePath)) {
                previousContent = fs.readFileSync(resolvedFilePath, 'utf-8');
            }
        } catch { /* treat as new file */ }
        snapshots.push({ filePath: resolvedFilePath, previousContent });
    }


    /** 
* Check whether the AI's reply in Plan/Orchestrator mode belongs to the "clarification/question stage". 
* 
* Only use deterministic signal judgment, no heuristic guessing: 
* - Plan document already exists → Revision phase (not clarification) 
* - write_file writes the plan → planning phase (non-clarification) 
* - contains :::question syntax → clarification phase 
*/
    private detectClarificationPhase(result: { explanation: string; steps: any[] }): boolean {
        if (!result.explanation) return false;

        // If Implementation_Plan.md already exists under the current topic,
        // This indicates that the user has already commented on the plan and the AI is revising it, so it should not be judged to be in the clarification stage.
        const topicId = this.topicManager.currentTopic?.id;
        if (topicId) {
            const candidates = getTopicFileCandidates(topicId, 'Implementation_Plan.md', getProjectWorkspaceRoot());
            const planExists = candidates.some(c => fs.existsSync(c));
            if (planExists) return false;
        }

        // If AI writes the plan file through the write_file tool → planning phase
        const wroteImplementationPlan = result.steps.some(
            (s: any) => (s.toolName === 'write_file') &&
            typeof s.toolArgs?.file === 'string' &&
            /implementation_plan|plan\.md/i.test(s.toolArgs.file)
        );
        if (wroteImplementationPlan) return false;

        // Contains :::question syntax → explicitly for question phase
        if (result.explanation.includes(':::question')) return true;

        return false;
    }

    private async savePlanFile(planText: string, userPrompt: string, steps?: any[]): Promise<void> {
        // ── Persist .md export ──────────────────────────────────────────────
        let filePath = '';
        let relPath = '';
        const baseDir = getAiStorageRoot(getProjectWorkspaceRoot());
        if (baseDir) {
            const topicId = this.topicManager.currentTopic?.id || 'default';
            // Put under topic folder to scope "same conversation series" (same conversation series) while keeping exactly "Implementation_Plan.md"
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
            this.postMessage({ type: 'planFileSaved', filePath, relPath, mode: this.currentMode });
            this.upsertArtifact({
                id: this.artifactId('plan', path.basename(filePath)),
                kind: 'plan',
                title: this.currentMode === 'orchestrator' ? 'Orchestrator Plan' : this.currentMode === 'script' ? 'Script Mode Pipeline Plan' : 'Implementation Plan',
                summary: (this.currentMode === 'orchestrator' || this.currentMode === 'script')
                    ? 'DAG dispatch plan awaiting approval.'
                    : 'Single-agent implementation plan awaiting approval.',
                filePath,
                relPath,
                status: 'pending',
            });

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

            this.postMessage({ type: 'renderPlan', sections, planText, mode: this.currentMode });

            if (steps) {
                steps.push({ type: 'plan_card', content: filePath, toolResult: sections, mode: this.currentMode, uiState: 'pending', timestamp: Date.now() });
                this.topicManager.saveTopics();
            }

        }
    }

    private async renderWalkthroughUI(filePath: string, topicId: string, steps?: any[]) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const relPath = path.posix.join('.cwtools-ai', topicId, 'walkthrough.md');

            this.postMessage({ type: 'walkthroughFileSaved', filePath, relPath });
            this.upsertArtifact({
                id: this.artifactId('walkthrough', path.basename(filePath)),
                kind: 'walkthrough',
                title: 'Walkthrough Report',
                summary: 'Full task walkthrough report generated by the agent.',
                filePath,
                relPath,
                status: 'done',
            });

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
                steps.push({ type: 'walkthrough_card', content: filePath, toolResult: sections, uiState: 'pending', timestamp: Date.now() });
                this.topicManager.saveTopics();
            }

        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to parse walkthrough.md', e);
        }
    }

    private async renderBlueprintUI(filePath: string, topicId: string, steps?: any[]) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const relPath = path.posix.join('.cwtools-ai', topicId, 'design_blueprint.md');

            this.postMessage({ type: 'blueprintFileSaved', filePath, relPath });
            this.upsertArtifact({
                id: this.artifactId('blueprint', path.basename(filePath)),
                kind: 'blueprint',
                title: 'Design Blueprint',
                summary: 'Structured architecture blueprint for cross-file work.',
                filePath,
                relPath,
                status: 'pending',
            });

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
            this.postMessage({ type: 'renderBlueprint', sections, planText: content });

            if (steps) {
                steps.push({ type: 'blueprint_card', content: filePath, toolResult: sections, uiState: 'pending', timestamp: Date.now() });
                this.topicManager.saveTopics();
            }

        } catch (e) {
            ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to parse design_blueprint.md', e);
        }
    }

    // ─── File Write Confirmation ──────────────────────────────────────────────

    private pendingWriteResolvers = new Map<string, (confirmed: boolean) => void>();
    private pendingWriteCards = new Map<string, PendingWriteCardMessage>();
    /** Maps messageId → temp file path used for the diff view (for cleanup) */
    private pendingDiffTempFiles = new Map<string, string>();
    handleAutoWritten(file: string, isNewFile: boolean) {
        this.postMessage({
            type: 'autoWriteFile',
            file,
            isNewFile
        });
    }

    handlePendingWrite(file: string, newContent: string, messageId: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.pendingWriteResolvers.set(messageId, (confirmed: boolean) => {
                resolve(confirmed);
            });

            const isNewFile = !fs.existsSync(file);

            // ── Open VSCode native diff editor ────────────────────────────────
            const topicId = this.topicManager.currentTopic?.id || 'default';
            const tmpDir = path.join(getTopicStorageDir(topicId, getProjectWorkspaceRoot()), 'tmp');
            const ext = path.extname(file) || '.txt';
            const tempPath = path.join(tmpDir, `__pending_${messageId}${ext}`);
            let diffPreview = isNewFile ? '+ file added' : 'Pending file change';
            let additions = 0;
            let deletions = 0;
            let diffLines: import('./types').DiffLine[] | undefined;

            try {
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                fs.writeFileSync(tempPath, newContent, 'utf-8');
                this.pendingDiffTempFiles.set(messageId, tempPath);

                if (isNewFile) {
                    const lines = newContent.split('\n');
                    additions = lines.length;
                    diffPreview = `+ ${additions} lines added`;
                    diffLines = lines.slice(0, 1200).map((content, index) => ({
                        type: 'add',
                        content,
                        newLineNo: index + 1,
                    }));
                } else {
                    const previousContent = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
                    const diffResult = computeLineDiff(previousContent, newContent);
                    additions = diffResult.additions;
                    deletions = diffResult.deletions;
                    diffLines = diffResult.lines;
                    diffPreview = `+${additions} -${deletions}${diffResult.truncated ? ' (truncated)' : ''}`;
                }
            } catch (e) {
                ErrorReporter.warn(SOURCE.CHAT_PANEL, 'Failed to prepare inline diff view', e);
            }

            const card: PendingWriteCardMessage = { type: 'pendingWriteFile', file, messageId, isNewFile, diffPreview, additions, deletions, diffLines };
            this.pendingWriteCards.set(messageId, card);
            if (this.currentRunId) {
                runLedger.appendEvent(
                    this.currentRunId,
                    'write_confirmation_requested',
                    { file, messageId, isNewFile, diffPreview, additions, deletions },
                    { invocationId: messageId }
                ).catch(() => {});
            }

            // Tell the WebView to show a simple Accept/Reject card
            this.postMessage(card);
        });
    }

    async resolveWriteConfirmation(messageId: string, confirmed: boolean): Promise<void> {
        const resolver = this.pendingWriteResolvers.get(messageId);
        if (resolver) {
            this.pendingWriteResolvers.delete(messageId);
            resolver(confirmed);
        }
        const card = this.pendingWriteCards.get(messageId);
        this.pendingWriteCards.delete(messageId);
        if (this.currentRunId) {
            runLedger.appendEvent(
                this.currentRunId,
                'write_confirmation_resolved',
                { confirmed, file: card?.file, messageId },
                { invocationId: messageId }
            ).catch(() => {});
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

    private _todoUpdateTimeout: NodeJS.Timeout | null = null;
    private _pendingTodos: import('./types').TodoItem[] | null = null;

    /** Push todo update to the WebView (called by toolExecutor.onTodoUpdate) with debouncing */
    sendTodoUpdate(todos: import('./types').TodoItem[]): void {
        // Defensive try-catch: In a multi-Agent concurrent scenario, this callback is called synchronously by the sub-Agent's todoWrite.
        // Any uncaught exception will cause the child Agent's Promise to reject, thus blocking the coordinator.
        try {
            this._pendingTodos = todos;
            
            if (this._todoUpdateTimeout) {
                return;
            }

            // Throttle updates to prevent UI lockups and I/O congestion during multi-agent concurrent execution
            this._todoUpdateTimeout = setTimeout(() => {
                this._todoUpdateTimeout = null;
                const currentTodos = this._pendingTodos;
                if (!currentTodos) return;

                try {
                    this.postMessage({ type: 'todoUpdate', todos: currentTodos });
                } catch { /* Prevent postMessage exception from affecting task.md writing */ }

                // Natively save task.md in the topic folder
                const topicId = this.topicManager.currentTopic?.id || 'default';
                const topicDir = getTopicStorageDir(topicId, getProjectWorkspaceRoot());
                if (topicDir && currentTodos.length > 0) {
                    const taskPath = path.join(topicDir, 'task.md');

                    const lines: string[] = ['# Task List\n'];
                    for (const t of currentTodos) {
                        const mark = t.status === 'done' ? '[x]' : (t.status === 'in_progress' ? '[/]' : '[ ]');
                        lines.push(`- ${mark} ${t.content}`);
                    }

                    // Register task.md in the current message snapshot so retract can delete/restore it
                    this._recordFileSnapshot(taskPath);

                    void fs.promises.mkdir(path.dirname(taskPath), { recursive: true }).then(() => {
                        fs.promises.writeFile(taskPath, lines.join('\n'), 'utf-8').catch((e: any) => console.debug('[cwtools] task.md write failed:', e?.message ?? e));
                    });
                }
            }, 500);
        } catch (e) {
            // Swallow the exception silently to ensure that the caller (sub-Agent todoWrite) is not affected
            ErrorReporter.debug(SOURCE.CHAT_PANEL, 'sendTodoUpdate: 回调异常已捕获', e);
        }
    }

    // ─── Code Insertion ──────────────────────────────────────────────────────

    public async insertCodeWithDiff(code: string): Promise<void> {
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
                aiText(`AI Code Change Preview - ${path.basename(document.uri.fsPath)}`, `AI 代码变更预览 - ${path.basename(document.uri.fsPath)}`),
                { preview: true }
            );

            // Ask for confirmation
            const acceptLabel = aiText('Accept', '✓ 接受');
            const rejectLabel = aiText('Reject', '✗ 拒绝');
            const action = await vs.window.showInformationMessage(
                aiText('Accept the AI-generated code change?', '是否接受 AI 生成的代码变更？'),
                { modal: false },
                acceptLabel,
                rejectLabel
            );

            if (action === acceptLabel) {
                // Apply the edit
                const edit = new vs.WorkspaceEdit();
                edit.insert(document.uri, new vs.Position(insertLine + 1, 0), code + '\n');
                await vs.workspace.applyEdit(edit);
                vs.window.showInformationMessage(aiText('Code inserted.', '代码已插入'));
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

    public startNewTopic(): void {
        this.topicManager.startNewTopic();
        this.conversationMessages = [];
        this._messageFileSnapshots.clear();
        this._currentMessageSnapshots = null;
        this.clearArtifacts();
    }

    public async loadTopic(topicId: string): Promise<void> {
        this.clearArtifacts();
        const topic = this.topicManager.topics.find(t => t.id === topicId);
        this.conversationMessages = this.topicManager.loadTopic(
            topicId,
            topic ? this.compactMessagesForWebview(topic.messages) as any : undefined
        );
        const resumeState = await this.agentRunner.loadResumeState(topicId);
        if (resumeState) {
            const topic = this.topicManager.currentTopic;
            const lastAssistant = [...(topic?.messages ?? [])]
                .reverse()
                .find(message => message.role === 'assistant' && message.timestamp);
            if (lastAssistant?.timestamp && lastAssistant.timestamp >= (resumeState.timestamp ?? 0) - 1000) {
                await this.agentRunner.clearResumeState(topicId);
                return;
            }
            this.postMessage({ type: 'generationError', error: aiText('This topic contains an unfinished task snapshot.', '当前会话包含未完成的任务快照。'), canResume: true });
        }
    }

    public deleteTopic(topicId: string): void {
        const wasCurrentDeleted = this.topicManager.deleteTopic(topicId);
        if (wasCurrentDeleted) {
            this.conversationMessages = [];
            this._messageFileSnapshots.clear();
            this._currentMessageSnapshots = null;
            this.clearArtifacts();
        }

        // Asynchronously clean up the disk folder corresponding to the topic (.cwtools-ai/{topicId}/),
        //Includes all derivative files such as plan, walkthrough, task, scratch, media, tmp, etc.
        const topicDirs = getTopicStorageDirCandidates(topicId, getProjectWorkspaceRoot());
        if (topicDirs.length > 0) {
            for (const topicDir of topicDirs) fs.promises.rm(topicDir, { recursive: true, force: true }).catch(() => {
                // Silently ignore if the folder does not exist or fails to be deleted
            });
        }
    }

    /**
     * Fork a topic at a specific message index (OpenCode-style session fork).
     * Creates a new topic with messages[0..messageIndex], switches to it.
     */
    public forkTopic(topicId: string, messageIndex: number): void {
        this.clearArtifacts();
        this.conversationMessages = this.topicManager.forkTopic(topicId, messageIndex);
    }

    /** Archive/unarchive a topic (hidden from main list but not deleted) */
    public archiveTopic(topicId: string): void {
        const wasCurrentArchived = this.topicManager.archiveTopic(topicId);
        if (wasCurrentArchived) {
            this.conversationMessages = [];
            this._messageFileSnapshots.clear();
            this._currentMessageSnapshots = null;
            this.clearArtifacts();
        }
    }


    public async regenerateLastResponse(): Promise<void> {
        if (!this.topicManager.currentTopic || this.topicManager.currentTopic.messages.length < 1) return;

        const lastMsg = this.topicManager.currentTopic.messages[this.topicManager.currentTopic.messages.length - 1];
        const topicId = this.topicManager.currentTopic.id;
        const resumeState = await this.agentRunner.loadResumeState(topicId);
        if (resumeState) {
            if (lastMsg?.role === 'assistant') {
                this.topicManager.currentTopic.messages.pop();
                this.conversationMessages.pop();
            }
            const lastUserMsg = this.topicManager.currentTopic.messages[this.topicManager.currentTopic.messages.length - 1];
            if (lastUserMsg?.role === 'user') {
                await this.handleUserMessage(lastUserMsg.content, lastUserMsg.images, undefined, false, false, true, lastUserMsg.displayContent, lastUserMsg.contexts);
                return;
            }
        }

        // Normal regenerate
        // Remove last assistant message
        if (lastMsg?.role === 'assistant') {
            this.topicManager.currentTopic.messages.pop();
            this.conversationMessages.pop();
        }

        // Re-send the last user message
        const lastUserMsg = this.topicManager.currentTopic.messages[this.topicManager.currentTopic.messages.length - 1];
        if (lastUserMsg?.role === 'user') {
            this.topicManager.currentTopic.messages.pop();
            this.conversationMessages.pop();
            await this.handleUserMessage(lastUserMsg.content, lastUserMsg.images, undefined, false, false, false, lastUserMsg.displayContent, lastUserMsg.contexts);
        }
    }

    public cancelGeneration(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.aiService.cancel();

        // Clean up all pending permission approval resolvers to prevent orphaned Promise and UI residual cards
        for (const resolver of this.pendingPermissionResolvers.values()) {
            resolver(false);
        }
        this.pendingPermissionResolvers.clear();
        this.pendingPermissionModes.clear();
        this.pendingPermissionDetails.clear();
        this.pendingPermissionCards.clear();

        // Clean up any pending file write confirmations resolver
        for (const resolver of this.pendingWriteResolvers.values()) {
            resolver(false);
        }
        this.pendingWriteResolvers.clear();
        this.pendingWriteCards.clear();
        for (const tempPath of this.pendingDiffTempFiles.values()) {
            void fs.promises.unlink(tempPath).catch(() => {});
        }
        this.pendingDiffTempFiles.clear();
    }

    /**
     * Handle slash commands from the WebView e.g. /clear, /fork, /mode:build, /init.
     */
    public async handleSlashCommand(command: string): Promise<void> {
        const cmd = command.trim().toLowerCase();
        if (cmd === 'clear' || cmd === '/clear') {
            this.startNewTopic();
        } else if (cmd === 'compact' || cmd === '/compact') {
            const result = await this.agentRunner.compactActiveHistory(this.conversationMessages, {
                mode: this.currentMode,
                model: this.aiService.getConfig().model || undefined,
            }, step => {
                if (step.compactionInfo) this.postMessage({ type: 'contextCompactionStatus', step });
            });
            vs.window.showInformationMessage(result.compacted ? UI.CONTEXT_COMPACTED : UI.CONTEXT_COMPACT_EMPTY);
        } else if (cmd.startsWith('mode:') || cmd.startsWith('/mode:')) {
            const mode = cmd.split(':')[1] as AgentMode;
            if (mode === 'general') {
                this.switchMode('utility');
            } else if (['build', 'plan', 'explore', 'utility', 'review', 'orchestrator', 'script'].includes(mode)) {
                this.switchMode(mode);
            }
        } else if (cmd === 'workflow:none' || cmd === '/workflow:none' || cmd === 'workflow:off' || cmd === '/workflow:off') {
            this.switchWorkflow(null);
        } else if (cmd === 'workflow:list' || cmd === '/workflow:list') {
            this.sendWorkflowState();
        } else if (cmd === 'workflow:save' || cmd === '/workflow:save' || cmd.startsWith('workflow:save:') || cmd.startsWith('/workflow:save:')) {
            await this.saveWorkflowFromSlash(command);
        } else if (cmd.startsWith('workflow:') || cmd.startsWith('/workflow:')) {
            this.switchWorkflow(cmd.split(':')[1]);
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
    private async saveWorkflowFromSlash(command: string): Promise<void> {
        const visibleCommand = command.trim();
        const normalized = visibleCommand.replace(/^\//, '');
        const parts = normalized.split(':');
        const requestedId = parts.length > 2
            ? parts.slice(2).join(':').trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80)
            : '';
        const idInstruction = requestedId
            ? `Use workflow id "${requestedId}" unless it is unsafe; if you need to sanitize it, preserve its meaning.`
            : 'Choose a short kebab-case id.';
        const prompt = [
            `The user invoked ${visibleCommand} to save the reusable process from this conversation as a project workflow.`,
            idInstruction,
            'Extract only the repeatable workflow: objective, phases, constraints, useful tools, required context, and verification.',
            'Then call save_workflow with title, description, mode, promptSupplement, and any narrow allowedTools/blockedTools that make the workflow safer.',
            'After saving, briefly tell the user the workflow id and slash command to run it.',
        ].join('\n');
        await this.handleUserMessage(prompt, undefined, undefined, true, false, false, visibleCommand);
    }

    private async generateInitFile(): Promise<void> {
        const result = await generateInitFile(
            (msg) => this.postMessage(msg),
            (filePath) => this._recordFileSnapshot(filePath)
        );
        if (result.success) {
            this.agentRunner.clearPromptCache();
        }
    }


    // ─── Permission System (OpenCode-aligned) ────────────────────────────────────

    private pendingPermissionResolvers = new Map<string, (allowed: boolean) => void>();
    private pendingPermissionModes = new Map<string, AgentMode>();
    private pendingPermissionDetails = new Map<string, { command?: string, cwd?: string, preflight?: any }>();
    private pendingPermissionCards = new Map<string, PendingPermissionCardMessage>();

    /**
     * Request permission from the user (for run_command tool).
     * Shows a WebView permission card and suspends indefinitely until user responds.
     */
    private requestPermission(
        id: string,
        tool: string,
        description: string,
        command?: string,
        context?: any
    ): Promise<boolean> {
        if (this.currentRunId) {
            runLedger.appendEvent(this.currentRunId, 'permission_requested', { tool, command, description }, { invocationId: id }).catch(() => {});
        }
        activePendingInteractions.set(id, command ? `[run_command] ${command}` : `[${tool}] ${description}`);
        const requestMode = this.currentMode;
        // Structured flags from preflight/tool context decide escalation; the
        // description-tag regex stays only as a fail-safe fallback.
        const isEscalationRequest = context?.preflight?.escalation === true
            || context?.preflight?.requiresEscalation === true
            || context?.escalation === true
            || /\[ESCALATION\]|escalation/i.test(description);
        const resolveAutomatically = (reason: string): Promise<boolean> => {
            activePendingInteractions.delete(id);
            if (this.currentRunId) {
                runLedger.appendEvent(
                    this.currentRunId,
                    'permission_resolved',
                    { allowed: true, alwaysAllow: false, autoApproved: true, reason },
                    { invocationId: id }
                ).catch(() => {});
            }
            return Promise.resolve(true);
        };

        // Full-access tier: the user explicitly removed sandbox and approval
        // boundaries for this workspace. Every request auto-resolves; the call is
        // still fully logged and visible in the run timeline.
        if (isSecuritySandboxDisabled()) {
            return resolveAutomatically('full-access');
        }

        // 联动 PermissionPolicyStore 进行高精细粒度低风险命令豁免，保障安全边界
        if (tool === 'run_command' && !isEscalationRequest) {
            const riskLevel = context?.preflight?.riskLevel ?? 0;
            const approved = PermissionPolicyStore.getInstance().isApproved(
                'run_command',
                {
                    CommandLine: command || '',
                    Cwd: context?.preflight?.cwd || context?.cwd || ''
                },
                riskLevel
            );
            if (approved) {
                return resolveAutomatically('policy');
            }
        }

        // Auto-review: reviewer swap at the approval boundary; ask_user falls through to the card.
        // Mode-agnostic: utility/build/script all share this exact funnel.
        const reviewerMode = vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string>('approvals.reviewer', 'auto_review');
        if (reviewerMode === 'auto_review' && !isEscalationRequest) {
            return this.runAutoReview(id, tool, description, command, context).then(decision => {
                if (decision !== undefined) return decision;
                return this.promptUserPermission(id, tool, description, command, context, requestMode);
            });
        }

        return this.promptUserPermission(id, tool, description, command, context, requestMode);
    }

    private promptUserPermission(
        id: string,
        tool: string,
        description: string,
        command: string | undefined,
        context: any,
        requestMode: AgentMode
    ): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.pendingPermissionResolvers.set(id, (allowed: boolean) => {
                resolve(allowed);
            });
            this.pendingPermissionModes.set(id, requestMode);
            this.pendingPermissionDetails.set(id, {
                command,
                cwd: context?.preflight?.cwd,
                preflight: context?.preflight
            });

            const isEscalation = /\[ESCALATION\]|escalation/i.test(description);
            const riskLevel = context?.preflight?.riskLevel ?? 2;
            const card: PendingPermissionCardMessage = {
                type: 'permissionRequest',
                permissionId: id,
                tool,
                description,
                command,
                preflight: context?.preflight,
                allowAlways: tool === 'run_command' && !isEscalation && riskLevel <= 1,
            };
            this.pendingPermissionCards.set(id, card);
            this.postMessage(card);
        });
    }

    private autoReviewer?: AutoReviewer;

    private getAutoReviewer(): AutoReviewer {
        if (!this.autoReviewer) {
            this.autoReviewer = new AutoReviewer(async (system, user) => {
                const res = await this.aiService.chatCompletion(
                    [{ role: 'system', content: system }, { role: 'user', content: user }],
                    { temperature: 0, maxTokens: 300, disableThinking: true, requestTimeoutMs: 30_000 }
                );
                const content = res.choices?.[0]?.message?.content;
                return typeof content === 'string' ? content : JSON.stringify(content ?? '');
            });
        }
        return this.autoReviewer;
    }

    /** Returns true/false when the reviewer decided, undefined to fall back to the user. */
    private async runAutoReview(
        id: string,
        tool: string,
        description: string,
        command: string | undefined,
        context: any
    ): Promise<boolean | undefined> {
        const preflight = context?.preflight;
        const decision = await this.getAutoReviewer().review({
            id,
            runId: this.currentRunId,
            toolName: tool,
            riskLevel: preflight?.riskLevel ?? 2,
            command,
            cwd: preflight?.cwd ?? context?.cwd,
            classification: preflight?.classification,
            systemReason: description,
            escalation: !!preflight?.escalation || !!preflight?.requiresEscalation,
            inlineEval: !!command && hasInlineEvalPayload(command),
        });
        if (this.currentRunId) {
            runLedger.appendEvent(this.currentRunId, 'reviewer_decision', {
                tool, command, verdict: decision.verdict, rationale: decision.rationale, fromCache: !!decision.fromCache,
            }, { invocationId: id }).catch(() => {});
        }
        if (decision.verdict === 'ask_user') return undefined;
        activePendingInteractions.delete(id);
        const allowed = decision.verdict !== 'deny';
        if (allowed && decision.verdict === 'approve_with_rule' && tool === 'run_command' && command) {
            // Reviewer rules are session-scoped and capped at risk 2 — never exempt destructive calls.
            const prefixWords = deriveCommandPrefix(command);
            if (prefixWords[0]) {
                const created = PermissionPolicyStore.getInstance().addRule({
                    tool: 'run_command',
                    commandPrefix: prefixWords,
                    cwdScope: preflight?.cwd || getProjectWorkspaceRoot(),
                    riskMax: Math.min(2, Math.max(1, preflight?.riskLevel ?? 1)) as 1 | 2,
                    sessionOnly: true,
                });
                if (this.currentRunId) {
                    runLedger.appendEvent(this.currentRunId, 'approval_rule_created', {
                        ruleId: created.id, tool: 'run_command', commandPrefix: prefixWords, scope: 'session', createdBy: 'auto_review',
                    }, { invocationId: id }).catch(() => {});
                }
            }
        }
        if (this.currentRunId) {
            runLedger.appendEvent(this.currentRunId, 'permission_resolved', {
                allowed, reviewer: 'auto_review', rationale: decision.rationale,
            }, { invocationId: id }).catch(() => {});
        }
        return allowed;
    }

    public resolvePermissionRequest(permissionId: string, allowed: boolean, alwaysAllow?: boolean): void {
        activePendingInteractions.delete(permissionId);
        if (this.currentRunId) {
            runLedger.appendEvent(this.currentRunId, 'permission_resolved', { allowed, alwaysAllow }, { invocationId: permissionId }).catch(() => {});
        }
        this.pendingPermissionCards.delete(permissionId);
        const resolver = this.pendingPermissionResolvers.get(permissionId);
        if (resolver) {
            this.pendingPermissionResolvers.delete(permissionId);
            this.pendingPermissionModes.delete(permissionId);
            
            const details = this.pendingPermissionDetails.get(permissionId);
            this.pendingPermissionDetails.delete(permissionId);

            if (alwaysAllow && allowed) {
                const riskLevel = details?.preflight?.riskLevel ?? 1;
                // Defense in depth: never persist exemptions for risk >= 2 even if the UI sent alwaysAllow.
                if (details?.command && riskLevel <= 1) {
                    const prefixWords = deriveCommandPrefix(details.command);
                    if (prefixWords[0]) {
                        const created = PermissionPolicyStore.getInstance().addRule({
                            tool: 'run_command',
                            commandPrefix: prefixWords,
                            cwdScope: details.cwd || getProjectWorkspaceRoot(),
                            riskMax: 1,
                            sessionOnly: true
                        });
                        if (this.currentRunId) {
                            runLedger.appendEvent(this.currentRunId, 'approval_rule_created', {
                                ruleId: created.id, tool: 'run_command', commandPrefix: prefixWords, scope: 'session', createdBy: 'user',
                            }, { invocationId: permissionId }).catch(() => {});
                        }
                        // Rule-set change invalidates cached reviewer decisions.
                        if (this.autoReviewer) {
                            this.autoReviewer.invalidateCache();
                            if (this.currentRunId) {
                                runLedger.appendEvent(this.currentRunId, 'reviewer_cache_invalidated', { reason: 'approval_rule_created' }).catch(() => {});
                            }
                        }
                    }
                }
            }
            resolver(allowed);
        }
    }

    public switchMode(mode: AgentMode): void {
        if (this.currentMode !== mode) this.previousMode = this.currentMode;
        this.currentMode = mode;
        this.postMessage({ type: 'modeChanged', mode });
    }

    public switchWorkflow(workflowId?: string | null): void {
        const normalized = (workflowId || '').trim();
        if (!normalized) {
            this.currentWorkflowId = null;
            this.sendWorkflowState();
            return;
        }

        const workflow = getWorkflow(normalized);
        if (!workflow) {
            vs.window.showWarningMessage(`Unknown AI workflow: ${normalized}`);
            this.sendWorkflowState();
            return;
        }

        this.currentWorkflowId = workflow.id;
        this.switchMode(workflow.mode);
        this.sendWorkflowState();
    }

    private sendWorkflowState(postMessage: (msg: HostMessage) => void = (msg) => this.postMessage(msg)): void {
        const workflowLocale = vs.env.language;
        const workflows = getAllWorkflows().map(workflow => toWorkflowViewModel(workflow, workflowLocale));
        const labels = getWorkflowUiLabels(workflowLocale);
        postMessage({
            type: 'workflowList',
            workflows,
            currentWorkflowId: this.currentWorkflowId,
            labels,
        });
        postMessage({
            type: 'workflowChanged',
            workflowId: this.currentWorkflowId,
            workflow: this.currentWorkflowId ? workflows.find(w => w.id === this.currentWorkflowId) : undefined,
            labels,
        });
    }

    public sendManagerSnapshot(): void {
        const visibleTopics = this.topicManager.topics
            .filter(topic => this.topicManager.showArchived || !topic.archived);
        const archivedCount = this.topicManager.topics.filter(topic => topic.archived).length;

        this.postMessageToSurface('manager', {
            type: 'managerSnapshot',
            topics: visibleTopics.map(topic => ({
                id: topic.id,
                title: topic.title,
                updatedAt: topic.updatedAt,
                createdAt: topic.createdAt,
                archived: topic.archived,
                pinned: topic.pinned,
                workspaceId: topic.workspaceId,
                workspaceLabel: topic.workspaceLabel,
                messageCount: topic.messages.length,
                parentTopicId: topic.parentTopicId,
                forkedFromMessageIndex: topic.forkedFromMessageIndex,
            })),
            stats: {
                total: this.topicManager.topics.length,
                visible: visibleTopics.length,
                archived: archivedCount,
                currentTopicId: this.topicManager.currentTopic?.id ?? null,
                currentTopicTitle: this.topicManager.currentTopic?.title ?? null,
            },
            messages: [],
            messageCount: (this.topicManager.currentTopic?.messages ?? []).filter(message => !message.isHidden).length,
            mode: this.currentMode,
            workflowId: this.currentWorkflowId,
            isGenerating: this._isGenerating,
            liveStepCount: this._liveSteps.length,
            artifacts: this.artifactStore.list(),
        });
    }

    public markLatestInteractiveCardApproved(types: Array<'plan_card' | 'blueprint_card' | 'walkthrough_card'>): void {
        const topic = this.topicManager.currentTopic;
        if (!topic) return;

        let changed = false;
        for (let messageIndex = topic.messages.length - 1; messageIndex >= 0; messageIndex--) {
            const steps = topic.messages[messageIndex]?.steps;
            if (!steps) continue;
            for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex--) {
                const step = steps[stepIndex] as any;
                if (!step || !types.includes(step.type as any) || step.uiState === 'approved') continue;
                step.uiState = 'approved';
                changed = true;
            }
        }
        if (changed) this.topicManager.saveTopics();
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
    public sendWorkspaceFileList(): void {
        const root = getProjectWorkspaceRoot();
        if (!root) {
            this.postMessage({ type: 'fileList', files: [] });
            return;
        }

        const IGNORE_DIRS = new Set([
            'node_modules', '.git', '.cwtools', '__pycache__',
            'bin', 'obj',
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

    private searchWorkspaceFolders(query: string, maxResults: number): string[] {
        const root = getProjectWorkspaceRoot();
        if (!root || maxResults <= 0) return [];

        const q = query.toLowerCase();
        const ignored = new Set(['node_modules', '.git', '.cwtools', '__pycache__', 'bin', 'obj', 'release']);
        const results: string[] = [];
        let visited = 0;
        const walk = (dir: string) => {
            if (results.length >= maxResults || visited > 3000) return;
            visited++;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (results.length >= maxResults || visited > 3000) return;
                if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
                const fullPath = path.join(dir, entry.name);
                const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
                if (entry.name.toLowerCase().includes(q) || relPath.toLowerCase().includes(q)) {
                    results.push(fullPath);
                }
                walk(fullPath);
            }
        };

        walk(root);
        return results.sort((a, b) => a.length - b.length);
    }

    public postMessage(msg: HostMessage): void {
        this.broadcaster.postMessage(msg);
    }

    public postMessageToSurface(surface: 'chat' | 'manager', msg: HostMessage): void {
        this.broadcaster.postMessageToSurface(surface, msg);
    }

    private clearArtifacts(): void {
        this.postMessage({ type: 'artifactList', artifacts: this.artifactStore.clear() });
    }

    private upsertArtifact(artifact: Omit<AgentArtifact, 'createdAt'> & { createdAt?: number }): void {
        this.postMessage({
            type: 'artifactList',
            artifacts: this.artifactStore.upsert(artifact),
        });
    }

    private artifactId(kind: AgentArtifactKind, key: string): string {
        return this.artifactStore.buildId(kind, key);
    }

    private collectArtifactsFromResult(result: import('./types').GenerationResult): void {
        const generationKey = String(Date.now());
        const validationSteps = result.steps.filter(s => s.type === 'validation');
        if (validationSteps.length > 0 || result.validationErrors.length > 0) {
            const errorCount = result.validationErrors.length;
            this.upsertArtifact({
                id: this.artifactId('validation', generationKey),
                kind: 'validation',
                title: errorCount > 0 ? 'Validation Result: issues found' : 'Validation Result: passed',
                summary: errorCount > 0 ? `${errorCount} validation issue(s) remain.` : 'No validation errors reported for this run.',
                status: errorCount > 0 ? 'failed' : 'done',
                data: { validationErrors: result.validationErrors, validationSteps },
            });
        }

        const diagnosticSteps = result.steps.filter(s => s.toolName === 'get_diagnostics' && s.toolResult);
        if (diagnosticSteps.length > 0) {
            this.upsertArtifact({
                id: this.artifactId('diagnostics', generationKey),
                kind: 'diagnostics',
                title: 'Diagnostics Report',
                summary: `${diagnosticSteps.length} get_diagnostics call(s) captured.`,
                status: 'done',
                data: diagnosticSteps.map(s => s.toolResult),
            });
        }

        const mediaSteps = result.steps.filter(s =>
            ['convert_image_to_dds', 'convert_audio', 'deploy_mod_asset'].includes(String(s.toolName))
        );
        if (mediaSteps.length > 0) {
            const files = mediaSteps.flatMap(s => {
                const r = s.toolResult as any;
                if (!r) return [];
                if (Array.isArray(r.files)) return r.files;
                if (r.file) return [r.file];
                if (r.outputFile) return [r.outputFile];
                if (r.destination) return [r.destination];
                return [];
            });
            this.upsertArtifact({
                id: this.artifactId('media', generationKey),
                kind: 'media',
                title: 'Generated Media / Assets',
                summary: files.length > 0 ? `${files.length} generated or deployed asset(s).` : `${mediaSteps.length} media tool call(s) captured.`,
                status: mediaSteps.some(s => (s.toolResult as any)?.success === false) ? 'failed' : 'done',
                data: { files, steps: mediaSteps.map(s => ({ toolName: s.toolName, result: s.toolResult })) },
            });
        }

        const blackboardSteps = result.steps.filter(s =>
            ['set_memory', 'get_memory', 'search_memory', 'query_blackboard', 'merge_results', 'dispatch_agents'].includes(String(s.toolName))
        );
        if (blackboardSteps.length > 0) {
            this.upsertArtifact({
                id: this.artifactId('blackboard', generationKey),
                kind: 'blackboard',
                title: 'Blackboard Summary',
                summary: `${blackboardSteps.length} blackboard/orchestrator coordination step(s).`,
                status: 'done',
                data: blackboardSteps.map(s => ({ toolName: s.toolName, args: s.toolArgs, result: s.toolResult })),
            });
        }
    }

    // ─── HTML Content ────────────────────────────────────────────────────────

    private getHtmlContent(webview: vs.Webview): string {
        return getChatPanelHtml(webview, this.extensionUri);
    }

    private getManagerHtmlContent(webview: vs.Webview): string {
        return getAgentManagerHtml(webview, this.extensionUri);
    }

    public async openAgentManager(): Promise<void> {
        if (this.managerPanel) {
            this.managerPanel.reveal(this.managerPanel.viewColumn ?? vs.ViewColumn.One, false);
            this._syncViewChromeState('manager');
            this.openManagerPanelInNewWindow();
            return;
        }

        const panel = vs.window.createWebviewPanel(
            'cwtools.agentManager',
            'Agent Manager',
            { viewColumn: vs.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri],
            }
        );

        this.managerPanel = panel;
        this._managerDisposables.forEach(d => d.dispose());
        this._managerDisposables = [];
        this.bindWebview(panel.webview, this._managerDisposables, 'manager');

        panel.onDidDispose(() => {
            this.managerPanel = undefined;
            this._managerDisposables.forEach(d => d.dispose());
            this._managerDisposables = [];
        }, this, this._managerDisposables);

        panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.visible) this._syncViewChromeState('manager');
        }, this, this._managerDisposables);

        this._syncViewChromeState('manager');
        this.openManagerPanelInNewWindow();
    }

    private openManagerPanelInNewWindow(): void {
        setTimeout(() => {
            void vs.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(
                undefined,
                () => { /* VS Code versions without floating editor support keep the panel in-place. */ },
            );
        }, 120);
    }

    /** 
* Send the selection reference to the Webview input box 
*/
    public async sendSelectionReference(
        relPath: string,
        startLine: number,
        endLine: number
    ): Promise<void> {
        if (this.managerPanel) {
            this.managerPanel.reveal(this.managerPanel.viewColumn ?? vs.ViewColumn.One, false);
        } else {
            await vs.commands.executeCommand('cwtools.aiChat.focus');
        }
        let attempts = 0;
        while (!this.hasVisibleChatSurface() && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        
        this.postMessage({
            type: 'insertSelectionReference',
            relPath,
            startLine,
            endLine
        });
    }

    private bindWebview(webview: vs.Webview, bucket: vs.Disposable[], surface: 'chat' | 'manager'): void {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webview.html = surface === 'manager'
            ? this.getManagerHtmlContent(webview)
            : this.getHtmlContent(webview);

        webview.onDidReceiveMessage(
            async (msg: WebViewMessage) => {
                if (!msg?.type) return;
                try {
                    await this.handleWebViewMessage(msg, surface);
                } catch (e) {
                    ErrorReporter.warn(SOURCE.CHAT_PANEL, `Error handling webview message '${msg.type}'`, e);
                }
            },
            this,
            bucket
        );
        bucket.push(this.broadcaster.register(webview, surface));

        this.topicManager.sendTopicList();
        this.settingsManager.buildAndSendSettingsData(false, surface).catch(() => { /* ignore on startup */ });
        this._restoreViewState(surface, true);
    }

    private async ensureOrchestratorWalkthrough(result: GenerationResult): Promise<void> {
        const dispatchResults = result.steps
            .filter(s => s.type === 'tool_result' && s.toolName === 'dispatch_agents')
            .map(s => s.toolResult as Record<string, any> | undefined)
            .filter((toolResult): toolResult is Record<string, any> => !!toolResult && Array.isArray(toolResult.agents));
        if (dispatchResults.length > 0) {
            const topicId = this.topicManager.currentTopic?.id || 'default';
            const candidates = getTopicFileCandidates(topicId, 'walkthrough.md', getProjectWorkspaceRoot());
            const wtPath = candidates[0];
            if (wtPath) {
                const runEvents = this.currentRunId
                    ? (runLedger.getSnapshot(this.currentRunId)?.events ?? [])
                    : [];
                const mdContent = this.buildOrchestratorWalkthroughMarkdown(dispatchResults, result, runEvents);
                try {
                    await fs.promises.mkdir(path.dirname(wtPath), { recursive: true });
                    await fs.promises.writeFile(wtPath, mdContent, 'utf-8');
                    this._recordFileSnapshot(wtPath);
                    ErrorReporter.debug(SOURCE.CHAT_PANEL, aiText(
                        `Orchestrator run finished: synthesized walkthrough.md report at ${wtPath}`,
                        `Orchestrator 任务结束：已自动合成并补全 walkthrough.md 报告，路径: ${wtPath}`,
                    ));
                } catch (err) {
                    ErrorReporter.warn(SOURCE.CHAT_PANEL, aiText('Failed to auto-generate orchestrator walkthrough.md', '自动生成 Orchestrator walkthrough.md 失败'), err);
                }
            }
        }
    }

    private collectSubagentFileChangesFromEvents(events: AgentRunEvent[]): Map<string, Set<string>> {
        const filesByAgent = new Map<string, Set<string>>();
        const add = (agentIdValue: unknown, fileValue: unknown) => {
            const file = typeof fileValue === 'string' ? fileValue.trim() : '';
            if (!file) return;
            const agentId = this.shortPlainText(agentIdValue, 100) || 'unknown';
            if (!filesByAgent.has(agentId)) filesByAgent.set(agentId, new Set<string>());
            filesByAgent.get(agentId)!.add(file);
        };

        for (const event of events) {
            const payload = event.payload && typeof event.payload === 'object'
                ? event.payload as Record<string, unknown>
                : {};
            if (event.type === 'subagent_end' && Array.isArray(payload.filesWritten)) {
                const agentId = event.agentId || payload.taskNodeId || payload.agentId;
                for (const file of payload.filesWritten) add(agentId, file);
            } else if (event.type === 'file_change') {
                const agentId = event.agentId || payload.taskNodeId || payload.agentId;
                const source = typeof payload.source === 'string' ? payload.source : '';
                if (!agentId && source !== 'subagent') continue;
                add(agentId || 'unknown', payload.filePath);
            }
        }

        return filesByAgent;
    }

    private buildOrchestratorWalkthroughMarkdown(dispatchResults: Array<Record<string, any>>, result: GenerationResult, runEvents: AgentRunEvent[] = []): string {
        const title = aiText('Multi-Agent Coordination Walkthrough', 'Multi-Agent Coordination Walkthrough (多 Agent 协作全局报告)');
        const topicTitle = this.topicManager.currentTopic?.title || aiText('PDXScript multi-agent coordination task', 'PDXScript 多 Agent 协作任务');
        const topicId = this.topicManager.currentTopic?.id || 'default';
        const workspaceRoot = getProjectWorkspaceRoot();
        const taskLookup = new Map(this.extractDispatchTasks(result).map(task => [task.id, task]));
        const ledgerFileChanges = this.collectSubagentFileChangesFromEvents(runEvents);
        const failedNodes = new Set<string>();
        const cancelledNodes = new Set<string>();
        const changedFiles = new Map<string, { file: string; agentIds: Set<string> }>();
        const recordedAgentFileKeys = new Set<string>();
        const batchSections: string[] = [];
        const agentSections: string[] = [];
        const manifestRows: string[] = [];
        let totalAgents = 0;
        let totalFilesCount = 0;
        let totalTokens = 0;
        let totalCost = 0;

        const stripInternalTruncationMarker = (text: string): string => {
            return text
                .replace(/\n?\s*\.{3}\s*\[truncated, full length:\s*\d+\]\s*$/i, '')
                .replace(/\s*\.{3}\(truncated, full length:\s*\d+\)\s*$/i, '')
                .trimEnd();
        };
        const trimIncompleteMarkdownTail = (text: string): string => {
            let next = text.trimEnd();
            while (/(^|\n)\s*(?:[-*+]\s*|\d+[.)]\s*)$/.test(next)) {
                next = next.replace(/(^|\n)\s*(?:[-*+]\s*|\d+[.)]\s*)$/, '').trimEnd();
            }
            return next;
        };
        const markdownText = (value: unknown, maxLength: number): string => {
            const text = stripInternalTruncationMarker(String(value ?? '')
                .replace(/\r\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim());
            if (!text) return '';
            if (text.length <= maxLength) return text;
            let preview = text.slice(0, maxLength).trimEnd();
            const paragraphBreak = preview.lastIndexOf('\n\n');
            const lineBreak = preview.lastIndexOf('\n');
            if (paragraphBreak > maxLength * 0.55) {
                preview = preview.slice(0, paragraphBreak).trimEnd();
            } else if (lineBreak > maxLength * 0.75) {
                preview = preview.slice(0, lineBreak).trimEnd();
            }
            preview = trimIncompleteMarkdownTail(preview);
            return `${preview}\n\n${aiText(
                `_Content was long and has been compacted automatically: showing the first ${preview.length} / ${text.length} characters._`,
                `_内容较长，已自动压缩：显示前 ${preview.length} / ${text.length} 字符。_`,
            )}`;
        };
        const tableCell = (value: unknown, maxLength = 140): string => {
            const text = this.shortPlainText(value, maxLength).replace(/\|/g, '\\|');
            return text || '-';
        };
        const listValue = (value: unknown, maxLength = 120): string => {
            if (!Array.isArray(value) || value.length === 0) return aiText('none', '无');
            const items = value
                .map(item => this.shortPlainText(item, maxLength))
                .filter(Boolean);
            return items.length > 0 ? items.map(item => `\`${item}\``).join(', ') : aiText('none', '无');
        };
        const fileLink = (file: string): string => {
            const absPath = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
            const relPath = path.relative(workspaceRoot, absPath) || file;
            return `[\`${path.basename(absPath)}\`](file:///${absPath.replace(/\\/g, '/')}) - \`${relPath}\``;
        };
        const recordFile = (agentId: string, file: string): boolean => {
            const absPath = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
            const key = absPath.toLowerCase();
            const agentFileKey = `${agentId}\0${key}`;
            if (recordedAgentFileKeys.has(agentFileKey)) return false;
            recordedAgentFileKeys.add(agentFileKey);
            if (!changedFiles.has(key)) changedFiles.set(key, { file: absPath, agentIds: new Set<string>() });
            changedFiles.get(key)?.agentIds.add(agentId);
            return true;
        };

        dispatchResults.forEach((batch, batchIndex) => {
            const agents = Array.isArray(batch.agents) ? batch.agents : [];
            totalAgents += agents.length;
            totalTokens += Number(batch.totalTokens || 0);
            totalCost += Number(batch.estimatedCostCny || 0);

            for (const id of Array.isArray(batch.failedNodes) ? batch.failedNodes : []) {
                failedNodes.add(String(id));
            }
            for (const id of Array.isArray(batch.cancelledNodes) ? batch.cancelledNodes : []) {
                cancelledNodes.add(String(id));
            }

            if (batch.summary) {
                batchSections.push([
                    `### Batch ${batchIndex + 1}`,
                    '',
                    markdownText(batch.summary, 1200),
                ].join('\n'));
            }

            agents.forEach((agent: any, agentIndex: number) => {
                const id = this.shortPlainText(agent.id, 100) || `agent_${batchIndex + 1}_${agentIndex + 1}`;
                const task = taskLookup.get(id);
                const role = agent.agentType || task?.agentType || 'agent';
                const resultFiles: string[] = Array.isArray(agent.filesWritten)
                    ? agent.filesWritten.filter((file: unknown): file is string => typeof file === 'string' && !!file)
                    : [];
                const ledgerFiles = Array.from(ledgerFileChanges.get(id) ?? []);
                const files = Array.from(new Set([...resultFiles, ...ledgerFiles]));
                const status = agent.success
                    ? aiText('Success', '✅ 成功')
                    : agent.needsClarification
                        ? aiText('Pending', '⚠️ 待决')
                        : agent.error
                            ? aiText('Failed', '❌ 失败')
                            : aiText('Unknown', '未知');
                const resultSummary = agent.success
                    ? (agent.outputSummary || agent.summary || aiText('The sub-agent completed its assigned task but did not return a detailed summary.', '子 Agent 已完成分配任务，但未返回详细摘要。'))
                    : agent.needsClarification
                        ? (agent.clarification || agent.error || aiText('The sub-agent requested a parent-agent decision.', '子 Agent 请求父 Agent 决策。'))
                        : (agent.error || aiText('The sub-agent did not return a successful result.', '子 Agent 未返回成功结果。'));

                for (const file of files) {
                    if (recordFile(id, file)) totalFilesCount++;
                }

                manifestRows.push(`| ${batchIndex + 1} | \`${tableCell(id, 100)}\` | \`${tableCell(role, 60)}\` | ${status} | ${files.length} | ${Number(agent.tokenUsed || 0)} | ${tableCell(resultSummary, 180)} |`);

                const agentLines = [
                    `### Agent ${id} (${role})`,
                    '',
                    `- **Batch**: ${batchIndex + 1}`,
                    aiText(`- **Status**: ${status}`, `- **状态**: ${status}`),
                    aiText(`- **Role / task**: ${markdownText(agent.prompt || task?.prompt, 1200) || 'No task description recorded.'}`, `- **职责/任务**: ${markdownText(agent.prompt || task?.prompt, 1200) || '未记录任务说明。'}`),
                    aiText(`- **Dependencies**: ${listValue(agent.dependencies || task?.dependencies)}`, `- **依赖**: ${listValue(agent.dependencies || task?.dependencies)}`),
                    aiText(`- **Context files**: ${listValue(task?.contextFiles)}`, `- **上下文文件**: ${listValue(task?.contextFiles)}`),
                    aiText(`- **Planned files**: ${listValue(agent.plannedFiles)}`, `- **计划文件**: ${listValue(agent.plannedFiles)}`),
                    aiText(`- **Planned entities**: ${listValue(agent.plannedEntities)}`, `- **计划对象**: ${listValue(agent.plannedEntities)}`),
                    aiText(`- **Step count**: ${Number(agent.stepCount || 0)}`, `- **步骤数**: ${Number(agent.stepCount || 0)}`),
                    aiText(`- **Token usage**: ${Number(agent.tokenUsed || 0)}`, `- **Token 消耗**: ${Number(agent.tokenUsed || 0)}`),
                    '',
                    aiText('#### Sub-Agent Work Summary', '#### 子 Agent 工作总结'),
                    markdownText(resultSummary, 2400) || aiText('No detailed output recorded.', '未记录详细输出。'),
                ];

                if (files.length > 0) {
                    agentLines.push('', aiText('#### File Outputs', '#### 文件产出'));
                    agentLines.push(...files.map(file => `- ${fileLink(file)}`));
                }

                agentSections.push(agentLines.join('\n'));
            });
        });

        for (const [agentId, files] of ledgerFileChanges.entries()) {
            for (const file of files) {
                if (recordFile(agentId, file)) totalFilesCount++;
            }
        }

        const tokenTotal = result.tokenUsage?.total || totalTokens || 0;
        const costTotal = result.tokenUsage?.estimatedCostCny ?? totalCost ?? 0;
        const changedFileLines = Array.from(changedFiles.values()).map(({ file, agentIds }) => {
            const displayPath = agentIds.size > 0
                ? Array.from(agentIds).join(', ')
                : 'unknown';
            return aiText(`- ${fileLink(file)}, source agent: ${displayPath}`, `- ${fileLink(file)}，来源 Agent: ${displayPath}`);
        });

        const lines = [
            `# ${title}`,
            '',
            '> [!NOTE]',
            aiText(
                '> This report was generated by the parent agent after all dispatch_agents batches completed. It summarizes each sub-agent role, execution, output summary, and file changes so the final record does not only reflect the last completed sub-agent.',
                '> 本报告由父级主 Agent 在所有 dispatch_agents 批次完成后统一生成，用于汇总每个子 Agent 的职责、执行过程、产出摘要和文件变更，避免只保留最后一个子 Agent 的结果。',
            ),
            '',
            aiText('## Topic Background', '## 任务背景 (Topic Background)'),
            aiText(`- **Current topic**: ${topicTitle}`, `- **当前主题**: ${topicTitle}`),
            aiText(`- **Dispatch batches**: ${dispatchResults.length}`, `- **调度批次**: ${dispatchResults.length}`),
            aiText(`- **Sub-agents**: ${totalAgents}`, `- **子 Agent 数量**: ${totalAgents}`),
            aiText(`- **Total tokens**: ${tokenTotal}`, `- **总 Token**: ${tokenTotal}`),
            aiText(`- **Estimated cost**: ¥${costTotal.toFixed(4)}`, `- **估算成本**: ¥${costTotal.toFixed(4)}`),
            '',
            aiText('## Parent Agent Global Summary', '## 主 Agent 全局总结 (Parent Agent Global Summary)'),
            markdownText(result.explanation, 1800) || aiText('The parent agent completed multi-agent coordination and generated this walkthrough from the dispatch results.', '父级主 Agent 已完成多 Agent 协调，并基于调度结果生成全局 Walkthrough。'),
            '',
            aiText('## Agent Execution Manifest', '## 协作节点执行列表 (Agent Execution Manifest)'),
            aiText('| Batch | Subtask ID | Role | Status | Changed Files | Token Usage | Result |', '| Batch | 子任务 ID | 角色类型 | 执行状态 | 变更文件数 | Token 消耗 | 结果说明 |'),
            '| :--- | :--- | :--- | :--- | ---: | ---: | :--- |',
            ...(manifestRows.length > 0 ? manifestRows : [aiText('| - | - | - | - | 0 | 0 | No sub-agent result recorded |', '| - | - | - | - | 0 | 0 | 未记录子 Agent 结果 |')]),
            '',
            aiText('## Dispatch Batch Summaries', '## 调度批次总结 (Dispatch Batch Summaries)'),
            batchSections.length > 0 ? batchSections.join('\n\n') : aiText('No batch-level summary recorded.', '未记录批次级摘要。'),
            '',
            aiText('## Per-Agent Work Summaries', '## 每个子 Agent 的工作总结 (Per-Agent Work Summaries)'),
            agentSections.length > 0 ? agentSections.join('\n\n') : aiText('No sub-agent work summary recorded.', '未记录子 Agent 工作总结。'),
            '',
            aiText('## File Changes Summary', '## 文件变更总览 (File Changes Summary)'),
            aiText(
                `This multi-agent run recorded **${totalFilesCount}** file-write event(s), touching **${changedFiles.size}** unique file(s).`,
                `本次多 Agent 协作共记录 **${totalFilesCount}** 个文件写入事件，涉及 **${changedFiles.size}** 个唯一文件。`,
            ),
            '',
            changedFileLines.length > 0 ? changedFileLines.join('\n') : aiText('No sub-agent file changes recorded.', '未记录子 Agent 文件变更。'),
            '',
            aiText('## Verification & Quality Gate', '## 验证与质量把关 (Verification & Quality Gate)'),
            aiText(`- **Failed nodes**: ${failedNodes.size > 0 ? Array.from(failedNodes).map(id => `\`${id}\``).join(', ') : 'none'}`, `- **失败节点**: ${failedNodes.size > 0 ? Array.from(failedNodes).map(id => `\`${id}\``).join(', ') : '无'}`),
            aiText(`- **Cancelled nodes**: ${cancelledNodes.size > 0 ? Array.from(cancelledNodes).map(id => `\`${id}\``).join(', ') : 'none'}`, `- **取消节点**: ${cancelledNodes.size > 0 ? Array.from(cancelledNodes).map(id => `\`${id}\``).join(', ') : '无'}`),
            aiText('- **Parent-agent responsibility**: Review all sub-agent results globally and confirm that the parts form a complete delivery, rather than accepting only the final node summary.', '- **主 Agent 职责**: 以全局视角审查所有子 Agent 结果，确认各部分产出能够组成完整任务交付，而不是只采用最后完成节点的总结。'),
            '',
            '---',
            aiText(
                `*Generated by the Eddy CWTool AI coordinator after multi-agent collaboration and archived at \`.cwtools-ai/${topicId}/walkthrough.md\`.*`,
                `*报告由 Eddy CWTool AI 协调器在多 Agent 协作结束后生成并存档于 \`.cwtools-ai/${topicId}/walkthrough.md\`。*`,
            ),
        ];

        return lines.join('\n');
    }

    private hasVisibleChatSurface(): boolean {
        if (this.view?.visible) return true;
        if (this.managerPanel?.visible) return true;
        return false;
    }
}
