import { expect } from 'chai';
import { applyDraftTextEdits } from '../../extension/entityDraftEditing';

describe('entity in-memory drafts', () => {
    it('applies insert, replace and delete edits without touching a document', () => {
        const source = 'one\ntwo\nthree';
        const result = applyDraftTextEdits(source, [
            { start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, newText: 'ONE' },
            { start: { line: 1, character: 3 }, end: { line: 1, character: 3 }, newText: '!' },
            { start: { line: 2, character: 0 }, end: { line: 2, character: 5 }, newText: '' },
        ]);

        expect(result).to.equal('ONE\ntwo!\n');
        expect(source).to.equal('one\ntwo\nthree');
    });

    it('rejects overlapping edits', () => {
        const result = applyDraftTextEdits('abcdef', [
            { start: { line: 0, character: 1 }, end: { line: 0, character: 4 }, newText: 'x' },
            { start: { line: 0, character: 3 }, end: { line: 0, character: 5 }, newText: 'y' },
        ]);
        expect(result).to.equal(undefined);
    });
});
