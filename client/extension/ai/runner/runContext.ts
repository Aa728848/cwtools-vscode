import { runLedger, type AgentRunEventType } from './runLedger';

export interface RunIdentity {
    runId: string;
    topicId?: string;
    parentRunId?: string;
    agentId?: string;
    invocationId?: string;
    threadId?: string;
    turnId?: string;
}

export interface RunEventMetadata {
    invocationId?: string;
    agentId?: string;
    status?: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
}

export class RunEventSink {
    constructor(private readonly identity: RunIdentity) {}

    get runId(): string {
        return this.identity.runId;
    }

    get agentId(): string | undefined {
        return this.identity.agentId;
    }

    child(overrides: Partial<RunIdentity>): RunEventSink {
        return new RunEventSink({ ...this.identity, ...overrides });
    }

    async append(
        type: AgentRunEventType,
        payload: Record<string, unknown>,
        metadata: RunEventMetadata = {},
    ): Promise<void> {
        await runLedger.appendEvent(this.identity.runId, type, payload, {
            invocationId: metadata.invocationId ?? this.identity.invocationId,
            agentId: metadata.agentId ?? this.identity.agentId,
            status: metadata.status,
        });
    }

    appendSoon(
        type: AgentRunEventType,
        payload: Record<string, unknown>,
        metadata: RunEventMetadata = {},
    ): void {
        this.append(type, payload, metadata).catch(() => {});
    }
}

export function createRunEventSink(identity: RunIdentity): RunEventSink {
    return new RunEventSink(identity);
}
