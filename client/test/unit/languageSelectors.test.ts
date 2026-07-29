import { expect } from 'chai';
import { getAllLanguageIds } from '../../extension/gameProfiles';
import {
	getLanguageClientDocumentSelector,
	getScriptDocumentSelector,
	LOCALISATION_LANGUAGE_ID,
	shouldRequestLanguageServerSemanticTokens,
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

	it('leaves localisation colours to the TextMate grammar and rich-text decorations', () => {
		expect(shouldRequestLanguageServerSemanticTokens({
			languageId: LOCALISATION_LANGUAGE_ID,
			fileName: 'localisation/simp_chinese/events_l_simp_chinese.yml',
		})).to.be.false;
		expect(shouldRequestLanguageServerSemanticTokens({
			languageId: 'yaml',
			fileName: 'localisation/english/events_l_english.yml',
		})).to.be.false;
		expect(shouldRequestLanguageServerSemanticTokens({
			languageId: 'stellaris',
			fileName: 'common/component_templates/components.txt',
		})).to.be.true;
	});
});
