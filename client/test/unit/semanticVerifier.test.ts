import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemanticVerifier } from '../../extension/ai/orchestrator/semanticVerifier';
import { TaskGraphEngine } from '../../extension/ai/orchestrator/taskGraphEngine';
import type { PdxSemanticCatalog } from '../../extension/ai/types';

const SEMANTIC_CATALOG: PdxSemanticCatalog = {
    status: 'ready',
    source: 'lsp',
    gameProfile: 'test',
    rules: [
        { name: 'realm_event', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: 'id', access: 'type', typeName: 'event.realm' }] },
        { name: 'set_realm_flag', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'value_set', typeName: 'realm_flag' }] },
        { name: 'has_realm_flag', category: 'trigger', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'value', typeName: 'realm_flag' }] },
        { name: 'store_anchor', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'value_set', typeName: 'anchor_handle' }] },
        { name: 'uses_anchor', category: 'trigger', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'value', typeName: 'anchor_handle' }] },
        { name: 'create_fleet', category: 'effect', supportedScopes: [], valueReferences: [] },
        { name: 'set_owner', category: 'effect', supportedScopes: [], valueReferences: [] },
        { name: 'set_location', category: 'effect', supportedScopes: [], valueReferences: [] },
    ],
    definitionTypes: [
        { name: 'event', paths: ['events'], nameField: 'id', typeKeyFilters: ['realm_event'] },
        { name: 'scripted_effect', paths: ['common/scripted_effects'], typeKeyFilters: [] },
        { name: 'scripted_trigger', paths: ['common/scripted_triggers'], typeKeyFilters: [] },
    ],
    warnings: [],
};

function semanticTools(execute: (toolName: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: false })) {
    return {
        execute,
        getPdxSemanticCatalog: async () => SEMANTIC_CATALOG,
    };
}

