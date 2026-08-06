import { expect } from 'chai';
import sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('/init artifact generation', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-chat-init-'));
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('keeps base artifacts and writes a recoverable manifest when the LSP export never becomes ready', async () => {
        const knowledgeRoot = path.join(workspaceRoot, '.cwtools', 'project', 'knowledge');
        const manifestPath = path.join(knowledgeRoot, 'manifest.json');
        const workspaceIndexPath = path.join(workspaceRoot, '.cwtools', 'index', 'workspace-symbols.sqlite');
        const progressMessages: string[] = [];
        let progressOptions: Record<string, unknown> | undefined;
        let workspaceIndexOptions: Record<string, unknown> | undefined;
        let exportAttempts = 0;
        let exportOptions: Record<string, unknown> | undefined;
        const vscodeStub = {
            workspace: {
                workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
                openTextDocument: async (uri: unknown) => ({ uri }),
            },
            window: {
                showWarningMessage: async () => undefined,
                showInformationMessage: async () => undefined,
                showTextDocument: async () => undefined,
                withProgress: async (options: Record<string, unknown>, task: (progress: { report(value: { message?: string }): void }) => Promise<unknown>) => {
                    progressOptions = options;
                    return task({
                        report(value) {
                            if (value.message) progressMessages.push(value.message);
                        },
                    });
                },
            },
            ProgressLocation: { Window: 10 },
            Uri: {
                file: (filePath: string) => ({ fsPath: filePath }),
            },
        };
        const projectKnowledgeStub = {
            generateProjectKnowledge: async (_root: string, _profile: unknown, options: Record<string, unknown>) => {
                exportAttempts += 1;
                exportOptions = options;
                throw new Error('LSP server has not loaded a game model yet.');
            },
            getProjectKnowledgeManifestPath: () => manifestPath,
            writeUnavailableProjectKnowledge: (_root: string, _profile: unknown, reason: string) => {
                fs.mkdirSync(knowledgeRoot, { recursive: true });
                const manifest = { status: 'unavailable', staleReasons: ['lsp_export_unavailable'], warnings: [reason] };
                fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
                return manifest;
            },
        };
        const moduleLoader = require('module') as { _load: (...args: any[]) => any };
        const originalLoad = moduleLoader._load;
        const modulePath = require.resolve('../../extension/ai/chatInit');
        delete require.cache[modulePath];
        moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
            if (request === 'vscode') return vscodeStub;
            if (request === './projectKnowledge') return projectKnowledgeStub;
            if (request === './errorReporter') return { ErrorReporter: { warn: () => undefined } };
            return originalLoad.apply(this, [request, ...args]);
        };

        const clock = sinon.useFakeTimers();
        try {
            const { generateInitFile } = require('../../extension/ai/chatInit') as typeof import('../../extension/ai/chatInit');
            const pending = generateInitFile(() => undefined, () => undefined, {
                ensureWorkspaceSymbolsReady: async (options: Record<string, unknown>) => {
                    workspaceIndexOptions = options;
                    fs.mkdirSync(path.dirname(workspaceIndexPath), { recursive: true });
                    fs.writeFileSync(workspaceIndexPath, 'sqlite');
                },
                workspaceSymbolTypeSummary: () => ({ byType: { event: ['test_event'] }, byTypeCounts: { event: 1 } }),
            } as any);
            await clock.runAllAsync();
            const result = await pending;

            expect(result.success).to.equal(true);
            expect(result.degraded).to.equal(true);
            expect(fs.existsSync(path.join(workspaceRoot, 'CWTOOLS.md'))).to.equal(true);
            expect(fs.existsSync(path.join(workspaceRoot, '.cwtools', 'project', 'profile.json'))).to.equal(true);
            expect(fs.existsSync(manifestPath)).to.equal(true);
            expect(fs.existsSync(workspaceIndexPath)).to.equal(true);
            expect(workspaceIndexOptions).to.deep.equal({ includeVanilla: false });
            expect(progressOptions?.location).to.equal(10);
            expect(progressMessages.some(message => message.includes('Scanning workspace'))).to.equal(true);
            expect(progressMessages.some(message => message.includes('persistent workspace symbol index'))).to.equal(true);
            expect(progressMessages.some(message => message.includes('Exporting project + vanilla knowledge'))).to.equal(true);
            expect(progressMessages.some(message => message.includes('Publishing the knowledge database'))).to.equal(true);
            expect(exportAttempts).to.equal(3);
            expect(exportOptions).to.deep.equal({ mode: 'full', complete: true, requireReady: true });
        } finally {
            clock.restore();
            moduleLoader._load = originalLoad;
            delete require.cache[modulePath];
        }
    });

    it('publishes a partial export without repeating the same full scan', async () => {
        const manifestPath = path.join(workspaceRoot, '.cwtools', 'project', 'knowledge', 'manifest.json');
        const warnings: string[] = [];
        let attempts = 0;
        const vscodeStub = {
            workspace: {
                workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
                openTextDocument: async (uri: unknown) => ({ uri }),
            },
            window: {
                showWarningMessage: async (message: string) => { warnings.push(message); },
                showInformationMessage: async () => undefined,
                showTextDocument: async () => undefined,
                withProgress: async (_options: unknown, task: (progress: { report(): void }) => Promise<unknown>) => task({ report: () => undefined }),
            },
            ProgressLocation: { Window: 10 },
            Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
        };
        const partialManifest = {
            status: 'partial' as const,
            game: 'stellaris',
            counts: { vanillaDefinitions: 1 },
        };
        const projectKnowledgeStub = {
            generateProjectKnowledge: async () => {
                attempts += 1;
                return partialManifest;
            },
            getProjectKnowledgeManifestPath: () => manifestPath,
            writeUnavailableProjectKnowledge: () => { throw new Error('partial data must not be overwritten as unavailable'); },
        };
        const moduleLoader = require('module') as { _load: (...args: any[]) => any };
        const originalLoad = moduleLoader._load;
        const modulePath = require.resolve('../../extension/ai/chatInit');
        delete require.cache[modulePath];
        moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
            if (request === 'vscode') return vscodeStub;
            if (request === './projectKnowledge') return projectKnowledgeStub;
            if (request === './errorReporter') return { ErrorReporter: { warn: () => undefined } };
            return originalLoad.apply(this, [request, ...args]);
        };

        const clock = sinon.useFakeTimers();
        try {
            const { generateInitFile } = require('../../extension/ai/chatInit') as typeof import('../../extension/ai/chatInit');
            const pending = generateInitFile(() => undefined, () => undefined);
            await clock.runAllAsync();
            const result = await pending;

            expect(attempts).to.equal(1);
            expect(result.success).to.equal(true);
            expect(result.degraded).to.equal(true);
            expect(result.message).to.include('partial coverage');
            expect(warnings).to.have.length(1);
            expect(warnings[0]).to.include('generated a partial project + vanilla knowledge pack');
        } finally {
            clock.restore();
            moduleLoader._load = originalLoad;
            delete require.cache[modulePath];
        }
    });
});
