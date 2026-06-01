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

function topicUi() {
    const zh = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh');
    return zh
        ? {
            searchResults: '搜索结果',
            topicBrowser: '话题浏览器',
            keyword: '关键字',
            emptyQuery: '空',
            results: '条结果',
            browserSubtitle: '支持分组、分叉、归档、置顶和导出',
            hits: '命中',
            visible: '显示',
            archived: '归档',
            archivedPrefix: '已归档',
            messages: '消息',
            updated: '更新',
            group: '分组',
            created: '创建',
            forkedFrom: '分叉于',
            relevance: '相关度',
            noTopicsTitle: '暂无历史话题',
            noTopicsSubtitle: '创建一个新会话，或用搜索快速回到旧会话。',
            noResultsTitle: '没有找到匹配结果',
            noResultsSubtitle: '试试更短的关键词，或者切回完整话题列表。',
            pinned: '置顶',
            current: '当前',
            branch: '分支',
            unpin: '取消置顶',
            pin: '置顶',
            forkTopic: '分叉话题',
            rename: '重命名',
            restore: '恢复',
            unarchive: '取消归档',
            setWorkspace: '设置话题分组',
            workspacePrompt: '输入话题分组名（留空清除）',
            delete: '删除',
            ungrouped: '未分组',
            currentArchived: '当前归档: ',
            hiddenTopic: '当前: 会话已隐藏',
            currentNone: '当前: 无活动会话',
            currentPrefix: '当前: ',
        }
        : {
            searchResults: 'Search Results',
            topicBrowser: 'Topic Browser',
            keyword: 'Keyword',
            emptyQuery: 'empty',
            results: 'results',
            browserSubtitle: 'Group, fork, archive, pin, and export topics',
            hits: 'hits',
            visible: 'visible',
            archived: 'archived',
            archivedPrefix: 'Archived',
            messages: 'messages',
            updated: 'updated',
            group: 'group',
            created: 'created',
            forkedFrom: 'forked from',
            relevance: 'relevance',
            noTopicsTitle: 'No topic history yet',
            noTopicsSubtitle: 'Create a new topic, or search to return to an old one.',
            noResultsTitle: 'No matching results',
            noResultsSubtitle: 'Try a shorter keyword, or return to the full topic list.',
            pinned: 'Pinned',
            current: 'Current',
            branch: 'Branch',
            unpin: 'Unpin',
            pin: 'Pin',
            forkTopic: 'Fork topic',
            rename: 'Rename',
            restore: 'Restore',
            unarchive: 'Unarchive',
            setWorkspace: 'Set topic group',
            workspacePrompt: 'Enter a topic group name (leave empty to clear)',
            delete: 'Delete',
            ungrouped: 'Ungrouped',
            currentArchived: 'Current archived: ',
            hiddenTopic: 'Current: hidden topic',
            currentNone: 'Current: none',
            currentPrefix: 'Current: ',
        };
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
    const text = topicUi();
    const summaryModel = buildTopicSummaryModel(mode, items, stats, query, totalCount);
    summary.dataset.summaryTitle = summaryModel.title;
    summary.innerHTML = `
        <div class="topics-panel-summary-main">
            <div class="topics-panel-summary-title">${mode === 'search' ? text.searchResults : text.topicBrowser}</div>
            <div class="topics-panel-summary-subtitle">${
                mode === 'search'
                    ? `${text.keyword} ${escapeHtml(query || text.emptyQuery)} · ${totalCount ?? summaryModel.visibleCount} ${text.results}`
                    : text.browserSubtitle
            }</div>
        </div>
        <div class="topics-panel-summary-chips">
            <span class="topics-summary-chip"><strong>${summaryModel.visibleCount}</strong> ${mode === 'search' ? text.hits : text.visible}</span>
            <span class="topics-summary-chip"><strong>${summaryModel.archivedCount}</strong> ${text.archived}</span>
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
    const text = topicUi();
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
    title.textContent = topic.archived ? `[${text.archivedPrefix}] ${topic.title}` : topic.title;
    head.appendChild(title);

    appendTopicState(head, topic, currentTopicId);

    const metaRow = document.createElement('div');
    metaRow.className = 'topic-meta-row';
    const metaBits = [
        `${text.messages} ${topic.messageCount ?? 0}`,
        `${text.updated} ${formatTopicMoment(topic.updatedAt, callbacks.formatTime)}`,
    ];
    if (topic.workspaceLabel || topic.workspaceId) metaBits.push(`${text.group} ${topic.workspaceLabel || topic.workspaceId}`);
    if (topic.createdAt) metaBits.push(`${text.created} ${formatTopicMoment(topic.createdAt, callbacks.formatTime)}`);
    if (topic.parentTopicId && topic.forkedFromMessageIndex != null) metaBits.push(`${text.forkedFrom} #${topic.forkedFromMessageIndex + 1}`);
    if (topic.score != null) metaBits.push(`${text.relevance} ${Math.round(topic.score)}`);
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
        const text = topicUi();
        list.innerHTML = `
            <div class="topic-empty-state">
                <div class="topic-empty-title">${text.noTopicsTitle}</div>
                <div class="topic-empty-subtitle">${text.noTopicsSubtitle}</div>
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
        const text = topicUi();
        list.innerHTML = `
            <div class="topic-empty-state">
                <div class="topic-empty-title">${text.noResultsTitle}</div>
                <div class="topic-empty-subtitle">${text.noResultsSubtitle}</div>
            </div>`;
        return;
    }
    list.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'topic-date-group';
    header.textContent = query ? `${topicUi().searchResults} · ${shortenText(query, 18)}` : topicUi().searchResults;
    list.appendChild(header);
    for (const topic of results) {
        list.appendChild(buildTopicItem(topic, stats?.currentTopicId, 'search', callbacks));
    }
}

function appendTopicState(head: HTMLElement, topic: TopicPanelItem, currentTopicId: string | null | undefined): void {
    const text = topicUi();
    const state = document.createElement('span');
    if (topic.id === currentTopicId) {
        state.className = 'topic-state topic-state-current';
        state.textContent = text.current;
    } else if (topic.pinned) {
        state.className = 'topic-state topic-state-current';
        state.textContent = text.pinned;
    } else if (topic.archived) {
        state.className = 'topic-state topic-state-archived';
        state.textContent = text.archived;
    } else if (topic.parentTopicId) {
        state.className = 'topic-state topic-state-forked';
        state.textContent = text.branch;
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
    const text = topicUi();
    const pinBtn = document.createElement('button');
    pinBtn.className = 'topic-action-btn topic-pin-btn';
    pinBtn.textContent = topic.pinned ? '📌' : '📍';
    pinBtn.title = topic.pinned ? text.unpin : text.pin;
    pinBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.postMessage({ type: 'pinTopic', topicId: topic.id, pinned: !topic.pinned });
    });

    const forkBtn = document.createElement('button');
    forkBtn.className = 'topic-action-btn topic-fork-btn';
    forkBtn.innerHTML = svgIconNoMargin('link');
    forkBtn.title = text.forkTopic;
    forkBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.postMessage({ type: 'forkTopic', topicId: topic.id, messageIndex: 999 });
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'topic-action-btn topic-rename-btn';
    renameBtn.innerHTML = svgIconNoMargin('edit');
    renameBtn.title = text.rename;
    renameBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.startRename(topic.id, topic.title || '', mode, title);
    });

    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'topic-action-btn topic-archive-btn';
    archiveBtn.innerHTML = topic.archived ? `${svgIconNoMargin('refresh')} ${text.restore}` : svgIconNoMargin('bookmark');
    archiveBtn.title = topic.archived ? text.unarchive : text.archived;
    archiveBtn.addEventListener('click', event => {
        event.stopPropagation();
        callbacks.postMessage({ type: 'archiveTopic', topicId: topic.id });
    });

    const workspaceBtn = document.createElement('button');
    workspaceBtn.className = 'topic-action-btn topic-workspace-btn';
    workspaceBtn.innerHTML = svgIconNoMargin('folder');
    workspaceBtn.title = text.setWorkspace;
    workspaceBtn.addEventListener('click', event => {
        event.stopPropagation();
        const current = topic.workspaceLabel || topic.workspaceId || '';
        const nextValue = window.prompt(text.workspacePrompt, current);
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
    deleteBtn.title = text.delete;
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
    const text = topicUi();
    for (const topic of topics) {
        const label = topic.workspaceLabel || topic.workspaceId || text.ungrouped;
        const items = groups.get(label) || [];
        items.push(topic);
        groups.set(label, items);
    }
    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

function localizeCurrentLabel(label: string): string {
    const text = topicUi();
    return label
        .replace(/^Current archived: /, text.currentArchived)
        .replace(/^Current: hidden topic$/, text.hiddenTopic)
        .replace(/^Current: none$/, text.currentNone)
        .replace(/^Current: /, text.currentPrefix);
}
