import type { AgentRunner } from '../agentRunner';
import type { RunEventSink } from './runContext';

export interface ActiveTurnRecord {
    runId: string;
    threadId?: string;
    turnId?: string;
    runner: Pick<AgentRunner, 'submitInput'>;
    abortController: AbortController;
    eventSink?: RunEventSink;
    startedAt: number;
}

export class ActiveTurnRegistry {
    private static instance: ActiveTurnRegistry | undefined;
    private readonly turns = new Map<string, ActiveTurnRecord>();

    static getInstance(): ActiveTurnRegistry {
        if (!ActiveTurnRegistry.instance) ActiveTurnRegistry.instance = new ActiveTurnRegistry();
        return ActiveTurnRegistry.instance;
    }

    register(record: Omit<ActiveTurnRecord, 'startedAt'> & { startedAt?: number }): () => void {
        const active: ActiveTurnRecord = {
            ...record,
            startedAt: record.startedAt ?? Date.now(),
        };
        this.turns.set(record.runId, active);
        return () => {
            if (this.turns.get(record.runId) === active) {
                this.turns.delete(record.runId);
            }
        };
    }

    steer(runId: string, message: string, clientUserMessageId?: string, images?: string[]): boolean {
        const record = this.turns.get(runId);
        if (!record) return false;
        return record.runner.submitInput(runId, message, clientUserMessageId, images);
    }

    interrupt(runId: string, reason = 'Interrupted by user'): boolean {
        const record = this.turns.get(runId);
        if (!record) return false;
        if (!record.abortController.signal.aborted) {
            const error = new Error(reason);
            error.name = 'AbortError';
            record.eventSink?.appendSoon('cancelled', { reason }, { status: 'cancelled' });
            record.abortController.abort(error);
        }
        return true;
    }

    get(runId: string): ActiveTurnRecord | undefined {
        return this.turns.get(runId);
    }

    list(): ActiveTurnRecord[] {
        return [...this.turns.values()].sort((a, b) => b.startedAt - a.startedAt);
    }
}

export const activeTurnRegistry = ActiveTurnRegistry.getInstance();
