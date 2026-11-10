/**
 * Workspace game detection.
 *
 * Pure, vscode-free evidence classification. Structural evidence decides WHETHER
 * a workspace is supported; scoring only decides WHICH game it targets. The
 * MCP generator publishes this file and its profile adapter to cwtools-shared.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseWorkshopContentAppId } from './workshopDetection';
import { getWorkspaceDetectionProfiles } from './workspaceDetectionProfiles';

/** Looks up the user-configured vanilla data path for a game id. */
export type ConfiguredGamePathLookup = (gameId: string) => string | undefined;

export interface WorkspaceDetectionProfile {
	id: string;
	displayName: string;
	steamFolderName: string;
	exeName: string;
	alternativeFolderNames: string[];
	steamAppId: string;
}

export type WorkspaceProjectKind = 'mod' | 'vanilla' | 'cwt-only' | 'unsupported' | 'ambiguous';
export type WorkspaceEvidenceStrength = 'strong' | 'composite' | 'none';

export interface WorkspaceProjectDetection {
	kind: WorkspaceProjectKind;
	gameId?: string;
	matchedAt?: string;
	evidence: string[];
	candidates?: string[];
	strength: WorkspaceEvidenceStrength;
	reason: string;
}

const WORKSPACE_GAME_MARKERS: Record<string, string[]> = {
	stellaris: [
		'common/solar_system_initializers', 'common/megastructures', 'common/pop_faction_types',
		'common/starbase_buildings', 'common/ship_sizes', 'common/planet_classes', 'map/star_classes',
	],
	hoi4: ['common/national_focus', 'common/ideas', 'common/units', 'history/states', 'map/strategicregions'],
	eu4: ['common/countries', 'common/country_tags', 'common/governments', 'common/religions', 'history/provinces', 'missions'],
	ck2: ['common/dynasties', 'common/landed_titles', 'common/religions', 'history/characters', 'history/titles'],
	ck3: ['common/dynasties', 'common/landed_titles', 'common/culture', 'common/religion', 'history/characters', 'history/titles'],
	vic2: ['common/countries', 'history/countries', 'history/provinces', 'poptypes', 'units'],
	vic3: ['common/country_definitions', 'common/interest_groups', 'common/laws', 'common/production_methods', 'common/pop_types'],
	imperator: ['common/cultures', 'common/religions', 'common/governments', 'common/countries', 'setup/main'],
	eu5: ['common/countries', 'common/country_tags', 'common/governments', 'common/laws', 'common/situations'],
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

const PARADOX_CONTENT_DIRS = new Set([
	'common', 'events', 'history', 'map', 'map_data', 'prescripted_countries',
	'localisation', 'localisation_synced', 'localization', 'interface', 'gfx',
]);
const PDX_PAYLOAD_EXTENSIONS = new Set(['.txt', '.yml', '.yaml', '.csv', '.gui', '.gfx', '.asset']);
const SCAN_IGNORED_DIRS = new Set([
	'.git', '.vscode', '.vscode-test', '.cwtools', '.cwtools-ai', 'node_modules',
	'bin', 'obj', 'out', 'output', 'release', 'runs', 'artifacts', '.tmp-test',
]);
const MAX_ANCESTORS = 6;
const MAX_CHILDREN = 64;
const MAX_PAYLOAD_ENTRIES = 64;
const MAX_DESCRIPTOR_CHARS = 12000;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const MAX_RULE_SCAN_ENTRIES = 5000;

function normalizeDetectionText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizedPath(value: string): string {
	const fold = (s: string) => os.platform() === 'win32' ? s.toLowerCase() : s;
	try {
		return fold(path.resolve(value));
	} catch {
		return fold(value);
	}
}

function sameOrInside(candidate: string, parent: string): boolean {
	const resolved = normalizedPath(candidate);
	const root = normalizedPath(parent);
	return resolved === root || resolved.startsWith(root + path.sep);
}

function isFile(filePath: string): boolean {
	try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function isDirectory(dirPath: string): boolean {
	try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

function hasRelativeDirectory(rootPath: string, relativePath: string): boolean {
	return isDirectory(path.join(rootPath, ...relativePath.split('/')));
}

function readEntries(dirPath: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

function unsupported(rootPath: string, reason = `No reliable Paradox/CWT evidence at '${rootPath}'.`): WorkspaceProjectDetection {
	return { kind: 'unsupported', evidence: [], strength: 'none', reason };
}

function supported(
	kind: 'mod' | 'vanilla' | 'cwt-only',
	rootPath: string,
	evidence: string[],
	strength: 'strong' | 'composite',
	gameId?: string,
): WorkspaceProjectDetection {
	return {
		kind,
		matchedAt: rootPath,
		evidence,
		strength,
		reason: evidence.join('; '),
		...(gameId ? { gameId } : {}),
	};
}

function descriptorEvidence(rootPath: string): string | undefined {
	const canonical = path.join(rootPath, 'descriptor.mod');
	if (isFile(canonical)) return 'descriptor.mod';
	for (const entry of readEntries(rootPath)) {
		if (!entry.isFile() || entry.name === 'descriptor.mod' || !entry.name.toLowerCase().endsWith('.mod')) continue;
		try {
			const content = fs.readFileSync(path.join(rootPath, entry.name), 'utf8').slice(0, MAX_DESCRIPTOR_CHARS);
			const hasName = /^name\s*=/m.test(content);
			const hasRootOrVersion = /^(path|supported_version)\s*=/m.test(content);
			if (hasName && hasRootOrVersion) return `${entry.name} (parsed descriptor fields)`;
		} catch {
			// An unreadable non-standard descriptor is not evidence.
		}
	}
	return undefined;
}

export function hasWorkspaceModDescriptor(rootPath: string): boolean {
	return descriptorEvidence(rootPath) !== undefined;
}

function readWorkspaceGameDescriptor(rootPath: string): string {
	const chunks: string[] = [];
	const candidates = [path.join(rootPath, 'descriptor.mod'), path.join(rootPath, '.metadata', 'metadata.json')];
	for (const entry of readEntries(rootPath)) {
		if (entry.isFile() && entry.name.toLowerCase().endsWith('.mod')) candidates.push(path.join(rootPath, entry.name));
	}
	for (const filePath of candidates) {
		try {
			if (isFile(filePath)) chunks.push(fs.readFileSync(filePath, 'utf8').slice(0, MAX_DESCRIPTOR_CHARS));
		} catch {
			// Ignore unreadable descriptor files.
		}
	}
	return normalizeDetectionText(chunks.join('\n'));
}

function validProjectProfileGame(rootPath: string): string | undefined {
	const profilePath = path.join(rootPath, '.cwtools', 'project', 'profile.json');
	try {
		if (!isFile(profilePath) || fs.statSync(profilePath).size > MAX_PROFILE_BYTES) return undefined;
		const raw: unknown = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
		const profile = raw as Record<string, unknown>;
		const game = typeof profile.game === 'object' && profile.game !== null && !Array.isArray(profile.game)
			? profile.game as Record<string, unknown>
			: undefined;
		const gameId = typeof game?.id === 'string' ? game.id : '';
		const known = gameId === 'paradox' || getWorkspaceDetectionProfiles().some(profileEntry => profileEntry.id === gameId);
		const workspaceKind = profile.workspaceKind;
		if (profile.schemaVersion !== 4
			|| (workspaceKind !== 'paradox_mod' && workspaceKind !== 'mixed')
			|| typeof profile.workspaceRoot !== 'string'
			|| normalizedPath(profile.workspaceRoot) !== normalizedPath(rootPath)
			|| !known) return undefined;
		return gameId;
	} catch {
		return undefined;
	}
}

function hasUsableNestedMetadata(rootPath: string): boolean {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(path.join(rootPath, '.metadata', 'metadata.json'), 'utf8'));
		return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
	} catch {
		return false;
	}
}

function contentEvidence(rootPath: string): { directories: string[]; payload?: string } {
	const directories = readEntries(rootPath)
		.filter(entry => entry.isDirectory() && PARADOX_CONTENT_DIRS.has(entry.name.toLowerCase()))
		.map(entry => entry.name);
	let payload: string | undefined;
	for (const directory of directories) {
		const result = findPdxPayload(path.join(rootPath, directory), directory, 0);
		if (result) {
			payload = result;
			break;
		}
	}
	return { directories, ...(payload ? { payload } : {}) };
}

function findPdxPayload(dirPath: string, relative: string, depth: number): string | undefined {
	let visited = 0;
	for (const entry of readEntries(dirPath)) {
		if (visited++ >= MAX_PAYLOAD_ENTRIES) break;
		if (entry.isDirectory()) {
			if (depth < 2 && !SCAN_IGNORED_DIRS.has(entry.name)) {
				const found = findPdxPayload(path.join(dirPath, entry.name), `${relative}/${entry.name}`, depth + 1);
				if (found) return found;
			}
		} else if (entry.isFile() && PDX_PAYLOAD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
			return `${relative}/${entry.name}`;
		}
	}
	return undefined;
}

function isCwtRuleWorkspace(rootPath: string): boolean {
	if (descriptorEvidence(rootPath)) return false;
	let count = 0;
	let cwtCount = 0;
	let visited = 0;
	const visit = (dirPath: string): boolean => {
		for (const entry of readEntries(dirPath)) {
			if (visited++ >= MAX_RULE_SCAN_ENTRIES) return false;
			if (entry.isDirectory()) {
				if (!SCAN_IGNORED_DIRS.has(entry.name) && visit(path.join(dirPath, entry.name))) return true;
			} else if (entry.isFile()) {
				const extension = path.extname(entry.name).toLowerCase();
				if (extension === '.cwt') cwtCount++;
				if ((extension === '.cwt' || extension === '.log')) count++;
				if (count >= 6 && cwtCount >= 1) return true;
			}
		}
		return false;
	};
	return visit(rootPath);
}

function vanillaEvidence(rootPath: string, configuredGamePath: ConfiguredGamePathLookup): { gameId?: string; evidence?: string } {
	const matches = getWorkspaceDetectionProfiles()
		.map(profile => ({ profile, configured: configuredGamePath(profile.id) }))
		.filter(item => item.configured
			&& isDirectory(path.join(item.configured, 'common'))
			&& sameOrInside(rootPath, item.configured))
		.map(item => ({ id: item.profile.id, configured: item.configured! }));
	if (matches.length === 0) return {};
	return {
		gameId: matches.length === 1 ? matches[0]!.id : undefined,
		evidence: `workspace is equal to or inside configured game data path: ${matches.map(item => item.configured).join(', ')}`,
	};
}

function markerEvidence(rootPath: string): string[] {
	const found: string[] = [];
	for (const profile of getWorkspaceDetectionProfiles()) {
		for (const marker of WORKSPACE_GAME_MARKERS[profile.id] ?? []) {
			if (hasRelativeDirectory(rootPath, marker)) found.push(`${profile.id}:${marker}`);
		}
	}
	return found;
}

function scoreWorkspaceForGame(
	rootPath: string,
	descriptorText: string,
	profile: WorkspaceDetectionProfile,
	configuredPath?: string,
): number {
	let score = 0;
	const rootText = normalizeDetectionText(rootPath);
	const profileTexts = [
		profile.id, profile.displayName, profile.steamFolderName, profile.exeName,
		...profile.alternativeFolderNames, ...(WORKSPACE_GAME_TEXT_HINTS[profile.id] ?? []),
	].map(normalizeDetectionText).filter(Boolean);
	if (profileTexts.some(hint => rootText.includes(hint))) score += 70;
	if (profileTexts.some(hint => descriptorText.includes(hint))) score += 90;
	if (configuredPath && sameOrInside(rootPath, configuredPath)) score += 80;
	for (const marker of WORKSPACE_GAME_MARKERS[profile.id] ?? []) {
		if (hasRelativeDirectory(rootPath, marker)) score += 25;
	}
	return score;
}

function inferSupportedGame(rootPath: string, configuredGamePath: ConfiguredGamePathLookup): string | undefined {
	const descriptorText = readWorkspaceGameDescriptor(rootPath);
	const scores = getWorkspaceDetectionProfiles()
		.map(profile => ({
			id: profile.id,
			score: scoreWorkspaceForGame(rootPath, descriptorText, profile, configuredGamePath(profile.id)),
		}))
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	const best = scores[0];
	const next = scores[1];
	return best && best.score >= 40 && best.score > (next?.score ?? 0) ? best.id : undefined;
}

/** Classify only this exact root; no ancestor or child can change its identity. */
export function classifyWorkspaceRoot(
	rootPath: string,
	configuredGamePath: ConfiguredGamePathLookup,
	options?: { allowCwt?: boolean },
): WorkspaceProjectDetection {
	const profiles = getWorkspaceDetectionProfiles();
	const workshopAppId = parseWorkshopContentAppId(rootPath);
	if (workshopAppId) {
		const game = profiles.find(profile => profile.steamAppId === workshopAppId);
		if (game && workshopAppId !== '0') {
			return supported('mod', rootPath, [`Steam Workshop App ID ${workshopAppId}`], 'strong', game.id);
		}
	}
	const vanilla = vanillaEvidence(rootPath, configuredGamePath);
	if (vanilla.evidence) return supported('vanilla', rootPath, [vanilla.evidence], 'strong', vanilla.gameId);
	const profileGame = validProjectProfileGame(rootPath);
	if (profileGame) return supported('mod', rootPath, ['valid .cwtools/project/profile.json'], 'strong', profileGame);
	const descriptor = descriptorEvidence(rootPath);
	if (descriptor) return supported('mod', rootPath, [descriptor], 'strong', inferSupportedGame(rootPath, configuredGamePath));
	if (options?.allowCwt !== false && isCwtRuleWorkspace(rootPath)) {
		return supported('cwt-only', rootPath, ['bounded CWT rule cluster (at least six rule/log files and one .cwt)'], 'strong');
	}
	const markers = markerEvidence(rootPath);
	if (markers.length > 0) return supported('mod', rootPath, markers, 'strong', inferSupportedGame(rootPath, configuredGamePath));
	const content = contentEvidence(rootPath);
	if (content.payload && content.directories.length >= 2) {
		return supported('mod', rootPath, [`content directories: ${content.directories.join(', ')}`, `PDX payload: ${content.payload}`], 'composite', inferSupportedGame(rootPath, configuredGamePath));
	}
	if (content.payload && content.directories.length === 1 && hasUsableNestedMetadata(rootPath)) {
		return supported('mod', rootPath, [`.metadata/metadata.json plus ${content.directories[0]!}`, `PDX payload: ${content.payload}`], 'composite', inferSupportedGame(rootPath, configuredGamePath));
	}
	return unsupported(rootPath);
}

/** Resolve a root, a strong ancestor, or exactly one matching immediate child. */
export function detectWorkspaceProject(rootPath: string, configuredGamePath: ConfiguredGamePathLookup): WorkspaceProjectDetection {
	const atRoot = classifyWorkspaceRoot(rootPath, configuredGamePath);
	if (atRoot.kind !== 'unsupported') return atRoot;
	let ancestor = rootPath;
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		const parent = path.dirname(ancestor);
		if (!parent || parent === ancestor) break;
		ancestor = parent;
		const match = classifyWorkspaceRoot(ancestor, configuredGamePath, { allowCwt: false });
		// Recursive CWT clustering at an ancestor would scan unrelated sibling trees.
		// Only non-recursive mod/vanilla markers are safe ancestor evidence.
		if ((match.kind === 'mod' || match.kind === 'vanilla') && match.strength === 'strong') return match;
	}
	const children = readEntries(rootPath)
		.filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
		.slice(0, MAX_CHILDREN)
		.map(entry => classifyWorkspaceRoot(path.join(rootPath, entry.name), configuredGamePath))
		.filter(result => result.kind !== 'unsupported');
	if (children.length === 1) return children[0]!;
	if (children.length > 1) {
		const candidates = children.map(result => result.matchedAt!).sort((a, b) => a.localeCompare(b));
		return {
			kind: 'ambiguous',
			evidence: children.flatMap(result => result.evidence),
			candidates,
			strength: 'none',
			reason: `Multiple Paradox/CWT projects found; pass --workspace explicitly: ${candidates.join(', ')}`,
		};
	}
	return unsupported(rootPath, `No reliable Paradox/CWT evidence at, above, or directly under '${rootPath}'.`);
}

/** True only for game/mod evidence; CWT-only deliberately does not select a game. */
export function workspaceHasParadoxStructure(rootPath: string, configuredGamePath: ConfiguredGamePathLookup): boolean {
	const result = classifyWorkspaceRoot(rootPath, configuredGamePath);
	return result.kind === 'mod' || result.kind === 'vanilla';
}

/** Infer the game only after structural support has been established. */
export function inferGameIdFromWorkspace(rootPath: string, configuredGamePath: ConfiguredGamePathLookup): string | undefined {
	const result = classifyWorkspaceRoot(rootPath, configuredGamePath);
	return result.kind === 'mod' || result.kind === 'vanilla' ? result.gameId : undefined;
}
