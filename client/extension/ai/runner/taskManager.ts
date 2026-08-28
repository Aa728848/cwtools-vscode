import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { getPrivateTopicStorageDir } from '../workspacePaths';
import { atomicWriteJson, readJsonWithBackup } from './durableStorage';

export type AgentTaskKind = 'process' | 'subagent' | 'validation' | 'compaction' | 'hook' | 'background_read';
export type AgentTaskStatus =
    | 'queued'
    | 'running'
    | 'detached'
    | 'suspended'
    | 'completed'
    | 'failed'
    | 'timed_out'
    | 'killed'
    | 'lost';

export interface AgentTaskRecord {
    version: 1;
    taskId: string;
    agentId?: string;
    kind: AgentTaskKind;
    status: AgentTaskStatus;
    topicId: string;
    runId: string;
    threadId: string;
    parentTaskId?: string;
    resumeAgentId?: string;
    domain?: 'general' | 'paradox';
    authorization?: 'read_only' | 'workspace_write';
    providerId?: string;
    model?: string;
    contextRef?: string;
    startedAt?: number;
    endedAt?: number;
    outputRef?: string;
    outputBytes: number;
    outputTruncated: boolean;
    resultSummary?: string;
    stopReason?: string;
    lastMessage?: string;
    notification: 'pending' | 'delivered' | 'suppressed';
    createdAt: number;
    updatedAt: number;
}

/** Optional account attached when a task settles. */
export interface AgentTaskSettlement {
    stopReason?: string;
    lastMessage?: string;
}

export interface CreateAgentTask {
    taskId?: string;
    agentId?: string;
    kind: AgentTaskKind;
    topicId: string;
    runId: string;
    threadId: string;
    parentTaskId?: string;
    resumeAgentId?: string;
    domain?: 'general' | 'paradox';
    authorization?: 'read_only' | 'workspace_write';
    providerId?: string;
    model?: string;
    contextRef?: string;
}

const TERMINAL = new Set<AgentTaskStatus>(['completed', 'failed', 'timed_out', 'killed', 'lost']);
const MAX_TASKS = 500;
const MAX_STOP_REASON_CHARS = 200;
const MAX_LAST_MESSAGE_CHARS = 4_000;

function isTaskArray(value: unknown): value is AgentTaskRecord[] {
    return Array.isArray(value) && value.every(item =>
        !!item && typeof item === 'object'
        && typeof (item as Partial<AgentTaskRecord>).taskId === 'string'
        && typeof (item as Partial<AgentTaskRecord>).status === 'string');
}

export class AgentTaskManager {
    private readonly tasksByTopic = new Map<string, Map<string, AgentTaskRecord>>();
    private readonly loadedTopics = new Set<string>();
    private configuredTopic?: string;

    configure(topicId: string): void {
        this.configuredTopic = topicId;
        if (this.loadedTopics.has(topicId)) return;
        const tasks = this.tasksFor(topicId);
        const dir = getPrivateTopicStorageDir(topicId);
        if (dir) {
            const loaded = readJsonWithBackup<AgentTaskRecord[]>(path.join(dir, 'tasks', 'tasks.json'), isTaskArray);
            if (loaded) {
                for (const task of loaded.value) {
                    const restored = { ...task };
                    if (restored.status === 'running' || restored.status === 'detached') {
                        restored.status = 'lost';
                        restored.endedAt = Date.now();
                        restored.updatedAt = restored.endedAt;
                        restored.notification = 'pending';
                        restored.stopReason = 'host_restart';
                    }
                    tasks.set(restored.taskId, restored);
                }
            }
        }
        this.loadedTopics.add(topicId);
        void this.persist(topicId);
    }

