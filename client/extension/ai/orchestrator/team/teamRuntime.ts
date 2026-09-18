/**
 * Eddy CWTool Code — Agent Teams runtime.
 *
 * Owns one team's roster, durable mailbox, and CAS task board, and drives the
 * peer-collaboration loop:
 *
 * 1. Every member is activated once with its brief (bounded concurrency).
 * 2. team_send_message to a running member is steered into its active run at
 *    the next model step boundary via the active-turn registry.
 * 3. team_send_message to an idle member cold-resumes it: the runtime restores
 *    the member's preserved transcript when available and sends the queued
 *    messages as the next prompt.
 * 4. The team settles when nothing is running, no message is undelivered, and
 *    either the lead closed the team, the quiet window elapsed, or the lifetime
 *    cap forced a wind-down. A settle summary is handed to the lead.
 *
 * The runtime is transport-agnostic: the host injects the member launcher, the
 * steer channel, and the transcript reader, so unit tests run without VS Code.
 */

import type { ChatMessage, TokenUsage } from '../../types';
import { TEAM_LEAD, type TeamMemberSpec, type TeamMemberState, type TeamMessage, type TeamSnapshot, type TeamSummary } from './types';
import { TeamMailbox } from './teamMailbox';
import { TeamTaskBoard } from './teamTaskBoard';

const DEFAULT_QUIET_MS = 90_000;
const DEFAULT_MAX_LIFETIME_MS = 30 * 60_000;
const MAX_OUTPUT_PREVIEW_CHARS = 600;
const SETTLE_SNAPSHOT_MESSAGES_CAP = 200;

export interface TeamMemberRunResult {
    success: boolean;
    output: string;
    error?: string;
    runId?: string;
    tokenUsage?: TokenUsage;
    needsClarification?: boolean;
    clarification?: string;
}

export interface TeamMemberActivation {
    member: TeamMemberState;
    prompt: string;
    /** Restored transcript for cold-resume wakes; undefined for fresh starts. */
    resumeMessages?: ChatMessage[];
    signal: AbortSignal;
}

export type TeamMemberLauncher = (activation: TeamMemberActivation) => Promise<TeamMemberRunResult>;

/** Progress/audit events surfaced to the parent run ledger and UI. */
export type TeamRuntimeEvent =
    | { kind: 'team_message'; from: string; to: string; delivery: string; preview: string }
    | { kind: 'team_member_started'; member: string; profileName: string; activation: number; reason: string }
    | { kind: 'team_member_idle'; member: string; success: boolean; preview: string }
    | { kind: 'team_settling'; reason: string };

export interface TeamRuntimeOptions {
    teamId: string;
    teamName?: string;
    objective: string;
    topicId?: string;
    domain: string;
    members: TeamMemberSpec[];
    maxConcurrency: number;
    /** Active run id of the dispatching lead; enables mid-run steer delivery. */
    leadRunId?: string;
    /** Quiet window with no running member and no undelivered mail before settle. */
    quietMs?: number;
    /** Hard team lifetime; reaching it starts a closing wind-down. */
    maxLifetimeMs?: number;
    launcher: TeamMemberLauncher;
    /** Steer a message into a running turn; returns false when the turn is gone. */
    steer?: (runId: string, message: string) => boolean;
    /** Restore a member transcript for cold-resume; absence falls back to summary seeding. */
    readResumeTranscript?: (runId: string) => Promise<ChatMessage[] | undefined>;
    onEvent?: (event: TeamRuntimeEvent) => void;
    /** Injectable clock for tests. */
    now?: () => number;
}

function emptyUsage(): TokenUsage {
    return { total: 0, input: 0, output: 0, estimatedCostCny: 0 };
}

function mergeUsage(target: TokenUsage, delta: TokenUsage | undefined): void {
    if (!delta) return;
    target.total += delta.total ?? 0;
    target.input += delta.input ?? 0;
    target.output += delta.output ?? 0;
    target.estimatedCostCny = (target.estimatedCostCny ?? 0) + (delta.estimatedCostCny ?? 0);
}

