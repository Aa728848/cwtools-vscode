import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
	blankParadoxCsvRow,
	adjustParadoxCsvColumnCount,
	analyzeParadoxCsvRows,
	columnIndexAtCharacter,
	insertParadoxCsvColumn,
	isParadoxCsvDataLine,
	parseParadoxCsvLine,
	removeParadoxCsvColumn,
	serializeParadoxCsvCell,
} from '../../extension/paradoxCsv';

describe('Paradox CSV utilities', () => {
	it('parses semicolon-delimited rows with quoted values', () => {
		const cells = parseParadoxCsvLine('key;"quoted;value";"with ""quote""";yes;');

		expect(cells.map(cell => cell.raw)).to.deep.equal([
			'key',
			'"quoted;value"',
			'"with ""quote"""',
			'yes',
			'',
		]);
		expect(cells.map(cell => cell.value)).to.deep.equal([
			'key',
			'quoted;value',
			'with "quote"',
			'yes',
			'',
		]);
		expect(cells[1]!.quoted).to.equal(true);
	});

	it('keeps comments and blank lines out of data operations', () => {
		expect(isParadoxCsvDataLine('# comment')).to.equal(false);
		expect(isParadoxCsvDataLine('  ## row config')).to.equal(false);
		expect(isParadoxCsvDataLine('')).to.equal(false);
		expect(isParadoxCsvDataLine('name;value')).to.equal(true);
	});

	it('resolves the active column from a cursor character', () => {
		expect(columnIndexAtCharacter('a;b;c', 0)).to.equal(0);
		expect(columnIndexAtCharacter('a;b;c', 1)).to.equal(0);
		expect(columnIndexAtCharacter('a;b;c', 2)).to.equal(1);
		expect(columnIndexAtCharacter('a;b;c', 5)).to.equal(2);
	});

	it('inserts and removes columns while preserving untouched raw cells', () => {
		const source = 'key;"still quoted";yes';
		expect(insertParadoxCsvColumn(source, 1)).to.equal('key;;"still quoted";yes');
		expect(insertParadoxCsvColumn(source, 3, 'new;value')).to.equal('key;"still quoted";yes;"new;value"');
		expect(removeParadoxCsvColumn(source, 1)).to.equal('key;yes');
	});

	it('serializes cells only when quoting is needed', () => {
		expect(serializeParadoxCsvCell('plain')).to.equal('plain');
		expect(serializeParadoxCsvCell('needs;quote')).to.equal('"needs;quote"');
		expect(serializeParadoxCsvCell('a "quote"')).to.equal('"a ""quote"""');
		expect(serializeParadoxCsvCell(' padded ')).to.equal('" padded "');
	});

	it('creates blank rows with a stable column count', () => {
		expect(blankParadoxCsvRow(1)).to.equal('');
		expect(blankParadoxCsvRow(3)).to.equal(';;');
		expect(blankParadoxCsvRow(0)).to.equal('');
	});

	it('analyzes malformed rows and column count drift', () => {
		const issues = analyzeParadoxCsvRows([
			'# comment',
			'name;value;flag',
			'one;two',
			'"unterminated;row',
		].join('\n'));

		expect(issues).to.have.lengthOf(2);
		expect(issues[0]).to.include({ line: 2, code: 'columnCount', actualColumns: 2, expectedColumns: 3 });
		expect(issues[1]).to.include({ line: 3, code: 'unterminatedQuote' });
	});

	it('adjusts rows to a target column count', () => {
		expect(adjustParadoxCsvColumnCount('a;b', 4)).to.equal('a;b;;');
		expect(adjustParadoxCsvColumnCount('a;b;c;d', 2)).to.equal('a;b');
	});
});

describe('Paradox CSV grammar and language configuration', () => {
	const grammarPath = path.join(__dirname, '../../../release/syntaxes/paradox-csv.tmLanguage.json');
	const configPath = path.join(__dirname, '../../../release/language-configuration-paradox-csv.json');

	it('ships TextMate grammar metadata', () => {
		const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
		expect(grammar.name).to.equal('Paradox CSV');
		expect(grammar.scopeName).to.equal('source.paradox-csv');
		expect(grammar.repository).to.have.keys(['comments', 'strings', 'delimiters', 'booleans', 'numbers']);
	});

	it('uses Paradox-style line comments in the language configuration', () => {
		const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		expect(config.comments.lineComment).to.equal('#');
		expect(config.wordPattern).to.contain(';');
	});
});
