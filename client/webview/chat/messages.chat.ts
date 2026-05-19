import type { ChatHistoryMessageView, TopicListItem, TopicStats } from './messages.shared';

/**
 * Lightweight chat-surface contract aliases used by split UI runtimes.
 * Kept intentionally small and additive to avoid coupling with extension-host unions.
 */
export type ChatSurfaceHostMessage =
    | { type: 'topicList'; topics: TopicListItem[]; stats?: TopicStats }
    | { type: 'topicSearchResults'; results: TopicListItem[]; stats?: TopicStats; query?: string; totalCount?: number }
    | { type: 'loadTopicMessages'; messages: ChatHistoryMessageView[]; targetSurface?: 'chat' | 'manager' }
    | { type: 'modeChanged' | 'setMode'; mode: string }
    | { type: 'clearChat'; targetSurface?: 'chat' | 'manager' }
    | { type: 'floatingCardResolved'; card: 'permission' | 'write' | 'transaction' | 'plan' | 'walkthrough' | 'blueprint'; id?: string }
    | { type: 'generationComplete' | 'generationError' }
    | { type: 'artifactList'; artifacts: Array<{ id: string; kind: string; title: string; summary?: string; status?: string; createdAt?: number }> }
    | { type: 'todoUpdate'; todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }> };
