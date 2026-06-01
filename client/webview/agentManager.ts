import './chatPanel';
import { escapeHtml } from './chat/formatters';
import { renderInspectorHTML } from './chat/runInspector';
import { groupTimelineEvents, renderTimelineHTML } from './chat/runTimeline';
import { getChatI18n, normalizeChatLocale } from './chat/i18n';
import { getDiffArtifactFiles } from './chat/artifacts';
import { svgIcon, svgIconNoMargin } from './svgIcons';
import type { ManagerSnapshotMessage, OrchestratorProgressMessage } from './chat/messages.manager';
import type { TopicListItem, TopicStats } from './chat/messages.shared';

type ManagerTab = 'agents' | 'runs' | 'artifacts' | 'tasks' | 'workspace' | 'settings';

type ManagerEnhancementState = {
    topics: TopicListItem[];
    stats: TopicStats;
    artifacts: ManagerSnapshotMessage['artifacts'];
    todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>;
    mode: string;
    workflowId: string | null;
    isGenerating: boolean;
    liveStepCount: number;
    messageCount: number;
    orchestrator: OrchestratorProgressMessage['progress'] | null;
    run: any | null;
    runEvents: any[];
    selectedRunEventId?: string;
    /** 当前展开的事件 inspector 面板是否可见（侧滑栏） */
    inspectorPanelOpen: boolean;
    compactedMemoryContent?: string;
    cleanupResult?: { deletedCount: number; keptCount: number; reclaimedBytes: number };
    copiedEventAt?: number;
    workspaceContent?: HTMLElement | null;
    workspaceEntries?: Array<{ content: HTMLElement; title?: string; subtitle?: string; kind?: string; wide?: boolean }>;
    workspaceTitle?: string;
    workspaceSubtitle?: string;
    settingsContent?: HTMLElement | null;
    settingsTitle?: string;
    settingsSubtitle?: string;
    usageStats?: any;
    /** T3.3 — Cache hit / saving badge on the run overview row. */
    cacheStats?: {
        totalCachedTokens: number;
        totalInputTokens: number;
        totalSavedCostCny: number;
        aggregateHitRate: number;
        byAgent: Array<{ agentId: string; cachedTokens: number; inputTokens: number; hitRate: number; callCount: number }>;
    };
};

const DEFAULT_STATE: ManagerEnhancementState = {
    topics: [],
    stats: { total: 0, visible: 0, archived: 0, currentTopicId: null, currentTopicTitle: null },
    artifacts: [],
    todos: [],
    mode: 'build',
    workflowId: null,
    isGenerating: false,
    liveStepCount: 0,
    messageCount: 0,
    orchestrator: null,
    run: null,
    runEvents: [],
    selectedRunEventId: undefined,
    inspectorPanelOpen: false,
    compactedMemoryContent: undefined,
    cleanupResult: undefined,
    copiedEventAt: undefined,
};

