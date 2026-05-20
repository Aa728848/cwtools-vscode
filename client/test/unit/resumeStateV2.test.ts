import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatMessage } from '../../extension/ai/types';

describe('ResumeState V2 Message Transcript Normalization Tests', () => {
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

    it('saves Resume V2 as compacted summary plus tail and archives full transcript', async () => {
        const { saveResumeState } = loadCheckpointModule();
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-resume-v2-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        try {
            const topicId = 'topic_resume';
            const runId = 'run_resume';
            const runDir = path.join(tmpRoot, '.cwtools-ai', topicId, 'runs', runId);
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

            const resumePath = path.join(tmpRoot, '.cwtools-ai', topicId, 'resume_state.json');
            const saved = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
            expect(saved.version).to.equal(2);
            expect(saved.compacted).to.equal(true);
            expect(saved.summaryRef).to.match(/summary\.md$/);
            expect(saved.fullTranscriptRef).to.match(/resume_transcript\.json$/);
            expect(fs.existsSync(saved.fullTranscriptRef)).to.equal(true);
            expect(saved.messages.length).to.be.lessThan(messages.length);
            expect(JSON.stringify(saved.messages)).to.include('[SYSTEM RESUME MEMORY]');
            expect(saved.pendingToolCalls).to.deep.equal([{ id: 'call_pending' }]);
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
};
