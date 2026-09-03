import type { ChatHistoryMessageView, TopicListItem, TopicStats } from './messages.shared';
import type { AgentRunEvent } from '../../shared/agentRunEvent';
import type { ManagerSchedulingStateView } from '../../shared/agentSchedulingProtocol';
import type { AgentTranscriptSnapshot } from '../../shared/agentTranscript';

export type { ManagerSchedulingStateView };

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
    | { type: 'cancelGeneration' };

export interface ManagerChildRunView {
    runId: string;
    parentRunId?: string;
    parentAgentId?: string;
    agentId?: string;
    threadId?: string;
    turnId?: string;
    status: string;
    schedulingState: ManagerSchedulingStateView;
    startedAt: number;
    completedAt?: number;
    userPromptPreview: string;
}

export interface ManagerRunSnapshotMessage {
    type: 'runSnapshot';
    snapshot: {
        runId: string;
        agentId?: string;
        status: string;
        startedAt: number;
        completedAt?: number;
        metrics: {
            totalTokens: number;
            promptTokens: number;
            completionTokens: number;
            cachedTokens?: number;
            costCny: number;
            iterations: number;
            maxIterations?: number;
            toolCalls: number;
        };
        context?: { estimatedPromptTokens?: number; contextLimit?: number };
        writtenFiles: string[];
        [key: string]: unknown;
    };
    events?: AgentRunEvent[];
    eventCount?: number;
    truncatedEventCount?: number;
    childRuns?: ManagerChildRunView[];
    cacheStats?: unknown;
    scheduling?: unknown;
}

export interface ManagerSnapshotMessage {
    type: 'managerSnapshot';
    topics: TopicListItem[];
    stats?: TopicStats;
    messages: ChatHistoryMessageView[];
    messageCount?: number;
    schedulingState: ManagerChildRunView['schedulingState'];
    workflowId?: string | null;
    isGenerating: boolean;
    liveStepCount: number;
    todos?: Array<{ id?: string; content: string; status: 'pending' | 'in_progress' | 'done' }>;
    artifacts: Array<{ id: string; kind: string; title: string; summary?: string; status?: string; createdAt?: number }>;
    activity?: {
        version: 1;
        lifecycle: 'ready' | 'disposed';
        background: Array<{ taskId: string; kind: string; status: string; since: number }>;
        items: Array<{ id: string; kind: string; label: string; status: string; detail?: string; outputRef?: string }>;
    };
    runtimeInspector?: {
        version: 1;
        scheduling?: ManagerSchedulingStateView;
        tools?: {
            registered: string[];
            activated: string[];
            disclosed: string[];
            authorization: string;
        };
        prompts: { total: number; pending: number; running: number };
        interactions: { total: number; pending: number };
        transcript: { sequence: number; turns: number; entities: number; pendingEntities: number; grade: string };
        profiles: {
            revision: number;
            profiles: Array<{ name: string }>;
            sources: Array<{ id: string; priority: number; profileCount: number; error?: string }>;
        };
        model?: { provider?: string; requested?: string; effective?: string; fallbackReason?: string; runId?: string; bindingSource?: string };
        permissions: Array<{
            id: string;
            tool: string;
            decision: string;
            source: string;
            reason?: string;
            timestamp: number;
        }>;
        scope: unknown;
    };
    transcript?: AgentTranscriptSnapshot;
}
