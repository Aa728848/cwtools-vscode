import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('Stellaris Localisation Grammar & Language Configuration', () => {
    const root = path.join(__dirname, '../../..');
    const grammarPath = path.join(root, 'release/syntaxes/stellaris-localisation.tmLanguage.json');
    const configPath = path.join(root, 'release/language-configuration-localisation.json');
    const packagePath = path.join(root, 'release/package.json');

    let grammar: any;
    let manifest: any;

    before(() => {
        expect(fs.existsSync(grammarPath), 'grammar file should exist').to.be.true;
        expect(fs.existsSync(configPath), 'language config file should exist').to.be.true;
        grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
        manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    });

    it('registers the language and grammar in the extension manifest', () => {
        const languages = manifest.contributes.languages as any[];
        const grammars = manifest.contributes.grammars as any[];

        const language = languages.find(entry => entry.id === 'stellaris-localisation');
        expect(language).to.not.equal(undefined);
        expect(language.configuration).to.equal('./language-configuration-localisation.json');
        expect(language.filenamePatterns).to.include.members([
            '**/localisation/**/*.yml',
            '**/localization/**/*.yml',
            '**/*_l_*.yml',
        ]);
        expect(language.filenamePatterns).not.to.include('**/localisation_synced/**/*.yml');

        const registeredGrammar = grammars.find(entry => entry.language === 'stellaris-localisation');
        expect(registeredGrammar).to.deep.equal({
            language: 'stellaris-localisation',
            scopeName: 'source.stellaris-localisation',
            path: './syntaxes/stellaris-localisation.tmLanguage.json',
        });
        expect(manifest.extensionPack).to.not.include('anthonyj.stellaris-localisation-syntax');
    });

    it('has valid grammar metadata and repository sections', () => {
        expect(grammar.name).to.equal('Stellaris Localisation');
        expect(grammar.scopeName).to.equal('source.stellaris-localisation');
        expect(grammar.patterns).to.be.an('array');
        expect(grammar.repository).to.be.an('object');

        const expectedKeys = [
            'comments',
            'language-header',
            'localisation-entry',
            'strings',
            'inline-markup',
        ];
        for (const key of expectedKeys) {
            expect(grammar.repository, `missing repository key: ${key}`).to.have.property(key);
        }
    });

    it('matches language headers and localisation entry keys', () => {
        const headerPattern = grammar.repository['language-header'].patterns[0];
        const entryPattern = grammar.repository['localisation-entry'].patterns[0];
        const headerRegex = new RegExp(headerPattern.match);
        const entryRegex = new RegExp(entryPattern.begin);

        const headerMatch = 'l_simp_chinese:'.match(headerRegex);
        expect(headerMatch).to.not.equal(null);
        expect(headerMatch![1]).to.equal('l_simp_chinese');

        const entryMatch = ' my_event.desc:0 "Text"'.match(entryRegex);
        expect(entryMatch).to.not.equal(null);
        expect(entryMatch![1]).to.equal('my_event.desc');
        expect(entryMatch![3]).to.equal(':');
        expect(entryMatch![4]).to.equal('0');
    });

    it('matches Stellaris localisation inline markup', () => {
        const patterns = grammar.repository['inline-markup'].patterns;
        const byName = (name: string) => {
            const pattern = patterns.find((entry: any) => entry.name === name);
            expect(pattern, `missing ${name}`).to.not.equal(undefined);
            return new RegExp(pattern.match);
        };

        expect(byName('constant.character.escape.stellaris-localisation').test('\\"')).to.be.true;
        expect(byName('constant.character.format.color.stellaris-localisation').test('\u00a7Y')).to.be.true;
        expect(byName('constant.character.format.color.stellaris-localisation').test('\u00a7!')).to.be.true;
        expect(byName('constant.character.icon.stellaris-localisation').test('\u00a3energy\u00a3')).to.be.true;
        expect(byName('constant.character.icon.stellaris-localisation').test('\u00a3energy|Y\u00a3')).to.be.true;
        expect(byName('variable.other.localisation-reference.stellaris-localisation').test('$PLANET|Y$')).to.be.true;
        expect(byName('variable.other.scripted-variable.stellaris-localisation').test('@scripted_var')).to.be.true;
        expect(byName('entity.name.concept.stellaris-localisation').test('[\'concept_test\' Concept text]')).to.be.true;
        const concept = patterns.find((entry: any) => entry.name === 'meta.concept.stellaris-localisation');
        expect(new RegExp(concept.begin).test("['concept_test','\u00a7R恐惧。\u00a7!']")).to.be.true;
        const conceptColor = concept.patterns.find((entry: any) => entry.name === 'constant.character.format.color.stellaris-localisation');
        expect("\u00a7R恐惧。\u00a7!".match(new RegExp(conceptColor.match, 'g'))).to.deep.equal(['\u00a7R', '\u00a7!']);
        expect(byName('support.function.scope-expression.stellaris-localisation').test('[Root.GetName]')).to.be.true;
    });

    it('keeps localisation editor defaults separate from generic YAML', () => {
        const defaults = manifest.contributes.configurationDefaults;
        expect(defaults['[stellaris-localisation]']).to.deep.include({
            'files.autoGuessEncoding': true,
            'files.encoding': 'utf8bom',
            'editor.autoIndent': 'none',
            'editor.wordWrap': 'on',
        });

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(config.comments.lineComment).to.equal('#');
        expect(config.surroundingPairs).to.deep.include(['$', '$']);
    });
});
