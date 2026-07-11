import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let nextSnapshot: Record<string, unknown>;

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    commands: {
        executeCommand: async () => nextSnapshot,
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

describe('project knowledge incremental refresh', () => {
    const projectKnowledge = loadProjectKnowledge();
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-project-knowledge-'));
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('removes stale domain data when the last definition in a changed domain is deleted', async () => {
        const eventDefinition = {
            entityType: 'event',
            id: 'example.1',
            file: path.join(workspaceRoot, 'events', 'example.txt'),
            logicalPath: 'events/example.txt',
            origin: 'workspace',
            domain: 'events',
            overwrite: 'none',
        };
        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            graphVersion: 1,
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            definitions: [eventDefinition],
            typeSummaries: [{ entityType: 'event', totalCount: 1, workspaceCount: 1, vanillaCount: 0 }],
            definitionStacks: [{ entityType: 'event', id: 'example.1', definitions: [eventDefinition], activeDefinitions: [eventDefinition], resolution: 'single' }],
            domains: [{ id: 'events', definitionCount: 1, workspaceCount: 1, vanillaCount: 0, projectExamples: [eventDefinition], vanillaArchetypes: [] }],
            topology: { files: [{ file: eventDefinition.file, logicalPath: eventDefinition.logicalPath, domain: 'events' }], edges: [] },
            overrideModes: [],
            overrideModeInfo: [],
            warnings: [],
        };
        const profile = { game: { id: 'stellaris' } } as import('../../extension/ai/types').ProjectProfile;
        await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile, { mode: 'full' });

        nextSnapshot = {
            ok: true,
            status: 'ready',
            game: 'stellaris',
            graphVersion: 2,
            generatedAtUnixMs: Date.now(),
            projectRoots: [workspaceRoot],
            definitions: [],
            typeSummaries: [],
            definitionStacks: [],
            domains: [],
            topology: { files: [], edges: [] },
            overrideModes: [],
            overrideModeInfo: [],
            warnings: [],
        };
        const manifest = await projectKnowledge.generateProjectKnowledge(workspaceRoot, profile, {
            mode: 'incremental',
            domains: ['events'],
        });

        const root = path.join(workspaceRoot, '.cwtools-ai', 'project', 'knowledge');
        const capability = JSON.parse(fs.readFileSync(path.join(root, 'capabilities', 'events.json'), 'utf8'));
        const topology = JSON.parse(fs.readFileSync(path.join(root, 'topology.json'), 'utf8'));
        const stacks = JSON.parse(fs.readFileSync(path.join(root, 'definition-stacks.json'), 'utf8'));
        const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8'));

        expect(capability.summary.definitionCount).to.equal(0);
        expect(capability.definitions).to.deep.equal([]);
        expect(topology.files).to.deep.equal([]);
        expect(stacks.definitions).to.deep.equal([]);
        expect(snapshot.definitions).to.deep.equal([]);
        expect(snapshot.domains.find((domain: { id: string }) => domain.id === 'events').definitionCount).to.equal(0);
        expect(manifest.counts.definitions).to.equal(0);
        expect(manifest.counts.topologyFiles).to.equal(0);
    });
});
