import { getAllLanguageIds, getKnownProfileByLanguageId } from './gameProfiles';

export const LOCALISATION_LANGUAGE_ID = 'stellaris-localisation';
export const CWT_LANGUAGE_ID = 'cwt';

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
		CWT_LANGUAGE_ID,
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

/**
 * True when the path is a CWT rules file, regardless of the language id VS
 * Code resolved. Legacy workspace file associations may still map `*.cwt` to
 * a game id, so startup decisions must key on the extension, not the id.
 */
export function isCwtFilePath(fileName: string): boolean {
	return /\.cwt$/i.test(fileName);
}

/**
 * True when the document is a CWT rules file by id or by path.
 */
export function isCwtDocument(document: { languageId: string; fileName: string }): boolean {
	return document.languageId === CWT_LANGUAGE_ID || isCwtFilePath(document.fileName);
}

/**
 * Server startup mode for the CWTools language server.
 *
 * - `full`: game/mod workspace with a known game context (vanilla folder,
 *   mod descriptor, resolved game language, or a single-file window).
 * - `cwt-only`: a rules repository or an opened `.cwt` file with no game
 *   evidence; the server starts without building a game model.
 * - `none`: no Paradox evidence; defer startup until a qualifying document
 *   becomes active.
 */
export type ServerStartMode = 'full' | 'cwt-only' | 'none';

export interface ServerStartModeInput {
	workspaceRootPath: string | undefined;
	isVanillaFolder: boolean;
	hasModDescriptor: boolean;
	/** The raw resolved language id; only registered game ids count as a
	 *  game context (generic `paradox` is not one). */
	languageId: string | null | undefined;
	activeDocument: { languageId: string; fileName: string } | undefined;
}

/**
 * Pure startup-mode decision. `.cwt` documents are evidence for CWT-only
 * mode but never for a specific game (handoff doc §8.3).
 */
export function determineServerStartMode(input: ServerStartModeInput): ServerStartMode {
	// `!workspaceRootPath` keeps legacy behavior for single-file windows.
	if (!input.workspaceRootPath) return 'full';
	if (input.isVanillaFolder || input.hasModDescriptor) return 'full';
	if (input.languageId && getKnownProfileByLanguageId(input.languageId)) return 'full';
	return input.activeDocument && isCwtDocument(input.activeDocument) ? 'cwt-only' : 'none';
}
