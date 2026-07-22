import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EvidenceGate, type GateRuleInfo } from '../../extension/ai/evidence/evidenceGate';
import type { EvidenceGatePhase } from '../../extension/ai/evidence/evidenceTypes';
import { getAllProfiles } from '../../extension/gameProfiles';
import type { PdxSemanticCatalog } from '../../extension/ai/types';

const RULES: Record<string, GateRuleInfo[]> = {
    effect: [{ name: 'set_variable', scopes: [] }],
    trigger: [{ name: 'has_trait', scopes: ['leader'] }],
    scope_change: [],
    modifier: [],
};

interface GoldenCase {
    name: string;
    text: string;
    expected: 'allow' | 'block';
    definitions?: Map<string, string>;
    indexEntries?: Set<string>;
    targetFile?: string;
    phase?: EvidenceGatePhase;
}

describe('Paradox semantic reliability golden benchmark', () => {
    const tempBase = path.resolve(__dirname, '../../..', '.tmp-test');
    let workspaceRoot: string;

    beforeEach(() => {
        fs.mkdirSync(tempBase, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(tempBase, 'cwtools-golden-'));
    });
    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        try { fs.rmdirSync(tempBase); } catch { /* shared test directory still in use */ }
    });

    it('blocks hard contradictions without false-blocking advisory cases for every registered profile', async () => {
        const cases: GoldenCase[] = [
            {
                name: 'legal existing effect',
                text: 'effect = { set_variable = { which = x value = 1 } }',
                expected: 'allow',
            },
            {
                name: 'plausible but nonexistent effect',
                text: 'golden_wrapper = { set_planetary_memory = yes }',
                targetFile: path.join('common', 'behavior_macros', 'missing.txt'),
                expected: 'block',
                phase: 'final',
            },
            {
                name: 'existing trigger in wrong scope',
                text: 'realm_event = { id = golden.1 trigger = { has_trait = leader_trait } }',
                expected: 'block',
            },
            {
                name: 'same name but wrong entity type',
                text: 'golden_wrapper = { shared_name = yes }',
                targetFile: path.join('common', 'behavior_macros', 'wrong_type.txt'),
                definitions: new Map([['shared_name', 'technology']]),
                expected: 'block',
                phase: 'final',
            },
            {
                name: 'missing referenced event id',
                text: 'effect = { realm_event = { id = missing_event.404 } }',
                expected: 'block',
                phase: 'final',
            },
            {
                name: 'reference before later static modifier definition',
                text: 'effect = { add_modifier = { modifier = future_static_modifier } }',
                expected: 'allow',
                phase: 'pre_write',
            },
            {
                name: 'LSP and workspace index refresh lag',
                text: 'effect = { realm_event = { id = stale_event.1 } }',
                indexEntries: new Set(['stale_event.1']),
                expected: 'allow',
            },
            {
                name: 'declaration awaiting a task graph edge',
                text: 'realm_event = { id = golden.2 requires_dispatch = yes }',
                expected: 'allow',
            },
            {
                name: 'declaration whose typed topology is resolved later',
                text: 'realm_event = { id = golden.3 requires_dispatch = yes }',
                expected: 'allow',
            },
            {
                name: 'same-write event definition and reference',
                text: [
                    'realm_event = { id = golden.4 immediate = { realm_event = { id = golden.5 } } }',
                    'realm_event = { id = golden.5 }',
                ].join('\n'),
                expected: 'allow',
            },
        ];

        const falseAcceptances: string[] = [];
        const falseBlocks: string[] = [];
        const profileIds = getAllProfiles().map(profile => profile.id).sort();
        expect(profileIds).to.have.length.greaterThan(1);
        for (const gameProfile of profileIds) for (const benchmark of cases) {
            const semanticCatalog: PdxSemanticCatalog = {
                status: 'ready',
                source: 'lsp',
                gameProfile,
                rules: [
                    { name: 'realm_event', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: 'id', access: 'type', typeName: 'event.realm' }] },
                    { name: 'set_variable', category: 'effect', supportedScopes: [], valueReferences: [] },
                    { name: 'add_modifier', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: 'modifier', access: 'type', typeName: 'static_modifier' }] },
                    { name: 'has_trait', category: 'trigger', supportedScopes: ['leader'], valueReferences: [{ argumentPath: '$value', access: 'value', typeName: 'trait' }] },
                    { name: '<behavior_macro>', category: 'effect', supportedScopes: [], valueReferences: [] },
                ],
                definitionTypes: [
                    { name: 'event', paths: ['events'], nameField: 'id', typeKeyFilters: ['realm_event'] },
                    { name: 'trait', paths: ['common/traits'], typeKeyFilters: [] },
                    { name: 'behavior_macro', paths: ['common/behavior_macros'], typeKeyFilters: [] },
                    { name: 'static_modifier', paths: ['common/static_modifiers'], typeKeyFilters: [] },
                ],
                warnings: [],
            };
            const gate = new EvidenceGate({
                workspaceRoot,
                gameProfile,
                sendLspCommand: async (command, args) => {
                    if (command === 'cwtools.ai.parseFragment') return { ok: true, valid: true, errors: [] };
                    if (command === 'cwtools.ai.queryDefinitionByName') {
                        const id = String(args[0] ?? '');
                        const type = benchmark.definitions?.get(id);
                        return type
                            ? { ok: true, type, file: path.join(workspaceRoot, 'common', 'definitions.txt'), line: 0 }
                            : { ok: false, error: 'not found' };
                    }
                    return undefined;
                },
                queryRules: async (category, name) => (RULES[category] ?? []).filter(rule => rule.name === name),
                querySemanticCatalog: async () => semanticCatalog,
                indexLookup: async name => ({
                    found: benchmark.indexEntries?.has(name) ?? false,
                    indexUpdatedAt: 1,
                }),
                getIndexRevision: () => 'golden:1:ready',
                rulesRoots: [],
            });
            const decision = await gate.evaluate({
                toolName: 'write_file',
                targetFile: path.join(workspaceRoot, benchmark.targetFile ?? path.join('events', `${benchmark.name.replace(/\W+/g, '_')}.txt`)),
                text: benchmark.text,
                mode: 'enforce',
                phase: benchmark.phase,
            });
            const caseName = `${gameProfile}:${benchmark.name}`;
            if (benchmark.expected === 'block' && decision.verdict === 'allow') falseAcceptances.push(caseName);
            if (benchmark.expected === 'allow' && decision.verdict === 'block') falseBlocks.push(caseName);
            for (const claim of decision.claims) {
                expect(claim.sources.every(source => source.gameProfile === gameProfile), `${caseName} evidence profile`).to.equal(true);
            }
        }

        expect(falseAcceptances, 'high-risk false acceptance').to.deep.equal([]);
        expect(falseBlocks, 'golden legal-case false block').to.deep.equal([]);
    });
});
