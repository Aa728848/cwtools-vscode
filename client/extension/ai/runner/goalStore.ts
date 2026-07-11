import * as path from 'path';
import { getPrivateTopicStorageDir, getPrivateTopicStorageDirCandidates } from '../workspacePaths';
import { atomicWriteJson, readJsonWithBackup } from './durableStorage';

export interface DurableAgentGoal {
    version: 1;
    topicId: string;
    threadId: string;
    objective: string;
    status: 'active' | 'completed' | 'blocked';
    tokenBudget?: number;
    createdAt: number;
    updatedAt: number;
}

export class GoalStore {
    async getGoal(topicId: string, threadId: string): Promise<DurableAgentGoal | undefined> {
        for (const dir of getPrivateTopicStorageDirCandidates(topicId)) {
            const loaded = readJsonWithBackup<DurableAgentGoal>(
                path.join(dir, 'goals', `${this.safe(threadId)}.json`),
                (value): value is DurableAgentGoal => !!value && typeof value === 'object' && typeof (value as DurableAgentGoal).objective === 'string',
            );
            if (loaded) return loaded.value;
        }
        return undefined;
    }

    async setGoal(topicId: string, threadId: string, objective: string, tokenBudget?: number): Promise<DurableAgentGoal> {
        const now = Date.now();
        const existing = await this.getGoal(topicId, threadId);
        const goal: DurableAgentGoal = {
            version: 1,
            topicId,
            threadId,
            objective: objective.trim(),
            status: 'active',
            tokenBudget: tokenBudget && tokenBudget > 0 ? Math.floor(tokenBudget) : undefined,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    async updateStatus(topicId: string, threadId: string, status: DurableAgentGoal['status']): Promise<DurableAgentGoal | undefined> {
        const goal = await this.getGoal(topicId, threadId);
        if (!goal) return undefined;
        goal.status = status;
        goal.updatedAt = Date.now();
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    private goalPath(topicId: string, threadId: string): string {
        return path.join(getPrivateTopicStorageDir(topicId), 'goals', `${this.safe(threadId)}.json`);
    }

    private safe(value: string): string { return value.replace(/[^a-zA-Z0-9_.-]/g, '_'); }
}

export const goalStore = new GoalStore();
