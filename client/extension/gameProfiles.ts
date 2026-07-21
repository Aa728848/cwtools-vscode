/**
 * GameProfile Platform Layer
 *
 * Centralises all game-specific configuration into explicit profile objects
 * so that Stellaris remains the first-class path while other Paradox games
 * can be added by registering a single profile entry.
 *
 * Consumers should query profiles through the helper functions at the bottom
 * of this module instead of hard-coding game names or folder structures.
 */



// ─── Sub-profile interfaces ──────────────────────────────────────────────────

/** Localisation file conventions for a specific game. */
export interface LocalisationProfile {
	/** Directory names that contain localisation files (e.g. 'localisation', 'localization'). */
	directories: string[];
	/** File encoding requirement ('utf8-bom' for most Paradox games). */
	encoding: 'utf8-bom' | 'utf8' | 'windows-1252';
	/** The header tag used in localisation files (e.g. 'l_english'). */
	defaultLanguageTag: string;
	/** All supported language tags for this game. */
	supportedLanguageTags: string[];
}

/** Well-known folder structures for a game. */
export interface GameFolderProfile {
	/** Script directories that contain game logic (e.g. 'events', 'common'). */
	scriptDirs: string[];
	/** Directories that contain GUI/interface definitions. */
	guiDirs: string[];
	/** Directories that contain graphics definitions. */
	gfxDirs: string[];
	/** Subdirectory within the Steam install that contains the actual game data (e.g. 'game' for CK3). */
	steamSubdir?: string;
}

/** Preview capabilities available for a game. */
export interface PreviewCapabilityProfile {
	/** Whether GUI preview is supported. */
	guiPreview: boolean;
	/** Whether solar system preview is supported. */
	solarSystemPreview: boolean;
	/** Whether event chain visualisation is supported. */
	eventChainPreview: boolean;
	/** Whether tech tree visualisation is supported. */
	techTreePreview: boolean;
	/** Whether 3D entity preview is supported. */
	entityPreview: boolean;
	/** Whether particle effect preview/editor is supported. */
	particlePreview: boolean;
	/** Whether static galaxy preview/editing (map/setup_scenarios) is supported. */
	staticGalaxyPreview: boolean;
}

/** AI-specific profile data for prompt construction. */
export interface GameAiProfile {
	/** Key into the gameKnowledge module to retrieve the knowledge block. */
	knowledgeKey: string;
}

/** Steam / install detection metadata. */
export interface GameInstallProfile {
	/** The game's folder name under steamapps/common/. */
	steamFolderName: string;
	/** Alternative folder names for cross-platform detection. */
	alternativeFolderNames: string[];
	/** Steam App ID (used for future auto-detection enhancements). */
	steamAppId: string;
	/** The executable file name (without extension) for vanilla-folder detection. */
	exeName: string;
	/** Whether the executable is inside a 'binaries/' subdirectory. */
	exeInBinaries: boolean;
}

// ─── Main profile interface ──────────────────────────────────────────────────

export interface GameProfile {
	/** Unique identifier matching the VS Code language ID (e.g. 'stellaris'). */
	id: string;
	/** Human-readable display name. */
	displayName: string;
	/** VS Code language ID used for document association. */
	languageId: string;
	/** File extensions associated with this game. */
	fileExtensions: string[];
	/** Configuration key for the vanilla cache path (e.g. 'stellarisLanguageServices.cache.stellaris'). */
	cacheSettingKey: string;
	/** GitHub URL for the CWTools config rules repository. */
	rulesRemoteUrl: string;
	/** Localisation conventions. */
	localisation: LocalisationProfile;
	/** Folder structure conventions. */
	folders: GameFolderProfile;
	/** Preview feature availability. */
	previews: PreviewCapabilityProfile;
	/** AI prompt knowledge configuration. */
	ai: GameAiProfile;
	/** Installation / Steam detection metadata. */
	install: GameInstallProfile;
}

// ─── Shared constants ────────────────────────────────────────────────────────

const COMMON_SCRIPT_DIRS = ['events', 'common'];
const COMMON_GUI_DIRS = ['interface', 'gfx'];
const COMMON_GFX_DIRS = ['gfx'];