export class TeamRuntime {
    readonly teamId: string;
    readonly teamName?: string;
    readonly objective: string;
    readonly topicId?: string;
    readonly domain: string;
    readonly board: TeamTaskBoard;
    readonly mailbox: TeamMailbox;

    private readonly members = new Map<string, TeamMemberState>();
    private readonly options: TeamRuntimeOptions;
    private readonly createdAt: number;
    private closing = false;
    private closeNote?: string;
    private settled = false;
    private settleReason: TeamSummary['settleReason'] = 'quiet';
    private lifetimeCapHit = false;
    private runningCount = 0;
    private lastActivityAt: number;
    private readonly waiters = new Set<() => void>();
    private readonly pendingInitial = new Set<string>();
    private readonly runningActivations = new Set<Promise<void>>();
    /** Abort signal of the active run() call; chained into every member activation. */
    private runSignal: AbortSignal = new AbortController().signal;

    constructor(options: TeamRuntimeOptions) {
        this.options = options;
        this.teamId = options.teamId;
        this.teamName = options.teamName;
        this.objective = options.objective;
        this.topicId = options.topicId;
        this.domain = options.domain;
        this.createdAt = this.now();
        this.lastActivityAt = this.createdAt;
        this.board = new TeamTaskBoard(options.teamId);
        this.mailbox = new TeamMailbox(options.teamId, name => name === TEAM_LEAD || this.members.has(name));
        for (const spec of options.members) {
            this.members.set(spec.name, {
                name: spec.name,
                profileName: spec.profileName,
                brief: spec.brief,
                plannedFiles: [...(spec.plannedFiles ?? [])],
                writeScopes: [...(spec.writeScopes ?? [])],
                status: 'provisioning',
                activations: 0,
                tokenUsage: emptyUsage(),
                lastActivityAt: this.createdAt,
            });
        }
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    /** Creation timestamp used for newest-first registry ordering. */
    get createdAtSortKey(): number {
        return this.createdAt;
    }

    isSettled(): boolean {
        return this.settled;
    }

    isClosing(): boolean {
        return this.closing;
    }

    /** Record the durable run id of a member activation (enables steer delivery). */
    markMemberRunStarted(memberName: string, runId: string): void {
        const member = this.members.get(memberName);
        if (!member) return;
        member.activeRunId = runId;
        member.lastRunId = runId;
        // Flush messages that queued between activation start and run
        // registration; they would otherwise wait for the next wake.
        const pending = this.mailbox.pendingFor(memberName);
        if (pending.length === 0) return;
        const steered: string[] = [];
        for (const message of pending) {
            if (this.options.steer?.(runId, this.frameMessage(message)) === true) {
                steered.push(message.id);
            }
        }
        if (steered.length > 0) this.mailbox.markDelivered(steered, 'steered');
    }

    /** Lead-side roster view. */
    roster(): Array<Record<string, unknown>> {
        return [...this.members.values()].map(member => ({
            name: member.name,
            profileName: member.profileName,
            status: member.status,
            activations: member.activations,
            unread: this.mailbox.countPendingFor(member.name),
            activeRunId: member.activeRunId,
            lastOutput: member.lastOutput,
            lastError: member.lastError,
            tokenUsage: member.tokenUsage,
            lastActivityAt: member.lastActivityAt,
        }));
    }

    memberNames(): string[] {
        return [...this.members.keys()];
    }

    /** Graceful wind-down: no new wakes; running members finish; then settle. */
    requestClose(reason: 'closed' | 'lifetime_cap' = 'closed', note?: string): void {
        if (this.settled) return;
        this.closing = true;
        if (reason === 'lifetime_cap') this.lifetimeCapHit = true;
        if (note && note.trim()) this.closeNote = note.trim().slice(0, 400);
        this.notifyActivity();
    }

    /**
     * Send one peer message. Running targets are steered immediately; idle or
     * provisioning targets keep the message pending until the run loop wakes
     * them; lead-bound messages steer the lead's active run or ride the settle
     * summary when the lead is no longer active.
     */
    sendMessage(from: string, to: string, content: string): { success: boolean; delivery?: string; messageId?: string; error?: string } {
        if (this.settled) {
            return { success: false, error: 'Team ' + this.teamId + ' has settled. Dispatch a new team for follow-up work.' };
        }
        if (this.closing) {
            return { success: false, error: 'Team ' + this.teamId + ' is closing and no longer accepts messages.' };
        }
        const sent = this.mailbox.send(from, to, content);
        if (!sent.success || !sent.message) {
            return { success: false, error: sent.error };
        }
        const message = sent.message;
        const framed = this.frameMessage(message);
        let delivery: TeamMessage['delivery'] | 'queued_wake' = 'queued_wake';
        if (message.to === TEAM_LEAD) {
            const leadRunId = this.options.leadRunId;
            const steered = !!leadRunId && this.options.steer?.(leadRunId, framed) === true;
            if (steered) {
                this.mailbox.markDelivered([message.id], 'steered');
                delivery = 'steered';
            } else {
                delivery = 'queued_wake';
            }
        } else {
            const target = this.members.get(message.to);
            if (target?.status === 'running' && target.activeRunId) {
                const steered = this.options.steer?.(target.activeRunId, framed) === true;
                if (steered) {
                    this.mailbox.markDelivered([message.id], 'steered');
                    delivery = 'steered';
                }
            }
        }
        this.options.onEvent?.({
            kind: 'team_message',
            from: message.from,
            to: message.to,
            delivery,
            preview: message.content.slice(0, 160),
        });
        this.notifyActivity();
        return { success: true, delivery, messageId: message.id };
    }

    /** Main team loop. Resolves with the settle summary. */
    async run(signal: AbortSignal): Promise<TeamSummary> {
        const quietMs = Math.max(1_000, this.options.quietMs ?? DEFAULT_QUIET_MS);
        const maxLifetimeMs = Math.max(quietMs * 2, this.options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS);
        for (const member of this.members.values()) {
            this.pendingInitial.add(member.name);
        }

        this.runSignal = signal;
        const onAbort = () => {
            this.settleReason = 'aborted';
            this.closing = true;
            this.notifyActivity();
        };
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
            while (true) {
                if (signal.aborted) {
                    this.settleReason = 'aborted';
                    break;
                }
                if (!this.lifetimeCapHit && this.now() - this.createdAt >= maxLifetimeMs) {
                    this.requestClose('lifetime_cap');
                }

                this.pumpActivations();

                if (this.runningCount > 0) {
                    await this.waitForActivity(undefined, signal);
                    continue;
                }

                if (!this.closing) {
                    // Deliver pending messages to idle members by waking them.
                    const woken = this.wakeIdleMembersWithPendingMessages();
                    if (woken > 0) continue;
                    if (this.pendingInitial.size > 0) continue;

                    const idleFor = this.now() - this.lastActivityAt;
                    if (idleFor >= quietMs) {
                        this.settleReason = 'quiet';
                        break;
                    }
                    await this.waitForActivity(quietMs - idleFor, signal);
                    continue;
                }

                // Closing: nothing running anymore (checked above).
                this.settleReason = this.settleReason === 'aborted'
                    ? 'aborted'
                    : this.lifetimeCapHit ? 'lifetime_cap' : 'closed';
                break;
            }

            // Wait for in-flight activations to finish their finally blocks.
            await Promise.allSettled([...this.runningActivations]);
        } finally {
            signal.removeEventListener('abort', onAbort);
            this.settled = true;
            this.options.onEvent?.({ kind: 'team_settling', reason: this.settleReason });
        }
        return this.buildSummary();
    }

