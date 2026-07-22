import { expect } from 'chai';
import { buildDefinitionReferenceEdges, buildImplicitEdges, extractConnectedSubgraph, mergeGraphs, parseCommonFile, parseEventFile } from '../../extension/eventChainParser';
import { parsePdxSemanticCatalog, type PdxSemanticCatalog } from '../../shared/pdxSemanticCatalog';

const CATALOG: PdxSemanticCatalog = {
    status: 'ready',
    source: 'lsp',
    gameProfile: 'synthetic',
    rules: [
        { name: 'realm_event', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: 'id', access: 'type', typeName: 'event.realm' }] },
        { name: 'has_realm_flag', category: 'trigger', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'value', typeName: 'realm_flag' }] },
        { name: 'set_realm_flag', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'value_set', typeName: 'realm_flag' }] },
    ],
    definitionTypes: [
        { name: 'event', paths: ['events'], nameField: 'event_key', typeKeyFilters: ['realm_event'] },
    ],
    warnings: [],
};

describe('event chain CWT semantics', () => {
    it('derives event keys, name fields, calls, and typed references from the semantic catalog', () => {
        const graph = parseEventFile(`
namespace = realm_test

realm_event = {
    event_key = realm_test.1
    immediate = {
        realm_event = { id = realm_test.2 }
    }
}

realm_event = {
    event_key = realm_test.2
    trigger = { has_realm_flag = ready }
    immediate = { set_realm_flag = complete }
}
`, 'events/realm_test.txt', CATALOG);

        expect(graph.nodes.map(node => [node.id, node.type])).to.deep.equal([
            ['realm_test.1', 'realm_event'],
            ['realm_test.2', 'realm_event'],
        ]);
        expect(graph.edges.some(edge =>
            edge.source === 'realm_test.1'
            && edge.target === 'realm_test.2'
            && edge.edgeType === 'effect'
            && edge.label === 'realm_event'
        )).to.equal(true);
        const realm = graph.nodes.find(node => node.id === 'realm_test.2')!;
        expect(realm.semanticReferences).to.deep.include({
            typeName: 'realm_flag', value: 'ready', access: 'value', category: 'trigger', ruleName: 'has_realm_flag',
        });
        expect(realm.semanticReferences).to.deep.include({
            typeName: 'realm_flag', value: 'complete', access: 'value_set', category: 'effect', ruleName: 'set_realm_flag',
        });
    });

    it('builds implicit relationships generically from typed writes and reads', () => {
        const graph = parseEventFile(`
realm_event = {
    event_key = realm_test.1
    set_realm_flag = shared_value
}
realm_event = {
    event_key = realm_test.2
    has_realm_flag = shared_value
}
`, 'events/realm_test.txt', CATALOG);

        expect(buildImplicitEdges(graph)).to.deep.include({
            source: 'realm_test.1',
            target: 'realm_test.2',
            edgeType: 'semantic',
            label: 'realm_flag:shared_value',
        });
    });

    it('accepts an unfiltered event TypeDef and identifies definitions by its CWT name field', () => {
        const graph = parseEventFile(`
namespace = realm_test

custom_event_kind = {
    event_key = realm_test.10
}

metadata = { value = ignored }
`, 'events/unfiltered.txt', {
            ...CATALOG,
            definitionTypes: [{ name: 'event', paths: ['events'], nameField: 'event_key', typeKeyFilters: [] }],
        });

        expect(graph.nodes.map(node => [node.id, node.type])).to.deep.equal([
            ['realm_test.10', 'custom_event_kind'],
        ]);
    });

    it('derives MTTH ordering only from the root trigger block and preserves boolean intent', () => {
        const graph = parseEventFile(`
realm_event = {
    event_key = realm_test.required_writer
    immediate = { set_realm_flag = required }
}
realm_event = {
    event_key = realm_test.alternative_writer
    immediate = { set_realm_flag = alternative }
}
realm_event = {
    event_key = realm_test.blocking_writer
    immediate = { set_realm_flag = blocked }
}
realm_event = {
    event_key = realm_test.nested_writer
    immediate = { set_realm_flag = nested_only }
}
realm_event = {
    event_key = realm_test.mtth
    mean_time_to_happen = { days = 10 }
    trigger = {
        has_realm_flag = required
        OR = { has_realm_flag = alternative }
        NOT = { has_realm_flag = blocked }
    }
    option = {
        trigger = { has_realm_flag = nested_only }
    }
}
`, 'events/realm_mtth.txt', CATALOG);

        const target = graph.nodes.find(node => node.id === 'realm_test.mtth')!;
        expect(target.meanTimeToHappen).to.equal(true);
        expect(target.triggerConditions?.map(condition => [condition.value, condition.relation])).to.deep.equal([
            ['required', 'requires'],
            ['alternative', 'alternative'],
            ['blocked', 'blocks'],
        ]);

        const edges = buildImplicitEdges(graph);
        expect(edges).to.deep.include({
            source: 'realm_test.required_writer',
            target: 'realm_test.mtth',
            edgeType: 'mtth_condition',
            label: 'has_realm_flag = required',
            conditionRelation: 'requires',
        });
        expect(edges).to.deep.include({
            source: 'realm_test.alternative_writer',
            target: 'realm_test.mtth',
            edgeType: 'mtth_condition',
            label: 'has_realm_flag = alternative',
            conditionRelation: 'alternative',
        });
        expect(edges).to.deep.include({
            source: 'realm_test.blocking_writer',
            target: 'realm_test.mtth',
            edgeType: 'mtth_condition',
            label: 'has_realm_flag = blocked',
            conditionRelation: 'blocks',
        });
        expect(edges.some(edge => edge.source === 'realm_test.nested_writer'
            && edge.target === 'realm_test.mtth'
            && edge.edgeType === 'mtth_condition')).to.equal(false);
    });

    it('connects CWT-declared definition event sets and preserves provable order', () => {
        const catalog: PdxSemanticCatalog = {
            ...CATALOG,
            definitionTypes: [
                ...CATALOG.definitionTypes,
                {
                    name: 'story_arc',
                    paths: ['common/story_arcs'],
                    typeKeyFilters: [],
                    valueReferences: [
                        { argumentPath: 'stage.event', access: 'type', typeName: 'event.realm' },
                        { argumentPath: 'pulse.events.$value', access: 'type', typeName: 'event.realm' },
                        { argumentPath: 'pulse.random_events.*', access: 'type', typeName: 'event.realm' },
                        { argumentPath: 'entry', access: 'type', typeName: 'event.realm' },
                    ],
                },
            ],
        };
        const result = parseCommonFile(`
story_arc = {
    stage = { event = realm_test.1 }
    stage = { event = realm_test.2 }
    entry = realm_test.7
    entry = realm_test.8
    pulse = {
        events = {
            realm_test.3
            realm_test.4
        }
        random_events = {
            10 = realm_test.5
            20 = realm_test.6
        }
    }
}
`, 'common/story_arcs/test.txt', catalog);

        expect(result.externalSources.map(source => source.id)).to.deep.equal(['[story_arc] story_arc']);
        for (const target of ['realm_test.1', 'realm_test.2', 'realm_test.3', 'realm_test.4', 'realm_test.5', 'realm_test.6', 'realm_test.7', 'realm_test.8']) {
            expect(result.edges.some(edge => edge.source === '[story_arc] story_arc'
                && edge.target === target
                && edge.edgeType === 'definition')).to.equal(true);
        }
        expect(result.edges).to.deep.include({
            source: 'realm_test.1',
            target: 'realm_test.2',
            edgeType: 'sequence',
            label: 'story_arc.stage.event',
        });
        expect(result.edges).to.deep.include({
            source: 'realm_test.3',
            target: 'realm_test.4',
            edgeType: 'sequence',
            label: 'story_arc.pulse.events.$value',
        });
        expect(result.edges.some(edge => edge.source === 'realm_test.5'
            && edge.target === 'realm_test.6'
            && edge.edgeType === 'sequence')).to.equal(false);
        expect(result.edges.some(edge => edge.source === 'realm_test.7'
            && edge.target === 'realm_test.8'
            && edge.edgeType === 'sequence')).to.equal(false);
    });

    it('validates TypeDef value references at the LSP boundary', () => {
        const parsed = parsePdxSemanticCatalog({
            ok: true,
            status: 'ready',
            rules: [],
            definitionTypes: [{
                name: 'Story_Arc',
                paths: ['game/common/story_arcs'],
                typeKeyFilters: [],
                valueReferences: [
                    { argumentPath: 'Stage.Event', access: 'type', typeName: 'Event.Realm' },
                    { argumentPath: 42, access: 'type', typeName: 'event.realm' },
                ],
            }],
        });

        expect(parsed?.definitionTypes[0]?.valueReferences).to.deep.equal([
            { argumentPath: 'stage.event', access: 'type', typeName: 'event.realm' },
        ]);
    });

    it('connects events and definitions through catalog-typed references without game-specific type lists', () => {
        const catalog: PdxSemanticCatalog = {
            ...CATALOG,
            rules: [
                ...CATALOG.rules,
                { name: 'enable_project', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'type', typeName: 'project.special' }] },
                { name: 'create_site', category: 'effect', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'type', typeName: 'site' }] },
                { name: 'has_site', category: 'trigger', supportedScopes: [], valueReferences: [{ argumentPath: '$value', access: 'type', typeName: 'site' }] },
            ],
            definitionTypes: [
                ...CATALOG.definitionTypes,
                { name: 'project', paths: ['common/projects'], typeKeyFilters: [] },
                { name: 'site', paths: ['common/sites'], typeKeyFilters: [] },
            ],
        };
        const events = parseEventFile(`
realm_event = {
    event_key = realm_test.start
    enable_project = project_x
}
realm_event = {
    event_key = realm_test.finish
    trigger = { has_site = site_x }
}
`, 'events/definitions.txt', catalog);
        const project = parseCommonFile('project_x = { create_site = site_x }', 'common/projects/test.txt', catalog);
        const site = parseCommonFile('site_x = { }', 'common/sites/test.txt', catalog);
        const graph = mergeGraphs([
            events,
            ...[project, site].map(result => ({
                nodes: result.externalSources.map(source => ({
                    id: source.id,
                    type: source.sourceType,
                    title: source.name,
                    file: source.file,
                    line: source.line,
                    endLine: source.line,
                    namespace: `__${source.sourceType}__`,
                    semanticReferences: source.semanticReferences,
                    definitionIdentity: source.definitionIdentity,
                })),
                edges: result.edges,
            })),
        ]);

        const definitionEdges = buildDefinitionReferenceEdges(graph);
        expect(definitionEdges).to.deep.include.members([
            {
                source: 'realm_test.start',
                target: '[project] project_x',
                edgeType: 'definition_effect',
                label: 'enable_project = project_x',
            },
            {
                source: '[project] project_x',
                target: '[site] site_x',
                edgeType: 'definition_effect',
                label: 'create_site = site_x',
            },
            {
                source: '[site] site_x',
                target: 'realm_test.finish',
                edgeType: 'definition_trigger',
                label: 'has_site = site_x',
            },
        ]);
        graph.edges.push(...definitionEdges);
        const visible = extractConnectedSubgraph(graph, new Set(['realm_test.start']), 4);
        expect(visible.nodes.map(node => node.id)).to.include.members([
            '[project] project_x',
            '[site] site_x',
            'realm_test.finish',
        ]);
    });

    it('keeps depth-bounded subgraphs induced while retaining unresolved references', () => {
        const makeNode = (id: string) => ({
            id,
            type: 'realm_event',
            file: 'events/bounded.txt',
            line: 1,
            endLine: 1,
            namespace: 'realm_test',
            semanticReferences: [],
        });
        const graph = {
            nodes: ['seed', 'near', 'outside', 'unrelated'].map(makeNode),
            edges: [
                { source: 'seed', target: 'near', edgeType: 'effect' as const },
                { source: 'near', target: 'outside', edgeType: 'effect' as const },
                { source: 'near', target: 'missing_definition', edgeType: 'effect' as const },
                { source: 'outside', target: 'unrelated', edgeType: 'effect' as const },
            ],
        };

        const visible = extractConnectedSubgraph(graph, new Set(['seed']), 1);

        expect(visible.nodes.map(node => node.id)).to.deep.equal(['seed', 'near']);
        expect(visible.edges).to.deep.equal([
            { source: 'seed', target: 'near', edgeType: 'effect' },
            { source: 'near', target: 'missing_definition', edgeType: 'effect' },
        ]);
    });

    it('uses CWT type-key filters to distinguish definition identities sharing a directory', () => {
        const result = parseCommonFile(`
alpha_kind = { }
beta_kind = { }
`, 'common/shared/test.txt', {
            ...CATALOG,
            definitionTypes: [
                ...CATALOG.definitionTypes,
                { name: 'alpha', paths: ['common/shared'], typeKeyFilters: ['alpha_kind'] },
                { name: 'beta', paths: ['common/shared'], typeKeyFilters: ['beta_kind'] },
            ],
        });

        expect(result.externalSources.map(source => source.definitionIdentity)).to.deep.equal([
            { typeName: 'alpha', value: 'alpha_kind' },
            { typeName: 'beta', value: 'beta_kind' },
        ]);
    });

    it('does not infer event types when the active CWT catalog lacks them', () => {
        const graph = parseEventFile(
            'country_event = { id = old.1 }',
            'events/old.txt',
            { ...CATALOG, rules: [], definitionTypes: [] },
        );
        expect(graph.nodes).to.deep.equal([]);
        expect(graph.edges).to.deep.equal([]);
    });
});
