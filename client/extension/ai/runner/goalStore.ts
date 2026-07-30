import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { getPrivateTopicStorageDir, getPrivateTopicStorageDirCandidates } from '../workspacePaths';
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
    /** Compatibility alias consumed by existing AgentRunner callers. */
    tokenBudget?: number;
    createdAt: number;
    updatedAt: number;
}

interface LegacyAgentGoal {
    version: 1;
    topicId: string;
    threadId: string;
    objective: string;
    status: 'active' | 'completed' | 'blocked';
    tokenBudget?: number;
    createdAt: number;
    updatedAt: number;
}

function isStoredGoal(value: unknown): value is DurableAgentGoal | LegacyAgentGoal {
    return !!value
        && typeof value === 'object'
        && typeof (value as Partial<DurableAgentGoal>).objective === 'string'
        && typeof (value as Partial<DurableAgentGoal>).topicId === 'string'
        && typeof (value as Partial<DurableAgentGoal>).threadId === 'string';
}

export class GoalStore {
    async getGoal(topicId: string, threadId: string): Promise<DurableAgentGoal | undefined> {
        for (const dir of getPrivateTopicStorageDirCandidates(topicId)) {
            const loaded = readJsonWithBackup<DurableAgentGoal | LegacyAgentGoal>(
                path.join(dir, 'goals', `${this.safe(threadId)}.json`),
                isStoredGoal,
            );
            if (loaded) return this.normalize(loaded.value);
        }
        return undefined;
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
            tokenBudget: normalizedBudget ?? existing?.budgetLimits.tokens,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    async updateStatus(
        topicId: string,
        threadId: string,
        status: DurableGoalStatus | 'completed',
        terminalReason?: string,
    ): Promise<DurableAgentGoal | undefined> {
        const goal = await this.getGoal(topicId, threadId);
        if (!goal) return undefined;
        goal.status = status === 'completed' ? 'complete' : status;
        goal.terminalReason = terminalReason;
        goal.updatedAt = Date.now();
        await atomicWriteJson(this.goalPath(topicId, threadId), goal);
        return goal;
    }

    async setBudget(topicId: string, threadId: string, budgetLimits: GoalBudgetLimits): Promise<DurableAgentGoal | undefined> {
        const goal = await this.getGoal(topicId, threadId);
        if (!goal) return undefined;
        goal.budgetLimits = this.normalizeBudget({ ...goal.budgetLimits, ...budgetLimits });
        goal.tokenBudget = goal.budgetLimits.tokens;
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

    private normalize(goal: DurableAgentGoal | LegacyAgentGoal): DurableAgentGoal {
        if (goal.version === 2) {
            const budgetLimits = this.normalizeBudget(goal.budgetLimits ?? {});
            return {
                ...goal,
                completionCriterion: Array.isArray(goal.completionCriterion)
                    ? goal.completionCriterion.filter(item => typeof item === 'string')
                    : [],
                budgetLimits,
                tokenBudget: budgetLimits.tokens,
                tokensUsed: Number.isFinite(goal.tokensUsed) ? Math.max(0, goal.tokensUsed) : 0,
                turnsUsed: Number.isFinite(goal.turnsUsed) ? Math.max(0, goal.turnsUsed) : 0,
                wallClockMs: Number.isFinite(goal.wallClockMs) ? Math.max(0, goal.wallClockMs) : 0,
                budgetGracePending: goal.budgetGracePending === true,
                budgetGraceUsed: goal.budgetGraceUsed === true,
            };
        }
        return {
            version: 2,
            goalId: crypto.createHash('sha256').update(`${goal.topicId}\0${goal.threadId}\0${goal.createdAt}`).digest('hex').slice(0, 32),
            topicId: goal.topicId,
            threadId: goal.threadId,
            objective: goal.objective,
            completionCriterion: [],
            status: goal.status === 'completed' ? 'complete' : goal.status,
            budgetLimits: this.normalizeBudget({ tokens: goal.tokenBudget }),
            tokenBudget: goal.tokenBudget,
            tokensUsed: 0,
            turnsUsed: 0,
            wallClockMs: 0,
            budgetGracePending: false,
            budgetGraceUsed: false,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
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
