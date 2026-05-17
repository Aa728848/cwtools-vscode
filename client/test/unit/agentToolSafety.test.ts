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
            agentRunner: require('../../extension/ai/agentRunner') as typeof import('../../extension/ai/agentRunner'),
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { fileTools, externalTools, agentTools, agentRunner } = loadToolModules();
const { FileToolHandler } = fileTools;
const { ExternalToolHandler } = externalTools;
const { AgentToolExecutor, TOOL_DEFINITIONS } = agentTools;
const { getAgentToolTargetFiles, SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS } = agentRunner;
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

    it('replaces an explicit line range with replace_lines', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'test_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'line one\nold a\nold b\nline four', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            newContent: 'new a\nnew b',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal('line one\nnew a\nnew b\nline four');
    });

    it('guards replace_lines with expectedContent to avoid stale line-range edits', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'guarded_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'line one\nchanged a\nold b\nline four', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            expectedContent: 'old a\nold b',
            newContent: 'new a\nnew b',
        }, makeContext()) as any;

        expect(result.success).to.equal(false);
        expect(result.message).to.include('safety check failed');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal('line one\nchanged a\nold b\nline four');
    });

    it('allows guarded replace_lines when expected anchors still match', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'anchored_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = old.1\n\tis_triggered_only = yes\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            expectedStartText: 'id = old.1',
            expectedEndText: 'is_triggered_only = yes',
            newContent: '\tid = new.1\n\tis_triggered_only = yes',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('id = new.1');
    });

    it('rejects replace_lines for .yml localisation files', async () => {
        const handler = createFileHandler();
        const ymlRel = 'localisation/english/test_l_english.yml';
        const ymlAbs = path.join(workspaceRoot, ...ymlRel.split('/'));
        const original = 'l_english:\n old_key:0 "Old"\n';
        fs.mkdirSync(path.dirname(ymlAbs), { recursive: true });
        fs.writeFileSync(ymlAbs, original, 'utf8');

        const result = await handler.replaceLines({
            filePath: ymlRel,
            startLine: 2,
            endLine: 2,
            newContent: ' old_key:0 "New"',
        }, makeContext()) as any;

        expect(result.success).to.equal(false);
        expect(result.message).to.include('write_localisation');
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

    it('extracts write target paths for runner scheduling without marking localisation as superseded', () => {
        expect(getAgentToolTargetFiles('write_localisation', { filePath: 'localisation/english/kuat_l_english.yml' }, workspaceRoot))
            .to.deep.equal([path.join(workspaceRoot, 'localisation', 'english', 'kuat_l_english.yml')]);
        expect(getAgentToolTargetFiles('multi_replace_file_content', { TargetFile: 'events/kuat_events.txt' }, workspaceRoot))
            .to.deep.equal([path.join(workspaceRoot, 'events', 'kuat_events.txt')]);
        expect(getAgentToolTargetFiles('replace_lines', { filePath: 'common/scripted_effects/kuat.txt' }, workspaceRoot))
            .to.deep.equal([path.join(workspaceRoot, 'common', 'scripted_effects', 'kuat.txt')]);
        expect(getAgentToolTargetFiles('write_file', { file: 'common/relics/kuat.txt' }, workspaceRoot))
            .to.deep.equal([path.join(workspaceRoot, 'common', 'relics', 'kuat.txt')]);
        expect(getAgentToolTargetFiles('write_design_blueprint', {}, workspaceRoot, 'topic-123'))
            .to.deep.equal([path.join(workspaceRoot, '.cwtools-ai', 'topic-123', 'design_blueprint.md')]);

        expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('write_file')).to.equal(true);
        expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('write_localisation')).to.equal(false);
        expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('multi_replace_file_content')).to.equal(false);
    });

    it('lets orchestrator sub-agents write localisation without waiting for pending-write confirmation', async () => {
        const pendingWrite = sinon.stub().resolves(false);
        const handler = new FileToolHandler({
            workspaceRoot,
            fileWriteMode: 'confirm',
            onPendingWrite: pendingWrite,
        });

        const result = await handler.writeLocalisation({
            filePath: 'localisation/english/kuat_rakata_arc_epilogue_l_english.yml',
            language: 'l_english',
            entries: [{ key: 'kuat_rakata_arc_epilogue_title', value: 'Epilogue' }],
        }, {
            runnerOptions: {
                topicId: 'topic-123',
                useSlimPrompt: true,
                forceAutoApplyWrites: true,
                abortSignal: new AbortController().signal,
            },
        } as any);

        expect(result.success).to.equal(true);
        expect(pendingWrite.called).to.equal(false);
        const ymlAbs = path.join(workspaceRoot, 'localisation', 'english', 'kuat_rakata_arc_epilogue_l_english.yml');
        expect(fs.readFileSync(ymlAbs, 'utf8')).to.include('kuat_rakata_arc_epilogue_title');
    });

    it('lets orchestrator sub-agents run multi_replace_file_content without pending-write confirmation', async () => {
        const pendingWrite = sinon.stub().resolves(false);
        const handler = new FileToolHandler({
            workspaceRoot,
            fileWriteMode: 'confirm',
            onPendingWrite: pendingWrite,
        });
        const fileAbs = path.join(workspaceRoot, 'events', 'kuat_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = kuat.1\n}\n', 'utf8');

        const result = await handler.multiReplaceFileContent({
            TargetFile: fileAbs,
            Instruction: 'sub-agent edit',
            ReplacementChunks: [{
                StartLine: 2,
                EndLine: 2,
                TargetContent: '\tid = kuat.1',
                ReplacementContent: '\tid = kuat.2',
            }],
        }, {
            runnerOptions: {
                topicId: 'topic-123',
                useSlimPrompt: true,
                forceAutoApplyWrites: true,
                abortSignal: new AbortController().signal,
            },
        } as any) as any;

        expect(result.success).to.equal(true);
        expect(pendingWrite.called).to.equal(false);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('id = kuat.2');
    });
});