const STELLARIS_LOC_LANGS = [
	'l_english', 'l_french', 'l_german', 'l_spanish', 'l_russian',
	'l_braz_por', 'l_polish', 'l_simp_chinese', 'l_korean', 'l_japanese', 'l_turkish',
];

const STANDARD_LOC_PROFILE: LocalisationProfile = {
	directories: ['localisation', 'localisation_synced'],
	encoding: 'utf8-bom',
	defaultLanguageTag: 'l_english',
	supportedLanguageTags: STELLARIS_LOC_LANGS,
};

const MODERN_LOC_PROFILE: LocalisationProfile = {
	directories: ['localization'],
	encoding: 'utf8-bom',
	defaultLanguageTag: 'l_english',
	supportedLanguageTags: STELLARIS_LOC_LANGS,
};

const NO_PREVIEWS: PreviewCapabilityProfile = {
	guiPreview: false,
	solarSystemPreview: false,
	eventChainPreview: false,
	techTreePreview: false,
	entityPreview: false,
	particlePreview: false,
	staticGalaxyPreview: false,
};

// ─── Profile registry ────────────────────────────────────────────────────────

const PROFILES: Map<string, GameProfile> = new Map();

function registerProfile(profile: GameProfile): void {
	PROFILES.set(profile.id, profile);
}

// ── Stellaris (canonical, complete) ──────────────────────────────────────────

registerProfile({
	id: 'stellaris',
	displayName: 'Stellaris',
	languageId: 'stellaris',
	fileExtensions: ['txt', 'gui', 'gfx', 'asset', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.stellaris',
	rulesRemoteUrl: 'https://github.com/Aa728848/cwtools-stellaris-config',
	localisation: {
		...STANDARD_LOC_PROFILE,
		directories: ['localisation', 'localisation_synced'],
	},
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS, 'map', 'map_data', 'prescripted_countries', 'flags', 'decisions'],
		guiDirs: COMMON_GUI_DIRS,
		gfxDirs: COMMON_GFX_DIRS,
	},
	previews: {
		guiPreview: true,
		solarSystemPreview: true,
		eventChainPreview: true,
		techTreePreview: true,
		entityPreview: true,
		particlePreview: true,
		staticGalaxyPreview: true,
	},
	ai: { knowledgeKey: 'stellaris' },
	install: {
		steamFolderName: 'Stellaris',
		alternativeFolderNames: [],
		steamAppId: '281990',
		exeName: 'stellaris',
		exeInBinaries: false,
	},
});

// ── HOI4 ─────────────────────────────────────────────────────────────────────

registerProfile({
	id: 'hoi4',
	displayName: 'Hearts of Iron IV',
	languageId: 'hoi4',
	fileExtensions: ['txt', 'gui', 'gfx', 'asset', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.hoi4',
	rulesRemoteUrl: 'https://github.com/cwtools/cwtools-hoi4-config',
	localisation: STANDARD_LOC_PROFILE,
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS, 'map', 'history', 'decisions', 'missions'],
		guiDirs: COMMON_GUI_DIRS,
		gfxDirs: COMMON_GFX_DIRS,
	},
	previews: NO_PREVIEWS,
	ai: { knowledgeKey: 'hoi4' },
	install: {
		steamFolderName: 'Hearts of Iron IV',
		alternativeFolderNames: [],
		steamAppId: '394360',
		exeName: 'hoi4',
		exeInBinaries: false,
	},
});

// ── EU4 ──────────────────────────────────────────────────────────────────────

registerProfile({
	id: 'eu4',
	displayName: 'Europa Universalis IV',
	languageId: 'eu4',
	fileExtensions: ['txt', 'gui', 'gfx', 'asset', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.eu4',
	rulesRemoteUrl: 'https://github.com/cwtools/cwtools-eu4-config',
	localisation: STANDARD_LOC_PROFILE,
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS, 'decisions', 'missions', 'history'],
		guiDirs: COMMON_GUI_DIRS,
		gfxDirs: COMMON_GFX_DIRS,
	},
	previews: NO_PREVIEWS,
	ai: { knowledgeKey: 'eu4' },
	install: {
		steamFolderName: 'Europa Universalis IV',
		alternativeFolderNames: [],
		steamAppId: '236850',
		exeName: 'eu4',
		exeInBinaries: false,
	},
});

