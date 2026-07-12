import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('Paradox Grammar', () => {
    const root = path.join(__dirname, '../../..');
    const grammarPath = path.join(root, 'release/syntaxes/paradox.tmLanguage.json');

    let grammar: any;

    before(() => {
        grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
    });

    it('marks inline script parameter placeholders and calls in the Paradox grammar', () => {
        expect(grammar.repository.parameters.patterns).to.deep.include({
            name: 'variable.parameter.placeholder.paradox',
            match: '(\\$)([A-Za-z0-9_.:-]+(?:\\|[A-Za-z0-9_.:-]+)?)(\\$)',
            captures: {
                1: { name: 'punctuation.definition.parameter.begin.paradox' },
                2: { name: 'variable.parameter.paradox' },
                3: { name: 'punctuation.definition.parameter.end.paradox' },
            },
        });
        expect(grammar.repository.parameters.patterns).to.deep.include({
            name: 'support.function.parameter-call.paradox',
            match: '(\\|)([A-Za-z0-9_.:-]+)(\\|)',
            captures: {
                1: { name: 'punctuation.definition.parameter-call.begin.paradox' },
                2: { name: 'variable.parameter.call.paradox' },
                3: { name: 'punctuation.definition.parameter-call.end.paradox' },
            },
        });

        const codeIncludes = grammar.repository.code.patterns.map((pattern: any) => pattern.include);
        expect(codeIncludes).to.include('#parameters');
    });

    it('recognizes comma-form concept labels with color markers inside the label', () => {
        const pattern = grammar.repository.strings.patterns.find((entry: any) => entry.name === 'meta.concept.paradox');
        expect(pattern).to.not.equal(undefined);
        const regex = new RegExp(pattern.begin);
        const correct = "['concept_SRA_set_terrified_3','\u00a7R恐惧。\u00a7!']";
        const match = correct.match(regex);
        expect(match).to.not.equal(null);
        expect(match![2]).to.equal("'concept_SRA_set_terrified_3'");
        const colorPattern = pattern.patterns.find((entry: any) => entry.name === 'constant.character.format.color.paradox');
        expect(correct.match(new RegExp(colorPattern.match, 'g'))).to.deep.equal(['\u00a7R', '\u00a7!']);
    });
});
