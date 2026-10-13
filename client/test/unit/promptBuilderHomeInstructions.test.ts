import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-prompt-home');

/**
 * PromptBuilder reads ~/.cwtools/CWTOOLS.md via os.homedir(); tests redirect
 * the home directory into a temp sandbox (same raw-module patching as
 * mcpConfig.test.ts) so the real user file is never touched.
 */
const rawOs = require('os') as typeof os & { homedir: () => string };

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    window: {
        activeTextEditor: undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

const RELOADED_MODULES = ['../../extension/ai/promptBuilder'];

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

describe('PromptBuilder user-global instructions (~/.cwtools/CWTOOLS.md)', () => {
    let workspaceRoot: string;
    let storageRoot: string;
    let extensionRoot: string;
    let fakeHome: string;
    let originalHomedir: () => string;

    function writeHomeRules(content: string): string {
        const dir = path.join(fakeHome, '.cwtools');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'CWTOOLS.md');
        fs.writeFileSync(filePath, content, 'utf8');
        return filePath;
    }

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-home-ws-'));
        storageRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-home-storage-'));
        extensionRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-home-ext-'));
        fakeHome = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-home-home-'));
        originalHomedir = rawOs.homedir;
        rawOs.homedir = () => fakeHome;
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    });

    afterEach(() => {
        rawOs.homedir = originalHomedir;
        vscodeStub.workspace.workspaceFolders = [];
        for (const dir of [workspaceRoot, storageRoot, extensionRoot, fakeHome]) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    function makeBuilder() {
        const { PromptBuilder } = loadPromptBuilderModule();
        return new PromptBuilder(workspaceRoot, storageRoot, extensionRoot);
    }

    it('injects <user-instructions> ahead of project rules in the paradox frozen prompt', () => {
        writeHomeRules('# Global\nAlways run unit tests before finishing.');
        fs.writeFileSync(path.join(workspaceRoot, 'CWTOOLS.md'), '# CWTOOLS\n\n## Mod Info\n- **Name**: HomeTestMod\n', 'utf8');
        const builder = makeBuilder();
        const prompt = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });

        expect(prompt).to.include('<user-instructions>');
        expect(prompt).to.include('Always run unit tests before finishing.');
        expect(prompt).to.include('<project-instructions>');
        expect(prompt.indexOf('<user-instructions>')).to.be.lessThan(prompt.indexOf('<project-instructions>'));
    });

    it('injects <user-instructions> into the general-domain prompt', () => {
        writeHomeRules('# Global\nPrefer pnpm over npm.');
        const builder = makeBuilder();
        const prompt = builder.buildFrozenSystemPrompt('utility', undefined, undefined, { toolsetHash: 'tools-a', domain: 'general' });

        expect(prompt).to.include('<user-instructions>');
        expect(prompt).to.include('Prefer pnpm over npm.');
    });

    it('omits the section when the home file is absent or empty', () => {
        const builder = makeBuilder();
        const paradox = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(paradox).to.not.include('<user-instructions>');

        writeHomeRules('   \n  ');
        const builder2 = makeBuilder();
        const general = builder2.buildFrozenSystemPrompt('utility', undefined, undefined, { toolsetHash: 'tools-a', domain: 'general' });
        expect(general).to.not.include('<user-instructions>');
    });

    it('injects <user-rules> into slim paradox sub-agent prompts', () => {
        writeHomeRules('# Global\nNever edit localisation files directly.');
        const builder = makeBuilder();
        const prompt = builder.buildFrozenSlimSystemPromptForMode('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(prompt).to.include('<user-rules>');
        expect(prompt).to.include('Never edit localisation files directly.');
    });

    it('invalidates the frozen prompt with rules_changed when the home file changes', () => {
        const rulesPath = writeHomeRules('# Global\nVersion one.');
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });

        // Bump mtime explicitly so the mtime cache cannot miss the rewrite.
        fs.writeFileSync(rulesPath, '# Global\nVersion two.', 'utf8');
        const bumped = fs.statSync(rulesPath).mtimeMs + 5000;
        fs.utimesSync(rulesPath, new Date(bumped), new Date(bumped));

        const rebuilt = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(rebuilt).to.include('Version two.');
        expect(builder.getFrozenPromptCacheStats().missReasons.rules_changed).to.equal(1);
    });

    it('invalidates the general-domain fingerprint too', () => {
        const rulesPath = writeHomeRules('# Global\nGeneral one.');
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('utility', undefined, undefined, { toolsetHash: 'tools-a', domain: 'general' });

        fs.writeFileSync(rulesPath, '# Global\nGeneral two.', 'utf8');
        const bumped = fs.statSync(rulesPath).mtimeMs + 5000;
        fs.utimesSync(rulesPath, new Date(bumped), new Date(bumped));

        const rebuilt = builder.buildFrozenSystemPrompt('utility', undefined, undefined, { toolsetHash: 'tools-a', domain: 'general' });
        expect(rebuilt).to.include('General two.');
        expect(builder.getFrozenPromptCacheStats().missReasons.rules_changed).to.equal(1);
    });

    it('re-reads the home file after invalidateProjectPromptInputs even when mtime is unchanged', () => {
        const rulesPath = writeHomeRules('# Global\nBeforeInvalidation');
        const builder = makeBuilder();
        builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });

        const before = fs.statSync(rulesPath);
        fs.writeFileSync(rulesPath, '# Global\nAfterInvalidation', 'utf8');
        fs.utimesSync(rulesPath, before.atime, before.mtime);

        builder.invalidateProjectPromptInputs();
        const rebuilt = builder.buildFrozenSystemPrompt('build', 'deepseek', 'stellaris', { toolsetHash: 'tools-a', domain: 'paradox' });
        expect(rebuilt).to.include('AfterInvalidation');
        expect(builder.getFrozenPromptCacheStats().missReasons.rules_changed).to.equal(1);
    });
});
