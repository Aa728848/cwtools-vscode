import { expect } from 'chai';
import { getAllLanguageIds } from '../../extension/gameProfiles';
import {
	CWT_LANGUAGE_ID,
	determineServerStartMode,
	getLanguageClientDocumentSelector,
	getScriptDocumentSelector,
	isCwtDocument,
	isCwtFilePath,
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

	it('routes the independent cwt language to the language server', () => {
		const languages = getLanguageClientDocumentSelector().map(selector => selector.language);

		expect(languages).to.include(CWT_LANGUAGE_ID);
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

describe('CWT document detection', () => {
	it('recognises .cwt files by path regardless of the resolved language id', () => {
		expect(isCwtFilePath('C:/mods/config/common/buildings.cwt')).to.be.true;
		expect(isCwtFilePath('config/effects.cwt')).to.be.true;
		expect(isCwtFilePath('common/buildings.txt')).to.be.false;
		expect(isCwtDocument({ languageId: 'stellaris', fileName: 'config/effects.cwt' })).to.be.true;
		expect(isCwtDocument({ languageId: CWT_LANGUAGE_ID, fileName: 'config/effects.cwt' })).to.be.true;
		expect(isCwtDocument({ languageId: CWT_LANGUAGE_ID, fileName: 'unusual.extension' })).to.be.true;
		expect(isCwtDocument({ languageId: 'stellaris', fileName: 'common/buildings.txt' })).to.be.false;
	});
});

describe('server start mode determination', () => {
	const base = {
		workspaceRootPath: 'C:/mods/my-mod',
		isVanillaFolder: false,
		hasModDescriptor: false,
		languageId: null,
		activeDocument: undefined,
	};

	it('keeps single-file windows on the full path for backwards compatibility', () => {
		expect(determineServerStartMode({ ...base, workspaceRootPath: undefined })).to.equal('full');
	});

	it('starts full mode for vanilla folders, mod descriptors, and known games', () => {
		expect(determineServerStartMode({ ...base, isVanillaFolder: true })).to.equal('full');
		expect(determineServerStartMode({ ...base, hasModDescriptor: true })).to.equal('full');
		expect(determineServerStartMode({ ...base, languageId: 'stellaris' })).to.equal('full');
	});

	it('does not treat the generic paradox language as a game context', () => {
		expect(determineServerStartMode({ ...base, languageId: 'paradox' })).to.equal('none');
	});

	it('starts CWT-only mode for a .cwt document without game evidence', () => {
		expect(determineServerStartMode({
			...base,
			activeDocument: { languageId: 'cwt', fileName: 'config/effects.cwt' },
		})).to.equal('cwt-only');
		// A legacy workspace association may still resolve .cwt to a game id.
		expect(determineServerStartMode({
			...base,
			activeDocument: { languageId: 'stellaris', fileName: 'config/effects.cwt' },
		})).to.equal('cwt-only');
	});

	it('prefers full mode when a game context exists even if a .cwt file is open', () => {
		expect(determineServerStartMode({
			...base,
			hasModDescriptor: true,
			activeDocument: { languageId: 'cwt', fileName: 'config/effects.cwt' },
		})).to.equal('full');
	});

	it('defers startup when there is no evidence at all', () => {
		expect(determineServerStartMode({
			...base,
			activeDocument: { languageId: 'plaintext', fileName: 'notes.md' },
		})).to.equal('none');
		expect(determineServerStartMode(base)).to.equal('none');
	});
});
