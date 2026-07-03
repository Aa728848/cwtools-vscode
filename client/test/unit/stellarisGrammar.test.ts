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
});