// ── CK2 ──────────────────────────────────────────────────────────────────────

registerProfile({
	id: 'ck2',
	displayName: 'Crusader Kings II',
	languageId: 'ck2',
	fileExtensions: ['txt', 'gui', 'gfx', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.ck2',
	rulesRemoteUrl: 'https://github.com/cwtools/cwtools-ck2-config',
	localisation: {
		directories: ['localisation'],
		encoding: 'utf8-bom',
		defaultLanguageTag: 'l_english',
		supportedLanguageTags: STELLARIS_LOC_LANGS,
	},
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS, 'decisions', 'history'],
		guiDirs: COMMON_GUI_DIRS,
		gfxDirs: COMMON_GFX_DIRS,
	},
	previews: NO_PREVIEWS,
	ai: { knowledgeKey: 'ck2' },
	install: {
		steamFolderName: 'Crusader Kings II',
		alternativeFolderNames: [],
		steamAppId: '203770',
		exeName: 'CK2',
		exeInBinaries: false,
	},
});

// ── CK3 ──────────────────────────────────────────────────────────────────────

registerProfile({
	id: 'ck3',
	displayName: 'Crusader Kings III',
	languageId: 'ck3',
	fileExtensions: ['txt', 'gui', 'gfx', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.ck3',
	rulesRemoteUrl: 'https://github.com/cwtools/cwtools-ck3-config',
	localisation: MODERN_LOC_PROFILE,
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS, 'history'],
		guiDirs: ['gui'],
		gfxDirs: ['gfx'],
		steamSubdir: 'game',
	},
	previews: NO_PREVIEWS,
	ai: { knowledgeKey: 'ck3' },
	install: {
		steamFolderName: 'Crusader Kings III',
		alternativeFolderNames: [],
		steamAppId: '1158310',
		exeName: 'ck3',
		exeInBinaries: true,
	},
});

// ── VIC2 ─────────────────────────────────────────────────────────────────────

registerProfile({
	id: 'vic2',
	displayName: 'Victoria II',
	languageId: 'vic2',
	fileExtensions: ['txt', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.vic2',
	rulesRemoteUrl: 'https://github.com/cwtools/cwtools-vic2-config',
	localisation: {
		directories: ['localisation'],
		encoding: 'windows-1252',
		defaultLanguageTag: 'l_english',
		supportedLanguageTags: ['l_english'],
	},
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS, 'decisions', 'history'],
		guiDirs: COMMON_GUI_DIRS,
		gfxDirs: COMMON_GFX_DIRS,
	},
	previews: NO_PREVIEWS,
	ai: { knowledgeKey: 'vic2' },
	install: {
		steamFolderName: 'Victoria 2',
		alternativeFolderNames: ['Victoria II'],
		steamAppId: '42960',
		exeName: 'v2game',
		exeInBinaries: false,
	},
});

// ── VIC3 ─────────────────────────────────────────────────────────────────────

registerProfile({
	id: 'vic3',
	displayName: 'Victoria 3',
	languageId: 'vic3',
	fileExtensions: ['txt', 'gui', 'gfx', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.vic3',
	rulesRemoteUrl: 'https://github.com/cwtools/cwtools-vic3-config',
	localisation: MODERN_LOC_PROFILE,
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS],
		guiDirs: ['gui'],
		gfxDirs: ['gfx'],
		steamSubdir: 'game',
	},
	previews: NO_PREVIEWS,
	ai: { knowledgeKey: 'vic3' },
	install: {
		steamFolderName: 'Victoria 3',
		alternativeFolderNames: [],
		steamAppId: '529340',
		exeName: 'victoria3',
		exeInBinaries: true,
	},
});

// ── Imperator ────────────────────────────────────────────────────────────────

