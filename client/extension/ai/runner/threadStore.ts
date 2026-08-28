import * as fs from 'fs';
import * as path from 'path';
import type { AgentRunRecord } from '../types';
import { getPrivateTopicStorageDir } from '../workspacePaths';
import { atomicWriteJson, readJsonWithBackup } from './durableStorage';
import { getHistoryPolicy } from './historyPolicy';

export type AgentThreadStatus = 'active' | 'interrupted' | 'failed' | 'completed' | 'compacted' | 'archived';

export interface AgentThreadRecord {
    version: 1;
    threadId: string;
    topicId: string;
    parentThreadId?: string;
    parentRunId?: string;
    rootRunId?: string;
    currentRunId?: string;
    forkedFromThreadId?: string;
    forkedFromRunId?: string;
    forkedFromMessageIndex?: number;
    compactedFromRunId?: string;
    latestSummaryRef?: string;
    runIds: string[];
    createdAt: number;
    updatedAt: number;
    status: AgentThreadStatus;
}

export interface RecordThreadRunOptions {
    threadId?: string;
    parentThreadId?: string;
    latestSummaryRef?: string;
}

function sanitizeFilePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function isThreadRecord(value: unknown): value is AgentThreadRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<AgentThreadRecord>;
    return record.version === 1
        && typeof record.threadId === 'string'
        && typeof record.topicId === 'string'
        && Array.isArray(record.runIds);
}

export class ThreadStore {
    private static instance: ThreadStore | undefined;
    private readonly cache = new Map<string, AgentThreadRecord>();

    static getInstance(): ThreadStore {
        if (!ThreadStore.instance) ThreadStore.instance = new ThreadStore();
        return ThreadStore.instance;
    }

    async recordRun(run: AgentRunRecord, options: RecordThreadRunOptions = {}): Promise<AgentThreadRecord> {
        const threadId = options.threadId ?? run.threadId ?? run.topicId;
        const existing = await this.getThread(run.topicId, threadId);
        const now = Date.now();
        const record: AgentThreadRecord = existing ?? {
            version: 1,
            threadId,
            topicId: run.topicId,
            parentThreadId: options.parentThreadId,
            parentRunId: run.parentRunId,
            rootRunId: run.runId,
            runIds: [],
            createdAt: now,
            updatedAt: now,
            status: 'active',
        };
        if (options.parentThreadId) record.parentThreadId = options.parentThreadId;
        if (run.parentRunId) record.parentRunId = run.parentRunId;
        if (!record.rootRunId) record.rootRunId = run.runId;
        record.currentRunId = run.runId;
        record.latestSummaryRef = options.latestSummaryRef ?? record.latestSummaryRef;
        record.updatedAt = now;
        record.status = run.status === 'completed'
            ? 'completed'
            : run.status === 'failed'
                ? 'failed'
                : run.status === 'cancelled'
                    ? 'interrupted'
                    : 'active';
        if (!record.runIds.includes(run.runId)) record.runIds.push(run.runId);
        await this.save(record);
        return record;
    }

    async getThread(topicId: string, threadId: string): Promise<AgentThreadRecord | undefined> {
        const key = this.cacheKey(topicId, threadId);
        const cached = this.cache.get(key);
        if (cached) return cached;
        const dir = getPrivateTopicStorageDir(topicId);
        if (!dir) return undefined;
        const loaded = readJsonWithBackup<AgentThreadRecord>(this.threadPathFromTopicDir(dir, threadId), isThreadRecord);
        if (loaded) {
            this.cache.set(key, loaded.value);
            return loaded.value;
        }
        return undefined;
    }

    async forkThread(
        topicId: string,
        sourceThreadId: string,
        newThreadId: string,
        newTopicId = topicId,
        sourceRunId?: string,
        messageIndex?: number,
    ): Promise<AgentThreadRecord | undefined> {
        const source = await this.getThread(topicId, sourceThreadId);
        if (!source) return undefined;
        const now = Date.now();
        const forkRunId = sourceRunId && source.runIds.includes(sourceRunId) ? sourceRunId : source.currentRunId;
        const forkIndex = forkRunId ? source.runIds.indexOf(forkRunId) : -1;
        const inheritedRuns = forkIndex >= 0 ? source.runIds.slice(0, forkIndex + 1) : [];
        const fork: AgentThreadRecord = {
            version: 1,
            threadId: newThreadId,
            topicId: newTopicId,
            parentThreadId: source.threadId,
            parentRunId: forkRunId,
            rootRunId: inheritedRuns[0] ?? forkRunId,
            currentRunId: forkRunId,
            forkedFromThreadId: source.threadId,
            forkedFromRunId: forkRunId,
            forkedFromMessageIndex: messageIndex,
            runIds: inheritedRuns,
            createdAt: now,
            updatedAt: now,
            status: 'active',
        };
        await this.save(fork);
        return fork;
    }

    async markCompacted(topicId: string, threadId: string, compactedFromRunId?: string, latestSummaryRef?: string): Promise<AgentThreadRecord | undefined> {
        const record = await this.getThread(topicId, threadId);
        if (!record) return undefined;
        record.status = 'compacted';
        record.compactedFromRunId = compactedFromRunId ?? record.currentRunId;
        record.latestSummaryRef = latestSummaryRef ?? record.latestSummaryRef;
        record.updatedAt = Date.now();
        await this.save(record);
        return record;
    }

    async markStatus(topicId: string, threadId: string, status: AgentThreadStatus): Promise<AgentThreadRecord | undefined> {
        const record = await this.getThread(topicId, threadId);
        if (!record) return undefined;
        record.status = status;
        record.updatedAt = Date.now();
        await this.save(record);
        return record;
    }

    async listThreads(topicId: string): Promise<AgentThreadRecord[]> {
        const topicDir = getPrivateTopicStorageDir(topicId);
        const threadsDir = path.join(topicDir, 'threads');
        if (!fs.existsSync(threadsDir)) return [];
        const records: AgentThreadRecord[] = [];
        for (const entry of await fs.promises.readdir(threadsDir)) {
            if (!entry.endsWith('.json')) continue;
            const loaded = readJsonWithBackup<AgentThreadRecord>(path.join(threadsDir, entry), isThreadRecord);
            if (loaded) {
                this.cache.set(this.cacheKey(loaded.value.topicId, loaded.value.threadId), loaded.value);
                records.push(loaded.value);
            }
        }
        return records.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    private async save(record: AgentThreadRecord): Promise<void> {
        this.cache.set(this.cacheKey(record.topicId, record.threadId), record);
        if (getHistoryPolicy().persistence === 'off') return;
        await atomicWriteJson(this.threadPath(record.topicId, record.threadId), record);
    }

    private threadPath(topicId: string, threadId: string): string {
        return this.threadPathFromTopicDir(getPrivateTopicStorageDir(topicId), threadId);
    }

    private threadPathFromTopicDir(topicDir: string, threadId: string): string {
        return path.join(topicDir, 'threads', `${sanitizeFilePart(threadId)}.json`);
    }

    private cacheKey(topicId: string, threadId: string): string {
        return `${topicId}\0${threadId}`;
    }
}

export const threadStore = ThreadStore.getInstance();
