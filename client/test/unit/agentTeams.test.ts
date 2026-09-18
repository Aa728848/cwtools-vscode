/**
 * Agent Teams — unit tests.
 *
 * Covers the mailbox (send/pending/deliver), the CAS task board (claim,
 * release, complete, edit, cycles, write scopes), and the team runtime
 * collaboration loop (initial activation, steer delivery to running members,
 * cold-resume of idle members, quiet settle, close).
 * Style: ts-mocha + chai, consistent with orchestrator.test.ts.
 */

import { expect } from 'chai';
import { TeamMailbox } from '../../extension/ai/orchestrator/team/teamMailbox';
import { TeamTaskBoard, normalizeTeamWriteScope } from '../../extension/ai/orchestrator/team/teamTaskBoard';
import { TeamRuntime, type TeamMemberLauncher, type TeamMemberRunResult } from '../../extension/ai/orchestrator/team/teamRuntime';
import { TEAM_LEAD, type TeamMemberSpec } from '../../extension/ai/orchestrator/team/types';

// ── TeamMailbox ─────────────────────────────────────────────────────────────

describe('TeamMailbox', () => {
    const recipients = new Set(['alpha', 'beta']);
    const known = (name: string) => name === TEAM_LEAD || recipients.has(name);

    it('send + pendingFor + markDelivered', () => {
        const mailbox = new TeamMailbox('team-t1', known);
        const sent = mailbox.send('alpha', 'beta', 'hello beta');
        expect(sent.success).to.be.true;
        expect(mailbox.pendingFor('beta')).to.have.length(1);
        mailbox.markDelivered([sent.message!.id], 'steered');
        expect(mailbox.pendingFor('beta')).to.have.length(0);
        expect(mailbox.hasPending()).to.be.false;
        expect(mailbox.snapshot()[0]!.delivery).to.equal('steered');
    });

    it('rejects unknown recipients', () => {
        const mailbox = new TeamMailbox('team-t1', known);
        const result = mailbox.send('alpha', 'nobody', 'hi');
        expect(result.success).to.be.false;
        expect(result.error).to.contain('Unknown team recipient');
    });

    it('rejects self messages and empty content', () => {
        const mailbox = new TeamMailbox('team-t1', known);
        expect(mailbox.send('alpha', 'alpha', 'hi').success).to.be.false;
        expect(mailbox.send('alpha', 'beta', '   ').success).to.be.false;
    });

    it('accepts lead as a recipient', () => {
        const mailbox = new TeamMailbox('team-t1', known);
        const result = mailbox.send('alpha', TEAM_LEAD, 'blocked: need a decision');
        expect(result.success).to.be.true;
        expect(mailbox.pendingFor(TEAM_LEAD)).to.have.length(1);
    });

    it('enforces the per-recipient pending cap', () => {
        const mailbox = new TeamMailbox('team-t1', known);
        for (let i = 0; i < 50; i++) {
            expect(mailbox.send('alpha', 'beta', 'msg ' + i).success).to.be.true;
        }
        const overflow = mailbox.send('alpha', 'beta', 'one too many');
        expect(overflow.success).to.be.false;
        expect(overflow.error).to.contain('undelivered');
    });
});

// ── TeamTaskBoard ───────────────────────────────────────────────────────────

