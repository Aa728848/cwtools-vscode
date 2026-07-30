import type { GenerationResult } from '../types';
import { goalStore, type DurableAgentGoal, type DurableGoalStatus, type GoalBudgetLimits } from './goalStore';
import { createStepRequest, type StepRequest } from './stepRequest';

export interface GoalContinuationContext {
    cancelled: boolean;
    pendingApproval: boolean;
    pendingUserAnswer: boolean;
    blockingValidation: boolean;
    madeProgress: boolean;
    loopIdle: boolean;
    continuationQueued: boolean;
}

export interface GoalBudgetDecision {
    allowed: boolean;
    exhausted?: keyof GoalBudgetLimits;
    finalizationGrace?: boolean;
}

const TRANSITIONS: Record<DurableGoalStatus, ReadonlySet<DurableGoalStatus>> = {
    active: new Set(['paused', 'blocked', 'complete', 'cancelled']),
    paused: new Set(['active', 'cancelled']),
    blocked: new Set(['active', 'cancelled']),
    complete: new Set(),
    cancelled: new Set(),
};

export class GoalSupervisor {
    canTransition(from: DurableGoalStatus, to: DurableGoalStatus): boolean {
        return from === to || TRANSITIONS[from].has(to);
    }

    budgetDecision(goal: DurableAgentGoal): GoalBudgetDecision {
        const grace = goal.budgetGracePending === true;
        if (goal.budgetLimits.tokens !== undefined && goal.tokensUsed >= goal.budgetLimits.tokens) {
            return { allowed: grace, exhausted: 'tokens', finalizationGrace: grace };
        }
        if (goal.budgetLimits.turns !== undefined && goal.turnsUsed >= goal.budgetLimits.turns) {
            return { allowed: grace, exhausted: 'turns', finalizationGrace: grace };
        }
        if (goal.budgetLimits.wallClockMs !== undefined && goal.wallClockMs >= goal.budgetLimits.wallClockMs) {
            return { allowed: grace, exhausted: 'wallClockMs', finalizationGrace: grace };
        }
        return { allowed: true };
    }

    shouldContinue(goal: DurableAgentGoal, context: GoalContinuationContext): boolean {
        const budget = this.budgetDecision(goal);
        return goal.status === 'active'
            && budget.allowed
            && !context.cancelled
            && !context.pendingApproval
            && !context.pendingUserAnswer
            && (!context.blockingValidation || budget.finalizationGrace === true)
            && context.madeProgress
            && context.loopIdle
            && !context.continuationQueued;
    }

    createContinuation(goal: DurableAgentGoal): StepRequest<{
        goalId: string;
        objective: string;
        finalizationGrace: boolean;
    }> {
        return createStepRequest('goal_continuation', {
            goalId: goal.goalId,
            objective: goal.objective,
            finalizationGrace: goal.budgetGracePending === true,
        }, { sourceId: goal.goalId });
    }

    async claimBudgetGrace(goal: DurableAgentGoal): Promise<DurableAgentGoal> {
        if (!goal.budgetGracePending) return goal;
        return await goalStore.setBudgetGrace(goal.topicId, goal.threadId, false, true) ?? goal;
    }

    async recordTurn(
        goal: DurableAgentGoal,
        result: GenerationResult,
        wallClockMs: number,
    ): Promise<DurableAgentGoal | undefined> {
        const tokens = result.tokenUsage?.total ?? 0;
        const updated = await goalStore.recordUsage(goal.topicId, goal.threadId, {
            tokens,
            turns: 1,
            wallClockMs,
        });
        if (!updated) return undefined;
        const budget = this.budgetDecision(updated);
        if (!budget.allowed) {
            const producedTools = (result.runMetrics?.toolCallCount ?? 0) > 0;
            if (producedTools && !updated.budgetGraceUsed) {
                return goalStore.setBudgetGrace(updated.topicId, updated.threadId, true, false);
            }
            return goalStore.updateStatus(
                updated.topicId,
                updated.threadId,
                'blocked',
                `Goal ${budget.exhausted} budget exhausted.`,
            );
        }
        return updated;
    }

    async transition(
        topicId: string,
        threadId: string,
        target: DurableGoalStatus,
        reason?: string,
    ): Promise<DurableAgentGoal | undefined> {
        const goal = await goalStore.getGoal(topicId, threadId);
        if (!goal) return undefined;
        if (!this.canTransition(goal.status, target)) {
            throw new Error(`Illegal goal transition: ${goal.status} -> ${target}.`);
        }
        return goalStore.updateStatus(topicId, threadId, target, reason);
    }
}

export const goalSupervisor = new GoalSupervisor();
