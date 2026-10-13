import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Detection contract for the background auto-/init trigger: a root needs
 * initialization when the manifest is missing, knowledge.sqlite is missing, or
 * the schema version no longer matches the current extension.
 */
describe('auto /init knowledge readiness detection', () => {
    let workspaceRoot: string;
    let knowledgeRoot: string;
    let moduleLoader: { _load: (...args: any[]) => any };
    let originalLoad: (...args: any[]) => any;
    let isProjectKnowledgeDatabaseReady: (root: string) => boolean;

    const writeManifest = (manifest: Record<string, unknown>) => {
        fs.mkdirSync(knowledgeRoot, { recursive: true });
        fs.writeFileSync(path.join(knowledgeRoot, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    };
    const writeDatabase = () => {
        fs.mkdirSync(knowledgeRoot, { recursive: true });
        fs.writeFileSync(path.join(knowledgeRoot, 'knowledge.sqlite'), 'sqlite');
    };

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-auto-init-'));
        knowledgeRoot = path.join(workspaceRoot, '.cwtools', 'project', 'knowledge');
        const vscodeStub = {
            workspace: {
                workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
                openTextDocument: async (uri: unknown) => ({ uri }),
            },
            window: {
                showWarningMessage: async () => undefined,
                showInformationMessage: async () => undefined,
                showTextDocument: async () => undefined,
            },
            ProgressLocation: { Window: 10 },
            Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
        };
        // fs-backed stand-ins mirroring the real projectKnowledge path helpers.
        const projectKnowledgeStub = {
            PROJECT_KNOWLEDGE_SCHEMA_VERSION: 7,
            getProjectKnowledgeManifestPath: (root: string) => path.join(root, '.cwtools', 'project', 'knowledge', 'manifest.json'),
            getProjectKnowledgeDatabasePath: (root: string) => path.join(root, '.cwtools', 'project', 'knowledge', 'knowledge.sqlite'),
            readProjectKnowledgeManifest: (root: string) => {
                try {
                    return JSON.parse(fs.readFileSync(path.join(root, '.cwtools', 'project', 'knowledge', 'manifest.json'), 'utf8'));
                } catch {
                    return undefined;
                }
            },
        };
        moduleLoader = require('module') as { _load: (...args: any[]) => any };
        originalLoad = moduleLoader._load;
        const modulePath = require.resolve('../../extension/ai/chatInit');
        delete require.cache[modulePath];
        moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
            if (request === 'vscode') return vscodeStub;
            if (request === './projectKnowledge') return projectKnowledgeStub;
            if (request === './errorReporter') return { ErrorReporter: { debug: () => undefined, warn: () => undefined } };
            return originalLoad.apply(this, [request, ...args]);
        };
        isProjectKnowledgeDatabaseReady = (require('../../extension/ai/chatInit') as typeof import('../../extension/ai/chatInit'))
            .isProjectKnowledgeDatabaseReady;
    });

    afterEach(() => {
        moduleLoader._load = originalLoad;
        delete require.cache[require.resolve('../../extension/ai/chatInit')];
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('reports not ready when the manifest is missing', () => {
        expect(isProjectKnowledgeDatabaseReady(workspaceRoot)).to.equal(false);
    });

    it('reports not ready when knowledge.sqlite is missing', () => {
        writeManifest({ schemaVersion: 7, database: { path: 'knowledge.sqlite', format: 'sqlite', schemaVersion: 7 } });
        expect(isProjectKnowledgeDatabaseReady(workspaceRoot)).to.equal(false);
    });

    it('reports not ready when the manifest schema is obsolete', () => {
        writeManifest({ schemaVersion: 6, database: { path: 'knowledge.sqlite', format: 'sqlite', schemaVersion: 6 } });
        writeDatabase();
        expect(isProjectKnowledgeDatabaseReady(workspaceRoot)).to.equal(false);
    });

    it('reports not ready when only the database schema is obsolete', () => {
        writeManifest({ schemaVersion: 7, database: { path: 'knowledge.sqlite', format: 'sqlite', schemaVersion: 6 } });
        writeDatabase();
        expect(isProjectKnowledgeDatabaseReady(workspaceRoot)).to.equal(false);
    });

    it('reports ready when manifest and database both match the current schema', () => {
        writeManifest({ schemaVersion: 7, database: { path: 'knowledge.sqlite', format: 'sqlite', schemaVersion: 7 } });
        writeDatabase();
        expect(isProjectKnowledgeDatabaseReady(workspaceRoot)).to.equal(true);
    });
});
