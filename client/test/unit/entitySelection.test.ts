import { expect } from 'chai';
import { resolveEntitySelectionIndex } from '../../extension/entitySelection';

describe('entity preview selection', () => {
    it('restores an entity by name after definitions are reordered', () => {
        expect(resolveEntitySelectionIndex(
            ['new_ship', 'selected_ship', 'old_ship'],
            'selected_ship',
            0,
        )).to.equal(1);
    });

    it('falls back to a bounded previous index when the entity is gone', () => {
        expect(resolveEntitySelectionIndex(['first', 'second'], 'removed_ship', 8)).to.equal(1);
        expect(resolveEntitySelectionIndex(['first', 'second'], 'removed_ship', -2)).to.equal(0);
    });

    it('returns no selection for an empty entity list', () => {
        expect(resolveEntitySelectionIndex([], 'removed_ship', 2)).to.equal(-1);
    });
});
