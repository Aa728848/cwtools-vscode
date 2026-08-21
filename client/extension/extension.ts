/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import { localize, isChineseLocale } from './panelI18n';
import * as os from 'os';
import * as fs from 'fs';
import * as vs from 'vscode';
import { workspace, ExtensionContext, window, Disposable, Uri, WorkspaceEdit, TextEdit, Range, commands } from 'vscode';
import { LanguageClient, LanguageClientOptions, NotificationType, RevealOutputChannelOn, State } from 'vscode-languageclient/node';

import { FileExplorer, FileListItem } from './fileExplorer';
import { GuiPanel } from './guiPanel';
import { EntityPanel } from './entityPanel';
import { ParticlePanel } from './particlePanel';
import { classifyAssetFile } from './particleSniff';
import { UI, SOURCE, aiText, setAiMessageLocale } from './ai/messages';
import { ErrorReporter } from './ai/errorReporter';
import { SolarSystemPanel } from './solarSystemPanel';
import { openStaticGalaxyPreview, registerStaticGalaxyEditor } from './staticGalaxyEditorProvider';
import { EventChainPanel } from './eventChainPanel';
import { TechTreePanel } from './techTreePanel';
import * as exe from './executable';
import { registerLocalizationFeatures } from './locDecorations';
import { AIService, AgentToolExecutor, AgentRunner, PromptBuilder, AIChatPanelProvider, AIInlineCompletionProvider, UsageTracker } from './ai';
import { lastAISettingsWriteTime } from './ai/chatSettings';
import { checkForUpdates } from './updateChecker';
import { registerCodeActions } from './codeActions';
import { enrichDiagnosticsInPlace, diagnosticCodeString, diagnosticMatchesIgnoredKey, filterLocalisationDiagnostics, foldLocalisationWarnings, foldRelatedCallSiteInformation } from './diagnosticI18n';
import type { LocalisationDiagnosticFilterMode } from './diagnosticI18n';
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
import { formatMemDiagEntry, memDiagLanguageForLocale } from './memDiagFormatter';
import { configurePrivateAgentStorage, configureWorkspaceCacheStorage, getProjectWorkspaceRoot, getPrivateAiStorageRoot, migrateLegacyAiStorageRoot, migrateLegacyPrivateAgentState } from './ai/workspacePaths';
import { configureHistoryPolicy, enforceHistoryRetention } from './ai/runner/historyPolicy';
import { TokenCalibrationTable, readCalibrationSnapshot } from './ai/runner/tokenCalibration';
import { sha256Text } from './ai/runner/durableStorage';
import { processRegistry } from './ai/runner/processRegistry';
import { getAllLanguageIds, getAllProfiles, getCacheSettingKey, getKnownProfileByLanguageId, getProfileByLanguageId, getRulesRemoteUrl, getGameExeList, getGameFolderMapping, getAlternativeSteamFolderNames } from './gameProfiles';
import { IndexService, type WorkspaceSymbolEntry } from './indexing/indexService';
import { McpBridgeServer } from './ai/mcpBridgeServer';
import { maybePromptForDefaultDarkModernTheme } from './themePrompt';
import { registerProjectKnowledgeWatcher, resumeStaleProjectKnowledgeRefreshes } from './ai/projectKnowledge';
import { repairMovedAgentWorktrees } from './ai/orchestrator/worktreeManager';
import { QuickPickSelectionGuard } from './quickPickSelectionGuard';
import { getDefaultLocalisationLanguagesForUiLocale } from './localisationLanguagePreference';
import { handleVanillaCacheGenerated } from './vanillaCacheLifecycle';
import { parseWorkshopContentAppId, getGameIdForWorkshopAppId } from './workshopDetection';
import { inferGameIdFromWorkspace, hasWorkspaceModDescriptor, workspaceHasParadoxStructure as workspaceHasParadoxStructureDetect } from './workspaceGameDetection';
import { LspFeaturePriorityGate } from './lspFeaturePriority';
import { LspPerformanceStats, type ValidationDiagnosticCounts } from './lspPerformanceStats';
import { DirectoryCompletionCommand } from './directoryCompletionCommand';
import { LanguageServerProcessController, ManagedLanguageClient } from './languageServerProcess';
import {
	CWT_LANGUAGE_ID,
	determineServerStartMode,
	getLanguageClientDocumentSelector,
	isCwtDocument,
	isCwtFilePath,
	shouldRequestLanguageServerSemanticTokens,
	type ServerStartMode,
} from './languageSelectors';
import { createLocalisationWordPattern, LOCALISATION_WORD_PATTERN_LANGUAGE_IDS } from './localisationWordPattern';

export let defaultClient: LanguageClient;

export interface CwtoolsExtensionApi {
	/** Returns the LanguageClient owned by the activated Extension Host instance. */
	getLanguageClient(): LanguageClient | undefined;
}

const extensionApi: CwtoolsExtensionApi = {
	getLanguageClient: () => defaultClient,
};

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

function workspaceHasParadoxStructure(rootPath: string): boolean {
	return workspaceHasParadoxStructureDetect(rootPath, getConfiguredGamePath);
}

