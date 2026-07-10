import type { AgentRunRecord } from '../types';
import { runLedger, type AgentRunEvent } from './runLedger';
import { reduceAll, type RunReducerSnapshot } from './runReducers';

export interface RunRollout {
    run: AgentRunRecord;
    events: AgentRunEvent[];
    projection: RunReducerSnapshot;
}

export async function readRunRollout(runId: string, topicId?: string): Promise<RunRollout | undefined> {
    const snapshot = await runLedger.getOrLoadSnapshot(runId, topicId);
    if (!snapshot) return undefined;
    return {
        run: snapshot.run,
        events: snapshot.events,
        projection: reduceAll(snapshot.events),
    };
}
