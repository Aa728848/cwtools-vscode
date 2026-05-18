import { svgIconNoMargin } from '../svgIcons';
import { escapeHtml } from './formatters';
import {
    buildTopicSummaryModel,
    formatTopicMoment,
    groupTopicsByDate,
    shortenText,
    type TopicPanelItem,
    type TopicPanelStats,
} from './topics';

export interface TopicViewElements {
    list: HTMLElement | null;
    summary: HTMLElement | null;
    panel: HTMLElement | null;
}

export interface TopicViewCallbacks {
    postMessage: (message: unknown) => void;
    startRename: (topicId: string, title: string, source: 'list' | 'search', titleElement: HTMLElement) => void;
    formatTime: (timestamp: number) => string;
}

export interface TopicRenderOptions {
    grouping?: 'date' | 'workspace';
}

export function renderTopicPanelSummary(
    summary: HTMLElement | null,
    mode: 'list' | 'search',
    items: TopicPanelItem[],
    stats: TopicPanelStats | undefined,
    query: string | undefined,
    totalCount: number | undefined,
): void {
    if (!summary) return;
    const summaryModel = buildTopicSummaryModel(mode, items, stats, query, totalCount);
    summary.dataset.summaryTitle = summaryModel.title;
    summary.innerHTML = `
        <div class="topics-panel-summary-main">
            <div class="topics-panel-summary-title">${mode === 'search' ? '搜索结果' : '话题浏览器'}</div>
            <div class="topics-panel-summary-subtitle">${
                mode === 'search'
                    ? `关键字 ${escapeHtml(query || '空')} · ${totalCount ?? summaryModel.visibleCount} 条结果`
                    : '按更新时间自动分组，支持分叉、归档、置顶和导出'
            }</div>
        </div>
        <div class="topics-panel-summary-chips">
            <span class="topics-summary-chip"><strong>${summaryModel.visibleCount}</strong> ${mode === 'search' ? '命中' : '显示'}</span>
            <span class="topics-summary-chip"><strong>${summaryModel.archivedCount}</strong> 归档</span>
            <span class="topics-summary-chip">${escapeHtml(localizeCurrentLabel(summaryModel.currentLabel))}</span>
        </div>
    `;
}

export function buildTopicItem(
    topic: TopicPanelItem,
    currentTopicId: string | null | undefined,
    mode: 'list' | 'search',
    callbacks: TopicViewCallbacks,
): HTMLElement {
    const item = document.createElement('div');
    item.className = 'topic-item';
    item.dataset.topicId = topic.id;
    if (topic.id === currentTopicId) item.classList.add('topic-item-active');
    if (topic.archived) item.classList.add('topic-item-archived');

    const main = document.createElement('div');
    main.className = 'topic-main';

    const head = document.createElement('div');
    head.className = 'topic-head';

    const title = document.createElement('span');
    title.className = 'topic-title';
    title.textContent = topic.archived ? `[已归档] ${topic.title}` : topic.title;
    head.appendChild(title);

    appendTopicState(head, topic, currentTopicId);

    const metaRow = document.createElement('div');
    metaRow.className = 'topic-meta-row';
    const metaBits = [
        `消息 ${topic.messageCount ?? 0}`,
        `更新 ${formatTopicMoment(topic.updatedAt, callbacks.formatTime)}`,
    ];
    if (topic.workspaceLabel || topic.workspaceId) metaBits.push(`分组 ${topic.workspaceLabel || topic.workspaceId}`);
    if (topic.createdAt) metaBits.push(`创建 ${formatTopicMoment(topic.createdAt, callbacks.formatTime)}`);
    if (topic.parentTopicId && topic.forkedFromMessageIndex != null) metaBits.push(`分叉于 #${topic.forkedFromMessageIndex + 1}`);
    if (topic.score != null) metaBits.push(`相关度 ${Math.round(topic.score)}`);
    metaRow.innerHTML = metaBits.map(bit => `<span class="topic-meta-chip">${escapeHtml(bit)}</span>`).join('');

    main.appendChild(head);
    main.appendChild(metaRow);

    if (mode === 'search' && topic.matchContext) {
        const summary = document.createElement('div');
        summary.className = 'topic-summary';
        summary.textContent = topic.matchContext;
        main.appendChild(summary);
    }

    const actions = document.createElement('div');
    actions.className = 'topic-actions';
    appendTopicActions(actions, topic, mode, title, callbacks);

    item.appendChild(main);
    item.appendChild(actions);
    item.addEventListener('click', () => callbacks.postMessage({ type: 'loadTopic', topicId: topic.id }));
    return item;
}

