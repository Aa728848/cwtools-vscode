import { expect } from 'chai';

describe('Agent resume state', () => {
    it('fills interrupted tool calls with synthetic tool results', () => {
        const { prepareMessagesForResume } = loadCheckpointModule();
        const messages = [
            { role: 'system' as const, content: 'system' },
            {
                role: 'assistant' as const,
                content: '',
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function' as const,
                        function: { name: 'read_file', arguments: '{"file":"a.txt"}' },
                    },
                ],
            },
        ];

        const prepared = prepareMessagesForResume(messages);

        expect(prepared).to.have.length(3);
        expect(prepared[2]?.role).to.equal('tool');
        expect(prepared[2]?.tool_call_id).to.equal('call_1');
        expect(prepared[2]?.name).to.equal('read_file');
        expect(String(prepared[2]?.content)).to.include('interrupted');
        expect(messages).to.have.length(2);
    });

    it('does not duplicate existing tool results', () => {
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
});

function loadCheckpointModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/checkpoint') as typeof import('../../extension/ai/runner/checkpoint');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
    },
};