describe('agent sprite candidate tool contract', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        cleanupWorkspace(workspaceRoot);
    });

    it('registers find_sprite_candidates as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'find_sprite_candidates');
        if (!definition) {
            throw new Error('find_sprite_candidates tool definition is missing');
        }
        expect(definition.function.description).to.include('Expected value of type sprite');
        expect(definition.function.parameters.properties).to.have.property('searchContext');
    });

    it('registers find_sound_candidates as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'find_sound_candidates');
        if (!definition) {
            throw new Error('find_sound_candidates tool definition is missing');
        }
        expect(definition.function.description).to.include('show_sound');
        expect(definition.function.parameters.properties).to.have.property('searchContext');
    });

    it('registers query_localisation_index as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'query_localisation_index');
        if (!definition) {
            throw new Error('query_localisation_index tool definition is missing');
        }
        expect(definition.function.description).to.include('shared incremental localisation index');
        expect(definition.function.parameters.properties).to.have.property('prefix');
    });

    it('registers query_workspace_index as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'query_workspace_index');
        if (!definition) {
            throw new Error('query_workspace_index tool definition is missing');
        }
        expect(definition.function.description).to.include('shared incremental workspace index');
        expect(definition.function.parameters.properties).to.have.property('kind');
        expect(definition.function.parameters.properties).to.have.property('source');
    });

    it('queries the shared localisation index when IndexService is provided', async () => {
        const fakeIndexService = {
            status: 'ready',
            queryLocalisation: (query: any) => [{
                key: query.key,
                value: 'Hello',
                file: path.join('localisation', 'test_l_english.yml'),
                line: 2,
                language: query.language || 'l_english',
            }],
        };
        const executor = new AgentToolExecutor({} as any, workspaceRoot, fakeIndexService as any);

        const result = await executor.execute('query_localisation_index', {
            key: 'my_key',
            language: 'l_english',
        }) as any;

        expect(result.status).to.equal('ready');
        expect(result.totalCount).to.equal(1);
        expect(result.entries[0].key).to.equal('my_key');
    });

    it('returns unavailable localisation index result without IndexService', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('query_localisation_index', { key: 'my_key' }) as any;

        expect(result.status).to.equal('unavailable');
        expect(result.entries).to.deep.equal([]);
    });

    it('queries the shared workspace symbol index when IndexService is provided', async () => {
        const fakeIndexService = {
            status: 'ready',
            queryWorkspaceSymbols: (query: any) => [{
                name: query.name,
                kind: query.kind || 'event',
                category: query.category || 'event',
                file: path.join('events', 'test.txt'),
                line: 3,
                source: query.source || 'script',
                container: 'country_event',
            }],
            workspaceSymbolCount: 42,
        };
        const executor = new AgentToolExecutor({} as any, workspaceRoot, fakeIndexService as any);

        const result = await executor.execute('query_workspace_index', {
            name: 'kuat.100',
            kind: 'event',
            exact: true,
        }) as any;

        expect(result.status).to.equal('ready');
        expect(result.totalCount).to.equal(1);
        expect(result.entries[0].name).to.equal('kuat.100');
        expect(result.entries[0].category).to.equal('event');
        expect(result.indexedSymbolNames).to.equal(42);
    });

    it('returns unavailable workspace index result without IndexService', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('query_workspace_index', { name: 'kuat.100' }) as any;

        expect(result.status).to.equal('unavailable');
        expect(result.entries).to.deep.equal([]);
    });

    it('parses project .gfx spriteType candidates and ranks event pictures', async () => {
        const lspTools = require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
        const interfaceDir = path.join(workspaceRoot, 'interface');
        fs.mkdirSync(interfaceDir, { recursive: true });
        fs.writeFileSync(path.join(interfaceDir, 'kuat_eventpictures.gfx'), [
            'spriteTypes = {',
            '    spriteType = {',
            '        name = "GFX_evt_kuat_force_echo"',
            '        texturefile = "gfx/event_pictures/kuat_force_echo.dds"',
            '    }',
            '    spriteType = {',
            '        name = "GFX_kuat_button_icon"',
            '        texturefile = "gfx/interface/icons/kuat_button.dds"',
            '    }',
            '}',
        ].join('\n'), 'utf8');

        const handler = new lspTools.LspToolHandler(
            { workspaceRoot },
            () => ({}) as any,
            fileTools.findFiles,
        );
        const result = await handler.findSpriteCandidates({
            currentValue: 'GFX_evt_kuat_missing_echo',
            query: 'kuat force echo',
            fieldName: 'picture',
            searchContext: 'mod',
            limit: 5,
        });

        expect(result.candidates.map(c => c.name)).to.include('GFX_evt_kuat_force_echo');
        expect(result.candidates[0]!.name).to.equal('GFX_evt_kuat_force_echo');
        expect(result.candidates[0]!.textureFile).to.include('event_pictures');
    });

    it('parses project .asset sound candidates for show_sound repairs', async () => {
        const lspTools = require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
        const soundDir = path.join(workspaceRoot, 'sound');
        fs.mkdirSync(soundDir, { recursive: true });
        fs.writeFileSync(path.join(soundDir, 'kuat_sounds.asset'), [
            'sounds = {',
            '    sound = {',
            '        name = "kuat_force_echo_reveal"',
            '        file = "sound/event/kuat_force_echo_reveal.wav"',
            '    }',
            '    music = {',
            '        name = "kuat_force_theme"',
            '        file = "music/kuat_force_theme.ogg"',
            '    }',
            '}',
        ].join('\n'), 'utf8');

        const handler = new lspTools.LspToolHandler(
            { workspaceRoot },
            () => ({}) as any,
            fileTools.findFiles,
        );
        const result = await handler.findSoundCandidates({
            currentValue: 'kuat_force_echo_missing',
            query: 'kuat force echo reveal',
            fieldName: 'show_sound',
            searchContext: 'mod',
            limit: 5,
        });

        expect(result.candidates.map(c => c.name)).to.include('kuat_force_echo_reveal');
        expect(result.candidates[0]!.name).to.equal('kuat_force_echo_reveal');
        expect(result.candidates[0]!.fileRef).to.include('.wav');
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

    it('relativizes quoted workspace script paths before running commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, '!!! WIP', 'tools');
        const scriptPath = path.join(scriptDir, 'TRTE_btn_gen.js');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(scriptPath, 'console.log("ran script");\n', 'utf8');

        const result = await handler.runCommand({
            command: `node "${scriptPath}"`,
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.exitCode).to.equal(0);
        expect(result.stdout).to.include('ran script');
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
