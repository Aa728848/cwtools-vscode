export interface TopicPanelItem {
    id: string;
    title: string;
    updatedAt: number;
    createdAt?: number;
    archived?: boolean;
    messageCount?: number;
    matchContext?: string;
    score?: number;
    parentTopicId?: string;
    forkedFromMessageIndex?: number;
}

export interface TopicPanelStats {
    total: number;
    visible: number;
    archived: number;
    currentTopicId?: string | null;
    currentTopicTitle?: string | null;
}

export interface TopicDateGroup {
    label: string;
    items: TopicPanelItem[];
}

const DAY_MS = 86400000;

export function groupTopicsByDate(topics: TopicPanelItem[], now = Date.now()): TopicDateGroup[] {
    const groups: TopicDateGroup[] = [
        { label: 'Today', items: [] },
        { label: 'Yesterday', items: [] },
        { label: 'This week', items: [] },
        { label: 'Earlier', items: [] },
    ];

    for (const topic of topics) {
        const age = now - (topic.updatedAt || 0);
        if (age < DAY_MS) groups[0]!.items.push(topic);
        else if (age < DAY_MS * 2) groups[1]!.items.push(topic);
        else if (age < DAY_MS * 7) groups[2]!.items.push(topic);
        else groups[3]!.items.push(topic);
    }

    return groups.filter(group => group.items.length > 0);
}

export function shortenText(text: string, maxLen: number): string {
    const value = String(text ?? '');
    if (value.length <= maxLen) return value;
    return value.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '...';
}

export function formatTopicMoment(ts: number | undefined, formatTime: (ts: number) => string, now = new Date()): string {
    if (!ts) return 'unknown time';
    const d = new Date(ts);
    const isSameDay = d.toDateString() === now.toDateString();
    const dateLabel = isSameDay ? 'Today' : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    return `${dateLabel} ${formatTime(ts)}`;
}

export function buildTopicSummaryModel(
    mode: 'list' | 'search',
    items: TopicPanelItem[],
    stats?: TopicPanelStats,
    query?: string,
    totalCount?: number,
): {
    title: string;
    subtitle: string;
    visibleCount: number;
    archivedCount: number;
    currentLabel: string;
} {
    const currentTopic = stats?.currentTopicId ? items.find(t => t.id === stats.currentTopicId) : undefined;
    const visibleCount = stats?.visible ?? items.length;
    const archivedCount = stats?.archived ?? items.filter(t => t.archived).length;
    const currentLabel = currentTopic
        ? `${currentTopic.archived ? 'Current archived' : 'Current'}: ${shortenText(currentTopic.title, 18)}`
        : (stats?.currentTopicId ? `Current: ${shortenText(stats.currentTopicTitle || 'hidden topic', 18)}` : 'Current: none');

    return {
        title: mode === 'search' ? 'Search results' : 'Topic browser',
        subtitle: mode === 'search'
            ? `Query ${query || 'empty'} | ${totalCount ?? visibleCount} result(s)`
            : 'Grouped by update time, with fork, archive, rename, and export actions.',
        visibleCount,
        archivedCount,
        currentLabel,
    };
}