    /** Fire-and-track one member activation; never throws. */
    private activate(member: TeamMemberState, messages: TeamMessage[], initial: boolean, signal: AbortSignal): void {
        member.status = 'running';
        member.activations += 1;
        member.lastActivityAt = this.now();
        this.runningCount += 1;
        this.options.onEvent?.({
            kind: 'team_member_started',
            member: member.name,
            profileName: member.profileName,
            activation: member.activations,
            reason: initial ? 'initial brief' : messages.length + ' queued message(s)',
        });

        const activation = (async () => {
            let resumeMessages: ChatMessage[] | undefined;
            if (!initial && member.lastRunId && this.options.readResumeTranscript) {
                try {
                    const transcript = await this.options.readResumeTranscript(member.lastRunId);
                    const replayable = (transcript ?? []).filter(message => message.role !== 'system');
                    if (replayable.length > 0) resumeMessages = replayable;
                } catch {
                    resumeMessages = undefined;
                }
            }
            const prompt = this.buildActivationPrompt(member, messages, initial, !!resumeMessages);
            try {
                const result = await this.options.launcher({ member, prompt, resumeMessages, signal });
                member.lastRunId = result.runId ?? member.lastRunId;
                member.lastOutput = (result.output || '').slice(0, MAX_OUTPUT_PREVIEW_CHARS) || member.lastOutput;
                member.lastError = result.success ? undefined : (result.error ?? 'unknown failure');
                mergeUsage(member.tokenUsage, result.tokenUsage);
                this.options.onEvent?.({
                    kind: 'team_member_idle',
                    member: member.name,
                    success: result.success,
                    preview: member.lastOutput ?? member.lastError ?? '',
                });
                // A blocked member escalates to the lead as ordinary peer mail.
                if (result.needsClarification && result.clarification) {
                    this.sendMessage(member.name, TEAM_LEAD, '[BLOCKED — needs a decision] ' + result.clarification);
                }
            } catch (error) {
                member.lastError = error instanceof Error ? error.message : String(error);
                this.options.onEvent?.({ kind: 'team_member_idle', member: member.name, success: false, preview: member.lastError });
            } finally {
                member.status = 'idle';
                member.activeRunId = undefined;
                member.lastActivityAt = this.now();
                this.runningCount -= 1;
                this.notifyActivity();
            }
        })();
        this.runningActivations.add(activation);
        void activation.finally(() => this.runningActivations.delete(activation));
    }

