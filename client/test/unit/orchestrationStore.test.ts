import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function loadStoreModules() {
    const loader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = loader._load;
    const storePath = require.resolve('../../extension/ai/orchestrator/orchestrationStore');
    const workspacePath = require.resolve('../../extension/ai/workspacePaths');
    const cachedStore = require.cache[storePath];
    const cachedWorkspace = require.cache[workspacePath];
    delete require.cache[storePath];
    delete require.cache[workspacePath];
    // Full stub: modules re-required here (errorReporter, messages, ...) stay
    // usable by later test files sharing this process's module cache.
    const vscodeStub = {
        workspace: { workspaceFolders: [] },
        commands: { executeCommand: async () => undefined },
        window: {
            activeTextEditor: undefined,
            createOutputChannel: () => ({
                appendLine: () => undefined,
                show: () => undefined,
                clear: () => undefined,
                dispose: () => undefined,
            }),
        },
        Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
    };
    loader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            store: require('../../extension/ai/orchestrator/orchestrationStore') as typeof import('../../extension/ai/orchestrator/orchestrationStore'),
            workspace: require('../../extension/ai/workspacePaths') as typeof import('../../extension/ai/workspacePaths'),
            engine: require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine'),
        };
    } finally {
        loader._load = originalLoad;
        delete require.cache[storePath];
        delete require.cache[workspacePath];
        if (cachedStore) require.cache[storePath] = cachedStore;
        if (cachedWorkspace) require.cache[workspacePath] = cachedWorkspace;
    }
}

