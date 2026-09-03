import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-lsp-rules-cache');

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
        fs.writeFileSync(path.join(rulesDir, 'effects.cwt'), [
            'alias[effect:realm_event] = {',
            '  id = <event.realm>',
            '}',
            'alias[effect:set_realm_flag] = value_set[realm_flag]',
            'alias[effect:<behavior_macro>] = yes',
            '',
        ].join('\n'), 'utf8');
        fs.writeFileSync(path.join(rulesDir, 'events.cwt'), [
            'types = {',
            '  type[event] = {',
            '    name_field = "id"',
            '    path = "events"',
            '    ## type_key_filter = realm_event',
            '    subtype[realm] = { }',
            '  }',
            '  type[behavior_macro] = {',
            '    path = "common/behavior_macros"',
            '  }',
            '}',
            '',
        ].join('\n'), 'utf8');
        const interfaceRulesDir = path.join(rulesDir, 'interface');
        fs.mkdirSync(interfaceRulesDir, { recursive: true });
        fs.writeFileSync(path.join(interfaceRulesDir, 'sprites.cwt'), [
            'types = {',
            '  type[sprite] = {',
            '    name_field = name',
            '    path = "game/interface"',
            '  }',
            '}',
            'sprite = {',
            '  effectFile = filepath[gfx/FX/,.shader]',
            '  meshsettings = {',
            '    shader = $shader_effect',
            '  }',
            '}',
            '',
        ].join('\n'), 'utf8');
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

    it('exposes links.cwt scope links as hard scope-change facts', async () => {
        fs.writeFileSync(path.join(rulesDir, 'links.cwt'), [
            'links = {',
            '  colony = {',
            '    input_scopes = { planet ship colony }',
            '    output_scope = Colony',
            '  }',
            '  owner = {',
            '    input_scopes = { colony }',
            '    output_scope = Country',
            '  }',
            '}',
            '',
        ].join('\n'), 'utf8');

        const handler = makeHandler();
        const result = await handler.queryRules({
            category: 'scope_change',
            name: 'ship.colony',
            scope: 'ship',
        });

        expect(result.rules[0]!.name).to.equal('ship.colony');
        expect(result.rules[0]!.hardFacts?.supportedScopes).to.include('ship');
        expect(result.rules[0]!.hardFacts?.pushScope).to.equal('colony');
        expect(result.rules[0]!.syntax).to.equal('ship.colony = { ... }');
        expect(result.rules[0]!.semanticHints?.some(hint => hint.source === 'links.cwt')).to.equal(true);

        const multiHop = await handler.queryRules({
            category: 'scope_change',
            name: 'ship.colony.owner',
            scope: 'ship',
        });

        expect(multiHop.rules[0]!.name).to.equal('ship.colony.owner');
        expect(multiHop.rules[0]!.hardFacts?.supportedScopes).to.include('ship');
        expect(multiHop.rules[0]!.hardFacts?.pushScope).to.equal('country');
        expect(multiHop.rules[0]!.syntax).to.equal('ship.colony.owner = { ... }');
    });

    it('loads alias rules from nested CWT files', async () => {
        const nestedRuleFile = path.join(rulesDir, 'common', 'custom_agent_rules.cwt');
        fs.mkdirSync(path.dirname(nestedRuleFile), { recursive: true });
        fs.writeFileSync(nestedRuleFile, [
            '## supported_scopes = country',
            'alias[effect:custom_nested_effect] = yes',
            '',
        ].join('\n'), 'utf8');

        const handler = makeHandler();
        const result = await handler.queryRules({
            category: 'effect',
            name: 'custom_nested_effect',
        });

        expect(result.rules[0]!.name).to.equal('custom_nested_effect');
        expect(result.rules[0]!.sourceFile?.replace(/\\/g, '/')).to.include('/common/custom_agent_rules.cwt');
    });

    it('derives typed values and type-key filters for the semantic catalog without game tables', async () => {
        const handler = makeHandler();
        const catalog = await handler.getPdxSemanticCatalog(
            [path.join(workspaceRoot, 'events', 'test.txt')],
            ['realm_event', 'set_realm_flag'],
        );

        expect(catalog.source).to.equal('cwt_fallback');
        expect(catalog.rules.find(rule => rule.name === 'realm_event')?.valueReferences)
            .to.deep.include({ argumentPath: 'id', access: 'type', typeName: 'event.realm' });
        expect(catalog.rules.find(rule => rule.name === 'set_realm_flag')?.valueReferences)
            .to.deep.include({ argumentPath: '$value', access: 'value_set', typeName: 'realm_flag' });
        expect(catalog.rules.find(rule => rule.name === '<behavior_macro>')?.category).to.equal('effect');
        expect(catalog.definitionTypes.find(type => type.name === 'behavior_macro')?.paths)
            .to.deep.equal(['common/behavior_macros']);
        expect(catalog.definitionTypes.find(type => type.name === 'event')).to.deep.include({
            paths: ['events'],
            nameField: 'id',
            typeKeyFilters: ['realm_event'],
        });
    });

    it('exposes shader Effect/file mappings and dynamic policies in the fallback semantic catalog', async () => {
        const handler = makeHandler();
        const catalog = await handler.getPdxSemanticCatalog(
            [path.join(workspaceRoot, 'interface', 'test.gfx')],
            [],
        );

        expect(catalog.definitionTypes.find(type => type.name === 'sprite')?.shaderReferences).to.deep.equal([
            {
                argumentPath: 'effectfile',
                referenceKind: 'shader_file',
                dynamicValuePolicy: 'literal_or_parameter',
                pathPrefix: 'gfx/FX/',
                extension: '.shader',
            },
            {
                argumentPath: 'meshsettings.shader',
                referenceKind: 'shader_effect',
                dynamicValuePolicy: 'allow_expression',
            },
        ]);
    });
});
