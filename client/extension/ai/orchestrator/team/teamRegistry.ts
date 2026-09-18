/**
 * Eddy CWTool Code — Agent Teams registry.
 *
 * Process-local registry of live team runtimes, keyed by team id. Mirrors the
 * backgroundOrchestrators pattern: tool dispatch resolves the caller's team
 * (members via their run-bound teamId, the lead via the latest active team of
 * the topic) and dead teams are removed when they settle.
 */

import type { TeamRuntime } from './teamRuntime';

class TeamRegistry {
    private readonly teams = new Map<string, TeamRuntime>();

    register(team: TeamRuntime): void {
        this.teams.set(team.teamId, team);
    }

    get(teamId: string): TeamRuntime | undefined {
        return this.teams.get(teamId);
    }

    remove(teamId: string): void {
        this.teams.delete(teamId);
    }

    /** Active (not settled) teams of one topic, newest first. */
    listActiveForTopic(topicId: string | undefined): TeamRuntime[] {
        return [...this.teams.values()]
            .filter(team => team.topicId === topicId && !team.isSettled())
            .sort((left, right) => right.createdAtSortKey - left.createdAtSortKey);
    }

    listAll(): TeamRuntime[] {
        return [...this.teams.values()];
    }

    /**
     * Resolve the team a tool call belongs to: an explicit teamId wins;
     * otherwise the caller inside a team run uses its bound team; the lead
     * falls back to the newest active team of the topic.
     */
    resolve(args: { teamId?: string; boundTeamId?: string; topicId?: string }): TeamRuntime | undefined {
        if (args.teamId) return this.teams.get(args.teamId);
        if (args.boundTeamId) return this.teams.get(args.boundTeamId);
        const candidates = this.listActiveForTopic(args.topicId);
        return candidates[0];
    }
}

export const teamRegistry = new TeamRegistry();
