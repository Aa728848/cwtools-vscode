import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-prompt-game-roots');
const STELLARIS_CACHE_KEY = 'cache.stellaris';
const SECTION_HEADING = '## Configured vanilla read roots';

let stubConfig: Record<string, unknown> = {};

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        getConfiguration: () => ({
            get: <T>(key: string, defaultValue?: T): T | undefined =>
                (key in stubConfig ? stubConfig[key] : defaultValue) as T | undefined,
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

/**
 * Modules that read this stub's configuration, or the prompt built from it.
 * Each keeps whatever vscode object it was bound to for the rest of the
 * process, so they are reloaded per call and handed back afterwards.
 */
const RELOADED_MODULES = [
    '../../extension/configuredGameRoots',
    '../../extension/ai/prompt/sections/gameRoots',
    '../../extension/ai/promptBuilder',
];

function withVscodeStub<T>(load: () => T): T {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    const saved = new Map<string, NodeModule | undefined>();
    try {
        // Another suite may already have loaded these under its own vscode stub,
        // and a module keeps that binding for the whole process. Reload them so
        // the prompt is really built against this stub's configuration.
        for (const id of RELOADED_MODULES) {
            const resolved = require.resolve(id);
            saved.set(resolved, require.cache[resolved]);
            delete require.cache[resolved];
        }
        return load();
    } finally {
        moduleLoader._load = originalLoad;
        // The caller keeps the returned module, but leaving a second
        // promptBuilder / configuredGameRoots in the process-wide cache would
        // hand every later suite a stub-bound copy instead of the instance it
        // already holds, splitting module state (frozen prompt cache, sandbox
        // storage) across the run. Put the previous entries back.
        for (const id of RELOADED_MODULES) {
            const resolved = require.resolve(id);
            delete require.cache[resolved];
            const previous = saved.get(resolved);
            if (previous) require.cache[resolved] = previous;
        }
    }
}

describe('PromptBuilder configured vanilla read roots', () => {
    let workspaceRoot: string;
    let vanillaRoot: string;

    beforeEach(() => {
        stubConfig = {};
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-game-roots-ws-'));
        vanillaRoot = path.join(os.tmpdir(), 'cwtools-game-roots-vanilla');
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    });

    afterEach(() => {
        stubConfig = {};
        vscodeStub.workspace.workspaceFolders = [];
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty or already removed */ }
    });

    function buildPrompt(domain: 'paradox' | 'general'): string {
        const { PromptBuilder } = withVscodeStub(
            () => require('../../extension/ai/promptBuilder') as typeof import('../../extension/ai/promptBuilder'));
        return new PromptBuilder(workspaceRoot)
            .buildSystemPromptForMode('build', undefined, 'stellaris', undefined, undefined, undefined, true, true, domain);
    }

    it('states the configured root and the read_file contract in the main agent prompt', () => {
        stubConfig[STELLARIS_CACHE_KEY] = vanillaRoot;
        const prompt = buildPrompt('paradox');

        expect(prompt).to.include(SECTION_HEADING);
        expect(prompt).to.include(vanillaRoot);
        expect(prompt).to.include('`read_file`');
        expect(prompt).to.include('Never guess a drive letter');
    });

    it('omits the whole statement when no game root is configured', () => {
        const prompt = buildPrompt('paradox');

        expect(prompt).to.not.include(SECTION_HEADING);
        expect(prompt).to.not.include('Never guess a drive letter');
        expect(prompt).to.include('Eddy CWTool Code');
    });

    it('keeps the statement out of the general repository domain', () => {
        stubConfig[STELLARIS_CACHE_KEY] = vanillaRoot;
        const prompt = buildPrompt('general');

        expect(prompt).to.not.include(SECTION_HEADING);
        expect(prompt).to.not.include(vanillaRoot);
    });

    it('mirrors the statement in Chinese for a zh-cn session', () => {
        stubConfig[STELLARIS_CACHE_KEY] = vanillaRoot;
        const messages = require('../../extension/ai/messages') as typeof import('../../extension/ai/messages');
        // The locale is process-wide state shared with every other suite.
        const previousLocale = messages.getAiMessageLocale();
        try {
            messages.setAiMessageLocale('zh-cn');
            expect(buildPrompt('paradox')).to.include('## \u5df2\u914d\u7f6e\u7684\u539f\u7248\u53ea\u8bfb\u6839');
        } finally {
            messages.setAiMessageLocale(previousLocale);
        }
    });

    it('builds nothing from an empty or missing root list', () => {
        const { buildGameRootReadScopeStatement } = withVscodeStub(
            () => require('../../extension/ai/prompt/sections/gameRoots') as typeof import('../../extension/ai/prompt/sections/gameRoots'));

        expect(buildGameRootReadScopeStatement(undefined)).to.equal('');
        expect(buildGameRootReadScopeStatement([])).to.equal('');
        expect(buildGameRootReadScopeStatement([{ gameId: 'stellaris', root: '   ' }])).to.equal('');
    });
});
