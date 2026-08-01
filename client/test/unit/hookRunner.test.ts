import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Agent hook runner', () => {
    let workspaceRoot: string;
    let hookSettings: Record<string, unknown>;
    let commandHandler: (command: string) => Promise<unknown>;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-hooks-'));
        fs.mkdirSync(path.join(workspaceRoot, '.cwtools'), { recursive: true });
        hookSettings = { enabled: true, failureMode: 'ignore', timeoutMs: 100 };
        commandHandler = async () => ({ allowed: true });
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
        vscodeStub.workspace.getConfiguration = (section: string) => ({
            get: <T>(key: string, fallback: T): T => section === 'stellarisLanguageServices.ai.hooks'
                ? (hookSettings[key] as T ?? fallback)
                : fallback,
        });
        vscodeStub.commands.executeCommand = command => commandHandler(command);
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
    });

    it('validates hooks and honors an allowlisted blocking response', async () => {
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'hooks.json'), JSON.stringify({
            preToolUse: [
                { command: 'not.allowed.command' },
                { command: 'cwtools.testHook', tools: ['write_file'] },
            ],
        }), 'utf8');
        commandHandler = async command => command === 'cwtools.testHook'
            ? { allowed: false, reason: 'policy says no', readonlyContext: 'bounded context' }
            : { allowed: true };
        const { runAgentHooks } = loadHookRunner();
        const result = await runAgentHooks('preToolUse', { toolName: 'write_file' });
        expect(result.allowed).to.equal(false);
        expect(result.reason).to.equal('policy says no');
        expect(result.readonlyContext).to.deep.equal(['bounded context']);
    });

    it('blocks on hook timeout only when configured fail-closed', async () => {
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'hooks.json'), JSON.stringify({
            preToolUse: [{ command: 'cwtools.slowHook' }],
        }), 'utf8');
        hookSettings.failureMode = 'block';
        commandHandler = async () => await new Promise(() => undefined);
        const { runAgentHooks } = loadHookRunner();
        const result = await runAgentHooks('preToolUse', { toolName: 'read_file' });
        expect(result.allowed).to.equal(false);
        expect(result.reason).to.include('failed under block-on-failure policy');
    });
});

function loadHookRunner() {
    const moduleLoader = require('module') as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: unknown, ...args: unknown[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/workspacePaths')];
        delete require.cache[require.resolve('../../extension/ai/runner/hookRunner')];
        return require('../../extension/ai/runner/hookRunner') as typeof import('../../extension/ai/runner/hookRunner');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        isTrusted: true,
        getConfiguration: (_section: string) => ({ get: <T>(_key: string, fallback: T): T => fallback }),
    },
    commands: {
        executeCommand: async (_command: string): Promise<unknown> => undefined,
    },
    window: {
        createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, clear: () => undefined, dispose: () => undefined }),
    },
};
