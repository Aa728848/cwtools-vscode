/**
 * Targeted regression tests for the SemanticEvidenceGate (plan §4 P0).
 *
 * Layers covered:
 *  - claimExtractor: deterministic, bounded claim extraction from write args.
 *  - EvidenceGate: per-status verdicts with fake CWT rules / fake LSP / fake index.
 *  - AgentToolExecutor wiring: shadow never blocks, enforce blocks confirmed
 *    conflicts with machine-readable evidence, infrastructure outages stay
 *    advisory, and manual override only uses the approval channel.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';

const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

function makeWorkspace(): string {
    fs.mkdirSync(TEMP_BASE, { recursive: true });
    return fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-evidence-gate-'));
}

function cleanupWorkspace(workspaceRoot: string | undefined): void {
    if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty or already removed */ }
}

// Pure modules under test (no 'vscode' imports at runtime).
import {
    extractWritePayload,
    extractClaimsFromText,
    extractLocalDefinitions,
    isPdxScriptTarget,
    MAX_CLAIM_CANDIDATES,
    MAX_EXTRACT_CHARS,
} from '../../extension/ai/evidence/claimExtractor';
import {
    EvidenceGate,
    computeRulesFingerprint,
    type GateRuleInfo,
} from '../../extension/ai/evidence/evidenceGate';
import {
    isEvidenceGateDecision,
    normalizeEvidenceGateMode,
} from '../../extension/ai/evidence/evidenceTypes';
import { reducePolicyActivity } from '../../extension/ai/runner/runReducers';
import type { AgentRunEvent } from '../../extension/ai/runner/runLedger';

