import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';

let nextSnapshot: Record<string, unknown>;
let commandCalls: Array<{ command: string; args: unknown[] }> = [];
let activeWorkspaceRoot = '';
let exportGate: Promise<void> | undefined;
let validationStatus: Record<string, unknown> = {
    ok: true,
    inProgress: false,
    pendingGlobalKinds: [],
    modelReadyForKnowledgeExport: true,
    loading: { inProgress: false },
};
let progressCalls: Array<{
    options: Record<string, unknown>;
    reports: Array<{ message?: string }>;
}> = [];
let activeProgressCount = 0;
const watcherStubs: Array<{
    change?: (uri: { fsPath: string }) => void;
    create?: (uri: { fsPath: string }) => void;
    delete?: (uri: { fsPath: string }) => void;
    dispose: () => void;
}> = [];
interface TextDocumentStub {
    uri: { fsPath: string; scheme: string };
    getText(): string;
}
let _openDocumentListener: ((document: TextDocumentStub) => void) | undefined;
let saveDocumentListener: ((document: TextDocumentStub) => void) | undefined;
let _closeDocumentListener: ((document: TextDocumentStub) => void) | undefined;

class DisposableStub {
    constructor(private readonly callback: () => void) {}
    dispose(): void { this.callback(); }
}

class RelativePatternStub {
    constructor(public readonly base: unknown, public readonly pattern: string) {}
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        textDocuments: [] as TextDocumentStub[],
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
        getWorkspaceFolder: (uri: { fsPath: string }) => vscodeStub.workspace.workspaceFolders.find(folder => {
            const relative = path.relative(folder.uri.fsPath, uri.fsPath);
            return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        }) ?? (activeWorkspaceRoot ? { uri: { fsPath: activeWorkspaceRoot } } : undefined),
        createFileSystemWatcher: () => {
            const watcher = {
                change: undefined as ((uri: { fsPath: string }) => void) | undefined,
                create: undefined as ((uri: { fsPath: string }) => void) | undefined,
                delete: undefined as ((uri: { fsPath: string }) => void) | undefined,
                onDidChange(callback: (uri: { fsPath: string }) => void) { this.change = callback; },
                onDidCreate(callback: (uri: { fsPath: string }) => void) { this.create = callback; },
                onDidDelete(callback: (uri: { fsPath: string }) => void) { this.delete = callback; },
                dispose: () => undefined,
            };
            watcherStubs.push(watcher);
            return watcher;
        },
        onDidChangeConfiguration: () => ({ dispose: () => undefined }),
        onDidOpenTextDocument: (listener: (document: TextDocumentStub) => void) => {
            _openDocumentListener = listener;
            return { dispose: () => { _openDocumentListener = undefined; } };
        },
        onDidSaveTextDocument: (listener: (document: TextDocumentStub) => void) => {
            saveDocumentListener = listener;
            return { dispose: () => { saveDocumentListener = undefined; } };
        },
        onDidCloseTextDocument: (listener: (document: TextDocumentStub) => void) => {
            _closeDocumentListener = listener;
            return { dispose: () => { _closeDocumentListener = undefined; } };
        },
    },
    commands: {
        executeCommand: async (command: string, ...args: unknown[]) => {
            commandCalls.push({ command, args });
            if (command === 'cwtools.ai.getValidationStatus') {
                return validationStatus;
            }
            if (command === 'cwtools.ai.exportProjectKnowledge' && exportGate) {
                await exportGate;
            }
            if (command === 'cwtools.ai.exportProjectKnowledge' && nextSnapshot?.ok === true) {
                const options = args[0] as { databasePath?: string };
                if (options.databasePath) {
                    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
                    fs.writeFileSync(options.databasePath, 'sqlite-v2');
                }
            }
            return nextSnapshot;
        },
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
        withProgress: async (
            options: Record<string, unknown>,
            task: (progress: { report(value: { message?: string }): void }) => Promise<unknown>,
        ) => {
            const call = { options, reports: [] as Array<{ message?: string }> };
            progressCalls.push(call);
            activeProgressCount++;
            try {
                return await task({ report: value => call.reports.push(value) });
            } finally {
                activeProgressCount--;
            }
        },
        setStatusBarMessage: () => ({ dispose: () => undefined }),
        onDidChangeWindowState: () => ({ dispose: () => undefined }),
    },
    ProgressLocation: { Window: 10 },
    Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
    RelativePattern: RelativePatternStub,
    Disposable: DisposableStub,
};

