import type { ChatHistoryMessageView, TopicListItem, TopicStats } from './messages.shared';

export type ManagerWebviewMessage =
    | { type: 'ready' }
    | { type: 'requestManagerSnapshot' }
    | { type: 'sendMessage'; text: string }
    | { type: 'newTopic' }
    | { type: 'loadTopic'; topicId: string }
    | { type: 'searchTopics'; query: string }
    | { type: 'setShowArchived'; show: boolean }
    | { type: 'pinTopic'; topicId: string; pinned?: boolean }
    | { type: 'setTopicWorkspace'; topicId: string; workspaceId?: string | null; workspaceLabel?: string | null }
    | { type: 'switchMode'; mode: 'build' | 'plan' | 'explore' | 'utility' | 'review' | 'orchestrator' | 'script' }
    | { type: 'cancelGeneration' };

export interface ManagerSnapshotMessage {
    type: 'managerSnapshot';
    topics: TopicListItem[];
    stats?: TopicStats;
    messages: ChatHistoryMessageView[];
    messageCount?: number;
    mode: string;
    workflowId?: string | null;
    isGenerating: boolean;
    liveStepCount: number;
    artifacts: Array<{ id: string; kind: string; title: string; summary?: string; status?: string; createdAt?: number }>;
}

export interface OrchestratorProgressMessage {
    type: 'orchestratorProgress';
    progress: {
        phase: 'planning' | 'executing' | 'reviewing' | 'complete' | 'failed';
        total: number;
        done: number;
        running: number;
        failed: number;
        cancelled: number;
        latestEvent?: string;
        lanes: Array<{
            id: string;
            role: string;
            taskNodeId: string;
            status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
            stepCount: number;
            tokenUsed: number;
            startedAt?: number;
            duration?: number;
            statusText?: string;
        }>;
    };
}
