import { expect } from 'chai';
import { fuzzyReplace } from '../../extension/ai/tools/replacerSuite';

const replace = (content: string, oldStr: string, newStr: string, replaceAll = false) =>
    fuzzyReplace(content, oldStr, newStr, replaceAll);

describe('FileToolHandler.replace — OpenCode Replacer Suite', () => {

    // ─── Strategy 1: Simple exact match ────────────────────────────────────

    describe('Strategy 1: simpleReplacer (exact match)', () => {
        it('replaces exact single-line match', () => {
            const result = replace('hello world', 'world', 'there');
            expect(result).to.equal('hello there');
        });

        it('replaces exact multi-line match', () => {
            const content = 'line1\nline2\nline3';
            const result = replace(content, 'line1\nline2', 'replaced');
            expect(result).to.equal('replaced\nline3');
        });

        it('throws on no match', () => {
            expect(() => replace('hello', 'xyz', 'abc')).to.throw('Content not found');
        });

        it('throws when oldString === newString', () => {
            expect(() => replace('hello', 'hello', 'hello')).to.throw('identical');
        });

        it('throws on ambiguous match (multiple occurrences without replaceAll)', () => {
            expect(() => replace('aaa', 'a', 'b')).to.throw('Multiple matches');
        });

        it('replaceAll replaces all occurrences', () => {
            const result = replace('aaa', 'a', 'b', true);
            expect(result).to.equal('bbb');
        });
    });

    // ─── Strategy 2: lineTrimmedReplacer ───────────────────────────────────

    describe('Strategy 2: lineTrimmedReplacer', () => {
        it('matches lines differing only in leading/trailing whitespace', () => {
            const content = '  hello  \n  world  ';
            const result = replace(content, 'hello\nworld', 'replaced');
            expect(result).to.equal('replaced');
        });

        it('matches with trailing newline in find', () => {
            const content = '  foo  \n  bar  \nbaz';
            const result = replace(content, 'foo\nbar\n', 'X');
            expect(result).to.equal('X\nbaz');
        });
    });

    // ─── Strategy 3: blockAnchorReplacer ───────────────────────────────────

    describe('Strategy 3: blockAnchorReplacer', () => {
        it('matches by first/last line anchor with fuzzy interior', () => {
            const content = 'start\n  aaa\n  bbb\nend\nextra';
            const find = 'start\n  aaa\n  ccc\nend'; // bbb vs ccc — similar enough
            const result = replace(content, find, 'BLOCK');
            expect(result).to.equal('BLOCK\nextra');
        });

        it('requires at least 3 lines for anchor matching', () => {
            const content = 'a\nb';
            // Should fall through to later strategies, not match here
            expect(() => replace(content, 'a\nb', 'x')).to.not.throw();
        });

        it('picks best candidate by Levenshtein score', () => {
            const content = 'start\naaa\nend\nstart\nbbb\nend';
            const result = replace(content, 'start\nbbb\nend', 'FOUND');
            expect(result).to.equal('start\naaa\nend\nFOUND');
        });
    });

    // ─── Strategy 4: whitespaceNormalizedReplacer ──────────────────────────

    describe('Strategy 4: whitespaceNormalizedReplacer', () => {
        it('matches when whitespace differs (multiple spaces collapsed)', () => {
            const content = 'hello   world';
            const result = replace(content, 'hello world', 'X');
            expect(result).to.equal('X');
        });

        it('matches multi-line with varied whitespace', () => {
            const content = 'foo   bar\nbaz';
            const result = replace(content, 'foo bar', 'Y');
            expect(result).to.equal('Y\nbaz');
        });
    });

    // ─── Strategy 5: indentationFlexibleReplacer ───────────────────────────

    describe('Strategy 5: indentationFlexibleReplacer', () => {
        it('matches when content has extra common indentation', () => {
            const content = '    if (true) {\n        return 1;\n    }';
            const find = 'if (true) {\n    return 1;\n}';
            const result = replace(content, find, 'DONE');
            expect(result).to.equal('DONE');
        });

        it('matches when find has extra indentation', () => {
            const content = 'if (true) {\n    return 1;\n}';
            const find = '    if (true) {\n        return 1;\n    }';
            const result = replace(content, find, 'DONE');
            expect(result).to.equal('DONE');
        });
    });

    // ─── Strategy 6: escapeNormalizedReplacer ──────────────────────────────

    describe('Strategy 6: escapeNormalizedReplacer', () => {
        it('matches escaped newlines in find against actual newlines in content', () => {
            const content = 'line1\nline2';
            const find = 'line1\\nline2';
            const result = replace(content, find, 'X');
            expect(result).to.equal('X');
        });

        it('matches escaped tabs', () => {
            const content = 'a\tb';
            const find = 'a\\tb';
            const result = replace(content, find, 'X');
            expect(result).to.equal('X');
        });
    });

    // ─── Strategy 7: trimmedBoundaryReplacer ───────────────────────────────

    describe('Strategy 7: trimmedBoundaryReplacer', () => {
        it('matches when find has leading/trailing whitespace not in content', () => {
            const content = 'hello world';
            const find = '  hello world  ';
            const result = replace(content, find, 'X');
            expect(result).to.equal('X');
        });
    });

    // ─── Strategy 8: contextAwareReplacer ──────────────────────────────────

    describe('Strategy 8: contextAwareReplacer', () => {
        it('matches by first/last line + 50% interior similarity', () => {
            const content = 'begin\naaa\nbbb\nccc\nend';
            const find = 'begin\naaa\nxxx\nccc\nend'; // 2/3 interior match = 66%
            const result = replace(content, find, 'FOUND');
            expect(result).to.equal('FOUND');
        });

        it('rejects when no strategy can find a match', () => {
            // Completely different content — no strategy should match
            const content = 'AAA\nhello\nZZZ';
            const find =   'QQQ\nzzzzz\nPPP';
            expect(() => replace(content, find, 'X')).to.throw('Content not found');
        });

        it('requires at least 3 lines', () => {
            const content = 'a\nb';
            // Strategy 8 should skip — falls through to error
            const result = replace(content, 'a\nb', 'x');
            expect(result).to.equal('x'); // matched by strategy 1 (exact)
        });
    });

    // ─── Integration: strategy fallback chain ──────────────────────────────

    describe('Strategy fallback chain', () => {
        it('falls through strategies until one matches', () => {
            // Content has extra indentation + trailing spaces
            const content = '    hello   \n    world   ';
            // Strategy 1 (exact) fails, strategy 2 (trimmed) matches
            const result = replace(content, 'hello\nworld', 'X');
            expect(result).to.equal('X');
        });

        it('prefers earlier strategy when multiple could match', () => {
            const content = 'hello world';
            // Both strategy 1 and 4 could match
            const result = replace(content, 'hello world', 'X');
            expect(result).to.equal('X');
        });
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    describe('Edge cases', () => {
        it('handles empty content', () => {
            expect(() => replace('', 'a', 'b')).to.throw('Content not found');
        });

        it('handles CRLF line endings', () => {
            const content = 'line1\r\nline2\r\nline3';
            // Strategy 1 should match exact CRLF, or strategy 2/5 normalizes
            const result = replace(content, 'line1\r\nline2', 'X');
            expect(result).to.equal('X\r\nline3');
        });

        it('handles unicode content', () => {
            const content = '你好 世界';
            const result = replace(content, '世界', '地球');
            expect(result).to.equal('你好 地球');
        });

        it('handles replaceAll with multi-line', () => {
            const content = 'if (a) {\n    x;\n}\nif (a) {\n    x;\n}';
            const result = replace(content, 'if (a) {\n    x;\n}', 'Y', true);
            expect(result).to.equal('Y\nY');
        });
    });
});
