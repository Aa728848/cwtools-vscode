import type { ChatSurfaceHostMessage } from './chat/messages.chat';
import type { ManagerSnapshotMessage, ManagerWebviewMessage, OrchestratorProgressMessage } from './chat/messages.manager';
import type { TopicListItem, TopicStats } from './chat/messages.shared';

type ManagerState = {
    topics: TopicListItem[];
    stats: TopicStats;
    messages: Array<{ role: 'user' | 'assistant'; content: string; displayContent?: string; code?: string; isHidden?: boolean }>;
    artifacts: Array<{ id: string; kind: string; title: string; summary?: string; status?: string; createdAt?: number }>;
    todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>;
    mode: string;
    workflowId: string | null;
    isGenerating: boolean;
    liveStepCount: number;
    orchestrator: OrchestratorProgressMessage['progress'] | null;
};

type ManagerMode = 'build' | 'plan' | 'explore' | 'utility' | 'review' | 'orchestrator';

const DEFAULT_STATE: ManagerState = {
    topics: [],
    stats: { total: 0, visible: 0, archived: 0, currentTopicId: null, currentTopicTitle: null },
    messages: [],
    artifacts: [],
    todos: [],
    mode: 'build',
    workflowId: null,
    isGenerating: false,
    liveStepCount: 0,
    orchestrator: null,
};

