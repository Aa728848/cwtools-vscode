import { expect } from 'chai';
import { repairToolArgs } from '../../extension/ai/tools/argRepair';

describe('repairToolArgs', () => {
    it('returns no repair for unknown tool name', () => {
        const result = repairToolArgs('nonexistent_tool', { foo: 'bar' });
        expect(result.repaired).to.be.false;
        expect(result.args).to.deep.equal({ foo: 'bar' });
    });

    it('returns no repair when all args match schema', () => {
        // query_scope has: file (string), line (number), column (number)
        const result = repairToolArgs('query_scope', { file: 'test.txt', line: 1, column: 0 });
        expect(result.repaired).to.be.false;
    });

    it('fixes common alias: type_name → typeName', () => {
        const result = repairToolArgs('query_types', { type_name: 'event' });
        expect(result.args).to.have.property('typeName', 'event');
        expect(result.args).to.not.have.property('type_name');
        expect(result.repaired).to.be.true;
        expect(result.repairs[0]).to.include('type_name');
        expect(result.repairs[0]).to.include('typeName');
    });

    it('fixes alias: file_path → filePath (not applicable to read_file which uses "file")', () => {
        // read_file uses 'file' not 'filePath', so file_path should fuzzy-match to 'file'
        const result = repairToolArgs('read_file', { file_path: 'test.txt' });
        // file_path → alias 'filePath', but read_file doesn't have 'filePath'
        // Falls through to Levenshtein: 'filePath' vs 'file' = distance 5, too far
        // So it should NOT be repaired
        // Actually, let's check: file_path alias → filePath, but read_file schema has 'file' not 'filePath'
        // So alias check fails, then Levenshtein on 'file_path' vs 'file' = distance 5, too far
        expect(result.repaired).to.be.false;
    });

    it('coerces string to number for line parameter', () => {
        const result = repairToolArgs('query_scope', { file: 'test.txt', line: '42', column: '10' });
        expect(result.args.line).to.equal(42);
        expect(result.args.column).to.equal(10);
        expect(result.repaired).to.be.true;
    });

    it('coerces a decimal string to an integer for line positions', () => {
        const result = repairToolArgs('query_scope', { file: 'test.txt', line: '42.7', column: 0 });
        expect(result.args.line).to.equal(42);
        expect(result.repaired).to.be.true;
    });

    it('coerces string boolean "true"', () => {
        // query_types has 'vanilla' as boolean
        const result = repairToolArgs('query_types', { typeName: 'event', vanilla: 'true' });
        expect(result.args.vanilla).to.equal(true);
        expect(result.repaired).to.be.true;
    });

    it('coerces string boolean "false"', () => {
        const result = repairToolArgs('query_types', { typeName: 'event', vanilla: 'false' });
        expect(result.args.vanilla).to.equal(false);
        expect(result.repaired).to.be.true;
    });

    it('does not coerce non-boolean string', () => {
        const result = repairToolArgs('query_types', { typeName: 'event', vanilla: 'yes' });
        expect(result.args.vanilla).to.equal('yes');
        // 'yes' is not a boolean coercion candidate, but no error
    });

    it('does not coerce non-numeric string to number', () => {
        const result = repairToolArgs('query_scope', { file: 'test.txt', line: 'abc', column: 0 });
        expect(result.args.line).to.equal('abc');
    });

    it('fuzzy-matches within Levenshtein distance 2', () => {
        // 'fiel' is distance 1 from 'file'
        const result = repairToolArgs('query_scope', { fiel: 'test.txt', line: 1, column: 0 });
        expect(result.args).to.have.property('file', 'test.txt');
        expect(result.args).to.not.have.property('fiel');
        expect(result.repaired).to.be.true;
    });

    it('fuzzy-matches with transposition', (): void => {
        // 'lien' is distance 1 from 'line' (transposition)
        const result = repairToolArgs('query_scope', { file: 'test.txt', lien: 1, column: 0 });
        expect(result.args).to.have.property('line', 1);
        expect(result.args).to.not.have.property('lien');
        expect(result.repaired).to.be.true;
    });

    it('does not repair unknown args beyond distance 2', () => {
        const result = repairToolArgs('query_scope', { xxxxxxx: 'test.txt', line: 1, column: 0 });
        expect(result.repaired).to.be.false;
        expect(result.args).to.have.property('xxxxxxx', 'test.txt');
    });

    it('combines alias rename and type coercion in one pass', () => {
        // query_types: typeName (string), filter (string), limit (number), vanilla (boolean)
        const result = repairToolArgs('query_types', {
            type_name: 'event',
            limit: '50',
            vanilla: 'true',
        });
        expect(result.args.typeName).to.equal('event');
        expect(result.args.limit).to.equal(50);
        expect(result.args.vanilla).to.equal(true);
        expect(result.repaired).to.be.true;
        expect(result.repairs.length).to.be.greaterThanOrEqual(3);
    });

    it('preserves correctly-typed args alongside repaired ones', () => {
        const result = repairToolArgs('query_scope', { file: 'test.txt', line: '5', column: 0 });
        expect(result.args.file).to.equal('test.txt');  // untouched
        expect(result.args.line).to.equal(5);            // coerced
        expect(result.args.column).to.equal(0);          // untouched
    });
});
