import './chatPanel';
import { escapeHtml } from './chat/formatters';
import { renderInspectorHTML } from './chat/runInspector';
import {
    buildAgentTraceModel,
    renderAgentTreeHTML,
    renderTraceRailHTML,
    stableTrajectoryEndTime,
    type AgentTraceEvent,
    type AgentTraceLabels,
} from './chat/agentTrace';
import { getChatI18n, normalizeChatLocale } from './chat/i18n';
import { getDiffArtifactFiles } from './chat/artifacts';
import { svgIcon, svgIconNoMargin } from './svgIcons';
import type { ManagerSnapshotMessage, OrchestratorProgressMessage } from './chat/messages.manager';
import type { ManagerAgentProfileView, ManagerRunSnapshotMessage } from './chat/messages.manager';
import type { TopicListItem, TopicStats } from './chat/messages.shared';
import { parseHostMessage } from './chat/hostProtocol';

type ManagerTab = 'changes' | 'activity' | 'settings';
type ManagerMainView = 'conversation' | 'trajectory';

type PersistedManagerUiState = {
    activeTab?: 'changes' | 'activity' | 'trajectory';
    mainView?: ManagerMainView;
    drawerOpen?: boolean;
    leftWidth?: number;
    rightWidth?: number;
};

type ManagerEnhancementState = {
    topics: TopicListItem[];
    stats: TopicStats;
    artifacts: ManagerSnapshotMessage['artifacts'];
    todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>;
    mode: string;
    agentProfile: ManagerAgentProfileView;
    resolvedAgentProfile?: ManagerSnapshotMessage['resolvedAgentProfile'];
    workflowId: string | null;
    isGenerating: boolean;
    liveStepCount: number;
    messageCount: number;
    orchestrator: OrchestratorProgressMessage['progress'] | null;
    run: ManagerRunSnapshotMessage['snapshot'] | null;
    runEvents: AgentTraceEvent[];
    childRuns: NonNullable<ManagerRunSnapshotMessage['childRuns']>;
    activity?: ManagerSnapshotMessage['activity'];
    runtimeInspector?: ManagerSnapshotMessage['runtimeInspector'];
    transcript?: ManagerSnapshotMessage['transcript'];
    selectedRunEventId?: string;
    compactedMemoryContent?: string;
    cleanupResult?: { deletedCount: number; keptCount: number; reclaimedBytes: number };
    copiedEventAt?: number;
    workspaceContent?: HTMLElement | null;
    workspaceEntries?: Array<{ content: HTMLElement; title?: string; subtitle?: string; kind?: string; sourceKey?: string; wide?: boolean }>;
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
        totalCacheCreationTokens?: number;
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
    agentProfile: { domain: 'paradox', intent: 'auto', strategy: 'auto' },
    resolvedAgentProfile: undefined,
    workflowId: null,
    isGenerating: false,
    liveStepCount: 0,
    messageCount: 0,
    orchestrator: null,
    run: null,
    runEvents: [],
    childRuns: [],
    activity: undefined,
    runtimeInspector: undefined,
    transcript: undefined,
    selectedRunEventId: undefined,
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

    const state: ManagerEnhancementState = { ...DEFAULT_STATE };
    const vscode = (window as any).__cwtoolsVscode;
    const persistedRootState = vscode?.getState?.() || {};
    const persistedUi = (persistedRootState.agentManager || {}) as PersistedManagerUiState;
    let activeTab: ManagerTab = persistedUi.activeTab === 'activity' ? 'activity' : 'changes';
    let mainView: ManagerMainView = persistedUi.mainView === 'trajectory' || persistedUi.activeTab === 'trajectory'
        ? 'trajectory'
        : 'conversation';
    let hasUserSelectedPrimaryTab = persistedUi.activeTab === 'changes' || persistedUi.activeTab === 'activity';
    let settingsRequestPending = false;
    let topicTitleEditing = false;
    let runDockOpen: 'tasks' | 'changes' | null = null;
    let selectedAgentId: string | undefined;
    let trajectoryDetailsOpen = false;
    let lastKnownTopicId: string | null = null;
    let lastOverviewSignature = '';
    let lastWorkspaceRenderSignature = '';
    let workspaceRenderRevision = 0;
    const collapsedWorkspaceFiles = new Set<string>();
    const expandedWorkspaceDiffFiles = new Set<string>();
    const expandedWorkspaceContextFiles = new Set<string>();
    const cacheStatsByRunId = new Map<string, NonNullable<ManagerEnhancementState['cacheStats']>>();
    document.body.dataset.managerActiveTab = activeTab;
    document.body.dataset.managerMainView = mainView;

    const initialDrawerOpen = persistedUi.drawerOpen ?? ((window.innerWidth || document.documentElement.clientWidth) > 1280);
    document.body.classList.toggle('artifact-drawer-open', initialDrawerOpen);
    artifactDrawerEl.setAttribute('aria-hidden', initialDrawerOpen ? 'false' : 'true');
    document.getElementById('btnArtifacts')?.setAttribute('aria-expanded', initialDrawerOpen ? 'true' : 'false');
    if (Number.isFinite(persistedUi.leftWidth)) {
        document.body.style.setProperty('--manager-left-width', `${persistedUi.leftWidth}px`);
    }
    if (Number.isFinite(persistedUi.rightWidth)) {
        document.body.style.setProperty('--manager-right-width', `${persistedUi.rightWidth}px`);
    }

    // 从 HTML body 的 data-locale 属性读取 locale（由 agentManagerHtml.ts 注入）
    const locale = normalizeChatLocale((document.body as HTMLElement).dataset.locale);
    const i18n = getChatI18n(locale);
    const m = i18n.manager;
    const RUN_MAX_RENDERED_EVENTS = 300;
    const DIFF_INITIAL_RENDER_LINES = 240;
    const DIFF_CONTEXT_EDGE_LINES = 3;
    const ui = locale === 'zh-cn'
        ? {
            topicsTitle: 'Agent 话题',
            tabs: { conversation: '对话', trajectory: '轨迹', changes: '变更', activity: '运行' },
            actions: { workbench: '工作台', closeWorkbench: '关闭工作台', settings: '设置', showTopics: '显示话题', toggleTopics: '折叠话题栏', newTopic: '新话题', archived: '已归档', exportTopic: '导出', searchTopics: '搜索话题...', renameTopic: '重命名话题', review: '审核' },
            workflow: { build: '构建工作流', plan: '计划工作流', review: '审查工作流', explore: '探索工作流', orchestrator: '通用多 Agent 工作流', script: 'Paradox 多 Agent 工作流' },
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
                currentRound: '当前轮次',
                previousRound: '上一轮',
                runDetails: '运行详情',
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
                reviewTitle: '审阅变更',
                reviewSubtitle: '逐文件检查本轮修改。',
                noChanges: '本轮暂无文件变更',
                openFile: '打开文件',
                showRemaining: '显示剩余 {count} 行',
                showAllContext: '展开未修改的上下文',
                collapseFile: '折叠文件',
                expandFile: '展开文件',
            },
            activity: {
                title: '运行活动',
                agents: 'Agent',
                tasks: '任务',
                artifacts: '产物',
                timeline: '事件时间线',
                noActivity: '暂无运行活动',
            },
            dock: { tasks: '任务', changes: '改动文件', review: '审核全部改动', running: '运行中', completed: '已完成', created: '新增', modified: '修改', deleted: '删除' },
            settings: {
                title: '设置',
                subtitle: '模型、上下文、API 和工具',
                loading: '正在加载设置...',
            },
            titleEditPlaceholder: '输入话题名称',
        }
        : {
            topicsTitle: 'Agent Topics',
            tabs: { conversation: 'Conversation', trajectory: 'Trajectory', changes: 'Changes', activity: 'Run' },
            actions: { workbench: 'Workbench', closeWorkbench: 'Close Workbench', settings: 'Settings', showTopics: 'Show topics', toggleTopics: 'Toggle topics', newTopic: 'New topic', archived: 'Archived', exportTopic: 'Export', searchTopics: 'Search topics...', renameTopic: 'Rename topic', review: 'Review' },
            workflow: { build: 'Build Workflow', plan: 'Plan Workflow', review: 'Review Workflow', explore: 'Explore Workflow', orchestrator: 'General Multi-Agent Workflow', script: 'Paradox Multi-Agent Workflow' },
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
                currentRound: 'Current round',
                previousRound: 'Previous round',
                runDetails: 'Run details',
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
                reviewTitle: 'Review changes',
                reviewSubtitle: 'Inspect this round file by file.',
                noChanges: 'No file changes in this round',
                openFile: 'Open file',
                showRemaining: 'Show {count} more lines',
                showAllContext: 'Expand unchanged context',
                collapseFile: 'Collapse file',
                expandFile: 'Expand file',
            },
            activity: {
                title: 'Run activity',
                agents: 'Agents',
                tasks: 'Tasks',
                artifacts: 'Artifacts',
                timeline: 'Event timeline',
                noActivity: 'No run activity yet',
            },
            dock: { tasks: 'Tasks', changes: 'changed files', review: 'Review all changes', running: 'Running', completed: 'Complete', created: 'Added', modified: 'Modified', deleted: 'Deleted' },
            settings: {
                title: 'Settings',
                subtitle: 'Models, context, API, and tools',
                loading: 'Loading settings...',
            },
            titleEditPlaceholder: 'Topic title',
        };
    const traceLabels: AgentTraceLabels = locale === 'zh-cn'
        ? {
            mainAgent: '主代理',
            subagent: '子代理',
            conversation: '代理任务',
            trajectory: '运行轨迹',
            modelCalls: '模型',
            toolCalls: '工具',
            events: '事件',
            noConversation: '该代理暂无可显示的对话步骤。',
            noTrajectory: '该代理暂无运行轨迹。',
            running: '运行中',
            completed: '已完成',
            failed: '失败',
            pending: '等待中',
            backToMain: '返回主代理',
            inspectHint: '点击树节点进入对应代理路径；点击轨迹条查看事件详情。',
        }
        : {
            mainAgent: 'Main agent',
            subagent: 'Subagent',
            conversation: 'Agent tasks',
            trajectory: 'Run trajectory',
            modelCalls: 'Model',
            toolCalls: 'Tools',
            events: 'Events',
            noConversation: 'No conversation steps are available for this agent.',
            noTrajectory: 'No run trajectory is available for this agent.',
            running: 'Running',
            completed: 'Completed',
            failed: 'Failed',
            pending: 'Pending',
            backToMain: 'Back to main agent',
            inspectHint: 'Select a tree node to enter that agent path; select a trace span to inspect its event.',
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
            if (evt?.type === 'file_change') add(payload.filePath);
            if (evt?.type === 'tool_call_end') addMany(payload.writtenFiles);
            if (evt?.type === 'subagent_end') addMany(payload.filesWritten);
        }
        return [...files].sort((left, right) => left.localeCompare(right));
    }

    function getDiffArtifacts(): ManagerSnapshotMessage['artifacts'] {
        return state.artifacts.filter((artifact: any) => {
            if (artifact.kind === 'diff') return true;
            if (typeof artifact.kind === 'string' && artifact.kind) return false;
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
            const key = record.file.replace(/\\/g, '/');
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
        return [...byPath.values()].sort((left, right) => left.file.localeCompare(right.file));
    }

    function normalizeCacheStats(raw: any): NonNullable<ManagerEnhancementState['cacheStats']> {
        const totalCachedTokens = Number(raw?.totalCachedTokens ?? raw?.cachedTokens ?? 0);
        const totalInputTokens = Number(raw?.totalInputTokens ?? raw?.inputTokens ?? raw?.totalTokens ?? 0);
        const totalCacheCreationTokens = Number(raw?.totalCacheCreationTokens ?? raw?.cacheCreationTokens ?? 0);
        const totalSavedCostCny = Number(raw?.totalSavedCostCny ?? raw?.savedCostCny ?? 0);
        return {
            totalCachedTokens,
            totalInputTokens,
            totalCacheCreationTokens,
            totalSavedCostCny,
            aggregateHitRate: totalInputTokens > 0 ? totalCachedTokens / totalInputTokens : Number(raw?.aggregateHitRate ?? raw?.hitRate ?? 0),
            byAgent: Array.isArray(raw?.byAgent) ? raw.byAgent : [],
        };
    }

    function aggregateCacheStats(): NonNullable<ManagerEnhancementState['cacheStats']> | undefined {
        let totalCachedTokens = 0;
        let totalInputTokens = 0;
        let totalCacheCreationTokens = 0;
        let totalSavedCostCny = 0;
        const byAgent = new Map<string, { agentId: string; cachedTokens: number; inputTokens: number; callCount: number }>();
        for (const stats of cacheStatsByRunId.values()) {
            totalCachedTokens += Number(stats.totalCachedTokens || 0);
            totalInputTokens += Number(stats.totalInputTokens || 0);
            totalCacheCreationTokens += Number(stats.totalCacheCreationTokens || 0);
            totalSavedCostCny += Number(stats.totalSavedCostCny || 0);
            for (const agent of stats.byAgent || []) {
                const agentId = String(agent.agentId || 'root');
                const existing = byAgent.get(agentId) || { agentId, cachedTokens: 0, inputTokens: 0, callCount: 0 };
                existing.cachedTokens += Number(agent.cachedTokens || 0);
                existing.inputTokens += Number(agent.inputTokens || 0);
                existing.callCount += Number(agent.callCount || 0);
                byAgent.set(agentId, existing);
            }
        }
        if (totalCachedTokens <= 0 && totalInputTokens <= 0 && totalCacheCreationTokens <= 0 && totalSavedCostCny <= 0) {
            return undefined;
        }
        return {
            totalCachedTokens,
            totalInputTokens,
            totalCacheCreationTokens,
            totalSavedCostCny,
            aggregateHitRate: totalInputTokens > 0 ? totalCachedTokens / totalInputTokens : 0,
            byAgent: Array.from(byAgent.values()).map(agent => ({
                ...agent,
                hitRate: agent.inputTokens > 0 ? agent.cachedTokens / agent.inputTokens : 0,
            })),
        };
    }

    function setRunCacheStats(runId: string | undefined, raw: any): void {
        if (!runId || !raw) return;
        cacheStatsByRunId.set(runId, normalizeCacheStats(raw));
        state.cacheStats = aggregateCacheStats();
    }

    function resetTopicScopedWorkbenchState(options: { preserveCache?: boolean } = {}): void {
        const previousCacheStats = options.preserveCache ? state.cacheStats : undefined;
        state.run = null;
        state.runEvents = [];
        state.childRuns = [];
        state.todos = [];
        runDockOpen = null;
        selectedAgentId = undefined;
        trajectoryDetailsOpen = false;
        state.selectedRunEventId = undefined;
        state.cacheStats = previousCacheStats;
        state.compactedMemoryContent = undefined;
        state.cleanupResult = undefined;
        state.workspaceContent = null;
        state.workspaceEntries = [];
        if (!options.preserveCache) cacheStatsByRunId.clear();
        collapsedWorkspaceFiles.clear();
        expandedWorkspaceDiffFiles.clear();
        expandedWorkspaceContextFiles.clear();
        workspaceRenderRevision++;
        lastWorkspaceRenderSignature = '';
    }

    function syncTopicScopedState(nextTopicId: string | null | undefined): void {
        const normalizedTopicId = nextTopicId || null;
        if (!normalizedTopicId) return;
        if (!lastKnownTopicId) {
            lastKnownTopicId = normalizedTopicId;
            return;
        }
        if (lastKnownTopicId === normalizedTopicId) return;
        lastKnownTopicId = normalizedTopicId;
        resetTopicScopedWorkbenchState();
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

    function compactDiffContextRows(lines: any[], showAllContext: boolean): Array<{ line?: any; omitted?: number }> {
        if (showAllContext) return lines.map(line => ({ line }));
        const rows: Array<{ line?: any; omitted?: number }> = [];
        let index = 0;
        while (index < lines.length) {
            if (lines[index]?.type !== 'ctx') {
                rows.push({ line: lines[index] });
                index++;
                continue;
            }
            let end = index + 1;
            while (end < lines.length && lines[end]?.type === 'ctx') end++;
            const count = end - index;
            if (count <= DIFF_CONTEXT_EDGE_LINES * 2 + 2) {
                for (let i = index; i < end; i++) rows.push({ line: lines[i] });
            } else {
                for (let i = index; i < index + DIFF_CONTEXT_EDGE_LINES; i++) rows.push({ line: lines[i] });
                rows.push({ omitted: count - DIFF_CONTEXT_EDGE_LINES * 2 });
                for (let i = end - DIFF_CONTEXT_EDGE_LINES; i < end; i++) rows.push({ line: lines[i] });
            }
            index = end;
        }
        return rows;
    }

    function renderWorkspaceDiffLines(file: WorkspaceFileRecord): string {
        const lines = Array.isArray(file.diffLines) ? file.diffLines : [];
        if (!lines.length) {
            return `<div class="manager-workspace-diff-preview manager-workspace-diff-empty">
                <div>${escapeHtml(file.file)}</div>
                <span>${escapeHtml(formatFileStats(file))}</span>
            </div>`;
        }
        const showAllLines = expandedWorkspaceDiffFiles.has(file.file);
        const renderedLines = showAllLines ? lines : lines.slice(0, DIFF_INITIAL_RENDER_LINES);
        const rows = compactDiffContextRows(renderedLines, expandedWorkspaceContextFiles.has(file.file)).map(row => {
            if (row.omitted) {
                return `<tr class="manager-diff-line manager-diff-line-omitted">
                    <td colspan="4"><button type="button" data-diff-expand-context="${escapeHtml(file.file)}">${escapeHtml(ui.workspace.showAllContext)} · ${row.omitted}</button></td>
                </tr>`;
            }
            const line = row.line || {};
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
        const remaining = Math.max(0, lines.length - renderedLines.length);
        const loadMore = remaining > 0
            ? `<button type="button" class="manager-diff-load-more" data-diff-expand-file="${escapeHtml(file.file)}">${escapeHtml(ui.workspace.showRemaining.replace('{count}', String(remaining)))}</button>`
            : '';
        return `<div class="manager-workspace-diff-preview"><table><tbody>${rows}</tbody></table>${loadMore}</div>`;
    }

    function currentWorkspaceEntries(): Array<{ content: HTMLElement; title?: string; subtitle?: string; kind?: string; sourceKey?: string; wide?: boolean }> {
        return state.workspaceEntries || (state.workspaceContent ? [{ content: state.workspaceContent, title: state.workspaceTitle, subtitle: state.workspaceSubtitle }] : []);
    }

    function workspaceRenderSignature(files: WorkspaceFileRecord[], entries = currentWorkspaceEntries()): string {
        return JSON.stringify({
            revision: workspaceRenderRevision,
            entries: entries.map(entry => ({
                key: entry.sourceKey || entry.kind || entry.title || '',
                title: entry.title || '',
                subtitle: entry.subtitle || '',
                compact: entry.content.classList.contains('ap-compact'),
            })),
            files: files.map(file => ({
                file: file.file,
                status: file.status || '',
                additions: file.additions ?? null,
                deletions: file.deletions ?? null,
                preview: file.diffPreview || '',
                lineCount: Array.isArray(file.diffLines) ? file.diffLines.length : 0,
                collapsed: collapsedWorkspaceFiles.has(file.file),
                expandedLines: expandedWorkspaceDiffFiles.has(file.file),
                expandedContext: expandedWorkspaceContextFiles.has(file.file),
            })),
        });
    }

    function updateWorkspaceFileToggle(fileKey: string, row: HTMLElement): void {
        const files = collectWorkspaceFiles(state.run);
        const file = files.find(item => item.file === fileKey);
        const nextCollapsed = !collapsedWorkspaceFiles.has(fileKey);
        if (nextCollapsed) collapsedWorkspaceFiles.add(fileKey);
        else collapsedWorkspaceFiles.delete(fileKey);
        row.classList.toggle('is-collapsed', nextCollapsed);
        const button = row.querySelector<HTMLButtonElement>('.manager-file-change-toggle');
        button?.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
        row.querySelector<HTMLElement>('.manager-workspace-diff-preview')?.remove();
        if (!nextCollapsed && file) {
            row.insertAdjacentHTML('beforeend', renderWorkspaceDiffLines(file));
        }
        lastWorkspaceRenderSignature = workspaceRenderSignature(files);
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

    const mainViewTabs = document.createElement('nav');
    mainViewTabs.className = 'manager-main-tabs';
    mainViewTabs.setAttribute('role', 'tablist');
    mainViewTabs.setAttribute('aria-label', locale === 'zh-cn' ? '主页面视图' : 'Main views');
    overview.insertAdjacentElement('afterend', mainViewTabs);

    const trajectoryView = document.createElement('section');
    trajectoryView.className = 'manager-trajectory-view';
    trajectoryView.id = 'managerTrajectoryView';
    trajectoryView.setAttribute('role', 'tabpanel');
    trajectoryView.setAttribute('aria-label', ui.tabs.trajectory);
    document.querySelector<HTMLElement>('.chat-area')?.insertAdjacentElement('beforebegin', trajectoryView);

    const runDock = document.createElement('div');
    runDock.className = 'manager-run-dock';
    runDock.id = 'managerRunDock';
    runDock.setAttribute('aria-live', 'polite');
    document.querySelector<HTMLElement>('.input-wrapper')?.prepend(runDock);

    const drawerTitle = artifactDrawerEl.querySelector<HTMLElement>('.artifact-drawer-title');
    const drawerSubtitle = artifactDrawerEl.querySelector<HTMLElement>('.artifact-drawer-subtitle');
    if (drawerTitle) drawerTitle.innerHTML = `${svgIcon('edit')}${ui.workspace.reviewTitle}`;
    if (drawerSubtitle) drawerSubtitle.textContent = ui.workspace.reviewSubtitle;

    const tabActiveClass = (tab: ManagerTab): string => activeTab === tab ? 'active' : '';

    const tabs = document.createElement('div');
    tabs.className = 'manager-inspector-tabs artifact-filter-row';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', ui.actions.workbench);
    tabs.innerHTML = `
        <button type="button" role="tab" aria-selected="${activeTab === 'changes'}" class="artifact-filter ${tabActiveClass('changes')}" data-manager-tab="changes">${ui.tabs.changes}</button>
        <button type="button" role="tab" aria-selected="${activeTab === 'activity'}" class="artifact-filter ${tabActiveClass('activity')}" data-manager-tab="activity">${ui.tabs.activity}</button>
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

    const artifactNativeFilterRow = artifactDrawerEl.querySelector<HTMLElement>('.artifact-filter-row:not(.manager-inspector-tabs)');
    if (artifactNativeFilterRow) artifactNativeFilterRow.style.display = 'none';

    function clickNativeButton(id: string): void {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        button?.click();
    }

    function ensureSettingsContent(force = false): void {
        if (settingsRequestPending) return;
        if (!force && state.settingsContent) return;
        settingsRequestPending = true;
        vscode?.postMessage?.({ type: 'openSettings' });
    }

    function currentManagerUiState(): PersistedManagerUiState {
        const leftWidth = Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--manager-left-width'));
        const rightWidth = Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--manager-right-width'));
        return {
            activeTab: activeTab === 'settings' ? (persistedUi.activeTab === 'activity' ? 'activity' : 'changes') : activeTab,
            mainView,
            drawerOpen: document.body.classList.contains('artifact-drawer-open'),
            leftWidth: Number.isFinite(leftWidth) ? Math.round(leftWidth) : undefined,
            rightWidth: Number.isFinite(rightWidth) ? Math.round(rightWidth) : undefined,
        };
    }

    function persistManagerUiState(): void {
        if (!vscode?.setState) return;
        const root = vscode.getState?.() || {};
        const next = currentManagerUiState();
        Object.assign(persistedUi, next);
        vscode.setState({ ...root, agentManager: next });
    }

    function setManagerDrawerOpen(open: boolean): void {
        document.body.classList.toggle('artifact-drawer-open', open);
        artifactDrawerEl.setAttribute('aria-hidden', open ? 'false' : 'true');
        document.getElementById('btnArtifacts')?.setAttribute('aria-expanded', open ? 'true' : 'false');
        persistManagerUiState();
        renderOverview();
    }

    const leftResizer = document.createElement('div');
    leftResizer.className = 'manager-pane-resizer manager-left-resizer';
    leftResizer.tabIndex = 0;
    leftResizer.setAttribute('role', 'separator');
    leftResizer.setAttribute('aria-orientation', 'vertical');
    leftResizer.setAttribute('aria-label', locale === 'zh-cn' ? '调整任务栏宽度' : 'Resize task sidebar');
    const rightResizer = document.createElement('div');
    rightResizer.className = 'manager-pane-resizer manager-right-resizer';
    rightResizer.tabIndex = 0;
    rightResizer.setAttribute('role', 'separator');
    rightResizer.setAttribute('aria-orientation', 'vertical');
    rightResizer.setAttribute('aria-label', locale === 'zh-cn' ? '调整审阅栏宽度' : 'Resize review pane');
    document.body.append(leftResizer, rightResizer);

    function clampPaneWidth(side: 'left' | 'right', rawWidth: number): number {
        if (side === 'left') return Math.max(220, Math.min(380, rawWidth));
        const leftWidth = topicsPanel?.getBoundingClientRect().width || 0;
        const maxRight = Math.max(440, window.innerWidth - leftWidth - 520);
        return Math.max(440, Math.min(Math.min(1100, maxRight), rawWidth));
    }

    function setPaneWidth(side: 'left' | 'right', rawWidth: number): void {
        const width = Math.round(clampPaneWidth(side, rawWidth));
        document.body.style.setProperty(side === 'left' ? '--manager-left-width' : '--manager-right-width', `${width}px`);
        const resizer = side === 'left' ? leftResizer : rightResizer;
        resizer.setAttribute('aria-valuenow', String(width));
        resizer.setAttribute('aria-valuemin', side === 'left' ? '220' : '440');
        resizer.setAttribute('aria-valuemax', side === 'left' ? '380' : '1100');
    }

    function installPaneResizer(resizer: HTMLElement, side: 'left' | 'right'): void {
        const currentWidth = (): number => side === 'left'
            ? (topicsPanel?.getBoundingClientRect().width || 280)
            : (artifactDrawerEl.getBoundingClientRect().width || 720);
        resizer.addEventListener('pointerdown', event => {
            if (window.innerWidth <= 1280) return;
            event.preventDefault();
            document.body.classList.add('manager-resizing');
            resizer.setPointerCapture(event.pointerId);
            const move = (moveEvent: PointerEvent): void => {
                setPaneWidth(side, side === 'left' ? moveEvent.clientX : window.innerWidth - moveEvent.clientX);
            };
            const finish = (): void => {
                document.body.classList.remove('manager-resizing');
                resizer.removeEventListener('pointermove', move);
                resizer.removeEventListener('pointerup', finish);
                resizer.removeEventListener('pointercancel', finish);
                persistManagerUiState();
            };
            resizer.addEventListener('pointermove', move);
            resizer.addEventListener('pointerup', finish);
            resizer.addEventListener('pointercancel', finish);
        });
        resizer.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || window.innerWidth <= 1280) return;
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const delta = side === 'left' ? direction * 16 : direction * -16;
            setPaneWidth(side, currentWidth() + delta);
            persistManagerUiState();
        });
        resizer.addEventListener('dblclick', () => {
            setPaneWidth(side, side === 'left' ? 288 : 720);
            persistManagerUiState();
        });
        setPaneWidth(side, currentWidth());
    }

    installPaneResizer(leftResizer, 'left');
    installPaneResizer(rightResizer, 'right');

    function suggestedPrimaryTab(): Exclude<ManagerTab, 'settings'> {
        return collectWorkspaceFiles(state.run).length > 0 ? 'changes' : 'activity';
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
            setManagerDrawerOpen(true);
            hasUserSelectedPrimaryTab = true;
            setActiveTab('changes');
            return true;
        }
        if (action === 'workbench') {
            if (document.body.classList.contains('artifact-drawer-open')) {
                setManagerDrawerOpen(false);
                return true;
            }
            setManagerDrawerOpen(true);
            setActiveTab(activeTab === 'settings' ? suggestedPrimaryTab() : activeTab);
            return true;
        }
        if (action === 'settings') {
            if (document.body.classList.contains('artifact-drawer-open') && activeTab === 'settings') {
                setManagerDrawerOpen(false);
                return true;
            }
            setManagerDrawerOpen(true);
            setActiveTab('settings', { forceSettingsRefresh: true });
            return true;
        }
        if (action === 'rename-topic') {
            renameCurrentTopic();
            return true;
        }
        return false;
    }

    mainViewTabs.addEventListener('click', event => {
        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-manager-main-tab]');
        const nextView = button?.dataset.managerMainTab as ManagerMainView | undefined;
        if (!nextView) return;
        setMainView(nextView);
    });

    mainViewTabs.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const nextView: ManagerMainView = mainView === 'trajectory' ? 'conversation' : 'trajectory';
        event.preventDefault();
        setMainView(nextView);
        mainViewTabs.querySelector<HTMLButtonElement>(`[data-manager-main-tab="${nextView}"]`)?.focus();
    });

    tabs.addEventListener('click', event => {
        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-manager-tab]');
        if (!button) return;
        const nextTab = button.dataset.managerTab as ManagerTab | undefined;
        if (!nextTab) return;
        hasUserSelectedPrimaryTab = true;
        setActiveTab(nextTab, { forceSettingsRefresh: nextTab === 'settings' });
    });

    tabs.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const nextTab: ManagerTab = activeTab === 'changes' ? 'activity' : 'changes';
        event.preventDefault();
        hasUserSelectedPrimaryTab = true;
        setActiveTab(nextTab);
        tabs.querySelector<HTMLButtonElement>(`[data-manager-tab="${nextTab}"]`)?.focus();
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
        if (nextTab !== 'settings') hasUserSelectedPrimaryTab = true;
        setManagerDrawerOpen(true);
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

    runDock.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        const fileButton = target?.closest<HTMLButtonElement>('[data-manager-dock-file]');
        if (fileButton?.dataset.managerDockFile) {
            event.preventDefault();
            event.stopPropagation();
            focusWorkspaceFile(fileButton.dataset.managerDockFile);
            return;
        }
        const actionButton = target?.closest<HTMLButtonElement>('[data-manager-dock-action]');
        const action = actionButton?.dataset.managerDockAction;
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if (action === 'review') {
            focusWorkspaceFile();
            return;
        }
        if (action === 'tasks' || action === 'changes') {
            runDockOpen = runDockOpen === action ? null : action;
            renderRunDock();
        }
    });

    document.addEventListener('click', event => {
        if (!runDockOpen || runDock.contains(event.target as Node)) return;
        runDockOpen = null;
        renderRunDock();
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !runDockOpen) return;
        runDockOpen = null;
        renderRunDock();
    });

    topicsPanel?.addEventListener('click', event => {
        const actionButton = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-manager-action]');
        if (handleManagerAction(actionButton?.dataset.managerAction)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

    });

    trajectoryView.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-trajectory-close-details]')) {
            state.selectedRunEventId = undefined;
            trajectoryDetailsOpen = false;
            updateTrajectoryDetails();
            return;
        }
        const actionButton = target?.closest<HTMLButtonElement>('[data-run-action]');
        if (actionButton?.dataset.runAction === 'copy-event') {
            const selectedEvent = state.runEvents.find(item => item.eventId === state.selectedRunEventId);
            if (selectedEvent) {
                void navigator.clipboard?.writeText(JSON.stringify(selectedEvent, null, 2)).then(() => {
                    state.copiedEventAt = Date.now();
                    updateTrajectoryDetails();
                });
            }
            return;
        }
        const eventButton = target?.closest<HTMLElement>('[data-trace-event-id]');
        if (eventButton?.dataset.traceEventId) {
            state.selectedRunEventId = eventButton.dataset.traceEventId;
            trajectoryDetailsOpen = true;
            updateTrajectoryDetails();
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

        const artifactTarget = target?.closest<HTMLElement>('[data-manager-artifact-id]');
        if (artifactTarget?.dataset.managerArtifactId) {
            vscode?.postMessage?.({ type: 'openArtifact', artifactId: artifactTarget.dataset.managerArtifactId });
            return;
        }

        if (target?.closest('.annotatable-plan .ap-header')) {
            lastWorkspaceRenderSignature = workspaceRenderSignature(collectWorkspaceFiles(state.run));
            return;
        }

        const expandDiffButton = target?.closest<HTMLElement>('[data-diff-expand-file]');
        if (expandDiffButton?.dataset.diffExpandFile) {
            expandedWorkspaceDiffFiles.add(expandDiffButton.dataset.diffExpandFile);
            lastWorkspaceRenderSignature = '';
            renderInspector();
            return;
        }

        const expandContextButton = target?.closest<HTMLElement>('[data-diff-expand-context]');
        if (expandContextButton?.dataset.diffExpandContext) {
            expandedWorkspaceContextFiles.add(expandContextButton.dataset.diffExpandContext);
            lastWorkspaceRenderSignature = '';
            renderInspector();
            return;
        }

        const workspaceFileToggle = target?.closest<HTMLElement>('[data-workspace-file-toggle]');
        if (workspaceFileToggle) {
            const fileKey = workspaceFileToggle.dataset.workspaceFileToggle;
            if (fileKey) {
                const row = workspaceFileToggle.closest<HTMLElement>('.manager-file-change-row');
                if (row) updateWorkspaceFileToggle(fileKey, row);
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

        const agentPath = target?.closest<HTMLElement>('[data-agent-path]');
        if (activeTab === 'activity' && agentPath?.dataset.agentPath) {
            selectedAgentId = agentPath.dataset.agentPath;
            state.selectedRunEventId = undefined;
            renderInspector();
            return;
        }

        // Keep event details inside the workbench so the right column stays spatially stable.
        const traceEvent = target?.closest<HTMLElement>('[data-trace-event-id]');
        if (activeTab === 'activity' && traceEvent?.dataset.traceEventId) {
            state.selectedRunEventId = traceEvent.dataset.traceEventId;
            renderInspector();
        }
    });

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

    function profileLabel(profile: ManagerAgentProfileView, resolved?: ManagerSnapshotMessage['resolvedAgentProfile']): string {
        const label = (value: string): string => {
            if (locale !== 'zh-cn') return value === 'general' ? 'General' : value === 'paradox' ? 'Paradox' : value[0]!.toUpperCase() + value.slice(1);
            return ({ auto: '自动', general: '通用', paradox: 'Paradox', execute: '执行', plan: '规划', explore: '探索', review: '审查', single: '单 Agent', multi: '多 Agent' } as Record<string, string>)[value] ?? value;
        };
        if (profile.domain === 'auto' && profile.intent === 'auto' && profile.strategy === 'auto' && resolved) {
            return `${label('auto')} → ${label(resolved.domain)} · ${label(resolved.intent)} · ${label(resolved.strategy)}`;
        }
        return [profile.domain, profile.intent, profile.strategy].filter(value => value !== 'auto').map(label).join(' · ') || label('auto');
    }

    function workflowLabel(mode: string, workflowId: string | null): string {
        if (workflowId) return workflowId;
        if (mode === 'orchestrator') return ui.workflow.orchestrator;
        if (mode === 'script') return ui.workflow.script;
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

    function workspaceFileStatus(file: WorkspaceFileRecord): 'created' | 'modified' | 'deleted' | 'changed' {
        if (file.status === 'created' || file.status === 'deleted' || file.status === 'modified') return file.status;
        return 'changed';
    }

    function workspaceFileStatusLabel(file: WorkspaceFileRecord): string {
        const status = workspaceFileStatus(file);
        if (status === 'created') return ui.dock.created;
        if (status === 'deleted') return ui.dock.deleted;
        if (status === 'modified') return ui.dock.modified;
        return ui.run.changed;
    }

    function renderRunDock(): void {
        const files = collectWorkspaceFiles(state.run);
        const todos = state.todos;
        const isActive = state.isGenerating || isRunActive(String(state.run?.status || ''));
        if (!isActive && todos.length === 0 && files.length === 0) {
            runDock.hidden = true;
            runDock.replaceChildren();
            return;
        }

        runDock.hidden = false;
        const done = todos.filter(todo => todo.status === 'done').length;
        const additions = files.reduce((sum, file) => sum + Number(file.additions || 0), 0);
        const deletions = files.reduce((sum, file) => sum + Number(file.deletions || 0), 0);
        const taskLabel = todos.length > 0 ? `${done}/${todos.length} ${ui.dock.tasks}` : (isActive ? ui.dock.running : ui.dock.completed);
        const taskRows = todos.map(todo => `
            <div class="manager-dock-task manager-dock-task-${escapeHtml(todo.status)}">
                <span>${taskStatusMark(todo.status)}</span><strong>${escapeHtml(todo.content)}</strong>
            </div>
        `).join('');
        const fileRows = files.map(file => {
            const status = workspaceFileStatus(file);
            return `
                <button type="button" class="manager-dock-file" data-manager-dock-file="${escapeHtml(file.file)}" title="${escapeHtml(file.file)}">
                    <span class="manager-file-status manager-file-status-${status}">${escapeHtml(workspaceFileStatusLabel(file).slice(0, 1))}</span>
                    <span class="manager-dock-file-main"><strong>${escapeHtml(fileBasename(file.file))}</strong><small>${escapeHtml(file.file)}</small></span>
                    <span class="manager-dock-file-delta"><strong>+${file.additions ?? 0}</strong><em>-${file.deletions ?? 0}</em></span>
                </button>
            `;
        }).join('');
        const popover = runDockOpen === 'tasks' && todos.length > 0 ? `
            <div class="manager-dock-popover" data-manager-dock-popover="tasks">
                <header><strong>${ui.dock.tasks}</strong><span>${done}/${todos.length}</span></header>
                <div class="manager-dock-list">${taskRows}</div>
            </div>
        ` : runDockOpen === 'changes' && files.length > 0 ? `
            <div class="manager-dock-popover" data-manager-dock-popover="changes">
                <header><strong>${ui.dock.changes}</strong><button type="button" data-manager-dock-action="review">${ui.dock.review}</button></header>
                <div class="manager-dock-list">${fileRows}</div>
            </div>
        ` : '';

        runDock.innerHTML = `
            <div class="manager-dock-capsule ${isActive ? 'is-running' : 'is-complete'}">
                <button type="button" class="manager-dock-segment manager-dock-tasks" data-manager-dock-action="tasks" aria-expanded="${runDockOpen === 'tasks'}">
                    <span class="manager-dock-state" aria-hidden="true"></span><strong>${escapeHtml(taskLabel)}</strong>
                </button>
                ${files.length > 0 ? `
                    <span class="manager-dock-divider" aria-hidden="true"></span>
                    <button type="button" class="manager-dock-segment manager-dock-changes" data-manager-dock-action="changes" aria-expanded="${runDockOpen === 'changes'}">
                        <strong>${files.length} ${ui.dock.changes}</strong>
                        <span class="manager-command-delta"><strong>+${additions}</strong><em>-${deletions}</em></span>
                    </button>
                ` : ''}
            </div>
            ${popover}
        `;
    }

    function focusWorkspaceFile(filePath?: string): void {
        if (filePath) collapsedWorkspaceFiles.delete(filePath);
        setManagerDrawerOpen(true);
        setActiveTab('changes');
        runDockOpen = null;
        renderRunDock();
        if (!filePath) return;
        requestAnimationFrame(() => {
            const row = Array.from(artifactListEl.querySelectorAll<HTMLElement>('[data-workspace-file]'))
                .find(candidate => candidate.dataset.workspaceFile === filePath);
            row?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            row?.classList.add('is-focused');
            if (row) setTimeout(() => row.classList.remove('is-focused'), 1600);
        });
    }

    function renderOverview(): void {
        renderRunDock();
        const runStatus = typeof state.run?.status === 'string' ? state.run.status : '';
        const isActive = state.isGenerating || isRunActive(runStatus);
        const statusText = runStatusLabel(runStatus, state.isGenerating);
        const statusClass = isActive ? 'is-running' : 'is-idle';
        const currentTopic = state.topics.find(topic => topic.id === state.stats.currentTopicId);
        const topicTitle = currentTopic?.title || state.stats.currentTopicTitle || ui.run.noActiveTopic;
        const drawerOpen = document.body.classList.contains('artifact-drawer-open');
        const workspaceFiles = collectWorkspaceFiles(state.run);
        const additions = workspaceFiles.reduce((sum, file) => sum + Number(file.additions || 0), 0);
        const deletions = workspaceFiles.reduce((sum, file) => sum + Number(file.deletions || 0), 0);
        const overviewSignature = JSON.stringify({
            drawerOpen,
            topicTitleEditing,
            topicTitle,
            workflow: state.workflowId || state.mode,
            statusText,
            statusClass,
            activeTab,
            mainView,
            fileCount: workspaceFiles.length,
            additions,
            deletions,
        });
        if (overviewSignature === lastOverviewSignature) return;
        lastOverviewSignature = overviewSignature;
        mainViewTabs.innerHTML = `
            <button type="button" role="tab" aria-selected="${mainView === 'conversation'}" class="manager-main-tab ${mainView === 'conversation' ? 'active' : ''}" data-manager-main-tab="conversation">${ui.tabs.conversation}</button>
            <button type="button" role="tab" aria-selected="${mainView === 'trajectory'}" class="manager-main-tab ${mainView === 'trajectory' ? 'active' : ''}" data-manager-main-tab="trajectory">${ui.tabs.trajectory}<span>${state.runEvents.length || ''}</span></button>
        `;
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
                <button type="button" class="manager-command-workflow" data-manager-jump="activity" title="${escapeHtml(state.workflowId || state.mode)}">
                    ${svgIconNoMargin('gitBranch')}
                    <span>${escapeHtml(isActive ? ui.run.currentRound : ui.run.previousRound)}</span>
                    <small>${escapeHtml(state.workflowId || profileLabel(state.agentProfile, state.resolvedAgentProfile))}</small>
                </button>
                <span class="manager-command-status ${statusClass}">
                    ${svgIconNoMargin(isActive ? 'link' : 'check')}
                    <span>${escapeHtml(statusText)}</span>
                </span>
            </div>
            <div class="manager-command-actions">
                <button type="button" class="manager-command-metric manager-command-change ${activeTab === 'changes' && drawerOpen ? 'active' : ''}" data-manager-jump="changes">
                    <span>${ui.actions.review}</span>
                    ${workspaceFiles.length > 0 ? `<span class="manager-command-delta"><strong>+${additions}</strong><em>-${deletions}</em></span>` : ''}
                </button>
                <button type="button" class="manager-command-settings manager-command-workbench" data-manager-action="workbench" title="${drawerOpen ? ui.actions.closeWorkbench : ui.actions.workbench}" aria-label="${drawerOpen ? ui.actions.closeWorkbench : ui.actions.workbench}">
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

    function setMainView(nextView: ManagerMainView): void {
        mainView = nextView;
        document.body.dataset.managerMainView = mainView;
        mainViewTabs.querySelectorAll<HTMLElement>('[data-manager-main-tab]').forEach(button => {
            const selected = button.dataset.managerMainTab === mainView;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        persistManagerUiState();
        renderOverview();
        renderTrajectoryView();
    }

    function setActiveTab(nextTab: ManagerTab, options: { forceSettingsRefresh?: boolean; suppressSettingsRequest?: boolean } = {}): void {
        activeTab = nextTab;
        document.body.dataset.managerActiveTab = activeTab;
        artifactDrawerEl.setAttribute('data-active-tab', activeTab);
        tabs.querySelectorAll<HTMLElement>('[data-manager-tab]').forEach(button => {
            const selected = button.dataset.managerTab === activeTab;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        renderOverview();
        if (activeTab === 'activity') {
            vscode?.postMessage?.({ type: 'requestUsageStats' });
        }
        if (activeTab === 'settings' && !options.suppressSettingsRequest) {
            ensureSettingsContent(!!options.forceSettingsRefresh);
        }

        if (activeTab !== 'settings') persistManagerUiState();
        renderInspector();
        renderTrajectoryView();
    }

    function syncSuggestedPrimaryTab(): void {
        if (hasUserSelectedPrimaryTab || activeTab === 'settings') return;
        const nextTab = suggestedPrimaryTab();
        if (nextTab === activeTab) return;
        activeTab = nextTab;
        document.body.dataset.managerActiveTab = activeTab;
        artifactDrawerEl.setAttribute('data-active-tab', activeTab);
        tabs.querySelectorAll<HTMLElement>('[data-manager-tab]').forEach(button => {
            const selected = button.dataset.managerTab === activeTab;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
    }

    function renderInspector(): void {
        if (activeTab === 'changes') {
            const run = state.run;
            const workspaceFiles = collectWorkspaceFiles(run);
            const workspaceEntries = currentWorkspaceEntries();
            const signature = workspaceRenderSignature(workspaceFiles, workspaceEntries);
            if (signature === lastWorkspaceRenderSignature && artifactListEl.querySelector('.manager-workspace-page')) {
                return;
            }
            lastWorkspaceRenderSignature = signature;
            const additions = workspaceFiles.reduce((sum, file) => sum + Number(file.additions || 0), 0);
            const deletions = workspaceFiles.reduce((sum, file) => sum + Number(file.deletions || 0), 0);
            const changedFilesHtml = workspaceFiles.length ? workspaceFiles.map(file => `
                <article class="manager-file-change-row ${collapsedWorkspaceFiles.has(file.file) ? 'is-collapsed' : ''}" data-workspace-file="${escapeHtml(file.file)}">
                    <header class="manager-file-change-header">
                        <button type="button" class="manager-file-change-toggle" data-workspace-file-toggle="${escapeHtml(file.file)}" aria-expanded="${collapsedWorkspaceFiles.has(file.file) ? 'false' : 'true'}" title="${escapeHtml(collapsedWorkspaceFiles.has(file.file) ? ui.workspace.expandFile : ui.workspace.collapseFile)}">
                            <span class="manager-file-chevron" aria-hidden="true"></span>
                            <span class="manager-file-status manager-file-status-${workspaceFileStatus(file)}">${escapeHtml(workspaceFileStatusLabel(file).slice(0, 1))}</span>
                            <span class="manager-file-identity" title="${escapeHtml(file.file)}"><strong>${escapeHtml(fileBasename(file.file))}</strong><small>${escapeHtml(file.file)}</small></span>
                        </button>
                        <span class="manager-file-delta" aria-label="${escapeHtml(formatFileStats(file))}">
                            ${file.additions !== undefined || file.deletions !== undefined ? `<strong>+${file.additions ?? 0}</strong><em>-${file.deletions ?? 0}</em>` : `<i>${escapeHtml(file.status || ui.run.changed)}</i>`}
                        </span>
                        <button type="button" class="manager-file-open open-result-link" data-path="${escapeHtml(file.file)}" title="${escapeHtml(ui.workspace.openFile)}" aria-label="${escapeHtml(ui.workspace.openFile)}">${svgIconNoMargin('file')}</button>
                    </header>
                    ${collapsedWorkspaceFiles.has(file.file) ? '' : renderWorkspaceDiffLines(file)}
                </article>
            `).join('') : `<div class="manager-review-empty"><strong>${ui.workspace.noChanges}</strong><span>${ui.workspace.noWorkspaceHint}</span></div>`;
            const hasExternalWorkspace = workspaceEntries.length > 0;
            artifactListEl.innerHTML = `
                <div class="manager-workspace-page manager-changes-page">
                    <header class="manager-review-summary">
                        <span><strong>${state.isGenerating || isRunActive(String(run?.status || '')) ? ui.run.currentRound : ui.run.previousRound}</strong><small>${escapeHtml(state.workflowId || workflowLabel(state.mode, null))}</small></span>
                        <span class="manager-review-delta"><strong>+${additions}</strong><em>-${deletions}</em><i>${workspaceFiles.length} ${ui.metrics.filesChanged}</i></span>
                    </header>
                    <section class="manager-workspace-host-card ${hasExternalWorkspace ? 'has-content' : ''}" ${hasExternalWorkspace ? '' : 'hidden'}>
                        <div id="managerWorkspaceExternalHost" class="manager-workspace-external-host">
                        </div>
                    </section>
                    <section class="manager-review-files" aria-label="${escapeHtml(ui.workspace.fileChanges)}">
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
            if (!artifactListEl.querySelector('.manager-settings-page')) {
                artifactListEl.innerHTML = `
                    <div class="manager-settings-page">
                        <section class="manager-side-card manager-workspace-hero">
                            <div class="manager-card-title"></div>
                            <p></p>
                        </section>
                        <div id="managerSettingsHost" class="manager-settings-host">
                            <div class="manager-side-empty">${ui.settings.loading}</div>
                        </div>
                    </div>
                `;
            }
            const titleEl = artifactListEl.querySelector<HTMLElement>('.manager-settings-page .manager-card-title');
            const subtitleEl = artifactListEl.querySelector<HTMLElement>('.manager-settings-page .manager-workspace-hero p');
            if (titleEl) titleEl.textContent = state.settingsTitle || ui.settings.title;
            if (subtitleEl) subtitleEl.textContent = state.settingsSubtitle || ui.settings.subtitle;
            const host = artifactListEl.querySelector<HTMLElement>('#managerSettingsHost');
            if (host && state.settingsContent && state.settingsContent.parentElement !== host) {
                host.replaceChildren(state.settingsContent);
            } else if (host && !state.settingsContent && !host.firstElementChild) {
                host.innerHTML = `<div class="manager-side-empty">${ui.settings.loading}</div>`;
            }
            return;
        }

        if (activeTab === 'activity') {
            const run = state.run;
            const metrics = run?.metrics || { totalTokens: 0, promptTokens: 0, completionTokens: 0, costCny: 0, iterations: 0, toolCalls: 0 };
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

            const traceModel = buildAgentTraceModel(state.runEvents, {
                agentId: typeof run?.agentId === 'string' ? run.agentId : undefined,
                runId: typeof run?.runId === 'string' ? run.runId : undefined,
                status: typeof run?.status === 'string' ? run.status : undefined,
                startedAt: typeof run?.startedAt === 'number' ? run.startedAt : undefined,
                completedAt: typeof run?.completedAt === 'number' ? run.completedAt : undefined,
            });
            for (const childRun of state.childRuns) {
                if (!childRun.agentId || traceModel.nodes.some(node => node.agentId === childRun.agentId)) continue;
                traceModel.nodes.push({
                    agentId: childRun.agentId,
                    parentAgentId: childRun.parentAgentId || traceModel.rootAgentId,
                    role: childRun.mode,
                    status: childRun.status === 'completed' || childRun.status === 'done' ? 'done'
                        : childRun.status === 'failed' ? 'failed'
                            : childRun.status === 'cancelled' ? 'cancelled'
                                : childRun.status === 'running' ? 'running' : 'pending',
                    task: childRun.userPromptPreview,
                    startedAt: childRun.startedAt,
                    endedAt: childRun.completedAt,
                    eventCount: 0,
                    modelCallCount: 0,
                    toolCallCount: 0,
                    tokenCount: 0,
                });
            }
            if (!selectedAgentId || !traceModel.nodes.some(node => node.agentId === selectedAgentId)) {
                selectedAgentId = traceModel.rootAgentId;
            }
            const currentTopicTitle = state.topics.find(topic => topic.id === state.stats.currentTopicId)?.title
                || state.stats.currentTopicTitle
                || (typeof run?.userPromptPreview === 'string' ? run.userPromptPreview : '')
                || traceLabels.mainAgent;
            const agentTreeHtml = renderAgentTreeHTML(traceModel, selectedAgentId, traceLabels, { rootTitle: currentTopicTitle });
            const progressPercent = runProgressPercent(run);
            const startedAt = Number(run?.startedAt || run?.createdAt || Date.now());
            const finishedAt = Number(run?.completedAt || Date.now());
            const startedLabel = new Date(startedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const contextUsed = Number(run?.context?.estimatedPromptTokens || metrics.promptTokens || 0);
            const contextLimit = Number(run?.context?.contextLimit || 0);
            const contextPct = contextPercent(run);
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
            const artifactCardsHtml = state.artifacts.length ? state.artifacts.slice(0, 12).map((artifact: any) => `
                <button type="button" class="manager-side-item" data-manager-artifact-id="${escapeHtml(artifact.id)}">
                    <span class="manager-side-icon">${svgIconNoMargin(artifact.kind === 'diff' ? 'pencil' : artifact.kind === 'validation' ? 'check' : 'fileText')}</span>
                    <span class="manager-side-main">
                        <strong>${escapeHtml(artifact.title || artifact.kind || 'Artifact')}</strong>
                        <em>${escapeHtml(artifact.summary || artifact.status || artifact.kind || '')}</em>
                    </span>
                </button>
            `).join('') : `<div class="manager-side-empty">${ui.run.noArtifacts}</div>`;
            const usageStatsHtml = renderUsageStatsCard();
            const progress = state.orchestrator;
            const agentsHtml = progress ? `
                <section class="manager-activity-section manager-agents-section">
                    <div class="manager-activity-section-title"><strong>${ui.activity.agents}</strong><span>${m.agents.done} ${progress.done}/${progress.total} · ${m.agents.running} ${progress.running} · ${m.agents.failed} ${progress.failed}</span></div>
                    <div class="manager-agent-summary-line"><span>${m.agents.phase}: ${escapeHtml(progress.phase)}</span><em>${escapeHtml(progress.latestEvent || '')}</em></div>
                    <div class="manager-agent-lanes">
                        ${progress.lanes.map(lane => `
                            <article class="manager-agent-lane manager-agent-${escapeHtml(lane.status)}">
                                <span class="manager-agent-state" aria-hidden="true"></span>
                                <span class="manager-agent-main"><strong>${escapeHtml(lane.role)}</strong><em>${escapeHtml(lane.statusText || lane.taskNodeId)}</em></span>
                                <span class="manager-agent-metrics">${lane.stepCount} ${m.agents.steps} · ${compactNumber(lane.tokenUsed)} ${m.agents.tokens}</span>
                            </article>
                        `).join('')}
                    </div>
                </section>
            ` : '';
            const runtimeTasks = state.activity?.items.filter(item => item.kind === 'task' || item.kind === 'goal') ?? [];
            const tasksHtml = `
                <section class="manager-activity-section manager-tasks-section">
                    <div class="manager-activity-section-title"><strong>${ui.activity.tasks}</strong><span>${state.todos.length + runtimeTasks.length}</span></div>
                    <div class="manager-task-list">
                        ${runtimeTasks.map(item => `
                            <article class="manager-task-item manager-task-${escapeHtml(item.status)}">
                                <span class="manager-task-mark">${escapeHtml(item.kind === 'goal' ? 'G' : 'T')}</span>
                                <span>${escapeHtml(item.label)}${item.detail ? `<em>${escapeHtml(item.detail)}</em>` : ''}</span>
                            </article>
                        `).join('')}
                        ${state.todos.length ? state.todos.map(todo => `
                            <article class="manager-task-item manager-task-${escapeHtml(todo.status)}">
                                <span class="manager-task-mark">${taskStatusMark(todo.status)}</span>
                                <span>${escapeHtml(todo.content)}</span>
                            </article>
                        `).join('') : `<div class="manager-side-empty">${m.tasks.noTasks}</div>`}
                    </div>
                </section>
            `;
            const runtime = state.runtimeInspector;
            const runtimeInspectorHtml = runtime ? `
                <details class="manager-activity-diagnostics" open>
                    <summary>${locale === 'zh-cn' ? '运行时检查器' : 'Runtime Inspector'}</summary>
                    <div class="manager-activity-diagnostics-body">
                        <div class="manager-context-breakdown">
                            <span>${locale === 'zh-cn' ? '配置' : 'Profile'}: ${escapeHtml(runtime.profile || '-')}</span>
                            <span>${locale === 'zh-cn' ? '阶段' : 'Phase'}: ${escapeHtml(runtime.scheduling?.phase || '-')}</span>
                            <span>${locale === 'zh-cn' ? '授权' : 'Authorization'}: ${escapeHtml(runtime.scheduling?.authorization || runtime.tools?.authorization || '-')}</span>
                            <span>${locale === 'zh-cn' ? '调度' : 'Dispatch'}: ${escapeHtml(runtime.scheduling?.dispatch || '-')}</span>
                            <span>${locale === 'zh-cn' ? '叠加能力' : 'Overlays'}: ${escapeHtml(runtime.overlays.join(', ') || '-')}</span>
                            <span>${locale === 'zh-cn' ? '工具' : 'Tools'}: ${runtime.tools?.activated.length ?? 0}/${runtime.tools?.registered.length ?? 0} (${runtime.tools?.disclosed.length ?? 0} ${locale === 'zh-cn' ? '已披露' : 'disclosed'})</span>
                            <span>${locale === 'zh-cn' ? '提示队列' : 'Prompts'}: ${runtime.prompts.running}/${runtime.prompts.total}</span>
                            <span>${locale === 'zh-cn' ? '待交互' : 'Interactions'}: ${runtime.interactions.pending}/${runtime.interactions.total}</span>
                            <span>${locale === 'zh-cn' ? '转录' : 'Transcript'}: ${runtime.transcript.turns} turns · #${runtime.transcript.sequence} · ${escapeHtml(runtime.transcript.grade)}</span>
                            <span>${locale === 'zh-cn' ? '实体' : 'Entities'}: ${runtime.transcript.pendingEntities}/${runtime.transcript.entities} ${locale === 'zh-cn' ? '待处理' : 'pending'}</span>
                            <span>${locale === 'zh-cn' ? '模型' : 'Model'}: ${escapeHtml(runtime.model?.requested || '-')}${runtime.model?.effective && runtime.model.effective !== runtime.model.requested ? ` → ${escapeHtml(runtime.model.effective)}` : ''}${runtime.model?.bindingSource ? ` · ${escapeHtml(runtime.model.bindingSource)}` : ''}</span>
                            <span>${locale === 'zh-cn' ? '配置目录' : 'Profile catalog'}: r${runtime.profiles.revision} · ${runtime.profiles.profiles.length} profiles · ${runtime.profiles.sources.length} sources</span>
                        </div>
                        ${runtime.profiles.sources.some(source => source.error) ? `
                            <div class="run-written-files">
                                <strong>${locale === 'zh-cn' ? '配置源错误' : 'Profile source errors'}:</strong>
                                <ul>${runtime.profiles.sources.filter(source => source.error).map(source =>
                                    `<li><code>${escapeHtml(source.id)}</code> ${escapeHtml(source.error || '')}</li>`
                                ).join('')}</ul>
                            </div>
                        ` : ''}
                        ${runtime.permissions.length ? `
                            <div class="run-written-files">
                                <strong>${locale === 'zh-cn' ? '最近权限决策' : 'Recent permission decisions'}:</strong>
                                <ul>${runtime.permissions.slice(-8).reverse().map(entry =>
                                    `<li><code>${escapeHtml(entry.tool)}</code> ${escapeHtml(entry.decision)} · ${escapeHtml(entry.source)}</li>`
                                ).join('')}</ul>
                            </div>
                        ` : ''}
                    </div>
                </details>
            ` : '';
            const transcriptTurns = state.transcript?.turns.slice(-6) ?? [];
            const transcriptHtml = transcriptTurns.length > 0 ? `
                <section class="manager-activity-section">
                    <div class="manager-activity-section-title">
                        <strong>${locale === 'zh-cn' ? '规范转录' : 'Canonical transcript'}</strong>
                        <span>#${state.transcript?.sequence ?? 0}</span>
                    </div>
                    <div class="manager-task-list">
                        ${transcriptTurns.map(turn => {
                            const frames = turn.steps
                                .flatMap(step => step.frames)
                                .map(frame => frame.toolName
                                    ? `${frame.toolName}: ${frame.status || frame.kind}`
                                    : frame.text || frame.kind)
                                .filter(Boolean)
                                .join('\n')
                                .slice(0, 800);
                            return `
                                <article class="manager-task-item manager-task-${escapeHtml(turn.state)}">
                                    <span class="manager-task-mark">${escapeHtml(turn.state === 'completed' ? '✓' : turn.state === 'failed' ? '!' : '…')}</span>
                                    <span>
                                        <strong>${escapeHtml((turn.prompt || turn.turnId).slice(0, 160))}</strong>
                                        ${frames ? `<em>${escapeHtml(frames)}</em>` : ''}
                                    </span>
                                </article>
                            `;
                        }).join('')}
                    </div>
                </section>
            ` : '';
            const hasActivity = !!run || !!progress || state.todos.length > 0 || runtimeTasks.length > 0
                || state.artifacts.length > 0 || events.length > 0 || !!runtime;

            artifactListEl.innerHTML = `
                <div class="manager-activity-page">
                    ${run ? `
                        <header class="manager-run-summary manager-activity-hero">
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
                                <div class="run-metric-cell">${m.runs.metrics.tokens}: <strong>${compactNumber(metrics.totalTokens)}</strong></div>
                                <div class="run-metric-cell">${m.runs.metrics.cost}: <strong>¥${costLabel(metrics.costCny)}</strong></div>
                                <div class="run-metric-cell">${m.runs.metrics.tools}: <strong>${metrics.toolCalls} ${m.runs.metrics.calls}</strong></div>
                                <div class="run-metric-cell">${escapeHtml(formatDuration(finishedAt - startedAt))}</div>
                            </div>
                        </header>
                    ` : hasActivity ? `<header class="manager-activity-header"><strong>${ui.activity.title}</strong><span>${m.runs.noRun}</span></header>` : `<div class="manager-review-empty"><strong>${ui.activity.noActivity}</strong><span>${m.runs.noRun}</span></div>`}
                    ${run ? `
                        <section class="manager-activity-section manager-agent-explorer">
                            <div class="manager-activity-section-title manager-agent-explorer-title">
                                <strong>${traceLabels.conversation}</strong>
                                <span>${traceModel.nodes.length} ${traceModel.nodes.length === 1 ? traceLabels.mainAgent : traceLabels.subagent}</span>
                            </div>
                            <div class="manager-agent-task-list" aria-label="${traceLabels.conversation}">
                                ${agentTreeHtml}
                            </div>
                        </section>
                    ` : ''}
                    ${agentsHtml}
                    ${tasksHtml}
                    ${runtimeInspectorHtml}
                    ${transcriptHtml}
                    <section class="manager-activity-section">
                        <div class="manager-activity-section-title"><strong>${ui.activity.artifacts}</strong><span>${state.artifacts.length}</span></div>
                        <div class="manager-artifact-grid">${artifactCardsHtml}</div>
                    </section>
                    ${run ? `
                        <details class="manager-activity-diagnostics">
                            <summary>${ui.run.runDetails}</summary>
                            <div class="manager-activity-diagnostics-body">
                                ${contextHtml}
                                ${usageStatsHtml}
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
                            </div>
                        </details>
                    ` : ''}
                    ${memoryHtml}
                </div>
            `;
            markSelectedRunEvent();
            return;
        }
    }

    function markSelectedRunEvent(): void {
        document.querySelectorAll<HTMLElement>('[data-trace-event-id]').forEach(row => {
            row.classList.toggle('is-selected', !!state.selectedRunEventId && row.dataset.traceEventId === state.selectedRunEventId);
        });
    }

    function trajectoryEventById(eventId: string | undefined): AgentTraceEvent | undefined {
        return eventId ? state.runEvents.find(event => event.eventId === eventId) : undefined;
    }

    function trajectoryDetailHtml(selectedEvent: AgentTraceEvent): string {
        const copyLabel = state.copiedEventAt && Date.now() - state.copiedEventAt < 2500 ? m.runs.copiedEvent : m.runs.copyEventJson;
        return '<aside class="manager-trajectory-details"><header><span><i></i><strong>' + escapeHtml(selectedEvent.type) + '</strong><small>' + escapeHtml(selectedEvent.agentId || traceLabels.mainAgent) + '</small></span><button type="button" data-trajectory-close-details aria-label="Close">×</button></header>' +
            '<nav><span class="active">' + (locale === 'zh-cn' ? '摘要' : 'Summary') + '</span><span>Payload</span><span>Result</span><span>Timing</span></nav>' +
            '<div class="manager-trajectory-detail-body"><button type="button" class="run-action-btn" data-run-action="copy-event">' + escapeHtml(copyLabel) + '</button>' +
            renderInspectorHTML({ selectedEventId: state.selectedRunEventId, selectedEvent }, i18n) + '</div></aside>';
    }

    function updateTrajectoryDetails(): void {
        trajectoryView.querySelector('.manager-trajectory-details')?.remove();
        const selectedEvent = trajectoryDetailsOpen ? trajectoryEventById(state.selectedRunEventId) : undefined;
        if (!selectedEvent) {
            markSelectedRunEvent();
            return;
        }
        const ledger = trajectoryView.querySelector<HTMLElement>('.manager-trajectory-ledger');
        ledger?.insertAdjacentHTML('beforeend', trajectoryDetailHtml(selectedEvent));
        markSelectedRunEvent();
    }

    function renderTrajectoryView(): void {
        trajectoryView.hidden = mainView !== 'trajectory';
        if (mainView !== 'trajectory') return;

        const run = state.run;
        const events = getRenderableRunEvents(Array.isArray(state.runEvents) ? state.runEvents : []);
        if (!run || events.length === 0) {
            trajectoryView.innerHTML = '<div class="manager-trajectory-empty"><strong>' + escapeHtml(traceLabels.trajectory) + '</strong><span>' + escapeHtml(traceLabels.noTrajectory) + '</span></div>';
            return;
        }
        if (!state.selectedRunEventId || !events.some(event => event.eventId === state.selectedRunEventId)) {
            state.selectedRunEventId = undefined;
            trajectoryDetailsOpen = false;
        }
        const traceModel = buildAgentTraceModel(state.runEvents, {
            agentId: typeof run.agentId === 'string' ? run.agentId : undefined,
            runId: run.runId,
            status: run.status,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
        });
        if (!selectedAgentId || !traceModel.nodes.some(node => node.agentId === selectedAgentId)) {
            selectedAgentId = traceModel.rootAgentId;
        }
        const selectedAgentEvents = traceModel.eventsByAgent.get(selectedAgentId) ?? [];
        const modelCalls = events.filter(event => event.type === 'model_call_start').length;
        const toolCalls = events.filter(event => event.type === 'tool_call_start' || event.type === 'tool_call_created').length;
        const startedAt = Number(run.startedAt || run.createdAt || Date.now());
        const finishedAt = stableTrajectoryEndTime(run, state.runEvents);
        const duration = formatDuration(Math.max(0, finishedAt - startedAt));
        const eventRows = events.map(event => {
            const selected = event.eventId === state.selectedRunEventId;
            const time = new Date(event.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
            const name = typeof payload.toolName === 'string' ? payload.toolName
                : typeof payload.model === 'string' ? payload.model
                    : event.type.replace(/_/g, ' ');
            const summary = typeof payload.description === 'string' ? payload.description
                : typeof payload.reason === 'string' ? payload.reason
                    : typeof payload.filePath === 'string' ? payload.filePath : '';
            return '<button type="button" class="manager-trajectory-record' + (selected ? ' is-selected' : '') + '" data-trace-event-id="' + escapeHtml(event.eventId) + '">' +
                '<span class="manager-trajectory-selection"></span><time>' + escapeHtml(time) + '</time>' +
                '<span class="manager-trajectory-record-main"><strong>' + escapeHtml(name) + '</strong>' + (summary ? '<small>' + escapeHtml(summary) + '</small>' : '') + '</span>' +
                '<span class="manager-trajectory-record-agent">' + escapeHtml(event.agentId || traceLabels.mainAgent) + '</span>' +
                '<span class="manager-trajectory-record-status">' + escapeHtml(event.status || 'done') + '</span></button>';
        }).join('');
        trajectoryView.innerHTML = '<div class="manager-trajectory-shell">' +
            '<header class="manager-trajectory-toolbar"><span><strong>' + escapeHtml(traceLabels.trajectory) + '</strong><em>' + escapeHtml(duration) + '</em></span>' +
            '<span><b>' + traceModel.nodes.length + '</b> ' + escapeHtml(traceLabels.subagent) + '</span>' +
            '<span><b>' + modelCalls + '</b> ' + escapeHtml(traceLabels.modelCalls) + '</span>' +
            '<span><b>' + toolCalls + '</b> ' + escapeHtml(traceLabels.toolCalls) + '</span>' +
            '<span class="manager-trajectory-count">' + events.length + ' ' + escapeHtml(traceLabels.events) + '</span></header>' +
            '<div class="manager-trajectory-overview">' + renderTraceRailHTML(selectedAgentEvents.length ? selectedAgentEvents : events, state.selectedRunEventId, traceLabels, finishedAt, { includeList: false }) + '</div>' +
            '<div class="manager-trajectory-ledger"><main class="manager-trajectory-table"><header><span>Event</span><span>Content</span><span>Agent</span><span>Status</span></header><div>' + eventRows + '</div></main></div></div>';
        updateTrajectoryDetails();
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
        state.topics = snapshot.topics || [];
        state.stats = snapshot.stats || state.stats;
        syncTopicScopedState(state.stats.currentTopicId);
        state.artifacts = snapshot.artifacts || [];
        state.activity = snapshot.activity;
        state.runtimeInspector = snapshot.runtimeInspector;
        state.transcript = snapshot.transcript;
        lastWorkspaceRenderSignature = '';
        state.mode = snapshot.mode || state.mode;
        state.agentProfile = snapshot.agentProfile || state.agentProfile;
        state.resolvedAgentProfile = snapshot.resolvedAgentProfile;
        state.workflowId = snapshot.workflowId || null;
        state.isGenerating = !!snapshot.isGenerating;
        state.liveStepCount = snapshot.liveStepCount || 0;
        state.todos = snapshot.todos || [];
        state.messageCount = typeof snapshot.messageCount === 'number'
            ? snapshot.messageCount
            : snapshot.messages?.filter(message => !message.isHidden).length || 0;
        syncSuggestedPrimaryTab();
        renderOverview();
        renderInspector();
    }

    function applyEmbeddedWorkbenchContent(detail: any): void {
        const kind = detail?.kind === 'settings' ? 'settings' : String(detail?.kind || 'workspace');
        const content = detail?.content instanceof HTMLElement ? detail.content : null;
        if (kind === 'settings') {
            settingsRequestPending = false;
            state.settingsContent = content;
            state.settingsTitle = detail?.title || ui.settings.title;
            state.settingsSubtitle = detail?.subtitle || ui.settings.subtitle;
            setManagerDrawerOpen(true);
            if (activeTab === 'settings') {
                renderInspector();
            } else {
                setActiveTab('settings', { suppressSettingsRequest: true });
            }
            return;
        }
        if (content) {
            const entries = state.workspaceEntries ? [...state.workspaceEntries] : [];
            const sourceKey = String(detail?.sourceKey || kind || 'workspace');
            const existingIndex = entries.findIndex(entry => entry.sourceKey === sourceKey || entry.content === content);
            const nextEntry = {
                content,
                title: detail?.title || ui.workspace.title,
                subtitle: detail?.subtitle || '',
                kind,
                sourceKey,
                wide: !!detail?.wide,
            };
            const previousEntry = existingIndex >= 0 ? entries[existingIndex] : undefined;
            const changedEntry = !previousEntry
                || previousEntry.content !== nextEntry.content
                || previousEntry.title !== nextEntry.title
                || previousEntry.subtitle !== nextEntry.subtitle
                || previousEntry.kind !== nextEntry.kind
                || previousEntry.sourceKey !== nextEntry.sourceKey;
            if (existingIndex >= 0) entries[existingIndex] = nextEntry;
            else entries.push(nextEntry);
            if (changedEntry) {
                workspaceRenderRevision++;
                lastWorkspaceRenderSignature = '';
            }
            state.workspaceEntries = entries;
            state.workspaceContent = content;
            state.workspaceTitle = nextEntry.title;
            state.workspaceSubtitle = nextEntry.subtitle;
        }
        setManagerDrawerOpen(true);
        if (activeTab === 'settings') {
            renderOverview();
            renderInspector();
        } else {
            setActiveTab('changes');
        }
    }

    function applyHostMessage(input: unknown): void {
        const validatedMessage = parseHostMessage(input);
        if (!validatedMessage) return;
        const msg: any = validatedMessage;
        switch (msg?.type) {
            case 'managerSnapshot':
                updateFromSnapshot(msg as ManagerSnapshotMessage);
                break;
            case 'activitySnapshot':
                state.activity = msg.activity;
                renderOverview();
                renderInspector();
                break;
            case 'runtimeInspectorSnapshot':
                state.runtimeInspector = msg.runtimeInspector;
                renderOverview();
                renderInspector();
                break;
            case 'transcriptSnapshot':
                state.transcript = msg.transcript;
                renderOverview();
                renderInspector();
                break;
            case 'runSnapshot':
                state.run = msg.snapshot;
                state.runEvents = Array.isArray(msg.events) ? msg.events : [];
                state.childRuns = Array.isArray(msg.childRuns) ? msg.childRuns : [];
                lastWorkspaceRenderSignature = '';
                setRunCacheStats(msg.snapshot?.runId, msg.cacheStats);
                syncSuggestedPrimaryTab();
                renderOverview();
                renderInspector();
                renderTrajectoryView();
                break;
            case 'compactedMemoryResult':
                state.compactedMemoryContent = msg.content || '';
                if (activeTab !== 'activity') {
                    setActiveTab('activity');
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
                renderTrajectoryView();
                break;
            case 'topicList':
                {
                    state.topics = msg.topics || [];
                    state.stats = msg.stats || state.stats;
                    syncTopicScopedState(state.stats.currentTopicId);
                    renderOverview();
                    renderInspector();
                    renderTrajectoryView();
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
                resetTopicScopedWorkbenchState({ preserveCache: true });
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
                lastWorkspaceRenderSignature = '';
                renderOverview();
                renderInspector();
                renderTrajectoryView();
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
                if (msg.agentId) break;
                state.todos = msg.todos || [];
                renderOverview();
                renderInspector();
                break;
            case 'replaySteps':
                state.liveStepCount = Array.isArray(msg.steps) ? msg.steps.length : 0;
                state.isGenerating = !!msg.isGenerating;
                renderOverview();
                break;
            case 'agentStep':
                state.liveStepCount += 1;
                {
                    const wasGenerating = state.isGenerating;
                    state.isGenerating = true;
                    if (!wasGenerating) renderOverview();
                }
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

    // Body class churn includes theme/zoom toggles from the host and
    // manager-resizing during pane drags; only react when the artifact drawer
    // state actually flips (drawer open/close and pane width have explicit
    // persistence paths of their own).
    const drawerObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.attributeName !== 'class') continue;
            const target = mutation.target as HTMLElement;
            const wasOpen = (mutation.oldValue ?? '').includes('artifact-drawer-open');
            if (wasOpen === target.classList.contains('artifact-drawer-open')) continue;
            persistManagerUiState();
            renderOverview();
            break;
        }
    });
    drawerObserver.observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

    renderOverview();
    renderInspector();
    renderTrajectoryView();
})();

(window as any).__cwtoolsPostReady?.();
