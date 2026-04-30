import { expect } from 'chai';
import { tryRepairJson } from '../../extension/ai/jsonRepair';

describe('tryRepairJson', () => {
    it('returns null for undefined input', () => {
        expect(tryRepairJson(undefined)).to.be.null;
    });

    it('returns null for empty string', () => {
        expect(tryRepairJson('')).to.be.null;
    });

    it('returns parsed object for valid JSON', () => {
        const result = tryRepairJson('{"key": "value", "num": 42}');
        expect(result).to.deep.equal({ key: 'value', num: 42 });
    });

    it('repairs missing closing brace + quote', () => {
        const result = tryRepairJson('{"key": "val');
        expect(result).to.deep.equal({ key: 'val' });
    });

    it('repairs missing closing bracket', () => {
        const result = tryRepairJson('{"arr": [1, 2, 3');
        expect(result).to.deep.equal({ arr: [1, 2, 3] });
    });

    it('repairs missing closing brace', () => {
        const result = tryRepairJson('{"a": 1, "b": 2');
        expect(result).to.deep.equal({ a: 1, b: 2 });
    });

    it('removes trailing commas', () => {
        const result = tryRepairJson('{"a": 1, "b": 2,}');
        expect(result).to.deep.equal({ a: 1, b: 2 });
    });

    it('removes trailing comma before closing bracket', () => {
        const result = tryRepairJson('{"arr": [1, 2,]}');
        expect(result).to.deep.equal({ arr: [1, 2] });
    });

    it('extracts JSON object from surrounding text', () => {
        const result = tryRepairJson('some prefix {"key": "val"} some suffix');
        expect(result).to.deep.equal({ key: 'val' });
    });

    it('handles truncated property value (cut in middle of string)', () => {
        const result = tryRepairJson('{"key": "unfinished');
        expect(result).to.deep.equal({ key: 'unfinished' });
    });

    it('handles truncated before last comma value', () => {
        const result = tryRepairJson('{"a": 1,');
        expect(result).to.deep.equal({ a: 1 });
    });

    it('fixes unescaped backslashes in AI output (Windows paths with invalid escapes)', () => {
        // Single backslashes in AI JSON output: \W and \s are NOT valid JSON escapes
        const result = tryRepairJson('{"path": "C:\\Windows\\system32"}');
        expect(result).to.exist;
        // The repair double-escapes invalid escapes, so path will have literal \\
        expect(result!.path).to.be.a('string').and.to.include('Windows');
    });

    it('handles nested objects', () => {
        const result = tryRepairJson('{"outer": {"inner": "val"}');
        expect(result).to.deep.equal({ outer: { inner: 'val' } });
    });

    it('returns null for completely unparseable input', () => {
        const result = tryRepairJson('not json at all { broken');
        expect(result).to.be.null;
    });
});
