import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatMessage } from '../../extension/ai/types';

describe('ResumeState V2/V3 Message Transcript Normalization Tests', () => {
    it('appends auto-interrupted tool replies for unanswered tool calls', () => {
        const { prepareMessagesForResume } = loadCheckpointModule();
        const messages: ChatMessage[] = [
            { role: 'user', content: 'hello' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{}' }
                    },
                    {
                        id: 'call_2',
                        type: 'function',
                        function: { name: 'write_file', arguments: '{}' }
                    }
                ]
            }
        ];

        const normalized = prepareMessagesForResume(messages);
        
        // Should insert two tool reply messages at the end
        expect(normalized).to.have.lengthOf(4);
        
        const t2 = normalized[2]!;
        const t3 = normalized[3]!;
        
        expect(t2.role).to.equal('tool');
        expect(t2.tool_call_id).to.equal('call_1');
        expect(JSON.parse(t2.content as string).interrupted).to.be.true;

        expect(t3.role).to.equal('tool');
        expect(t3.tool_call_id).to.equal('call_2');
        expect(JSON.parse(t3.content as string).interrupted).to.be.true;
    });

    it('does not touch already answered tool calls', () => {
        const { prepareMessagesForResume } = loadCheckpointModule();
        const messages: ChatMessage[] = [
            { role: 'user', content: 'hello' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{}' }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                name: 'read_file',
                content: '{"ok": true}'
            }
        ];

        const normalized = prepareMessagesForResume(messages);
        expect(normalized).to.have.lengthOf(3); // Unchanged since it was answered
    });

    it('builds a compact resume transcript from summary plus recent tail', () => {
        const { buildResumeMessages } = loadCheckpointModule();
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system prompt' },
            ...Array.from({ length: 40 }, (_, i): ChatMessage => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `message ${i}`,
            })),
        ];

        const compacted = buildResumeMessages(messages, 'summary says previous work is done', 8);
        expect(compacted[0]?.role).to.equal('system');
        expect(compacted[1]?.role).to.equal('user');
        expect(String(compacted[1]?.content)).to.include('[SYSTEM RESUME MEMORY]');
        expect(String(compacted[1]?.content)).to.include('summary says previous work is done');
        expect(compacted.length).to.be.lessThan(messages.length);
        expect(compacted.some(message => message.content === 'message 0')).to.equal(false);
        expect(compacted.some(message => message.content === 'message 39')).to.equal(true);
    });

    it('preserves all leading system instructions in compact resume context', () => {
        const { buildResumeMessages } = loadCheckpointModule();
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system prompt' },
            { role: 'system', content: 'workspace policy' },
            ...Array.from({ length: 20 }, (_, i): ChatMessage => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `message ${i}`,
            })),
        ];

        const compacted = buildResumeMessages(messages, 'durable summary', 6);
        expect(compacted.slice(0, 2).map(message => message.content)).to.deep.equal([
            'system prompt',
            'workspace policy',
        ]);
        expect(String(compacted[2]?.content)).to.include('[SYSTEM RESUME MEMORY]');
    });

    it('retains a legacy system-form compacted summary when loading a long V2 transcript', () => {
        const { buildResumeMessages } = loadCheckpointModule();
        const messages: ChatMessage[] = [
            { role: 'system', content: '## Conversation Summary (compacted)\nLEGACY_DECISION' },
            ...Array.from({ length: 20 }, (_, i): ChatMessage => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `message ${i}`,
            })),
        ];

        const compacted = buildResumeMessages(messages, 'duplicate external summary', 4);
        expect(String(compacted[0]?.content)).to.include('LEGACY_DECISION');
        expect(compacted.some(message => String(message.content).includes('[SYSTEM RESUME MEMORY]'))).to.equal(false);
    });

    it('saves Resume V3 as compacted summary plus tail and archives a checksummed full transcript', async () => {
        const { saveResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-v2-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_resume';
            const runId = 'run_resume';
            const runDir = path.join(tmpRoot, '.cwtools', topicId, 'runs', runId);
            fs.mkdirSync(runDir, { recursive: true });
            fs.writeFileSync(path.join(runDir, 'summary.md'), '# Summary\n\nKeep the important decision.', 'utf-8');

            const messages: ChatMessage[] = [
                { role: 'system', content: 'system prompt' },
                ...Array.from({ length: 36 }, (_, i): ChatMessage => ({
                    role: i % 2 === 0 ? 'user' : 'assistant',
                    content: `long transcript ${i}`,
                })),
            ];

            await saveResumeState(
                topicId,
                'build',
                messages,
                { getTodos: () => [{ content: 'resume task', status: 'pending' }] } as any,
                runId,
                [{ id: 'call_pending' }]
            );

            const resumePath = path.join(tmpRoot, '.cwtools', topicId, 'resume_state.json');
            const saved = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
            expect(saved.version).to.equal(4);
            expect(saved.domain).to.equal('paradox');
            expect(saved.compacted).to.equal(true);
            expect(saved.summaryRef).to.match(/summary\.md$/);
            expect(saved.fullTranscriptRef).to.match(/resume_transcript\.json$/);
            expect(fs.existsSync(saved.fullTranscriptRef)).to.equal(true);
            expect(saved.transcriptSha256).to.match(/^[a-f0-9]{64}$/);
            expect(saved.transcriptMessageCount).to.equal(messages.length);
            expect(saved.messages.length).to.be.lessThan(messages.length);
            expect(JSON.stringify(saved.messages)).to.include('[SYSTEM RESUME MEMORY]');
            expect(saved.pendingToolCalls).to.deep.equal([{ id: 'call_pending' }]);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });

    it('recovers a V3 resume state from the previous complete generation', async () => {
        const { saveResumeState, loadResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-backup-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_backup';
            const toolExecutor = { getTodos: () => [] } as any;
            await saveResumeState(topicId, 'build', [{ role: 'user', content: 'generation one' }], toolExecutor);
            await saveResumeState(topicId, 'build', [{ role: 'user', content: 'generation two' }], toolExecutor);

            const resumePath = path.join(tmpRoot, '.cwtools', topicId, 'resume_state.json');
            expect(fs.existsSync(`${resumePath}.bak`)).to.equal(true);
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

    it('replays a newer incremental model request after the periodic resume snapshot', async () => {
        const { saveResumeState, loadResumeState } = loadCheckpointModule();
        const { runLedger } = require('../../extension/ai/runner/runLedger') as typeof import('../../extension/ai/runner/runLedger');
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-event-replay-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_event_replay';
            const run = await runLedger.createRun(topicId, 'build', 'recover after crash');
            const snapshotMessages: ChatMessage[] = [
                { role: 'system', content: 'policy' },
                { role: 'user', content: 'snapshot task' },
            ];
            await saveResumeState(
                topicId,
                'build',
                snapshotMessages,
                { getTodos: () => [] } as any,
                run.runId,
            );

            const newerMessages: ChatMessage[] = [
                ...snapshotMessages,
                { role: 'assistant', content: 'newer verified progress' },
                { role: 'user', content: 'continue from the latest request' },
            ];
            const requestRef = 'model_requests/model_after_snapshot.json';
            const artifact = await runLedger.writeJsonArtifact(run.runId, requestRef, {
                version: 2,
                kind: 'model_request',
                messageArchive: { format: 'full', messages: newerMessages },
                toolset: { count: 0 },
            });
            await runLedger.appendEvent(run.runId, 'model_call_start', {
                requestRef: artifact?.ref,
                requestSha256: artifact?.sha256,
            });

            const loaded = await loadResumeState(topicId);
            expect(loaded?.recoveredFromEventLog).to.equal(true);
            expect(loaded?.messages.some(message => message.content === 'newer verified progress')).to.equal(true);
            expect(loaded?.messages.some(message => message.content === 'continue from the latest request')).to.equal(true);
            expect((loaded?.lastStableSequence ?? 0)).to.be.greaterThan(1);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });

    it('uses the checksummed transcript backup when the primary transcript is valid JSON but damaged', async () => {
        const { saveResumeState, loadResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-transcript-backup-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_transcript_backup';
            const runId = 'run_transcript_backup';
            const runDir = path.join(tmpRoot, '.cwtools', topicId, 'runs', runId);
            fs.mkdirSync(runDir, { recursive: true });
            const toolExecutor = { getTodos: () => [] } as any;
            await saveResumeState(topicId, 'build', [{ role: 'user', content: 'transcript generation one' }], toolExecutor, runId);
            await saveResumeState(topicId, 'build', [{ role: 'user', content: 'transcript generation two' }], toolExecutor, runId);

            const resumePath = path.join(tmpRoot, '.cwtools', topicId, 'resume_state.json');
            const generationOneState = JSON.parse(fs.readFileSync(`${resumePath}.bak`, 'utf-8'));
            delete generationOneState.messages;
            fs.writeFileSync(resumePath, JSON.stringify(generationOneState), 'utf-8');
            fs.writeFileSync(path.join(runDir, 'resume_transcript.json'), JSON.stringify([
                { role: 'user', content: 'tampered but valid JSON' },
            ]), 'utf-8');

            const loaded = await loadResumeState(topicId);
            expect(loaded?.messages.some(message => message.content === 'transcript generation one')).to.equal(true);
            expect(loaded?.messages.some(message => message.content === 'tampered but valid JSON')).to.equal(false);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });

    it('loads V2 state without restoring its legacy session-only approvals', async () => {
        const { loadResumeState } = loadCheckpointModule();
        const { PermissionPolicyStore } = require('../../extension/ai/runner/permissionPolicy') as typeof import('../../extension/ai/runner/permissionPolicy');
        const store = PermissionPolicyStore.getInstance();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-v2-compat-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            store.clear();
            const topicId = 'topic_v2_compat';
            const resumeDir = path.join(tmpRoot, '.cwtools', topicId);
            fs.mkdirSync(resumeDir, { recursive: true });
            fs.writeFileSync(path.join(resumeDir, 'resume_state.json'), JSON.stringify({
                version: 2,
                timestamp: Date.now(),
                mode: 'build',
                topicId,
                messages: [{ role: 'user', content: 'legacy context' }],
                todos: [],
                permissionRules: [{
                    id: 'legacy_session_rule',
                    tool: 'run_command',
                    cwdScope: tmpRoot,
                    commandPrefix: ['npm'],
                    riskMax: 1,
                    sessionOnly: true,
                    createdAt: Date.now(),
                }],
            }), 'utf-8');

            const loaded = await loadResumeState(topicId);
            expect(loaded?.version).to.equal(4);
            expect(loaded?.domain).to.equal('paradox');
            expect(loaded?.messages[0]?.content).to.equal('legacy context');
            expect(loaded?.domainSnapshot?.version).to.equal(1);
            expect(store.getRules()).to.deep.equal([]);
        } finally {
            store.clear();
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });

    it('persists an explicit General Coding domain for shared read-only modes', async () => {
        const { saveResumeState, loadResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-domain-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_general_plan';
            await saveResumeState(
                topicId,
                'plan',
                [{ role: 'user', content: 'plan a TypeScript refactor' }],
                { getTodos: () => [] } as any,
                undefined,
                undefined,
                'general',
            );

            const loaded = await loadResumeState(topicId);
            expect(loaded?.mode).to.equal('plan');
            expect(loaded?.domain).to.equal('general');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            vscodeStub.workspace.workspaceFolders = [];
        }
    });
});

function loadCheckpointModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/workspacePaths')];
        delete require.cache[require.resolve('../../extension/ai/runner/checkpoint')];
        return require('../../extension/ai/runner/checkpoint') as typeof import('../../extension/ai/runner/checkpoint');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};