    private pumpActivations(): void {
        if (this.closing) return;
        const maxConcurrency = Math.max(1, this.options.maxConcurrency);
        // Initial activations first.
        for (const name of [...this.pendingInitial]) {
            if (this.runningCount >= maxConcurrency) return;
            const member = this.members.get(name);
            if (!member) {
                this.pendingInitial.delete(name);
                continue;
            }
            this.pendingInitial.delete(name);
            const pending = this.mailbox.pendingFor(name);
            this.mailbox.markDelivered(pending.map(message => message.id), 'wake');
            this.activate(member, pending, true, this.runSignal);
        }
    }

    /** Wake idle members that have undelivered messages. Returns the count woken. */
    private wakeIdleMembersWithPendingMessages(): number {
        const maxConcurrency = Math.max(1, this.options.maxConcurrency);
        let woken = 0;
        for (const member of this.members.values()) {
            if (this.runningCount >= maxConcurrency) break;
            if (member.status !== 'idle') continue;
            const pending = this.mailbox.pendingFor(member.name);
            if (pending.length === 0) continue;
            this.mailbox.markDelivered(pending.map(message => message.id), 'wake');
            this.activate(member, pending, false, this.runSignal);
            woken += 1;
        }
        return woken;
    }


    private frameMessage(message: TeamMessage): string {
        return '[Team message from ' + message.from + ' in team ' + this.teamId + ']\n\n' + message.content;
    }

