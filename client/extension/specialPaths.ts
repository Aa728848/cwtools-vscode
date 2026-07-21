import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vs from 'vscode';
import { getKnownProfileByLanguageId, type GameProfile } from './gameProfiles';

export interface SpecialPathOptions {
	languageId: string;
	cacheDir: string;
	bundledRulesPath: string;
	globalStoragePath: string;
	getSteamLibraryPaths: () => string[];
}

interface SpecialPathItem extends vs.QuickPickItem {
	fsPath?: string;
	uri?: vs.Uri;
	canCreate?: boolean;
}

function isChineseLocale(): boolean {
	return vs.env.language.toLowerCase().startsWith('zh');
}

function localize(en: string, zh: string): string {
	return isChineseLocale() ? zh : en;
}

function firstWorkspaceFolder(): string | undefined {
	return vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function existingFolder(folderPath?: string): string | undefined {
	return folderPath && fs.existsSync(folderPath) ? folderPath : undefined;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const candidate of paths) {
		if (!candidate) continue;
		const key = path.resolve(candidate).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(candidate);
	}
	return result;
}

export function deriveGameInstallPath(dataPath: string, steamSubdir?: string): string {
	if (!steamSubdir) return dataPath;
	const normalizedSubdir = steamSubdir.replace(/[\\/]+$/, '').toLowerCase();
	if (path.basename(dataPath).toLowerCase() === normalizedSubdir) {
		return path.dirname(dataPath);
	}
	return dataPath;
}

function configuredGameDataPath(profile: GameProfile): string | undefined {
	const configured = vs.workspace.getConfiguration('stellarisLanguageServices').get<string>(profile.cacheSettingKey, '')?.trim();
	return existingFolder(configured);
}

function detectedGameDataPath(profile: GameProfile, steamLibraries: string[]): string | undefined {
	const folderNames = [profile.install.steamFolderName, ...profile.install.alternativeFolderNames];
	for (const library of steamLibraries) {
		for (const folderName of folderNames) {
			const installPath = path.join(library, 'steamapps', 'common', folderName);
			const dataPath = profile.folders.steamSubdir ? path.join(installPath, profile.folders.steamSubdir) : installPath;
			if (fs.existsSync(path.join(dataPath, 'common'))) return dataPath;
		}
	}
	return undefined;
}

export function steamWorkshopPathForLibrary(libraryPath: string, steamAppId: string): string {
	return path.join(libraryPath, 'steamapps', 'workshop', 'content', steamAppId);
}

function steamappsFolderFromGamePath(gamePath: string): string | undefined {
	const segments = path.resolve(gamePath).split(path.sep);
	for (let i = 0; i < segments.length - 1; i++) {
		if (segments[i]?.toLowerCase() === 'steamapps' && segments[i + 1]?.toLowerCase() === 'common') {
			return segments.slice(0, i + 1).join(path.sep);
		}
	}
	return undefined;
}

export function paradoxUserModPath(displayName: string, platform: NodeJS.Platform = os.platform(), homeDir: string = os.homedir()): string {
	const base = platform === 'linux'
		? path.join(homeDir, '.local', 'share', 'Paradox Interactive')
		: path.join(homeDir, 'Documents', 'Paradox Interactive');
	return path.join(base, displayName, 'mod');
}

function markdownDescription(folderPath?: string, canCreate = false): string {
	if (!folderPath) return localize('Not available', '不可用');
	if (fs.existsSync(folderPath)) return folderPath;
	return canCreate
		? localize(`${folderPath} (will be created)`, `${folderPath} (将创建)`)
		: localize(`${folderPath} (missing)`, `${folderPath} (缺失)`);
}

function pushFolder(items: SpecialPathItem[], label: string, folderPath: string | undefined, canCreate = false): void {
	if (!folderPath && !canCreate) return;
	items.push({
		label,
		description: markdownDescription(folderPath, canCreate),
		detail: folderPath,
		fsPath: folderPath,
		canCreate,
	});
}

