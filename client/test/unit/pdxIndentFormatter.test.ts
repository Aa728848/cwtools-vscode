import { expect } from 'chai';
import { reindentLines, braceDeltaOf } from '../../extension/pdxIndent';

const TAB = '\t';

describe('PDX indent formatter — reindentLines', () => {
	it('re-indents a nested block from a base depth using tabs', () => {
		const lines = [
			'star = {',
			'type = spth_star',
			'scale = 0.25',
			'}',
		];
		const out = reindentLines(lines, 2, TAB);
		expect(out).to.deep.equal([
			'\t\tstar = {',
			'\t\t\ttype = spth_star',
			'\t\t\tscale = 0.25',
			'\t\t}',
		]);
	});

	it('dedents lines that start with a closing brace', () => {
		const lines = ['a = {', 'b = 1', '}'];
		const out = reindentLines(lines, 0, TAB);
		expect(out).to.deep.equal(['a = {', '\tb = 1', '}']);
	});

	it('normalizes wrong incoming indentation (the pasted-block case)', () => {
		// Over-indented clipboard content should be flattened to the target depth.
		const lines = [
			'\t\t\t\t\tstar = {',
			'\t\t\t\t\t\ttype = x',
			'\t\t\t\t\t}',
		];
		const out = reindentLines(lines, 1, TAB);
		expect(out).to.deep.equal([
			'\tstar = {',
			'\t\ttype = x',
			'\t}',
		]);
	});

	it('emits empty string for blank / whitespace-only lines', () => {
		const lines = ['a = {', '   ', '', 'b = 1', '}'];
		const out = reindentLines(lines, 0, TAB);
		expect(out).to.deep.equal(['a = {', '', '', '\tb = 1', '}']);
	});

	it('supports a space-based indent unit', () => {
		const lines = ['a = {', 'b = 1', '}'];
		const out = reindentLines(lines, 0, '    ');
		expect(out).to.deep.equal(['a = {', '    b = 1', '}']);
	});

	it('never produces negative indentation', () => {
		const lines = ['}', 'a = 1'];
		const out = reindentLines(lines, 0, TAB);
		expect(out).to.deep.equal(['}', 'a = 1']);
	});

	it('indents one level per line for compressed multi-brace lines', () => {
		// `x = { y = {` opens two braces on one line but should only add one
		// indent level (matching VS Code built-in indentationRules + hand style);
		// `} }` closes both but dedents only one level.
		const lines = [
			'event_target:Foo = {',
			'solar_system = { spawn_megastructure = {',
			'type = Bar',
			'planet = star owner = space_owner',
			'} }',
			'remove_megastructure = this',
			'}',
		];
		const out = reindentLines(lines, 1, TAB);
		expect(out).to.deep.equal([
			'\tevent_target:Foo = {',
			'\t\tsolar_system = { spawn_megastructure = {',
			'\t\t\ttype = Bar',
			'\t\t\tplanet = star owner = space_owner',
			'\t\t} }',
			'\t\tremove_megastructure = this',
			'\t}',
		]);
	});
});

describe('PDX indent formatter — braceDeltaOf', () => {
	it('counts net braces on a line', () => {
		expect(braceDeltaOf('a = { b = { } }')).to.equal(0); // balanced
		expect(braceDeltaOf('a = { b = {')).to.equal(2);
		expect(braceDeltaOf('}')).to.equal(-1);
		expect(braceDeltaOf('a = 1')).to.equal(0);
	});

	it('ignores braces inside line comments', () => {
		expect(braceDeltaOf('a = 1 # not a block { { {')).to.equal(0);
	});

	it('ignores braces inside double-quoted strings', () => {
		expect(braceDeltaOf('name = "weird { name }"')).to.equal(0);
		expect(braceDeltaOf('a = { key = "}" }')).to.equal(0); // string `}` ignored; real braces balance
		expect(braceDeltaOf('a = { name = "}"')).to.equal(1); // string `}` ignored; one real open
	});

	it('handles escaped quotes inside strings', () => {
		expect(braceDeltaOf('a = "he said \\"{\\"" b = {')).to.equal(1);
	});

	it('does not let comments/strings throw off block re-indentation', () => {
		const lines = [
			'event = {',
			'desc = "a } b { c"   # trailing { comment',
			'value = 1',
			'}',
		];
		const out = reindentLines(lines, 0, TAB);
		expect(out).to.deep.equal([
			'event = {',
			'\tdesc = "a } b { c"   # trailing { comment',
			'\tvalue = 1',
			'}',
		]);
	});
});
