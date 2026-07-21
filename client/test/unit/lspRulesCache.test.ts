import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
    },
    extensions: {
        getExtension: () => undefined,
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

function loadLspToolsModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/tools/lspTools')];
        return require('../../extension/ai/tools/lspTools') as typeof import('../../extension/ai/tools/lspTools');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('LspToolHandler CWT rules cache lifecycle (plan §7.4)', () => {
    let workspaceRoot: string;
    let rulesDir: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-rules-ws-'));
        rulesDir = path.join(workspaceRoot, '.cwtools', 'stellaris', 'config');
        fs.mkdirSync(rulesDir, { recursive: true });
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
        writeTriggers(['alpha_trigger']);
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
    });

    function writeTriggers(names: string[]): void {
        const body = names
            .map(name => `## supported_scopes = country\nalias[trigger:${name}] = {\n}\n`)
            .join('\n');
        fs.writeFileSync(path.join(rulesDir, 'triggers.cwt'), body, 'utf8');
    }

    function makeHandler() {
        const { LspToolHandler } = loadLspToolsModule();
        return new LspToolHandler(
            { workspaceRoot },
            () => ({}) as never,
            () => [],
        );
    }

    it('serves the parsed cache across calls without reloading (stable generation)', async () => {
        const handler = makeHandler();
        const first = await handler.queryRules({ category: 'trigger' });
        expect(first.rules.map(rule => rule.name)).to.include('alpha_trigger');
        expect(first.rulesGeneration).to.equal(1);
        expect(first.rulesContentHash).to.be.a('string').with.lengthOf(16);

        const second = await handler.queryRules({ category: 'trigger' });
        expect(second.rulesGeneration).to.equal(1);
        expect(second.rulesContentHash).to.equal(first.rulesContentHash);
    });

    it('invalidates on rule file mtime change and bumps generation + content hash', async () => {
        const handler = makeHandler();
        const first = await handler.queryRules({ category: 'trigger' });

        writeTriggers(['alpha_trigger', 'beta_trigger']);
        const third = await handler.queryRules({ category: 'trigger' });

        expect(third.rulesGeneration).to.equal(2);
        expect(third.rulesContentHash).to.not.equal(first.rulesContentHash);
        expect(third.rules.map(rule => rule.name)).to.include.members(['alpha_trigger', 'beta_trigger']);
    });

    it('invalidates when a previously missing rule file appears', async () => {
        const handler = makeHandler();
        const first = await handler.queryRules({ category: 'trigger' });

        fs.writeFileSync(path.join(rulesDir, 'effects.cwt'), '## supported_scopes = country\nalias[effect:gamma_effect] = {\n}\n', 'utf8');
        const second = await handler.queryRules({ category: 'effect' });

        expect(second.rulesGeneration).to.equal(2);
        expect(second.rulesContentHash).to.not.equal(first.rulesContentHash);
        expect(second.rules.map(rule => rule.name)).to.include('gamma_effect');
    });

    it('exposes generation metadata on searchRuleCapabilities results', async () => {
        const handler = makeHandler();
        const result = await handler.searchRuleCapabilities({ intent: 'alpha', category: 'trigger' });
        expect(result.rulesGeneration).to.equal(1);
        expect(result.rulesContentHash).to.be.a('string').with.lengthOf(16);
    });
});
