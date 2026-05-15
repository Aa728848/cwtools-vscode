import { expect } from 'chai';
import sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    commands: {
        executeCommand: async () => undefined,
    },
    Uri: {
        file: (filePath: string) => ({
            fsPath: filePath,
            toString: () => `file://${filePath.replace(/\\/g, '/')}`,
        }),
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

function loadToolModules() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            fileTools: require('../../extension/ai/tools/fileTools') as typeof import('../../extension/ai/tools/fileTools'),
            externalTools: require('../../extension/ai/tools/externalTools') as typeof import('../../extension/ai/tools/externalTools'),
            agentTools: require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools'),
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { fileTools, externalTools, agentTools } = loadToolModules();
const { FileToolHandler } = fileTools;
const { ExternalToolHandler } = externalTools;
const { AgentToolExecutor } = agentTools;
const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

function makeWorkspace(): string {
    fs.mkdirSync(TEMP_BASE, { recursive: true });
    return fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-agent-tools-'));
}

function cleanupWorkspace(workspaceRoot: string | undefined): void {
    if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty or already removed */ }
}

function makeContext(topicId = 'topic-a'): any {
    const abortController = new AbortController();
    return {
        runnerOptions: {
            topicId,
            abortSignal: abortController.signal,
        },
    };
}

describe('agent tool file path safety', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        cleanupWorkspace(workspaceRoot);
    });

    function createFileHandler() {
        return new FileToolHandler({ workspaceRoot, fileWriteMode: 'auto' });
    }

    it('remaps legacy .cwtools-ai/scratch writes into the current topic folder', async () => {
        const handler = createFileHandler();
        const result = await handler.writeFile(
            { file: '.cwtools-ai/scratch/notes.txt', content: 'hello topic scratch' },
            makeContext('topic-123'),
        );

        expect(result.success).to.equal(true);
        const expectedPath = path.join(workspaceRoot, '.cwtools-ai', 'topic-123', 'scratch', 'notes.txt');
        const legacyPath = path.join(workspaceRoot, '.cwtools-ai', 'scratch', 'notes.txt');
        expect(fs.readFileSync(expectedPath, 'utf8')).to.equal('hello topic scratch');
        expect(fs.existsSync(legacyPath)).to.equal(false);
    });

    it('remaps loose .cwtools-ai writes into the current topic folder', async () => {
        const handler = createFileHandler();
        const result = await handler.writeFile(
            { file: '.cwtools-ai/notes.md', content: 'topic note' },
            makeContext('topic-123'),
        );

        expect(result.success).to.equal(true);
        const expectedPath = path.join(workspaceRoot, '.cwtools-ai', 'topic-123', 'notes.md');
        const loosePath = path.join(workspaceRoot, '.cwtools-ai', 'notes.md');
        expect(fs.readFileSync(expectedPath, 'utf8')).to.equal('topic note');
        expect(fs.existsSync(loosePath)).to.equal(false);
    });

    it('rejects absolute paths that only share the workspace path prefix', async () => {
        const handler = createFileHandler();
        const siblingRoot = `${workspaceRoot}-sibling`;
        fs.mkdirSync(siblingRoot, { recursive: true });
        try {
            const result = await handler.writeFile(
                { file: path.join(siblingRoot, 'outside.txt'), content: 'outside' },
                makeContext('topic-123'),
            );

            expect(result.success).to.equal(false);
            expect(result.message).to.include('outside the workspace root');
            expect(fs.existsSync(path.join(siblingRoot, 'outside.txt'))).to.equal(false);
        } finally {
            cleanupWorkspace(siblingRoot);
        }
    });

    it('rejects .yml writes through generic write tools', async () => {
        const handler = createFileHandler();
        const ctx = makeContext();
        const ymlRel = 'localisation/english/test_l_english.yml';
        const ymlAbs = path.join(workspaceRoot, ...ymlRel.split('/'));
        const original = 'l_english:\n old_key:0 "Old"\n';
        fs.mkdirSync(path.dirname(ymlAbs), { recursive: true });
        fs.writeFileSync(ymlAbs, original, 'utf8');

        const writeResult = await handler.writeFile({ file: ymlRel, content: 'l_english:\n old_key:0 "New"\n' }, ctx);
        expect(writeResult.success).to.equal(false);
        expect(writeResult.message).to.include('write_localisation');

        const replaceResult = await handler.multiReplaceFileContent({
            TargetFile: ymlRel,
            Instruction: 'should be refused',
            ReplacementChunks: [{
                StartLine: 2,
                EndLine: 2,
                TargetContent: ' old_key:0 "Old"',
                ReplacementContent: ' old_key:0 "New"',
            }],
        }, ctx) as any;
        expect(replaceResult.success).to.equal(false);
        expect(replaceResult.message).to.include('write_localisation');

        const patchResult = await handler.applyPatch({
            patch: [
                `--- a/${ymlRel}`,
                `+++ b/${ymlRel}`,
                '@@',
                '- old_key:0 "Old"',
                '+ old_key:0 "New"',
                '',
            ].join('\n'),
        }, ctx);
        expect(patchResult.success).to.equal(false);
        expect(patchResult.errors.join('\n')).to.include('write_localisation');
        expect(fs.readFileSync(ymlAbs, 'utf8')).to.equal(original);
    });

    it('rejects write_localisation targets outside real localisation folders', async () => {
        const handler = createFileHandler();
        const result = await handler.writeLocalisation({
            filePath: '.cwtools-ai/scratch/bad_l_english.yml',
            language: 'l_english',
            entries: [{ key: 'bad_key', value: 'Bad' }],
        }, makeContext('topic-123'));

        expect(result.success).to.equal(false);
        expect(result.message).to.include('Localisation files must be written under');
        const rejectedPath = path.join(workspaceRoot, '.cwtools-ai', 'topic-123', 'scratch', 'bad_l_english.yml');
        expect(fs.existsSync(rejectedPath)).to.equal(false);
    });
});

