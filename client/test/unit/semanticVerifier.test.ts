import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemanticVerifier } from '../../extension/ai/orchestrator/semanticVerifier';
import { TaskGraphEngine } from '../../extension/ai/orchestrator/taskGraphEngine';

describe('SemanticVerifier', () => {
    let root = '';

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-semantic-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('rejects unused state, duplicate targets, and localisation for a missing event', async () => {
        const eventFile = path.join(root, 'events', 'broken.txt');
        const locFile = path.join(root, 'localisation', 'broken_l_english.yml');
        fs.mkdirSync(path.dirname(eventFile), { recursive: true });
        fs.mkdirSync(path.dirname(locFile), { recursive: true });
        fs.writeFileSync(eventFile, [
            'namespace = broken',
            'country_event = {',
            '  id = broken.1',
            '  immediate = {',
            '    set_global_flag = broken_unused_flag',
            '    save_global_event_target_as = broken_unused_target',
            '    set_location = { target = root target = prev }',
            '  }',
            '}',
        ].join('\n'));
        fs.writeFileSync(locFile, 'l_english:\n broken.2.title:0 "Missing event"\n');

        const graph = TaskGraphEngine.createGraph('build broken chain', {
            objective: 'Build a connected event chain',
            expectsFileChanges: true,
            acceptanceCriteria: [],
        });
        const verifier = new SemanticVerifier();
        const result = await verifier.verify(root, [eventFile, locFile], graph, {
            execute: async (toolName) => toolName === 'query_references' ? { references: [] } : { ok: false },
        });

        expect(result.passed).to.equal(false);
        expect(result.issues.map(issue => issue.code)).to.include.members([
            'duplicate_target_assignment',
            'unused_flag',
            'unused_event_target',
            'orphan_localisation',
        ]);
    });

    it('proves producer-consumer edges for a connected event and scripted effect', async () => {
        const eventFile = path.join(root, 'events', 'connected.txt');
        const effectFile = path.join(root, 'common', 'scripted_effects', 'connected.txt');
        fs.mkdirSync(path.dirname(eventFile), { recursive: true });
        fs.mkdirSync(path.dirname(effectFile), { recursive: true });
        fs.writeFileSync(effectFile, [
            'connected_create_fleet = {',
            '  create_fleet = { effect = { set_owner = root } }',
            '  save_global_event_target_as = connected_fleet',
            '}',
        ].join('\n'));
        fs.writeFileSync(eventFile, [
            'namespace = connected',
            'country_event = {',
            '  id = connected.1',
            '  trigger = { has_global_flag = connected_enabled }',
            '  immediate = {',
            '    set_global_flag = connected_enabled',
            '    connected_create_fleet = { }',
            '    exists = event_target:connected_fleet',
            '  }',
            '}',
        ].join('\n'));

        const graph = TaskGraphEngine.createGraph('build connected chain', {
            objective: 'Build a connected event and fleet effect',
            expectsFileChanges: true,
            requiredEdges: [
                { from: 'connected.1', relation: 'call', to: 'connected_create_fleet' },
                { from: 'connected_create_fleet', relation: 'save', to: 'connected_fleet' },
                { from: 'connected.1', relation: 'read', to: 'connected_fleet' },
            ],
            acceptanceCriteria: [
                { id: 'event_exists', description: 'Event exists', type: 'entity_exists', subject: 'connected.1' },
                { id: 'target_lifecycle', description: 'Fleet target is saved and read', type: 'target_lifecycle', subject: 'connected_fleet' },
            ],
        });
        TaskGraphEngine.addNode(graph, 'effect', 'build', 'build effect', {
            plannedFiles: [effectFile],
            produces: [
                { kind: 'scripted_effect', id: 'connected_create_fleet', operation: 'define' },
                { kind: 'event_target', id: 'connected_fleet', operation: 'save' },
            ],
        });
        TaskGraphEngine.addNode(graph, 'event', 'build', 'build event', {
            plannedFiles: [eventFile],
            produces: [{ kind: 'event', id: 'connected.1', operation: 'define' }],
            consumes: [
                { kind: 'scripted_effect', id: 'connected_create_fleet', operation: 'call' },
                { kind: 'event_target', id: 'connected_fleet', operation: 'read' },
            ],
        });

        const result = await new SemanticVerifier().verify(root, [eventFile, effectFile], graph);
        expect(result.passed).to.equal(true, result.report);
        expect(result.acceptanceFailures).to.deep.equal([]);
    });

    it('proves a declared event-to-scripted-effect edge in the repository sample mod corpus', async () => {
        const sampleRoot = path.resolve(__dirname, '..', 'sample');
        const eventFile = path.join(sampleRoot, 'events', 'irm_faction.txt');
        const effectFile = path.join(sampleRoot, 'common', 'scripted_effects', 'irm_scripted_effects.txt');
        const graph = TaskGraphEngine.createGraph('verify IRM faction leader chain', {
            objective: 'Verify the checked-in sample mod event calls its scripted effect',
            requiredEdges: [
                { from: 'irm_faction.2', relation: 'call', to: 'faction_set_leader' },
            ],
            acceptanceCriteria: [
                { id: 'sample_event_exists', description: 'Sample event exists', type: 'entity_exists', subject: 'irm_faction.2' },
                { id: 'sample_effect_referenced', description: 'Sample scripted effect is called', type: 'entity_referenced', subject: 'faction_set_leader' },
            ],
        });

        const result = await new SemanticVerifier().verify(sampleRoot, [eventFile, effectFile], graph);
        const edgeEvidence = result.evidence.filter(item =>
            (item.id === 'irm_faction.2' && item.operation === 'define')
            || (item.id === 'faction_set_leader' && (item.operation === 'define' || item.operation === 'call')));

        expect(edgeEvidence.some(item => item.id === 'irm_faction.2' && item.operation === 'define')).to.equal(true);
        expect(edgeEvidence.some(item => item.id === 'faction_set_leader' && item.operation === 'define')).to.equal(true);
        expect(edgeEvidence.some(item => item.id === 'faction_set_leader' && item.operation === 'call')).to.equal(true);
        expect(result.issues.some(issue => issue.code === 'missing_required_edge')).to.equal(false, result.report);
        expect(result.acceptanceFailures).to.deep.equal([]);
    });

    it('detects duplicated responsibility between an event and its scripted effect', async () => {
        const eventFile = path.join(root, 'events', 'duplicate.txt');
        const effectFile = path.join(root, 'common', 'scripted_effects', 'duplicate.txt');
        fs.mkdirSync(path.dirname(eventFile), { recursive: true });
        fs.mkdirSync(path.dirname(effectFile), { recursive: true });
        fs.writeFileSync(effectFile, 'duplicate_create = { create_fleet = { } }\n');
        fs.writeFileSync(eventFile, 'country_event = { id = duplicate.1 immediate = { create_fleet = { } duplicate_create = { } } }\n');
        const graph = TaskGraphEngine.createGraph('duplicate', { objective: 'No duplicate work', acceptanceCriteria: [] });

        const result = await new SemanticVerifier().verify(root, [eventFile, effectFile], graph);
        expect(result.issues.some(issue => issue.code === 'duplicate_responsibility')).to.equal(true);
    });
});