describe('claimExtractor', () => {
    it('extracts write payloads per tool schema and skips non-PDX targets', () => {
        expect(extractWritePayload('write_file', { file: 'events/a.txt', content: 'x = 1' })?.text).to.equal('x = 1');
        expect(extractWritePayload('edit_file', { filePath: 'common/a.txt', oldString: 'a', newString: 'b = 2' })?.text).to.equal('b = 2');
        expect(extractWritePayload('replace_lines', { filePath: 'common/a.txt', startLine: 1, endLine: 2, newContent: 'c = 3' })?.text).to.equal('c = 3');
        expect(extractWritePayload('edit_pdx_block', { file: 'events/a.txt', symbol: 'country_event', newContent: 'd = 4' })?.text).to.equal('d = 4');
        const multi = extractWritePayload('multi_replace_file_content', {
            TargetFile: 'common/a.txt',
            ReplacementChunks: [
                { StartLine: 1, EndLine: 1, TargetContent: 'a', ReplacementContent: 'e = 5' },
                { StartLine: 3, EndLine: 3, TargetContent: 'b', ReplacementContent: 'f = 6' },
            ],
        });
        expect(multi?.text).to.equal('e = 5\nf = 6');

        expect(extractWritePayload('write_file', { file: 'localisation/a_l_english.yml', content: 'x = 1' })).to.equal(null);
        expect(extractWritePayload('write_file', { file: 'docs/README.md', content: '# hi' })).to.equal(null);
        expect(extractWritePayload('write_file', { file: 'gfx/a.png', content: 'x' })).to.equal(null);
        expect(extractWritePayload('read_file', { file: 'events/a.txt' })).to.equal(null);
        expect(extractWritePayload('write_file', { file: 'events/a.txt' })).to.equal(null);
        expect(isPdxScriptTarget('gui/window.gui')).to.equal(true);
        expect(isPdxScriptTarget('gfx/ships/design.asset')).to.equal(true);
        expect(isPdxScriptTarget('localisation/a.yml')).to.equal(false);
    });

    it('finds effect/trigger usages with scope context from scope_change blocks', () => {
        const payload = extractWritePayload('write_file', {
            file: 'events/a.txt',
            content: [
                'country_event = {',
                '  id = my_event.1',
                '  immediate = {',
                '    every_country = {',
                '      add_opinion_modifier = { who = root modifier = x }',
                '    }',
                '  }',
                '}',
            ].join('\n'),
        })!;
        const claims = extractClaimsFromText(payload);
        const byName = (fragment: string) => claims.filter(c => c.claim.includes(fragment));

        expect(byName('parses as valid script syntax')).to.have.lengthOf(1);
        const addOpinion = byName('add_opinion_modifier');
        expect(addOpinion).to.have.lengthOf(1);
        expect(addOpinion[0]!.kind).to.equal('symbol_exists');
        expect(addOpinion[0]!.blocking).to.equal(true);
        expect(addOpinion[0]!.subject).to.deep.include({ type: 'rule', name: 'add_opinion_modifier', currentScope: 'country' });

        // Top-level event definition yields a non-blocking call_chain note only.
        const entry = byName('my_event.1');
        expect(entry).to.have.lengthOf(1);
        expect(entry[0]!.kind).to.equal('call_chain');
        expect(entry[0]!.blocking).to.equal(false);
    });

    it('derives event root scopes and never treats grammar containers as semantic calls', () => {
        const payload = extractWritePayload('write_file', {
            file: 'events/a.txt',
            content: [
                'planet_event = {',
                '  id = my_event.3',
                '  trigger = {',
                '    always = yes',
                '  }',
                '  immediate = {',
                '    limit = { always = yes }',
                '    set_variable = { which = x value = 1 }',
                '  }',
                '}',
            ].join('\n'),
        })!;
        const claims = extractClaimsFromText(payload);
        const setVariable = claims.find(c => c.kind === 'symbol_exists' && c.claim.includes('set_variable'));
        expect(setVariable?.subject).to.deep.include({ type: 'rule', currentScope: 'planet' });
        for (const container of ['trigger', 'immediate', 'limit']) {
            expect(claims.some(c => c.kind === 'symbol_exists' && c.claim.includes(`'${container}'`))).to.equal(false);
        }
    });

    it('uses the target file family to inspect scripted effect and trigger definitions', () => {
        const effectPayload = extractWritePayload('write_file', {
            file: 'common/scripted_effects/my_effects.txt',
            content: 'my_effect = { totally_fake_effect = yes }',
        })!;
        const triggerPayload = extractWritePayload('write_file', {
            file: 'common/scripted_triggers/my_triggers.txt',
            content: 'my_trigger = { totally_fake_trigger = yes }',
        })!;
        expect(extractClaimsFromText(effectPayload).some(c => c.claim.includes('totally_fake_effect'))).to.equal(true);
        expect(extractClaimsFromText(triggerPayload).some(c => c.claim.includes('totally_fake_trigger'))).to.equal(true);
        expect(extractLocalDefinitions(effectPayload)).to.deep.equal([{ id: 'my_effect', kind: 'scripted_effect' }]);
        expect(extractLocalDefinitions(triggerPayload)).to.deep.equal([{ id: 'my_trigger', kind: 'scripted_trigger' }]);
    });

    it('extracts triggered-only reachability and bare on_action event references', () => {
        const eventPayload = extractWritePayload('write_file', {
            file: 'events/my_events.txt',
            content: 'country_event = { id = my_event.10 is_triggered_only = yes }',
        })!;
        const entry = extractClaimsFromText(eventPayload).find(claim => claim.kind === 'call_chain');
        expect(entry?.blocking).to.equal(true);
        expect(entry?.subject).to.deep.include({ entryId: 'my_event.10', requiresCaller: true });
        expect(extractLocalDefinitions(eventPayload)).to.deep.equal([{ id: 'my_event.10', kind: 'event' }]);

        const onActionPayload = extractWritePayload('write_file', {
            file: 'common/on_actions/my_on_actions.txt',
            content: 'on_game_start = { events = { my_event.10 my_event.11 } }',
        })!;
        const references = extractClaimsFromText(onActionPayload)
            .filter(claim => claim.kind === 'reference_exists')
            .map(claim => claim.subject.type === 'reference' ? claim.subject.id : '');
        expect(references).to.include.members(['my_event.10', 'my_event.11']);
    });

    it('treats nested event blocks as id references and modifier blocks as modifier usages', () => {
        const payload = extractWritePayload('write_file', {
            file: 'events/a.txt',
            content: [
                'country_event = {',
                '  id = my_event.2',
                '  option = {',
                '    name = my_loc_key',
                '    country_event = { id = other_event.7 days = 5 }',
                '    add_modifier = { modifier = my_static_mod duration = -1 }',
                '    my_scripted_effect = yes',
                '  }',
                '}',
            ].join('\n'),
        })!;
        const claims = extractClaimsFromText(payload);

        const eventRef = claims.find(c => c.kind === 'reference_exists' && c.claim.includes('other_event.7'));
        expect(eventRef, 'nested event id reference').to.not.equal(undefined);
        expect(eventRef!.subject).to.deep.include({ refKind: 'event' });

        const modRef = claims.find(c => c.kind === 'reference_exists' && c.claim.includes('my_static_mod'));
        expect(modRef, 'static modifier reference').to.not.equal(undefined);
        expect(modRef!.subject).to.deep.include({ refKind: 'static_modifier' });

        const scriptedCall = claims.find(c => c.kind === 'symbol_exists' && c.claim.includes('my_scripted_effect'));
        expect(scriptedCall, 'boolean-style scripted call candidate').to.not.equal(undefined);

        // `name = my_loc_key` is an option argument, not a scripted call.
        expect(claims.some(c => c.claim.includes("'name'"))).to.equal(false);
        expect(claims.some(c => c.claim.includes('my_loc_key'))).to.equal(false);
    });

    it('extracts conservative typed technology, trait, and building references', () => {
        const payload = extractWritePayload('write_file', {
            file: 'events/entity_refs.txt',
            content: [
                'country_event = {',
                '  id = entity_refs.1',
                '  trigger = {',
                '    has_technology = tech_verified',
                '    has_trait = leader_trait_verified',
                '    has_building = building_verified',
                '  }',
                '  immediate = {',
                '    give_technology = { tech = tech_block_verified message = no }',
                '    add_trait = { trait = leader_trait_block_verified }',
                '    add_building = { building = building_block_verified }',
                '  }',
                '}',
            ].join('\n'),
        })!;
        const references = extractClaimsFromText(payload)
            .filter(claim => claim.subject.type === 'reference')
            .map(claim => claim.subject.type === 'reference'
                ? `${claim.subject.refKind}:${claim.subject.id}`
                : '');

        expect(references).to.include.members([
            'technology:tech_verified',
            'trait:leader_trait_verified',
            'building:building_verified',
            'technology:tech_block_verified',
            'trait:leader_trait_block_verified',
            'building:building_block_verified',
        ]);
        expect(references.some(reference => reference.endsWith(':no'))).to.equal(false);
    });

    it('extracts generic same-write definitions from typed common directories', () => {
        const technology = extractWritePayload('write_file', {
            file: 'common/technology/my_tech.txt',
            content: 'tech_verified = { area = physics }',
        })!;
        const building = extractWritePayload('write_file', {
            file: 'common/buildings/my_building.txt',
            content: 'building_verified = { category = government }',
        })!;
        const trait = extractWritePayload('write_file', {
            file: 'common/traits/my_trait.txt',
            content: 'leader_trait_verified = { leader_trait = { } }',
        })!;

        expect(extractLocalDefinitions(technology)).to.deep.equal([{ id: 'tech_verified', kind: 'technology' }]);
        expect(extractLocalDefinitions(building)).to.deep.equal([{ id: 'building_verified', kind: 'building' }]);
        expect(extractLocalDefinitions(trait)).to.deep.equal([{ id: 'leader_trait_verified', kind: 'trait' }]);
    });

    it('flags modifier keys inside modifier blocks and ignores comments and strings', () => {
        const payload = extractWritePayload('write_file', {
            file: 'common/modifiers/a.txt',
            content: [
                'option = {',
                '  modifier = {',
                '    ship_hull_mult = 0.1',
                '    # planet_jobs_produces_mult = 0.2',
                '    custom = "effect = { not_a_claim = yes }"',
                '  }',
                '}',
            ].join('\n'),
        })!;
        const claims = extractClaimsFromText(payload);
        const hull = claims.find(c => c.claim.includes('ship_hull_mult'));
        expect(hull, 'numeric modifier usage').to.not.equal(undefined);
        expect(hull!.subject).to.deep.include({ position: 'modifier' });
        expect(claims.some(c => c.claim.includes('planet_jobs_produces_mult'))).to.equal(false);
        expect(claims.some(c => c.claim.includes('not_a_claim'))).to.equal(false);
    });

    it('stays bounded on large or hostile payloads', () => {
        const hugeLine = 'effect = { fake_effect_%d = yes }\n';
        const huge = hugeLine.repeat(2000).replace(/%d/g, () => String(Math.floor(Math.random() * 1e9)));
        const payload = extractWritePayload('write_file', { file: 'events/big.txt', content: huge })!;
        const claims = extractClaimsFromText(payload);
        expect(claims.length).to.be.at.most(MAX_CLAIM_CANDIDATES);

        const oversized = 'x = 1\n'.repeat(MAX_EXTRACT_CHARS);
        const truncatedPayload = extractWritePayload('write_file', { file: 'events/big.txt', content: oversized })!;
        expect(truncatedPayload.truncated).to.equal(true);
        expect(truncatedPayload.text.length).to.equal(MAX_EXTRACT_CHARS);
        // Never throws, always returns an array.
        expect(Array.isArray(extractClaimsFromText(truncatedPayload))).to.equal(true);

        const malformed = extractWritePayload('write_file', { file: 'events/big.txt', content: '{{{{ = = = "unclosed' })!;
        expect(Array.isArray(extractClaimsFromText(malformed))).to.equal(true);
    });
});

