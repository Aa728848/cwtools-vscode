import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AgentTranscriptStore,
    boundTranscriptSnapshot,
    createEmptyTranscript,
    filterTranscriptOperations,
    paginateTranscriptTurns,
    TRANSCRIPT_SNAPSHOT_LIMITS,
} from '../../shared/agentTranscript';
import { PromptQueueService, InteractionService } from '../../extension/ai/runner/promptInteraction';
import { RuntimeScope } from '../../extension/ai/runner/runtimeScope';
import { AgentProfileCatalog, ToolActivationService } from '../../extension/ai/runner/agentProfileCatalog';
import {
    buildHandoffRepairPrompt,
    parseAgentHandoff,
    validateAgentHandoff,
} from '../../extension/ai/runner/agentHandoff';
import { PermissionTraceStore } from '../../extension/ai/runner/permissionTrace';
import { DomainJournal } from '../../extension/ai/runner/state/domainJournal';
import type { AppendLogStore } from '../../extension/ai/runner/storageAccess';
import { createDirectoryAgentProfileSource } from '../../extension/ai/runner/agentProfileSources';

describe('agent platform kernel', () => {
    it('converges transcript operations and detects sequence and append gaps', () => {
        const store = new AgentTranscriptStore('agent');
        store.next([
            { op: 'turn.upsert', turn: { turnId: 't1', ordinal: 1, state: 'running' } },
            { op: 'step.upsert', turnId: 't1', step: { stepId: 's1', ordinal: 1, state: 'running' } },
            { op: 'frame.upsert', turnId: 't1', stepId: 's1', frame: { frameId: 'f1', kind: 'text', text: 'abc' } },
        ]);
        const duplicate = store.apply({
            version: 1,
            agentId: 'agent',
            sequence: 1,
            operations: [{ op: 'meta.merge', meta: { ignored: true } }],
        });
        expect(duplicate.accepted).to.deep.equal([]);
        const gap = store.apply({
            version: 1,
            agentId: 'agent',
            sequence: 3,
            operations: [],
        });
        expect(gap.gap?.kind).to.equal('batch_sequence');
        const appendGap = store.next([{
            op: 'append',
            target: { turnId: 't1', stepId: 's1', frameId: 'f1' },
            offset: 10,
            text: 'x',
        }]);
        expect(appendGap.gap?.kind).to.equal('append_offset');
    });

    it('supports transcript grades and turn pagination independently from model context', () => {
        const snapshot = createEmptyTranscript('agent');
        snapshot.turns = Array.from({ length: 5 }, (_, index) => ({
            turnId: `t${index}`,
            ordinal: index,
            state: 'completed' as const,
            steps: [],
        }));
        expect(paginateTranscriptTurns(snapshot, { pageSize: 2 }).turns.map(turn => turn.turnId))
            .to.deep.equal(['t3', 't4']);
        expect(filterTranscriptOperations('turn', [
            { op: 'turn.upsert', turn: { turnId: 'x', ordinal: 1, state: 'running' } },
            { op: 'append', target: { turnId: 'x', stepId: 's', frameId: 'f' }, offset: 0, text: 'x' },
        ])).to.have.length(1);
        expect(filterTranscriptOperations('off', [{ op: 'meta.merge', meta: {} }])).to.deep.equal([]);
        const reset = filterTranscriptOperations('turn', [{ op: 'reset', snapshot: {
            ...snapshot,
            turns: [{
                turnId: 'secret',
                ordinal: 10,
                state: 'completed',
                steps: [{
                    stepId: 'step',
                    ordinal: 0,
                    state: 'completed',
                    frames: [{ frameId: 'frame', kind: 'thinking', text: 'private chain' }],
                }],
            }],
        } }]);
        expect(reset[0]).to.have.nested.property('snapshot.turns[0].steps').that.deep.equals([]);
        const blockReset = filterTranscriptOperations('block', [{ op: 'reset', snapshot: {
            ...snapshot,
            turns: [{
                turnId: 'tool',
                ordinal: 11,
                state: 'completed',
                steps: [{
                    stepId: 'step',
                    ordinal: 0,
                    state: 'completed',
                    frames: [{ frameId: 'frame', kind: 'tool', payload: { raw: 'large result' } }],
                }],
            }],
        } }]);
        expect(blockReset[0]).to.have.nested.property('snapshot.turns[0].steps[0].frames[0].payload', undefined);
    });

    it('removes timeline-anchored entities with their turn', () => {
        const store = new AgentTranscriptStore('agent');
        store.next([
            { op: 'turn.upsert', turn: { turnId: 't1', ordinal: 1, state: 'completed' } },
            {
                op: 'entity.upsert',
                entity: {
                    id: 'interaction',
                    kind: 'interaction',
                    anchorTurnId: 't1',
                    state: 'resolved',
                    value: {},
                    updatedAt: 1,
                },
            },
        ]);
        store.next([{ op: 'turns.remove', turnIds: ['t1'] }]);
        expect(store.snapshot().turns).to.deep.equal([]);
        expect(store.snapshot().entities).to.deep.equal([]);
    });

    it('bounds completed transcript history while preserving active append offsets', () => {
        const snapshot = createEmptyTranscript('agent');
        snapshot.turns = Array.from({ length: TRANSCRIPT_SNAPSHOT_LIMITS.turns + 5 }, (_, index) => ({
            turnId: `old-${index}`,
            ordinal: index,
            state: 'completed' as const,
            prompt: 'p'.repeat(1_000),
            steps: index === TRANSCRIPT_SNAPSHOT_LIMITS.turns + 4 ? Array.from({ length: 300 }, (_, stepIndex) => ({
                stepId: `step-${stepIndex}`,
                ordinal: stepIndex,
                state: 'completed' as const,
                frames: [{
                    frameId: `frame-${stepIndex}`,
                    kind: 'tool' as const,
                    text: 't'.repeat(20_000),
                    payload: { output: 'x'.repeat(40_000) },
                }],
            })) : [],
        }));
        const bounded = boundTranscriptSnapshot(snapshot);
        expect(bounded.turns).to.have.length(TRANSCRIPT_SNAPSHOT_LIMITS.turns);
        expect(bounded.turns.reduce((total, turn) => total + turn.steps.length, 0))
            .to.be.at.most(TRANSCRIPT_SNAPSHOT_LIMITS.stepsTotal);
        expect(bounded.hasMoreOlder).to.equal(true);
        expect(JSON.stringify(bounded).length).to.be.lessThan(3_500_000);

        const active = createEmptyTranscript('active-agent');
        active.turns = [{
            turnId: 'active',
            ordinal: 1,
            state: 'running',
            steps: Array.from({ length: TRANSCRIPT_SNAPSHOT_LIMITS.stepsPerTurn + 1 }, (_, index) => ({
                stepId: `s-${index}`,
                ordinal: index,
                state: 'running' as const,
                frames: [{ frameId: `f-${index}`, kind: 'text' as const, text: index === 0 ? 'abc' : '' }],
            })),
        }];
        const store = new AgentTranscriptStore('active-agent', active);
        const appended = store.next([{
            op: 'append',
            target: { turnId: 'active', stepId: 's-0', frameId: 'f-0' },
            offset: 3,
            text: 'def',
        }]);
        expect(appended.gap).to.equal(undefined);
        expect(store.snapshot().turns[0]?.steps[0]?.frames[0]?.text).to.equal('abcdef');
    });

    it('tracks prompt launch/completion and creates only cold interactions', async () => {
        const prompts = new PromptQueueService();
        const handle = prompts.enqueue({ topicId: 'topic', threadId: 'thread', text: 'do it' });
        prompts.transition(handle.prompt.id, 'running');
        expect((await handle.launched).state).to.equal('running');
        prompts.transition(handle.prompt.id, 'completed');
        expect((await handle.completion).state).to.equal('completed');

        const interactions = new InteractionService();
        expect(interactions.list()).to.have.length(0);
        interactions.request({
            id: 'approval-1',
            topicId: 'topic',
            threadId: 'thread',
            kind: 'approval',
            title: 'Approve command',
        });
        expect(interactions.list({ state: 'pending' })).to.have.length(1);
        interactions.resolve('approval-1', { decision: 'accept' });
        expect(interactions.list({ state: 'resolved' })).to.have.length(1);

        const restoredPrompts = new PromptQueueService();
        restoredPrompts.restore([{ ...handle.prompt, state: 'running' }]);
        expect(restoredPrompts.list()[0]?.state).to.equal('blocked');
        const restoredInteractions = new InteractionService();
        restoredInteractions.restore([{
            id: 'restart-approval',
            topicId: 'topic',
            threadId: 'thread',
            kind: 'approval',
            title: 'Approve command',
            state: 'pending',
            createdAt: 1,
        }]);
        expect(restoredInteractions.list()[0]?.state).to.equal('cancelled');
        expect(restoredInteractions.list()[0]?.resolution).to.deep.equal({ reason: 'extension_restart' });
    });

    it('owns app/session/agent services and disposes children before parents', async () => {
        const disposed: string[] = [];
        const app = new RuntimeScope('app', 'app');
        const session = app.child('session', 'topic');
        const agent = session.child('agent', 'thread');
        agent.set('agent-service', { dispose: () => { disposed.push('agent'); } });
        session.set('session-service', { dispose: () => { disposed.push('session'); } });
        await app.dispose();
        expect(disposed).to.deep.equal(['agent', 'session']);
        expect(app.snapshot().state).to.equal('disposed');
    });

    it('merges explicit profile overrides and separates activation from disclosure', async () => {
        const catalog = new AgentProfileCatalog([{
            name: 'base',
            description: 'base',
            authorizationCeiling: 'read_only',
            tools: ['read_file'],
        }]);
        catalog.registerSource({
            id: 'workspace',
            priority: 100,
            load: async () => [{
                name: 'base',
                description: 'override',
                authorizationCeiling: 'workspace_write',
                tools: ['read_file', 'grep'],
                override: true,
            }],
        });
        await catalog.reload();
        expect(catalog.get('base')?.description).to.equal('override');
        expect(catalog.snapshot().revision).to.be.greaterThan(0);
        expect(catalog.snapshot().sources[0]?.profileCount).to.equal(1);
        const activation = new ToolActivationService().activate(catalog.get('base')!, {
            profileName: 'base',
            domainProfile: 'general',
            authorization: 'workspace_write',
            phase: 'execute',
            dispatch: 'single',
            routeConfidence: 1,
            routeEvidence: [],
            phaseReason: 'test',
            revision: 0,
        }, ['read_file', 'run_command']);
        expect(activation.activated).to.include('read_file');
        expect(activation.disclosed).to.deep.equal(['read_file']);
    });

    it('rejects cross-domain profile overrides and keeps activation inside the admitted domain', async () => {
        const catalog = new AgentProfileCatalog([{
            name: 'general-agent',
            description: 'general',
            domain: 'general',
            authorizationCeiling: 'workspace_write',
            tools: ['*'],
        }]);
        catalog.registerSource({
            id: 'workspace',
            priority: 100,
            load: async () => [{
                name: 'general-agent',
                description: 'attempted cross-domain override',
                domain: 'paradox',
                authorizationCeiling: 'workspace_write',
                tools: ['*'],
                override: true,
            }],
        });
        await catalog.reload();
        expect(catalog.get('general-agent')?.domain).to.equal('general');
        expect(catalog.snapshot().sources[0]?.error).to.include('override cannot change domain');

        const activation = new ToolActivationService().activate(catalog.get('general-agent')!, {
            profileName: 'general-agent',
            domainProfile: 'general',
            authorization: 'workspace_write',
            phase: 'execute',
            dispatch: 'single',
            routeConfidence: 1,
            routeEvidence: [],
            phaseReason: 'test',
            revision: 0,
        });
        expect(activation.activated).to.include('read_file');
        expect(activation.activated).to.not.include('query_cwt_schema');
    });

    it('hot-reloads watched profile sources with a monotonic catalog revision', async () => {
        const catalog = new AgentProfileCatalog([]);
        let notify = () => {};
        let description = 'first';
        catalog.registerSource({
            id: 'watched',
            priority: 1,
            load: async () => [{
                name: 'watched',
                description,
                authorizationCeiling: 'read_only',
            }],
            watch: onChange => {
                notify = onChange;
                return { dispose: () => undefined };
            },
        });
        await catalog.reload();
        const revision = catalog.snapshot().revision;
        catalog.startWatching();
        description = 'second';
        notify();
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(catalog.get('watched')?.description).to.equal('second');
        expect(catalog.snapshot().revision).to.be.greaterThan(revision);
        catalog.dispose();
    });

    it('loads isolated AGENT.md profiles with multiline tool lists', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-agent-profile-'));
        const profileDir = path.join(root, 'custom');
        fs.mkdirSync(profileDir);
        fs.writeFileSync(path.join(profileDir, 'AGENT.md'), [
            '---',
            'name: custom',
            'description: Custom profile',
            'authorization: read_only',
            'tools:',
            '  - read_file',
            '  - grep',
            'summaryMinCharacters: 20',
            'summaryRequiredSections:',
            '  - summary',
            '  - unresolved',
            '---',
            'Profile instructions.',
        ].join('\n'));
        try {
            const profiles = await createDirectoryAgentProfileSource('test', root, 1).load();
            expect(profiles[0]?.tools).to.deep.equal(['read_file', 'grep']);
            expect(profiles[0]?.summaryPolicy?.requiredSections).to.deep.equal(['summary', 'unresolved']);
            expect(profiles[0]?.instructions).to.equal('Profile instructions.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('reports malformed AGENT.md files instead of silently dropping them', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-agent-profile-invalid-'));
        const profileDir = path.join(root, 'broken');
        fs.mkdirSync(profileDir);
        fs.writeFileSync(path.join(profileDir, 'AGENT.md'), 'name: missing-frontmatter\n');
        try {
            let message = '';
            try {
                await createDirectoryAgentProfileSource('test', root, 1).load();
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            expect(message).to.include('Invalid AGENT.md frontmatter');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('normalizes sub-agent handoffs and validates summary policy', () => {
        const handoff = parseAgentHandoff([
            '## Summary',
            'Implemented the requested runtime change with bounded state.',
            '## Changed Files',
            '- client/a.ts',
            '## Verification',
            '- compile passed',
            '## Unresolved',
            '- none',
        ].join('\n'));
        expect(handoff.changedFiles).to.deep.equal(['client/a.ts']);
        expect(validateAgentHandoff(handoff, {
            minCharacters: 10,
            requiredSections: ['summary', 'changedFiles', 'verification', 'unresolved'],
        })).to.deep.equal([]);
        expect(buildHandoffRepairPrompt('short', ['verification'])).to.include('Verification');
    });

    it('keeps permission traces bounded and journals through an access-pattern store', async () => {
        const traces = new PermissionTraceStore();
        for (let index = 0; index < 510; index++) {
            traces.record({
                id: `p${index}`,
                topicId: 'topic',
                threadId: 'thread',
                tool: 'run_command',
                decision: 'requested',
                source: 'policy',
            });
        }
        expect(traces.list()).to.have.length(500);
        const restoredTraces = new PermissionTraceStore();
        restoredTraces.restore(traces.list().slice(-2));
        restoredTraces.restore(traces.list().slice(-2));
        expect(restoredTraces.list()).to.have.length(2);

        let text = '';
        const storage: AppendLogStore = {
            append: async (_file, value) => { text += value; },
            read: () => text || undefined,
            replace: async (_file, value) => { text = value; },
        };
        const journal = new DomainJournal('memory://journal', storage);
        await journal.append({
            type: 'test.replaced',
            version: 1,
            domain: 'context',
            payload: {},
        }, 1, 'op-1', 1);
        expect(journal.read().operations).to.have.length(1);
        await journal.compactThrough(1);
        expect(journal.read(1).operations).to.deep.equal([]);
        await journal.append({
            type: 'test.replaced',
            version: 1,
            domain: 'context',
            payload: {},
        }, 2, 'op-2', 2);
        expect(journal.read(1).operations.map(operation => operation.sequence)).to.deep.equal([2]);
    });
});
