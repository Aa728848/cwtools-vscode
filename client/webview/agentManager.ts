import './chatPanel';
import { escapeHtml } from './chat/formatters';
import type { ManagerSnapshotMessage, OrchestratorProgressMessage } from './chat/messages.manager';
import type { TopicListItem, TopicStats } from './chat/messages.shared';

type ManagerTab = 'agents' | 'artifacts' | 'tasks';

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

    const overview = document.createElement('div');
    overview.className = 'manager-overview';
    overview.id = 'managerOverview';
    topicsSummary.insertAdjacentElement('afterend', overview);

    const tabs = document.createElement('div');
    tabs.className = 'manager-inspector-tabs artifact-filter-row';
    tabs.innerHTML = `
        <button type="button" class="artifact-filter active" data-manager-tab="agents">Agents</button>
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

    function currentTopicMessageCount(): number {
        const currentId = state.stats.currentTopicId;
        if (!currentId) return state.messageCount;
        return state.topics.find(topic => topic.id === currentId)?.messageCount ?? state.messageCount;
    }

    function renderOverview(): void {
        overview.innerHTML = `
            <div class="manager-overview-row">
                <span class="manager-pill">${state.stats.visible} Topics</span>
                <span class="manager-pill">${state.artifacts.length} Artifacts</span>
                <span class="manager-pill">${state.liveStepCount} Steps</span>
                <span class="manager-pill">${currentTopicMessageCount()} Messages</span>
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
                        <div class="artifact-item-title">${escapeHtml(todo.content)}</div>
                        <div class="artifact-meta">${escapeHtml(todo.status.replace('_', ' '))}</div>
                    </article>
                `).join('')
                : '<div class="artifact-empty">No tasks yet</div>';
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
                state.messageCount = (msg.messages || []).filter((message: { isHidden?: boolean }) => !message.isHidden).length;
                renderOverview();
                break;
            case 'clearChat':
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