// - EvidenceGate unit tests with fake sources -

const FAKE_RULES: Record<string, GateRuleInfo[]> = {
    effect: [
        { name: 'add_opinion_modifier', scopes: ['country'] },
        { name: 'set_variable', scopes: [] },
        { name: 'give_technology', scopes: [] },
        { name: 'add_trait', scopes: [] },
        { name: 'add_building', scopes: [] },
    ],
    trigger: [
        { name: 'has_trait', scopes: ['leader'] },
        { name: 'always', scopes: ['all'] },
    ],
    scope_change: [
        { name: 'every_country', scopes: [], pushScope: 'country' },
    ],
    modifier: [
        { name: 'ship_hull_mult', scopes: [] },
    ],
};

interface FakeLspOptions {
    parseValid?: boolean;
    parseErrors?: Array<{ line: number; col: number; message: string }>;
    definitions?: Set<string>;
    definitionTypes?: Map<string, string>;
    throwAll?: boolean;
    onParse?: () => void;
}

function makeGateDeps(overrides: {
    workspaceRoot: string;
    lsp?: FakeLspOptions;
    indexEntries?: Set<string>;
    lspCalls?: Array<{ command: string; args: unknown[] }>;
    indexRevision?: () => string;
    now?: () => number;
    totalTimeoutMs?: number;
    references?: Array<{ file: string; line?: number; context?: string }>;
}) {
    const lspCalls = overrides.lspCalls ?? [];
    const lsp = overrides.lsp ?? {};
    return {
        workspaceRoot: overrides.workspaceRoot,
        gameProfile: 'stellaris',
        now: overrides.now,
        totalTimeoutMs: overrides.totalTimeoutMs,
        sendLspCommand: async (command: string, args: unknown[]): Promise<unknown> => {
            lspCalls.push({ command, args });
            if (lsp.throwAll) throw new Error('LSP unavailable');
            if (command === 'cwtools.ai.parseFragment') {
                lsp.onParse?.();
                return { ok: true, valid: lsp.parseValid !== false, fragments: 1, errors: lsp.parseErrors ?? [] };
            }
            if (command === 'cwtools.ai.queryDefinitionByName') {
                const id = String(args[0] ?? '');
                const expectedTypes = Array.isArray(args[1])
                    ? args[1].filter((value): value is string => typeof value === 'string')
                    : [];
                return lsp.definitions?.has(id)
                    ? {
                        ok: true,
                        name: id,
                        type: lsp.definitionTypes?.get(id) ?? expectedTypes[0],
                        file: path.join(overrides.workspaceRoot, 'events', 'x.txt'),
                        line: 1,
                    }
                    : { ok: false, error: 'not found' };
            }
            return undefined;
        },
        queryRules: async (category: 'trigger' | 'effect' | 'scope_change' | 'modifier', name: string): Promise<GateRuleInfo[]> => {
            const rules = FAKE_RULES[category] ?? [];
            const exact = rules.filter(r => r.name.toLowerCase() === name.toLowerCase());
            if (exact.length > 0) return exact;
            // Mirror LspToolHandler fuzzy fallback: non-exact suggestions the gate must reject.
            return rules
                .filter(r => r.name.toLowerCase().startsWith(name.toLowerCase().slice(0, 4)))
                .map(r => ({ ...r }));
        },
        indexLookup: async (name: string) => ({
            found: overrides.indexEntries?.has(name) ?? false,
            fileVersion: 7,
            indexUpdatedAt: 1000,
        }),
        queryReferences: async () => overrides.references ?? [],
        getIndexRevision: overrides.indexRevision ?? (() => '1000:7:ready'),
        rulesRoots: [] as string[],
    };
}

