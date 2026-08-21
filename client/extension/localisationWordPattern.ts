import { LOCALISATION_LANGUAGE_ID } from './languageSelectors';

export const LOCALISATION_WORD_PATTERN_SOURCE =
	"\\u00a7[A-Za-z0-9!%-]?|\\u00a3|\\$?[^\\s\\u00a7\\u00a3$\\\"'\\[\\]{}(),;!?=<>#]+\\$?";

export const LOCALISATION_WORD_PATTERN_LANGUAGE_IDS = [LOCALISATION_LANGUAGE_ID] as const;

export function createLocalisationWordPattern(): RegExp {
	return new RegExp(LOCALISATION_WORD_PATTERN_SOURCE);
}