    private buildActivationPrompt(member: TeamMemberState, messages: TeamMessage[], initial: boolean, resumed: boolean): string {
        const rosterLines = [...this.members.values()].map(other =>
            '- ' + other.name + ' (' + other.profileName + ', ' + other.status + ')'
            + (other.name === member.name ? ' — you' : ''),
        );
        const openTasks = this.board.openTasks();
        const taskLines = openTasks.slice(0, 12).map(task =>
            '- [' + task.status + '] ' + task.id + ' rev' + task.revision + ': ' + task.subject
            + (task.owner ? ' (owner: ' + task.owner + ')' : ' (unclaimed)')
            + (task.blockedBy.length > 0 ? ' blockedBy: ' + task.blockedBy.join(', ') : ''),
        );
        const messageLines = messages.map(message =>
            '--- from ' + message.from + ' ---\n' + message.content,
        );

        const parts: string[] = [
            '<team-context team="' + this.teamId + '" member="' + member.name + '">',
            'You are member ' + member.name + ' (profile: ' + member.profileName + ') of agent team'
            + (this.teamName ? ' "' + this.teamName + '"' : '') + '.',
            'Team objective: ' + this.objective,
            '',
            'Teammates:',
            ...rosterLines,
            '- lead — the coordinator that dispatched this team',
            '',
            'Peer collaboration protocol:',
            '- team_send_message({ target, message }) reaches a teammate: running teammates are steered at their next step, idle teammates wake up with your message. Use target "lead" to escalate decisions or blockers to the coordinator.',
            '- Shared task board: team_task_create / team_task_list / team_task_update. Read the board before starting work; claim a task with its current revision before you start it; complete it when done. Re-read and retry on revision conflicts.',
            '- Coordinate writes through the board writeScopes and your declared plannedFiles; never edit a file another member owns without agreeing on the board first.',
            '</team-context>',
        ];
        if (initial) {
            parts.push('', '## Your initial brief', '', member.brief);
        }
        if (messages.length > 0) {
            parts.push('', '## Team messages', '', ...messageLines);
        }
        if (taskLines.length > 0) {
            parts.push('', '## Open team tasks', '', ...taskLines);
        }
        if (resumed) {
            parts.push(
                '',
                'The conversation above is your own restored working context from your previous activation. '
                + 'Continue from it; do not repeat tool calls whose results are already present. '
                + 'Re-read a file only before changing it or when you suspect a teammate modified it.',
            );
        }
        return parts.join('\n');
    }

    private notifyActivity(): void {
        this.lastActivityAt = this.now();
        const waiters = [...this.waiters];
        this.waiters.clear();
        for (const resolve of waiters) resolve();
    }

    private waitForActivity(timeoutMs: number | undefined, signal: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            if (signal.aborted) { resolve(); return; }
            const done = () => {
                if (timer) clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
            const onAbort = () => done();
            this.waiters.add(done);
            signal.addEventListener('abort', onAbort, { once: true });
            const timer = timeoutMs !== undefined
                ? setTimeout(() => {
                    this.waiters.delete(done);
                    done();
                }, timeoutMs)
                : undefined;
        });
    }

    private buildSummary(): TeamSummary {
        const tasks = this.board.snapshot();
        const open = tasks.filter(task => task.status !== 'completed');
        const totalTokenUsage = emptyUsage();
        const memberSummaries = [...this.members.values()].map(member => {
            mergeUsage(totalTokenUsage, member.tokenUsage);
            return {
                name: member.name,
                profileName: member.profileName,
                activations: member.activations,
                tokenUsage: member.tokenUsage,
                lastOutput: member.lastOutput,
                lastError: member.lastError,
            };
        });
        return {
            teamId: this.teamId,
            teamName: this.teamName,
            objective: this.objective,
            settledAt: this.now(),
            settleReason: this.settleReason,
            closeNote: this.closeNote,
            members: memberSummaries,
            tasks: {
                total: tasks.length,
                completed: tasks.length - open.length,
                open: open.map(task => ({ id: task.id, subject: task.subject, status: task.status, owner: task.owner })),
            },
            undeliveredMessages: this.mailbox.undeliveredPreview(),
            totalTokenUsage,
        };
    }

    /** Serializable snapshot for best-effort persistence at settle time. */
    snapshot(): TeamSnapshot {
        return {
            version: 1,
            teamId: this.teamId,
            teamName: this.teamName,
            objective: this.objective,
            topicId: this.topicId,
            domain: this.domain,
            createdAt: this.createdAt,
            members: [...this.members.values()].map(member => ({
                name: member.name,
                profileName: member.profileName,
                brief: member.brief,
                status: member.status,
                activations: member.activations,
                lastOutput: member.lastOutput,
                lastError: member.lastError,
                lastRunId: member.lastRunId,
            })),
            messages: this.mailbox.snapshot().slice(-SETTLE_SNAPSHOT_MESSAGES_CAP),
            tasks: this.board.snapshot(),
        };
    }
}

export { TEAM_LEAD };