describe('TeamTaskBoard', () => {
    it('create assigns monotonically numbered ids and revision 1', () => {
        const board = new TeamTaskBoard('team-t1');
        const first = board.create('lead', { subject: 'first' });
        const second = board.create('lead', { subject: 'second' });
        expect(first.task?.id).to.equal('task-1');
        expect(second.task?.id).to.equal('task-2');
        expect(second.task?.revision).to.equal(1);
    });

    it('claim succeeds when blockers are complete', () => {
        const board = new TeamTaskBoard('team-t1');
        const a = board.create('lead', { subject: 'a' }).task!;
        const b = board.create('lead', { subject: 'b', blockedBy: [a.id] }).task!;
        const blockedClaim = board.update('alpha', false, b.id, b.revision, 'claim');
        expect(blockedClaim.success).to.be.false;
        expect(blockedClaim.error).to.contain('blocked by');
        board.update('alpha', false, a.id, a.revision, 'claim');
        board.update('alpha', false, a.id, a.revision + 1, 'complete');
        const readyClaim = board.update('beta', false, b.id, b.revision, 'claim');
        expect(readyClaim.success).to.be.true;
        expect(readyClaim.task?.owner).to.equal('beta');
        expect(readyClaim.task?.status).to.equal('in_progress');
    });

    it('claim fails on CAS revision mismatch', () => {
        const board = new TeamTaskBoard('team-t1');
        const task = board.create('lead', { subject: 'x' }).task!;
        board.update('alpha', false, task.id, 1, 'claim');
        const stale = board.update('beta', false, task.id, 1, 'claim');
        expect(stale.success).to.be.false;
        expect(stale.currentRevision).to.equal(2);
    });

    it('claim is idempotent for the current owner but rejects others', () => {
        const board = new TeamTaskBoard('team-t1');
        const task = board.create('lead', { subject: 'x' }).task!;
        board.update('alpha', false, task.id, 1, 'claim');
        const again = board.update('alpha', false, task.id, 2, 'claim');
        expect(again.success).to.be.true;
        const other = board.update('beta', false, task.id, 2, 'claim');
        expect(other.success).to.be.false;
        expect(other.error).to.contain('already claimed');
    });

    it('release and complete enforce ownership (lead may override)', () => {
        const board = new TeamTaskBoard('team-t1');
        const task = board.create('lead', { subject: 'x' }).task!;
        board.update('alpha', false, task.id, 1, 'claim');
        const wrongRelease = board.update('beta', false, task.id, 2, 'release');
        expect(wrongRelease.success).to.be.false;
        const wrongComplete = board.update('beta', false, task.id, 2, 'complete');
        expect(wrongComplete.success).to.be.false;
        const leadComplete = board.update('lead', true, task.id, 2, 'complete');
        expect(leadComplete.success).to.be.true;
        expect(leadComplete.task?.status).to.equal('completed');
    });

    it('edit rejects dependency cycles and self-blocking', () => {
        const board = new TeamTaskBoard('team-t1');
        const a = board.create('lead', { subject: 'a' }).task!;
        const b = board.create('lead', { subject: 'b', blockedBy: [a.id] }).task!;
        const cycle = board.update('lead', true, a.id, a.revision, 'edit', { blockedBy: [b.id] });
        expect(cycle.success).to.be.false;
        expect(cycle.error).to.contain('cycle');
        const selfBlock = board.update('lead', true, a.id, a.revision, 'edit', { blockedBy: [a.id] });
        expect(selfBlock.success).to.be.false;
        expect(selfBlock.error).to.contain('itself');
    });

    it('edit rejects blockers referencing unknown tasks', () => {
        const board = new TeamTaskBoard('team-t1');
        const created = board.create('lead', { subject: 'a', blockedBy: ['task-99'] });
        expect(created.success).to.be.false;
        expect(created.error).to.contain('unknown task');
    });

    it('writeScopes normalize and surface overlap warnings', () => {
        expect(normalizeTeamWriteScope('common/events')).to.equal('common/events/');
        expect(normalizeTeamWriteScope('common\\\\events\\\\')).to.equal('common/events/');
        expect(normalizeTeamWriteScope('C:/abs/path')).to.be.undefined;
        expect(normalizeTeamWriteScope('../escape')).to.be.undefined;
        expect(normalizeTeamWriteScope('/abs')).to.be.undefined;

        const board = new TeamTaskBoard('team-t1');
        const a = board.create('alpha', { subject: 'a', writeScopes: ['common/events'] }).task!;
        const b = board.create('beta', { subject: 'b', writeScopes: ['common/events/naval'] }).task!;
        expect(b.writeScopeWarnings.some(warning => warning.includes(a.id))).to.be.true;
        // Unrelated scopes produce no warnings.
        const c = board.create('beta', { subject: 'c', writeScopes: ['localisation'] }).task!;
        expect(c.writeScopeWarnings).to.have.length(0);
    });

    it('list filters by status and owner and sorts numerically', () => {
        const board = new TeamTaskBoard('team-t1');
        for (let i = 0; i < 11; i++) board.create('lead', { subject: 't' + i });
        board.update('alpha', false, 'task-1', 1, 'claim');
        const inProgress = board.list({ status: 'in_progress' });
        expect(inProgress).to.have.length(1);
        expect(inProgress[0]!.owner).to.equal('alpha');
        const all = board.list();
        expect(all[0]!.id).to.equal('task-1');
        expect(all[10]!.id).to.equal('task-11');
    });
});

