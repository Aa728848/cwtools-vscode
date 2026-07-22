import { expect } from 'chai';
import { buildImplicitEdges, parseEventFile } from '../../extension/eventChainParser';
import type { PdxSemanticCatalog } from '../../shared/pdxSemanticCatalog';

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
