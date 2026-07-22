import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

let stubFlags: Record<string, boolean> = {};
let stubEditorLanguageId: string | undefined;

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        getConfiguration: () => ({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (key in stubFlags) return stubFlags[key] as T;
                return defaultValue;
            },
        }),
    },
    window: {
        get activeTextEditor() {
            return stubEditorLanguageId ? { document: { languageId: stubEditorLanguageId } } : undefined;
        },
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

function loadPromptBuilderModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/promptBuilder')];
        return require('../../extension/ai/promptBuilder') as typeof import('../../extension/ai/promptBuilder');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('PromptBuilder frozen prompt fingerprint cache (plan §7.1)', () => {
    let workspaceRoot: string;
    let storageRoot: string;
    let extensionRoot: string;

    beforeEach(() => {
        stubFlags = {};
        stubEditorLanguageId = undefined;
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-prompt-ws-'));
        storageRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-prompt-storage-'));
        extensionRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-prompt-ext-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
        fs.writeFileSync(path.join(workspaceRoot, 'CWTOOLS.md'), '# CWTOOLS\n\n## Mod Info\n- **Name**: TestMod\n', 'utf8');
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(storageRoot, { recursive: true, force: true });
        fs.rmSync(extensionRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
    });

    function makeBuilder() {
        const { PromptBuilder } = loadPromptBuilderModule();
        return new PromptBuilder(workspaceRoot, storageRoot, extensionRoot);
    }

    it('serves a byte-identical cached prompt on identical inputs (cold then hit)', () => {
        const builder = makeBuilder();
        const first = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });
        let stats = builder.getFrozenPromptCacheStats();
        expect(stats.misses).to.equal(1);
        expect(stats.missReasons.cold).to.equal(1);

        const second = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });
        expect(second).to.equal(first);
        stats = builder.getFrozenPromptCacheStats();
        expect(stats.hits).to.equal(1);
        expect(stats.size).to.equal(1);
    });

    it('invalidates with rules_changed when CWTOOLS.md content changes', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });

        fs.writeFileSync(path.join(workspaceRoot, 'CWTOOLS.md'), '# CWTOOLS\n\n## Mod Info\n- **Name**: RenamedMod\n', 'utf8');
        const rebuilt = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });

        expect(rebuilt).to.include('RenamedMod');
        expect(builder.getFrozenPromptCacheStats().missReasons.rules_changed).to.equal(1);
    });

    it('re-reads CWTOOLS.md after invalidateProjectPromptInputs even when mtime is unchanged', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });

        // Simulate an edit hidden by mtime granularity: same mtime, new content.
        const rulesPath = path.join(workspaceRoot, 'CWTOOLS.md');
        const before = fs.statSync(rulesPath);
        fs.writeFileSync(rulesPath, '# CWTOOLS\n\n## Mod Info\n- **Name**: SilentEdit\n', 'utf8');
        fs.utimesSync(rulesPath, before.atime, before.mtime);

        builder.invalidateProjectPromptInputs();
        const rebuilt = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });
        expect(rebuilt).to.include('SilentEdit');
        expect(builder.getFrozenPromptCacheStats().missReasons.rules_changed).to.equal(1);
    });

    it('invalidates with flag_changed when a prompt-affecting flag flips', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });

        stubFlags.fullProjectRulesInBuild = true;
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });

        expect(builder.getFrozenPromptCacheStats().missReasons.flag_changed).to.equal(1);
    });

    it('invalidates with toolset_changed when the tool set hash changes', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-b' });

        expect(builder.getFrozenPromptCacheStats().missReasons.toolset_changed).to.equal(1);
    });

    it('rebuild:true forces a rebuild and counts a rebuild miss', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', rebuild: true });

        const stats = builder.getFrozenPromptCacheStats();
        expect(stats.missReasons.rebuild).to.equal(1);
        expect(stats.hits).to.equal(0);
        // The rebuilt entry is cached again for subsequent calls.
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });
        expect(builder.getFrozenPromptCacheStats().hits).to.equal(1);
    });

    it('resolves the real game id into the fingerprint when languageId is omitted', () => {
        const builder = makeBuilder();
        stubEditorLanguageId = 'stellaris';
        const stellarisPrompt = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });
        expect(stellarisPrompt).to.include('Stellaris');

        stubEditorLanguageId = 'eu4';
        const eu4Prompt = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a' });

        expect(eu4Prompt).to.not.equal(stellarisPrompt);
        // A different game identity is a new cache identity, not a mutation.
        expect(builder.getFrozenPromptCacheStats().missReasons.cold).to.equal(2);
    });

    it('reports evicted when an identical fingerprint lost its LRU entry', () => {
        const builder = makeBuilder();
        // FROZEN_PROMPT_CACHE_MAX is 32: 33 distinct providers evict the first entry.
        for (let i = 0; i < 33; i++) {
            builder.buildFrozenSystemPrompt('build', `provider-${i}`, undefined, { toolsetHash: 'tools-a' });
        }
        expect(builder.getFrozenPromptCacheStats().size).to.equal(32);
        expect(builder.getFrozenPromptCacheStats().missReasons.cold).to.equal(33);

        builder.buildFrozenSystemPrompt('build', 'provider-0', undefined, { toolsetHash: 'tools-a' });
        expect(builder.getFrozenPromptCacheStats().missReasons.evicted).to.equal(1);
    });

    it('keeps the cache bounded at FROZEN_PROMPT_CACHE_MAX', () => {
        const builder = makeBuilder();
        for (let i = 0; i < 40; i++) {
            builder.buildFrozenSystemPrompt('build', `provider-${i}`, undefined, { toolsetHash: 'tools-a' });
        }
        expect(builder.getFrozenPromptCacheStats().size).to.be.at.most(32);
    });

    it('uses separate frozen prompt identities for General and Paradox domains in a shared mode', () => {
        const builder = makeBuilder();
        const general = builder.buildFrozenSystemPrompt('plan', 'deepseek', undefined, {
            toolsetHash: 'general-tools',
            domain: 'general',
        });
        const paradox = builder.buildFrozenSystemPrompt('plan', 'deepseek', undefined, {
            toolsetHash: 'paradox-tools',
            domain: 'paradox',
        });

        expect(general).to.not.include('CWT/LSP');
        expect(paradox).to.include('CWT/LSP');
        expect(general).to.not.equal(paradox);
        expect(builder.getFrozenPromptCacheStats().size).to.equal(2);
    });
});