// ── TeamRuntime ─────────────────────────────────────────────────────────────

interface LauncherCall {
    member: string;
    prompt: string;
    resumed: boolean;
}

function makeMembers(): TeamMemberSpec[] {
    return [
        { name: 'alpha', profileName: 'general-coder', brief: 'do alpha work', plannedFiles: [], writeScopes: [] },
        { name: 'beta', profileName: 'reviewer', brief: 'do beta work', plannedFiles: [], writeScopes: [] },
    ];
}

function makeLauncher(behavior?: (call: LauncherCall) => Partial<TeamMemberRunResult>) {
    const calls: LauncherCall[] = [];
    const launcher: TeamMemberLauncher = async (activation) => {
        const call: LauncherCall = {
            member: activation.member.name,
            prompt: activation.prompt,
            resumed: !!activation.resumeMessages,
        };
        calls.push(call);
        const extra = behavior?.(call) ?? {};
        return {
            success: extra.success ?? true,
            output: extra.output ?? ('done: ' + activation.member.name),
            error: extra.error,
            runId: extra.runId ?? ('run-' + activation.member.name + '-' + calls.length),
            tokenUsage: extra.tokenUsage ?? { total: 10, input: 6, output: 4, estimatedCostCny: 0 },
            needsClarification: extra.needsClarification,
            clarification: extra.clarification,
        };
    };
    return { calls, launcher };
}