export function buildSpecialPathItems(options: SpecialPathOptions): SpecialPathItem[] {
	const profile = getKnownProfileByLanguageId(options.languageId);
	const steamLibraries = uniquePaths(options.getSteamLibraryPaths());
	const workspaceRoot = firstWorkspaceFolder();
	const items: SpecialPathItem[] = [];

	pushFolder(items, localize('Workspace Folder', '工作区目录'), workspaceRoot);
	if (workspaceRoot) {
		const { getAiStorageRoot } = require('./ai/workspacePaths') as typeof import('./ai/workspacePaths');
		pushFolder(items, localize('AI Workspace Storage (.cwtools)', 'AI 工作区存储 (.cwtools)'), getAiStorageRoot(workspaceRoot), true);
	}

	pushFolder(items, localize('Extension Global Storage', '扩展全局存储'), options.globalStoragePath, true);
	pushFolder(items, localize('Cached Rules Folder', '缓存规则目录'), path.join(options.cacheDir, options.languageId));
	pushFolder(items, localize('Bundled Rules Folder', '内置规则目录'), options.bundledRulesPath);

	if (!profile) return items;

	const configuredDataPath = configuredGameDataPath(profile);
	const detectedDataPath = configuredDataPath ?? detectedGameDataPath(profile, steamLibraries);
	const installPath = detectedDataPath ? deriveGameInstallPath(detectedDataPath, profile.folders.steamSubdir) : undefined;

	pushFolder(items, localize(`${profile.displayName} Vanilla Data Folder`, `${profile.displayName} 原版数据目录`), detectedDataPath);
	pushFolder(items, localize(`${profile.displayName} Install Folder`, `${profile.displayName} 安装目录`), installPath);
	pushFolder(items, localize(`${profile.displayName} User Mod Folder`, `${profile.displayName} 用户 Mod 目录`), paradoxUserModPath(profile.displayName), true);

	const steamappsFromGame = installPath ? steamappsFolderFromGamePath(installPath) : undefined;
	const libraryFromGame = steamappsFromGame ? path.dirname(steamappsFromGame) : undefined;
	const workshopCandidates = uniquePaths([
		libraryFromGame ? steamWorkshopPathForLibrary(libraryFromGame, profile.install.steamAppId) : undefined,
		...steamLibraries.map(library => steamWorkshopPathForLibrary(library, profile.install.steamAppId)),
	]);
	for (const workshopPath of workshopCandidates.slice(0, 5)) {
		pushFolder(items, localize(`${profile.displayName} Steam Workshop Mods`, `${profile.displayName} Steam 工坊 Mod`), workshopPath);
	}

	items.push({
		label: localize(`Launch ${profile.displayName} in Steam`, `通过 Steam 启动 ${profile.displayName}`),
		description: `steam://rungameid/${profile.install.steamAppId}`,
		uri: vs.Uri.parse(`steam://rungameid/${profile.install.steamAppId}`),
	});

	return items;
}

async function openSpecialItem(item: SpecialPathItem): Promise<void> {
	if (item.uri) {
		await vs.env.openExternal(item.uri);
		return;
	}
	if (!item.fsPath) return;
	if (!fs.existsSync(item.fsPath)) {
		if (!item.canCreate) {
			await vs.window.showWarningMessage(localize('That local path does not exist.', '该本地路径不存在。'));
			return;
		}
		await fs.promises.mkdir(item.fsPath, { recursive: true });
	}
	await vs.commands.executeCommand('revealFileInOS', vs.Uri.file(item.fsPath));
}

async function pickSpecialPath(options: SpecialPathOptions, placeHolder: string): Promise<SpecialPathItem | undefined> {
	const items = buildSpecialPathItems(options);
	return vs.window.showQuickPick(items, {
		placeHolder,
		matchOnDescription: true,
		matchOnDetail: true,
	});
}

export function registerSpecialPathCommands(context: vs.ExtensionContext, getOptions: () => SpecialPathOptions): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.openSpecialPath', async () => {
			const picked = await pickSpecialPath(getOptions(), localize('Open local Stellaris/CWTools path', '打开本地 Stellaris/CWTools 路径'));
			if (picked) await openSpecialItem(picked);
		}),
		vs.commands.registerCommand('cwtools.copySpecialPath', async () => {
			const picked = await pickSpecialPath(getOptions(), localize('Copy local Stellaris/CWTools path', '复制本地 Stellaris/CWTools 路径'));
			const value = picked?.fsPath ?? picked?.uri?.toString();
			if (!value) return;
			await vs.env.clipboard.writeText(value);
			await vs.window.showInformationMessage(localize('Path copied to clipboard.', '路径已复制到剪贴板。'));
		}),
		vs.commands.registerCommand('cwtools.launchGameInSteam', async () => {
			const profile = getKnownProfileByLanguageId(getOptions().languageId);
			if (!profile) {
				await vs.window.showWarningMessage(localize('No known game profile is active.', '当前没有活动的已知游戏配置。'));
				return;
			}
			await vs.env.openExternal(vs.Uri.parse(`steam://rungameid/${profile.install.steamAppId}`));
		}),
	);
}
