/**
 * Workspace game detection.
 *
 * Pure, vscode-free logic that decides WHETHER a workspace looks like a
 * Paradox project and WHICH game it targets. The Extension Host layer
 * (extension.ts) supplies the workspace root and configured vanilla paths.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAllProfiles, type GameProfile } from './gameProfiles';

/** Looks up the user-configured vanilla data path for a game id. */
export type ConfiguredGamePathLookup = (gameId: string) => string | undefined;

const WORKSPACE_GAME_MARKERS: Record<string, string[]> = {
	stellaris: [
		'common/solar_system_initializers',
		'common/megastructures',
		'common/pop_faction_types',
		'common/starbase_buildings',
		'common/ship_sizes',
		'common/planet_classes',
		'map/star_classes',
	],
	hoi4: [
		'common/national_focus',
		'common/ideas',
		'common/units',
		'history/states',
		'map/strategicregions',
	],
	eu4: [
		'common/countries',
		'common/country_tags',
		'common/governments',
		'common/religions',
		'history/provinces',
		'missions',
	],
	ck2: [
		'common/dynasties',
		'common/landed_titles',
		'common/religions',
		'history/characters',
		'history/titles',
	],
	ck3: [
		'common/dynasties',
		'common/landed_titles',
		'common/culture',
		'common/religion',
		'history/characters',
		'history/titles',
	],
	vic2: [
		'common/countries',
		'history/countries',
		'history/provinces',
		'poptypes',
		'units',
	],
	vic3: [
		'common/country_definitions',
		'common/interest_groups',
		'common/laws',
		'common/production_methods',
		'common/pop_types',
	],
	imperator: [
		'common/cultures',
		'common/religions',
		'common/governments',
		'common/countries',
		'setup/main',
	],
	eu5: [
		'common/countries',
		'common/country_tags',
		'common/governments',
		'common/laws',
		'common/situations',
	],
};

const WORKSPACE_GAME_TEXT_HINTS: Record<string, string[]> = {
	stellaris: ['stellaris', 'solar system', 'megastructure', 'pop faction', 'starbase'],
	hoi4: ['hoi4', 'hearts of iron', 'national focus', 'strategic region'],
	eu4: ['eu4', 'europa universalis iv', 'europa universalis 4'],
	ck2: ['ck2', 'crusader kings ii', 'crusader kings 2'],
	ck3: ['ck3', 'crusader kings iii', 'crusader kings 3'],
	vic2: ['vic2', 'victoria ii', 'victoria 2'],
	vic3: ['vic3', 'victoria 3', 'victoria iii'],
	imperator: ['imperator', 'imperator rome', 'imperator: rome'],
	eu5: ['eu5', 'europa universalis v', 'europa universalis 5'],
};

function normalizeDetectionText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizedPath(value: string): string {
	// Only fold case on Windows (case-insensitive FS); keep case on Linux/macOS (case-sensitive).
	const fold = (s: string) => (os.platform() === 'win32' ? s.toLowerCase() : s);
	try {
		return fold(path.resolve(value));
	} catch {
		return fold(value);
	}
}

function hasRelativePath(rootPath: string, relativePath: string): boolean {
	return fs.existsSync(path.join(rootPath, ...relativePath.split('/')));
}

export function hasWorkspaceModDescriptor(rootPath: string): boolean {
	try {
		for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
			if (entry.isFile() && (entry.name.toLowerCase().endsWith('.mod') || entry.name === 'metadata.json')) {
				return true;
			}
		}
	} catch {
		// Ignore unreadable workspaces
	}
	return false;
}

// Directories that mark a Paradox game/mod content root. Path-name text (e.g.
// "stellaris" in the folder path) is deliberately not enough to start the
// language server.
const PARADOX_CONTENT_DIRS = new Set([
	'common', 'events', 'history', 'map', 'map_data', 'prescripted_countries',
	'localisation', 'localisation_synced', 'localization', 'interface', 'gfx',
]);

export function workspaceHasParadoxStructure(rootPath: string, configuredGamePath: ConfiguredGamePathLookup): boolean {
	try {
		for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
			if (entry.isDirectory() && PARADOX_CONTENT_DIRS.has(entry.name.toLowerCase())) {
				return true;
			}
		}
	} catch {
		// Ignore unreadable workspaces
	}
	for (const profile of getAllProfiles()) {
		const configuredPath = configuredGamePath(profile.id);
		if (!configuredPath) continue;
		const root = normalizedPath(rootPath);
		const configured = normalizedPath(configuredPath);
		if (root === configured || root.startsWith(configured + path.sep) || configured.startsWith(root + path.sep)) {
			return true;
		}
	}
	return false;
}

