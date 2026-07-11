import { runLedger } from './runLedger';

export interface AgentRunEvaluation {
    version: 1;
    runId: string;
    passed: boolean;
    score: number;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
    evaluatedAt: number;
}

/** Deterministic runtime invariants used as a cheap regression/evaluation layer. */
export async function evaluateAgentRun(runId: string, topicId?: string): Promise<AgentRunEvaluation | undefined> {
    const snapshot = await runLedger.getOrLoadSnapshot(runId, topicId);
    if (!snapshot) return undefined;
    const sequences = snapshot.events.map(event => event.sequence);
    const monotonic = sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!);
    const processEvents = snapshot.events.filter(event => event.type === 'process_started');
    const honestSandbox = processEvents.every(event => {
        const mode = String(event.payload?.sandboxMode ?? '');
        return ['workspace-write', 'disabled', 'user-approved-terminal'].includes(mode);
    });
    const toolEnds = snapshot.events.filter(event => event.type === 'tool_call_end');
    const failedTools = toolEnds.filter(event => event.payload?.success === false && !event.payload?.skipped).length;
    const failureRate = toolEnds.length > 0 ? failedTools / toolEnds.length : 0;
    const checks = [
        { name: 'event_sequence_monotonic', passed: monotonic, detail: `${sequences.length} persisted events` },
        { name: 'sandbox_metadata_honest', passed: honestSandbox, detail: `${processEvents.length} command process events` },
        { name: 'tool_failure_rate', passed: failureRate <= 0.5, detail: `${failedTools}/${toolEnds.length} failed` },
        { name: 'durable_identity', passed: !!snapshot.run.topicId && !!snapshot.run.runId, detail: `topic=${snapshot.run.topicId}; thread=${snapshot.run.threadId ?? '(legacy)'}` },
    ];
    const passedCount = checks.filter(check => check.passed).length;
    return {
        version: 1,
        runId,
        passed: passedCount === checks.length,
        score: Math.round((passedCount / checks.length) * 100),
        checks,
        evaluatedAt: Date.now(),
    };
}
