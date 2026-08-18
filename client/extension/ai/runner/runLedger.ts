import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { getPrivateTopicRootCandidates, getPrivateTopicStorageDir } from '../workspacePaths';
import { ErrorReporter } from '../errorReporter';
import {
    AgentRunRecord,
    type AdmissionDecision,
    type AgentRunPhase,
    type AgentRunStatus,
    type AgentSchedulingState,
    type ChatMessage,
} from '../types';
import { isPathInsideOrEqual } from '../../pathScope';
import { isRecord } from '../../../shared/protocolValidation';
import { atomicWriteJson, atomicWriteText, readJsonWithBackup, sha256Text } from './durableStorage';
import { getHistoryPolicy } from './historyPolicy';
import { schedulingStateFromAdmission } from './scheduling';
import {
    applyModelRequestMessageArchive,
    type ModelRequestMessageArchive,
} from './requestArtifacts';

const RUN_LEDGER_FIELD_MAX_CHARS = 6000;
const RUN_STATE_MAX_LOAD_BYTES = 4_000_000;
const RUN_EVENTS_MAX_LOAD_BYTES = 4_000_000;
const PERSIST_DEBOUNCE_MS = 150;
/** Terminal runs whose full event arrays stay in memory; older ones are re-read from disk on demand. */
const MAX_MEMORY_TERMINAL_RUN_EVENTS = 20;
const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled', 'completed']);

export type AgentRunEventType =
    | 'run_created'
    | 'item_started'
    | 'item_updated'
    | 'item_completed'
    | 'status_changed'
    | 'step_appended'
    | 'model_call_start'
    | 'model_call_delta'
    | 'model_call_end'
    | 'tool_call_created'
    | 'tool_call_start'
    | 'tool_call_end'
    | 'tool_output_delta'
    | 'input_queued'
    | 'input_injected'
    | 'process_started'
    | 'process_output_delta'
    | 'process_completed'
    | 'permission_requested'
    | 'permission_resolved'
    | 'write_confirmation_requested'
    | 'write_confirmation_resolved'
    | 'file_change'
    | 'todo_update'
    | 'artifact_created'
    | 'checkpoint_saved'
    | 'resume_state_saved'
    | 'compaction_start'
    | 'compaction_end'
    | 'validation_start'
    | 'validation_end'
    | 'subagent_start'
    | 'subagent_end'
    | 'metrics_updated'
    | 'error'
    | 'cancelled'
    | 'complete'
    | 'cache_stats'
    | 'blackboard_write'
    | 'blackboard_read'
    | 'conflict_detected'
    | 'quality_gate_decision'
    | 'subagent_refused'
    | 'policy_resolved'
    | 'approval_rule_created'
    | 'denial_feedback_emitted'
    | 'sandbox_denied'
    | 'subagent_policy_derived'
    | 'mcp_tool_registered'
    | 'reviewer_decision'
    | 'reviewer_cache_invalidated'
    | 'env_allowlist_shadow'
    | 'worktree_created'
    | 'worktree_diff_collected'
    | 'worktree_cleaned'
    | 'evidence_gate_decision'
    | 'admission_decided'
    | 'phase_changed'
    | 'capabilities_changed'
    | 'prompt_queued'
    | 'prompt_steered'
    | 'dispatch_evaluated'
    | 'agent_suspended'
    | 'agent_requeued'
    | 'provider_capacity_changed'
    | 'route_outcome_evaluated'
    | 'domain_op_applied'
    | 'domain_replay_completed'
    | 'goal_transitioned'
    | 'goal_budget_exhausted'
    | 'goal_continuation_queued'
    | 'task_created'
    | 'task_status_changed'
    | 'task_notification_delivered'
    | 'tool_disclosure_changed'
    | 'tool_call_deduplicated'
    | 'tool_repeat_escalated'
    | 'context_limit_observed'
    | 'compaction_retry'
    | 'undo_started'
    | 'undo_completed'
    | 'side_question_started'
    | 'side_question_completed';

export interface AgentRunEvent {
    eventId: string;
    runId: string;
    sequence: number;
    timestamp: number;
    type: AgentRunEventType;
    status?: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
    invocationId?: string;
    agentId?: string;
    /** Event payloads have many shapes (step/toolArgs/result/diff/…); consumers
     * narrow each field. Converting this to `unknown` would force ~90 call-site
     * casts, so the envelope keeps `any` — validate at the consumer boundary. */
    payload: any;
}

export interface LargeResultCleanupResult {
    deletedCount: number;
    keptCount: number;
    reclaimedBytes: number;
}

export class RunLedger {
    private static instance: RunLedger | undefined;
    private activeRuns = new Map<string, AgentRunRecord>();
    private runEvents = new Map<string, AgentRunEvent[]>();
    private runSequences = new Map<string, number>();
    private persistenceQueues = new Map<string, Promise<void>>();
    private pendingEventBatches = new Map<string, AgentRunEvent[]>();
    private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private flushRequests = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    private runPrompts = new Map<string, string>();
    private runDirectories = new Map<string, string>();
    private emitter = new EventEmitter();

    private static latestActiveRunId: string | undefined;

    public static getLatestActiveRunId(): string | undefined {
        return RunLedger.latestActiveRunId;
    }

    private constructor() {}

    public static getInstance(): RunLedger {
        if (!RunLedger.instance) {
            RunLedger.instance = new RunLedger();
        }
        return RunLedger.instance;
    }

