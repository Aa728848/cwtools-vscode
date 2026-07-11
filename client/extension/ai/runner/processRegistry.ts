import * as fs from 'fs';
import * as path from 'path';
import type { RunEventSink } from './runContext';
import { atomicWriteJson, readJsonWithBackup } from './durableStorage';

export interface BackgroundProcessRecord {
    processId: string;
    pid?: number;
    command: string;
    cwd: string;
    startedAt: number;
    sandboxMode?: string;
    networkAccess?: boolean;
    executionMode?: 'captured' | 'terminal';
    runId?: string;
    threadId?: string;
    completedAt?: number;
    exitCode?: number;
    outputPreview?: string;
    status: 'running' | 'completed' | 'failed' | 'terminated' | 'orphaned';
}

interface ProcessControl {
    terminate?: () => void;
}

export class ProcessRegistry {
    private static instance: ProcessRegistry | undefined;
    private readonly processes = new Map<string, BackgroundProcessRecord>();
    private readonly controls = new Map<string, ProcessControl>();
    private storageFile?: string;

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
        this.persistSoon();
    }

    register(
        command: string,
        cwd: string,
        pid?: number,
        eventSink?: RunEventSink,
        sandbox?: { sandboxMode?: string; networkAccess?: boolean },
        options: { executionMode?: 'captured' | 'terminal'; runId?: string; threadId?: string; terminate?: () => void } = {},
    ): BackgroundProcessRecord {
        const record: BackgroundProcessRecord = {
            processId: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            pid,
            command,
            cwd,
            startedAt: Date.now(),
            sandboxMode: sandbox?.sandboxMode,
            networkAccess: sandbox?.networkAccess,
            executionMode: options.executionMode ?? 'captured',
            runId: options.runId,
            threadId: options.threadId,
            status: 'running',
        };
        this.processes.set(record.processId, record);
        if (options.terminate) this.controls.set(record.processId, { terminate: options.terminate });
        eventSink?.appendSoon('process_started', { ...record }, { status: 'running' });
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
        this.persistSoon();
    }

    complete(processId: string, exitCode: number, eventSink?: RunEventSink): void {
        const record = this.processes.get(processId);
        if (!record) return;
        record.completedAt = Date.now();
        record.exitCode = exitCode;
        record.status = exitCode === 0 ? 'completed' : 'failed';
        this.controls.delete(processId);
        eventSink?.appendSoon('process_completed', {
            processId, exitCode, durationMs: record.completedAt - record.startedAt,
        }, { status: record.status === 'completed' ? 'done' : 'failed' });
        this.persistSoon();
    }

    markTerminated(processId: string, eventSink?: RunEventSink): void {
        const record = this.processes.get(processId);
        if (!record) return;
        record.completedAt = Date.now();
        record.status = 'terminated';
        this.controls.delete(processId);
        eventSink?.appendSoon('process_completed', {
            processId, exitCode: -1, terminated: true, durationMs: record.completedAt - record.startedAt,
        }, { status: 'cancelled' });
        this.persistSoon();
    }

    terminate(processId: string, eventSink?: RunEventSink): boolean {
        const record = this.processes.get(processId);
        if (!record || record.status !== 'running') return false;
        try { this.controls.get(processId)?.terminate?.(); } catch { /* best effort */ }
        this.markTerminated(processId, eventSink);
        return true;
    }

    list(): BackgroundProcessRecord[] { return [...this.processes.values()].sort((a, b) => b.startedAt - a.startedAt); }
    get(processId: string): BackgroundProcessRecord | undefined { return this.processes.get(processId); }

    private persistSoon(): void {
        if (!this.storageFile) return;
        const file = this.storageFile;
        const records = this.list();
        void fs.promises.mkdir(path.dirname(file), { recursive: true })
            .then(() => atomicWriteJson(file, records))
            .catch(() => {});
    }
}

export const processRegistry = ProcessRegistry.getInstance();