    async create(input: CreateAgentTask): Promise<AgentTaskRecord> {
        this.ensureTopic(input.topicId);
        const now = Date.now();
        const task: AgentTaskRecord = {
            version: 1,
            taskId: input.taskId ?? crypto.randomUUID(),
            agentId: input.agentId ?? (input.kind === 'subagent' ? crypto.randomUUID() : undefined),
            kind: input.kind,
            status: 'queued',
            topicId: input.topicId,
            runId: input.runId,
            threadId: input.threadId,
            parentTaskId: input.parentTaskId,
            resumeAgentId: input.resumeAgentId,
            domain: input.domain,
            authorization: input.authorization,
            providerId: input.providerId,
            model: input.model,
            contextRef: input.contextRef,
            outputBytes: 0,
            outputTruncated: false,
            notification: 'pending',
            createdAt: now,
            updatedAt: now,
        };
        this.tasksFor(input.topicId).set(task.taskId, task);
        await this.persist(input.topicId);
        return { ...task };
    }

    async transition(
        taskId: string,
        status: AgentTaskStatus,
        summary?: string,
        settlement?: AgentTaskSettlement,
    ): Promise<AgentTaskRecord> {
        const task = this.requireTask(taskId);
        if (TERMINAL.has(task.status)) throw new Error(`Task ${taskId} is already terminal.`);
        if (status === 'running') {
            const maxRunning = Math.max(1, vs.workspace.getConfiguration('stellarisLanguageServices.ai.runtime.backgroundTasks')
                .get<number>('maxRunning', 4));
            const running = [...this.tasksFor(task.topicId).values()].filter(candidate =>
                candidate.taskId !== taskId && (candidate.status === 'running' || candidate.status === 'detached')).length;
            if (running >= maxRunning) throw new Error(`Background task capacity ${maxRunning} is exhausted.`);
        }
        const now = Date.now();
        task.status = status;
        task.updatedAt = now;
        if (status === 'running' && task.startedAt === undefined) task.startedAt = now;
        if (TERMINAL.has(status)) task.endedAt = now;
        if (summary !== undefined) task.resultSummary = summary.slice(0, 4_000);
        if (settlement?.stopReason !== undefined) task.stopReason = settlement.stopReason.slice(0, MAX_STOP_REASON_CHARS);
        if (settlement?.lastMessage !== undefined) {
            const preserved = settlement.lastMessage.trim();
            task.lastMessage = preserved ? preserved.slice(0, MAX_LAST_MESSAGE_CHARS) : undefined;
        }
        if (TERMINAL.has(status) && task.stopReason === undefined) {
            task.stopReason = status === 'completed' ? 'completed' : status;
        }
        await this.persist(task.topicId);
        return { ...task };
    }

    async appendOutput(taskId: string, chunk: string): Promise<AgentTaskRecord> {
        const task = this.requireTask(taskId);
        const outputLimit = Math.max(1_048_576, vs.workspace.getConfiguration('stellarisLanguageServices.ai.runtime.backgroundTasks')
            .get<number>('outputLimitBytes', 32 * 1024 * 1024));
        const remaining = Math.max(0, outputLimit - task.outputBytes);
        const bytes = Buffer.from(chunk, 'utf8');
        const accepted = bytes.subarray(0, remaining);
        const outputPath = this.outputPath(task);
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        if (accepted.length > 0) await fs.promises.appendFile(outputPath, accepted);
        task.outputBytes += accepted.length;
        task.outputTruncated ||= accepted.length < bytes.length;
        task.outputRef = outputPath;
        task.updatedAt = Date.now();
        await this.persist(task.topicId);
        return { ...task };
    }

    readOutput(taskId: string, offset = 0, maxBytes = 64 * 1024): { data: string; nextOffset?: number; totalBytes: number } {
        const task = this.requireTask(taskId);
        if (!task.outputRef || !fs.existsSync(task.outputRef)) return { data: '', totalBytes: 0 };
        const size = fs.statSync(task.outputRef).size;
        const start = Math.max(0, Math.min(Math.floor(offset), size));
        const length = Math.max(0, Math.min(Math.floor(maxBytes), 256 * 1024, size - start));
        const handle = fs.openSync(task.outputRef, 'r');
        try {
            const buffer = Buffer.alloc(length);
            fs.readSync(handle, buffer, 0, length, start);
            const end = start + length;
            return { data: buffer.toString('utf8'), nextOffset: end < size ? end : undefined, totalBytes: size };
        } finally {
            fs.closeSync(handle);
        }
    }

