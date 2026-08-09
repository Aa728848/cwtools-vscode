import { expect } from 'chai';
import {
	getDefaultLocalisationLanguagesForUiLocale,
	getPreferredLocalisationLanguageTags,
	localisationLanguageRank,
	sortLocalisationEntriesByLanguagePreference,
} from '../../extension/localisationLanguagePreference';
import type { LocEntry } from '../../extension/indexing/indexService';

describe('localisation language preference', () => {
	it('maps supported VS Code UI locales to Stellaris localisation settings', () => {
		expect(getDefaultLocalisationLanguagesForUiLocale('zh-cn')).to.deep.equal(['Chinese']);
		expect(getDefaultLocalisationLanguagesForUiLocale('de')).to.deep.equal(['German']);
		expect(getDefaultLocalisationLanguagesForUiLocale('pt-BR')).to.deep.equal(['Braz_Por']);
		expect(getDefaultLocalisationLanguagesForUiLocale('ja')).to.deep.equal(['Japanese']);
		expect(getDefaultLocalisationLanguagesForUiLocale('unsupported')).to.deep.equal(['English']);
	});

	it('maps extension language settings to localisation header tags', () => {
		expect(getPreferredLocalisationLanguageTags(['Chinese', 'English'])).to.deep.equal([
			'l_simp_chinese',
			'l_english',
		]);
		expect(getPreferredLocalisationLanguageTags(['Braz_Por'])).to.deep.equal(['l_braz_por']);
		expect(getPreferredLocalisationLanguageTags([])).to.deep.equal(['l_english']);
	});

	it('ranks entries by configured language order', () => {
		const preferred = getPreferredLocalisationLanguageTags(['Chinese', 'English']);
		expect(localisationLanguageRank('l_simp_chinese', preferred)).to.equal(0);
		expect(localisationLanguageRank('l_english', preferred)).to.equal(1);
	});

	it('sorts indexed localisation entries using configured language order', () => {
		const entries: LocEntry[] = [
			{ key: 'ship_name', value: 'Ship', file: '/loc/en.yml', line: 2, language: 'l_english', valueHash: 'aaaaaaaa', hasBom: false, encoding: 'utf8', header: 'l_english' },
			{ key: 'ship_name', value: 'ZH Ship', file: '/loc/zh.yml', line: 2, language: 'l_simp_chinese', valueHash: 'bbbbbbbb', hasBom: false, encoding: 'utf8', header: 'l_simp_chinese' },
		];

		const sorted = sortLocalisationEntriesByLanguagePreference(
			entries,
			getPreferredLocalisationLanguageTags(['Chinese', 'English']),
		);

		expect(sorted[0]!.language).to.equal('l_simp_chinese');
		expect(sorted[0]!.value).to.equal('ZH Ship');
	});
});
