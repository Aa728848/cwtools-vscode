import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Background dispatch contract: registry semantics, domain gating, immediate
 * return shape, and durable settlement. Orchestrator execution is stubbed.
 */

let stubConfigOverrides: Record<string, any> = {};

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        isTrusted: true,
        getConfiguration: () => ({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (key in stubConfigOverrides) return stubConfigOverrides[key] as T;
                return defaultValue;
            },
        }),
    },
    languages: { getDiagnostics: () => [] },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    commands: { executeCommand: async () => undefined },
    Uri: {
        file: (filePath: string) => ({
            fsPath: filePath,
            toString: () => `file://${filePath.replace(/\\/g, '/')}`,
        }),
    },
    CancellationTokenSource: class {
        token = {};
        cancel(): void { /* stub */ }
        dispose(): void { /* stub */ }
    },
    window: {
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

function loadModules() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            agentTools: require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools'),
            store: require('../../extension/ai/orchestrator/orchestrationStore') as typeof import('../../extension/ai/orchestrator/orchestrationStore'),
            workspace: require('../../extension/ai/workspacePaths') as typeof import('../../extension/ai/workspacePaths'),
            engine: require('../../extension/ai/orchestrator/taskGraphEngine') as typeof import('../../extension/ai/orchestrator/taskGraphEngine'),
            orchestrator: require('../../extension/ai/orchestrator/orchestrator') as typeof import('../../extension/ai/orchestrator/orchestrator'),
            registry: require('../../extension/ai/orchestrator/backgroundOrchestrators') as typeof import('../../extension/ai/orchestrator/backgroundOrchestrators'),
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { agentTools, store, workspace, engine, orchestrator, registry } = loadModules();
const { AgentToolExecutor } = agentTools;
const { BackgroundOrchestratorRegistry } = registry;
const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

function successfulResult() {
    return {
        success: true,
        summary: 'background wave complete',
        agentResults: new Map([['n1', {
            nodeId: 'n1', success: true, output: 'done',
            tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
            writtenFiles: [], stepCount: 1,
        }]]),
        totalTokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
        failedNodes: [],
        cancelledNodes: [],
    };
}

describe('BackgroundOrchestratorRegistry', () => {
    it('deduplicates active graphs and supports cancel/cancelAllForTopic', async () => {
        const reg = new BackgroundOrchestratorRegistry();
        let releaseRun: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { releaseRun = resolve; });
        let aborted = false;
        const entry = reg.start({
            graphId: 'g1',
            topicId: 'topic-a',
            run: (signal) => new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => { aborted = true; resolve(); });
                void gate.then(resolve);
            }),
        });
        expect(reg.hasActive('g1')).to.equal(true);
        expect(() => reg.start({
            graphId: 'g1',
            run: async () => undefined,
        })).to.throw(/already running/);
        expect(reg.cancel('missing')).to.equal(false);
        expect(reg.cancel('g1')).to.equal(true);
        await entry.settled;
        expect(aborted).to.equal(true);
        expect(reg.hasActive('g1')).to.equal(false);
    });

    it('aborts every graph of a topic on cancelAllForTopic', async () => {
        const reg = new BackgroundOrchestratorRegistry();
        const entries: Array<Promise<void>> = [];
        for (const id of ['g1', 'g2', 'g3']) {
            const entry = reg.start({
                graphId: id,
                topicId: id === 'g3' ? 'topic-b' : 'topic-a',
                run: (signal) => new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => resolve());
                }),
            });
            entries.push(entry.settled);
        }
        expect(reg.cancelAllForTopic('topic-a')).to.equal(2);
        await Promise.all(entries.slice(0, 2));
        expect(reg.hasActive('g1')).to.equal(false);
        expect(reg.hasActive('g2')).to.equal(false);
        expect(reg.hasActive('g3')).to.equal(true);
        reg.cancel('g3');
        await entries[2];
    });

    it('chains the parent run abort signal', async () => {
        const reg = new BackgroundOrchestratorRegistry();
        const parent = new AbortController();
        let runAborted = false;
        const entry = reg.start({
            graphId: 'g1',
            parentAbortSignal: parent.signal,
            run: (signal) => new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => { runAborted = true; resolve(); });
            }),
        });
        parent.abort(new Error('run cancelled'));
        await entry.settled;
        expect(runAborted).to.equal(true);
    });
});

