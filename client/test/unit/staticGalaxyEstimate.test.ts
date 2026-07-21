import { expect } from 'chai';
import { estimateHyperlanes } from '../../shared/staticGalaxyEstimate';

describe('staticGalaxyEstimate', () => {
    it('connects each system to its nearest neighbors within max distance', () => {
        const lanes = estimateHyperlanes([
            { nodeKey: 'a', x: 0, y: 0 },
            { nodeKey: 'b', x: 10, y: 0 },
            { nodeKey: 'c', x: 20, y: 0 },
            { nodeKey: 'far', x: 500, y: 0 },
        ], 50);
        expect(lanes).to.include.deep.members([['a', 'b'], ['b', 'c']]);
        expect(lanes.every(([a, b]) => a !== 'far' && b !== 'far')).to.equal(true);
    });

    it('dedupes undirected pairs', () => {
        const lanes = estimateHyperlanes([
            { nodeKey: 'a', x: 0, y: 0 },
            { nodeKey: 'b', x: 5, y: 0 },
        ], 10);
        expect(lanes).to.have.lengthOf(1);
    });

    it('scales the neighbor count with density', () => {
        const points = [
            { nodeKey: 'c', x: 0, y: 0 },
            { nodeKey: 'n1', x: 10, y: 0 },
            { nodeKey: 'n2', x: 0, y: 10 },
            { nodeKey: 'n3', x: -10, y: 0 },
            { nodeKey: 'n4', x: 0, y: -10 },
            { nodeKey: 'n5', x: 8, y: 8 },
        ];
        const sparse = estimateHyperlanes(points, 20, 0.34); // k -> 1
        const dense = estimateHyperlanes(points, 20, 2); // k -> 6
        expect(dense.length).to.be.greaterThan(sparse.length);
        // k=1: every system links only to its single nearest neighbor (out-degree 1).
        const fromC = sparse.filter(([a]) => a === 'c');
        expect(fromC).to.have.lengthOf(1);
    });

    it('returns nothing for empty input, single points or non-positive distance', () => {
        expect(estimateHyperlanes([], 50)).to.have.lengthOf(0);
        expect(estimateHyperlanes([{ nodeKey: 'a', x: 0, y: 0 }], 50)).to.have.lengthOf(0);
        expect(estimateHyperlanes([{ nodeKey: 'a', x: 0, y: 0 }, { nodeKey: 'b', x: 1, y: 1 }], 0)).to.have.lengthOf(0);
    });
});
