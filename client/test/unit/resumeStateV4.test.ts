import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { schedulingStateFromAdmission } from '../../extension/ai/runner/scheduling';
import type { ChatMessage } from '../../extension/ai/types';
import { createVscodeRunnerStub, loadModuleWithVscodeStub, createTempRunnerWorkspace } from './runnerTestFixtures';

const PARADOX_WRITE = schedulingStateFromAdmission({
    domainProfile: 'paradox', authorization: 'workspace_write', initialPhase: 'execute',
    explicitDelegation: false, confidence: 1, evidence: ['test'],
});
const GENERAL_PLAN = schedulingStateFromAdmission({
    domainProfile: 'general', authorization: 'plan_write_only', initialPhase: 'plan',
    explicitDelegation: false, confidence: 1, evidence: ['test'],
});

const vscodeStub = createVscodeRunnerStub();

function loadCheckpointModule() {
    return loadModuleWithVscodeStub<typeof import('../../extension/ai/runner/checkpoint')>(
        '../../extension/ai/runner/checkpoint',
        vscodeStub,
        { freshPaths: ['../../extension/ai/workspacePaths', '../../extension/ai/runner/checkpoint'] },
    );
}

describe('ResumeState V4', () => {
    it('appends interrupted replies only for unanswered tool calls', () => {
        const { prepareMessagesForResume } = loadCheckpointModule();
        const messages: ChatMessage[] = [
            { role: 'user', content: 'hello' },
            {
                role: 'assistant', content: null, tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                    { id: 'call_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: '{"ok":true}' },
        ];
        const normalized = prepareMessagesForResume(messages);
        expect(normalized).to.have.lengthOf(4);
        expect(normalized[3]?.tool_call_id).to.equal('call_2');
        expect(JSON.parse(normalized[3]?.content as string).interrupted).to.equal(true);
    });

    it('does not duplicate existing tool results when preparing resume messages', () => {
        const { prepareMessagesForResume } = loadCheckpointModule();
        const messages = [
            {
                role: 'assistant' as const,
                content: '',
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function' as const,
                        function: { name: 'grep', arguments: '{"query":"foo"}' },
                    },
                ],
            },
            {
                role: 'tool' as const,
                content: '{"success":true}',
                tool_call_id: 'call_1',
                name: 'grep',
            },
        ];

        const prepared = prepareMessagesForResume(messages);
        expect(prepared).to.have.length(2);
        expect(prepared.filter(message => message.role === 'tool')).to.have.length(1);
    });

    it('builds a compact resume transcript from summary plus recent tail', () => {
        const { buildResumeMessages } = loadCheckpointModule();
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system prompt' },
            { role: 'system', content: 'workspace policy' },
            ...Array.from({ length: 30 }, (_, index): ChatMessage => ({
                role: index % 2 === 0 ? 'user' : 'assistant', content: `message ${index}`,
            })),
        ];
        const compacted = buildResumeMessages(messages, 'durable summary', 6);
        expect(compacted.slice(0, 2).map(message => message.content)).to.deep.equal(['system prompt', 'workspace policy']);
        expect(String(compacted[2]?.content)).to.include('[SYSTEM RESUME MEMORY]');
        expect(compacted.some(message => message.content === 'message 29')).to.equal(true);
        expect(compacted.some(message => message.content === 'message 0')).to.equal(false);
    });

    it('persists only V4 scheduling state and converts pending calls into retry requests', async () => {
        const { saveResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-v4-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_resume';
            const runId = 'run_resume';
            const runDir = path.join(tmpRoot, '.cwtools', topicId, 'runs', runId);
            fs.mkdirSync(runDir, { recursive: true });
            fs.writeFileSync(path.join(runDir, 'summary.md'), '# Summary\n\nKeep the decision.', 'utf-8');
            const messages: ChatMessage[] = [
                { role: 'system', content: 'system prompt' },
                ...Array.from({ length: 36 }, (_, index): ChatMessage => ({
                    role: index % 2 === 0 ? 'user' : 'assistant', content: `long transcript ${index}`,
                })),
            ];

            await saveResumeState(
                topicId,
                PARADOX_WRITE,
                messages,
                { getTodos: () => [{ content: 'resume task', status: 'pending' }] } as any,
                runId,
                [{ id: 'call_pending', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
            );

            const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.cwtools', topicId, 'resume_state.json'), 'utf-8'));
            expect(saved.version).to.equal(4);
            expect(saved.schedulingState).to.include({ domainProfile: 'paradox', authorization: 'workspace_write' });
            expect(saved).not.to.have.property('mode');
            expect(saved).not.to.have.property('domain');
            expect(saved).not.to.have.property('pendingToolCalls');
            expect(saved.pendingStepRequests?.[0]?.kind).to.equal('retry');
            expect(saved.fullTranscriptRef).to.match(/resume_transcript\.json$/);
            expect(saved.transcriptSha256).to.match(/^[a-f0-9]{64}$/);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });

    it('recovers the previous complete V4 generation from the atomic backup', async () => {
        const { saveResumeState, loadResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-backup-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_backup';
            const toolExecutor = { getTodos: () => [] } as any;
            await saveResumeState(topicId, PARADOX_WRITE, [{ role: 'user', content: 'generation one' }], toolExecutor);
            await saveResumeState(topicId, PARADOX_WRITE, [{ role: 'user', content: 'generation two' }], toolExecutor);
            const resumePath = path.join(tmpRoot, '.cwtools', topicId, 'resume_state.json');
            fs.writeFileSync(resumePath, '{broken json', 'utf-8');

            const loaded = await loadResumeState(topicId);
            expect(loaded?.recoveredFromBackup).to.equal(true);
            expect(loaded?.version).to.equal(4);
            expect(loaded?.messages.some(message => message.content === 'generation one')).to.equal(true);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });

    it('replays a newer model request after the periodic resume snapshot', async () => {
        const { saveResumeState, loadResumeState } = loadCheckpointModule();
        const { runLedger } = require('../../extension/ai/runner/runLedger') as typeof import('../../extension/ai/runner/runLedger');
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-event-replay-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_event_replay';
            const run = await runLedger.createRun(topicId, PARADOX_WRITE, 'recover after crash');
            const snapshotMessages: ChatMessage[] = [
                { role: 'system', content: 'policy' },
                { role: 'user', content: 'snapshot task' },
            ];
            await saveResumeState(topicId, PARADOX_WRITE, snapshotMessages, { getTodos: () => [] } as any, run.runId);
            const newerMessages: ChatMessage[] = [
                ...snapshotMessages,
                { role: 'assistant', content: 'newer verified progress' },
                { role: 'user', content: 'continue from the latest request' },
            ];
            const artifact = await runLedger.writeJsonArtifact(run.runId, 'model_requests/model_after_snapshot.json', {
                version: 2,
                kind: 'model_request',
                messageArchive: { format: 'full', messages: newerMessages },
                toolset: { count: 0 },
            });
            await runLedger.appendEvent(run.runId, 'model_call_start', {
                requestRef: artifact?.ref, requestSha256: artifact?.sha256,
            });

            const loaded = await loadResumeState(topicId);
            expect(loaded?.recoveredFromEventLog).to.equal(true);
            expect(loaded?.messages.some(message => message.content === 'newer verified progress')).to.equal(true);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });

    it('rejects V2, V3, and unversioned resume records', async () => {
        const { loadResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-old-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            for (const version of [2, 3, undefined]) {
                const topicId = `topic_old_${version ?? 'none'}`;
                const resumeDir = path.join(tmpRoot, '.cwtools', topicId);
                fs.mkdirSync(resumeDir, { recursive: true });
                fs.writeFileSync(path.join(resumeDir, 'resume_state.json'), JSON.stringify({
                    ...(version === undefined ? {} : { version }),
                    timestamp: Date.now(), mode: 'build', domain: 'paradox', topicId,
                    messages: [{ role: 'user', content: 'old context' }], todos: [],
                }), 'utf-8');
                expect(await loadResumeState(topicId)).to.equal(null);
            }
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });

    it('round-trips an explicit General planning scheduler without parallel domain fields', async () => {
        const { saveResumeState, loadResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-domain-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_general_plan';
            await saveResumeState(topicId, GENERAL_PLAN, [{ role: 'user', content: 'plan a TypeScript refactor' }], { getTodos: () => [] } as any);
            const loaded = await loadResumeState(topicId);
            expect(loaded?.schedulingState).to.include({ domainProfile: 'general', phase: 'plan' });
            expect(loaded).not.to.have.property('mode');
            expect(loaded).not.to.have.property('domain');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });
});
