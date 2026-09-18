/**
 * Eddy CWTool Code — Agent Teams shared task board.
 *
 * A per-team DAG of tasks with compare-and-set mutation. Every mutation
 * stores a complete snapshot and bumps revision by one; callers pass the
 * revision they observed so concurrent claim/edit races fail deterministically
 * instead of silently overwriting each other. blockedBy edges must reference
 * existing tasks and keep the graph acyclic. writeScopes are advisory
 * workspace-relative prefixes that surface overlap warnings — they are not
 * file locks (the runner write queue remains the hard exclusion boundary).
 */

import type {
    TeamTask,
    TeamTaskAction,
    TeamTaskListFilter,
    TeamTaskUpdateResult,
    TeamTaskView,
} from './types';
import {
    TEAM_MAX_DESCRIPTION_CHARS,
    TEAM_MAX_SUBJECT_CHARS,
    TEAM_MAX_WRITE_SCOPE_CHARS,
    TEAM_MAX_WRITE_SCOPES,
} from './types';

export interface TeamTaskCreateInput {
    subject: string;
    description?: string;
    blockedBy?: string[];
    writeScopes?: string[];
}

export interface TeamTaskEditPayload {
    subject?: string;
    description?: string;
    blockedBy?: string[];
    writeScopes?: string[];
}

/**
 * Normalize one advisory write scope to a workspace-relative forward-slash
 * prefix. Rejects absolute paths and '..' traversal; returns undefined for
 * unusable input so the caller can report the rejected scope.
 */
