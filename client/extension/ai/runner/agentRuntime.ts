import type { AgentRunner, AgentRunnerOptions } from '../agentRunner';
import type { ChatMessage, GenerationResult } from '../types';
import { activeTurnRegistry } from './activeTurnRegistry';
import { readRunRollout, type RunRollout } from './rolloutStore';
import { threadStore, type AgentThreadRecord } from './threadStore';
import { goalStore, type DurableAgentGoal } from './goalStore';
import { runLedger } from './runLedger';
import { runAgentHooks } from './hookRunner';
import { evaluateAgentRun } from './agentEvals';

export interface TurnStartRequest {
    userMessage: string;
    context?: {
        activeFile?: string;
        cursorLine?: number;
        cursorColumn?: number;
        selectedText?: string;
        fileContent?: string;
        topicId?: string;
    };
    conversationHistory?: ChatMessage[];
    options?: AgentRunnerOptions;
    images?: string[];
}

export interface TurnStartResult {
    runId?: string;
    threadId: string;
    turnId?: string;
    result: GenerationResult;
    rollout?: RunRollout;
}

export interface TurnSteerResult {
    accepted: boolean;
    runId: string;
}

export interface TurnInterruptResult {
    interrupted: boolean;
    runId: string;
}

export class AgentRuntime {
    constructor(private readonly runner: AgentRunner) {}

    async startTurn(request: TurnStartRequest): Promise<TurnStartResult> {
        const context = request.context ?? {};
        const topicId = context.topicId ?? request.options?.topicId ?? 'default';
        const threadId = request.options?.threadId ?? topicId;
        const turnId = request.options?.turnId ?? `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const goal = await goalStore.getGoal(topicId, threadId);
        const history = [...(request.conversationHistory ?? [])];
        if (goal?.status === 'active') {
            history.unshift({
                role: 'system',
                content: `[DURABLE GOAL]\nObjective: ${goal.objective}\nStatus: ${goal.status}${goal.tokenBudget ? `\nToken budget: ${goal.tokenBudget}` : ''}`,
            });
        }
        await runAgentHooks('userPromptSubmit', { topicId, threadId, turnId });
        let result: GenerationResult;
        try {
            result = await this.runner.run(
                request.userMessage,
                { ...context, topicId },
                history,
                {
                    ...request.options,
                    topicId,
                    threadId,
                    turnId,
                    tokenBudget: request.options?.tokenBudget ?? goal?.tokenBudget,
                    durableGoal: goal?.status === 'active',
                },
                request.images,
            );
        } finally {
            await runAgentHooks('stop', { topicId, threadId, turnId });
        }
        const rollout = result.runId ? await readRunRollout(result.runId, topicId) : undefined;
        if (result.runId) {
            const evaluation = await evaluateAgentRun(result.runId, topicId);
            if (evaluation) await runLedger.writeJsonArtifact(result.runId, 'evaluations/latest.json', evaluation);
        }
        return {
            runId: result.runId,
            threadId,
            turnId,
            result,
            rollout,
        };
    }

    steerTurn(runId: string, message: string, clientUserMessageId?: string, images?: string[]): TurnSteerResult {
        return {
            runId,
            accepted: activeTurnRegistry.steer(runId, message, clientUserMessageId, images),
        };
    }

    interruptTurn(runId: string, reason?: string): TurnInterruptResult {
        return {
            runId,
            interrupted: activeTurnRegistry.interrupt(runId, reason),
        };
    }

    readTurnRollout(runId: string, topicId?: string): Promise<RunRollout | undefined> {
        return readRunRollout(runId, topicId);
    }

    resumeThread(topicId: string, threadId: string): Promise<AgentThreadRecord | undefined> {
        return threadStore.getThread(topicId, threadId);
    }

    async resumeThreadContext(topicId: string, threadId: string): Promise<{
        thread: AgentThreadRecord;
        conversationHistory: ChatMessage[];
        goal?: DurableAgentGoal;
    } | undefined> {
        const thread = await threadStore.getThread(topicId, threadId);
        if (!thread) return undefined;
        const conversationHistory = thread.currentRunId
            ? await runLedger.readResumeTranscript(thread.currentRunId, topicId) ?? []
            : [];
        return { thread, conversationHistory, goal: await goalStore.getGoal(topicId, threadId) };
    }

    forkThread(topicId: string, sourceThreadId: string, newThreadId: string, newTopicId?: string, sourceRunId?: string, messageIndex?: number): Promise<AgentThreadRecord | undefined> {
        return threadStore.forkThread(topicId, sourceThreadId, newThreadId, newTopicId, sourceRunId, messageIndex);
    }

    setGoal(topicId: string, threadId: string, objective: string, tokenBudget?: number): Promise<DurableAgentGoal> {
        return goalStore.setGoal(topicId, threadId, objective, tokenBudget);
    }

    updateGoal(topicId: string, threadId: string, status: DurableAgentGoal['status']): Promise<DurableAgentGoal | undefined> {
        return goalStore.updateStatus(topicId, threadId, status);
    }

    getGoal(topicId: string, threadId: string): Promise<DurableAgentGoal | undefined> {
        return goalStore.getGoal(topicId, threadId);
    }

    compactThread(topicId: string, threadId: string, compactedFromRunId?: string, latestSummaryRef?: string): Promise<AgentThreadRecord | undefined> {
        return threadStore.markCompacted(topicId, threadId, compactedFromRunId, latestSummaryRef);
    }

    listThreads(topicId: string): Promise<AgentThreadRecord[]> {
        return threadStore.listThreads(topicId);
    }
}