    public onChange(listener: (runId: string) => void): void {
        this.emitter.on('change', listener);
    }

    /** List runs newest-first (in-memory cache only — does not scan disk). T4.2 uses this for the replay picker. */
    public listRecentRuns(): AgentRunRecord[] {
        return Array.from(this.activeRuns.values())
            .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    }

    public getRun(runId: string): AgentRunRecord | undefined {
        return this.activeRuns.get(runId);
    }

    public getLatestEvent(runId: string): AgentRunEvent | undefined {
        return this.runEvents.get(runId)?.at(-1);
    }

    public async createRun(
        topicId: string,
        mode: string,
        userPromptPreview: string,
        parentRunId?: string,
        userPrompt?: string,
        metadata?: {
            agentId?: string;
            providerId?: string;
            model?: string;
            workflowId?: string | null;
            threadId?: string;
            turnId?: string;
            schedulingState?: AgentSchedulingState;
        },
    ): Promise<AgentRunRecord> {
        const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        RunLedger.latestActiveRunId = runId;
        const now = Date.now();
        const hasUserPrompt = typeof userPrompt === 'string' && getHistoryPolicy().persistence === 'full';
        const promptRef = hasUserPrompt ? 'prompt.json' : undefined;
        const promptSha256 = hasUserPrompt ? sha256Text(userPrompt) : undefined;
        const record: AgentRunRecord = {
            runId,
            topicId,
            parentRunId,
            agentId: metadata?.agentId,
            threadId: metadata?.threadId,
            turnId: metadata?.turnId,
            status: 'created',
            mode,
            schedulingState: metadata?.schedulingState,
            workflowId: metadata?.workflowId,
            providerId: metadata?.providerId,
            model: metadata?.model,
            userPromptPreview,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
            steps: [],
            metrics: {
                totalTokens: 0,
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                costCny: 0,
                iterations: 0,
                maxIterations: 0,
                toolCalls: 0,
                modelCallCount: 0,
                compactionCount: 0,
                repeatedToolSignatureCount: 0,
                failedToolCount: 0,
                permissionRequested: 0,
                permissionApproved: 0,
                permissionDenied: 0,
                artifactizedResultCount: 0
            },
            context: promptRef ? { promptRef, promptSha256 } : undefined,
            writtenFiles: []
        };
        this.activeRuns.set(runId, record);
        this.runEvents.set(runId, []);
        this.runSequences.set(runId, 0);
        this.runDirectories.set(runId, this.getRunDir(topicId, runId));

        if (hasUserPrompt) {
            this.runPrompts.set(runId, userPrompt);
            try {
                await atomicWriteJson(path.join(this.getRunDir(topicId, runId), promptRef!), {
                    version: 1,
                    prompt: userPrompt,
                    sha256: promptSha256,
                });
            } catch (error) {
                ErrorReporter.warn('RunLedger', `Failed to archive original prompt for run ${runId}`, error);
            }
        }

        await this.appendEvent(runId, 'run_created', {
            topicId,
            mode,
            userPromptPreview,
            promptRef,
            promptSha256,
            parentRunId,
            agentId: metadata?.agentId,
            providerId: metadata?.providerId,
            model: metadata?.model,
            workflowId: metadata?.workflowId,
            threadId: metadata?.threadId,
            turnId: metadata?.turnId,
            schedulingState: metadata?.schedulingState,
        }, { agentId: metadata?.agentId });

        return record;
    }

