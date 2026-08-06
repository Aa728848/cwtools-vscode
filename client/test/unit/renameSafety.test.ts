import { expect } from 'chai';
import {
    applyRenameEdits,
    buildRenameExpansionPlan,
    renameNeedsExpansionPlan,
    type RenameEditPreview,
} from '../../extension/ai/tools/renameSafety';

describe('rename safety', () => {
    const edit = (overrides: Partial<RenameEditPreview> = {}): RenameEditPreview => ({
        file: 'events/test.txt',
        startOffset: 0,
        endOffset: 3,
        newText: 'new',
        context: 'id = old',
        ...overrides,
    });

    it('requires a reviewed expansion plan for inline and composite names', () => {
        expect(renameNeedsExpansionPlan('plain_id', 'new_id', [edit()])).to.equal(false);
        expect(renameNeedsExpansionPlan('$ID$_title', 'new_title', [edit()])).to.equal(true);
        expect(renameNeedsExpansionPlan('plain_id', 'new_id', [edit({
            file: 'common/inline_scripts/example.txt',
            context: 'id = "$ID$_generated"',
        })])).to.equal(true);
    });

    it('applies non-overlapping edits from the end of the document', () => {
        const content = 'old + old';
        expect(applyRenameEdits(content, [
            edit({ startOffset: 0, endOffset: 3 }),
            edit({ startOffset: 6, endOffset: 9 }),
        ])).to.equal('new + new');
        expect(() => applyRenameEdits(content, [
            edit({ startOffset: 0, endOffset: 5 }),
            edit({ startOffset: 3, endOffset: 6 }),
        ])).to.throw('overlapping edits');
    });

    it('builds a stable hash bound to the reviewed occurrences', () => {
        const first = buildRenameExpansionPlan('old', 'new', [edit()]);
        const reordered = buildRenameExpansionPlan('old', 'new', [edit()]);
        const changed = buildRenameExpansionPlan('old', 'other', [edit({ newText: 'other' })]);
        expect(first.planHash).to.equal(reordered.planHash);
        expect(changed.planHash).to.not.equal(first.planHash);
        expect(first.files).to.deep.equal([{ file: 'events/test.txt', edits: 1 }]);
    });
});
