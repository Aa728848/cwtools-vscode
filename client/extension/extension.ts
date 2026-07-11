/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vs from 'vscode';
import { workspace, ExtensionContext, window, Disposable, Uri, WorkspaceEdit, TextEdit, Range, commands } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, NotificationType, RevealOutputChannelOn } from 'vscode-languageclient/node';

import { FileExplorer, FileListItem } from './fileExplorer';
import { GuiPanel } from './guiPanel';
import { EntityPanel } from './entityPanel';
import { ParticlePanel } from './particlePanel';
import { classifyAssetFile } from './particleSniff';
import { UI, SOURCE, aiText, setAiMessageLocale } from './ai/messages';
import { ErrorReporter } from './ai/errorReporter';
import { SolarSystemPanel } from './solarSystemPanel';
import { EventChainPanel } from './eventChainPanel';
import { TechTreePanel } from './techTreePanel';
import * as exe from './executable';
import { registerLocalizationFeatures } from './locDecorations';
import { AIService, AgentToolExecutor, AgentRunner, PromptBuilder, AIChatPanelProvider, AIInlineCompletionProvider, UsageTracker } from './ai';
import { lastAISettingsWriteTime } from './ai/chatSettings';
import { checkForUpdates } from './updateChecker';
import { registerCodeActions } from './codeActions';
import { enrichDiagnosticsInPlace, diagnosticCodeString, diagnosticMatchesIgnoredKey } from './diagnosticI18n';
import { isImagePathLinkText, registerGraphicsFeatures } from './graphicsFeatures';
import { registerVanillaCompare } from './vanillaCompare';
import { registerPdxIndentFormatter } from './pdxIndentFormatter';
import { registerTexturePreviewEditor } from './texturePreviewEditor';
import { registerParadoxCsvFeatures } from './paradoxCsvFeatures';
import { registerRelatedResourceFeatures } from './relatedResources';
import { registerRulesConfigGroupCommands } from './rulesConfigGroups';
import { registerImageTools } from './imageTools';
import { registerLocalisationAiCommands } from './localisationAiCommands';
import { registerTranslationPreviewCommands } from './translationPreview';
import { registerSpecialPathCommands } from './specialPaths';
import { registerInspectionOverviewCommand } from './inspectionOverview';
import { configurePrivateAgentStorage, getProjectWorkspaceRoot, getPrivateAiStorageRoot, migrateLegacyPrivateAgentState } from './ai/workspacePaths';
import { configureHistoryPolicy, enforceHistoryRetention } from './ai/runner/historyPolicy';
import { sha256Text } from './ai/runner/durableStorage';
import { processRegistry } from './ai/runner/processRegistry';
import { getAllLanguageIds, getAllProfiles, getCacheSettingKey, getKnownProfileByLanguageId, getProfileByLanguageId, getRulesRemoteUrl, getGameExeList, getGameFolderMapping, getAlternativeSteamFolderNames } from './gameProfiles';
import type { GameProfile } from './gameProfiles';
import { IndexService, type WorkspaceSymbolEntry } from './indexing/indexService';
import { McpBridgeServer } from './ai/mcpBridgeServer';
import { maybePromptForDefaultDarkModernTheme } from './themePrompt';
import { registerProjectKnowledgeWatcher } from './ai/projectKnowledge';
import { QuickPickSelectionGuard } from './quickPickSelectionGuard';

export let defaultClient: LanguageClient;
let fileList: FileListItem[];
let fileExplorer: FileExplorer;

const CONFLICTING_EXTENSION_IDS = [
	'foreverskywalker.eddy-stellaris-cwt',
	'ForeverSkywalker.eddy-stellaris-cwt',
	'Eddy.eddy-stellaris-cwt',
	'tboby.cwtools-vscode',
];
const LEGACY_GLOBAL_STORAGE_IDS = [
	'foreverskywalker.eddy-stellaris-cwt',
	'eddy.eddy-stellaris-cwt',
];
const PUBLISHER_MIGRATION_MARKER = '.storage-migration-from-legacy-extension-ids.done';
const LEGACY_GLOBAL_STORAGE_ENTRIES = [
	'.cwtools',
	'.agents',
	'ai-chat-topics.json',
] as const;
const AUTO_DETECTED_LOC_LANGUAGE_KEY = 'stellarisLanguageServices.localisation.languages.autoDetected';

interface AutoDetectedLocLanguageState {
	languages: string[];
	disabled?: boolean;
}

function legacyPublisherStoragePaths(context: ExtensionContext): string[] {
	const currentStorage = context.globalStorageUri.fsPath;
	const currentParent = path.dirname(currentStorage);
	const currentResolved = path.resolve(currentStorage).toLowerCase();
	return LEGACY_GLOBAL_STORAGE_IDS
		.map(legacyId => path.join(currentParent, legacyId))
		.filter(legacyStorage => path.resolve(legacyStorage).toLowerCase() !== currentResolved);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function copyMissingStorageEntries(source: string, target: string): Promise<void> {
	const stat = await fs.promises.lstat(source);
	if (stat.isSymbolicLink()) {
		return;
	}

	if (stat.isDirectory()) {
		await fs.promises.mkdir(target, { recursive: true });
		const entries = await fs.promises.readdir(source, { withFileTypes: true });
		for (const entry of entries) {
			await copyMissingStorageEntries(
				path.join(source, entry.name),
				path.join(target, entry.name)
			);
		}
		return;
	}

	if (!stat.isFile() || await pathExists(target)) {
		return;
	}

	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	await fs.promises.copyFile(source, target);
}

async function migrateLegacyPublisherGlobalStorage(context: ExtensionContext): Promise<void> {
	const currentStorage = context.globalStorageUri.fsPath;
	const markerPath = path.join(currentStorage, PUBLISHER_MIGRATION_MARKER);
	if (await pathExists(markerPath)) {
		return;
	}

	const copied: string[] = [];

	for (const legacyStorage of legacyPublisherStoragePaths(context)) {
		if (!(await pathExists(legacyStorage))) {
			continue;
		}

		await fs.promises.mkdir(currentStorage, { recursive: true });
		for (const entry of LEGACY_GLOBAL_STORAGE_ENTRIES) {
			const source = path.join(legacyStorage, entry);
			if (!(await pathExists(source))) {
				continue;
			}
			await copyMissingStorageEntries(source, path.join(currentStorage, entry));
			copied.push(entry);
		}
	}

	if (copied.length > 0) {
		await fs.promises.writeFile(
			markerPath,
			JSON.stringify({ migratedAt: new Date().toISOString(), copied: Array.from(new Set(copied)) }, null, 2),
			'utf-8'
		);
		ErrorReporter.debug('Extension', `Migrated legacy publisher globalStorage entries: ${Array.from(new Set(copied)).join(', ')}`);
	}
}

/**
 * Remove extensions that would start a competing CWTools language server.
 * VSIX manifests have no supported way to declare mutually exclusive extensions,
 * so UI/Marketplace installs need this activation-time fallback. Returning false
 * keeps this extension dormant until the window is reloaded.
 */
async function removeConflictingExtensions(): Promise<boolean> {
	const conflictingExtensionId = CONFLICTING_EXTENSION_IDS.find(extensionId => vs.extensions.getExtension(extensionId));
	if (!conflictingExtensionId) {
		return true;
	}

	try {
		await commands.executeCommand(
			'workbench.extensions.uninstallExtension',
			conflictingExtensionId
		);

		const reloadAction = localize('Reload Window', '重新加载窗口');
		const choice = await window.showInformationMessage(
			localize(
				`The conflicting CWTools extension (${conflictingExtensionId}) was uninstalled. Reload the window to finish switching to Stellaris Language Serves.`,
				`已自动卸载冲突的 CWTools 插件 (${conflictingExtensionId})。请重新加载窗口以完成切换。`
			),
			reloadAction
		);
		if (choice === reloadAction) {
			await commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (error) {
		await window.showErrorMessage(
			localize(
				`Could not uninstall ${conflictingExtensionId}. This extension will stay inactive to avoid starting two CWTools servers. Uninstall the conflicting extension manually and reload the window.`,
				`无法卸载 ${conflictingExtensionId}。为避免同时启动两个 CWTools 服务，当前插件本次不会启动。请手动卸载冲突插件并重新加载窗口。`
			)
		);
		ErrorReporter.warn('Extension', `Failed to remove conflicting extension ${conflictingExtensionId}`, error);
	}

	return false;
}

const registeredCommands = new Map<string, Disposable>();
function safeRegisterCommand(context: ExtensionContext, commandId: string, handler: (...args: any[]) => any): void {
	const existing = registeredCommands.get(commandId);
	if (existing) {
		try { existing.dispose(); } catch { /* ignore */ }
	}
	const disposable = commands.registerCommand(commandId, handler);
	registeredCommands.set(commandId, disposable);
	context.subscriptions.push(disposable);
}

type RulesSourceName = 'Manual' | 'Remote' | 'Bundled' | 'Missing';

interface RulesSourceStatus {
	source: RulesSourceName;
	path?: string;
	fileCount: number;
}

interface InstallHealthOptions {
	context: ExtensionContext;
	languageId: string;
	cacheDir: string;
	bundledRulesPath: string;
	rulesRemoteUrl: string;
	serverExe: string;
	isVanillaFolder: boolean;
	clientStarted: boolean;
}

let setupPanel: vs.WebviewPanel | undefined;

function isChineseLocale(): boolean {
	return vs.env.language.toLowerCase().startsWith('zh');
}

function localize(en: string, zh: string): string {
	return isChineseLocale() ? zh : en;
}

function rulesSourceLabel(source: RulesSourceName): string {
	if (!isChineseLocale()) return source;
	switch (source) {
		case 'Manual': return '手动';
		case 'Remote': return '远程';
		case 'Bundled': return '内置';
		case 'Missing': return '缺失';
	}
}

function getConfiguredRulesRemoteUrl(languageId: string): string {
	const config = workspace.getConfiguration('stellarisLanguageServices');
	const customUrl = config.get<string>('rules_remote_url', '')?.trim();
	return customUrl || getRulesRemoteUrl(languageId);
}

function isKnownGameLanguageId(languageId?: string | null): languageId is string {
	return !!languageId && getKnownProfileByLanguageId(languageId) !== undefined;
}

function displayGameName(languageId: string): string {
	return getKnownProfileByLanguageId(languageId)?.displayName ?? localize('Paradox Script', 'Paradox 脚本');
}

function countRuleFiles(folder?: string): number {
	if (!folder) return 0;
	// ZIP archive: file exists and has .zip extension
	if (folder.endsWith('.zip')) {
		return fs.existsSync(folder) ? 100 : 0; // Estimate; exact count is not needed for health display
	}
	if (!fs.existsSync(folder)) return 0;
	let count = 0;
	const visit = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
			} else {
				const ext = path.extname(entry.name).toLowerCase();
				if (ext === '.cwt' || ext === '.log') count++;
			}
		}
	};
	visit(folder);
	return count;
}

