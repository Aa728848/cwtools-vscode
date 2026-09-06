import { Icons, svgIcon, svgIconNoMargin } from './svgIcons';
import type { ProviderMeta } from '../shared/providerMeta';
import { buildAntigravityAccountHtml, isAntigravityAccountStatus, type AntigravityAccountStatus } from './chat/antigravityAccount';
import { isSubscriptionProxyMode, isSubscriptionProxyStatus, type SubscriptionProxyStatus } from '../shared/subscriptionProxy';
import { routeLiveStep, buildToolPairHtml, buildToolGroupHtml, buildLocalisationPromptCardHtml, escapeHtml as mrEscapeHtml, type RendererStep } from './messageRenderer';
import { groupToolCalls } from './chat/toolPhrases';
import {
    escapeHtml as _fmtEscapeHtml,
    formatNum as _fmtFormatNum,
    formatTime as _fmtFormatTime,
    formatDuration as _fmtFormatDuration,
    extractStepFile as _fmtExtractStepFile,
    makeRunSummary as _fmtMakeRunSummary,
    WRITE_TOOL_NAMES as _fmtWriteTools,
    READ_TOOL_NAMES as _fmtReadTools,
    VALIDATION_TOOL_NAMES as _fmtValidationTools,
    ORCHESTRATOR_TOOL_NAMES as _fmtOrchestratorTools,
    type RunSummary as _FmtRunSummary,
} from './chat/formatters';
import {
    artifactFileStatusTone,
    formatArtifactFileDelta,
    formatArtifactFileStatusLabel,
    getDiffArtifactFiles,
    restoreArtifactsFromMessages as restoreArtifactsFromHistory,
    sortArtifactsByNewest,
    type ArtifactFilter,
    type ArtifactRecord,
} from './chat/artifacts';
import { renderArtifactDrawer } from './chat/artifactDrawer';
import { type TopicPanelItem, type TopicPanelStats } from './chat/topics';
import {
    buildLiveProcessMeta,
    buildLiveProcessSummaryHtml,
    buildSubagentCardHtml,
    buildSubagentFullscreenHtml,
    buildSubagentHeaderMetricsHtml,
    buildSubagentMetaHtml,
    buildThinkingSummaryHtml,
    hasVisibleLiveContent,
    latestLiveToolName,
    pushBoundedWebviewLiveStep,
    reactivateSubagentStreamState,
} from './chat/liveSteps';
import {
    applySettingsOverview,
    buildSettingsOverviewModel,
    resolveSettingsModelContextTokens,
} from './chat/settingsOverview';
import { buildCodexQuotaHtml } from './chat/codexQuota';
import {
    renderTopicSearchResults as renderTopicSearchResultsView,
    renderTopics as renderTopicsView,
} from './chat/topicViews';
import { getChatI18n } from './chat/i18n';
import { parseHostMessage } from './chat/hostProtocol';
import {
    buildSlashCommands,
    filterSlashCommands,
    getSlashCommandFilter,
    renderSlashCommandItems,
    type SlashCommandView,
} from './chat/slashCommands';
import { type WorkflowView } from './chat/workflows';
import { createMarkdownRenderer } from './chat/markdown';
import { startMermaidRendering } from './chat/mermaidRenderer';
import { startMessageSelectionActions } from './chat/messageSelectionActions';
import { buildUserMessagePresentation } from './chat/userMessagePresentation';
import { createAnnotationCard, type AnnotationCardOptions } from './chat/annotations';
import { renderAssistantTurnCodex } from './chat/codexConversation';
import {
    CONTEXT_TYPE_META,
    generateContextId,
    mentionResultToActiveContext,
    type ActiveContext,
    type MentionResult,
} from './chat/contextMentions';

interface SideDiffLine {
    type: 'add' | 'remove' | 'context';
    content: string;
    oldLineNo?: number;
    newLineNo?: number;
}

interface SideDiffFile {
    file: string;
    status?: string;
    diffPreview?: string;
    additions?: number;
    deletions?: number;
    diffLines?: SideDiffLine[];
}

interface SideDiffEntry {
    id: string;
    title: string;
    timestamp: number;
    files: SideDiffFile[];
    pending?: { messageId: string; isNewFile: boolean };
    sourceKey?: string;
}

interface SideDiffFocus {
    entryId?: string;
    file?: string;
}

interface AgentSchedulingStateView {
    profileName: string;
    domainProfile: 'paradox' | 'general' | 'hybrid';
    authorization: 'read_only' | 'plan_write_only' | 'workspace_write';
    phase: 'inspect' | 'plan' | 'execute' | 'verify' | 'finalize';
    dispatch: 'single' | 'parallel' | 'specialist';
    overlays: string[];
    routeConfidence: number;
    routeEvidence: string[];
    awaitingUserDecision: boolean;
    routingSource?: 'model' | 'deterministic' | 'workflow' | 'user';
    phaseReason: string;
    dispatchReason?: string;
    revision: number;
}

function parseSchedulingStateView(value: unknown): AgentSchedulingStateView | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    const domainProfile = candidate.domainProfile;
    const authorization = candidate.authorization;
    const phase = candidate.phase;
    const dispatch = candidate.dispatch;
    const profileName = candidate.profileName;
    const overlays = candidate.overlays;
    const routeConfidence = candidate.routeConfidence;
    const routeEvidence = candidate.routeEvidence;
    const phaseReason = candidate.phaseReason;
    const revision = candidate.revision;
    if (domainProfile !== 'paradox' && domainProfile !== 'general' && domainProfile !== 'hybrid') return undefined;
    if (authorization !== 'read_only' && authorization !== 'plan_write_only' && authorization !== 'workspace_write') return undefined;
    if (phase !== 'inspect' && phase !== 'plan' && phase !== 'execute' && phase !== 'verify' && phase !== 'finalize') return undefined;
    if (dispatch !== 'single' && dispatch !== 'parallel' && dispatch !== 'specialist') return undefined;
    if (typeof profileName !== 'string' || !profileName.trim()) return undefined;
    if (!Array.isArray(overlays) || !overlays.every(item => typeof item === 'string')) return undefined;
    if (typeof routeConfidence !== 'number' || !Number.isFinite(routeConfidence)) return undefined;
    if (!Array.isArray(routeEvidence) || !routeEvidence.every(item => typeof item === 'string')) return undefined;
    if (typeof phaseReason !== 'string') return undefined;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return undefined;
    const routingSource = candidate.routingSource;
    return {
        profileName: profileName.slice(0, 100),
        domainProfile,
        authorization,
        phase,
        dispatch,
        overlays: overlays.map(item => item.slice(0, 80)).slice(0, 12),
        routeConfidence: Math.max(0, Math.min(1, routeConfidence)),
        routeEvidence: routeEvidence.map(item => item.slice(0, 240)).slice(0, 4),
        awaitingUserDecision: candidate.awaitingUserDecision === true,
        routingSource: routingSource === 'model' || routingSource === 'deterministic' || routingSource === 'workflow' || routingSource === 'user'
            ? routingSource
            : undefined,
        phaseReason: phaseReason.slice(0, 500),
        dispatchReason: typeof candidate.dispatchReason === 'string' ? candidate.dispatchReason.slice(0, 500) : undefined,
        revision,
    };
}

function renderDiffFileStatusBadge(status?: string, classPrefix: 'ds' | 'side-diff' = 'ds'): string {
    const tone = artifactFileStatusTone(status);
    const label = formatArtifactFileStatusLabel(status);
    return `<span class="${classPrefix}-file-status ${classPrefix}-file-status-${tone}">${_fmtEscapeHtml(label)}</span>`;
}

function renderDiffFileDelta(file: SideDiffFile, classPrefix: 'ds' | 'side-diff' = 'ds'): string {
    const delta = formatArtifactFileDelta(file);
    if (file.additions !== undefined || file.deletions !== undefined) {
        return `<span class="${classPrefix}-file-delta" aria-label="${_fmtEscapeHtml(delta)}">` +
            `<span class="${classPrefix}-file-additions">+${_fmtEscapeHtml(file.additions ?? 0)}</span>` +
            `<span class="${classPrefix}-file-deletions">-${_fmtEscapeHtml(file.deletions ?? 0)}</span>` +
            `</span>`;
    }
    return delta
        ? `<span class="${classPrefix}-file-delta ${classPrefix}-file-delta-preview" title="${_fmtEscapeHtml(delta)}">${_fmtEscapeHtml(delta)}</span>`
        : '';
}

function shouldShowSideDiffPreview(file: SideDiffFile): boolean {
    if (!file.diffPreview) return false;
    if (file.additions === undefined && file.deletions === undefined) return true;
    return /truncated|too large|could not|store|read/i.test(file.diffPreview);
}

function normalizeDiffFilePath(file: string): string {
    return (file || '').replace(/\\/g, '/').trim().toLowerCase();
}

function mergeSideDiffFiles(files: SideDiffFile[]): SideDiffFile[] {
    const merged = new Map<string, SideDiffFile>();
    const order: string[] = [];
    for (const file of files) {
        const key = normalizeDiffFilePath(file.file);
        if (!key) continue;
        const previous = merged.get(key);
        if (!previous) order.push(key);
        merged.set(key, {
            ...cloneSideDiffFile(file),
            status: previous?.status === 'created' || file.status === 'created'
                ? 'created'
                : file.status || previous?.status,
        });
    }
    return order.map(key => merged.get(key)!).filter(Boolean);
}

interface UserMessageInputPayload {
    text: string;
    images?: string[];
    contexts?: ActiveContext[];
    attachedFiles?: string[];
}

interface ResponsiveWorkspacePanel {
    kind: 'plan' | 'walkthrough' | 'blueprint';
    title: string;
    subtitle?: string;
    content: HTMLElement;
    wide?: boolean;
    sourceKey?: string;
    signature?: string;
    annotationOptions?: AnnotationCardOptions;
}

function cloneSideDiffLines(lines?: SideDiffLine[]): SideDiffLine[] | undefined {
    if (!lines || lines.length === 0) return undefined;
    return lines.map(line => ({
        type: line.type,
        content: line.content,
        ...(line.oldLineNo != null ? { oldLineNo: line.oldLineNo } : {}),
        ...(line.newLineNo != null ? { newLineNo: line.newLineNo } : {}),
    }));
}

function cloneSideDiffFile(file: SideDiffFile): SideDiffFile {
    return {
        file: file.file,
        status: file.status,
        diffPreview: file.diffPreview,
        additions: file.additions,
        deletions: file.deletions,
        diffLines: cloneSideDiffLines(file.diffLines),
    };
}

function cloneSideDiffEntry(entry: SideDiffEntry): SideDiffEntry {
    return {
        id: entry.id,
        title: entry.title,
        timestamp: entry.timestamp,
        files: entry.files.map(cloneSideDiffFile),
        ...(entry.pending ? { pending: { ...entry.pending } } : {}),
        ...(entry.sourceKey ? { sourceKey: entry.sourceKey } : {}),
    };
}

(function () {
    const chatI18n = getChatI18n(document.documentElement.lang || navigator.language);
    const renderMarkdown = createMarkdownRenderer(chatI18n.markdown);
    const uiText = chatI18n.locale === 'zh-cn'
        ? {
            workspace: '工作区',
            workspaceEmptyTitle: '暂无工作区内容',
            workspaceEmptyText: '当前没有文件变更、计划或批注需要展示。等本轮产生可跟踪内容后，这里会自动显示详情。',
            workspaceSubtitle: '计划、批注和文件变更会显示在这里',
            fileChanges: '文件变更',
            changeOverview: '变更概览',
            thisChange: '本次变更',
            changeRecord: '变更记录',
            changesCount: '次变更',
            filesCount: '个文件',
            previewLines: '行预览',
            noInlineDiff: '没有可内联显示的差异。',
            noFileChanges: '暂无文件变更',
            scratchEmpty: '暂无 Scratch 文件',
            scratchHint: 'Agent 创建的临时脚本和文件会显示在这里',
            artifactsEmpty: '暂无产物',
            artifactsHint: '计划、验证和文件变更产物会显示在这里',
            changesTab: '变更',
            filesTab: '文件',
            artifactsTab: '产物',
            accept: '接受',
            reject: '拒绝',
        }
        : {
            workspace: 'Workspace',
            workspaceEmptyTitle: 'No workspace content yet',
            workspaceEmptyText: 'There are no file changes, plans, or annotations to show yet. Trackable content will appear here automatically.',
            workspaceSubtitle: 'Plans, annotations, and file changes appear here',
            fileChanges: 'File Changes',
            changeOverview: 'Change Overview',
            thisChange: 'This Change',
            changeRecord: 'Change Record',
            changesCount: 'changes',
            filesCount: 'files',
            previewLines: 'preview lines',
            noInlineDiff: 'No inline diff is available.',
            noFileChanges: 'No file changes yet',
            scratchEmpty: 'No scratch files yet',
            scratchHint: 'Temporary scripts and files created by the agent will appear here',
            artifactsEmpty: 'No artifacts yet',
            artifactsHint: 'Plans, validation, and file-change artifacts will appear here',
            changesTab: 'Changes',
            filesTab: 'Files',
            artifactsTab: 'Artifacts',
            accept: 'Accept',
            reject: 'Reject',
        };
    const tr = (en: string, zh: string) => chatI18n.locale === 'zh-cn' ? zh : en;
    const vscode = acquireVsCodeApi();
    (window as any).__cwtoolsVscode = vscode;
    const chatArea = document.getElementById('chatArea') as HTMLDivElement;
    startMermaidRendering(document.body);
    const input = document.getElementById('input') as HTMLDivElement;
    const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
    const emptyState = document.getElementById('emptyState') as HTMLDivElement;
    const topicsPanel = document.getElementById('topicsPanel') as HTMLDivElement;
    const settingsPage = document.getElementById('settingsPage') as HTMLDivElement;
    const settingsTabs = Array.from(settingsPage.querySelectorAll<HTMLButtonElement>('[data-settings-tab]'));
    const settingsBody = settingsPage.querySelector<HTMLElement>('.settings-body');
    let activeSettingsTab = 'models';
    const settingsTabScroll: Record<string, number> = {};
    let settingsFormBaseline: string | null = null;
    let settingsSavePending = false;
    let settingsModelInputTimer: ReturnType<typeof setTimeout> | undefined;
    const chatHeader = document.querySelector('.header') as HTMLElement;
    const inputWrapper = document.querySelector('.input-wrapper') as HTMLElement;
    const todoPanel = document.getElementById('todoPanel') as HTMLDivElement;
    const sideWorkspace = document.getElementById('sideWorkspace') as HTMLElement | null;
    const sideWorkspaceBody = document.getElementById('sideWorkspaceBody') as HTMLElement | null;
    const sideWorkspaceTitle = document.getElementById('sideWorkspaceTitle') as HTMLElement | null;
    const sideWorkspaceSubtitle = document.getElementById('sideWorkspaceSubtitle') as HTMLElement | null;

    type TodoView = { id?: string; content: string; status: 'pending' | 'in_progress' | 'done' };
    const subagentTodos = new Map<string, TodoView[]>();

    let isGenerating = false;
    let currentAssistantDiv: HTMLDivElement | null = null;
    type SchedulingDomain = AgentSchedulingStateView['domainProfile'];
    let schedulingState: AgentSchedulingStateView = {
        profileName: 'paradox-agent',
        domainProfile: 'paradox',
        authorization: 'workspace_write',
        phase: 'execute',
        dispatch: 'single',
        overlays: [],
        routeConfidence: 1,
        routeEvidence: [],
        awaitingUserDecision: false,
        phaseReason: 'Initial host state pending.',
        revision: 0,
    };

    function applySchedulingState(value: unknown): void {
        const parsed = parseSchedulingStateView(value);
        if (!parsed) return;
        schedulingState = parsed;
        applyComposerDomainLabels();
        renderComposerChips();
        const trigger = document.getElementById('quickDomainTrigger');
        if (trigger) trigger.title = tr(`Capability domain: ${getSchedulingDomainSummary()}`, `能力领域：${getSchedulingDomainSummary()}`);
    }
    const messageIndexMap = new Map<number, HTMLDivElement>();
    const userMessagePayloadMap = new Map<number, UserMessageInputPayload>();
    let settingsProviders: any[] = [];
    let settingsOllamaModels: any[] = [];
    let settingsCodexAccount: any = undefined;
    let settingsAntigravityAccount: AntigravityAccountStatus | undefined;
    let settingsSubscriptionProxy: SubscriptionProxyStatus | undefined;
    let cachedSettingsData: { providers: any[]; current: any; ollamaModels: any[] } | undefined;
    type ReasoningEffortValue = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    type ReasoningCapabilityView = {
        kind: 'none' | 'fixed' | 'toggle' | 'budget' | 'effort';
        options: ReasoningEffortValue[];
        defaultValue: ReasoningEffortValue;
    };
    let settingsReasoningCapabilities: Record<string, ReasoningCapabilityView> = {};
    // Per-provider endpoint overrides shown in the settings UI, keyed by provider id.
    // Lets us swap the endpoint field when switching providers without leaking values.
    let settingsProviderEndpoints: Record<string, string> = {};

    // Custom absolute positioned dropdown logic
    const apDropdownBindings = new WeakMap<HTMLInputElement, { getOptions: () => string[]; onSelect?: (val: string) => void }>();

    function setupApDropdown(inputId: string, dropdownId: string, getOptions: () => string[], onSelect?: (val: string) => void) {
        const input = document.getElementById(inputId) as HTMLInputElement | null;
        const dropdown = document.getElementById(dropdownId) as HTMLDivElement | null;
        if (!input || !dropdown) return;
        apDropdownBindings.set(input, { getOptions, onSelect });
        if (input.dataset.apDropdownBound === 'true') return;
        input.dataset.apDropdownBound = 'true';

        function render(filter: string) {
            const term = (filter || '').toLowerCase();
            const binding = apDropdownBindings.get(input!);
            const opts = binding?.getOptions() || [];
            const html = opts.filter((m: string) => m.toLowerCase().includes(term))
                .map((m: string) => '<div class="ap-dropdown-item">' + escapeHtml(m) + '</div>').join('');
            dropdown!.innerHTML = html;
            Array.from(dropdown!.children).forEach(el => {
                (el as HTMLElement).onmousedown = (e: MouseEvent) => {
                    e.preventDefault();
                    input!.value = el.textContent || '';
                    dropdown!.style.display = 'none';
                    binding?.onSelect?.(input!.value);
                };
            });
        }

        input.addEventListener('focus', () => { render(input.value); dropdown.style.display = 'block'; });
        input.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, 150); });
        input.addEventListener('input_ap', () => { render(input.value); });
        input.addEventListener('input', () => { render(input.value); });
    }

    /** Per-model context window sizes received from backend — used to auto-fill settingsCtx */
    let settingsModelContextTokens: Record<string, number> = {};
    /** Thinking model prefixes — these models are excluded from inline completion selectors */
    let settingsThinkingPrefixes: string[] = [];
    let currentTopicId: string | null = null;
    let currentTopicTitle = '';
    let totalConversationTokens = 0;
    let lastKnownContextTokens = 0;
    let contextLimit = 128000;
    /** Pending images (base64 data URLs) to attach to next sent message */
    let pendingImages: string[] = [];
    /** Pending files to attach */
    let pendingFiles: string[] = [];
    /** Pending structured references to attach to the next sent message */
    let activeContexts: ActiveContext[] = [];
    type ComposerPayload = UserMessageInputPayload;
    type AgentActivityView = {
        id: string;
        kind: string;
        label: string;
        status: string;
        startedAt?: number;
        endedAt?: number;
        detail?: string;
    };
    type QueuedComposerInput = ComposerPayload & {
        id: string;
        createdAt: number;
    };
    const queuedComposerInputs: QueuedComposerInput[] = [];
    let currentGoalActivity: AgentActivityView | null = null;
    let goalRunArea: HTMLElement | null = null;
    let queuedPromptArea: HTMLElement | null = null;
    let queuedPromptDispatchTimer: ReturnType<typeof setTimeout> | null = null;
    let queuedPromptDispatchAfterCompletion = false;
    let inlineEditSession: {
        messageIndex: number;
        container: HTMLElement;
        bubble: HTMLElement;
        actions: HTMLElement | null;
    } | null = null;
    let savedInputRange: Range | null = null;
    /** Currently active contenteditable element (main input or inline editor) */
    let activeComposerEl: HTMLElement = input;
    let artifacts: ArtifactRecord[] = [];
    let artifactFilter: ArtifactFilter = 'all';
    let workflows: WorkflowView[] = [];
    let slashCommandCatalog: SlashCommandView[] = [];
    let activeWorkflowId: string | null = null;
    let quickModelOptions: string[] = [];
    let quickModelCurrent = '';
    let quickReasoningEffort: ReasoningEffortValue = 'high';
    let quickWriteMode: 'confirm' | 'auto' | 'auto_review' | 'full' = 'auto';
    let fullAccessArmedUntil = 0;
    /** Last known host-side cwtools.ai.developer.disableSecuritySandbox value (the 'full' tier). */
    let settingsSandboxDisabled = false;
    let sideWorkspaceContent: HTMLElement | null = null;
    let settingsInSideWorkspace = false;
    let lastSettingsPageSignature = '';
    let sideDiffEntrySeq = 0;
    const sideDiffEntries: SideDiffEntry[] = [];
    const responsiveWorkspacePanelCache = new Map<string, ResponsiveWorkspacePanel>();
    /** Files modified by Agent that the user has not yet viewed in the diff panel. */
    const unseenDiffFiles = new Set<string>();
    const originalParents = new Map<HTMLElement, { parent: Node; nextSibling: ChildNode | null }>();
    let activeResponsiveWorkspace: ResponsiveWorkspacePanel | null = null;
    let responsiveWorkspacePinnedClosed = false;
    let responsiveWorkspaceLayoutPending = false;
    let wasWideWorkspace = shouldUseSideWorkspace();
    
    function hasConversationContent(): boolean {
        return Array.from(chatArea.children).some(child => child !== emptyState && !(child as HTMLElement).classList.contains('empty-state'));
    }

    function setChatEmptyState(isEmpty = !hasConversationContent()) {
        const changed = document.body.classList.contains('chat-empty') !== isEmpty;
        document.body.classList.toggle('chat-empty', isEmpty);
        chatArea.classList.toggle('is-empty', isEmpty);
        if (changed) requestAnimationFrame(updateComposerStackHeight);
    }

    const chatContentObserver = new MutationObserver(() => setChatEmptyState());
    chatContentObserver.observe(chatArea, { childList: true });
    setChatEmptyState();

    let lastComposerStackHeight = 0;
    let composerStackScrollSyncPending = false;

    function scheduleComposerScrollSync() {
        if (composerStackScrollSyncPending) return;
        composerStackScrollSyncPending = true;
        requestAnimationFrame(() => {
            composerStackScrollSyncPending = false;
            if (!document.body.classList.contains('chat-empty')) {
                scrollBottom();
            }
        });
    }

    function updateComposerStackHeight() {
        if (!inputWrapper) return;
        const rect = inputWrapper.getBoundingClientRect();
        const height = Math.ceil(rect.height);
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const popupGap = 12;
        document.documentElement.style.setProperty('--composer-stack-height', `${height}px`);
        document.documentElement.style.setProperty('--composer-popup-top', `${Math.ceil(rect.bottom + popupGap)}px`);
        document.documentElement.style.setProperty('--composer-popup-bottom', `${Math.max(12, Math.ceil(viewportHeight - rect.top + popupGap))}px`);
        if (Math.abs(height - lastComposerStackHeight) > 1) {
            lastComposerStackHeight = height;
            scheduleComposerScrollSync();
        }
    }

    const composerResizeObserver = new ResizeObserver(updateComposerStackHeight);
    if (inputWrapper) composerResizeObserver.observe(inputWrapper);
    window.addEventListener('resize', updateComposerStackHeight);
    window.addEventListener('resize', positionComposerMenus);
    window.addEventListener('resize', updateManagerTopicsToggleState);
    window.addEventListener('focus', removeReplayBanners);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) removeReplayBanners();
    });
    updateComposerStackHeight();

    function currentViewportWidth(): number {
        return document.documentElement.clientWidth || document.body?.clientWidth || window.innerWidth;
    }

    function shouldUseSideWorkspace(): boolean {
        return currentViewportWidth() >= 1180;
    }

    function isManagerShell(): boolean {
        return document.body.classList.contains('agent-manager-shell');
    }

    function isCurrentSurface(targetSurface?: 'chat' | 'manager'): boolean {
        if (!targetSurface) return true;
        return targetSurface === (isManagerShell() ? 'manager' : 'chat');
    }

    function removeReplayBanners(): void {
        document.querySelectorAll('.replay-steps-banner').forEach(el => el.remove());
    }

    function isManagerTopicsRailMode(): boolean {
        return isManagerShell() && currentViewportWidth() >= 980;
    }

    function updateManagerTopicsToggleState(): void {
        if (!isManagerShell()) return;
        const button = document.getElementById('btnTopics') as HTMLButtonElement | null;
        if (!button) return;
        const collapsed = document.body.classList.contains('manager-topics-collapsed');
        const railVisible = isManagerTopicsRailMode() && !collapsed;
        button.classList.toggle('active', railVisible);
        button.setAttribute('aria-pressed', railVisible ? 'true' : 'false');
        button.title = collapsed ? tr('Expand topic rail', '展开话题栏') : tr('Close topic rail', '关闭话题栏');
        button.setAttribute('aria-label', collapsed ? tr('Expand topic rail', '展开话题栏') : tr('Close topic rail', '关闭话题栏'));
        if (isManagerTopicsRailMode()) {
            topicsPanel.classList.remove('show');
            if (sideWorkspaceContent === topicsPanel) closeSideWorkspace();
        }
    }

    function updateWorkspaceToggleState(): void {
        const toggle = document.getElementById('btnWorkspace');
        if (!toggle) return;
        const hasWorkspaceItems = sideDiffEntries.length > 0 || !!activeResponsiveWorkspace;
        const isWorkspacePanelOpen = document.body.classList.contains('side-workspace-open')
            && !!sideWorkspaceContent
            && sideWorkspaceContent !== settingsPage
            && sideWorkspaceContent !== topicsPanel;
        toggle.classList.toggle('active', isWorkspacePanelOpen);
        toggle.classList.toggle('has-workspace-items', hasWorkspaceItems);
        toggle.setAttribute('aria-pressed', isWorkspacePanelOpen ? 'true' : 'false');
        const visible = shouldUseSideWorkspace();
        toggle.style.display = visible ? 'inline-flex' : '';
        toggle.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }

    function createWorkspaceHomeView(): HTMLElement {
        const view = document.createElement('div');
        view.className = 'workspace-empty';
        view.innerHTML = `
            <div class="workspace-empty-title">${svgIconNoMargin('folder')} ${escapeHtml(uiText.workspaceEmptyTitle)}</div>
            <div class="workspace-empty-text">${escapeHtml(uiText.workspaceEmptyText)}</div>
        `;
        return view;
    }

    function rememberOriginalParent(element: HTMLElement): void {
        if (!originalParents.has(element) && element.parentNode) {
            originalParents.set(element, { parent: element.parentNode, nextSibling: element.nextSibling });
        }
    }

    function restoreOriginalParent(element: HTMLElement): void {
        const original = originalParents.get(element);
        if (!original) return;
        if (element.parentNode === original.parent) return;
        const anchor = original.nextSibling && original.nextSibling.parentNode === original.parent
            ? original.nextSibling
            : null;
        original.parent.insertBefore(element, anchor);
    }

    function detachSideWorkspaceContent(): void {
        if (!sideWorkspaceContent) return;
        hideDetachedWorkspaceContent(sideWorkspaceContent);
        restoreOriginalParent(sideWorkspaceContent);
        sideWorkspaceContent = null;
    }

    function clearSideWorkspaceShell(): void {
        document.body.classList.remove('side-workspace-open');
        document.body.classList.remove('side-workspace-wide');
        sideWorkspace?.setAttribute('aria-hidden', 'true');
        if (sideWorkspaceTitle) sideWorkspaceTitle.textContent = uiText.workspace;
        if (sideWorkspaceSubtitle) sideWorkspaceSubtitle.textContent = '';
        if (sideWorkspaceBody) sideWorkspaceBody.innerHTML = '';
        updateWorkspaceToggleState();
    }

    function hideDetachedWorkspaceContent(content: HTMLElement): void {
        if (content === topicsPanel) {
            topicsPanel.classList.remove('show');
            return;
        }
        if (content === settingsPage) {
            settingsInSideWorkspace = false;
            settingsPage.classList.remove('active');
            chatHeader.style.display = '';
            document.getElementById('chatArea')!.style.display = 'flex';
            if (inputWrapper) inputWrapper.style.display = '';
            if (todoPanel) todoPanel.style.display = '';
        }
    }

    function closeSideWorkspace(options: { preserveResponsivePin?: boolean } = {}): void {
        if (!options.preserveResponsivePin
            && shouldUseSideWorkspace()
            && activeResponsiveWorkspace?.content === sideWorkspaceContent) {
            responsiveWorkspacePinnedClosed = true;
        }
        detachSideWorkspaceContent();
        clearSideWorkspaceShell();
        hideSwTabs();
    }

    function clearTopicWorkspaceState(): void {
        const responsiveContent = activeResponsiveWorkspace?.content || null;
        sideDiffEntries.length = 0;
        responsiveWorkspacePanelCache.clear();
        responsiveWorkspacePinnedClosed = false;

        if (sideWorkspaceContent && sideWorkspaceContent !== settingsPage && sideWorkspaceContent !== topicsPanel) {
            closeSideWorkspace({ preserveResponsivePin: true });
        }

        if (responsiveContent) {
            if (responsiveContent.parentNode) {
                responsiveContent.remove();
            }
            originalParents.delete(responsiveContent);
        }

        activeResponsiveWorkspace = null;
        updateWorkspaceToggleState();
    }

    function openSideWorkspace(options: { title: string; subtitle?: string; content?: HTMLElement; build?: () => HTMLElement; wide?: boolean; kind?: string; sourceKey?: string }): HTMLElement | null {
        if (!sideWorkspace || !sideWorkspaceBody) return null;
        let content = options.content || null;
        if (!content && options.build) content = options.build();
        if (!content) return null;
        if (isManagerShell() && content !== topicsPanel) {
            if (sideWorkspaceContent && sideWorkspaceContent !== content) {
                detachSideWorkspaceContent();
            }
            if (sideWorkspaceContent !== content) {
                rememberOriginalParent(content);
                sideWorkspaceContent = content;
            }
            const kind = content === settingsPage ? 'settings' : (options.kind || 'workspace');
            const detail = {
                kind,
                sourceKey: options.sourceKey || kind,
                title: options.title,
                subtitle: options.subtitle || '',
                content,
                wide: !!options.wide,
            };
            (window as any).__cwtoolsPendingManagerWorkspaceContent = detail;
            window.dispatchEvent(new CustomEvent('agent-manager-workspace-content', { detail }));
            document.body.classList.remove('side-workspace-open', 'side-workspace-wide');
            sideWorkspace.setAttribute('aria-hidden', 'true');
            updateWorkspaceToggleState();
            return content;
        }
        if (document.body.classList.contains('artifact-drawer-open')) setArtifactDrawerOpen(false);
        if (sideWorkspaceContent && sideWorkspaceContent !== content) {
            detachSideWorkspaceContent();
        }
        if (sideWorkspaceContent !== content) {
            sideWorkspaceBody.innerHTML = '';
            rememberOriginalParent(content);
            sideWorkspaceBody.appendChild(content);
            sideWorkspaceContent = content;
        }
        if (sideWorkspaceTitle) sideWorkspaceTitle.textContent = options.title;
        if (sideWorkspaceSubtitle) sideWorkspaceSubtitle.textContent = options.subtitle || '';
        document.body.classList.add('side-workspace-open');
        document.body.classList.toggle('side-workspace-wide', !!options.wide);
        sideWorkspace.setAttribute('aria-hidden', 'false');
        updateComposerStackHeight();
        updateWorkspaceToggleState();
        return content;
    }

    function forgetResponsiveWorkspaceContent(content: HTMLElement): void {
        if (activeResponsiveWorkspace?.content === content) {
            activeResponsiveWorkspace = null;
            responsiveWorkspacePinnedClosed = false;
        }
        if (sideWorkspaceContent === content) {
            sideWorkspaceContent = null;
            clearSideWorkspaceShell();
        }
        originalParents.delete(content);
        updateWorkspaceToggleState();
    }

    function showResponsiveWorkspacePanel(panel: ResponsiveWorkspacePanel): void {
        activeResponsiveWorkspace = panel;
        responsiveWorkspacePinnedClosed = false;

        if (isManagerShell() || shouldUseSideWorkspace()) {
            openSideWorkspace({
                title: panel.title,
                subtitle: panel.subtitle,
                content: panel.content,
                wide: panel.wide,
                kind: panel.kind,
                sourceKey: panel.sourceKey || panel.kind,
            });
        } else {
            if (sideWorkspaceContent === panel.content) {
                closeSideWorkspace({ preserveResponsivePin: true });
            }
            if (panel.content.parentNode !== chatArea) {
                chatArea.appendChild(panel.content);
            }
            scrollBottom();
        }
        setChatEmptyState();
        updateWorkspaceToggleState();
    }

    function showAnnotationWorkspacePanel(panel: ResponsiveWorkspacePanel): void {
        const sourceKey = panel.sourceKey || panel.kind;
        const cached = responsiveWorkspacePanelCache.get(sourceKey);
        if (cached && cached.signature === panel.signature) {
            showResponsiveWorkspacePanel(cached);
            return;
        }
        if (cached) {
            const updater = (cached.content as HTMLElement & { __cwtoolsUpdateAnnotationCard?: (nextPanel: any) => void }).__cwtoolsUpdateAnnotationCard;
            if (typeof updater === 'function' && panel.annotationOptions) {
                updater(panel.annotationOptions);
            } else {
                cached.content.className = panel.content.className;
                cached.content.replaceChildren(...Array.from(panel.content.childNodes));
            }
            const header = cached.content.querySelector<HTMLElement>('.ap-header');
            if (header && isManagerShell()) {
                header.tabIndex = 0;
                header.setAttribute('role', 'button');
                header.setAttribute('aria-expanded', cached.content.classList.contains('ap-compact') ? 'false' : 'true');
            }
            const nextPanel = {
                ...panel,
                content: cached.content,
                sourceKey,
            };
            responsiveWorkspacePanelCache.set(sourceKey, nextPanel);
            showResponsiveWorkspacePanel(nextPanel);
            return;
        }
        const nextPanel = { ...panel, sourceKey };
        responsiveWorkspacePanelCache.set(sourceKey, nextPanel);
        showResponsiveWorkspacePanel(nextPanel);
    }

    function scheduleResponsiveWorkspaceLayoutSync(): void {
        if (responsiveWorkspaceLayoutPending) return;
        responsiveWorkspaceLayoutPending = true;
        requestAnimationFrame(() => {
            responsiveWorkspaceLayoutPending = false;
            syncResponsiveWorkspaceLayout();
            updateComposerStackHeight();
            positionComposerMenus();
        });
    }

    function syncResponsiveWorkspaceLayout(): void {
        const isWide = isManagerShell() || shouldUseSideWorkspace();
        if (isWide !== wasWideWorkspace) {
            responsiveWorkspacePinnedClosed = false;
            wasWideWorkspace = isWide;
        }

        if (activeResponsiveWorkspace) {
            const panel = activeResponsiveWorkspace;
            if (isWide && !responsiveWorkspacePinnedClosed) {
                openSideWorkspace({
                    title: panel.title,
                    subtitle: panel.subtitle,
                    content: panel.content,
                    wide: panel.wide,
                    kind: panel.kind,
                    sourceKey: panel.sourceKey || panel.kind,
                });
            } else if (!isWide) {
                if (sideWorkspaceContent === panel.content) {
                    closeSideWorkspace({ preserveResponsivePin: true });
                }
                if (panel.content.parentNode !== chatArea) {
                    chatArea.appendChild(panel.content);
                    scrollBottom();
                }
            }
        }

        if (!isWide && document.body.classList.contains('side-workspace-open')) {
            closeSideWorkspace({ preserveResponsivePin: true });
        }
        updateWorkspaceToggleState();
    }

    function openWorkspaceFromButton(): void {
        if (!isManagerShell() && !shouldUseSideWorkspace()) return;
        if (document.body.classList.contains('side-workspace-open')) {
            const isNonWorkspacePanel = sideWorkspaceContent === settingsPage || sideWorkspaceContent === topicsPanel;
            if (isNonWorkspacePanel) {
                responsiveWorkspacePinnedClosed = false;
                if (activeResponsiveWorkspace) {
                    openSideWorkspace({
                        title: activeResponsiveWorkspace.title,
                        subtitle: activeResponsiveWorkspace.subtitle,
                        content: activeResponsiveWorkspace.content,
                        wide: activeResponsiveWorkspace.wide,
                        kind: activeResponsiveWorkspace.kind,
                        sourceKey: activeResponsiveWorkspace.sourceKey || activeResponsiveWorkspace.kind,
                    });
                    return;
                }
                if (sideDiffEntries.length > 0) {
                    showSideDiffWorkspace();
                    return;
                }
                openSideWorkspace({
                    title: uiText.workspace,
                    subtitle: uiText.workspaceSubtitle,
                    build: createWorkspaceHomeView,
                });
                showSwTabs('changes');
                return;
            }
            if (activeResponsiveWorkspace && sideWorkspaceContent !== activeResponsiveWorkspace.content) {
                responsiveWorkspacePinnedClosed = false;
                openSideWorkspace({
                    title: activeResponsiveWorkspace.title,
                    subtitle: activeResponsiveWorkspace.subtitle,
                    content: activeResponsiveWorkspace.content,
                    wide: activeResponsiveWorkspace.wide,
                    kind: activeResponsiveWorkspace.kind,
                    sourceKey: activeResponsiveWorkspace.sourceKey || activeResponsiveWorkspace.kind,
                });
                return;
            }
            if (!activeResponsiveWorkspace && sideDiffEntries.length > 0 && !sideWorkspaceContent?.classList.contains('side-diff-view')) {
                showSideDiffWorkspace();
                return;
            }
            closeSideWorkspace();
            return;
        }

        responsiveWorkspacePinnedClosed = false;
        setArtifactDrawerOpen(false);
        if (activeResponsiveWorkspace) {
            openSideWorkspace({
                title: activeResponsiveWorkspace.title,
                subtitle: activeResponsiveWorkspace.subtitle,
                content: activeResponsiveWorkspace.content,
                wide: activeResponsiveWorkspace.wide,
                kind: activeResponsiveWorkspace.kind,
                sourceKey: activeResponsiveWorkspace.sourceKey || activeResponsiveWorkspace.kind,
            });
            return;
        }
        if (sideDiffEntries.length > 0) {
            showSideDiffWorkspace();
            return;
        }
        openSideWorkspace({
            title: uiText.workspace,
            subtitle: uiText.workspaceSubtitle,
            build: createWorkspaceHomeView,
        });
        showSwTabs('changes');
    }

    function fileBaseNameLocal(file: string): string {
        return (file || '').replace(/\\/g, '/').split('/').pop() || file;
    }

    function renderDiffTable(lines: SideDiffLine[] | undefined): string {
        if (!lines || lines.length === 0) {
            return `<div class="side-diff-empty">${escapeHtml(uiText.noInlineDiff)}</div>`;
        }
        let html = '<table class="ds-diff-table"><tbody>';
        for (const line of lines) {
            const cls = line.type === 'add' ? 'ds-line-add' : line.type === 'remove' ? 'ds-line-del' : 'ds-line-ctx';
            const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
            const oldNo = line.oldLineNo != null ? String(line.oldLineNo) : '';
            const newNo = line.newLineNo != null ? String(line.newLineNo) : '';
            html += `<tr class="${cls}">
                <td class="ds-ln">${oldNo}</td>
                <td class="ds-ln">${newNo}</td>
                <td class="ds-prefix">${prefix}</td>
                <td class="ds-code">${escapeHtml(line.content)}</td>
            </tr>`;
        }
        return html + '</tbody></table>';
    }

    function getSideDiffTotals(files: SideDiffFile[]): { additions: number; deletions: number; lineCount: number } {
        return files.reduce((totals, file) => {
            totals.additions += file.additions || 0;
            totals.deletions += file.deletions || 0;
            totals.lineCount += file.diffLines?.length || 0;
            return totals;
        }, { additions: 0, deletions: 0, lineCount: 0 });
    }

    function createSideDiffEntry(
        files: SideDiffFile[],
        title: string,
        pending?: { messageId: string; isNewFile: boolean },
        sourceKey?: string,
    ): SideDiffEntry {
        return {
            id: `diff-${Date.now()}-${++sideDiffEntrySeq}`,
            title,
            timestamp: Date.now(),
            files: files.map(cloneSideDiffFile),
            pending,
            sourceKey,
        };
    }

    function normalizeSideDiffFilePath(file: string): string {
        return normalizeDiffFilePath(file);
    }

    function removeSideDiffFilesFromExisting(files: SideDiffFile[], sourceKey?: string): void {
        const fileKeys = new Set(files.map(file => normalizeSideDiffFilePath(file.file)).filter(Boolean));
        if (fileKeys.size === 0) return;
        for (let index = sideDiffEntries.length - 1; index >= 0; index--) {
            const entry = sideDiffEntries[index]!;
            if (entry.pending || entry.sourceKey === sourceKey) continue;
            const nextFiles = entry.files.filter(file => !fileKeys.has(normalizeSideDiffFilePath(file.file)));
            if (nextFiles.length === entry.files.length) continue;
            if (nextFiles.length === 0) {
                sideDiffEntries.splice(index, 1);
            } else {
                entry.files = nextFiles;
            }
        }
    }

    function removeDuplicateDiffSummaryFiles(files: SideDiffFile[], sourceKey?: string): void {
        const fileKeys = new Set(files.map(file => normalizeSideDiffFilePath(file.file)).filter(Boolean));
        if (fileKeys.size === 0) return;
        document.querySelectorAll<HTMLElement>('.diff-summary-card').forEach(card => {
            if (sourceKey && card.dataset.diffSummaryId === sourceKey) return;
            let removed = false;
            card.querySelectorAll<HTMLElement>('.ds-file').forEach(fileEl => {
                const key = fileEl.dataset.diffFile || '';
                if (fileKeys.has(key)) {
                    fileEl.remove();
                    removed = true;
                }
            });
            if (!card.querySelector('.ds-file')) card.remove();
            else if (removed) {
                const remaining = Array.from(card.querySelectorAll<HTMLElement>('.ds-file'));
                const additions = remaining.reduce((sum, fileEl) => sum + Number(fileEl.dataset.diffAdditions || 0), 0);
                const deletions = remaining.reduce((sum, fileEl) => sum + Number(fileEl.dataset.diffDeletions || 0), 0);
                const stats = card.querySelector<HTMLElement>('.ds-stats');
                if (stats) {
                    stats.innerHTML = `<span class="ds-add">+${additions}</span> <span class="ds-del">-${deletions}</span>`;
                }
                const title = card.querySelector<HTMLElement>('.ds-title-text');
                if (title) title.textContent = chatI18n.locale === 'zh-cn'
                    ? `已编辑 ${remaining.length} 个文件`
                    : `Edited ${remaining.length} ${remaining.length === 1 ? 'file' : 'files'}`;
            }
        });
    }

    function getSideDiffSourceKey(title: string, files: SideDiffFile[], pending?: { messageId: string; isNewFile: boolean }): string {
        if (pending) return `pending:${pending.messageId}`;
        const payload = files.map(file => [
            normalizeSideDiffFilePath(file.file),
            file.status || '',
            file.additions ?? '',
            file.deletions ?? '',
            file.diffPreview || '',
            file.diffLines?.length ?? 0,
        ].join('|')).join('||');
        return `${title}::${payload}`;
    }

    function findSideDiffEntryIndex(entry: SideDiffEntry): number {
        if (entry.sourceKey) {
            const bySourceKey = sideDiffEntries.findIndex(item => item.sourceKey === entry.sourceKey);
            if (bySourceKey >= 0) return bySourceKey;
        }
        if (entry.pending) {
            return sideDiffEntries.findIndex(item => item.pending?.messageId === entry.pending?.messageId);
        }
        return sideDiffEntries.findIndex(item => item.id === entry.id);
    }

    function upsertSideDiffEntry(entry: SideDiffEntry): SideDiffEntry {
        const existingIndex = findSideDiffEntryIndex(entry);
        if (existingIndex >= 0) {
            const existing = sideDiffEntries[existingIndex]!;
            sideDiffEntries[existingIndex] = {
                ...entry,
                id: existing.id,
                timestamp: existing.timestamp,
            };
            updateWorkspaceToggleState();
            return sideDiffEntries[existingIndex];
        }
        sideDiffEntries.unshift(entry);
        if (sideDiffEntries.length > 30) sideDiffEntries.length = 30;
        updateWorkspaceToggleState();
        return entry;
    }

    function removeSideDiffEntry(entryId: string): boolean {
        const index = sideDiffEntries.findIndex(item => item.id === entryId);
        if (index < 0) return false;
        sideDiffEntries.splice(index, 1);
        updateWorkspaceToggleState();
        return true;
    }

    function removePendingSideDiffEntry(messageId: string): boolean {
        const index = sideDiffEntries.findIndex(item => item.pending?.messageId === messageId || item.sourceKey === `pending:${messageId}`);
        if (index < 0) return false;
        sideDiffEntries.splice(index, 1);
        updateWorkspaceToggleState();
        return true;
    }

    function refreshSideDiffWorkspaceAfterRemoval(): void {
        if (!sideWorkspaceContent?.classList.contains('side-diff-view')) return;
        if (sideDiffEntries.length > 0) {
            showSideDiffWorkspace(uiText.fileChanges);
        } else {
            closeSideWorkspace();
        }
    }

    function formatSideDiffTime(timestamp: number): string {
        const d = new Date(timestamp);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    /** Render the side workspace diff overview with per-file change cards. */
    function createSideDiffView(entries: SideDiffEntry[], options: { title: string; focus?: SideDiffFocus }): HTMLElement {
        const view = document.createElement('div');
        view.className = 'side-diff-view';
        const allFiles = entries.flatMap(entry => entry.files);
        const totals = getSideDiffTotals(allFiles);
        const toolbarTitle = options.title === uiText.fileChanges || options.title === '文件变更' ? uiText.changeOverview : options.title;
        view.innerHTML = `<div class="side-diff-toolbar">
            <div class="side-diff-title">${svgIconNoMargin('edit')}<span>${escapeHtml(toolbarTitle)}</span></div>
            <div class="side-diff-stats"><span class="ds-add">+${totals.additions}</span><span class="ds-del">-${totals.deletions}</span><span>${entries.length} ${uiText.changesCount}</span><span>${allFiles.length} ${uiText.filesCount}</span></div>
        </div>`;

        const fileList = document.createElement('div');
        fileList.className = 'side-diff-files';
        const focusPath = options.focus?.file ? normalizeSideDiffFilePath(options.focus.file) : '';
        const focusEntryId = options.focus?.entryId || '';
        let focusTarget: HTMLElement | null = null;
        for (const entry of entries) {
            const entryEl = document.createElement('section');
            entryEl.className = 'side-diff-entry open';
            entryEl.dataset.sideDiffEntryId = entry.id;
            const entryTotals = getSideDiffTotals(entry.files);
            const entryTitle = entry.title === options.title ? (entries.length === 1 ? uiText.thisChange : uiText.changeRecord) : entry.title;
            const entryHeader = document.createElement('button');
            entryHeader.type = 'button';
            entryHeader.className = 'side-diff-entry-header';
            entryHeader.innerHTML = `
                <div class="side-diff-entry-main">
                    <span class="side-diff-chevron">&gt;</span>
                    <span class="side-diff-entry-title">${escapeHtml(entryTitle)}</span>
                    <span class="side-diff-entry-time">${formatSideDiffTime(entry.timestamp)}</span>
                </div>
                <div class="side-diff-entry-stats"><span class="ds-add">+${entryTotals.additions}</span><span class="ds-del">-${entryTotals.deletions}</span><span>${entry.files.length} ${uiText.filesCount}</span><span>${entryTotals.lineCount} ${uiText.previewLines}</span></div>`;
            entryHeader.addEventListener('click', () => {
                entryEl.classList.toggle('open');
            });
            entryEl.appendChild(entryHeader);

            const entryFiles = document.createElement('div');
            entryFiles.className = 'side-diff-entry-files';
            for (const file of entry.files) {
                const item = document.createElement('section');
                item.className = `side-diff-file side-diff-file-${artifactFileStatusTone(file.status)} open`;
                item.dataset.sideDiffFile = file.file;
                const fileBaseName = fileBaseNameLocal(file.file);
                const isUnseen = unseenDiffFiles.has(file.file);
                const unseenDot = isUnseen ? '<span class="side-diff-unseen-dot"></span>' : '';
                const statusBadge = renderDiffFileStatusBadge(file.status, 'side-diff');
                const stats = renderDiffFileDelta(file, 'side-diff');
                const preview = shouldShowSideDiffPreview(file) ? `<span class="side-diff-file-preview">${escapeHtml(file.diffPreview)}</span>` : '';
                const fileHeader = document.createElement('button');
                fileHeader.type = 'button';
                fileHeader.className = 'side-diff-file-header';
                fileHeader.innerHTML = `
                    ${statusBadge}
                    <div class="side-diff-file-main">
                        <span class="side-diff-file-title">
                            ${unseenDot}
                            <span class="side-diff-chevron">&gt;</span>
                            <span class="side-diff-file-name" title="${escapeHtml(file.file)}">${escapeHtml(fileBaseName)}</span>
                        </span>
                        <span class="side-diff-file-path">${escapeHtml(file.file)}</span>
                        ${preview}
                    </div>
                    <div class="side-diff-file-stats">${stats}</div>`;
                fileHeader.addEventListener('click', event => {
                    event.stopPropagation();
                    item.classList.toggle('open');
                    // Clear unseen on click
                    if (unseenDiffFiles.delete(file.file)) {
                        const dot = fileHeader.querySelector('.side-diff-unseen-dot');
                        if (dot) dot.remove();
                        updateSwBadges();
                    }
                });
                item.appendChild(fileHeader);
                const code = document.createElement('div');
                code.className = 'side-diff-code';
                code.innerHTML = renderDiffTable(file.diffLines);
                item.appendChild(code);
                if (focusPath && (!focusEntryId || focusEntryId === entry.id) && normalizeSideDiffFilePath(file.file) === focusPath) {
                    item.classList.add('focused');
                    entryEl.classList.add('focused');
                    focusTarget = item;
                }
                entryFiles.appendChild(item);
            }
            entryEl.appendChild(entryFiles);
            if (!focusTarget && focusEntryId === entry.id) {
                entryEl.classList.add('focused');
                focusTarget = entryEl;
            }

            if (entry.pending) {
                const actions = document.createElement('div');
                actions.className = 'side-diff-actions';
                actions.innerHTML = `<button class="diff-reject-btn" type="button">${svgIcon('x')}${escapeHtml(uiText.reject)}</button>
                    <button class="diff-accept-btn" type="button">${svgIcon('check')}${escapeHtml(uiText.accept)}</button>`;
                actions.querySelector('.diff-accept-btn')?.addEventListener('click', () => {
                    vscode.postMessage({ type: 'confirmWriteFile', messageId: entry.pending!.messageId });
                    removeSideDiffEntry(entry.id);
                    refreshSideDiffWorkspaceAfterRemoval();
                });
                actions.querySelector('.diff-reject-btn')?.addEventListener('click', () => {
                    vscode.postMessage({ type: 'cancelWriteFile', messageId: entry.pending!.messageId });
                    removeSideDiffEntry(entry.id);
                    refreshSideDiffWorkspaceAfterRemoval();
                });
                entryEl.appendChild(actions);
            }
            fileList.appendChild(entryEl);
        }
        view.appendChild(fileList);
        if (focusTarget) {
            requestAnimationFrame(() => focusTarget?.scrollIntoView({ block: 'nearest' }));
        }

        return view;
    }

    function showSideDiffWorkspace(title = uiText.fileChanges, entries = sideDiffEntries, focus?: SideDiffFocus): void {
        const fileCount = entries.reduce((sum, entry) => sum + entry.files.length, 0);
        const snapshot = entries.map(cloneSideDiffEntry);
        openSideWorkspace({
            title,
            subtitle: entries.length === 1 && fileCount === 1 ? `${entries[0]?.title || title} · ${entries[0]?.files[0]?.file || ''}` : `${entries.length} ${uiText.changesCount} · ${fileCount} ${uiText.filesCount}`,
            wide: true,
            kind: 'fileChanges',
            sourceKey: 'fileChanges',
            build: () => createSideDiffView(snapshot, { title, focus }),
        });
        showSwTabs('changes');
    }

    function openDiffInSideWorkspace(
        files: SideDiffFile[],
        title = uiText.fileChanges,
        options: { pending?: { messageId: string; isNewFile: boolean }; append?: boolean; sourceKey?: string; focusFile?: string } = {},
    ): void {
        const mergedFiles = mergeSideDiffFiles(files);
        if (mergedFiles.length === 0) return;
        // Mark incoming files as unseen
        for (const f of mergedFiles) unseenDiffFiles.add(f.file);
        const sourceKey = options.sourceKey || getSideDiffSourceKey(title, mergedFiles, options.pending);
        if (!options.pending) removeSideDiffFilesFromExisting(mergedFiles, sourceKey);
        const entry = createSideDiffEntry(mergedFiles, title, options.pending, sourceKey);
        const activeEntry = upsertSideDiffEntry(entry);
        showSideDiffWorkspace(uiText.fileChanges, sideDiffEntries, {
            entryId: activeEntry.id,
            file: options.focusFile,
        });
    }

    const responsiveWorkspaceResizeObserver = new ResizeObserver(scheduleResponsiveWorkspaceLayoutSync);
    responsiveWorkspaceResizeObserver.observe(document.documentElement);
    window.addEventListener('resize', scheduleResponsiveWorkspaceLayoutSync);
    updateWorkspaceToggleState();

    function textFromComposerNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
        if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            return Array.from(node.childNodes).map(textFromComposerNode).join('');
        }
        if (!(node instanceof HTMLElement)) return '';
        if (node.classList.contains('reference-chip')) return ' ';
        if (node.tagName === 'BR') return '\n';
        const childText = Array.from(node.childNodes).map(textFromComposerNode).join('');
        return node !== input && (node.tagName === 'DIV' || node.tagName === 'P') ? childText + '\n' : childText;
    }

    function getInputText(): string {
        return Array.from(activeComposerEl.childNodes).map(textFromComposerNode).join('').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    }

    function isInputEmpty(): boolean {
        return getInputText().trim() === '' && !input.querySelector('.reference-chip');
    }

    function hasComposerPayload(): boolean {
        return getInputText().trim() !== ''
            || pendingImages.length > 0
            || pendingFiles.length > 0
            || activeContexts.length > 0
            || !!input.querySelector('.reference-chip');
    }

    function autoResizeInput() {
        updateComposerStackHeight();
    }

    function normalizeEmptyInput() {
        if (input.querySelector('.reference-chip')) return;
        if (getInputText().trim() === '' && input.innerHTML === '<br>') input.innerHTML = '';
    }

    function isRangeInsideInput(range: Range): boolean {
        const el = activeComposerEl;
        return (range.startContainer === el || el.contains(range.startContainer))
            && (range.endContainer === el || el.contains(range.endContainer));
    }

    function saveInputSelection() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (isRangeInsideInput(range)) savedInputRange = range.cloneRange();
    }

    function setInputRange(range: Range) {
        activeComposerEl.focus();
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        savedInputRange = range.cloneRange();
    }

    function getInputEndRange(): Range {
        const range = document.createRange();
        range.selectNodeContents(activeComposerEl);
        range.collapse(false);
        return range;
    }

    function getActiveInputRange(): Range {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (isRangeInsideInput(range)) return range.cloneRange();
        }
        if (savedInputRange && isRangeInsideInput(savedInputRange)) return savedInputRange.cloneRange();
        return getInputEndRange();
    }

    function placeCaretAtEnd(el: HTMLElement) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        setInputRange(range);
    }

    function insertPlainTextAtRange(text: string, range = getActiveInputRange()) {
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        const caret = document.createRange();
        caret.setStart(textNode, textNode.length);
        caret.collapse(true);
        setInputRange(caret);
        autoResizeInput();
        updateSendButtonState();
    }

    function normalizePastedText(text: string): string {
        return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    }

    function setInputText(text: string) {
        input.textContent = text;
        placeCaretAtEnd(input);
        autoResizeInput();
        updateSendButtonState();
    }

    function appendInputText(text: string, separator = '') {
        const current = getInputText();
        placeCaretAtEnd(input);
        insertPlainTextAtRange(current.trim() ? separator + text : text);
    }

    startMessageSelectionActions({
        root: chatArea,
        labels: {
            addToTask: tr('Add to task', '添加到任务'),
            addToTaskHint: tr('Add selected text to the task input', '将选中内容添加到任务输入框'),
        },
        onAddToTask: text => {
            cancelInlineEdit();
            const quoted = text.trim();
            if (!quoted) return;
            insertReferenceAtCaret({
                id: generateContextId(),
                type: 'quote',
                label: 'quote',
                description: quoted.split('\n')[0]!.slice(0, 120),
                text: quoted,
                tokenEstimate: Math.max(1, Math.ceil(quoted.length / 4)),
                cacheStatus: 'live',
            });
            updateSendButtonState();
        },
    });

    function clearInput() {
        input.innerHTML = '';
        activeContexts = [];
        savedInputRange = null;
        autoResizeInput();
        updateSendButtonState();
    }

    // ── Side-Workspace Tab system ─────────────────────────────────────────────
    let _activeSwTab: string = 'changes';
    let _scratchFiles: Array<{ name: string; relPath: string; size: number }> = [];

    const swTabs = document.getElementById('swTabs');
    const swBadgeChanges = document.getElementById('swBadgeChanges');
    const swBadgeFiles = document.getElementById('swBadgeFiles');
    const swBadgeArtifacts = document.getElementById('swBadgeArtifacts');
    swTabs?.querySelector('[data-sw-tab="changes"] span:not(.sw-tab-badge)')?.replaceChildren(uiText.changesTab);
    swTabs?.querySelector('[data-sw-tab="files"] span:not(.sw-tab-badge)')?.replaceChildren(uiText.filesTab);
    swTabs?.querySelector('[data-sw-tab="artifacts"] span:not(.sw-tab-badge)')?.replaceChildren(uiText.artifactsTab);

    function showSwTabs(activeTab: string): void {
        if (!swTabs) return;
        _activeSwTab = activeTab;
        swTabs.style.display = 'flex';
        swTabs.querySelectorAll('.sw-tab').forEach(btn => {
            const tab = (btn as HTMLElement).dataset.swTab || '';
            btn.classList.toggle('active', tab === activeTab);
        });
        updateSwBadges();
    }

    function hideSwTabs(): void {
        if (swTabs) swTabs.style.display = 'none';
    }

    function updateSwBadges(): void {
        const diffCount = sideDiffEntries.reduce((s, e) => s + e.files.length, 0);
        if (swBadgeChanges) swBadgeChanges.textContent = diffCount > 0 ? String(diffCount) : '';
        if (swBadgeFiles) swBadgeFiles.textContent = _scratchFiles.length > 0 ? String(_scratchFiles.length) : '';
        if (swBadgeArtifacts) swBadgeArtifacts.textContent = artifacts.length > 0 ? String(artifacts.length) : '';
        // Unseen indicator on the changes tab
        const changesTab = swTabs?.querySelector('[data-sw-tab="changes"]');
        if (changesTab) {
            changesTab.classList.toggle('sw-tab-unseen', unseenDiffFiles.size > 0 && _activeSwTab !== 'changes');
        }
    }

    function switchSwTab(tab: string): void {
        _activeSwTab = tab;
        swTabs?.querySelectorAll('.sw-tab').forEach(btn => {
            btn.classList.toggle('active', (btn as HTMLElement).dataset.swTab === tab);
        });
        if (!sideWorkspaceBody) return;
        switch (tab) {
            case 'changes':
                if (sideDiffEntries.length > 0) {
                    showSideDiffWorkspace();
                } else {
                    sideWorkspaceBody.innerHTML = `<div class="sw-empty-state">${escapeHtml(uiText.noFileChanges)}</div>`;
                }
                break;
            case 'files':
                vscode.postMessage({ type: 'requestScratchFiles' });
                renderScratchFileTree();
                break;
            case 'artifacts':
                renderSwArtifactList();
                break;
        }
    }

    function renderScratchFileTree(): void {
        if (!sideWorkspaceBody) return;
        if (_scratchFiles.length === 0) {
            sideWorkspaceBody.innerHTML = `<div class="sw-empty-state">${escapeHtml(uiText.scratchEmpty)}<br><span style="font-size:10px;opacity:0.6">${escapeHtml(uiText.scratchHint)}</span></div>`;
            return;
        }
        const html = _scratchFiles.map(f => {
            const ext = f.name.split('.').pop() || '';
            const iconMap: Record<string, string> = { py: '🐍', ts: '📘', js: '📗', ps1: '⚡', sh: '⚡', bat: '⚡', md: '📄', txt: '📄', json: '📋' };
            const icon = iconMap[ext] || '📄';
            const sizeLabel = f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`;
            return `<div class="scratch-file-item" data-file="${escapeHtml(f.relPath)}" title="${escapeHtml(f.relPath)}">` +
                `<span class="scratch-file-icon">${icon}</span>` +
                `<span class="scratch-file-name">${escapeHtml(f.name)}</span>` +
                `<span class="scratch-file-size">${sizeLabel}</span>` +
            `</div>`;
        }).join('');
        sideWorkspaceBody.innerHTML = `<div class="scratch-file-tree">${html}</div>`;
        sideWorkspaceBody.querySelectorAll('.scratch-file-item').forEach(el => {
            el.addEventListener('click', () => {
                const filePath = (el as HTMLElement).dataset.file;
                if (filePath) vscode.postMessage({ type: 'openScratchFile', file: filePath });
            });
        });
    }

    function renderSwArtifactList(): void {
        if (!sideWorkspaceBody) return;
        if (artifacts.length === 0) {
            sideWorkspaceBody.innerHTML = `<div class="sw-empty-state">${escapeHtml(uiText.artifactsEmpty)}<br><span style="font-size:10px;opacity:0.6">${escapeHtml(uiText.artifactsHint)}</span></div>`;
            return;
        }
        const html = artifacts.map(a => {
            return `<div class="sw-artifact-card" data-artifact-id="${escapeHtml(a.id)}" title="${escapeHtml(a.summary || '')}">` +
                `<span class="sw-artifact-kind">${escapeHtml(a.kind)}</span>` +
                `<span class="sw-artifact-title">${escapeHtml(a.title)}</span>` +
                `<span class="sw-artifact-status">${escapeHtml(a.status || '')}</span>` +
            `</div>`;
        }).join('');
        sideWorkspaceBody.innerHTML = `<div class="sw-artifact-list">${html}</div>`;
        sideWorkspaceBody.querySelectorAll('.sw-artifact-card').forEach(el => {
            el.addEventListener('click', () => {
                const id = (el as HTMLElement).dataset.artifactId;
                if (id) vscode.postMessage({ type: 'openArtifact', artifactId: id });
            });
        });
    }

    // Tab click handler
    swTabs?.querySelectorAll('.sw-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = (btn as HTMLElement).dataset.swTab || '';
            if (tab) switchSwTab(tab);
        });
    });

    function cloneInputPayload(payload: UserMessageInputPayload): UserMessageInputPayload {
        return {
            text: payload.text || '',
            images: payload.images ? [...payload.images] : undefined,
            contexts: payload.contexts ? payload.contexts.map(ctx => ({ ...ctx, id: ctx.id || generateContextId() })) : undefined,
            attachedFiles: payload.attachedFiles ? [...payload.attachedFiles] : undefined,
        };
    }

    function getGoalRunArea(): HTMLElement | null {
        if (goalRunArea?.isConnected) return goalRunArea;
        const container = document.querySelector('.input-container');
        if (!container) return null;
        const area = document.createElement('div');
        area.id = 'goalRunArea';
        area.className = 'goal-run-area';
        const anchor = queuedPromptArea?.isConnected
            ? queuedPromptArea
            : container.querySelector('#fileBadgeArea') || container.firstChild;
        container.insertBefore(area, anchor);
        goalRunArea = area;
        return area;
    }

    function goalStatusLabel(status: string): string {
        switch (status) {
            case 'running': return tr('Running', '运行中');
            case 'queued': return tr('Queued', '排队中');
            case 'blocked': return tr('Blocked', '受阻');
            case 'complete': return tr('Complete', '完成');
            case 'failed': return tr('Stopped', '已停止');
            case 'attention': return tr('Needs attention', '需要处理');
            default: return status || tr('Goal', '目标');
        }
    }

    function goalActionLabel(action: 'edit' | 'blocked' | 'complete' | 'cancel'): string {
        switch (action) {
            case 'edit': return tr('Edit goal', '编辑目标');
            case 'blocked': return tr('Mark goal blocked', '标记目标受阻');
            case 'complete': return tr('Mark goal complete', '标记目标完成');
            case 'cancel': return tr('Cancel current run', '取消当前运行');
        }
    }

    function renderGoalRunArea(): void {
        const area = getGoalRunArea();
        if (!area) return;
        document.body.classList.toggle('has-goal-run', !!currentGoalActivity);
        if (!currentGoalActivity) {
            area.innerHTML = '';
            area.hidden = true;
            updateComposerStackHeight();
            return;
        }

        const goal = currentGoalActivity;
        const statusClass = goal.status.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'unknown';
        const canMarkTerminal = goal.status !== 'complete' && goal.status !== 'failed';
        area.hidden = false;
        area.innerHTML = `
            <div class="goal-run-row goal-run-${escapeHtml(statusClass)}">
                <span class="goal-run-icon" aria-hidden="true">${svgIconNoMargin('flag')}</span>
                <button class="goal-run-main" type="button" data-goal-action="edit" title="${escapeHtml(goalActionLabel('edit'))}">
                    <span class="goal-run-status">${escapeHtml(goalStatusLabel(goal.status))}</span>
                    <span class="goal-run-objective">${escapeHtml(goal.label)}</span>
                    ${goal.detail ? `<span class="goal-run-detail">${escapeHtml(goal.detail)}</span>` : ''}
                </button>
                <div class="goal-run-actions" role="toolbar" aria-label="${escapeHtml(tr('Goal controls', '目标控制'))}">
                    ${isGenerating ? `<button class="goal-run-action goal-action-cancel" type="button" data-goal-action="cancel" title="${escapeHtml(goalActionLabel('cancel'))}" aria-label="${escapeHtml(goalActionLabel('cancel'))}"><span class="stop-icon"></span></button>` : ''}
                    <button class="goal-run-action" type="button" data-goal-action="edit" title="${escapeHtml(goalActionLabel('edit'))}" aria-label="${escapeHtml(goalActionLabel('edit'))}">${svgIconNoMargin('pencil')}</button>
                    ${canMarkTerminal ? `<button class="goal-run-action goal-action-blocked" type="button" data-goal-action="blocked" title="${escapeHtml(goalActionLabel('blocked'))}" aria-label="${escapeHtml(goalActionLabel('blocked'))}">${svgIconNoMargin('warning')}</button>` : ''}
                    ${canMarkTerminal ? `<button class="goal-run-action goal-action-complete" type="button" data-goal-action="complete" title="${escapeHtml(goalActionLabel('complete'))}" aria-label="${escapeHtml(goalActionLabel('complete'))}">${svgIconNoMargin('check')}</button>` : ''}
                </div>
            </div>
        `;

        area.querySelectorAll<HTMLElement>('[data-goal-action]').forEach(button => {
            button.addEventListener('click', event => {
                event.preventDefault();
                const action = button.dataset.goalAction;
                if (action === 'edit') {
                    setInputText(`/goal ${goal.label}`);
                    input.focus();
                } else if (action === 'blocked') {
                    vscode.postMessage({ type: 'slashCommand', command: '/goal:blocked' });
                } else if (action === 'complete') {
                    vscode.postMessage({ type: 'slashCommand', command: '/goal:complete' });
                } else if (action === 'cancel') {
                    vscode.postMessage({ type: 'cancelGeneration' });
                }
            });
        });
        updateComposerStackHeight();
    }

    function updateGoalActivityFromProjection(activity: { items?: unknown[] } | undefined): void {
        const items = Array.isArray(activity?.items) ? activity.items : [];
        const goal = items.find((item): item is AgentActivityView => {
            if (!item || typeof item !== 'object') return false;
            const candidate = item as Partial<AgentActivityView>;
            return candidate.kind === 'goal'
                && typeof candidate.id === 'string'
                && typeof candidate.label === 'string'
                && typeof candidate.status === 'string';
        });
        currentGoalActivity = goal ? { ...goal } : null;
        renderGoalRunArea();
    }

    function getQueuedPromptArea(): HTMLElement | null {
        if (queuedPromptArea?.isConnected) return queuedPromptArea;
        const container = document.querySelector('.input-container');
        if (!container) return null;
        const area = document.createElement('div');
        area.id = 'queuedPromptArea';
        area.className = 'queued-prompt-area';
        const anchor = container.querySelector('#fileBadgeArea') || container.firstChild;
        container.insertBefore(area, anchor);
        queuedPromptArea = area;
        return area;
    }

    function queuedPromptSummary(item: UserMessageInputPayload): string {
        const text = item.text.trim().replace(/\s+/g, ' ');
        if (text) return text;
        const parts: string[] = [];
        if (item.contexts?.length) parts.push(tr(`${item.contexts.length} reference(s)`, `${item.contexts.length} 个引用`));
        if (item.images?.length) parts.push(tr(`${item.images.length} image(s)`, `${item.images.length} 张图片`));
        return parts.join(' · ') || tr('Queued input', '待发送输入');
    }

    function queuedPromptMeta(item: UserMessageInputPayload): string {
        const parts: string[] = [];
        if (item.contexts?.length) parts.push(tr(`${item.contexts.length} ref`, `${item.contexts.length} 引用`));
        if (item.images?.length) parts.push(tr(`${item.images.length} img`, `${item.images.length} 图`));
        return parts.join(' · ');
    }

    function renderQueuedPromptArea(): void {
        const area = getQueuedPromptArea();
        if (!area) return;
        document.body.classList.toggle('has-queued-composer-inputs', queuedComposerInputs.length > 0);
        if (queuedComposerInputs.length === 0) {
            area.innerHTML = '';
            area.hidden = true;
            updateComposerStackHeight();
            return;
        }

        area.hidden = false;
        area.innerHTML = queuedComposerInputs.map((item, index) => {
            const meta = queuedPromptMeta(item);
            const sendTitle = isGenerating
                ? tr('Send to current run as steering input', '作为调整方向插入当前任务')
                : tr('Send now', '立即发送');
            return `
                <div class="queued-prompt-row" data-queued-id="${escapeHtml(item.id)}">
                    <button class="queued-prompt-main" type="button" data-action="edit" title="${escapeHtml(tr('Edit queued input', '编辑待发送输入'))}">
                        <span class="queued-prompt-badge">${escapeHtml(index === 0 ? tr('Queued', '排队') : `#${index + 1}`)}</span>
                        <span class="queued-prompt-text">${escapeHtml(queuedPromptSummary(item))}</span>
                        ${meta ? `<span class="queued-prompt-meta">${escapeHtml(meta)}</span>` : ''}
                    </button>
                    <div class="queued-prompt-actions" role="toolbar" aria-label="${escapeHtml(tr('Queued input actions', '待发送输入操作'))}">
                        <button class="queued-prompt-action" type="button" data-action="edit" title="${escapeHtml(tr('Edit queued input', '编辑待发送输入'))}" aria-label="${escapeHtml(tr('Edit queued input', '编辑待发送输入'))}">${svgIconNoMargin('pencil')}</button>
                        <button class="queued-prompt-action queued-prompt-delete" type="button" data-action="delete" title="${escapeHtml(tr('Delete queued input', '删除待发送输入'))}" aria-label="${escapeHtml(tr('Delete queued input', '删除待发送输入'))}">${svgIconNoMargin('trash')}</button>
                        <button class="queued-prompt-action queued-prompt-send" type="button" data-action="send" title="${escapeHtml(sendTitle)}" aria-label="${escapeHtml(sendTitle)}">${svgIconNoMargin('upload')}</button>
                    </div>
                </div>
            `;
        }).join('');

        area.querySelectorAll<HTMLElement>('[data-action]').forEach(button => {
            button.addEventListener('click', event => {
                event.preventDefault();
                const row = button.closest<HTMLElement>('.queued-prompt-row');
                const id = row?.dataset.queuedId;
                if (!id) return;
                const action = button.dataset.action;
                if (action === 'edit') editQueuedComposerInput(id);
                else if (action === 'delete') removeQueuedComposerInput(id);
                else if (action === 'send') sendQueuedComposerInput(id);
            });
        });
        updateComposerStackHeight();
    }

    function enqueueComposerInput(payload: ComposerPayload): void {
        queuedComposerInputs.push({
            ...cloneInputPayload(payload),
            id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            createdAt: Date.now(),
        });
        renderQueuedPromptArea();
    }

    function removeQueuedComposerInput(id: string): QueuedComposerInput | undefined {
        const index = queuedComposerInputs.findIndex(item => item.id === id);
        if (index < 0) return undefined;
        const [removed] = queuedComposerInputs.splice(index, 1);
        renderQueuedPromptArea();
        return removed;
    }

    function editQueuedComposerInput(id: string): void {
        const item = removeQueuedComposerInput(id);
        if (!item) return;
        restoreComposerPayload(item);
    }

    function clearQueuedComposerInputs(): void {
        queuedComposerInputs.length = 0;
        if (queuedPromptDispatchTimer) {
            clearTimeout(queuedPromptDispatchTimer);
            queuedPromptDispatchTimer = null;
        }
        queuedPromptDispatchAfterCompletion = false;
        renderQueuedPromptArea();
    }

    function clearComposerAttachmentPreviews() {
        pendingImages = [];
        pendingFiles = [];
        const preview = document.getElementById('imagePreviewArea');
        if (preview) preview.innerHTML = '';
        const fileBadges = document.getElementById('fileBadgeArea');
        if (fileBadges) fileBadges.innerHTML = '';
    }

    function restoreComposerPayload(payload: UserMessageInputPayload) {
        const next = cloneInputPayload(payload);
        clearInput();
        clearComposerAttachmentPreviews();

        for (const ctx of next.contexts || []) {
            activeContexts.push(ctx);
            input.appendChild(buildReferenceChip(ctx));
            input.appendChild(document.createTextNode(' '));
        }
        if (next.text) input.appendChild(document.createTextNode(next.text));

        pendingImages = next.images ? [...next.images] : [];
        for (const dataUrl of pendingImages) addImagePreview(dataUrl);

        placeCaretAtEnd(input);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        stopPlaceholderRotation();
        updateComposerStackHeight();
    }

    function getInlineEditorText(editor: HTMLElement): string {
        return (editor.innerText || editor.textContent || '')
            .replace(/\r\n?/g, '\n')
            .replace(/\u00a0/g, ' ')
            .replace(/\u200b/g, '')
            .replace(/\n$/, '');
    }

    function cancelInlineEdit(focusBubble = false) {
        const session = inlineEditSession;
        if (!session) {
            return;
        }
        activeComposerEl = input;
        session.container.remove();
        session.bubble.style.display = '';
        if (session.actions) session.actions.style.display = '';
        messageIndexMap.get(session.messageIndex)?.classList.remove('editing');
        inlineEditSession = null;
        closeAtPopup();
        setSlashPopupOpen(false);
        if (focusBubble) session.bubble.focus();
    }

    function buildInlineContextChip(ctx: ActiveContext, onRemove: () => void): HTMLElement {
        const meta = CONTEXT_TYPE_META[ctx.type] || CONTEXT_TYPE_META.file;
        const range = typeof ctx.startLine === 'number' && typeof ctx.endLine === 'number'
            ? ` #L${ctx.startLine}-${ctx.endLine}`
            : typeof ctx.line === 'number'
                ? ` #L${ctx.line + 1}`
                : '';
        const title = ctx.description || ctx.uri || ctx.label;
        const metaBits = [
            typeof ctx.tokenEstimate === 'number' && ctx.tokenEstimate > 0 ? `~${formatNum(ctx.tokenEstimate)} tok` : '',
            ctx.cacheStatus ? ctx.cacheStatus : '',
        ].filter(Boolean).join(' · ');
        const el = document.createElement('span');
        el.className = `reference-chip ref-${ctx.type}`;
        el.title = title;
        el.innerHTML = `
            ${svgIconNoMargin(meta.icon)}
            <span class="ref-kind">${escapeHtml(meta.label)}</span>
            <span class="ref-text">${escapeHtml(ctx.label)}${range}</span>
            ${metaBits ? `<span class="ref-meta">${escapeHtml(metaBits)}</span>` : ''}
        `;
        el.classList.add('inline-edit-chip');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'inline-edit-remove';
        remove.setAttribute('aria-label', tr('Remove reference', '移除引用'));
        remove.textContent = '×';
        remove.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
        });
        el.appendChild(remove);
        return el;
    }

    function beginEditMessage(messageIdx: number) {
        if (isGenerating) return;
        const payload = userMessagePayloadMap.get(messageIdx);
        if (!payload) return;
        cancelInlineEdit();

        const message = messageIndexMap.get(messageIdx);
        const bubble = message?.querySelector<HTMLElement>('.user-bubble');
        const actions = message?.querySelector<HTMLElement>('.message-actions');
        if (!message || !bubble) return;

        const draft = cloneInputPayload(payload);
        let draftContexts = draft.contexts || [];
        let draftImages = draft.images || [];

        const editorCard = document.createElement('div');
        editorCard.className = 'inline-message-editor';
        editorCard.innerHTML = `
            <div class="inline-edit-top">
                <span>${svgIconNoMargin('pencil')}</span>
                <span>${tr(`Editing message ${messageIdx + 1}; sending will rerun from here`, `编辑第 ${messageIdx + 1} 条消息，发送后会从这里重新运行`)}</span>
            </div>
            <div class="inline-edit-context-row"></div>
            <div class="inline-edit-text" contenteditable="true" role="textbox" aria-multiline="true"></div>
            <div class="inline-edit-image-row"></div>
            <div class="inline-edit-actions">
                <button class="inline-edit-cancel" type="button">${tr('Cancel', '取消')}</button>
                <button class="inline-edit-submit" type="button">${svgIconNoMargin('pointer')}${tr('Send', '发送')}</button>
            </div>
        `;

        const textEditor = editorCard.querySelector<HTMLElement>('.inline-edit-text')!;
        const contextRow = editorCard.querySelector<HTMLElement>('.inline-edit-context-row')!;
        const imageRow = editorCard.querySelector<HTMLElement>('.inline-edit-image-row')!;
        const submitBtn = editorCard.querySelector<HTMLButtonElement>('.inline-edit-submit')!;
        const cancelBtn = editorCard.querySelector<HTMLButtonElement>('.inline-edit-cancel')!;
        textEditor.textContent = draft.text;

        const renderContexts = () => {
            contextRow.innerHTML = '';
            if (draftContexts.length === 0) {
                contextRow.style.display = 'none';
                return;
            }
            contextRow.style.display = '';
            draftContexts.forEach(ctx => {
                contextRow.appendChild(buildInlineContextChip(ctx, () => {
                    draftContexts = draftContexts.filter(item => item.id !== ctx.id);
                    renderContexts();
                }));
            });
        };

        const renderImages = () => {
            imageRow.innerHTML = '';
            if (draftImages.length === 0) {
                imageRow.style.display = 'none';
                return;
            }
            imageRow.style.display = '';
            draftImages.forEach(src => {
                const wrap = document.createElement('div');
                wrap.className = 'inline-edit-image';
                const img = document.createElement('img');
                img.src = src;
                img.title = tr('Click to enlarge', '点击放大');
                img.addEventListener('click', () => showImageLightbox(src));
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.setAttribute('aria-label', tr('Remove image', '移除图片'));
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    draftImages = draftImages.filter(item => item !== src);
                    renderImages();
                });
                wrap.appendChild(img);
                wrap.appendChild(remove);
                imageRow.appendChild(wrap);
            });
        };

        const submit = () => {
            const text = getInlineEditorText(textEditor).trim();
            if (!text && draftContexts.length === 0 && draftImages.length === 0) return;
            submitBtn.disabled = true;
            cancelBtn.disabled = true;
            editorCard.classList.add('submitting');
            vscode.postMessage({
                type: 'editAndResendMessage',
                messageIndex: messageIdx,
                text,
                contexts: draftContexts.length > 0 ? draftContexts.map(ctx => ({ ...ctx })) : undefined,
                images: draftImages.length > 0 ? [...draftImages] : undefined,
            });
            activeComposerEl = input;
            closeAtPopup();
            setSlashPopupOpen(false);
        };

        textEditor.addEventListener('keydown', e => {
            // @ mention popup keyboard handling in inline editor
            if (_atPopupVisible && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape')) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIndex(_mentionSelectedIndex + 1); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIndex(_mentionSelectedIndex - 1); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (acceptSelectedMention()) return; }
                if (e.key === 'Escape') { e.preventDefault(); closeAtPopup(); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !(e as KeyboardEvent).isComposing) {
                e.preventDefault();
                submit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelInlineEdit(true);
            }
        });
        textEditor.addEventListener('input', () => {
            const v = getInputText();
            if (v.startsWith('/') && v.length > 0) showSlashPopup(v);
            else setSlashPopupOpen(false);
            const mentionFilter = getMentionFilterBeforeCaret();
            if (mentionFilter !== null) showAtPopup(mentionFilter);
            else closeAtPopup();
        });
        submitBtn.addEventListener('click', submit);
        cancelBtn.addEventListener('click', () => cancelInlineEdit(true));

        renderContexts();
        renderImages();

        bubble.style.display = 'none';
        if (actions) actions.style.display = 'none';
        message.classList.add('editing');
        bubble.insertAdjacentElement('afterend', editorCard);
        inlineEditSession = { messageIndex: messageIdx, container: editorCard, bubble, actions: actions || null };
        activeComposerEl = textEditor;
        textEditor.focus();
        const range = document.createRange();
        range.selectNodeContents(textEditor);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    function syncContextsFromComposer() {
        const byId = new Map(activeContexts.map(ctx => [ctx.id, ctx]));
        activeContexts = Array.from(input.querySelectorAll<HTMLElement>('.reference-chip'))
            .map(chip => byId.get(chip.dataset.id || ''))
            .filter((ctx): ctx is ActiveContext => !!ctx);
    }

    function getComposerTextBeforeRange(range: Range): string {
        if (!isRangeInsideInput(range)) return '';
        const before = document.createRange();
        before.selectNodeContents(activeComposerEl);
        before.setEnd(range.startContainer, range.startOffset);
        return textFromComposerNode(before.cloneContents());
    }

    function nodeChildIndex(node: Node): number {
        if (!node.parentNode) return 0;
        return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
    }

    function domPointForComposerTextOffset(offset: number): { node: Node; offset: number } {
        let remaining = Math.max(0, offset);

        const walk = (node: Node): { node: Node; offset: number } | null => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || '';
                if (remaining <= text.length) return { node, offset: remaining };
                remaining -= text.length;
                return null;
            }

            if (node instanceof HTMLElement && (node.classList.contains('reference-chip') || node.tagName === 'BR')) {
                const parent = node.parentNode || activeComposerEl;
                const index = nodeChildIndex(node);
                if (remaining <= 1) return { node: parent, offset: index + (remaining > 0 ? 1 : 0) };
                remaining -= 1;
                return null;
            }

            for (const child of Array.from(node.childNodes)) {
                const result = walk(child);
                if (result) return result;
            }

            if (node instanceof HTMLElement && node !== activeComposerEl && (node.tagName === 'DIV' || node.tagName === 'P')) {
                const parent = node.parentNode || activeComposerEl;
                const index = nodeChildIndex(node);
                if (remaining <= 1) return { node: parent, offset: index + 1 };
                remaining -= 1;
            }

            return null;
        };

        return walk(activeComposerEl) || { node: activeComposerEl, offset: activeComposerEl.childNodes.length };
    }

    function getAtTriggerBeforeCaret(): { range: Range; filter: string } | null {
        const caretRange = getActiveInputRange();
        if (!isRangeInsideInput(caretRange)) return null;
        const value = getComposerTextBeforeRange(caretRange);
        if (!value) return null;
        const atIdx = value.lastIndexOf('@');
        if (atIdx < 0) return null;
        const filter = value.slice(atIdx + 1);
        if (/[\s\n]/.test(filter)) return null;
        const triggerRange = document.createRange();
        const start = domPointForComposerTextOffset(atIdx);
        triggerRange.setStart(start.node, start.offset);
        triggerRange.setEnd(caretRange.startContainer, caretRange.startOffset);
        return { range: triggerRange, filter };
    }

    function replaceAtTriggerWithText(text: string) {
        const trigger = getAtTriggerBeforeCaret();
        insertPlainTextAtRange(text, trigger?.range || getActiveInputRange());
    }

    function getMentionFilterBeforeCaret(): string | null {
        return getAtTriggerBeforeCaret()?.filter ?? null;
    }

    function insertReferenceAtCaret(ctx: ActiveContext, targetRange = getActiveInputRange()) {
        activeContexts.push(ctx);
        const chip = buildReferenceChip(ctx);
        const range = isRangeInsideInput(targetRange) ? targetRange : getInputEndRange();
        range.deleteContents();
        const fragment = document.createDocumentFragment();
        const leadingSpace = document.createTextNode(' ');
        const trailingSpace = document.createTextNode(' ');
        fragment.appendChild(leadingSpace);
        fragment.appendChild(chip);
        fragment.appendChild(trailingSpace);
        range.insertNode(fragment);

        const caret = document.createRange();
        caret.setStart(trailingSpace, trailingSpace.textContent?.length || 0);
        caret.collapse(true);
        setInputRange(caret);
        autoResizeInput();
    }

    function replaceAtTriggerWithReference(ctx: ActiveContext) {
        const trigger = getAtTriggerBeforeCaret();
        insertReferenceAtCaret(ctx, trigger?.range || getActiveInputRange());
    }

    function getReferenceInitial(ctx: ActiveContext, fallback: string): string {
        if (ctx.type === 'file') {
            const ext = ctx.label.split('.').pop();
            if (ext && ext !== ctx.label && ext.length <= 4) return ext.toUpperCase();
        }
        if (ctx.type === 'folder') return 'DIR';
        if (ctx.type === 'code_selection') return 'SEL';
        if (ctx.type === 'diagnostics') return 'ERR';
        return fallback.slice(0, 2).toUpperCase();
    }

    function buildReferenceChip(ctx: ActiveContext): HTMLElement {
        const meta = CONTEXT_TYPE_META[ctx.type] || CONTEXT_TYPE_META.file;
        const range = typeof ctx.startLine === 'number' && typeof ctx.endLine === 'number'
            ? ` #L${ctx.startLine}-${ctx.endLine}`
            : typeof ctx.line === 'number'
                ? ` #L${ctx.line + 1}`
                : '';
        const title = ctx.description || ctx.uri || ctx.label;
        const metaBits = [
            typeof ctx.tokenEstimate === 'number' && ctx.tokenEstimate > 0 ? `~${formatNum(ctx.tokenEstimate)} tok` : '',
            ctx.cacheStatus ? ctx.cacheStatus : '',
        ].filter(Boolean).join(' · ');
        const chip = document.createElement('span');
        chip.className = `reference-chip ref-${ctx.type}`;
        chip.contentEditable = 'false';
        chip.dataset.id = ctx.id;
        chip.dataset.label = ctx.label;
        chip.title = title;
        chip.innerHTML = `
            ${svgIconNoMargin(meta.icon)}
            <span class="ref-kind">${mrEscapeHtml(getReferenceInitial(ctx, meta.label))}</span>
            <span class="ref-text">${mrEscapeHtml(ctx.label)}${range}</span>
            ${metaBits ? `<span class="ref-meta">${mrEscapeHtml(metaBits)}</span>` : ''}
            <button class="remove-ctx-btn" data-id="${ctx.id}" aria-label="Remove reference">&times;</button>
        `;
        chip.querySelector('.remove-ctx-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = (e.currentTarget as HTMLElement).dataset.id;
            activeContexts = activeContexts.filter(c => c.id !== id);
            chip.remove();
            autoResizeInput();
            updateSendButtonState();
            input.focus();
        });
        return chip;
    }

    // ── Placeholder rotation ───────────────────────────────────────────────────
    const PROMPT_EXAMPLES = chatI18n.promptExamples;
    let placeholderIdx = Math.floor(Math.random() * PROMPT_EXAMPLES.length);
    let placeholderTimer: ReturnType<typeof setInterval> | null = null;

    function startPlaceholderRotation() {
        stopPlaceholderRotation();
        placeholderTimer = setInterval(() => {
            if (isInputEmpty() && !isGenerating) {
                placeholderIdx = (placeholderIdx + 1) % PROMPT_EXAMPLES.length;
                input.dataset.placeholder = PROMPT_EXAMPLES[placeholderIdx]!;
            }
        }, 6500);
    }
    function stopPlaceholderRotation() {
        if (placeholderTimer) { clearInterval(placeholderTimer); placeholderTimer = null; }
    }
    input.dataset.placeholder = PROMPT_EXAMPLES[placeholderIdx]!;
    startPlaceholderRotation();

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isGenerating) {
            vscode.postMessage({ type: 'cancelGeneration' });
        }
    });

    // ── Suggestion cards ───────────────────────────────────────────────────────
    document.querySelectorAll('.suggest-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const text = btn.getAttribute('data-suggest');
            if (text && !isGenerating) {
                setInputText(text);
                setTimeout(() => sendMessage(), 120);
            }
        });
    });

    // ── Dynamic Event Delegation for AI Options ─────────────────────────────────
    document.body.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const btn = target.closest('.ai-option-btn') as HTMLElement;
        if (btn) {
            const text = btn.getAttribute('data-suggest');
            if (text && !isGenerating) {
                appendInputText(text, '\n');
            }
        }
    });

    // ── Button logic ───────────────────────────────────────────────────────────
    sendBtn.addEventListener('click', () => {
        if (isGenerating && !hasComposerPayload()) {
            vscode.postMessage({ type: 'cancelGeneration' });
        } else {
            sendMessage();
        }
    });
    input.addEventListener('keydown', e => {
        if (handleSlashPopupKeydown(e)) return;
        if (_atPopupVisible && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape')) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionSelectedIndex(_mentionSelectedIndex + 1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionSelectedIndex(_mentionSelectedIndex - 1);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                if (acceptSelectedMention()) return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeAtPopup();
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isGenerating || hasComposerPayload()) sendMessage();
        }
    });
    input.addEventListener('input', () => {
        normalizeEmptyInput();
        syncContextsFromComposer();
        saveInputSelection();
        autoResizeInput();
        updateSendButtonState();
    });
    input.addEventListener('keyup', saveInputSelection);
    input.addEventListener('mouseup', saveInputSelection);
    input.addEventListener('focus', saveInputSelection);
    input.addEventListener('select', saveInputSelection);
    input.addEventListener('focus', stopPlaceholderRotation);
    input.addEventListener('blur', () => { if (isInputEmpty()) startPlaceholderRotation(); });

    function bindBtn(id: string, handler: () => void) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }

    function setArtifactDrawerOpen(open: boolean) {
        const drawer = document.getElementById('artifactDrawer');
        const toggle = document.getElementById('btnArtifacts');
        if (open) closeSideWorkspace({ preserveResponsivePin: true });
        document.body.classList.toggle('artifact-drawer-open', open);
        drawer?.setAttribute('aria-hidden', open ? 'false' : 'true');
        toggle?.classList.toggle('active', open);
        updateWorkspaceToggleState();
    }

    function toggleArtifactDrawer() {
        const nextOpen = !document.body.classList.contains('artifact-drawer-open');
        if (nextOpen) topicsPanel.classList.remove('show');
        setArtifactDrawerOpen(nextOpen);
    }

    function getSchedulingDomainSummary(): string {
        return schedulingState.domainProfile === 'general'
            ? tr('General', '通用')
            : schedulingState.domainProfile === 'hybrid' ? tr('Hybrid', '混合') : 'Paradox';
    }

    function applyComposerDomainLabels(): void {
        const quickDomainLabel = document.getElementById('quickDomainLabel');
        if (quickDomainLabel) quickDomainLabel.textContent = getSchedulingDomainSummary();
    }

    function closeComposerMenus() {
        const composerMenu = document.getElementById('composerMenu');
        const domainMenu = document.getElementById('domainMenu');
        const modelMenu = document.getElementById('modelMenu');
        const reasoningMenu = document.getElementById('reasoningMenu');
        const writeModeMenu = document.getElementById('writeModeMenu');
        const composerAddBtn = document.getElementById('composerAddBtn');
        const quickDomainTrigger = document.getElementById('quickDomainTrigger');
        const quickModelTrigger = document.getElementById('quickModelTrigger');
        const quickReasoningTrigger = document.getElementById('quickReasoningTrigger');
        const quickWriteModeTrigger = document.getElementById('quickWriteModeTrigger');
        composerMenu?.classList.remove('show');
        composerMenu?.setAttribute('aria-hidden', 'true');
        domainMenu?.classList.remove('show');
        domainMenu?.setAttribute('aria-hidden', 'true');
        modelMenu?.classList.remove('show');
        modelMenu?.setAttribute('aria-hidden', 'true');
        reasoningMenu?.classList.remove('show');
        reasoningMenu?.setAttribute('aria-hidden', 'true');
        writeModeMenu?.classList.remove('show');
        writeModeMenu?.setAttribute('aria-hidden', 'true');
        composerAddBtn?.classList.remove('active');
        quickDomainTrigger?.classList.remove('active');
        quickDomainTrigger?.setAttribute('aria-expanded', 'false');
        quickModelTrigger?.classList.remove('active');
        quickModelTrigger?.setAttribute('aria-expanded', 'false');
        quickReasoningTrigger?.classList.remove('active');
        quickReasoningTrigger?.setAttribute('aria-expanded', 'false');
        quickWriteModeTrigger?.classList.remove('active');
        quickWriteModeTrigger?.setAttribute('aria-expanded', 'false');
    }

    function setComposerMenuOpen(open: boolean) {
        const composerMenu = document.getElementById('composerMenu');
        const domainMenu = document.getElementById('domainMenu');
        const modelMenu = document.getElementById('modelMenu');
        const reasoningMenu = document.getElementById('reasoningMenu');
        const writeModeMenu = document.getElementById('writeModeMenu');
        const composerAddBtn = document.getElementById('composerAddBtn');
        const quickDomainTrigger = document.getElementById('quickDomainTrigger');
        const quickModelTrigger = document.getElementById('quickModelTrigger');
        const quickReasoningTrigger = document.getElementById('quickReasoningTrigger');
        const quickWriteModeTrigger = document.getElementById('quickWriteModeTrigger');
        composerMenu?.classList.toggle('show', open);
        composerMenu?.setAttribute('aria-hidden', open ? 'false' : 'true');
        composerAddBtn?.classList.toggle('active', open);
        if (open) positionComposerMenus();
        if (open) {
            domainMenu?.classList.remove('show');
            domainMenu?.setAttribute('aria-hidden', 'true');
            modelMenu?.classList.remove('show');
            modelMenu?.setAttribute('aria-hidden', 'true');
            reasoningMenu?.classList.remove('show');
            reasoningMenu?.setAttribute('aria-hidden', 'true');
            writeModeMenu?.classList.remove('show');
            writeModeMenu?.setAttribute('aria-hidden', 'true');
            quickModelTrigger?.classList.remove('active');
            quickModelTrigger?.setAttribute('aria-expanded', 'false');
            quickReasoningTrigger?.classList.remove('active');
            quickReasoningTrigger?.setAttribute('aria-expanded', 'false');
            quickDomainTrigger?.classList.remove('active');
            quickDomainTrigger?.setAttribute('aria-expanded', 'false');
            quickWriteModeTrigger?.classList.remove('active');
            quickWriteModeTrigger?.setAttribute('aria-expanded', 'false');
        }
    }

    function setDomainMenuOpen(open: boolean) {
        const domainMenu = document.getElementById('domainMenu');
        const quickDomainTrigger = document.getElementById('quickDomainTrigger');
        if (!domainMenu || !quickDomainTrigger) return;
        closeComposerMenus();
        domainMenu.classList.toggle('show', open);
        domainMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
        quickDomainTrigger.classList.toggle('active', open);
        quickDomainTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) positionComposerMenus();
    }

    function setModelMenuOpen(open: boolean) {
        const composerMenu = document.getElementById('composerMenu');
        const domainMenu = document.getElementById('domainMenu');
        const modelMenu = document.getElementById('modelMenu');
        const reasoningMenu = document.getElementById('reasoningMenu');
        const writeModeMenu = document.getElementById('writeModeMenu');
        const composerAddBtn = document.getElementById('composerAddBtn');
        const quickDomainTrigger = document.getElementById('quickDomainTrigger');
        const quickModelTrigger = document.getElementById('quickModelTrigger');
        const quickReasoningTrigger = document.getElementById('quickReasoningTrigger');
        const quickWriteModeTrigger = document.getElementById('quickWriteModeTrigger');
        modelMenu?.classList.toggle('show', open);
        modelMenu?.setAttribute('aria-hidden', open ? 'false' : 'true');
        quickModelTrigger?.classList.toggle('active', open);
        quickModelTrigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) positionComposerMenus();
        if (open) {
            composerMenu?.classList.remove('show');
            composerMenu?.setAttribute('aria-hidden', 'true');
            domainMenu?.classList.remove('show');
            domainMenu?.setAttribute('aria-hidden', 'true');
            reasoningMenu?.classList.remove('show');
            reasoningMenu?.setAttribute('aria-hidden', 'true');
            writeModeMenu?.classList.remove('show');
            writeModeMenu?.setAttribute('aria-hidden', 'true');
            composerAddBtn?.classList.remove('active');
            quickDomainTrigger?.classList.remove('active');
            quickDomainTrigger?.setAttribute('aria-expanded', 'false');
            quickReasoningTrigger?.classList.remove('active');
            quickReasoningTrigger?.setAttribute('aria-expanded', 'false');
            quickWriteModeTrigger?.classList.remove('active');
            quickWriteModeTrigger?.setAttribute('aria-expanded', 'false');
        }
    }

    function setReasoningMenuOpen(open: boolean) {
        const reasoningMenu = document.getElementById('reasoningMenu');
        const quickReasoningTrigger = document.getElementById('quickReasoningTrigger');
        if (!reasoningMenu || !quickReasoningTrigger) return;
        closeComposerMenus();
        reasoningMenu.classList.toggle('show', open);
        reasoningMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
        quickReasoningTrigger.classList.toggle('active', open);
        quickReasoningTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) positionComposerMenus();
    }

    function setWriteModeMenuOpen(open: boolean) {
        const composerMenu = document.getElementById('composerMenu');
        const domainMenu = document.getElementById('domainMenu');
        const modelMenu = document.getElementById('modelMenu');
        const reasoningMenu = document.getElementById('reasoningMenu');
        const writeModeMenu = document.getElementById('writeModeMenu');
        const composerAddBtn = document.getElementById('composerAddBtn');
        const quickDomainTrigger = document.getElementById('quickDomainTrigger');
        const quickModelTrigger = document.getElementById('quickModelTrigger');
        const quickReasoningTrigger = document.getElementById('quickReasoningTrigger');
        const quickWriteModeTrigger = document.getElementById('quickWriteModeTrigger');
        writeModeMenu?.classList.toggle('show', open);
        writeModeMenu?.setAttribute('aria-hidden', open ? 'false' : 'true');
        quickWriteModeTrigger?.classList.toggle('active', open);
        quickWriteModeTrigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) positionComposerMenus();
        if (open) {
            composerMenu?.classList.remove('show');
            composerMenu?.setAttribute('aria-hidden', 'true');
            domainMenu?.classList.remove('show');
            domainMenu?.setAttribute('aria-hidden', 'true');
            modelMenu?.classList.remove('show');
            modelMenu?.setAttribute('aria-hidden', 'true');
            reasoningMenu?.classList.remove('show');
            reasoningMenu?.setAttribute('aria-hidden', 'true');
            composerAddBtn?.classList.remove('active');
            quickDomainTrigger?.classList.remove('active');
            quickDomainTrigger?.setAttribute('aria-expanded', 'false');
            quickModelTrigger?.classList.remove('active');
            quickModelTrigger?.setAttribute('aria-expanded', 'false');
            quickReasoningTrigger?.classList.remove('active');
            quickReasoningTrigger?.setAttribute('aria-expanded', 'false');
        }
    }

    function positionComposerMenus(): void {
        if (!inputWrapper) return;
        const wrapperRect = inputWrapper.getBoundingClientRect();
        const composerMenu = document.getElementById('composerMenu') as HTMLElement | null;
        const domainMenu = document.getElementById('domainMenu') as HTMLElement | null;
        const modelMenu = document.getElementById('modelMenu') as HTMLElement | null;
        const reasoningMenu = document.getElementById('reasoningMenu') as HTMLElement | null;
        const writeModeMenu = document.getElementById('writeModeMenu') as HTMLElement | null;
        const composerAddBtn = document.getElementById('composerAddBtn') as HTMLElement | null;
        const quickDomainTrigger = document.getElementById('quickDomainTrigger') as HTMLElement | null;
        const quickModelTrigger = document.getElementById('quickModelTrigger') as HTMLElement | null;
        const quickReasoningTrigger = document.getElementById('quickReasoningTrigger') as HTMLElement | null;
        const quickWriteModeTrigger = document.getElementById('quickWriteModeTrigger') as HTMLElement | null;

        const positionMenu = (menu: HTMLElement | null, anchor: HTMLElement | null, alignment: 'start' | 'end' = 'start') => {
            if (!menu || !anchor) return;
            const anchorRect = anchor.getBoundingClientRect();
            const menuWidth = menu.offsetWidth || 260;
            const preferredLeft = alignment === 'end'
                ? anchorRect.right - wrapperRect.left - menuWidth
                : anchorRect.left - wrapperRect.left;
            const maxLeft = Math.max(12, wrapperRect.width - menuWidth - 12);
            menu.style.left = `${Math.max(12, Math.min(preferredLeft, maxLeft))}px`;
        };

        positionMenu(composerMenu, composerAddBtn);
        positionMenu(domainMenu, quickDomainTrigger);
        positionMenu(modelMenu, quickModelTrigger);
        positionMenu(reasoningMenu, quickReasoningTrigger, 'end');
        positionMenu(writeModeMenu, quickWriteModeTrigger);
    }

    function renderComposerChips() {
        const chipRow = document.getElementById('composerChipRow');
        if (!chipRow) return;
        chipRow.innerHTML = '';
        const quickDomainLabel = document.getElementById('quickDomainLabel');
        if (quickDomainLabel) quickDomainLabel.textContent = getSchedulingDomainSummary();

        if (activeWorkflowId) {
            const activeWorkflow = workflows.find(workflow => workflow.id === activeWorkflowId);
            const workflowChip = document.createElement('button');
            workflowChip.className = 'composer-chip workflow-chip';
            workflowChip.type = 'button';
            workflowChip.title = 'Turn off workflow';
            const label = activeWorkflow?.title || activeWorkflowId;
            const workflowIcon = document.createElement('span');
            workflowIcon.className = 'composer-chip-icon';
            workflowIcon.innerHTML = Icons.x;
            const workflowText = document.createElement('span');
            workflowText.textContent = label;
            workflowChip.append(workflowIcon, workflowText);
            workflowChip.addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({ type: 'switchWorkflow', workflowId: null });
            });
            chipRow.appendChild(workflowChip);
        }

        document.querySelectorAll<HTMLElement>('.composer-menu-item[data-scheduling-domain]').forEach(item => {
            item.classList.toggle('active', item.dataset.schedulingDomain === schedulingState.domainProfile);
        });
    }

    function renderQuickModelMenu() {
        const label = document.getElementById('quickModelLabel');
        const list = document.getElementById('modelMenuList');
        const trigger = document.getElementById('quickModelTrigger');
        if (label) label.textContent = quickModelCurrent || 'Model';
        if (trigger) trigger.title = quickModelCurrent ? `Model: ${quickModelCurrent}` : 'Select model';
        if (!list) return;
        list.innerHTML = '';

        if (!quickModelOptions.length) {
            const empty = document.createElement('div');
            empty.className = 'model-menu-empty';
            empty.textContent = 'No models available';
            list.appendChild(empty);
            return;
        }

        for (const model of quickModelOptions) {
            const btn = document.createElement('button');
            btn.className = 'model-menu-item';
            btn.type = 'button';
            btn.textContent = model;
            btn.classList.toggle('active', model === quickModelCurrent);
            btn.addEventListener('click', () => {
                const qms = document.getElementById('quickModelSelect') as HTMLSelectElement | null;
                if (qms) qms.value = model;
                quickModelCurrent = model;
                renderQuickModelMenu();
                updateQuickReasoningControls(cachedSettingsData?.current?.provider || '', model);
                setModelMenuOpen(false);
                vscode.postMessage({ type: 'quickChangeModel', model });
            });
            list.appendChild(btn);
        }
    }

    const REASONING_VALUES = new Set<ReasoningEffortValue>([
        'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);

    function isReasoningEffortValue(value: unknown): value is ReasoningEffortValue {
        return typeof value === 'string' && REASONING_VALUES.has(value as ReasoningEffortValue);
    }

    function reasoningCapabilityFor(providerId: string, model: string): ReasoningCapabilityView {
        return settingsReasoningCapabilities[`${providerId}:${model}`] ?? {
            kind: 'none',
            options: [],
            defaultValue: 'high',
        };
    }

    function reasoningOptionLabel(value: ReasoningEffortValue, kind: ReasoningCapabilityView['kind']): string {
        if (kind === 'toggle') {
            return value === 'none' ? tr('Thinking off', '关闭思考') : tr('Thinking on', '开启思考');
        }
        const labels: Record<ReasoningEffortValue, [string, string]> = {
            none: ['Off', '关闭'],
            minimal: ['Minimal', '最少'],
            low: ['Low', '低'],
            medium: ['Medium', '中'],
            high: ['High', '高'],
            xhigh: ['XHigh', '超高'],
            max: ['Max', '最大'],
        };
        const [en, zh] = labels[value];
        return tr(en, zh);
    }

    function selectReasoningValue(capability: ReasoningCapabilityView, requested: unknown): ReasoningEffortValue {
        if (isReasoningEffortValue(requested) && capability.options.includes(requested)) return requested;
        if (requested === 'max' || requested === 'xhigh') {
            if (capability.options.includes('max')) return 'max';
            if (capability.options.includes('xhigh')) return 'xhigh';
            if (capability.options.includes('high')) return 'high';
        }
        return capability.options.includes(capability.defaultValue)
            ? capability.defaultValue
            : capability.options[0] ?? 'high';
    }

    function populateReasoningSelect(
        select: HTMLSelectElement,
        capability: ReasoningCapabilityView,
        requested: unknown
    ): ReasoningEffortValue {
        const selected = selectReasoningValue(capability, requested);
        select.innerHTML = '';
        for (const value of capability.options) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = reasoningOptionLabel(value, capability.kind);
            option.selected = value === selected;
            select.appendChild(option);
        }
        select.disabled = capability.kind === 'fixed' || capability.kind === 'none';
        select.value = selected;
        return selected;
    }

    function updateSettingsReasoningControls(providerId: string, model: string, requested?: unknown): void {
        const capability = reasoningCapabilityFor(providerId, model);
        const group = document.getElementById('settingsReasoningGroup');
        const select = document.getElementById('settingsReasoningEffort') as HTMLSelectElement | null;
        const label = document.getElementById('settingsReasoningLabel');
        const hint = document.getElementById('settingsReasoningHint');
        if (!select) return;
        const selected = populateReasoningSelect(
            select,
            capability,
            requested ?? select.value ?? select.dataset.requested
        );
        select.dataset.requested = selected;
        if (group) group.style.display = capability.kind === 'none' ? 'none' : '';
        if (label) {
            label.textContent = capability.kind === 'toggle' || capability.kind === 'fixed'
                ? tr('Thinking mode', '思考模式')
                : capability.kind === 'budget'
                    ? tr('Thinking budget', '思考预算')
                    : tr('Reasoning effort', '推理强度');
        }
        if (hint) {
            hint.textContent = capability.kind === 'fixed'
                ? tr('(always on for this model)', '（该模型始终开启）')
                : capability.kind === 'toggle'
                    ? tr('(this API exposes only an on/off switch)', '（该接口仅提供开关）')
                    : '';
        }
    }

    function updateQuickReasoningControls(providerId: string, model: string, requested?: unknown): void {
        const capability = reasoningCapabilityFor(providerId, model);
        const select = document.getElementById('quickReasoningEffort') as HTMLSelectElement | null;
        const trigger = document.getElementById('quickReasoningTrigger') as HTMLButtonElement | null;
        if (select) quickReasoningEffort = populateReasoningSelect(select, capability, requested ?? quickReasoningEffort);
        if (trigger) {
            trigger.style.display = capability.kind === 'none' ? 'none' : '';
            trigger.disabled = capability.kind === 'fixed';
        }
        renderQuickReasoningMenu();
    }

    function renderQuickReasoningMenu(): void {
        const select = document.getElementById('quickReasoningEffort') as HTMLSelectElement | null;
        const label = document.getElementById('quickReasoningLabel');
        const trigger = document.getElementById('quickReasoningTrigger');
        const list = document.getElementById('reasoningMenuList');
        if (select) select.value = quickReasoningEffort;
        const selectedLabel = select?.selectedOptions[0]?.textContent || quickReasoningEffort;
        if (label) label.textContent = selectedLabel;
        if (trigger) {
            trigger.title = chatI18n.locale === 'zh-cn'
                ? `推理强度：${selectedLabel}`
                : `Reasoning effort: ${selectedLabel}`;
        }
        if (!list || !select) return;
        list.innerHTML = '';
        for (const option of Array.from(select.options)) {
            if (!isReasoningEffortValue(option.value)) continue;
            const item = document.createElement('button');
            item.className = 'model-menu-item';
            item.type = 'button';
            item.setAttribute('role', 'option');
            item.dataset.reasoningEffort = option.value;
            item.textContent = option.textContent;
            const active = option.value === quickReasoningEffort;
            item.classList.toggle('active', active);
            item.setAttribute('aria-selected', active ? 'true' : 'false');
            item.addEventListener('click', () => {
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                setReasoningMenuOpen(false);
            });
            list.appendChild(item);
        }
    }

    /** Map host settings to the quick ladder tier: confirm < auto < auto_review < full. */
    function deriveWriteTier(current: any): 'confirm' | 'auto' | 'auto_review' | 'full' {
        settingsSandboxDisabled = current?.securitySandboxDisabled === true;
        if (settingsSandboxDisabled) return 'full';
        const writeMode = current?.agentFileWriteMode === 'auto' ? 'auto' : 'confirm';
        if (writeMode === 'auto' && current?.approvals?.reviewer === 'auto_review') return 'auto_review';
        return writeMode;
    }

    function updateQuickWriteModeSelector(mode: 'confirm' | 'auto' | 'auto_review' | 'full' | string | undefined): void {
        quickWriteMode = mode === 'auto' || mode === 'auto_review' || mode === 'full' ? mode : 'confirm';
        const select = document.getElementById('quickWriteModeSelect') as HTMLSelectElement | null;
        if (select) select.value = quickWriteMode;
        const label = document.getElementById('quickWriteModeLabel');
        const trigger = document.getElementById('quickWriteModeTrigger');
        const display = getQuickWriteModeLabel(quickWriteMode);
        if (label) label.textContent = display;
        if (trigger) {
            trigger.classList.toggle('write-mode-elevated', quickWriteMode === 'auto_review');
            trigger.classList.toggle('write-mode-danger', quickWriteMode === 'full');
            trigger.title = (chatI18n.locale === 'zh-cn' ? `权限配置：${display}` : `Permission profile: ${display}`)
                + (getQuickWriteModeDesc(quickWriteMode) ? ` — ${getQuickWriteModeDesc(quickWriteMode)}` : '');
            trigger.dataset.baseTitle = trigger.title;
        }
        renderQuickWriteModeMenu();
    }

    function getQuickWriteModeLabel(mode: 'confirm' | 'auto' | 'auto_review' | 'full'): string {
        if (chatI18n.locale === 'zh-cn') {
            if (mode === 'full') return '完全放行';
            return mode === 'auto_review' ? '自动审核' : mode === 'auto' ? '自动写入' : '确认写入';
        }
        if (mode === 'full') return 'Full access';
        return mode === 'auto_review' ? 'Auto review' : mode === 'auto' ? 'Auto write' : 'Confirm write';
    }

    function getQuickWriteModeDesc(mode: 'confirm' | 'auto' | 'auto_review' | 'full'): string {
        if (chatI18n.locale === 'zh-cn') {
            if (mode === 'full') return '仅当前工作区会话解除沙箱与审批边界（高危，关闭 VS Code 后失效）';
            if (mode === 'auto_review') return '自动审核原本需要审批的操作；可能批准或拒绝，并会增加模型调用';
            if (mode === 'auto') return '文件直接写入；风险操作仍询问';
            return '写入前出 diff 确认';
        }
        if (mode === 'full') return 'Removes sandbox and approval boundaries for this workspace session only (dangerous)';
        if (mode === 'auto_review') return 'Automatically reviews actions that require approval; it may allow or deny them and uses extra model calls';
        if (mode === 'auto') return 'Files write directly; risky calls still ask';
        return 'Diff confirmation before writes';
    }

    function renderQuickWriteModeMenu(): void {
        const list = document.getElementById('writeModeMenuList');
        const title = document.getElementById('writeModeMenuTitle');
        if (title) title.textContent = chatI18n.locale === 'zh-cn' ? '权限配置' : 'Permission profile';
        if (!list) return;
        list.innerHTML = '';
        (['confirm', 'auto', 'auto_review', 'full'] as const).forEach(mode => {
            const btn = document.createElement('button');
            btn.className = 'model-menu-item model-menu-item-stacked';
            if (mode === 'auto_review') btn.classList.add('write-mode-item-elevated');
            if (mode === 'full') btn.classList.add('write-mode-item-danger');
            btn.type = 'button';
            const nameEl = document.createElement('span');
            nameEl.textContent = getQuickWriteModeLabel(mode);
            const descEl = document.createElement('span');
            descEl.className = 'write-mode-item-desc';
            descEl.textContent = getQuickWriteModeDesc(mode);
            btn.appendChild(nameEl);
            btn.appendChild(descEl);
            btn.classList.toggle('active', mode === quickWriteMode);
            btn.addEventListener('click', () => {
                if (mode === 'full' && quickWriteMode !== 'full' && Date.now() > fullAccessArmedUntil) {
                    fullAccessArmedUntil = Date.now() + 10_000;
                    nameEl.textContent = tr('Confirm Full access', '确认完全放行');
                    descEl.textContent = tr('Click again within 10 seconds to remove sandbox and approval boundaries for this workspace session.', '请在 10 秒内再次点击，以解除当前工作区会话的沙箱与审批边界。');
                    btn.focus();
                    return;
                }
                fullAccessArmedUntil = 0;
                updateQuickWriteModeSelector(mode);
                syncSettingsControlsToWriteTier();
                refreshSettingsOverview();
                setWriteModeMenuOpen(false);
                input.focus();
                vscode.postMessage({ type: 'quickChangeWriteMode', mode: quickWriteMode });
            });
            list.appendChild(btn);
        });
    }

    /** Mirror the quick ladder into the settings-page controls so both stay coherent. */
    function syncSettingsControlsToWriteTier(): void {
        const agentWriteMode = document.getElementById('agentWriteMode') as HTMLSelectElement | null;
        if (agentWriteMode) agentWriteMode.value = quickWriteMode === 'confirm' ? 'confirm' : 'auto';
        const autoReviewEl = document.getElementById('approvalsAutoReview') as HTMLInputElement | null;
        if (autoReviewEl) autoReviewEl.checked = quickWriteMode === 'auto_review';
        settingsSandboxDisabled = quickWriteMode === 'full';
    }

    const quickModelSel = document.getElementById('quickModelSelect');
    if (quickModelSel) {
        quickModelSel.addEventListener('change', () => {
            quickModelCurrent = (quickModelSel as HTMLSelectElement).value;
            renderQuickModelMenu();
            updateQuickReasoningControls(cachedSettingsData?.current?.provider || '', quickModelCurrent);
            vscode.postMessage({ type: 'quickChangeModel', model: quickModelCurrent });
        });
    }

    const quickReasoningSel = document.getElementById('quickReasoningEffort') as HTMLSelectElement | null;
    quickReasoningSel?.addEventListener('change', () => {
        const effort = quickReasoningSel.value;
        if (!isReasoningEffortValue(effort)) return;
        quickReasoningEffort = effort;
        renderQuickReasoningMenu();
        vscode.postMessage({ type: 'quickChangeReasoningEffort', effort });
    });

    const quickWriteModeSel = document.getElementById('quickWriteModeSelect') as HTMLSelectElement | null;
    if (quickWriteModeSel) {
        quickWriteModeSel.addEventListener('change', () => {
            updateQuickWriteModeSelector(quickWriteModeSel.value);
            syncSettingsControlsToWriteTier();
            refreshSettingsOverview();
            vscode.postMessage({ type: 'quickChangeWriteMode', mode: quickWriteMode });
        });
    }

    const quickWriteModeTrigger = document.getElementById('quickWriteModeTrigger');
    quickWriteModeTrigger?.addEventListener('click', e => {
        e.stopPropagation();
        const writeModeMenu = document.getElementById('writeModeMenu');
        setWriteModeMenuOpen(!writeModeMenu?.classList.contains('show'));
    });
    renderQuickWriteModeMenu();

    if (chatI18n.locale !== 'zh-cn' && quickWriteModeSel) {
        const confirmOption = quickWriteModeSel.querySelector<HTMLOptionElement>('option[value="confirm"]');
        const autoOption = quickWriteModeSel.querySelector<HTMLOptionElement>('option[value="auto"]');
        const autoReviewOption = quickWriteModeSel.querySelector<HTMLOptionElement>('option[value="auto_review"]');
        const fullOption = quickWriteModeSel.querySelector<HTMLOptionElement>('option[value="full"]');
        if (confirmOption) confirmOption.textContent = 'Confirm';
        if (autoOption) autoOption.textContent = 'Auto';
        if (autoReviewOption) autoReviewOption.textContent = 'Auto review';
        if (fullOption) fullOption.textContent = 'Full access';
        quickWriteModeSel.title = 'Permission profile';
        quickWriteModeSel.setAttribute('aria-label', 'Permission profile');
    }

    applyComposerDomainLabels();
    renderQuickReasoningMenu();

    const composerAddBtn = document.getElementById('composerAddBtn');
    const quickDomainTrigger = document.getElementById('quickDomainTrigger');
    const quickModelTrigger = document.getElementById('quickModelTrigger');
    const quickReasoningTrigger = document.getElementById('quickReasoningTrigger');
    composerAddBtn?.addEventListener('click', e => {
        e.stopPropagation();
        const composerMenu = document.getElementById('composerMenu');
        setComposerMenuOpen(!composerMenu?.classList.contains('show'));
    });
    quickModelTrigger?.addEventListener('click', e => {
        e.stopPropagation();
        const modelMenu = document.getElementById('modelMenu');
        setModelMenuOpen(!modelMenu?.classList.contains('show'));
    });
    quickReasoningTrigger?.addEventListener('click', e => {
        e.stopPropagation();
        const reasoningMenu = document.getElementById('reasoningMenu');
        setReasoningMenuOpen(!reasoningMenu?.classList.contains('show'));
    });
    quickDomainTrigger?.addEventListener('click', e => {
        e.stopPropagation();
        const domainMenu = document.getElementById('domainMenu');
        setDomainMenuOpen(!domainMenu?.classList.contains('show'));
    });
    const updateSchedulingDomain = (domain: SchedulingDomain) => {
        vscode.postMessage({ type: 'switchSchedulingDomain', domain });
    };
    document.querySelectorAll<HTMLElement>('.composer-menu-item[data-scheduling-domain]').forEach(item => {
        item.addEventListener('click', () => {
            const domain = item.dataset.schedulingDomain;
            if (domain === 'paradox' || domain === 'general' || domain === 'hybrid') {
                updateSchedulingDomain(domain);
                setDomainMenuOpen(false);
            }
        });
    });
    document.querySelectorAll<HTMLElement>('.composer-menu-item[data-composer-action]').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.composerAction;
            setComposerMenuOpen(false);
            if (action === 'media') {
                document.getElementById('imgPickBtn')?.click();
            } else if (action === 'mentions') {
                insertPlainTextAtRange('@');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (action === 'workflows') {
                setInputText('/workflow:');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (action === 'goal') {
                setInputText('/goal ');
                input.focus();
            }
        });
    });
    const headerMore = document.getElementById('headerMore');
    headerMore?.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('button')) headerMore.removeAttribute('open');
    });
    document.addEventListener('click', e => {
        const target = e.target as Element | null;
        if (!target?.closest('#headerMore')) headerMore?.removeAttribute('open');
        if (!target?.closest('#composerMenu') && !target?.closest('#composerAddBtn') && !target?.closest('#domainMenu') && !target?.closest('#quickDomainTrigger') && !target?.closest('#modelMenu') && !target?.closest('#quickModelTrigger') && !target?.closest('#reasoningMenu') && !target?.closest('#quickReasoningTrigger') && !target?.closest('#writeModeMenu') && !target?.closest('#quickWriteModeTrigger')) {
            closeComposerMenus();
        }
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeComposerMenus();
        if (e.key === 'Escape' && headerMore?.hasAttribute('open')) {
            headerMore.removeAttribute('open');
            headerMore.querySelector('summary')?.focus();
        }
    });

    bindBtn('btnNewTopic', () => vscode.postMessage({ type: 'newTopic' }));
    bindBtn('currentTopicTitle', () => {
        if (currentTopicId) startTopicRename(currentTopicId, currentTopicTitle, 'header');
    });
    bindBtn('currentTopicRename', () => {
        if (currentTopicId) startTopicRename(currentTopicId, currentTopicTitle, 'header');
    });
    bindBtn('btnWorkspace', openWorkspaceFromButton);
    bindBtn('btnArtifacts', toggleArtifactDrawer);
    bindBtn('btnAgentManager', () => vscode.postMessage({ type: 'openAgentManager' }));
    bindBtn('btnCloseArtifacts', () => setArtifactDrawerOpen(false));
    bindBtn('artifactScrim', () => setArtifactDrawerOpen(false));
    document.querySelectorAll<HTMLElement>('[data-artifact-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.artifactFilter;
            artifactFilter = (next === 'plan' || next === 'validation' || next === 'diff') ? next : 'all';
            renderArtifactPanel();
        });
    });
    bindBtn('btnTopics', () => {
        if (isManagerTopicsRailMode()) {
            const collapsed = !document.body.classList.contains('manager-topics-collapsed');
            document.body.classList.toggle('manager-topics-collapsed', collapsed);
            updateManagerTopicsToggleState();
            updateComposerStackHeight();
            positionComposerMenus();
            return;
        }
        setArtifactDrawerOpen(false);
        if (shouldUseSideWorkspace()) {
            if (document.body.classList.contains('side-workspace-open') && sideWorkspaceContent === topicsPanel) {
                closeSideWorkspace();
                return;
            }
            topicsPanel.classList.add('show');
            openSideWorkspace({
                title: chatI18n.locale === 'zh-cn' ? '历史话题' : 'Topic History',
                subtitle: chatI18n.locale === 'zh-cn' ? '搜索、切换和管理对话' : 'Search, switch, and manage conversations',
                content: topicsPanel,
            });
            return;
        }
        closeSideWorkspace();
        topicsPanel.classList.toggle('show');
        updateWorkspaceToggleState();
        updateManagerTopicsToggleState();
    });
    bindBtn('btnNewTopicPanel', () => { vscode.postMessage({ type: 'newTopic' }); topicsPanel.classList.remove('show'); if (sideWorkspaceContent === topicsPanel) closeSideWorkspace(); });
    updateManagerTopicsToggleState();
    bindBtn('btnSettings', () => {
        if (!isManagerShell()) {
            setArtifactDrawerOpen(false);
        } else {
            document.body.classList.add('artifact-drawer-open');
        }
        if (cachedSettingsData) {
            showSettingsPage(cachedSettingsData.providers, cachedSettingsData.current, cachedSettingsData.ollamaModels);
        }
        vscode.postMessage({ type: 'openSettings' });
        topicsPanel.classList.remove('show');
    });
    bindBtn('settingsBackBtn', closeSettings);
    bindBtn('sideWorkspaceClose', closeSideWorkspace);
    bindBtn('testConnBtn', testConnection);
    bindBtn('saveSettingsBtn', saveSettings);
    bindBtn('resetSettingsBtn', () => {
        if (!cachedSettingsData) return;
        lastSettingsPageSignature = '';
        showSettingsPage(cachedSettingsData.providers, cachedSettingsData.current, cachedSettingsData.ollamaModels);
    });
    bindBtn('keyToggleBtn', () => { const k = document.getElementById('settingsApiKey') as HTMLInputElement | null; if (k) k.type = k.type === 'password' ? 'text' : 'password'; });
    bindBtn('fetchApiModelsBtn', () => { fetchApiModels(); });
    bindBtn('deleteApiKeyBtn', () => { deleteApiKey(); });
    bindBtn('codexLoginBtn', () => {
        vscode.postMessage({ type: 'codexLogin' });
    });
    bindBtn('codexRefreshBtn', () => {
        vscode.postMessage({ type: 'codexRefreshAccount' });
    });
    bindBtn('codexLogoutBtn', () => {
        vscode.postMessage({ type: 'codexLogout' });
    });
    bindBtn('antigravityLoginBtn', () => vscode.postMessage({ type: 'antigravityLogin' }));
    bindBtn('antigravityRefreshBtn', () => vscode.postMessage({ type: 'antigravityRefreshAccount' }));
    bindBtn('antigravityLogoutBtn', () => vscode.postMessage({ type: 'antigravityLogout' }));
    document.getElementById('subscriptionProxyMode')?.addEventListener('change', updateSubscriptionProxyUrlVisibility);
    bindBtn('subscriptionProxySaveBtn', () => {
        const mode = document.getElementById('subscriptionProxyMode');
        const input = document.getElementById('subscriptionProxyUrl');
        if (!(mode instanceof HTMLSelectElement) || !isSubscriptionProxyMode(mode.value)) return;
        const url = input instanceof HTMLInputElement && mode.value === 'custom' ? input.value.trim() : '';
        setSubscriptionProxyBusy(true);
        vscode.postMessage({ type: 'saveSubscriptionProxy', mode: mode.value, url: url || undefined });
    });
    bindBtn('subscriptionProxyRefreshBtn', () => {
        setSubscriptionProxyBusy(true);
        vscode.postMessage({ type: 'refreshSubscriptionProxy' });
    });
    bindBtn('detectBtn', detectOllamaModels);
    
    bindBtn('installSkillBtn', () => {
        const source = (document.getElementById('skillSourceInput') as HTMLInputElement).value.trim();
        if (source) {
            const btn = document.getElementById('installSkillBtn') as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = tr('Installing...', '安装中...');
            vscode.postMessage({ type: 'installSkill', source });
        }
    });
    bindBtn('accChat', () => toggleAccordion('chatModelSection'));
    bindBtn('accTranslationPreview', () => toggleAccordion('translationPreviewSection'));
    bindBtn('accInline', () => toggleAccordion('inlineSection'));
    bindBtn('accMcp', () => toggleAccordion('mcpSection'));
    bindBtn('accAgent', () => toggleAccordion('agentSection'));
    bindBtn('accAgentProfiles', () => toggleAccordion('agentProfilesSection'));
    bindBtn('accWeb', () => toggleAccordion('webSection'));
    bindBtn('accSkills', () => toggleAccordion('skillsSection'));
    bindBtn('addMcpServerBtn', () => addMcpServerBlock());
    bindBtn('accUsage', () => { toggleAccordion('usageSection'); vscode.postMessage({ type: 'requestUsageStats' }); });
    bindBtn('refreshUsageBtn', () => vscode.postMessage({ type: 'requestUsageStats' }));
    bindBtn('clearUsageBtn', () => {
        vscode.postMessage({ type: 'promptClearUsageStats' });
    });

    if (settingsPage) {
        settingsTabs.forEach(tab => {
            tab.addEventListener('click', () => selectSettingsTab(tab));
            tab.addEventListener('keydown', event => {
                const index = settingsTabs.indexOf(tab);
                const nextIndex = event.key === 'Home' ? 0
                    : event.key === 'End' ? settingsTabs.length - 1
                    : event.key === 'ArrowRight' ? (index + 1) % settingsTabs.length
                    : event.key === 'ArrowLeft' ? (index + settingsTabs.length - 1) % settingsTabs.length
                    : -1;
                const next = settingsTabs[nextIndex];
                if (!next) return;
                event.preventDefault();
                selectSettingsTab(next);
                next.focus();
            });
        });
        settingsPage.addEventListener('click', event => {
            if (!(event.target instanceof Element)) return;
            const toggle = event.target.closest<HTMLButtonElement>('[data-settings-key-toggle]');
            const input = toggle?.dataset.settingsKeyToggle ? document.getElementById(toggle.dataset.settingsKeyToggle) : null;
            if (input instanceof HTMLInputElement) input.type = input.type === 'password' ? 'text' : 'password';
        });
        settingsPage.addEventListener('input', () => {
            if (settingsPage.classList.contains('active')) refreshSettingsOverview();
            settingsSavePending = false;
            refreshSettingsDraftStatus();
        });
        settingsPage.addEventListener('change', event => {
            const targetId = (event.target as HTMLElement | null)?.id;
            if (targetId === 'settingsReasoningEffort') {
                const reasoningSelect = event.target as HTMLSelectElement;
                reasoningSelect.dataset.requested = reasoningSelect.value;
            }
            if ((targetId === 'agentWriteMode' || targetId === 'approvalsAutoReview') && !settingsSandboxDisabled) {
                // While the 'full' tier is active the ladder is the only exit — the page
                // controls don't persist the sandbox flag, so they must not repaint the tier.
                const writeSel = document.getElementById('agentWriteMode') as HTMLSelectElement | null;
                const autoReviewEl = document.getElementById('approvalsAutoReview') as HTMLInputElement | null;
                const base = writeSel?.value || 'confirm';
                updateQuickWriteModeSelector(base === 'auto' && autoReviewEl?.checked ? 'auto_review' : base);
            }
            if (settingsPage.classList.contains('active')) refreshSettingsOverview();
            settingsSavePending = false;
            refreshSettingsDraftStatus();
        });
    }

    function selectSettingsTab(tab: HTMLButtonElement): void {
        const category = tab.dataset.settingsTab;
        if (!category) return;
        if (settingsBody) settingsTabScroll[activeSettingsTab] = settingsBody.scrollTop;
        activeSettingsTab = category;
        settingsTabs.forEach(button => {
            const selected = button === tab;
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        settingsPage.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach(panel => {
            panel.hidden = panel.dataset.settingsPanel !== category;
        });
        const testButton = document.getElementById('testConnBtn');
        if (testButton) testButton.hidden = category !== 'models';
        if (settingsBody) settingsBody.scrollTop = settingsTabScroll[category] ?? 0;
        if (category === 'usage') vscode.postMessage({ type: 'requestUsageStats' });
    }

    function settingsFormSignature(): string {
        return JSON.stringify(Array.from(settingsPage.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'))
            .filter(field => field.id !== 'skillSourceInput' && !field.closest('#subscriptionProxyGroup'))
            .map(field => [field.id || field.className, field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value]));
    }

    function refreshSettingsDraftStatus(): void {
        if (settingsFormBaseline === null) return;
        const dirty = settingsFormSignature() !== settingsFormBaseline;
        const status = document.getElementById('settingsSaveStatus');
        const actions = document.getElementById('settingsSaveActions');
        if (actions) actions.hidden = !dirty;
        if (status) status.textContent = settingsSavePending ? chatI18n.settings.saveRequested
            : dirty ? chatI18n.settings.unsaved : chatI18n.settings.saved;
    }

    // ── Topic search (debounced 300ms) ─────────────────────────────────────────
    (() => {
        const si = document.getElementById('topicsSearch') as HTMLInputElement | null;
        if (!si) return;
        let _timer: ReturnType<typeof setTimeout> | null = null;
        si.addEventListener('input', () => {
            if (_timer) clearTimeout(_timer);
            _timer = setTimeout(() => {
                vscode.postMessage({ type: 'searchTopics', query: si.value.trim() });
            }, 300);
        });
        si.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                si.value = '';
                vscode.postMessage({ type: 'searchTopics', query: '' });
            }
        });
    })();

    // ── Export current topic as Markdown ───────────────────────────────────────
    bindBtn('btnExportTopic', () => {
        vscode.postMessage({ type: 'exportTopic', topicId: undefined });
        topicsPanel.classList.remove('show');
        if (sideWorkspaceContent === topicsPanel) closeSideWorkspace();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && document.body.classList.contains('artifact-drawer-open')) {
            setArtifactDrawerOpen(false);
        } else if (e.key === 'Escape' && document.body.classList.contains('side-workspace-open')) {
            closeSideWorkspace();
        }
    });
    renderArtifactPanel();


    // ── Slash command popup ────────────────────────────────────────────────────
    const slashPopup = document.getElementById('slashPopup');
    let slashMatches: SlashCommandView[] = [];
    let slashSelectedIndex = 0;

    function positionComposerSuggestionPopup(popup: HTMLElement): void {
        const composer = document.querySelector<HTMLElement>('.input-container');
        if (!composer) return;
        const rect = composer.getBoundingClientRect();
        popup.style.left = `${Math.max(12, rect.left)}px`;
        popup.style.right = 'auto';
        popup.style.width = `${Math.max(0, rect.width)}px`;
        popup.style.top = 'auto';
        popup.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 8)}px`;
        popup.style.maxHeight = `${Math.min(360, Math.max(80, rect.top - 20))}px`;
    }

    function setSlashPopupOpen(open: boolean): void {
        if (open && slashPopup) positionComposerSuggestionPopup(slashPopup);
        slashPopup?.classList.toggle('show', open);
        slashPopup?.setAttribute('aria-hidden', open ? 'false' : 'true');
        input.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) input.removeAttribute('aria-activedescendant');
    }

    function renderSlashPopup(): void {
        if (!slashPopup) return;
        slashPopup.innerHTML = renderSlashCommandItems(slashMatches, slashSelectedIndex);
        if (slashMatches.length > 0) {
            input.setAttribute('aria-activedescendant', `slash-option-${slashSelectedIndex}`);
        }
    }

    function showSlashPopup(filter: string) {
        if (!slashPopup) return;
        slashMatches = filterSlashCommands(
            buildSlashCommands(slashCommandCatalog, workflows),
            filter,
        );
        slashSelectedIndex = 0;
        if (!slashMatches.length) {
            setSlashPopupOpen(false);
            return;
        }
        renderSlashPopup();
        setSlashPopupOpen(true);
    }

    function setSlashSelectedIndex(index: number): void {
        if (slashMatches.length === 0) return;
        slashSelectedIndex = (index + slashMatches.length) % slashMatches.length;
        renderSlashPopup();
        slashPopup?.querySelector(`#slash-option-${slashSelectedIndex}`)?.scrollIntoView({ block: 'nearest' });
    }

    function acceptSlashCommand(index = slashSelectedIndex): boolean {
        const command = slashMatches[index];
        if (!command) return false;
        setSlashPopupOpen(false);
        setInputText(command.completion === 'insert' ? `${command.command} ` : command.command);
        if (command.completion === 'execute') sendMessage();
        return true;
    }

    function handleSlashPopupKeydown(event: KeyboardEvent): boolean {
        if (!slashPopup?.classList.contains('show')) return false;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSlashSelectedIndex(slashSelectedIndex + 1);
            return true;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSlashSelectedIndex(slashSelectedIndex - 1);
            return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            return acceptSlashCommand();
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setSlashPopupOpen(false);
            return true;
        }
        return false;
    }

    slashPopup?.addEventListener('click', event => {
        const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('.slash-popup-item');
        if (!item) return;
        const index = Number(item.dataset.index);
        if (Number.isInteger(index)) acceptSlashCommand(index);
    });

    input.addEventListener('input', () => {
        autoResizeInput();
        const v = getInputText();
        const slashFilter = getSlashCommandFilter(v);
        if (slashFilter !== null) showSlashPopup(slashFilter);
        else setSlashPopupOpen(false);
        const mentionFilter = getMentionFilterBeforeCaret();
        if (mentionFilter !== null) {
            showAtPopup(mentionFilter);
        } else {
            closeAtPopup();
        }
    });
    document.addEventListener('click', e => { if (slashPopup && !slashPopup.contains(e.target as Node) && e.target !== input && e.target !== activeComposerEl) setSlashPopupOpen(false); });
    document.addEventListener('click', e => { const t = e.target as HTMLElement; if (t && !t.closest('#atPopup') && t !== input && t !== activeComposerEl) closeAtPopup(); });

    // ── @ file mention popup ───────────────────────────────────────────────────
    const atPopup = (() => {
        const el = document.createElement('div');
        el.id = 'atPopup';
        el.className = 'slash-popup mention-popup';
        document.body.appendChild(el);
        return el;
    })();
    let _atPopupVisible = false;

    let _mentionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let _mentionResults: MentionResult[] = [];
    let _mentionSelectedIndex = 0;

    function showAtPopup(filter: string) {
        if (!atPopup) return;
        const q = filter.trim();

        if (_mentionDebounceTimer) clearTimeout(_mentionDebounceTimer);
        _mentionDebounceTimer = setTimeout(() => {
            vscode.postMessage({ type: 'requestMentionSearch', query: q });
        }, q ? 200 : 0);
    }

    function renderMentionMenu(results: MentionResult[]) {
        if (!atPopup) return;
        _mentionResults = results;
        _mentionSelectedIndex = 0;
        if (results.length === 0) {
            atPopup.style.display = 'none';
            atPopup.classList.remove('show');
            _atPopupVisible = false;
            return;
        }

        const groups = new Map<string, Array<{ res: MentionResult; index: number }>>();
        results.forEach((res, index) => {
            const type = res.type || 'file';
            const label = CONTEXT_TYPE_META[type]?.label || 'file';
            const items = groups.get(label) || [];
            items.push({ res, index });
            groups.set(label, items);
        });

        atPopup.innerHTML = Array.from(groups.entries()).map(([groupLabel, items]) => {
            const itemsHtml = items.map(({ res, index }) => {
                const type = res.type || 'file';
                const meta = CONTEXT_TYPE_META[type] || CONTEXT_TYPE_META.file;
                const detailBits = [
                    res.tokenEstimate ? `~${formatNum(res.tokenEstimate)} tok` : '',
                    res.cacheStatus || '',
                ].filter(Boolean).join(' · ');
                return `<div class="slash-popup-item ${index === _mentionSelectedIndex ? 'selected' : ''}" data-index="${index}" tabindex="${index}">` +
                    `<span class="slash-popup-cmd">${svgIconNoMargin(meta.icon)} @${escapeHtml(res.label)}</span>` +
                    `<span class="slash-popup-desc">${escapeHtml(res.desc)}</span>` +
                    (detailBits ? `<span class="slash-popup-meta">${escapeHtml(detailBits)}</span>` : '') +
                `</div>`;
            }).join('');
            return `<div class="mention-group"><div class="mention-group-title">${escapeHtml(groupLabel)}</div>${itemsHtml}</div>`;
        }).join('');

        saveInputSelection();
        atPopup.querySelectorAll('.slash-popup-item').forEach(el => {
            el.addEventListener('mousedown', e => {
                e.preventDefault();
                saveInputSelection();
            });
            el.addEventListener('click', e => {
                e.preventDefault();
                const index = Number((el as HTMLElement).dataset.index);
                const result = results[index];
                if (!result) return;
                const type = result.type || 'file';
                if ((type === 'file' || type === 'folder' || type === 'code_selection') && !result.uri) return;
                const isTemplate = (type === 'symbol' || type === 'vanilla' || type === 'blackboard')
                    && !result.uri && !result.name && !result.key && !result.vanillaType;
                if (isTemplate) {
                    replaceAtTriggerWithText('@' + result.label);
                    showAtPopup(result.label);
                    return;
                }
                closeAtPopup();
                replaceAtTriggerWithReference(mentionResultToActiveContext(result));
            });
        });
        atPopup.style.display = '';
        positionComposerSuggestionPopup(atPopup);
        atPopup.classList.add('show');
        _atPopupVisible = true;
    }

    function setMentionSelectedIndex(index: number) {
        if (!atPopup || _mentionResults.length === 0) return;
        _mentionSelectedIndex = (index + _mentionResults.length) % _mentionResults.length;
        atPopup.querySelectorAll('.slash-popup-item').forEach((el, idx) => {
            el.classList.toggle('selected', idx === _mentionSelectedIndex);
            if (idx === _mentionSelectedIndex) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
        });
    }

    function renderArtifactPanel() {
        const openArtifact = (artifactId: string, file?: string) => {
            if (openArtifactDiffInSideWorkspace(artifactId, file)) return;
            vscode.postMessage({ type: 'openArtifact', artifactId, file });
        };

        renderArtifactDrawer(
            {
                list: document.getElementById('artifactList'),
                count: document.getElementById('artifactCount'),
                toggle: document.getElementById('btnArtifacts'),
                filterButtons: document.querySelectorAll<HTMLElement>('[data-artifact-filter]'),
            },
            artifacts,
            artifactFilter,
            chatI18n,
            {
                openPlanFile: filePath => vscode.postMessage({ type: 'openPlanFile', filePath }),
                openArtifact,
            },
        );
    }

    function openArtifactDiffInSideWorkspace(artifactId: string, file?: string): boolean {
        const artifact = artifacts.find(item => item.id === artifactId);
        if (!artifact || (artifact.kind !== 'diff' && artifact.action !== 'openDiff')) return false;

        const files = getDiffArtifactFiles(artifact).map(change => ({
            file: change.file,
            status: change.status,
            diffPreview: change.diffPreview,
            additions: change.additions,
            deletions: change.deletions,
            diffLines: change.diffLines,
        }));
        if (files.length === 0) return true;

        openDiffInSideWorkspace(files, uiText.fileChanges, { sourceKey: artifactId, focusFile: file });
        return true;
    }

    function restoreArtifactsFromMessages(messages: any[]) {
        const restored: ArtifactRecord[] = [];
        const pushUnique = (artifact: ArtifactRecord) => {
            if (!restored.some(a => a.id === artifact.id)) restored.push(artifact);
        };
        for (const message of messages) {
            if (!message?.steps) continue;
            for (const step of message.steps) {
                const stamp = step.timestamp || message.timestamp || Date.now();
                if (step.type === 'plan_card') {
                    pushUnique({
                        id: `restored:plan:${step.content}`,
                        kind: 'plan',
                        title: tr('Implementation Plan', '实施计划'),
                        summary: 'Restored from chat history.',
                        filePath: step.content,
                        relPath: step.content,
                        status: step.uiState === 'approved' ? 'done' : 'pending',
                        createdAt: stamp,
                    });
                } else if (step.type === 'blueprint_card') {
                    pushUnique({
                        id: `restored:blueprint:${step.content}`,
                        kind: 'blueprint',
                        title: 'Design Blueprint',
                        summary: 'Restored from chat history.',
                        filePath: step.content,
                        relPath: step.content,
                        status: step.uiState === 'approved' ? 'done' : 'pending',
                        createdAt: stamp,
                    });
                } else if (step.type === 'walkthrough_card') {
                    pushUnique({
                        id: `restored:walkthrough:${step.content}`,
                        kind: 'walkthrough',
                        title: 'Walkthrough Report',
                        summary: 'Full task walkthrough restored from chat history.',
                        filePath: step.content,
                        relPath: step.content,
                        status: 'done',
                        createdAt: stamp,
                    });
                } else if (step.type === 'validation') {
                    pushUnique({
                        id: `restored:validation:${stamp}`,
                        kind: 'validation',
                        title: 'Validation Result',
                        summary: step.content || 'Validation step restored from history.',
                        status: /error|failed|失败|错误/i.test(step.content || '') ? 'failed' : 'done',
                        createdAt: stamp,
                        data: step.toolResult,
                    });
                } else if (step.toolName === 'get_diagnostics') {
                    pushUnique({
                        id: `restored:diagnostics:${stamp}`,
                        kind: 'diagnostics',
                        title: 'Diagnostics Report',
                        summary: 'Restored get_diagnostics result.',
                        status: 'done',
                        createdAt: stamp,
                        data: step.toolResult,
                    });
                }
            }
        }
        artifacts = restoreArtifactsFromHistory(messages);
        renderArtifactPanel();
    }

    function acceptSelectedMention() {
        if (!atPopup || !_atPopupVisible) return false;
        const item = atPopup.querySelector(`.slash-popup-item[data-index="${_mentionSelectedIndex}"]`) as HTMLElement | null;
        if (!item) return false;
        item.click();
        return true;
    }

    function closeAtPopup() {
        if (atPopup) {
            atPopup.style.display = 'none';
            atPopup.classList.remove('show');
            _atPopupVisible = false;
            _mentionResults = [];
            _mentionSelectedIndex = 0;
        }
    }

    window.addEventListener('resize', () => {
        if (slashPopup?.classList.contains('show')) positionComposerSuggestionPopup(slashPopup);
        if (_atPopupVisible && atPopup) positionComposerSuggestionPopup(atPopup);
    });
    inputWrapper?.addEventListener('transitionend', event => {
        if (event.target !== inputWrapper) return;
        updateComposerStackHeight();
        if (slashPopup?.classList.contains('show')) positionComposerSuggestionPopup(slashPopup);
        if (_atPopupVisible && atPopup) positionComposerSuggestionPopup(atPopup);
    });

    // ── Image compression helper ───────────────────────────────────────────────
    // Unifies all image input (paste / drag / file picker) to a clean JPEG data URL.
    // Max dimension: 1024px  |  JPEG quality: 0.85  |  Output: single-line string.
    // This ensures:
    //   • No base64 line-breaks that break Claude / GLM regex matching on the backend
    //   • Consistent "data:image/jpeg;base64,..." format accepted by all providers
    //   • Payload is always ≤ ~400 KB (well within postMessage limits)
    function compressImage(file: Blob, callback: (dataUrl: string) => void) {
        const reader = new FileReader();
        reader.onload = ev => {
            const original = ev.target && ev.target.result;
            if (typeof original !== 'string') return;
            const img = new Image();
            img.onload = () => {
                const MAX = 1024;
                let w = img.width, h = img.height;
                if (w > MAX || h > MAX) {
                    if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
                    else { w = Math.round(w * MAX / h); h = MAX; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx!.drawImage(img, 0, 0, w, h);
                // toDataURL always returns a single-line string — no embedded newlines
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                callback(dataUrl);
            };
            img.onerror = () => callback(original); // fallback: use original if img fails
            img.src = original;
        };
        reader.onerror = () => { };  // silently ignore unreadable files
        reader.readAsDataURL(file);
    }

    // ── Image paste (Ctrl+V or paste event on input) ───────────────────────────
    input.addEventListener('paste', e => {
        const items = e.clipboardData && e.clipboardData.items;
        const text = e.clipboardData?.getData('text/plain') || '';
        let handled = false;
        if (items) {
            for (const item of Array.from(items)) {
                if (!item.type.startsWith('image/')) continue;
                handled = true;
                const blob = item.getAsFile();
                if (!blob) continue;
                compressImage(blob, dataUrl => {
                    pendingImages.push(dataUrl);
                    addImagePreview(dataUrl);
                });
            }
        }
        if (text) {
            handled = true;
            insertPlainTextAtRange(normalizePastedText(text));
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (handled) e.preventDefault();
    });

    // ── Drag-and-drop images onto input area ───────────────────────────────────
    inputWrapper?.addEventListener('dragover', e => {
        e.preventDefault();
        inputWrapper.classList.add('drag-over');
    });
    inputWrapper?.addEventListener('dragleave', () => {
        inputWrapper.classList.remove('drag-over');
    });
    inputWrapper?.addEventListener('drop', e => {
        e.preventDefault();
        inputWrapper.classList.remove('drag-over');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files) return;
        for (const file of Array.from(files)) {
            if (!file.type.startsWith('image/')) continue;
            compressImage(file, dataUrl => {
                pendingImages.push(dataUrl);
                addImagePreview(dataUrl);
            });
        }
    });

    // ── Image file-picker button ───────────────────────────────────────────────
    (() => {
        const imgPickBtn = document.getElementById('imgPickBtn');
        if (!imgPickBtn) return;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
        imgPickBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            for (const file of Array.from(fileInput.files || [])) {
                compressImage(file, dataUrl => {
                    pendingImages.push(dataUrl);
                    addImagePreview(dataUrl);
                });
            }
            fileInput.value = '';
        });
    })();

    // ── Lightbox for full-size image preview ───────────────────────────────────
    function showImageLightbox(dataUrl: string) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);';
        overlay.appendChild(img);
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    }

    function addImagePreview(dataUrl: string) {
        let area = document.getElementById('imagePreviewArea');
        if (!area) {
            area = document.createElement('div');
            area.id = 'imagePreviewArea';
            area.style.cssText = '';
            //Before inserting into input-container inside input-row, make sure the image preview is within the rounded corner of the input box
            const container = document.querySelector('.input-container');
            const inputRow = container?.querySelector('.input-row');
            if (container && inputRow) container.insertBefore(area, inputRow);
            else inputWrapper?.prepend(area);
        }
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;display:inline-block;width:48px;height:48px;flex-shrink:0;';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px;border:1px solid rgba(255,255,255,0.1);cursor:zoom-in;transition:transform 0.15s;display:block;';
        img.title = tr('Click to enlarge', '点击放大');
        img.addEventListener('click', () => showImageLightbox(dataUrl));
        img.addEventListener('mouseenter', () => { img.style.transform = 'scale(1.07)'; });
        img.addEventListener('mouseleave', () => { img.style.transform = ''; });
        const del = document.createElement('button');
        del.textContent = '✕';
        del.style.cssText = 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:rgba(38,38,40,0.96);color:#fff;border:1px solid rgba(255,255,255,0.18);cursor:pointer;font-size:11px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;';
        del.addEventListener('click', () => {
            pendingImages = pendingImages.filter(u => u !== dataUrl);
            wrap.remove();
            updateComposerStackHeight();
            updateSendButtonState();
        });
        wrap.appendChild(img); wrap.appendChild(del);
        area.appendChild(wrap);
        updateComposerStackHeight();
        updateSendButtonState();
    }


    const providerSel = document.getElementById('settingsProvider');
    if (providerSel) providerSel.addEventListener('change', onProviderChange);
    const customApiFormatSel = document.getElementById('customApiFormat');
    if (customApiFormatSel) customApiFormatSel.addEventListener('change', () => updateCustomApiFormatUI());
    const endpointInp = document.getElementById('settingsEndpoint');
    if (endpointInp) endpointInp.addEventListener('input', onEndpointChange);

    function captureComposerPayload(): ComposerPayload {
        syncContextsFromComposer();
        return {
            text: getInputText().trim(),
            images: pendingImages.length > 0 ? [...pendingImages] : undefined,
            contexts: activeContexts.length > 0 ? activeContexts.map(ctx => ({ ...ctx })) : undefined,
            attachedFiles: pendingFiles.length > 0 ? [...pendingFiles] : undefined,
        };
    }

    function hasPayloadContent(payload: UserMessageInputPayload): boolean {
        return payload.text.trim() !== ''
            || (payload.images?.length ?? 0) > 0
            || (payload.contexts?.length ?? 0) > 0
            || (payload.attachedFiles?.length ?? 0) > 0;
    }

    function hasSlashAttachments(payload: UserMessageInputPayload): boolean {
        return payload.text.startsWith('/')
            && (((payload.images?.length ?? 0) > 0)
                || ((payload.attachedFiles?.length ?? 0) > 0)
                || ((payload.contexts?.length ?? 0) > 0));
    }

    function postComposerPayload(payload: ComposerPayload, mode: 'turn' | 'steer'): void {
        const contextsToSend = payload.contexts && payload.contexts.length > 0
            ? payload.contexts.map(ctx => ({ ...ctx }))
            : undefined;
        const imagesToSend = payload.images && payload.images.length > 0 ? [...payload.images] : undefined;
        if (mode === 'steer' && isGenerating && !contextsToSend) {
            vscode.postMessage({
                type: 'steerGeneration',
                text: payload.text,
                images: imagesToSend,
            });
            return;
        }
        if (contextsToSend) {
            vscode.postMessage({
                type: 'sendMessageWithReference',
                text: payload.text,
                contexts: contextsToSend,
                images: imagesToSend,
            });
            return;
        }
        vscode.postMessage({
            type: 'sendMessage',
            text: payload.text,
            images: imagesToSend,
            attachedFiles: payload.attachedFiles && payload.attachedFiles.length > 0 ? [...payload.attachedFiles] : undefined,
        });
    }

    function sendQueuedComposerInput(id: string): void {
        const item = removeQueuedComposerInput(id);
        if (!item) return;
        setChatEmptyState(false);
        postComposerPayload(item, isGenerating ? 'steer' : 'turn');
        updateSendButtonState();
    }

    function scheduleNextQueuedComposerInput(): void {
        if (queuedPromptDispatchTimer || isGenerating || queuedComposerInputs.length === 0) return;
        queuedPromptDispatchTimer = setTimeout(() => {
            queuedPromptDispatchTimer = null;
            if (isGenerating || queuedComposerInputs.length === 0) return;
            const next = queuedComposerInputs.shift();
            renderQueuedPromptArea();
            if (!next) return;
            setChatEmptyState(false);
            postComposerPayload(next, 'turn');
            updateSendButtonState();
        }, 120);
    }

    function sendMessage() {
        const payload = captureComposerPayload();
        if (!hasPayloadContent(payload)) return;
        setChatEmptyState(false);

        const slashHasAttachments = hasSlashAttachments(payload);
        if (slashHasAttachments) postComposerPayload(payload, 'turn');
        else if (isGenerating) enqueueComposerInput(payload);
        else postComposerPayload(payload, 'turn');

        // The Host rejects slash commands with attachments. Keep the complete
        // composer payload intact so the user can remove attachments and retry.
        if (slashHasAttachments) {
            updateSendButtonState();
            return;
        }
        
        clearInput();
        stopPlaceholderRotation();
        clearComposerAttachmentPreviews();
        updateComposerStackHeight();
        updateSendButtonState();
    }

    renderComposerChips();

    function updateSendButtonState() {
        if (isGenerating && !hasComposerPayload()) {
            sendBtn.disabled = false;
            sendBtn.innerHTML = '<span class="stop-icon"></span>';
            sendBtn.title = chatI18n.buttons.cancelGeneration;
            sendBtn.className = 'send-btn cancel-mode';
            return;
        }
        sendBtn.innerHTML = '<span class="send-icon">↑</span>';
        sendBtn.title = isGenerating
            ? tr('Queue after current run', '排队到当前任务之后')
            : `${chatI18n.buttons.send} (Enter)`;
        sendBtn.className = isGenerating ? 'send-btn steer-mode' : 'send-btn';
        sendBtn.disabled = !hasComposerPayload();
    }

    function setGenerating(val: boolean) {
        isGenerating = val;
        if (val && queuedPromptDispatchTimer) {
            clearTimeout(queuedPromptDispatchTimer);
            queuedPromptDispatchTimer = null;
        }
        updateSendButtonState();
        renderGoalRunArea();
        renderQueuedPromptArea();
        if (!val && isInputEmpty()) startPlaceholderRotation();
    }

    // ── Token usage bar ────────────────────────────────────────────────────────
    function updateTokenUsage(used: number, limit: number) {
        if (!used) return;
        const bar = document.getElementById('tokenUsageBar');
        const fill = document.getElementById('tokenUsageFill');
        const label = document.getElementById('tokenUsageLabel');
        if (!bar || !fill || !label) return;
        const pct = Math.min(100, Math.round((used / limit) * 100));
        fill.style.width = pct + '%';
        fill.style.background = pct > 80 ? 'var(--error)' : pct > 60 ? 'var(--warning)' : 'var(--accent)';
        label.textContent = `~${formatNum(used)} / ${formatNum(limit)} tokens`;
        bar.style.display = 'flex';
    }

    // Delegated to chat/formatters.ts for single-source-of-truth
    const formatNum = _fmtFormatNum;
    const formatTime = _fmtFormatTime;
    const escapeHtml = _fmtEscapeHtml;

    let isUserScrolledUp = false;
    let scrollBottomPending = false;
    let subagentScrollPending = false;
    const subagentUserScrolledUp = new WeakMap<HTMLElement, boolean>();
    const jumpLatestBtn = document.createElement('button');
    jumpLatestBtn.className = 'jump-latest-btn';
    jumpLatestBtn.type = 'button';
    jumpLatestBtn.innerHTML = `${svgIconNoMargin('pointer')} ${tr('Latest message', '最新消息')}`;
    jumpLatestBtn.addEventListener('click', () => {
        scrollBottom(true);
        jumpLatestBtn.classList.remove('show');
    });
    document.body.appendChild(jumpLatestBtn);
    chatArea.addEventListener('scroll', () => {
        isUserScrolledUp = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight > 65;
        jumpLatestBtn.classList.toggle('show', isUserScrolledUp);
    });

    function bindSubagentScroll(fullscreen: HTMLElement): void {
        if (fullscreen.dataset.scrollBound === 'true') return;
        fullscreen.dataset.scrollBound = 'true';
        fullscreen.addEventListener('scroll', () => {
            const scrolledUp = fullscreen.scrollHeight - fullscreen.scrollTop - fullscreen.clientHeight > 65;
            subagentUserScrolledUp.set(fullscreen, scrolledUp);
        });
    }

    function scrollSubagentBottom(fullscreen: HTMLElement): void {
        if (subagentScrollPending) return;
        subagentScrollPending = true;
        requestAnimationFrame(() => {
            subagentScrollPending = false;
            fullscreen.scrollTop = fullscreen.scrollHeight;
            subagentUserScrolledUp.set(fullscreen, false);
        });
    }

    // Re-render a streaming scrollable body (e.g. .thinking-body) without losing
    // the user's scroll position: follow the stream while pinned to the bottom,
    // otherwise restore the previous offset (innerHTML replacement resets it).
    function rerenderScrollableBody(body: HTMLElement, html: string): void {
        const stickToBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
        const prevScrollTop = body.scrollTop;
        body.innerHTML = html;
        body.scrollTop = stickToBottom ? body.scrollHeight : Math.min(prevScrollTop, body.scrollHeight);
    }

    function scrollBottom(force = false) {
        const activeSubagent = document.querySelector('.subagent-fullscreen-view.active') as HTMLElement | null;
        if (activeSubagent) {
            bindSubagentScroll(activeSubagent);
            if (force || !subagentUserScrolledUp.get(activeSubagent)) {
                scrollSubagentBottom(activeSubagent);
            }
            return;
        }
        if (force || !isUserScrolledUp) {
            if (scrollBottomPending) return;
            scrollBottomPending = true;
            requestAnimationFrame(() => {
                scrollBottomPending = false;
                chatArea.scrollTop = chatArea.scrollHeight;
                isUserScrolledUp = false;
                jumpLatestBtn.classList.remove('show');
            });
        }
    }

    // ── Batch 3.1: Virtual scroll — IntersectionObserver offscreen optimization ──
    // Adds CSS class 'offscreen' to messages far from the viewport, enabling
    // content-visibility:auto to skip layout/paint for off-screen DOM subtrees.
    // This dramatically reduces memory and rendering cost for 100+ message sessions.
    const virtualScrollObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const el = entry.target as HTMLElement;
                if (entry.isIntersecting) {
                    el.classList.remove('offscreen');
                } else {
                    // Only mark offscreen if the message is NOT the live streaming message
                    if (!el.classList.contains('live-msg')) {
                        el.classList.add('offscreen');
                    }
                }
            }
        },
        { root: chatArea, rootMargin: '200% 0px' } // ±2 screens buffer
    );

    /** Register a message element for virtual scroll observation */
    function observeMessage(el: HTMLElement) {
        virtualScrollObserver.observe(el);
    }

    // ── Batch 3.2: Code block copy button enhancer ──────────────────────────
    // After rendering markdown, attach copy buttons to all code blocks.
    function enhanceCodeBlocks(container: HTMLElement) {
        const blocks = container.querySelectorAll('.md-codeblock');
        blocks.forEach(block => {
            // Skip if already enhanced
            if (block.querySelector('.md-codeblock-copy')) return;
            const codeEl = block.querySelector('code');
            if (!codeEl) return;
            const btn = document.createElement('button');
            btn.className = 'md-codeblock-copy';
            btn.textContent = 'Copy';
            btn.setAttribute('aria-label', tr('Copy code', '复制代码'));
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
                    btn.textContent = '✓';
                    btn.classList.add('copied');
                    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
                }).catch(() => { /* clipboard not available in webview sandbox */ });
            });
            block.appendChild(btn);
        });
    }

    // ── Batch 3.2: Task list checkbox rendering ──────────────────────────────
    // Converts GFM-style task list items (- [x] / - [ ]) to styled checkboxes.
    function enhanceTaskLists(container: HTMLElement) {
        const lists = container.querySelectorAll('ul, ol');
        lists.forEach(list => {
            const items = Array.from(list.children) as HTMLElement[];
            let hasTask = false;
            for (const li of items) {
                const text = li.innerHTML;
                const checkedMatch = text.match(/^\s*\[x\]\s*/i);
                const uncheckedMatch = text.match(/^\s*\[\s?\]\s*/);
                if (checkedMatch || uncheckedMatch) {
                    hasTask = true;
                    const checked = !!checkedMatch;
                    const prefix = checked ? checkedMatch![0] : uncheckedMatch![0];
                    li.innerHTML = `<input type="checkbox" class="task-checkbox" ${checked ? 'checked' : ''} disabled aria-label="${checked ? tr('Done', '已完成') : tr('Not done', '未完成')}">` +
                        text.substring(prefix.length);
                }
            }
            if (hasTask) list.classList.add('task-list');
        });
    }

    // ── Batch 3.3: ARIA role helpers for dynamic messages ─────────────────────
    function setMessageAria(el: HTMLElement, role: 'user' | 'assistant') {
        el.setAttribute('role', 'article');
        el.setAttribute('aria-label', role === 'user' ? 'User message' : 'AI response');
    }

    // Delegated to chat/formatters.ts
    const WRITE_TOOL_NAMES = _fmtWriteTools;
    const READ_TOOL_NAMES = _fmtReadTools;
    const VALIDATION_TOOL_NAMES = _fmtValidationTools;
    const ORCHESTRATOR_TOOL_NAMES = _fmtOrchestratorTools;
    type RunSummary = _FmtRunSummary;
    const extractStepFile = _fmtExtractStepFile;

    function makeRunSummary(steps: any[] | undefined, fallbackContent?: string): RunSummary {
        const isZh = chatI18n.locale === 'zh-cn';
        const all = steps || [];
        const timestamps = all.map(s => Number(s.timestamp || 0)).filter(Boolean);
        const startedAt = timestamps.length ? Math.min(...timestamps) : null;
        const endedAt = timestamps.length ? Math.max(...timestamps) : null;
        const toolCounts = new Map<string, number>();
        const files = new Set<string>();
        let thinkingCount = 0;
        let toolCallCount = 0;
        let toolResultCount = 0;
        let writeCount = 0;
        let readCount = 0;
        let validationCount = 0;
        let orchestratorCount = 0;
        let errorCount = 0;
        let failedToolCount = 0;
        let latestStatus = fallbackContent?.trim() ? fallbackContent.trim() : (isZh ? '已完成' : 'Completed');
        const alerts: string[] = [];
        const validations: string[] = [];

        for (const step of all) {
            const type = step?.type || '';
            if (type === 'thinking' || type === 'thinking_content') thinkingCount++;
            if (type === 'tool_call') {
                const toolName = String(step.toolName || 'tool');
                const file = extractStepFile(step);
                toolCallCount++;
                toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
                if (WRITE_TOOL_NAMES.has(toolName)) {
                    writeCount++;
                    if (file) files.add(file);
                } else if (READ_TOOL_NAMES.has(toolName)) {
                    readCount++;
                } else if (VALIDATION_TOOL_NAMES.has(toolName)) {
                    validationCount++;
                } else if (ORCHESTRATOR_TOOL_NAMES.has(toolName)) {
                    orchestratorCount++;
                }
                latestStatus = file
                    ? (isZh ? `正在调用 ${toolName}: ${file}` : `Calling ${toolName}: ${file}`)
                    : (isZh ? `正在调用 ${toolName}` : `Calling ${toolName}`);
            } else if (type === 'tool_result') {
                toolResultCount++;
                const result = step.toolResult as any;
                if (result?.success === false || result?.error) {
                    failedToolCount++;
                    const msg = String(result?.message || result?.error || (isZh ? `${step.toolName || '工具'} 执行失败` : `${step.toolName || 'tool'} failed`));
                    alerts.push(msg);
                }
                latestStatus = result?.success === false || result?.error
                    ? (isZh ? `${step.toolName || '工具'} 返回问题` : `${step.toolName || 'Tool'} returned an issue`)
                    : (isZh ? `${step.toolName || '工具'} 已返回` : `${step.toolName || 'Tool'} returned`);
            } else if (type === 'validation') {
                validationCount++;
                if (step.content) validations.push(String(step.content));
            } else if (type === 'error') {
                errorCount++;
                if (step.content) alerts.push(String(step.content));
            } else if (type === 'orchestrator_progress' || type === 'subtask_start' || type === 'subtask_complete') {
                orchestratorCount++;
            }
            if (step?.content && ['error', 'validation', 'orchestrator_progress', 'subtask_complete'].includes(type)) {
                latestStatus = String(step.content).replace(/\$\(([\w-]+)\)/g, '').trim() || latestStatus;
            }
        }

        return {
            startedAt,
            endedAt,
            durationMs: startedAt && endedAt ? Math.max(0, endedAt - startedAt) : 0,
            totalSteps: all.length,
            thinkingCount,
            toolCallCount,
            toolResultCount,
            writeCount,
            readCount,
            validationCount,
            orchestratorCount,
            errorCount,
            failedToolCount,
            changedFiles: Array.from(files).slice(0, 8),
            topTools: Array.from(toolCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([name, count]) => ({ name, count })),
            latestStatus,
            hasOrchestrator: orchestratorCount > 0 || all.some(s => !!s.agentId),
            alerts: alerts.slice(0, 3),
            validations: validations.slice(0, 3),
        };
    }

    function renderRunSummaryHtml(summary: RunSummary, live = false): string {
        const isZh = chatI18n.locale === 'zh-cn';
        const severity = summary.errorCount > 0 || summary.failedToolCount > 0 ? 'error'
            : summary.validationCount > 0 ? 'ok'
            : summary.hasOrchestrator ? 'orch'
            : 'normal';
        const title = live
            ? (isZh ? '正在执行' : 'Running')
            : severity === 'error'
                ? (isZh ? '执行完成，有问题需要查看' : 'Run completed with issues')
                : (isZh ? '执行完成' : 'Run complete');
        const duration = summary.durationMs > 0 ? formatDuration(summary.durationMs) : (live ? (isZh ? '进行中' : 'running') : (isZh ? '短任务' : 'short task'));
        const fileText = summary.changedFiles.length > 0 ? summary.changedFiles.join(', ') : (isZh ? '无文件改动' : 'No file changes');
        const toolText = summary.topTools.length > 0
            ? summary.topTools.map(t => `${t.name} ${t.count}×`).join(' · ')
            : (isZh ? '未调用工具' : 'No tools called');
        const status = summary.latestStatus.length > 110 ? summary.latestStatus.slice(0, 110) + '...' : summary.latestStatus;
        const alertHtml = summary.alerts.length > 0
            ? `<div class="run-summary-alerts">${summary.alerts.map(a => `<div>${svgIconNoMargin('warning')} ${escapeHtml(a.length > 160 ? a.slice(0, 160) + '...' : a)}</div>`).join('')}</div>`
            : summary.validations.length > 0
                ? `<div class="run-summary-alerts run-summary-validations">${summary.validations.slice(0, 2).map(v => `<div>${svgIconNoMargin('check')} ${escapeHtml(v.length > 160 ? v.slice(0, 160) + '...' : v)}</div>`).join('')}</div>`
                : '';
        return `
            <section class="run-summary run-summary-${severity} ${live ? 'run-summary-live' : ''}">
                <div class="run-summary-head">
                    <span class="run-summary-icon">${live ? svgIconNoMargin('refresh') : svgIconNoMargin(severity === 'error' ? 'warning' : severity === 'orch' ? 'bot' : 'check')}</span>
                    <div class="run-summary-title-wrap">
                        <div class="run-summary-title">${escapeHtml(title)}</div>
                        <div class="run-summary-status">${escapeHtml(status)}</div>
                    </div>
                    <span class="run-summary-duration">${escapeHtml(duration)}</span>
                </div>
                <div class="run-summary-metrics">
                    <span>${svgIconNoMargin('gear')} ${summary.toolCallCount} ${isZh ? '工具' : 'tools'}</span>
                    <span>${svgIconNoMargin('edit')} ${summary.writeCount} ${isZh ? '写入' : 'writes'}</span>
                    <span>${svgIconNoMargin('search')} ${summary.readCount} ${isZh ? '读取' : 'reads'}</span>
                    <span>${svgIconNoMargin('stethoscope')} ${summary.validationCount} ${isZh ? '验证' : 'validations'}</span>
                    ${summary.errorCount + summary.failedToolCount > 0 ? `<span class="run-summary-danger">${svgIconNoMargin('x')} ${summary.errorCount + summary.failedToolCount} ${isZh ? '问题' : 'issues'}</span>` : ''}
                </div>
                <div class="run-summary-foot">
                    <span class="run-summary-files" title="${escapeHtml(fileText)}">${escapeHtml(fileText)}</span>
                    <span class="run-summary-tools" title="${escapeHtml(toolText)}">${escapeHtml(toolText)}</span>
                </div>
                ${alertHtml}
            </section>
        `;
    }

    // Delegated to chat/formatters.ts
    const formatDuration = _fmtFormatDuration;

    function _buildProcessPanel(sortedSteps: any[]) {
        const thinkingSteps = sortedSteps.filter((s: any) => s.type === 'thinking' || s.type === 'thinking_content');
        const textDeltas = sortedSteps.filter((s: any) => s.type === 'text_delta');
        const cacheStatsSteps = sortedSteps.filter((s: any) => s.type === 'cache_stats');
        const specialSteps = sortedSteps.filter((s: any) =>
            !['thinking', 'thinking_content', 'tool_call', 'tool_result', 'text_delta', 'cache_stats'].includes(s.type)
            && !(s.type === 'compaction' && s.compactionInfo)
        );
        const toolCalls = sortedSteps.filter((s: any) => s.type === 'tool_call');
        const toolResults = sortedSteps.filter((s: any) => s.type === 'tool_result');
        const hasFailedTool = toolResults.some((s: any) => {
            const r = s.toolResult as any;
            return r?.success === false || !!r?.error;
        });
        const hasUsefulContent = thinkingSteps.length > 0 || toolCalls.length > 0 || specialSteps.length > 0 || textDeltas.length > 0;
        if (!hasUsefulContent) return null;

        // ── Custom collapsible panel (replaces native <details>) ──
        const panel = document.createElement('div');
        panel.className = 'agent-process-panel';
        let isExpanded = hasFailedTool;
        let userToggled = false;

        function setExpanded(expanded: boolean) {
            isExpanded = expanded;
            panel.classList.toggle('process-expanded', expanded);
            if (expanded) {
                // First set to scrollHeight to animate open, then unlock to none after transition
                body.style.maxHeight = body.scrollHeight + 'px';
                body.style.opacity = '1';
                const unlock = () => {
                    if (isExpanded) body.style.maxHeight = 'none';
                    body.removeEventListener('transitionend', unlock);
                };
                body.addEventListener('transitionend', unlock);
            } else {
                // Collapse: lock to current scrollHeight first, then animate to 0
                body.style.maxHeight = body.scrollHeight + 'px';
                // Force reflow before setting to 0
                void body.offsetHeight;
                body.style.maxHeight = '0';
                body.style.opacity = '0';
            }
            collapseBtn.style.display = expanded ? '' : 'none';
        }

        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'process-panel-header';
        header.innerHTML = `
            <span class="process-panel-chevron"></span>
            ${svgIconNoMargin('layers')}
            <span class="process-title">${tr('Process', '探索过程')}</span>
            <span class="process-meta">${thinkingSteps.length} ${tr('thoughts', '思考')} · ${toolCalls.length} ${tr('tools', '工具')} · ${textDeltas.length} ${tr('text', '文本')}</span>
            <span class="process-countdown"></span>
        `;
        header.addEventListener('click', () => {
            userToggled = true;
            setExpanded(!isExpanded);
        });
        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = 'process-panel-body';
        body.style.maxHeight = isExpanded ? 'none' : '0';
        body.style.opacity = isExpanded ? '1' : '0';

        const stack = document.createElement('div');
        stack.className = 'process-stack';

        if (thinkingSteps.length > 0) {
            let thinkText = '';
            for (const s of thinkingSteps) {
                if (s.type === 'thinking' && thinkText) thinkText += '\n\n---\n\n' + (s.content || '');
                else thinkText += (s.content || '');
            }
            thinkText = thinkText.trim();
            if (thinkText) {
                const estTokens = Math.ceil(thinkText.length / 4);
                const thinking = document.createElement('details');
                thinking.className = 'process-section process-thinking';
                thinking.innerHTML = `<summary>${svgIconNoMargin('messageSquare')} ${tr('Thinking details', '思考详情')} <span>~${formatNum(estTokens)} tokens</span></summary>`;
                const thinkingBody = document.createElement('div');
                thinkingBody.className = 'thinking-body markdown-body';
                thinkingBody.innerHTML = renderMarkdown(thinkText);
                thinking.appendChild(thinkingBody);
                stack.appendChild(thinking);
            }
        }

        if (textDeltas.length > 0) {
            const text = textDeltas.map((s: any) => s.content || '').join('').trim();
            if (text) {
                const textBlock = document.createElement('details');
                textBlock.className = 'process-section process-text';
                textBlock.innerHTML = `<summary>${svgIconNoMargin('file')} ${tr('Process text', '过程文本')} <span>${textDeltas.length} chunks</span></summary>`;
                const textBody = document.createElement('div');
                textBody.className = 'thinking-body process-text-body markdown-body';
                textBody.innerHTML = renderMarkdown(text);
                textBlock.appendChild(textBody);
                stack.appendChild(textBlock);
            }
        }

        if (toolCalls.length > 0) {
            const isZh = chatI18n.locale === 'zh-cn';
            const tools = document.createElement('details');
            tools.className = 'process-section process-tools';
            tools.open = hasFailedTool;
            tools.innerHTML = `<summary>${svgIconNoMargin('gear')} ${isZh ? '工具详情' : 'Tool details'} <span>${toolCalls.length} ${isZh ? '次调用' : 'call(s)'}${hasFailedTool ? ` · ${isZh ? '有失败' : 'failed'}` : ''}</span></summary>`;

            const pairOpts = { showDuration: true, showParams: true, showDiff: true, locale: chatI18n.locale };

            // Use grouped rendering when ≥3 tool calls (Stage B integration)
            const groups = groupToolCalls(toolCalls, toolResults, chatI18n.locale);
            if (groups) {
                const timelineDiv = document.createElement('div');
                timelineDiv.className = 'tool-timeline process-tool-timeline tool-timeline-grouped';
                const idxRef = { value: 0 };
                for (const group of groups) {
                    const wrapper = document.createElement('div');
                    wrapper.innerHTML = buildToolGroupHtml(group, idxRef, pairOpts);
                    if (wrapper.firstElementChild) timelineDiv.appendChild(wrapper.firstElementChild);
                }
                tools.appendChild(timelineDiv);
            } else {
                const timelineDiv = document.createElement('div');
                timelineDiv.className = 'tool-timeline process-tool-timeline';
                const resultsCopy = [...toolResults];
                toolCalls.forEach((call: any, idx: number) => {
                    const resultIdx = resultsCopy.findIndex((r: any) => r.toolName === call.toolName);
                    let result: RendererStep | undefined;
                    if (resultIdx >= 0) result = resultsCopy.splice(resultIdx, 1)[0];
                    const wrapper = document.createElement('div');
                    wrapper.innerHTML = buildToolPairHtml(call, result, {
                        ...pairOpts,
                        stepIndex: call.stepIndex || idx + 1,
                    });
                    if (wrapper.firstElementChild) timelineDiv.appendChild(wrapper.firstElementChild);
                });
                tools.appendChild(timelineDiv);
            }
            stack.appendChild(tools);
        }

        // ── Aggregated cache stats summary ──
        if (cacheStatsSteps.length > 0) {
            let totalHit = 0, totalCreated = 0, totalSaved = 0;
            for (const cs of cacheStatsSteps) {
                const stats = (cs as any).cacheStats;
                if (stats) {
                    totalHit += stats.cachedTokens || 0;
                    totalCreated += stats.cacheCreationTokens || 0;
                    totalSaved += stats.savedCostCny || 0;
                }
            }
            const hitRate = totalHit > 0 ? ((totalHit / (totalHit + totalCreated)) * 100).toFixed(1) : '0.0';
            const cacheSummary = document.createElement('div');
            cacheSummary.className = 'process-cache-summary';
            cacheSummary.innerHTML = chatI18n.locale === 'zh-cn'
                ? `${svgIconNoMargin('check')} Prefix Cache 汇总 (${cacheStatsSteps.length} 次)：命中 ${totalHit.toLocaleString()} tokens (${hitRate}%)，创建 ${totalCreated.toLocaleString()} tokens，节省约 ¥${totalSaved.toFixed(4)}`
                : `${svgIconNoMargin('check')} Prefix cache summary (${cacheStatsSteps.length} call(s)): hit ${totalHit.toLocaleString()} tokens (${hitRate}%), created ${totalCreated.toLocaleString()} tokens, saved about ¥${totalSaved.toFixed(4)}`;
            stack.appendChild(cacheSummary);
        }

        if (specialSteps.length > 0) {
            const special = document.createElement('div');
            special.className = 'process-specials';
            specialSteps.forEach((s: any) => {
                const el = document.createElement('div');
                const icon = s.type === 'error' ? svgIconNoMargin('x') : s.type === 'validation' ? svgIconNoMargin('check') : s.type === 'compaction' ? svgIconNoMargin('gear') : '·';
                el.className = `special-step ${s.type}`;
                el.innerHTML = icon + ' ' + escapeHtml(s.content || '');
                special.appendChild(el);
            });
            stack.appendChild(special);
        }

        // ── Collapse button at bottom of body ──
        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'process-collapse-btn';
        collapseBtn.innerHTML = svgIconNoMargin('x') + ' ' + tr('Collapse', '收起');
        collapseBtn.style.display = isExpanded ? '' : 'none';
        collapseBtn.addEventListener('click', () => {
            userToggled = true;
            setExpanded(false);
        });

        body.appendChild(stack);
        body.appendChild(collapseBtn);
        panel.appendChild(body);

        if (isExpanded) panel.classList.add('process-expanded');

        // ── Auto-collapse with 3s countdown (skipped if user toggled or has failures) ──
        if (!hasFailedTool && !userToggled) {
            // Start expanded so user can see progress
            setExpanded(true);
            const countdownEl = header.querySelector('.process-countdown') as HTMLElement | null;
            let countdown = 3;
            const tick = () => {
                if (userToggled) return;
                if (countdownEl) countdownEl.textContent = `（${countdown}）`;
                if (countdown <= 0) {
                    if (countdownEl) countdownEl.textContent = '';
                    setExpanded(false);
                    return;
                }
                countdown--;
                setTimeout(tick, 1000);
            };
            setTimeout(tick, 500);
        }

        return panel;
    }

    function updateContextCompactionCard(card: HTMLElement, step: RendererStep): void {
        const info = step.compactionInfo;
        const state = info?.state ?? 'start';
        const stateClass = state === 'complete' ? 'is-complete' : state === 'failed' ? 'is-failed' : 'is-running';
        const title = state === 'complete'
            ? chatI18n.live.contextCompacted
            : state === 'failed'
                ? chatI18n.live.contextCompactionFailed
                : chatI18n.live.compactingContext;
        let detail = state === 'start' ? chatI18n.live.compactingContextDetail : String(step.content || '');
        if (typeof info?.beforeTokens === 'number' && typeof info.afterTokens === 'number') {
            detail = `${formatNum(info.beforeTokens)} → ${formatNum(info.afterTokens)} tokens`;
        } else if (state === 'start' && typeof info?.beforeTokens === 'number' && typeof info.thresholdTokens === 'number') {
            detail += ` · ${formatNum(info.beforeTokens)} / ${formatNum(info.thresholdTokens)} tokens`;
        }
        const icon = state === 'complete' ? 'check' : state === 'failed' ? 'x' : 'package';
        const status = state === 'complete' ? '✓' : state === 'failed' ? '!' : '•••';
        card.className = `context-compaction-card ${stateClass}`;
        card.dataset.compactionState = state;
        card.setAttribute('role', 'status');
        card.setAttribute('aria-live', 'polite');
        card.innerHTML = `
            <span class="context-compaction-icon" aria-hidden="true">${svgIconNoMargin(icon as keyof typeof Icons)}</span>
            <span class="context-compaction-copy">
                <span class="context-compaction-title">${escapeHtml(title)}</span>
                <span class="context-compaction-detail">${escapeHtml(detail)}</span>
            </span>
            <span class="context-compaction-status" aria-hidden="true">${status}</span>
        `;
    }

    function createContextCompactionCard(step: RendererStep): HTMLElement {
        const card = document.createElement('div');
        updateContextCompactionCard(card, step);
        return card;
    }

    function isContextCompactionStep(step: any): step is RendererStep {
        return step?.type === 'compaction' && !!step.compactionInfo;
    }

    function updateContextMeterFromCompaction(step: RendererStep): void {
        const info = step.compactionInfo;
        const tokens = info?.state === 'complete' ? info.afterTokens : info?.beforeTokens;
        if (typeof tokens !== 'number' || tokens <= 0) return;
        lastKnownContextTokens = tokens;
        updateTokenUsage(tokens, contextLimit);
        const label = document.getElementById('tokenUsageLabel');
        if (!label) return;
        const stateLabel = info?.state === 'complete'
            ? tr('after compaction estimate', '压缩后估算')
            : info?.state === 'failed'
                ? tr('compaction failed', '压缩失败')
                : tr('compacting', '正在压缩');
        label.textContent = `${label.textContent} · ${stateLabel}`;
    }

    // ── OpenCode-style: build complete assistant message DOM ────────────────────
    //   Structure (matches OpenCode's message anatomy):
    //   1. [Thinking block]  — extended reasoning, collapsible, at the top
    //   2. [Tool calls block] — list of tool-pair rows (call + result)
    //   3. [Text response]   — the final markdown answer

    function buildAssistantMessage(content: string, steps: any[], msgTime: number | null, isSubagentView = false) {
        const div = document.createElement('div');
        div.className = 'message assistant codex-message';

        const subAgentGroups = new Map<string, any[]>();
        const mainSteps: any[] = [];
        for (const step of steps || []) {
            if (step.agentId && !isSubagentView) {
                let group = subAgentGroups.get(step.agentId);
                if (!group) {
                    group = [];
                    subAgentGroups.set(step.agentId, group);
                }
                const stepCopy = { ...step };
                delete stepCopy.agentId;
                if (stepCopy.content && stepCopy.content.startsWith(`[${step.agentId}] `)) {
                    stepCopy.content = stepCopy.content.substring(step.agentId.length + 3);
                }
                group.push(stepCopy);
            } else {
                mainSteps.push(step);
            }
        }

        const sorted = [...mainSteps].sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));
        const latestCompactionStep = [...sorted].reverse().find(isContextCompactionStep);
        const renderedSteps = sorted.filter(step => !isContextCompactionStep(step));
        div.innerHTML = renderAssistantTurnCodex(content, renderedSteps, {
            i18n: chatI18n,
            msgTime,
            renderMarkdown,
            isSubagentView,
        });
        if (latestCompactionStep) {
            div.prepend(createContextCompactionCard(latestCompactionStep));
        }

        // Recursively render all sub-Agent independent boxes to prevent merging with the main dialogue flow
        for (const [agentId, groupSteps] of subAgentGroups.entries()) {
            // Use a fixed uniqueId to prevent the active state from being lost during re-rendering
            const uniqueId = `subview-${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${msgTime || 'sub'}`;
            const agentSummary = makeRunSummary(groupSteps);
            const agentStatusClass = 'lane-done';
            const agentFiles = agentSummary.changedFiles.length > 0 ? ` · ${agentSummary.changedFiles.length} ${tr('file(s)', '文件')}` : '';
            const agentDuration = agentSummary.durationMs > 0 ? formatDuration(agentSummary.durationMs) : tr('short task', '短任务');
            const agentTopTool = agentSummary.topTools[0]?.name || tr('no tool', '无工具');
            
            const card = document.createElement('div');
            card.className = `orch-lane ${agentStatusClass} subagent-card`;
            card.dataset.targetId = uniqueId;
            card.innerHTML = `
                <div class="lane-header">
                    <span class="lane-icon">${svgIconNoMargin('bot')}</span>
                    <span class="lane-role">${tr('Subtask', '子任务')}: ${escapeHtml(agentId)}</span>
                    <span class="lane-status" style="margin-left:auto;">›</span>
                </div>
                <div class="lane-status-text">${agentSummary.toolCallCount} ${tr('tools', '工具')}${agentFiles}</div>
                <div class="lane-meta">
                    <span>${escapeHtml(agentDuration)}</span>
                    <span>${escapeHtml(agentTopTool)}</span>
                    ${agentSummary.readCount ? `<span>${agentSummary.readCount} ${tr('reads', '读取')}</span>` : ''}
                    ${agentSummary.writeCount ? `<span>${agentSummary.writeCount} ${tr('writes', '写入')}</span>` : ''}
                </div>
            `;
            div.appendChild(card);
            
            const fullscreen = document.createElement('div');
            fullscreen.id = uniqueId;
            fullscreen.className = 'subagent-fullscreen-view';
            fullscreen.dataset.agentId = agentId;
            fullscreen.innerHTML = `
                <div class="subagent-header">
                    <button class="subagent-back-btn" data-target-id="${uniqueId}">‹ ${tr('Back', '返回')}</button>
                    <div class="subagent-title-wrap">
                        <span class="subagent-title">${tr('Subagent', '子代理')}: ${escapeHtml(agentId)}</span>
                        <span class="subagent-subtitle">${escapeHtml(agentSummary.latestStatus)}</span>
                    </div>
                    <div class="subagent-header-metrics">
                        <span>${escapeHtml(agentDuration)}</span>
                        <span>${agentSummary.toolCallCount} ${tr('tools', '工具')}</span>
                    </div>
                </div>
                <div class="subagent-body"></div>
            `;
            bindSubagentScroll(fullscreen);
            
            // Recursively render the content of the sub-Agent without msgTime to avoid multiple timestamps
            const innerMsg = buildAssistantMessage('', groupSteps, null, true);
            fullscreen.querySelector('.subagent-body')!.appendChild(innerMsg);
            
            div.appendChild(fullscreen);
            const persistedTodos = latestTodosFromSteps(groupSteps);
            if (persistedTodos.length > 0) {
                subagentTodos.set(agentId, persistedTodos);
                renderSubagentTodoPanel(fullscreen, persistedTodos);
            }
        }

        // Batch 3: Enhance rendered content
        setMessageAria(div, 'assistant');
        enhanceCodeBlocks(div);
        enhanceTaskLists(div);
        observeMessage(div);

        return div;
    }

    // ── Global Drill-Down Functions ───────────────────────────────────────────
    function clearActiveSubagentViews(): void {
        document.querySelectorAll('.subagent-fullscreen-view.active').forEach(el => {
            el.classList.remove('active');
        });
        document.body.classList.remove('has-active-subagent');
    }

    function removeLiveAssistantViews(): void {
        document.querySelectorAll('.message.assistant.live-msg').forEach(el => el.remove());
        currentAssistantDiv = null;
        streamStates.clear();
    }

    (window as any).openSubagentView = (id: string) => {
        const el = document.getElementById(id);
        if (el) {
            document.querySelectorAll('.subagent-fullscreen-view.active').forEach(active => {
                if (active !== el) active.classList.remove('active');
            });
            el.classList.add('active');
            bindSubagentScroll(el);
            scrollSubagentBottom(el);
            document.body.classList.add('has-active-subagent');
        }
    };
    (window as any).closeSubagentView = (id: string) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('active');
            if (!document.querySelector('.subagent-fullscreen-view.active')) {
                document.body.classList.remove('has-active-subagent');
            }
        }
    };

    // ── Live thinking/tool state builders ─────────────────────────────────────
    // We maintain a structured state for the live (streaming) assistant message.
    interface AgentStreamState {
        livePhase: string | null;
        liveSummary: HTMLElement | null;
        liveProcessPanel: HTMLDivElement | null;
        liveProcessBody: HTMLElement | null;
        liveTextProcessBody: HTMLElement | null;
        liveThinkBlock: HTMLElement | null;
        liveThinkBody: HTMLElement | null;
        liveThinkSum: HTMLElement | null;
        liveToolTimeline: HTMLElement | null;
        liveCompactionCard: HTMLElement | null;
        liveTextBubble: HTMLDivElement | null;
        liveTextContent: string;
        liveThinkContent: string;
        liveSteps: any[];
        liveStepKeys: Set<string>;
        lastCodexRenderKey: string | null;
        container: HTMLElement | null;
        /** Store the uniqueId of the fullscreen container, used to find the corresponding card when subtask_complete */
        fullscreenId: string | null;
        startedAt: number;
        lastStepAt: number;
        completedAt: number | null;
        isComplete: boolean;
        subtaskStatus: string | null;
        lastSummaryRenderAt: number;
        pendingThinkingRender: boolean;
        pendingTextRender: boolean;
        pendingCodexRender: boolean;
        pendingCodexFinalContent: string;
        lastSpecialKey: string | null;
        lastSpecialElement: HTMLElement | null;
    }
    const streamStates = new Map<string, AgentStreamState>();
    let standaloneCompactionCard: HTMLElement | null = null;
    let subagentTicker: ReturnType<typeof setInterval> | null = null;
    const LIVE_RENDER_MAX_CHARS = 16000;
    const LIVE_SPECIAL_MAX_ITEMS = 18;

    function clipLiveMarkdownContent(content: string): string {
        if (content.length <= LIVE_RENDER_MAX_CHARS) return content;
        const head = content.substring(0, 5000);
        const tail = content.substring(content.length - 10000);
        const hidden = Math.max(0, content.length - head.length - tail.length);
        return `${head}\n\n...\n\n[${hidden} chars hidden while streaming]\n\n...\n\n${tail}`;
    }

    function liveStepCoalesceKey(step: any): string | null {
        if (!step || step.type !== 'orchestrator_progress') return null;
        const content = String(step.content || '').replace(/\(\d+s\)/g, '(...)').trim();
        if (!content) return null;
        if (/waiting|等待模型返回/i.test(content)) return `${step.agentId || '__main__'}:wait-model`;
        return `${step.agentId || '__main__'}:progress:${content}`;
    }

    function coalesceLiveStep(state: AgentStreamState, step: any): boolean {
        const key = liveStepCoalesceKey(step);
        if (!key || state.liveSteps.length === 0) return false;
        const last = state.liveSteps[state.liveSteps.length - 1];
        if (liveStepCoalesceKey(last) !== key) return false;
        state.liveSteps[state.liveSteps.length - 1] = step;
        return true;
    }

    function getStreamState(agentId: string | undefined): AgentStreamState {
        const key = agentId || '__main__';
        let state = streamStates.get(key);
        if (!state) {
            state = {
                livePhase: null,
                liveSummary: !agentId && currentAssistantDiv ? currentAssistantDiv.querySelector(':scope > .live-run-summary-anchor') as HTMLElement | null : null,
                liveProcessPanel: null,
                liveProcessBody: null,
                liveTextProcessBody: null,
                liveThinkBlock: null,
                liveThinkBody: null,
                liveThinkSum: null,
                liveToolTimeline: null,
                liveCompactionCard: null,
                liveTextBubble: null,
                liveTextContent: '',
                liveThinkContent: '',
                liveSteps: [],
                liveStepKeys: new Set(),
                lastCodexRenderKey: null,
                container: currentAssistantDiv,
                fullscreenId: null,
                startedAt: Date.now(),
                lastStepAt: Date.now(),
                completedAt: null,
                isComplete: false,
                subtaskStatus: null,
                lastSummaryRenderAt: 0,
                pendingThinkingRender: false,
                pendingTextRender: false,
                pendingCodexRender: false,
                pendingCodexFinalContent: '',
                lastSpecialKey: null,
                lastSpecialElement: null,
            };
            if (agentId && currentAssistantDiv) {
                const uniqueId = `live-subview-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                state.fullscreenId = uniqueId;

                // Card representation in the main timeline
                const card = document.createElement('div');
                card.className = 'orch-lane lane-running subagent-card';
                card.innerHTML = buildSubagentCardHtml(agentId, uniqueId, chatI18n);
                card.dataset.targetId = uniqueId;
                currentAssistantDiv.appendChild(card);

                // Hidden fullscreen container
                const fullscreen = document.createElement('div');
                fullscreen.id = uniqueId;
                fullscreen.className = 'subagent-fullscreen-view';
                fullscreen.dataset.agentId = agentId;
                fullscreen.innerHTML = buildSubagentFullscreenHtml(agentId, uniqueId, chatI18n);
                bindSubagentScroll(fullscreen);
                currentAssistantDiv.appendChild(fullscreen);
                renderSubagentTodoPanel(fullscreen, []);

                const subagentBody = fullscreen.querySelector('.subagent-body') as HTMLElement;
                subagentBody.innerHTML = `<div class="codex-live-host">${renderAssistantTurnCodex('', [], {
                    i18n: chatI18n,
                    live: true,
                    renderMarkdown,
                    isSubagentView: true,
                })}</div>`;
                state.container = subagentBody;
                ensureSubagentTicker();
            }
            streamStates.set(key, state);
        }
        return state;
    }

    function updateSubagentCard(state: AgentStreamState, finalText?: string) {
        if (!state.fullscreenId) return;
        const card = document.querySelector(`.subagent-card[data-target-id="${state.fullscreenId}"]`) as HTMLElement | null;
        if (!card) return;

        const now = Date.now();
        const summary = makeRunSummary(state.liveSteps, finalText);
        const idleMs = state.isComplete ? 0 : now - state.lastStepAt;
        const toolName = latestLiveToolName(state.liveSteps, chatI18n.live.waitingForOutput);
        const isBlocked = !state.isComplete && /澄清|clarification|blocked/i.test(finalText || summary.latestStatus || '');

        card.classList.remove('lane-running', 'lane-done', 'lane-failed', 'lane-stalled', 'lane-blocked');
        if (!state.isComplete) {
            card.classList.add(isBlocked ? 'lane-blocked' : 'lane-running');
            if (!isBlocked && idleMs >= 2 * 60 * 1000) card.classList.add('lane-stalled');
        } else if (state.subtaskStatus === 'failed' || state.subtaskStatus === 'cancelled') {
            card.classList.add('lane-failed');
        } else if (state.subtaskStatus === 'pending_validation' || state.subtaskStatus === 'needs_clarification') {
            card.classList.add('lane-blocked');
        } else {
            card.classList.add('lane-done');
        }

        const statusText = card.querySelector('.lane-status-text') as HTMLElement | null;
        if (statusText) {
            const livePrefix = state.isComplete
                ? (finalText || summary.latestStatus || tr('Complete', '完成'))
                : idleMs >= 2 * 60 * 1000
                    ? tr(`Waiting ${formatDuration(idleMs)} · ${summary.latestStatus}`, `等待 ${formatDuration(idleMs)} · ${summary.latestStatus}`)
                    : summary.latestStatus;
            statusText.textContent = livePrefix.length > 100 ? livePrefix.slice(0, 100) + '...' : livePrefix;
        }

        const meta = card.querySelector('.lane-live-meta') as HTMLElement | null;
        if (meta) {
            meta.innerHTML = buildSubagentMetaHtml(state, summary, toolName, now, chatI18n);
        }

        const fullscreen = document.getElementById(state.fullscreenId);
        if (fullscreen) {
            const subtitle = fullscreen.querySelector('.subagent-subtitle') as HTMLElement | null;
            if (subtitle) subtitle.textContent = summary.latestStatus;
            const metrics = fullscreen.querySelector('.subagent-header-metrics') as HTMLElement | null;
            if (metrics) {
                metrics.innerHTML = buildSubagentHeaderMetricsHtml(state, summary, now, chatI18n);
            }
        }
    }

    function ensureSubagentTicker() {
        if (subagentTicker) return;
        subagentTicker = setInterval(() => {
            let activeCount = 0;
            for (const [key, state] of streamStates.entries()) {
                if (key !== '__main__') {
                    if (!state.isComplete) {
                        activeCount++;
                        updateSubagentCard(state);
                    }
                }
            }
            // 💡 Performance Optimization: If no active subagents are currently running,
            // tear down the interval ticker to release main thread CPU cycles.
            if (activeCount === 0 && subagentTicker) {
                clearInterval(subagentTicker);
                subagentTicker = null;
            }
        }, 5000);
    }

    function ensureLiveProcessPanel(state: AgentStreamState) {
        if (!state.container) return null;
        if (!state.liveProcessPanel) {
            state.liveProcessPanel = document.createElement('div');
            state.liveProcessPanel.className = 'agent-process-panel live-process-panel process-expanded';
            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'process-panel-header';
            header.innerHTML = `<span class="process-panel-chevron"></span>` + buildLiveProcessSummaryHtml('layers', chatI18n.live.realtimeProcess, '');
            header.addEventListener('click', () => {
                const isOpen = state.liveProcessPanel!.classList.toggle('process-expanded');
                const body = state.liveProcessBody;
                if (body) {
                    if (isOpen) {
                        body.style.maxHeight = 'none';
                        body.style.opacity = '1';
                    } else {
                        body.style.maxHeight = body.scrollHeight + 'px';
                        void body.offsetHeight;
                        body.style.maxHeight = '0';
                        body.style.opacity = '0';
                    }
                }
            });
            state.liveProcessPanel.appendChild(header);
            state.liveProcessBody = document.createElement('div');
            state.liveProcessBody.className = 'process-panel-body';
            state.liveProcessBody.style.maxHeight = 'none';
            state.liveProcessBody.style.opacity = '1';
            const stack = document.createElement('div');
            stack.className = 'process-stack live-process-stack';
            state.liveProcessBody.appendChild(stack);
            state.liveProcessPanel.appendChild(state.liveProcessBody);
            if (state.liveSummary && state.liveSummary.nextSibling) {
                state.container.insertBefore(state.liveProcessPanel, state.liveSummary.nextSibling);
            } else {
                state.container.appendChild(state.liveProcessPanel);
            }
        }
        const meta = state.liveProcessPanel.querySelector('.process-panel-header .process-meta');
        if (meta) meta.textContent = buildLiveProcessMeta(state.liveSteps, chatI18n);
        // Return the inner stack, not the body wrapper
        return state.liveProcessBody?.querySelector('.process-stack') as HTMLElement | null ?? state.liveProcessBody;
    }

    function ensureLiveSummary(state: AgentStreamState, step?: any) {
        if (!state.container) return;
        if (!state.liveSummary) {
            state.liveSummary = document.createElement('div');
            state.liveSummary.className = 'live-run-summary-anchor';
            state.container.prepend(state.liveSummary);
        }
        const now = Date.now();
        const noisy = step && (step.type === 'text_delta' || step.type === 'thinking_content' || step.type === 'orchestrator_progress');
        if (noisy && now - state.lastSummaryRenderAt < 800) return;
        state.lastSummaryRenderAt = now;
        state.liveSummary.innerHTML = renderRunSummaryHtml(makeRunSummary(state.liveSteps), true);
    }

    function initLiveAssistantDiv() {
        const div = document.createElement('div');
        div.className = 'message assistant live-msg codex-message';
        const host = document.createElement('div');
        host.className = 'codex-live-host';
        host.innerHTML = renderAssistantTurnCodex('', [], {
            i18n: chatI18n,
            live: true,
            renderMarkdown,
        });
        div.appendChild(host);
        return div;
    }

    interface CodexTurnUiSnapshot {
        turnCollapsed: boolean;
        expandedGroupIds: Set<string>;
        expandedGroupKeys: Set<string>;
        expandedRowIds: Set<string>;
        expandedRowKeys: Set<string>;
        hadExpandedGroup: boolean;
    }

    function codexGroupStableKey(group: HTMLElement): string {
        return (group.dataset.activityGroupId || '').replace(/-\d+$/, '');
    }

    function codexRowStableKey(row: HTMLElement): string {
        return row.dataset.invocationId || (row.dataset.activityId || '').replace(/-\d+$/, '');
    }

    function snapshotCodexTurnUiState(host: HTMLElement): CodexTurnUiSnapshot {
        const turn = host.querySelector(':scope > .codex-turn') as HTMLElement | null;
        const groups = Array.from(host.querySelectorAll<HTMLElement>('.codex-activity-group'));
        const expandedGroups = groups.filter(group => !group.classList.contains('codex-activity-group-collapsed'));
        const rows = Array.from(host.querySelectorAll<HTMLElement>('.codex-activity-row'));
        const expandedRows = rows.filter(row => row.querySelector('[data-codex-activity-row-toggle]') && !row.classList.contains('codex-activity-row-collapsed'));
        return {
            turnCollapsed: !!turn?.classList.contains('codex-turn-collapsed'),
            expandedGroupIds: new Set(expandedGroups.map(group => group.dataset.activityGroupId || '').filter(Boolean)),
            expandedGroupKeys: new Set(expandedGroups.map(codexGroupStableKey).filter(Boolean)),
            expandedRowIds: new Set(expandedRows.map(row => row.dataset.activityId || '').filter(Boolean)),
            expandedRowKeys: new Set(expandedRows.map(codexRowStableKey).filter(Boolean)),
            hadExpandedGroup: expandedGroups.length > 0,
        };
    }

    function restoreCodexTurnUiState(host: HTMLElement, snapshot: CodexTurnUiSnapshot): void {
        const turn = host.querySelector(':scope > .codex-turn') as HTMLElement | null;
        const turnToggle = host.querySelector('[data-codex-turn-toggle]') as HTMLElement | null;
        if (turn) turn.classList.toggle('codex-turn-collapsed', snapshot.turnCollapsed);
        if (turnToggle) turnToggle.setAttribute('aria-expanded', snapshot.turnCollapsed ? 'false' : 'true');

        const groups = Array.from(host.querySelectorAll<HTMLElement>('.codex-activity-group'));
        let restoredExpandedGroup = false;
        for (const group of groups) {
            const shouldExpand = snapshot.expandedGroupIds.has(group.dataset.activityGroupId || '')
                || snapshot.expandedGroupKeys.has(codexGroupStableKey(group));
            if (shouldExpand) {
                group.classList.remove('codex-activity-group-collapsed');
                restoredExpandedGroup = true;
            }
            const toggle = group.querySelector('[data-codex-activity-group-toggle]') as HTMLElement | null;
            if (toggle) toggle.setAttribute('aria-expanded', group.classList.contains('codex-activity-group-collapsed') ? 'false' : 'true');
        }

        const rows = Array.from(host.querySelectorAll<HTMLElement>('.codex-activity-row'));
        for (const row of rows) {
            const shouldExpand = snapshot.expandedRowIds.has(row.dataset.activityId || '')
                || snapshot.expandedRowKeys.has(codexRowStableKey(row));
            if (shouldExpand) row.classList.remove('codex-activity-row-collapsed');
            const toggle = row.querySelector('[data-codex-activity-row-toggle]') as HTMLElement | null;
            if (toggle) toggle.setAttribute('aria-expanded', row.classList.contains('codex-activity-row-collapsed') ? 'false' : 'true');
        }

        if (snapshot.hadExpandedGroup && !restoredExpandedGroup && groups.length > 0) {
            const group = groups[0]!;
            group.classList.remove('codex-activity-group-collapsed');
            const toggle = group.querySelector('[data-codex-activity-group-toggle]') as HTMLElement | null;
            if (toggle) toggle.setAttribute('aria-expanded', 'true');
        }
    }

    function renderCodexLiveTurn(state: AgentStreamState, finalContent = ''): void {
        if (!state.container) return;
        const host = state.container.querySelector(':scope > .codex-live-host') as HTMLElement | null;
        if (!host) return;
        // Skip a full rebuild when neither the step list nor the text moved.
        const lastStep = state.liveSteps[state.liveSteps.length - 1];
        const lastSig = lastStep ? `${lastStep.invocationId ?? lastStep.type ?? ''}:${lastStep.content ?? lastStep.toolName ?? ''}` : '';
        const renderKey = `${state.liveSteps.length}:${lastSig}:${finalContent.length}`;
        if (renderKey === state.lastCodexRenderKey) return;
        state.lastCodexRenderKey = renderKey;
        const uiSnapshot = snapshotCodexTurnUiState(host);
        host.innerHTML = renderAssistantTurnCodex(finalContent, state.liveSteps.filter(step => !isContextCompactionStep(step)), {
            i18n: chatI18n,
            live: !state.isComplete,
            renderMarkdown,
            isSubagentView: !!state.fullscreenId,
        });
        restoreCodexTurnUiState(host, uiSnapshot);
        enhanceCodeBlocks(host);
        enhanceTaskLists(host);
    }

    function scheduleCodexLiveTurnRender(state: AgentStreamState, finalContent = ''): void {
        if (finalContent) state.pendingCodexFinalContent = finalContent;
        if (state.pendingCodexRender) return;
        state.pendingCodexRender = true;
        requestAnimationFrame(() => {
            state.pendingCodexRender = false;
            const pendingFinalContent = state.pendingCodexFinalContent;
            state.pendingCodexFinalContent = '';
            renderCodexLiveTurn(state, pendingFinalContent);
            scrollBottom();
        });
    }

    function appendCodexLiveSyntheticStep(step: any): void {
        if (!currentAssistantDiv?.classList.contains('codex-message')) return;
        const state = getStreamState(undefined);
        const key = step.invocationId || step.permissionId || step.messageId || `${step.type}:${step.content || step.toolName || ''}`;
        if (key) {
            if (state.liveStepKeys.has(key)) return;
            state.liveStepKeys.add(key);
            while (state.liveStepKeys.size > 320) {
                const oldest = state.liveStepKeys.values().next().value as string | undefined;
                if (oldest === undefined) break;
                state.liveStepKeys.delete(oldest);
            }
        }
        pushBoundedWebviewLiveStep(state.liveSteps, step);
        state.lastStepAt = Date.now();
        scheduleCodexLiveTurnRender(state);
    }

    function flushLiveText(state: AgentStreamState) {
        if (state.liveTextBubble) {
            state.liveTextBubble.classList.remove('stream-cursor');
            state.liveTextBubble.innerHTML = renderMarkdown(clipLiveMarkdownContent(state.liveTextContent));
        }
        if (state.liveTextProcessBody) {
            state.liveTextProcessBody.classList.remove('stream-cursor');
            state.liveTextProcessBody.innerHTML = renderMarkdown(clipLiveMarkdownContent(state.liveTextContent));
        }
        state.liveTextBubble = null;
        state.liveTextProcessBody = null;
        state.liveTextContent = '';
    }

    function scheduleThinkingRender(state: AgentStreamState) {
        if (state.pendingThinkingRender) return;
        state.pendingThinkingRender = true;
        requestAnimationFrame(() => {
            state.pendingThinkingRender = false;
            if (state.liveThinkBody) {
                rerenderScrollableBody(state.liveThinkBody, renderMarkdown(clipLiveMarkdownContent(state.liveThinkContent)));
            }
            if (state.liveThinkSum) {
                state.liveThinkSum.innerHTML = buildThinkingSummaryHtml(state.liveThinkContent, chatI18n);
            }
            scrollBottom();
        });
    }

    function finishLiveThinking(state: AgentStreamState) {
        if (!state.liveThinkBlock) return;

        const content = state.liveThinkContent.trim();
        if (!content) {
            state.liveThinkBlock.remove();
        } else {
            if (state.liveThinkBody) {
                state.liveThinkBody.innerHTML = renderMarkdown(clipLiveMarkdownContent(state.liveThinkContent));
            }
            if (state.liveThinkSum) {
                state.liveThinkSum.innerHTML = buildThinkingSummaryHtml(state.liveThinkContent, chatI18n);
            }
            const pulse = state.liveThinkBlock.querySelector('.think-pulse');
            if (pulse) pulse.classList.remove('spinning');
        }

        state.liveThinkBlock = null;
        state.liveThinkBody = null;
        state.liveThinkSum = null;
        state.liveThinkContent = '';
    }

    function scheduleTextRender(state: AgentStreamState) {
        if (state.pendingTextRender) return;
        state.pendingTextRender = true;
        requestAnimationFrame(() => {
            state.pendingTextRender = false;
            if (state.liveTextProcessBody) {
                rerenderScrollableBody(state.liveTextProcessBody, renderMarkdown(clipLiveMarkdownContent(state.liveTextContent)));
            }
            scrollBottom();
        });
    }

    function createToolPairElement(html: string): HTMLElement | null {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        return wrapper.firstElementChild as HTMLElement | null;
    }

    function applyLiveCompactionStep(state: AgentStreamState, step: RendererStep): void {
        const startsNewCard = step.compactionInfo?.state === 'start'
            && state.liveCompactionCard?.dataset.compactionState !== 'start';
        if (!state.liveCompactionCard?.isConnected || startsNewCard) {
            state.liveCompactionCard = createContextCompactionCard(step);
            state.container?.appendChild(state.liveCompactionCard);
        } else {
            updateContextCompactionCard(state.liveCompactionCard, step);
        }
        updateContextMeterFromCompaction(step);
    }

    function applyStandaloneCompactionStep(step: RendererStep): void {
        const startsNewCard = step.compactionInfo?.state === 'start'
            && standaloneCompactionCard?.dataset.compactionState !== 'start';
        if (!standaloneCompactionCard?.isConnected || startsNewCard) {
            standaloneCompactionCard = createContextCompactionCard(step);
            standaloneCompactionCard.classList.add('context-compaction-standalone');
            chatArea.appendChild(standaloneCompactionCard);
        } else {
            updateContextCompactionCard(standaloneCompactionCard, step);
            standaloneCompactionCard.classList.add('context-compaction-standalone');
        }
        updateContextMeterFromCompaction(step);
        scrollBottom(true);
    }

    function applyLiveStep(s: any) {
        if (!currentAssistantDiv) return;

        const state = getStreamState(s.agentId);
        if (s.agentId && reactivateSubagentStreamState(state, s.type)) {
            ensureSubagentTicker();
        }
        if ((s.type === 'thinking' || s.type === 'thinking_content') && !state.liveThinkBlock && !hasVisibleLiveContent(s)) {
            return;
        }

        if (state.container?.querySelector(':scope > .codex-live-host')) {
            const coalesced = coalesceLiveStep(state, s);
            if (!coalesced) pushBoundedWebviewLiveStep(state.liveSteps, s);
            state.lastStepAt = Date.now();
            if (s.type === 'subtask_complete') {
                state.isComplete = true;
                state.subtaskStatus = s.subtaskStatus || 'completed';
                state.completedAt = Date.now();
            }
            scheduleCodexLiveTurnRender(state, s.type === 'subtask_complete' ? (s.content || '') : '');
            if (s.agentId) {
                updateSubagentCard(state, s.type === 'subtask_complete' ? (s.content || '') : undefined);
            }
            return;
        }
        const coalesced = coalesceLiveStep(state, s);
        if (!coalesced) pushBoundedWebviewLiveStep(state.liveSteps, s);
        ensureLiveSummary(state, s);
        state.lastStepAt = Date.now();
        updateSubagentCard(state);

        if (s.type === 'compaction' && s.compactionInfo) {
            applyLiveCompactionStep(state, s as RendererStep);
            scrollBottom();
            return;
        }

        if (s.type === 'subtask_complete') {
            state.isComplete = true;
            state.subtaskStatus = s.subtaskStatus || 'completed';
            state.completedAt = Date.now();
            if (state.liveSummary) {
                state.liveSummary.innerHTML = renderRunSummaryHtml(makeRunSummary(state.liveSteps, s.content), false);
            }
            // Find card using explicitly stored fullscreenId (fix: state.container points to .subagent-body, no id)
            if (state.fullscreenId) {
                const card = document.querySelector(`.subagent-card[data-target-id="${state.fullscreenId}"]`);
                if (card) {
                    card.classList.remove('lane-running', 'lane-done', 'lane-failed', 'lane-stalled', 'lane-blocked');
                    if (state.subtaskStatus === 'failed' || state.subtaskStatus === 'cancelled') {
                        card.classList.add('lane-failed');
                    } else if (state.subtaskStatus === 'pending_validation' || state.subtaskStatus === 'needs_clarification') {
                        card.classList.add('lane-blocked');
                    } else {
                        card.classList.add('lane-done');
                    }
                    const statusText = card.querySelector('.lane-status-text');
                    if (statusText) statusText.textContent = s.content || tr('Complete', '完成');
                }
            }
            updateSubagentCard(state, s.content || tr('Complete', '完成'));
            // Terminate all active streaming states - the child agent has completed and there will be no new steps
            // 1. Terminate the Thinking block: stop the spinning indicator
            if (state.liveThinkBlock) {
                finishLiveThinking(state);
            }
            // 2. End text bubble
            if (state.liveTextBubble) flushLiveText(state);
            // 3. Clean tool timeline references
            state.liveToolTimeline = null;
            state.livePhase = null;
            return;
        }

        const target = routeLiveStep(s);

        // Determine the new phase
        const newPhase = target === 'thinking' ? 'thinking' : target === 'text_bubble' ? 'text' : target === 'tool_call' ? 'tool' : target === 'tool_result' ? 'tool' : 'special';

        // ── Phase transition: finalize current container and start new one ──
        if (newPhase !== 'special' && newPhase !== state.livePhase && target !== 'tool_result') {
            // Finalize previous text bubble if transitioning away from text
            if (state.livePhase === 'text' && state.liveTextBubble) {
                flushLiveText(state);
            }
            // Finalize previous thinking block if transitioning away from thinking
            if (state.livePhase === 'thinking' && state.liveThinkBlock) {
                finishLiveThinking(state);
            }
            // Clear tool timeline ref if transitioning away from tool
            if (state.livePhase === 'tool' && newPhase !== 'tool') {
                state.liveToolTimeline = null;
            }
            state.livePhase = newPhase;
        }

        // ── Thinking: create or reuse a thinking block at current position ──
        if (target === 'thinking') {
            const processBody = ensureLiveProcessPanel(state);
            if (!state.liveThinkBlock) {
                state.liveThinkBlock = document.createElement('details');
                state.liveThinkBlock.className = 'process-section process-thinking live-thinking-block'; (state.liveThinkBlock as HTMLDetailsElement).open = false;
                state.liveThinkSum = document.createElement('summary');
                state.liveThinkSum.innerHTML = `<span class="think-pulse spinning"></span>${tr('Thinking details...', '思考详情...')}`;
                state.liveThinkBlock.appendChild(state.liveThinkSum);
                state.liveThinkBody = document.createElement('div');
                state.liveThinkBody.className = 'thinking-body markdown-body';
                state.liveThinkBlock.appendChild(state.liveThinkBody);
                processBody?.appendChild(state.liveThinkBlock);
            }
            if (state.liveThinkBody) {
                if (s.type === 'thinking' && state.liveThinkContent) {
                    state.liveThinkContent += '\n\n---\n\n' + (s.content || '');
                } else {
                    state.liveThinkContent += (s.content || '');
                }
                scheduleThinkingRender(state);
            }
            return;
        }

        // ── text_delta: create or reuse a text bubble at current position ──
        if (target === 'text_bubble') {
            const processBody = ensureLiveProcessPanel(state);
            if (!state.liveTextProcessBody && processBody) {
                const section = document.createElement('details');
                section.className = 'process-section process-text live-process-text';
                section.open = false;
                const summary = document.createElement('summary');
                summary.innerHTML = buildLiveProcessSummaryHtml('file', tr('Process text', '过程文本'), 'streaming');
                section.appendChild(summary);
                state.liveTextProcessBody = document.createElement('div');
                state.liveTextProcessBody.className = 'thinking-body process-text-body markdown-body stream-cursor';
                section.appendChild(state.liveTextProcessBody);
                processBody.appendChild(section);
            }
            if (state.liveTextProcessBody) {
                state.liveTextContent += (s.content || '');
                scheduleTextRender(state);
            }
            return;
        }

        // ── tool_call: create or reuse a tool timeline at current position ──
        if (target === 'tool_call') {
            const processBody = ensureLiveProcessPanel(state);
            if (!state.liveToolTimeline) {
                const toolSection = document.createElement('details');
                toolSection.className = 'process-section process-tools live-process-tools';
                toolSection.open = false;
                const summary = document.createElement('summary');
                summary.innerHTML = buildLiveProcessSummaryHtml(
                    'gear',
                    chatI18n.locale === 'zh-cn' ? '工具详情' : 'Tool details',
                    chatI18n.locale === 'zh-cn' ? '实时调用' : 'Live calls',
                );
                toolSection.appendChild(summary);
                state.liveToolTimeline = document.createElement('div');
                state.liveToolTimeline.className = 'tool-timeline process-tool-timeline live-tool-timeline';
                toolSection.appendChild(state.liveToolTimeline);
                processBody?.appendChild(toolSection);
            }
            const stepIdx = s.stepIndex || (state.liveToolTimeline.querySelectorAll('.tool-pair').length + 1);
            const toolMeta = state.liveToolTimeline.closest('.process-tools')?.querySelector('.process-meta');
            if (toolMeta) toolMeta.textContent = chatI18n.locale === 'zh-cn' ? `${stepIdx} 次调用` : `${stepIdx} call(s)`;
            const pairDiv = createToolPairElement(buildToolPairHtml(s as RendererStep, undefined, {
                stepIndex: stepIdx,
                showDuration: false,
                locale: chatI18n.locale,
            }));
            if (!pairDiv) return;
            pairDiv.dataset.tool = s.toolName || '';
            pairDiv.dataset.callIdx = String(stepIdx);
            pairDiv.dataset.callTs = String(s.timestamp || Date.now());
            // Store toolArgs so we can recover them when tool_result arrives
            try { pairDiv.dataset.callArgs = JSON.stringify(s.toolArgs || {}); } catch { pairDiv.dataset.callArgs = '{}'; }

            // Auto-collapse: when tool count exceeds threshold, wrap overflow in <details>
            const LIVE_COLLAPSE_THRESHOLD = 1;
            const directPairs = state.liveToolTimeline.querySelectorAll(':scope > .tool-pair');
            if (directPairs.length >= LIVE_COLLAPSE_THRESHOLD) {
                let collapseEl = state.liveToolTimeline.querySelector(':scope > .tool-collapse') as HTMLDetailsElement | null;
                if (!collapseEl) {
                    collapseEl = document.createElement('details');
                    collapseEl.className = 'tool-collapse';
                    const sum = document.createElement('summary');
                    collapseEl.appendChild(sum);
                    state.liveToolTimeline.appendChild(collapseEl);
                    // Track user manual open — respect their intent
                    collapseEl.addEventListener('toggle', () => {
                        if ((collapseEl as HTMLDetailsElement).open) {
                            (collapseEl as HTMLElement).dataset.userOpened = '1';
                        }
                    });
                }
                // Move the 2nd+ direct pairs into the collapse
                const toMove = Array.from(state.liveToolTimeline.querySelectorAll(':scope > .tool-pair')).slice(1);
                for (const m of toMove) collapseEl.appendChild(m);
                // Append new pair into collapse too
                collapseEl.appendChild(pairDiv);
                const insideCount = collapseEl.querySelectorAll('.tool-pair').length;
                (collapseEl.querySelector('summary') as HTMLElement).textContent = chatI18n.locale === 'zh-cn'
                    ? `+${insideCount} 个更多工具调用`
                    : `+${insideCount} more tool calls`;
                // Default collapsed — only auto-open if the user has manually opened it
                if ((collapseEl as HTMLElement).dataset.userOpened) {
                    collapseEl.open = true;
                }
            } else {
                state.liveToolTimeline.appendChild(pairDiv);
            }
        } else if (target === 'tool_result') {
            // Find the most recent unresolved tool pair within the current agent view.
            const searchRoot = state.container || currentAssistantDiv;
            const allTimelines = searchRoot.querySelectorAll('.tool-timeline');
            for (let i = allTimelines.length - 1; i >= 0; i--) {
                const tl = allTimelines[i]!;
                const pairs = Array.from(tl.querySelectorAll('.tool-pair[data-tool="' + s.toolName + '"]:not([data-resolved])'));
                if (pairs.length > 0) {
                    const pair = pairs[0] as HTMLElement;
                    pair.dataset.resolved = '1';
                    const callTs = parseInt(pair.dataset.callTs || '0', 10);
                    const stepIdx = parseInt(pair.dataset.callIdx || '0', 10);
                    // Recover original toolArgs from stored data
                    let recoveredArgs: Record<string, unknown> = {};
                    try { recoveredArgs = JSON.parse(pair.dataset.callArgs || '{}'); } catch { /* ignore */ }
                    const fakeCall: RendererStep = { type: 'tool_call', toolName: s.toolName, toolArgs: recoveredArgs, content: '', timestamp: callTs };
                    const updatedPair = createToolPairElement(buildToolPairHtml(fakeCall, s as RendererStep, {
                        stepIndex: stepIdx,
                        showDuration: true,
                        showDiff: true,
                        locale: chatI18n.locale,
                    }));
                    if (updatedPair) {
                        pair.className = updatedPair.className;
                        pair.innerHTML = updatedPair.innerHTML;
                    }
                    break;
                }
            }
        } else if (target === 'special') {
            const processBody = ensureLiveProcessPanel(state);
            const specialKey = liveStepCoalesceKey(s);
            const el = document.createElement('div');
            // Add step type as additional CSS class name (consistent with finalized renderer)
            el.className = `special-step ${s.type}`;
            const icon = s.type === 'error' ? svgIconNoMargin('x')
                : s.type === 'validation' ? svgIconNoMargin('check')
                : s.type === 'orchestrator_progress' ? svgIconNoMargin('chart')
                : svgIconNoMargin('gear');
            // Replace $(iconName) codicon placeholder with SVG icon
            let safeContent = escapeHtml(s.content || '');
            safeContent = safeContent.replace(/\$\(([\w-]+)\)/g, (_match: string, iconName: string) => {
                if (iconName in Icons) {
                    return svgIconNoMargin(iconName as keyof typeof Icons);
                }
                return _match;
            });
            const nextHtml = icon + ' ' + safeContent;
            if (specialKey && state.lastSpecialKey === specialKey && state.lastSpecialElement?.isConnected) {
                state.lastSpecialElement.innerHTML = nextHtml;
            } else {
                el.innerHTML = nextHtml;
                processBody?.appendChild(el);
                state.lastSpecialKey = specialKey;
                state.lastSpecialElement = el;
                const specialItems = processBody ? Array.from(processBody.querySelectorAll(':scope > .special-step')) as HTMLElement[] : [];
                const overflow = specialItems.length - LIVE_SPECIAL_MAX_ITEMS;
                if (overflow > 0) {
                    for (const item of specialItems.slice(0, overflow)) item.remove();
                }
            }
        }
        scrollBottom();
    }

    function toggleCodexActivityControl(control: HTMLElement): boolean {
        const groupToggle = control.closest('[data-codex-activity-group-toggle]') as HTMLElement | null;
        if (groupToggle) {
            const group = groupToggle.closest('.codex-activity-group') as HTMLElement | null;
            if (!group) return false;
            const collapsed = group.classList.toggle('codex-activity-group-collapsed');
            groupToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            return true;
        }

        const rowToggle = control.closest('[data-codex-activity-row-toggle]') as HTMLElement | null;
        if (rowToggle) {
            const row = rowToggle.closest('.codex-activity-row') as HTMLElement | null;
            if (!row) return false;
            const collapsed = row.classList.toggle('codex-activity-row-collapsed');
            rowToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            return true;
        }

        const toggle = control.closest('[data-codex-turn-toggle]') as HTMLElement | null;
        if (!toggle) return false;
        const turn = toggle.closest('.codex-turn') as HTMLElement | null;
        if (!turn) return false;
        const collapsed = turn.classList.toggle('codex-turn-collapsed');
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        return true;
    }

    let suppressLiveCodexClickUntil = 0;
    chatArea.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const control = (e.target as HTMLElement).closest(
            '[data-codex-activity-group-toggle], [data-codex-activity-row-toggle], [data-codex-turn-toggle]',
        ) as HTMLElement | null;
        if (!control?.closest('.codex-live-host')) return;
        // Streaming replaces the live turn DOM on every animation frame, which can
        // remove a pressed button before the browser dispatches its click event.
        if (toggleCodexActivityControl(control)) {
            suppressLiveCodexClickUntil = performance.now() + 750;
        }
    });

    chatArea.addEventListener('click', (e) => {
        const control = (e.target as HTMLElement).closest(
            '[data-codex-activity-group-toggle], [data-codex-activity-row-toggle], [data-codex-turn-toggle]',
        ) as HTMLElement | null;
        if (!control) return;
        if (control.closest('.codex-live-host') && e.detail > 0 && performance.now() <= suppressLiveCodexClickUntil) {
            return;
        }
        toggleCodexActivityControl(control);
    });

    // ── Phase 5: Event delegation for inline permission buttons in tool timeline ──
    chatArea.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.tp-perm-btn') as HTMLElement | null;
        if (!btn) return;
        const permId = btn.dataset.perm;
        const action = btn.dataset.action;
        if (!permId || !action) return;
        floatingPermissionIds.delete(permId);
        document.querySelectorAll('.permission-card[data-perm-id]').forEach(el => {
            if ((el as HTMLElement).dataset.permId === permId) dismissCard(el as HTMLElement, 0);
        });

        // Disable all sibling buttons
        const parent = btn.closest('.tp-perm-actions');
        if (parent) {
            parent.querySelectorAll('.tp-perm-btn').forEach(b => {
                (b as HTMLButtonElement).disabled = true;
                (b as HTMLElement).style.opacity = '0.4';
            });
        }

        if (action === 'allow') {
            btn.textContent = tr('✓ Allowed', '✓ 已允许');
            vscode.postMessage({ type: 'permissionResponse', permissionId: permId, allowed: true });
        } else if (action === 'deny') {
            btn.textContent = tr('✗ Denied', '✗ 已拒绝');
            vscode.postMessage({ type: 'permissionResponse', permissionId: permId, allowed: false });
        } else if (action === 'always') {
            btn.textContent = tr('✓ Always allowed', '✓ 已一直允许');
            vscode.postMessage({ type: 'permissionResponse', permissionId: permId, allowed: true, alwaysAllow: true });
        }
    });

    // Subagent drill-down view navigation via event delegation
    chatArea.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const subagentCard = target.closest('.subagent-card') as HTMLElement | null;
        if (subagentCard) {
            const uniqueId = subagentCard.dataset.targetId;
            if (uniqueId) {
                (window as any).openSubagentView(uniqueId);
                return;
            }
        }
        
        const backBtn = target.closest('.subagent-back-btn') as HTMLElement | null;
        if (backBtn) {
            const uniqueId = backBtn.dataset.targetId;
            if (uniqueId) {
                (window as any).closeSubagentView(uniqueId);
                return;
            }
        }
    });

    // ── User message ───────────────────────────────────────────────────────────
    // Builds inline image thumbnails (clickable lightbox) from images array
    function buildImageRow(images: string[]) {
        if (!images || !images.length) return null;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
        for (const src of images) {
            const img = document.createElement('img');
            img.src = src;
            img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,0.12);cursor:zoom-in;transition:transform 0.15s;';
            img.title = tr('Click to enlarge', '点击放大');
            img.addEventListener('click', () => showImageLightbox(src));
            img.addEventListener('mouseenter', () => { img.style.transform = 'scale(1.07)'; });
            img.addEventListener('mouseleave', () => { img.style.transform = ''; });
            row.appendChild(img);
        }
        return row;
    }

    function buildContextChipRow(contexts?: ActiveContext[]) {
        if (!contexts || contexts.length === 0) return null;
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'message-reference-row';
        for (const ctx of contexts) {
            const meta = CONTEXT_TYPE_META[ctx.type] || CONTEXT_TYPE_META.file;
            const range = typeof ctx.startLine === 'number' && typeof ctx.endLine === 'number'
                ? ` #L${ctx.startLine}-${ctx.endLine}`
                : typeof ctx.line === 'number'
                    ? ` #L${ctx.line + 1}`
                    : '';
            const title = ctx.description || ctx.uri || ctx.label;
            const metaBits = [
                typeof ctx.tokenEstimate === 'number' && ctx.tokenEstimate > 0 ? `~${formatNum(ctx.tokenEstimate)} tok` : '',
                ctx.cacheStatus ? ctx.cacheStatus : '',
            ].filter(Boolean).join(' · ');
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `reference-chip ref-${ctx.type} ref-clickable`;
            chip.title = title;
            chip.innerHTML = `
                ${svgIconNoMargin(meta.icon)}
                <span class="ref-kind">${escapeHtml(meta.label)}</span>
                <span class="ref-text">${escapeHtml(ctx.label)}${range}</span>
                ${metaBits ? `<span class="ref-meta">${escapeHtml(metaBits)}</span>` : ''}
            `;
            chip.addEventListener('click', () => {
                vscode.postMessage({ type: 'openContextReference', context: ctx });
            });
            chipsContainer.appendChild(chip);
        }
        return chipsContainer;
    }

    function appendUserMessageText(bubble: HTMLElement, text: string): void {
        const presentation = buildUserMessagePresentation(text);
        if (!presentation.isLong) {
            const textNode = document.createElement('div');
            textNode.className = 'user-message-text';
            textNode.textContent = text;
            bubble.appendChild(textNode);
            return;
        }

        bubble.classList.add('long-user-input-bubble');
        const card = document.createElement('details');
        card.className = 'long-user-input-card';

        const summary = document.createElement('summary');
        summary.className = 'long-user-input-summary';
        summary.setAttribute('aria-label', tr('Expand or collapse long user input', '展开或收起长输入'));

        const icon = document.createElement('span');
        icon.className = 'long-user-input-icon';
        icon.innerHTML = svgIconNoMargin('file');

        const heading = document.createElement('span');
        heading.className = 'long-user-input-heading';
        const title = document.createElement('strong');
        title.textContent = tr('Long input', '长输入');
        const meta = document.createElement('span');
        meta.textContent = tr(
            `${presentation.lineCount} lines · ${presentation.characterCount.toLocaleString()} characters`,
            `${presentation.lineCount} 行 · ${presentation.characterCount.toLocaleString()} 字符`,
        );
        heading.append(title, meta);

        const toggle = document.createElement('span');
        toggle.className = 'long-user-input-toggle';
        const expandLabel = document.createElement('span');
        expandLabel.className = 'long-user-input-toggle-expand';
        expandLabel.textContent = tr('Expand', '展开全文');
        const collapseLabel = document.createElement('span');
        collapseLabel.className = 'long-user-input-toggle-collapse';
        collapseLabel.textContent = tr('Collapse', '收起');
        toggle.append(expandLabel, collapseLabel);
        summary.append(icon, heading, toggle);

        const preview = document.createElement('div');
        preview.className = 'long-user-input-preview';
        preview.textContent = presentation.preview;

        const full = document.createElement('div');
        full.className = 'long-user-input-full';
        full.textContent = text;

        card.append(summary, preview, full);
        bubble.appendChild(card);
    }

    let liveAgentRoutingStatus: HTMLDivElement | null = null;

    function schedulingPhaseLabel(phase: AgentSchedulingStateView['phase']): string {
        return {
            inspect: tr('Inspect', '调查'),
            plan: tr('Plan', '计划'),
            execute: tr('Execute', '执行'),
            verify: tr('Verify', '验证'),
            finalize: tr('Finalize', '收尾'),
        }[phase];
    }

    function schedulingDispatchLabel(dispatch: AgentSchedulingStateView['dispatch']): string {
        return {
            single: tr('Single Agent', '单 Agent'),
            parallel: tr('Parallel', '并行'),
            specialist: tr('Specialists', '专家协作'),
        }[dispatch];
    }

    function schedulingAuthorizationLabel(authorization: AgentSchedulingStateView['authorization']): string {
        return {
            read_only: tr('Read-only', '只读'),
            plan_write_only: tr('Plan writes only', '仅计划写入'),
            workspace_write: tr('Workspace writes', '工作区写入'),
        }[authorization];
    }

    function clearAgentRoutingStatus(): void {
        liveAgentRoutingStatus?.remove();
        liveAgentRoutingStatus = null;
    }

    function updateAgentRoutingStatus(
        phase: 'classifying' | 'resolved' | 'fallback',
        state?: unknown,
    ): void {
        if (!liveAgentRoutingStatus) {
            emptyState.style.display = 'none';
            liveAgentRoutingStatus = document.createElement('div');
            liveAgentRoutingStatus.className = 'agent-routing-live';
            liveAgentRoutingStatus.setAttribute('role', 'status');
            liveAgentRoutingStatus.setAttribute('aria-live', 'polite');
            chatArea.appendChild(liveAgentRoutingStatus);
        }
        liveAgentRoutingStatus.replaceChildren();
        const indicator = document.createElement('span');
        indicator.className = phase === 'classifying' ? 'agent-routing-spinner' : 'agent-routing-dot';
        indicator.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        const resolved = parseSchedulingStateView(state);
        if (phase === 'classifying') {
            label.textContent = tr('Judging the task mode from its meaning…', '正在根据需求语义判断任务模式…');
        } else if (phase === 'fallback') {
            label.textContent = tr('Semantic routing was unavailable; using the safe rule fallback…', '语义路由暂不可用，正在使用安全规则回退…');
        } else if (resolved) {
            label.textContent = resolved.awaitingUserDecision
                ? tr('A user decision is required; execution remains blocked.', '需要用户敲定关键选择，本轮不会进入执行。')
                : tr(
                    `Scheduled ${schedulingPhaseLabel(resolved.phase)} with ${schedulingDispatchLabel(resolved.dispatch)}.`,
                    `已调度为${schedulingPhaseLabel(resolved.phase)}，${schedulingDispatchLabel(resolved.dispatch)}。`,
                );
        } else {
            label.textContent = tr('Scheduling decision completed.', '调度决策已完成。');
        }
        liveAgentRoutingStatus.append(indicator, label);
        scrollBottom();
    }

    function addUserMessage(text: string, msgIdx: number, images?: string[], contexts?: ActiveContext[], state?: unknown) {
        clearAgentRoutingStatus();
        emptyState.style.display = 'none';
        const div = document.createElement('div');
        div.className = 'message user codex-user-message';
        if (msgIdx !== undefined && msgIdx >= 0) div.dataset.msgIndex = String(msgIdx);

        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<span class="msg-role user-role">You</span><span class="msg-time">' + formatTime(Date.now()) + '</span>';

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble user-bubble codex-user-bubble';

        const localisationCardHtml = buildLocalisationPromptCardHtml(text, chatI18n.locale);
        if (localisationCardHtml) {
            bubble.classList.add('localisation-task-bubble');
            bubble.innerHTML = localisationCardHtml;
        } else {
        const structuredChips = buildContextChipRow(contexts);
        if (structuredChips) bubble.appendChild(structuredChips);
        
        // Parse Prompt template with code reference and convert it into UI chip (supports multiple references)
        const refRegex = /文件 `([^`]+)` 第 (\d+-\d+) 行[^\n]*：\n```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g;
        
        let remainingText = text;
        let match;
        const chipsContainer = document.createElement('div');
        chipsContainer.style.display = 'flex';
        chipsContainer.style.flexWrap = 'wrap';
        chipsContainer.style.gap = '4px';
        chipsContainer.style.marginBottom = '6px';
        let foundAny = false;

        while ((match = refRegex.exec(text)) !== null) {
            foundAny = true;
            const file = match[1] || '';
            const lines = match[2] || '';
            const fileName = file.split(/[\\/]/).pop() || file;
            
            const chip = document.createElement('div');
            chip.className = 'reference-chip';
            chip.style.background = 'rgba(100, 120, 255, 0.08)';
            chip.innerHTML = `<span class="ref-text" title="${escapeHtml(file)}">${escapeHtml(fileName)} #L${lines}</span>`;
            chipsContainer.appendChild(chip);
            
            remainingText = remainingText.replace(match[0], '');
        }

        if (foundAny) bubble.appendChild(chipsContainer);

        const textToShow = remainingText.trim();
        if (textToShow) {
            appendUserMessageText(bubble, textToShow);
        } else if (!structuredChips && !foundAny) {
            appendUserMessageText(bubble, text);
        }
        }

        // M6 fix: display image thumbnails from the actual images array
        const imgRow = buildImageRow(images || []);
        if (imgRow) bubble.appendChild(imgRow);

        div.appendChild(hdr);
        div.appendChild(bubble);

        const resolved = parseSchedulingStateView(state);
        if (resolved) {
            const routing = document.createElement('details');
            routing.className = `agent-routing-status agent-routing-${resolved.phase}`;
            const summary = document.createElement('summary');
            summary.className = 'agent-routing-summary';
            const sourceLabel = resolved.routingSource === 'model'
                ? tr('Semantic routing', '语义路由')
                : resolved.routingSource === 'workflow'
                    ? tr('Workflow scheduling', '工作流调度')
                    : resolved.routingSource === 'user'
                        ? tr('User scheduling', '用户调度')
                        : tr('Rule routing', '规则路由');
            summary.textContent = resolved.awaitingUserDecision
                ? `${sourceLabel} · ${tr('Awaiting your decision', '等待用户敲定')} · ${schedulingPhaseLabel(resolved.phase)}`
                : `${sourceLabel} · ${schedulingPhaseLabel(resolved.phase)} · ${schedulingDispatchLabel(resolved.dispatch)} · ${schedulingAuthorizationLabel(resolved.authorization)}`;
            routing.setAttribute('aria-label', `${tr('Task routing decision', '任务路由判断')}：${summary.textContent}`);
            routing.appendChild(summary);

            const explanation = document.createElement('div');
            explanation.className = 'agent-routing-explanation';
            if (resolved.awaitingUserDecision) {
                const boundary = document.createElement('div');
                boundary.className = 'agent-routing-decision-boundary';
                boundary.textContent = tr(
                    'A material choice must be made by you. The Agent is kept out of Execute mode until you answer.',
                    '存在必须由你决定的关键选择；在你答复前，Agent 不会进入执行模式。',
                );
                explanation.appendChild(boundary);
            }
            if (resolved.phaseReason) {
                const reason = document.createElement('div');
                reason.className = 'agent-routing-reason';
                reason.textContent = `${tr('Scheduling reason', '调度依据')}：${resolved.phaseReason}`;
                explanation.appendChild(reason);
            }
            if (resolved.dispatchReason && resolved.dispatchReason !== resolved.phaseReason) {
                const reason = document.createElement('div');
                reason.className = 'agent-routing-reason';
                reason.textContent = `${tr('Dispatch reason', '分派依据')}：${resolved.dispatchReason}`;
                explanation.appendChild(reason);
            }
            if (resolved.routeEvidence.length > 0) {
                const evidence = document.createElement('ul');
                evidence.className = 'agent-routing-evidence';
                for (const item of resolved.routeEvidence) {
                    const entry = document.createElement('li');
                    entry.textContent = item;
                    evidence.appendChild(entry);
                }
                explanation.appendChild(evidence);
            }
            if (resolved.routeConfidence > 0) {
                const confidence = document.createElement('div');
                confidence.className = 'agent-routing-confidence';
                confidence.textContent = `${tr('Confidence', '置信度')} ${Math.round(resolved.routeConfidence * 100)}%`;
                explanation.appendChild(confidence);
            }
            if (explanation.childElementCount > 0) routing.appendChild(explanation);
            div.appendChild(routing);
        }

        if (msgIdx !== undefined && msgIdx >= 0) {
            userMessagePayloadMap.set(msgIdx, cloneInputPayload({ text, images, contexts }));

            const actions = document.createElement('div');
            actions.className = 'message-actions user-message-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'message-action-btn edit-resend-btn';
            editBtn.type = 'button';
            editBtn.title = tr('Edit and resend', '编辑并重新发送');
            editBtn.setAttribute('aria-label', tr('Edit and resend this message', '编辑并重新发送此消息'));
            editBtn.innerHTML = `${svgIconNoMargin('pencil')}<span>${tr('Edit resend', '编辑重发')}</span>`;
            editBtn.addEventListener('click', () => beginEditMessage(msgIdx));

            const rb = document.createElement('button');
            rb.className = 'message-action-btn retract-btn';
            rb.type = 'button';
            rb.title = tr('Roll back to here', '回滚到此处');
            rb.setAttribute('aria-label', tr('Roll back before this message and restore input', '回滚到此消息之前并恢复输入'));
            rb.innerHTML = `${svgIconNoMargin('refresh')}<span>${tr('Rollback', '回滚')}</span>`;
            rb.addEventListener('click', () => showRetractConfirm(msgIdx));

            actions.appendChild(editBtn);
            actions.appendChild(rb);
            div.appendChild(actions);
            messageIndexMap.set(msgIdx, div);
        }
        // Batch 3: ARIA and virtual scroll
        setMessageAria(div, 'user');
        observeMessage(div);
        chatArea.appendChild(div);
        scrollBottom(true);
        return div;
    }

    function showRetractConfirm(messageIdx: number) {
        if (isGenerating) return;
        const payload = userMessagePayloadMap.get(messageIdx);
        const imageCount = payload?.images?.length || 0;
        const contextCount = payload?.contexts?.length || 0;
        const overlay = document.createElement('div');
        overlay.className = 'retract-confirm';
        overlay.innerHTML = `
            <div class="retract-confirm-box">
                <div class="retract-confirm-title">${tr('Roll back before this message?', '回滚到这条消息之前？')}</div>
                <div class="retract-confirm-hint">
                    <div>${tr('This will delete this user message and later AI replies, then try to restore file changes produced by those replies.', '将删除这条用户消息以及之后的 AI 回复，并尝试恢复这些回复产生的文件改动。')}</div>
                    <div>${tr(`The original message will be restored to the input with ${contextCount} reference(s) and ${imageCount} image(s).`, `完成后会把原消息放回输入框，包含 ${contextCount} 个引用和 ${imageCount} 张图片。`)}</div>
                    <div class="retract-confirm-note">${tr('File restore depends on the current topic snapshot; anything that cannot be restored will be reported after completion.', '文件恢复依赖当前会话快照；无法恢复的项目会在完成后提示。')}</div>
                </div>
                <div class="retract-confirm-btns">
                    <button class="retract-ok" type="button">${tr('Rollback and restore input', '回滚并恢复输入')}</button>
                    <button class="retract-cancel" type="button">${tr('Cancel', '取消')}</button>
                </div>
            </div>`;
        overlay.querySelector('.retract-ok')!.addEventListener('click', () => {
            overlay.remove();
            cancelInlineEdit();
            vscode.postMessage({ type: 'retractMessage', messageIndex: messageIdx });
        });
        overlay.querySelector('.retract-cancel')!.addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }
    // ── Card dismiss helper ────────────────────────────────────────────────────
    function dismissCard(el: HTMLElement, delay: number, onComplete?: () => void, removeDom: boolean = true) {
        setTimeout(() => {
            el.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            el.style.opacity = '0';
            el.style.transform = 'translateY(-4px)';
            setTimeout(() => {
                if (removeDom) {
                    el.remove();
                    forgetResponsiveWorkspaceContent(el);
                } else {
                    el.style.display = 'none';
                    el.style.opacity = '1';
                    el.style.transform = '';
                }
                if (onComplete) onComplete();
            }, 260);
        }, delay || 400);
    }
    
    // ── Diff card ──────────────────────────────────────────────────────────────
    function showAutoWriteCard(file: string, isNewFile: boolean) {
        const fileName = (file || '').split(/[\\/]/).pop() || file;
        const fileKey = normalizeSideDiffFilePath(file);
        const existing = fileKey
            ? chatArea.querySelector<HTMLElement>(`.auto-write-row[data-auto-write-path="${CSS.escape(fileKey)}"]`)
            : null;
        const wrap = existing || document.createElement('div');
        const nextCount = Number(wrap.dataset.autoWriteCount || 0) + 1;
        const previousStatus = wrap.dataset.autoWriteStatus || '';
        const status = previousStatus === 'created' || isNewFile ? 'created' : 'modified';
        wrap.dataset.autoWritePath = fileKey;
        wrap.dataset.autoWriteCount = String(nextCount);
        wrap.dataset.autoWriteStatus = status;
        wrap.className = 'auto-write-row';
        const tag = status === 'created' ? '<span class="aw-tag aw-new">NEW</span>' : '<span class="aw-tag aw-mod">MOD</span>';
        const count = nextCount > 1 ? `<span class="aw-count">×${nextCount}</span>` : '';
        wrap.innerHTML = `${svgIconNoMargin('sparkles')} ${tag} <span class="aw-file" title="${escapeHtml(file)}">${escapeHtml(fileName)}</span>${count}`;
        wrap.title = file;
        if (!existing) chatArea.appendChild(wrap);
        scrollBottom();
    }
    function showPendingWriteCard(file: string, messageId: string, isNewFile: boolean, diff?: Partial<SideDiffFile>) {
        const fileName = (file || '').split(/[\\/]/).pop() || file;
        const div = document.createElement('div');
        const card = document.createElement('div');
        card.className = 'diff-card';
        const safeId = escapeHtml(messageId);
        const diffFile: SideDiffFile = {
            file,
            status: isNewFile ? 'created' : 'modified',
            diffPreview: diff?.diffPreview,
            additions: diff?.additions,
            deletions: diff?.deletions,
            diffLines: diff?.diffLines,
        };
        const openPendingDiff = () => openDiffInSideWorkspace(
            [diffFile],
            isNewFile ? tr('New file', '新建文件') : tr('File change', '文件修改'),
            { pending: { messageId, isNewFile } },
        );
        const hint = isNewFile
            ? tr('The new file has been opened in the editor; review it before deciding', '新文件已在编辑器中打开，请确认内容后决定')
            : tr('The file comparison has been opened in the VS Code diff editor', '文件对比已在 VSCode 差异编辑器中打开');
        card.innerHTML =
            '<div class="diff-card-header">' +
            svgIcon('edit') + tr(`Request to ${isNewFile ? 'create' : 'modify'}: `, `请求${isNewFile ? '创建' : '修改'}: `) + '<strong>' + escapeHtml(fileName) + '</strong>' +
            '<span class="diff-card-hint">' + hint + '</span></div>' +
            '<div class="diff-card-actions">' +
            '<button class="diff-accept-btn" data-msgid="' + safeId + '">' + svgIcon('check') + tr('Accept', '接受') + '</button>' +
            '<button class="diff-reject-btn" data-msgid="' + safeId + '">' + svgIcon('x') + tr('Reject', '拒绝') + '</button>' +
            '</div>';
        (card.querySelector('.diff-accept-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; (card.querySelector('.diff-reject-btn') as HTMLButtonElement).disabled = true;
            this.innerHTML = svgIcon('check') + tr('Accepted', '已接受');
            vscode.postMessage({ type: 'confirmWriteFile', messageId });
            removePendingSideDiffEntry(messageId);
            refreshSideDiffWorkspaceAfterRemoval();
            dismissCard(div, 400);
        });
        (card.querySelector('.diff-reject-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; (card.querySelector('.diff-accept-btn') as HTMLButtonElement).disabled = true;
            this.textContent = tr('Rejected', '已拒绝');
            vscode.postMessage({ type: 'cancelWriteFile', messageId });
            removePendingSideDiffEntry(messageId);
            refreshSideDiffWorkspaceAfterRemoval();
            dismissCard(div, 400);
        });
        const pendingActions = card.querySelector('.diff-card-actions') as HTMLElement | null;
        if (pendingActions) {
            const previewBtn = document.createElement('button');
            previewBtn.className = 'diff-preview-btn';
            previewBtn.type = 'button';
            previewBtn.innerHTML = svgIcon('search') + tr('View details', '查看详情');
            previewBtn.addEventListener('click', openPendingDiff);
            pendingActions.insertBefore(previewBtn, pendingActions.firstChild);
        }
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
        if (shouldUseSideWorkspace()) openPendingDiff();
    }

    // ── Floating Card Queue ──────────────────────────────────────────────────
    let floatingCardQueue: HTMLElement[] = [];
    let isShowingFloatingCard = false;
    const floatingPermissionIds = new Set<string>();
    const floatingQuestionIds = new Set<string>();

    function processFloatingCardQueue() {
        if (isShowingFloatingCard || floatingCardQueue.length === 0) return;
        const div = floatingCardQueue.shift()!;
        isShowingFloatingCard = true;
        const floatingCardArea = document.getElementById('floatingCardArea');
        if (floatingCardArea) {
            floatingCardArea.appendChild(div);
        } else {
            chatArea.appendChild(div);
        }
        scrollBottom();
    }

    function removeQueuedFloatingCards(predicate: (card: HTMLElement) => boolean): void {
        const nextQueue: HTMLElement[] = [];
        for (const card of floatingCardQueue) {
            if (predicate(card)) {
                card.remove();
            } else {
                nextQueue.push(card);
            }
        }
        floatingCardQueue = nextQueue;
    }

    function dismissResolvedCard(card: HTMLElement): void {
        if (card.dataset.resolved === 'true') return;
        card.dataset.resolved = 'true';
        const floatingCardArea = document.getElementById('floatingCardArea');
        const wasVisibleFloatingCard = (!!floatingCardArea && card.parentElement === floatingCardArea)
            || (!floatingCardArea && card.parentElement === chatArea && isShowingFloatingCard);
        dismissCard(card, 0, () => {
            if (wasVisibleFloatingCard) {
                isShowingFloatingCard = false;
                processFloatingCardQueue();
            }
        });
    }

    function cardShell(element: HTMLElement): HTMLElement {
        const parent = element.parentElement as HTMLElement | null;
        if (parent && parent.parentElement === chatArea && parent.childElementCount === 1) return parent;
        return element;
    }

    function disableInlinePermissionActions(permissionId?: string): void {
        document.querySelectorAll('.tp-perm-btn[data-perm]').forEach(btn => {
            const el = btn as HTMLButtonElement;
            if (permissionId && el.dataset.perm !== permissionId) return;
            el.disabled = true;
            el.style.opacity = '0.4';
        });
    }

    function resolveFloatingCard(card: 'permission' | 'question' | 'write' | 'plan' | 'walkthrough' | 'blueprint', id?: string): void {
        if (card === 'permission') {
            if (id) floatingPermissionIds.delete(id);
            else floatingPermissionIds.clear();
            removeQueuedFloatingCards(el => el.classList.contains('permission-card') && (!id || el.dataset.permId === id));
            document.querySelectorAll('.permission-card[data-perm-id]').forEach(el => {
                const cardEl = el as HTMLElement;
                if (!id || cardEl.dataset.permId === id) dismissResolvedCard(cardEl);
            });
            disableInlinePermissionActions(id);
            return;
        }

        if (card === 'question') {
            if (id) floatingQuestionIds.delete(id);
            else floatingQuestionIds.clear();
            removeQueuedFloatingCards(el => el.classList.contains('structured-question-wizard') && (!id || el.dataset.questionId === id));
            document.querySelectorAll<HTMLElement>('.structured-question-wizard[data-question-id]').forEach(el => {
                if (!id || el.dataset.questionId === id) dismissResolvedCard(el);
            });
            return;
        }

        if (card === 'write') {
            if (id) {
                removePendingSideDiffEntry(id);
                refreshSideDiffWorkspaceAfterRemoval();
            }
            document.querySelectorAll('.diff-card').forEach(el => {
                const cardEl = el as HTMLElement;
                const button = cardEl.querySelector('[data-msgid]') as HTMLElement | null;
                if (!button) return;
                if (!id || button.dataset.msgid === id) dismissResolvedCard(cardShell(cardEl));
            });
            return;
        }

        const className = card === 'plan'
            ? 'plan-card-wrap'
            : card === 'walkthrough'
                ? 'walkthrough-card-wrap'
                : 'blueprint-card-wrap';
        if (isManagerShell()) {
            const labels = card === 'walkthrough'
                ? chatI18n.annotations.walkthrough
                : card === 'blueprint'
                    ? chatI18n.annotations.blueprint
                    : chatI18n.annotations.plan;
            document.querySelectorAll(`.annotatable-plan.${className}`).forEach(el => {
                const cardEl = el as HTMLElement;
                const resolvedLabels = labels;
                cardEl.dataset.resolved = 'true';
                cardEl.classList.add('ap-approved', 'ap-compact');
                cardEl.style.display = '';
                cardEl.style.opacity = '1';
                cardEl.style.transform = '';
                const header = cardEl.querySelector<HTMLElement>('.ap-header');
                if (header) {
                    header.tabIndex = 0;
                    header.setAttribute('role', 'button');
                    header.setAttribute('aria-expanded', 'false');
                }
                const hint = cardEl.querySelector<HTMLElement>('.ap-header-hint');
                if (hint) hint.textContent = resolvedLabels.approved;
                const approveBtn = cardEl.querySelector<HTMLButtonElement>('.ap-approve-btn');
                if (approveBtn) {
                    approveBtn.innerHTML = svgIcon('check') + escapeHtml(resolvedLabels.approved);
                    approveBtn.disabled = true;
                }
                const submitBtn = cardEl.querySelector<HTMLButtonElement>('.ap-submit-btn');
                if (submitBtn) submitBtn.disabled = true;
            });
            return;
        }
        document.querySelectorAll(`.annotatable-plan.${className}`).forEach(el => {
            dismissResolvedCard(el as HTMLElement);
        });
    }

    // ── Permission request card ─────────────────────────────────────────────────
    function showPermissionCard(permissionId: string, tool: string, description: string, command: string, allowAlways?: boolean, preflight?: any, availableDecisions?: string[], proposedRule?: any) {
        if (!permissionId || floatingPermissionIds.has(permissionId)) return;
        floatingPermissionIds.add(permissionId);
        const div = document.createElement('div');
        div.className = `permission-card${preflight?.unsandboxed ? ' permission-card-critical' : ''}`;
        div.dataset.permId = permissionId;
        div.setAttribute('role', 'alertdialog');
        div.setAttribute('aria-label', tr('Permission required', '需要权限'));
        const safeId = escapeHtml(permissionId);
        const decisions = new Set(availableDecisions || ['accept', 'decline', 'cancel']);
        const allowLabel = preflight?.unsandboxed
            ? tr('Run unsandboxed once', '仅本次无沙箱运行')
            : preflight?.networkAccess
                ? tr('Allow requested access once', '仅本次允许所请求权限')
                : tr('Allow once', '仅允许本次');
        let actionsHtml = `<div class="permission-card-actions">`
            + (decisions.has('accept') ? `<button class="permission-allow-btn${preflight?.unsandboxed ? ' permission-unsandboxed-btn' : ''}" data-permid="${safeId}">${svgIcon('check')}${allowLabel}</button>` : '')
            + (decisions.has('decline') ? `<button class="permission-deny-btn" data-permid="${safeId}">${svgIcon('x')}${tr('Deny', '拒绝')}</button>` : '')
            + (decisions.has('cancel') ? `<button class="permission-cancel-btn" data-permid="${safeId}">${tr('Cancel request', '取消请求')}</button>` : '');
        if (tool === 'run_command' && allowAlways && decisions.has('acceptForSession')) {
            const title = proposedRule?.commandPrefix?.length
                ? `${proposedRule.commandPrefix.join(' ')} @ ${proposedRule.cwdScope}`
                : tr('Allow this exact low-risk prefix for the current extension session', '在当前扩展会话允许此精确低风险前缀');
            actionsHtml += `<button class="permission-always-btn" data-permid="${safeId}" title="${escapeHtml(title)}">${svgIcon('check')}${tr('Allow rule for session', '本会话允许此规则')}</button>`;
        }
        actionsHtml += `</div>`;

        let preflightHtml = '';
        if (preflight) {
            const riskMap: Record<number, { text: string; color: string; bg: string }> = {
                0: { text: tr('Low risk', '低风险'), color: 'var(--vscode-testing-iconPassed)', bg: 'var(--vscode-editor-inactiveSelectionBackground)' },
                1: { text: tr('Moderate risk', '中风险'), color: 'var(--vscode-editorWarning-foreground)', bg: 'var(--vscode-editor-inactiveSelectionBackground)' },
                2: { text: tr('High risk / extra scope', '高风险 / 额外权限'), color: 'var(--vscode-editorWarning-foreground)', bg: 'var(--vscode-editor-inactiveSelectionBackground)' },
                3: { text: tr('Critical / destructive', '严重风险 / 破坏性操作'), color: 'var(--vscode-errorForeground)', bg: 'var(--vscode-inputValidation-errorBackground)' },
            };
            const risk = riskMap[preflight.riskLevel] || riskMap[1]!;
            const classLabels: Record<string, string> = {
                read: tr('Read-only query', '只读查询'), readonly: tr('Read-only query', '只读查询'),
                write: tr('File write/change', '写入修改'), network: tr('Network access', '网络访问'),
                script: tr('Inline execution', '内联执行'), interpreter: tr('Interpreter execution', '解释器执行'),
                destructive: tr('Destructive operation', '高危破坏'),
            };
            const badges = (preflight.classification || []).map((value: string) => `<span class="preflight-badge">${escapeHtml(classLabels[value] || value)}</span>`).join('');
            const details = (preflight.reasons || []).map((reason: string) => `<li>${escapeHtml(reason)}</li>`).join('');
            const scopeRows = [
                preflight.unsandboxed ? tr('Filesystem and process sandbox: unrestricted for this command', '文件系统与进程沙箱：此命令不受限制') : '',
                preflight.cwd ? `${tr('Working directory', '工作目录')}: ${preflight.cwd}` : '',
                preflight.sandboxMode ? `${tr('Sandbox after approval', '批准后的沙箱')}: ${preflight.sandboxMode}` : '',
                preflight.networkAccess ? `${tr('Network', '网络')}: ${
                    preflight.networkEnforcement === 'declared-only'
                        ? `${(preflight.networkHosts || []).join(', ')} ${tr('(declared/audited; sandbox grants broad network access)', '（仅声明/审计；沙箱实际授予广泛网络访问）')}`
                        : preflight.networkEnforcement === 'unrestricted'
                            ? tr('Unrestricted because this run leaves the OS sandbox', '因本次运行离开 OS 沙箱而不受限制')
                            : tr('Any destination (broad network grant)', '任意目标（广泛网络授权）')
                }` : `${tr('Network', '网络')}: ${tr('blocked by sandbox', '由沙箱阻止')}`,
                Array.isArray(preflight.writableRoots) && preflight.writableRoots.length ? `${tr('Writable roots', '可写目录')}: ${preflight.writableRoots.join(', ')}` : '',
                Array.isArray(preflight.targetPaths) && preflight.targetPaths.length ? `${tr('Target paths', '目标路径')}: ${preflight.targetPaths.join(', ')}` : '',
                preflight.mcpServer || preflight.mcpTool ? `MCP: ${preflight.mcpServer || '?'} / ${preflight.mcpTool || '?'}` : '',
                Array.isArray(preflight.protectedPathOverrides) && preflight.protectedPathOverrides.length ? `${tr('One-time protected path override', '单次受保护路径覆盖')}: ${preflight.protectedPathOverrides.join(', ')}` : '',
                proposedRule?.commandPrefix?.length ? `${tr('Proposed session rule', '拟议会话规则')}: ${proposedRule.commandPrefix.join(' ')} @ ${proposedRule.cwdScope}` : '',
            ].filter(Boolean).map(row => `<div class="permission-scope-row">${escapeHtml(row)}</div>`).join('');
            preflightHtml = `<div class="preflight-assessment-panel">`
                + `<div class="preflight-assessment-header"><span>${tr('Requested capability change', '请求的能力变更')}</span><span style="color:${risk.color};background:${risk.bg}">${risk.text}</span></div>`
                + `<div>${badges}</div>${scopeRows}`
                + (details ? `<ul>${details}</ul>` : '')
                + `</div>`;
        }

        div.innerHTML = `<div class="permission-card-header"><span class="permission-card-icon">${svgIconNoMargin('key')}</span><div class="permission-card-body">`
            + `<div class="permission-card-title">${escapeHtml(description)}</div>`
            + (command ? `<div class="permission-card-cmd">${escapeHtml(command)}</div>` : '')
            + `${preflightHtml}</div></div>${actionsHtml}`;

        const finish = (decision: string, button: HTMLButtonElement) => {
            div.querySelectorAll<HTMLButtonElement>('button').forEach(item => { item.disabled = true; });
            button.setAttribute('aria-pressed', 'true');
            vscode.postMessage({ type: 'permissionResponse', permissionId, decision });
            dismissCard(div, 400, () => {
                floatingPermissionIds.delete(permissionId);
                isShowingFloatingCard = false;
                processFloatingCardQueue();
            });
        };
        div.querySelector<HTMLButtonElement>('.permission-allow-btn')?.addEventListener('click', function () { finish('accept', this); });
        div.querySelector<HTMLButtonElement>('.permission-deny-btn')?.addEventListener('click', function () { finish('decline', this); });
        div.querySelector<HTMLButtonElement>('.permission-cancel-btn')?.addEventListener('click', function () { finish('cancel', this); });
        div.querySelector<HTMLButtonElement>('.permission-always-btn')?.addEventListener('click', function () { finish('acceptForSession', this); });
        div.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            div.querySelector<HTMLButtonElement>('.permission-cancel-btn')?.click();
        });

        floatingCardQueue.push(div);
        processFloatingCardQueue();
        queueMicrotask(() => div.querySelector<HTMLButtonElement>('button')?.focus());
    }

    type StructuredQuestionItem = {
        id: string;
        header?: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: boolean;
    };

    function showStructuredQuestionCard(questionId: string, questions: StructuredQuestionItem[]): void {
        if (!questionId || floatingQuestionIds.has(questionId) || questions.length === 0) return;
        floatingQuestionIds.add(questionId);

        const wizard = document.createElement('div');
        wizard.className = 'question-wizard-container structured-question-wizard';
        wizard.dataset.questionId = questionId;
        wizard.setAttribute('role', 'dialog');
        wizard.setAttribute('aria-label', tr('Clarification questions', '澄清问题'));

        const header = document.createElement('div');
        header.className = 'question-wizard-header';
        const title = document.createElement('div');
        title.className = 'question-wizard-title';
        title.innerHTML = svgIcon('question');
        title.appendChild(document.createTextNode(tr('Clarification questions', '澄清问题')));
        const count = document.createElement('div');
        count.className = 'question-wizard-count';
        header.append(title, count);
        wizard.appendChild(header);

        const list = document.createElement('div');
        list.className = 'question-wizard-list';
        wizard.appendChild(list);

        const selections = new Map<string, Set<string>>();
        const otherInputs = new Map<string, HTMLTextAreaElement>();
        const questionCards: HTMLElement[] = [];
        const otherKey = '__other__';
        let pageIndex = 0;

        const footer = document.createElement('div');
        footer.className = 'question-wizard-footer structured-question-footer';
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'permission-cancel-btn structured-question-cancel';
        cancelButton.textContent = tr('Cancel request', '取消提问');
        const previousButton = document.createElement('button');
        previousButton.type = 'button';
        previousButton.className = 'structured-question-nav structured-question-previous';
        previousButton.textContent = tr('Previous', '上一步');
        const nextButton = document.createElement('button');
        nextButton.type = 'button';
        nextButton.className = 'structured-question-nav structured-question-next';
        nextButton.textContent = tr('Next', '下一步');
        const submitButton = document.createElement('button');
        submitButton.type = 'button';
        submitButton.className = 'question-submit-btn structured-question-submit';
        submitButton.innerHTML = svgIcon('check') + tr('Submit answers', '提交回答');
        submitButton.disabled = true;
        footer.append(cancelButton, previousButton, nextButton, submitButton);
        wizard.appendChild(footer);

        const isQuestionAnswered = (question: StructuredQuestionItem): boolean => {
            const selected = selections.get(question.id) ?? new Set<string>();
            const hasPreset = Array.from(selected).some(value => value !== otherKey);
            const hasOther = selected.has(otherKey) && !!otherInputs.get(question.id)?.value.trim();
            return hasPreset || hasOther;
        };

        const updateState = (): void => {
            const answered = questions.filter(isQuestionAnswered).length;
            count.textContent = tr(
                `Question ${pageIndex + 1}/${questions.length} · ${answered}/${questions.length} answered`,
                `问题 ${pageIndex + 1}/${questions.length} · 已回答 ${answered}/${questions.length}`,
            );
            nextButton.disabled = !isQuestionAnswered(questions[pageIndex]!);
            submitButton.disabled = answered !== questions.length;
        };

        const showPage = (nextPageIndex: number): void => {
            pageIndex = Math.max(0, Math.min(nextPageIndex, questions.length - 1));
            questionCards.forEach((card, index) => {
                const visible = index === pageIndex;
                card.style.display = visible ? 'block' : 'none';
                card.setAttribute('aria-hidden', visible ? 'false' : 'true');
            });
            const isFirst = pageIndex === 0;
            const isLast = pageIndex === questions.length - 1;
            previousButton.style.display = isFirst ? 'none' : 'inline-flex';
            nextButton.style.display = isLast ? 'none' : 'inline-flex';
            submitButton.style.display = isLast ? 'inline-flex' : 'none';
            updateState();
        };

        questions.forEach((question, index) => {
            selections.set(question.id, new Set<string>());
            const card = document.createElement('div');
            card.className = 'permission-card question-card structured-question-card';
            card.dataset.questionKey = question.id;

            const cardHeader = document.createElement('div');
            cardHeader.className = 'permission-card-header';
            const body = document.createElement('div');
            body.className = 'permission-card-body';
            const eyebrow = document.createElement('div');
            eyebrow.className = 'structured-question-header';
            eyebrow.textContent = question.header || tr(`Question ${index + 1}`, `问题 ${index + 1}`);
            const prompt = document.createElement('div');
            prompt.className = 'permission-card-title';
            prompt.textContent = question.question;
            body.append(eyebrow, prompt);
            cardHeader.appendChild(body);
            card.appendChild(cardHeader);

            const actions = document.createElement('div');
            actions.className = 'permission-card-actions';
            card.appendChild(actions);

            const otherInput = document.createElement('textarea');
            otherInput.className = 'question-other-input';
            otherInput.rows = 2;
            otherInput.placeholder = tr('Type your answer...', '输入你的回答...');
            otherInput.addEventListener('input', updateState);
            otherInputs.set(question.id, otherInput);

            const optionValues = [
                ...question.options.map(option => ({ ...option, value: option.label })),
                { label: tr('Other', '其他'), description: tr('Type a custom answer', '输入自定义回答'), value: otherKey },
            ];
            for (const option of optionValues) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'structured-question-option';
                button.dataset.value = option.value;
                button.setAttribute('aria-pressed', 'false');
                const optionLabel = document.createElement('span');
                optionLabel.className = 'structured-question-option-label';
                optionLabel.textContent = option.label;
                const optionDescription = document.createElement('span');
                optionDescription.className = 'structured-question-option-description';
                optionDescription.textContent = option.description;
                button.append(optionLabel, optionDescription);
                button.addEventListener('click', () => {
                    const selected = selections.get(question.id)!;
                    if (question.multiSelect) {
                        if (selected.has(option.value)) selected.delete(option.value);
                        else selected.add(option.value);
                    } else {
                        selected.clear();
                        selected.add(option.value);
                    }
                    actions.querySelectorAll<HTMLButtonElement>('.structured-question-option').forEach(item => {
                        const isSelected = selected.has(item.dataset.value ?? '');
                        item.classList.toggle('selected', isSelected);
                        item.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
                    });
                    otherInput.style.display = selected.has(otherKey) ? 'block' : 'none';
                    if (selected.has(otherKey)) otherInput.focus();
                    else otherInput.value = '';
                    updateState();
                });
                actions.appendChild(button);
            }
            actions.appendChild(otherInput);
            list.appendChild(card);
            questionCards.push(card);
        });

        const finish = (cancelled: boolean): void => {
            wizard.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
            const answers: Record<string, string | string[]> = {};
            if (!cancelled) {
                for (const question of questions) {
                    const selected = Array.from(selections.get(question.id) ?? []);
                    const values = selected
                        .filter(value => value !== otherKey)
                        .concat(selected.includes(otherKey) ? [otherInputs.get(question.id)?.value.trim() ?? ''] : [])
                        .filter(Boolean);
                    answers[question.id] = question.multiSelect ? values : (values[0] ?? '');
                }
                submitButton.innerHTML = svgIcon('check') + tr('Submitting...', '正在提交...');
            }
            vscode.postMessage({ type: 'questionResponse', questionId, answers: cancelled ? undefined : answers, cancelled });
        };
        submitButton.addEventListener('click', () => {
            updateState();
            if (!submitButton.disabled) finish(false);
        });
        previousButton.addEventListener('click', () => {
            showPage(pageIndex - 1);
            questionCards[pageIndex]?.querySelector<HTMLButtonElement>('.structured-question-option')?.focus();
        });
        nextButton.addEventListener('click', () => {
            updateState();
            if (nextButton.disabled) return;
            showPage(pageIndex + 1);
            questionCards[pageIndex]?.querySelector<HTMLButtonElement>('.structured-question-option')?.focus();
        });
        cancelButton.addEventListener('click', () => finish(true));
        wizard.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            cancelButton.click();
        });

        showPage(0);
        floatingCardQueue.push(wizard);
        processFloatingCardQueue();
        queueMicrotask(() => questionCards[0]?.querySelector<HTMLButtonElement>('.structured-question-option')?.focus());
    }

    function prepareSingleFileArtifactCard(card: HTMLElement, kind: string, filePath?: string, relPath?: string): void {
        const key = filePath || relPath || kind;
        document.querySelectorAll<HTMLElement>(`.plan-file-card[data-card-kind="${kind}"]`).forEach(existing => {
            if (existing.dataset.cardPath === key) existing.remove();
        });
        card.dataset.cardKind = kind;
        card.dataset.cardPath = key;
    }

    function restorePendingInteractiveCardsFromSteps(steps: any[] | undefined): void {
        if (!Array.isArray(steps) || steps.length === 0) return;
        const pCard = steps.find((s: any) => s.type === 'plan_card' && s.uiState === 'pending');
        if (pCard && pCard.toolResult) {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'renderPlan', sections: pCard.toolResult, planText: pCard.content }
            }));
        }
        const wtCard = steps.find((s: any) => s.type === 'walkthrough_card' && s.uiState === 'pending');
        if (wtCard && wtCard.toolResult) {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'renderWalkthrough', sections: wtCard.toolResult }
            }));
        }
        const bpCard = steps.find((s: any) => s.type === 'blueprint_card' && s.uiState === 'pending');
        if (bpCard && bpCard.toolResult) {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'renderBlueprint', sections: bpCard.toolResult, planText: bpCard.content }
            }));
        }
    }

    // ── Message handler ────────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const validatedMessage = parseHostMessage(event.data);
        if (!validatedMessage) return;
        const msg: any = validatedMessage;
        switch (msg.type) {

            case 'addUserMessage':
                removeReplayBanners();
                clearActiveSubagentViews();
                setGenerating(true);
                if (subagentTicker) {
                    clearInterval(subagentTicker);
                    subagentTicker = null;
                }
                removeLiveAssistantViews();
                addUserMessage(msg.text, msg.messageIndex, msg.images, msg.contexts, msg.schedulingState);
                currentAssistantDiv = initLiveAssistantDiv();
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom(true);
                break;

            case 'queuedUserInput': {
                const queued = addUserMessage(msg.text, msg.messageIndex, msg.images, msg.contexts);
                queued.classList.add('queued-user-input');
                const bubble = queued.querySelector('.msg-bubble');
                if (bubble) {
                    const status = document.createElement('div');
                    status.className = 'queued-input-status';
                    status.style.cssText = 'margin-top:6px;font-size:11px;color:var(--vscode-descriptionForeground);';
                    status.textContent = tr('Queued for current run', '已排队到当前任务');
                    bubble.appendChild(status);
                }
                updateSendButtonState();
                break;
            }

            case 'startBackgroundGeneration':
                removeReplayBanners();
                clearActiveSubagentViews();
                setGenerating(true);
                if (subagentTicker) {
                    clearInterval(subagentTicker);
                    subagentTicker = null;
                }
                removeLiveAssistantViews();
                // Do not add user message bubble, but still render the assistant div
                currentAssistantDiv = initLiveAssistantDiv();
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom(true);
                break;

            case 'agentStep':
                applyLiveStep(msg.step);
                break;
            case 'contextCompactionStatus':
                applyStandaloneCompactionStep(msg.step as RendererStep);
                break;
            case 'generationComplete': {
                removeReplayBanners();
                clearActiveSubagentViews();
                setGenerating(false);
                if (subagentTicker) {
                    clearInterval(subagentTicker);
                    subagentTicker = null;
                }
                // Clear all streaming status to prevent residual liveThinkBlock and other references from interfering with final message reconstruction
                removeLiveAssistantViews();
                
                // Clear any unresolved interactive cards (permission, diff)
                floatingCardQueue = [];
                floatingPermissionIds.clear();
                floatingQuestionIds.clear();
                isShowingFloatingCard = false;
                document.querySelectorAll('.permission-card, .diff-card, .structured-question-wizard').forEach(el => dismissCard(el as HTMLElement, 0));

                const r = msg.result;
                const completedMsg = buildAssistantMessage(
                    r.explanation || (r.steps && r.steps.length ? '' : tr('Complete', '完成')),
                    r.steps,
                    Date.now()
                );
                chatArea.appendChild(completedMsg);
                restorePendingInteractiveCardsFromSteps(r.steps);

                // Use real tokenUsage from result if available, else fall back to rough estimate
                if (r.tokenUsage && r.tokenUsage.total > 0) {
                    const gaugeUsage = r.tokenUsage.contextWindowTokens ?? r.tokenUsage.input ?? (r.tokenUsage.total > contextLimit ? Math.min(r.tokenUsage.input ?? 0, contextLimit) : r.tokenUsage.total);
                    lastKnownContextTokens = gaugeUsage;
                    totalConversationTokens = r.tokenUsage.total;
                    updateTokenUsage(gaugeUsage, contextLimit);
                    // Show cost badge
                    const label = document.getElementById('tokenUsageLabel');
                    if (label) {
                        label.textContent = `${label.textContent} · ${tr('last request', '上次请求')}`;
                        if (r.tokenUsage.estimatedCostCny > 0) {
                            const cost = r.tokenUsage.estimatedCostCny < 0.01
                                ? '<¥0.01'
                                : '¥' + r.tokenUsage.estimatedCostCny.toFixed(2);
                            label.textContent = `${label.textContent} · ${cost}`;
                        }
                    }
                } else {
                    // Rough estimate fallback (no API usage data)
                    // Estimate current active context window tokens, NOT accumulating multi-turn cumulative billing totals into the gauge!
                    let estimatedContext = lastKnownContextTokens;
                    if (estimatedContext <= 0) {
                        const msgNodes = chatArea.querySelectorAll('.message-content, .chat-message-text');
                        let totalChars = 0;
                        msgNodes.forEach(node => { totalChars += (node.textContent || '').length; });
                        estimatedContext = Math.ceil(totalChars / 4) + 1500;
                    } else {
                        estimatedContext += Math.ceil((r.explanation || '').length / 4) + 500;
                    }
                    estimatedContext = Math.min(estimatedContext, contextLimit);
                    lastKnownContextTokens = estimatedContext;
                    updateTokenUsage(estimatedContext, contextLimit);
                    const label = document.getElementById('tokenUsageLabel');
                    if (label) label.textContent = `${label.textContent} · ${tr('conversation estimate', '对话估算')}`;
                }
                scrollBottom();
                queuedPromptDispatchAfterCompletion = true;
                break;
            }

            case 'generationError': {
                removeReplayBanners();
                clearActiveSubagentViews();
                setGenerating(false);
                queuedPromptDispatchAfterCompletion = false;
                removeLiveAssistantViews();
                
                // Clear any unresolved interactive cards
                floatingCardQueue = [];
                floatingPermissionIds.clear();
                floatingQuestionIds.clear();
                isShowingFloatingCard = false;
                document.querySelectorAll('.permission-card, .diff-card, .structured-question-wizard').forEach(el => dismissCard(el as HTMLElement, 0));

                const errNode = buildAssistantMessage(String(msg.error || ''), [], Date.now());
                errNode.classList.add('assistant-error-message');
                const errBubble = errNode.querySelector('.msg-bubble');
                if (errBubble) {
                    const icon = document.createElement('span');
                    icon.className = 'assistant-error-icon';
                    icon.innerHTML = svgIconNoMargin('x');
                    errBubble.prepend(document.createTextNode(' '));
                    errBubble.prepend(icon);
                }
                if (msg.canResume) {
                    const resumeBtn = document.createElement('button');
                    resumeBtn.className = 'resume-btn';
                    resumeBtn.style.cssText = 'margin-top: 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 13px;';
                    resumeBtn.innerHTML = svgIcon('refresh') + tr(' Resume', ' 恢复执行 (Resume)');
                    resumeBtn.addEventListener('click', () => {
                        resumeBtn.disabled = true;
                        resumeBtn.innerHTML = svgIcon('refresh') + tr(' Resuming...', ' 恢复中...');
                        vscode.postMessage({ type: 'resumeGeneration' });
                    });
                    
                    const msgBubble = errNode.querySelector('.msg-bubble');
                    if (msgBubble) {
                        msgBubble.appendChild(document.createElement('br'));
                        msgBubble.appendChild(resumeBtn);
                    } else {
                        errNode.appendChild(resumeBtn);
                    }
                }
                chatArea.appendChild(errNode);
                scrollBottom(true);
                break;
            }

            case 'clearChat':
                if (!isCurrentSurface(msg.targetSurface)) break;
                clearActiveSubagentViews();
                clearTopicWorkspaceState();
                cancelInlineEdit();
                while (chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
                emptyState.style.display = '';
                chatArea.appendChild(emptyState);
                messageIndexMap.clear();
                userMessagePayloadMap.clear();
                clearQueuedComposerInputs();
                currentGoalActivity = null;
                renderGoalRunArea();
                setGenerating(false);
                currentAssistantDiv = null;
                streamStates.clear();
                totalConversationTokens = 0;
                lastKnownContextTokens = 0;
                artifacts = [];
                renderArtifactPanel();
                updateCurrentTopicHeader(null, null);
                { const bar = document.getElementById('tokenUsageBar'); if (bar) bar.style.display = 'none'; }
                setChatEmptyState(true);
                startPlaceholderRotation();
                break;

            case 'managerSnapshot': {
                if (!isManagerShell()) break;
                updateCurrentTopicHeader(msg.stats?.currentTopicId ?? null, msg.stats?.currentTopicTitle ?? null);
                // Snapshots are the manager's initial topic source. Do not replace active search results.
                const search = document.getElementById('topicsSearch');
                if (!(search instanceof HTMLInputElement) || !search.value.trim()) {
                    renderTopics(msg.topics, msg.stats);
                }
                break;
            }

            case 'topicList': {
                const currentFromList = msg.stats?.currentTopicId
                    ? (msg.topics || []).find((t: TopicPanelItem) => t.id === msg.stats.currentTopicId)
                    : undefined;
                updateCurrentTopicHeader(
                    msg.stats?.currentTopicId ?? null,
                    msg.stats?.currentTopicTitle ?? currentFromList?.title ?? null
                );
                renderTopics(msg.topics, msg.stats);
                break;
            }

            case 'mentionSearchResults':
                renderMentionMenu(msg.results);
                break;
            case 'fileList':
                // If @ popup is open, refresh it
                if (_atPopupVisible) {
                    const filter = getMentionFilterBeforeCaret();
                    if (filter !== null) showAtPopup(filter);
                }
                break;

            case 'artifactList':
                artifacts = sortArtifactsByNewest(msg.artifacts || []);
                renderArtifactPanel();
                updateSwBadges();
                break;
            case 'scratchFiles':
                _scratchFiles = (msg as any).files || [];
                updateSwBadges();
                if (_activeSwTab === 'files') renderScratchFileTree();
                break;

            case 'topicTitleGenerated': {
                if (msg.topicId === currentTopicId) {
                    updateCurrentTopicHeader(msg.topicId, msg.title);
                }
                const list = document.getElementById('topicsList');
                if (list) {
                    for (const item of Array.from(list.querySelectorAll('.topic-item[data-topic-id]'))) {
                        if ((item as HTMLElement).dataset.topicId !== msg.topicId) continue;
                        const span = item.querySelector('.topic-title');
                        if (span) span.textContent = msg.title;
                    }
                }
                break;
            }

            case 'topicForked': {
                // Close the topics panel and show a notification
                topicsPanel.classList.remove('show');
                if (sideWorkspaceContent === topicsPanel) closeSideWorkspace();
                const notif = document.createElement('div');
                notif.className = 'special-step';
                notif.style.cssText = 'padding:6px 0;opacity:0.6;font-size:11px;';
                notif.innerHTML = `${svgIconNoMargin('gitBranch')} ${tr('Forked a new topic from here', '已从此处分叉为新话题')}: ${escapeHtml(msg.title)}`;
                chatArea.appendChild(notif);
                scrollBottom();
                break;
            }

            case 'loadTopicMessages':
                if (!isCurrentSurface(msg.targetSurface)) break;
                clearActiveSubagentViews();
                cancelInlineEdit();
                clearQueuedComposerInputs();
                currentGoalActivity = null;
                renderGoalRunArea();
                chatArea.innerHTML = '';
                messageIndexMap.clear();
                userMessagePayloadMap.clear();
                restoreArtifactsFromMessages(msg.messages || []);
                msg.messages.forEach((m: any, idx: number) => {
                    if (m.isHidden === true) return;
                    
                    // M4 fix: pass images array when restoring user messages from history
                    if (m.role === 'user') addUserMessage(m.displayContent || m.content, idx, m.images, m.contexts, m.schedulingState);
                    else {
                        chatArea.appendChild(buildAssistantMessage(m.content, m.steps, null));
                        scrollBottom();
                        // Restore custom UI cards from steps
                        restorePendingInteractiveCardsFromSteps(m.steps);
                    }
                });
                break;

            case 'messageRetracted': {
                if (inlineEditSession && inlineEditSession.messageIndex >= msg.messageIndex) {
                    cancelInlineEdit();
                }
                // Find the retracted message element and remove it plus ALL subsequent siblings
                const rd = messageIndexMap.get(msg.messageIndex);
                if (rd) {
                    // Collect all nodes from rd onwards (inclusive) and remove them
                    const toRemove: Element[] = [];
                    let cur: Element | null = rd;
                    while (cur) {
                        toRemove.push(cur);
                        cur = cur.nextElementSibling;
                    }
                    for (const el of toRemove) el.remove();
                }
                // Clear all messageIndexMap entries whose index >= retracted index
                for (const [idx] of messageIndexMap) {
                    if (idx >= msg.messageIndex) messageIndexMap.delete(idx);
                }
                for (const [idx] of userMessagePayloadMap) {
                    if (idx >= msg.messageIndex) userMessagePayloadMap.delete(idx);
                }
                if (msg.restoredInput) {
                    cancelInlineEdit();
                    restoreComposerPayload(msg.restoredInput);
                }
                break;
            }

            case 'pendingWriteFile':
                appendCodexLiveSyntheticStep({
                    type: 'write_confirmation_request',
                    toolName: 'write_file',
                    invocationId: msg.messageId ? `write:${msg.messageId}` : undefined,
                    messageId: msg.messageId,
                    content: msg.file || '',
                    toolArgs: { filePath: msg.file, isNewFile: !!msg.isNewFile },
                    toolResult: msg.diffLines ? { diffLines: msg.diffLines } : undefined,
                    timestamp: Date.now(),
                });
                showPendingWriteCard(msg.file, msg.messageId, msg.isNewFile, msg);
                break;

            case 'floatingCardResolved':
                resolveFloatingCard(msg.card, msg.id);
                break;

            case 'questionRequest':
                showStructuredQuestionCard(msg.questionId, msg.questions);
                break;

            case 'questionResolved':
                resolveFloatingCard('question', msg.questionId);
                break;

            case 'permissionRequest': {
                appendCodexLiveSyntheticStep({
                    type: 'permission_request',
                    toolName: msg.tool || 'tool',
                    permissionId: msg.permissionId,
                    invocationId: msg.permissionId ? `permission:${msg.permissionId}` : undefined,
                    content: msg.description || msg.command || msg.tool || '',
                    toolArgs: {
                        command: msg.command || undefined,
                        description: msg.description || undefined,
                    },
                    toolResult: msg.preflight ? { preflight: msg.preflight } : undefined,
                    timestamp: Date.now(),
                });
                showPermissionCard(msg.permissionId, msg.tool || '', msg.description || '', msg.command || '', !!msg.allowAlways, msg.preflight, msg.availableDecisions, msg.proposedRule);
                break;
            }

            case 'permissionResolved': {
                floatingPermissionIds.delete(msg.permissionId);
                removeQueuedFloatingCards(card => card.dataset.permId === msg.permissionId);
                document.querySelectorAll<HTMLElement>('.permission-card[data-perm-id]').forEach(card => {
                    if (card.dataset.permId === msg.permissionId && !card.querySelector('[aria-pressed="true"]')) dismissResolvedCard(card);
                });
                const labels: Record<string, string> = {
                    accept: tr('Allowed once', '已允许一次'),
                    acceptForSession: tr('Allowed for this session', '已在本会话允许'),
                    decline: tr('Denied', '已拒绝'),
                    cancel: tr('Cancelled', '已取消'),
                };
                appendCodexLiveSyntheticStep({
                    type: 'thinking',
                    content: `${tr('Permission', '权限')} · ${labels[msg.decision] || msg.decision} · ${msg.reviewer}`,
                    timestamp: Date.now(),
                });
                break;
            }

            case 'agentRoutingStatus':
                updateAgentRoutingStatus(msg.phase, msg.schedulingState);
                break;

            case 'setSchedulingState':
                applySchedulingState(msg.schedulingState);
                break;

            case 'runtimeInspectorSnapshot': {
                // Detailed runtime diagnostics remain available in Agent Manager.
                // The composer deliberately exposes only the capability domain.
                const trigger = document.getElementById('quickDomainTrigger');
                if (trigger) trigger.title = tr(
                    `Capability domain: ${getSchedulingDomainSummary()}`,
                    `能力领域：${getSchedulingDomainSummary()}`,
                );
                break;
            }

            case 'workflowList':
                workflows = (msg.workflows || []) as WorkflowView[];
                activeWorkflowId = msg.currentWorkflowId || null;
                renderComposerChips();
                break;

            case 'workflowChanged':
                activeWorkflowId = msg.workflowId || null;
                if (msg.workflow && !workflows.some(workflow => workflow.id === msg.workflow.id)) {
                    workflows = [...workflows, msg.workflow as WorkflowView];
                }
                renderComposerChips();
                break;

            case 'slashCommandList':
                slashCommandCatalog = Array.isArray(msg.commands) ? msg.commands as SlashCommandView[] : [];
                if (slashPopup?.classList.contains('show')) {
                    const filter = getSlashCommandFilter(getInputText());
                    if (filter !== null) showSlashPopup(filter);
                }
                break;

            case 'slashCommandResult': {
                const resultNode = buildAssistantMessage(`${msg.command} — ${msg.message}`, [], Date.now());
                resultNode.classList.add('slash-command-result', `slash-command-${msg.status}`);
                chatArea.appendChild(resultNode);
                setChatEmptyState(false);
                scrollBottom(true);
                if (msg.uiAction === 'openModelMenu') {
                    setModelMenuOpen(true);
                } else if (msg.uiAction === 'openPermissionsMenu') {
                    setWriteModeMenuOpen(true);
                } else if (msg.uiAction === 'openReasoningMenu') {
                    setReasoningMenuOpen(true);
                }
                break;
            }

            case 'replaySteps': {
                removeReplayBanners();
                const replayedSteps = Array.isArray(msg.steps) ? msg.steps : [];
                if (msg.isGenerating) {
                    setGenerating(true);
                    removeLiveAssistantViews();
                    currentAssistantDiv = initLiveAssistantDiv();
                    chatArea.appendChild(currentAssistantDiv);
                    for (const step of replayedSteps) {
                        applyLiveStep(step);
                    }
                } else if (replayedSteps.length > 0) {
                    removeLiveAssistantViews();
                    chatArea.appendChild(buildAssistantMessage('', replayedSteps, Date.now()));
                }
                scrollBottom();
                break;
                /*
                // Panel was hidden while AI was running — replay accumulated steps
                banner.innerHTML = msg.isGenerating
                    ? `${svgIconNoMargin('zap')} AI 正在后台运行（面板重新打开时恢复显示）`
                    : `${svgIconNoMargin('clipboard')} 以下为 AI 上次运行记录`;
                chatArea.appendChild(banner);
                // Replay each step
                for (const step of msg.steps) {
                    applyLiveStep(step);
                }
                if (msg.isGenerating) {
                    // Show generating indicator
                    sendBtn.classList.add('cancel-mode');
                    const sendIcon = sendBtn.querySelector('.send-icon') as HTMLElement | null;
                    const stopIcon = sendBtn.querySelector('.stop-icon') as HTMLElement | null;
                    if (sendIcon) (sendIcon as HTMLElement).style.display = 'none';
                    if (stopIcon) (stopIcon as HTMLElement).style.display = 'inline-block';
                }
                scrollBottom();
                break;
                */
            }

            case 'activitySnapshot': {
                const activity = msg.activity as {
                    lifecycle?: string;
                    turn?: { phase?: string; pendingApprovals?: unknown[]; activeToolCalls?: unknown[] };
                    background?: unknown[];
                    items?: unknown[];
                };
                updateGoalActivityFromProjection(activity);
                document.body.dataset.agentLifecycle = activity.lifecycle || 'ready';
                document.body.dataset.agentPhase = activity.turn?.phase || 'idle';
                document.body.dataset.agentBackgroundCount = String(activity.background?.length ?? 0);
                document.body.dataset.agentApprovalCount = String(activity.turn?.pendingApprovals?.length ?? 0);
                document.body.dataset.agentToolCallCount = String(activity.turn?.activeToolCalls?.length ?? 0);
                if (queuedPromptDispatchAfterCompletion && !isGenerating) {
                    queuedPromptDispatchAfterCompletion = false;
                    scheduleNextQueuedComposerInput();
                }
                break;
            }

            case 'todoUpdate':
                if (typeof msg.agentId === 'string' && msg.agentId) {
                    renderSubagentTodos(msg.agentId, msg.todos || []);
                } else {
                    renderTodos(msg.todos);
                }
                break;

            case 'autoWriteFile': showAutoWriteCard(msg.file, msg.isNewFile); break;

            case 'skillsList': {
                const list = document.getElementById('installedSkillsList');
                if (list) {
                    list.innerHTML = '';
                    if (!msg.skills || msg.skills.length === 0) {
                        list.innerHTML = `<div style="opacity:0.5; font-size:11px;">${tr('No local skills', '暂无本地技能')}</div>`;
                    } else {
                        msg.skills.forEach((skill: string) => {
                            const row = document.createElement('div');
                            row.style.display = 'flex';
                            row.style.justifyContent = 'space-between';
                            row.style.alignItems = 'center';
                            row.innerHTML = `<span style="font-family:monospace;">${escapeHtml(skill)}</span>
                                <button class="detect-btn" data-skill="${escapeHtml(skill)}" style="padding:0 6px; width:auto; border-radius:4px;" title="${tr('Delete this skill', '删除此技能')}">${svgIconNoMargin('trash')}</button>`;
                            row.querySelector('button')!.addEventListener('click', (e) => {
                                const btn = e.currentTarget as HTMLButtonElement;
                                btn.disabled = true; btn.textContent = '...';
                                vscode.postMessage({ type: 'deleteSkill', skill: btn.dataset.skill });
                            });
                            list.appendChild(row);
                        });
                    }
                }
                break;
            }

            case 'skillInstallComplete': {
                const btn = document.getElementById('installSkillBtn') as HTMLButtonElement;
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = tr('Install/import', '安装/导入');
                }
                const input = document.getElementById('skillSourceInput') as HTMLInputElement;
                if (input && msg.success) input.value = '';
                break;
            }

            case 'settingsData':
                settingsCodexAccount = msg.codexAccount;
                settingsAntigravityAccount = isAntigravityAccountStatus(msg.antigravityAccount) ? msg.antigravityAccount : undefined;
                if (isSubscriptionProxyStatus(msg.subscriptionProxy)) settingsSubscriptionProxy = msg.subscriptionProxy;
                cachedSettingsData = {
                    providers: msg.providers,
                    current: msg.current,
                    ollamaModels: msg.ollamaModels || [],
                };
                if (msg.current && msg.current.maxContextTokens > 0) contextLimit = msg.current.maxContextTokens;
                // Cache model context token map for use in updateModelUI
                if (msg.modelContextTokens) settingsModelContextTokens = msg.modelContextTokens;
                if (msg.thinkingModelPrefixes) settingsThinkingPrefixes = msg.thinkingModelPrefixes;
                settingsReasoningCapabilities = msg.reasoningCapabilities || {};
                updateQuickModelSelector(msg.providers, msg.current, msg.ollamaModels);
                updateQuickReasoningSelector(msg.current);
                updateQuickWriteModeSelector(deriveWriteTier(msg.current));
                {
                    const trigger = document.getElementById('quickWriteModeTrigger');
                    const unavailable = msg.current?.sandboxBackend?.available === false && !msg.current?.securitySandboxDisabled;
                    if (trigger) {
                        const baseTitle = trigger.dataset.baseTitle || trigger.title;
                        trigger.dataset.baseTitle = baseTitle;
                        trigger.title = unavailable && msg.current?.sandboxBackend?.message
                            ? `${baseTitle}${baseTitle ? ' — ' : ''}${msg.current.sandboxBackend.message}`
                            : baseTitle;
                    }
                }
                {
                    const managerSettingsVisible = isManagerShell()
                        && document.body.dataset.managerActiveTab === 'settings'
                        && document.body.classList.contains('artifact-drawer-open');
                    if ((msg.showPanel || managerSettingsVisible) && isCurrentSurface(msg.targetSurface)) {
                        showSettingsPage(msg.providers, msg.current, msg.ollamaModels);
                    }
                }
                break;

            case 'subscriptionProxyStatus': {
                if (!isSubscriptionProxyStatus(msg.status)) break;
                settingsSubscriptionProxy = msg.status;
                if (!isCurrentSurface(msg.targetSurface)) break;
                setSubscriptionProxyBusy(false);
                renderSubscriptionProxyStatus(msg.saved === true);
                if (msg.saved === true) {
                    const input = document.getElementById('subscriptionProxyUrl');
                    if (input instanceof HTMLInputElement) input.value = '';
                    const mode = document.getElementById('subscriptionProxyMode');
                    if (mode instanceof HTMLSelectElement) mode.value = msg.status.mode;
                    updateSubscriptionProxyUrlVisibility();
                }
                break;
            }

            case 'ollamaModels': {
                const db = document.getElementById('detectBtn') as HTMLButtonElement | null;
                if (db) { db.disabled = false; db.innerHTML = svgIcon('search') + tr('Detect', '检测'); }
                if (msg.error) { document.getElementById('modelHint')!.textContent = msg.error; }
                else { settingsOllamaModels = msg.models; updateModelUI((document.getElementById('settingsProvider') as HTMLSelectElement).value, '', msg.models); }
                break;
            }
            case 'apiModelsFetched': {
                const fb = document.getElementById('fetchApiModelsBtn') as HTMLButtonElement | null;
                if (fb) { fb.disabled = false; fb.innerHTML = svgIcon('cloud') + tr('Fetch supported models', '拉取支持的模型'); }
                if (msg.error) { document.getElementById('apiKeyStatus')!.textContent = tr('Fetch failed: ', '获取失败: ') + msg.error; document.getElementById('apiKeyStatus')!.style.color = '#ff9800'; }
                else {
                    const p = settingsProviders.find(p => p.id === msg.providerId);
                    if (p && msg.models && msg.models.length > 0) {
                        const newModels = msg.models.map((m: any) => m.id);
                        for (const m of newModels) {
                            if (!p.models.includes(m)) p.models.push(m);
                        }
                        if (msg.dynContexts) {
                            Object.assign(settingsModelContextTokens, msg.dynContexts);
                        }
                        if (msg.reasoningCapabilities) {
                            Object.assign(settingsReasoningCapabilities, msg.reasoningCapabilities);
                        }
                        updateModelUI(msg.providerId, getSelectedModel(), null);
                        const ctxInfo = msg.ctxNote ? ` ${msg.ctxNote}` : '';
                        document.getElementById('modelHint')!.textContent = tr(`Loaded ${newModels.length} model(s) from endpoint.`, `成功从端点加载了 ${newModels.length} 个模型！`) + ctxInfo;
                        document.getElementById('apiKeyStatus')!.innerHTML = svgIcon('check') + tr('Models fetched successfully', '已成功获取模型');
                        document.getElementById('apiKeyStatus')!.style.color = '#4caf50';
                    }
                }
                break;
            }
            case 'testConnectionResult': {
                const tr = document.getElementById('testResult');
                if (tr) {
                    tr.className = 'test-result ' + (msg.ok ? 'ok' : 'fail');
                    tr.textContent = msg.message;
                }
                break;
            }
            case 'usageStats': {
                const stats = msg.stats;
                const c = document.getElementById('usageStatsContent');
                if (!c) break;

                if (!stats || stats.totalTokens === 0) {
                    c.innerHTML = `<div style="opacity:0.6; text-align:center; padding: 10px;">${tr('No token usage data yet', '暂无 Token 消耗数据')}</div>`;
                    break;
                }

                let html = '';
                const cache = stats.cacheStats;
                const cacheBucket = (value: unknown) => {
                    if (!value || typeof value !== 'object') {
                        return { requests: 0, hitRequests: 0, requestHitRate: 0 };
                    }
                    const record = value as Record<string, unknown>;
                    return {
                        requests: typeof record.requests === 'number' ? record.requests : 0,
                        hitRequests: typeof record.hitRequests === 'number' ? record.hitRequests : 0,
                        requestHitRate: typeof record.requestHitRate === 'number' ? record.requestHitRate : 0,
                    };
                };
                const renderCacheDimension = (
                    label: string,
                    groups: Record<string, unknown> | undefined,
                    compactKeys = false,
                ) => {
                    const allEntries = Object.entries(groups || {})
                        .sort((left, right) => cacheBucket(right[1]).requests - cacheBucket(left[1]).requests)
                    const entries = allEntries.slice(0, 6);
                    if (entries.length === 0) return '';
                    const chips = entries.map(([key, value]) => {
                        const bucket = cacheBucket(value);
                        const hitRate = Math.max(0, Math.min(100, bucket.requestHitRate));
                        const displayKey = compactKeys && key.length > 20
                            ? `${key.slice(0, 8)}…${key.slice(-6)}`
                            : key;
                        const requestSummary = tr(
                            `${bucket.hitRequests}/${bucket.requests} requests hit`,
                            `${bucket.hitRequests}/${bucket.requests} 次命中`,
                        );
                        return `<span class="usage-cache-chip" title="${escapeHtml(`${key} · ${requestSummary}`)}">
                            <span class="usage-cache-chip-name">${escapeHtml(displayKey)}</span>
                            <strong>${hitRate.toFixed(1)}%</strong>
                            <span class="usage-cache-chip-count">${escapeHtml(requestSummary)}</span>
                            <span class="usage-cache-chip-meter"><i style="width:${hitRate}%;"></i></span>
                        </span>`;
                    }).join('');
                    const overflow = allEntries.length > entries.length
                        ? `<span class="usage-cache-overflow">+${allEntries.length - entries.length}</span>`
                        : '';
                    return `<div class="usage-cache-dimension">
                        <span class="usage-cache-dimension-label">${escapeHtml(label)}</span>
                        <div class="usage-cache-values">${chips}${overflow}</div>
                    </div>`;
                };

                // ── Summary ──
                html += `<div class="settings-usage-summary">
                    <div><span>${tr('Total tokens', '消耗 tokens')}</span><strong title="${escapeHtml(stats.totalTokens.toLocaleString())}">${new Intl.NumberFormat(chatI18n.locale, { notation: 'compact', maximumFractionDigits: 0 }).format(stats.totalTokens)}</strong></div>
                    <div><span>${tr('Estimated cost', '估算费用')}</span><strong>¥${typeof stats.totalCostCny === 'number' ? stats.totalCostCny.toFixed(2) : '0.00'}</strong></div>
                    ${cache ? `<div><span>${tr('Request hit rate', '请求命中率')}</span><strong>${Number(cache.requestHitRate || 0).toFixed(1)}%</strong></div>` : ''}
                </div><div class="settings-hint settings-usage-calls">${tr(`${stats.totalCalls ?? 0} call(s)`, `共 ${stats.totalCalls ?? 0} 次调用`)}</div>`;

                if (cache) {
                    html += '<details class="usage-cache-panel">';
                    html += `<summary class="usage-cache-heading">
                        <span>${tr('Cache request breakdown', '缓存请求分组')}</span>
                        <small>${tr('Request-level hit rate', '按请求统计命中率')}</small>
                    </summary>`;
                    html += `<div class="usage-cache-overview">
                        <div class="usage-cache-metric"><span>${tr('Cache requests', '缓存请求')}</span><strong>${Number(cache.requestHitRate || 0).toFixed(1)}%</strong></div>
                        <div class="usage-cache-metric"><span>${tr('cached input tokens', '缓存输入 token')}</span><strong>${Number(cache.cachedInputTokenRatio || 0).toFixed(1)}%</strong></div>
                        <div class="usage-cache-metric"><span>${tr('token hit rate', 'token 命中率')}</span><strong>${Number(cache.cacheHitRate || 0).toFixed(1)}%</strong></div>
                        <div class="usage-cache-metric"><span>${tr('saved tokens', '节省 token')}</span><strong>${Number(cache.totalCachedTokens || 0).toLocaleString()}</strong><small>${tr('saved about', '约节省')} ¥${Number(cache.estimatedSavingsCny || 0).toFixed(2)}</small></div>
                    </div>`;
                    html += '<div class="usage-cache-dimensions">';
                    html += renderCacheDimension(tr('Provider', '供应商'), cache.byProvider);
                    html += renderCacheDimension(tr('Model', '模型'), cache.byModel);
                    html += renderCacheDimension(tr('Agent mode', 'Agent 模式'), cache.byAgentMode);
                    html += renderCacheDimension(tr('Tool focus', '工具焦点'), cache.byToolFocus);
                    html += '</div>';
                    const promptFingerprintCount = Object.keys(cache.byPromptFingerprint || {}).length;
                    if (promptFingerprintCount > 0) {
                        html += `<details class="usage-cache-advanced">
                            <summary>${tr('Prompt fingerprint', '提示词指纹')} <span>${promptFingerprintCount}</span></summary>
                            ${renderCacheDimension(tr('Prompt variants', '提示词版本'), cache.byPromptFingerprint, true)}
                        </details>`;
                    }
                    const invalidations = Object.entries(cache.invalidationReasons || {})
                        .sort((left, right) => Number(right[1]) - Number(left[1]));
                    if (invalidations.length > 0) {
                        html += `<div class="usage-cache-misses">
                            <span>${tr('Zero-hit reasons', '零命中原因')}</span>
                            <div>${invalidations.map(([reason, count]) => `<span title="${escapeHtml(reason)}">${escapeHtml(reason.replace(/_/g, ' '))}<strong>${Number(count)}</strong></span>`).join('')}</div>
                        </div>`;
                    }
                    html += '</details>';
                }

                // ── Provider breakdown ──
                html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px; margin-bottom: 10px;">';
                html += `<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">${tr('By provider', '按 Provider')}</div>`;
                for (const [providerId, pStats] of Object.entries(stats.byProvider || {})) {
                    html += `<div style="display:flex; justify-content:space-between; margin-bottom: 3px;">
                                <span style="opacity:0.8;">${providerId}</span>
                                <span><b>${(pStats as any).tokens.toLocaleString()}</b> <span style="opacity:0.5; font-size:10px;">(¥${typeof (pStats as any).costCny === 'number' ? (pStats as any).costCny.toFixed(2) : '0.00'})</span></span>
                             </div>`;
                }
                html += '</div>';

                // ── Model distribution ──
                if (stats.modelDistribution && stats.modelDistribution.length > 0) {
                    html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px; margin-bottom: 10px;">';
                    html += `<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">${tr('Model distribution', '模型分布')}</div>`;
                    for (const m of stats.modelDistribution) {
                        const barWidth = Math.max(2, m.percentage);
                        const shortModel = m.model.length > 24 ? m.model.slice(0, 22) + '…' : m.model;
                        html += `<div style="margin-bottom: 5px;">
                            <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:2px;">
                                <span title="${m.model}" style="opacity:0.85;">${shortModel}</span>
                                <span style="opacity:0.6;">${m.percentage}% · ${tr(`${m.callCount} calls`, `${m.callCount} 次`)}</span>
                            </div>
                            <div style="background:var(--border); border-radius:3px; height:6px; overflow:hidden;">
                                <div style="width:${barWidth}%; height:100%; background:var(--accent); border-radius:3px; transition:width 0.3s;"></div>
                            </div>
                        </div>`;
                    }
                    html += '</div>';
                }

                // Daily totals share the full chart width; exact values remain keyboard accessible.
                if (stats.dailyStats && stats.dailyStats.length > 0) {
                    const recent = stats.dailyStats.slice(0, 14).reverse();
                    const maxTokens = Math.max(...recent.map((day: { tokens: number }) => day.tokens), 1);
                    html += `<div class="usage-trend"><div class="usage-trend-heading"><strong>${tr('Daily usage', '每日用量')}</strong><span>Tokens · ${tr('Peak', '峰值')} ${maxTokens.toLocaleString()}</span></div><div class="usage-trend-bars">`;
                    for (const day of recent) {
                        const height = Math.max(2, Math.round(day.tokens / maxTokens * 100));
                        const label = `${day.date}: ${day.tokens.toLocaleString()} tokens · ${tr(`${day.callCount} calls`, `${day.callCount} 次调用`)} · ¥${day.costCny.toFixed(2)}`;
                        html += `<div class="usage-trend-day" tabindex="0" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span style="height:${height}%"></span></div>`;
                    }
                    html += `</div><div class="usage-trend-dates"><span>${escapeHtml(recent[0].date)}</span><span>${escapeHtml(recent[recent.length - 1].date)}</span></div></div>`;
                }

                // ── Batch 4.2: Tool frequency ──
                if (stats.toolFrequency && stats.toolFrequency.length > 0) {
                    html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px; margin-bottom: 10px;">';
                    html += `<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">${tr('Tool usage frequency', '工具使用频率')}</div>`;
                    for (const [index, t] of stats.toolFrequency.entries()) {
                        if (index === 5) html += `<details class="usage-tools-more"><summary>${tr(`Show ${stats.toolFrequency.length - 5} more tools`, `展开其余 ${stats.toolFrequency.length - 5} 个工具`)}</summary>`;
                        const barW = Math.max(2, t.percentage);
                        html += `<div style="margin-bottom: 4px;">
                            <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:2px;">
                                <span style="opacity:0.85; font-family:var(--vscode-editor-font-family,monospace);">${escapeHtml(t.tool)}</span>
                                <span style="opacity:0.6;">${t.count}× (${t.percentage}%)</span>
                            </div>
                            <div style="background:var(--border); border-radius:3px; height:4px; overflow:hidden;">
                                <div style="width:${barW}%; height:100%; background:cornflowerblue; border-radius:3px; transition:width 0.3s;"></div>
                            </div>
                        </div>`;
                    }
                    if (stats.toolFrequency.length > 5) html += '</details>';
                    html += '</div>';
                }

                // ── Batch 4.2: Average response time ──
                if (stats.avgResponseMs && stats.avgResponseMs > 0) {
                    const avgSec = (stats.avgResponseMs / 1000).toFixed(1);
                    html += `<div style="border-top: 1px dashed var(--border); padding-top: 6px; font-size:11px; opacity:0.7;">
                        ${tr('Average response time', '平均响应时间')}: <b>${avgSec}s</b> (${stats.avgResponseMs}ms)
                    </div>`;
                }

                c.innerHTML = html;
                break;
            }

            case 'planFileSaved': {
                // Compact card — just "open file" button; annotation is handled by renderPlan below
                const card = document.createElement('div');
                card.className = 'plan-file-card';
                prepareSingleFileArtifactCard(card, 'plan', msg.filePath, msg.relPath);
                card.innerHTML = `
                    <div class="plan-file-icon">${svgIconNoMargin('clipboard')}</div>
                    <div class="plan-file-info">
                        <div class="plan-file-title">${tr('Implementation Plan exported', '实施计划已导出')}</div>
                        <div class="plan-file-path">${escapeHtml(msg.relPath)}</div>
                        <div class="plan-file-hint">${tr('After confirmation, the approved plan enters execution.', '确认后，已批准计划将进入执行。')}</div>
                    </div>
                    <div class="plan-file-actions">
                        <button class="plan-open-btn" data-path="${escapeHtml(msg.filePath)}">${svgIconNoMargin('folder')} ${tr('Open file', '打开文件')}</button>
                    </div>`;
                (card.querySelector('.plan-open-btn') as HTMLElement).addEventListener('click', e => {
                    vscode.postMessage({ type: 'openPlanFile', filePath: (e.currentTarget as HTMLElement).dataset.path });
                });
                chatArea.appendChild(card);
                scrollBottom();
                break;
            }

            case 'renderPlan': {
                const labels = chatI18n.annotations.plan;
                const sourceKey = 'plan';
                const signature = JSON.stringify(msg.sections || []);
                if (!isManagerShell()) {
                    document.querySelectorAll('.annotatable-plan.plan-card-wrap').forEach(el => dismissCard(el as HTMLElement, 0));
                }
                const cardOptions: AnnotationCardOptions = {
                    className: 'plan-card-wrap',
                    icon: 'edit',
                    approveIcon: 'check',
                    sections: msg.sections || [],
                    labels,
                    renderMarkdown,
                    postMessage: message => vscode.postMessage(message),
                    dismissCard: (element, delay = 0, done, removeFromDom) => dismissCard(element, delay, done, removeFromDom),
                    approveMessageType: 'submitPlanAnnotations',
                    reviseMessageType: 'revisePlanWithAnnotations',
                };
                const wrap = createAnnotationCard(cardOptions);
                showAnnotationWorkspacePanel({
                    kind: 'plan',
                    title: labels.title,
                    subtitle: labels.hint,
                    content: wrap,
                    wide: true,
                    sourceKey,
                    signature,
                    annotationOptions: cardOptions,
                });
                scheduleResponsiveWorkspaceLayoutSync();
                break;
            }

            case 'walkthroughFileSaved': {
                const card = document.createElement('div');
                card.className = 'plan-file-card walkthrough-file-card';
                prepareSingleFileArtifactCard(card, 'walkthrough', msg.filePath, msg.relPath);
                card.innerHTML = `
                    <div class="plan-file-icon">${svgIconNoMargin('flag')}</div>
                    <div class="plan-file-info">
                        <div class="plan-file-title">${tr('Walkthrough report exported', 'Walkthrough 报告已导出')}</div>
                        <div class="plan-file-path">${escapeHtml(msg.relPath)}</div>
                    </div>
                    <div class="plan-file-actions">
                        <button class="plan-open-btn" data-path="${escapeHtml(msg.filePath)}">${svgIconNoMargin('folder')} ${tr('Open file', '打开文件')}</button>
                    </div>`;
                (card.querySelector('.plan-open-btn') as HTMLElement).addEventListener('click', e => {
                    vscode.postMessage({ type: 'openPlanFile', filePath: (e.currentTarget as HTMLElement).dataset.path });
                });
                chatArea.appendChild(card);
                scrollBottom();
                break;
            }

            case 'blueprintFileSaved': {
                const card = document.createElement('div');
                card.className = 'plan-file-card blueprint-file-card';
                prepareSingleFileArtifactCard(card, 'blueprint', msg.filePath, msg.relPath);
                card.innerHTML = `
                    <div class="plan-file-icon">${svgIconNoMargin('layers')}</div>
                    <div class="plan-file-info">
                        <div class="plan-file-title">${tr('Blueprint exported', '设计蓝图已导出')}</div>
                        <div class="plan-file-path">${escapeHtml(msg.relPath)}</div>
                    </div>
                    <div class="plan-file-actions">
                        <button class="plan-open-btn" data-path="${escapeHtml(msg.filePath)}">${svgIconNoMargin('folder')} ${tr('Open file', '打开文件')}</button>
                    </div>`;
                (card.querySelector('.plan-open-btn') as HTMLElement).addEventListener('click', e => {
                    vscode.postMessage({ type: 'openPlanFile', filePath: (e.currentTarget as HTMLElement).dataset.path });
                });
                chatArea.appendChild(card);
                scrollBottom();
                break;
            }

            case 'renderWalkthrough': {
                const signature = JSON.stringify(msg.sections || []);
                if (!isManagerShell()) {
                    document.querySelectorAll('.annotatable-plan.walkthrough-card-wrap').forEach(el => dismissCard(el as HTMLElement, 0));
                }
                const cardOptions: AnnotationCardOptions = {
                    className: 'walkthrough-card-wrap',
                    icon: 'flag',
                    sections: msg.sections || [],
                    labels: chatI18n.annotations.walkthrough,
                    renderMarkdown,
                    postMessage: message => vscode.postMessage(message),
                    dismissCard: (element, delay = 0, done, removeFromDom) => dismissCard(element, delay, done, removeFromDom),
                    approveMessageType: 'approveWalkthrough',
                    reviseMessageType: 'reviseWalkthroughWithAnnotations',
                    disableApproveOnSubmit: true,
                };
                const wrap = createAnnotationCard(cardOptions);
                showAnnotationWorkspacePanel({
                    kind: 'walkthrough',
                    title: chatI18n.annotations.walkthrough.title,
                    subtitle: chatI18n.annotations.walkthrough.hint,
                    content: wrap,
                    wide: true,
                    sourceKey: 'walkthrough',
                    signature,
                    annotationOptions: cardOptions,
                });
                scheduleResponsiveWorkspaceLayoutSync();
                break;
            }

            case 'renderBlueprint': {
                const signature = JSON.stringify(msg.sections || []);
                if (!isManagerShell()) {
                    document.querySelectorAll('.annotatable-plan.blueprint-card-wrap').forEach(el => dismissCard(el as HTMLElement, 0));
                }
                const cardOptions: AnnotationCardOptions = {
                    className: 'blueprint-card-wrap',
                    icon: 'layers',
                    sections: msg.sections || [],
                    labels: chatI18n.annotations.blueprint,
                    renderMarkdown,
                    postMessage: message => vscode.postMessage(message),
                    dismissCard: (element, delay = 0, done, removeFromDom) => dismissCard(element, delay, done, removeFromDom),
                    approveMessageType: 'submitPlanAnnotations',
                    reviseMessageType: 'revisePlanWithAnnotations',
                };
                const wrap = createAnnotationCard(cardOptions);
                showAnnotationWorkspacePanel({
                    kind: 'blueprint',
                    title: chatI18n.annotations.blueprint.title,
                    subtitle: chatI18n.annotations.blueprint.hint,
                    content: wrap,
                    wide: true,
                    sourceKey: 'blueprint',
                    signature,
                    annotationOptions: cardOptions,
                });
                scheduleResponsiveWorkspaceLayoutSync();
                break;
            }

            case 'insertSelectionReference': {
                insertReferenceAtCaret({
                    id: generateContextId(),
                    type: 'code_selection',
                    label: msg.relPath.split('/').pop() || msg.relPath,
                    uri: msg.relPath,
                    startLine: msg.startLine,
                    endLine: msg.endLine,
                    tokenEstimate: Math.max(1, (msg.endLine - msg.startLine + 1) * 24),
                    cacheStatus: 'live',
                });
                break;
            }

            case 'tokenUsage': {
                // Override/supplement with actual counted tokens from the API
                // This fires AFTER generationComplete (for plan mode) or may duplicate normal mode;
                // only update if we don't already have real data (avoid double-counting).
                const u = msg.usage;
                if (u && u.total > 0) {
                    const gaugeUsage = u.contextWindowTokens
                        ?? ((u.compactionCalls ?? 0) > 0 ? undefined : (u.input ?? (u.total > contextLimit ? Math.min(u.total, contextLimit) : u.total)));
                    totalConversationTokens = u.total;
                    if (typeof gaugeUsage !== 'number' || gaugeUsage <= 0) break;
                    lastKnownContextTokens = gaugeUsage;
                    updateTokenUsage(gaugeUsage, contextLimit);
                    // Completely replace the label with token + cost info
                    const label = document.getElementById('tokenUsageLabel');
                    if (label) {
                        const cacheText = u.cachedTokens ? ` · <span style="display:inline-flex; align-items:center; gap:2px; vertical-align:middle; color:var(--vscode-charts-green, #388a34); margin-top:-2px;">${svgIconNoMargin('zap')} ${formatNum(u.cachedTokens)} ${tr('cached', '缓存')}</span>` : '';
                        const base = `~${formatNum(gaugeUsage)} / ${formatNum(contextLimit)} tokens · ${tr('last request', '上次请求')}` + cacheText;
                        const cost = u.estimatedCostCny > 0
                            ? ' · ' + (u.estimatedCostCny < 0.01 ? '<¥0.01' : '¥' + u.estimatedCostCny.toFixed(2))
                            : '';
                        label.innerHTML = base + cost;
                    }
                }
                break;
            }

            case 'diffSummary': {
                if (!msg.files || msg.files.length === 0) break;
                const summaryFiles: SideDiffFile[] = mergeSideDiffFiles(msg.files.map((f: any) => ({
                    file: f.file,
                    status: f.status,
                    diffPreview: f.diffPreview,
                    additions: f.additions,
                    deletions: f.deletions,
                    diffLines: f.diffLines,
                })));
                if (summaryFiles.length === 0) break;
                const summarySourceKey = msg.summaryId || getSideDiffSourceKey(uiText.fileChanges, summaryFiles);
                removeDuplicateDiffSummaryFiles(summaryFiles, summarySourceKey);
                const card = document.createElement('div');
                card.className = 'diff-summary-card';
                card.dataset.diffSummaryId = summarySourceKey;

                // Header with total stats
                let totalAdd = 0, totalDel = 0;
                for (const f of summaryFiles) { totalAdd += f.additions || 0; totalDel += f.deletions || 0; }
                const collapseSummaryLabel = chatI18n.locale === 'zh-cn' ? '收起文件变更摘要' : 'Collapse file-change summary';
                const expandSummaryLabel = chatI18n.locale === 'zh-cn' ? '展开文件变更摘要' : 'Expand file-change summary';
                const editedFilesLabel = chatI18n.locale === 'zh-cn'
                    ? `已编辑 ${summaryFiles.length} 个文件`
                    : `Edited ${summaryFiles.length} ${summaryFiles.length === 1 ? 'file' : 'files'}`;
                const reviewLabel = chatI18n.locale === 'zh-cn' ? '审核' : 'Review';
                const headerHtml = `<div class="ds-header">
                    <button class="ds-collapse-btn" type="button" aria-label="${escapeHtml(collapseSummaryLabel)}" aria-expanded="true">▾</button>
                    <span class="ds-title">${svgIconNoMargin('edit')}<span class="ds-title-text">${escapeHtml(editedFilesLabel)}</span></span>
                    <span class="ds-stats"><span class="ds-add">+${totalAdd}</span> <span class="ds-del">-${totalDel}</span></span>
                    <button class="ds-review-btn" type="button">${escapeHtml(reviewLabel)}</button>
                </div>`;
                card.innerHTML = headerHtml;

                const filesList = document.createElement('div');
                filesList.className = 'ds-files';

                for (const f of summaryFiles) {
                    const fileEl = document.createElement('div');
                    fileEl.className = `ds-file ds-file-${artifactFileStatusTone(f.status)}`;
                    fileEl.dataset.diffFile = normalizeSideDiffFilePath(f.file);
                    fileEl.dataset.diffAdditions = String(f.additions || 0);
                    fileEl.dataset.diffDeletions = String(f.deletions || 0);

                    const baseName = f.file.replace(/\\/g, '/').split('/').pop() || f.file;
                    const relPath = f.file.replace(/\\/g, '/');
                    const statusBadge = renderDiffFileStatusBadge(f.status, 'ds');
                    const statsText = renderDiffFileDelta(f as SideDiffFile, 'ds');

                    const fileHeader = document.createElement('div');
                    fileHeader.className = 'ds-file-header';
                    fileHeader.innerHTML = `${statusBadge}
                        <span class="ds-file-main">
                            <span class="ds-file-name" title="${escapeHtml(relPath)}">${escapeHtml(baseName)}</span>
                            <span class="ds-file-path">${escapeHtml(relPath)}</span>
                        </span>
                        <span class="ds-file-stats">${statsText}</span>
                        ${f.diffLines && f.diffLines.length > 0 ? '<span class="ds-expand-btn">▶</span>' : ''}`;

                    fileEl.appendChild(fileHeader);

                    // Line-level diff body (collapsed by default)
                    if (f.diffLines && f.diffLines.length > 0) {
                        const diffBody = document.createElement('div');
                        diffBody.className = 'ds-diff-body';
                        diffBody.style.display = 'none';

                        let diffHtml = '<table class="ds-diff-table"><tbody>';
                        for (const line of f.diffLines) {
                            const cls = line.type === 'add' ? 'ds-line-add' : line.type === 'remove' ? 'ds-line-del' : 'ds-line-ctx';
                            const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
                            const oldNo = line.oldLineNo != null ? String(line.oldLineNo) : '';
                            const newNo = line.newLineNo != null ? String(line.newLineNo) : '';
                            diffHtml += `<tr class="${cls}">
                                <td class="ds-ln">${oldNo}</td>
                                <td class="ds-ln">${newNo}</td>
                                <td class="ds-prefix">${prefix}</td>
                                <td class="ds-code">${escapeHtml(line.content)}</td>
                            </tr>`;
                        }
                        diffHtml += '</tbody></table>';
                        diffBody.innerHTML = diffHtml;
                        fileEl.appendChild(diffBody);

                        // Toggle expand/collapse
                        fileHeader.style.cursor = 'pointer';
                        fileHeader.addEventListener('click', () => {
                            if (shouldUseSideWorkspace()) {
                                openDiffInSideWorkspace(summaryFiles, uiText.fileChanges, { sourceKey: summarySourceKey, focusFile: f.file });
                                return;
                            }
                            const isOpen = diffBody.style.display !== 'none';
                            diffBody.style.display = isOpen ? 'none' : 'block';
                            const btn = fileHeader.querySelector('.ds-expand-btn');
                            if (btn) btn.textContent = isOpen ? '▶' : '▼';
                        });
                    }

                    filesList.appendChild(fileEl);
                }

                card.appendChild(filesList);
                const collapseBtn = card.querySelector('.ds-collapse-btn') as HTMLButtonElement | null;
                if (collapseBtn) {
                    collapseBtn.addEventListener('click', event => {
                        event.stopPropagation();
                        const collapsed = card.classList.toggle('collapsed');
                        collapseBtn.textContent = collapsed ? '▸' : '▾';
                        collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                        collapseBtn.setAttribute('aria-label', collapsed ? expandSummaryLabel : collapseSummaryLabel);
                    });
                }
                card.querySelector<HTMLButtonElement>('.ds-review-btn')?.addEventListener('click', event => {
                    event.stopPropagation();
                    openDiffInSideWorkspace(summaryFiles, uiText.fileChanges, { sourceKey: summarySourceKey });
                });
                chatArea.appendChild(card);
                scrollBottom();
                if (shouldUseSideWorkspace()) {
                    openDiffInSideWorkspace(summaryFiles, uiText.fileChanges, { sourceKey: summarySourceKey });
                }
                break;
            }

            case 'topicSearchResults': {
                const currentFromResults = msg.stats?.currentTopicId
                    ? (msg.results || []).find((t: TopicPanelItem) => t.id === msg.stats.currentTopicId)
                    : undefined;
                updateCurrentTopicHeader(
                    msg.stats?.currentTopicId ?? currentTopicId,
                    msg.stats?.currentTopicTitle ?? currentFromResults?.title ?? currentTopicTitle
                );
                renderTopicSearchResults(msg.results || [], msg.query || '', msg.totalCount || (msg.results ? msg.results.length : 0), msg.stats);
                break;
            }
        }
    });

    // ── Topic list with date groups ────────────────────────────────────────────
    const showArchivedCb = document.getElementById('showArchivedCb') as HTMLInputElement;
    if (showArchivedCb) {
        showArchivedCb.addEventListener('change', (e) => {
            vscode.postMessage({ type: 'setShowArchived', show: (e.target as HTMLInputElement).checked });
        });
    }

    function updateCurrentTopicHeader(topicId?: string | null, title?: string | null) {
        currentTopicId = topicId || null;
        currentTopicTitle = title || '';
        const titleBtn = document.getElementById('currentTopicTitle') as HTMLButtonElement | null;
        const renameBtn = document.getElementById('currentTopicRename') as HTMLButtonElement | null;
        const chip = document.getElementById('currentTopicChip') as HTMLElement | null;
        const label = currentTopicTitle || tr('New topic', '新话题');
        if (titleBtn) {
            titleBtn.textContent = label;
            titleBtn.title = currentTopicId ? tr(`Rename: ${label}`, `重命名：${label}`) : tr('A topic is created after the first message', '发送第一条消息后创建话题');
            titleBtn.disabled = !currentTopicId;
        }
        if (renameBtn) {
            renameBtn.disabled = !currentTopicId;
            renameBtn.style.display = currentTopicId ? '' : 'none';
        }
        if (chip) chip.classList.toggle('current-topic-empty', !currentTopicId);
    }

    function commitTopicRename(topicId: string, rawTitle: string, originalTitle: string) {
        const nextTitle = rawTitle.trim().replace(/\s+/g, ' ');
        if (!nextTitle || nextTitle === originalTitle) return false;
        vscode.postMessage({ type: 'renameTopic', topicId, title: nextTitle });
        return true;
    }

    function startTopicRename(topicId: string, title: string, source: 'header' | 'list' | 'search', titleEl?: HTMLElement) {
        if (!topicId) return;
        const originalTitle = title || '';
        const headerTitleBtn = source === 'header'
            ? document.getElementById('currentTopicTitle') as HTMLButtonElement | null
            : null;
        const input = document.createElement('input');
        input.className = 'topic-rename-input';
        input.value = originalTitle;
        input.maxLength = 120;
        input.setAttribute('aria-label', tr('Topic name', '话题名称'));

        let cancelled = false;
        let finished = false;
        const finish = (commit: boolean) => {
            if (finished || !input.isConnected) return;
            // Replacing a focused input can synchronously dispatch blur.
            finished = true;
            const parent = input.parentElement;
            if (commit && !cancelled) {
                commitTopicRename(topicId, input.value, originalTitle);
            }
            if (source === 'header') {
                if (headerTitleBtn && parent) {
                    parent.replaceChild(headerTitleBtn, input);
                }
                updateCurrentTopicHeader(currentTopicId, currentTopicTitle);
            } else if (titleEl && parent) {
                parent.replaceChild(titleEl, input);
            }
        };

        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelled = true;
                finish(false);
            }
        });
        input.addEventListener('blur', () => finish(true));

        if (source === 'header') {
            if (!headerTitleBtn?.parentElement) return;
            headerTitleBtn.replaceWith(input);
        } else if (titleEl?.parentElement) {
            titleEl.replaceWith(input);
        }

        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    }

    function renderTopics(topics: TopicPanelItem[], stats?: TopicPanelStats) {
        renderTopicsView(
            { list: document.getElementById('topicsList'), summary: document.getElementById('topicsPanelSummary'), panel: topicsPanel },
            topics,
            stats,
            {
                postMessage: message => {
                    vscode.postMessage(message);
                    if ((message as any)?.type === 'loadTopic' && sideWorkspaceContent !== topicsPanel) {
                        topicsPanel.classList.remove('show');
                    }
                },
                startRename: (topicId, title, source, titleElement) => startTopicRename(topicId, title, source, titleElement),
                formatTime,
            },
            { grouping: document.body.classList.contains('agent-manager-shell') ? 'workspace' : 'date' },
        );
    }

    function renderTopicSearchResults(results: TopicPanelItem[], query: string, totalCount: number, stats?: TopicPanelStats) {
        renderTopicSearchResultsView(
            { list: document.getElementById('topicsList'), summary: document.getElementById('topicsPanelSummary'), panel: topicsPanel },
            results,
            query,
            totalCount,
            stats,
            {
                postMessage: message => {
                    vscode.postMessage(message);
                    if ((message as any)?.type === 'loadTopic' && sideWorkspaceContent !== topicsPanel) {
                        topicsPanel.classList.remove('show');
                    }
                },
                startRename: (topicId, title, source, titleElement) => startTopicRename(topicId, title, source, titleElement),
                formatTime,
            },
        );
    }

    function isTodoView(value: unknown): value is TodoView {
        if (!value || typeof value !== 'object') return false;
        const candidate = value as Partial<TodoView>;
        return typeof candidate.content === 'string'
            && candidate.content.trim().length > 0
            && (candidate.status === 'pending' || candidate.status === 'in_progress' || candidate.status === 'done');
    }

    function normalizeTodoViews(value: unknown): TodoView[] {
        return Array.isArray(value) ? value.filter(isTodoView).map(todo => ({ ...todo })) : [];
    }

    function latestTodosFromSteps(steps: readonly unknown[]): TodoView[] {
        for (let index = steps.length - 1; index >= 0; index--) {
            const step = steps[index];
            if (!step || typeof step !== 'object') continue;
            const record = step as { type?: unknown; toolName?: unknown; toolArgs?: { todos?: unknown } };
            if (record.type !== 'tool_call' || record.toolName !== 'todo_write') continue;
            const todos = normalizeTodoViews(record.toolArgs?.todos);
            if (todos.length > 0) return todos;
        }
        return [];
    }

    function todoItemsHtml(todos: readonly TodoView[]): string {
        const icons: Record<TodoView['status'], string> = { pending: '○', in_progress: '●', done: '✓' };
        return todos.map(todo => {
            const cls = todo.status === 'done' ? 'done' : todo.status === 'in_progress' ? 'in_progress' : '';
            return `<div class="todo-item ${cls}"><span>${icons[todo.status]}</span>${escapeHtml(todo.content)}</div>`;
        }).join('');
    }

    function renderSubagentTodoPanel(fullscreen: HTMLElement, todos: readonly TodoView[]): void {
        fullscreen.querySelector('.subagent-task-panel')?.remove();
        if (todos.length === 0) return;
        const done = todos.filter(todo => todo.status === 'done').length;
        const panel = document.createElement('details');
        panel.className = 'subagent-task-panel';
        panel.open = todos.some(todo => todo.status === 'in_progress');
        panel.innerHTML = `
            <summary><span>${tr('Tasks', '任务')}</span><strong>${done}/${todos.length}</strong></summary>
            <div class="subagent-task-list">${todoItemsHtml(todos)}</div>
        `;
        fullscreen.querySelector('.subagent-header')?.insertAdjacentElement('afterend', panel);
    }

    function renderSubagentTodos(agentId: string, rawTodos: unknown): void {
        const todos = normalizeTodoViews(rawTodos);
        subagentTodos.set(agentId, todos);
        const matchingViews = Array.from(document.querySelectorAll<HTMLElement>('.subagent-fullscreen-view'))
            .filter(fullscreen => fullscreen.dataset.agentId === agentId);
        const currentView = matchingViews[matchingViews.length - 1];
        if (currentView) renderSubagentTodoPanel(currentView, todos);
    }

    function renderTodos(rawTodos: unknown) {
        const todos = normalizeTodoViews(rawTodos);
        const todoList = document.getElementById('todoList');
        if (!todoList) return;
        if (todos.length === 0) { todoPanel.classList.remove('has-items'); todoList.innerHTML = ''; return; }
        todoPanel.classList.add('has-items');
        todoList.innerHTML = todoItemsHtml(todos);
    }

    function updateQuickModelSelector(providers: any[], current: any, ollamaModels: any[]) {
        const qms = document.getElementById('quickModelSelect');
        if (!qms) return;
        const provider = providers.find((p: any) => p.id === current.provider);
        const models: string[] = current.provider === 'ollama' ? (ollamaModels || []).map((m: any) => m.name) : (provider ? provider.models : []);
        quickModelOptions = models.length > 0 ? models : (current.model ? [current.model] : []);
        quickModelCurrent = current.model || quickModelOptions[0] || '';
        qms.innerHTML = '';
        if (models.length > 0) {
            for (const m of models) { const opt = document.createElement('option'); opt.value = m; opt.textContent = m; opt.selected = m === current.model; qms.appendChild(opt); }
        } else { const opt = document.createElement('option'); opt.value = current.model || ''; opt.textContent = current.model || tr('(not set)', '(未设置)'); qms.appendChild(opt); }
        renderQuickModelMenu();
    }

    function updateQuickReasoningSelector(current: any): void {
        updateQuickReasoningControls(
            current?.provider || '',
            current?.model || quickModelCurrent,
            current?.reasoningEffort
        );
    }

    function refreshSettingsOverview() {
        const titleEl = document.getElementById('settingsOverviewTitle');
        const subtitleEl = document.getElementById('settingsOverviewSubtitle');
        const chipsEl = document.getElementById('settingsOverviewChips');
        const providerSel = document.getElementById('settingsProvider') as HTMLSelectElement | null;
        if (!titleEl || !subtitleEl || !chipsEl || !providerSel) return;

        const providerId = providerSel.value || settingsProviders[0]?.id || '';
        const provider = settingsProviders.find((p: any) => p.id === providerId);
        const modelInput = document.getElementById('settingsModelInput') as HTMLInputElement | null;
        const endpointInput = document.getElementById('settingsEndpoint') as HTMLInputElement | null;
        const ctxInput = document.getElementById('settingsCtx') as HTMLInputElement | null;
        const inlineEnabled = document.getElementById('inlineEnabled') as HTMLInputElement | null;
        const inlineProviderSel = document.getElementById('inlineProvider') as HTMLSelectElement | null;
        const writePermissionSel = document.getElementById('agentWriteMode') as HTMLSelectElement | null;
        const reasoningSel = document.getElementById('settingsReasoningEffort') as HTMLSelectElement | null;
        const inlineProviderName = inlineProviderSel?.value
            ? (settingsProviders.find((p: any) => p.id === inlineProviderSel.value)?.name || inlineProviderSel.value)
            : undefined;
        const inlineSummary = document.getElementById('inlineSectionSummary');
        if (inlineSummary) inlineSummary.textContent = inlineEnabled?.checked
            ? `${tr('On', '已开启')} · ${inlineProviderName || tr('Same as chat', '与对话相同')}` : tr('Off', '已关闭');
        const mcpSummary = document.getElementById('mcpSectionSummary');
        const mcpCount = document.querySelectorAll('#mcpServersList .mcp-server-block').length;
        if (mcpSummary) mcpSummary.textContent = tr(`${mcpCount} configured`, `已配置 ${mcpCount} 个`);
        const profilesSummary = document.getElementById('profilesSectionSummary');
        const customProfiles = Array.from(document.querySelectorAll<HTMLElement>('.agent-model-row'))
            .filter(row => Array.from(row.querySelectorAll<HTMLSelectElement>('select'))
                .some(select => select.value && select.value !== '__inherit__')).length;
        if (profilesSummary) profilesSummary.textContent = customProfiles
            ? tr(`${customProfiles} customized`, `${customProfiles} 个独立配置`) : tr('Inherit main model', '继承主模型');
        applySettingsOverview(
            {
                title: titleEl,
                subtitle: subtitleEl,
                chips: chipsEl,
                headerSubtitle: document.getElementById('settingsHeaderSubtitle'),
            },
            buildSettingsOverviewModel({
                providers: settingsProviders,
                providerId,
                model: modelInput?.value.trim() || provider?.defaultModel,
                accountStatus: providerId === 'antigravity'
                    ? (settingsAntigravityAccount?.signedIn ? tr('Signed in', '已登录') : tr('Not signed in', '未登录')) : undefined,
                endpoint: endpointInput?.value.trim() || provider?.defaultEndpoint,
                contextTokens: parseInt(ctxInput?.value || '0', 10) || 0,
                inlineEnabled: !!inlineEnabled?.checked,
                inlineProviderName,
                mcpCount: document.querySelectorAll('#mcpServersList .mcp-server-block').length,
                writeMode: (() => {
                    if (settingsSandboxDisabled) return 'full';
                    const base = writePermissionSel?.value || 'confirm';
                    const autoReviewEl = document.getElementById('approvalsAutoReview') as HTMLInputElement | null;
                    return base === 'auto' && autoReviewEl?.checked ? 'auto_review' : base;
                })(),
                reasoningEffort: reasoningSel?.value || 'high',
            }, chatI18n),
        );
    }

    function showSettingsPage(providers: any[], current: any, ollamaModels: any[]) {
        settingsProviders = providers;
        settingsOllamaModels = ollamaModels || [];
        // Seed the per-provider endpoint map so switching providers swaps the field value.
        settingsProviderEndpoints = {};
        for (const p of providers || []) settingsProviderEndpoints[p.id] = p.userEndpoint || '';
        if (current?.provider && current.endpoint) settingsProviderEndpoints[current.provider] = current.endpoint;
        updateQuickModelSelector(providers, current, ollamaModels);
        updateQuickWriteModeSelector(deriveWriteTier(current));
        const settingsPageSignature = JSON.stringify({
            providers: (providers || []).map((p: any) => ({
                id: p.id,
                name: p.name,
                models: p.models,
                hasKey: p.hasKey,
                defaultModel: p.defaultModel,
                defaultEndpoint: p.defaultEndpoint,
                maxContextTokens: p.maxContextTokens,
            })),
            codexAccount: settingsCodexAccount,
            antigravityAccount: settingsAntigravityAccount,
            subscriptionProxy: settingsSubscriptionProxy,
            current,
            customApiFormat: current.customApiFormat,
            ollamaModels: (ollamaModels || []).map((m: any) => ({ name: m.name, size: m.size, parameterSize: m.parameterSize })),
        });
        if (settingsPage.classList.contains('active') && settingsPageSignature === lastSettingsPageSignature) {
            if (isManagerShell()) {
                settingsInSideWorkspace = true;
                openSideWorkspace({
                    title: chatI18n.locale === 'zh-cn' ? 'AI 设置' : 'AI Settings',
                    subtitle: chatI18n.locale === 'zh-cn' ? '模型、上下文、API 和工具' : 'Models, context, API, and tools',
                    content: settingsPage,
                });
            }
            return;
        }
        lastSettingsPageSignature = settingsPageSignature;
        settingsFormBaseline = null;
        const sel = document.getElementById('settingsProvider') as HTMLSelectElement;
        sel.innerHTML = providers.map((p: any) => '<option value="' + p.id + '"' + (p.id === current.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        const inlineSel = document.getElementById('inlineProvider') as HTMLSelectElement;
        inlineSel.innerHTML = `<option value="">${tr('- Same as chat -', '- 与对话相同 -')}</option>` + providers.map((p: any) => '<option value="' + p.id + '"' + (p.id === current.inlineCompletion?.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        const translationProviderSel = document.getElementById('translationPreviewProvider') as HTMLSelectElement;
        if (translationProviderSel) {
            const utilityProviders = providers.filter((p: any) => p.supportsUtilityCalls !== false);
            const chatSupportsUtilityCalls = providers.find((p: any) => p.id === current.provider)?.supportsUtilityCalls !== false;
            translationProviderSel.innerHTML = (chatSupportsUtilityCalls ? `<option value="">${tr('- Same as chat -', '- 与对话相同 -')}</option>` : '')
                + utilityProviders.map((p: any) => '<option value="' + p.id + '"' + (p.id === current.translationPreview?.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
            const configuredTranslationProvider = current.translationPreview?.provider || '';
            if ((!configuredTranslationProvider && !chatSupportsUtilityCalls)
                || (configuredTranslationProvider && !utilityProviders.some((p: any) => p.id === configuredTranslationProvider))) {
                translationProviderSel.value = utilityProviders[0]?.id || '';
            }
        }
        (document.getElementById('settingsApiKey') as HTMLInputElement).value = '';
        (document.getElementById('settingsEndpoint') as HTMLInputElement).value = current.endpoint || '';
        const customFormatSel = document.getElementById('customApiFormat') as HTMLSelectElement | null;
        if (customFormatSel) customFormatSel.value = current.customApiFormat || 'openai-chat-completions';
        const reasoningKeyInput = document.getElementById('settingsReasoningKey') as HTMLInputElement | null;
        if (reasoningKeyInput) reasoningKeyInput.value = current.reasoningKey || '';
        // Reopening settings must preserve an explicitly saved context limit, including 0.
        const initCtx = autoFillContextForModel(current.model, current.provider, current.maxContextTokens);
        (document.getElementById('settingsCtx') as HTMLInputElement).value = String(initCtx);
        (document.getElementById('settingsReasoningEffort') as HTMLSelectElement).dataset.requested =
            current.reasoningEffort || 'high';
        const responseVerbositySelect = document.getElementById('settingsResponseVerbosity') as HTMLSelectElement | null;
        if (responseVerbositySelect) {
            responseVerbositySelect.value = ['low', 'medium', 'high'].includes(current.responseVerbosity)
                ? current.responseVerbosity
                : 'default';
        }
        const proxyMode = document.getElementById('subscriptionProxyMode');
        if (proxyMode instanceof HTMLSelectElement) proxyMode.value = settingsSubscriptionProxy?.mode ?? 'auto';
        updateSubscriptionProxyUrlVisibility();
        renderSubscriptionProxyStatus();
        const codexServiceTierSelect = document.getElementById('settingsCodexServiceTier') as HTMLSelectElement | null;
        if (codexServiceTierSelect) {
            codexServiceTierSelect.value = current.codexServiceTier === 'fast' ? 'fast' : 'default';
        }
        (document.getElementById('inlineEnabled') as HTMLInputElement).checked = current.inlineCompletion?.enabled ?? false;
        const overlapEl = document.getElementById('inlineOverlapStripping') as HTMLInputElement | null;
        if (overlapEl) overlapEl.checked = current.inlineCompletion?.overlapStripping ?? true;
        const lspFastPathEl = document.getElementById('inlineLspFastPath') as HTMLInputElement | null;
        if (lspFastPathEl) lspFastPathEl.checked = current.inlineCompletion?.lspFastPath ?? true;
        const includeMcpEl = document.getElementById('inlineIncludeMcp') as HTMLInputElement | null;
        if (includeMcpEl) includeMcpEl.checked = current.inlineCompletion?.includeMcpContext ?? false;
        (document.getElementById('inlineEndpoint') as HTMLInputElement).value = current.inlineCompletion?.endpoint || '';
        (document.getElementById('inlineDebounce') as HTMLInputElement).value = String(current.inlineCompletion?.debounceMs ?? 200);
        (document.getElementById('inlineMaxTokens') as HTMLInputElement).value = String(current.inlineCompletion?.maxTokens ?? 128);
        (document.getElementById('inlineContextBefore') as HTMLInputElement).value = String(current.inlineCompletion?.contextBeforeLines ?? 20);
        (document.getElementById('inlineContextAfter') as HTMLInputElement).value = String(current.inlineCompletion?.contextAfterLines ?? 10);
        (document.getElementById('inlineRequestTimeout') as HTMLInputElement).value = String(current.inlineCompletion?.requestTimeoutMs ?? 6000);
        (document.getElementById('inlineMcpCacheTtl') as HTMLInputElement).value = String(current.inlineCompletion?.mcpCacheTtlMs ?? 30000);
        (document.getElementById('agentWriteMode') as HTMLSelectElement).value = current.agentFileWriteMode || 'auto';
        updateQuickWriteModeSelector(deriveWriteTier(current));
        const autoReviewEl = document.getElementById('approvalsAutoReview') as HTMLInputElement | null;
        if (autoReviewEl) autoReviewEl.checked = current.approvals?.reviewer === 'auto_review';
        const web = current.webAccess || {};
        const setWebValue = (id: string, value: unknown) => {
            const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
            if (element) element.value = String(value ?? '');
        };
        setWebValue('webAccessMode', web.mode || 'indexed');
        setWebValue('webSearchProvider', web.provider || 'auto');
        setWebValue('webContextSize', web.contextSize || 'medium');
        setWebValue('webFallbackProviders', web.fallbackProviders || '');
        setWebValue('webAllowedDomains', web.allowedDomains || '');
        setWebValue('webBlockedDomains', web.blockedDomains || '');
        setWebValue('webCountry', web.country || '');
        setWebValue('webSearxngEndpoint', web.searxngEndpoint || '');
        setWebValue('webOpenAIModel', web.openaiModel || '');
        setWebValue('webCacheTtlMs', web.cacheTtlMs ?? 300000);
        const syntheticProxyEl = document.getElementById('webAllowSyntheticProxy') as HTMLInputElement | null;
        if (syntheticProxyEl) syntheticProxyEl.checked = web.allowSyntheticProxyAddresses === true;
        for (const provider of ['brave', 'exa', 'tavily', 'serper', 'serpapi']) {
            setWebValue(`webKey-${provider}`, web.keys?.[provider] || '');
            const keyElement = document.getElementById(`webKey-${provider}`) as HTMLInputElement | null;
            if (keyElement) keyElement.dataset.hadSecret = web.keys?.[provider] ? 'true' : 'false';
        }

        // Render MCP Servers
        const mcpList = document.getElementById('mcpServersList');
        if (mcpList) mcpList.innerHTML = '';
        if (current.mcp?.servers) {
            current.mcp.servers.forEach((s: any) => addMcpServerBlock(s));
        }

        // ── Child Agent model configuration: dynamically populate supplier/model drop-down ──────────────────────
        const savedAgentModels = current.orchestrator?.agentModels || {};
        document.querySelectorAll('.agent-model-row').forEach(row => {
            const role = (row as HTMLElement).dataset.role;
            if (!role) return;
            const provSel = row.querySelector('.agent-model-provider') as HTMLSelectElement;
            const modSel = row.querySelector('.agent-model-model') as HTMLSelectElement;
            if (!provSel || !modSel) return;

            // Populate the supplier dropdown
            provSel.innerHTML = `<option value="__inherit__">${tr('Inherit main settings', '继承主设置')}</option>`
                + providers.filter((p: any) => p.supportsUtilityCalls !== false).map((p: any) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

            const saved = savedAgentModels[role];
            if (saved?.provider && saved.provider !== '__inherit__') {
                provSel.value = saved.provider;
            }

            // Populate model dropdown (according to selected supplier)
            const fillModels = (pid: string) => {
                const provDef = providers.find((p: any) => p.id === pid);
                const models: string[] = pid === 'ollama'
                    ? (ollamaModels || []).map((m: any) => m.name)
                    : (provDef ? provDef.models : []);
                modSel.innerHTML = `<option value="__inherit__">${tr('Inherit main settings', '继承主设置')}</option>`
                    + models.map(m => `<option value="${m}">${escapeHtml(m)}</option>`).join('');
            };

            if (saved?.provider && saved.provider !== '__inherit__') {
                fillModels(saved.provider);
                if (saved.model && saved.model !== '__inherit__') {
                    modSel.value = saved.model;
                }
            }

            // Linked update model drop-down when supplier changes
            provSel.onchange = () => {
                if (provSel.value === '__inherit__') {
                    modSel.innerHTML = `<option value="__inherit__">${tr('Inherit main settings', '继承主设置')}</option>`;
                } else {
                    fillModels(provSel.value);
                }
            };
        });

        function updateTranslationModelSelect(pid: string, selectedModel: string, ollamaModels: any[]) {
            const inheritChat = !pid;
            const effectiveProvider = pid || current.provider;
            const providerDef = providers.find((p: any) => p.id === effectiveProvider);
            const models: string[] = inheritChat ? [] : effectiveProvider === 'ollama'
                ? (ollamaModels || []).map((m: any) => m.name)
                : (providerDef ? providerDef.models : []);
            const input = document.getElementById('translationPreviewModelInput') as HTMLInputElement | null;
            if (!input) return;
            input.disabled = inheritChat;
            input.value = inheritChat ? '' : (selectedModel || '');
            input.placeholder = inheritChat
                ? tr('Inherits the chat model', '继承对话模型')
                : tr('Leave empty to use provider default', '留空使用提供商默认模型');
            setupApDropdown('translationPreviewModelInput', 'translationPreviewModelDatalist', () => models);
        }

        function updateInlineProviderSelect() {
            const currentPid = inlineSel.value;
            // Only FIM-capable providers can be used for inline completion
            const filteredProviders = providers.filter((p: any) => p.supportsFIM);
            
            // Can we allow "Same as chat"? Only if the chat provider supports FIM.
            const chatProviderDef = providers.find((p: any) => p.id === current.provider);
            const chatSupportsFIM = chatProviderDef ? chatProviderDef.supportsFIM : false;
            
            let html = '';
            if (chatSupportsFIM) {
                html += `<option value="">${tr('- Same as chat -', '- 与对话相同 -')}</option>`;
            }
            html += filteredProviders.map((p: any) => '<option value="' + p.id + '"' + (p.id === currentPid ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
            
            inlineSel.innerHTML = html;

            // If the current selection is invalid (e.g., "Same as chat" but chat doesn't support FIM, or the provider was removed), auto-select a valid one.
            if ((currentPid === '' && !chatSupportsFIM) || (currentPid !== '' && !filteredProviders.find((p: any) => p.id === currentPid))) {
                inlineSel.value = filteredProviders.find((p: ProviderMeta) => p.authKind !== 'antigravity-oauth')?.id || '';
            }
        }

        function updateInlineModelSelect(pid: string, selectedModel: string, ollamaModels: any[]) {
            const p2 = providers.find((p: any) => p.id === (pid || current.provider));
            let ms: string[] = (pid || current.provider) === 'ollama' ? (ollamaModels || []).map((m: any) => m.name) : (p2 ? p2.inlineModels ?? p2.models : []);
            // Filter out thinking/reasoning models — they can't do inline completion
            ms = ms.filter((m: string) => !settingsThinkingPrefixes.some(prefix => m.toLowerCase().includes(prefix.toLowerCase())));

            // Always filter out non-FIM models since fallback Chat Mode is removed
            if (p2) {
                const fimRules = [
                    { key: 'deepseek-v4-pro', capable: true },
                    { key: 'deepseek-v4-flash', capable: true },
                    { key: 'deepseek-coder', capable: true },
                    { key: 'qwen2.5-coder', capable: true },
                    { key: 'codellama', capable: true },
                    { key: 'starcoder', capable: true },
                    { key: 'qwen', capable: false }, // Catch-all for non-coder qwen
                    { key: 'gpt-', capable: false },
                    { key: 'claude-', capable: false },
                    { key: 'gemini-', capable: false }
                ];
                ms = ms.filter((m: string) => {
                    if (!m) return p2.supportsFIM;
                    const lower = m.toLowerCase();
                    for (const rule of fimRules) {
                        if (lower.includes(rule.key)) return rule.capable;
                    }
                    return p2.supportsFIM;
                });
            }

            const inp = document.getElementById('inlineModelInput') as HTMLInputElement;
            inp.value = p2?.inlineModels ? (ms.includes(selectedModel) ? selectedModel : ms[0] || '') : selectedModel || '';

            setupApDropdown('inlineModelInput', 'inlineModelDatalist', () => ms);
        }
        const inlineProviderSel = document.getElementById('inlineProvider') as HTMLSelectElement;
        const translationPreviewProviderSel = document.getElementById('translationPreviewProvider') as HTMLSelectElement | null;

        updateTranslationModelSelect(translationProviderSel?.value || '', current.translationPreview?.model, ollamaModels);
        if (translationPreviewProviderSel) {
            translationPreviewProviderSel.onchange = () => updateTranslationModelSelect(translationPreviewProviderSel.value, '', ollamaModels);
        }
        updateInlineProviderSelect();
        updateInlineModelSelect(current.inlineCompletion?.provider, current.inlineCompletion?.model, ollamaModels);
        inlineProviderSel.onchange = () => updateInlineModelSelect(inlineProviderSel.value, '', ollamaModels);
        updateCustomApiFormatUI(current.provider);
        updateModelUI(current.provider, current.model, ollamaModels);
        updateApiKeyStatus(current.provider, providers);
        settingsPage.classList.add('active');
        if (shouldUseSideWorkspace()) {
            settingsInSideWorkspace = true;
            responsiveWorkspacePinnedClosed = !!activeResponsiveWorkspace;
            openSideWorkspace({
                title: chatI18n.locale === 'zh-cn' ? 'AI 设置' : 'AI Settings',
                subtitle: chatI18n.locale === 'zh-cn' ? '模型、上下文、API 和工具' : 'Models, context, API, and tools',
                content: settingsPage,
            });
        } else {
            settingsInSideWorkspace = false;
            closeSideWorkspace({ preserveResponsivePin: true });
            chatHeader.style.display = 'none';
            document.getElementById('chatArea')!.style.display = 'none';
            if (inputWrapper) inputWrapper.style.display = 'none';
            if (todoPanel) todoPanel.style.display = 'none';
        }
        const _tr = document.getElementById('testResult');
        if (_tr) { _tr.className = 'test-result'; _tr.textContent = ''; }
        refreshSettingsOverview();
        settingsSavePending = false;
        settingsFormBaseline = settingsFormSignature();
        refreshSettingsDraftStatus();
    }

    /** Look up per-model context size with fallback to provider level */
    function autoFillContextForModel(model: string, providerId: string, configuredTokens?: unknown) {
        const provider = settingsProviders.find(p => p.id === providerId);
        return resolveSettingsModelContextTokens(
            model,
            providerId,
            settingsModelContextTokens,
            provider?.maxContextTokens || 0,
            configuredTokens,
        );
    }

    function closeSettings() {
        if (settingsInSideWorkspace) {
            closeSideWorkspace({ preserveResponsivePin: true });
            responsiveWorkspacePinnedClosed = false;
            syncResponsiveWorkspaceLayout();
            return;
        }
        settingsPage.classList.remove('active');
        chatHeader.style.display = '';
        document.getElementById('chatArea')!.style.display = 'flex';
        if (inputWrapper) inputWrapper.style.display = '';
        if (todoPanel) todoPanel.style.display = '';
    }

    function updateSubscriptionProxyUrlVisibility(): void {
        const mode = document.getElementById('subscriptionProxyMode');
        const group = document.getElementById('subscriptionProxyUrlGroup');
        if (group) group.style.display = mode instanceof HTMLSelectElement && mode.value === 'custom' ? '' : 'none';
    }

    function setSubscriptionProxyBusy(busy: boolean): void {
        for (const id of ['subscriptionProxySaveBtn', 'subscriptionProxyRefreshBtn']) {
            const button = document.getElementById(id);
            if (button instanceof HTMLButtonElement) button.disabled = busy;
        }
        const status = document.getElementById('subscriptionProxyStatus');
        if (busy && status) status.textContent = tr('Updating proxy settings…', '正在更新代理设置…');
    }

    function renderSubscriptionProxyStatus(saved = false): void {
        const element = document.getElementById('subscriptionProxyStatus');
        if (!element) return;
        const status = settingsSubscriptionProxy;
        if (!status) {
            element.textContent = tr('Refresh detection to view the active proxy.', '刷新检测以查看当前代理。');
            return;
        }
        const sources = {
            vscode: 'VS Code http.proxy', environment: tr('environment', '环境变量'),
            system: tr('system', '系统'), custom: tr('custom', '自定义'),
        };
        const active = status.activeProxyUrl
            ? `${tr('Proxy', '代理')} (${status.source ? sources[status.source] : ''}): ${status.activeProxyUrl}`
            : status.mode === 'auto' ? tr('No proxy detected; using a direct connection.', '未检测到代理，将使用直连。')
                : tr('Direct connection.', '直连。');
        const stored = status.customProxyUrl ? tr(` Saved address: ${status.customProxyUrl}`, ` 已保存地址：${status.customProxyUrl}`) : '';
        element.textContent = status.error || (saved ? tr('Saved. ', '已保存。') : '') + active + stored;
        element.style.color = status.error ? 'var(--vscode-errorForeground)' : '';
    }

    function updateApiKeyStatus(providerId: string, providers?: any[]) {
        const p = (providers || settingsProviders).find((x: any) => x.id === providerId);
        const status = document.getElementById('apiKeyStatus')!;
        const group = document.getElementById('apiKeyGroup')!;
        const codexGroup = document.getElementById('codexAccountGroup') as HTMLElement | null;
        const codexSpeedGroup = document.getElementById('settingsCodexSpeedGroup') as HTMLElement | null;
        const responseVerbosityGroup = document.getElementById('settingsResponseVerbosityGroup') as HTMLElement | null;
        const endpointGroup = document.getElementById('endpointGroup') as HTMLElement | null;
        const providerHint = document.getElementById('providerHint')!;
        const deleteBtn = document.getElementById('deleteApiKeyBtn') as HTMLButtonElement | null;
        const isCodex = p?.authKind === 'chatgpt-oauth';
        const isAntigravity = p?.authKind === 'antigravity-oauth';
        const antigravityGroup = document.getElementById('antigravityAccountGroup');
        const proxyGroup = document.getElementById('subscriptionProxyGroup');
        if (proxyGroup) proxyGroup.style.display = isCodex || isAntigravity ? '' : 'none';
        if (antigravityGroup) antigravityGroup.style.display = isAntigravity ? '' : 'none';
        if (codexGroup) codexGroup.style.display = isCodex ? '' : 'none';
        if (codexSpeedGroup) codexSpeedGroup.style.display = isCodex ? '' : 'none';
        if (responseVerbosityGroup) responseVerbosityGroup.style.display = isCodex ? '' : 'none';
        if (endpointGroup) endpointGroup.style.display = isCodex || isAntigravity ? 'none' : '';
        if (isAntigravity) {
            group.style.display = 'none';
            providerHint.textContent = '';
            if (deleteBtn) deleteBtn.disabled = true;
            const accountStatus = document.getElementById('antigravityAccountStatus');
            if (accountStatus) accountStatus.innerHTML = buildAntigravityAccountHtml(settingsAntigravityAccount, chatI18n.locale === 'zh-cn');
            const loginBtn = document.getElementById('antigravityLoginBtn');
            const logoutBtn = document.getElementById('antigravityLogoutBtn');
            if (loginBtn) loginBtn.style.display = settingsAntigravityAccount?.signedIn ? 'none' : '';
            if (logoutBtn) logoutBtn.style.display = settingsAntigravityAccount?.hasCredentials ? '' : 'none';
            refreshSettingsOverview();
            return;
        }
        if (isCodex) {
            group.style.display = 'none';
            providerHint.innerHTML = '';
            if (deleteBtn) deleteBtn.disabled = true;
            const accountStatus = document.getElementById('codexAccountStatus');
            const quotaStatus = document.getElementById('codexQuotaStatus');
            const loginBtn = document.getElementById('codexLoginBtn') as HTMLButtonElement | null;
            const logoutBtn = document.getElementById('codexLogoutBtn') as HTMLButtonElement | null;
            const account = settingsCodexAccount;
            const hasCodexAccount = Boolean(account?.accountType);
            if (accountStatus) {
                if (account?.signedIn) {
                    const identity = [account.email, account.planType].filter(Boolean).join(' · ');
                    accountStatus.innerHTML = svgIcon('check') + escapeHtml(tr(`Signed in${identity ? ` · ${identity}` : ''}`, `已登录${identity ? ` · ${identity}` : ''}`));
                    accountStatus.style.color = '#4caf50';
                } else {
                    accountStatus.innerHTML = svgIcon('warning') + escapeHtml(account?.error || tr('Not signed in with ChatGPT', '尚未使用 ChatGPT 登录'));
                    accountStatus.style.color = '#ff9800';
                }
            }
            if (loginBtn) {
                loginBtn.disabled = account?.signedIn === true;
                loginBtn.style.display = account?.signedIn ? 'none' : '';
            }
            if (logoutBtn) {
                logoutBtn.disabled = !hasCodexAccount;
                logoutBtn.style.display = hasCodexAccount ? '' : 'none';
            }
            if (quotaStatus) {
                quotaStatus.innerHTML = buildCodexQuotaHtml(account?.rateLimits, {
                    used: tr('used', '已用'),
                    remaining: tr('remaining', '剩余'),
                    resets: tr('Resets', '重置'),
                    window: tr('Window', '窗口'),
                    weekly: tr('Weekly limit', '周额度'),
                    unknownReset: tr('unknown reset time', '重置时间未知'),
                    unavailable: tr('Quota details are unavailable for this account.', '当前账户暂未返回额度详情。'),
                }, chatI18n.locale === 'zh-cn' ? 'zh-CN' : 'en');
            }
            refreshSettingsOverview();
            return;
        }
        if (p && p.requiresApiKey === false) {
            group.style.display = 'none';
            providerHint.innerHTML = '';
            if (deleteBtn) deleteBtn.disabled = true;
            refreshSettingsOverview();
            return;
        }
        group.style.display = '';
        
        if (p && p.hasKey) { status.innerHTML = svgIcon('check') + tr('API key configured', '已配置 API Key'); status.style.color = '#4caf50'; }
        else { status.innerHTML = svgIcon('warning') + tr('API key not configured', '尚未配置 API Key'); status.style.color = '#ff9800'; }
        if (deleteBtn) deleteBtn.disabled = !(p && p.hasKey);
        
        if (p && p.registerUrl) {
            providerHint.innerHTML = `<a href="${p.registerUrl}" style="color:var(--vscode-textLink-foreground);">${tr('Get an API key', '申请 API Key 地址')}</a>`;
        } else {
            providerHint.innerHTML = '';
        }
        refreshSettingsOverview();
    }

    function getCustomApiFormat() {
        return (document.getElementById('customApiFormat') as HTMLSelectElement | null)?.value || 'openai-chat-completions';
    }

    function updateCustomApiFormatUI(providerId?: string) {
        const id = providerId || (document.getElementById('settingsProvider') as HTMLSelectElement | null)?.value || '';
        const group = document.getElementById('customApiFormatGroup') as HTMLElement | null;
        const hint = document.getElementById('customApiFormatHint') as HTMLElement | null;
        const format = getCustomApiFormat();
        if (group) group.style.display = id === 'custom' ? '' : 'none';
        if (!hint) return;
        const hints: Record<string, string> = {
            'openai-chat-completions': 'POST {endpoint}/chat/completions, Authorization: Bearer <key>',
            'openai-responses': 'POST {endpoint}/responses, Authorization: Bearer <key>',
            'anthropic-messages': 'POST {endpoint}/messages, x-api-key or Authorization: Bearer <key>',
            'gemini-generate-content': 'POST {endpoint}/models/{model}:generateContent?key=<key>',
        };
        hint.textContent = hints[format] ?? hints['openai-chat-completions'] ?? '';
        updateEndpointHint(id);
        refreshSettingsOverview();
    }

    function onProviderChange() {
        const id = (document.getElementById('settingsProvider') as HTMLSelectElement).value;
        // Swap the endpoint field to the newly-selected provider's saved value so
        // one provider's endpoint never carries over into another.
        const epField = document.getElementById('settingsEndpoint') as HTMLInputElement | null;
        if (epField) epField.value = settingsProviderEndpoints[id] || '';
        updateCustomApiFormatUI(id);
        updateModelUI(id, '', settingsOllamaModels);
        updateEndpointHint(id);
        updateApiKeyStatus(id, settingsProviders);
        const provider = settingsProviders.find(p => p.id === id);
        const inlineSel = document.getElementById('inlineProvider') as HTMLSelectElement | null;
        if (inlineSel) {
            const selected = inlineSel.value;
            const fimProviders = settingsProviders.filter((candidate: any) => candidate.supportsFIM);
            const chatSupportsFim = provider?.supportsFIM === true;
            inlineSel.innerHTML = (chatSupportsFim ? `<option value="">${tr('- Same as chat -', '- 与对话相同 -')}</option>` : '')
                + fimProviders.map((candidate: any) => `<option value="${candidate.id}">${escapeHtml(candidate.name)}</option>`).join('');
            inlineSel.value = (selected && fimProviders.some((candidate: any) => candidate.id === selected))
                ? selected
                : (chatSupportsFim ? '' : (fimProviders.find((candidate: ProviderMeta) => candidate.authKind !== 'antigravity-oauth')?.id || ''));
            inlineSel.dispatchEvent(new Event('change'));
        }
        const translationSel = document.getElementById('translationPreviewProvider') as HTMLSelectElement | null;
        if (translationSel) {
            const selected = translationSel.value;
            const utilityProviders = settingsProviders.filter((candidate: any) => candidate.supportsUtilityCalls !== false);
            const chatSupportsUtility = provider?.supportsUtilityCalls !== false;
            translationSel.innerHTML = (chatSupportsUtility ? `<option value="">${tr('- Same as chat -', '- 与对话相同 -')}</option>` : '')
                + utilityProviders.map((candidate: any) => `<option value="${candidate.id}">${escapeHtml(candidate.name)}</option>`).join('');
            translationSel.value = (selected && utilityProviders.some((candidate: any) => candidate.id === selected))
                ? selected
                : (chatSupportsUtility ? '' : (utilityProviders[0]?.id || ''));
            translationSel.dispatchEvent(new Event('change'));
        }
        refreshSettingsOverview();
    }

    function updateModelUI(providerId: string, currentModel: string, ollamaModels: any[] | null) {
        clearTimeout(settingsModelInputTimer);
        const provider = settingsProviders.find((p: any) => p.id === providerId);
        const modelInput = document.getElementById('settingsModelInput') as HTMLInputElement;
        const detectBtn = document.getElementById('detectBtn') as HTMLButtonElement;
        const modelHint = document.getElementById('modelHint')!;

        let contextModel = currentModel;
        /** Auto-fill only for a changed model; refreshes retain manual context limits. */
        function onModelSelected(model: string) {
            clearTimeout(settingsModelInputTimer);
            if (model !== contextModel) {
                (document.getElementById('settingsCtx') as HTMLInputElement).value = String(autoFillContextForModel(model, providerId));
                contextModel = model;
            }
            const reasoningSelect = document.getElementById('settingsReasoningEffort') as HTMLSelectElement | null;
            updateSettingsReasoningControls(
                providerId,
                model,
                reasoningSelect?.dataset.requested || reasoningSelect?.value
            );
            refreshSettingsOverview();
            refreshSettingsDraftStatus();
        }

        let currentDropdownOpts: string[] = [];

        if (providerId === 'ollama') {
            document.getElementById('apiKeyGroup')!.style.display = 'none';
            if (ollamaModels && ollamaModels.length > 0) {
                currentDropdownOpts = ollamaModels.map((m: any) => m.name);
                modelHint.textContent = tr(`Detected ${ollamaModels.length} local model(s)`, `已检测到 ${ollamaModels.length} 个本地模型`);
            } else { currentDropdownOpts = []; modelHint.textContent = tr('Click "Detect" to get Ollama models', '点击「检测」获取 Ollama 模型'); }
            detectBtn.style.display = '';
        } else if (provider && provider.models.length > 0) {
            currentDropdownOpts = provider.models;
            modelHint.textContent = tr('Choose from the dropdown or enter a custom model name', '可选择下拉项，或直接输入自定义模型名');
            detectBtn.style.display = 'none';
        } else if (providerId === 'custom') {
            currentDropdownOpts = [];
            modelHint.textContent = tr('Enter a model supported by the custom endpoint, or fetch models with an API key and endpoint', '输入自定义渠道支持的模型名，或用 API Key 和 Endpoint 拉取模型');
            detectBtn.style.display = 'none';
        } else { currentDropdownOpts = []; modelHint.textContent = ''; detectBtn.style.display = 'none'; }

        // Setup dropdown logic
        setupApDropdown('settingsModelInput', 'settingsModelDatalist', () => currentDropdownOpts, onModelSelected);

        // Restore value
        modelInput.value = currentModel || provider?.defaultModel || currentDropdownOpts[0] || '';

        // Bind auto-fill to model input changes
        modelInput.oninput = () => {
            clearTimeout(settingsModelInputTimer);
            settingsModelInputTimer = setTimeout(() => onModelSelected(modelInput.value.trim()), 400);
            const evt = new Event('input_ap');
            modelInput.dispatchEvent(evt); // trigger dropdown render
        };
        modelInput.onchange = () => onModelSelected(modelInput.value.trim());
        // Auto-fill immediately for current selection
        if (modelInput.value) onModelSelected(modelInput.value);

        updateEndpointHint(providerId);
        refreshSettingsOverview();
    }

    function updateEndpointHint(providerId: string) {
        const provider = settingsProviders.find(p => p.id === providerId);
        const hint = document.getElementById('endpointHint');
        const ep = document.getElementById('settingsEndpoint') as HTMLInputElement | null;
        if (providerId === 'custom' && hint && ep) {
            const format = getCustomApiFormat();
            const examples: Record<string, string> = {
                'openai-chat-completions': 'https://example.com/v1',
                'openai-responses': 'https://api.openai.com/v1',
                'anthropic-messages': 'https://api.anthropic.com/v1',
                'gemini-generate-content': 'https://generativelanguage.googleapis.com/v1beta',
            };
            hint.textContent = 'Custom format endpoint example: ' + (examples[format] || examples['openai-chat-completions']);
            if (!ep.value) ep.placeholder = examples[format] ?? examples['openai-chat-completions'] ?? '';
            return;
        }
        if (provider && hint && ep) {
            hint.textContent = tr('Default: ', '默认: ') + (provider.defaultEndpoint || tr('decided by provider', '由 provider 决定'));
            if (!ep.value) ep.placeholder = provider.defaultEndpoint || tr('Leave empty to use default', '留空使用默认');
        }
    }

    function onEndpointChange() {
        const providerId = (document.getElementById('settingsProvider') as HTMLSelectElement).value;
        // Track the live value per provider so switching away and back preserves it.
        const epField = document.getElementById('settingsEndpoint') as HTMLInputElement | null;
        if (providerId && epField) settingsProviderEndpoints[providerId] = epField.value;
        if (providerId === 'ollama') {
            settingsOllamaModels = [];
            document.getElementById('settingsModelInput')!.style.display = '';
            document.getElementById('modelHint')!.textContent = tr('Endpoint changed. Click "Detect" to fetch models again.', '端点已更改，点击「检测」重新获取模型');
        }
    }

    function detectOllamaModels() {
        const btn = document.getElementById('detectBtn') as HTMLButtonElement; const ep = (document.getElementById('settingsEndpoint') as HTMLInputElement).value.trim();
        btn.disabled = true; btn.textContent = tr('Detecting...', '检测中...');
        document.getElementById('modelHint')!.textContent = tr('Connecting to Ollama...', '正在连接 Ollama...');
        vscode.postMessage({ type: 'detectOllamaModels', endpoint: ep || 'http://localhost:11434/v1' });
    }

    document.getElementById('delModelBtn')!.addEventListener('click', () => {
        const providerId = (document.getElementById('settingsProvider') as HTMLSelectElement).value;
        const modelId = (document.getElementById('settingsModelInput') as HTMLInputElement).value.trim();
        if (providerId && modelId) {
            vscode.postMessage({ type: 'deleteDynamicModel', providerId, modelId });
        }
    });

    /** Convert env Record to KEY=VALUE text for textarea display */
    function envToText(env?: Record<string, string>): string {
        if (!env || typeof env !== 'object') return '';
        return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
    }

    /** Parse KEY=VALUE text back to Record */
    function parseEnvText(text: string): Record<string, string> | undefined {
        if (!text.trim()) return undefined;
        const env: Record<string, string> = {};
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
            }
        }
        return Object.keys(env).length > 0 ? env : undefined;
    }

    function addMcpServerBlock(server: any = {}) {
        const list = document.getElementById('mcpServersList');
        if (!list) return;
        const div = document.createElement('div');
        div.className = 'mcp-server-block';

        const t = server;
        const serverEnv: Record<string, string> | undefined = server.env;

        div.innerHTML = `
            <div class="mcp-row">
                <input class="settings-input mcp-name" type="text" placeholder="${tr('Server name', 'Server 名称')}" value="${escapeHtml(server.name || '')}" style="flex:1" />
                <select class="settings-select mcp-type" style="width:90px">
                    <option value="stdio" ${(t.type || 'stdio') === 'stdio' ? 'selected' : ''}>stdio</option>
                    <option value="sse" ${t.type === 'sse' ? 'selected' : ''}>sse</option>
                </select>
                <select class="settings-select mcp-domain" title="${tr('Capability domain', '能力领域')}" style="width:105px">
                    <option value="paradox" ${(server.capabilityDomain || 'paradox') === 'paradox' ? 'selected' : ''}>Paradox</option>
                    <option value="general" ${server.capabilityDomain === 'general' ? 'selected' : ''}>General</option>
                    <option value="both" ${server.capabilityDomain === 'both' ? 'selected' : ''}>${tr('Both', '两者')}</option>
                </select>
                <button class="mcp-delete-btn" title="${tr('Delete', '删除')}">${svgIconNoMargin('trash')}</button>
            </div>
            <div class="mcp-transport-content"></div>
        `;
        list.appendChild(div);

        const typeSel = div.querySelector('.mcp-type') as HTMLSelectElement;
        const contentDiv = div.querySelector('.mcp-transport-content') as HTMLDivElement;

        function renderTransport() {
            if (typeSel.value === 'stdio') {
                contentDiv.innerHTML = `
                    <input class="settings-input mcp-command" type="text" placeholder="${tr('Command (for example: uvx, npx)', 'Command (例如: uvx, npx)')}" value="${(t.type || 'stdio') === 'stdio' ? escapeHtml(t.command || '') : ''}" />
                    <input class="settings-input mcp-args" type="text" placeholder="${tr('Args (space-separated)', 'Args (空格分隔)')}" value="${(t.type || 'stdio') === 'stdio' && t.args ? escapeHtml(t.args.join(' ')) : ''}" style="margin-top:4px" />
                    <textarea class="settings-input mcp-env" rows="3" placeholder="${tr('Environment variables (KEY=VALUE per line, # starts a comment)', '环境变量 (每行 KEY=VALUE，# 开头为注释)')}" style="margin-top:4px; font-family:monospace; font-size:11px; resize:vertical">${escapeHtml(envToText(serverEnv))}</textarea>
                `;
            } else {
                contentDiv.innerHTML = `
                    <input class="settings-input mcp-url" type="text" placeholder="${tr('SSE URL (for example: http://localhost:3000/sse)', 'SSE URL (例如: http://localhost:3000/sse)')}" value="${t.type === 'sse' ? escapeHtml(t.url || '') : ''}" />
                `;
            }
        }

        renderTransport();
        typeSel.addEventListener('change', renderTransport);

        div.querySelector('.mcp-delete-btn')!.addEventListener('click', () => {
            div.remove();
            refreshSettingsOverview();
            refreshSettingsDraftStatus();
        });
        refreshSettingsOverview();
        refreshSettingsDraftStatus();
    }

    function deleteApiKey() {
        const providerId = (document.getElementById('settingsProvider') as HTMLSelectElement).value;
        if (!providerId) return;

        const keyInput = document.getElementById('settingsApiKey') as HTMLInputElement | null;
        if (keyInput) keyInput.value = '';
        const status = document.getElementById('apiKeyStatus');
        if (status) {
            status.textContent = tr('Removing API key...', '正在移除 API Key...');
            status.style.color = 'inherit';
        }
        vscode.postMessage({ type: 'deleteApiKey', providerId });
    }

    function fetchApiModels() {
        const btn = document.getElementById('fetchApiModelsBtn') as HTMLButtonElement;
        btn.disabled = true; btn.textContent = tr('Fetching...', '拉取中...');
        document.getElementById('apiKeyStatus')!.textContent = tr('Sending network request to fetch supported models...', '正在发起网络请求拉取支持模型...');
        document.getElementById('apiKeyStatus')!.style.color = 'inherit';
        vscode.postMessage({
            type: 'fetchApiModels',
            providerId: (document.getElementById('settingsProvider') as HTMLSelectElement).value,
            endpoint: (document.getElementById('settingsEndpoint') as HTMLInputElement).value.trim(),
            apiKey: (document.getElementById('settingsApiKey') as HTMLInputElement).value,
            customApiFormat: getCustomApiFormat()
        });
    }

    function getSelectedModel() {
        return (document.getElementById('settingsModelInput') as HTMLInputElement).value.trim();
    }

    function parseInlineNumber(id: string, fallback: number): number {
        const el = document.getElementById(id) as HTMLInputElement | null;
        const parsed = parseInt(el?.value || '', 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function toggleAccordion(id: string) {
        const section = document.getElementById(id);
        if (!section) return;
        const expanded = section.classList.toggle('open');
        section.querySelector('.accordion-header')?.setAttribute('aria-expanded', String(expanded));
    }

    function saveSettings() {
        clearTimeout(settingsModelInputTimer);
        settingsSavePending = true;
        lastSettingsPageSignature = '';
        refreshSettingsDraftStatus();

        // Build flat MCPServerConfig objects (matching backend types.ts interface)
        const mcpServers = Array.from(document.querySelectorAll('.mcp-server-block')).map(block => {
            const type = (block.querySelector('.mcp-type') as HTMLSelectElement).value;
            const name = (block.querySelector('.mcp-name') as HTMLInputElement).value.trim();
            const capabilityDomain = (block.querySelector('.mcp-domain') as HTMLSelectElement | null)?.value || 'paradox';
            if (type === 'stdio') {
                const command = (block.querySelector('.mcp-command') as HTMLInputElement | null)?.value.trim() || '';
                const argsStr = (block.querySelector('.mcp-args') as HTMLInputElement | null)?.value.trim() || '';
                const args = argsStr ? argsStr.split(/\s+/) : [];
                const envText = (block.querySelector('.mcp-env') as HTMLTextAreaElement | null)?.value || '';
                const env = parseEnvText(envText);
                return { name, type, capabilityDomain, command, args, ...(env ? { env } : {}) };
            } else {
                const url = (block.querySelector('.mcp-url') as HTMLInputElement | null)?.value.trim() || '';
                return { name, type, capabilityDomain, url };
            }
        });

        vscode.postMessage({
            type: 'saveSettings', settings: {
                provider: (document.getElementById('settingsProvider') as HTMLSelectElement).value,
                model: getSelectedModel(),
                apiKey: (document.getElementById('settingsApiKey') as HTMLInputElement).value,
                endpoint: (document.getElementById('settingsEndpoint') as HTMLInputElement).value.trim(),
                customApiFormat: getCustomApiFormat(),
                maxContextTokens: parseInt((document.getElementById('settingsCtx') as HTMLInputElement).value) || 0,
                agentFileWriteMode: (document.getElementById('agentWriteMode') as HTMLSelectElement).value,
                approvals: {
                    reviewer: ((document.getElementById('approvalsAutoReview') as HTMLInputElement | null)?.checked ? 'auto_review' : 'user'),
                },
                reasoningEffort: (document.getElementById('settingsReasoningEffort') as HTMLSelectElement).value || 'high',
                responseVerbosity: (document.getElementById('settingsResponseVerbosity') as HTMLSelectElement | null)?.value || 'default',
                codexServiceTier: (document.getElementById('settingsCodexServiceTier') as HTMLSelectElement | null)?.value || 'default',
                reasoningKey: ((document.getElementById('settingsReasoningKey') as HTMLInputElement | null)?.value || '').trim(),
                webAccess: {
                    mode: ((document.getElementById('webAccessMode') as HTMLSelectElement | null)?.value || 'indexed'),
                    provider: ((document.getElementById('webSearchProvider') as HTMLSelectElement | null)?.value || 'auto'),
                    contextSize: ((document.getElementById('webContextSize') as HTMLSelectElement | null)?.value || 'medium'),
                    fallbackProviders: ((document.getElementById('webFallbackProviders') as HTMLInputElement | null)?.value || '').trim(),
                    allowedDomains: ((document.getElementById('webAllowedDomains') as HTMLInputElement | null)?.value || '').trim(),
                    blockedDomains: ((document.getElementById('webBlockedDomains') as HTMLInputElement | null)?.value || '').trim(),
                    country: ((document.getElementById('webCountry') as HTMLInputElement | null)?.value || '').trim(),
                    searxngEndpoint: ((document.getElementById('webSearxngEndpoint') as HTMLInputElement | null)?.value || '').trim(),
                    openaiModel: ((document.getElementById('webOpenAIModel') as HTMLInputElement | null)?.value || '').trim(),
                    cacheTtlMs: parseInt((document.getElementById('webCacheTtlMs') as HTMLInputElement | null)?.value || '300000') || 0,
                    allowSyntheticProxyAddresses: (document.getElementById('webAllowSyntheticProxy') as HTMLInputElement | null)?.checked === true,
                    keys: Object.fromEntries(['brave', 'exa', 'tavily', 'serper', 'serpapi'].map(provider => {
                        const element = document.getElementById(`webKey-${provider}`) as HTMLInputElement | null;
                        const value = (element?.value || '').trim();
                        return [provider, !value && element?.dataset.hadSecret === 'true' ? '__DELETE__' : value];
                    })),
                },
                inlineCompletion: {
                    enabled: (document.getElementById('inlineEnabled') as HTMLInputElement).checked,
                    provider: (document.getElementById('inlineProvider') as HTMLSelectElement).value,
                    model: (document.getElementById('inlineModelInput') as HTMLInputElement).value.trim(),
                    endpoint: (document.getElementById('inlineEndpoint') as HTMLInputElement).value.trim(),
                    debounceMs: parseInlineNumber('inlineDebounce', 200),
                    maxTokens: parseInlineNumber('inlineMaxTokens', 128),
                    contextBeforeLines: parseInlineNumber('inlineContextBefore', 20),
                    contextAfterLines: parseInlineNumber('inlineContextAfter', 10),
                    includeMcpContext: (document.getElementById('inlineIncludeMcp') as HTMLInputElement | null)?.checked ?? false,
                    mcpCacheTtlMs: parseInlineNumber('inlineMcpCacheTtl', 30000),
                    requestTimeoutMs: parseInlineNumber('inlineRequestTimeout', 6000),
                    lspFastPath: (document.getElementById('inlineLspFastPath') as HTMLInputElement | null)?.checked ?? true,
                    overlapStripping: (document.getElementById('inlineOverlapStripping') as HTMLInputElement | null)?.checked ?? true,
                },
                translationPreview: {
                    provider: ((document.getElementById('translationPreviewProvider') as HTMLSelectElement | null)?.value || '').trim(),
                    model: (((document.getElementById('translationPreviewProvider') as HTMLSelectElement | null)?.value || '').trim()
                        ? ((document.getElementById('translationPreviewModelInput') as HTMLInputElement | null)?.value || '').trim()
                        : ''),
                },
                mcp: { servers: mcpServers },
                orchestrator: {
                    agentModels: (() => {
                        const models: Record<string, { provider: string; model: string }> = {};
                        document.querySelectorAll('.agent-model-row').forEach(row => {
                            const role = (row as HTMLElement).dataset.role;
                            if (!role) return;
                            const prov = (row.querySelector('.agent-model-provider') as HTMLSelectElement)?.value || '__inherit__';
                            const mod = (row.querySelector('.agent-model-model') as HTMLSelectElement)?.value || '__inherit__';
                            //Only collect non-inherited configurations
                            if (prov !== '__inherit__' || mod !== '__inherit__') {
                                models[role] = { provider: prov, model: mod };
                            }
                        });
                        return Object.keys(models).length > 0 ? models : undefined;
                    })(),
                },
            }
        });
    }

    function testConnection() {
        const resultEl = document.getElementById('testResult');
        if (resultEl) { resultEl.className = 'test-result'; resultEl.textContent = tr('Testing...', '测试中...'); resultEl.style.display = 'block'; }
        vscode.postMessage({
            type: 'testConnection', settings: {
                provider: (document.getElementById('settingsProvider') as HTMLSelectElement).value,
                model: getSelectedModel(),
                apiKey: (document.getElementById('settingsApiKey') as HTMLInputElement).value,
                endpoint: (document.getElementById('settingsEndpoint') as HTMLInputElement).value.trim(),
                customApiFormat: getCustomApiFormat()
            }
        });
    }

    // Send ready only after all message handlers are registered.
    (window as any).__cwtoolsPostReady = () => vscode.postMessage({ type: 'ready' });
    if (!isManagerShell()) {
        (window as any).__cwtoolsPostReady();
    }
})();
