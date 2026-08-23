import { expect } from 'chai';
import { validateOverlayCatalog } from '../../extension/ai/runner/overlayCatalog';

describe('overlay catalog', () => {
    it('makes events introduced in another candidate file visible', () => {
        const result = validateOverlayCatalog([
            { file: 'events/a.txt', content: 'country_event = { id = test.1 immediate = { country_event = { id = test.2 } } }' },
            { file: 'events/b.txt', content: 'country_event = { id = test.2 }' },
        ]);
        expect(result.issues).to.deep.equal([]);
        expect(result.definitions.map(item => item.id)).to.deep.equal(['test.1', 'test.2']);
    });
    it('reports duplicate and unresolved overlay identities deterministically', () => {
        const result = validateOverlayCatalog([
            { file: 'events/b.txt', content: 'country_event = { id = test.1 immediate = { country_event = { id = missing.1 } } }' },
            { file: 'events/a.txt', content: 'country_event = { id = test.1 }' },
        ]);
        expect(result.issues.filter(issue => issue.code === 'overlay_duplicate_definition')).to.have.length(2);
        expect(result.issues.some(issue => issue.message.includes('missing.1'))).to.equal(true);
    });
    it('accepts references supplied by the live catalog', () => {
        const result = validateOverlayCatalog([{ file: 'events/a.txt', content: 'country_event = { id = test.1 immediate = { country_event = { id = vanilla.1 } } }' }], new Set(['vanilla.1']));
        expect(result.issues).to.deep.equal([]);
    });
});
