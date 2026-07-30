import type { AgentMode, AgentRunRecord, AgentSchedulingState } from '../types';
import { runLedger, type RunLedger } from './runLedger';
import { AgentInputQueue } from './inputQueue';
import { createRunEventSink, type RunEventSink } from './runContext';
import { threadStore, type ThreadStore } from './threadStore';

export interface TurnStartOptions {
    topicId: string;
    mode: AgentMode | string;
    userPrompt: string;
    userPromptPreview?: string;
    parentRunId?: string;
    agentId?: string;
    providerId?: string;
    model?: string;
    workflowId?: string | null;
    threadId?: string;
    turnId?: string;
    schedulingState?: AgentSchedulingState;
}

export interface TurnRuntime {
    run: AgentRunRecord;
    eventSink: RunEventSink;
    inputQueue: AgentInputQueue;
}

export class TurnRunner {
    constructor(
        private readonly ledger: RunLedger = runLedger,
        private readonly threads: ThreadStore = threadStore,
    ) {}

    async startTurn(options: TurnStartOptions): Promise<TurnRuntime> {
        const threadId = options.threadId ?? options.topicId;
        const run = await this.ledger.createRun(
            options.topicId,
            options.mode,
            options.userPromptPreview ?? options.userPrompt.substring(0, 100),
            options.parentRunId,
            options.userPrompt,
            {
                agentId: options.agentId,
                providerId: options.providerId,
                model: options.model,
                workflowId: options.workflowId,
                threadId,
                turnId: options.turnId,
                schedulingState: options.schedulingState,
            },
        );
        await this.threads.recordRun(run, { threadId });
        const eventSink = createRunEventSink({
            runId: run.runId,
            topicId: run.topicId,
            parentRunId: run.parentRunId,
            agentId: run.agentId,
            threadId,
            turnId: options.turnId,
        });
        await eventSink.append('status_changed', { status: 'planning' });
        return {
            run,
            eventSink,
            inputQueue: new AgentInputQueue(run.runId),
        };
    }
}
