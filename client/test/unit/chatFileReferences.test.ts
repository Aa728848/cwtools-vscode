import { expect } from 'chai';
import { findFileReferences } from '../../webview/chat/fileReferences';

describe('chat file reference matcher', () => {
    it('matches path:line and path:start-end with whitelisted extensions', () => {
        expect(findFileReferences('see events/kuat_missions_events.txt:399-414 for details')).to.deep.equal([
            { file: 'events/kuat_missions_events.txt', startLine: 399, endLine: 414, index: 4, text: 'events/kuat_missions_events.txt:399-414' },
        ]);
        expect(findFileReferences('exe_feature_l_simp_chinese.yml:443')).to.deep.equal([
            { file: 'exe_feature_l_simp_chinese.yml', startLine: 443, endLine: undefined, index: 0, text: 'exe_feature_l_simp_chinese.yml:443' },
        ]);
    });

    it('matches multiple references on one line and keeps only the full form', () => {
        const matches = findFileReferences('common/foo.txt:443 / :447 and gui/bar.gui:10-12');
        expect(matches).to.have.length(2);
        expect(matches[0]).to.deep.equal({ file: 'common/foo.txt', startLine: 443, endLine: undefined, index: 0, text: 'common/foo.txt:443' });
        expect(matches[1]).to.deep.equal({ file: 'gui/bar.gui', startLine: 10, endLine: 12, index: 30, text: 'gui/bar.gui:10-12' });
    });

    it('matches extensions case-insensitively across the whitelist', () => {
        for (const sample of ['a.TXT:1', 'b.PS1:2', 'c.Rules:3', 'd.pdxtxt:4', 'e.fxh:5', 'f.cwt:6', 'g.loc:7', 'h.asset:8', 'i.mod:9']) {
            expect(findFileReferences(sample), sample).to.have.length(1);
        }
    });

    it('rejects extension-less paths and unknown extensions', () => {
        expect(findFileReferences('kuat_missions.12:129-132')).to.deep.equal([]);
        expect(findFileReferences('notes.docx:10')).to.deep.equal([]);
        expect(findFileReferences('archive.zip:3')).to.deep.equal([]);
    });

    it('rejects references glued onto URLs or longer words', () => {
        expect(findFileReferences('https://example.com/a/file.txt:10')).to.deep.equal([]);
        expect(findFileReferences('myfile.txt:10')).to.have.length(1);
    });

    it('handles punctuation boundaries and inverted ranges', () => {
        const matches = findFileReferences('(common/a.md:3), then "b/c.ts:7-9".');
        expect(matches.map(m => m.text)).to.deep.equal(['common/a.md:3', 'b/c.ts:7-9']);
        const inverted = findFileReferences('a.txt:9-4');
        expect(inverted).to.have.length(1);
        expect(inverted[0]!.endLine).to.equal(undefined);
        expect(findFileReferences('')).to.deep.equal([]);
    });
});