export function renderTopics(
    elements: TopicViewElements,
    topics: TopicPanelItem[],
    stats: TopicPanelStats | undefined,
    callbacks: TopicViewCallbacks,
    options: TopicRenderOptions = {},
): void {
    const { list } = elements;
    if (!list) return;
    renderTopicPanelSummary(elements.summary, 'list', topics, stats, undefined, undefined);
    if (!topics.length) {
        list.innerHTML = `
            <div class="topic-empty-state">
                <div class="topic-empty-title">暂无历史话题</div>
                <div class="topic-empty-subtitle">创建一个新会话，或用搜索快速回到旧会话。</div>
            </div>`;
        return;
    }
    list.innerHTML = '';
    const sorted = [...topics].sort((a, b) => {
        const pinA = a.pinned ? 1 : 0;
        const pinB = b.pinned ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const groups = options.grouping === 'workspace'
        ? groupTopicsByWorkspace(sorted)
        : groupTopicsByDate(sorted);
    for (const group of groups) {
        const header = document.createElement('div');
        header.className = 'topic-date-group';
        header.textContent = group.label;
        list.appendChild(header);
        for (const topic of group.items) {
            list.appendChild(buildTopicItem(topic, stats?.currentTopicId, 'list', callbacks));
        }
    }
}

export function renderTopicSearchResults(
    elements: TopicViewElements,
    results: TopicPanelItem[],
    query: string,
    totalCount: number,
    stats: TopicPanelStats | undefined,
    callbacks: TopicViewCallbacks,
): void {
    const { list } = elements;
    if (!list) return;
    renderTopicPanelSummary(elements.summary, 'search', results, stats, query, totalCount);
    if (!results.length) {
        list.innerHTML = `
            <div class="topic-empty-state">
                <div class="topic-empty-title">没有找到匹配结果</div>
                <div class="topic-empty-subtitle">试试更短的关键词，或者切回完整话题列表。</div>
            </div>`;
        return;
    }
    list.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'topic-date-group';
    header.textContent = query ? `搜索结果 · ${shortenText(query, 18)}` : '搜索结果';
    list.appendChild(header);
    for (const topic of results) {
        list.appendChild(buildTopicItem(topic, stats?.currentTopicId, 'search', callbacks));
    }
}

function appendTopicState(head: HTMLElement, topic: TopicPanelItem, currentTopicId: string | null | undefined): void {
    const state = document.createElement('span');
    if (topic.id === currentTopicId) {
        state.className = 'topic-state topic-state-current';
        state.textContent = '当前';
    } else if (topic.pinned) {
        state.className = 'topic-state topic-state-current';
        state.textContent = '置顶';
    } else if (topic.archived) {
        state.className = 'topic-state topic-state-archived';
        state.textContent = '归档';
    } else if (topic.parentTopicId) {
        state.className = 'topic-state topic-state-forked';
        state.textContent = '分支';
    } else {
        return;
    }
    head.appendChild(state);
}

function appendTopicActions(
    actions: HTMLElement,
    topic: TopicPanelItem,
    mode: 'list' | 'search',
    title: HTMLElement,
    callbacks: TopicViewCallbacks,
): void {
    const pinBtn = document.createElement('button');
    pinBtn.className = 'topic-action-btn topic-pin-btn';
    pinBtn.textContent = topic.pinned ? '📌' : '📍';
    pinBtn.title = topic.pinned ? '取消置顶' : '置顶';
    pinBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.postMessage({ type: 'pinTopic', topicId: topic.id, pinned: !topic.pinned });
    });

    const forkBtn = document.createElement('button');
    forkBtn.className = 'topic-action-btn topic-fork-btn';
    forkBtn.innerHTML = svgIconNoMargin('link');
    forkBtn.title = '分叉话题';
    forkBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.postMessage({ type: 'forkTopic', topicId: topic.id, messageIndex: 999 });
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'topic-action-btn topic-rename-btn';
    renameBtn.innerHTML = svgIconNoMargin('edit');
    renameBtn.title = '重命名';
    renameBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.startRename(topic.id, topic.title || '', mode, title);
    });

    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'topic-action-btn topic-archive-btn';
    archiveBtn.innerHTML = topic.archived ? `${svgIconNoMargin('refresh')} 恢复` : svgIconNoMargin('bookmark');
    archiveBtn.title = topic.archived ? '取消归档' : '归档';
    archiveBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.postMessage({ type: 'archiveTopic', topicId: topic.id });
    });

    const workspaceBtn = document.createElement('button');
    workspaceBtn.className = 'topic-action-btn topic-workspace-btn';
    workspaceBtn.innerHTML = svgIconNoMargin('folder');
    workspaceBtn.title = '设置工作区分组';
    workspaceBtn.addEventListener('click', event => {
        event.stopPropagation();
        const current = topic.workspaceLabel || topic.workspaceId || '';
        const nextValue = window.prompt('输入工作区分组名（留空清除）', current);
        if (nextValue === null) return;
        const next = nextValue.trim();
        callbacks.postMessage({
            type: 'setTopicWorkspace',
            topicId: topic.id,
            workspaceId: next || null,
            workspaceLabel: next || null,
        });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'topic-action-btn topic-delete';
    deleteBtn.innerHTML = svgIconNoMargin('trash');
    deleteBtn.title = '删除';
    deleteBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.postMessage({ type: 'deleteTopic', topicId: topic.id });
    });

    actions.appendChild(pinBtn);
    actions.appendChild(forkBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(workspaceBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(deleteBtn);
}

function groupTopicsByWorkspace(topics: TopicPanelItem[]): Array<{ label: string; items: TopicPanelItem[] }> {
    const groups = new Map<string, TopicPanelItem[]>();
    for (const topic of topics) {
        const label = topic.workspaceLabel || topic.workspaceId || '默认工作区';
        const items = groups.get(label) || [];
        items.push(topic);
        groups.set(label, items);
    }
    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

function localizeCurrentLabel(label: string): string {
    return label
        .replace(/^Current archived: /, '当前归档: ')
        .replace(/^Current: hidden topic$/, '当前: 会话已隐藏')
        .replace(/^Current: none$/, '当前: 无活动会话')
        .replace(/^Current: /, '当前: ');
}
