import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let nextSnapshot: Record<string, unknown>;
let commandCalls: Array<{ command: string; args: unknown[] }> = [];

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    commands: {
        executeCommand: async (command: string, ...args: unknown[]) => {
            commandCalls.push({ command, args });
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
    },
};

function loadProjectKnowledge() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    const modulePath = require.resolve('../../extension/ai/projectKnowledge');
    delete require.cache[modulePath];
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/projectKnowledge') as typeof import('../../extension/ai/projectKnowledge');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('project knowledge SQLite V2', () => {
    const projectKnowledge = loadProjectKnowledge();
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-project-knowledge-'));
        commandCalls = [];
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('publishes only manifest + SQLite and cleans V1 artifacts after a successful export', async () => {
        const root = path.join(workspaceRoot, '.cwtools-ai', 'project', 'knowledge');
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
            schemaVersion: 2,
            game: 'stellaris',
            graphVersion: 1,
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
        });

        expect(manifest.schemaVersion).to.equal(2);
        expect(manifest.artifacts).to.deep.equal(['knowledge.sqlite']);
        expect(manifest.counts.eventLogic).to.equal(9);
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
            maxDefinitions: 100000,
            maxTopologyFiles: 1200,
            maxEdges: 8000,
            archetypesPerDomain: 8,
            databasePath: path.join(root, 'knowledge.sqlite'),
            generationMode: 'incremental',
        }]);
    });

    it('writes only a lightweight manifest when the LSP export is unavailable', () => {
        const profile = { game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        const manifest = projectKnowledge.writeUnavailableProjectKnowledge(
            workspaceRoot,
            profile,
            'LSP server has not loaded a game model yet.',
        );
        const root = path.join(workspaceRoot, '.cwtools-ai', 'project', 'knowledge');

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
        expect(result.eventGraph?.edges[0]?.edgeType).to.equal('option');
        expect(result.eventGraph?.logic[0]?.relationType).to.equal('flag_set');
        expect(commandCalls[1]!.command).to.equal('cwtools.ai.queryProjectKnowledgeDb');
    });

    it('keeps one-version V1 JSON query compatibility', async () => {
        const root = path.join(workspaceRoot, '.cwtools-ai', 'project', 'knowledge');
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
});