function readWorkspaceGameDescriptor(rootPath: string): string {
	const chunks: string[] = [];
	const candidates = [
		path.join(rootPath, 'descriptor.mod'),
		path.join(rootPath, '.metadata', 'metadata.json'),
	];
	try {
		for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.toLowerCase().endsWith('.mod')) {
				candidates.push(path.join(rootPath, entry.name));
			}
		}
	} catch {
		// Ignore unreadable workspaces.
	}
	for (const filePath of candidates) {
		try {
			if (fs.existsSync(filePath)) {
				chunks.push(fs.readFileSync(filePath, 'utf8').slice(0, 12000));
			}
		} catch {
			// Ignore unreadable descriptor files.
		}
	}
	return normalizeDetectionText(chunks.join('\n'));
}

export function scoreWorkspaceForGame(rootPath: string, descriptorText: string, profile: GameProfile, configuredPath?: string): number {
	let score = 0;
	const rootText = normalizeDetectionText(rootPath);
	const hints = WORKSPACE_GAME_TEXT_HINTS[profile.id] ?? [];
	const profileTexts = [
		profile.id,
		profile.displayName,
		profile.install.steamFolderName,
		profile.install.exeName,
		...profile.install.alternativeFolderNames,
		...hints,
	].map(normalizeDetectionText).filter(Boolean);

	if (profileTexts.some(hint => rootText.includes(hint))) score += 70;
	if (profileTexts.some(hint => descriptorText.includes(hint))) score += 90;

	if (configuredPath) {
		const root = normalizedPath(rootPath);
		const configured = normalizedPath(configuredPath);
		if (root === configured || root.startsWith(configured + path.sep) || configured.startsWith(root + path.sep)) {
			score += 80;
		}
	}

	for (const marker of WORKSPACE_GAME_MARKERS[profile.id] ?? []) {
		if (hasRelativePath(rootPath, marker)) score += 25;
	}

	return score;
}

const RULE_WORKSPACE_SCAN_IGNORED_DIRS = new Set([
	'.git',
	'.vscode',
	'.vscode-test',
	'.cwtools',
	'.cwtools-ai',
	'node_modules',
	'bin',
	'obj',
	'out',
	'output',
	'release',
	'runs',
	'artifacts',
	'.tmp-test',
]);

function hasAtLeastRuleFiles(folder: string, threshold: number): boolean {
	if (threshold <= 0) return true;
	if (!fs.existsSync(folder)) return false;
	let count = 0;
	const visit = (dir: string): boolean => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (RULE_WORKSPACE_SCAN_IGNORED_DIRS.has(entry.name)) continue;
				if (visit(fullPath)) return true;
			} else {
				const ext = path.extname(entry.name).toLowerCase();
				if ((ext === '.cwt' || ext === '.log') && ++count >= threshold) {
					return true;
				}
			}
		}
		return false;
	};
	return visit(folder);
}

function isCwtRuleWorkspace(rootPath: string): boolean {
	try {
		if (fs.existsSync(path.join(rootPath, 'descriptor.mod'))) {
			return false;
		}
		return hasAtLeastRuleFiles(rootPath, 6);
	} catch {
		return false;
	}
}

/**
 * Infers the game a workspace targets, or undefined when evidence is
 * inconclusive. Structural evidence decides WHETHER this is a Paradox
 * workspace; scoring only decides WHICH game.
 *
 * There is deliberately no "single configured game" fallback: guessing the
 * one game the user happens to have configured mislabels mods for any other
 * game, and downstream flows then write wrong-language settings into the
 * user's project. Inconclusive workspaces fall back to generic 'paradox'
 * handling, which asks the user instead.
 */
export function inferGameIdFromWorkspace(rootPath: string, configuredGamePath: ConfiguredGamePathLookup): string | undefined {
	if (isCwtRuleWorkspace(rootPath)) return undefined;
	if (!hasWorkspaceModDescriptor(rootPath) && !workspaceHasParadoxStructure(rootPath, configuredGamePath)) {
		return undefined;
	}
	const descriptorText = readWorkspaceGameDescriptor(rootPath);
	const scores = getAllProfiles()
		.map(profile => ({ id: profile.id, score: scoreWorkspaceForGame(rootPath, descriptorText, profile, configuredGamePath(profile.id)) }))
		.sort((a, b) => b.score - a.score);
	const best = scores[0];
	const next = scores[1];
	if (best && best.score >= 40 && best.score > (next?.score ?? 0)) {
		return best.id;
	}
	return undefined;
}
