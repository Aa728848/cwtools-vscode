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
            permissionPolicy: require('../../extension/ai/runner/permissionPolicy') as typeof import('../../extension/ai/runner/permissionPolicy'),
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { fileTools, externalTools, agentTools, agentRunner, permissionPolicy } = loadToolModules();
const { FileToolHandler } = fileTools;
const { ExternalToolHandler } = externalTools;
const { AgentToolExecutor, TOOL_DEFINITIONS } = agentTools;
const { getAgentToolTargetFiles, SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS } = agentRunner;
const { PermissionPolicyStore } = permissionPolicy;
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

    it('rejects generic PDX edits that would unbalance brace structure', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'common', 'buildings', 'guarded_buildings.txt');
        const original = 'building_guarded = {\n\tcost = { minerals = 100 }\n}\n';
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, original, 'utf8');

        const writeResult = await handler.writeFile({
            file: fileAbs,
            content: 'building_guarded = {\n\tcost = { minerals = 200 }\n',
        }, makeContext()) as any;
        expect(writeResult.success).to.equal(false);
        expect(writeResult.message).to.include('PDX brace structure');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal(original);

        const replaceResult = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 3,
            endLine: 3,
            newContent: '',
        }, makeContext()) as any;
        expect(replaceResult.success).to.equal(false);
        expect(replaceResult.message).to.include('PDX brace structure');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal(original);

        const multiReplaceResult = await handler.multiReplaceFileContent({
            TargetFile: fileAbs,
            Instruction: 'remove the block terminator',
            ReplacementChunks: [{
                StartLine: 3,
                EndLine: 3,
                TargetContent: '}',
                ReplacementContent: '',
            }],
        }, makeContext()) as any;
        expect(multiReplaceResult.success).to.equal(false);
        expect(multiReplaceResult.message).to.include('PDX brace structure');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal(original);

        const patchResult = await handler.applyPatch({
            patch: [
                '--- a/common/buildings/guarded_buildings.txt',
                '+++ b/common/buildings/guarded_buildings.txt',
                '@@',
                '-building_guarded = {',
                '-\tcost = { minerals = 100 }',
                '-}',
                '+building_guarded = {',
                '+\tcost = { minerals = 100 }',
                '',
            ].join('\n'),
        }, makeContext());
        expect(patchResult.success).to.equal(false);
        expect(patchResult.errors.join('\n')).to.include('PDX brace structure');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal(original);
    });

    it('ignores PDX brace-like text in strings and comments during edit safety checks', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'string_braces_events.txt');
        const original = 'country_event = {\n\ttitle = "old { title }"\n\t# } comment brace\n}\n';
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, original, 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            newContent: '\ttitle = "new } title {"\n\t# { comment brace',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('title = "new } title {"');
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

    it('registers query_project_profile as a first-class read-only tool', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'query_project_profile');
        if (!definition) {
            throw new Error('query_project_profile tool definition is missing');
        }
        expect(definition.function.description).to.include('Agent project profile');
        expect(definition.function.parameters.properties).to.have.property('section');
        expect(definition.function.parameters.properties).to.have.property('mode');
    });

    it('tells dispatch_agents to declare known Builder plannedFiles', () => {
        const definition = TOOL_DEFINITIONS.find((tool: any) => tool.function.name === 'dispatch_agents');
        if (!definition) {
            throw new Error('dispatch_agents tool definition is missing');
        }

        const taskProperties = (definition.function.parameters.properties as any).tasks.items.properties;
        expect((definition.function.parameters.properties as any).tasks.maxItems).to.equal(8);
        expect(taskProperties.plannedFiles.description).to.include('Provide this for Builder tasks');
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
        let ensureArgs: any;
        const fakeIndexService = {
            status: 'ready',
            ensureWorkspaceSymbolsReady: async (args: any) => {
                ensureArgs = args;
            },
            queryWorkspaceSymbols: (query: any) => [{
                name: query.name,
                kind: query.kind || 'event',
                category: query.category || 'event',
                file: path.join('events', 'test.txt'),
                line: 3,
                source: query.source || 'script',
                container: 'country_event',
                references: query.includeReferences ? [{ file: path.join('events', 'test.txt'), line: 8, context: 'fire_only_once = yes' }] : undefined,
                updatedAt: 1000,
                fileVersion: 7,
            }],
            workspaceSymbolCount: 42,
            workspaceSymbolUpdatedAt: 2000,
        };
        const executor = new AgentToolExecutor({} as any, workspaceRoot, fakeIndexService as any);

        const result = await executor.execute('query_workspace_index', {
            name: 'kuat.100',
            kind: 'event',
            exact: true,
            includeReferences: true,
        }) as any;

        expect(result.status).to.equal('ready');
        expect(result.totalCount).to.equal(1);
        expect(result.entries[0].name).to.equal('kuat.100');
        expect(result.entries[0].category).to.equal('event');
        expect(result.entries[0].references).to.have.lengthOf(1);
        expect(result.entries[0].fileVersion).to.equal(7);
        expect(result.indexedSymbolNames).to.equal(42);
        expect(result.indexUpdatedAt).to.equal(2000);
        expect(ensureArgs).to.deep.equal({ includeVanilla: true });
    });

    it('returns unavailable workspace index result without IndexService', async () => {
        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('query_workspace_index', { name: 'kuat.100' }) as any;

        expect(result.status).to.equal('unavailable');
        expect(result.entries).to.deep.equal([]);
    });

    it('queries the /init project profile without scanning the workspace', async () => {
        const profileDir = path.join(workspaceRoot, '.cwtools-ai', 'project');
        fs.mkdirSync(profileDir, { recursive: true });
        fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-05-24T00:00:00.000Z',
            workspaceRoot,
            workspaceKind: 'paradox_mod',
            projectName: 'Kuat',
            game: { id: 'stellaris', displayName: 'Stellaris', confidence: 'high', evidence: ['test'] },
            keyDirectories: [{ key: 'events', path: 'events', exists: true, fileCount: 1 }],
            localisation: { roots: ['localisation'], languages: ['l_english'], encoding: 'UTF-8 with BOM', sampleFiles: [] },
            identifiers: {
                namespaces: ['kuat'],
                variablePrefixes: ['@kuat_'],
                scriptedTriggers: [],
                scriptedEffects: [],
                events: ['kuat.1'],
                onActions: [],
                staticModifiers: [],
            },
            routing: {
                recommendedWorkflowByIntent: [],
                preferredReadTools: ['query_project_profile'],
                avoidPatterns: [],
            },
            validation: { lspReady: 'unknown', indexStatus: 'unknown', vanillaCache: 'unknown' },
            promptCards: { build: 'Build card' },
            efficiencyHints: ['Use profile first'],
        }), 'utf8');

        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const result = await executor.execute('query_project_profile', { section: 'summary', mode: 'build' }) as any;

        expect(result.status).to.equal('ready');
        expect(result.summary).to.include('Project: Kuat');
        expect(result.promptCard).to.equal('Build card');
        expect(result.data.workspaceKind).to.equal('paradox_mod');
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

    it('uses IndexService sprite candidates before falling back to file scans', async () => {
        const lspTools = require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
        const handler = new lspTools.LspToolHandler(
            {
                workspaceRoot,
                indexService: {
                    queryWorkspaceSymbols: () => [{
                        name: 'GFX_evt_indexed_force_echo',
                        kind: 'sprite',
                        category: 'asset',
                        source: 'asset',
                        file: path.join(workspaceRoot, 'interface', 'indexed.gfx'),
                        line: 4,
                        container: 'spriteType',
                        references: [{ file: 'indexed.gfx', line: 5, context: 'texturefile = "gfx/event_pictures/indexed_force_echo.dds"' }],
                    }],
                },
            } as any,
            () => ({}) as any,
            () => [],
        );
        const result = await handler.findSpriteCandidates({
            query: 'indexed force echo',
            fieldName: 'picture',
            searchContext: 'mod',
            limit: 5,
        });

        expect(result.candidates[0]!.name).to.equal('GFX_evt_indexed_force_echo');
        expect(result.candidates[0]!.matchedBy).to.include('workspace-index');
        expect(result.searchedRoots).to.include('IndexService:workspaceSymbolIndex');
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

    it('maps legacy scratch paths into the current topic scratch directory for commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools-ai', 'media-topic', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'helper.js');
        fs.writeFileSync(targetPath, 'console.log("ok");\n', 'utf8');

        const result = await handler.runCommand({
            command: 'node ".cwtools-ai/scratch/helper.js"',
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
        expect(result.stdout).to.include('ok');
    });

    it('normalizes backslash-escaped quoted scratch script paths before running commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools-ai', 'media-topic', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'agent_helper.js');
        fs.writeFileSync(targetPath, 'console.log("escaped ok");\n', 'utf8');

        const result = await handler.runCommand({
            command: 'node \\".cwtools-ai/scratch/agent_helper.js\\"',
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
        expect(result.stdout).to.include('escaped ok');
    });

    it('normalizes one-sided escaped quoted topic scratch script paths before running commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools-ai', 'topic_1779112553395', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'search_fallen.js');
        fs.writeFileSync(targetPath, 'console.log("topic escaped ok");\n', 'utf8');

        const result = await handler.runCommand({
            command: 'node \\".cwtools-ai\\topic_1779112553395\\scratch\\search_fallen.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'topic_1779112553395',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('topic escaped ok');
    });

    it('normalizes one-sided escaped quoted topic scratch paths for PowerShell commands', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools-ai', 'topic_1779112553395', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'search_fallen.txt');
        fs.writeFileSync(targetPath, 'powershell path ok\n', 'utf8');

        const result = await handler.runCommand({
            command: 'Get-Content \\".cwtools-ai\\topic_1779112553395\\scratch\\search_fallen.txt"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'topic_1779112553395',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('powershell path ok');
    });

    it('uses PowerShell for normal Windows commands instead of cmd quoting', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const topicScratch = path.join(workspaceRoot, '.cwtools-ai', 'topic_1779112553395', 'scratch');
        fs.mkdirSync(topicScratch, { recursive: true });
        const targetPath = path.join(topicScratch, 'search_fallen.txt');
        fs.writeFileSync(targetPath, 'normal powershell path ok\n', 'utf8');

        const result = await handler.runCommand({
            command: 'Get-Content \\".cwtools-ai\\topic_1779112553395\\scratch\\search_fallen.txt"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                topicId: 'topic_1779112553395',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(result.stdout).to.include('normal powershell path ok');
    });

    it('classifies PowerShell read-only commands as safe auto-run commands', () => {
        const handler = new ExternalToolHandler({ workspaceRoot }) as any;

        expect(handler.isReadOnlyRunCommand('Select-String -Path "common/buildings/*.txt" -Pattern "planet"')).to.equal(true);
        expect(handler.isReadOnlyRunCommand('Get-ChildItem -Path "common" -Recurse -Filter *.txt | Select-String -Pattern "trigger"')).to.equal(true);
        expect(handler.isReadOnlyRunCommand('Get-Content "common/test.txt" | Select-Object -First 20')).to.equal(true);
        expect(handler.isReadOnlyRunCommand('Select-String -Path "common/*.txt" -Pattern "planet" | Set-Content out.txt')).to.equal(false);
    });

    it('does not request permission for read-only run_command invocations', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        let permissionRequested = false;

        const result = await handler.runCommand({
            command: 'ls .',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => {
                permissionRequested = true;
                return false;
            },
        } as any);

        expect(permissionRequested).to.equal(false);
        expect(result.stderr).to.not.include('no permission handler configured');
    });

    it('does not let a low-risk permission rule bypass higher-risk command preflight', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const policy = PermissionPolicyStore.getInstance();
        policy.clear();
        policy.addRule({
            tool: 'run_command',
            commandPrefix: ['node'],
            cwdScope: workspaceRoot,
            riskMax: 1,
            sessionOnly: true,
        });

        let permissionRequested = false;
        const result = await handler.runCommand({
            command: 'node -e "console.log(\'should not auto approve\')"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => {
                permissionRequested = true;
                return false;
            },
        } as any);

        expect(permissionRequested).to.equal(true);
        expect(result.exitCode).to.equal(1);
        policy.clear();
    });

    it('records project file changes made by a command for the diff panel', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'change-file.js');
        const targetPath = path.join(workspaceRoot, 'config.txt');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(targetPath, 'before\n', 'utf8');
        fs.writeFileSync(scriptPath, [
            "const fs = require('fs');",
            "fs.writeFileSync('config.txt', 'after\\n', 'utf8');",
            "console.log('changed');",
        ].join('\n'), 'utf8');

        const snapshots: Array<{ filePath: string; previousContent: string | null }> = [];
        const result = await handler.runCommand({
            command: 'node "tools/change-file.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
            onBeforeFileWrite: (filePath: string, previousContent: string | null) => {
                snapshots.push({ filePath, previousContent });
            },
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(fs.readFileSync(targetPath, 'utf8')).to.equal('after\n');
        expect(snapshots).to.deep.include({ filePath: targetPath, previousContent: 'before\n' });
    });

    it('omits temporary helper scripts from command-recorded workspace changes', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'create-temp-and-change.js');
        const targetPath = path.join(workspaceRoot, 'config.txt');
        const helperPath = path.join(workspaceRoot, 'agent_helper.py');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(targetPath, 'before\n', 'utf8');
        fs.writeFileSync(scriptPath, [
            "const fs = require('fs');",
            "fs.writeFileSync('config.txt', 'after\\n', 'utf8');",
            "fs.writeFileSync('agent_helper.py', 'print(\"temporary\")\\n', 'utf8');",
        ].join('\n'), 'utf8');

        const snapshots: Array<{ filePath: string; previousContent: string | null }> = [];
        const result = await handler.runCommand({
            command: 'node "tools/create-temp-and-change.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
            onBeforeFileWrite: (filePath: string, previousContent: string | null) => {
                snapshots.push({ filePath, previousContent });
            },
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(fs.existsSync(helperPath)).to.equal(true);
        expect(snapshots).to.deep.include({ filePath: targetPath, previousContent: 'before\n' });
        expect(snapshots.some(snapshot => snapshot.filePath === helperPath)).to.equal(false);
    });

    it('still records edits to existing project scripts with helper-like names', async () => {
        const handler = new ExternalToolHandler({ workspaceRoot });
        const scriptDir = path.join(workspaceRoot, 'tools');
        const scriptPath = path.join(scriptDir, 'modify-existing-helper.js');
        const helperPath = path.join(workspaceRoot, 'helper.py');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(helperPath, 'print("before")\n', 'utf8');
        fs.writeFileSync(scriptPath, [
            "const fs = require('fs');",
            "fs.writeFileSync('helper.py', 'print(\"after\")\\n', 'utf8');",
        ].join('\n'), 'utf8');

        const snapshots: Array<{ filePath: string; previousContent: string | null }> = [];
        const result = await handler.runCommand({
            command: 'node "tools/modify-existing-helper.js"',
            timeoutMs: 10000,
        }, {
            runnerOptions: {
                mode: 'utility',
                topicId: 'media-topic',
                abortSignal: new AbortController().signal,
            },
            onPermissionRequest: async () => true,
            onBeforeFileWrite: (filePath: string, previousContent: string | null) => {
                snapshots.push({ filePath, previousContent });
            },
        } as any);

        if (result.exitCode !== 0) {
            throw new Error(`runCommand failed: ${result.stderr || result.stdout}`);
        }
        expect(snapshots).to.deep.include({ filePath: helperPath, previousContent: 'print("before")\n' });
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

    it('routes dynamic MCP tool names without treating them as unknown registry tools', async () => {
        const executor = createExecutor();
        const executeInternal = sinon.stub(executor as any, 'executeInternal').resolves({ success: true, routed: true });

        const result = await executor.execute('mcp_filesystem_read_file', { path: 'README.md' }, {
            runnerOptions: { mode: 'build' },
        } as any) as any;

        expect(result).to.deep.include({ success: true, routed: true });
        expect(executeInternal.calledOnce).to.equal(true);
        expect(executeInternal.firstCall.args[0]).to.equal('mcp_filesystem_read_file');
    });

    it('keeps generic mcp_call behind normal registry mode validation', async () => {
        const executor = createExecutor();
        const executeInternal = sinon.stub(executor as any, 'executeInternal').resolves({ success: true });

        const result = await executor.execute('mcp_call', { server: 'filesystem', tool: 'read_file' }, {
            runnerOptions: { mode: 'build' },
        } as any) as any;

        expect(result.success).to.equal(false);
        expect(result.error).to.include("Tool 'mcp_call' is not allowed in current mode 'build'");
        expect(executeInternal.called).to.equal(false);
    });

    it('keeps sub-agent git and command tools out of the runtime', async () => {
        const executor = createExecutor();
        const executeInternal = sinon.stub(executor as any, 'executeInternal').resolves({ success: true });
        const context = {
            runnerOptions: {
                mode: 'build',
                useSlimPrompt: true,
            },
        } as any;

        const gitResult = await executor.execute('git_ops', { operation: 'status' }, context) as any;
        const commandResult = await executor.execute('run_command', { command: 'git status' }, context) as any;

        expect(gitResult.success).to.equal(false);
        expect(gitResult.message).to.include('git_ops is disabled');
        expect(commandResult.success).to.equal(false);
        expect(commandResult.message).to.include('run_command is disabled');
        expect(commandResult.message).to.include('BLOCKED_FOR_ORCHESTRATOR');
        expect(executeInternal.called).to.equal(false);
    });
});