registerProfile({
	id: 'imperator',
	displayName: 'Imperator: Rome',
	languageId: 'imperator',
	fileExtensions: ['txt', 'gui', 'gfx', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.imperator',
	rulesRemoteUrl: 'https://github.com/cwtools/cwtools-ir-config',
	localisation: MODERN_LOC_PROFILE,
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS, 'decisions'],
		guiDirs: COMMON_GUI_DIRS,
		gfxDirs: COMMON_GFX_DIRS,
		steamSubdir: 'game',
	},
	previews: NO_PREVIEWS,
	ai: { knowledgeKey: 'imperator' },
	install: {
		steamFolderName: 'ImperatorRome',
		alternativeFolderNames: ['Imperator'],
		steamAppId: '859580',
		exeName: 'imperator',
		exeInBinaries: true,
	},
});

// ── EU5 ──────────────────────────────────────────────────────────────────────

registerProfile({
	id: 'eu5',
	displayName: 'Europa Universalis V',
	languageId: 'eu5',
	fileExtensions: ['txt', 'gui', 'gfx', 'cwt'],
	cacheSettingKey: 'stellarisLanguageServices.cache.eu5',
	rulesRemoteUrl: 'https://github.com/kaiser-chris/cwtools-eu5-config',
	localisation: MODERN_LOC_PROFILE,
	folders: {
		scriptDirs: [...COMMON_SCRIPT_DIRS],
		guiDirs: ['gui'],
		gfxDirs: ['gfx'],
		steamSubdir: 'game',
	},
	previews: NO_PREVIEWS,
	ai: { knowledgeKey: 'eu5' },
	install: {
		steamFolderName: 'Europa Universalis V',
		alternativeFolderNames: [],
		steamAppId: '0',
		exeName: 'eu5',
		exeInBinaries: true,
	},
});

// ─── Query helpers ───────────────────────────────────────────────────────────

/**
 * Returns the profile for a given language ID.
 * Falls back to Stellaris if no matching profile is found.
 */
export function getProfileByLanguageId(languageId: string): GameProfile {
	return PROFILES.get(languageId) ?? PROFILES.get('stellaris')!;
}

/**
 * Returns the profile for a given language ID, or undefined for generic/custom modes.
 */
export function getKnownProfileByLanguageId(languageId?: string | null): GameProfile | undefined {
	return languageId ? PROFILES.get(languageId) : undefined;
}

/**
 * Returns the profile matching a document's language ID.
 * Accepts any object with a languageId property.
 * Falls back to Stellaris if no matching profile is found.
 */
export function getProfileForDocument(document: { languageId: string }): GameProfile {
	return getProfileByLanguageId(document.languageId);
}



/**
 * Returns the default profile (Stellaris).
 */
export function getDefaultProfile(): GameProfile {
	return PROFILES.get('stellaris')!;
}

/**
 * Returns all registered profiles.
 */
export function getAllProfiles(): GameProfile[] {
	return Array.from(PROFILES.values());
}

/**
 * Returns all localisation directory names across registered profiles.
 * Consumers should use this when watching/scanning localisation files instead
 * of hard-coding localisation/localization spellings.
 */
export function getAllLocalisationDirectoryNames(): string[] {
	const names = new Set<string>();
	for (const profile of PROFILES.values()) {
		for (const dir of profile.localisation.directories) {
			names.add(dir);
		}
	}
	return Array.from(names);
}

/**
 * Builds a VS Code glob fragment for all known localisation directories.
 */
export function getLocalisationDirectoryGlob(): string {
	const names = getAllLocalisationDirectoryNames();
	return names.length === 1 ? names[0]! : `{${names.join(',')}}`;
}

/**
 * Returns all registered language IDs (game IDs).
 */
export function getAllLanguageIds(): string[] {
	return Array.from(PROFILES.keys());
}

/**
 * Returns the rules remote URL for a given language ID.
 * This replaces the scattered switch statements in extension.ts.
 */
export function getRulesRemoteUrl(languageId: string): string {
	return getKnownProfileByLanguageId(languageId)?.rulesRemoteUrl ?? '';
}

/**
 * Returns the cache setting key (without 'cwtools.' prefix) for a given language ID.
 * E.g. 'cache.stellaris'.
 */
