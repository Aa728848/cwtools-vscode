import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EvidenceGate, type GateRuleInfo } from '../../extension/ai/evidence/evidenceGate';
import { getAllProfiles } from '../../extension/gameProfiles';

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
    references?: Array<{ file: string; line: number; context: string }>;
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

    it('has zero false acceptance and zero legal-case false block for every registered profile', async () => {
        const cases: GoldenCase[] = [
            {
                name: 'legal existing effect',
                text: 'effect = { set_variable = { which = x value = 1 } }',
                expected: 'allow',
            },
            {
                name: 'plausible but nonexistent effect',
                text: 'effect = { set_planetary_memory = yes }',
                expected: 'block',
            },
            {
                name: 'existing trigger in wrong scope',
                text: 'country_event = { id = golden.1 trigger = { has_trait = leader_trait } }',
                expected: 'block',
            },
            {
                name: 'same name but wrong entity type',
                text: 'effect = { shared_name = yes }',
                definitions: new Map([['shared_name', 'technology']]),
                expected: 'block',
            },
            {
                name: 'missing referenced event id',
                text: 'effect = { country_event = { id = missing_event.404 } }',
                expected: 'block',
            },
            {
                name: 'LSP and workspace index conflict',
                text: 'effect = { country_event = { id = stale_event.1 } }',
                indexEntries: new Set(['stale_event.1']),
                expected: 'block',
            },
            {
                name: 'syntax-valid but unreachable triggered event',
                text: 'country_event = { id = golden.2 is_triggered_only = yes }',
                expected: 'block',
            },
            {
                name: 'triggered event with indexed on_action caller',
                text: 'country_event = { id = golden.3 is_triggered_only = yes }',
                references: [{ file: 'common/on_actions/golden.txt', line: 3, context: 'events = { golden.3 }' }],
                expected: 'allow',
            },
            {
                name: 'same-write event definition and reference',
                text: [
                    'country_event = { id = golden.4 immediate = { country_event = { id = golden.5 } } }',
                    'country_event = { id = golden.5 }',
                ].join('\n'),
                expected: 'allow',
            },
        ];

        const falseAcceptances: string[] = [];
        const falseBlocks: string[] = [];
        const profileIds = getAllProfiles().map(profile => profile.id).sort();
        expect(profileIds).to.have.length.greaterThan(1);
        for (const gameProfile of profileIds) for (const benchmark of cases) {
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
                indexLookup: async name => ({
                    found: benchmark.indexEntries?.has(name) ?? false,
                    indexUpdatedAt: 1,
                }),
                getIndexRevision: () => 'golden:1:ready',
                queryReferences: async () => benchmark.references ?? [],
                rulesRoots: [],
            });
            const decision = await gate.evaluate({
                toolName: 'write_file',
                targetFile: path.join(workspaceRoot, 'events', `${benchmark.name.replace(/\W+/g, '_')}.txt`),
                text: benchmark.text,
                mode: 'enforce',
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
