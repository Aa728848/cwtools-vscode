import { expect } from 'chai';
import {
    parseLocFile,
    parseLocalisationLine,
    detectLocLanguage,
    addEntriesToIndex,
    removeFileFromIndex,
    queryLocIndex,
    stripLocalisationColorMarkers,
    tokenizeLocalisationRichText,
} from '../../extension/indexing/locParser';
import { getLocalisationCompletionContext } from '../../extension/localisationCompletions';
import type { LocEntry } from '../../extension/indexing/indexService';

const SAMPLE_LOC = `\uFEFFl_english:
 greeting:0 "Hello"
 farewell:1 "Goodbye"
 mod_name: "My Mod"
`;

const SAMPLE_LOC_SIMP_CHINESE = `\uFEFFl_simp_chinese:
 greeting:0 "你好"
 farewell:1 "再见"
`;

describe('Localisation Parser (indexing)', () => {
    // ── parseLocFile ───────────────────────────────────────────────────

    it('parses standard loc entries', () => {
        const entries = parseLocFile(SAMPLE_LOC, '/test/loc_english.yml');
        expect(entries).to.have.lengthOf(3);
        expect(entries[0]!.key).to.equal('greeting');
        expect(entries[0]!.value).to.equal('Hello');
        expect(entries[0]!.language).to.equal('l_english');
        expect(entries[0]!.file).to.equal('/test/loc_english.yml');
        expect(entries[0]!.line).to.equal(2);
    });

    it('parses entries with version numbers', () => {
        const entries = parseLocFile(SAMPLE_LOC, '/test.yml');
        const farewell = entries.find(e => e.key === 'farewell');
        expect(farewell).to.not.be.undefined;
        expect(farewell!.value).to.equal('Goodbye');
    });

    it('parses entries without version number', () => {
        const entries = parseLocFile(SAMPLE_LOC, '/test.yml');
        const modName = entries.find(e => e.key === 'mod_name');
        expect(modName).to.not.be.undefined;
        expect(modName!.value).to.equal('My Mod');
    });

    it('parses unindented entries from loose mod localisation files', () => {
        const entries = parseLocFile(`l_english:
building_kuat_command_center_auto:0 "Command Center"
`, '/test.yml');
        expect(entries).to.have.lengthOf(1);
        expect(entries[0]!.key).to.equal('building_kuat_command_center_auto');
    });

    it('parses entries with comments after the value', () => {
        const entries = parseLocFile(`l_english:
 building_kuat_resource_center_auto:0 "Resource Center" # generated
`, '/test.yml');
        expect(entries).to.have.lengthOf(1);
        expect(entries[0]!.value).to.equal('Resource Center');
    });

    it('parses escaped quotes and keeps # inside quoted values', () => {
        const entries = parseLocFile(`l_english:
 quoted_key:0 "A \\"quoted\\" # value" # trailing comment
`, '/test.yml');
        expect(entries).to.have.lengthOf(1);
        expect(entries[0]!.value).to.equal('A "quoted" # value');
    });

    it('parses localisation line value offsets for editor decorations', () => {
        const parsed = parseLocalisationLine(' my_key:0 "§Y$PLANET|Y$§! £energy£ [Root.GetName]" # comment');
        expect(parsed).to.not.equal(undefined);
        expect(parsed!.key).to.equal('my_key');
        expect(parsed!.version).to.equal('0');
        expect(parsed!.rawValue).to.equal('§Y$PLANET|Y$§! £energy£ [Root.GetName]');
        expect(parsed!.valueStart).to.equal(' my_key:0 "'.length);
        expect(parsed!.valueEnd).to.equal(parsed!.valueStart + parsed!.rawValue.length);
    });

    it('tokenizes rich localisation text for colors, icons, references, concepts, and variables', () => {
        const text = '§Y$PLANET|Y$§! £energy|Y£ [Root.GetName] [\'concept_test\' Concept] @scripted_var';
        const tokens = tokenizeLocalisationRichText(text, 10);

        expect(tokens.some(token => token.type === 'colorMarker' && token.text === '§Y')).to.be.true;
        expect(tokens.some(token => token.type === 'colorRange' && token.colorCode === '§Y' && token.text === '$PLANET|Y$')).to.be.true;
        expect(tokens.some(token => token.type === 'parameter' && token.text === '$PLANET|Y$')).to.be.true;
        expect(tokens.some(token => token.type === 'icon' && token.text === '£energy|Y£')).to.be.true;
        expect(tokens.some(token => token.type === 'scopeExpression' && token.text === '[Root.GetName]')).to.be.true;
        expect(tokens.some(token => token.type === 'concept' && token.text === '[\'concept_test\' Concept]')).to.be.true;
        expect(tokens.some(token => token.type === 'scriptedVariable' && token.text === '@scripted_var')).to.be.true;
    });

    it('strips all localisation color markers for plain hover previews', () => {
        expect(stripLocalisationColorMarkers('§HHeader§! and §Oorange§!')).to.equal('Header and orange');
    });

    it('detects localisation completion contexts only inside values', () => {
        const line = ' my_key:0 "§Y$PLANET| [Root. £energy" # §R comment';

        expect(getLocalisationCompletionContext(line, line.indexOf('§Y') + 1)!.kind).to.equal('colorMarker');
        expect(getLocalisationCompletionContext(line, line.indexOf('$PLANET|') + '$PLANET|'.length)!.kind).to.equal('colorArgument');
        expect(getLocalisationCompletionContext(line, line.indexOf('[Root.') + '[Root.'.length)!.kind).to.equal('command');
        expect(getLocalisationCompletionContext(line, line.indexOf('£energy') + '£energy'.length)!.kind).to.equal('icon');
        expect(getLocalisationCompletionContext(line, line.indexOf('# §R') + '# §'.length)).to.equal(undefined);
    });

    it('detects language from header', () => {
        const entries = parseLocFile(SAMPLE_LOC_SIMP_CHINESE, '/test.yml');
        expect(entries[0]!.language).to.equal('l_simp_chinese');
    });

    it('returns empty for file with no entries', () => {
        const entries = parseLocFile('l_english:\n# comment only\n', '/test.yml');
        expect(entries).to.have.lengthOf(0);
    });

    it('returns empty for empty string', () => {
        const entries = parseLocFile('', '/test.yml');
        expect(entries).to.have.lengthOf(0);
    });

    it('handles CRLF line endings', () => {
        const crlf = '\uFEFFl_english:\r\n key1:0 "val1"\r\n key2: "val2"\r\n';
        const entries = parseLocFile(crlf, '/test.yml');
        expect(entries).to.have.lengthOf(2);
    });

    it('assigns correct line numbers', () => {
        const entries = parseLocFile(SAMPLE_LOC, '/test.yml');
        expect(entries[0]!.line).to.equal(2); // greeting on line 2
        expect(entries[1]!.line).to.equal(3); // farewell on line 3
        expect(entries[2]!.line).to.equal(4); // mod_name on line 4
    });

    // ── detectLocLanguage ──────────────────────────────────────────────

    it('detects l_english', () => {
        expect(detectLocLanguage(SAMPLE_LOC)).to.equal('l_english');
    });

    it('detects l_simp_chinese', () => {
        expect(detectLocLanguage(SAMPLE_LOC_SIMP_CHINESE)).to.equal('l_simp_chinese');
    });

    it('returns empty for no header', () => {
        expect(detectLocLanguage('# no header\n key:0 "val"')).to.equal('');
    });

    // ── addEntriesToIndex ──────────────────────────────────────────────

    it('adds entries to empty index', () => {
        const index = new Map<string, LocEntry[]>();
        const entries = parseLocFile(SAMPLE_LOC, '/test.yml');
        addEntriesToIndex(index, entries);
        expect(index.size).to.equal(3);
        expect(index.get('greeting')).to.have.lengthOf(1);
    });

    it('appends duplicate keys from different files', () => {
        const index = new Map<string, LocEntry[]>();
        addEntriesToIndex(index, parseLocFile(SAMPLE_LOC, '/file1.yml'));
        addEntriesToIndex(index, parseLocFile(SAMPLE_LOC_SIMP_CHINESE, '/file2.yml'));
        // Both files have 'greeting'
        expect(index.get('greeting')!.length).to.equal(2);
    });

    // ── removeFileFromIndex ────────────────────────────────────────────

    it('removes entries for a specific file', () => {
        const index = new Map<string, LocEntry[]>();
        addEntriesToIndex(index, parseLocFile(SAMPLE_LOC, '/file1.yml'));
        addEntriesToIndex(index, parseLocFile(SAMPLE_LOC_SIMP_CHINESE, '/file2.yml'));
        expect(index.get('greeting')!.length).to.equal(2);

        removeFileFromIndex(index, '/file1.yml');
        expect(index.get('greeting')!.length).to.equal(1);
        expect(index.get('greeting')![0]!.file).to.equal('/file2.yml');
    });

    it('deletes key entirely when last file is removed', () => {
        const index = new Map<string, LocEntry[]>();
        addEntriesToIndex(index, parseLocFile(SAMPLE_LOC, '/file1.yml'));
        removeFileFromIndex(index, '/file1.yml');
        expect(index.has('greeting')).to.be.false;
        expect(index.size).to.equal(0);
    });

    it('handles removing a non-existent file gracefully', () => {
        const index = new Map<string, LocEntry[]>();
        addEntriesToIndex(index, parseLocFile(SAMPLE_LOC, '/file1.yml'));
        removeFileFromIndex(index, '/nonexistent.yml');
        expect(index.size).to.equal(3);
    });

    // ── queryLocIndex ──────────────────────────────────────────────────

    describe('queryLocIndex', () => {
        let index: Map<string, LocEntry[]>;

        beforeEach(() => {
            index = new Map();
            addEntriesToIndex(index, parseLocFile(SAMPLE_LOC, '/en.yml'));
            addEntriesToIndex(index, parseLocFile(SAMPLE_LOC_SIMP_CHINESE, '/zh.yml'));
        });

        it('exact match returns correct entry', () => {
            const results = queryLocIndex(index, { key: 'greeting' });
            expect(results).to.have.lengthOf(2); // en + zh
        });

        it('exact match with language filter', () => {
            const results = queryLocIndex(index, { key: 'greeting', language: 'l_english' });
            expect(results).to.have.lengthOf(1);
            expect(results[0]!.value).to.equal('Hello');
        });

        it('prefix match', () => {
            const results = queryLocIndex(index, { key: 'greet', prefix: true });
            expect(results).to.have.lengthOf(2); // en + zh greeting
        });

        it('prefix match with language filter', () => {
            const results = queryLocIndex(index, { key: 'fare', prefix: true, language: 'l_english' });
            expect(results).to.have.lengthOf(1);
            expect(results[0]!.value).to.equal('Goodbye');
        });

        it('contains match is case-insensitive by default', () => {
            const results = queryLocIndex(index, { key: 'NAME', contains: true });
            expect(results).to.have.lengthOf(1);
            expect(results[0]!.key).to.equal('mod_name');
        });

        it('returns empty for non-existent key', () => {
            const results = queryLocIndex(index, { key: 'nonexistent' });
            expect(results).to.have.lengthOf(0);
        });

        it('returns all entries when no key is specified', () => {
            const results = queryLocIndex(index, {});
            expect(results.length).to.be.greaterThan(0);
        });

        it('respects limit', () => {
            const results = queryLocIndex(index, { limit: 2 });
            expect(results).to.have.lengthOf(2);
        });

        it('returns all entries filtered by language', () => {
            const results = queryLocIndex(index, { language: 'l_simp_chinese' });
            expect(results.length).to.equal(2); // greeting + farewell in Chinese
            for (const r of results) {
                expect(r.language).to.equal('l_simp_chinese');
            }
        });
    });
});
