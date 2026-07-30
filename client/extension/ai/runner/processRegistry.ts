import * as fs from 'fs';
import * as path from 'path';
import type { RunEventSink } from './runContext';
import { atomicWriteJson, readJsonWithBackup } from './durableStorage';
import { agentTaskManager, type AgentTaskStatus } from './taskManager';

const MAX_PROCESS_RECORDS = 200;

export interface BackgroundProcessRecord {
    processId: string;
    pid?: number;
    command: string;
    cwd: string;
    startedAt: number;
    sandboxMode?: string;
    networkAccess?: boolean;
    authorization?: { type: 'full-access' | 'one-shot'; permissionId?: string };
    executionMode?: 'captured' | 'terminal';
    runId?: string;
    threadId?: string;
    topicId?: string;
    taskId?: string;
    completedAt?: number;
    exitCode?: number;
    outputPreview?: string;
    status: 'running' | 'completed' | 'failed' | 'terminated' | 'orphaned';
}

interface ProcessControl {
    terminate?: () => void;
    writeStdin?: (text: string) => void;
}

export class ProcessRegistry {
    private static instance: ProcessRegistry | undefined;
    private readonly processes = new Map<string, BackgroundProcessRecord>();
    private readonly controls = new Map<string, ProcessControl>();
    private storageFile?: string;
    private persistChain: Promise<void> = Promise.resolve();

    static getInstance(): ProcessRegistry {
        if (!ProcessRegistry.instance) ProcessRegistry.instance = new ProcessRegistry();
        return ProcessRegistry.instance;
    }

    configureStorage(storageRoot: string): void {
        this.storageFile = path.join(storageRoot, 'processes.json');
        const loaded = readJsonWithBackup<BackgroundProcessRecord[]>(
            this.storageFile,
            value => Array.isArray(value),
        );
        for (const value of loaded?.value ?? []) {
            const record = { ...value };
            if (record.status === 'running') record.status = 'orphaned';
            this.processes.set(record.processId, record);
        }
        this.pruneCompletedRecords();
        this.persistSoon();
    }

    register(
        command: string,
        cwd: string,
        pid?: number,
        eventSink?: RunEventSink,
        sandbox?: { sandboxMode?: string; networkAccess?: boolean; authorization?: { type: 'full-access' | 'one-shot'; permissionId?: string } },
        options: { executionMode?: 'captured' | 'terminal'; runId?: string; threadId?: string; topicId?: string; terminate?: () => void; writeStdin?: (text: string) => void } = {},
    ): BackgroundProcessRecord {
        const record: BackgroundProcessRecord = {
            processId: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            pid,
            command,
            cwd,
            startedAt: Date.now(),
            sandboxMode: sandbox?.sandboxMode,
            networkAccess: sandbox?.networkAccess,
            authorization: sandbox?.authorization,
            executionMode: options.executionMode ?? 'captured',
            runId: options.runId,
            threadId: options.threadId,
            topicId: options.topicId,
            status: 'running',
        };
        record.taskId = record.processId;
        this.processes.set(record.processId, record);
        this.pruneCompletedRecords();
        if (options.terminate || options.writeStdin) this.controls.set(record.processId, { terminate: options.terminate, writeStdin: options.writeStdin });
        eventSink?.appendSoon('process_started', { ...record }, { status: 'running' });
        eventSink?.appendSoon('item_started', {
            itemId: record.processId,
            threadId: record.threadId,
            type: 'process',
            status: 'inProgress',
            title: record.command,
            command: record.command,
            cwd: record.cwd,
            startedAt: record.startedAt,
            metadata: { sandboxMode: record.sandboxMode, networkAccess: record.networkAccess, authorization: record.authorization },
        }, { invocationId: record.processId, status: 'running' });
        if (record.topicId && record.runId && record.threadId) {
            eventSink?.appendSoon('task_created', {
                taskId: record.taskId,
                kind: 'process',
                processId: record.processId,
            }, { invocationId: record.taskId, status: 'pending' });
            void agentTaskManager.create({
                taskId: record.taskId,
                kind: 'process',
                topicId: record.topicId,
                runId: record.runId,
                threadId: record.threadId,
            }).then(() => agentTaskManager.transition(record.taskId!, 'running'))
                .then(() => eventSink?.appendSoon('task_status_changed', {
                    taskId: record.taskId,
                    status: 'running',
                }, { invocationId: record.taskId, status: 'running' }))
                .catch(() => {});
        }
        this.persistSoon();
        return record;
    }

    setPid(processId: string, pid: number | undefined): void {
        const record = this.processes.get(processId);
        if (!record || !pid) return;
        record.pid = pid;
        this.persistSoon();
    }

