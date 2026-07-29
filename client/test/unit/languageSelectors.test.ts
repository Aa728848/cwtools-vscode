import { expect } from 'chai';
import { getAllLanguageIds } from '../../extension/gameProfiles';
import {
	getLanguageClientDocumentSelector,
	getScriptDocumentSelector,
	LOCALISATION_LANGUAGE_ID,
} from '../../extension/languageSelectors';

describe('language selectors', () => {
	it('routes the shared localisation language and every registered game to the language server', () => {
		const languages = getLanguageClientDocumentSelector().map(selector => selector.language);

		expect(languages).to.include(LOCALISATION_LANGUAGE_ID);
		expect(languages).to.include.members(getAllLanguageIds());
		expect(new Set(languages).size).to.equal(languages.length);
	});

	it('enables localisation references for every registered game script language', () => {
		const languages = getScriptDocumentSelector().map(selector => selector.language);

		expect(languages).to.include('paradox');
		expect(languages).to.include.members(getAllLanguageIds());
		expect(new Set(languages).size).to.equal(languages.length);
	});
});
