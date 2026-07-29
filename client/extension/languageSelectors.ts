import { getAllLanguageIds } from './gameProfiles';

export const LOCALISATION_LANGUAGE_ID = 'stellaris-localisation';

export interface FileLanguageSelector {
	scheme: 'file';
	language: string;
}

function fileLanguageSelectors(languageIds: readonly string[]): FileLanguageSelector[] {
	return Array.from(new Set(languageIds))
		.map(language => ({ scheme: 'file' as const, language }));
}

/** Languages whose documents are handled by the CWTools language server. */
export function getLanguageClientDocumentSelector(): FileLanguageSelector[] {
	return fileLanguageSelectors([
		'paradox',
		'yaml',
		LOCALISATION_LANGUAGE_ID,
		...getAllLanguageIds(),
		'pdx-shader',
	]);
}

/** Script languages that can contain references to localisation keys. */
export function getScriptDocumentSelector(): FileLanguageSelector[] {
	return fileLanguageSelectors([
		'paradox',
		...getAllLanguageIds(),
	]);
}

/**
 * Localisation/YAML documents use their TextMate grammar plus rich-text
 * decorations. PDX semantic tokens would classify the flat YAML as script and
 * override those colours.
 */
export function shouldRequestLanguageServerSemanticTokens(
	document: { languageId: string; fileName: string },
): boolean {
	return document.languageId !== LOCALISATION_LANGUAGE_ID
		&& !/\.ya?ml$/i.test(document.fileName);
}
