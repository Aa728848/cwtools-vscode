import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    AgentToolExecutor,
    cleanupWorkspace,
    makeContext,
    makeWorkspace,
    resetSandboxStorageForTesting,
    resetStubState,
    setStubConfigOverrides,
    vscodeStub,
} from './agentToolSafetyFixtures';

/**
 * Vanilla cache setting key relative to the stellarisLanguageServices section,
 * i.e. the key getConfiguredGameRoots() asks the stubbed configuration for.
 */
const STELLARIS_CACHE_KEY = 'cache.stellaris';
const VANILLA_MARKER = 'cwtools_vanilla_echo';
const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-test-vanilla-root');

type ConfiguredGameRootsModule = typeof import('../../extension/configuredGameRoots');
type LspToolsModule = typeof import('../../extension/ai/tools/lspTools');

/**
 * Modules that decide the vanilla roots this suite configures, plus the tool
 * that resolves them. Each of them captures whatever vscode object was bound
 * when it was first loaded, so the shared fixture's setStubConfigOverrides()
 * only reaches them when they happen to be loaded under the fixture's stub.
 * That is not guaranteed in a mixed run: an earlier test file that imports an
 * AI module with its own vscode stub (toolPresentationMode.test.ts pulls
 * aiService -> fileTools -> workspaceSandbox -> configuredGameRoots) leaves a
 * foreign instance in the process-wide require cache, and this suite would
 * then configure roots nobody reads. Reloading them here makes that binding
 * explicit instead of load-order dependent.
 */
const RELOADED_MODULES = [
    '../../extension/configuredGameRoots',
    '../../extension/ai/tools/lspTools',
];

interface StubbedModuleLoad<T> {
    value: T;
    /** Puts the require cache back exactly as it was before the load. */
    restore: () => void;
}

/**
 * Reload RELOADED_MODULES against the shared fixture's vscode stub and hand
 * back the fresh instances, plus a restore callback that removes them from the
 * require cache again so later suites keep the instances they already hold.
 * @param load Requires the modules while the stub is installed.
 * @returns The freshly loaded value and the cache restore callback.
 */
function loadUnderVscodeStub<T>(load: () => T): StubbedModuleLoad<T> {
    const saved = new Map<string, NodeModule | undefined>();
    for (const id of RELOADED_MODULES) {
        const resolved = require.resolve(id);
        saved.set(resolved, require.cache[resolved]);
        delete require.cache[resolved];
    }
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            value: load(),
            restore: () => {
                for (const id of RELOADED_MODULES) {
                    const resolved = require.resolve(id);
                    delete require.cache[resolved];
                    const previous = saved.get(resolved);
                    if (previous) require.cache[resolved] = previous;
                }
            },
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('vanilla grep to read_file path continuity', () => {
    let workspaceRoot: string;
    let vanillaRoot: string;
    let vanillaFile: string;
    let lspTools: LspToolsModule;
    let configuredGameRoots: ConfiguredGameRootsModule;
    let restoreModuleCache: () => void;

    before(() => {
        const loaded = loadUnderVscodeStub(() => ({
            configuredGameRoots: require('../../extension/configuredGameRoots') as ConfiguredGameRootsModule,
            lspTools: require('../../extension/ai/tools/lspTools') as LspToolsModule,
        }));
        configuredGameRoots = loaded.value.configuredGameRoots;
        lspTools = loaded.value.lspTools;
        restoreModuleCache = loaded.restore;
    });

    after(() => {
        restoreModuleCache();
    });

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        vanillaRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-vanilla-'));
        const vanillaDir = path.join(vanillaRoot, 'common', 'scripted_effects');
        fs.mkdirSync(vanillaDir, { recursive: true });
        vanillaFile = path.join(vanillaDir, '00_vanilla_effects.txt');
        fs.writeFileSync(vanillaFile, [VANILLA_MARKER + ' = {', '\tsomething = yes', '}'].join('\n'), 'utf8');
        resetStubState();
        resetSandboxStorageForTesting();
        configuredGameRoots.resetSandboxStorageForTesting();
    });

    afterEach(() => {
        resetStubState();
        resetSandboxStorageForTesting();
        configuredGameRoots.resetSandboxStorageForTesting();
        cleanupWorkspace(workspaceRoot);
        fs.rmSync(vanillaRoot, { recursive: true, force: true });
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty or already removed */ }
    });

    function makeHandler() {
        return new lspTools.LspToolHandler(
            { workspaceRoot },
            () => ({}) as any,
            (root: string) => (path.resolve(root) === path.resolve(vanillaRoot) ? [vanillaFile] : []),
        );
    }

    it('returns a vanilla match as a readable absolute path and ships the scanned root', async () => {
        setStubConfigOverrides({ [STELLARIS_CACHE_KEY]: vanillaRoot });
        const result = await makeHandler().searchText({ query: VANILLA_MARKER, searchContext: 'vanilla' });

        expect(result.matches.map(match => match.file)).to.deep.equal([vanillaFile]);
        expect(result.searchedRoots).to.deep.equal([vanillaRoot]);
        expect(result._hint).to.include('searchedRoots');
    });

    it('feeds the grep result straight into read_file without guessing a root', async () => {
        setStubConfigOverrides({ [STELLARIS_CACHE_KEY]: vanillaRoot });
        const result = await makeHandler().searchText({ query: VANILLA_MARKER, searchContext: 'vanilla' });

        const executor = new AgentToolExecutor({} as any, workspaceRoot);
        const read = await executor.execute('read_file', { file: result.matches[0]!.file }, makeContext('vanilla-root')) as any;

        expect(read.error).to.equal(undefined);
        expect(read.content).to.include(VANILLA_MARKER);
    });

    it('stays a no-op when no game root is configured', async () => {
        const result = await makeHandler().searchText({ query: VANILLA_MARKER, searchContext: 'vanilla' });

        expect(result.matches).to.deep.equal([]);
        expect(result.searchedRoots).to.equal(undefined);
        expect(result._hint ?? '').to.not.include('searchedRoots');
    });
});
