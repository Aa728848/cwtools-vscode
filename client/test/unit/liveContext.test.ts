import { expect } from 'chai';

const vscodeStub = {
    workspace: { textDocuments: [], isTrusted: true, workspaceFolders: [] },
    window: { activeTextEditor: undefined },
    languages: { getDiagnostics: () => [] },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
};

function loadLiveContext() {
    const loader = require('module') as { _load: (...args: any[]) => any };
    const original = loader._load;
    loader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return original.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/runner/liveContext')];
        return require('../../extension/ai/runner/liveContext') as typeof import('../../extension/ai/runner/liveContext');
    } finally {
        loader._load = original;
    }
}

describe('live editor context prefix stability', () => {
    it('is timestamp-free and byte-identical for identical state', () => {
        const { collectLiveVsCodeContext } = loadLiveContext();
        const first = String(collectLiveVsCodeContext().content);
        const second = String(collectLiveVsCodeContext().content);
        expect(first).to.equal(second);
        expect(first).to.not.include('Refreshed:');
    });

    it('replaces stale context at the transcript tail and is idempotent', () => {
        const { LIVE_CONTEXT_MARKER, refreshLiveVsCodeContext } = loadLiveContext();
        const messages: import('../../extension/ai/types').ChatMessage[] = [
            { role: 'system', content: 'stable' },
            { role: 'system', content: `${LIVE_CONTEXT_MARKER}\nstale` },
            { role: 'assistant', content: 'history' },
        ];
        refreshLiveVsCodeContext(messages);
        const once = JSON.stringify(messages);
        expect(messages[0]?.content).to.equal('stable');
        expect(String(messages.at(-1)?.content)).to.include(LIVE_CONTEXT_MARKER);
        expect(messages.at(-1)?.role).to.equal('user');
        refreshLiveVsCodeContext(messages);
        expect(JSON.stringify(messages)).to.equal(once);
        expect(messages.filter(message => String(message.content).includes(LIVE_CONTEXT_MARKER))).to.have.length(1);
    });
});
