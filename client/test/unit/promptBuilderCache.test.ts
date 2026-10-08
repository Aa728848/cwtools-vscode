import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-prompt-cache');

let stubFlags: Record<string, unknown> = {};
let stubEditorLanguageId: string | undefined;
const STELLARIS_CACHE_KEY = 'cache.stellaris';
const GAME_ROOT_SECTION = '## Configured vanilla read roots';
const OLD_VANILLA_ROOT = 'D:\\Games\\Stellaris';
const NEW_VANILLA_ROOT = 'E:\\Games\\Stellaris';

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

/**
 * Every module that reads this stub's configuration through the frozen prompt
 * path. A module keeps the vscode object it was bound to for the rest of the
 * process, so whichever suite loaded them first would otherwise decide which
 * configuration these tests see. They are reloaded together here and their
 * previous cache entries restored afterwards, so this suite neither depends on
 * load order nor leaves a stub-bound copy behind.
 */
const RELOADED_MODULES = [
    '../../extension/configuredGameRoots',
    '../../extension/ai/prompt/sections/gameRoots',
    '../../extension/ai/promptBuilder',
];

function loadPromptBuilderModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    const saved = new Map<string, NodeModule | undefined>();
    try {
        for (const id of RELOADED_MODULES) {
            const resolved = require.resolve(id);
            saved.set(resolved, require.cache[resolved]);
            delete require.cache[resolved];
        }
        return require('../../extension/ai/promptBuilder') as typeof import('../../extension/ai/promptBuilder');
    } finally {
        moduleLoader._load = originalLoad;
        for (const id of RELOADED_MODULES) {
            const resolved = require.resolve(id);
            delete require.cache[resolved];
            const previous = saved.get(resolved);
            if (previous) require.cache[resolved] = previous;
        }
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
        const first = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        let stats = builder.getFrozenPromptCacheStats();
        expect(stats.misses).to.equal(1);
        expect(stats.missReasons.cold).to.equal(1);

        const second = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(second).to.equal(first);
        stats = builder.getFrozenPromptCacheStats();
        expect(stats.hits).to.equal(1);
        expect(stats.size).to.equal(1);
    });

    it('invalidates with rules_changed when CWTOOLS.md content changes', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });

        fs.writeFileSync(path.join(workspaceRoot, 'CWTOOLS.md'), '# CWTOOLS\n\n## Mod Info\n- **Name**: RenamedMod\n', 'utf8');
        const rebuilt = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });

        expect(rebuilt).to.include('RenamedMod');
        expect(builder.getFrozenPromptCacheStats().missReasons.rules_changed).to.equal(1);
    });

    it('re-reads CWTOOLS.md after invalidateProjectPromptInputs even when mtime is unchanged', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });

        // Simulate an edit hidden by mtime granularity: same mtime, new content.
        const rulesPath = path.join(workspaceRoot, 'CWTOOLS.md');
        const before = fs.statSync(rulesPath);
        fs.writeFileSync(rulesPath, '# CWTOOLS\n\n## Mod Info\n- **Name**: SilentEdit\n', 'utf8');
        fs.utimesSync(rulesPath, before.atime, before.mtime);

        builder.invalidateProjectPromptInputs();
        const rebuilt = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(rebuilt).to.include('SilentEdit');
        expect(builder.getFrozenPromptCacheStats().missReasons.rules_changed).to.equal(1);
    });

    it('invalidates with flag_changed when a prompt-affecting flag flips', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });

        stubFlags.includeFullSmallFiles = true;
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });

        expect(builder.getFrozenPromptCacheStats().missReasons.flag_changed).to.equal(1);
    });

    it('invalidates with toolset_changed when the tool set hash changes', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-b', domain: 'paradox' });

        expect(builder.getFrozenPromptCacheStats().missReasons.toolset_changed).to.equal(1);
    });


    it('invalidates with game_roots_changed when a configured vanilla root moves', () => {
        stubFlags[STELLARIS_CACHE_KEY] = OLD_VANILLA_ROOT;
        const builder = makeBuilder();
        const first = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(first).to.include(GAME_ROOT_SECTION);
        expect(first).to.include(OLD_VANILLA_ROOT);
        const firstHash = builder.getLastFrozenPromptFingerprintHash();

        stubFlags[STELLARIS_CACHE_KEY] = NEW_VANILLA_ROOT;
        const rebuilt = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });

        // The cached prompt named the previous install path, so the model would
        // hand a dead path to read_file; the new entry must name the new one.
        expect(rebuilt).to.include(NEW_VANILLA_ROOT);
        expect(rebuilt).to.not.include(OLD_VANILLA_ROOT);
        expect(builder.getLastFrozenPromptFingerprintHash()).to.not.equal(firstHash);
        expect(builder.getLastFrozenPromptLookup()).to.deep.equal({ hit: false, missReason: 'game_roots_changed' });
        const stats = builder.getFrozenPromptCacheStats();
        expect(stats.missReasons.game_roots_changed).to.equal(1);
        expect(stats.hits).to.equal(0);
    });

    it('invalidates with game_roots_changed when a root is added and again when it is removed', () => {
        stubFlags[STELLARIS_CACHE_KEY] = OLD_VANILLA_ROOT;
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });

        stubFlags['cache.eu4'] = NEW_VANILLA_ROOT;
        const withTwoRoots = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(withTwoRoots).to.include(OLD_VANILLA_ROOT);
        expect(withTwoRoots).to.include(NEW_VANILLA_ROOT);

        stubFlags[STELLARIS_CACHE_KEY] = undefined;
        stubFlags['cache.eu4'] = undefined;
        const withoutRoots = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(withoutRoots).to.not.include(GAME_ROOT_SECTION);
        expect(withoutRoots).to.not.include(OLD_VANILLA_ROOT);

        expect(builder.getFrozenPromptCacheStats().missReasons.game_roots_changed).to.equal(2);
    });

    it('keeps hitting the cache while the configured vanilla root is unchanged', () => {
        stubFlags[STELLARIS_CACHE_KEY] = OLD_VANILLA_ROOT;
        const builder = makeBuilder();
        const first = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        const firstHash = builder.getLastFrozenPromptFingerprintHash();

        const second = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        const third = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });

        expect(second).to.equal(first);
        expect(third).to.equal(first);
        expect(builder.getLastFrozenPromptFingerprintHash()).to.equal(firstHash);
        const stats = builder.getFrozenPromptCacheStats();
        expect(stats.hits).to.equal(2);
        expect(stats.misses).to.equal(1);
        expect(stats.missReasons.cold).to.equal(1);
        expect(stats.missReasons.game_roots_changed).to.equal(undefined);
        expect(stats.size).to.equal(1);
    });

    it('adds neither prompt bytes nor misses when no vanilla root is configured', () => {
        const builder = makeBuilder();
        const frozen = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        // The direct build is what a cold build produces: the new fingerprint
        // component must not reach the prompt text.
        const direct = builder.buildSystemPromptForMode('build', 'deepseek', 'stellaris', undefined, undefined, undefined, false, false, 'paradox');

        expect(frozen).to.equal(direct);
        expect(frozen).to.not.include(GAME_ROOT_SECTION);
        expect(frozen).to.include('Eddy CWTool Code');

        expect(builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' })).to.equal(frozen);
        const stats = builder.getFrozenPromptCacheStats();
        expect(stats.hits).to.equal(1);
        expect(stats.misses).to.equal(1);
        expect(stats.missReasons.cold).to.equal(1);
    });

    it('leaves general-domain prompts cached when a Paradox vanilla root changes', () => {
        stubFlags[STELLARIS_CACHE_KEY] = OLD_VANILLA_ROOT;
        const builder = makeBuilder();
        const first = builder.buildFrozenSystemPrompt('plan', 'deepseek', undefined, { toolsetHash: 'general-tools', domain: 'general' });

        stubFlags[STELLARIS_CACHE_KEY] = NEW_VANILLA_ROOT;
        const second = builder.buildFrozenSystemPrompt('plan', 'deepseek', undefined, { toolsetHash: 'general-tools', domain: 'general' });

        expect(second).to.equal(first);
        expect(second).to.not.include(GAME_ROOT_SECTION);
        expect(builder.getFrozenPromptCacheStats().hits).to.equal(1);
    });

    it('rebuild:true forces a rebuild and counts a rebuild miss', () => {
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', rebuild: true, domain: 'paradox' });

        const stats = builder.getFrozenPromptCacheStats();
        expect(stats.missReasons.rebuild).to.equal(1);
        expect(stats.hits).to.equal(0);
        // The rebuilt entry is cached again for subsequent calls.
        builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(builder.getFrozenPromptCacheStats().hits).to.equal(1);
    });

    it('resolves the real game id into the fingerprint when languageId is omitted', () => {
        const builder = makeBuilder();
        stubEditorLanguageId = 'stellaris';
        const stellarisPrompt = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(stellarisPrompt).to.include('Stellaris');

        stubEditorLanguageId = 'eu4';
        const eu4Prompt = builder.buildFrozenSystemPrompt('build', 'deepseek', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });

        expect(eu4Prompt).to.not.equal(stellarisPrompt);
        // A different game identity is a new cache identity, not a mutation.
        expect(builder.getFrozenPromptCacheStats().missReasons.cold).to.equal(2);
    });

    it('reports evicted when an identical fingerprint lost its LRU entry', () => {
        const builder = makeBuilder();
        // FROZEN_PROMPT_CACHE_MAX is 32: 33 distinct providers evict the first entry.
        for (let i = 0; i < 33; i++) {
            builder.buildFrozenSystemPrompt('build', `provider-${i}`, undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        }
        expect(builder.getFrozenPromptCacheStats().size).to.equal(32);
        expect(builder.getFrozenPromptCacheStats().missReasons.cold).to.equal(33);

        builder.buildFrozenSystemPrompt('build', 'provider-0', undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(builder.getFrozenPromptCacheStats().missReasons.evicted).to.equal(1);
    });

    it('keeps the cache bounded at FROZEN_PROMPT_CACHE_MAX', () => {
        const builder = makeBuilder();
        for (let i = 0; i < 40; i++) {
            builder.buildFrozenSystemPrompt('build', `provider-${i}`, undefined, { toolsetHash: 'tools-a', domain: 'paradox' });
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

describe('PromptBuilder frozen slim prompt cache', () => {
    it('serves a stable slim base while keeping delegation in a tail reminder', () => {
        const { PromptBuilder } = loadPromptBuilderModule();
        const builder = new PromptBuilder('', undefined, undefined);
        const first = builder.buildFrozenSlimSystemPromptForMode('explore', 'mimo', undefined, {
            toolsetHash: 'tools-a', domain: 'general',
        });
        const second = builder.buildFrozenSlimSystemPromptForMode('explore', 'mimo', undefined, {
            toolsetHash: 'tools-a', domain: 'general',
        });
        expect(second).to.equal(first);
        expect(builder.getFrozenPromptCacheStats().hits).to.equal(1);
        const dynamic = builder.buildSlimDynamicPromptBlock({ readOnly: true, writeScope: [] });
        expect(dynamic).to.have.length(1);
        expect(first).to.not.include('Delegated scope');
        expect(String(dynamic[0]?.content)).to.include('Delegated scope');
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

    it('is invariant to tool and required-parameter ordering', () => {
        const { hashToolDefinitionsForFingerprint } = loadPromptBuilderModule();
        const makeTool = (name: string, required: string[]) => ({
            type: 'function' as const,
            function: { name, description: '', parameters: { type: 'object', required, properties: {} } },
        });
        const left = [makeTool('write_file', ['content', 'path']), makeTool('read_file', ['path'])];
        const right = [makeTool('read_file', ['path']), makeTool('write_file', ['path', 'content'])];
        expect(hashToolDefinitionsForFingerprint(left)).to.equal(hashToolDefinitionsForFingerprint(right));
    });
});
