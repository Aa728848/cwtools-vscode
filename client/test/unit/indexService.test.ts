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
        expect(entries[0]!.valueHash).to.match(/^[0-9a-f]{8}$/);
        expect(entries[0]!.header).to.equal('l_english');
        expect(entries[0]!.hasBom).to.equal(true);
        expect(entries[0]!.encoding).to.equal('utf8-bom');
    });

    it('records BOM and validates the header against the localisation language directory', () => {
        const entries = parseLocFile(SAMPLE_LOC_SIMP_CHINESE, '/mod/localisation/simp_chinese/sample.yml');
        expect(entries[0]!.hasBom).to.equal(true);
        expect(entries[0]!.encoding).to.equal('utf8-bom');
        expect(entries[0]!.headerMatchesPath).to.equal(true);
        const mismatched = parseLocFile(SAMPLE_LOC, '/mod/localisation/simp_chinese/wrong.yml');
        expect(mismatched[0]!.headerMatchesPath).to.equal(false);
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
building_samplemod_command_center_auto:0 "Command Center"
`, '/test.yml');
        expect(entries).to.have.lengthOf(1);
        expect(entries[0]!.key).to.equal('building_samplemod_command_center_auto');
    });

    it('parses entries with comments after the value', () => {
        const entries = parseLocFile(`l_english:
 building_samplemod_resource_center_auto:0 "Resource Center" # generated
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

    it('restores the outer color after a nested color closes', () => {
        const text = '\u00a7Hgold \u00a7Bblue\u00a7! gold again\u00a7! plain';
        const colorRanges = tokenizeLocalisationRichText(text, 10)
            .filter(token => token.type === 'colorRange')
            .map(token => ({ colorCode: token.colorCode, text: token.text }));

        expect(colorRanges).to.deep.equal([
            { colorCode: '\u00a7H', text: 'gold ' },
            { colorCode: '\u00a7B', text: 'blue' },
            { colorCode: '\u00a7H', text: ' gold again' },
        ]);
    });

    it('pairs resets with unknown nested color markers before restoring the outer color', () => {
        const text = '\u00a7Hgold \u00a7Zunknown\u00a7! gold again\u00a7!';
        const colorRanges = tokenizeLocalisationRichText(text)
            .filter(token => token.type === 'colorRange')
            .map(token => ({ colorCode: token.colorCode, text: token.text }));

        expect(colorRanges).to.deep.equal([
            { colorCode: '\u00a7H', text: 'gold ' },
            { colorCode: '\u00a7H', text: ' gold again' },
        ]);
    });

    it('strips all localisation color markers for plain hover previews', () => {
        expect(stripLocalisationColorMarkers('§HHeader§! and §Oorange§!')).to.equal('Header and orange');
    });

    it('keeps color markers inside comma-form concept labels tokenizable', () => {
        const text = "['concept_SRA_set_terrified_3','\u00a7R恐惧。\u00a7!']";
        const tokens = tokenizeLocalisationRichText(text, 0);
        expect(tokens.some(token => token.type === 'concept' && token.text === text)).to.equal(true);
        expect(tokens.some(token => token.type === 'colorMarker' && token.text === '\u00a7R')).to.equal(true);
        expect(tokens.some(token => token.type === 'colorRange' && token.colorCode === '\u00a7R' && token.text === '恐惧。')).to.equal(true);
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

describe('IndexService workspaceSymbolTypeSummary', () => {
    const vscodeStub = {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: 'C:\\workspace' } }],
        },
        window: {
            createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
        },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
    };

    function loadIndexService() {
        const moduleLoader = require('module') as { _load: (...args: any[]) => any };
        const originalLoad = moduleLoader._load;
        const modulePath = require.resolve('../../extension/indexing/indexService');
        const reporterPath = require.resolve('../../extension/ai/errorReporter');
        delete require.cache[modulePath];
        delete require.cache[reporterPath];
        moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
            if (request === 'vscode') return vscodeStub;
            return originalLoad.apply(this, [request, ...args]);
        };
        const service = require('../../extension/indexing/indexService') as typeof import('../../extension/indexing/indexService');
        return { service, originalLoad, modulePath, reporterPath };
    }

    function restoreLoader(loaded: { originalLoad: (...args: any[]) => any; modulePath: string; reporterPath: string }): void {
        const moduleLoader = require('module') as { _load: (...args: any[]) => any };
        moduleLoader._load = loaded.originalLoad;
        delete require.cache[loaded.modulePath];
        delete require.cache[loaded.reporterPath];
    }

    it('groups workspace symbols by kind with bounded samples and counts', () => {
        const loaded = loadIndexService();
        try {
        const { IndexService } = loaded.service;
        const service = new IndexService() as unknown as {
            _workspaceSymbolIndex: Map<string, Array<{ name: string; kind: string; origin?: string }>>;
            workspaceSymbolTypeSummary(limitPerType?: number, maxTypes?: number): { byType: Record<string, string[]>; byTypeCounts: Record<string, number> };
        };
        const index = new Map<string, Array<{ name: string; kind: string; origin?: string }>>();
        index.set('a', [{ name: 'a', kind: 'event' }, { name: 'a', kind: 'event' }]);
        index.set('b', [{ name: 'b', kind: 'event' }, { name: 'b', kind: 'event', origin: 'vanilla' }]);
        index.set('c', [{ name: 'c', kind: 'scripted_effect' }, { name: 'c', kind: 'namespace' }]);
        index.set('d', [{ name: 'd', kind: 'pdx_block' }]);
        service._workspaceSymbolIndex = index;

        const summary = service.workspaceSymbolTypeSummary(2, 10);

        expect(summary.byType.event).to.deep.equal(['a', 'b']);
        expect(summary.byTypeCounts.event).to.equal(2);
        expect(summary.byType.scripted_effect).to.deep.equal(['c']);
        expect(summary.byType.namespace).to.equal(undefined);
        expect(summary.byType.pdx_block).to.equal(undefined);
        // vanilla origin is excluded
        expect(summary.byTypeCounts.event).to.equal(2);
        } finally {
            restoreLoader(loaded);
        }
    });

    it('limits the number of sample names and kinds', () => {
        const loaded = loadIndexService();
        try {
        const { IndexService } = loaded.service;
        const service = new IndexService() as unknown as {
            _workspaceSymbolIndex: Map<string, Array<{ name: string; kind: string; origin?: string }>>;
            workspaceSymbolTypeSummary(limitPerType?: number, maxTypes?: number): { byType: Record<string, string[]>; byTypeCounts: Record<string, number> };
        };
        const index = new Map<string, Array<{ name: string; kind: string; origin?: string }>>();
        for (let i = 0; i < 20; i++) {
            index.set(`n${i}`, [{ name: `n${i}`, kind: 'event' }]);
        }
        service._workspaceSymbolIndex = index;

        const summary = service.workspaceSymbolTypeSummary(3, 5);

        expect(summary.byType.event).to.have.lengthOf(3);
        expect(summary.byTypeCounts.event).to.equal(20);
        } finally {
            restoreLoader(loaded);
        }
    });

    it('computes true language key-set differences before result truncation', () => {
        const loaded = loadIndexService();
        try {
            const { IndexService } = loaded.service;
            const service = new IndexService() as any;
            service._locIndex = new Map<string, LocEntry[]>([
                ['shared', [
                    { key: 'shared', value: 'Shared', file: 'en.yml', line: 2, language: 'l_english' },
                    { key: 'shared', value: '共享', file: 'zh.yml', line: 2, language: 'l_simp_chinese' },
                ]],
                ['english_only', [{ key: 'english_only', value: 'Only', file: 'en.yml', line: 3, language: 'l_english' }]],
                ['chinese_only', [{ key: 'chinese_only', value: '仅有', file: 'zh.yml', line: 3, language: 'l_simp_chinese' }]],
            ]);

            const comparison = service.locLanguageDifferences({}, 'l_english', 1);
            const chinese = comparison.find((item: any) => item.language === 'l_simp_chinese');
            expect(chinese.missingKeys).to.deep.equal(['english_only']);
            expect(chinese.extraKeys).to.deep.equal(['chinese_only']);
            expect(chinese.present).to.equal(false);
        } finally {
            restoreLoader(loaded);
        }
    });

    it('does not misclassify normal translations as duplicate keys', () => {
        const loaded = loadIndexService();
        try {
            const { IndexService } = loaded.service;
            const service = new IndexService() as any;
            service._locIndex = new Map<string, LocEntry[]>([
                ['shared', [
                    { key: 'shared', value: 'Shared', file: 'en.yml', line: 2, language: 'l_english' },
                    { key: 'shared', value: '共享', file: 'zh.yml', line: 2, language: 'l_simp_chinese' },
                ]],
                ['duplicate', [
                    { key: 'duplicate', value: 'One', file: 'en-a.yml', line: 2, language: 'l_english' },
                    { key: 'duplicate', value: 'Two', file: 'en-b.yml', line: 4, language: 'l_english' },
                ]],
            ]);
            const groups = service.locDuplicateGroups(10);
            expect(groups).to.have.lengthOf(1);
            expect(groups[0].key).to.equal('duplicate');
            expect(groups[0].language).to.equal('l_english');
        } finally {
            restoreLoader(loaded);
        }
    });
});