export function getCacheSettingKey(languageId: string): string {
	const profile = getProfileByLanguageId(languageId);
	// Strip the namespace prefix for use with getConfiguration('stellarisLanguageServices')
	return profile.cacheSettingKey.replace('stellarisLanguageServices.', '');
}

const VANILLA_CACHE_FILE_NAMES: Readonly<Record<string, string>> = {
	stellaris: 'stl.cwb',
	hoi4: 'hoi4.cwb',
	eu4: 'eu4.cwb',
	eu5: 'eu5.cwb',
	ck2: 'ck2.cwb',
	ck3: 'ck3.cwb',
	imperator: 'ir.cwb',
	vic2: 'vic2.cwb',
	vic3: 'vic3.cwb',
};

/** Serialized vanilla cache file written beside the per-game rules folders. */
export function getVanillaCacheFileName(languageId: string): string | undefined {
	return VANILLA_CACHE_FILE_NAMES[languageId.toLowerCase()];
}

/** Resolve a serialized vanilla cache file back to its game language ID. */
export function getGameIdForVanillaCacheFile(fileName: string): string | undefined {
	const normalized = fileName.toLowerCase();
	return Object.entries(VANILLA_CACHE_FILE_NAMES)
		.find(([, candidate]) => candidate === normalized)?.[0];
}

/**
 * Returns the install detection metadata for a given language ID.
 */
export function getInstallProfile(languageId: string): GameInstallProfile {
	return getProfileByLanguageId(languageId).install;
}

/**
 * Checks whether a specific preview capability is available for a game.
 */
export function isPreviewAvailable(languageId: string, capability: keyof PreviewCapabilityProfile): boolean {
	return getProfileByLanguageId(languageId).previews[capability];
}

/**
 * Build the gameInfoMap used by promptVanillaPath notification handler.
 * This replaces the inline Record<string, ...> in extension.ts.
 */
export function getGameInfoMap(): Record<string, { display: string; steamFolder: string; subdir?: string; steamAppId: string }> {
	const result: Record<string, { display: string; steamFolder: string; subdir?: string; steamAppId: string }> = {};
	for (const profile of PROFILES.values()) {
		result[profile.id] = {
			display: profile.displayName,
			steamFolder: profile.install.steamFolderName,
			subdir: profile.folders.steamSubdir,
			steamAppId: profile.install.steamAppId,
		};
	}
	return result;
}

/**
 * Build the game executable detection list used by the activate function.
 * This replaces the inline games array in extension.ts.
 */
export function getGameExeList(): Array<{ id: string; exeName: string; binariesPrefix: boolean }> {
	return getAllProfiles().map(p => ({
		id: p.id,
		exeName: p.install.exeName,
		binariesPrefix: p.install.exeInBinaries,
	}));
}

/**
 * Build the game folder name → language ID mapping used by the manual
 * folder-selection flow in extension.ts. Also includes information about
 * whether the selected folder needs a subdirectory appended.
 */
export function getGameFolderMapping(): Map<string, { languageId: string; subdir?: string }> {
	const map = new Map<string, { languageId: string; subdir?: string }>();
	for (const profile of PROFILES.values()) {
		map.set(profile.install.steamFolderName, {
			languageId: profile.id,
			subdir: profile.folders.steamSubdir,
		});
		for (const alt of profile.install.alternativeFolderNames) {
			map.set(alt, {
				languageId: profile.id,
				subdir: profile.folders.steamSubdir,
			});
		}
	}
	return map;
}

/**
 * Returns alternative Steam folder names for a given folder name.
 * This replaces the hard-coded getAlternativeFolderNames function in extension.ts.
 */
export function getAlternativeSteamFolderNames(steamFolderName: string): string[] {
	for (const profile of PROFILES.values()) {
		if (profile.install.steamFolderName === steamFolderName) {
			return profile.install.alternativeFolderNames;
		}
		if (profile.install.alternativeFolderNames.includes(steamFolderName)) {
			// Return the primary name plus other alternatives, excluding the queried name
			const others = profile.install.alternativeFolderNames.filter(n => n !== steamFolderName);
			return [profile.install.steamFolderName, ...others];
		}
	}
	return [];
}
