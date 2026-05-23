/**
 * Run Replay (T4.1).
 *
 * Re-runs a previously-recorded agent run with new prompt / model / provider
 * overrides. The default mode is "recorded-tool" (mode A): the LLM is invoked
 * fresh but tool calls are answered from the original ledger, so the replay is
 * cheap and the behaviour difference is isolated to the LLM's reasoning under
 * the new prompt.
 *
 * Mode B (full-replay, where tools are re-executed) is intentionally out of
 * scope for this MVP — it requires workspace snapshotting and dry-run guards
 * the plan deferred. Callers asking for it currently fall back to mode A and
 * see a warning step.
 */

import type { AgentRunEvent } from './runLedger';
import { runLedger } from './runLedger';
import type { AgentRunRecord, AgentMode, AgentStep, GenerationResult, AgentToolName } from '../types';
import type { AgentRunner, AgentRunnerOptions } from '../agentRunner';

export type ReplayMode = 'recorded-tool' | 'full-replay';

export interface ReplayOverrides {
    /** Switch model for the replay. */
    model?: string;
    /** Switch provider for the replay. */
    providerId?: string;
    /** Switch mode for the replay (e.g. `build` → `plan`). */
    mode?: AgentMode;
    /** Force a rebuild of the system prompt (useful after promptBuilder edits). */
    rebuildSystemPrompt?: boolean;
    /** Replay mode. Default: recorded-tool (mode A). */
    replayMode?: ReplayMode;
}

export interface ReplayResult {
    originalRunId: string;
    newRun: AgentRunRecord;
    missedToolCalls: number;
    /** Tool calls that didn't match any ledger entry — strong signal the new prompt diverged. */
    missedToolDescriptors: Array<{ toolName: string; argsHash: string }>;
}

/**
 * Map of (toolName + argsHash) → recorded tool result. Used by AgentRunner
 * in replay mode to short-circuit tool execution and return canned results.
 */
export class ReplaySession {
    public readonly mode: ReplayMode;
    public readonly originalRunId: string;
    private readonly resultMap = new Map<string, unknown>();
    public missedCount = 0;
    public missedDescriptors: Array<{ toolName: string; argsHash: string }> = [];

    constructor(originalRunId: string, mode: ReplayMode = 'recorded-tool') {
        this.originalRunId = originalRunId;
        this.mode = mode;
    }

    /** Index a tool_call_created + tool_call_end pair from the ledger. */
    record(toolName: string, toolArgs: any, result: unknown): void {
        const key = makeReplayKey(toolName, toolArgs);
        this.resultMap.set(key, result);
    }

    /** Returns recorded result for this tool invocation, or `undefined` if miss. */
    lookup(toolName: string, toolArgs: any): unknown | undefined {
        const key = makeReplayKey(toolName, toolArgs);
        const hit = this.resultMap.get(key);
        if (hit === undefined) {
            this.missedCount++;
            this.missedDescriptors.push({ toolName, argsHash: key.slice(0, 64) });
        }
        return hit;
    }

    has(toolName: string, toolArgs: any): boolean {
        return this.resultMap.has(makeReplayKey(toolName, toolArgs));
    }
}

function makeReplayKey(toolName: string, toolArgs: any): string {
    const argsCanonical = canonicalize(toolArgs);
    return `${toolName}|${argsCanonical}`;
}

/**
 * Canonical JSON for hashing: keys sorted, undefined dropped. Stable across
 * argument-order variations the LLM may emit.
 */
function canonicalize(value: any): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/**
 * Build a ReplaySession from a previously-recorded run's ledger events.
 */