function loadProjectKnowledge() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    const modulePath = require.resolve('../../extension/ai/projectKnowledge');
    const workspacePathsModulePath = require.resolve('../../extension/ai/workspacePaths');
    delete require.cache[modulePath];
    delete require.cache[workspacePathsModulePath];
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/projectKnowledge') as typeof import('../../extension/ai/projectKnowledge');
    } finally {
        moduleLoader._load = originalLoad;
        delete require.cache[workspacePathsModulePath];
    }
}

describe('project knowledge SQLite V3', () => {
    const projectKnowledge = loadProjectKnowledge();
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-project-knowledge-'));
        activeWorkspaceRoot = workspaceRoot;
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
        vscodeStub.workspace.textDocuments = [];
        watcherStubs.length = 0;
        _openDocumentListener = undefined;
        saveDocumentListener = undefined;
        _closeDocumentListener = undefined;
        commandCalls = [];
        exportGate = undefined;
        validationStatus = {
            ok: true,
            inProgress: false,
            pendingGlobalKinds: [],
            modelReadyForKnowledgeExport: true,
            loading: { inProgress: false },
        };
        progressCalls = [];
        activeProgressCount = 0;
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('publishes only manifest + SQLite and cleans V1 artifacts after a successful export', async () => {
        const root = path.join(workspaceRoot, '.cwtools', 'project', 'knowledge');
        fs.mkdirSync(path.join(root, 'capabilities'), { recursive: true });
        fs.mkdirSync(path.join(root, 'archetypes'), { recursive: true });
        for (const legacy of ['snapshot.json', 'topology.json', 'definition-stacks.json', 'override-map.json', 'unresolved.json']) {
            fs.writeFileSync(path.join(root, legacy), '{}');
        }
        fs.writeFileSync(path.join(root, 'capabilities', 'events.json'), '{}');
        fs.writeFileSync(path.join(root, 'archetypes', 'events.json'), '{}');
        nextSnapshot = {
            ok: true,
            status: 'ready',
            schemaVersion: 3,
            game: 'stellaris',
            graphVersion: 1,
            completeExport: true,
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'events' }, { id: 'on_actions' }],
            counts: {
                definitions: 12,
                workspaceDefinitions: 4,
                vanillaDefinitions: 8,
                definitionStacks: 2,
                topologyFiles: 3,
                topologyEdges: 5,
                eventNodes: 6,
                eventEdges: 7,
                eventLogic: 9,
            },
            warnings: [],
        };
        const profile = { game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        const manifest = await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile, {
            mode: 'incremental',
            domains: ['events'],
            changedFiles: [path.join(workspaceRoot, 'events', 'changed.txt')],
            complete: true,
        });

        expect(manifest.schemaVersion).to.equal(3);
        expect(manifest.artifacts).to.deep.equal(['knowledge.sqlite']);
        expect(manifest.counts.eventLogic).to.equal(9);
        expect(manifest.completeExport).to.equal(true);
        expect(fs.existsSync(path.join(root, 'manifest.json'))).to.equal(true);
        expect(fs.existsSync(path.join(root, 'knowledge.sqlite'))).to.equal(true);
        expect(fs.existsSync(path.join(root, 'capabilities'))).to.equal(false);
        expect(fs.existsSync(path.join(root, 'archetypes'))).to.equal(false);
        for (const legacy of ['snapshot.json', 'topology.json', 'definition-stacks.json', 'override-map.json', 'unresolved.json']) {
            expect(fs.existsSync(path.join(root, legacy))).to.equal(false);
        }
        expect(commandCalls).to.have.length(1);
        expect(commandCalls[0]!.command).to.equal('cwtools.ai.exportProjectKnowledge');
        expect(commandCalls[0]!.args).to.deep.equal([{
            domains: ['events'],
            changedFiles: [path.join(workspaceRoot, 'events', 'changed.txt')],
            maxDefinitions: 100000,
            maxTopologyFiles: 1200,
            maxEdges: 8000,
            archetypesPerDomain: 8,
            completeExport: true,
            requireReady: false,
            databasePath: path.join(root, 'knowledge.sqlite'),
            generationMode: 'incremental',
        }]);
    });

    it('rejects a manifest database path outside the knowledge directory', async () => {
        const profile = { game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [],
            counts: { definitions: 0, workspaceDefinitions: 0, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 0, topologyEdges: 0 },
            warnings: [],
        };
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        const manifestPath = projectKnowledge.getProjectKnowledgeManifestPath(workspaceRoot);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.database.path = '../../outside.sqlite';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'outside.sqlite'), 'sqlite', 'utf8');
        commandCalls = [];

        const result = await projectKnowledge.queryProjectKnowledge(workspaceRoot);

        expect(result.status).to.equal('error');
        expect(result.staleReasons).to.include('invalid_database_path');
        expect(commandCalls).to.deep.equal([]);
    });

    it('moves a legacy knowledge pack to .cwtools and keeps subsequent writes there', async () => {
        const legacyRoot = path.join(workspaceRoot, '.cwtools-ai', 'project', 'knowledge');
        const primaryRoot = path.join(workspaceRoot, '.cwtools', 'project', 'knowledge');
        fs.mkdirSync(legacyRoot, { recursive: true });
        fs.writeFileSync(path.join(legacyRoot, 'manifest.json'), JSON.stringify({
            schemaVersion: 2,
            status: 'ready',
            staleReasons: [],
        }), 'utf8');
        fs.writeFileSync(path.join(legacyRoot, 'knowledge.sqlite'), 'legacy-sqlite', 'utf8');
        nextSnapshot = {
            ok: true,
            status: 'ready',
            schemaVersion: 3,
            game: 'stellaris',
            graphVersion: 1,
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'events' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };

        await projectKnowledge.generateProjectKnowledge(
            workspaceRoot,
            { game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile,
        );

        expect(fs.readFileSync(path.join(primaryRoot, 'knowledge.sqlite'), 'utf8')).to.equal('sqlite-v2');
        expect(fs.existsSync(path.join(primaryRoot, 'manifest.json'))).to.equal(true);
        expect(fs.existsSync(legacyRoot)).to.equal(false);
        expect((commandCalls[0]!.args[0] as { databasePath: string }).databasePath)
            .to.equal(path.join(primaryRoot, 'knowledge.sqlite'));
    });

    it('writes only a lightweight manifest when the LSP export is unavailable', () => {
        const profile = { game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        const manifest = projectKnowledge.writeUnavailableProjectKnowledge(
            workspaceRoot,
            profile,
            'LSP server has not loaded a game model yet.',
        );
        const root = path.join(workspaceRoot, '.cwtools', 'project', 'knowledge');

        expect(manifest.status).to.equal('unavailable');
        expect(manifest.staleReasons).to.include('lsp_export_unavailable');
        expect(fs.existsSync(path.join(root, 'manifest.json'))).to.equal(true);
        expect(manifest.artifacts).to.deep.equal([]);
        expect(fs.readdirSync(root).sort()).to.deep.equal(['manifest.json']);
    });

    it('queries event structure and logic through the SQLite LSP command', async () => {
        const profile = { game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            graphVersion: 3,
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'events' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 1 },
            warnings: [],
        };
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        nextSnapshot = {
            ok: true,
            status: 'ready',
            domains: ['events'],
            retrieval: {
                strategy: 'indexed_graph',
                seedIdentifiers: ['example.1'],
                seedDefinitions: 1,
                evidenceReturned: 1,
                eventNodesReturned: 1,
                eventEdgesReturned: 1,
                eventLogicReturned: 1,
            },
            capabilities: [],
            evidence: [],
            unresolved: [],
            eventGraph: {
                nodes: [{ eventId: 'example.1' }],
                edges: [{ sourceId: 'example.1', targetEventId: 'example.2', edgeType: 'option' }],
                logic: [{ eventId: 'example.1', relationType: 'flag_set', subject: 'example_started' }],
            },
        };

        const result = await projectKnowledge.queryProjectKnowledge(workspaceRoot, {
            identifiers: ['example.1'],
            includeEventGraph: true,
        });
        expect(result.status).to.equal('ready');
        expect(result.retrieval?.strategy).to.equal('indexed_graph');
        expect(result.retrieval?.seedIdentifiers).to.deep.equal(['example.1']);
        expect(result.eventGraph?.edges[0]?.edgeType).to.equal('option');
        expect(result.eventGraph?.logic[0]?.relationType).to.equal('flag_set');
        expect(commandCalls[1]!.command).to.equal('cwtools.ai.queryProjectKnowledgeDb');
    });

    it('preserves partial completeness instead of reporting a bounded graph as ready', async () => {
        const profile = { game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        nextSnapshot = {
            ok: true,
            status: 'partial',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'events' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1200, topologyEdges: 8000 },
            warnings: ['Topology and event relationships are partial because the configured export limits were reached.'],
        };
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        nextSnapshot = {
            ok: true,
            status: 'partial',
            domains: ['events'],
            evidence: [],
            unresolved: [],
            eventGraph: { nodes: [], edges: [], logic: [] },
        };

        const result = await projectKnowledge.queryProjectKnowledge(workspaceRoot);

        expect(result.status).to.equal('partial');
        expect(result._hint).to.include('export limits');
    });

    it('keeps one-version V1 JSON query compatibility', async () => {
        const root = path.join(workspaceRoot, '.cwtools', 'project', 'knowledge');
        fs.mkdirSync(path.join(root, 'capabilities'), { recursive: true });
        fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            generationMode: 'full',
            status: 'ready',
            game: 'stellaris',
            projectRoots: [workspaceRoot],
            domains: ['events'],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            fingerprints: {
                project: projectKnowledge.computeProjectKnowledgeFingerprint(workspaceRoot),
                vanilla: 'legacy',
                rules: 'legacy',
            },
            warnings: [],
            staleReasons: [],
            artifacts: ['capabilities/events.json'],
        }), 'utf8');
        fs.writeFileSync(path.join(root, 'capabilities', 'events.json'), JSON.stringify({
            summary: { id: 'events', definitionCount: 1 },
            definitions: [{ id: 'legacy.1', entityType: 'event', origin: 'workspace' }],
        }), 'utf8');
        fs.writeFileSync(path.join(root, 'unresolved.json'), JSON.stringify({ entries: [] }), 'utf8');

        const result = await projectKnowledge.queryProjectKnowledge(workspaceRoot, {
            identifiers: ['legacy.1'],
            domains: ['events'],
        });
        expect(result.evidence.some(item => item.id === 'legacy.1')).to.equal(true);
        expect(commandCalls).to.have.length(0);
    });

    it('defers a .cwb-triggered full rebuild until the next project load', async () => {
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'events' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        fs.mkdirSync(path.join(workspaceRoot, '.cwtools', 'project'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'project', 'profile.json'), JSON.stringify(profile));
        const refreshedGames: Array<readonly string[] | undefined> = [];
        const context = {
            globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
            subscriptions: [] as Array<{ dispose(): void }>,
        };
        projectKnowledge.registerProjectKnowledgeWatcher(context as any, {
            refreshVanillaSymbols: async (gameIds?: readonly string[]) => { refreshedGames.push(gameIds); },
        } as any);
        expect(watcherStubs).to.have.length(2);

        const clock = sinon.useFakeTimers();
        try {
            watcherStubs[1]!.change?.({ fsPath: path.join(context.globalStorageUri.fsPath, '.cwtools', 'stl.cwb') });
            expect(projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)?.staleReasons).to.include('vanilla_cache_changed');
            await clock.tickAsync(2000);
            await clock.runAllAsync();
        } finally {
            clock.restore();
            for (const disposable of context.subscriptions.reverse()) disposable.dispose();
        }

        expect(refreshedGames).to.deep.equal([]);
        expect(commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge')).to.have.length(1);
        expect(progressCalls).to.have.length(0);
        expect(activeProgressCount).to.equal(0);
        const manifest = projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)!;
        expect(manifest.status).to.equal('stale');
        expect(manifest.staleReasons).to.include('vanilla_cache_changed');
    });

    it('resumes a vanilla knowledge refresh after the required window reload', async () => {
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            completeExport: true,
            domains: [{ id: 'events' }],
            counts: { definitions: 2, workspaceDefinitions: 1, vanillaDefinitions: 1, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile, { complete: true });
        fs.mkdirSync(path.join(workspaceRoot, '.cwtools', 'project'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'project', 'profile.json'), JSON.stringify(profile), 'utf8');
        projectKnowledge.markProjectKnowledgeStale(workspaceRoot, ['vanilla_cache_changed']);
        commandCalls = [];
        const refreshedGames: Array<readonly string[] | undefined> = [];
        const context = {
            globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
            subscriptions: [] as Array<{ dispose(): void }>,
        };
        projectKnowledge.registerProjectKnowledgeWatcher(context as any, {
            refreshVanillaSymbols: async (gameIds?: readonly string[]) => { refreshedGames.push(gameIds); },
        } as any);

        const clock = sinon.useFakeTimers();
        try {
            projectKnowledge.resumeStaleProjectKnowledgeRefreshes({
                refreshVanillaSymbols: async (gameIds?: readonly string[]) => { refreshedGames.push(gameIds); },
            } as any);
            await clock.tickAsync(300);
            await clock.runAllAsync();
        } finally {
            clock.restore();
            for (const disposable of context.subscriptions.reverse()) disposable.dispose();
        }

        expect(refreshedGames).to.deep.equal([]);
        expect(commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge')).to.have.length(1);
        const manifest = projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)!;
        expect(manifest.status).to.equal('ready');
        expect(manifest.completeExport).to.equal(true);
        expect(manifest.counts.vanillaDefinitions).to.equal(1);
        expect(manifest.staleReasons).to.deep.equal([]);
    });

    it('repairs an interrupted incremental update with one full rebuild on project load', async () => {
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'events' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        fs.mkdirSync(path.join(workspaceRoot, '.cwtools', 'project'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'project', 'profile.json'), JSON.stringify(profile), 'utf8');
        const changedFile = path.join(workspaceRoot, 'events', 'changed-after-export.txt');
        fs.mkdirSync(path.dirname(changedFile), { recursive: true });
        fs.writeFileSync(changedFile, 'country_event = { id = test.1 }', 'utf8');
        projectKnowledge.markProjectKnowledgeStale(workspaceRoot, ['workspace_files_changed']);
        commandCalls = [];

        const clock = sinon.useFakeTimers();
        try {
            projectKnowledge.resumeStaleProjectKnowledgeRefreshes();
            await clock.tickAsync(1000);
            await clock.runAllAsync();
        } finally {
            clock.restore();
        }

        const exports = commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge');
        expect(exports).to.have.length(1);
        expect((exports[0]!.args[0] as { generationMode: string }).generationMode).to.equal('full');
        expect(progressCalls).to.have.length(1);
        expect(projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)?.staleReasons).to.deep.equal([]);
    });

    it('coalesces edits made during a load-time full refresh into one incremental tail', async () => {
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'events' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        fs.mkdirSync(path.join(workspaceRoot, '.cwtools', 'project'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'project', 'profile.json'), JSON.stringify(profile), 'utf8');
        const context = {
            globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
            subscriptions: [] as Array<{ dispose(): void }>,
        };
        projectKnowledge.registerProjectKnowledgeWatcher(context as any, {
            refreshVanillaSymbols: async () => undefined,
        } as any);
        commandCalls = [];

        let releaseExport = () => undefined;
        exportGate = new Promise<void>(resolve => { releaseExport = resolve; });
        const clock = sinon.useFakeTimers();
        try {
            projectKnowledge.markProjectKnowledgeStale(workspaceRoot, ['vanilla_cache_changed']);
            projectKnowledge.resumeStaleProjectKnowledgeRefreshes();
            await clock.tickAsync(300);
            expect(commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge')).to.have.length(1);

            const changedFile = path.join(workspaceRoot, 'events', 'changed-during-refresh.txt');
            watcherStubs[0]!.change?.({ fsPath: changedFile });
            watcherStubs[0]!.change?.({ fsPath: changedFile });
            await clock.tickAsync(200);
            expect(commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge')).to.have.length(1);

            releaseExport();
            exportGate = undefined;
            await clock.runAllAsync();
        } finally {
            releaseExport();
            exportGate = undefined;
            clock.restore();
            for (const disposable of context.subscriptions.reverse()) disposable.dispose();
        }

        const exports = commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge');
        expect(exports).to.have.length(2);
        expect((exports[0]!.args[0] as { generationMode: string }).generationMode).to.equal('full');
        expect((exports[1]!.args[0] as { generationMode: string; changedFiles: string[] })).to.deep.include({
            generationMode: 'incremental',
            changedFiles: [path.join(workspaceRoot, 'events', 'changed-during-refresh.txt')],
        });
        expect(activeProgressCount).to.equal(0);
        const manifest = projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)!;
        expect(manifest.status).to.equal('ready');
        expect(manifest.staleReasons).to.deep.equal([]);
    });

    it('deduplicates saved files into one incremental batch per workspace', async () => {
        const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-project-knowledge-second-'));
        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            generationMode: 'full',
            domains: [{ id: 'event' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }, { uri: { fsPath: secondRoot } }];
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        await projectKnowledge.generateProjectKnowledge(secondRoot, profile);
        for (const root of [workspaceRoot, secondRoot]) {
            const projectRoot = path.join(root, '.cwtools', 'project');
            fs.mkdirSync(projectRoot, { recursive: true });
            fs.writeFileSync(path.join(projectRoot, 'profile.json'), JSON.stringify(profile), 'utf8');
        }
        commandCalls = [];
        const context = {
            globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
            subscriptions: [] as Array<{ dispose(): void }>,
        };
        projectKnowledge.registerProjectKnowledgeWatcher(context as any);
        const firstChanged = path.join(workspaceRoot, 'events', 'first.txt');
        const secondChanged = path.join(secondRoot, 'common', 'scripted_effects', 'second.txt');
        let secondManifest: import('../../extension/ai/projectKnowledge').ProjectKnowledgeManifest | undefined;

        const clock = sinon.useFakeTimers();
        try {
            watcherStubs[0]!.change?.({ fsPath: firstChanged });
            watcherStubs[0]!.change?.({ fsPath: firstChanged });
            watcherStubs[0]!.change?.({ fsPath: secondChanged });
            await clock.tickAsync(2000);
            await clock.runAllAsync();
            secondManifest = projectKnowledge.readProjectKnowledgeManifest(secondRoot);
        } finally {
            clock.restore();
            for (const disposable of context.subscriptions.reverse()) disposable.dispose();
            fs.rmSync(secondRoot, { recursive: true, force: true });
        }

        const exports = commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge');
        expect(exports).to.have.length(2);
        expect(exports.every(call => (call.args[0] as { generationMode: string }).generationMode === 'incremental')).to.equal(true);
        const changedBatches = exports.map(call => (call.args[0] as { changedFiles: string[] }).changedFiles);
        expect(changedBatches).to.deep.include([firstChanged]);
        expect(changedBatches).to.deep.include([secondChanged]);
        expect(progressCalls).to.have.length(2);
        expect(projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)?.staleReasons).to.deep.equal([]);
        expect(secondManifest?.staleReasons).to.deep.equal([]);
    });

    it('keeps Git-style file changes queued without leaving progress active during startup validation', async () => {
        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'event' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        fs.mkdirSync(path.join(workspaceRoot, '.cwtools', 'project'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'project', 'profile.json'), JSON.stringify(profile), 'utf8');
        commandCalls = [];
        nextSnapshot = {
            ...nextSnapshot,
            generationMode: 'incremental',
            generatedAtUnixMs: Date.now() + 1,
        };
        validationStatus = {
            ok: true,
            inProgress: true,
            pendingGlobalKinds: ['types'],
            modelReadyForKnowledgeExport: false,
            loading: { inProgress: false },
        };
        const context = {
            globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
            subscriptions: [] as Array<{ dispose(): void }>,
        };
        projectKnowledge.registerProjectKnowledgeWatcher(context as any);
        const firstChanged = path.join(workspaceRoot, 'events', 'first.txt');
        const secondChanged = path.join(workspaceRoot, 'common', 'bypass', 'second.txt');

        const clock = sinon.useFakeTimers();
        try {
            watcherStubs[0]!.change?.({ fsPath: firstChanged });
            await clock.tickAsync(200);
            expect(commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge')).to.have.length(0);
            expect(progressCalls).to.have.length(0);
            expect(activeProgressCount).to.equal(0);

            watcherStubs[0]!.change?.({ fsPath: firstChanged });
            watcherStubs[0]!.create?.({ fsPath: secondChanged });
            await clock.tickAsync(1200);
            expect(commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge')).to.have.length(0);
            expect(progressCalls).to.have.length(0);
            expect(activeProgressCount).to.equal(0);

            validationStatus = {
                ok: true,
                inProgress: false,
                pendingGlobalKinds: ['types', 'rules'],
                modelReadyForKnowledgeExport: true,
                loading: { inProgress: false },
            };
            await clock.tickAsync(1200);
            await clock.runAllAsync();
        } finally {
            clock.restore();
            for (const disposable of context.subscriptions.reverse()) disposable.dispose();
        }

        const exports = commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge');
        expect(exports).to.have.length(1);
        expect(exports[0]!.args[0]).to.deep.include({
            generationMode: 'incremental',
            changedFiles: [firstChanged, secondChanged],
        });
        expect(progressCalls).to.have.length(1);
        expect(progressCalls[0]!.reports.some(report => report.message?.includes('Updating changed project files'))).to.equal(true);
        expect(activeProgressCount).to.equal(0);
        const manifest = projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)!;
        expect(manifest.status).to.equal('ready');
        expect(manifest.staleReasons).to.deep.equal([]);
    });

    it('ignores unchanged saves and coalesces an open-document save with its file-watcher echo', async () => {
        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'event' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        fs.mkdirSync(path.join(workspaceRoot, '.cwtools', 'project'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'project', 'profile.json'), JSON.stringify(profile), 'utf8');
        commandCalls = [];
        nextSnapshot = {
            ...nextSnapshot,
            generationMode: 'incremental',
            generatedAtUnixMs: Date.now() + 1,
        };

        const changedFile = path.join(workspaceRoot, 'events', 'changed.txt');
        let documentText = 'event = { id = test.1 }\n';
        const document: TextDocumentStub = {
            uri: { fsPath: changedFile, scheme: 'file' },
            getText: () => documentText,
        };
        vscodeStub.workspace.textDocuments = [document];
        const context = {
            globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
            subscriptions: [] as Array<{ dispose(): void }>,
        };
        projectKnowledge.registerProjectKnowledgeWatcher(context as any);

        const clock = sinon.useFakeTimers();
        try {
            saveDocumentListener?.(document);
            watcherStubs[0]!.change?.(document.uri);
            await clock.tickAsync(1000);
            expect(commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge')).to.have.length(0);
            expect(progressCalls).to.have.length(0);

            documentText = 'event = { id = test.2 }\n';
            saveDocumentListener?.(document);
            watcherStubs[0]!.change?.(document.uri);
            await clock.tickAsync(2000);
            await clock.runAllAsync();
        } finally {
            clock.restore();
            for (const disposable of context.subscriptions.reverse()) disposable.dispose();
        }

        const exports = commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge');
        expect(exports).to.have.length(1);
        expect(exports[0]!.args[0]).to.deep.include({
            generationMode: 'incremental',
            changedFiles: [changedFile],
        });
        expect(progressCalls).to.have.length(1);
    });

    it('routes secondary-root changes into one primary incremental export', async () => {
        const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-project-knowledge-combined-'));
        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }, { uri: { fsPath: secondRoot } }];
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot, secondRoot],
            generationMode: 'full',
            domains: [{ id: 'event' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        const projectRoot = path.join(workspaceRoot, '.cwtools', 'project');
        fs.mkdirSync(projectRoot, { recursive: true });
        fs.writeFileSync(path.join(projectRoot, 'profile.json'), JSON.stringify(profile), 'utf8');
        commandCalls = [];
        const context = {
            globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
            subscriptions: [] as Array<{ dispose(): void }>,
        };
        projectKnowledge.registerProjectKnowledgeWatcher(context as any);
        const changedFile = path.join(secondRoot, 'events', 'secondary.txt');

        const clock = sinon.useFakeTimers();
        try {
            watcherStubs[0]!.change?.({ fsPath: changedFile });
            await clock.tickAsync(2000);
            await clock.runAllAsync();
        } finally {
            clock.restore();
            for (const disposable of context.subscriptions.reverse()) disposable.dispose();
            fs.rmSync(secondRoot, { recursive: true, force: true });
        }

        const exports = commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge');
        expect(exports).to.have.length(1);
        expect(exports[0]!.args[0]).to.deep.include({
            generationMode: 'incremental',
            changedFiles: [changedFile],
        });
        expect(progressCalls).to.have.length(1);
        const manifest = projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)!;
        expect(manifest.status).to.equal('ready');
        expect(manifest.staleReasons).to.deep.equal([]);
    });

    it('includes .shader and .fxh files in the fingerprint and marks watcher changes stale', async () => {
        const shaderFile = path.join(workspaceRoot, 'gfx', 'FX', 'test.shader');
        const fxhFile = path.join(workspaceRoot, 'gfx', 'FX', 'test.fxh');
        fs.mkdirSync(path.dirname(shaderFile), { recursive: true });
        fs.writeFileSync(shaderFile, 'shader body\n', 'utf8');
        fs.writeFileSync(fxhFile, '#include "x"\n', 'utf8');

        const before = projectKnowledge.computeProjectKnowledgeFingerprint(workspaceRoot);
        fs.writeFileSync(shaderFile, 'modified shader body\n', 'utf8');
        const afterShader = projectKnowledge.computeProjectKnowledgeFingerprint(workspaceRoot);
        fs.writeFileSync(fxhFile, '#include "changed-y"\n', 'utf8');
        const afterFxh = projectKnowledge.computeProjectKnowledgeFingerprint(workspaceRoot);

        expect(afterShader).to.not.equal(before);
        expect(afterFxh).to.not.equal(afterShader);

        const profile = { schemaVersion: 1, game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            generationMode: 'full',
            domains: [{ id: 'event' }],
            counts: { definitions: 1, workspaceDefinitions: 1, vanillaDefinitions: 0, definitionStacks: 0, topologyFiles: 1, topologyEdges: 0 },
            warnings: [],
        };
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile);
        fs.mkdirSync(path.join(workspaceRoot, '.cwtools', 'project'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'project', 'profile.json'), JSON.stringify(profile), 'utf8');
        commandCalls = [];
        const context = {
            globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
            subscriptions: [] as Array<{ dispose(): void }>,
        };
        projectKnowledge.registerProjectKnowledgeWatcher(context as any);

        const clock = sinon.useFakeTimers();
        try {
            watcherStubs[0]!.change?.({ fsPath: shaderFile });
            watcherStubs[0]!.change?.({ fsPath: fxhFile });
            await clock.tickAsync(2000);
            await clock.runAllAsync();
        } finally {
            clock.restore();
            for (const disposable of context.subscriptions.reverse()) disposable.dispose();
        }

        expect(commandCalls.filter(call => call.command === 'cwtools.ai.exportProjectKnowledge')).to.have.length(0);
        expect(progressCalls).to.have.length(0);
        const manifest = projectKnowledge.readProjectKnowledgeManifest(workspaceRoot)!;
        expect(manifest.status).to.equal('stale');
        expect(manifest.staleReasons).to.include('workspace_files_changed');
        expect(manifest.staleReasons).to.include('graph_wide_inputs_changed');
    });
});
