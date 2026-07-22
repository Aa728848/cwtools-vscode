import { expect } from 'chai';
import * as path from 'path';

describe('IndexService workspace symbol completeness', () => {
    it('reports partial when discovery exceeds the bounded file limit', async () => {
        const files = ['one.txt', 'two.txt', 'three.txt'].map(name => ({ fsPath: path.join('C:\\workspace', name) }));
        const vscodeStub = {
            workspace: {
                workspaceFolders: [{ uri: { fsPath: 'C:\\workspace' } }],
                findFiles: async (_include: unknown, _exclude: unknown, limit: number) => files.slice(0, limit),
                fs: {
                    stat: async () => ({ size: 0, mtime: 1 }),
                    readFile: async () => new Uint8Array(),
                },
            },
            window: {
                createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
            },
            Uri: { file: (fsPath: string) => ({ fsPath }) },
        };
        const moduleLoader = require('module') as { _load: (...args: any[]) => any };
        const originalLoad = moduleLoader._load;
        const modulePath = require.resolve('../../extension/indexing/indexService');
        const reporterPath = require.resolve('../../extension/ai/errorReporter');
        delete require.cache[modulePath];
        delete require.cache[reporterPath];
        moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
            if (request === 'vscode') return vscodeStub;
            return originalLoad.apply(this, [request, ...args]);
        };

        try {
            const { IndexService } = require('../../extension/indexing/indexService') as typeof import('../../extension/indexing/indexService');
            const originalLimit = (IndexService as any).WORKSPACE_SYMBOL_FILE_LIMIT;
            (IndexService as any).WORKSPACE_SYMBOL_FILE_LIMIT = 2;
            try {
                const service = new IndexService();
                await (service as any)._ensureWorkspaceSymbolPhase(false);
                expect(service.workspaceSymbolStatus).to.equal('partial');
            } finally {
                (IndexService as any).WORKSPACE_SYMBOL_FILE_LIMIT = originalLimit;
            }
        } finally {
            moduleLoader._load = originalLoad;
            delete require.cache[modulePath];
            delete require.cache[reporterPath];
        }
    });
});