    public async appendEvent(
        runId: string,
        type: AgentRunEventType,
        payload: any,
        metadata?: { invocationId?: string; agentId?: string; status?: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' },
        options?: { debounced?: boolean },
    ): Promise<void> {
        const run = this.activeRuns.get(runId);
        if (!run) {
            ErrorReporter.debug('RunLedger', `Attempted to append event to non-existent run: ${runId}`);
            return;
        }
        if (this.shouldSkipPersistedEvent(type, payload)) {
            run.updatedAt = Date.now();
            return;
        }
        const wasTerminal = this.isTerminalRun(run);

        const timestamp = Date.now();
        run.updatedAt = timestamp;
        const storedPayload = this.compactPayloadForLedger(type, payload) as Record<string, unknown>;

        // Apply event to state
        if (type === 'status_changed') {
            if (typeof storedPayload.status === 'string') {
                run.status = storedPayload.status as AgentRunStatus;
            }
        } else if (type === 'file_change' && typeof storedPayload.filePath === 'string') {
            if (!run.writtenFiles.includes(storedPayload.filePath)) {
                run.writtenFiles.push(storedPayload.filePath);
            }
        } else if (type === 'tool_call_end' && Array.isArray(storedPayload?.writtenFiles)) {
            for (const filePath of storedPayload.writtenFiles) {
                if (typeof filePath === 'string' && filePath && !run.writtenFiles.includes(filePath)) {
                    run.writtenFiles.push(filePath);
                }
            }
        } else if (type === 'subagent_end' && Array.isArray(storedPayload?.filesWritten)) {
            for (const filePath of storedPayload.filesWritten) {
                if (typeof filePath === 'string' && filePath && !run.writtenFiles.includes(filePath)) {
                    run.writtenFiles.push(filePath);
                }
            }
        } else if (type === 'metrics_updated' && isRecord(storedPayload.metrics)) {
            run.metrics = { ...run.metrics, ...storedPayload.metrics };
        } else if (type === 'phase_changed' && run.schedulingState && typeof storedPayload?.to === 'string') {
            run.schedulingState = {
                ...run.schedulingState,
                phase: storedPayload.to as AgentRunPhase,
                phaseReason: typeof storedPayload.reason === 'string' ? storedPayload.reason : run.schedulingState.phaseReason,
                revision: typeof storedPayload.revision === 'number'
                    ? storedPayload.revision
                    : run.schedulingState.revision + 1,
            };
        } else if (type === 'dispatch_evaluated' && run.schedulingState && storedPayload?.accepted === true) {
            run.schedulingState = {
                ...run.schedulingState,
                dispatch: 'parallel',
                dispatchReason: typeof storedPayload.reason === 'string' ? storedPayload.reason : run.schedulingState.dispatchReason,
                revision: run.schedulingState.revision + 1,
            };
        }
        const metrics = run.metrics;
        if (type === 'model_call_start') {
            metrics.modelCallCount = (metrics.modelCallCount ?? 0) + 1;
        } else if (type === 'tool_call_end' && storedPayload?.success === false && !storedPayload?.skipped) {
            metrics.failedToolCount = (metrics.failedToolCount ?? 0) + 1;
        } else if (type === 'permission_requested') {
            metrics.permissionRequested = (metrics.permissionRequested ?? 0) + 1;
        } else if (type === 'permission_resolved') {
            if (storedPayload?.allowed) {
                metrics.permissionApproved = (metrics.permissionApproved ?? 0) + 1;
            } else {
                metrics.permissionDenied = (metrics.permissionDenied ?? 0) + 1;
            }
        } else if (type === 'artifact_created') {
            metrics.artifactizedResultCount = (metrics.artifactizedResultCount ?? 0) + 1;
        } else if (type === 'compaction_end' && storedPayload?.success !== false) {
            metrics.compactionCount = (metrics.compactionCount ?? 0) + 1;
        }

        // 自增序号计算，保证 sequence 全局单调递增，不依赖时间戳精度
        const currentSeq = (this.runSequences.get(runId) ?? 0) + 1;
        this.runSequences.set(runId, currentSeq);

        const event: AgentRunEvent = {
            eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            runId,
            sequence: currentSeq,
            timestamp,
            type,
            status: metadata?.status,
            invocationId: metadata?.invocationId,
            agentId: metadata?.agentId,
            payload: storedPayload
        };

        // Store in memory
        const events = this.runEvents.get(runId);
        if (events) events.push(event);

        // Persist in per-run sequence order. Events are batched per flush window
        // (debounced for fire-and-forget appends, next-microtask for awaited ones)
        // so high-frequency deltas such as process output do not deep-copy and
        // rewrite run_state.json per chunk. A run reaching a terminal state
        // always flushes immediately so the final state lands on disk promptly.
        if (getHistoryPolicy().persistence !== 'off') {
            const batch = this.pendingEventBatches.get(runId);
            if (batch) batch.push(event);
            else this.pendingEventBatches.set(runId, [event]);

            const terminalNow = this.isTerminalRun(run);
            if (options?.debounced && !terminalNow) {
                this.requestDebouncedFlush(runId);
            } else {
                const timer = this.flushTimers.get(runId);
                if (timer) {
                    clearTimeout(timer);
                    this.flushTimers.delete(runId);
                }
                await this.requestFlush(runId);
            }
            if (!wasTerminal && terminalNow) {
                this.evictTerminalRunEvents();
            }
        }

        // Notify subscribers of the change
        this.emitter.emit('change', runId);
    }

    private shouldSkipPersistedEvent(type: AgentRunEventType, _payload: unknown): boolean {
        if (type === 'model_call_delta' || type === 'tool_output_delta') return true;
        return type === 'step_appended';
    }

    private clipText(value: unknown, maxChars = RUN_LEDGER_FIELD_MAX_CHARS): string {
        const text = typeof value === 'string' ? value : String(value ?? '');
        if (text.length <= maxChars) return text;
        return `${text.slice(0, maxChars)}\n... (${text.length - maxChars} chars truncated)`;
    }

    private compactUnknown(value: unknown, maxChars = RUN_LEDGER_FIELD_MAX_CHARS): unknown {
        if (value == null) return value;
        if (typeof value === 'string') return this.clipText(value, maxChars);
        let raw = '';
        try {
            raw = JSON.stringify(value);
        } catch {
            return this.clipText(String(value), maxChars);
        }
        if (raw.length <= maxChars) return value;
        return { _truncated: true, preview: this.clipText(raw, maxChars) };
    }

    private compactStep(step: unknown): unknown | undefined {
        if (!step || typeof step !== 'object') return step;
        const obj = step as Record<string, unknown>;
        const type = String(obj.type || '');
        if (type === 'text_delta' || type === 'thinking_content') return undefined;
        if (type === 'orchestrator_progress' && /waiting|等待模型返回/i.test(String(obj.content || ''))) return undefined;
        const copy: Record<string, unknown> = { ...obj };
        if (typeof copy.content === 'string') copy.content = this.clipText(copy.content);
        if (copy.toolArgs !== undefined) copy.toolArgs = this.compactUnknown(copy.toolArgs);
        if (copy.toolResult !== undefined) copy.toolResult = this.compactUnknown(copy.toolResult);
        return copy;
    }

    private compactPayloadForLedger(type: AgentRunEventType, payload: unknown): unknown {
        if (!payload || typeof payload !== 'object') return this.compactUnknown(payload);
        const obj = payload as Record<string, unknown>;
        if (type === 'step_appended') {
            return { ...obj, step: this.compactStep(obj.step) };
        }
        if (type === 'tool_call_created' || type === 'tool_call_start') {
            const args = this.compactUnknown(obj.toolArgs ?? obj.args ?? obj.arguments);
            return { ...obj, toolArgs: args, args, arguments: args };
        }
        if (type === 'tool_call_end') {
            return { ...obj, result: this.compactUnknown(obj.result) };
        }
        if (type === 'file_change' && obj.diff) {
            return { ...obj, diff: this.clipText(obj.diff) };
        }
        if (type === 'compaction_end' && obj.summary) {
            return { ...obj, summary: this.compactUnknown(obj.summary) };
        }
        return this.compactUnknown(payload);
    }

    /**
     * Returns the full snapshot of a run: record + all events.
     */
    public getSnapshot(runId: string): { run: AgentRunRecord; events: AgentRunEvent[] } | undefined {
        const run = this.activeRuns.get(runId);
        if (!run) return undefined;
        return { run, events: this.runEvents.get(runId) ?? [] };
    }

    public async getOrLoadSnapshot(
        runId: string,
        topicId?: string,
    ): Promise<{ run: AgentRunRecord; events: AgentRunEvent[] } | undefined> {
        const existing = this.getSnapshot(runId);
        if (existing) return existing;

        const match = await this.findRunDirectory(runId, topicId);
        if (!match) return undefined;
        await this.loadRunFromDirectory(match.topicId, runId, match.runDir);
        return this.getSnapshot(runId);
    }

    public async readPrompt(runId: string, topicId?: string): Promise<string | undefined> {
        const inMemory = this.runPrompts.get(runId);
        if (inMemory !== undefined) return inMemory;

        const snapshot = await this.getOrLoadSnapshot(runId, topicId);
        if (!snapshot) return undefined;
        const created = snapshot.events.find(event => event.type === 'run_created');
        const ref = created?.payload?.promptRef ?? snapshot.run.context?.promptRef;
        const expectedHash = created?.payload?.promptSha256 ?? snapshot.run.context?.promptSha256;
        if (typeof ref !== 'string' || !ref) return undefined;

        const runDir = this.resolveRunDir(snapshot.run.topicId, runId);
        const promptPath = path.isAbsolute(ref) ? ref : path.join(runDir, ref);
        if (!isPathInsideOrEqual(promptPath, runDir)) {
            ErrorReporter.warn('RunLedger', `Rejected prompt artifact outside run directory for ${runId}`);
            return undefined;
        }
        const loaded = readJsonWithBackup<{ prompt: string; sha256?: string }>(
            promptPath,
            (value): value is { prompt: string; sha256?: string } => {
                if (!value || typeof value !== 'object') return false;
                const candidate = value as { prompt?: unknown; sha256?: unknown };
                if (typeof candidate.prompt !== 'string') return false;
                const actualHash = sha256Text(candidate.prompt);
                return (!expectedHash || actualHash === expectedHash)
                    && (typeof candidate.sha256 !== 'string' || actualHash === candidate.sha256);
            },
        );
        if (!loaded) {
            ErrorReporter.warn('RunLedger', `Prompt checksum mismatch for run ${runId}`);
            return undefined;
        }
        this.runPrompts.set(runId, loaded.value.prompt);
        return loaded.value.prompt;
    }

    public async readResumeTranscript(runId: string, topicId?: string): Promise<import('../types').ChatMessage[] | undefined> {
        const snapshot = await this.getOrLoadSnapshot(runId, topicId);
        if (!snapshot) return undefined;
        const runDir = this.resolveRunDir(snapshot.run.topicId, runId);
        const transcriptPath = path.join(runDir, 'resume_transcript.json');
        return readJsonWithBackup<import('../types').ChatMessage[]>(
            transcriptPath,
            (value): value is import('../types').ChatMessage[] => Array.isArray(value),
        )?.value;
    }

    /**
     * Replay the newest checksummed model-request transcript newer than a
     * periodic resume snapshot. Model requests are archived before provider
     * execution, so a crash can safely resume from this last complete prompt.
     */
    public async readLatestModelRequestMessages(
        runId: string,
        topicId?: string,
        afterSequence = 0,
    ): Promise<{ messages: ChatMessage[]; eventId: string; sequence: number } | undefined> {
        const snapshot = await this.getOrLoadSnapshot(runId, topicId);
        if (!snapshot) return undefined;
        const runDir = this.resolveRunDir(snapshot.run.topicId, runId);
        const requestEvents = snapshot.events
            .filter(event => (
                event.type === 'model_call_start'
                && event.sequence > afterSequence
                && typeof event.payload?.requestRef === 'string'
            ))
            .sort((left, right) => right.sequence - left.sequence);
        if (requestEvents.length === 0) return undefined;

        const expectedHashes = new Map<string, string>();
        for (const event of snapshot.events) {
            const ref = event.payload?.requestRef;
            const sha256 = event.payload?.requestSha256;
            if (typeof ref === 'string' && typeof sha256 === 'string') expectedHashes.set(ref, sha256);
        }

        type PersistedModelRequest = {
            version: 2;
            kind: 'model_request';
            messageArchive: ModelRequestMessageArchive;
        };
        const isMessage = (value: unknown): value is ChatMessage => (
            !!value && typeof value === 'object'
            && typeof (value as { role?: unknown }).role === 'string'
            && 'content' in value
        );
        const isArchive = (value: unknown): value is ModelRequestMessageArchive => {
            if (!value || typeof value !== 'object') return false;
            const archive = value as Partial<ModelRequestMessageArchive>;
            if (archive.format === 'full') {
                return Array.isArray(archive.messages) && archive.messages.every(isMessage);
            }
            return archive.format === 'delta'
                && typeof archive.baseRequestRef === 'string'
                && Number.isInteger(archive.commonPrefixLength)
                && (archive.commonPrefixLength ?? -1) >= 0
                && Array.isArray(archive.appendedMessages)
                && archive.appendedMessages.every(isMessage);
        };

        const resolveArchive = (
            requestRef: string,
            seen: Set<string>,
            depth: number,
        ): ChatMessage[] | undefined => {
            const normalizedRef = requestRef.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!normalizedRef || depth > 64 || seen.has(normalizedRef)) return undefined;
            const requestPath = path.join(runDir, ...normalizedRef.split('/'));
            if (!isPathInsideOrEqual(requestPath, runDir)) return undefined;
            seen.add(normalizedRef);
            const expectedHash = expectedHashes.get(requestRef) ?? expectedHashes.get(normalizedRef);
            const loaded = readJsonWithBackup<PersistedModelRequest>(
                requestPath,
                (value): value is PersistedModelRequest => {
                    if (!value || typeof value !== 'object') return false;
                    const candidate = value as Partial<PersistedModelRequest>;
                    if (candidate.version !== 2 || candidate.kind !== 'model_request' || !isArchive(candidate.messageArchive)) {
                        return false;
                    }
                    return !expectedHash || sha256Text(JSON.stringify(value, null, 2)) === expectedHash;
                },
            );
            if (!loaded) return undefined;
            const archive = loaded.value.messageArchive;
            if (archive.format === 'full') return applyModelRequestMessageArchive(archive);
            const base = resolveArchive(archive.baseRequestRef, seen, depth + 1);
            return base ? applyModelRequestMessageArchive(archive, base) : undefined;
        };

        for (const event of requestEvents) {
            const requestRef = event.payload.requestRef as string;
            try {
                const messages = resolveArchive(requestRef, new Set<string>(), 0);
                if (messages) return { messages, eventId: event.eventId, sequence: event.sequence };
            } catch (error) {
                ErrorReporter.warn('RunLedger', `Failed to replay model request artifact ${requestRef}`, error);
            }
        }
        return undefined;
    }