const RULE_WORKSPACE_SCAN_IGNORED_DIRS = new Set([
	'.git',
	'.vscode',
	'.vscode-test',
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

function firstWorkspacePath(): string | undefined {
	return workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function indexedWorkspaceSymbolKind(entry: WorkspaceSymbolEntry): vs.SymbolKind {
	switch (entry.kind.toLowerCase()) {
		case 'sprite':
		case 'spritetype':
		case 'texture':
		case 'asset':
			return vs.SymbolKind.Object;
		case 'gui':
		case 'windowtype':
		case 'containertype':
		case 'buttontype':
		case 'icontype':
			return vs.SymbolKind.Interface;
		case 'namespace':
			return vs.SymbolKind.Namespace;
		case 'event':
			return vs.SymbolKind.Event;
		case 'trigger':
			return vs.SymbolKind.Function;
		case 'effect':
			return vs.SymbolKind.Method;
		case 'modifier':
			return vs.SymbolKind.Property;
		default:
			return entry.source === 'gui' ? vs.SymbolKind.Interface : vs.SymbolKind.Object;
	}
}

function workspaceSymbolScore(entry: WorkspaceSymbolEntry, query: string): number {
	if (!query) return 0;
	const name = entry.name.toLowerCase();
	const kind = entry.kind.toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	if (kind === query) return 2;
	if (kind.startsWith(query)) return 3;
	if (name.includes(query)) return 4;
	return 5;
}

function registerIndexedWorkspaceSymbols(context: ExtensionContext, indexService: IndexService): void {
	context.subscriptions.push(
		vs.languages.registerWorkspaceSymbolProvider({
			async provideWorkspaceSymbols(query, token) {
				await indexService.ensureWorkspaceSymbolsReady({ includeVanilla: false });
				if (token.isCancellationRequested) return [];

				const normalizedQuery = query.trim();
				const queryLower = normalizedQuery.toLowerCase();
				const entries = [
					...indexService.queryWorkspaceSymbols({ name: normalizedQuery, source: 'asset', origin: 'workspace', limit: 120 }),
					...indexService.queryWorkspaceSymbols({ name: normalizedQuery, source: 'gui', origin: 'workspace', limit: 120 }),
				];
				const seen = new Set<string>();
				const unique = entries
					.filter(entry => {
						const key = `${entry.file}:${entry.line}:${entry.name}:${entry.kind}`;
						if (seen.has(key)) return false;
						seen.add(key);
						return true;
					})
					.sort((a, b) =>
						workspaceSymbolScore(a, queryLower) - workspaceSymbolScore(b, queryLower)
						|| a.name.localeCompare(b.name)
						|| a.file.localeCompare(b.file)
					)
					.slice(0, 200);

				return unique.map(entry => {
					const line = Math.max(0, entry.line - 1);
					const location = new vs.Location(vs.Uri.file(entry.file), new vs.Range(line, 0, line, 0));
					const container = entry.container ? `${entry.container} / ${entry.kind}` : entry.kind;
					return new vs.SymbolInformation(entry.name, indexedWorkspaceSymbolKind(entry), container, location);
				});
			}
		})
	);
}

function resolveBundledRulesPath(context: ExtensionContext, languageId: string): string {
	// Packaged ZIP archive (preferred in production)
	const packagedZip = context.asAbsolutePath(path.join('rules', `${languageId}-rules.zip`));
	if (fs.existsSync(packagedZip)) return packagedZip;
	// Legacy: packaged folder
	const packagedPath = context.asAbsolutePath(path.join('rules', languageId, 'config'));
	if (fs.existsSync(packagedPath)) return packagedPath;
	// Dev mode: submodule folder
	if (languageId === 'stellaris') {
		const devPath = context.asAbsolutePath(path.join('submodules', 'cwtools-stellaris-config', 'config'));
		if (fs.existsSync(devPath)) return devPath;
	}
	return packagedZip;
}

function getConfiguredGamePath(languageId: string): string | undefined {
	if (!isKnownGameLanguageId(languageId)) return undefined;
	const key = getCacheSettingKey(languageId);
	const value = workspace.getConfiguration('stellarisLanguageServices').get<string>(key, '')?.trim();
	return value || undefined;
}

function isValidGameDataPath(candidate?: string): boolean {
	return !!candidate && fs.existsSync(path.join(candidate, 'common'));
}

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

function hasWorkspaceModDescriptor(rootPath: string): boolean {
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

function workspaceHasParadoxStructure(rootPath: string): boolean {
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
		const configuredPath = getConfiguredGamePath(profile.id);
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

function scoreWorkspaceForGame(rootPath: string, descriptorText: string, profile: GameProfile): number {
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

	const configuredPath = getConfiguredGamePath(profile.id);
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

function inferLanguageIdFromWorkspace(): string | undefined {
	const rootPath = firstWorkspacePath();
	if (!rootPath) return undefined;
	if (isCwtRuleWorkspace(rootPath)) return undefined;
	// Structural evidence decides WHETHER this is a Paradox workspace; scoring
	// below only decides WHICH game.
	if (!hasWorkspaceModDescriptor(rootPath) && !workspaceHasParadoxStructure(rootPath)) {
		return undefined;
	}
	const descriptorText = readWorkspaceGameDescriptor(rootPath);
	const scores = getAllProfiles()
		.map(profile => ({ id: profile.id, score: scoreWorkspaceForGame(rootPath, descriptorText, profile) }))
		.sort((a, b) => b.score - a.score);
	const best = scores[0];
	const next = scores[1];
	if (best && best.score >= 40 && best.score > (next?.score ?? 0)) {
		return best.id;
	}

	const configuredProfiles = getAllProfiles()
		.filter(profile => isValidGameDataPath(getConfiguredGamePath(profile.id)));
	return configuredProfiles.length === 1 ? configuredProfiles[0]!.id : undefined;
}

function getRulesSourceStatus(languageId: string, cacheDir: string, _bundledRulesPath: string): RulesSourceStatus {
	const config = workspace.getConfiguration('stellarisLanguageServices');
	const rulesVersion = config.get<string>('rules_version', 'latest');
	const manualRulesFolder = config.get<string>('rules_folder', '')?.trim();
	if (rulesVersion === 'manual') {
		const fileCount = countRuleFiles(manualRulesFolder);
		if (fileCount > 0) return { source: 'Manual', path: manualRulesFolder, fileCount };
		return { source: 'Missing', path: manualRulesFolder || undefined, fileCount: 0 };
	}

	const cachedRulesPath = path.join(cacheDir, languageId);
	const cachedCount = countRuleFiles(cachedRulesPath);
	if (cachedCount > 0) return { source: 'Remote', path: cachedRulesPath, fileCount: cachedCount };

	return { source: 'Missing', fileCount: 0 };
}

function resolveSelectedGameFolder(selectedPath: string, preferredLanguageId?: string): { languageId: string; dataPath: string } | undefined {
	if (preferredLanguageId && isValidGameDataPath(selectedPath)) {
		return { languageId: preferredLanguageId, dataPath: selectedPath };
	}

	const folderMapping = getGameFolderMapping();
	const mappedGame = folderMapping.get(path.basename(selectedPath));
	if (mappedGame) {
		const dataPath = mappedGame.subdir ? path.join(selectedPath, mappedGame.subdir) : selectedPath;
		if (isValidGameDataPath(dataPath)) {
			return { languageId: mappedGame.languageId, dataPath };
		}
	}

	if (preferredLanguageId) {
		const profile = getProfileByLanguageId(preferredLanguageId);
		const dataPath = profile.folders.steamSubdir ? path.join(selectedPath, profile.folders.steamSubdir) : selectedPath;
		if (isValidGameDataPath(dataPath)) {
			return { languageId: preferredLanguageId, dataPath };
		}
	}

	for (const profile of getAllProfiles()) {
		const dataPath = profile.folders.steamSubdir ? path.join(selectedPath, profile.folders.steamSubdir) : selectedPath;
		if (isValidGameDataPath(dataPath)) {
			return { languageId: profile.id, dataPath };
		}
	}

	return undefined;
}

async function selectGameFolderFlow(languageHint?: string): Promise<boolean> {
	let languageId = languageHint && getAllLanguageIds().includes(languageHint) ? languageHint : undefined;
	if (!languageId) {
		const picked = await window.showQuickPick(
			getAllProfiles().map(profile => ({ label: profile.displayName, description: profile.id, id: profile.id })),
			{ placeHolder: localize('Select the game this workspace targets', '选择此工作区对应的游戏') }
		);
		if (!picked) return false;
		languageId = picked.id;
	}

	const profile = getProfileByLanguageId(languageId);
	const detectedPath = await autoDetectGamePath(profile.install.steamFolderName, profile.folders.steamSubdir);
	let selectedPath: string | undefined;
	if (detectedPath) {
		const choice = await window.showQuickPick(
			[
				{ label: localize(`Use detected ${profile.displayName} folder`, `使用检测到的 ${profile.displayName} 目录`), description: detectedPath, value: 'detected' },
				{ label: localize('Browse for another folder...', '浏览其它目录...'), description: localize('Choose the vanilla game data folder manually', '手动选择原版游戏数据目录'), value: 'browse' },
			],
			{ placeHolder: localize(`${profile.displayName} installation detected`, `已检测到 ${profile.displayName} 安装目录`) }
		);
		if (!choice) return false;
		if (choice.value === 'detected') selectedPath = detectedPath;
	}

	if (!selectedPath) {
		const uri = await window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: localize(`Select ${profile.displayName} vanilla folder`, `选择 ${profile.displayName} 原版目录`),
			title: localize(`Select ${profile.displayName} vanilla installation folder`, `选择 ${profile.displayName} 原版安装目录`),
		});
		if (!uri?.[0]) return false;
		const resolved = resolveSelectedGameFolder(uri[0].fsPath, languageId);
		if (!resolved) {
			const retry = await window.showErrorMessage(
				localize(
					`The selected folder does not look like a supported ${profile.displayName} game data folder. Pick the folder that contains "common".`,
					`所选目录不像可用的 ${profile.displayName} 游戏数据目录。请选择包含 "common" 文件夹的目录。`
				),
				localize('Choose Again', '重新选择')
			);
			if (retry === localize('Choose Again', '重新选择')) return selectGameFolderFlow(languageId);
			return false;
		}
		languageId = resolved.languageId;
		selectedPath = resolved.dataPath;
	}

	const finalProfile = getProfileByLanguageId(languageId);
	await workspace.getConfiguration('stellarisLanguageServices').update(getCacheSettingKey(languageId), selectedPath, true);

	// ── Automatically set workspace-level file associations to enable language themes/validation ──
	if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
		const filesConfig = workspace.getConfiguration('files');
		const associations = filesConfig.get<Record<string, string>>('associations') || {};
		const updatedAssociations = { ...associations };
		const extensionsToAssociate = ['*.txt', '*.gui', '*.gfx', '*.asset'];
		let updated = false;
		for (const ext of extensionsToAssociate) {
			if (updatedAssociations[ext] !== languageId) {
				updatedAssociations[ext] = languageId;
				updated = true;
			}
		}
		if (updated) {
			await filesConfig.update('associations', updatedAssociations, false);
		}
	}

	await reloadExtension(
		localize(
			`${finalProfile.displayName} folder saved. Reload CWTools to build the vanilla cache now?`,
			`${finalProfile.displayName} 目录已保存。现在重新加载 CWTools 以生成原版缓存吗？`
		),
		localize('Reload', '重新加载')
	);
	return true;
}

function buildInstallHealth(options: InstallHealthOptions) {
	const profile = getKnownProfileByLanguageId(options.languageId);
	const profileDisplayName = profile?.displayName ?? displayGameName(options.languageId);
	const configuredGamePath = getConfiguredGamePath(options.languageId);
	const rules = getRulesSourceStatus(options.languageId, options.cacheDir, options.bundledRulesPath);
	const source = rulesSourceLabel(rules.source);
	const workspacePath = firstWorkspacePath();
	const hasMod = workspacePath ? hasWorkspaceModDescriptor(workspacePath) : false;
	const checks = [
		{
			name: localize('Language server', '语言服务'),
			ok: fs.existsSync(options.serverExe) && options.clientStarted,
			detail: fs.existsSync(options.serverExe)
				? localize('Server binary found and client started.', '已找到服务端程序，语言客户端已启动。')
				: localize(`Missing server binary: ${options.serverExe}`, `缺少服务端程序：${options.serverExe}`),
			action: undefined as string | undefined,
		},
		{
			name: localize('Validation rules', '校验规则'),
			ok: rules.source !== 'Missing',
			detail: rules.source === 'Missing'
				? localize(
					'No active CWTools rules were found. latest/stable need a remote rules cache; bundled fallback is only used after a failed remote update when it is newer than the cache. manual needs a local rules folder.',
					'未找到当前可用的 CWTools 规则。latest/stable 需要远程规则缓存；内置备用规则只会在远程更新失败且比缓存更新时使用。manual 需要本地规则目录。'
				)
				: localize(
					`${source} rules: ${rules.fileCount} files${rules.path ? ` at ${rules.path}` : ''}.`,
					`${source}规则：${rules.fileCount} 个文件${rules.path ? `，位置：${rules.path}` : ''}。`
				),
			action: rules.source === 'Missing'
				? localize('Reinstall the VSIX or run the package script again.', '请重新安装 VSIX，或重新运行打包脚本。')
				: undefined,
		},
		{
			name: localize('Rules repository', '规则仓库'),
			ok: !!options.rulesRemoteUrl || rules.source !== 'Missing',
			detail: options.rulesRemoteUrl
				? localize(`Remote rules: ${options.rulesRemoteUrl}`, `远程规则：${options.rulesRemoteUrl}`)
				: localize('No remote rules repository is configured for the detected game type.', '当前识别的游戏类型没有配置远程规则仓库。'),
			action: options.rulesRemoteUrl
				? undefined
				: localize(
					'Select the target game folder or switch to manual and choose a local rules folder.',
					'请选择目标游戏目录，或切换到 manual 并选择本地规则目录。'
				),
		},
		profile
			? {
				name: localize('Vanilla game folder', '游戏目录'),
				ok: options.isVanillaFolder || isValidGameDataPath(configuredGamePath),
				detail: options.isVanillaFolder
					? localize('Current workspace looks like a vanilla game folder.', '当前工作区看起来是游戏目录。')
					: configuredGamePath
						? localize(`Configured path: ${configuredGamePath}`, `已配置路径：${configuredGamePath}`)
						: localize(`${profile.displayName} vanilla folder is not configured.`, `尚未配置 ${profile.displayName} 游戏目录。`),
				action: options.isVanillaFolder ? undefined : localize('Use Select Game Folder to configure it.', '使用“选择游戏目录”进行配置。'),
			}
			: {
				name: localize('Game type', '游戏类型'),
				ok: false,
				detail: hasMod
					? localize('Detected a Mod descriptor (.mod) in workspace, but the target game could not be determined automatically.', '在工作区中检测到了 Mod 描述文件 (.mod)，但无法自动确定目标游戏类型。')
					: localize('Workspace game type was not detected.', '未识别工作区游戏类型。'),
				action: hasMod
					? localize('Click Select Game Folder below to choose the target game.', '请点击下方的“选择游戏目录”来显式指定此 Mod 对应的游戏。')
					: localize('Open a game-specific file or use Select Game Folder to choose the target game.', '请打开具体游戏的脚本文件，或使用“选择游戏目录”指定目标游戏。'),
			},
		{
			name: localize('Workspace', '工作区'),
			ok: !!workspacePath,
			detail: workspacePath ? localize(`Workspace: ${workspacePath}`, `工作区：${workspacePath}`) : localize('No folder is open.', '当前未打开文件夹。'),
			action: workspacePath ? undefined : localize('Open the mod folder with File > Open Folder.', '请通过“文件 > 打开文件夹”打开 Mod 目录。'),
		},
	];
	return { profileDisplayName, rules, checks };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderSetupHtml(options: InstallHealthOptions): string {
	const health = buildInstallHealth(options);
	const source = rulesSourceLabel(health.rules.source);
	const okText = localize('OK', '正常');
	const needsSetupText = localize('Needs setup', '需要配置');
	const rows = health.checks.map(check => `
		<tr>
			<td class="status ${check.ok ? 'ok' : 'warn'}">${check.ok ? okText : needsSetupText}</td>
			<td class="check-name">${escapeHtml(check.name)}</td>
			<td class="check-detail">${escapeHtml(check.detail)}${check.action ? `<div class="hint">${escapeHtml(check.action)}</div>` : ''}</td>
		</tr>
	`).join('');
	const rulesPath = health.rules.path ? `<p class="muted">${escapeHtml(health.rules.path)}</p>` : '';
	const title = localize('CWTools Setup', 'CWTools 安装配置');
	return `<!DOCTYPE html>
	<html lang="${isChineseLocale() ? 'zh-CN' : 'en'}">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${escapeHtml(title)}</title>
		<style>
			body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
			main { max-width: 880px; margin: 0 auto; padding: 28px 24px 40px; }
			h1 { font-size: 24px; font-weight: 600; margin: 0 0 8px; }
			h2 { font-size: 15px; font-weight: 600; margin: 28px 0 10px; }
			p { line-height: 1.5; margin: 0 0 12px; }
			.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 22px; }
			button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 7px 12px; border-radius: 3px; cursor: pointer; }
			button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
			.health-table { overflow-x: auto; }
			table { width: 100%; min-width: 620px; border-collapse: collapse; border: 1px solid var(--vscode-panel-border); table-layout: fixed; }
			td { border-top: 1px solid var(--vscode-panel-border); padding: 10px 12px; vertical-align: top; }
			tr:first-child td { border-top: 0; }
			.status { width: 64px; }
			.check-name { width: 150px; white-space: nowrap; }
			.check-detail { overflow-wrap: anywhere; word-break: break-word; }
			.ok { color: var(--vscode-testing-iconPassed); font-weight: 600; white-space: nowrap; }
			.warn { color: var(--vscode-testing-iconQueued); font-weight: 600; white-space: nowrap; }
			.muted, .hint { color: var(--vscode-descriptionForeground); }
			.hint { margin-top: 4px; }
			.summary { border-left: 3px solid var(--vscode-focusBorder); padding-left: 12px; margin-top: 18px; }
		</style>
	</head>
	<body>
		<main>
			<h1>${escapeHtml(title)}</h1>
			<p class="muted">${escapeHtml(localize(`${health.profileDisplayName} workspace health and first-run configuration.`, `${health.profileDisplayName} 工作区健康状态与首次运行配置。`))}</p>
			<div class="summary">
				<p><strong>${escapeHtml(localize('Rules source:', '规则来源：'))}</strong> ${escapeHtml(source)} (${escapeHtml(localize(`${health.rules.fileCount} files`, `${health.rules.fileCount} 个文件`))})</p>
				${rulesPath}
			</div>
			<div class="toolbar">
				<button data-command="selectGameFolder">${escapeHtml(localize('Select Game Folder', '选择游戏目录'))}</button>
				<button class="secondary" data-command="rules">${escapeHtml(localize('Manage Rules', '管理规则'))}</button>
				<button class="secondary" data-command="paths">${escapeHtml(localize('Local Paths', '本地路径'))}</button>
				<button class="secondary" data-command="copyPath">${escapeHtml(localize('Copy Path', '复制路径'))}</button>
				<button class="secondary" data-command="inspection">${escapeHtml(localize('Inspection Overview', '检查概览'))}</button>
				<button class="secondary" data-command="imageMagick">${escapeHtml(localize('Check ImageMagick', '检查 ImageMagick'))}</button>
				<button class="secondary" data-command="reload">${escapeHtml(localize('Reload CWTools', '重新加载 CWTools'))}</button>
				<button class="secondary" data-command="settings">${escapeHtml(localize('Open Settings', '打开设置'))}</button>
				<button class="secondary" data-command="refresh">${escapeHtml(localize('Refresh', '刷新'))}</button>
			</div>
			<h2>${escapeHtml(localize('Installation Health', '安装健康检查'))}</h2>
			<div class="health-table"><table>${rows}</table></div>
		</main>
		<script>
			const vscode = acquireVsCodeApi();
			document.querySelectorAll('button[data-command]').forEach(button => {
				button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
			});
		</script>
	</body>
	</html>`;
}

async function showSetupPanel(options: InstallHealthOptions): Promise<void> {
	if (setupPanel) {
		setupPanel.dispose();
	}
	setupPanel = window.createWebviewPanel('cwtoolsSetup', localize('CWTools Setup', 'CWTools 安装配置'), vs.ViewColumn.One, { enableScripts: true });
	setupPanel.onDidDispose(() => { setupPanel = undefined; }, null, options.context.subscriptions);
	setupPanel.webview.html = renderSetupHtml(options);
	setupPanel.webview.onDidReceiveMessage(async message => {
		switch (message?.command) {
			case 'selectGameFolder':
				await selectGameFolderFlow(options.languageId);
				break;
			case 'rules':
				await commands.executeCommand('cwtools.rules.manageConfigGroups');
				break;
			case 'paths':
				await commands.executeCommand('cwtools.openSpecialPath');
				break;
			case 'copyPath':
				await commands.executeCommand('cwtools.copySpecialPath');
				break;
			case 'inspection':
				await commands.executeCommand('cwtools.diagnostics.openInspectionOverview');
				break;
			case 'imageMagick':
				await commands.executeCommand('cwtools.images.checkImageMagick');
				break;
			case 'reload':
				await reloadExtension(localize('Reload CWTools now?', '现在重新加载 CWTools 吗？'), localize('Reload', '重新加载'));
				break;
			case 'settings':
				await commands.executeCommand('workbench.action.openSettings', `@ext:${options.context.extension.id} stellarisLanguageServices`);
				break;
			case 'refresh':
				setupPanel!.webview.html = renderSetupHtml(options);
				break;
		}
	}, undefined, options.context.subscriptions);
}

async function maybeShowFirstRunExperience(options: InstallHealthOptions): Promise<void> {
	await maybePromptForDefaultDarkModernTheme({
		envLanguage: vs.env.language,
		configurationTargetGlobal: vs.ConfigurationTarget.Global,
		globalState: options.context.globalState,
		getConfiguration: (section) => workspace.getConfiguration(section),
		showInformationMessage: (message, ...items) => window.showInformationMessage(message, ...items),
		warn: (message, error) => ErrorReporter.warn('Extension', message, error),
	});

	// Auto-open the setup panel only once per machine
	const isParadoxWorkspace = options.isVanillaFolder || isKnownGameLanguageId(options.languageId);
	const shownKey = 'stellarisLanguageServices.setupPanel.shown';
	const shownForOlderVersion = options.context.globalState.keys().some(key => key.startsWith(`${shownKey}.`));
	if (isParadoxWorkspace && !shownForOlderVersion && !options.context.globalState.get<boolean>(shownKey)) {
		await options.context.globalState.update(shownKey, true);
		await showSetupPanel(options);
	}

	const gamePromptKey = `stellarisLanguageServices.gamePathPrompted.${options.languageId}`;
	const hasGamePath = options.isVanillaFolder || isValidGameDataPath(getConfiguredGamePath(options.languageId));
	if (!hasGamePath && !options.context.globalState.get<boolean>(gamePromptKey)) {
		const profile = getKnownProfileByLanguageId(options.languageId);
		if (!profile) return;
		await options.context.globalState.update(gamePromptKey, true);
		const choice = await window.showInformationMessage(
			localize(
				`${profile.displayName} vanilla folder is not configured. Configure it now so CWTools can build the vanilla cache.`,
				`尚未配置 ${profile.displayName} 游戏目录。现在配置后，CWTools 就可以生成原版缓存。`
			),
			localize('Configure', '配置'),
			localize('Later', '稍后')
		);
		if (choice === localize('Configure', '配置')) {
			await selectGameFolderFlow(options.languageId);
		}
	}
}

export async function activate(context: ExtensionContext) {
	setAiMessageLocale(vs.env.language);

	await migrateLegacyPublisherGlobalStorage(context).catch((e) =>
		ErrorReporter.warn('Extension', 'Failed to migrate legacy publisher globalStorage', e)
	);

	if (!await removeConflictingExtensions()) {
		return;
	}

	// Run update checks in the background so slow GitHub/network responses never block LSP startup.
	void checkForUpdates(context, {
		beforeInstall: async ({ reinstallCurrentVersion }) => {
			if (!reinstallCurrentVersion || !defaultClient) {
				return;
			}
			try {
				await defaultClient.stop();
			} catch (e) {
				ErrorReporter.warn(SOURCE.UPDATE_CHECKER, 'Failed to stop CWTools language server before same-version reinstall', e);
			}
		}
	}).catch((e) => ErrorReporter.warn(SOURCE.UPDATE_CHECKER, 'Failed to check for updates', e));

	const indexService = new IndexService({
		extensionPath: context.extensionPath,
		globalStoragePath: context.globalStorageUri.fsPath,
	});
	context.subscriptions.push(indexService);
	void indexService.start();
	registerProjectKnowledgeWatcher(context, indexService);

	// Register localization enhancements (§ color highlighting, $REF$ hover/goto)
	registerLocalizationFeatures(context, indexService);
	registerIndexedWorkspaceSymbols(context, indexService);
	registerParadoxCsvFeatures(context);
	registerRelatedResourceFeatures(context, indexService);
	registerInspectionOverviewCommand(context);

	// Register completion provider for @ constants in .gui, .asset, .gfx files
	context.subscriptions.push(
		vs.languages.registerCompletionItemProvider(
			[
				{ scheme: 'file', pattern: '**/*.gui' },
				{ scheme: 'file', pattern: '**/*.asset' },
				{ scheme: 'file', pattern: '**/*.gfx' }
			],
			{
				provideCompletionItems(document: vs.TextDocument, position: vs.Position) {
					const linePrefix = document.lineAt(position).text.substring(0, position.character);
					const matchPrefix = linePrefix.match(/@([A-Za-z0-9_]*)$/);
					if (!matchPrefix) return undefined;

					const text = document.getText();
					const regex = /@([A-Za-z0-9_]+)\s*=/g;
					const completions: vs.CompletionItem[] = [];
					const seen = new Set<string>();

					let match;
					while ((match = regex.exec(text)) !== null) {
						const varName = match[1];
						if (!varName) continue;
						if (!seen.has(varName)) {
							seen.add(varName);
							const item = new vs.CompletionItem('@' + varName, vs.CompletionItemKind.Constant);
							//Replace the @ and subsequent characters that have been entered when triggering
							item.range = new vs.Range(
								position.line, position.character - matchPrefix[0].length,
								position.line, position.character
							);
							item.detail = 'Local Constant';
							completions.push(item);
						}
					}
					return completions;
				}
			},
			'@'
		)
	);

	// Client-side Rename Provider — uses VSCode's built-in reference finding
	// Fix #8: shared game language list (was duplicated as gameLanguages and gameLanguages2)
	const gameLanguages = [...getAllLanguageIds(), 'paradox'];
	const docSelector = gameLanguages.map(lang => ({ scheme: 'file', language: lang }));
	const legacyClientRenameProviderEnabled = false;

	if (legacyClientRenameProviderEnabled) {
	context.subscriptions.push(
		vs.languages.registerRenameProvider(docSelector, {
			async provideRenameEdits(document, position, newName, _token) {
				const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_@$]+/);
				const oldName = wordRange ? document.getText(wordRange) : '';
				if (!oldName) {
					throw new Error('No symbol found at cursor');
				}

				const edit = new WorkspaceEdit();
				const editMeta: vs.WorkspaceEditEntryMetadata = {
					needsConfirmation: true,
					label: 'Rename Symbol'
				};

				// First try LSP references (works for type definitions)
				const refs: vs.Location[] = await vs.commands.executeCommand(
					'vscode.executeReferenceProvider', document.uri, position
				) || [];

				if (refs.length > 0) {
					for (const ref of refs) {
						const refDoc = await vs.workspace.openTextDocument(ref.uri);
						const refText = refDoc.getText(ref.range);
						if (refText === oldName) {
							edit.replace(ref.uri, ref.range, newName, editMeta);
						} else {
							const lineText = refDoc.lineAt(ref.range.start.line).text;
							const idx = lineText.indexOf(oldName, ref.range.start.character);
							if (idx >= 0) {
								edit.replace(ref.uri, new vs.Range(
									ref.range.start.line, idx,
									ref.range.start.line, idx + oldName.length
								), newName, editMeta);
							}
						}
					}
				} else {
					// Fallback: search all .txt files in workspace for exact word match
					const files = await vs.workspace.findFiles('**/*.txt', '**/.*/**');
					const wordBoundary = new RegExp(`(?<![A-Za-z0-9_])${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');
					for (const fileUri of files.slice(0, 2000)) {
						let text: string;
						try { const buf = await vs.workspace.fs.readFile(fileUri); text = new TextDecoder('utf-8').decode(buf); } catch { continue; }
						// L4 Fix: avoid openTextDocument (never freed — memory leak)
						const offs: number[] = [0];
						for (let j = 0; j < text.length; j++) { if (text[j] === '\n') { offs.push(j + 1); } }
						const posAt = (o: number): vs.Position => {
							let lv = 0, hv = offs.length - 1;
							while (lv < hv) { const mid = Math.ceil((lv + hv) / 2);  
 if (offs[mid]! <= o) { lv = mid; } else { hv = mid - 1; } }
							 
							return new vs.Position(lv, o - offs[lv]!);
						};
						wordBoundary.lastIndex = 0;
						let match: RegExpExecArray | null;
						while ((match = wordBoundary.exec(text)) !== null) {
							edit.replace(fileUri, new vs.Range(posAt(match.index), posAt(match.index + oldName.length)), newName, editMeta);
						}
					}
				}

				if (edit.size === 0) {
					throw new Error('No occurrences found for rename');
				}
				return edit;
			},
			async prepareRename(document, position, _token) {
				const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_@$]+/);
				if (!wordRange) {
					throw new Error('Cannot rename this element');
				}
				return { range: wordRange, placeholder: document.getText(wordRange) };
			}
		})
	);
	}

	// CodeLens click command — properly converts JSON args to VSCode types
	safeRegisterCommand(context, 'cwtools.showReferences', async (uriStr: string, pos: any, locs?: any[]) => {
		const uri = vs.Uri.parse(uriStr);
		const position = new vs.Position(pos.line || 0, pos.character || 0);
		const locations = Array.isArray(locs)
			? locs.map((loc: any) => {
				const locUri = vs.Uri.parse(loc.uri);
				const range = new vs.Range(
					new vs.Position(loc.range?.start?.line || 0, loc.range?.start?.character || 0),
					new vs.Position(loc.range?.end?.line || 0, loc.range?.end?.character || 0)
				);
				return new vs.Location(locUri, range);
			})
			: await vs.commands.executeCommand<vs.Location[]>('vscode.executeReferenceProvider', uri, position) || [];
		await vs.commands.executeCommand('editor.action.showReferences', uri, position, locations);
	});

	safeRegisterCommand(context, 'cwtools.showTypeReferences', async (uriStr: string, pos: any, typeName: string, id: string) => {
		const uri = vs.Uri.parse(uriStr);
		const position = new vs.Position(pos?.line ?? 0, pos?.character ?? 0);

		let rawLocations: any[] = [];
		let usedTypeQuery = false;
		try {
			const response = await defaultClient.sendRequest<any>('workspace/executeCommand', {
				command: 'cwtools.findTypeReferences',
				arguments: [typeName, id]
			});
			usedTypeQuery = true;
			rawLocations = Array.isArray(response) ? response : [];
		} catch (error) {
			ErrorReporter.debug('Extension', 'Failed to query type references for CodeLens', error);
		}

		let locations = rawLocations.map((loc: any) => {
			const locUri = vs.Uri.parse(loc.uri);
			const range = new vs.Range(
				new vs.Position(loc.range?.start?.line ?? 0, loc.range?.start?.character ?? 0),
				new vs.Position(loc.range?.end?.line ?? 0, loc.range?.end?.character ?? 0)
			);
			return new vs.Location(locUri, range);
		});

		if (!usedTypeQuery) {
			locations = await vs.commands.executeCommand<vs.Location[]>('vscode.executeReferenceProvider', uri, position) || [];
		}

		if (locations.length === 0) {
			void vs.window.showInformationMessage(`No references found for ${typeName}: ${id}`);
			return;
		}

		await vs.commands.executeCommand('editor.action.showReferences', uri, position, locations);
	});

	safeRegisterCommand(context, 'cwtools.definitionInjection.changeMode', async (uriStr: string, lineArg: number, mode: string) => {
		const uri = vs.Uri.parse(uriStr);
		const line = Number(lineArg);
		const newMode = String(mode || '').toUpperCase();
		const supportedModes = new Set(['INJECT', 'REPLACE', 'TRY_INJECT', 'TRY_REPLACE', 'INJECT_OR_CREATE', 'REPLACE_OR_CREATE']);
		if (!supportedModes.has(newMode)) {
			void vs.window.showWarningMessage(localize(`Unsupported definition injection mode: ${newMode}`, `不支持的定义注入模式：${newMode}`));
			return;
		}

		const document = await vs.workspace.openTextDocument(uri);
		if (!Number.isInteger(line) || line < 0 || line >= document.lineCount) {
			return;
		}

		const textLine = document.lineAt(line).text;
		const match = textLine.match(/^(\s*)(INJECT|REPLACE|TRY_INJECT|TRY_REPLACE|INJECT_OR_CREATE|REPLACE_OR_CREATE):([A-Za-z0-9_.:-]+)\s*=/i);
		if (!match) {
			void vs.window.showWarningMessage(localize('No definition injection key was found on this line.', '此行没有找到定义注入键。'));
			return;
		}

		const oldMode = match[2] ?? '';
		if (oldMode.toUpperCase() === newMode) {
			return;
		}

		const start = (match[1] ?? '').length;
		const edit = new vs.WorkspaceEdit();
		edit.replace(uri, new vs.Range(line, start, line, start + oldMode.length), newMode);
		await vs.workspace.applyEdit(edit);
	});


	class CwtoolsProvider implements vs.TextDocumentContentProvider {
		private disposables: Disposable[] = [];

		constructor() {
			// Fix #7: capture registration Disposable instead of dropping it
			this.disposables.push(
				workspace.registerTextDocumentContentProvider("cwtools", this)
			);
		}
		async provideTextDocumentContent() {
			return '';
		}

		dispose(): void {
			this.disposables.forEach(d => d.dispose());
		}
	}

	// Ensure the cache is always generated in the globalStorage path to avoid permission issues and path-encoding issues
	// common when extensions are installed in Program Files or Chinese User directories.
	const cacheDir = path.join(context.globalStorageUri.fsPath, '.cwtools');

	// Asynchronously clean up the old .cwtools directory in the extension path if it exists
	// to reclaim disk space for the user.
	setTimeout(async () => {
		try {
			const oldCacheDir = path.join(context.extensionPath, '.cwtools');
			if (fs.existsSync(oldCacheDir)) {
				await fs.promises.rm(oldCacheDir, { recursive: true, force: true });
				ErrorReporter.debug('Extension', 'Successfully cleaned up legacy .cwtools cache directory.');
			}
		} catch (e) {
			ErrorReporter.debug('Extension', 'Failed to clean up legacy .cwtools directory', e);
		}
	}, 5000);

	// Sync the bundled MCP server to a version-independent globalStorage path so
	// external agents (Codex / Claude Code) can point at a stable location that
	// keeps following extension updates instead of a versioned extension path.
	const stableMcpDir = path.join(context.globalStorageUri.fsPath, 'mcp');
	const stableMcpPath = path.join(stableMcpDir, 'cwtools-mcp.cjs');
	setTimeout(async () => {
		try {
			const bundledMcp = path.join(context.extensionPath, 'bin', 'mcp', 'cwtools-mcp.cjs');
			if (fs.existsSync(bundledMcp)) {
				const legacyMcpPaths = legacyPublisherStoragePaths(context)
					.filter(legacyStorage => fs.existsSync(legacyStorage))
					.map(legacyStorage => path.join(legacyStorage, 'mcp', 'cwtools-mcp.cjs'));
				for (const targetMcpPath of [stableMcpPath, ...legacyMcpPaths]) {
					await fs.promises.mkdir(path.dirname(targetMcpPath), { recursive: true });
					await fs.promises.copyFile(bundledMcp, targetMcpPath);
				}
				ErrorReporter.debug('Extension', `Synced MCP server to stable path ${stableMcpPath}`);
			}
		} catch (e) {
			ErrorReporter.debug('Extension', 'Failed to sync MCP server to globalStorage', e);
		}
	}, 2000);

	// ─── AI Module Integration (registered at top-level so panel works immediately) ──
	const aiService = new AIService(context);
	// Retire the legacy global endpoint into the per-provider map early so quick-switching
	// providers before opening settings cannot leak one provider's endpoint into another.
	void aiService.migrateLegacyEndpoint();
	const workspaceRoot = getProjectWorkspaceRoot();
	const privateAgentRoot = context.storageUri?.fsPath
		?? path.join(context.globalStorageUri.fsPath, 'agent-workspaces', sha256Text(workspaceRoot || 'empty-window').slice(0, 16));
	configurePrivateAgentStorage(privateAgentRoot);
	migrateLegacyPrivateAgentState(workspaceRoot);
	const historyConfig = workspace.getConfiguration('stellarisLanguageServices.ai.history');
	const historyPersistence = historyConfig.get<'off' | 'metadata' | 'full'>('persistence', 'full');
	configureHistoryPolicy({
		persistence: historyPersistence,
		maxAgeDays: historyConfig.get<number>('maxAgeDays', 30),
		maxBytes: historyConfig.get<number>('maxBytes', 268435456),
		redactLocalPaths: historyConfig.get<boolean>('redactLocalPaths', true),
	});
	if (historyPersistence !== 'off') processRegistry.configureStorage(privateAgentRoot);
	void enforceHistoryRetention(getPrivateAiStorageRoot()).catch(error =>
		ErrorReporter.warn('AgentHistory', 'Failed to enforce Agent history retention', error)
	);
	// AgentToolExecutor gets a lazy getter so it can be registered before client starts
	const toolExecutor = new AgentToolExecutor(() => defaultClient, workspaceRoot, indexService, context.globalStorageUri.fsPath, context.extensionPath);
	const legacyMcpDirs = legacyPublisherStoragePaths(context)
		.filter(legacyStorage => fs.existsSync(legacyStorage))
		.map(legacyStorage => path.join(legacyStorage, 'mcp'));
	const mcpBridge = new McpBridgeServer({
		context,
		toolExecutor,
		workspaceRoot,
		additionalManifestDirs: legacyMcpDirs,
	});
	context.subscriptions.push(mcpBridge);
	void mcpBridge.start().catch(e =>
		ErrorReporter.warn('MCP', 'Failed to start extension-host MCP bridge', e)
	);
	const promptBuilder = new PromptBuilder(workspaceRoot, context.globalStorageUri.fsPath, context.extensionPath);
	const agentRunner = new AgentRunner(aiService, toolExecutor, promptBuilder);
	const usageTracker = new UsageTracker(context);
	const chatStorageUri = historyPersistence === 'off'
		? undefined
		: context.storageUri ?? Uri.file(privateAgentRoot);
	if (chatStorageUri) {
		const legacyTopics = path.join(context.globalStorageUri.fsPath, 'ai-chat-topics.json');
		const privateTopics = path.join(chatStorageUri.fsPath, 'ai-chat-topics.json');
		if (fs.existsSync(legacyTopics) && !fs.existsSync(privateTopics)) {
			fs.mkdirSync(path.dirname(privateTopics), { recursive: true });
			fs.copyFileSync(legacyTopics, privateTopics);
		}
	}
	const chatPanelProvider = new AIChatPanelProvider(
		context.extensionUri,
		agentRunner,
		aiService,
		usageTracker,
		chatStorageUri,
		historyPersistence,
	);
	context.subscriptions.push(
		vs.window.registerWebviewViewProvider(AIChatPanelProvider.viewType, chatPanelProvider)
	);

	safeRegisterCommand(context, 'cwtools.ai.clearPrivateHistory', async () => {
		const confirm = aiText('Clear private Agent history', '清除 Agent 私有历史');
		const choice = await window.showWarningMessage(
			aiText('This removes private runs, checkpoints, goals, and learned memory for this workspace. Project files and shared workflows are not affected.', '这会删除当前工作区的私有运行记录、检查点、目标和学习记忆，但不会影响项目文件和共享工作流。'),
			{ modal: true },
			confirm,
		);
		if (choice !== confirm) return;
		await fs.promises.rm(path.join(getPrivateAiStorageRoot(), 'topics'), { recursive: true, force: true });
		void window.showInformationMessage(aiText('Private Agent history cleared.', 'Agent 私有历史已清除。'));
	});

	safeRegisterCommand(context, 'cwtools.ai.exportDiagnostics', async () => {
		const target = await window.showSaveDialog({
			filters: { JSON: ['json'] },
			saveLabel: aiText('Export diagnostics', '导出诊断'),
			defaultUri: Uri.file(path.join(os.homedir(), 'cwtools-agent-diagnostics.json')),
		});
		if (!target) return;
		const { runLedger } = require('./ai/runner/runLedger') as typeof import('./ai/runner/runLedger');
		const runs = await runLedger.listRecentRunsFromDisk(50);
		const redactPaths = workspace.getConfiguration('stellarisLanguageServices.ai.history').get<boolean>('redactLocalPaths', true);
		const serialized = JSON.stringify({
			version: 1,
			exportedAt: new Date().toISOString(),
			workspaceTrusted: workspace.isTrusted,
			runs,
		}, null, 2);
		const output = redactPaths && workspaceRoot
			? serialized
				.split(workspaceRoot).join('${WORKSPACE_ROOT}')
				.split(getPrivateAiStorageRoot()).join('${AGENT_PRIVATE_STORAGE}')
				.split(os.homedir()).join('${USER_HOME}')
			: serialized;
		await workspace.fs.writeFile(target, Buffer.from(output, 'utf8'));
		void window.showInformationMessage(aiText('Redacted Agent diagnostics exported.', '已导出脱敏后的 Agent 诊断。'));
	});

	// T4.2 — Replay a recorded agent run with optional overrides.
	// Side-by-side diff of original vs new event streams is opened in the editor.
	safeRegisterCommand(context, 'cwtools.ai.replayRun', async () => {
		try {
			const { runLedger } = require('./ai/runner/runLedger') as typeof import('./ai/runner/runLedger');
			const { replayRun } = require('./ai/runner/runReplay') as typeof import('./ai/runner/runReplay');
			const recentRuns = await runLedger.listRecentRunsFromDisk(30);
			if (recentRuns.length === 0) {
				vs.window.showInformationMessage('CWTools: no recorded runs available to replay.');
				return;
			}
			const pick = await vs.window.showQuickPick(
				recentRuns.slice(0, 30).map((r: any) => ({
					label: `${(r.runId ?? '').substring(0, 12)}  ·  ${r.mode ?? 'build'}  ·  ${r.status ?? 'unknown'}`,
					description: r.userPromptPreview ? String(r.userPromptPreview).substring(0, 80) : '',
					runId: r.runId,
				})),
				{ placeHolder: 'Select a run to replay (recorded tool results will be reused)' }
			);
			if (!pick) return;

			const overrideChoice = await vs.window.showQuickPick(
				[
					{ label: 'Replay with current prompt (no override)', op: 'none' as const },
					{ label: 'Replay with rebuilt system prompt', op: 'rebuild' as const },
					{ label: 'Replay with different model…', op: 'model' as const },
				],
				{ placeHolder: 'Replay overrides' }
			);
			if (!overrideChoice) return;

			const overrides: any = {};
			if (overrideChoice.op === 'rebuild') overrides.rebuildSystemPrompt = true;
			if (overrideChoice.op === 'model') {
				const modelInput = await vs.window.showInputBox({ placeHolder: 'Model id (e.g. claude-3-5-sonnet)' });
				if (!modelInput) return;
				overrides.model = modelInput;
			}

			const result = await replayRun(pick.runId, agentRunner, overrides);

			const origSnap = runLedger.getSnapshot(pick.runId);
			const newSnap = runLedger.getSnapshot(result.newRun.runId);
			const origDoc = await vs.workspace.openTextDocument({
				language: 'jsonc',
				content: JSON.stringify(origSnap?.events ?? [], null, 2),
			});
			const newDoc = await vs.workspace.openTextDocument({
				language: 'jsonc',
				content: JSON.stringify(newSnap?.events ?? [], null, 2),
			});
			await vs.commands.executeCommand(
				'vscode.diff',
				origDoc.uri,
				newDoc.uri,
				`Replay: ${pick.runId.substring(0, 8)} ↔ ${result.newRun.runId.substring(0, 8)}`,
			);

			if (result.missedToolCalls > 0) {
				vs.window.showWarningMessage(
					`Replay finished with ${result.missedToolCalls} tool-call miss(es) — model diverged from recorded run.`,
				);
			}
		} catch (e) {
			vs.window.showErrorMessage(`CWTools replayRun failed: ${(e as Error)?.message ?? e}`);
		}
	});

	// ─── Wire up AgentToolExecutor callbacks ─────────────────────────────────
	// onPendingWrite: route file-write confirmations through the WebView panel
	toolExecutor.onPendingWrite = (file, newContent, messageId) =>
		chatPanelProvider.handlePendingWrite(file, newContent, messageId);
	// onAutoWritten: show a read-only notification UI for auto-applied changes
	toolExecutor.onAutoWritten = (file, isNewFile) =>
		chatPanelProvider.handleAutoWritten(file, isNewFile);
	// onTodoUpdate: push todo list updates to the WebView panel
	toolExecutor.onTodoUpdate = (todos) =>
		chatPanelProvider.sendTodoUpdate(todos);
	// Sync fileWriteMode from config on startup
	toolExecutor.fileWriteMode = workspace.getConfiguration('stellarisLanguageServices.ai').get<'confirm' | 'auto'>('agentFileWriteMode', 'auto');
	// Re-sync fileWriteMode whenever config changes
	context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('stellarisLanguageServices.ai.agentFileWriteMode')) {
			toolExecutor.fileWriteMode = workspace.getConfiguration('stellarisLanguageServices.ai').get<'confirm' | 'auto'>('agentFileWriteMode', 'auto');
		}
	}));
	// Invalidate LSP read cache on document changes so AI doesn't base decisions on stale data
	context.subscriptions.push(workspace.onDidChangeTextDocument(e => {
		toolExecutor.invalidateCacheForFile(e.document.uri.fsPath);
	}));
	// Closed files can be changed by Git, external editors, generators, or agent
	// commands without producing onDidChangeTextDocument. Keep query-only semantic
	// graph caches coherent with those file-system mutations as well.
	const aiSemanticWatcher = workspace.createFileSystemWatcher('**/*.{txt,gui,yml,gfx,asset,cwt,entity,shader,fxh}');
	context.subscriptions.push(
		aiSemanticWatcher,
		aiSemanticWatcher.onDidChange(uri => toolExecutor.invalidateCacheForFile(uri.fsPath)),
		aiSemanticWatcher.onDidCreate(uri => toolExecutor.invalidateCacheForFile(uri.fsPath)),
		aiSemanticWatcher.onDidDelete(uri => toolExecutor.invalidateCacheForFile(uri.fsPath)),
	);
	// Backspacing never auto-triggers completion in VS Code (only typed word characters do),
	// so a mistyped character inside an @variable token would dead-end the suggestion list.
	// Re-open it when a small deletion leaves the cursor inside an @token. Similarly, typing
	// the space in `key = ` never triggers either, so value suggestions (parameter values,
	// enums) would only appear via Ctrl+Space — pull the list up when a space lands after '='.
	context.subscriptions.push(workspace.onDidChangeTextDocument(e => {
		if (e.contentChanges.length !== 1) return;
		const change = e.contentChanges[0];
		if (!change) return;
		const isSmallDeletion = change.text === '' && change.rangeLength >= 1 && change.rangeLength <= 2;
		const isSpaceInsert = change.text === ' ' && change.rangeLength === 0;
		if (!isSmallDeletion && !isSpaceInsert) return;
		if (!gameLanguages.includes(e.document.languageId)) return;
		const pos = change.range.start;
		setTimeout(() => {
			const editor = vs.window.activeTextEditor;
			if (!editor || editor.document !== e.document) return;
			const cursor = editor.selection.active;
			if (cursor.line !== pos.line) return;
			const textBefore = editor.document.lineAt(cursor.line).text.substring(0, cursor.character);
			const shouldTrigger = isSmallDeletion
				? /@[A-Za-z0-9_]*$/.test(textBefore)
				: /=\s+$/.test(textBefore);
			if (shouldTrigger) {
				void vs.commands.executeCommand('editor.action.triggerSuggest');
			}
		}, 0);
	}));
	// Fix #8: reuse shared gameLanguages instead of duplicate gameLanguages2
	const docSelector2 = gameLanguages.map(lang => ({ scheme: 'file', language: lang }));
	const inlineProvider = new AIInlineCompletionProvider(aiService, promptBuilder, usageTracker);
	context.subscriptions.push(
		inlineProvider,
		chatPanelProvider,
		vs.languages.registerInlineCompletionItemProvider(docSelector2, inlineProvider)
	);
	safeRegisterCommand(context, "cwtools.ai.configure", async () => {
		await aiService.quickConfigureProvider();
	});
	safeRegisterCommand(context, "cwtools.ai.openChat", async () => {
		await vs.commands.executeCommand('cwtools.aiChat.focus');
	});
	safeRegisterCommand(context, "cwtools.ai.openAgentManager", async () => {
		await chatPanelProvider.openAgentManager();
	});
	safeRegisterCommand(context, "cwtools.ai.selectModel", async () => {
		await aiService.selectModelCommand();
	});
	registerLocalisationAiCommands(context, (message: string) => chatPanelProvider.sendProgrammaticMessage(message));
	registerTranslationPreviewCommands(context, aiService);

	// ── Quick AI commands (keyboard shortcuts / command palette) ──────────
	safeRegisterCommand(context, "cwtools.ai.reviewFile", async () => {
		const editor = vs.window.activeTextEditor;
		if (!editor) {
			vs.window.showWarningMessage(UI.NO_ACTIVE_EDITOR);
			return;
		}
		const relPath = vs.workspace.asRelativePath(editor.document.uri);
		await chatPanelProvider.sendProgrammaticMessage(
			localize(
				`Please review the current file \`${relPath}\` for scope errors, logic issues, and CWTools diagnostic warnings.`,
				`请审查当前文件 \`${relPath}\`，检查 scope 错误、逻辑问题和 CWTools 诊断警告。`
			)
		);
	});

	safeRegisterCommand(context, "cwtools.ai.explainSelection", async () => {
		const editor = vs.window.activeTextEditor;
		if (!editor) {
			vs.window.showWarningMessage(UI.NO_ACTIVE_EDITOR);
			return;
		}
		const selection = editor.document.getText(editor.selection);
		if (!selection.trim()) {
			vs.window.showWarningMessage(UI.SELECT_CODE_FIRST);
			return;
		}
		await chatPanelProvider.sendProgrammaticMessage(
			localize(
				`Please explain what the following code does, including its scope chain and logic:\n\`\`\`pdx\n${selection}\n\`\`\``,
				`请解释以下代码的作用、scope 链和逻辑：\n\`\`\`pdx\n${selection}\n\`\`\``
			)
		);
	});

	safeRegisterCommand(context, "cwtools.ai.fixDiagnostics", async () => {
		const editor = vs.window.activeTextEditor;
		if (!editor) {
			vs.window.showWarningMessage(UI.NO_ACTIVE_EDITOR);
			return;
		}
		const relPath = vs.workspace.asRelativePath(editor.document.uri);
		await chatPanelProvider.sendProgrammaticMessage(
			localize(
				`Please get and fix all CWTools diagnostic errors in the current file \`${relPath}\`.`,
				`请获取并修复当前文件 \`${relPath}\` 中的所有 CWTools 诊断错误。`
			)
		);
	});

	safeRegisterCommand(context, "cwtools.ai.manageIgnoredDiagnostics", async () => {
		const config = vs.workspace.getConfiguration('stellarisLanguageServices.ai');
		const currentIgnored = config.get<string[]>('ignoredDiagnostics', []);

		const allDiagnostics = vs.languages.getDiagnostics();
		const candidatesByCode = new Map<string, Set<string>>();

		for (const [, diags] of allDiagnostics) {
			for (const diag of diags) {
				if (diag.severity !== vs.DiagnosticSeverity.Error) {
					continue;
				}

				const code = diagnosticCodeString(diag.code) ?? 'Unknown Code';

				const addKey = (key: string) => {
					if (!candidatesByCode.has(code)) {
						candidatesByCode.set(code, new Set<string>());
					}
					candidatesByCode.get(code)!.add(key);
				};

				if (code.toUpperCase().startsWith('CW274')) {
					for (const ri of diag.relatedInformation ?? []) {
						const riMatch = ri.message.match(/'([^']+)'/) || ri.message.match(/"([^"]+)"/);
						if (riMatch && riMatch[1]) {
							addKey(riMatch[1]);
						}
					}
					continue;
				}

				const match = diag.message.match(/'([^']+)'/) || diag.message.match(/"([^"]+)"/);
				const matchUnexpected = diag.message.match(/^([^\s]+) is unexpected in/);
				const matchUnknown = diag.message.match(/^Unknown [^\s]+ ([^\s]+)/);

				const key = match && match[1] ? match[1]
							: (matchUnexpected && matchUnexpected[1] ? matchUnexpected[1]
							: (matchUnknown && matchUnknown[1] ? matchUnknown[1] : diag.message));

				addKey(key);
			}
		}

		currentIgnored.forEach(key => {
			let found = false;
			for (const keys of candidatesByCode.values()) {
				if (keys.has(key)) {
					found = true;
					break;
				}
			}
			if (!found) {
				if (!candidatesByCode.has('Previously Saved')) {
					candidatesByCode.set('Previously Saved', new Set<string>());
				}
				candidatesByCode.get('Previously Saved')!.add(key);
			}
		});

		if (candidatesByCode.size === 0) {
			vs.window.showInformationMessage(localize('No error diagnostics were found in the current context.', '当前上下文中未发现任何红色报错。'));
			return;
		}

		const qp = vs.window.createQuickPick();
		qp.canSelectMany = true;
		qp.title = localize(
			'Select compatibility diagnostics to ignore (use the right-side icon to expand/collapse details)',
			'请选择要忽略的兼容性报错 (点击右侧图标可展开/收起具体报错)'
		);
		qp.placeholder = localize('Search prefix or diagnostic code (for example: CW262)', '搜索前缀或报错码 (例如: CW262)');
		
		const globalItem: vs.QuickPickItem = {
			label: localize('Ignore all compatibility diagnostics (global)', '忽略所有兼容性报错 (全局)'),
			description: localize('Add diagnostics from all categories to the allowlist', '将所有分类下的报错一键加入白名单'),
			alwaysShow: true
		};

		const categoryItems = new Map<string, vs.QuickPickItem>();
		const childItemsByCode = new Map<string, vs.QuickPickItem[]>();
		
		const collapseButton: vs.QuickInputButton = { iconPath: new vs.ThemeIcon('chevron-down'), tooltip: localize('Collapse this category', '收起此分类') };
		const expandButton: vs.QuickInputButton = { iconPath: new vs.ThemeIcon('chevron-right'), tooltip: localize('Expand this category to show details', '展开此分类查看详情') };

		for (const [code, keys] of candidatesByCode.entries()) {
			const catItem: vs.QuickPickItem = {
				label: localize(`Ignore all ${code} diagnostics`, `忽略所有 ${code} 报错`),
				description: localize(`${keys.size} diagnostic item(s)`, `共 ${keys.size} 个报错项`)
			};
			categoryItems.set(code, catItem);

			const children: vs.QuickPickItem[] = [];
			Array.from(keys).sort().forEach(key => {
				children.push({
					label: key,
					description: localize(`Diagnostic code: ${code}`, `报错码: ${code}`)
				});
			});
			childItemsByCode.set(code, children);
		}

		const categoryCodeFromLabel = (label: string): string | undefined => {
			const en = label.match(/^Ignore all (.+) diagnostics$/);
			if (en && en[1]) return en[1];
			const zh = label.match(/^忽略所有 (.+) 报错$/);
			return zh?.[1];
		};

		// State
		const expandedCategories = new Set<string>(); // Default to collapsed
		const internalSelected = new Set<string>(currentIgnored); // Initially selected from settings

		let isUpdating = false;
		const selectionGuard = new QuickPickSelectionGuard();
		let previousSelectedIds = new Set<string>();

		const selectionId = (item: vs.QuickPickItem): string => {
			if (item === globalItem) return 'global';
			const categoryCode = categoryCodeFromLabel(item.label);
			return categoryCode ? `category:${categoryCode}` : `key:${item.label}`;
		};

		const suppressProgrammaticSelectionEvents = (items: readonly vs.QuickPickItem[]) => {
			// QuickPick may emit onDidChangeSelection after items/selectedItems setters
			// return. Preserve the expected stable IDs until the UI reports that state,
			// so collapsing a category cannot be mistaken for clearing its selections.
			selectionGuard.beginProgrammaticUpdate(items.map(selectionId));
		};

		const rebuildItems = (updateItems: boolean) => {
			const newItems: vs.QuickPickItem[] = [globalItem];
			const newSelected: vs.QuickPickItem[] = [];

			let allGlobalPicked = true;
			let totalKeys = 0;

			for (const [code, keys] of candidatesByCode.entries()) {
				totalKeys += keys.size;
				const isExpanded = expandedCategories.has(code);
				
				if (updateItems) {
					newItems.push({
						label: localize(`Diagnostic code: ${code}`, `报错码: ${code}`),
						kind: vs.QuickPickItemKind.Separator
					});

					const catItem = categoryItems.get(code)!;
					catItem.buttons = [isExpanded ? collapseButton : expandButton];
					newItems.push(catItem);
				}

				let allCatPicked = true;
				for (const key of keys) {
					if (!internalSelected.has(key)) {
						allCatPicked = false;
						allGlobalPicked = false;
					}
				}
				if (allCatPicked && keys.size > 0) {
					newSelected.push(categoryItems.get(code)!);
				}

				if (isExpanded) {
					const children = childItemsByCode.get(code)!;
					for (const child of children) {
						if (updateItems) newItems.push(child);
						if (internalSelected.has(child.label)) {
							newSelected.push(child);
						}
					}
				}
			}

			if (allGlobalPicked && totalKeys > 0) {
				newSelected.push(globalItem);
			}

			isUpdating = true;
			suppressProgrammaticSelectionEvents(newSelected);
			if (updateItems) {
				qp.items = newItems;
			}
			qp.selectedItems = newSelected;
			previousSelectedIds = new Set(newSelected.map(selectionId));
			isUpdating = false;
		};

		qp.onDidTriggerItemButton(e => {
			const code = categoryCodeFromLabel(e.item.label);
			if (code) {
				if (expandedCategories.has(code)) {
					expandedCategories.delete(code);
				} else {
					expandedCategories.add(code);
				}
				rebuildItems(true);
			}
		});

		qp.onDidChangeSelection(selected => {
			const currentIds = new Set(selected.map(selectionId));
			if (isUpdating || selectionGuard.shouldIgnore(currentIds)) return;

			const toggledOn = selected.filter(item => !previousSelectedIds.has(selectionId(item)));
			const toggledOnIds = new Set(toggledOn.map(selectionId));
			const toggledOff = Array.from(previousSelectedIds).filter(id => !currentIds.has(id));

			if (toggledOn.length === 0 && toggledOff.length === 0) return;

			if (toggledOnIds.has('global')) {
				for (const keys of candidatesByCode.values()) {
					keys.forEach(k => internalSelected.add(k));
				}
			} else if (toggledOff.includes('global')) {
				for (const keys of candidatesByCode.values()) {
					keys.forEach(k => internalSelected.delete(k));
				}
			} else {
				for (const item of toggledOn) {
					const code = categoryCodeFromLabel(item.label);
					if (code) {
						candidatesByCode.get(code)?.forEach(k => internalSelected.add(k));
					} else if (item.kind !== vs.QuickPickItemKind.Separator) {
						internalSelected.add(item.label);
					}
				}
				for (const id of toggledOff) {
					if (id.startsWith('category:')) {
						const code = id.slice('category:'.length);
						candidatesByCode.get(code)?.forEach(k => internalSelected.delete(k));
					} else if (id.startsWith('key:')) {
						internalSelected.delete(id.slice('key:'.length));
					}
				}
			}

			rebuildItems(false);
		});

		qp.onDidAccept(async () => {
			qp.hide();
			
			const newIgnored = Array.from(internalSelected);
			await config.update('ignoredDiagnostics', newIgnored, vs.ConfigurationTarget.Workspace);
			vs.window.showInformationMessage(localize(
				`Added ${newIgnored.length} compatibility diagnostic(s) to the allowlist.`,
				`已成功将 ${newIgnored.length} 个兼容性报错加入白名单。`
			));
			
			qp.dispose();
		});

		qp.onDidHide(() => {
			selectionGuard.dispose();
			qp.dispose();
		});

		// Initialize
		rebuildItems(true);
		qp.show();
	});

	// ── CodeActionProvider: AI Quick Fix for CWTools diagnostics ──────────
	registerCodeActions(
		context,
		(msg: string) => chatPanelProvider.sendProgrammaticMessage(msg),
		[...getAllLanguageIds(), 'paradox']
	);

	// ── AI Chat: Send selection to chat ──────────────────────────────────────
	safeRegisterCommand(context, "cwtools.ai.sendSelectionToChat", async () => {
		const editor = vs.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			vs.window.showWarningMessage(UI.SELECT_CODE_FIRST);
			return;
		}
		const relPath = vs.workspace.asRelativePath(editor.document.uri);
		const startLine = editor.selection.start.line + 1;
		const endLine = editor.selection.end.line + 1;
		await chatPanelProvider.sendSelectionReference(relPath, startLine, endLine);
	});

	// ── Graphics Features: DDS hover preview, GFX sprite goto, room completion ──
	registerTexturePreviewEditor(context);
	registerGraphicsFeatures(context);
	registerImageTools(context);

	// ── Vanilla Code Comparison: block-level and file-level diff against vanilla game ──
	registerVanillaCompare(context);
	registerPdxIndentFormatter(context);

	const init = async function (language: string, isVanillaFolder: boolean) {
		vs.languages.setLanguageConfiguration(language, {
			wordPattern: /"?([^\s.]+)"?/,
			indentationRules: {
				increaseIndentPattern: /((\{\s*))$/,
				decreaseIndentPattern: /^\s*((\}))/
			},
			autoClosingPairs: [
				{ open: '{', close: '}' },
				{ open: '[', close: ']' },
				{ open: '(', close: ')' },
				{ open: '"', close: '"' },
				{ open: "'", close: "'" }
			]
		})
		// The server is implemented using dotnet core
		let serverExe: string;
		if (os.platform() == "win32") {
			serverExe = context.asAbsolutePath(path.join('bin', 'server', 'win-x64', 'CWTools Server.exe'))
		}
		else if (os.platform() == "darwin") {
			serverExe = context.asAbsolutePath(path.join('bin', 'server', 'osx-x64', 'CWTools Server'))
			fs.chmodSync(serverExe, '755');
		}
		else {
			serverExe = context.asAbsolutePath(path.join('bin', 'server', 'linux-x64', 'CWTools Server'))
			fs.chmodSync(serverExe, '755');
		}
		
		const repoPathStr = getRulesRemoteUrl(language);
		const defaultRepoPath = repoPathStr;
		const repoPath = getConfiguredRulesRemoteUrl(language);
		const bundledRulesPath = resolveBundledRulesPath(context, language);
		ErrorReporter.debug('Extension', `Language: ${language}, repo: ${repoPath}`);
		registerRulesConfigGroupCommands(context, () => ({
			languageId: language,
			cacheDir,
			bundledRulesPath,
			defaultRemoteRulesUrl: defaultRepoPath,
			remoteRulesUrl: getConfiguredRulesRemoteUrl(language),
		}));
		registerSpecialPathCommands(context, () => ({
			languageId: language,
			cacheDir,
			bundledRulesPath,
			globalStoragePath: context.globalStorageUri.fsPath,
			getSteamLibraryPaths,
		}));

		// If the extension is launched in debug mode then the debug server options are used
		// Otherwise the run options are used
		const serverOptions: ServerOptions = {
			run: { command: serverExe, transport: TransportKind.stdio },
			debug: { command: serverExe, transport: TransportKind.stdio }
		}

		const fileEvents = [
			workspace.createFileSystemWatcher("**/{events,common,map,map_data,prescripted_countries,flags,decisions,missions}/**/*.txt"),
			workspace.createFileSystemWatcher("**/{interface,gfx}/**/*.gui"),
			workspace.createFileSystemWatcher("**/{interface,gfx}/**/*.gfx"),
			workspace.createFileSystemWatcher("**/gfx/**/*.{shader,fxh}"),
			workspace.createFileSystemWatcher("**/{interface}/**/*.sfx"),
			workspace.createFileSystemWatcher("**/{interface,gfx,fonts,music,sound}/**/*.asset"),
			workspace.createFileSystemWatcher("**/{localisation,localisation_synced,localization}/**/*.yml")
		]

		// Options to control the language client
		const clientOptions: LanguageClientOptions = {
			// Register the server for F# documents
			documentSelector: [{ scheme: 'file', language: 'paradox' }, { scheme: 'file', language: 'yaml' }, { scheme: 'file', language: 'stellaris' },
			{ scheme: 'file', language: 'hoi4' }, { scheme: 'file', language: 'eu4' }, { scheme: 'file', language: 'ck2' }, { scheme: 'file', language: 'imperator' }
				, { scheme: 'file', language: 'vic2' }, { scheme: 'file', language: 'vic3' }, { scheme: 'file', language: 'ck3' }, { scheme: 'file', language: 'eu5' }, { scheme: 'file', language: 'pdx-shader' }, { scheme: 'file', language: 'paradox' }],
			synchronize: {
				// Synchronize extension settings to the language server.
				configurationSection: 'stellarisLanguageServices',
				// Notify the server about file changes to F# project files contain in the workspace

				fileEvents: fileEvents
			},
			middleware: {
				workspace: {
					didChangeConfiguration: async (sections: any, next: (sections: any) => Promise<void>) => {
						// Drop config changes if they were just triggered by our own AI Settings Manager
						// This prevents the F# server from resetting the workspace because of pure UI changes.
						if (Date.now() - lastAISettingsWriteTime < 1500) {
							return;
						}
						await next(sections);
					}
				},
				handleDiagnostics: (uri, diagnostics, next) => {
					const config = workspace.getConfiguration('stellarisLanguageServices.ai');
					const ignored = config.get<string[]>('ignoredDiagnostics', []);
					let result = diagnostics;
					if (ignored.length > 0) {
						// Ignore-list matching runs against the original server message,
						// before any enrichment rewrites it. relatedInformation is matched
						// too: call-site relocated errors (CW274 inline_script expansion)
						// carry the actual error text only there.
						result = diagnostics.filter(diag =>
							!ignored.some(key => diagnosticMatchesIgnoredKey(diag, key)));
					}
					if (config.get<boolean>('enhancedDiagnostics', true)) {
						enrichDiagnosticsInPlace(result, vs.env.language.startsWith('zh'));
					}
					next(uri, result);
				},
				provideDocumentLinks: async (document, token, next) => {
					const links = await next(document, token);
					if (!links || !document.fileName.toLowerCase().endsWith('.gfx')) {
						return links;
					}
					return links.filter(link => !isImagePathLinkText(document.getText(link.range)));
				}
			},
			initializationOptions: {
				language: language,
				uiLanguage: vs.env.language,
				isVanillaFolder: isVanillaFolder,
				rulesCache: cacheDir,
				bundledRulesPath: bundledRulesPath,
				rules_version: workspace.getConfiguration('stellarisLanguageServices').get('rules_version'),
				defaultRepoPath: defaultRepoPath,
				repoPath: repoPath,
				diagnosticLogging: workspace.getConfiguration('stellarisLanguageServices').get('logging.diagnostic')
			},
			revealOutputChannelOn: RevealOutputChannelOn.Error
		}

		const client = new LanguageClient('cwtools', 'Paradox Language Server', serverOptions, clientOptions);
		defaultClient = client;
		client.registerProposedFeatures();
		const monitorLogChannel = window.createOutputChannel('MemDiag');
		context.subscriptions.push(monitorLogChannel);
		interface loadingBarParams { enable: boolean; value: string; percentage?: number }
		const loadingBarNotification = new NotificationType<loadingBarParams>('loadingBar');
		interface debugStatusBarParams { enable: boolean; value: string }
		const debugStatusBarParamsNotification = new NotificationType<debugStatusBarParams>('debugBar');
		interface CreateVirtualFile { uri: string; fileContent: string }
		const createVirtualFile = new NotificationType<CreateVirtualFile>('createVirtualFile');
		const promptReload = new NotificationType<string>('promptReload')
		const forceReload = new NotificationType<string>('forceReload')
		const promptVanillaPath = new NotificationType<string>('promptVanillaPath')
		interface DidFocusFile { uri: string }
		const didFocusFile = new NotificationType<DidFocusFile>('didFocusFile')
		let status: Disposable | undefined;
		interface UpdateFileList { fileList: FileListItem[] }
		const updateFileList = new NotificationType<UpdateFileList>('updateFileList');
		interface MonitorLogParams { category?: string; message: string; timestamp?: string }
		const monitorLogNotification = new NotificationType<MonitorLogParams>('monitorLog');

		async function didChangeActiveTextEditor(editor: vs.TextEditor | undefined): Promise<void> {
			if (editor) {
				const path = editor.document.uri.toString();
				if (languageId == "paradox" && editor.document.languageId == "plaintext") {
					await vs.languages.setTextDocumentLanguage(editor.document, "paradox")
				}
				if (editor.document.languageId == language) {
					await client.sendNotification(didFocusFile, { uri: path });
				}
			}
		}

		context.subscriptions.push(window.onDidChangeActiveTextEditor(didChangeActiveTextEditor));

		// Monitor document changes and automatically trigger completion when | is entered in the script_value environment
		let lastCursorLine = -1;
		let lastCursorChar = -1;
		context.subscriptions.push(workspace.onDidChangeTextDocument(async (e) => {
			//Only process the currently active text
			if (window.activeTextEditor && e.document === window.activeTextEditor.document) {
				const doc = window.activeTextEditor.document;

				// Only handle paradox languages
				if (doc.languageId !== language) return;

				// Get the current cursor position
				const cursor = window.activeTextEditor.selection.active;
				const currentLine = cursor.line;
				const currentChar = cursor.character;

				// Check if there are any changes
				if (currentLine === lastCursorLine && currentChar === lastCursorChar) return;
				lastCursorLine = currentLine;
				lastCursorChar = currentChar;

				// Get the current line of text
				const lineText = doc.lineAt(currentLine).text;

				// Check if it is in value:xxx| environment
				// Matching pattern: value:xxx| (cursor is after |)
				const textBeforeCursor = lineText.substring(0, currentChar);

				// Check if it ends with value:xxx| (spaces allowed)
				const scriptValuePattern = /value\s*:\s*\S+\|\s*$/;
				const isMatch = scriptValuePattern.test(textBeforeCursor);

				if (isMatch) {
					//Trigger completion after a delay of 150ms to allow the document to be completed synchronously
					setTimeout(() => {
						commands.executeCommand('editor.action.triggerSuggest');
					}, 150);
				}
			}
		}));

		if (languageId == "paradox") {
			for (const textDocument of workspace.textDocuments) {
				if (textDocument.languageId == "plaintext") {
					await vs.languages.setTextDocumentLanguage(textDocument, "paradox")
				}
			}
		}

		let resolveLoadingBar: (() => void) | undefined;
		let loadingReporter: vs.Progress<{ message?: string; increment?: number; }> | undefined;
			let lastPercentage = 0;

		client.onNotification(loadingBarNotification, (param: loadingBarParams) => {
			if (param.enable) {
				if (status !== undefined) {
					status.dispose();
					status = undefined;
				}
				status = window.setStatusBarMessage(param.value);
				context.subscriptions.push(status);

				if (!resolveLoadingBar) {
					vs.window.withProgress({
						location: vs.ProgressLocation.Notification,
						cancellable: false,
						title: "CWTools",
					}, (progress) => {
						loadingReporter = progress;
						const inc0 = param.percentage !== undefined ? Math.max(0, param.percentage - lastPercentage) : undefined;
						lastPercentage = param.percentage ?? lastPercentage;
						progress.report({ message: param.value, increment: inc0 });
						return new Promise<void>((resolve) => {
							resolveLoadingBar = resolve;
						});
					}).then(() => {
						loadingReporter = undefined;
						resolveLoadingBar = undefined;
					});
				} else {
					if (loadingReporter) {
						const inc = param.percentage !== undefined ? Math.max(0, param.percentage - lastPercentage) : undefined;
						lastPercentage = param.percentage ?? lastPercentage;
						loadingReporter.report({ message: param.value, increment: inc });
					}
				}
			} else {
				lastPercentage = 0;
				if (status !== undefined) {
					status.dispose();
					status = undefined;
				}
				if (resolveLoadingBar) {
					resolveLoadingBar();
					resolveLoadingBar = undefined;
					loadingReporter = undefined;
				}
			}
		})
		const debugStatusBar = window.createStatusBarItem(vs.StatusBarAlignment.Left);
		context.subscriptions.push(debugStatusBar);
		client.onNotification(debugStatusBarParamsNotification, (param: debugStatusBarParams) => {
			if (param.enable) {
				debugStatusBar.text = param.value;
				debugStatusBar.show();
			}
			else if (!param.enable) {
				debugStatusBar.hide();
			}
		})
		client.onNotification(monitorLogNotification, (param: MonitorLogParams) => {
			const timestamp = param.timestamp ?? new Date().toLocaleTimeString('en-US', { hour12: false });
			const category = param.category ? `[${param.category}] ` : '';
			monitorLogChannel.appendLine(`[${timestamp}] ${category}${param.message}`);
		})

		let clientStarted = false;
		const healthOptions = (): InstallHealthOptions => ({
			context,
			languageId: language,
			cacheDir,
			bundledRulesPath,
			rulesRemoteUrl: getConfiguredRulesRemoteUrl(language),
			serverExe,
			isVanillaFolder,
			clientStarted,
		});

		const rulesStatusBar = window.createStatusBarItem(vs.StatusBarAlignment.Left, 90);
		rulesStatusBar.command = 'cwtools.openSetup';
		const updateRulesStatusBar = () => {
			const rules = getRulesSourceStatus(language, cacheDir, bundledRulesPath);
			const source = rulesSourceLabel(rules.source);
			rulesStatusBar.text = rules.source === 'Missing'
				? localize('$(warning) CWTools: Rules Missing', '$(warning) CWTools：规则缺失')
				: localize(`$(check) CWTools: Rules ${source}`, `$(check) CWTools：规则 ${source}`);
			rulesStatusBar.tooltip = rules.source === 'Missing'
				? localize('No CWTools validation rules were found. Open CWTools Setup for details.', '未找到 CWTools 校验规则。打开 CWTools 安装配置查看详情。')
				: localize(
					`Validation rules: ${source}\nFiles: ${rules.fileCount}${rules.path ? `\nPath: ${rules.path}` : ''}`,
					`校验规则：${source}\n文件数：${rules.fileCount}${rules.path ? `\n路径：${rules.path}` : ''}`
				);
			rulesStatusBar.show();
		};
		context.subscriptions.push(rulesStatusBar);
		context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
			const profile = getKnownProfileByLanguageId(language);
			if (
				e.affectsConfiguration('stellarisLanguageServices.rules_version') ||
				e.affectsConfiguration('stellarisLanguageServices.rules_folder') ||
				e.affectsConfiguration('stellarisLanguageServices.rules_remote_url') ||
				(profile ? e.affectsConfiguration(profile.cacheSettingKey) : false)
			) {
				updateRulesStatusBar();
			}
		}));
		client.onNotification(createVirtualFile, async (param: CreateVirtualFile) => {
			const uri = Uri.parse(param.uri);
			const doc = await workspace.openTextDocument(uri);
			const edit = new WorkspaceEdit();
			const range = new Range(0, 0, doc.lineCount, doc.getText().length);
			edit.set(uri, [new TextEdit(range, param.fileContent)]);
			await workspace.applyEdit(edit);
			await window.showTextDocument(uri);
		})
		client.onNotification(promptReload, async (param: string) => {
			await reloadExtension(param, localize("Reload", "重新加载"))
		})
		client.onNotification(forceReload, async (param: string) => {
			window.showInformationMessage(param);
			await commands.executeCommand('workbench.action.reloadWindow');
		})
		client.onNotification(promptVanillaPath, async (param: string) => {
			await selectGameFolderFlow(param);
		})
		client.onNotification(updateFileList, (params: UpdateFileList) => {
			fileList = params.fileList;
			if (fileExplorer) {
				fileExplorer.refresh(fileList);
			}
			else {
				fileExplorer = new FileExplorer(context, fileList);
			}
		})

		if (workspace.name === undefined) {
			await window.showWarningMessage("You have opened a file directly.\n\rFor CWTools to work correctly, the mod folder should be opened using \"File, Open Folder\"")
		}


		// Create the language client and start the client.

		// Push the disposable to the context's subscriptions so that the
		// client can be deactivated on extension deactivation
		context.subscriptions.push(new CwtoolsProvider());

		safeRegisterCommand(context, "cwtools.openSetup", async () => {
			await showSetupPanel(healthOptions());
		});

		safeRegisterCommand(context, "cwtools.runInstallationDoctor", async () => {
			await showSetupPanel(healthOptions());
		});

		safeRegisterCommand(context, "cwtools.selectGameFolder", async () => {
			await selectGameFolderFlow(language);
			updateRulesStatusBar();
			if (setupPanel) {
				setupPanel.webview.html = renderSetupHtml(healthOptions());
			}
		});

		const toggleInlineTextFunc = async () => {
			const config = vs.workspace.getConfiguration("stellarisLanguageServices");
			const currentState = config.get<boolean>("showInlineText", false);
			await config.update("showInlineText", !currentState, vs.ConfigurationTarget.Global);
			if (!currentState) {
				vs.window.showInformationMessage("Inline Text is now ON");
			} else {
				vs.window.showInformationMessage("Inline Text is now OFF");
			}
		};

		// Toggle Inline Text commands for dynamic icon
		safeRegisterCommand(context, "cwtools.toggleInlineTextOn", toggleInlineTextFunc);
		safeRegisterCommand(context, "cwtools.toggleInlineTextOff", toggleInlineTextFunc);

		// GUI Preview command
		safeRegisterCommand(context, "cwtools.previewGUI", async () => {
			const editor = vs.window.activeTextEditor;
			if (!editor) {
				vs.window.showWarningMessage('No active editor to preview');
				return;
			}
			const doc = editor.document;
			const fileName = doc.fileName.toLowerCase();
			if (!fileName.endsWith('.gui')) {
				vs.window.showWarningMessage('GUI Preview is only available for .gui files');
				return;
			}
			await GuiPanel.create(context.extensionPath, doc);
		});

		// Solar System Preview command
		safeRegisterCommand(context, "cwtools.previewSolarSystem", async () => {
			const editor = vs.window.activeTextEditor;
			if (!editor) {
				vs.window.showWarningMessage('No active editor to preview');
				return;
			}
			const doc = editor.document;
			const fileName = doc.fileName.toLowerCase();
			if (!fileName.endsWith('.txt')) {
				vs.window.showWarningMessage('Solar System Preview is only available for .txt files');
				return;
			}
			// Check if file is in solar_system_initializers directory
			const normalizedPath = fileName.replace(/\\/g, '/');
			if (!normalizedPath.includes('solar_system_initializers')) {
				const result = await vs.window.showWarningMessage(
					'This file is not in a solar_system_initializers directory. Preview anyway?',
					'Preview', 'Cancel'
				);
				if (result !== 'Preview') return;
			}
			await SolarSystemPanel.create(context.extensionPath, doc);
		});

		// Event Chain Visualizer command
		safeRegisterCommand(context, "cwtools.visualizeEventChain", async () => {
			const editor = vs.window.activeTextEditor;
			await EventChainPanel.create(context.extensionPath, editor?.document);
		});

		// Tech Tree Visualizer command
		safeRegisterCommand(context, "cwtools.visualizeTechTree", async () => {
			const editor = vs.window.activeTextEditor;
			await TechTreePanel.create(context.extensionPath, editor?.document);
		});

		// Entity Preview command
		safeRegisterCommand(context, "cwtools.previewEntity", async () => {
			const editor = vs.window.activeTextEditor;
			if (!editor) {
				vs.window.showWarningMessage('No active editor to preview');
				return;
			}
			const doc = editor.document;
			const fileName = doc.fileName.toLowerCase();
			if (!fileName.endsWith('.asset')) {
				vs.window.showWarningMessage('Entity Preview is only available for .asset files');
				return;
			}
			await EntityPanel.create(context.extensionPath, doc);
		});

		// Particle Preview command
		safeRegisterCommand(context, "cwtools.previewParticle", async () => {
			const editor = vs.window.activeTextEditor;
			if (!editor) {
				vs.window.showWarningMessage('No active editor to preview');
				return;
			}
			const doc = editor.document;
			const fileName = doc.fileName.toLowerCase();
			if (!fileName.endsWith('.asset')) {
				vs.window.showWarningMessage('Particle Preview is only available for .asset files');
				return;
			}
			const kind = classifyAssetFile(doc.getText());
			if (kind !== 'particle') {
				vs.window.showWarningMessage('This .asset file does not contain a top-level particle definition. It may be an entity asset.');
				return;
			}
			await ParticlePanel.create(context.extensionPath, doc);
		});

		safeRegisterCommand(context, "cwtools.reloadExtension", async () => {
			// Stop the language server client first
			if (defaultClient) {
				try { await defaultClient.stop(); } catch { /* ignore */ }
			}
			// Dispose GUI panel if open
			if (GuiPanel.currentPanel) {
				try { GuiPanel.currentPanel.dispose(); } catch { /* ignore */ }
			}
			if (EntityPanel.currentPanel) {
				try { EntityPanel.currentPanel.dispose(); } catch { /* ignore */ }
			}
			if (ParticlePanel.currentPanel) {
				try { ParticlePanel.currentPanel.dispose(); } catch { /* ignore */ }
			}
			// L7 Fix: dispose the chat panel provider before re-activating so its
			// WebView is closed and callbacks don't reference a stale agentRunner.
			try { chatPanelProvider.dispose(); } catch { /* ignore */ }
			// Dispose all subscriptions
			for (const sub of context.subscriptions) {
				try {
					sub.dispose();
				} catch (e) {
					ErrorReporter.debug('Extension', 'Failed to dispose subscription', e);
				}
			}
			// Clear the array to prevent accumulation
			context.subscriptions.length = 0;
			await activate(context);
		});

		await client.start();
		clientStarted = true;
		updateRulesStatusBar();
		void maybeShowFirstRunExperience(healthOptions());
	}

	let languageId: string;
	const getLanguageIdFallback = async function () {
		const markerFiles = await workspace.findFiles("**/*.txt", '**/{node_modules,.git,.vscode,.vscode-test,.cwtools-ai}/**', 2);
		if (markerFiles.length == 1) {
			 
			return (await workspace.openTextDocument(markerFiles[0]!)).languageId;
		}
		return null;
	}

	let guessedLanguageId: string | undefined | null = window.activeTextEditor?.document?.languageId;
	// CWT files are rule files, opening them shouldn't act as a trigger to activate a specific game context
	if (window.activeTextEditor?.document?.uri.fsPath.toLowerCase().endsWith('.cwt')) {
		guessedLanguageId = null;
	}
	if (!isKnownGameLanguageId(guessedLanguageId)) {
		// The marker-file guess opens a .txt whose languageId can resolve to a
		// game via global associations; only trust it in structured workspaces.
		const detectionRoot = firstWorkspacePath();
		const structuredWorkspace = detectionRoot
			? hasWorkspaceModDescriptor(detectionRoot) || workspaceHasParadoxStructure(detectionRoot)
			: false;
		guessedLanguageId = structuredWorkspace ? await getLanguageIdFallback() : null;
	}

	if (isKnownGameLanguageId(guessedLanguageId)) {
		languageId = guessedLanguageId;
	} else {
		languageId = inferLanguageIdFromWorkspace() ?? "paradox";
	}
	async function findExeInFiles(gameExeName: string, binariesPrefix = false) {
		if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
			return [];
		}

		const root = workspace.workspaceFolders[0]!.uri.fsPath;
		const isWin = os.platform() === "win32";
		const targetDir = binariesPrefix ? path.join(root, "binaries") : root;
		const needle = gameExeName.toLowerCase();
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
		} catch {
			return [];
		}

		const candidates = entries
			.filter(entry => {
				if (!entry.isFile()) return false;
				const name = entry.name.toLowerCase();
				return name.startsWith(needle) && (!isWin || name.endsWith(".exe"));
			})
			.map(entry => path.join(targetDir, entry.name));

		const validFiles = await Promise.all(
			candidates.map(async candidate => (await exe.existAndIsExe(candidate)) ? vs.Uri.file(candidate) : null)
		).then(arr => arr.filter(Boolean));

		return validFiles;
	}
	const games = getGameExeList();

	const promises = games.map(({ exeName, binariesPrefix }) =>
		findExeInFiles(exeName, binariesPrefix)
	);

	const results = await Promise.all(promises);

	let isVanillaFolder = false;

	for (let i = 0; i < results.length; i++) {
		 
		const { id } = games[i]!;
		 
		if (results[i]!.length > 0 && (!isKnownGameLanguageId(languageId) || languageId === id)) {
			isVanillaFolder = true;
			languageId = id;
		}
	}

	if (
		workspace.workspaceFolders &&
		workspace.workspaceFolders.length > 0 &&
		 
		path.basename(workspace.workspaceFolders[0]!.uri.fsPath) === "game"
	) {
		isVanillaFolder = true;
		if (!isKnownGameLanguageId(languageId)) {
			languageId = inferLanguageIdFromWorkspace() ?? languageId;
		}
	}

	// ── Auto-default localization language from VS Code UI language ──
	if (isKnownGameLanguageId(languageId)) {
		await autoDetectLocLanguage(context);
	}

	// ── Mod folder target game selection guidance and auto-association ──
	const workspaceRootPath = workspace.workspaceFolders && workspace.workspaceFolders.length > 0
		? workspace.workspaceFolders[0]!.uri.fsPath
		: undefined;
	const hasModDescriptor = workspaceRootPath ? hasWorkspaceModDescriptor(workspaceRootPath) : false;
	if (hasModDescriptor) {
		if (languageId === "paradox") {
			const gamePromptKey = "stellarisLanguageServices.gamePathPrompted.paradox";
			if (!context.globalState.get<boolean>(gamePromptKey)) {
				void context.globalState.update(gamePromptKey, true);
				void window.showInformationMessage(
					localize(
						'Detected a Mod descriptor in workspace, but the target game type is undetermined. Select your target game platform now?',
						'检测到当前工作区包含 Mod 描述文件，但尚未确定目标游戏类型。是否现在指定你的目标游戏平台？'
					),
					localize('Select Game', '选择游戏'),
					localize('Later', '稍后')
				).then(async (choice) => {
					if (choice === localize('Select Game', '选择游戏')) {
						await selectGameFolderFlow();
					}
				});
			}
		} else if (isKnownGameLanguageId(languageId)) {
			// If the game type was successfully determined (either via scoring or fallback),
			// automatically sync workspace-level file associations so that editor themes/syntax highlights instantly work.
			const filesConfig = workspace.getConfiguration('files');
			const associations = filesConfig.get<Record<string, string>>('associations') || {};
			const extensionsToAssociate = ['*.txt', '*.gui', '*.gfx', '*.asset'];
			let needsUpdate = false;
			const updatedAssociations = { ...associations };
			for (const ext of extensionsToAssociate) {
				if (updatedAssociations[ext] !== languageId) {
					updatedAssociations[ext] = languageId;
					needsUpdate = true;
				}
			}
			if (needsUpdate) {
				void filesConfig.update('associations', updatedAssociations, false);
			}
		}
	}

	// ── Gate the language server on actual Paradox evidence ──
	// `!workspaceRootPath` keeps legacy behavior for single-file windows.
	const looksLikeParadoxWorkspace =
		isVanillaFolder || hasModDescriptor || isKnownGameLanguageId(languageId) || !workspaceRootPath;
	ErrorReporter.debug('Extension', `Startup gate: start=${looksLikeParadoxWorkspace} vanilla=${isVanillaFolder} descriptor=${hasModDescriptor} language=${languageId}`);
	if (looksLikeParadoxWorkspace) {
		await init(languageId, isVanillaFolder);
		return;
	}

	ErrorReporter.debug('Extension', 'No Paradox project detected in this workspace; deferring CWTools language server start');
	let lazyStartPromise: Promise<void> | undefined;
	const lazyListeners: Disposable[] = [];
	const startLazily = (language: string): Promise<void> => {
		lazyStartPromise ??= (async () => {
			for (const listener of lazyListeners) {
				try { listener.dispose(); } catch { /* ignore */ }
			}
			await init(language, isVanillaFolder);
		})();
		return lazyStartPromise;
	};
	const maybeStartForEditor = (editor: vs.TextEditor | undefined) => {
		const doc = editor?.document;
		if (!doc || doc.uri.scheme !== 'file') return;
		// CWT rule files are not evidence of a game workspace.
		if (doc.uri.fsPath.toLowerCase().endsWith('.cwt')) return;
		if (isKnownGameLanguageId(doc.languageId)) {
			void startLazily(doc.languageId);
		} else if (doc.languageId === 'pdx-shader') {
			void startLazily(languageId);
		}
	};
	lazyListeners.push(window.onDidChangeActiveTextEditor(maybeStartForEditor));
	context.subscriptions.push(...lazyListeners);
	maybeStartForEditor(window.activeTextEditor);
	// Bootstrap commands start the server first, then re-dispatch to the real
	// handler registered by init.
	for (const commandId of ['cwtools.openSetup', 'cwtools.runInstallationDoctor', 'cwtools.selectGameFolder']) {
		safeRegisterCommand(context, commandId, async () => {
			await startLazily(languageId);
			await commands.executeCommand(commandId);
		});
	}
}