describe('orderMessagesForStablePrefix (plan §7.2)', () => {
    it('places dynamic editor/project state after history and before the user turn', () => {
        const { orderMessagesForStablePrefix } = loadPromptBuilderModule();
        const messages = orderMessagesForStablePrefix({
            systemPrompt: 'FROZEN_SYSTEM',
            compactedHistory: [
                { role: 'user', content: 'HISTORY_USER' },
                { role: 'assistant', content: 'HISTORY_ASSISTANT' },
            ],
            contextMessages: [{ role: 'system', content: 'EDITOR_CONTEXT' }],
            dynamicBlock: [{ role: 'user', content: 'DYNAMIC_BLOCK' }],
            userContent: 'USER_INPUT',
        });

        expect(messages.map(m => m.content)).to.deep.equal([
            'FROZEN_SYSTEM',
            'HISTORY_USER',
            'HISTORY_ASSISTANT',
            'EDITOR_CONTEXT',
            'DYNAMIC_BLOCK',
            'USER_INPUT',
        ]);
        expect(messages[0]!.role).to.equal('system');
        expect(messages[messages.length - 1]!.role).to.equal('user');
        // The dynamic editor context must not sit between the stable system
        // prompt and the cacheable history.
        const editorIndex = messages.findIndex(m => m.content === 'EDITOR_CONTEXT');
        const historyIndex = messages.findIndex(m => m.content === 'HISTORY_ASSISTANT');
        const userIndex = messages.findIndex(m => m.content === 'USER_INPUT');
        expect(editorIndex).to.be.greaterThan(historyIndex);
        expect(editorIndex).to.be.lessThan(userIndex);
    });
});

describe('hashToolDefinitionsForFingerprint (plan §7.1)', () => {
    it('changes with tool names and required lists but not descriptions', () => {
        const { hashToolDefinitionsForFingerprint } = loadPromptBuilderModule();
        const makeTool = (name: string, required: string[], description: string) => ({
            type: 'function' as const,
            function: { name, description, parameters: { type: 'object', required, properties: {} } },
        });
        const base = hashToolDefinitionsForFingerprint([makeTool('read_file', ['path'], 'Reads a file')]);
        const same = hashToolDefinitionsForFingerprint([makeTool('read_file', ['path'], 'Rewritten description text')]);
        const renamed = hashToolDefinitionsForFingerprint([makeTool('write_file', ['path'], 'Reads a file')]);
        const requiredChanged = hashToolDefinitionsForFingerprint([makeTool('read_file', ['path', 'encoding'], 'Reads a file')]);

        expect(same).to.equal(base);
        expect(renamed).to.not.equal(base);
        expect(requiredChanged).to.not.equal(base);
    });
});
