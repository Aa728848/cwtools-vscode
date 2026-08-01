import type { ChatHistoryMessageView, TopicListItem, TopicStats } from './messages.shared';

/**
 * Lightweight chat-surface contract aliases used by split UI runtimes.
 * Kept intentionally small and additive to avoid coupling with extension-host unions.
 */
export type ChatSurfaceHostMessage =
    | { type: 'topicList'; topics: TopicListItem[]; stats?: TopicStats }
    | { type: 'topicSearchResults'; results: TopicListItem[]; stats?: TopicStats; query?: string; totalCount?: number }
    | { type: 'loadTopicMessages'; messages: ChatHistoryMessageView[]; targetSurface?: 'chat' | 'manager' }
    | { type: 'messageRetracted'; messageIndex: number; restoredInput?: { text: string; images?: string[]; contexts?: unknown[] }; restoredFiles?: number; skippedFiles?: number }
    | { type: 'modeChanged' | 'setMode'; mode: string }
    | { type: 'clearChat'; targetSurface?: 'chat' | 'manager' }
    | { type: 'floatingCardResolved'; card: 'permission' | 'write' | 'transaction' | 'plan' | 'walkthrough' | 'blueprint'; id?: string }
    | { type: 'generationComplete' | 'generationError' }
    | { type: 'contextCompactionStatus'; step: unknown }
    | { type: 'activitySnapshot'; activity: unknown }
    | { type: 'runtimeProfiles'; revision: number; profiles: Array<{ name: string; description: string; domain?: string; authorizationCeiling: string; modelPreference?: string }> }
    | { type: 'runtimeInspectorSnapshot'; runtimeInspector: unknown }
    | { type: 'transcriptSnapshot'; transcript: unknown }
    | { type: 'artifactList'; artifacts: Array<{ id: string; kind: string; title: string; summary?: string; status?: string; createdAt?: number }> }
    | { type: 'todoUpdate'; todos: Array<{ id?: string; content: string; status: 'pending' | 'in_progress' | 'done' }>; agentId?: string; threadId?: string; runId?: string };