function normaliseLocLanguageSetting(value: readonly string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value.filter((item): item is string => typeof item === 'string');
}

function sameLocLanguageSetting(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	const left = normaliseLocLanguageSetting(a);
	const right = normaliseLocLanguageSetting(b);
	if (!left || !right || left.length !== right.length) return false;
	return left.every((item, index) => item.trim().toLowerCase() === right[index]!.trim().toLowerCase());
}

function hasLocLanguageSetting(value: readonly string[] | undefined): boolean {
	return value !== undefined;
}

function defaultLocLanguagesForUi(): string[] {
	return isChineseLocale() ? ['Chinese'] : ['English'];
}

/**
 * Chooses the default validation language from the VS Code UI language.
 * Chinese VS Code uses Chinese; every other UI language falls back to English.
 * User-configured values still win over this automatic default.
 */
async function autoDetectLocLanguage(context: ExtensionContext): Promise<void> {
	const config = workspace.getConfiguration('stellarisLanguageServices');
	const inspected = config.inspect<string[]>('localisation.languages');
	const trackedAuto = context.workspaceState.get<AutoDetectedLocLanguageState>(AUTO_DETECTED_LOC_LANGUAGE_KEY);
	const trackedLanguages = trackedAuto?.languages;
	const desiredLanguages = defaultLocLanguagesForUi();

	if (trackedAuto?.disabled) {
		return;
	}

	if (trackedLanguages && sameLocLanguageSetting(inspected?.workspaceValue, trackedLanguages)) {
		if (hasLocLanguageSetting(inspected?.globalValue) || hasLocLanguageSetting(inspected?.workspaceFolderValue)) {
			await config.update('localisation.languages', undefined, vs.ConfigurationTarget.Workspace);
			await context.workspaceState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, undefined);
			ErrorReporter.debug('Extension', 'Cleared auto-managed localisation language so explicit user settings can apply');
			return;
		}

		if (sameLocLanguageSetting(inspected?.workspaceValue, desiredLanguages)) {
			return;
		}

		if (sameLocLanguageSetting(desiredLanguages, ['English'])) {
			await config.update('localisation.languages', undefined, vs.ConfigurationTarget.Workspace);
			await context.workspaceState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, undefined);
			ErrorReporter.debug('Extension', 'Cleared auto-managed localisation language; English is the default for non-Chinese UI');
			return;
		}

		await config.update('localisation.languages', desiredLanguages, vs.ConfigurationTarget.Workspace);
		await context.workspaceState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, { languages: desiredLanguages });
		ErrorReporter.debug('Extension', `Auto-managed localisation language: ${desiredLanguages.join(', ')}`);
		return;
	}

	if (trackedLanguages) {
		await context.workspaceState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, { languages: [], disabled: true });
		return;
	}

	if (
		hasLocLanguageSetting(inspected?.workspaceValue)
		&& hasLocLanguageSetting(inspected?.globalValue)
		&& !sameLocLanguageSetting(inspected?.globalValue, inspected?.workspaceValue)
	) {
		await config.update('localisation.languages', undefined, vs.ConfigurationTarget.Workspace);
		ErrorReporter.debug('Extension', 'Cleared workspace localisation language so the user setting can apply');
		return;
	}

	if (
		hasLocLanguageSetting(inspected?.globalValue)
		|| hasLocLanguageSetting(inspected?.workspaceFolderValue)
	) {
		return;
	}

	if (hasLocLanguageSetting(inspected?.workspaceValue)) {
		return;
	}

	if (sameLocLanguageSetting(desiredLanguages, ['English'])) {
		return;
	}

	await config.update('localisation.languages', desiredLanguages, vs.ConfigurationTarget.Workspace);
	await context.workspaceState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, { languages: desiredLanguages });
	ErrorReporter.debug('Extension', `Auto-managed localisation language: ${desiredLanguages.join(', ')}`);
	return;
}