describe('TeamRuntime', () => {
    it('activates every member with its brief, then settles quietly', async () => {
        const { calls, launcher } = makeLauncher();
        const runtime = new TeamRuntime({
            teamId: 'team-q1',
            objective: 'test objective',
            domain: 'general',
            members: makeMembers(),
            maxConcurrency: 2,
            launcher,
            quietMs: 30,
        });
        const summary = await runtime.run(new AbortController().signal);
        expect(calls.map(call => call.member).sort()).to.deep.equal(['alpha', 'beta']);
        expect(calls[0]!.prompt).to.contain('test objective');
        expect(calls[0]!.prompt).to.contain('do alpha work');
        expect(calls[0]!.prompt).to.contain('team_send_message');
        expect(summary.settleReason).to.equal('quiet');
        expect(summary.members).to.have.length(2);
        expect(summary.members[0]!.tokenUsage.total).to.equal(10);
    });

    it('steers a message into a running member immediately', async () => {
        let releaseAlpha!: () => void;
        const alphaGate = new Promise<void>(resolve => { releaseAlpha = resolve; });
        const { launcher } = makeLauncher();
        const slowLauncher: TeamMemberLauncher = async (activation) => {
            if (activation.member.name === 'alpha') await alphaGate;
            return { success: true, output: 'ok', runId: 'run-' + activation.member.name, tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 } };
        };
        const steered: Array<{ runId: string; message: string }> = [];
        const runtime = new TeamRuntime({
            teamId: 'team-q2',
            objective: 'obj',
            domain: 'general',
            members: makeMembers(),
            maxConcurrency: 2,
            launcher: slowLauncher,
            steer: (runId, message) => { steered.push({ runId, message }); return true; },
            quietMs: 30,
        });
        // Simulate the host reporting the member's active run id.
        void launcher; // silence unused
        const runPromise = runtime.run(new AbortController().signal);
        // Wait until alpha is running, then mark its run id and message it.
        await new Promise(resolve => setTimeout(resolve, 20));
        runtime.markMemberRunStarted('alpha', 'run-alpha');
        const sent = runtime.sendMessage('beta', 'alpha', 'please also check X');
        expect(sent.success).to.be.true;
        expect(sent.delivery).to.equal('steered');
        expect(steered).to.have.length(1);
        expect(steered[0]!.runId).to.equal('run-alpha');
        expect(steered[0]!.message).to.contain('[Team message from beta in team team-q2]');
        expect(steered[0]!.message).to.contain('please also check X');
        releaseAlpha();
        const summary = await runPromise;
        expect(summary.settleReason).to.equal('quiet');
    });

    it('cold-resumes an idle member with queued messages and its restored transcript', async () => {
        const { calls, launcher } = makeLauncher();
        const runtime = new TeamRuntime({
            teamId: 'team-q3',
            objective: 'obj',
            domain: 'general',
            members: makeMembers(),
            maxConcurrency: 2,
            launcher,
            readResumeTranscript: async () => [
                { role: 'user', content: 'earlier brief' } as never,
                { role: 'assistant', content: 'earlier answer' } as never,
            ],
            quietMs: 300,
        });
        const runPromise = runtime.run(new AbortController().signal);
        // Wait for the initial activations to settle into idle.
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(calls).to.have.length(2);
        const sent = runtime.sendMessage(TEAM_LEAD, 'beta', 'follow-up question');
        expect(sent.success).to.be.true;
        expect(sent.delivery).to.equal('queued_wake');
        const summary = await runPromise;
        expect(summary.settleReason).to.equal('quiet');
        expect(calls).to.have.length(3);
        const wake = calls[2]!;
        expect(wake.member).to.equal('beta');
        expect(wake.resumed).to.be.true;
        expect(wake.prompt).to.contain('follow-up question');
        expect(wake.prompt).to.contain('restored working context');
    });

    it('routes member clarification to the lead and steers the lead when active', async () => {
        const { launcher } = makeLauncher(call => call.member === 'beta'
            ? { success: false, needsClarification: true, clarification: 'which event target?' }
            : {});
        const steered: string[] = [];
        const runtime = new TeamRuntime({
            teamId: 'team-q4',
            objective: 'obj',
            domain: 'general',
            members: makeMembers(),
            maxConcurrency: 2,
            launcher,
            leadRunId: 'lead-run-1',
            steer: runId => { steered.push(runId); return runId === 'lead-run-1'; },
            quietMs: 40,
        });
        const summary = await runtime.run(new AbortController().signal);
        expect(steered).to.include('lead-run-1');
        // The clarification reached the lead mailbox and was delivered by steer.
        expect(summary.undeliveredMessages).to.have.length(0);
    });

    it('requestClose prevents further wakes and reports undelivered messages', async () => {
        const { calls, launcher } = makeLauncher();
        const runtime = new TeamRuntime({
            teamId: 'team-q5',
            objective: 'obj',
            domain: 'general',
            members: makeMembers(),
            maxConcurrency: 2,
            launcher,
            quietMs: 10_000,
        });
        const runPromise = runtime.run(new AbortController().signal);
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(calls).to.have.length(2);
        runtime.requestClose();
        const sent = runtime.sendMessage(TEAM_LEAD, 'beta', 'too late');
        expect(sent.success).to.be.false;
        expect(sent.error).to.contain('closing');
        const summary = await runPromise;
        expect(summary.settleReason).to.equal('closed');
        expect(calls).to.have.length(2);
    });

    it('roster reports member status and unread counts', async () => {
        const { launcher } = makeLauncher();
        const runtime = new TeamRuntime({
            teamId: 'team-q6',
            objective: 'obj',
            domain: 'general',
            members: makeMembers(),
            maxConcurrency: 1,
            launcher,
            quietMs: 30,
        });
        const runPromise = runtime.run(new AbortController().signal);
        const summary = await runPromise;
        expect(summary.settleReason).to.equal('quiet');
        // After settle the roster still reports final state for team_members.
        const roster = runtime.roster();
        expect(roster.map(entry => entry.name).sort()).to.deep.equal(['alpha', 'beta']);
        expect(roster.every(entry => entry.status === 'idle')).to.be.true;
        expect(roster.every(entry => entry.unread === 0)).to.be.true;
    });
});


// ── TeamTaskBoard pipeline driver API (GraphTeamExecutor substrate) ─────────

