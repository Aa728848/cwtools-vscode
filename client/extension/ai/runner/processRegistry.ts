import type { RunEventSink } from './runContext';

export interface BackgroundProcessRecord {
    processId: string;
    pid?: number;
    command: string;
    cwd: string;
    startedAt: number;
    sandboxMode?: string;
    networkAccess?: boolean;
    completedAt?: number;
    exitCode?: number;
    status: 'running' | 'completed' | 'failed' | 'terminated';
}

export class ProcessRegistry {
    private static instance: ProcessRegistry | undefined;
    private readonly processes = new Map<string, BackgroundProcessRecord>();

    static getInstance(): ProcessRegistry {
        if (!ProcessRegistry.instance) ProcessRegistry.instance = new ProcessRegistry();
        return ProcessRegistry.instance;
    }

    register(
        command: string,
        cwd: string,
        pid?: number,
        eventSink?: RunEventSink,
        sandbox?: { sandboxMode?: string; networkAccess?: boolean },
    ): BackgroundProcessRecord {
        const record: BackgroundProcessRecord = {
            processId: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            pid,
            command,
            cwd,
            startedAt: Date.now(),
            sandboxMode: sandbox?.sandboxMode,
            networkAccess: sandbox?.networkAccess,
            status: 'running',
        };
        this.processes.set(record.processId, record);
        eventSink?.appendSoon('process_started', {
            processId: record.processId,
            pid,
            command,
            cwd,
            sandboxMode: sandbox?.sandboxMode,
            networkAccess: sandbox?.networkAccess,
        }, { status: 'running' });
        return record;
    }

    appendOutput(processId: string, stream: 'stdout' | 'stderr', text: string, eventSink?: RunEventSink): void {
        if (!text) return;
        const record = this.processes.get(processId);
        if (!record) return;
        eventSink?.appendSoon('process_output_delta', {
            processId,
            stream,
            size: text.length,
            preview: text.slice(0, 240),
        }, { status: 'running' });
    }

    complete(processId: string, exitCode: number, eventSink?: RunEventSink): void {
        const record = this.processes.get(processId);
        if (!record) return;
        record.completedAt = Date.now();
        record.exitCode = exitCode;
        record.status = exitCode === 0 ? 'completed' : 'failed';
        eventSink?.appendSoon('process_completed', {
            processId,
            exitCode,
            durationMs: record.completedAt - record.startedAt,
        }, { status: record.status === 'completed' ? 'done' : 'failed' });
    }

    markTerminated(processId: string, eventSink?: RunEventSink): void {
        const record = this.processes.get(processId);
        if (!record) return;
        record.completedAt = Date.now();
        record.status = 'terminated';
        eventSink?.appendSoon('process_completed', {
            processId,
            exitCode: -1,
            terminated: true,
            durationMs: record.completedAt - record.startedAt,
        }, { status: 'cancelled' });
    }

    list(): BackgroundProcessRecord[] {
        return [...this.processes.values()];
    }

    get(processId: string): BackgroundProcessRecord | undefined {
        return this.processes.get(processId);
    }
}

export const processRegistry = ProcessRegistry.getInstance();