export async function reloadExtension(prompt: string, buttonText?: string, force?: boolean) {
	const restartAction = buttonText || "Restart";
	const actions = [restartAction];
	if (force) {
		window.showInformationMessage(prompt);
		await commands.executeCommand("cwtools.reloadExtension");
	}
	else {
		const chosenAction = prompt && await window.showInformationMessage(prompt, ...actions);
		if (!prompt || chosenAction === restartAction) {
			await commands.executeCommand("cwtools.reloadExtension");
		}
	}
}
// export default defaultClient;

/**
 * Auto-detect a Paradox game's vanilla installation path by scanning
 * Steam library folders (Windows registry + libraryfolders.vdf) and
 * common non-Steam install locations.
 *
 * @param steamFolderName - The game's folder name under steamapps/common/ (e.g. "Stellaris")
 * @param subdir - Optional subdirectory containing the actual game data (e.g. "game" for CK3/VIC3)
 * @returns The validated game data path, or undefined if not found
 */
async function autoDetectGamePath(steamFolderName: string, subdir?: string): Promise<string | undefined> {
	try {
		const steamLibraries = getSteamLibraryPaths();

		// Check each Steam library for the game
		for (const lib of steamLibraries) {
			const gamePath = path.join(lib, 'steamapps', 'common', steamFolderName);
			const dataPath = subdir ? path.join(gamePath, subdir) : gamePath;
			if (fs.existsSync(path.join(dataPath, 'common'))) {
				return dataPath;
			}
		}

		// Also try alternative folder names (some games have variant names)
		const altNames = getAlternativeSteamFolderNames(steamFolderName);
		for (const altName of altNames) {
			for (const lib of steamLibraries) {
				const gamePath = path.join(lib, 'steamapps', 'common', altName);
				const dataPath = subdir ? path.join(gamePath, subdir) : gamePath;
				if (fs.existsSync(path.join(dataPath, 'common'))) {
					return dataPath;
				}
			}
		}
	} catch (e) {
		ErrorReporter.debug('Extension', 'Auto-detect game path failed', e);
	}
	return undefined;
}

