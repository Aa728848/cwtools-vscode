import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { getPrivateTopicStorageDir } from '../workspacePaths';
import { atomicWriteJson, readJsonWithBackup } from './durableStorage';

export type DurableGoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled';

export interface GoalBudgetLimits {
    tokens?: number;
    turns?: number;
    wallClockMs?: number;
}

export interface DurableAgentGoal {
    version: 2;
    goalId: string;
    topicId: string;
    threadId: string;
    objective: string;
    completionCriterion: string[];
    status: DurableGoalStatus;
    budgetLimits: GoalBudgetLimits;
    tokensUsed: number;
    turnsUsed: number;
    wallClockMs: number;
    /** One final read-only turn may be claimed after a tool-producing turn exhausts a budget. */
    budgetGracePending?: boolean;
    budgetGraceUsed?: boolean;
    terminalReason?: string;
    createdAt: number;
    updatedAt: number;
}

function isStoredGoal(value: unknown): value is DurableAgentGoal {
    if (!value || typeof value !== 'object') return false;
    const goal = value as Partial<DurableAgentGoal>;
    return goal.version === 2
        && typeof goal.goalId === 'string'
        && typeof goal.objective === 'string'
        && typeof goal.topicId === 'string'
        && typeof goal.threadId === 'string'
        && Array.isArray(goal.completionCriterion)
        && goal.completionCriterion.every(item => typeof item === 'string')
        && !!goal.budgetLimits && typeof goal.budgetLimits === 'object'
        && typeof goal.tokensUsed === 'number' && Number.isFinite(goal.tokensUsed)
        && typeof goal.turnsUsed === 'number' && Number.isFinite(goal.turnsUsed)
        && typeof goal.wallClockMs === 'number' && Number.isFinite(goal.wallClockMs)
        && typeof goal.createdAt === 'number' && Number.isFinite(goal.createdAt)
        && typeof goal.updatedAt === 'number' && Number.isFinite(goal.updatedAt)
        && ['active', 'paused', 'blocked', 'complete', 'cancelled'].includes(String(goal.status));
}

export class GoalStore {
    async getGoal(topicId: string, threadId: string): Promise<DurableAgentGoal | undefined> {
        const dir = getPrivateTopicStorageDir(topicId);
        if (!dir) return undefined;
        const loaded = readJsonWithBackup<DurableAgentGoal>(
            path.join(dir, 'goals', `${this.safe(threadId)}.json`),
            isStoredGoal,
        );
        return loaded ? this.normalize(loaded.value) : undefined;
    }

    async setGoal(
        topicId: string,
        threadId: string,
        objective: string,
        tokenBudget?: number,
        completionCriterion: string[] = [],
    ): Promise<DurableAgentGoal> {
        const now = Date.now();
        const existing = await this.getGoal(topicId, threadId);
        const normalizedBudget = tokenBudget && tokenBudget > 0 ? Math.floor(tokenBudget) : undefined;
        const goal: DurableAgentGoal = {
            version: 2,
            goalId: existing?.goalId ?? crypto.randomUUID(),
            topicId,
            threadId,
            objective: objective.trim(),
            completionCriterion: completionCriterion.map(item => item.trim()).filter(Boolean),
            status: 'active',
            budgetLimits: {
                ...existing?.budgetLimits,
                tokens: normalizedBudget ?? existing?.budgetLimits.tokens,
            },
            tokensUsed: existing?.tokensUsed ?? 0,
            turnsUsed: existing?.turnsUsed ?? 0,
            wallClockMs: existing?.wallClockMs ?? 0,
            budgetGracePending: existing?.budgetGracePending ?? false,
            budgetGraceUsed: existing?.budgetGraceUsed ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    async updateStatus(
        topicId: string,
        threadId: string,
        status: DurableGoalStatus,
        terminalReason?: string,
    ): Promise<DurableAgentGoal | undefined> {
        const goal = await this.getGoal(topicId, threadId);
        if (!goal) return undefined;
        goal.status = status;
        goal.terminalReason = terminalReason;
        goal.updatedAt = Date.now();
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    async setBudget(topicId: string, threadId: string, budgetLimits: GoalBudgetLimits): Promise<DurableAgentGoal | undefined> {
        const goal = await this.getGoal(topicId, threadId);
        if (!goal) return undefined;
        goal.budgetLimits = this.normalizeBudget({ ...goal.budgetLimits, ...budgetLimits });
        goal.updatedAt = Date.now();
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    async recordUsage(
        topicId: string,
        threadId: string,
        usage: { tokens?: number; turns?: number; wallClockMs?: number },
    ): Promise<DurableAgentGoal | undefined> {
        const goal = await this.getGoal(topicId, threadId);
        if (!goal) return undefined;
        goal.tokensUsed += Math.max(0, Math.floor(usage.tokens ?? 0));
        goal.turnsUsed += Math.max(0, Math.floor(usage.turns ?? 0));
        goal.wallClockMs += Math.max(0, Math.floor(usage.wallClockMs ?? 0));
        goal.updatedAt = Date.now();
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    async setBudgetGrace(
        topicId: string,
        threadId: string,
        pending: boolean,
        used: boolean,
    ): Promise<DurableAgentGoal | undefined> {
        const goal = await this.getGoal(topicId, threadId);
        if (!goal) return undefined;
        goal.budgetGracePending = pending;
        goal.budgetGraceUsed = used;
        goal.updatedAt = Date.now();
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    async restoreSnapshot(topicId: string, threadId: string, snapshot: DurableAgentGoal | undefined): Promise<void> {
        const target = this.goalPath(topicId, threadId);
        if (snapshot) {
            await atomicWriteJson(target, snapshot);
            return;
        }
        if (!fs.existsSync(target)) return;
        const recoveryPath = `${target}.undo.bak`;
        await fs.promises.rm(recoveryPath, { force: true });
        await fs.promises.rename(target, recoveryPath);
    }

    private goalPath(topicId: string, threadId: string): string {
        const topicDir = getPrivateTopicStorageDir(topicId);
        if (!topicDir) throw new Error('Goal storage is unavailable without an active workspace or private storage root.');
        return path.join(topicDir, 'goals', `${this.safe(threadId)}.json`);
    }

    private safe(value: string): string { return value.replace(/[^a-zA-Z0-9_.-]/g, '_'); }

    private normalize(goal: DurableAgentGoal): DurableAgentGoal {
        const budgetLimits = this.normalizeBudget(goal.budgetLimits);
        return {
            ...goal,
            completionCriterion: goal.completionCriterion.filter(item => typeof item === 'string'),
            budgetLimits,
            tokensUsed: Math.max(0, goal.tokensUsed),
            turnsUsed: Math.max(0, goal.turnsUsed),
            wallClockMs: Math.max(0, goal.wallClockMs),
            budgetGracePending: goal.budgetGracePending === true,
            budgetGraceUsed: goal.budgetGraceUsed === true,
        };
    }

    private normalizeBudget(budget: GoalBudgetLimits): GoalBudgetLimits {
        const normalized: GoalBudgetLimits = {};
        for (const key of ['tokens', 'turns', 'wallClockMs'] as const) {
            const value = budget[key];
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) normalized[key] = Math.floor(value);
        }
        return normalized;
    }
}

export const goalStore = new GoalStore();
