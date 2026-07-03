import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('Stellaris Dark Modern theme', () => {
    const root = path.join(__dirname, '../../..');
    const packagePath = path.join(root, 'release/package.json');
    const themePath = path.join(root, 'release/themes/stellaris-dark-modern.json');

    let manifest: any;
    let theme: any;

    before(() => {
        expect(fs.existsSync(themePath), 'theme file should exist').to.be.true;
        manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));
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
            comment: '#6A9955',
        });

        const scopes = theme.tokenColors.flatMap((rule: any) => Array.isArray(rule.scope) ? rule.scope : [rule.scope]);
        expect(scopes).to.include.members([
            'variable.language.definition_tokens.paradox',
            'variable.language.conditions.paradox',
            'constant.numeric.paradox',
            'comment.line.number-sign.paradox',
        ]);
    });
});