describe('agent tool topic artifacts', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        cleanupWorkspace(workspaceRoot);
    });

    it('creates media output directories inside the current topic folder', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const dir = await (handler as any).getMediaOutputDir(makeContext('media-topic'));

        expect(dir).to.equal(path.join(workspaceRoot, '.cwtools-ai', 'media-topic', 'media'));
        expect(fs.existsSync(dir)).to.equal(true);
    });

    it('rejects run_command working directories outside the workspace boundary', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const result = await handler.runCommand({
            command: 'echo hi',
            cwd: `${workspaceRoot}-sibling`,
        }, makeContext('media-topic'));

        expect(result.exitCode).to.equal(1);
        expect(result.stderr).to.include('Working directory must be within the workspace root');
    });

    it('rejects media deployment targets outside the workspace boundary', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const sourcePath = path.join(workspaceRoot, '.cwtools-ai', 'media-topic', 'media', 'source.png');
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'fake image', 'utf8');

        const result = await handler.deployModAsset({
            sourcePath,
            targetRelativePath: '../outside.dds',
            overwrite: true,
        }, makeContext('media-topic'));

        expect(result.success).to.equal(false);
        expect(result.message).to.include('Target path must be within the workspace');
    });
});

describe('agent tool progress and aborts', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        cleanupWorkspace(workspaceRoot);
    });

    function createExecutor() {
        const client = {
            onNotification: () => undefined,
            sendNotification: () => undefined,
        } as any;
        return new AgentToolExecutor(client, workspaceRoot);
    }

    it('emits heartbeat progress while a tool is still running and stops after abort', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const executor = createExecutor();
            sinon.stub(executor as any, 'executeInternal').returns(new Promise(() => undefined));
            const abortController = new AbortController();
            const steps: any[] = [];
            const promise = executor.execute('dispatch_agents', {}, {
                runnerOptions: { abortSignal: abortController.signal },
                onStep: (step: any) => steps.push(step),
            } as any);

            await clock.tickAsync(15_001);
            const progress = steps.filter(step => step.type === 'orchestrator_progress');
            expect(progress.length).to.be.greaterThan(0);
            expect(String(progress[0].content)).to.include('dispatch_agents');

            const stepCountBeforeAbort = steps.length;
            abortController.abort(new Error('test abort'));
            const error = await promise.then(() => undefined, e => e);
            expect(error).to.be.instanceOf(Error);
            await clock.tickAsync(30_000);
            expect(steps.length).to.equal(stepCountBeforeAbort);
        } finally {
            clock.restore();
        }
    });

    it('aborts the derived tool signal when a tool timeout fires', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const executor = createExecutor();
            let innerSignal: AbortSignal | undefined;
            sinon.stub(executor as any, 'executeInternal').callsFake((...callArgs: unknown[]) => {
                const context = callArgs[2] as any;
                innerSignal = context.runnerOptions.abortSignal;
                return new Promise(() => undefined);
            });

            const resultPromise = executor.execute('todo_write', {}, {
                runnerOptions: {},
                onStep: () => undefined,
            } as any);

            await clock.tickAsync(5_001);
            const result = await resultPromise as any;
            expect(innerSignal?.aborted).to.equal(true);
            expect((innerSignal?.reason as Error).name).to.equal('TimeoutError');
            expect(String(result.error)).to.include('todo_write');
        } finally {
            clock.restore();
        }
    });
});