export function normalizeTeamWriteScope(scope: unknown): string | undefined {
    if (typeof scope !== 'string') return undefined;
    let value = scope.trim().replace(/\\/g, '/');
    if (!value) return undefined;
    if (value.length > TEAM_MAX_WRITE_SCOPE_CHARS) return undefined;
    if (/^[a-zA-Z]:\//.test(value) || value.startsWith('/')) return undefined;
    const segments = value.split('/').filter(segment => segment.length > 0 && segment !== '.');
    if (segments.some(segment => segment === '..')) return undefined;
    value = segments.join('/');
    if (!value) return undefined;
    // Directory-style scopes keep a trailing slash so 'events' and
    // 'events2' never overlap by string prefix alone.
    return value.endsWith('/') ? value : value + '/';
}

function scopesOverlap(left: string, right: string): boolean {
    return left.startsWith(right) || right.startsWith(left);
}

export class TeamTaskBoard {
    private readonly tasks = new Map<string, TeamTask>();
    private nextTaskNumber = 1;

    constructor(private readonly teamId: string) {}

    get size(): number {
        return this.tasks.size;
    }

    get(taskId: string): TeamTask | undefined {
        return this.tasks.get(taskId);
    }

    isReady(task: TeamTask): boolean {
        return task.blockedBy.every(id => this.tasks.get(id)?.status === 'completed');
    }

    /** Create a task. Returns the created view or a validation error. */
    create(caller: string, input: TeamTaskCreateInput): TeamTaskUpdateResult {
        const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
        if (!subject) {
            return { success: false, error: 'team_task_create requires a non-empty subject.' };
        }
        if (subject.length > TEAM_MAX_SUBJECT_CHARS) {
            return { success: false, error: 'subject exceeds ' + TEAM_MAX_SUBJECT_CHARS + ' characters.' };
        }
        const description = typeof input.description === 'string' ? input.description.trim() : '';
        if (description.length > TEAM_MAX_DESCRIPTION_CHARS) {
            return { success: false, error: 'description exceeds ' + TEAM_MAX_DESCRIPTION_CHARS + ' characters.' };
        }
        const blockedBy = this.normalizeBlockers(input.blockedBy);
        if (typeof blockedBy === 'string') {
            return { success: false, error: blockedBy };
        }
        const writeScopes = this.normalizeScopes(input.writeScopes);
        if (typeof writeScopes === 'string') {
            return { success: false, error: writeScopes };
        }

        const id = 'task-' + this.nextTaskNumber++;
        const now = Date.now();
        const task: TeamTask = {
            id,
            subject,
            description,
            status: 'pending',
            revision: 1,
            blockedBy,
            writeScopes,
            createdBy: caller,
            createdAt: now,
            updatedAt: now,
        };
        this.tasks.set(id, task);
        return { success: true, task: this.toView(task) };
    }

    /** Compare-and-set mutation. */
    update(
        caller: string,
        isLead: boolean,
        taskId: string,
        expectedRevision: number,
        action: TeamTaskAction,
        payload: TeamTaskEditPayload = {},
    ): TeamTaskUpdateResult {
        const task = this.tasks.get(taskId);
        if (!task) {
            return { success: false, error: "Unknown task '" + taskId + "'. Use team_task_list for the current board." };
        }
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
            return { success: false, error: 'expectedRevision must be a positive integer read from team_task_list or the create result.' };
        }
        if (task.revision !== expectedRevision) {
            return {
                success: false,
                error: "Revision conflict on '" + taskId + "': expected v" + expectedRevision + ", current v" + task.revision + ". Re-read with team_task_list and retry.",
                currentRevision: task.revision,
            };
        }

        switch (action) {
            case 'claim': {
                if (task.status === 'completed') {
                    return { success: false, error: "Task '" + taskId + "' is already completed.", currentRevision: task.revision };
                }
                if (task.status === 'in_progress' && task.owner !== caller) {
                    return { success: false, error: "Task '" + taskId + "' is already claimed by '" + task.owner + "'.", currentRevision: task.revision };
                }
                if (task.status === 'in_progress' && task.owner === caller) {
                    return { success: true, task: this.toView(task) };
                }
                const incomplete = task.blockedBy.filter(id => this.tasks.get(id)?.status !== 'completed');
                if (incomplete.length > 0) {
                    return {
                        success: false,
                        error: "Task '" + taskId + "' is blocked by incomplete task(s): " + incomplete.join(', ') + '.',
                        currentRevision: task.revision,
                    };
                }
                task.status = 'in_progress';
                task.owner = caller;
                break;
            }
            case 'release': {
                if (task.status !== 'in_progress') {
                    return { success: false, error: "Task '" + taskId + "' is not in progress.", currentRevision: task.revision };
                }
                if (task.owner !== caller && !isLead) {
                    return { success: false, error: "Only the owner '" + task.owner + "' or the lead can release task '" + taskId + "'.", currentRevision: task.revision };
                }
                task.status = 'pending';
                task.owner = undefined;
                break;
            }
            case 'complete': {
                if (task.status === 'completed') {
                    return { success: true, task: this.toView(task) };
                }
                if (task.owner !== caller && !isLead) {
                    return {
                        success: false,
                        error: task.owner
                            ? "Only the owner '" + task.owner + "' or the lead can complete task '" + taskId + "'. Claim it first if it is unowned."
                            : "Task '" + taskId + "' is unclaimed. Claim it before completing it.",
                        currentRevision: task.revision,
                    };
                }
                task.status = 'completed';
                task.completedAt = Date.now();
                break;
            }
            case 'edit': {
                if (task.owner && task.owner !== caller && !isLead) {
                    return { success: false, error: "Only the owner '" + task.owner + "' or the lead can edit task '" + taskId + "'.", currentRevision: task.revision };
                }
                if (task.status === 'completed') {
                    return { success: false, error: "Task '" + taskId + "' is completed and can no longer be edited.", currentRevision: task.revision };
                }
                if (payload.subject !== undefined) {
                    const subject = payload.subject.trim();
                    if (!subject) return { success: false, error: 'subject must be non-empty when provided.' };
                    if (subject.length > TEAM_MAX_SUBJECT_CHARS) {
                        return { success: false, error: 'subject exceeds ' + TEAM_MAX_SUBJECT_CHARS + ' characters.' };
                    }
                    task.subject = subject;
                }
                if (payload.description !== undefined) {
                    const description = payload.description.trim();
                    if (description.length > TEAM_MAX_DESCRIPTION_CHARS) {
                        return { success: false, error: 'description exceeds ' + TEAM_MAX_DESCRIPTION_CHARS + ' characters.' };
                    }
                    task.description = description;
                }
                if (payload.blockedBy !== undefined) {
                    const blockedBy = this.normalizeBlockers(payload.blockedBy, task.id);
                    if (typeof blockedBy === 'string') return { success: false, error: blockedBy };
                    task.blockedBy = blockedBy;
                }
                if (payload.writeScopes !== undefined) {
                    const writeScopes = this.normalizeScopes(payload.writeScopes);
                    if (typeof writeScopes === 'string') return { success: false, error: writeScopes };
                    task.writeScopes = writeScopes;
                }
                break;
            }
        }

        task.revision += 1;
        task.updatedAt = Date.now();
        return { success: true, task: this.toView(task) };
    }

    list(filter: TeamTaskListFilter = {}): TeamTaskView[] {
        const rows = [...this.tasks.values()]
            .filter(task => (!filter.status || task.status === filter.status)
                && (!filter.owner || task.owner === filter.owner))
            .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));
        return rows.map(task => this.toView(task));
    }

    /** Open (not completed) tasks, in creation order. */
    openTasks(): TeamTask[] {
        return [...this.tasks.values()]
            .filter(task => task.status !== 'completed')
            .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));
    }

    snapshot(): TeamTask[] {
        return [...this.tasks.values()].map(task => ({ ...task, blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes] }));
    }

    /** Advisory overlap between one task's scopes and every other open task. */
    private overlapWarnings(task: TeamTask): string[] {
        const warnings: string[] = [];
        for (const other of this.tasks.values()) {
            if (other.id === task.id || other.status === 'completed') continue;
            const overlap = task.writeScopes.some(scope => other.writeScopes.some(otherScope => scopesOverlap(scope, otherScope)));
            if (overlap) {
                warnings.push('write scope overlaps with ' + other.id + ' (' + other.subject + ')' + (other.owner ? ' owned by ' + other.owner : ''));
            }
        }
        return warnings;
    }

    private toView(task: TeamTask): TeamTaskView {
        return {
            ...task,
            blockedBy: [...task.blockedBy],
            writeScopes: [...task.writeScopes],
            ready: task.status === 'completed' ? false : this.isReady(task),
            writeScopeWarnings: this.overlapWarnings(task),
        };
    }

    /** Returns the normalized blocker list, or an error string. */
    private normalizeBlockers(blockedBy: unknown, selfId?: string): string[] | string {
        if (blockedBy === undefined) return [];
        if (!Array.isArray(blockedBy) || blockedBy.length > 32) {
            return 'blockedBy must be an array of at most 32 task ids.';
        }
        const normalized: string[] = [];
        for (const raw of blockedBy) {
            if (typeof raw !== 'string' || !raw.trim()) return 'blockedBy entries must be non-empty task id strings.';
            const id = raw.trim();
            if (selfId && id === selfId) return "Task '" + selfId + "' cannot block itself.";
            if (!this.tasks.has(id)) return "blockedBy references unknown task '" + id + "'.";
            if (!normalized.includes(id)) normalized.push(id);
        }
        // Cycle check: walk the blocker graph from each new blocker; reaching
        // selfId closes a loop. New tasks have no outgoing edges yet, so only
        // edits need this check.
        if (selfId) {
            for (const blocker of normalized) {
                if (this.reachesViaBlockers(blocker, selfId)) {
                    return "blockedBy would create a dependency cycle: '" + blocker + "' already depends on '" + selfId + "'.";
                }
            }
        }
        return normalized;
    }

    private reachesViaBlockers(fromId: string, targetId: string): boolean {
        const visited = new Set<string>();
        const stack = [fromId];
        while (stack.length > 0) {
            const current = stack.pop()!;
            if (current === targetId) return true;
            if (visited.has(current)) continue;
            visited.add(current);
            const task = this.tasks.get(current);
            if (task) stack.push(...task.blockedBy);
        }
        return false;
    }

    /** Returns the normalized scope list, or an error string. */
    private normalizeScopes(writeScopes: unknown): string[] | string {
        if (writeScopes === undefined) return [];
        if (!Array.isArray(writeScopes) || writeScopes.length > TEAM_MAX_WRITE_SCOPES) {
            return 'writeScopes must be an array of at most ' + TEAM_MAX_WRITE_SCOPES + ' workspace-relative prefixes.';
        }
        const normalized: string[] = [];
        for (const raw of writeScopes) {
            const scope = normalizeTeamWriteScope(raw);
            if (!scope) {
                return "Invalid write scope '" + String(raw) + "': use workspace-relative prefixes without drive letters, leading slashes, or '..'.";
            }
            if (!normalized.includes(scope)) normalized.push(scope);
        }
        return normalized;
    }
}