describe('dispatch_agents background contract', () => {
    let workspaceRoot: string;
    let privateRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-bg-'));
        privateRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-bg-private-'));
        workspace.configurePrivateAgentStorage(privateRoot);
        stubConfigOverrides = {};
    });

    afterEach(() => {
        workspace.configurePrivateAgentStorage(undefined);
        stubConfigOverrides = {};
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(privateRoot, { recursive: true, force: true });
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty or already removed */ }
    });

    function createExecutor() {
        const client = {
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any;
        return new AgentToolExecutor(client, workspaceRoot);
    }

    function makeContext(topicId: string, domain: 'general' | 'paradox') {
        return {
            runnerOptions: {
                topicId,
                schedulingState: {
                    profileName: domain === 'paradox' ? 'paradox-agent' : 'general-agent',
                    domainProfile: domain,
                    authorization: 'workspace_write',
                    phase: 'execute',
                    dispatch: 'parallel',
                    overlays: ['swarm'],
                    routeConfidence: 1,
                    routeEvidence: ['test'],
                    phaseReason: 'test',
                    dispatchReason: 'test',
                    revision: 0,
                },
            },
        };
    }

    it('rejects background write nodes in the Paradox domain', async () => {
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            background: true,
            tasks: [{ id: 'w1', agentType: 'build', prompt: 'Write.' }],
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('Background waves are read-only');
    });

    it('rejects background read-only nodes that declare plannedFiles in the Paradox domain', async () => {
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            background: true,
            tasks: [{
                id: 'e1', agentType: 'explore', prompt: 'Inspect.',
                plannedFiles: ['client/a.txt'],
            }],
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('Background waves are read-only');
    });

    it('rejects background dispatch with a blueprintFile', async () => {
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            background: true,
            blueprintFile: '.cwtools/topic-a/Implementation_Plan.md',
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('does not accept blueprintFile');
    });

    it('rejects resuming a graph that is still running in the background', async () => {
        // Seed a stored graph first, then register THAT graph id as an active
        // background run on the shared singleton (dispatch reads it, not a
        // local registry instance).
        const graph = engine.TaskGraphEngine.createGraph('Active objective');
        engine.TaskGraphEngine.addNode(graph, 'n1', 'explore', 'Inspect.', { dependencies: [] });
        await store.saveOrchestration({
            topicId: 'topic-a', domain: 'paradox', graph,
            agentResults: new Map(),
            blackboard: { entries: [], timestamp: 1 },
            summary: 's',
            totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
        });
        const blocker = registry.backgroundOrchestrators.start({
            graphId: graph.id,
            topicId: 'topic-a',
            run: (signal) => new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve());
            }),
        });
        void blocker;
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
            answerClarifications: [{ id: 'n1', answer: 'Proceed.' }],
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('still running in the background');
        registry.backgroundOrchestrators.cancel(graph.id);
        await blocker.settled;
    });

    it('returns immediately with background metadata and settles durably', async () => {
        const originalExecute = (orchestrator.Orchestrator.prototype as any).execute;
        (orchestrator.Orchestrator.prototype as any).execute = async (graph: any) => {
            // Simulate a real execution: nodes reach a terminal state so the
            // durable record is complete after settlement.
            for (const node of graph.nodes.values()) node.status = 'done';
            return successfulResult();
        };
        try {
            const executor = createExecutor();
            executor.parentAgentRunner = { getActiveRunRecordPromise: async () => undefined } as any;
            const result = await executor.execute('dispatch_agents', {
                background: true,
                tasks: [
                    { id: 'n1', agentType: 'explore', prompt: 'Inspect.' },
                    { id: 'n2', agentType: 'explore', prompt: 'Inspect deeper.', dependencies: ['n1'] },
                ],
            }, makeContext('topic-a', 'general') as any) as any;

            expect(result.success).to.equal(true);
            expect(result.background).to.equal(true);
            expect(result.nodeCount).to.equal(2);
            expect(result.graphId).to.be.a('string');

            // In-progress snapshot exists before the background run settles.
            const inProgress = store.loadOrchestration(result.graphId, { topicId: 'topic-a', domain: 'general' });
            expect(inProgress).to.not.equal(undefined);
            expect(inProgress!.complete).to.equal(false);

            // The background run settles and writes the terminal record.
            const active = registry.backgroundOrchestrators.list().find(entry => entry.graphId === result.graphId);
            expect(active).to.not.equal(undefined);
            await active!.settled;
            expect(registry.backgroundOrchestrators.hasActive(result.graphId)).to.equal(false);
            const terminal = store.loadOrchestration(result.graphId, { topicId: 'topic-a', domain: 'general' });
            expect(terminal!.complete).to.equal(true);
            expect(terminal!.agentResults.n1?.output).to.equal('done');
        } finally {
            (orchestrator.Orchestrator.prototype as any).execute = originalExecute;
        }
    });

    it('cancel_dispatch aborts a running background graph', async () => {
        const originalExecute = (orchestrator.Orchestrator.prototype as any).execute;
        (orchestrator.Orchestrator.prototype as any).execute = async (_graph: any, options: any) => {
            // Hang until aborted, then surface the cancellation.
            await new Promise<void>((_resolve, reject) => {
                options.abortSignal?.addEventListener('abort', () => {
                    const error = new Error('Background orchestration cancelled.');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        };
        try {
            const executor = createExecutor();
            executor.parentAgentRunner = { getActiveRunRecordPromise: async () => undefined } as any;
            const result = await executor.execute('dispatch_agents', {
                background: true,
                tasks: [
                    { id: 'n1', agentType: 'explore', prompt: 'Inspect.' },
                    { id: 'n2', agentType: 'explore', prompt: 'Inspect deeper.', dependencies: ['n1'] },
                ],
            }, makeContext('topic-a', 'general') as any) as any;
            expect(result.success).to.equal(true);
            expect(result.background).to.equal(true);

            const cancelResult = await executor.execute('cancel_dispatch', {
                graphId: result.graphId,
            }, makeContext('topic-a', 'general') as any) as any;
            expect(cancelResult.success).to.equal(true);
            expect(cancelResult.cancelled).to.equal(true);

            const active = registry.backgroundOrchestrators.list().find(entry => entry.graphId === result.graphId);
            expect(active).to.not.equal(undefined);
            await active!.settled;
            expect(registry.backgroundOrchestrators.hasActive(result.graphId)).to.equal(false);

            // The cancelled graph persists an explicit cancelled summary.
            const terminal = store.loadOrchestration(result.graphId, { topicId: 'topic-a', domain: 'general' });
            expect(terminal!.summary).to.include('cancelled');
        } finally {
            (orchestrator.Orchestrator.prototype as any).execute = originalExecute;
        }
    });

    it('cancel_dispatch reports graphs that are not running', async () => {
        const executor = createExecutor();
        const result = await executor.execute('cancel_dispatch', {
            graphId: 'tg_never_ran',
        }, makeContext('topic-a', 'general') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.message).to.include('not running in the background');
    });
});
