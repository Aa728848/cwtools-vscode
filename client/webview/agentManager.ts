import './chatPanel';
import { escapeHtml } from './chat/formatters';
import { renderInspectorHTML } from './chat/runInspector';
import { groupTimelineEvents, renderTimelineHTML } from './chat/runTimeline';
import { getChatI18n, normalizeChatLocale } from './chat/i18n';
import { svgIcon, svgIconNoMargin } from './svgIcons';
import type { ManagerSnapshotMessage, OrchestratorProgressMessage } from './chat/messages.manager';
import type { TopicListItem, TopicStats } from './chat/messages.shared';

type ManagerTab = 'agents' | 'runs' | 'artifacts' | 'tasks';

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
    let activeTab: ManagerTab = 'agents';
    const vscode = (window as any).__cwtoolsVscode;

    // 从 HTML body 的 data-locale 属性读取 locale（由 agentManagerHtml.ts 注入）
    const locale = normalizeChatLocale((document.body as HTMLElement).dataset.locale);
    const i18n = getChatI18n(locale);
    const m = i18n.manager;
    const RUN_MAX_RENDERED_EVENTS = 300;

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

    const overview = document.createElement('div');
    overview.className = 'manager-overview';
    overview.id = 'managerOverview';
    topicsSummary.insertAdjacentElement('afterend', overview);

    const tabs = document.createElement('div');
    tabs.className = 'manager-inspector-tabs artifact-filter-row';
    tabs.innerHTML = `
        <button type="button" class="artifact-filter active" data-manager-tab="agents">${m.tabs.agents}</button>
        <button type="button" class="artifact-filter" data-manager-tab="runs">${m.tabs.runs}</button>
        <button type="button" class="artifact-filter" data-manager-tab="artifacts">${m.tabs.artifacts}</button>
        <button type="button" class="artifact-filter" data-manager-tab="tasks">${m.tabs.tasks}</button>
    `;
    artifactDrawerEl.querySelector('.artifact-drawer-header')?.after(tabs);
    artifactDrawerEl.setAttribute('data-active-tab', activeTab);

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

    tabs.addEventListener('click', event => {
        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-manager-tab]');
        if (!button) return;
        const nextTab = button.dataset.managerTab as ManagerTab | undefined;
        if (!nextTab) return;
        setActiveTab(nextTab);
    });

    artifactListEl.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
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
                        renderInspectorSlider();
                    });
                }
            }
            return;
        }

        // 时间线分组折叠切换（问题5）
        const groupHeader = target?.closest<HTMLElement>('.timeline-group-header');
        if (groupHeader) {
            const groupEl = groupHeader.closest<HTMLElement>('.timeline-group');
            groupEl?.classList.toggle('collapsed');
            return;
        }

        // 点击事件行 → 打开次级 inspector 侧滑栏（问题4）
        const eventRow = target?.closest<HTMLElement>('.timeline-event');
        if (activeTab === 'runs' && eventRow?.dataset.eventId) {
            state.selectedRunEventId = eventRow.dataset.eventId;
            state.inspectorPanelOpen = true;
            markSelectedRunEvent();
            renderInspectorSlider();
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

    function renderOverview(): void {
        const runPill = state.run
            ? `<span class="manager-pill manager-pill-run">${m.overview.run}: ${escapeHtml(state.run.runId.substring(0, 10))} (${escapeHtml(state.run.status)})</span>`
            : '';
        // T3.3 — cache hit-rate badge. Only show when we have at least one cache_stats event.
        let cachePill = '';
        const cs = state.cacheStats;
        if (cs && cs.totalInputTokens > 0) {
            const pct = Math.round(cs.aggregateHitRate * 100);
            const saved = cs.totalSavedCostCny.toFixed(3);
            const cls = pct >= 70 ? 'manager-pill-cache-good' : pct >= 30 ? 'manager-pill-cache-mid' : 'manager-pill-cache-low';
            cachePill = `<span class="manager-pill manager-pill-cache ${cls}" title="cached ${cs.totalCachedTokens} / ${cs.totalInputTokens} input tokens · saved ≈ ¥${saved}">Cache ${pct}% · ¥${saved}</span>`;
        }
        overview.innerHTML = `
            <div class="manager-overview-row">
                <span class="manager-pill">${state.stats.visible} ${m.overview.topics}</span>
                <span class="manager-pill">${state.artifacts.length} ${m.overview.artifacts}</span>
                <span class="manager-pill">${state.liveStepCount} ${m.overview.steps}</span>
                <span class="manager-pill">${currentTopicMessageCount()} ${m.overview.messages}</span>
                ${runPill}
                ${cachePill}
            </div>
            <div class="manager-overview-row">
                <span class="manager-meta">${m.overview.mode}: ${escapeHtml(state.mode)}</span>
                <span class="manager-meta">${m.overview.workflow}: ${escapeHtml(state.workflowId || m.overview.none)}</span>
                <span class="manager-meta">${m.overview.status}: ${state.isGenerating ? m.overview.running : m.overview.idle}</span>
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
            const eventTimelineHtml = eventGroups.length ? renderTimelineHTML(eventGroups, true) : '';

            artifactListEl.innerHTML = `
                <article class="artifact-item manager-run-summary">
                    <div class="artifact-item-title">${m.runs.runId}: ${escapeHtml(run.runId)}</div>
                    <div class="artifact-item-summary">${m.runs.status}: <span class="run-status-pill run-status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></div>
                    <div class="run-metrics-grid">
                        <div class="run-metric-cell">${m.runs.metrics.tokens}: <strong>${metrics.totalTokens}</strong> (${metrics.promptTokens} in / ${metrics.completionTokens} out)</div>
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
                        ${eventTimelineHtml}
                    </div>
                ` : ''}
                ${memoryHtml}
            `;
            markSelectedRunEvent();
            if (state.inspectorPanelOpen) {
                renderInspectorSlider();
            }
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
        state.topics = snapshot.topics || [];
        state.stats = snapshot.stats || state.stats;
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

    function applyHostMessage(msg: any): void {
        switch (msg?.type) {
            case 'managerSnapshot':
                updateFromSnapshot(msg as ManagerSnapshotMessage);
                break;
            case 'runSnapshot':
                state.run = msg.snapshot;
                state.runEvents = Array.isArray(msg.events) ? msg.events : [];
                state.cacheStats = msg.cacheStats;
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
                state.topics = msg.topics || [];
                state.stats = msg.stats || state.stats;
                renderOverview();
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
                renderOverview();
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

    window.addEventListener('message', event => applyHostMessage(event.data));

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
            }
        }
    });
    drawerObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    renderOverview();
    renderInspector();
})();

(window as any).__cwtoolsPostReady?.();
