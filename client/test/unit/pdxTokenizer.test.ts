import { expect } from 'chai';
import { tokenize, TokenType } from '../../extension/pdxTokenizer';

describe('pdxTokenizer', () => {
    it('keeps escaped double quotes inside string tokens', () => {
        const input = 'name = "Foo \\"Bar\\" Baz"\nnext = 1';
        const tokens = tokenize(input);
        const stringTokens = tokens.filter(t => t.type === TokenType.String);
        expect(stringTokens).to.have.lengthOf(1);
        expect(stringTokens[0]!.value).to.equal('Foo \\"Bar\\" Baz');
        // Token after the string must be the following key, not trailing string garbage.
        const keys = tokens.filter(t => t.type === TokenType.Identifier).map(t => t.value);
        expect(keys).to.deep.equal(['name', 'next']);
    });

    it('tracks offsets accurately around escaped quotes', () => {
        const input = 'a = "x\\"y" b = 2';
        const tokens = tokenize(input);
        const str = tokens.find(t => t.type === TokenType.String)!;
        expect(input.slice(str.startOffset, str.endOffset)).to.equal('"x\\"y"');
        const num = tokens.find(t => t.type === TokenType.Number)!;
        expect(num.value).to.equal('2');
        expect(input.slice(num.startOffset, num.endOffset)).to.equal('2');
    });

    it('handles a backslash at end of input without hanging', () => {
        const tokens = tokenize('a = "unterminated\\');
        expect(tokens[tokens.length - 1]!.type).to.equal(TokenType.EOF);
    });

    it('counts CRLF as a single line increment', () => {
        const input = 'a = 1\r\nb = 2\r\nc = 3';
        const tokens = tokenize(input);
        const numbers = tokens.filter(t => t.type === TokenType.Number);
        expect(numbers.map(t => t.line)).to.deep.equal([1, 2, 3]);
        // Offsets still map to the raw text including \r.
        const two = numbers[1]!;
        expect(input.slice(two.startOffset, two.endOffset)).to.equal('2');
    });

    it('counts lone LF and lone CR consistently', () => {
        const lf = tokenize('a = 1\nb = 2').filter(t => t.type === TokenType.Number);
        expect(lf.map(t => t.line)).to.deep.equal([1, 2]);
        const cr = tokenize('a = 1\rb = 2').filter(t => t.type === TokenType.Number);
        expect(cr.map(t => t.line)).to.deep.equal([1, 2]);
    });

    it('keeps token offsets accurate after skipped comments', () => {
        const input = 'a = 1 # comment with = { } and "quotes"\r\nb = 2';
        const tokens = tokenize(input);
        const numbers = tokens.filter(t => t.type === TokenType.Number);
        expect(numbers.map(t => t.value)).to.deep.equal(['1', '2']);
        const two = numbers[1]!;
        expect(two.line).to.equal(2);
        expect(input.slice(two.startOffset, two.endOffset)).to.equal('2');
    });

    it('ignores comment markers inside strings', () => {
        const tokens = tokenize('a = "x # y" b = 1');
        const numbers = tokens.filter(t => t.type === TokenType.Number);
        expect(numbers.map(t => t.value)).to.deep.equal(['1']);
    });

    it('tokenizes positive, negative and decimal numbers with exact spans', () => {
        const input = 'x = -97.5 y = +20 z = 0.25';
        const tokens = tokenize(input);
        const numbers = tokens.filter(t => t.type === TokenType.Number);
        expect(numbers.map(t => t.value)).to.deep.equal(['-97.5', '+20', '0.25']);
        for (const num of numbers) {
            expect(input.slice(num.startOffset, num.endOffset)).to.equal(num.value);
        }
    });

    it('tokenizes @[...] expressions as single identifiers with exact span', () => {
        const input = 'x = @[ 1 + (2 * 3) ] y = 1';
        const tokens = tokenize(input);
        const expr = tokens.find(t => t.value.startsWith('@['))!;
        expect(expr.type).to.equal(TokenType.Identifier);
        expect(input.slice(expr.startOffset, expr.endOffset)).to.equal('@[ 1 + (2 * 3) ]');
    });

    it('skips unknown characters without corrupting following offsets', () => {
        const input = 'a = 1 € b = 2';
        const tokens = tokenize(input);
        const numbers = tokens.filter(t => t.type === TokenType.Number);
        expect(numbers.map(t => t.value)).to.deep.equal(['1', '2']);
        const two = numbers[1]!;
        expect(input.slice(two.startOffset, two.endOffset)).to.equal('2');
    });

    it('does not treat a minus before a non-digit as a number', () => {
        const input = 'a - b';
        const tokens = tokenize(input);
        expect(tokens.filter(t => t.type === TokenType.Number)).to.have.lengthOf(0);
    });
});
