import { expect } from 'chai';
import {
	getPreferredLocalisationLanguageTags,
	localisationLanguageRank,
	sortLocalisationEntriesByLanguagePreference,
} from '../../extension/localisationLanguagePreference';
import type { LocEntry } from '../../extension/indexing/indexService';

describe('localisation language preference', () => {
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
			{ key: 'ship_name', value: 'Ship', file: '/loc/en.yml', line: 2, language: 'l_english' },
			{ key: 'ship_name', value: 'ZH Ship', file: '/loc/zh.yml', line: 2, language: 'l_simp_chinese' },
		];

		const sorted = sortLocalisationEntriesByLanguagePreference(
			entries,
			getPreferredLocalisationLanguageTags(['Chinese', 'English']),
		);

		expect(sorted[0]!.language).to.equal('l_simp_chinese');
		expect(sorted[0]!.value).to.equal('ZH Ship');
	});
});
