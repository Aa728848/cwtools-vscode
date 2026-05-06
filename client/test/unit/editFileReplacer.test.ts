import { expect } from 'chai';
import { fuzzyReplace, findNearestMatch } from '../../extension/ai/tools/replacerSuite';

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

    // ─── Strategy 10: similarityReplacer ──────────────────────────────────

    describe('Strategy 10: similarityReplacer (75% Jaccard)', () => {
        it('matches when ~78% of lines are the same (above 75% threshold)', () => {
            // 7 of 8 lines match, 1 differs → Jaccard = 7/9 = 77.8% > 75%
            const content = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8';
            const find =   'line1\nline2\nline3\nline4\nlineX\nline6\nline7\nline8';
            const result = replace(content, find, 'MATCHED');
            expect(result).to.equal('MATCHED');
        });

        it('rejects when similarity is below 75% threshold', () => {
            // All lines different — no earlier strategy should match
            const content = 'alpha1\nbeta2\ngamma3\ndelta4\nepsilon5\nzeta6';
            const find =   'qqq1\nrrr2\nsss3\nttt4\nuuu5\nvvv6';
            // Jaccard: 0 intersection → 0% → below 75%
            expect(() => replace(content, find, 'X')).to.throw('Content not found');
        });

        it('handles window tolerance (content matches a sub-window)', () => {
            // Content has extra lines, find targets a sub-range
            const content = 'header\nalpha\nbeta\ngamma\ndelta\nfooter';
            const find =   'alpha\nbeta\ngamma\ndelta';
            // Exact 4-line match — will be caught by simpleReplacer (Strategy 1) first
            const result = replace(content, find, 'WINDOW');
            expect(result).to.equal('header\nWINDOW\nfooter');
        });
    });

    // ─── findNearestMatch helper ──────────────────────────────────────────

    describe('findNearestMatch', () => {
        it('returns nearest match info for partially similar content', () => {
            const content = 'header\nalpha\nbeta\ngamma\nfooter';
            const find = 'alpha\nbeta\nXXXX';
            const result = findNearestMatch(content, find);
            expect(result).to.not.be.null;
            expect(result!.startLine).to.be.greaterThan(0);
            expect(result!.similarity).to.be.greaterThan(15);
        });

        it('returns null for completely unrelated content', () => {
            const content = 'aaa\nbbb\nccc';
            const find = 'xxx\nyyy\nzzz';
            const result = findNearestMatch(content, find);
            expect(result).to.be.null;
        });

        it('returns correct line numbers (1-based)', () => {
            const content = 'line1\nline2\nalpha\nbeta\nline5';
            const find = 'alpha\nbeta';
            const result = findNearestMatch(content, find);
            expect(result).to.not.be.null;
            expect(result!.startLine).to.equal(3); // 1-based
            expect(result!.endLine).to.equal(4);
            expect(result!.similarity).to.equal(100);
        });
    });

    // ─── Enhanced error messages ──────────────────────────────────────────

    describe('Enhanced error messages', () => {
        it('includes nearest match hint in error when partial match exists', () => {
            const content = 'header\nalpha\nbeta\ngamma\nfooter';
            const find = 'alpha\nbeta\nXXXX_NOMATCH';
            try {
                replace(content, find, 'X');
                expect.fail('Should have thrown');
            } catch (e: any) {
                expect(e.message).to.include('Nearest partial match');
                expect(e.message).to.include('replace_lines');
            }
        });

        it('includes basic hint when no partial match exists', () => {
            try {
                replace('abc', 'xyz_totally_different', 'X');
                expect.fail('Should have thrown');
            } catch (e: any) {
                expect(e.message).to.include('Content not found');
                expect(e.message).to.include('read_file');
            }
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
