import { expect } from 'chai';
import type { ShipIconDataSource } from '../../extension/shipIcon/shipIconDefinitions';
import type { LocEntry, LocQuery } from '../../extension/indexing/indexService';
import { resolveShipDesignDisplayNames } from '../../extension/shipDesign/localisation';

class Source implements ShipIconDataSource {
    private readonly files = new Map<string, string>([
        ['localisation/simp_chinese/test.yml', [
            'l_simp_chinese:',
            ' NAME_TEST: "测试护卫舰"',
            ' SMALL_RED_LASER: "§G红色激光§!"',
            ' CORVETTE: "护卫舰"',
            ' SECTION_KEY: "$section_base$"',
            ' section_base: "核心中段"',
        ].join('\n')],
        ['localisation/english/test.yml', [
            'l_english:',
            ' EN_ONLY: "English Only"',
            ' NAME_TEST: "Test Corvette"',
        ].join('\n')],
    ]);
    async readText(relativePath: string): Promise<string | undefined> {
        return this.files.get(relativePath.toLowerCase());
    }
    async listFiles(relativeDirectory: string): Promise<string[]> {
        const prefix = relativeDirectory.toLowerCase() + '/';
        return [...this.files.keys()].filter(path => path.startsWith(prefix)
            && !path.slice(prefix.length).includes('/'));
    }
}

const indexService = {
    async queryLocalisationAsync(query: LocQuery): Promise<LocEntry[]> {
        if (query.key !== 'MOD_KEY') return [];
        return [{
            key: 'MOD_KEY', value: '工作区覆盖名称', file: 'workspace.yml', line: 1,
            language: 'l_simp_chinese', valueHash: '', hasBom: true, encoding: 'utf8-bom', header: 'l_simp_chinese',
        }];
    },
};

describe('ship design localisation display names', () => {
    it('uses language preference, uppercase hull keys, references and workspace overrides', async () => {
        const names = await resolveShipDesignDisplayNames({
            source: new Source(),
            indexService,
            preferredTags: ['l_simp_chinese', 'l_english'],
            ids: ['NAME_TEST', 'SMALL_RED_LASER', 'corvette', 'SECTION_KEY', 'EN_ONLY', 'MOD_KEY', 'MISSING'],
        });
        expect(names.get('NAME_TEST')).to.equal('测试护卫舰');
        expect(names.get('SMALL_RED_LASER')).to.equal('红色激光');
        expect(names.get('corvette')).to.equal('护卫舰');
        expect(names.get('SECTION_KEY')).to.equal('核心中段');
        expect(names.get('EN_ONLY')).to.equal('English Only');
        expect(names.get('MOD_KEY')).to.equal('工作区覆盖名称');
        expect(names.has('MISSING')).to.equal(false);
    });
});
