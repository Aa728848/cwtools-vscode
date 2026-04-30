import { expect } from 'chai';
import { computeLineDiff } from '../../extension/ai/diffEngine';

describe('computeLineDiff', () => {
    it('returns empty diff for identical content', () => {
        const result = computeLineDiff('a\nb\nc', 'a\nb\nc');
        expect(result.additions).to.equal(0);
        expect(result.deletions).to.equal(0);
        expect(result.lines.filter(l => l.type !== 'context')).to.be.empty;
    });

    it('detects a single added line', () => {
        const result = computeLineDiff('line1\nline2', 'line1\ninserted\nline2');
        expect(result.additions).to.equal(1);
        expect(result.deletions).to.equal(0);
        expect(result.lines.some(l => l.type === 'add' && l.content === 'inserted')).to.be.true;
    });

    it('detects a single removed line', () => {
        const result = computeLineDiff('line1\nremoved\nline2', 'line1\nline2');
        expect(result.additions).to.equal(0);
        expect(result.deletions).to.equal(1);
        expect(result.lines.some(l => l.type === 'remove' && l.content === 'removed')).to.be.true;
    });

    it('detects mixed additions and deletions', () => {
        const result = computeLineDiff(
            'keep1\nold2\nkeep3\nold4',
            'keep1\nnew2\nkeep3\nnew4'
        );
        expect(result.additions).to.equal(2);
        expect(result.deletions).to.equal(2);
    });

    it('includes context lines around changes', () => {
        const result = computeLineDiff(
            'a\nb\nc\nd\ne\nf\ng\nh',
            'a\nb\nc\nCHANGED\ne\nf\ng\nh'
        );
        expect(result.lines.some(l => l.type === 'context')).to.be.true;
        expect(result.lines.some(l => l.type === 'remove' && l.content === 'd')).to.be.true;
        expect(result.lines.some(l => l.type === 'add' && l.content === 'CHANGED')).to.be.true;
    });

    it('handles completely different content', () => {
        const result = computeLineDiff('old1\nold2\nold3', 'new1\nnew2');
        expect(result.additions + result.deletions).to.be.greaterThan(0);
    });

    it('truncates at maxLines', () => {
        const oldLines = Array.from({ length: 100 }, (_, i) => `line${i}`);
        const newLines = Array.from({ length: 100 }, (_, i) => `changed${i}`);
        const result = computeLineDiff(oldLines.join('\n'), newLines.join('\n'), 20);
        expect(result.truncated).to.be.true;
        expect(result.lines.length).to.be.at.most(20);
    });

    it('handles empty strings', () => {
        const result = computeLineDiff('', '');
        expect(result.lines).to.be.empty;
        expect(result.additions).to.equal(0);
        expect(result.deletions).to.equal(0);
    });

    it('handles old content empty (pure addition)', () => {
        const result = computeLineDiff('', 'new1\nnew2\nnew3');
        expect(result.additions).to.equal(3);
    });

    it('handles new content empty (pure deletion)', () => {
        const result = computeLineDiff('old1\nold2', '');
        expect(result.deletions).to.equal(2);
    });

    it('uses simple diff fallback for very large files (>10k lines)', () => {
        const lines = Array.from({ length: 6000 }, (_, i) => `line${i}`);
        const content = lines.join('\n');
        const modified = 'line0\n' + lines.slice(1).join('\n'); // one diff line
        const result = computeLineDiff(content, modified);
        expect(result).to.have.property('additions');
        expect(result).to.have.property('deletions');
    });

    it('assigns correct line numbers to diff entries', () => {
        const result = computeLineDiff('first\nsecond\nthird', 'first\nCHANGED\nthird');
        const addLine = result.lines.find(l => l.type === 'add');
        expect(addLine).to.exist;
        expect(addLine!.newLineNo).to.equal(2);
        const removeLine = result.lines.find(l => l.type === 'remove');
        expect(removeLine).to.exist;
        expect(removeLine!.oldLineNo).to.equal(2);
    });
});