(function bootAgentManagerEnhancements() {
    if (!document.body.classList.contains('agent-manager-shell')) return;

    const topicsSummary = document.getElementById('topicsPanelSummary');
    const artifactDrawer = document.getElementById('artifactDrawer');
    const artifactList = document.getElementById('artifactList');
    if (!topicsSummary || !artifactDrawer || !artifactList) return;
    const artifactDrawerEl = artifactDrawer;
    const artifactListEl = artifactList;

    if ((window.innerWidth || document.documentElement.clientWidth) > 1280) {
        document.body.classList.add('artifact-drawer-open');
    }

    const state: ManagerEnhancementState = { ...DEFAULT_STATE };
    let activeTab: ManagerTab = 'runs';
    let settingsRequestPending = false;
    let topicTitleEditing = false;
    const collapsedTimelineGroups = new Set<string>();
    const collapsedWorkspaceFiles = new Set<string>();
    const vscode = (window as any).__cwtoolsVscode;

    // 从 HTML body 的 data-locale 属性读取 locale（由 agentManagerHtml.ts 注入）
    const locale = normalizeChatLocale((document.body as HTMLElement).dataset.locale);
    const i18n = getChatI18n(locale);
    const m = i18n.manager;
    const RUN_MAX_RENDERED_EVENTS = 300;
    const ui = locale === 'zh-cn'
        ? {
            topicsTitle: 'Agent 话题',
            tabs: { runs: '运行', artifacts: '产物', tasks: '任务', workspace: '工作区', settings: '设置' },
            actions: { workbench: '工作台', closeWorkbench: '关闭工作台', settings: '设置', showTopics: '显示话题', toggleTopics: '折叠话题栏', newTopic: '新话题', archived: '已归档', exportTopic: '导出', searchTopics: '搜索话题...', renameTopic: '重命名话题' },
            workflow: { build: '构建工作流', plan: '计划工作流', review: '审查工作流', explore: '探索工作流', orchestrator: '多 Agent 工作流' },
            status: { paused: '已暂停', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', idle: '空闲' },
            metrics: { tokens: 'Token', cache: '缓存', filesChanged: '个文件变更', cost: '费用', in: '输入', out: '输出', cached: '缓存', calls: '调用', totalUsage: '总计消耗', estimatedCost: '预估成本', cacheHit: '缓存命中', providers: '按供应商', models: '模型分布' },
            run: {
                started: '开始于',
                runPrefix: '运行',
                activeRun: '当前运行',
                contextTokens: '上下文 Token',
                contextUsage: '上下文用量',
                prompt: '提示词',
                output: '输出',
                artifacts: '产物',
                filesChanged: '文件变更',
                currentTopic: '当前话题',
                noActiveTopic: '暂无当前话题',
                messages: '条消息',
                eventTimeline: '事件时间线',
                selectedEvent: '选中事件',
                noArtifacts: '暂无产物',
                noFileChanges: '暂无文件变更',
                changed: '已变更',
            },
            workspace: {
                title: '工作区',
                subtitle: '查看批注、文件差异、变更产物和本轮改动文件。',
                changedFiles: '改动文件',
                noFiles: '暂无改动文件',
                diffSummary: 'Diff 摘要',
                artifactStatus: '产物',
                noWorkspace: '暂无工作区内容',
                noWorkspaceHint: '批注、计划确认和文件差异会在这里集中显示。',
                fileChanges: '文件变更',
                openWorkspaceHint: '工作区内容会跟随批注和文件变更自动更新。',
            },
            settings: {
                title: '设置',
                subtitle: '模型、上下文、API 和工具',
                loading: '正在加载设置...',
            },
            titleEditPlaceholder: '输入话题名称',
        }
        : {
            topicsTitle: 'Agent Topics',
            tabs: { runs: 'Runs', artifacts: 'Artifacts', tasks: 'Tasks', workspace: 'Workspace', settings: 'Settings' },
            actions: { workbench: 'Workbench', closeWorkbench: 'Close Workbench', settings: 'Settings', showTopics: 'Show topics', toggleTopics: 'Toggle topics', newTopic: 'New topic', archived: 'Archived', exportTopic: 'Export', searchTopics: 'Search topics...', renameTopic: 'Rename topic' },
            workflow: { build: 'Build Workflow', plan: 'Plan Workflow', review: 'Review Workflow', explore: 'Explore Workflow', orchestrator: 'Multi-Agent Workflow' },
            status: { paused: 'Paused', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', idle: 'Idle' },
            metrics: { tokens: 'Tokens', cache: 'Cache', filesChanged: 'files changed', cost: 'Cost', in: 'in', out: 'out', cached: 'cached', calls: 'calls', totalUsage: 'Total Usage', estimatedCost: 'Estimated Cost', cacheHit: 'Cache Hit', providers: 'By Provider', models: 'Models' },
            run: {
                started: 'Started',
                runPrefix: 'Run',
                activeRun: 'Active Run',
                contextTokens: 'Context Tokens',
                contextUsage: 'Context Usage',
                prompt: 'Prompt',
                output: 'Output',
                artifacts: 'Artifacts',
                filesChanged: 'Files Changed',
                currentTopic: 'Current Topic',
                noActiveTopic: 'No active topic',
                messages: 'messages',
                eventTimeline: 'Event Timeline',
                selectedEvent: 'Selected Event',
                noArtifacts: 'No artifacts yet',
                noFileChanges: 'No file changes yet',
                changed: 'changed',
            },
            workspace: {
                title: 'Workspace',
                subtitle: 'Review annotations, file diffs, change artifacts, and files touched by this run.',
                changedFiles: 'Changed Files',
                noFiles: 'No changed files yet',
                diffSummary: 'Diff Summary',
                artifactStatus: 'Artifact',
                noWorkspace: 'No workspace content yet',
                noWorkspaceHint: 'Annotations, plan approvals, and file diffs will appear here.',
                fileChanges: 'File Changes',
                openWorkspaceHint: 'Workspace content follows annotations and file changes automatically.',
            },
            settings: {
                title: 'Settings',
                subtitle: 'Models, context, API, and tools',
                loading: 'Loading settings...',
            },
            titleEditPlaceholder: 'Topic title',
        };

    function isNoisyRunEvent(evt: any): boolean {
        if (evt?.type === 'model_call_delta') return true;
        return evt?.type === 'step_appended';
    }

    function getRenderableRunEvents(events: any[]): any[] {
        const filtered = events.filter(evt => !isNoisyRunEvent(evt));
        return filtered.length > RUN_MAX_RENDERED_EVENTS
            ? filtered.slice(filtered.length - RUN_MAX_RENDERED_EVENTS)
            : filtered;
    }

    function collectChangedFiles(run: any, events: any[] = state.runEvents): string[] {
        const files = new Set<string>();
        const add = (value: unknown): void => {
            if (typeof value === 'string' && value.trim()) files.add(value.trim());
        };
        const addMany = (value: unknown): void => {
            if (Array.isArray(value)) value.forEach(add);
        };
        addMany(run?.writtenFiles);
        for (const evt of Array.isArray(events) ? events : []) {
            const payload = evt?.payload || {};
            add(payload.path);
            add(payload.filePath);
            add(payload.targetPath);
            add(payload.relativePath);
            addMany(payload.files);
            addMany(payload.paths);
            addMany(payload.filesWritten);
            addMany(payload.writtenFiles);
            add(payload.diff?.path);
            add(payload.change?.path);
        }
        return [...files];
    }

    function getDiffArtifacts(): ManagerSnapshotMessage['artifacts'] {
        return state.artifacts.filter((artifact: any) => {
            const haystack = `${artifact.kind || ''} ${artifact.title || ''} ${artifact.summary || ''}`.toLowerCase();
            return haystack.includes('diff') || haystack.includes('change') || haystack.includes('patch') || haystack.includes('变更') || haystack.includes('差异');
        });
    }

    type WorkspaceFileRecord = {
        file: string;
        status?: string;
        additions?: number;
        deletions?: number;
        diffPreview?: string;
        diffLines?: any[];
    };

    function fileBasename(file: string): string {
        return (file || '').replace(/\\/g, '/').split('/').pop() || file;
    }

    function collectWorkspaceFiles(run: any, events: any[] = state.runEvents): WorkspaceFileRecord[] {
        const byPath = new Map<string, WorkspaceFileRecord>();
        const addRecord = (record: WorkspaceFileRecord): void => {
            if (!record.file) return;
            const key = record.file.replace(/\\/g, '/').toLowerCase();
            const existing = byPath.get(key);
            byPath.set(key, {
                ...existing,
                ...record,
                additions: record.additions ?? existing?.additions,
                deletions: record.deletions ?? existing?.deletions,
                diffLines: record.diffLines ?? existing?.diffLines,
            });
        };

        for (const artifact of getDiffArtifacts() as any[]) {
            for (const file of getDiffArtifactFiles(artifact as any) as WorkspaceFileRecord[]) {
                addRecord(file);
            }
        }
        for (const file of collectChangedFiles(run, events)) {
            addRecord({ file });
        }
        return [...byPath.values()];
    }

    function formatFileStats(file: WorkspaceFileRecord): string {
        const parts: string[] = [];
        if (file.status) parts.push(file.status);
        if (file.additions !== undefined || file.deletions !== undefined) {
            parts.push(`+${file.additions ?? 0} -${file.deletions ?? 0}`);
        } else if (file.diffPreview) {
            parts.push(file.diffPreview);
        } else {
            parts.push(ui.run.changed);
        }
        return parts.join(' | ');
    }

    function renderWorkspaceDiffLines(file: WorkspaceFileRecord): string {
        const lines = Array.isArray(file.diffLines) ? file.diffLines : [];
        if (!lines.length) return '';
        const rows = lines.slice(0, 160).map(line => {
            const type = line.type === 'add' ? 'add' : line.type === 'remove' ? 'remove' : 'ctx';
            const prefix = type === 'add' ? '+' : type === 'remove' ? '-' : ' ';
            const oldNo = line.oldLineNo != null ? String(line.oldLineNo) : '';
            const newNo = line.newLineNo != null ? String(line.newLineNo) : '';
            return `<tr class="manager-diff-line manager-diff-line-${type}">
                <td>${escapeHtml(oldNo)}</td>
                <td>${escapeHtml(newNo)}</td>
                <td>${prefix}</td>
                <td>${escapeHtml(String(line.content || ''))}</td>
            </tr>`;
        }).join('');
        return `<div class="manager-workspace-diff-preview"><table><tbody>${rows}</tbody></table></div>`;
    }

    function renderUsageStatsCard(): string {
        const stats = state.usageStats;
        if (!stats || Number(stats.totalTokens || 0) <= 0) return '';
        const providerRows = Object.entries(stats.byProvider || {}).slice(0, 5).map(([providerId, value]) => {
            const pStats = value as any;
            return `<div class="manager-usage-row">
                <span>${escapeHtml(providerId)}</span>
                <strong>${Number(pStats.tokens || 0).toLocaleString()} tokens</strong>
            </div>`;
        }).join('');
        const modelRows = Array.isArray(stats.modelDistribution) ? stats.modelDistribution.slice(0, 4).map((item: any) => `
            <div class="manager-usage-row">
                <span title="${escapeHtml(item.model || '')}">${escapeHtml(String(item.model || '').slice(0, 28))}${String(item.model || '').length > 28 ? '…' : ''}</span>
                <strong>${Number(item.percentage || 0)}%</strong>
            </div>
        `).join('') : '';
        return `
            <section class="manager-side-card manager-usage-card">
                <div class="manager-card-title">${ui.metrics.totalUsage} <span>${Number(stats.totalTokens || 0).toLocaleString()} tokens</span></div>
                <div class="manager-usage-summary">
                    <div><span>${ui.metrics.estimatedCost}</span><strong>¥${typeof stats.totalCostCny === 'number' ? stats.totalCostCny.toFixed(2) : '0.00'}</strong></div>
                    <div><span>${ui.metrics.calls}</span><strong>${Number(stats.totalCalls || 0)}</strong></div>
                    ${stats.cacheStats?.totalCachedTokens ? `<div><span>${ui.metrics.cacheHit}</span><strong>${Number(stats.cacheStats.totalCachedTokens || 0).toLocaleString()}</strong></div>` : ''}
                </div>
                ${providerRows ? `<div class="manager-usage-section"><em>${ui.metrics.providers}</em>${providerRows}</div>` : ''}
                ${modelRows ? `<div class="manager-usage-section"><em>${ui.metrics.models}</em>${modelRows}</div>` : ''}
            </section>
        `;
    }

    const overview = document.createElement('div');
    overview.className = 'manager-overview';
    overview.id = 'managerOverview';
    const header = document.querySelector('.header');
    if (header) {
        header.insertAdjacentElement('afterend', overview);
    } else {
        topicsSummary.insertAdjacentElement('afterend', overview);
    }

    const drawerTitle = artifactDrawerEl.querySelector<HTMLElement>('.artifact-drawer-title');
    const drawerSubtitle = artifactDrawerEl.querySelector<HTMLElement>('.artifact-drawer-subtitle');
    if (drawerTitle) drawerTitle.innerHTML = `${svgIcon('layers')}${ui.actions.workbench}`;
    if (drawerSubtitle) drawerSubtitle.textContent = ui.workspace.openWorkspaceHint;

    const tabActiveClass = (tab: ManagerTab): string => activeTab === tab ? 'active' : '';

    const tabs = document.createElement('div');
    tabs.className = 'manager-inspector-tabs artifact-filter-row';
    tabs.innerHTML = `
        <button type="button" class="artifact-filter ${tabActiveClass('runs')}" data-manager-tab="runs">${ui.tabs.runs}</button>
        <button type="button" class="artifact-filter ${tabActiveClass('artifacts')}" data-manager-tab="artifacts">${ui.tabs.artifacts}</button>
        <button type="button" class="artifact-filter ${tabActiveClass('tasks')}" data-manager-tab="tasks">${ui.tabs.tasks}</button>
        <button type="button" class="artifact-filter ${tabActiveClass('workspace')}" data-manager-tab="workspace">${ui.tabs.workspace}</button>
        <button type="button" class="artifact-filter ${tabActiveClass('settings')}" data-manager-tab="settings">${ui.tabs.settings}</button>
    `;
    artifactDrawerEl.querySelector('.artifact-drawer-header')?.after(tabs);
    artifactDrawerEl.setAttribute('data-active-tab', activeTab);

    const topicsPanel = document.getElementById('topicsPanel');
    if (topicsPanel && !topicsPanel.querySelector('.manager-topics-heading')) {
        const topicsHeading = document.createElement('div');
        topicsHeading.className = 'manager-topics-heading';
        topicsHeading.innerHTML = `
            <span>${ui.topicsTitle}</span>
            <span class="manager-topics-heading-actions">
                <button type="button" class="manager-rail-action" data-manager-action="toggle-topics" title="${ui.actions.toggleTopics}" aria-label="${ui.actions.toggleTopics}">${svgIconNoMargin('collapseAll')}</button>
                <button type="button" class="manager-rail-action" data-manager-action="new-topic" title="${ui.actions.newTopic}" aria-label="${ui.actions.newTopic}">${svgIconNoMargin('plus')}</button>
            </span>
        `;
        topicsPanel.prepend(topicsHeading);
    }
    const topicSearchInput = document.getElementById('topicsSearch') as HTMLInputElement | null;
    if (topicSearchInput) topicSearchInput.placeholder = ui.actions.searchTopics;
    const showArchivedLabel = document.querySelector<HTMLLabelElement>('.topics-search-row label');
    if (showArchivedLabel) {
        const checkbox = showArchivedLabel.querySelector<HTMLInputElement>('input');
        showArchivedLabel.textContent = '';
        if (checkbox) showArchivedLabel.appendChild(checkbox);
        showArchivedLabel.append(` ${ui.actions.archived}`);
    }
    const exportTopicButton = document.getElementById('btnExportTopic') as HTMLButtonElement | null;
    if (exportTopicButton) {
        exportTopicButton.title = ui.actions.exportTopic;
        exportTopicButton.setAttribute('aria-label', ui.actions.exportTopic);
        exportTopicButton.innerHTML = `${svgIcon('save')}${ui.actions.exportTopic}`;
    }

    // 次级 inspector 侧滑栏（问题4）- 挂到 body，fixed 定位，贴 artifactDrawer 左侧
    const inspectorSlider = document.createElement('div');
    inspectorSlider.className = 'run-inspector-slider';
    inspectorSlider.innerHTML = `
        <div class="run-inspector-slider-header">
            <span class="run-inspector-slider-title">${svgIcon('layers')}${m.runs.eventDetail}</span>
            <button type="button" class="run-inspector-slider-close" data-run-action="close-inspector" title="${m.runs.closeInspector}">${svgIconNoMargin('x')}</button>
        </div>
        <div class="run-inspector-slider-body" id="runInspectorSliderBody"></div>
    `;
    document.body.appendChild(inspectorSlider);

    // 原生 artifact-filter-row（全部/计划/验证/变更）引用
    const artifactNativeFilterRow = artifactDrawerEl.querySelector<HTMLElement>('.artifact-filter-row:not(.manager-inspector-tabs)');

    function clickNativeButton(id: string): void {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        button?.click();
    }

    function ensureSettingsContent(): void {
        if (state.settingsContent) return;
        settingsRequestPending = true;
        vscode?.postMessage?.({ type: 'openSettings' });
    }

    function commitCurrentTopicTitle(rawTitle: string): void {
        const currentTopic = state.topics.find(topic => topic.id === state.stats.currentTopicId);
        const topicId = state.stats.currentTopicId || currentTopic?.id;
        if (!topicId) return;
        const originalTitle = currentTopic?.title || state.stats.currentTopicTitle || '';
        const nextTitle = rawTitle.trim().replace(/\s+/g, ' ');
        if (!nextTitle || nextTitle === originalTitle) return;
        vscode?.postMessage?.({ type: 'renameTopic', topicId, title: nextTitle });
        state.stats = { ...state.stats, currentTopicId: topicId, currentTopicTitle: nextTitle };
        if (currentTopic) currentTopic.title = nextTitle;
    }

    function renameCurrentTopic(): void {
        const topicId = state.stats.currentTopicId || state.topics.find(topic => topic.id === state.stats.currentTopicId)?.id;
        if (!topicId) return;
        topicTitleEditing = true;
        renderOverview();
        requestAnimationFrame(() => {
            const input = overview.querySelector<HTMLInputElement>('.manager-topic-title-input');
            input?.focus();
            input?.select();
        });
    }

    function handleManagerAction(action: string | undefined): boolean {
        if (!action) return false;
        if (action === 'stop') {
            vscode?.postMessage?.({ type: 'cancelGeneration' });
            return true;
        }
        if (action === 'toggle-topics') {
            clickNativeButton('btnTopics');
            return true;
        }
        if (action === 'new-topic') {
            clickNativeButton('btnNewTopic');
            return true;
        }
        if (action === 'workspace') {
            document.body.classList.add('artifact-drawer-open');
            setActiveTab('workspace');
            return true;
        }
        if (action === 'workbench') {
            if (document.body.classList.contains('artifact-drawer-open')) {
                document.body.classList.remove('artifact-drawer-open');
                return true;
            }
            document.body.classList.add('artifact-drawer-open');
            setActiveTab(activeTab === 'settings' ? 'settings' : (activeTab === 'artifacts' || activeTab === 'tasks' ? activeTab : 'workspace'));
            return true;
        }
        if (action === 'settings') {
            if (document.body.classList.contains('artifact-drawer-open') && activeTab === 'settings') {
                document.body.classList.remove('artifact-drawer-open');
                return true;
            }
            document.body.classList.add('artifact-drawer-open');
            setActiveTab('settings');
            return true;
        }
        if (action === 'rename-topic') {
            renameCurrentTopic();
            return true;
        }
        return false;
    }

    tabs.addEventListener('click', event => {
        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-manager-tab]');
        if (!button) return;
        const nextTab = button.dataset.managerTab as ManagerTab | undefined;
        if (!nextTab) return;
        setActiveTab(nextTab);
    });

    overview.addEventListener('click', event => {
        const actionButton = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-manager-action]');
        if (handleManagerAction(actionButton?.dataset.managerAction)) {
            return;
        }

        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-manager-jump]');
        if (!button) return;
        const nextTab = button.dataset.managerJump as ManagerTab | undefined;
        if (!nextTab) return;
        document.body.classList.add('artifact-drawer-open');
        setActiveTab(nextTab);
    });

    overview.addEventListener('keydown', event => {
        const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.manager-topic-title-input');
        if (!input) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            commitCurrentTopicTitle(input.value);
            topicTitleEditing = false;
            renderOverview();
            renderInspector();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            topicTitleEditing = false;
            renderOverview();
        }
    });

    overview.addEventListener('focusout', event => {
        const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.manager-topic-title-input');
        if (!input || !topicTitleEditing) return;
        commitCurrentTopicTitle(input.value);
        topicTitleEditing = false;
        renderOverview();
        renderInspector();
    });

    topicsPanel?.addEventListener('click', event => {
        const actionButton = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-manager-action]');
        if (handleManagerAction(actionButton?.dataset.managerAction)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

    });

    artifactListEl.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        const managerActionButton = target?.closest<HTMLButtonElement>('[data-manager-action]');
        if (handleManagerAction(managerActionButton?.dataset.managerAction)) {
            event.preventDefault();
            return;
        }

        const jumpTarget = target?.closest<HTMLElement>('[data-manager-jump]');
        const jumpTab = jumpTarget?.dataset.managerJump as ManagerTab | undefined;
        if (jumpTab) {
            setActiveTab(jumpTab);
            return;
        }

        const workspaceFileToggle = target?.closest<HTMLButtonElement>('[data-workspace-file-toggle]');
        if (workspaceFileToggle) {
            const fileKey = workspaceFileToggle.dataset.workspaceFileToggle;
            if (fileKey) {
                if (collapsedWorkspaceFiles.has(fileKey)) collapsedWorkspaceFiles.delete(fileKey);
                else collapsedWorkspaceFiles.add(fileKey);
                renderInspector();
            }
            return;
        }

        const resultLink = target?.closest<HTMLAnchorElement>('.open-result-link');
        if (resultLink) {
            event.preventDefault();
            const filePath = resultLink.dataset.path;
            if (filePath) vscode?.postMessage?.({ type: 'openRunResult', filePath });
            return;
        }

        const actionButton = target?.closest<HTMLButtonElement>('[data-run-action]');
        if (actionButton) {
            const action = actionButton.dataset.runAction;
            if (action === 'memory') {
                vscode?.postMessage?.({ type: 'requestCompactedMemory' });
            } else if (action === 'cleanup-results') {
                vscode?.postMessage?.({ type: 'cleanupRunArtifacts', maxAgeDays: 14, maxFiles: 50 });
            } else if (action === 'copy-event') {
                const selectedEvent = state.runEvents.find((evt: any) => evt.eventId === state.selectedRunEventId);
                if (selectedEvent) {
                    void navigator.clipboard?.writeText(JSON.stringify(selectedEvent, null, 2)).then(() => {
                        state.copiedEventAt = Date.now();
                        renderInspector();
                    });
                }
            }
            return;
        }

        // 时间线分组折叠切换（问题5）
        const groupHeader = target?.closest<HTMLElement>('.timeline-group-header');
        if (groupHeader) {
            const groupEl = groupHeader.closest<HTMLElement>('.timeline-group');
            const groupId = groupEl?.dataset.group;
            if (groupEl && groupId) {
                groupEl.classList.toggle('collapsed');
                if (groupEl.classList.contains('collapsed')) collapsedTimelineGroups.add(groupId);
                else collapsedTimelineGroups.delete(groupId);
            }
            return;
        }

        // Keep event details inside the workbench so the right column stays spatially stable.
        const eventRow = target?.closest<HTMLElement>('.timeline-event');
        if (activeTab === 'runs' && eventRow?.dataset.eventId) {
            state.selectedRunEventId = eventRow.dataset.eventId;
            state.inspectorPanelOpen = false;
            updateInspectorSliderVisibility();
            renderInspector();
        }
    });

    // inspector 侧滑栏关闭按钮
    inspectorSlider.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-run-action="close-inspector"]')) {
            state.inspectorPanelOpen = false;
            updateInspectorSliderVisibility();
        }
    });

    function currentTopicMessageCount(): number {
        const currentId = state.stats.currentTopicId;
        if (!currentId) return state.messageCount;
        return state.topics.find(topic => topic.id === currentId)?.messageCount ?? state.messageCount;
    }

    function compactNumber(value: number | undefined): string {
        const n = Number(value || 0);
        if (!Number.isFinite(n) || n <= 0) return '0';
        if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}m`;
        if (n >= 1000) return `${Math.round(n / 1000)}k`;
        return String(Math.round(n));
    }

    function costLabel(value: number | undefined): string {
        const n = Number(value || 0);
        if (!Number.isFinite(n) || n <= 0) return '0.00';
        return n >= 1 ? n.toFixed(2) : n.toFixed(3);
    }

    function workflowLabel(mode: string, workflowId: string | null): string {
        if (workflowId) return workflowId;
        if (mode === 'orchestrator') return ui.workflow.orchestrator;
        if (mode === 'plan') return ui.workflow.plan;
        if (mode === 'review') return ui.workflow.review;
        if (mode === 'explore') return ui.workflow.explore;
        return ui.workflow.build;
    }

    function isRunActive(status: string): boolean {
        return ['queued', 'running', 'model_call', 'tool_call', 'waiting_permission', 'waiting_write_confirmation', 'verifying', 'compacting', 'paused'].includes(status);
    }

    function runStatusLabel(status: string, isGenerating: boolean): string {
        if (isGenerating || isRunActive(status)) return status === 'paused' ? ui.status.paused : ui.status.running;
        if (status === 'completed') return ui.status.completed;
        if (status === 'failed') return ui.status.failed;
        if (status === 'cancelled') return ui.status.cancelled;
        return ui.status.idle;
    }

    function runProgressPercent(run: any): number {
        const status = String(run?.status || '');
        if (status === 'completed') return 100;
        if (status === 'failed' || status === 'cancelled') return 100;
        const metrics = run?.metrics || {};
        const iterations = Number(metrics.iterations || 0);
        const maxIterations = Number(metrics.maxIterations || 0);
        if (maxIterations > 0) return Math.max(8, Math.min(95, Math.round((iterations / maxIterations) * 100)));
        return status && isRunActive(status) ? 32 : 0;
    }

    function formatDuration(ms: number): string {
        if (!Number.isFinite(ms) || ms <= 0) return '0s';
        const seconds = Math.round(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m`;
    }

    function contextPercent(run: any): number {
        const context = run?.context || {};
        const used = Number(context.estimatedPromptTokens || run?.metrics?.promptTokens || 0);
        const limit = Number(context.contextLimit || 0);
        if (!used || !limit) return 0;
        return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
    }

    function renderOverview(): void {
        const runStatus = typeof state.run?.status === 'string' ? state.run.status : '';
        const metrics = state.run?.metrics || {};
        const isActive = state.isGenerating || isRunActive(runStatus);
        const statusText = runStatusLabel(runStatus, state.isGenerating);
        const statusClass = isActive ? 'is-running' : 'is-idle';
        const changedCount = collectChangedFiles(state.run).length;
        const currentTopic = state.topics.find(topic => topic.id === state.stats.currentTopicId);
        const topicTitle = currentTopic?.title || state.stats.currentTopicTitle || ui.run.noActiveTopic;
        const cacheStats = state.cacheStats;
        let cachePercent = metrics.promptTokens && metrics.cachedTokens
            ? Math.round((Number(metrics.cachedTokens) / Math.max(1, Number(metrics.promptTokens))) * 100)
            : 0;
        if (cacheStats && cacheStats.totalInputTokens > 0) {
            cachePercent = Math.round(cacheStats.aggregateHitRate * 100);
        }
        cachePercent = Math.max(0, Math.min(100, cachePercent));
        overview.innerHTML = `
            <div class="manager-command-left">
                <button type="button" class="manager-command-icon manager-overview-topic-toggle" data-manager-action="toggle-topics" title="${ui.actions.showTopics}" aria-label="${ui.actions.showTopics}">${svgIconNoMargin('collapseAll')}</button>
                ${topicTitleEditing ? `
                    <input class="manager-topic-title-input" type="text" value="${escapeHtml(topicTitle)}" placeholder="${escapeHtml(ui.titleEditPlaceholder)}" aria-label="${escapeHtml(ui.actions.renameTopic)}" />
                ` : `
                    <button type="button" class="manager-command-topic-title" data-manager-action="rename-topic" title="${ui.actions.renameTopic}: ${escapeHtml(topicTitle)}" aria-label="${ui.actions.renameTopic}">
                        ${svgIconNoMargin('messageSquare')}
                        <span>${escapeHtml(topicTitle)}</span>
                    </button>
                `}
                <button type="button" class="manager-command-workflow" data-manager-jump="runs" title="${escapeHtml(state.workflowId || state.mode)}">
                    ${svgIconNoMargin('gitBranch')}
                    <span>${escapeHtml(workflowLabel(state.mode, state.workflowId))}</span>
                    <span class="manager-command-chevron">v</span>
                </button>
                <span class="manager-command-status ${statusClass}">
                    ${svgIconNoMargin(isActive ? 'link' : 'check')}
                    <span>${escapeHtml(statusText)}</span>
                </span>
                <span class="manager-command-metric">${ui.metrics.tokens} <strong>${compactNumber(metrics.totalTokens)}</strong></span>
                <span class="manager-command-metric manager-command-cache">
                    ${ui.metrics.cache} <strong>${cachePercent}%</strong>
                    <span class="manager-cache-meter" aria-hidden="true"><span style="width:${cachePercent}%"></span></span>
                </span>
                <span class="manager-command-metric">${ui.metrics.cost} <strong>¥${costLabel(metrics.costCny)}</strong></span>
            </div>
            <div class="manager-command-actions">
                <button type="button" class="manager-command-metric manager-command-change" data-manager-jump="workspace">
                    <strong>${changedCount}</strong> ${ui.metrics.filesChanged}
                </button>
                <button type="button" class="manager-command-settings manager-command-workbench" data-manager-action="workbench" title="${document.body.classList.contains('artifact-drawer-open') ? ui.actions.closeWorkbench : ui.actions.workbench}" aria-label="${document.body.classList.contains('artifact-drawer-open') ? ui.actions.closeWorkbench : ui.actions.workbench}">
                    ${svgIconNoMargin('layers')}
                    <span>${ui.actions.workbench}</span>
                </button>
                <button type="button" class="manager-command-settings" data-manager-action="settings" title="${ui.actions.settings}" aria-label="${ui.actions.settings}">
                    ${svgIconNoMargin('gear')}
                    <span>${ui.actions.settings}</span>
                </button>
            </div>
        `;
    }

    function setActiveTab(nextTab: ManagerTab): void {
        activeTab = nextTab;
        artifactDrawerEl.setAttribute('data-active-tab', activeTab);
        tabs.querySelectorAll<HTMLElement>('[data-manager-tab]').forEach(button => {
            button.classList.toggle('active', button.dataset.managerTab === activeTab);
        });

        // 原生筛选行（全部/计划/验证/变更）仅在 artifacts tab 时显示
        if (artifactNativeFilterRow) {
            artifactNativeFilterRow.style.display = activeTab === 'artifacts' ? '' : 'none';
        }

        // 切换到非 runs 时关闭 inspector 侧滑栏
        if (activeTab !== 'runs') {
            state.inspectorPanelOpen = false;
            updateInspectorSliderVisibility();
        }

        renderOverview();
        if (activeTab === 'runs') {
            vscode?.postMessage?.({ type: 'requestUsageStats' });
        }
        if (activeTab === 'settings') {
            ensureSettingsContent();
        }

        if (activeTab === 'artifacts') {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'artifactList', artifacts: state.artifacts },
            }));
            return;
        }

        renderInspector();
    }

    function updateInspectorSliderVisibility(): void {
        const isOpen = state.inspectorPanelOpen && activeTab === 'runs';
        inspectorSlider.classList.toggle('open', isOpen);
        if (isOpen) {
            // 动态定位：侧滑栏 right = artifactDrawer 的 offsetWidth，从其左边界向左弹出
            const drawerRect = artifactDrawerEl.getBoundingClientRect();
            inspectorSlider.style.right = `${window.innerWidth - drawerRect.left}px`;
            inspectorSlider.style.top = `${drawerRect.top}px`;
        } else {
            inspectorSlider.style.top = '';
        }
    }

    function renderInspectorSlider(): void {
        const sliderBody = document.getElementById('runInspectorSliderBody');
        if (!sliderBody) return;

        const events = Array.isArray(state.runEvents) ? state.runEvents : [];
        const selectedEvent = events.find((evt: any) => evt.eventId === state.selectedRunEventId);
        const run = state.run;
        const context = run?.context || {};
        const contextMeter = context.estimatedPromptTokens && context.contextLimit ? {
            estimatedPromptTokens: context.estimatedPromptTokens,
            contextLimit: context.contextLimit,
            percentage: Math.round((context.estimatedPromptTokens / context.contextLimit) * 100),
        } : undefined;

        const copyLabel = state.copiedEventAt && Date.now() - state.copiedEventAt < 2500 ? m.runs.copiedEvent : m.runs.copyEventJson;
        sliderBody.innerHTML = `
            <div class="run-action-row run-inspector-actions">
                <button type="button" class="run-action-btn" data-run-action="copy-event" ${selectedEvent ? '' : 'disabled'}>${copyLabel}</button>
            </div>
            ${renderInspectorHTML({ selectedEventId: state.selectedRunEventId, selectedEvent, contextMeter }, i18n)}
        `;
        updateInspectorSliderVisibility();
    }

    function renderInspector(): void {
        if (activeTab === 'artifacts') return;

        if (activeTab === 'workspace') {
            const run = state.run;
            const workspaceFiles = collectWorkspaceFiles(run);
            const workspaceEntries = state.workspaceEntries || (state.workspaceContent ? [{ content: state.workspaceContent, title: state.workspaceTitle, subtitle: state.workspaceSubtitle }] : []);
            const changedFilesHtml = workspaceFiles.length ? workspaceFiles.map(file => `
                <article class="manager-file-change-row ${collapsedWorkspaceFiles.has(file.file) ? 'is-collapsed' : ''}">
                    <button type="button" class="manager-file-change-toggle" data-workspace-file-toggle="${escapeHtml(file.file)}" aria-expanded="${collapsedWorkspaceFiles.has(file.file) ? 'false' : 'true'}">
                        <span title="${escapeHtml(file.file)}">${svgIconNoMargin('file')}${escapeHtml(fileBasename(file.file))}<small>${escapeHtml(file.file)}</small></span>
                        <em>${escapeHtml(formatFileStats(file))}</em>
                    </button>
                    ${collapsedWorkspaceFiles.has(file.file) ? '' : renderWorkspaceDiffLines(file)}
                </article>
            `).join('') : `<div class="manager-side-empty">${ui.workspace.noFiles}</div>`;
            const hasExternalWorkspace = workspaceEntries.length > 0;
            artifactListEl.innerHTML = `
                <div class="manager-workspace-page">
                    <section class="manager-side-card manager-workspace-hero">
                        <div class="manager-card-title">${escapeHtml(ui.workspace.title)} <span>${escapeHtml(state.workflowId || state.mode)}</span></div>
                        <p>${escapeHtml(ui.workspace.subtitle)}</p>
                    </section>
                    <section class="manager-side-card manager-workspace-host-card ${hasExternalWorkspace ? 'has-content' : ''}">
                        <div id="managerWorkspaceExternalHost" class="manager-workspace-external-host">
                            ${hasExternalWorkspace ? '' : `<div class="manager-workspace-empty-card"><strong>${ui.workspace.noWorkspace}</strong><span>${ui.workspace.noWorkspaceHint}</span></div>`}
                        </div>
                    </section>
                    <section class="manager-side-card">
                        <div class="manager-card-title">${ui.workspace.fileChanges} <span>${workspaceFiles.length}</span></div>
                        ${changedFilesHtml}
                    </section>
                </div>
            `;
            const host = artifactListEl.querySelector<HTMLElement>('#managerWorkspaceExternalHost');
            if (host && workspaceEntries.length) {
                host.replaceChildren();
                workspaceEntries.forEach(entry => {
                    const section = document.createElement('section');
                    section.className = 'manager-workspace-entry';
                    if (workspaceEntries.length > 1 && (entry.title || entry.subtitle)) {
                        const header = document.createElement('div');
                        header.className = 'manager-workspace-entry-header';
                        header.innerHTML = `<strong>${escapeHtml(entry.title || ui.workspace.title)}</strong>${entry.subtitle ? `<span>${escapeHtml(entry.subtitle)}</span>` : ''}`;
                        section.appendChild(header);
                    }
                    section.appendChild(entry.content);
                    host.appendChild(section);
                });
            }
            return;
        }

        if (activeTab === 'settings') {
            artifactListEl.innerHTML = `
                <div class="manager-settings-page">
                    <section class="manager-side-card manager-workspace-hero">
                        <div class="manager-card-title">${escapeHtml(state.settingsTitle || ui.settings.title)}</div>
                        <p>${escapeHtml(state.settingsSubtitle || ui.settings.subtitle)}</p>
                    </section>
                    <div id="managerSettingsHost" class="manager-settings-host">
                        <div class="manager-side-empty">${ui.settings.loading}</div>
                    </div>
                </div>
            `;
            const host = artifactListEl.querySelector<HTMLElement>('#managerSettingsHost');
            if (host && state.settingsContent) {
                host.replaceChildren(state.settingsContent);
            }
            return;
        }

        if (activeTab === 'tasks') {
            artifactListEl.innerHTML = state.todos.length
                ? state.todos.map(todo => `
                    <article class="artifact-item manager-task-item manager-task-${escapeHtml(todo.status)}">
                        <div class="manager-task-line">
                            <span class="manager-task-mark">${taskStatusMark(todo.status)}</span>
                            <span class="artifact-item-title">${escapeHtml(todo.content)}</span>
                        </div>
                    </article>
                `).join('')
                : `<div class="artifact-empty">${m.tasks.noTasks}</div>`;
            return;
        }

        if (activeTab === 'runs') {
            const run = state.run;
            if (!run) {
                artifactListEl.innerHTML = `<div class="artifact-empty">${m.runs.noRun}</div>`;
                return;
            }

            const metrics = run.metrics || { totalTokens: 0, promptTokens: 0, completionTokens: 0, costCny: 0, iterations: 0, toolCalls: 0 };
            const events = getRenderableRunEvents(Array.isArray(state.runEvents) ? state.runEvents : []);
            if (events.length > 0 && (!state.selectedRunEventId || !events.some((evt: any) => evt.eventId === state.selectedRunEventId))) {
                state.selectedRunEventId = events[events.length - 1]?.eventId;
            }
            if (events.length === 0) {
                state.selectedRunEventId = undefined;
            }

            const cleanupHtml = state.cleanupResult ? `
                <div class="run-action-note">
                    ${m.runs.cleaned
                        .replace('{deleted}', String(state.cleanupResult.deletedCount))
                        .replace('{kept}', String(state.cleanupResult.keptCount))
                        .replace('{size}', formatBytes(state.cleanupResult.reclaimedBytes))}
                </div>
            ` : '';
            const memoryHtml = state.compactedMemoryContent ? `
                <details class="run-memory-panel" open>
                    <summary>${m.runs.compactedMemory}</summary>
                    <pre>${escapeHtml(state.compactedMemoryContent)}</pre>
                </details>
            ` : '';
            const subAgentChangeSets = events
                .filter((evt: any) => evt.type === 'subagent_end' && Array.isArray(evt.payload?.filesWritten) && evt.payload.filesWritten.length > 0);
            const subAgentChangeHtml = subAgentChangeSets.length ? `
                <details class="run-subagent-change-set">
                    <summary>${m.runs.subAgentChangeSets} (${subAgentChangeSets.length})</summary>
                    ${subAgentChangeSets.map((evt: any) => `
                        <div class="run-subagent-change-item">
                            <div class="run-subagent-change-title">${escapeHtml(evt.agentId || evt.payload?.taskNodeId || 'sub-agent')}</div>
                            <ul>
                                ${evt.payload.filesWritten.map((file: string) => `<li><code>${escapeHtml(file)}</code></li>`).join('')}
                            </ul>
                        </div>
                    `).join('')}
                </details>
            ` : '';

            // 时间线：传入 i18n，并在分组 header 上加折叠按钮（问题5）
            const eventGroups = groupTimelineEvents(events, i18n).filter(group => group.id !== 'other');
            const eventTimelineHtml = eventGroups.length ? renderTimelineHTML(eventGroups, true, collapsedTimelineGroups) : '';
            const progressPercent = runProgressPercent(run);
            const startedAt = Number(run.startedAt || run.createdAt || Date.now());
            const finishedAt = Number(run.completedAt || Date.now());
            const startedLabel = new Date(startedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const contextUsed = Number(run.context?.estimatedPromptTokens || metrics.promptTokens || 0);
            const contextLimit = Number(run.context?.contextLimit || 0);
            const contextPct = contextPercent(run);
            const changedFiles = collectChangedFiles(run, events);
            const currentTopic = state.topics.find(topic => topic.id === state.stats.currentTopicId);
            const selectedEventContextMeter = contextUsed && contextLimit ? {
                estimatedPromptTokens: contextUsed,
                contextLimit,
                percentage: contextPct,
            } : undefined;
            const contextHtml = contextUsed ? `
                <section class="manager-context-card">
                    <div class="manager-card-title">${ui.run.contextUsage} <span>${contextLimit ? `${compactNumber(contextUsed)} / ${compactNumber(contextLimit)}` : compactNumber(contextUsed)} tokens</span></div>
                    <div class="manager-context-meter"><span style="width:${contextPct || 6}%"></span></div>
                    <div class="manager-context-breakdown">
                        <span>${ui.run.prompt} ${compactNumber(metrics.promptTokens)}</span>
                        <span>${ui.run.output} ${compactNumber(metrics.completionTokens)}</span>
                        ${metrics.cachedTokens ? `<span>${ui.metrics.cached} ${compactNumber(metrics.cachedTokens)}</span>` : ''}
                    </div>
                </section>
            ` : '';
            const runOverviewCardsHtml = `
                <section class="manager-delivery-grid">
                    <article class="manager-delivery-card" data-manager-jump="runs">
                        <span class="manager-delivery-value">${run ? 1 : 0}</span>
                        <span class="manager-delivery-label">${ui.run.activeRun}</span>
                    </article>
                    <article class="manager-delivery-card" data-manager-jump="artifacts">
                        <span class="manager-delivery-value">${state.artifacts.length}</span>
                        <span class="manager-delivery-label">${ui.run.artifacts}</span>
                    </article>
                    <article class="manager-delivery-card" data-manager-jump="workspace">
                        <span class="manager-delivery-value">${changedFiles.length}</span>
                        <span class="manager-delivery-label">${ui.run.filesChanged}</span>
                    </article>
                    <article class="manager-delivery-card">
                        <span class="manager-delivery-value">${compactNumber(contextUsed)}</span>
                        <span class="manager-delivery-label">${ui.run.contextTokens}</span>
                    </article>
                </section>
            `;
            const currentTopicHtml = `
                <section class="manager-side-card">
                    <div class="manager-card-title">${ui.run.currentTopic} <span>${currentTopic ? escapeHtml(formatDuration(Date.now() - (currentTopic.updatedAt || Date.now()))) : ''}</span></div>
                    <div class="manager-workspace-detail-row">
                        <strong>${escapeHtml(currentTopic?.title || state.stats.currentTopicTitle || ui.run.noActiveTopic)}</strong>
                        <span>${currentTopic?.messageCount ?? currentTopicMessageCount()} ${ui.run.messages}</span>
                    </div>
                </section>
            `;
            const artifactCardsHtml = state.artifacts.length ? state.artifacts.slice(0, 4).map((artifact: any) => `
                <article class="manager-side-item">
                    <span class="manager-side-icon">${svgIconNoMargin(artifact.kind === 'diff' ? 'pencil' : artifact.kind === 'validation' ? 'check' : 'fileText')}</span>
                    <span class="manager-side-main">
                        <strong>${escapeHtml(artifact.title || artifact.kind || 'Artifact')}</strong>
                        <em>${escapeHtml(artifact.summary || artifact.status || artifact.kind || '')}</em>
                    </span>
                </article>
            `).join('') : `<div class="manager-side-empty">${ui.run.noArtifacts}</div>`;
            const filesCardsHtml = changedFiles.length ? changedFiles.slice(0, 5).map((file: string) => `
                <article class="manager-file-change-row">
                    <span>${svgIconNoMargin('file')}${escapeHtml(file.split(/[\\/]/).pop() || file)}</span>
                    <em>${ui.run.changed}</em>
                </article>
            `).join('') : `<div class="manager-side-empty">${ui.run.noFileChanges}</div>`;
            const usageStatsHtml = renderUsageStatsCard();
            const selectedEvent = events.find((evt: any) => evt.eventId === state.selectedRunEventId);
            const copyLabel = state.copiedEventAt && Date.now() - state.copiedEventAt < 2500 ? m.runs.copiedEvent : m.runs.copyEventJson;
            const selectedEventHtml = selectedEvent ? `
                <section class="manager-selected-event-card">
                    <div class="manager-card-title">${ui.run.selectedEvent} <span>${escapeHtml(selectedEvent.type || '')}</span></div>
                    <div class="run-action-row manager-selected-event-actions">
                        <button type="button" class="run-action-btn" data-run-action="copy-event">${copyLabel}</button>
                    </div>
                    ${renderInspectorHTML({ selectedEventId: state.selectedRunEventId, selectedEvent, contextMeter: selectedEventContextMeter }, i18n)}
                </section>
            ` : '';

            artifactListEl.innerHTML = `
                <div class="manager-run-workbench">
                    <section class="manager-run-main">
                        <article class="artifact-item manager-run-summary">
                            <div class="manager-run-head">
                                <div>
                                    <div class="artifact-item-title">${ui.run.runPrefix} #${escapeHtml(run.runId)}</div>
                                    <div class="artifact-item-summary">${escapeHtml(runStatusLabel(run.status, state.isGenerating))} · ${ui.run.started} ${escapeHtml(startedLabel)} · ${escapeHtml(formatDuration(finishedAt - startedAt))}</div>
                                </div>
                                <span class="run-status-pill run-status-${escapeHtml(run.status)}">${escapeHtml(runStatusLabel(run.status, state.isGenerating))}</span>
                            </div>
                            <div class="manager-run-progress" aria-label="Run progress">
                                <span style="width:${progressPercent}%"></span>
                                <em>${progressPercent}%</em>
                            </div>
                            <div class="run-metrics-grid">
                                <div class="run-metric-cell">${m.runs.metrics.tokens}: <strong>${metrics.totalTokens}</strong> (${metrics.promptTokens} ${ui.metrics.in} / ${metrics.completionTokens} ${ui.metrics.out}${metrics.cachedTokens ? `, ${metrics.cachedTokens} ${ui.metrics.cached}` : ''})</div>
                                <div class="run-metric-cell">${m.runs.metrics.cost}: <strong>¥${metrics.costCny?.toFixed(4) || '0.0000'}</strong></div>
                                <div class="run-metric-cell">${m.runs.metrics.tools}: <strong>${metrics.toolCalls} ${m.runs.metrics.calls}</strong></div>
                            </div>
                            <div class="run-action-row">
                                <button type="button" class="run-action-btn" data-run-action="memory">${m.runs.openMemory}</button>
                                <button type="button" class="run-action-btn" data-run-action="cleanup-results">${m.runs.cleanLargeResults}</button>
                            </div>
                            ${cleanupHtml}
                            ${run.writtenFiles?.length ? `
                                <div class="run-written-files">
                                    <strong>${m.runs.modifiedFiles}:</strong>
                                    <ul>
                                        ${run.writtenFiles.map((f: string) => `<li><code>${escapeHtml(f.split(/[\\/]/).pop() || f)}</code></li>`).join('')}
                                    </ul>
                                </div>
                            ` : ''}
                            ${subAgentChangeHtml}
                        </article>
                        ${eventTimelineHtml ? `
                            <div class="run-events-container">
                                <div class="manager-card-title">${ui.run.eventTimeline} <span>${events.length}</span></div>
                                ${eventTimelineHtml}
                            </div>
                        ` : ''}
                        ${selectedEventHtml}
                        ${memoryHtml}
                    </section>
                    <aside class="manager-run-side">
                        ${runOverviewCardsHtml}
                        ${currentTopicHtml}
                        ${contextHtml}
                        ${usageStatsHtml}
                        <section class="manager-side-card">
                            <div class="manager-card-title">${ui.run.artifacts} <span>${state.artifacts.length}</span></div>
                            ${artifactCardsHtml}
                        </section>
                        <section class="manager-side-card">
                            <div class="manager-card-title">${ui.run.filesChanged} <span>${changedFiles.length}</span></div>
                            ${filesCardsHtml}
                        </section>
                    </aside>
                </div>
            `;
            markSelectedRunEvent();
            return;
        }

        const progress = state.orchestrator;
        if (!progress) {
            artifactListEl.innerHTML = `<div class="artifact-empty">${m.agents.noLanes}</div>`;
            return;
        }

        artifactListEl.innerHTML = `
            <article class="artifact-item manager-agent-summary">
                <div class="artifact-item-title">${m.agents.phase}: ${escapeHtml(progress.phase)}</div>
                <div class="artifact-item-summary">${m.agents.done} ${progress.done}/${progress.total}, ${m.agents.running} ${progress.running}, ${m.agents.failed} ${progress.failed}</div>
                <div class="artifact-meta">${escapeHtml(progress.latestEvent || '')}</div>
            </article>
            ${progress.lanes.map(lane => `
                <article class="artifact-item manager-agent-lane manager-agent-${escapeHtml(lane.status)}">
                    <div class="artifact-item-title">${escapeHtml(lane.role)} / ${escapeHtml(lane.status)}</div>
                    <div class="artifact-item-summary">${m.agents.task} ${escapeHtml(lane.taskNodeId)} / ${m.agents.steps} ${lane.stepCount} / ${m.agents.tokens} ${lane.tokenUsed}</div>
                    <div class="artifact-meta">${escapeHtml(lane.statusText || '')}</div>
                </article>
            `).join('')}
        `;
    }

    function markSelectedRunEvent(): void {
        artifactListEl.querySelectorAll<HTMLElement>('.timeline-event').forEach(row => {
            row.classList.toggle('selected', !!state.selectedRunEventId && row.dataset.eventId === state.selectedRunEventId);
        });
    }

    function formatBytes(bytes: number): string {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        if (bytes < 1024) return `${Math.round(bytes)} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function taskStatusMark(status: 'pending' | 'in_progress' | 'done'): string {
        if (status === 'done') return '&#10003;';
        if (status === 'in_progress') return '&#8230;';
        return '&#9675;';
    }

    function updateFromSnapshot(snapshot: ManagerSnapshotMessage): void {
        const previousTopicId = state.stats.currentTopicId;
        state.topics = snapshot.topics || [];
        state.stats = snapshot.stats || state.stats;
        if (previousTopicId !== state.stats.currentTopicId) {
            state.run = null;
            state.runEvents = [];
            state.selectedRunEventId = undefined;
            state.cacheStats = undefined;
            state.compactedMemoryContent = undefined;
            state.cleanupResult = undefined;
            state.workspaceContent = null;
            state.workspaceEntries = [];
            collapsedTimelineGroups.clear();
            collapsedWorkspaceFiles.clear();
        }
        state.artifacts = snapshot.artifacts || [];
        state.mode = snapshot.mode || state.mode;
        state.workflowId = snapshot.workflowId || null;
        state.isGenerating = !!snapshot.isGenerating;
        state.liveStepCount = snapshot.liveStepCount || 0;
        state.messageCount = typeof snapshot.messageCount === 'number'
            ? snapshot.messageCount
            : snapshot.messages?.filter(message => !message.isHidden).length || 0;
        renderOverview();
        renderInspector();
    }

    function applyEmbeddedWorkbenchContent(detail: any): void {
        const kind = detail?.kind === 'settings' ? 'settings' : 'workspace';
        const content = detail?.content instanceof HTMLElement ? detail.content : null;
        if (kind === 'settings') {
            settingsRequestPending = false;
            state.settingsContent = content;
            state.settingsTitle = detail?.title || ui.settings.title;
            state.settingsSubtitle = detail?.subtitle || ui.settings.subtitle;
            document.body.classList.add('artifact-drawer-open');
            setActiveTab('settings');
            return;
        }
        if (content) {
            const entries = state.workspaceEntries ? [...state.workspaceEntries] : [];
            const existingIndex = entries.findIndex(entry => entry.content === content);
            const nextEntry = {
                content,
                title: detail?.title || ui.workspace.title,
                subtitle: detail?.subtitle || '',
                kind,
                wide: !!detail?.wide,
            };
            if (existingIndex >= 0) entries[existingIndex] = nextEntry;
            else entries.push(nextEntry);
            state.workspaceEntries = entries;
            state.workspaceContent = content;
            state.workspaceTitle = nextEntry.title;
            state.workspaceSubtitle = nextEntry.subtitle;
        }
        document.body.classList.add('artifact-drawer-open');
        setActiveTab('workspace');
    }

    function applyHostMessage(msg: any): void {
        switch (msg?.type) {
            case 'managerSnapshot':
                updateFromSnapshot(msg as ManagerSnapshotMessage);
                break;
            case 'runSnapshot':
                state.run = msg.snapshot;
                state.runEvents = Array.isArray(msg.events) ? msg.events : [];
                state.cacheStats = msg.cacheStats || state.cacheStats;
                renderOverview();
                renderInspector();
                break;
            case 'compactedMemoryResult':
                state.compactedMemoryContent = msg.content || '';
                if (activeTab !== 'runs') {
                    setActiveTab('runs');
                } else {
                    renderInspector();
                }
                break;
            case 'runArtifactsCleanupResult':
                state.cleanupResult = {
                    deletedCount: Number(msg.deletedCount || 0),
                    keptCount: Number(msg.keptCount || 0),
                    reclaimedBytes: Number(msg.reclaimedBytes || 0),
                };
                renderInspector();
                break;
            case 'topicList':
                {
                    const previousTopicId = state.stats.currentTopicId;
                    state.topics = msg.topics || [];
                    state.stats = msg.stats || state.stats;
                    if (previousTopicId !== state.stats.currentTopicId) {
                        state.run = null;
                        state.runEvents = [];
                        state.selectedRunEventId = undefined;
                        state.cacheStats = undefined;
                        state.compactedMemoryContent = undefined;
                        state.cleanupResult = undefined;
                        state.workspaceContent = null;
                        state.workspaceEntries = [];
                        collapsedTimelineGroups.clear();
                        collapsedWorkspaceFiles.clear();
                    }
                    renderOverview();
                    renderInspector();
                }
                break;
            case 'topicSearchResults':
                state.stats = msg.stats || state.stats;
                renderOverview();
                break;
            case 'loadTopicMessages':
                if (msg.targetSurface && msg.targetSurface !== 'manager') break;
                state.messageCount = (msg.messages || []).filter((message: { isHidden?: boolean }) => !message.isHidden).length;
                renderOverview();
                break;
            case 'clearChat':
                if (msg.targetSurface && msg.targetSurface !== 'manager') break;
                state.messageCount = 0;
                state.run = null;
                state.runEvents = [];
                state.selectedRunEventId = undefined;
                state.cacheStats = undefined;
                state.workspaceContent = null;
                state.workspaceEntries = [];
                collapsedTimelineGroups.clear();
                collapsedWorkspaceFiles.clear();
                renderOverview();
                renderInspector();
                break;
            case 'addUserMessage':
                state.messageCount += 1;
                renderOverview();
                break;
            case 'startBackgroundGeneration':
                state.isGenerating = true;
                renderOverview();
                break;
            case 'modeChanged':
            case 'setMode':
                state.mode = msg.mode || state.mode;
                renderOverview();
                break;
            case 'workflowChanged':
                state.workflowId = msg.workflowId || null;
                renderOverview();
                break;
            case 'artifactList':
                state.artifacts = msg.artifacts || [];
                renderOverview();
                renderInspector();
                break;
            case 'usageStats':
                state.usageStats = msg.stats;
                renderInspector();
                break;
            case 'topicTitleGenerated':
                if (msg.topicId === state.stats.currentTopicId) {
                    state.stats = { ...state.stats, currentTopicTitle: msg.title || state.stats.currentTopicTitle };
                    const topic = state.topics.find(item => item.id === msg.topicId);
                    if (topic) topic.title = msg.title || topic.title;
                    renderOverview();
                    renderInspector();
                }
                break;
            case 'todoUpdate':
                state.todos = msg.todos || [];
                renderInspector();
                break;
            case 'replaySteps':
                state.liveStepCount = Array.isArray(msg.steps) ? msg.steps.length : 0;
                state.isGenerating = !!msg.isGenerating;
                renderOverview();
                break;
            case 'agentStep':
                state.liveStepCount += 1;
                state.isGenerating = true;
                if (msg.step?.type === 'cache_stats' && msg.step.cacheStats) {
                    const current = state.cacheStats || {
                        totalCachedTokens: 0,
                        totalInputTokens: 0,
                        totalSavedCostCny: 0,
                        aggregateHitRate: 0,
                        byAgent: [],
                    };
                    const cachedTokens = Number(msg.step.cacheStats.cachedTokens || 0);
                    const inputTokens = Number(msg.step.cacheStats.totalTokens || 0);
                    const savedCost = Number(msg.step.cacheStats.savedCostCny || 0);
                    const totalCachedTokens = current.totalCachedTokens + cachedTokens;
                    const totalInputTokens = current.totalInputTokens + inputTokens;
                    state.cacheStats = {
                        ...current,
                        totalCachedTokens,
                        totalInputTokens,
                        totalSavedCostCny: current.totalSavedCostCny + savedCost,
                        aggregateHitRate: totalInputTokens > 0 ? totalCachedTokens / totalInputTokens : 0,
                    };
                }
                renderOverview();
                break;
            case 'generationComplete':
                state.messageCount += 1;
                state.liveStepCount = 0;
                state.isGenerating = false;
                renderOverview();
                break;
            case 'generationError':
                state.liveStepCount = 0;
                state.isGenerating = false;
                renderOverview();
                break;
            case 'orchestratorProgress':
                state.orchestrator = (msg as OrchestratorProgressMessage).progress || null;
                renderInspector();
                break;
        }
    }

    window.addEventListener('agent-manager-workspace-content', event => {
        applyEmbeddedWorkbenchContent((event as CustomEvent).detail);
    });
    window.addEventListener('message', event => applyHostMessage(event.data));
    const pendingWorkbenchContent = (window as any).__cwtoolsPendingManagerWorkspaceContent;
    if (pendingWorkbenchContent) {
        applyEmbeddedWorkbenchContent(pendingWorkbenchContent);
    }

    // 监听 body 的 class 变化，若右侧抽屉被关掉，联动收起左侧 Event Detail 侧滑栏
    const drawerObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.attributeName === 'class') {
                const hasDrawer = document.body.classList.contains('artifact-drawer-open');
                if (!hasDrawer && state.inspectorPanelOpen) {
                    state.inspectorPanelOpen = false;
                    updateInspectorSliderVisibility();
                    markSelectedRunEvent();
                }
                renderOverview();
            }
        }
    });
    drawerObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    renderOverview();
    renderInspector();
})();

(window as any).__cwtoolsPostReady?.();