/**
 * Get all Steam library folder paths by reading the Steam installation
 * directory from the registry (Windows) or known paths (macOS/Linux),
 * then parsing libraryfolders.vdf for additional library locations.
 */
function getSteamLibraryPaths(): string[] {
	const libraries: string[] = [];

	let steamPath: string | undefined;

	if (os.platform() === 'win32') {
		// Try reading Steam path from Windows registry
		try {
			const cp = require('child_process');
			// Try HKLM WOW6432Node first (most common on 64-bit Windows)
			for (const regKey of [
				'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam',
				'HKLM\\SOFTWARE\\Valve\\Steam',
			]) {
				try {
					const result = cp.execSync(
						`reg query "${regKey}" /v InstallPath`,
						{ encoding: 'utf8', timeout: 3000, windowsHide: true }
					);
					const match = result.match(/InstallPath\s+REG_SZ\s+(.+)/);
					if (match?.[1]) {
						steamPath = match[1].trim();
						break;
					}
				} catch { /* try next key */ }
			}
		} catch { /* registry not available */ }

		// Fallback: check common Windows Steam paths
		if (!steamPath) {
			const candidates = [
				'C:\\Program Files (x86)\\Steam',
				'C:\\Program Files\\Steam',
				'D:\\Steam',
				'D:\\SteamLibrary',
			];
			for (const c of candidates) {
				if (fs.existsSync(path.join(c, 'steam.exe')) || fs.existsSync(path.join(c, 'steamapps'))) {
					steamPath = c;
					break;
				}
			}
		}
	} else if (os.platform() === 'darwin') {
		const macPath = path.join(os.homedir(), 'Library', 'Application Support', 'Steam');
		if (fs.existsSync(macPath)) steamPath = macPath;
	} else {
		// Linux
		const linuxPaths = [
			path.join(os.homedir(), '.steam', 'steam'),
			path.join(os.homedir(), '.local', 'share', 'Steam'),
		];
		for (const lp of linuxPaths) {
			if (fs.existsSync(lp)) { steamPath = lp; break; }
		}
	}

	if (steamPath) {
		libraries.push(steamPath);

		// Parse libraryfolders.vdf for additional library paths
		const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
		if (fs.existsSync(vdfPath)) {
			try {
				const content = fs.readFileSync(vdfPath, 'utf8');
				// Match "path" entries: "path"		"D:\\SteamLibrary"
				const pathRegex = /"path"\s+"([^"]+)"/g;
				let match;
				while ((match = pathRegex.exec(content)) !== null) {
					const libPath = match[1]!.replace(/\\\\/g, '\\');
					if (!libraries.includes(libPath) && fs.existsSync(libPath)) {
						libraries.push(libPath);
					}
				}
			} catch {
				// VDF parse failure is non-critical
			}
		}
	}

	return libraries;
}

