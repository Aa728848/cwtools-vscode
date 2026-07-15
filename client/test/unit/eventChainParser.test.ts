import { expect } from 'chai';
import { parseEventFile } from '../../extension/eventChainParser';

describe('event chain Carrier support', () => {
    it('indexes carrier and colony events, calls, and carrier flags', () => {
        const graph = parseEventFile(`
namespace = carrier_test

colony_event = {
    id = carrier_test.1
    immediate = {
        carrier_event = { id = carrier_test.2 }
    }
}

carrier_event = {
    id = carrier_test.2
    trigger = { has_carrier_flag = ready }
    immediate = { set_carrier_flag = complete }
}
`, 'events/carrier_test.txt');

        expect(graph.nodes.map(node => [node.id, node.type])).to.deep.equal([
            ['carrier_test.1', 'colony_event'],
            ['carrier_test.2', 'carrier_event'],
        ]);
        expect(graph.edges.some(edge =>
            edge.source === 'carrier_test.1'
            && edge.target === 'carrier_test.2'
            && edge.edgeType === 'immediate'
        )).to.equal(true);
        const carrier = graph.nodes.find(node => node.id === 'carrier_test.2')!;
        expect(carrier.flagsChecked).to.deep.include({ scope: 'carrier', name: 'ready' });
        expect(carrier.flagsSet).to.deep.include({ scope: 'carrier', name: 'complete' });
    });
});