export function buildReplaySession(events: AgentRunEvent[], mode: ReplayMode = 'recorded-tool'): ReplaySession {
    const runId = events[0]?.runId ?? 'unknown';
    const session = new ReplaySession(runId, mode);

    const pending = new Map<string, { toolName: string; toolArgs: any }>();
    for (const ev of events) {
        const p = ev.payload as Record<string, any> | undefined;
        if (ev.type === 'tool_call_created' && ev.invocationId) {
            pending.set(ev.invocationId, {
                toolName: p?.toolName ?? '',
                toolArgs: p?.toolArgs,
            });
        } else if (ev.type === 'tool_call_end' && ev.invocationId) {
            const created = pending.get(ev.invocationId);
            if (created && created.toolName) {
                const result = p?.result ?? p?.toolResult ?? p?.output ?? p;
                session.record(created.toolName, created.toolArgs, result);
            }
            pending.delete(ev.invocationId);
        }
    }
    return session;
}

/**
 * Extract the user prompt that originally kicked off the run.
 */
export function extractOriginalUserPrompt(events: AgentRunEvent[]): string | undefined {
    for (const ev of events) {
        if (ev.type === 'run_created') {
            const p = ev.payload as Record<string, any> | undefined;
            const candidate = p?.userPrompt ?? p?.prompt;
            if (typeof candidate === 'string') return candidate;
        }
    }
    return undefined;
}

/**
 * Replay a recorded run. Caller supplies the live AgentRunner instance to
 * dispatch into; we read the original ledger, derive the user prompt + tool
 * stubs, and call `runner.run` with overrides + an attached ReplaySession.
 *
 * The new run is recorded as a fresh runId in the ledger with `replayOf`
 * meta-payload pointing back at the original.
 */
export async function replayRun(
    originalRunId: string,
    runner: AgentRunner,
    overrides: ReplayOverrides = {},
): Promise<ReplayResult> {
    const snapshot = runLedger.getSnapshot(originalRunId);
    if (!snapshot) {
        throw new Error(`replayRun: original run ${originalRunId} not found in ledger`);
    }
    const events = snapshot.events;
    const userPrompt = extractOriginalUserPrompt(events);
    if (!userPrompt) {
        throw new Error(`replayRun: could not extract original user prompt from ${originalRunId}`);
    }
    const mode: AgentMode = overrides.mode ?? (snapshot.run as any).mode ?? 'build';
    const replayMode: ReplayMode = overrides.replayMode ?? 'recorded-tool';
    if (replayMode === 'full-replay') {
        // Mode B not implemented — fall through to mode A but flag.
        // (Plan leaves it deferred until workspace snapshotting lands.)
    }
    const session = buildReplaySession(events, replayMode);

    const stepCollector: AgentStep[] = [];
    const opts: AgentRunnerOptions = {
        providerId: overrides.providerId,
        model: overrides.model,
        mode,
        replaySession: session,
        replayOf: originalRunId,
        rebuildSystemPrompt: overrides.rebuildSystemPrompt,
        onStep: (step: AgentStep) => stepCollector.push(step),
    };

    // AgentRunner.run signature: (userMessage, context, conversationHistory, options, images).
    // For replay we start from a fresh history and let the original prompt drive turn 1.
    const gen: GenerationResult = await (runner as any).run(
        userPrompt,
        { topicId: `replay-${originalRunId}` },
        [],
        opts,
    );
    const newRunId = (gen as any).runId ?? (gen as any).run?.runId;
    const newSnapshot = newRunId ? runLedger.getSnapshot(newRunId) : undefined;

    return {
        originalRunId,
        newRun: newSnapshot?.run ?? ({} as AgentRunRecord),
        missedToolCalls: session.missedCount,
        missedToolDescriptors: session.missedDescriptors,
    };
}

// ─── Hook used by AgentToolExecutor when in replay mode ──────────────────────

/**
 * Helper that lets the tool executor short-circuit a tool call when a replay
 * session has the recorded result. Returns `{ hit: true, result }` if served
 * from the ledger, `{ hit: false }` otherwise (caller falls back to live exec).
 */
export function maybeServeFromReplay(
    session: ReplaySession | undefined,
    toolName: AgentToolName | string,
    toolArgs: any,
): { hit: boolean; result?: unknown } {
    if (!session) return { hit: false };
    const recorded = session.lookup(toolName, toolArgs);
    if (recorded === undefined) return { hit: false };
    return { hit: true, result: recorded };
}
