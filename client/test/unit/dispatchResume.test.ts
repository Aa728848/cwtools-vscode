import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { GENERAL_PARALLEL, PARADOX_PARALLEL } from './schedulingFixtures';

/**
 * Resume/append/clarification contract of dispatch_agents plus the durable
 * merge_results layer. Validation-only tests: full sub-agent execution is
 * covered by the orchestrator integration tests.
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
            registry: require('../../extension/ai/orchestrator/backgroundOrchestrators') as typeof import('../../extension/ai/orchestrator/backgroundOrchestrators'),
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { agentTools, store, workspace, engine, registry } = loadModules();
const { AgentToolExecutor } = agentTools;
const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

describe('dispatch_agents resume/append/clarification', () => {
    let workspaceRoot: string;
    let privateRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-resume-'));
        privateRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-resume-private-'));
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

    async function saveGraph(graphId: string, topicId: string, domain: 'general' | 'paradox') {
        const graph = engine.TaskGraphEngine.createGraph('Resume objective');
        engine.TaskGraphEngine.addNode(graph, 'n1', 'explore', 'Inspect.', { dependencies: [] });
        engine.TaskGraphEngine.addNode(graph, 'n2', 'explore', 'Inspect deeper.', { dependencies: ['n1'] });
        const graphEngine = new engine.TaskGraphEngine();
        graphEngine.markComplete(graph, 'n1', 'done wave one');
        const ok = await store.saveOrchestration({
            topicId,
            domain,
            graph,
            agentResults: new Map([['n1', {
                nodeId: 'n1', success: true, output: 'done wave one',
                tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
                writtenFiles: [], stepCount: 1,
            }]]),
            blackboard: { entries: [], timestamp: 1 },
            summary: 'wave one',
            totalTokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
        });
        expect(ok).to.equal(true);
        return graph;
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

    it('rejects an unknown resumeGraphId', async () => {
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: 'tg_unknown_000000',
            appendTasks: [{ id: 'n3', agentType: 'explore', prompt: 'more' }],
        }, makeContext('topic-a', 'general') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('not a known orchestration');
    });

    it('rejects resuming a graph with a new blueprintFile', async () => {
        const graph = await saveGraph('tg_resume_blueprint', 'topic-a', 'paradox');
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
            blueprintFile: '.cwtools/topic-a/Implementation_Plan.md',
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('Resumed graphs are already approved contracts');
    });

    it('requires appendTasks or answerClarifications on resume', async () => {
        const graph = await saveGraph('tg_resume_nothing', 'topic-a', 'paradox');
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('Resuming requires appendTasks');
    });

    it('rejects duplicate appended task ids', async () => {
        const graph = await saveGraph('tg_resume_dup', 'topic-a', 'paradox');
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
            appendTasks: [{ id: 'n1', agentType: 'explore', prompt: 'duplicate' }],
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include(`already exists in graph '${graph.id}'`);
    });

    it('rejects write-intent appended tasks in the Paradox domain', async () => {
        const graph = await saveGraph('tg_resume_writer', 'topic-a', 'paradox');
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
            appendTasks: [{ id: 'w1', agentType: 'build', prompt: 'Write a file.' }],
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('must be read-only (explore/plan/review)');
    });

    it('rejects read-only roles that still declare plannedFiles when appending', async () => {
        const graph = await saveGraph('tg_resume_planned', 'topic-a', 'paradox');
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
            appendTasks: [{
                id: 'e1', agentType: 'explore', prompt: 'Inspect.',
                plannedFiles: ['client/extension/ai/chatPanel.ts'],
            }],
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('must be read-only (explore/plan/review)');
    });

    it('allows read-only appended tasks in the Paradox domain (incl. dependencies on stored nodes)', async () => {
        const graph = await saveGraph('tg_resume_readonly', 'topic-a', 'paradox');
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
            appendTasks: [{
                id: 'e2', agentType: 'explore', prompt: 'Inspect more.',
                dependencies: ['n1'], // references a node from the stored wave
            }],
        }, makeContext('topic-a', 'paradox') as any) as any;
        // Passes all resume validations; the missing parentAgentRunner is the
        // next gate, proving the appended task was accepted.
        expect(result.success).to.equal(false);
        expect(result.error).to.include('Orchestrator is not ready');
    });

    it('allows utility writers appended in the General domain', async () => {
        const graph = await saveGraph('tg_resume_general', 'topic-a', 'general');
        const target = path.join(workspaceRoot, 'client', 'a.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'content', 'utf8');
        const executor = createExecutor();
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
            appendTasks: [{
                id: 'u1', agentType: 'utility', prompt: 'Write a file.',
                plannedFiles: [target],
            }],
        }, makeContext('topic-a', 'general') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include('Orchestrator is not ready');
    });

    it('rejects answerClarifications for unknown node ids', async () => {
        const graph = await saveGraph('tg_resume_answer', 'topic-a', 'paradox');
        const executor = createExecutor();
        executor.parentAgentRunner = { getActiveRunRecordPromise: async () => undefined } as any;
        const result = await executor.execute('dispatch_agents', {
            resumeGraphId: graph.id,
            answerClarifications: [{ id: 'ghost', answer: 'Proceed.' }],
        }, makeContext('topic-a', 'paradox') as any) as any;
        expect(result.success).to.equal(false);
        expect(result.error).to.include("answerClarifications references unknown node id 'ghost'");
    });
});

describe('merge_results durable store layer', () => {
    let workspaceRoot: string;
    let privateRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-merge-'));
        privateRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-merge-private-'));
        workspace.configurePrivateAgentStorage(privateRoot);
    });

    afterEach(() => {
        workspace.configurePrivateAgentStorage(undefined);
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(privateRoot, { recursive: true, force: true });
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty or already removed */ }
    });

    it('merges a persisted wave by graphId even without the in-memory cache', async () => {
        const graph = engine.TaskGraphEngine.createGraph('Merge objective');
        engine.TaskGraphEngine.addNode(graph, 'n1', 'explore', 'Inspect.', { dependencies: [] });
        engine.TaskGraphEngine.addNode(graph, 'n2', 'explore', 'Inspect deeper.', { dependencies: ['n1'] });
        const graphEngine = new engine.TaskGraphEngine();
        graphEngine.markComplete(graph, 'n1', 'found the answer');
        const ok = await store.saveOrchestration({
            topicId: 'topic-a',
            domain: 'paradox',
            graph,
            agentResults: new Map([['n1', {
                nodeId: 'n1', success: true, output: 'the complete detailed answer',
                tokenUsage: { total: 5, input: 3, output: 2, estimatedCostCny: 0.0001 },
                writtenFiles: ['common/events/evt.txt'],
                stepCount: 4,
                handoff: {
                    version: 1,
                    summary: 'n1 handoff',
                    verification: ['v1'],
                    unresolved: [],
                    changedFiles: ['common/events/evt.txt'],
                } as import('../../extension/ai/runner/agentHandoff').AgentHandoff,
            }]]),
            blackboard: { entries: [], timestamp: 1 },
            summary: 'wave complete',
            totalTokenUsage: { total: 5, input: 3, output: 2, estimatedCostCny: 0.0001 },
        });
        expect(ok).to.equal(true);

        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('merge_results', {
            graphId: graph.id,
        }, {
            runnerOptions: { topicId: 'topic-a', schedulingState: PARADOX_PARALLEL },
        } as any) as any;

        expect(result.success).to.equal(true);
        expect(result.graphId).to.equal(graph.id);
        expect(result.resumeable).to.equal(true); // n2 still pending
        expect(result.agentOutputs).to.have.length(1);
        // Handoff summaries take precedence over raw output in reports.
        expect(result.agentOutputs[0].output).to.include('n1 handoff');
        expect(result.agentOutputs[0].files).to.include('common/events/evt.txt');
        expect(result.fileGroups).to.have.length(1);
        expect(result.integration.entityContracts).to.have.length(1);
        expect(result.integration.entityContracts[0].nodeId).to.equal('n1');
    });

    it('returns the catalog only when both graphId and nodeIds are omitted', async () => {
        const graph = engine.TaskGraphEngine.createGraph('Catalog objective');
        engine.TaskGraphEngine.addNode(graph, 'catalog_n1', 'explore', 'Inspect.', { dependencies: [] });
        await store.saveOrchestration({
            topicId: 'topic-a', domain: 'general', graph,
            agentResults: new Map(), blackboard: { entries: [], timestamp: 1 },
            summary: 'catalog', totalTokenUsage: { total: 0, input: 0, output: 0, estimatedCostCny: 0 },
        });
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('merge_results', {}, {
            runnerOptions: { topicId: 'topic-a', schedulingState: GENERAL_PARALLEL },
        } as any) as any;
        expect(result.mode).to.equal('catalog');
        expect(result.graphs[0].nodes[0]).to.deep.include({ id: 'catalog_n1', hasResult: false });
    });

    it('merge_results reports graphs still running in the background', async () => {
        const graph = engine.TaskGraphEngine.createGraph('Bg merge objective');
        engine.TaskGraphEngine.addNode(graph, 'n1', 'explore', 'Inspect.', { dependencies: [] });
        await store.saveOrchestration({
            topicId: 'topic-a', domain: 'general', graph,
            agentResults: new Map(),
            blackboard: { entries: [], timestamp: 1 },
            summary: 'in progress',
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
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('merge_results', {
            nodeIds: ['n1'],
            graphId: graph.id,
        }, {
            runnerOptions: { topicId: 'topic-a', schedulingState: GENERAL_PARALLEL },
        } as any) as any;
        expect(result.success).to.equal(false);
        expect(result.background).to.equal(true);
        expect(result.message).to.include('still running in the background');
        registry.backgroundOrchestrators.cancel(graph.id);
        await blocker.settled;
    });

    it('falls back to the latest wave when no graphId is given', async () => {
        const graph = engine.TaskGraphEngine.createGraph('Latest objective');
        engine.TaskGraphEngine.addNode(graph, 'n1', 'explore', 'Inspect.', { dependencies: [] });
        await store.saveOrchestration({
            topicId: 'topic-a',
            domain: 'general',
            graph,
            agentResults: new Map([['n1', {
                nodeId: 'n1', success: true, output: 'latest wave output',
                tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
                writtenFiles: [], stepCount: 1,
            }]]),
            blackboard: { entries: [], timestamp: 1 },
            summary: 'latest',
            totalTokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
        });
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('merge_results', {
            nodeIds: ['n1'],
        }, {
            runnerOptions: { topicId: 'topic-a', schedulingState: GENERAL_PARALLEL },
        } as any) as any;
        expect(result.success).to.equal(true);
        expect(result.agentOutputs[0].output).to.include('latest wave output');
    });

    it('reports unknown node ids from a persisted graph', async () => {
        const graph = engine.TaskGraphEngine.createGraph('Unknown objective');
        engine.TaskGraphEngine.addNode(graph, 'n1', 'explore', 'Inspect.', { dependencies: [] });
        await store.saveOrchestration({
            topicId: 'topic-a',
            domain: 'general',
            graph,
            agentResults: new Map([['n1', {
                nodeId: 'n1', success: true, output: 'o',
                tokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
                writtenFiles: [], stepCount: 1,
            }]]),
            blackboard: { entries: [], timestamp: 1 },
            summary: 's',
            totalTokenUsage: { total: 1, input: 1, output: 0, estimatedCostCny: 0 },
        });
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('merge_results', {
            nodeIds: ['missing'],
            graphId: graph.id,
        }, {
            runnerOptions: { topicId: 'topic-a', schedulingState: GENERAL_PARALLEL },
        } as any) as any;
        expect(result.success).to.equal(false);
        expect(result.message).to.include('Unknown or unavailable task node IDs: missing');
    });
});