    public async writeJsonArtifact(
        runId: string,
        relativePath: string,
        value: unknown,
    ): Promise<{ ref: string; sha256: string } | undefined> {
        if (getHistoryPolicy().persistence === 'off') return undefined;
        const run = this.activeRuns.get(runId);
        if (!run || path.isAbsolute(relativePath)) return undefined;

        const normalizedRef = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!normalizedRef || normalizedRef.split('/').some(part => part === '..')) {
            ErrorReporter.warn('RunLedger', `Rejected unsafe artifact path for ${runId}: ${relativePath}`);
            return undefined;
        }

        const runDir = this.resolveRunDir(run.topicId, runId);
        const artifactPath = path.join(runDir, ...normalizedRef.split('/'));
        if (!isPathInsideOrEqual(artifactPath, runDir)) {
            ErrorReporter.warn('RunLedger', `Rejected artifact outside run directory for ${runId}: ${relativePath}`);
            return undefined;
        }

        const serialized = JSON.stringify(value, null, 2);
        const sha256 = sha256Text(serialized);
        await atomicWriteJson(artifactPath, value);
        return { ref: normalizedRef, sha256 };
    }

    private getRunDir(topicId: string, runId: string): string {
        const topicDir = getPrivateTopicStorageDir(topicId);
        return path.join(topicDir, 'runs', runId);
    }

    private resolveRunDir(topicId: string, runId: string): string {
        return this.runDirectories.get(runId) ?? this.getRunDir(topicId, runId);
    }

    /** Flush the buffered events of a run on the next microtask; bursts coalesce into one write. */
    private requestFlush(runId: string): Promise<void> {
        const existing = this.flushRequests.get(runId);
        if (existing) return existing.promise;
        let resolve!: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        const entry = { promise, resolve };
        this.flushRequests.set(runId, entry);
        queueMicrotask(() => {
            this.flushRequests.delete(runId);
            void this.flushRun(runId).then(entry.resolve, entry.resolve);
        });
        return entry.promise;
    }

    /** Debounce a fire-and-forget flush so a burst of deltas lands in one write. */
    private requestDebouncedFlush(runId: string): void {
        if (this.flushTimers.has(runId)) return;
        this.flushTimers.set(runId, setTimeout(() => {
            this.flushTimers.delete(runId);
            void this.flushRun(runId);
        }, PERSIST_DEBOUNCE_MS));
    }

    /**
     * Write one batch of buffered events plus the run state. The serialized state
     * is taken synchronously together with the batch drain, so the state on disk
     * always corresponds exactly to the last flushed event; events appended during
     * the async write join the next batch and are re-applied on resume via
     * lastStableSequence.
     */
    private flushRun(runId: string): Promise<void> {
        const run = this.activeRuns.get(runId);
        if (!run) return Promise.resolve();
        const batch = this.pendingEventBatches.get(runId);
        if (!batch || batch.length === 0) {
            return this.persistenceQueues.get(runId) ?? Promise.resolve();
        }
        this.pendingEventBatches.delete(runId);
        const policy = getHistoryPolicy();
        if (policy.persistence === 'off') return Promise.resolve();
        const stateText = this.serializeStateForPersistence(run, batch, policy);
        const previous = this.persistenceQueues.get(runId) ?? Promise.resolve();
        const current = previous
            .catch(() => {})
            .then(() => this.writeBatchToDisk(run, batch, stateText));
        this.persistenceQueues.set(runId, current);
        return current.finally(() => {
            if (this.persistenceQueues.get(runId) === current) {
                this.persistenceQueues.delete(runId);
            }
        });
    }

    private serializeStateForPersistence(
        run: AgentRunRecord,
        batch: AgentRunEvent[],
        policy: ReturnType<typeof getHistoryPolicy>,
    ): string | undefined {
        const last = batch[batch.length - 1]!;
        if (policy.persistence === 'metadata') {
            return JSON.stringify({ ...run, userPromptPreview: '', steps: [], context: undefined });
        }
        return JSON.stringify({
            ...run,
            context: { ...run.context, lastStableEventId: last.eventId, lastStableSequence: last.sequence },
        });
    }

    private async writeBatchToDisk(
        run: AgentRunRecord,
        batch: AgentRunEvent[],
        stateText: string | undefined,
    ): Promise<void> {
        try {
            const dir = this.resolveRunDir(run.topicId, run.runId);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            if (getHistoryPolicy().persistence === 'full') {
                const file = path.join(dir, 'events.jsonl');
                const handle = await fs.promises.open(file, 'a', 0o600);
                try {
                    await handle.writeFile(batch.map(event => JSON.stringify(event) + '\n').join(''), 'utf8');
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            }
            if (stateText !== undefined) {
                await atomicWriteText(path.join(dir, 'run_state.json'), stateText);
            }
        } catch (e) {
            ErrorReporter.warn('RunLedger', `Failed to persist run ${run.runId}`, e);
        }
    }

    /** Flush all pending persistence (used on extension deactivation). */
    public async flushAll(): Promise<void> {
        for (const [runId, timer] of this.flushTimers) {
            clearTimeout(timer);
            this.flushTimers.delete(runId);
        }
        const runIds = new Set<string>([...this.pendingEventBatches.keys(), ...this.persistenceQueues.keys()]);
        await Promise.all([...runIds].map(runId => this.flushRun(runId)));
    }

    private isTerminalRun(run: AgentRunRecord): boolean {
        return TERMINAL_RUN_STATUSES.has(run.status);
    }

    /** Drop event arrays of terminal runs beyond the retention window; re-read from disk on demand. */
    private evictTerminalRunEvents(): void {
        const candidates: Array<{ runId: string; updatedAt: number }> = [];
        for (const [runId] of this.runEvents) {
            const run = this.activeRuns.get(runId);
            if (!run || !this.isTerminalRun(run)) continue;
            candidates.push({ runId, updatedAt: run.updatedAt ?? 0 });
        }
        if (candidates.length <= MAX_MEMORY_TERMINAL_RUN_EVENTS) return;
        candidates.sort((a, b) => b.updatedAt - a.updatedAt);
        for (const candidate of candidates.slice(MAX_MEMORY_TERMINAL_RUN_EVENTS)) {
            this.runEvents.delete(candidate.runId);
            this.runPrompts.delete(candidate.runId);
        }
    }

    private async readEventsFromDisk(runDir: string, runId: string): Promise<AgentRunEvent[]> {
        const file = path.join(runDir, 'events.jsonl');
        if (!fs.existsSync(file)) return [];

        const events: AgentRunEvent[] = [];
        const stat = await fs.promises.stat(file);
        let text = '';
        if (stat.size <= RUN_EVENTS_MAX_LOAD_BYTES) {
            text = await fs.promises.readFile(file, 'utf8');
        } else {
            const start = Math.max(0, stat.size - RUN_EVENTS_MAX_LOAD_BYTES);
            const length = stat.size - start;
            const handle = await fs.promises.open(file, 'r');
            try {
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, start);
                text = buffer.toString('utf8');
                if (start > 0) {
                    const firstNewline = text.indexOf('\n');
                    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
                }
            } finally {
                await handle.close();
            }
        }
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const event = JSON.parse(trimmed) as AgentRunEvent;
                if (
                    event &&
                    event.runId === runId &&
                    typeof event.sequence === 'number' &&
                    typeof event.type === 'string'
                ) {
                    events.push(event);
                }
            } catch {
                ErrorReporter.warn('RunLedger', `Skipping malformed run event while loading ${runId}`);
            }
        }

        return events.sort((a, b) => (a.sequence - b.sequence) || (a.timestamp - b.timestamp));
    }

    private createLargeRunPlaceholder(topicId: string, runId: string, mtimeMs: number, size: number): AgentRunRecord {
        return {
            runId,
            topicId,
            status: 'running',
            mode: 'unknown',
            userPromptPreview: `Run state is large (${Math.round(size / 1024)} KB); showing a compact recovery view.`,
            startedAt: mtimeMs,
            createdAt: mtimeMs,
            updatedAt: mtimeMs,
            steps: [],
            metrics: {
                totalTokens: 0,
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                costCny: 0,
                iterations: 0,
                maxIterations: 0,
                toolCalls: 0,
                modelCallCount: 0,
                compactionCount: 0,
                repeatedToolSignatureCount: 0,
                failedToolCount: 0,
                permissionRequested: 0,
                permissionApproved: 0,
                permissionDenied: 0,
                artifactizedResultCount: 0,
            },
            writtenFiles: [],
        };
    }

    private applyPersistedEvents(record: AgentRunRecord, events: AgentRunEvent[], includeMetrics = false): void {
        record.steps = [];
        record.writtenFiles = Array.isArray(record.writtenFiles) ? record.writtenFiles : [];
        for (const event of events) {
            if (event.type === 'admission_decided') {
                const payload = event.payload as Partial<AdmissionDecision>;
                if ((payload.domainProfile === 'general' || payload.domainProfile === 'paradox')
                    && (payload.authorization === 'read_only'
                        || payload.authorization === 'plan_write_only'
                        || payload.authorization === 'workspace_write')
                    && (payload.initialPhase === 'inspect'
                        || payload.initialPhase === 'plan'
                        || payload.initialPhase === 'execute'
                        || payload.initialPhase === 'verify')) {
                    record.schedulingState = schedulingStateFromAdmission({
                        domainProfile: payload.domainProfile,
                        authorization: payload.authorization,
                        initialPhase: payload.initialPhase,
                        explicitDelegation: payload.explicitDelegation === true,
                        confidence: typeof payload.confidence === 'number' ? payload.confidence : 0,
                        evidence: Array.isArray(payload.evidence)
                            ? payload.evidence.filter((item): item is string => typeof item === 'string')
                            : [],
                    });
                }
            } else if (event.type === 'phase_changed' && record.schedulingState
                && ['inspect', 'plan', 'execute', 'verify', 'finalize'].includes(event.payload?.to)) {
                record.schedulingState = {
                    ...record.schedulingState,
                    phase: event.payload.to,
                    phaseReason: typeof event.payload.reason === 'string'
                        ? event.payload.reason
                        : record.schedulingState.phaseReason,
                    revision: typeof event.payload.revision === 'number'
                        ? event.payload.revision
                        : record.schedulingState.revision + 1,
                };
            } else if (event.type === 'dispatch_evaluated' && record.schedulingState
                && event.payload?.accepted === true) {
                record.schedulingState = {
                    ...record.schedulingState,
                    dispatch: 'parallel',
                    dispatchReason: typeof event.payload.reason === 'string'
                        ? event.payload.reason
                        : record.schedulingState.dispatchReason,
                    revision: record.schedulingState.revision + 1,
                };
            } else if (event.type === 'status_changed' && event.payload?.status) {
                record.status = event.payload.status;
            } else if (event.type === 'complete') {
                record.status = 'completed';
            } else if (event.type === 'file_change' && event.payload?.filePath && !record.writtenFiles.includes(event.payload.filePath)) {
                record.writtenFiles.push(event.payload.filePath);
            } else if (event.type === 'tool_call_end' && Array.isArray(event.payload?.writtenFiles)) {
                for (const filePath of event.payload.writtenFiles) {
                    if (typeof filePath === 'string' && !record.writtenFiles.includes(filePath)) record.writtenFiles.push(filePath);
                }
            } else if (event.type === 'subagent_end' && Array.isArray(event.payload?.filesWritten)) {
                for (const filePath of event.payload.filesWritten) {
                    if (typeof filePath === 'string' && !record.writtenFiles.includes(filePath)) record.writtenFiles.push(filePath);
                }
            }

            if (!includeMetrics) continue;
            if (event.type === 'metrics_updated') {
                record.metrics = { ...record.metrics, ...event.payload?.metrics };
            } else if (event.type === 'model_call_start') {
                record.metrics.modelCallCount = (record.metrics.modelCallCount ?? 0) + 1;
            } else if (event.type === 'tool_call_end' && event.payload?.success === false && !event.payload?.skipped) {
                record.metrics.failedToolCount = (record.metrics.failedToolCount ?? 0) + 1;
            } else if (event.type === 'permission_requested') {
                record.metrics.permissionRequested = (record.metrics.permissionRequested ?? 0) + 1;
            } else if (event.type === 'permission_resolved') {
                if (event.payload?.allowed) {
                    record.metrics.permissionApproved = (record.metrics.permissionApproved ?? 0) + 1;
                } else {
                    record.metrics.permissionDenied = (record.metrics.permissionDenied ?? 0) + 1;
                }
            } else if (event.type === 'artifact_created') {
                record.metrics.artifactizedResultCount = (record.metrics.artifactizedResultCount ?? 0) + 1;
            } else if (event.type === 'compaction_end' && event.payload?.success !== false) {
                record.metrics.compactionCount = (record.metrics.compactionCount ?? 0) + 1;
            }
        }
        const latest = events.at(-1);
        if (latest) {
            record.updatedAt = Math.max(record.updatedAt ?? 0, latest.timestamp);
            record.context = {
                ...record.context,
                lastStableEventId: latest.eventId,
                lastStableSequence: latest.sequence,
            };
        }
    }

    private async loadRunFromDirectory(
        topicId: string,
        runId: string,
        runDir: string,
    ): Promise<AgentRunRecord | undefined> {
        const stateFile = path.join(runDir, 'run_state.json');
        const loadedState = readJsonWithBackup<AgentRunRecord>(stateFile, (value): value is AgentRunRecord => (
            !!value && typeof value === 'object' && typeof (value as AgentRunRecord).runId === 'string'
        ));
        if (!loadedState) return undefined;

        const stateStat = await fs.promises.stat(loadedState.sourcePath);
        const record = stateStat.size > RUN_STATE_MAX_LOAD_BYTES
            ? this.createLargeRunPlaceholder(topicId, runId, stateStat.mtimeMs, stateStat.size)
            : loadedState.value;
        const events = await this.readEventsFromDisk(runDir, runId);
        const stableSequence = record.context?.lastStableSequence;
        const unappliedEvents = typeof stableSequence === 'number'
            ? events.filter(event => event.sequence > stableSequence)
            : events;
        this.applyPersistedEvents(record, unappliedEvents, typeof stableSequence === 'number');
        const latestSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0);
        this.activeRuns.set(record.runId, record);
        this.runEvents.set(record.runId, events);
        this.runSequences.set(record.runId, latestSequence);
        this.runDirectories.set(record.runId, runDir);
        return record;
    }

    private async findRunDirectory(
        runId: string,
        topicId?: string,
    ): Promise<{ topicId: string; runDir: string } | undefined> {
        if (topicId) {
            const runDir = this.getRunDir(topicId, runId);
            if (fs.existsSync(runDir)) return { topicId, runDir };
        }

        for (const root of getPrivateTopicRootCandidates()) {
            const topics = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
            for (const topic of topics) {
                if (!topic.isDirectory()) continue;
                const runDir = path.join(root, topic.name, 'runs', runId);
                if (fs.existsSync(runDir)) return { topicId: topic.name, runDir };
            }
        }
        return undefined;
    }

    public async listRecentRunsFromDisk(limit = 50): Promise<AgentRunRecord[]> {
        const candidates: Array<{ topicId: string; runId: string; runDir: string; mtimeMs: number }> = [];
        for (const root of getPrivateTopicRootCandidates()) {
            const topics = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
            for (const topic of topics) {
                if (!topic.isDirectory()) continue;
                const runsDir = path.join(root, topic.name, 'runs');
                const runs = await fs.promises.readdir(runsDir, { withFileTypes: true }).catch(() => []);
                for (const run of runs) {
                    if (!run.isDirectory()) continue;
                    const runDir = path.join(runsDir, run.name);
                    const stat = await fs.promises.stat(runDir).catch(() => undefined);
                    if (stat) candidates.push({ topicId: topic.name, runId: run.name, runDir, mtimeMs: stat.mtimeMs });
                }
            }
        }

        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const candidate of candidates.slice(0, Math.max(limit * 2, limit))) {
            if (!this.activeRuns.has(candidate.runId)) {
                await this.loadRunFromDirectory(candidate.topicId, candidate.runId, candidate.runDir);
            }
        }
        return this.listRecentRuns().slice(0, limit);
    }

    /**
     * Attempts to load the latest run for a given topic.
     * Useful for restoring pending write confirm / permission cards on startup.
     */
    public async loadLatestRunForTopic(topicId: string): Promise<AgentRunRecord | undefined> {
        try {
            const topicDir = getPrivateTopicStorageDir(topicId);
            const runsDir = path.join(topicDir, 'runs');
            if (!fs.existsSync(runsDir)) return undefined;

            const runIds = await fs.promises.readdir(runsDir);
            if (runIds.length === 0) return undefined;

            // Sort by directory stat mtime or directory name
            const runsWithTime = await Promise.all(runIds.map(async id => {
                const p = path.join(runsDir, id);
                const stat = await fs.promises.stat(p);
                return { id, mtime: stat.mtimeMs };
            }));

            runsWithTime.sort((a, b) => b.mtime - a.mtime);
            const latestRunId = runsWithTime[0]?.id;
            if (!latestRunId) return undefined;

            const runDir = path.join(runsDir, latestRunId);
            return await this.loadRunFromDirectory(topicId, latestRunId, runDir);
        } catch (e) {
            ErrorReporter.warn('RunLedger', `Failed to load latest run for topic ${topicId}`, e);
            return undefined;
        }
    }

    public async cleanupLargeResultArtifacts(
        topicId: string,
        options: { maxAgeDays?: number; maxFiles?: number } = {}
    ): Promise<LargeResultCleanupResult> {
        const result: LargeResultCleanupResult = { deletedCount: 0, keptCount: 0, reclaimedBytes: 0 };
        const maxAgeDays = options.maxAgeDays ?? 14;
        const maxFiles = options.maxFiles ?? 50;
        const cutoff = Date.now() - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;
        const topicDir = getPrivateTopicStorageDir(topicId);
        const runsDir = path.join(topicDir, 'runs');
        if (!fs.existsSync(runsDir)) return result;

        const candidates: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
        const runIds = await fs.promises.readdir(runsDir).catch(() => []);
        for (const runId of runIds) {
            const largeDir = path.join(runsDir, runId, 'large_results');
            if (!fs.existsSync(largeDir)) continue;
            const entries = await fs.promises.readdir(largeDir).catch(() => []);
            for (const entry of entries) {
                const filePath = path.join(largeDir, entry);
                try {
                    const stat = await fs.promises.stat(filePath);
                    if (!stat.isFile()) continue;
                    candidates.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
                } catch {
                    // Ignore files that disappeared while scanning.
                }
            }
        }

        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index]!;
            const expired = candidate.mtimeMs < cutoff;
            const overLimit = index >= maxFiles;
            if (expired || overLimit) {
                try {
                    await fs.promises.unlink(candidate.filePath);
                    result.deletedCount++;
                    result.reclaimedBytes += candidate.size;
                } catch {
                    // Ignore files that could not be deleted; they simply remain kept.
                    result.keptCount++;
                }
            } else {
                result.keptCount++;
            }
        }

        return result;
    }
}

export const runLedger = RunLedger.getInstance();
