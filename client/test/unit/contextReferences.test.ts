import { expect } from 'chai';

describe('context references: quote contexts', () => {
    it('injects quoted chat text into the reference prompt without touching the filesystem', async () => {
        const { ContextReferenceManager } = loadContextReferencesModule();
        const manager = new ContextReferenceManager(() => undefined);
        const prompt = await manager.buildReferencePrompt([
            { id: 'ctx_1', type: 'quote', label: 'quote', text: 'selected assistant answer' } as any,
        ]);
        expect(prompt).to.include('<referenced-context>');
        expect(prompt).to.include('selected assistant answer');
    });

    it('skips quote contexts with empty text', async () => {
        const { ContextReferenceManager } = loadContextReferencesModule();
        const manager = new ContextReferenceManager(() => undefined);
        const prompt = await manager.buildReferencePrompt([
            { id: 'ctx_2', type: 'quote', label: 'quote', text: '   ' } as any,
        ]);
        expect(prompt).to.equal('');
    });

    it('clips over-long quoted text', async () => {
        const { ContextReferenceManager } = loadContextReferencesModule();
        const manager = new ContextReferenceManager(() => undefined);
        const prompt = await manager.buildReferencePrompt([
            { id: 'ctx_3', type: 'quote', label: 'quote', text: 'x'.repeat(9000) } as any,
        ]);
        expect(prompt).to.include('(truncated)');
        expect(prompt.length).to.be.lessThan(9000);
    });
});

function loadContextReferencesModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/contextReferences') as typeof import('../../extension/ai/contextReferences');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
    },
};