describe('orchestrationStore', () => {
    let root: string;
    let store: typeof import('../../extension/ai/orchestrator/orchestrationStore');
    let workspace: typeof import('../../extension/ai/workspacePaths');
    let engine: typeof import('../../extension/ai/orchestrator/taskGraphEngine');

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-orch-store-'));
        ({ store, workspace, engine } = loadStoreModules());
        workspace.configurePrivateAgentStorage(root);
    });

    afterEach(() => {
        workspace.configurePrivateAgentStorage(undefined);
        fs.rmSync(root, { recursive: true, force: true });
    });

    function makeGraph(id: string, topicId = 'topic-a') {
        const graph = engine.TaskGraphEngine.createGraph(`Objective ${id}`, {
            objective: `Objective ${id}`,
            acceptanceCriteria: [{ id: 'a1', description: 'works', type: 'custom' }],
        });
        engine.TaskGraphEngine.addNode(graph, 'n1', 'explore', 'Inspect the project.', {
            plannedFiles: [],
            dependencies: [],
        });
        engine.TaskGraphEngine.addNode(graph, 'n2', 'explore', 'Inspect deeper.', {
            dependencies: ['n1'],
        });
        return { graph, topicId };
    }

    function makeResult() {
        return new Map<string, import('../../extension/ai/orchestrator/types').SubAgentResult>([
            ['n1', {
                nodeId: 'n1',
                success: true,
                output: 'found relevant files',
                tokenUsage: { total: 10, input: 5, output: 5, estimatedCostCny: 0.001 },
                writtenFiles: [],
                stepCount: 3,
                handoff: {
                    version: 1,
                    summary: 'n1 handoff summary',
                    verification: ['verified a'],
                    unresolved: [],
                    changedFiles: [],
                } as import('../../extension/ai/runner/agentHandoff').AgentHandoff,
            }],
            ['n2', {
                nodeId: 'n2',
                success: false,
                output: 'failed early',
                error: 'provider timeout',
                tokenUsage: { total: 4, input: 2, output: 2, estimatedCostCny: 0 },
                writtenFiles: [],
                stepCount: 1,
            }],
        ]);
    }

    it('roundtrips graph, agent results, and blackboard', async () => {
        const { graph, topicId } = makeGraph('rt');
        const graphEngine = new engine.TaskGraphEngine();
        graphEngine.markComplete(graph, 'n1', 'found relevant files');
        graphEngine.markFailed(graph, 'n2', 'provider timeout');
        const results = makeResult();
        const blackboard = { entries: [['__handoff:n1', {
            key: '__handoff:n1',
            value: '{"summary":"n1 handoff summary"}',
            type: 'free_text' as const,
            version: 1,
            authorAgentId: 'n1',
            timestamp: 1,
        }] as [string, import('../../extension/ai/orchestrator/types').BlackboardEntry]], timestamp: 2 };

        const saved = await store.saveOrchestration({
            topicId,
            runId: 'run-1',
            domain: 'paradox',
            mode: 'script',
            graph,
            agentResults: results,
            blackboard,
            summary: '## Execution Complete',
            totalTokenUsage: { total: 14, input: 7, output: 7, estimatedCostCny: 0.001 },
            qualityGate: {
                passed: true,
                diagnosticErrors: 0,
                logicIssues: 0,
                semanticIssues: 0,
                acceptanceFailures: [],
                filesChecked: [],
                reviewReport: 'ok',
            },
        });
        expect(saved).to.equal(true);

        const loaded = store.loadOrchestration(graph.id, { topicId, domain: 'paradox' });
        expect(loaded).to.not.equal(undefined);
        expect(loaded!.graphId).to.equal(graph.id);
        expect(loaded!.complete).to.equal(true);
        expect(loaded!.qualityGate?.passed).to.equal(true);

        const restored = store.deserializeGraph(loaded!.graph);
        expect(restored.nodes.size).to.equal(2);
        expect(restored.nodes.get('n1')!.status).to.equal('done');
        expect(restored.nodes.get('n2')!.status).to.equal('failed');
        expect(restored.metadata.featureManifest?.objective).to.equal('Objective rt');
        expect(restored.metadata.userExecutionPolicy).to.equal(undefined);

        const restoredResults = store.deserializeAgentResults(loaded!.agentResults);
        expect(restoredResults.size).to.equal(2);
        expect(restoredResults.get('n1')!.handoff?.summary).to.equal('n1 handoff summary');
        expect(restoredResults.get('n2')!.error).to.equal('provider timeout');
    });

    it('skips corrupted files and domain mismatches', async () => {
        const { graph, topicId } = makeGraph('corrupt');
        await store.saveOrchestration({
            topicId, domain: 'paradox', graph,
            agentResults: new Map(),
            blackboard: { entries: [], timestamp: 1 },
            summary: 's',
            totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
        });
        // Domain mismatch: not returned for the general domain.
        expect(store.loadOrchestration(graph.id, { topicId, domain: 'general' })).to.equal(undefined);
        // Corrupted file: guard rejects it, load falls through to undefined.
        const dir = path.join(root, 'topics', topicId, 'orchestrations');
        const target = path.join(dir, `${graph.id}.json`);
        fs.writeFileSync(target, '{ not valid json', 'utf8');
        expect(store.loadOrchestration(graph.id, { topicId, domain: 'paradox' })).to.equal(undefined);
        // Listing ignores the corrupted entry as well.
        expect(store.listOrchestrations({ topicId, domain: 'paradox' })).to.have.length(0);
    });

    it('bounds stored graphs per topic (newest 32 retained)', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 35; i++) {
            const { graph, topicId } = makeGraph(`bulk${i}`);
            const ok = await store.saveOrchestration({
                topicId, domain: 'general', graph,
                agentResults: new Map(),
                blackboard: { entries: [], timestamp: i },
                summary: 's',
                totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
            });
            expect(ok).to.equal(true);
            ids.push(graph.id);
        }
        const listed = store.listOrchestrations({ topicId: 'topic-a', domain: 'general', limit: 100 });
        expect(listed.length).to.be.at.most(32);
        // The newest graph is retained; the oldest is evicted.
        expect(store.loadOrchestration(ids[ids.length - 1]!, { topicId: 'topic-a', domain: 'general' })).to.not.equal(undefined);
        expect(store.loadOrchestration(ids[0]!, { topicId: 'topic-a', domain: 'general' })).to.equal(undefined);
        // Other topics are unaffected.
        expect(store.listOrchestrations({ topicId: 'topic-b', domain: 'general', limit: 100 })).to.have.length(0);
    });

    it('keeps incomplete graphs incomplete after a partial wave', async () => {
        const { graph, topicId } = makeGraph('partial');
        const graphEngine = new engine.TaskGraphEngine();
        // n2 stays pending; only n1 is done.
        graphEngine.markComplete(graph, 'n1', 'done');
        await store.saveOrchestration({
            topicId, domain: 'general', graph,
            agentResults: new Map([['n1', {
                nodeId: 'n1', success: true, output: 'o',
                tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
                writtenFiles: [], stepCount: 1,
            }]]),
            blackboard: { entries: [], timestamp: 1 },
            summary: 's',
            totalTokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
        });
        const loaded = store.loadOrchestration(graph.id, { topicId, domain: 'general' })!;
        expect(loaded.complete).to.equal(false);
        const restored = store.deserializeGraph(loaded.graph);
        // TaskGraphEngine only returns pending nodes, so the resumed graph
        // skips the completed n1 and can still schedule the pending n2.
        expect(graphEngine.getReadyNodes(restored).map(n => n.id)).to.deep.equal(['n2']);
    });
});