describe('EvidenceGate', () => {
    let workspaceRoot: string;
    beforeEach(() => { workspaceRoot = makeWorkspace(); });
    afterEach(() => { cleanupWorkspace(workspaceRoot); });

    async function evaluate(content: string, deps: ReturnType<typeof makeGateDeps>, mode: 'shadow' | 'enforce' = 'shadow') {
        const gate = new EvidenceGate(deps);
        const decision = await gate.evaluate({
            toolName: 'write_file',
            targetFile: path.join(workspaceRoot, 'events', 'a.txt'),
            text: content,
            mode,
        });
        expect(isEvidenceGateDecision(decision)).to.equal(true);
        return decision;
    }

    it('verifies a fully legal write (syntax + rule + scope + scripted reference)', async () => {
        const deps = makeGateDeps({ workspaceRoot, lsp: { definitions: new Set(['my_scripted_effect']) } });
        const decision = await evaluate([
            'effect = {',
            '  every_country = {',
            '    add_opinion_modifier = { who = root modifier = x }',
            '  }',
            '  my_scripted_effect = yes',
            '}',
        ].join('\n'), deps);

        expect(decision.verdict).to.equal('allow');
        expect(decision.missingEvidence).to.have.lengthOf(0);
        const statuses = new Map(decision.claims.map(c => [c.kind + ':' + c.claim, c.status]));
        for (const [key, status] of statuses) {
            expect(status, key).to.equal('verified');
        }
        const scopeClaim = decision.claims.find(c => c.kind === 'scope_compatibility' && c.claim.includes('add_opinion_modifier'));
        expect(scopeClaim?.sources[0]?.revision).to.match(/^rules:/);
        expect(scopeClaim?.sources[0]?.gameProfile).to.equal('stellaris');
    });

    it('conflicts when a name is used in a scope its rule does not support', async () => {
        const deps = makeGateDeps({ workspaceRoot });
        const decision = await evaluate([
            'limit = {',
            '  every_country = {',
            '    has_trait = leader_trait_x',
            '  }',
            '}',
        ].join('\n'), deps, 'enforce');

        expect(decision.verdict).to.equal('block');
        const scopeClaim = decision.claims.find(c => c.kind === 'scope_compatibility' && c.claim.includes('has_trait'));
        expect(scopeClaim?.status).to.equal('conflict');
        expect(scopeClaim?.blocking).to.equal(true);
        expect(scopeClaim?.detail).to.include('leader');
        const missing = decision.missingEvidence.find(m => m.kind === 'scope_compatibility');
        expect(missing?.suggestedQueries.some(q => q.includes('query_rules'))).to.equal(true);
    });

    it('conflicts when neither CWT rules nor any index knows an effect name', async () => {
        const deps = makeGateDeps({ workspaceRoot });
        const decision = await evaluate('effect = { totally_fake_effect = yes }', deps, 'enforce');

        expect(decision.verdict).to.equal('block');
        const ref = decision.claims.find(c => c.kind === 'reference_exists' && c.claim.includes('totally_fake_effect'));
        expect(ref?.status).to.equal('conflict');
        const missing = decision.missingEvidence.find(m => m.claim.includes('totally_fake_effect'));
        expect(missing?.suggestedQueries.some(q => q.includes('verify_pdx_identifier'))).to.equal(true);
    });

    it('verifies unknown effect names as scripted_effect definitions via the LSP', async () => {
        const deps = makeGateDeps({ workspaceRoot, lsp: { definitions: new Set(['my_custom_effect']) } });
        const decision = await evaluate('effect = { my_custom_effect = yes }', deps, 'enforce');
        expect(decision.verdict).to.equal('allow');
        const ref = decision.claims.find(c => c.kind === 'reference_exists' && c.claim.includes('my_custom_effect'));
        expect(ref?.status).to.equal('verified');
    });

    it('rejects a same-named definition of the wrong entity type', async () => {
        const deps = makeGateDeps({
            workspaceRoot,
            lsp: {
                definitions: new Set(['my_custom_effect']),
                definitionTypes: new Map([['my_custom_effect', 'technology']]),
            },
        });
        const decision = await evaluate('effect = { my_custom_effect = yes }', deps, 'enforce');
        const ref = decision.claims.find(c => c.kind === 'reference_exists' && c.claim.includes('my_custom_effect'));
        expect(ref?.status).to.equal('conflict');
        expect(ref?.detail).to.include("type 'technology'");
        expect(decision.verdict).to.equal('block');
    });

    it('requires exact typed definitions for technology, trait, and building ids', async () => {
        const ids = new Set(['tech_verified', 'leader_trait_verified', 'building_verified']);
        const types = new Map([
            ['tech_verified', 'technology'],
            ['leader_trait_verified', 'trait'],
            ['building_verified', 'building'],
        ]);
        const lspCalls: Array<{ command: string; args: unknown[] }> = [];
        const deps = makeGateDeps({
            workspaceRoot,
            lsp: { definitions: ids, definitionTypes: types },
            lspCalls,
        });
        const decision = await evaluate([
            'effect = {',
            '  give_technology = tech_verified',
            '  add_trait = leader_trait_verified',
            '  add_building = building_verified',
            '}',
        ].join('\n'), deps, 'enforce');

        expect(decision.verdict).to.equal('allow');
        for (const id of ids) {
            expect(decision.claims.find(claim => claim.kind === 'reference_exists' && claim.claim.includes(id))?.status).to.equal('verified');
        }
        const expectedById = new Map(lspCalls
            .filter(call => call.command === 'cwtools.ai.queryDefinitionByName')
            .map(call => [String(call.args[0]), call.args[1]]));
        expect(expectedById.get('tech_verified')).to.deep.equal(['technology']);
        expect(expectedById.get('leader_trait_verified')).to.deep.equal(['trait']);
        expect(expectedById.get('building_verified')).to.deep.equal(['building']);
    });

    it('blocks a plausible generic entity id when only a wrong typed definition exists', async () => {
        const deps = makeGateDeps({
            workspaceRoot,
            lsp: {
                definitions: new Set(['tech_that_looks_real']),
                definitionTypes: new Map([['tech_that_looks_real', 'building']]),
            },
        });
        const decision = await evaluate('limit = { has_technology = tech_that_looks_real }', deps, 'enforce');
        const ref = decision.claims.find(claim => claim.kind === 'reference_exists' && claim.claim.includes('tech_that_looks_real'));
        expect(ref?.status).to.equal('conflict');
        expect(ref?.detail).to.include("type 'building'");
        expect(decision.verdict).to.equal('block');
    });

    it('rejects fuzzy rule suggestions that are not exact matches', async () => {
        const deps = makeGateDeps({ workspaceRoot });
        // 'add_opinion' fuzzily suggests 'add_opinion_modifier' but must not verify.
        const decision = await evaluate('effect = { add_opinion = yes }', deps, 'enforce');
        expect(decision.verdict).to.equal('block');
        expect(decision.claims.some(c => c.kind === 'symbol_exists' && c.status === 'verified')).to.equal(false);
    });

    it('marks invalid syntax as conflict with the parse errors attached', async () => {
        const deps = makeGateDeps({
            workspaceRoot,
            lsp: { parseValid: false, parseErrors: [{ line: 0, col: 3, message: 'unexpected token' }] },
        });
        const decision = await evaluate('effect = { broken', deps, 'enforce');
        expect(decision.verdict).to.equal('block');
        const syntax = decision.claims.find(c => c.kind === 'syntax_shape');
        expect(syntax?.status).to.equal('conflict');
        expect(syntax?.detail).to.include('unexpected token');
    });

    it('allows enforce-mode writes with advisory evidence when the LSP channel is down', async () => {
        const deps = makeGateDeps({ workspaceRoot, lsp: { throwAll: true } });
        const decision = await evaluate('effect = { add_opinion_modifier = yes }', deps, 'enforce');
        expect(decision.verdict).to.equal('allow');
        expect(decision.degraded).to.equal(true);
        expect(decision.evidenceUnavailable).to.equal(true);
        expect(decision.claims.find(c => c.kind === 'syntax_shape')?.status).to.equal('unknown');
        expect(decision.missingEvidence.some(item => item.status === 'unknown')).to.equal(true);
    });

    it('records degraded shadow decisions without turning unknowns into verified', async () => {
        const deps = makeGateDeps({ workspaceRoot, lsp: { throwAll: true } });
        const decision = await evaluate('effect = { add_opinion_modifier = yes }', deps, 'shadow');
        expect(decision.verdict).to.equal('allow');
        expect(decision.degraded).to.equal(true);
    });

    it('treats index/LSP disagreement as stale advisory evidence', async () => {
        const deps = makeGateDeps({ workspaceRoot, indexEntries: new Set(['other_event.7']) });
        const decision = await evaluate('effect = { country_event = { id = other_event.7 } }', deps, 'enforce');
        const ref = decision.claims.find(c => c.kind === 'reference_exists' && c.claim.includes('other_event.7'));
        expect(ref?.status).to.equal('stale');
        expect(ref?.detail).to.include('workspace index');
        expect(decision.verdict).to.equal('allow');
    });

    it('stays unknown when only the index (not the LSP) can confirm an id', async () => {
        const deps = makeGateDeps({ workspaceRoot, lsp: { throwAll: true }, indexEntries: new Set(['other_event.7']) });
        const decision = await evaluate('effect = { country_event = { id = other_event.7 } }', deps, 'shadow');
        const ref = decision.claims.find(c => c.kind === 'reference_exists' && c.claim.includes('other_event.7'));
        expect(ref?.status).to.equal('unknown');
        expect(ref?.detail).to.include('did not return a matching typed definition');
    });

    it('verifies referenced event ids found by the LSP', async () => {
        const deps = makeGateDeps({ workspaceRoot, lsp: { definitions: new Set(['other_event.7']) } });
        const decision = await evaluate('effect = { country_event = { id = other_event.7 } }', deps, 'enforce');
        const ref = decision.claims.find(c => c.kind === 'reference_exists' && c.claim.includes('other_event.7'));
        expect(ref?.status).to.equal('verified');
        expect(decision.verdict).to.equal('allow');
    });

    it('uses exact pending definitions for same-write references before the LSP can index them', async () => {
        const deps = makeGateDeps({ workspaceRoot, lsp: { definitions: new Set() } });
        const decision = await evaluate([
            'country_event = {',
            '  id = local_event.1',
            '  immediate = { country_event = { id = local_event.2 } }',
            '}',
            'country_event = { id = local_event.2 }',
        ].join('\n'), deps, 'enforce');
        const reference = decision.claims.find(claim => claim.kind === 'reference_exists' && claim.claim.includes('local_event.2'));
        expect(reference?.status).to.equal('verified');
        expect(reference?.sources.some(source => source.tool === 'pending_write.localDefinition')).to.equal(true);
        expect(decision.verdict).to.equal('allow');
    });

    it('allows a triggered-only event before a future caller and verifies an existing external caller', async () => {
        const content = 'country_event = { id = local_event.3 is_triggered_only = yes }';
        const unreachable = await evaluate(content, makeGateDeps({ workspaceRoot }), 'enforce');
        const missingCall = unreachable.claims.find(claim => claim.kind === 'call_chain');
        expect(missingCall?.status).to.equal('unknown');
        expect(missingCall?.detail).to.include('dependent Agent');
        expect(unreachable.verdict).to.equal('allow');

        const reachable = await evaluate(content, makeGateDeps({
            workspaceRoot,
            references: [{ file: 'common/on_actions/my_on_actions.txt', line: 8, context: 'events = { local_event.3 }' }],
        }), 'enforce');
        const call = reachable.claims.find(claim => claim.kind === 'call_chain');
        expect(call?.status).to.equal('verified');
        expect(call?.sources[0]?.tool).to.equal('project.queryReferences');
        expect(reachable.verdict).to.equal('allow');
    });

    it('marks claims stale when the target file changes during collection', async () => {
        const target = path.join(workspaceRoot, 'events', 'a.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'original = yes\n');
        const deps = makeGateDeps({
            workspaceRoot,
            lsp: {
                onParse: () => {
                    const future = new Date(Date.now() + 5000);
                    fs.utimesSync(target, future, future);
                },
            },
        });
        const decision = await evaluate('effect = { add_opinion_modifier = yes }', deps, 'enforce');
        expect(decision.verdict).to.equal('allow');
        expect(decision.claims.find(c => c.kind === 'syntax_shape')?.status).to.equal('stale');
    });

    it('serves repeat evaluations of identical input from the decision cache', async () => {
        const lspCalls: Array<{ command: string; args: unknown[] }> = [];
        const deps = makeGateDeps({ workspaceRoot, lspCalls });
        const gate = new EvidenceGate(deps);
        const input = {
            toolName: 'write_file',
            targetFile: path.join(workspaceRoot, 'events', 'a.txt'),
            text: 'plain_value = 42',
            mode: 'shadow' as const,
        };
        const first = await gate.evaluate(input);
        const second = await gate.evaluate(input);
        expect(first.fromCache).to.equal(undefined);
        expect(second.fromCache).to.equal(true);
        expect(second.decisionId).to.equal(first.decisionId);
        expect(lspCalls.filter(c => c.command === 'cwtools.ai.parseFragment')).to.have.lengthOf(1);
    });

    it('invalidates an allowed decision when the index revision changes', async () => {
        let revision = 'index-a';
        const lspCalls: Array<{ command: string; args: unknown[] }> = [];
        const deps = makeGateDeps({ workspaceRoot, lspCalls, indexRevision: () => revision });
        const gate = new EvidenceGate(deps);
        const input = {
            toolName: 'write_file',
            targetFile: path.join(workspaceRoot, 'events', 'a.txt'),
            text: 'plain_value = 42',
            mode: 'shadow' as const,
        };
        await gate.evaluate(input);
        expect((await gate.evaluate(input)).fromCache).to.equal(true);
        revision = 'index-b';
        expect((await gate.evaluate(input)).fromCache).to.equal(undefined);
        expect(lspCalls.filter(c => c.command === 'cwtools.ai.parseFragment')).to.have.lengthOf(2);
    });

    it('keeps unresolved claims unknown (not degraded) when the time budget runs out', async () => {
        let now = 0;
        const deps = makeGateDeps({
            workspaceRoot,
            now: () => now,
            lsp: {
                onParse: () => { now += 10_000; },
            },
        });
        const gate = new EvidenceGate(deps);
        const decision = await gate.evaluate({
            toolName: 'write_file',
            targetFile: path.join(workspaceRoot, 'events', 'a.txt'),
            text: 'effect = { add_opinion_modifier = yes }',
            mode: 'enforce',
        });
        expect(decision.degraded).to.equal(undefined);
        const ruleClaims = decision.claims.filter(c => c.kind !== 'syntax_shape');
        expect(ruleClaims.length).to.be.greaterThan(0);
        for (const claim of ruleClaims) {
            expect(claim.status).to.equal('unknown');
            expect(claim.detail).to.include('time budget');
        }
        expect(decision.verdict).to.equal('allow');
    });

    it('produces machine-readable missing evidence with suggested queries', async () => {
        const deps = makeGateDeps({ workspaceRoot });
        const decision = await evaluate('effect = { totally_fake_effect = yes }', deps, 'enforce');
        expect(decision.missingEvidence.length).to.be.greaterThan(0);
        for (const item of decision.missingEvidence) {
            expect(item.status).to.be.oneOf(['unknown', 'conflict', 'stale']);
            expect(item.suggestedQueries.length).to.be.greaterThan(0);
        }
    });

    it('parses the complete oversized file and marks bounded semantic coverage pending', async () => {
        const lspCalls: Array<{ command: string; args: unknown[] }> = [];
        const gate = new EvidenceGate(makeGateDeps({ workspaceRoot, lspCalls }));
        const content = `${'x = 1\n'.repeat(20_000)}tail = yes\n`;
        const decision = await gate.evaluate({
            toolName: 'write_file',
            targetFile: path.join(workspaceRoot, 'events', 'large.txt'),
            text: content,
            mode: 'enforce',
            phase: 'post_write',
        });
        const parseCall = lspCalls.find(call => call.command === 'cwtools.ai.parseFragment');
        expect(parseCall?.args[0]).to.equal(content);
        expect(decision.claims.some(claim =>
            claim.blocking && claim.status === 'unknown' && claim.claim.includes('complete written file'))).to.equal(true);
    });

    it('normalizes untrusted mode values', () => {
        expect(normalizeEvidenceGateMode('off')).to.equal('off');
        expect(normalizeEvidenceGateMode('enforce')).to.equal('enforce');
        expect(normalizeEvidenceGateMode('shadow')).to.equal('shadow');
        expect(normalizeEvidenceGateMode('bogus')).to.equal('enforce');
        expect(normalizeEvidenceGateMode(undefined)).to.equal('enforce');
        expect(normalizeEvidenceGateMode(42)).to.equal('enforce');
    });

    it('computes a stable rules fingerprint that changes with rule file mtimes', () => {
        const rulesDir = path.join(workspaceRoot, 'rules', 'config');
        fs.mkdirSync(rulesDir, { recursive: true });
        const fp1 = computeRulesFingerprint([rulesDir]);
        expect(fp1).to.equal('none');
        const effectsFile = path.join(rulesDir, 'effects.cwt');
        fs.writeFileSync(effectsFile, 'add_x = { scopes = { country } }');
        const fp2 = computeRulesFingerprint([rulesDir]);
        expect(fp2).to.not.equal('none');
        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(effectsFile, future, future);
        const fp3 = computeRulesFingerprint([rulesDir]);
        expect(fp3).to.not.equal(fp2);
    });
});

describe('reducePolicyActivity evidence gate counters', () => {
    function ev(type: string, payload: any): AgentRunEvent {
        return {
            eventId: `evt_${Math.random().toString(36).slice(2, 8)}`,
            runId: 'run_1',
            sequence: 0,
            timestamp: Date.now(),
            type: type as AgentRunEvent['type'],
            payload,
        };
    }

    it('counts gate verdicts and degraded decisions', () => {
        const snap = reducePolicyActivity([
            ev('evidence_gate_decision', { verdict: 'allow', mode: 'shadow' }),
            ev('evidence_gate_decision', { verdict: 'allow', mode: 'enforce' }),
            ev('evidence_gate_decision', { verdict: 'block', mode: 'shadow', degraded: true }),
            ev('evidence_gate_decision', { verdict: 'block', mode: 'enforce' }),
            ev('evidence_gate_decision', { verdict: 'override', mode: 'enforce' }),
        ]);
        expect(snap.evidenceGate.decisions).to.equal(5);
        expect(snap.evidenceGate.allowed).to.equal(2);
        expect(snap.evidenceGate.blocked).to.equal(2);
        expect(snap.evidenceGate.overrides).to.equal(1);
        expect(snap.evidenceGate.degraded).to.equal(1);
    });
});

// - AgentToolExecutor wiring tests (vscode stubbed via module._load hook) -

let gateModeConfig: string = 'shadow';
const stubConfigOverrides: Record<string, unknown> = {};

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        isTrusted: true,
        getConfiguration: (section?: string) => ({
            get: <T,>(key: string, defaultValue?: T): T | undefined => {
                if (section === 'stellarisLanguageServices.ai.evidenceGate' && key === 'mode') {
                    return gateModeConfig as T;
                }
                if (key in stubConfigOverrides) return stubConfigOverrides[key] as T;
                return defaultValue;
            },
            update: async () => undefined,
        }),
        openTextDocument: async () => {
            // No editor in tests; the diagnostics fallback tolerates this.
            throw new Error('no documents in unit tests');
        },
    },
    languages: {
        getDiagnostics: () => [],
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    commands: {
        executeCommand: async (..._args: unknown[]): Promise<unknown> => undefined,
    },
    SymbolKind: { 0: 'File' },
    extensions: {
        getExtension: () => undefined,
    },
    Uri: {
        file: (filePath: string) => ({
            fsPath: filePath,
            toString: () => `file://${filePath.replace(/\\/g, '/')}`,
        }),
    },
    window: {
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};

function loadExecutorModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        // Other test files may have loaded these modules with their own
        // vscode stubs (which lack `extensions` / `openTextDocument`). Reload
        // the gate-relevant modules so this file's stub is authoritative.
        for (const mod of [
            '../../extension/ai/agentTools',
            '../../extension/ai/tools/lspTools',
            '../../extension/ai/tools/fileTools',
        ]) {
            delete require.cache[require.resolve(mod)];
        }
        return require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

function makeFakeLspClient(opts: { definitions?: Set<string>; throwAll?: boolean; parseValid?: boolean }) {
    let epoch = 0;
    const sendRequest = sinon.stub().callsFake(async (method: string, params: any) => {
        if (method !== 'workspace/executeCommand') return undefined;
        if (opts.throwAll) throw new Error('LSP unavailable');
        const command = params?.command as string | undefined;
        if (command === 'cwtools.ai.parseFragment') {
            return { ok: true, valid: opts.parseValid !== false, fragments: 1, errors: [] };
        }
        if (command === 'cwtools.ai.queryDefinitionByName') {
            const id = String(params?.arguments?.[0] ?? '');
            const expectedTypes = Array.isArray(params?.arguments?.[1]) ? params.arguments[1] : [];
            return opts.definitions?.has(id)
                ? { ok: true, name: id, type: expectedTypes[0], file: 'events/x.txt', line: 1 }
                : { ok: false, error: 'not found' };
        }
        if (command === 'cwtools.ai.getDiagnosticsFresh') {
            epoch += 1;
            return { freshness: 'fresh', epoch, pendingGlobalKinds: [], diagnostics: [] };
        }
        if (command === 'cwtools.ai.revalidateFiles') return { ok: true, requested: 1 };
        return undefined;
    });
    return { sendRequest };
}

describe('AgentToolExecutor evidence gate wiring', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
        gateModeConfig = 'shadow';
        vscodeStub.commands.executeCommand = async () => undefined;
        for (const key of Object.keys(stubConfigOverrides)) delete stubConfigOverrides[key];
        stubConfigOverrides['policy.preset'] = 'workspace-auto';
    });

    afterEach(() => {
        cleanupWorkspace(workspaceRoot);
    });

    function makeExecutor(lsp: { sendRequest: sinon.SinonStub }) {
        const { AgentToolExecutor } = loadExecutorModule();
        const executor = new AgentToolExecutor(lsp as any, workspaceRoot);
        executor.fileWriteMode = 'auto';
        return executor;
    }

    function makeContext(events: Array<{ type: string; payload: any }>, permissionAnswer?: boolean) {
        return {
            runnerOptions: { mode: 'build', topicId: 'evidence-test' },
            runEventSink: {
                runId: 'evidence-test-run',
                appendSoon: (type: string, payload: any) => events.push({ type, payload }),
            },
            onPermissionRequest: permissionAnswer === undefined
                ? undefined
                : async () => permissionAnswer,
        } as any;
    }

    it('shadow mode records the decision but never blocks the write', async () => {
        const lsp = makeFakeLspClient({ parseValid: false });
        const executor = makeExecutor(lsp);
        const events: Array<{ type: string; payload: any }> = [];
        const target = path.join(workspaceRoot, 'events', 'shadow.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const result = await executor.execute('write_file', {
            file: target,
            content: 'effect = { totally_fake_effect = yes }',
        }, makeContext(events)) as any;

        expect(result.success).to.equal(true);
        expect(fs.existsSync(target)).to.equal(true);
        expect(typeof result.evidenceGate?.decisionId).to.equal('string');
        const gateEvents = events.filter(e => e.type === 'evidence_gate_decision');
        expect(gateEvents).to.have.lengthOf(2);
        expect(gateEvents[0]!.payload.phase).to.equal('pre_write');
        expect(gateEvents[1]!.payload.phase).to.equal('post_write');
        expect(gateEvents[0]!.payload.mode).to.equal('shadow');
        expect(gateEvents[0]!.payload.verdict).to.equal('block');
        expect(gateEvents[0]!.payload.counts.conflict).to.be.greaterThan(0);
        expect(result.postWriteValidationPassed).to.equal(false);
        expect(result.postWriteValidation).to.deep.include({
            verdict: 'repair',
            evidencePassed: false,
            diagnosticsPassed: true,
            diagnosticErrorCount: 0,
        });
    });

    it('enforce mode blocks a confirmed conflict with machine-readable evidence and decisionId', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ parseValid: false });
        const executor = makeExecutor(lsp);
        const events: Array<{ type: string; payload: any }> = [];
        const target = path.join(workspaceRoot, 'events', 'enforce.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const result = await executor.execute('write_file', {
            file: target,
            content: 'effect = { totally_fake_effect = yes }',
        }, makeContext(events)) as any;

        expect(result.success).to.equal(false);
        expect(result.evidenceGateBlocked).to.equal(true);
        expect(typeof result.evidenceGate?.decisionId).to.equal('string');
        expect(Array.isArray(result.evidenceGate?.missingEvidence)).to.equal(true);
        expect(result.evidenceGate.missingEvidence.length).to.be.greaterThan(0);
        const queries = result.evidenceGate.suggestedQueries as string[];
        expect(queries.some(q => q.includes('parse_pdx_fragment'))).to.equal(true);
        expect(fs.existsSync(target)).to.equal(false);
        const gateEvents = events.filter(e => e.type === 'evidence_gate_decision');
        expect(gateEvents).to.have.lengthOf(1);
        expect(gateEvents[0]!.payload.verdict).to.equal('block');
    });

    it('a model-supplied override flag does not bypass enforce mode', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ parseValid: false });
        const executor = makeExecutor(lsp);
        const target = path.join(workspaceRoot, 'events', 'sneaky.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const result = await executor.execute('write_file', {
            file: target,
            content: 'effect = { totally_fake_effect = yes }',
            _evidenceGateOverride: true,
            _autoApply: true,
        }, makeContext([])) as any;

        expect(result.success).to.equal(false);
        expect(result.evidenceGateBlocked).to.equal(true);
        expect(fs.existsSync(target)).to.equal(false);
    });

    it('manual override via the approval channel writes with verdict override and is recorded', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ parseValid: false });
        const executor = makeExecutor(lsp);
        const events: Array<{ type: string; payload: any }> = [];
        const target = path.join(workspaceRoot, 'events', 'override.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const result = await executor.execute('write_file', {
            file: target,
            content: 'effect = { totally_fake_effect = yes }',
        }, makeContext(events, true)) as any;

        expect(result.success).to.equal(true);
        expect(fs.existsSync(target)).to.equal(true);
        const gateEvents = events.filter(e => e.type === 'evidence_gate_decision');
        expect(gateEvents.length).to.be.greaterThan(0);
        const preWriteEvents = gateEvents.filter(e => e.payload.phase === 'pre_write');
        expect(preWriteEvents[preWriteEvents.length - 1]!.payload.verdict).to.equal('override');
        expect(result.postWriteValidationPassed).to.equal(false);
        expect(result.requiresRepair).to.equal(true);
    });

    it('denying the override keeps the write blocked', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ parseValid: false });
        const executor = makeExecutor(lsp);
        const target = path.join(workspaceRoot, 'events', 'denied.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const result = await executor.execute('write_file', {
            file: target,
            content: 'effect = { totally_fake_effect = yes }',
        }, makeContext([], false)) as any;

        expect(result.success).to.equal(false);
        expect(fs.existsSync(target)).to.equal(false);
    });

    it('keeps writes available without prompting when the LSP evidence channel is down', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ throwAll: true });
        const executor = makeExecutor(lsp);
        const events: Array<{ type: string; payload: any }> = [];
        let permissionAsked = false;
        const context = {
            runnerOptions: { mode: 'build', topicId: 'evidence-test' },
            runEventSink: { runId: 'evidence-test-run', appendSoon: (type: string, payload: any) => events.push({ type, payload }) },
            onPermissionRequest: async () => { permissionAsked = true; return true; },
        } as any;
        const target = path.join(workspaceRoot, 'events', 'closed.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const result = await executor.execute('write_file', {
            file: target,
            content: 'effect = { add_opinion_modifier = yes }',
        }, context) as any;

        expect(result.success).to.equal(true);
        expect(result.evidenceGateBlocked).to.not.equal(true);
        expect(result.evidenceGate?.degraded).to.equal(true);
        expect(result.evidenceGate?.advisoryEvidence).to.be.an('array').that.is.not.empty;
        expect(result.postWriteValidation).to.deep.include({
            verdict: 'pending',
            evidencePassed: false,
            diagnosticsPassed: false,
        });
        expect(result.requiresValidation).to.equal(true);
        expect(result.requiresRepair).to.not.equal(true);
        expect(permissionAsked).to.equal(false);
        expect(fs.existsSync(target)).to.equal(true);
    });

    it('re-runs pending child evidence against the integrated file at finalization', async () => {
        gateModeConfig = 'enforce';
        const lspOptions: { throwAll?: boolean; definitions?: Set<string> } = {
            throwAll: true,
            definitions: new Set(['my_scripted_effect']),
        };
        const lsp = makeFakeLspClient(lspOptions);
        const executor = makeExecutor(lsp);
        const target = path.join(workspaceRoot, 'events', 'revalidate.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const write = await executor.execute('write_file', {
            file: target,
            content: 'effect = { my_scripted_effect = yes }',
        }, makeContext([])) as any;
        expect(write.postWriteValidation?.verdict).to.equal('pending');

        lspOptions.throwAll = false;
        const final = await executor.finalizePdxEvidence([target]);
        expect(final.passed).to.equal(true);
        expect(final.filesChecked).to.deep.equal([target]);
        expect(final.pendingFiles).to.deep.equal([]);
        expect(final.conflictFiles).to.deep.equal([]);
    });

    it('allows enforce-mode writes whose claims all verify', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ definitions: new Set(['my_scripted_effect']) });
        const executor = makeExecutor(lsp);
        const events: Array<{ type: string; payload: any }> = [];
        const target = path.join(workspaceRoot, 'events', 'ok.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const result = await executor.execute('write_file', {
            file: target,
            content: 'effect = { my_scripted_effect = yes }',
        }, makeContext(events)) as any;

        expect(result.success).to.equal(true);
        expect(fs.existsSync(target)).to.equal(true);
        expect(result.evidenceGate?.verdict).to.equal('allow');
        expect(result.postWriteValidation).to.deep.include({
            verdict: 'allow',
            evidencePassed: true,
            diagnosticsPassed: true,
            diagnosticErrorCount: 0,
        });
        const gateEvents = events.filter(e => e.type === 'evidence_gate_decision');
        expect(gateEvents[0]?.payload.verdict).to.equal('allow');
    });

    it('gates edit_file against the exact complete content, not only newString', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ parseValid: false });
        const executor = makeExecutor(lsp);
        const target = path.join(workspaceRoot, 'common', 'scripted_effects', 'edit.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'my_effect = { set_variable = { which = x value = 1 } }\n');

        const result = await executor.execute('edit_file', {
            filePath: target,
            oldString: 'set_variable = { which = x value = 1 }',
            newString: 'totally_fake_effect = yes',
        }, makeContext([])) as any;

        expect(result.success).to.equal(false);
        expect(result.evidenceGateBlocked).to.equal(true);
        expect(fs.readFileSync(target, 'utf8')).to.include('set_variable');
    });

    it('gates replace_lines against the exact complete PDX content before writing', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ parseValid: false });
        const executor = makeExecutor(lsp);
        const target = path.join(workspaceRoot, 'common', 'scripted_effects', 'lines.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, [
            'my_effect = {',
            '  set_variable = { which = x value = 1 }',
            '}',
        ].join('\n'));

        const result = await executor.execute('replace_lines', {
            filePath: target,
            startLine: 2,
            endLine: 2,
            expectedContent: '  set_variable = { which = x value = 1 }',
            newContent: '  totally_fake_effect = yes',
        }, makeContext([])) as any;

        expect(result.success).to.equal(false);
        expect(result.evidenceGateBlocked).to.equal(true);
        expect(fs.readFileSync(target, 'utf8')).to.include('set_variable');
        expect(fs.readFileSync(target, 'utf8')).to.not.include('totally_fake_effect');
    });

    it('gates edit_pdx_block through its delegated structured file write', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ parseValid: false });
        const executor = makeExecutor(lsp);
        const target = path.join(workspaceRoot, 'common', 'scripted_effects', 'block.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'my_effect = { set_variable = { which = x value = 1 } }\n');
        vscodeStub.commands.executeCommand = async (command: unknown) => command === 'vscode.executeDocumentSymbolProvider'
            ? [{
                name: 'my_effect',
                kind: 0,
                range: { start: { line: 0 }, end: { line: 0 } },
                children: [],
            }]
            : undefined;

        const result = await executor.execute('edit_pdx_block', {
            file: target,
            symbol: 'my_effect',
            newContent: 'my_effect = { totally_fake_effect = yes }',
        }, makeContext([])) as any;

        expect(result.success).to.equal(false);
        expect(result.evidenceGateBlocked).to.equal(true);
        expect(fs.readFileSync(target, 'utf8')).to.include('set_variable');
        expect(fs.readFileSync(target, 'utf8')).to.not.include('totally_fake_effect');
    });

    it('allows an edit that removes a pre-existing invalid claim', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({ definitions: new Set(['my_scripted_effect']) });
        const executor = makeExecutor(lsp);
        const target = path.join(workspaceRoot, 'common', 'scripted_effects', 'repair.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'my_effect = { totally_fake_effect = yes }\n');

        const result = await executor.execute('edit_file', {
            filePath: target,
            oldString: 'totally_fake_effect = yes',
            newString: 'my_scripted_effect = yes',
        }, makeContext([])) as any;

        expect(result.success, JSON.stringify(result)).to.equal(true);
        expect(fs.readFileSync(target, 'utf8')).to.include('my_scripted_effect');
        expect(result.postWriteValidationPassed).to.equal(true);
    });

    it('does not gate non-PDX writes even in enforce mode', async () => {
        gateModeConfig = 'enforce';
        const lsp = makeFakeLspClient({});
        const executor = makeExecutor(lsp);
        const events: Array<{ type: string; payload: any }> = [];
        const target = path.join(workspaceRoot, 'notes.md');

        const result = await executor.execute('write_file', {
            file: target,
            content: '# totally not pdx script',
        }, makeContext(events)) as any;

        expect(result.success).to.equal(true);
        expect(result.evidenceGate).to.equal(undefined);
        expect(events.filter(e => e.type === 'evidence_gate_decision')).to.have.lengthOf(0);
    });

    it('mode off disables the gate entirely', async () => {
        gateModeConfig = 'off';
        const lsp = makeFakeLspClient({ definitions: new Set() });
        const executor = makeExecutor(lsp);
        const events: Array<{ type: string; payload: any }> = [];
        const target = path.join(workspaceRoot, 'events', 'off.txt');
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const result = await executor.execute('write_file', {
            file: target,
            content: 'effect = { totally_fake_effect = yes }',
        }, makeContext(events)) as any;

        expect(result.success).to.equal(true);
        expect(result.evidenceGate).to.equal(undefined);
        expect(events.filter(e => e.type === 'evidence_gate_decision')).to.have.lengthOf(0);
    });
});
