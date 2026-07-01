import type { LocEntry } from './indexing/indexService';

const LANGUAGE_SETTING_TO_TAG: Record<string, string> = {
	english: 'l_english',
	french: 'l_french',
	german: 'l_german',
	spanish: 'l_spanish',
	russian: 'l_russian',
	braz_por: 'l_braz_por',
	brazilian_portuguese: 'l_braz_por',
	polish: 'l_polish',
	chinese: 'l_simp_chinese',
	simp_chinese: 'l_simp_chinese',
	korean: 'l_korean',
	japanese: 'l_japanese',
	turkish: 'l_turkish',
};

export const DEFAULT_LOCALISATION_LANGUAGE_TAGS = ['l_english'];

export interface LocalisationLanguageEntry {
	language?: string;
	key?: string;
	file?: string;
	line?: number;
}

export function normaliseLocalisationLanguageTag(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;

	const normalized = raw.toLowerCase().replace(/[-\s]+/g, '_');
	const mapped = LANGUAGE_SETTING_TO_TAG[normalized];
	if (mapped) return mapped;

	if (normalized.startsWith('l_')) return normalized;
	if (/^[a-z][a-z0-9_]*$/.test(normalized)) return `l_${normalized}`;
	return undefined;
}

export function getPreferredLocalisationLanguageTags(
	configuredLanguages: readonly string[] | undefined,
): string[] {
	const tags: string[] = [];
	const seen = new Set<string>();

	for (const language of configuredLanguages ?? []) {
		const tag = normaliseLocalisationLanguageTag(language);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		tags.push(tag);
	}

	return tags.length > 0 ? tags : [...DEFAULT_LOCALISATION_LANGUAGE_TAGS];
}

export function localisationLanguageRank(
	language: string | undefined,
	preferredTags: readonly string[],
): number {
	const tag = normaliseLocalisationLanguageTag(language);
	if (!tag) return Number.MAX_SAFE_INTEGER;
	const rank = preferredTags.indexOf(tag);
	return rank >= 0 ? rank : Number.MAX_SAFE_INTEGER;
}

export function compareLocalisationLanguagePreference(
	a: LocalisationLanguageEntry,
	b: LocalisationLanguageEntry,
	preferredTags: readonly string[],
): number {
	const languageDelta = localisationLanguageRank(a.language, preferredTags)
		- localisationLanguageRank(b.language, preferredTags);
	if (languageDelta !== 0) return languageDelta;

	const aLanguage = normaliseLocalisationLanguageTag(a.language) ?? '';
	const bLanguage = normaliseLocalisationLanguageTag(b.language) ?? '';
	if (aLanguage !== bLanguage) return aLanguage.localeCompare(bLanguage);

	const aKey = a.key ?? '';
	const bKey = b.key ?? '';
	if (aKey !== bKey) return aKey.localeCompare(bKey);

	const aFile = a.file ?? '';
	const bFile = b.file ?? '';
	if (aFile !== bFile) return aFile.localeCompare(bFile);

	return (a.line ?? 0) - (b.line ?? 0);
}

export function sortLocalisationEntriesByLanguagePreference<T extends LocalisationLanguageEntry>(
	entries: readonly T[],
	preferredTags: readonly string[],
): T[] {
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => {
			const languageDelta = localisationLanguageRank(a.entry.language, preferredTags)
				- localisationLanguageRank(b.entry.language, preferredTags);
			if (languageDelta !== 0) return languageDelta;

			const aLanguage = normaliseLocalisationLanguageTag(a.entry.language) ?? '';
			const bLanguage = normaliseLocalisationLanguageTag(b.entry.language) ?? '';
			return aLanguage.localeCompare(bLanguage) || a.index - b.index;
		})
		.map(item => item.entry);
}

export function pickPreferredLocalisationEntry<T extends LocEntry>(
	entries: readonly T[],
	preferredTags: readonly string[],
): T | undefined {
	return sortLocalisationEntriesByLanguagePreference(entries, preferredTags)[0];
}