function escapeHtml(value: string): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTime(ts?: number): string {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

(function bootAgentManager() {
    const vscode = acquireVsCodeApi();

    const chatArea = document.getElementById('chatArea') as HTMLDivElement | null;
    const input = document.getElementById('input') as HTMLDivElement | null;
    const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement | null;
    const topicsList = document.getElementById('topicsList') as HTMLDivElement | null;
    const topicsSummary = document.getElementById('topicsPanelSummary') as HTMLDivElement | null;
    const topicSearch = document.getElementById('topicsSearch') as HTMLInputElement | null;
    const showArchivedCb = document.getElementById('showArchivedCb') as HTMLInputElement | null;
    const currentTopicTitle = document.getElementById('currentTopicTitle') as HTMLButtonElement | null;
    const modeSel = document.getElementById('modeSel') as HTMLSelectElement | null;
    const btnNewTopic = document.getElementById('btnNewTopic') as HTMLButtonElement | null;
    const btnNewTopicPanel = document.getElementById('btnNewTopicPanel') as HTMLButtonElement | null;

    const artifactDrawer = document.getElementById('artifactDrawer') as HTMLElement | null;
    const artifactList = document.getElementById('artifactList') as HTMLElement | null;

    if (!chatArea || !input || !sendBtn || !topicsList || !topicsSummary || !artifactDrawer || !artifactList) return;
    const chatAreaEl = chatArea;
    const inputEl = input;
    const sendBtnEl = sendBtn;
    const topicsListEl = topicsList;
    const topicsSummaryEl = topicsSummary;
    const artifactDrawerEl = artifactDrawer;
    const artifactListEl = artifactList;

    const state: ManagerState = { ...DEFAULT_STATE };
    const pendingSearchState = { query: '' };

    function postMessage(message: ManagerWebviewMessage) {
        vscode.postMessage(message);
    }

    function getInputText(): string {
        return (inputEl.textContent || '').replace(/\u00a0/g, ' ').trim();
    }

    function clearInput(): void {
        inputEl.textContent = '';
    }

    function sendMessage(): void {
        const text = getInputText();
        if (!text || state.isGenerating) return;
        postMessage({ type: 'sendMessage', text });
        clearInput();
    }

    function updateHeader(): void {
        if (currentTopicTitle) {
            currentTopicTitle.textContent = state.stats.currentTopicTitle || '新话题';
        }
        if (modeSel) {
            modeSel.value = state.mode || 'build';
        }
        sendBtnEl.textContent = state.isGenerating ? '停止' : '发送';
    }

    function renderMessages(): void {
        const frag = document.createDocumentFragment();
        for (const msg of state.messages) {
            if (msg.isHidden) continue;
            const outer = document.createElement('div');
            outer.className = `message ${msg.role === 'assistant' ? 'assistant' : 'user'}`;
            const bubble = document.createElement('div');
            bubble.className = 'msg-bubble';
            if (msg.role === 'assistant') {
                const text = (msg.content || '').trim();
                const code = (msg.code || '').trim();
                bubble.innerHTML = `${text ? `<div class="assistant-text">${escapeHtml(text)}</div>` : ''}${code ? `<pre class="md-codeblock"><code>${escapeHtml(code)}</code></pre>` : ''}`;
            } else {
                bubble.textContent = msg.displayContent || msg.content || '';
            }
            outer.appendChild(bubble);
            frag.appendChild(outer);
        }
        chatAreaEl.innerHTML = '';
        chatAreaEl.appendChild(frag);
        chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
    }

    function renderTopics(): void {
        const topics = [...state.topics].sort((a, b) => {
            const pinA = a.pinned ? 1 : 0;
            const pinB = b.pinned ? 1 : 0;
            if (pinA !== pinB) return pinB - pinA;
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        });

        const grouped = new Map<string, TopicListItem[]>();
        for (const topic of topics) {
            const key = topic.workspaceLabel || topic.workspaceId || 'Default Workspace';
            const arr = grouped.get(key) || [];
            arr.push(topic);
            grouped.set(key, arr);
        }

        topicsListEl.innerHTML = '';
        for (const [groupName, items] of grouped) {
            const groupHeader = document.createElement('div');
            groupHeader.className = 'topic-date-group';
            groupHeader.textContent = groupName;
            topicsListEl.appendChild(groupHeader);

            for (const topic of items) {
                const row = document.createElement('div');
                row.className = `topic-item ${topic.id === state.stats.currentTopicId ? 'topic-item-active' : ''} ${topic.archived ? 'topic-item-archived' : ''}`;
                row.innerHTML = `
                    <div class="topic-main">
                        <div class="topic-head">
                            <span class="topic-title">${escapeHtml(topic.title)}</span>
                            ${topic.pinned ? '<span class="topic-state topic-state-current">置顶</span>' : ''}
                            ${topic.archived ? '<span class="topic-state topic-state-archived">归档</span>' : ''}
                        </div>
                        <div class="topic-meta-row">
                            <span class="topic-meta-chip">消息 ${topic.messageCount ?? 0}</span>
                            <span class="topic-meta-chip">更新 ${formatTime(topic.updatedAt)}</span>
                        </div>
                    </div>
                    <div class="topic-actions">
                        <button class="topic-action-btn" data-act="pin" title="置顶">📌</button>
                        <button class="topic-action-btn" data-act="workspace" title="工作区分组">🗂</button>
                    </div>
                `;
                row.addEventListener('click', () => postMessage({ type: 'loadTopic', topicId: topic.id }));
                row.querySelector('[data-act="pin"]')?.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    postMessage({ type: 'pinTopic', topicId: topic.id, pinned: !topic.pinned });
                });
                row.querySelector('[data-act="workspace"]')?.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const current = topic.workspaceLabel || topic.workspaceId || '';
                    const inputValue = window.prompt('输入工作区分组名（留空清除）', current);
                    if (inputValue === null) return;
                    const next = inputValue.trim();
                    postMessage({
                        type: 'setTopicWorkspace',
                        topicId: topic.id,
                        workspaceId: next || null,
                        workspaceLabel: next || null,
                    });
                });
                topicsListEl.appendChild(row);
            }
        }

        topicsSummaryEl.innerHTML = `
            <div class="manager-overview">
                <div class="manager-overview-row">
                    <span class="manager-pill">${state.stats.visible} Topics</span>
                    <span class="manager-pill">${state.artifacts.length} Artifacts</span>
                    <span class="manager-pill">${state.liveStepCount} Steps</span>
                    <span class="manager-pill">${state.messages.length} Messages</span>
                </div>
                <div class="manager-overview-row">
                    <span class="manager-meta">Mode: ${escapeHtml(state.mode)}</span>
                    <span class="manager-meta">Workflow: ${escapeHtml(state.workflowId || 'none')}</span>
                    <span class="manager-meta">Status: ${state.isGenerating ? 'running' : 'idle'}</span>
                </div>
            </div>
        `;
    }

    function renderInspector(): void {
        artifactDrawerEl.setAttribute('aria-hidden', 'false');
        if (!artifactDrawerEl.querySelector('.manager-inspector-tabs')) {
            const tabs = document.createElement('div');
            tabs.className = 'manager-inspector-tabs artifact-filter-row';
            tabs.innerHTML = `
                <button type="button" class="artifact-filter active" data-tab="agents">Agents</button>
                <button type="button" class="artifact-filter" data-tab="artifacts">Artifacts</button>
                <button type="button" class="artifact-filter" data-tab="tasks">Tasks</button>
            `;
            artifactDrawerEl.querySelector('.artifact-drawer-header')?.after(tabs);
            tabs.addEventListener('click', (ev) => {
                const target = ev.target as HTMLElement;
                const btn = target.closest<HTMLButtonElement>('[data-tab]');
                if (!btn) return;
                const tab = btn.dataset.tab || 'agents';
                artifactDrawerEl.setAttribute('data-active-tab', tab);
                tabs.querySelectorAll('[data-tab]').forEach(el => el.classList.remove('active'));
                btn.classList.add('active');
                renderInspector();
            });
            artifactDrawerEl.setAttribute('data-active-tab', 'agents');
        }

        const tab = artifactDrawerEl.getAttribute('data-active-tab') || 'agents';
        if (tab === 'artifacts') {
            const artifacts = [...state.artifacts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            artifactListEl.innerHTML = artifacts.length
                ? artifacts.map(artifact => `
                    <article class="artifact-item artifact-kind-${escapeHtml(artifact.kind)}">
                        <div class="artifact-item-title">${escapeHtml(artifact.title)}</div>
                        <div class="artifact-item-summary">${escapeHtml(artifact.summary || '')}</div>
                        <div class="artifact-meta">${escapeHtml(artifact.kind)} · ${escapeHtml(artifact.status || 'done')}</div>
                    </article>
                `).join('')
                : '<div class="artifact-empty">No artifacts yet</div>';
            return;
        }

        if (tab === 'tasks') {
            artifactListEl.innerHTML = state.todos.length
                ? state.todos.map(todo => `<div class="artifact-item"><div class="artifact-item-title">${todo.status === 'done' ? '✅' : todo.status === 'in_progress' ? '⏳' : '⬜'} ${escapeHtml(todo.content)}</div></div>`).join('')
                : '<div class="artifact-empty">No tasks yet</div>';
            return;
        }

        const progress = state.orchestrator;
        if (!progress) {
            artifactListEl.innerHTML = '<div class="artifact-empty">No active orchestrator lanes</div>';
            return;
        }
        artifactListEl.innerHTML = `
            <article class="artifact-item">
                <div class="artifact-item-title">Phase: ${escapeHtml(progress.phase)}</div>
                <div class="artifact-item-summary">Done ${progress.done}/${progress.total}, Running ${progress.running}, Failed ${progress.failed}</div>
                <div class="artifact-meta">${escapeHtml(progress.latestEvent || '')}</div>
            </article>
            ${progress.lanes.map(lane => `
                <article class="artifact-item">
                    <div class="artifact-item-title">${escapeHtml(lane.role)} · ${escapeHtml(lane.status)}</div>
                    <div class="artifact-item-summary">Task ${escapeHtml(lane.taskNodeId)} · steps ${lane.stepCount} · tokens ${lane.tokenUsed}</div>
                    <div class="artifact-meta">${escapeHtml(lane.statusText || '')}</div>
                </article>
            `).join('')}
        `;
    }

    function renderAll(): void {
        updateHeader();
        renderTopics();
        renderMessages();
        renderInspector();
    }

    function applySnapshot(snapshot: ManagerSnapshotMessage): void {
        state.topics = snapshot.topics || [];
        state.stats = snapshot.stats || state.stats;
        state.messages = (snapshot.messages || []).map(msg => ({
            role: msg.role,
            content: msg.content,
            displayContent: msg.displayContent,
            code: msg.code,
            isHidden: msg.isHidden,
        }));
        state.mode = snapshot.mode || state.mode;
        state.workflowId = snapshot.workflowId || null;
        state.isGenerating = !!snapshot.isGenerating;
        state.liveStepCount = snapshot.liveStepCount || 0;
        state.artifacts = snapshot.artifacts || [];
        renderAll();
    }

    function applyHostMessage(msg: ChatSurfaceHostMessage | ManagerSnapshotMessage | OrchestratorProgressMessage | any): void {
        switch (msg.type) {
            case 'managerSnapshot':
                applySnapshot(msg);
                break;
            case 'topicList':
                state.topics = msg.topics || [];
                state.stats = msg.stats || state.stats;
                renderTopics();
                break;
            case 'topicSearchResults':
                state.topics = msg.results || [];
                state.stats = msg.stats || state.stats;
                renderTopics();
                break;
            case 'loadTopicMessages':
                state.messages = (msg.messages || []).map((m: any) => ({ role: m.role, content: m.content, displayContent: m.displayContent, code: m.code, isHidden: m.isHidden }));
                renderMessages();
                break;
            case 'artifactList':
                state.artifacts = msg.artifacts || [];
                renderInspector();
                renderTopics();
                break;
            case 'todoUpdate':
                state.todos = msg.todos || [];
                renderInspector();
                break;
            case 'modeChanged':
            case 'setMode':
                state.mode = msg.mode || state.mode;
                updateHeader();
                renderTopics();
                break;
            case 'workflowChanged':
                state.workflowId = msg.workflowId || null;
                renderTopics();
                break;
            case 'replaySteps':
                state.liveStepCount = Array.isArray(msg.steps) ? msg.steps.length : 0;
                state.isGenerating = !!msg.isGenerating;
                renderTopics();
                break;
            case 'agentStep':
                state.liveStepCount += 1;
                state.isGenerating = true;
                renderTopics();
                break;
            case 'generationComplete':
            case 'generationError':
                state.isGenerating = false;
                state.liveStepCount = 0;
                renderTopics();
                break;
            case 'orchestratorProgress':
                state.orchestrator = msg.progress || null;
                renderInspector();
                break;
        }
    }

    sendBtnEl.addEventListener('click', () => {
        if (state.isGenerating) {
            postMessage({ type: 'cancelGeneration' });
            return;
        }
        sendMessage();
    });
    inputEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            sendMessage();
        }
    });
    btnNewTopic?.addEventListener('click', () => postMessage({ type: 'newTopic' }));
    btnNewTopicPanel?.addEventListener('click', () => postMessage({ type: 'newTopic' }));
    topicSearch?.addEventListener('input', () => {
        pendingSearchState.query = topicSearch.value.trim();
        postMessage({ type: 'searchTopics', query: pendingSearchState.query });
    });
    showArchivedCb?.addEventListener('change', () => {
        postMessage({ type: 'setShowArchived', show: !!showArchivedCb.checked });
    });
    modeSel?.addEventListener('change', () => {
        const mode = modeSel.value as ManagerMode;
        postMessage({ type: 'switchMode', mode });
    });

    window.addEventListener('message', (event: MessageEvent) => {
        applyHostMessage(event.data);
    });

    if ((window.innerWidth || document.documentElement.clientWidth) >= 1180) {
        document.body.classList.add('artifact-drawer-open');
    }

    postMessage({ type: 'requestManagerSnapshot' });
    postMessage({ type: 'ready' });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) postMessage({ type: 'requestManagerSnapshot' });
    });

    renderAll();
})();
