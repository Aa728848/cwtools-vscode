export interface TopicListItem {
    id: string;
    title: string;
    updatedAt: number;
    createdAt?: number;
    archived?: boolean;
    pinned?: boolean;
    workspaceId?: string;
    workspaceLabel?: string;
    messageCount?: number;
    parentTopicId?: string;
    forkedFromMessageIndex?: number;
}

export interface TopicStats {
    total: number;
    visible: number;
    archived: number;
    currentTopicId?: string | null;
    currentTopicTitle?: string | null;
}

export interface ChatHistoryMessageView {
    role: 'user' | 'assistant';
    content: string;
    displayContent?: string;
    timestamp: number;
    code?: string;
    isHidden?: boolean;
}