describe('TeamTaskBoard pipeline driver API', () => {
    const pipeline = (profileName = 'explore') => ({ profileName, prompt: 'do the thing' });

    it('seedPipeline keeps explicit node ids and exposes readiness via blockedBy', () => {
        const board = new TeamTaskBoard('team-p1');
        const error = board.seedPipeline('graph', [
            { id: 'scan', subject: 'scan', pipeline: pipeline() },
            { id: 'build', subject: 'build', blockedBy: ['scan'], pipeline: pipeline('paradox-coder') },
            { id: 'verify', subject: 'verify', blockedBy: ['build'], pipeline: pipeline('reviewer') },
        ]);
        expect(error).to.be.undefined;
        expect(board.size).to.equal(3);
        expect(board.readyPendingTasks().map(task => task.id)).to.deep.equal(['scan']);
        board.forceStatus('scan', 'completed');
        expect(board.readyPendingTasks().map(task => task.id)).to.deep.equal(['build']);
    });

    it('seedPipeline rejects duplicates, unknown blockers and cycles atomically', () => {
        const board = new TeamTaskBoard('team-p2');
        expect(board.seedPipeline('graph', [
            { id: 'a', subject: 'a' },
            { id: 'a', subject: 'dup' },
        ])).to.contain('Duplicate');
        expect(board.size).to.equal(0);

        expect(board.seedPipeline('graph', [
            { id: 'a', subject: 'a', blockedBy: ['ghost'] },
        ])).to.contain('unknown task');
        expect(board.size).to.equal(0);

        expect(board.seedPipeline('graph', [
            { id: 'a', subject: 'a', blockedBy: ['b'] },
            { id: 'b', subject: 'b', blockedBy: ['a'] },
        ])).to.contain('cycle');
        expect(board.size).to.equal(0);
    });

    it('seedPipeline preserves initial statuses for resumed graphs', () => {
        const board = new TeamTaskBoard('team-p3');
        const error = board.seedPipeline('graph', [
            { id: 'done-node', subject: 'd', status: 'completed', pipeline: pipeline() },
            { id: 'failed-node', subject: 'f', status: 'failed', pipeline: pipeline() },
            { id: 'fresh', subject: 'n', pipeline: pipeline() },
        ]);
        expect(error).to.be.undefined;
        expect(board.get('done-node')?.status).to.equal('completed');
        expect(board.get('failed-node')?.status).to.equal('failed');
        expect(board.readyPendingTasks().map(task => task.id)).to.deep.equal(['fresh']);
    });

    it('forceStatus transitions and bumps the CAS revision', () => {
        const board = new TeamTaskBoard('team-p4');
        board.seedPipeline('graph', [{ id: 'a', subject: 'a', pipeline: pipeline() }]);
        const before = board.get('a')!.revision;
        expect(board.forceStatus('a', 'in_progress')).to.be.true;
        expect(board.get('a')!.revision).to.equal(before + 1);
        expect(board.isSettledBoard()).to.be.false;
        board.forceStatus('a', 'completed');
        expect(board.isSettledBoard()).to.be.true;
        expect(board.get('a')!.completedAt).to.be.a('number');
    });

    it('cancelDownstream cascades to pending tasks only, in BFS order', () => {
        const board = new TeamTaskBoard('team-p5');
        board.seedPipeline('graph', [
            { id: 'root', subject: 'root', pipeline: pipeline() },
            { id: 'mid', subject: 'mid', blockedBy: ['root'], pipeline: pipeline() },
            { id: 'leaf', subject: 'leaf', blockedBy: ['mid'], pipeline: pipeline() },
            { id: 'running-branch', subject: 'rb', blockedBy: ['root'], pipeline: pipeline() },
        ]);
        board.forceStatus('root', 'failed');
        board.forceStatus('running-branch', 'in_progress');
        const cancelled = board.cancelDownstream('root');
        expect(cancelled).to.deep.equal(['mid', 'leaf']);
        expect(board.get('mid')?.status).to.equal('cancelled');
        expect(board.get('leaf')?.status).to.equal('cancelled');
        expect(board.get('running-branch')?.status).to.equal('in_progress');
    });

    it('pipeline contracts ride the snapshot untouched', () => {
        const board = new TeamTaskBoard('team-p6');
        board.seedPipeline('graph', [{
            id: 'build',
            subject: 'build',
            pipeline: {
                profileName: 'paradox-coder',
                prompt: 'write events',
                plannedFiles: ['events/x.txt'],
                maxRetries: 2,
                produces: [{ kind: 'event', id: 'evt_1', operation: 'define' }],
            },
        }]);
        const snap = board.snapshot();
        expect(snap[0]!.pipeline?.profileName).to.equal('paradox-coder');
        expect(snap[0]!.pipeline?.plannedFiles).to.deep.equal(['events/x.txt']);
        expect(snap[0]!.pipeline?.produces?.[0]?.id).to.equal('evt_1');
    });
});
