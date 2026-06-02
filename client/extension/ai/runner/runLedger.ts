import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { getTopicStorageDir } from '../workspacePaths';
import { ErrorReporter } from '../errorReporter';
import { AgentRunRecord } from '../types';

const RUN_LEDGER_FIELD_MAX_CHARS = 6000;
const RUN_STATE_MAX_LOAD_BYTES = 4_000_000;
const RUN_EVENTS_MAX_LOAD_BYTES = 4_000_000;

export type AgentRunEventType =
    | 'run_created'
    | 'status_changed'
    | 'step_appended'
    | 'model_call_start'
    | 'model_call_delta'
    | 'model_call_end'
    | 'tool_call_created'
    | 'tool_call_start'
    | 'tool_call_end'
    | 'tool_output_delta'
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
    | 'subagent_refused';

export interface AgentRunEvent {
    eventId: string;
    runId: string;
    sequence: number;
    timestamp: number;
    type: AgentRunEventType;
    status?: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
    invocationId?: string;
    agentId?: string;
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

    public async createRun(
        topicId: string,
        mode: string,
        userPromptPreview: string,
        parentRunId?: string
    ): Promise<AgentRunRecord> {
        const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        RunLedger.latestActiveRunId = runId;
        const now = Date.now();
        const record: AgentRunRecord = {
            runId,
            topicId,
            parentRunId,
            status: 'created',
            mode,
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
            writtenFiles: []
        };
        this.activeRuns.set(runId, record);
        this.runEvents.set(runId, []);
        this.runSequences.set(runId, 0);

        await this.appendEvent(runId, 'run_created', {
            topicId,
            mode,
            userPromptPreview,
            parentRunId
        });

        return record;
    }

    public async appendEvent(
        runId: string,
        type: AgentRunEventType,
        payload: any,
        metadata?: { invocationId?: string; agentId?: string; status?: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' }
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

        const timestamp = Date.now();
        run.updatedAt = timestamp;
        const storedPayload = this.compactPayloadForLedger(type, payload);

        // Apply event to state
        if (type === 'status_changed') {
            run.status = storedPayload.status;
        } else if (type === 'file_change' && storedPayload.filePath) {
            if (!run.writtenFiles.includes(storedPayload.filePath)) {
                run.writtenFiles.push(storedPayload.filePath);
            }
        } else if (type === 'subagent_end' && Array.isArray(storedPayload?.filesWritten)) {
            for (const filePath of storedPayload.filesWritten) {
                if (typeof filePath === 'string' && filePath && !run.writtenFiles.includes(filePath)) {
                    run.writtenFiles.push(filePath);
                }
            }
        } else if (type === 'metrics_updated') {
            run.metrics = { ...run.metrics, ...storedPayload.metrics };
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

        // Persist event to jsonl
        await this.writeEventToDisk(run, event);
        await this.writeStateToDisk(run);

        // Notify subscribers of the change
        this.emitter.emit('change', runId);
    }

    private shouldSkipPersistedEvent(type: AgentRunEventType, _payload: any): boolean {
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

    private compactStep(step: any): any | undefined {
        if (!step || typeof step !== 'object') return step;
        const type = String(step.type || '');
        if (type === 'text_delta' || type === 'thinking_content') return undefined;
        if (type === 'orchestrator_progress' && /waiting|等待模型返回/i.test(String(step.content || ''))) return undefined;
        const copy: any = { ...step };
        if (typeof copy.content === 'string') copy.content = this.clipText(copy.content);
        if (copy.toolArgs !== undefined) copy.toolArgs = this.compactUnknown(copy.toolArgs);
        if (copy.toolResult !== undefined) copy.toolResult = this.compactUnknown(copy.toolResult);
        return copy;
    }

    private compactPayloadForLedger(type: AgentRunEventType, payload: any): any {
        if (!payload || typeof payload !== 'object') return this.compactUnknown(payload);
        if (type === 'step_appended') {
            return { ...payload, step: this.compactStep(payload.step) };
        }
        if (type === 'tool_call_created' || type === 'tool_call_start') {
            const args = this.compactUnknown(payload.args ?? payload.arguments);
            return { ...payload, args, arguments: args };
        }
        if (type === 'tool_call_end') {
            return { ...payload, result: this.compactUnknown(payload.result) };
        }
        if (type === 'file_change' && payload.diff) {
            return { ...payload, diff: this.clipText(payload.diff) };
        }
        if (type === 'compaction_end' && payload.summary) {
            return { ...payload, summary: this.compactUnknown(payload.summary) };
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

    private getRunDir(topicId: string, runId: string): string {
        const topicDir = getTopicStorageDir(topicId);
        return path.join(topicDir, 'runs', runId);
    }

    private async writeEventToDisk(run: AgentRunRecord, event: AgentRunEvent): Promise<void> {
        try {
            const dir = this.getRunDir(run.topicId, run.runId);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            const file = path.join(dir, 'events.jsonl');
            await fs.promises.appendFile(file, JSON.stringify(event) + '\n', 'utf8');
        } catch (e) {
            ErrorReporter.warn('RunLedger', `Failed to write event to disk for run ${run.runId}`, e);
        }
    }

    private async writeStateToDisk(run: AgentRunRecord): Promise<void> {
        try {
            const dir = this.getRunDir(run.topicId, run.runId);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            const file = path.join(dir, 'run_state.json');
            await fs.promises.writeFile(file, JSON.stringify(run, null, 2), 'utf8');
        } catch (e) {
            ErrorReporter.warn('RunLedger', `Failed to write state to disk for run ${run.runId}`, e);
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

    /**
     * Attempts to load the latest run for a given topic.
     * Useful for restoring pending write confirm / permission cards on startup.
     */
    public async loadLatestRunForTopic(topicId: string): Promise<AgentRunRecord | undefined> {
        try {
            const topicDir = getTopicStorageDir(topicId);
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
            const stateFile = path.join(runDir, 'run_state.json');
            if (!fs.existsSync(stateFile)) return undefined;

            const stateStat = await fs.promises.stat(stateFile);
            let record: AgentRunRecord;
            if (stateStat.size > RUN_STATE_MAX_LOAD_BYTES) {
                record = this.createLargeRunPlaceholder(topicId, latestRunId, stateStat.mtimeMs, stateStat.size);
            } else {
                const data = await fs.promises.readFile(stateFile, 'utf8');
                record = JSON.parse(data) as AgentRunRecord;
                record.steps = [];
            }
            const events = await this.readEventsFromDisk(runDir, record.runId);
            for (const event of events) {
                if (event.type === 'status_changed' && event.payload?.status) {
                    record.status = event.payload.status;
                } else if (event.type === 'complete') {
                    record.status = 'completed';
                } else if (event.type === 'file_change' && event.payload?.filePath && !record.writtenFiles.includes(event.payload.filePath)) {
                    record.writtenFiles.push(event.payload.filePath);
                } else if (event.type === 'subagent_end' && Array.isArray(event.payload?.filesWritten)) {
                    for (const filePath of event.payload.filesWritten) {
                        if (typeof filePath === 'string' && !record.writtenFiles.includes(filePath)) record.writtenFiles.push(filePath);
                    }
                }
            }
            const latestSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0);
            this.activeRuns.set(record.runId, record);
            this.runEvents.set(record.runId, events);
            this.runSequences.set(record.runId, latestSequence);
            return record;
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
        const topicDir = getTopicStorageDir(topicId);
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
