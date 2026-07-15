import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  explainScopeWithHost,
  getPdxBlockWithHost,
  queryCwtSchemaWithHost,
  queryRulesWithHost,
  searchRuleCapabilitiesWithHost,
  type HostServices,
} from 'cwtools-shared';

describe('phase 1 read tool contracts', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

  it('queries CWT trigger/effect rules from the configured rules source', async () => {
    const host = createFsHost(repoRoot);
    const result = await queryRulesWithHost(host, {
      category: 'trigger',
    });

    expect(result.ok).to.equal(true);
    expect(result.source).to.equal('cwtools-node-rules');
    expect(result.data!.rules.length).to.be.greaterThan(0);
    expect(result.data!.warnings?.[0]).to.include('Phase 1 fallback');
  });

  it('queries CWT schema snippets and type summaries from the configured rules source', async () => {
    const rulesRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-cwt-schema-'));
    try {
      const configDir = path.join(rulesRoot, 'config');
      const schemaFile = path.join(configDir, 'common', 'special_projects.cwt');
      fs.mkdirSync(path.dirname(schemaFile), { recursive: true });
      fs.writeFileSync(schemaFile, [
        'types = {',
        '  type[special_project] = {',
        '    path = "common/special_projects"',
        '    graph_related_types = { ship country }',
        '    subtype[ship] = {',
        '      type_per_file = yes',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'), 'utf8');
      const host = createFsHost(repoRoot, {
        rules: {
          gameId: 'stellaris',
          configDirs: [rulesRoot],
          async readTextFile(filePath) {
            if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
            const content = fs.readFileSync(filePath, 'utf8');
            return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
          },
          async listCwtFiles(root) {
            const relative = path.relative(root, schemaFile);
            return relative.startsWith('..') || path.isAbsolute(relative) ? [] : [schemaFile];
          },
        },
      });

      const result = await queryCwtSchemaWithHost(host, {
        target: 'common/special_projects/00_test.txt',
        name: 'ship',
      });

      expect(result.ok).to.equal(true);
      expect(result.data!.status).to.equal('ready');
      expect(result.data!.matches[0]!.relativeRuleFile).to.equal('common/special_projects.cwt');
      expect(result.data!.matches[0]!.snippet).to.include('type[special_project]');
      expect(result.data!.entities[0]!.name).to.equal('special_project');
      expect(result.data!.entities[0]!.path).to.equal('common/special_projects');
      expect(result.data!.entities[0]!.subtypes).to.include('ship');
      expect(result.data!.entities[0]!.schemaKeys).to.include('path');
    } finally {
      fs.rmSync(rulesRoot, { recursive: true, force: true });
    }
  });

  it('exposes scope-change hard facts and docs hints from CWT rules', async () => {
    const result = await queryRulesWithHost(createFsHost(repoRoot), {
      category: 'scope_change',
      name: 'every_owned_ship',
    });

    expect(result.ok).to.equal(true);
    const rule = result.data!.rules.find(item => item.name === 'every_owned_ship');
    expect(rule).to.not.equal(undefined);
    expect(rule!.hardFacts?.category).to.equal('scope_change');
    expect(rule!.hardFacts?.pushScope).to.equal('ship');
    expect(rule!.hardFacts?.supportedScopes).to.include.members(['country', 'fleet']);
    expect(rule!.syntax).to.include('every_owned_ship = { limit = { <triggers> } <effects> }');
    expect(rule!.semanticHints?.some(hint => hint.source === 'trigger_docs.log')).to.equal(true);
    expect(rule!.semanticHints?.some(hint => hint.text.includes('ship'))).to.equal(true);
  });

  it('keeps event-effect legality separate from semantic hints', async () => {
    const result = await queryRulesWithHost(createFsHost(repoRoot), {
      category: 'effect',
      name: 'carrier_event',
    });

    expect(result.ok).to.equal(true);
    const rule = result.data!.rules.find(item => item.name === 'carrier_event');
    expect(rule).to.not.equal(undefined);
    expect(rule!.hardFacts?.category).to.equal('effect');
    expect(rule!.hardFacts?.supportedScopes).to.include.members(['planet', 'ship', 'colony']);
    expect(rule!.syntax).to.include('id = <id>');
    expect(rule!.semanticHints?.some(hint => hint.source === 'trigger_docs.log' && hint.text.includes('carrier event'))).to.equal(true);
    expect(rule!.semanticHints?.some(hint => hint.source === 'scopes.cwt' && hint.text.includes('Scope Carrier'))).to.equal(true);
  });

  it('searches rule capabilities from Chinese intent and scope facts', async () => {
    const result = await searchRuleCapabilitiesWithHost(createFsHost(repoRoot), {
      intent: '查询舰队中的舰船并遍历所有舰船',
      category: 'scope_change',
      currentScope: 'fleet',
      desiredPushScope: 'ship',
      limit: 5,
    });

    expect(result.ok).to.equal(true);
    expect(result.data!.candidates[0]!.rule.name).to.equal('every_owned_ship');
    expect(result.data!.candidates[0]!.reasons).to.include("pushes scope to 'ship'");
  });

  it('explains Carrier without treating its host union as subscope inheritance', async () => {
    const result = await explainScopeWithHost(createFsHost(repoRoot), {
      scope: 'carrier',
    });

    expect(result.ok).to.equal(true);
    expect(result.data!.status).to.equal('ready');
    expect(result.data!.canonicalName).to.equal('Carrier');
    expect(result.data!.aliases).to.include('carrier');
    expect(result.data!.isSubscopeOf).to.deep.equal([]);
    expect(result.data!.semanticHints?.[0]?.source).to.equal('scopes.cwt');
  });

  it('prefers the configured current-game rules directory over Stellaris fallback rules', async () => {
    const rulesRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-hoi4-rules-'));
    try {
      const configDir = path.join(rulesRoot, 'config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'effects.cwt'), [
        '## supported_scopes = country',
        '## push_scope = state',
        'alias[effect:test_multigame_effect] = {',
        '}',
        '',
      ].join('\n'), 'utf8');
      const host = createFsHost(repoRoot, {
        rules: {
          gameId: 'hoi4',
          configDirs: [rulesRoot],
          async readTextFile(filePath) {
            if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
            const content = fs.readFileSync(filePath, 'utf8');
            return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
          },
        },
      });

      const ownRules = await queryRulesWithHost(host, {
        category: 'effect',
        name: 'test_multigame_effect',
      });
      const leakedStellarisRules = await queryRulesWithHost(host, {
        category: 'scope_change',
        name: 'every_owned_ship',
      });

      expect(ownRules.ok).to.equal(true);
      expect(ownRules.data!.rules[0]!.name).to.equal('test_multigame_effect');
      expect(ownRules.data!.rules[0]!.hardFacts?.pushScope).to.equal('state');
      expect(leakedStellarisRules.data!.totalCount).to.equal(0);
    } finally {
      fs.rmSync(rulesRoot, { recursive: true, force: true });
    }
  });

  it('reports an empty current-game rules source instead of claiming a known scope is invalid', async () => {
    const result = await explainScopeWithHost(createFsHost(repoRoot, {
      rules: {
        gameId: 'hoi4',
        configDirs: [],
      },
    }), {
      scope: 'Fleet',
    });

    expect(result.ok).to.equal(false);
    expect(result.error?.code).to.equal('rules_source_empty');
    expect(result.error?.message).to.include('No scopes were loaded');
  });

  it('extracts a complete PDX block by top-level symbol without leaving the workspace', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-pdx-block-'));
    try {
      const filePath = path.join(workspaceRoot, 'common', 'scripted_triggers', 'test.txt');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        'first_trigger = {',
        '  always = yes',
        '}',
        'second_trigger = {',
        '  always = no',
        '}',
        '',
      ].join('\n'), 'utf8');

      const result = await getPdxBlockWithHost(createFsHost(workspaceRoot), {
        file: 'common/scripted_triggers/test.txt',
        symbol: 'second_trigger',
      });

      expect(result.ok).to.equal(true);
      expect(result.data!.content).to.equal('second_trigger = {\n  always = no\n}');
      expect(result.data!.startLine).to.equal(4);
      expect(result.data!.endLine).to.equal(6);
      expect(result.data!.source).to.equal('cwtools-node-block');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function createFsHost(workspaceRoot: string, options: Partial<Pick<HostServices, 'rules'>> = {}): HostServices {
  return {
    workspaceRoot,
    readonlyMode: true,
    writesEnabled: false,
    rules: options.rules,
    lsp: createUnavailableLspHost(),
    diagnostics: createUnavailableDiagnosticsHost(),
    filesystem: {
      async readTextFile(filePath) {
        if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
        const content = fs.readFileSync(filePath, 'utf8');
        return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
      },
      async writeTextFile() { throw new Error('unexpected write'); },
      async list() { return []; },
      async glob() { return []; },
    },
    now: () => Date.now(),
    log: () => undefined,
  };
}