function inferLanguageIdFromWorkspace(): string | undefined {
	const rootPath = firstWorkspacePath();
	if (!rootPath) return undefined;
	return inferGameIdFromWorkspace(rootPath, getConfiguredGamePath);
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

async function selectGameFolderFlow(languageHint?: string, context?: ExtensionContext): Promise<boolean> {
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
			if (retry === localize('Choose Again', '重新选择')) return selectGameFolderFlow(languageId, context);
			return false;
		}
		languageId = resolved.languageId;
		selectedPath = resolved.dataPath;
	}

	const finalProfile = getProfileByLanguageId(languageId);
	await workspace.getConfiguration('stellarisLanguageServices').update(getCacheSettingKey(languageId), selectedPath, true);

	// Offer workspace-level file associations to enable language themes/validation.
	if (context) {
		await syncWorkspaceFileAssociations(context, languageId);
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
					'No active CWTools rules were found. latest/stable use the bundled fallback automatically after a remote update failure. manual needs a local rules folder.',
					'未找到当前可用的 CWTools 规则。latest/stable 在远程更新失败后会自动使用内置备用规则；manual 需要本地规则目录。'
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
				await selectGameFolderFlow(options.languageId, options.context);
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
			await selectGameFolderFlow(options.languageId, options.context);
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

	const workspaceRoot = getProjectWorkspaceRoot();
	const aiStorageMigration = migrateLegacyAiStorageRoot(workspaceRoot);
	if (aiStorageMigration.migrated) {
		ErrorReporter.debug(
			'Extension',
			`Migrated AI workspace storage to ${aiStorageMigration.primaryRoot} (${aiStorageMigration.movedEntries} moved, ${aiStorageMigration.resolvedConflicts} conflicts kept from .cwtools, obsolete knowledge removed: ${aiStorageMigration.obsoleteKnowledgeRemoved})`,
		);
		await repairMovedAgentWorktrees(workspaceRoot).catch(error =>
			ErrorReporter.warn('Extension', 'Failed to repair Agent worktrees after AI storage migration', error)
		);
	}

	const indexService = new IndexService({
		extensionPath: context.extensionPath,
		globalStoragePath: context.globalStorageUri.fsPath,
		onVanillaSymbolCacheGenerated: event => window.showInformationMessage(
			event.kind === 'created'
				? localize(
					`CWTools: ${displayGameName(event.gameId)} vanilla symbol database generated (${event.indexedFiles} files).`,
					`CWTools：${displayGameName(event.gameId)} 原版符号数据库已生成（${event.indexedFiles} 个文件）。`,
				)
				: localize(
					`CWTools: ${displayGameName(event.gameId)} vanilla symbol database rebuilt (${event.indexedFiles} files).`,
					`CWTools：${displayGameName(event.gameId)} 原版符号数据库已重新生成（${event.indexedFiles} 个文件）。`,
				),
		),
	});
	context.subscriptions.push(indexService);
	void indexService.start();
	registerProjectKnowledgeWatcher(context, indexService);

	// Register localization enhancements (§ color highlighting, $REF$ hover/goto).
	// Keep the custom word pattern scoped to the dedicated localisation language;
	// overriding VS Code's shared yaml configuration would affect unrelated YAML.
	for (const language of LOCALISATION_WORD_PATTERN_LANGUAGE_IDS) {
		context.subscriptions.push(vs.languages.setLanguageConfiguration(language, {
			wordPattern: createLocalisationWordPattern(),
		}));
	}
	registerLocalizationFeatures(context, indexService);
	registerIndexedWorkspaceSymbols(context, indexService);
	registerParadoxCsvFeatures(context);
	registerRelatedResourceFeatures(context, indexService);
	registerInspectionOverviewCommand(context);
	new DirectoryCompletionCommand(() => defaultClient).register(context);

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

	const gameLanguages = [...getAllLanguageIds(), 'paradox'];

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

	// The MCP server moved to the standalone cwtools-mcp package (npx -y cwtools-mcp)
	// and is no longer bundled or synced to globalStorage. Copies synced by older
	// versions still work: the bridge manifest protocol below is unchanged.
	// ─── AI Module Integration (registered at top-level so panel works immediately) ──
	const aiService = new AIService(context);
	// Retire the legacy global endpoint into the per-provider map early so quick-switching
	// providers before opening settings cannot leak one provider's endpoint into another.
	void aiService.migrateLegacyEndpoint();
	const privateAgentRoot = context.storageUri?.fsPath
		?? path.join(context.globalStorageUri.fsPath, 'agent-workspaces', sha256Text(workspaceRoot || 'empty-window').slice(0, 16));
	configurePrivateAgentStorage(privateAgentRoot);
	// Regenerable per-workspace caches (symbol index) live in extension storage,
	// never in the project tree.
	configureWorkspaceCacheStorage(privateAgentRoot);
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
	const toolExecutor = new AgentToolExecutor(() => defaultClient, workspaceRoot, indexService, context.globalStorageUri.fsPath, context.extensionPath, aiService.getKeyManager());
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
	// Real-usage token calibration (P0 design 3): created before the Runner and
	// injected; persisted snapshots are validated field-by-field on load and
	// written single-flight by the table itself.
	const tokenCalibration = new TokenCalibrationTable(
		readCalibrationSnapshot(context.globalState.get('cwtools.ai.tokenCalibration.v1')),
		snapshot => Promise.resolve(context.globalState.update('cwtools.ai.tokenCalibration.v1', snapshot)),
		error => ErrorReporter.warn('TokenCalibration', 'Failed to persist token calibration data', error),
	);
	context.subscriptions.push({ dispose: () => { void tokenCalibration.flush(); } });
	const agentRunner = new AgentRunner(aiService, toolExecutor, promptBuilder, tokenCalibration);
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

			const origSnap = await runLedger.getOrLoadSnapshot(pick.runId);
			const newSnap = await runLedger.getOrLoadSnapshot(result.newRun.runId);
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
	toolExecutor.onTodoUpdate = (todos, scope) =>
		chatPanelProvider.sendTodoUpdate(todos, scope);
	// Sync fileWriteMode from config on startup
	toolExecutor.fileWriteMode = workspace.getConfiguration('stellarisLanguageServices.ai').get<'confirm' | 'auto'>('agentFileWriteMode', 'auto');
	// Re-sync fileWriteMode whenever config changes
	context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('stellarisLanguageServices.ai.agentFileWriteMode')) {
			toolExecutor.fileWriteMode = workspace.getConfiguration('stellarisLanguageServices.ai').get<'confirm' | 'auto'>('agentFileWriteMode', 'auto');
		}
		if (e.affectsConfiguration('stellarisLanguageServices.rules_version')
			|| e.affectsConfiguration('stellarisLanguageServices.rules_folder')
			|| e.affectsConfiguration('stellarisLanguageServices.rules_remote_url')) {
			scheduleProjectMemoryInvalidation();
		}
	}));
	// Invalidate LSP read cache on document changes so AI doesn't base decisions on stale data
	context.subscriptions.push(workspace.onDidChangeTextDocument(e => {
		toolExecutor.invalidateCacheForFile(e.document.uri.fsPath);
	}));
	// Closed files can be changed by Git, external editors, generators, or agent
	// commands without producing onDidChangeTextDocument. Keep query-only semantic
	// graph caches coherent with those file-system mutations as well.
	const aiSemanticWatcher = workspace.createFileSystemWatcher('**/*.{txt,gui,yml,csv,gfx,asset,cwt,entity,shader,fxh}');
	let aiMemoryInvalidationTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleProjectMemoryInvalidation = () => {
		if (aiMemoryInvalidationTimer) clearTimeout(aiMemoryInvalidationTimer);
		aiMemoryInvalidationTimer = setTimeout(() => {
			aiMemoryInvalidationTimer = undefined;
			promptBuilder.markProjectMemoryStale();
		}, 250);
	};
	const invalidateAiSemanticInputs = (uri: vs.Uri) => {
		toolExecutor.invalidateCacheForFile(uri.fsPath);
		scheduleProjectMemoryInvalidation();
	};
	context.subscriptions.push(
		{ dispose: () => {
			if (aiMemoryInvalidationTimer) clearTimeout(aiMemoryInvalidationTimer);
		} },
		aiSemanticWatcher,
		aiSemanticWatcher.onDidChange(invalidateAiSemanticInputs),
		aiSemanticWatcher.onDidCreate(invalidateAiSemanticInputs),
		aiSemanticWatcher.onDidDelete(invalidateAiSemanticInputs),
	);
	// Frozen system prompts key on CWTOOLS.md / project profile content hashes,
	// so they miss naturally on edit; this watcher proactively drops the parsed
	// mtime caches so the next fingerprint reflects current content immediately
	// (plan §7.1).
	const aiPromptInputsWatcher = workspace.createFileSystemWatcher('{CWTOOLS.md,.cwtools/project/profile.json,.cwtools-ai/project/profile.json}');
	const invalidatePromptInputs = () => {
		promptBuilder.invalidateProjectPromptInputs();
		scheduleProjectMemoryInvalidation();
	};
	context.subscriptions.push(
		aiPromptInputsWatcher,
		aiPromptInputsWatcher.onDidChange(invalidatePromptInputs),
		aiPromptInputsWatcher.onDidCreate(invalidatePromptInputs),
		aiPromptInputsWatcher.onDidDelete(invalidatePromptInputs),
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
	registerStaticGalaxyEditor(context);
	registerGraphicsFeatures(context);
	registerImageTools(context);

	// ── Vanilla Code Comparison: block-level and file-level diff against vanilla game ──
	registerVanillaCompare(context);
	registerPdxIndentFormatter(context);

	const init = async function (language: string, isVanillaFolder: boolean, mode: ServerStartMode = 'full') {
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
			refreshRules: async () => {
				if (!defaultClient) return;
				await defaultClient.restart();
			},
		}));
		registerSpecialPathCommands(context, () => ({
			languageId: language,
			cacheDir,
			bundledRulesPath,
			globalStoragePath: context.globalStorageUri.fsPath,
			getSteamLibraryPaths,
		}));

		const cwtOnly = mode === 'cwt-only';
		// Game-specific watchers (script/gfx/localisation) only make sense in
		// full mode; CWT-only watches rule files for the Phase 3 project index.
		const fileEvents = cwtOnly
			? [workspace.createFileSystemWatcher('**/*.cwt')]
			: (() => {
				const activeProfile = getProfileByLanguageId(language);
				const globAlternatives = (values: string[]) => values.length === 1 ? values[0]! : `{${values.join(',')}}`;
				const scriptDirectories = globAlternatives(Array.from(new Set(activeProfile.folders.scriptDirs)).sort());
				const guiDirectories = globAlternatives(Array.from(new Set(activeProfile.folders.guiDirs)).sort());
				const gfxDirectories = globAlternatives(Array.from(new Set(activeProfile.folders.gfxDirs)).sort());
				const localisationDirectories = globAlternatives(Array.from(new Set(activeProfile.localisation.directories)).sort());
				const localisationExtensions = globAlternatives(Array.from(new Set(activeProfile.localisation.fileExtensions)).sort());
				return [
					workspace.createFileSystemWatcher(`**/${scriptDirectories}/**/*.txt`),
					workspace.createFileSystemWatcher(`**/${guiDirectories}/**/*.gui`),
					workspace.createFileSystemWatcher(`**/${gfxDirectories}/**/*.gfx`),
					workspace.createFileSystemWatcher("**/gfx/**/*.{shader,fxh}"),
					workspace.createFileSystemWatcher("**/{interface}/**/*.sfx"),
					workspace.createFileSystemWatcher("**/{interface,gfx,fonts,music,sound}/**/*.asset"),
					workspace.createFileSystemWatcher(`**/${localisationDirectories}/**/*.${localisationExtensions}`),
				];
			})();
		const editorFeaturePriority = new LspFeaturePriorityGate();
		const monitorLogChannel = window.createOutputChannel('MemDiag');
		const monitorLogLanguage = memDiagLanguageForLocale(vs.env.language);
		const appendMemDiagEntry = (entry: { category?: string; message: string; timestamp?: string }) => {
			const fallbackTimestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
			for (const line of formatMemDiagEntry(entry, fallbackTimestamp, monitorLogLanguage)) {
				monitorLogChannel.appendLine(line);
			}
		};
		const lspPerformanceStats = new LspPerformanceStats(appendMemDiagEntry);
		context.subscriptions.push(monitorLogChannel);
		const editorFeaturesConfiguration = () => workspace.getConfiguration('stellarisLanguageServices.editor');
		const backgroundFeatureDelay = () =>
			Math.max(0, editorFeaturesConfiguration().get<number>('backgroundFeaturesDelayMs', 250));
		const waitForBackgroundFeature = async (token: vs.CancellationToken) =>
			editorFeaturePriority.waitForBackgroundSlot(backgroundFeatureDelay(), token);
		const runBackgroundFeature = async <T>(
			token: vs.CancellationToken,
			dispatch: (backgroundToken: vs.CancellationToken) => Thenable<T> | T,
		): Promise<T | undefined> => {
			if (!await waitForBackgroundFeature(token)) return undefined;
			const backgroundCancellation = new vs.CancellationTokenSource();
			const originalCancellation = token.onCancellationRequested(() => backgroundCancellation.cancel());
			const stopTracking = editorFeaturePriority.trackBackgroundCancellation(() => backgroundCancellation.cancel());
			try {
				return await dispatch(backgroundCancellation.token);
			} finally {
				stopTracking();
				originalCancellation.dispose();
				backgroundCancellation.dispose();
			}
		};

		// Options to control the language client
		const clientOptions: LanguageClientOptions = {
			// Register the server for F# documents
			documentSelector: getLanguageClientDocumentSelector(),
			synchronize: {
				// Synchronize extension settings to the language server.
				configurationSection: 'stellarisLanguageServices',
				// Notify the server about file changes to F# project files contain in the workspace

				fileEvents: fileEvents
			},
			middleware: {
				provideCompletionItem: async (document, position, context, token, next) => {
					editorFeaturePriority.prioritiseCompletion(backgroundFeatureDelay());
					const statsRequest = lspPerformanceStats.beginCompletion({
						file: workspace.asRelativePath(document.uri, false),
						line: position.line,
						character: position.character,
						triggerKind: context.triggerKind,
						triggerCharacter: context.triggerCharacter,
					});
					try {
						const result = await next(document, position, context, token);
						const itemCount = Array.isArray(result) ? result.length : result?.items.length ?? 0;
						lspPerformanceStats.finishCompletion(statsRequest, token.isCancellationRequested
							? { status: 'cancelled', itemCount }
							: { status: 'success', itemCount });
						return result;
					} catch (error) {
						lspPerformanceStats.finishCompletion(statsRequest, token.isCancellationRequested
							? { status: 'cancelled' }
							: { status: 'error', error });
						throw error;
					}
				},
				provideCodeLenses: async (document, token, next) => {
					if (!editorFeaturesConfiguration().get<boolean>('codeLens.enabled', true)) return [];
					return (await runBackgroundFeature(token, backgroundToken => next(document, backgroundToken))) ?? [];
				},
				provideDocumentSemanticTokens: async (document, token, next) => {
					if (!editorFeaturesConfiguration().get<boolean>('semanticHighlighting.enabled', true)) return undefined;
					if (!shouldRequestLanguageServerSemanticTokens(document)) return undefined;
					return runBackgroundFeature(token, backgroundToken => next(document, backgroundToken));
				},
				provideDocumentSemanticTokensEdits: async (document, previousResultId, token, next) => {
					if (!editorFeaturesConfiguration().get<boolean>('semanticHighlighting.enabled', true)) return undefined;
					if (!shouldRequestLanguageServerSemanticTokens(document)) return undefined;
					return runBackgroundFeature(token, backgroundToken => next(document, previousResultId, backgroundToken));
				},
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
					const errorsConfig = workspace.getConfiguration('stellarisLanguageServices.errors');
					const ignored = config.get<string[]>('ignoredDiagnostics', []);
					let result = diagnostics;
					const localisationFilter = errorsConfig.get<LocalisationDiagnosticFilterMode>('localisationFilter', 'off');
					if (localisationFilter !== 'off') {
						// "problems" keeps the server-side diagnostic state intact; "all"
						// is filtered here as well so the panel updates before its reload finishes.
						result = filterLocalisationDiagnostics(result);
					}
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
					if (errorsConfig.get<boolean>('foldLocalisationWarnings', true)) {
						result = foldLocalisationWarnings(result, uri, vs.env.language.startsWith('zh'));
					}
					if (errorsConfig.get<boolean>('foldRelatedCallSiteInformation', true)) {
						result = foldRelatedCallSiteInformation(result, vs.env.language.startsWith('zh'));
					}
					next(uri, result);
					const counts: ValidationDiagnosticCounts = {
						diagnostics: diagnostics.length,
						publishedDiagnostics: result.length,
						errors: diagnostics.filter(diagnostic => diagnostic.severity === vs.DiagnosticSeverity.Error).length,
						warnings: diagnostics.filter(diagnostic => diagnostic.severity === vs.DiagnosticSeverity.Warning).length,
						information: diagnostics.filter(diagnostic => diagnostic.severity === vs.DiagnosticSeverity.Information).length,
						hints: diagnostics.filter(diagnostic => diagnostic.severity === vs.DiagnosticSeverity.Hint).length,
					};
					lspPerformanceStats.recordValidationPublication(uri.toString(), counts);
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

		const processController = new LanguageServerProcessController({
			command: serverExe,
			cwd: workspaceRoot,
			onEvent: event => {
				appendMemDiagEntry({
					category: 'Lifecycle',
					timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
					message: [
						'ClientServerProcess',
						`stage=${event.stage}`,
						event.pid === undefined ? undefined : `pid=${event.pid}`,
						event.instanceId ? `instance=${event.instanceId}` : undefined,
						event.code === undefined ? undefined : `code=${event.code}`,
						event.signal === undefined ? undefined : `signal=${event.signal}`,
						event.reason ? `reason=${event.reason}` : undefined,
					].filter((value): value is string => value !== undefined).join(' '),
				});
			},
		});
		const client = new ManagedLanguageClient('cwtools', 'Paradox Language Server', processController, clientOptions);
		defaultClient = client;
		client.registerProposedFeatures();
		interface loadingBarParams { enable: boolean; value: string; percentage?: number }
		const loadingBarNotification = new NotificationType<loadingBarParams>('loadingBar');
		interface debugStatusBarParams { enable: boolean; value: string }
		const debugStatusBarParamsNotification = new NotificationType<debugStatusBarParams>('debugBar');
		interface CreateVirtualFile { uri: string; fileContent: string }
		const createVirtualFile = new NotificationType<CreateVirtualFile>('createVirtualFile');
		const promptReload = new NotificationType<string>('promptReload')
		const forceReload = new NotificationType<string>('forceReload')
		const vanillaCacheGenerated = new NotificationType<unknown>('vanillaCacheGenerated')
		const serverReady = new NotificationType<unknown>('cwtools/serverReady')
		const promptVanillaPath = new NotificationType<string>('promptVanillaPath')
		interface DidFocusFile { uri: string }
		const didFocusFile = new NotificationType<DidFocusFile>('didFocusFile')
		let status: Disposable | undefined;
		interface UpdateFileList { fileList: FileListItem[] }
		const updateFileList = new NotificationType<UpdateFileList>('updateFileList');
		interface MonitorLogParams { category?: string; message: string; timestamp?: string }
		const monitorLogNotification = new NotificationType<MonitorLogParams>('monitorLog');
		const validationCompleteNotification = new NotificationType<unknown>('cwtools/validationComplete');
		interface CompletionRefreshParams { uri: string; line: number; character: number; version: number }
		const completionRefreshNotification = new NotificationType<CompletionRefreshParams>('completionRefresh');

		async function didChangeActiveTextEditor(editor: vs.TextEditor | undefined): Promise<void> {
			if (editor) {
				const path = editor.document.uri.toString();
				if (languageId == "paradox" && editor.document.languageId == "plaintext") {
					await vs.languages.setTextDocumentLanguage(editor.document, "paradox")
				}
				if (editor.document.languageId == language
					|| (language == CWT_LANGUAGE_ID && isCwtFilePath(editor.document.fileName))) {
					await client.sendNotification(didFocusFile, { uri: path });
				}
			}
		}

		context.subscriptions.push(window.onDidChangeActiveTextEditor(didChangeActiveTextEditor));

		const trackedValidationLanguages = new Set([
			'paradox', 'yaml', 'stellaris', 'hoi4', 'eu4', 'ck2', 'imperator',
			'vic2', 'vic3', 'ck3', 'eu5', 'pdx-shader',
		]);
		const recordValidationTrigger = (document: vs.TextDocument, trigger: 'open' | 'change' | 'save') => {
			if (document.uri.scheme !== 'file' || !trackedValidationLanguages.has(document.languageId)) return;
			lspPerformanceStats.recordValidationTrigger({
				uri: document.uri.toString(),
				file: workspace.asRelativePath(document.uri, false),
				version: document.version,
				trigger,
			});
		};
		context.subscriptions.push(
			workspace.onDidOpenTextDocument(document => recordValidationTrigger(document, 'open')),
			workspace.onDidChangeTextDocument(event => {
				if (event.contentChanges.length > 0) recordValidationTrigger(event.document, 'change');
			}),
			workspace.onDidSaveTextDocument(document => recordValidationTrigger(document, 'save')),
			workspace.onDidCloseTextDocument(document => lspPerformanceStats.forgetValidation(document.uri.toString())),
		);
		for (const document of workspace.textDocuments) recordValidationTrigger(document, 'open');

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
			if (!param || typeof param.message !== 'string') {
				ErrorReporter.warn('MemDiag', 'Ignored invalid monitorLog notification');
				return;
			}
			const timestamp = typeof param.timestamp === 'string'
				? param.timestamp
				: new Date().toLocaleTimeString('en-US', { hour12: false });
			const entry = {
				message: param.message,
				category: typeof param.category === 'string' ? param.category : undefined,
				timestamp,
			};
			appendMemDiagEntry(entry);
		})
		client.onNotification(validationCompleteNotification, (param: unknown) => {
			if (
				typeof param !== 'object'
				|| param === null
				|| !('uri' in param)
				|| typeof param.uri !== 'string'
				|| !('documentVersion' in param)
				|| typeof param.documentVersion !== 'number'
				|| !Number.isInteger(param.documentVersion)
				|| !('phase' in param)
				|| (param.phase !== 'shallow-complete' && param.phase !== 'deep-complete')
			) {
				ErrorReporter.warn('MemDiag', 'Ignored invalid validationComplete notification');
				return;
			}
			lspPerformanceStats.finishValidation(param.uri, param.documentVersion, param.phase);
		});
		client.onNotification(completionRefreshNotification, (param: CompletionRefreshParams) => {
			setTimeout(() => {
				const editor = window.activeTextEditor;
				if (!editor) return;
				const currentPath = path.resolve(editor.document.uri.fsPath);
				const refreshPath = path.resolve(vs.Uri.parse(param.uri).fsPath);
				const sameDocument = process.platform === 'win32'
					? currentPath.toLowerCase() === refreshPath.toLowerCase()
					: currentPath === refreshPath;
				if (!sameDocument) return;
				if (param.version >= 0 && editor.document.version !== param.version) return;
				const cursor = editor.selection.active;
				if (cursor.line !== param.line || cursor.character !== param.character) return;
				void commands.executeCommand('editor.action.triggerSuggest');
			}, 25);
		});

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
		// The rules-source status bar is game-mode only; CWT-only mode does not
		// load game rules and must not report them as "missing".
		if (!cwtOnly) {
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
		} else {
			rulesStatusBar.dispose();
		}
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
		client.onNotification(vanillaCacheGenerated, async (param: unknown) => {
			await handleVanillaCacheGenerated(param, {
				refreshVanillaSymbols: gameIds => indexService.refreshVanillaSymbols(gameIds),
				showInformationMessage: message => window.showInformationMessage(message),
				reloadWindow: () => commands.executeCommand('workbench.action.reloadWindow'),
				debug: message => ErrorReporter.debug('VanillaCache', message),
				warn: (message, error) => ErrorReporter.warn('VanillaCache', message, error),
			});
		})
		client.onNotification(serverReady, () => {
			resumeStaleProjectKnowledgeRefreshes(indexService);
		})
		client.onNotification(promptVanillaPath, async (param: string) => {
			await selectGameFolderFlow(param, context);
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
		context.subscriptions.push({
			dispose: () => {
				void client.stop().catch(error =>
					ErrorReporter.warn('Extension', 'Failed to stop CWTools language client during disposal', error)
				);
			},
		});
		context.subscriptions.push(client.onDidChangeState(event => {
			appendMemDiagEntry({
				category: 'Lifecycle',
				timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
				message: `LanguageClientState old=${State[event.oldState]} new=${State[event.newState]}`,
			});
		}));

		safeRegisterCommand(context, "cwtools.openSetup", async () => {
			await showSetupPanel(healthOptions());
		});

		safeRegisterCommand(context, "cwtools.runInstallationDoctor", async () => {
			await showSetupPanel(healthOptions());
		});

		safeRegisterCommand(context, "cwtools.selectGameFolder", async () => {
			await selectGameFolderFlow(language, context);
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

		// Static Galaxy Preview/Edit command (also reachable via explorer/editor context menus)
		safeRegisterCommand(context, "cwtools.previewStaticGalaxy", async (target?: vs.Uri) => {
			await openStaticGalaxyPreview(target);
		});

		// Event Chain Visualizer command
		safeRegisterCommand(context, "cwtools.visualizeEventChain", async () => {
			const editor = vs.window.activeTextEditor;
			await EventChainPanel.create(
				context.extensionPath,
				editor?.document,
				editor ? editor.selection.active.line + 1 : undefined,
			);
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
		safeRegisterCommand(context, "cwtools.entityPreview.undo", () => {
			EntityPanel.currentPanel?.undo();
		});
		safeRegisterCommand(context, "cwtools.entityPreview.redo", () => {
			EntityPanel.currentPanel?.redo();
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
		context.subscriptions.push(workspace.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration('stellarisLanguageServices.errors.localisationFilter')) return;
			const mode = workspace.getConfiguration('stellarisLanguageServices.errors')
				.get<LocalisationDiagnosticFilterMode>('localisationFilter', 'off');
			if (mode === 'off') return;
			client.diagnostics?.forEach((uri, diagnostics) => {
				client.diagnostics?.set(uri, filterLocalisationDiagnostics(diagnostics));
			});
		}));
		if (!cwtOnly) {
			updateRulesStatusBar();
			void maybeShowFirstRunExperience(healthOptions());
		}
	}

	let languageId: string;
	const getLanguageIdFallback = async function () {
		const markerFiles = await workspace.findFiles("**/*.txt", '**/{node_modules,.git,.vscode,.vscode-test,.cwtools,.cwtools-ai}/**', 2);
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

	// ── Steam Workshop workspace gate ──
	// Workshop mods live under steamapps/workshop/content/<appId>/<itemId>.
	// The App ID is the most reliable identification signal, and users should
	// opt in before CWTools starts (and potentially writes) inside a workshop
	// folder that Steam manages and may overwrite.
	const workspaceRootPath = workspace.workspaceFolders && workspace.workspaceFolders.length > 0
		? workspace.workspaceFolders[0]!.uri.fsPath
		: undefined;
	const workshopAppId = workspaceRootPath ? parseWorkshopContentAppId(workspaceRootPath) : undefined;
	if (workshopAppId) {
		const workshopGameId = getGameIdForWorkshopAppId(workshopAppId);
		if (workshopGameId && workshopGameId !== languageId) {
			ErrorReporter.debug('Extension', `Workshop App ID ${workshopAppId} identifies workspace as ${workshopGameId} (was ${languageId})`);
			languageId = workshopGameId;
		}
		const workshopConsent = context.workspaceState.get<string>(WORKSHOP_ACTIVATION_CONSENT_KEY);
		if (workshopConsent !== 'granted') {
			let proceed = false;
			if (workshopConsent !== 'denied') {
				const enable = localize('Enable', '启用');
				const neverAsk = localize("Don't Ask Again", '不再询问');
				const choice = await window.showInformationMessage(
					localize(
						`This workspace is inside the Steam Workshop folder (App ID ${workshopAppId}), which Steam manages and may overwrite. Enable CWTools for this workspace?`,
						`当前工作区位于 Steam 创意工坊目录（App ID ${workshopAppId}），其内容由 Steam 管理且可能被覆盖。是否为此工作区启用 CWTools？`
					),
					enable,
					localize('Not Now', '暂不'),
					neverAsk
				);
				if (choice === enable) {
					await context.workspaceState.update(WORKSHOP_ACTIVATION_CONSENT_KEY, 'granted');
					proceed = true;
				} else if (choice === neverAsk) {
					await context.workspaceState.update(WORKSHOP_ACTIVATION_CONSENT_KEY, 'denied');
				}
			}
			if (!proceed) {
				ErrorReporter.debug('Extension', `Workshop workspace deferred (consent: ${workshopConsent ?? 'unset'})`);
				return;
			}
		}
	}

	// ── Auto-default localization language from VS Code UI language ──
	if (isKnownGameLanguageId(languageId)) {
		await autoDetectLocLanguage(context);
	}

	// ── Mod folder target game selection and auto-association ──
	const hasModDescriptor = workspaceRootPath ? hasWorkspaceModDescriptor(workspaceRootPath) : false;

	// When the target game cannot be determined (workshop or not), ask the
	// user to pick one instead of guessing. The choice is remembered per
	// workspace; dismissal is remembered too and not re-asked.
	if (!isKnownGameLanguageId(languageId) && workspaceRootPath
		&& (hasModDescriptor || workspaceHasParadoxStructure(workspaceRootPath))) {
		const savedGame = context.workspaceState.get<string>(WORKSPACE_GAME_SELECTION_KEY);
		if (savedGame && isKnownGameLanguageId(savedGame)) {
			languageId = savedGame;
		} else if (savedGame !== 'dismissed') {
			const pickedGame = await pickWorkspaceGame();
			if (pickedGame) {
				languageId = pickedGame;
				await context.workspaceState.update(WORKSPACE_GAME_SELECTION_KEY, pickedGame);
			} else {
				await context.workspaceState.update(WORKSPACE_GAME_SELECTION_KEY, 'dismissed');
			}
		}
	}

	if (hasModDescriptor && isKnownGameLanguageId(languageId)) {
		// If the game type was successfully determined (via scoring, App ID, or
		// user selection), offer to sync workspace-level file associations so
		// editor themes/syntax highlights work.
		await syncWorkspaceFileAssociations(context, languageId);
	}

	// ── Gate the language server on actual Paradox evidence ──
	// `determineServerStartMode` is the single pure decision point: vanilla
	// folders, mod descriptors and known game ids start full mode; `.cwt`
	// documents start CWT-only mode; otherwise startup is deferred.
	const activeDocumentForMode = window.activeTextEditor?.document;
	const startMode = determineServerStartMode({
		workspaceRootPath,
		isVanillaFolder,
		hasModDescriptor,
		languageId,
		activeDocument: activeDocumentForMode
			? { languageId: activeDocumentForMode.languageId, fileName: activeDocumentForMode.fileName }
			: undefined,
	});
	ErrorReporter.debug('Extension', `Startup gate: mode=${startMode} vanilla=${isVanillaFolder} descriptor=${hasModDescriptor} language=${languageId}`);
	if (startMode === 'full') {
		await init(languageId, isVanillaFolder);
		return extensionApi;
	}
	if (startMode === 'cwt-only') {
		await init(CWT_LANGUAGE_ID, isVanillaFolder, 'cwt-only');
		// Upgrade to full game mode in place (single server process, no second
		// client) when a game document becomes active later.
		context.subscriptions.push(window.onDidChangeActiveTextEditor(editor => {
			const doc = editor?.document;
			if (!doc || doc.uri.scheme !== 'file') return;
			if (isKnownGameLanguageId(doc.languageId) || doc.languageId === 'pdx-shader') {
				void commands.executeCommand('cwtools.reloadExtension');
			}
		}));
		return extensionApi;
	}

	ErrorReporter.debug('Extension', 'No Paradox or CWT evidence in this workspace; deferring CWTools language server start');
	let lazyStartPromise: Promise<void> | undefined;
	const lazyListeners: Disposable[] = [];
	const startLazily = (language: string, mode: ServerStartMode): Promise<void> => {
		lazyStartPromise ??= (async () => {
			for (const listener of lazyListeners) {
				try { listener.dispose(); } catch { /* ignore */ }
			}
			await init(language, isVanillaFolder, mode);
		})();
		return lazyStartPromise;
	};
	const maybeStartForEditor = (editor: vs.TextEditor | undefined) => {
		const doc = editor?.document;
		if (!doc || doc.uri.scheme !== 'file') return;
		// CWT rule files are evidence of a CWT-only workspace, not of a game.
		if (isCwtDocument(doc)) {
			void startLazily(CWT_LANGUAGE_ID, 'cwt-only');
		} else if (isKnownGameLanguageId(doc.languageId)) {
			void startLazily(doc.languageId, 'full');
		} else if (doc.languageId === 'pdx-shader') {
			void startLazily(languageId, 'full');
		}
	};
	lazyListeners.push(window.onDidChangeActiveTextEditor(maybeStartForEditor));
	context.subscriptions.push(...lazyListeners);
	maybeStartForEditor(window.activeTextEditor);
	// Bootstrap commands start the server first, then re-dispatch to the real
	// handler registered by init.
	for (const commandId of ['cwtools.openSetup', 'cwtools.runInstallationDoctor', 'cwtools.selectGameFolder']) {
		safeRegisterCommand(context, commandId, async () => {
			await startLazily(languageId, 'full');
			await commands.executeCommand(commandId);
		});
	}
	return extensionApi;
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
	return getDefaultLocalisationLanguagesForUiLocale(vs.env.language);
}

/**
 * Chooses the default validation language from the VS Code UI language.
 * Supported Stellaris languages follow the matching VS Code UI language.
 * The auto-managed value is written to user (Global) settings only — never to
 * workspace settings — so opening a project never creates .vscode/settings.json.
 * User-configured values (any scope) still win over this automatic default.
 */
async function autoDetectLocLanguage(context: ExtensionContext): Promise<void> {
	const config = workspace.getConfiguration('stellarisLanguageServices');
	const inspected = config.inspect<string[]>('localisation.languages');
	const trackedAuto = context.globalState.get<AutoDetectedLocLanguageState>(AUTO_DETECTED_LOC_LANGUAGE_KEY)
		?? context.workspaceState.get<AutoDetectedLocLanguageState>(AUTO_DETECTED_LOC_LANGUAGE_KEY);
	const trackedLanguages = trackedAuto?.languages;
	const desiredLanguages = defaultLocLanguagesForUi();

	const isTrackedValue = (value: readonly string[] | undefined): boolean =>
		!!trackedLanguages?.length && sameLocLanguageSetting(value, trackedLanguages);

	// Older builds wrote the auto-managed value into workspace settings, creating
	// .vscode/settings.json. Remove our value; user-authored workspace values stay.
	if (isTrackedValue(inspected?.workspaceValue)) {
		await config.update('localisation.languages', undefined, vs.ConfigurationTarget.Workspace);
		ErrorReporter.debug('Extension', 'Cleared legacy auto-managed workspace localisation language');
	}
	await context.workspaceState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, undefined);

	const hasExplicitWorkspaceValue = hasLocLanguageSetting(inspected?.workspaceValue)
		&& !isTrackedValue(inspected?.workspaceValue);
	if (hasExplicitWorkspaceValue || hasLocLanguageSetting(inspected?.workspaceFolderValue)) {
		// An explicit project-level setting wins; drop our global auto value.
		if (isTrackedValue(inspected?.globalValue)) {
			await config.update('localisation.languages', undefined, vs.ConfigurationTarget.Global);
		}
		await context.globalState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, { languages: [], disabled: true });
		return;
	}

	if (trackedAuto?.disabled) {
		return;
	}

	if (hasLocLanguageSetting(inspected?.globalValue)) {
		if (isTrackedValue(inspected?.globalValue)) {
			// Our auto-managed global value: keep it in sync with the UI language.
			if (sameLocLanguageSetting(desiredLanguages, ['English'])) {
				await config.update('localisation.languages', undefined, vs.ConfigurationTarget.Global);
				await context.globalState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, undefined);
				ErrorReporter.debug('Extension', 'Cleared auto-managed localisation language; English is the default for this UI language');
			} else if (!sameLocLanguageSetting(inspected?.globalValue, desiredLanguages)) {
				await config.update('localisation.languages', desiredLanguages, vs.ConfigurationTarget.Global);
				await context.globalState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, { languages: desiredLanguages });
				ErrorReporter.debug('Extension', `Auto-managed localisation language: ${desiredLanguages.join(', ')}`);
			}
			return;
		}
		// A global value we did not write is user configuration; stop auto-managing.
		await context.globalState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, { languages: [], disabled: true });
		return;
	}

	if (sameLocLanguageSetting(desiredLanguages, ['English'])) {
		return;
	}

	await config.update('localisation.languages', desiredLanguages, vs.ConfigurationTarget.Global);
	await context.globalState.update(AUTO_DETECTED_LOC_LANGUAGE_KEY, { languages: desiredLanguages });
	ErrorReporter.debug('Extension', `Auto-managed localisation language: ${desiredLanguages.join(', ')}`);
}