    appendOutput(processId: string, stream: 'stdout' | 'stderr', text: string, eventSink?: RunEventSink): void {
        if (!text) return;
        const record = this.processes.get(processId);
        if (!record) return;
        record.outputPreview = `${record.outputPreview ?? ''}${text}`.slice(-2000);
        eventSink?.appendSoon('process_output_delta', {
            processId, stream, size: text.length, preview: text.slice(0, 240),
        }, { status: 'running' });
        eventSink?.appendSoon('item_updated', { itemId: processId, type: 'process', status: 'inProgress', stream, preview: text.slice(0, 240) }, { invocationId: processId, status: 'running' });
        if (record.taskId && record.topicId) void agentTaskManager.appendOutput(record.taskId, text).catch(() => {});
        this.persistSoon();
    }

    complete(processId: string, exitCode: number, eventSink?: RunEventSink): void {
        const record = this.processes.get(processId);
        if (!record || record.status !== 'running') return;
        record.completedAt = Date.now();
        record.exitCode = exitCode;
        record.status = exitCode === 0 ? 'completed' : 'failed';
        this.controls.delete(processId);
        eventSink?.appendSoon('process_completed', {
            processId, exitCode, durationMs: record.completedAt - record.startedAt,
        }, { status: record.status === 'completed' ? 'done' : 'failed' });
        eventSink?.appendSoon('item_completed', {
            itemId: processId,
            type: 'process',
            status: record.status === 'completed' ? 'completed' : 'failed',
            completedAt: record.completedAt,
            exitCode,
        }, { invocationId: processId, status: record.status === 'completed' ? 'done' : 'failed' });
        this.transitionTask(record, record.status === 'completed' ? 'completed' : 'failed', eventSink);
        this.pruneCompletedRecords();
        this.persistSoon();
    }

    markTerminated(processId: string, eventSink?: RunEventSink): void {
        const record = this.processes.get(processId);
        if (!record || record.status !== 'running') return;
        record.completedAt = Date.now();
        record.status = 'terminated';
        this.controls.delete(processId);
        eventSink?.appendSoon('process_completed', {
            processId, exitCode: -1, terminated: true, durationMs: record.completedAt - record.startedAt,
        }, { status: 'cancelled' });
        eventSink?.appendSoon('item_completed', {
            itemId: processId,
            type: 'process',
            status: 'cancelled',
            completedAt: record.completedAt,
            exitCode: -1,
        }, { invocationId: processId, status: 'cancelled' });
        this.transitionTask(record, 'killed', eventSink);
        this.pruneCompletedRecords();
        this.persistSoon();
    }

    terminate(processId: string, eventSink?: RunEventSink): boolean {
        const record = this.processes.get(processId);
        if (!record || record.status !== 'running') return false;
        try { this.controls.get(processId)?.terminate?.(); } catch { /* best effort */ }
        this.markTerminated(processId, eventSink);
        return true;
    }

    writeStdin(processId: string, text: string): boolean {
        const record = this.processes.get(processId);
        const control = this.controls.get(processId);
        if (!record || record.status !== 'running' || !control?.writeStdin) return false;
        try {
            control.writeStdin(text);
            return true;
        } catch {
            return false;
        }
    }

    list(): BackgroundProcessRecord[] { return [...this.processes.values()].sort((a, b) => b.startedAt - a.startedAt); }
    get(processId: string): BackgroundProcessRecord | undefined { return this.processes.get(processId); }

    private pruneCompletedRecords(): void {
        if (this.processes.size <= MAX_PROCESS_RECORDS) return;
        const removable = [...this.processes.values()]
            .filter(record => record.status !== 'running')
            .sort((a, b) => a.startedAt - b.startedAt);
        for (const record of removable) {
            if (this.processes.size <= MAX_PROCESS_RECORDS) break;
            this.processes.delete(record.processId);
            this.controls.delete(record.processId);
        }
    }

    private persistSoon(): void {
        if (!this.storageFile) return;
        const file = this.storageFile;
        const records = this.list();
        this.persistChain = this.persistChain
            .then(async () => {
                await fs.promises.mkdir(path.dirname(file), { recursive: true });
                await atomicWriteJson(file, records);
            })
            .catch(() => {});
    }

    private transitionTask(record: BackgroundProcessRecord, status: AgentTaskStatus, eventSink?: RunEventSink): void {
        if (!record.taskId || !record.topicId) return;
        void agentTaskManager.transition(record.taskId, status, record.outputPreview)
            .then(() => eventSink?.appendSoon('task_status_changed', {
                taskId: record.taskId,
                status,
            }, { invocationId: record.taskId, status: status === 'completed' ? 'done' : 'failed' }))
            .catch(() => {});
    }
}

export const processRegistry = ProcessRegistry.getInstance();