    async claimNotification(taskId: string): Promise<boolean> {
        const task = this.requireTask(taskId);
        if (task.notification !== 'pending' || !TERMINAL.has(task.status)) return false;
        task.notification = 'delivered';
        task.updatedAt = Date.now();
        await this.persist(task.topicId);
        return true;
    }

    async setContextRef(taskId: string, contextRef: string): Promise<AgentTaskRecord> {
        const task = this.requireTask(taskId);
        task.contextRef = contextRef;
        task.updatedAt = Date.now();
        await this.persist(task.topicId);
        return { ...task };
    }

    async restoreNotificationStates(
        topicId: string,
        states: Readonly<Record<string, AgentTaskRecord['notification']>>,
    ): Promise<void> {
        this.configure(topicId);
        for (const task of this.tasksFor(topicId).values()) {
            const notification = states[task.taskId];
            task.notification = notification ?? 'suppressed';
        }
        await this.persist(topicId);
    }

    get(taskId: string): AgentTaskRecord | undefined {
        const task = this.findTask(taskId);
        return task ? { ...task } : undefined;
    }

    list(topicId = this.configuredTopic): AgentTaskRecord[] {
        if (!topicId) return [];
        return [...this.tasksFor(topicId).values()].map(task => ({ ...task }))
            .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId));
    }

    findResumableAgent(agentId: string, topicId: string, threadId: string): AgentTaskRecord | undefined {
        return [...this.tasksFor(topicId).values()].reverse().find(task =>
            task.kind === 'subagent'
            && task.agentId === agentId
            && task.topicId === topicId
            && task.threadId === threadId
            && ['suspended', 'lost', 'failed', 'timed_out'].includes(task.status));
    }

    async resumeSubagent(input: {
        agentId: string;
        topicId: string;
        threadId: string;
        runId: string;
        authorization: 'read_only' | 'workspace_write';
    }): Promise<AgentTaskRecord> {
        this.ensureTopic(input.topicId);
        const previous = this.findResumableAgent(input.agentId, input.topicId, input.threadId);
        if (!previous) throw new Error(`No resumable Agent ${input.agentId} exists in this thread.`);
        if (input.authorization === 'workspace_write' && previous.authorization !== 'workspace_write') {
            throw new Error('Resume cannot expand the original Agent authorization.');
        }
        return this.create({
            kind: 'subagent',
            agentId: previous.agentId,
            resumeAgentId: previous.agentId,
            topicId: input.topicId,
            threadId: input.threadId,
            runId: input.runId,
            parentTaskId: previous.taskId,
            domain: previous.domain,
            authorization: input.authorization,
            providerId: previous.providerId,
            model: previous.model,
            contextRef: previous.contextRef,
        });
    }

    private ensureTopic(topicId: string): void {
        if (this.configuredTopic !== topicId) this.configure(topicId);
    }

    private requireTask(taskId: string): AgentTaskRecord {
        const task = this.findTask(taskId);
        if (!task) throw new Error(`Unknown task ${taskId}.`);
        return task;
    }

    private outputPath(task: AgentTaskRecord): string {
        const topicDir = getPrivateTopicStorageDir(task.topicId);
        if (!topicDir) throw new Error('Task storage is unavailable without an active workspace or private storage root.');
        return path.join(topicDir, 'tasks', 'output', `${task.taskId}.log`);
    }

    private findTask(taskId: string): AgentTaskRecord | undefined {
        for (const tasks of this.tasksByTopic.values()) {
            const task = tasks.get(taskId);
            if (task) return task;
        }
        return undefined;
    }

    private tasksFor(topicId: string): Map<string, AgentTaskRecord> {
        let tasks = this.tasksByTopic.get(topicId);
        if (!tasks) {
            tasks = new Map<string, AgentTaskRecord>();
            this.tasksByTopic.set(topicId, tasks);
        }
        return tasks;
    }

    private async persist(topicId: string): Promise<void> {
        const topicDir = getPrivateTopicStorageDir(topicId);
        if (!topicDir) return;
        const records = this.list(topicId).slice(-MAX_TASKS);
        await atomicWriteJson(path.join(topicDir, 'tasks', 'tasks.json'), records);
    }
}

export const agentTaskManager = new AgentTaskManager();