const FILE_ASSOCIATIONS_CONSENT_KEY = 'stellarisLanguageServices.fileAssociations.consent';
const WORKSHOP_ACTIVATION_CONSENT_KEY = 'stellarisLanguageServices.workshopActivation.consent';
const WORKSPACE_GAME_SELECTION_KEY = 'stellarisLanguageServices.workspaceGame.selection';
const FILE_ASSOCIATION_EXTENSIONS = ['*.txt', '*.gui', '*.gfx', '*.asset'];

/**
 * Associates common Paradox file extensions with the detected game language so
 * editor themes and validation apply. This writes .vscode/settings.json into the
 * user's project, so ask first; a granted choice is remembered per workspace,
 * while skipping only applies to the current prompt and is asked again later.
 */
/**
 * Lets the user pick the game a workspace belongs to when detection is
 * inconclusive. Returns the picked game language id, or undefined when the
 * user dismisses the picker.
 */
async function pickWorkspaceGame(): Promise<string | undefined> {
	const picked = await window.showQuickPick(
		getAllProfiles().map(profile => ({ label: profile.displayName, description: profile.id })),
		{ placeHolder: localize('Select the game this workspace belongs to', '请选择当前工作区所属的游戏') }
	);
	return picked?.description;
}

async function syncWorkspaceFileAssociations(context: ExtensionContext, languageId: string): Promise<void> {
	if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
		return;
	}
	const filesConfig = workspace.getConfiguration('files');
	const associations = filesConfig.get<Record<string, string>>('associations') || {};
	const updatedAssociations = { ...associations };
	let needsUpdate = false;
	for (const ext of FILE_ASSOCIATION_EXTENSIONS) {
		if (updatedAssociations[ext] !== languageId) {
			updatedAssociations[ext] = languageId;
			needsUpdate = true;
		}
	}
	if (!needsUpdate) {
		return;
	}

	const consent = context.workspaceState.get<string>(FILE_ASSOCIATIONS_CONSENT_KEY);
	if (consent !== 'granted') {
		const associate = localize('Associate', '关联');
		const notNow = localize('Not Now', '暂不');
		const choice = await window.showInformationMessage(
			localize(
				`Associate ${FILE_ASSOCIATION_EXTENSIONS.join(', ')} files with ${languageId} in this workspace? This creates .vscode/settings.json.`,
				`是否将 ${FILE_ASSOCIATION_EXTENSIONS.join(', ')} 文件在此工作区关联为 ${languageId}？这会创建 .vscode/settings.json。`
			),
			associate,
			notNow
		);
		// "Not now" and dismissal both skip this time only; ask again on next activation.
		if (choice !== associate) {
			return;
		}
		await context.workspaceState.update(FILE_ASSOCIATIONS_CONSENT_KEY, 'granted');
	}
	await filesConfig.update('associations', updatedAssociations, vs.ConfigurationTarget.Workspace);
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

export async function deactivate(): Promise<void> {
	// Flush the Agent run ledger and process registry so the final state of any
	// active run survives a window/extension close (VS Code awaits deactivate).
	try {
		const { runLedger } = require('./ai/runner/runLedger') as typeof import('./ai/runner/runLedger');
		await Promise.allSettled([processRegistry.flush(), runLedger.flushAll()]);
	} catch (error) {
		ErrorReporter.warn('Extension', 'Failed to flush Agent state during deactivation', error);
	}
	if (!defaultClient) return;
	try {
		await defaultClient.stop();
	} catch (error) {
		ErrorReporter.warn('Extension', 'Failed to stop CWTools language client during deactivation', error);
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