describe('SemanticVerifier', () => {
    let root = '';

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-semantic-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('enforces explicitly declared typed lifecycles without game-specific heuristics', async () => {
        const eventFile = path.join(root, 'events', 'broken.txt');
        const locFile = path.join(root, 'localisation', 'broken_l_english.yml');
        fs.mkdirSync(path.dirname(eventFile), { recursive: true });
        fs.mkdirSync(path.dirname(locFile), { recursive: true });
        fs.writeFileSync(eventFile, [
            'namespace = broken',
            'realm_event = {',
            '  id = broken.1',
            '  immediate = {',
            '    set_realm_flag = broken_unused_flag',
            '    store_anchor = broken_unused_target',
            '    set_location = { target = root target = prev }',
            '  }',
            '}',
        ].join('\n'));
        fs.writeFileSync(locFile, 'l_english:\n broken.2.title:0 "Missing event"\n');

        const graph = TaskGraphEngine.createGraph('build broken chain', {
            objective: 'Build a connected event chain',
            expectsFileChanges: true,
            acceptanceCriteria: [
                { id: 'flag_lifecycle', description: 'Realm state is consumed', type: 'typed_lifecycle', entityKind: 'realm_flag', subject: 'broken_unused_flag' },
                { id: 'target_lifecycle', description: 'Target is consumed', type: 'typed_lifecycle', entityKind: 'anchor_handle', subject: 'broken_unused_target' },
            ],
        });
        const verifier = new SemanticVerifier();
        const result = await verifier.verify(root, [eventFile, locFile], graph, semanticTools(
            async (toolName) => toolName === 'find_references' ? { references: [] } : { ok: false },
        ));

        expect(result.passed).to.equal(false);
        expect(result.acceptanceFailures).to.have.length(2);
        expect(result.issues.filter(issue => issue.code === 'acceptance_failed')).to.have.length(2);
        expect(result.issues.some(issue => issue.code === 'duplicate_target_assignment' || issue.code === 'orphan_localisation')).to.equal(false);
    });

    it('proves producer-consumer edges for a connected event and scripted effect', async () => {
        const eventFile = path.join(root, 'events', 'connected.txt');
        const effectFile = path.join(root, 'common', 'scripted_effects', 'connected.txt');
        fs.mkdirSync(path.dirname(eventFile), { recursive: true });
        fs.mkdirSync(path.dirname(effectFile), { recursive: true });
        fs.writeFileSync(effectFile, [
            'connected_create_fleet = {',
            '  create_fleet = { effect = { set_owner = root } }',
            '  store_anchor = connected_fleet',
            '}',
        ].join('\n'));
        fs.writeFileSync(eventFile, [
            'namespace = connected',
            'realm_event = {',
            '  id = connected.1',
            '  trigger = { has_realm_flag = connected_enabled }',
            '  immediate = {',
            '    set_realm_flag = connected_enabled',
            '    connected_create_fleet = { }',
            '    uses_anchor = connected_fleet',
            '  }',
            '}',
        ].join('\n'));

        const graph = TaskGraphEngine.createGraph('build connected chain', {
            objective: 'Build a connected event and fleet effect',
            expectsFileChanges: true,
            requiredEdges: [
                { from: 'connected.1', relation: 'call', to: 'connected_create_fleet' },
                { from: 'connected_create_fleet', relation: 'set', to: 'connected_fleet' },
                { from: 'connected.1', relation: 'reference', to: 'connected_fleet' },
            ],
            acceptanceCriteria: [
                { id: 'event_exists', description: 'Event exists', type: 'entity_exists', subject: 'connected.1' },
                { id: 'target_lifecycle', description: 'Typed target is stored and referenced', type: 'typed_lifecycle', entityKind: 'anchor_handle', subject: 'connected_fleet' },
            ],
        });
        TaskGraphEngine.addNode(graph, 'effect', 'build', 'build effect', {
            plannedFiles: [effectFile],
            produces: [
                { kind: 'scripted_effect', id: 'connected_create_fleet', operation: 'define' },
                { kind: 'anchor_handle', id: 'connected_fleet', operation: 'set' },
            ],
        });
        TaskGraphEngine.addNode(graph, 'event', 'build', 'build event', {
            plannedFiles: [eventFile],
            produces: [{ kind: 'event', id: 'connected.1', operation: 'define' }],
            consumes: [
                { kind: 'scripted_effect', id: 'connected_create_fleet', operation: 'call' },
                { kind: 'anchor_handle', id: 'connected_fleet', operation: 'reference' },
            ],
        });

        const result = await new SemanticVerifier().verify(root, [eventFile, effectFile], graph, semanticTools());
        expect(result.passed).to.equal(true, result.report);
        expect(result.acceptanceFailures).to.deep.equal([]);
    });

    it('verifies the checked-in sample mod definitions without stale scripted-effect edges', async () => {
        const sampleRoot = path.resolve(__dirname, '..', 'sample');
        const eventFile = path.join(sampleRoot, 'events', 'irm_faction.txt');
        const effectFile = path.join(sampleRoot, 'common', 'scripted_effects', 'irm_scripted_effects.txt');
        const graph = TaskGraphEngine.createGraph('verify IRM sample corpus', {
            objective: 'Verify the checked-in sample mod event and scripted effect definitions',
            // The sample no longer calls faction_set_leader from irm_faction.2
            // (the call and the regionalist faction definition were removed), so
            // no call edge is declared and none may be fabricated.
            requiredEdges: [],
            acceptanceCriteria: [
                { id: 'sample_event_exists', description: 'Sample event exists', type: 'entity_exists', subject: 'irm_faction.2' },
                { id: 'sample_effect_defined', description: 'Sample scripted effect is defined', type: 'entity_exists', subject: 'faction_set_leader' },
            ],
        });

        const sampleCatalog: PdxSemanticCatalog = {
            ...SEMANTIC_CATALOG,
            definitionTypes: SEMANTIC_CATALOG.definitionTypes.map(type => type.name === 'event'
                ? { ...type, typeKeyFilters: ['country_event'] }
                : type),
            rules: [
                ...SEMANTIC_CATALOG.rules,
                { name: 'country_event', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: 'id', access: 'type', typeName: 'event.country' }] },
            ],
        };
        const result = await new SemanticVerifier().verify(sampleRoot, [eventFile, effectFile], graph, {
            execute: async () => ({ ok: false }),
            getPdxSemanticCatalog: async () => sampleCatalog,
        });
        const edgeEvidence = result.evidence.filter(item =>
            (item.id === 'irm_faction.2' && item.operation === 'define')
            || (item.id === 'faction_set_leader' && (item.operation === 'define' || item.operation === 'call')));

        expect(edgeEvidence.some(item => item.id === 'irm_faction.2' && item.operation === 'define')).to.equal(true);
        expect(edgeEvidence.some(item => item.id === 'faction_set_leader' && item.operation === 'define')).to.equal(true);
        // The sample removed the event's call to faction_set_leader; the verifier
        // must not invent a call edge that no longer exists in the corpus.
        expect(edgeEvidence.some(item => item.id === 'faction_set_leader' && item.operation === 'call')).to.equal(false);
        expect(result.issues.some(issue => issue.code === 'missing_required_edge')).to.equal(false, result.report);
        expect(result.acceptanceFailures).to.deep.equal([]);
    });

    it('detects duplicated responsibility between an event and its scripted effect', async () => {
        const eventFile = path.join(root, 'events', 'duplicate.txt');
        const effectFile = path.join(root, 'common', 'scripted_effects', 'duplicate.txt');
        fs.mkdirSync(path.dirname(eventFile), { recursive: true });
        fs.mkdirSync(path.dirname(effectFile), { recursive: true });
        fs.writeFileSync(effectFile, 'duplicate_create = { create_fleet = { } }\n');
        fs.writeFileSync(eventFile, 'realm_event = { id = duplicate.1 immediate = { create_fleet = { } duplicate_create = { } } }\n');
        const graph = TaskGraphEngine.createGraph('duplicate', { objective: 'No duplicate work', acceptanceCriteria: [] });

        const result = await new SemanticVerifier().verify(root, [eventFile, effectFile], graph, semanticTools());
        expect(result.issues.some(issue => issue.code === 'duplicate_responsibility')).to.equal(true);
    });
});
