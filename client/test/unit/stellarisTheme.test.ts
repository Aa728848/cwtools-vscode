import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('Stellaris Dark Modern theme', () => {
    const root = path.join(__dirname, '../../..');
    const packagePath = path.join(root, 'release/package.json');
    const themePath = path.join(root, 'release/themes/stellaris-dark-modern.json');
    const grammarPath = path.join(root, 'release/syntaxes/paradox.tmLanguage.json');

    let manifest: any;
    let theme: any;
    let grammar: any;

    before(() => {
        expect(fs.existsSync(themePath), 'theme file should exist').to.be.true;
        manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));
        grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
    });

    it('registers the bundled color theme in the extension manifest', () => {
        const themes = manifest.contributes.themes as any[];
        const registeredTheme = themes.find(entry => entry.id === 'Stellaris Dark Modern');

        expect(registeredTheme).to.deep.equal({
            id: 'Stellaris Dark Modern',
            label: '%themes.stellarisDarkModern.label%',
            uiTheme: 'vs-dark',
            path: './themes/stellaris-dark-modern.json',
        });
    });

    it('keeps Modern Dark-style syntax colors for Paradox scripts', () => {
        expect(theme.name).to.equal('Stellaris Dark Modern');
        expect(theme.type).to.equal('dark');
        expect(theme.semanticHighlighting).to.equal(true);
        expect(theme.colors['editor.background']).to.equal('#1F1F1F');

        expect(theme.semanticTokenColors).to.deep.include({
            property: '#9CDCFE',
            keyword: '#C586C0',
            number: '#B5CEA8',
            string: '#CE9178',
            'string:stellaris': '#9CDCFE',
            'string:paradox': '#9CDCFE',
            'parameter:stellaris': '#C586C0',
            'macro:stellaris': '#D7BA7D',
            comment: '#6A9955',
        });

        const scopes = theme.tokenColors.flatMap((rule: any) => Array.isArray(rule.scope) ? rule.scope : [rule.scope]);
        expect(scopes).to.include.members([
            'variable.language.definition_tokens.paradox',
            'variable.language.conditions.paradox',
            'variable.parameter.paradox',
            'variable.parameter.call.paradox',
            'constant.numeric.paradox',
            'comment.line.number-sign.paradox',
        ]);
    });

    it('marks inline script parameter placeholders and calls in the Paradox grammar', () => {
        expect(grammar.repository.parameters.patterns).to.deep.include({
            name: 'variable.parameter.placeholder.paradox',
            match: '(\\$)([A-Za-z0-9_.:-]+)(\\$)',
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
