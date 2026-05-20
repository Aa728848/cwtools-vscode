import './chatPanel';
import { escapeHtml } from './chat/formatters';
import { renderInspectorHTML } from './chat/runInspector';
import { groupTimelineEvents, renderTimelineHTML } from './chat/runTimeline';
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
    compactedMemoryContent?: string;
    cleanupResult?: { deletedCount: number; keptCount: number; reclaimedBytes: number };
    copiedEventAt?: number;
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

    const overview = document.createElement('div');
    overview.className = 'manager-overview';
    overview.id = 'managerOverview';
    topicsSummary.insertAdjacentElement('afterend', overview);

    const tabs = document.createElement('div');
    tabs.className = 'manager-inspector-tabs artifact-filter-row';
    tabs.innerHTML = `
        <button type="button" class="artifact-filter active" data-manager-tab="agents">Agents</button>
        <button type="button" class="artifact-filter" data-manager-tab="runs">Runs</button>
        <button type="button" class="artifact-filter" data-manager-tab="artifacts">Artifacts</button>
        <button type="button" class="artifact-filter" data-manager-tab="tasks">Tasks</button>
    `;
    artifactDrawerEl.querySelector('.artifact-drawer-header')?.after(tabs);
    artifactDrawerEl.setAttribute('data-active-tab', activeTab);

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
                    });
                }
            }
            return;
        }

        const eventRow = target?.closest<HTMLElement>('.timeline-event');
        if (activeTab === 'runs' && eventRow?.dataset.eventId) {
            state.selectedRunEventId = eventRow.dataset.eventId;
            renderInspector();
        }
    });

    function currentTopicMessageCount(): number {
        const currentId = state.stats.currentTopicId;
        if (!currentId) return state.messageCount;
        return state.topics.find(topic => topic.id === currentId)?.messageCount ?? state.messageCount;
    }

    function renderOverview(): void {
        const runPill = state.run
            ? `<span class="manager-pill manager-pill-run">Run: ${escapeHtml(state.run.runId.substring(0, 10))} (${escapeHtml(state.run.status)})</span>`
            : '';
        overview.innerHTML = `
            <div class="manager-overview-row">
                <span class="manager-pill">${state.stats.visible} Topics</span>
                <span class="manager-pill">${state.artifacts.length} Artifacts</span>
                <span class="manager-pill">${state.liveStepCount} Steps</span>
                <span class="manager-pill">${currentTopicMessageCount()} Messages</span>
                ${runPill}
            </div>
            <div class="manager-overview-row">
                <span class="manager-meta">Mode: ${escapeHtml(state.mode)}</span>
                <span class="manager-meta">Workflow: ${escapeHtml(state.workflowId || 'none')}</span>
                <span class="manager-meta">Status: ${state.isGenerating ? 'running' : 'idle'}</span>
            </div>
        `;
    }

    function setActiveTab(nextTab: ManagerTab): void {
        activeTab = nextTab;
        artifactDrawerEl.setAttribute('data-active-tab', activeTab);
        tabs.querySelectorAll<HTMLElement>('[data-manager-tab]').forEach(button => {
            button.classList.toggle('active', button.dataset.managerTab === activeTab);
        });

        if (activeTab === 'artifacts') {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'artifactList', artifacts: state.artifacts },
            }));
            return;
        }

        renderInspector();
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
                : '<div class="artifact-empty">No tasks yet</div>';
            return;
        }

        if (activeTab === 'runs') {
            const run = state.run;
            if (!run) {
                artifactListEl.innerHTML = '<div class="artifact-empty">No active run recorded</div>';
                return;
            }

            const metrics = run.metrics || { totalTokens: 0, promptTokens: 0, completionTokens: 0, costCny: 0, iterations: 0, toolCalls: 0 };
            const steps = run.steps || [];
            const events = Array.isArray(state.runEvents) ? state.runEvents : [];
            if (events.length > 0 && (!state.selectedRunEventId || !events.some((evt: any) => evt.eventId === state.selectedRunEventId))) {
                state.selectedRunEventId = events[events.length - 1]?.eventId;
            }
            if (events.length === 0) {
                state.selectedRunEventId = undefined;
            }
            const selectedEvent = events.find((evt: any) => evt.eventId === state.selectedRunEventId);
            const context = run.context || {};
            const contextMeter = context.estimatedPromptTokens && context.contextLimit ? {
                estimatedPromptTokens: context.estimatedPromptTokens,
                contextLimit: context.contextLimit,
                percentage: Math.round((context.estimatedPromptTokens / context.contextLimit) * 100),
            } : undefined;
            const eventTimelineHtml = events.length
                ? renderTimelineHTML(groupTimelineEvents(events))
                : '';
            const eventInspectorHtml = renderInspectorHTML({
                selectedEventId: state.selectedRunEventId,
                selectedEvent,
                contextMeter,
            });
            const cleanupHtml = state.cleanupResult ? `
                <div class="run-action-note">
                    Cleaned ${state.cleanupResult.deletedCount} large result file(s), kept ${state.cleanupResult.keptCount}, reclaimed ${formatBytes(state.cleanupResult.reclaimedBytes)}.
                </div>
            ` : '';
            const memoryHtml = state.compactedMemoryContent ? `
                <details class="run-memory-panel" open>
                    <summary>Compacted Memory</summary>
                    <pre>${escapeHtml(state.compactedMemoryContent)}</pre>
                </details>
            ` : '';
            const copyLabel = state.copiedEventAt && Date.now() - state.copiedEventAt < 2500 ? 'Copied Event' : 'Copy Event JSON';
            const subAgentChangeSets = events
                .filter((evt: any) => evt.type === 'subagent_end' && Array.isArray(evt.payload?.filesWritten) && evt.payload.filesWritten.length > 0);
            const subAgentChangeHtml = subAgentChangeSets.length ? `
                <details class="run-subagent-change-set">
                    <summary>Sub-Agent Change Sets (${subAgentChangeSets.length})</summary>
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

            const stepsHtml = steps.map((step: any) => {
                let icon = '💭';
                let title = 'Thought / reasoning';
                let contentClass = 'run-step-thought';
                let body = '';

                if (step.type === 'thinking') {
                    icon = '🧠';
                    title = 'Thinking process';
                    body = escapeHtml(step.content || '');
                } else if (step.type === 'tool_call' || step.toolName) {
                    icon = '⚙️';
                    title = `Tool Call: ${escapeHtml(step.toolName)}`;
                    contentClass = 'run-step-tool';
                    const argsStr = step.toolArgs ? JSON.stringify(step.toolArgs, null, 2) : '';
                    body = `<pre class="run-step-code"><code>${escapeHtml(argsStr)}</code></pre>`;
                } else if (step.type === 'tool_result') {
                    icon = '📦';
                    title = `Tool Result: ${escapeHtml(step.toolName)}`;
                    contentClass = 'run-step-result';
                    const resStr = typeof step.toolResult === 'object' ? JSON.stringify(step.toolResult, null, 2) : String(step.toolResult || '');
                    body = `<pre class="run-step-code"><code>${escapeHtml(resStr)}</code></pre>`;
                } else if (step.type === 'error') {
                    icon = '⚠️';
                    title = 'Execution Error';
                    contentClass = 'run-step-error';
                    body = escapeHtml(step.content || '');
                } else if (step.content) {
                    body = escapeHtml(step.content);
                }

                return `
                    <div class="run-step-item ${contentClass}">
                        <div class="run-step-header">
                            <span class="run-step-icon">${icon}</span>
                            <span class="run-step-title">${title}</span>
                            <span class="run-step-time">${step.timestamp ? new Date(step.timestamp).toLocaleTimeString() : ''}</span>
                        </div>
                        ${body ? `<div class="run-step-body">${body}</div>` : ''}
                    </div>
                `;
            }).join('');

            artifactListEl.innerHTML = `
                <article class="artifact-item manager-run-summary">
                    <div class="artifact-item-title">Run ID: ${escapeHtml(run.runId)}</div>
                    <div class="artifact-item-summary">Status: <span class="run-status-pill run-status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></div>
                    <div class="run-metrics-grid">
                        <div class="run-metric-cell">Tokens: <strong>${metrics.totalTokens}</strong> (${metrics.promptTokens} in / ${metrics.completionTokens} out)</div>
                        <div class="run-metric-cell">Cost: <strong>¥${metrics.costCny?.toFixed(4) || '0.0000'}</strong></div>
                        <div class="run-metric-cell">Tools: <strong>${metrics.toolCalls} calls</strong></div>
                    </div>
                    <div class="run-action-row">
                        <button type="button" class="run-action-btn" data-run-action="memory">Open Memory</button>
                        <button type="button" class="run-action-btn" data-run-action="copy-event" ${selectedEvent ? '' : 'disabled'}>${copyLabel}</button>
                        <button type="button" class="run-action-btn" data-run-action="cleanup-results">Clean Large Results</button>
                    </div>
                    ${cleanupHtml}
                    ${run.writtenFiles?.length ? `
                        <div class="run-written-files">
                            <strong>Modified Files:</strong>
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
                    <div class="run-inspector-container">
                        ${eventInspectorHtml}
                    </div>
                ` : ''}
                ${memoryHtml}
                <div class="run-timeline-container">
                    ${stepsHtml || '<div class="artifact-empty">No steps recorded in this run</div>'}
                </div>
            `;
            markSelectedRunEvent();
            return;
        }

        const progress = state.orchestrator;
        if (!progress) {
            artifactListEl.innerHTML = '<div class="artifact-empty">No active orchestrator lanes</div>';
            return;
        }

        artifactListEl.innerHTML = `
            <article class="artifact-item manager-agent-summary">
                <div class="artifact-item-title">Phase: ${escapeHtml(progress.phase)}</div>
                <div class="artifact-item-summary">Done ${progress.done}/${progress.total}, Running ${progress.running}, Failed ${progress.failed}</div>
                <div class="artifact-meta">${escapeHtml(progress.latestEvent || '')}</div>
            </article>
            ${progress.lanes.map(lane => `
                <article class="artifact-item manager-agent-lane manager-agent-${escapeHtml(lane.status)}">
                    <div class="artifact-item-title">${escapeHtml(lane.role)} / ${escapeHtml(lane.status)}</div>
                    <div class="artifact-item-summary">Task ${escapeHtml(lane.taskNodeId)} / steps ${lane.stepCount} / tokens ${lane.tokenUsed}</div>
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
        state.messageCount = snapshot.messages?.filter(message => !message.isHidden).length || 0;
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

    renderOverview();
    renderInspector();
})();

(window as any).__cwtoolsPostReady?.();
