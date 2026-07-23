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

    it('coalesces concurrent forced refreshes for the same vanilla game', async () => {
        const vscodeStub = {
            workspace: {
                createFileSystemWatcher: () => ({
                    onDidChange: () => undefined,
                    onDidCreate: () => undefined,
                    onDidDelete: () => undefined,
                    dispose: () => undefined,
                }),
            },
            window: {
                createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
            },
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
            const service = new IndexService();
            let buildCount = 0;
            let workspacePhaseCount = 0;
            let releaseBuild: (() => void) | undefined;
            let markBuildStarted: (() => void) | undefined;
            let markSecondWorkspacePhase: (() => void) | undefined;
            const buildStarted = new Promise<void>(resolve => { markBuildStarted = resolve; });
            const secondWorkspacePhase = new Promise<void>(resolve => { markSecondWorkspacePhase = resolve; });
            const buildGate = new Promise<void>(resolve => { releaseBuild = resolve; });
            (service as any)._refreshSemanticCatalog = async () => false;
            (service as any)._ensureWorkspaceSymbolPhase = async () => {
                workspacePhaseCount += 1;
                if (workspacePhaseCount === 2) markSecondWorkspacePhase?.();
            };
            (service as any)._indexVanillaWorkspaceSymbolFiles = async () => {
                buildCount += 1;
                markBuildStarted?.();
                await buildGate;
            };

            const first = service.refreshVanillaSymbols(['stellaris']);
            await buildStarted;
            const second = service.refreshVanillaSymbols(['stellaris']);
            await secondWorkspacePhase;
            await Promise.resolve();
            releaseBuild?.();
            await Promise.all([first, second]);

            expect(buildCount).to.equal(1);
        } finally {
            moduleLoader._load = originalLoad;
            delete require.cache[modulePath];
            delete require.cache[reporterPath];
        }
    });
});
