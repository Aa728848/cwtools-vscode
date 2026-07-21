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
            generateProjectKnowledge: async () => {
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
        } finally {
            clock.restore();
            moduleLoader._load = originalLoad;
            delete require.cache[modulePath];
        }
    });
});
