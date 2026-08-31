import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getAllProfiles, getCacheSettingKey } from './gameProfiles';

export interface ConfiguredGameRoot {
	gameId: string;
	root: string;
}

let configuredGlobalStoragePath = '';
let configuredExtensionPath = '';
let configuredAdditionalReadableRoots: string[] = [];

export function configureSandboxStorage(options: {
	globalStoragePath?: string;
	extensionPath?: string;
	additionalReadableRoots?: string[];
}): void {
	if (options.globalStoragePath !== undefined) {
		configuredGlobalStoragePath = options.globalStoragePath ? path.resolve(options.globalStoragePath) : '';
	}
	if (options.extensionPath !== undefined) {
		configuredExtensionPath = options.extensionPath ? path.resolve(options.extensionPath) : '';
	}
	if (options.additionalReadableRoots !== undefined) {
		configuredAdditionalReadableRoots = options.additionalReadableRoots
			.map(r => (r?.trim() ? path.resolve(r.trim()) : ''))
			.filter(Boolean);
	}
}

export function resetSandboxStorageForTesting(): void {
	configuredGlobalStoragePath = '';
	configuredExtensionPath = '';
	configuredAdditionalReadableRoots = [];
}

export function getConfiguredCustomRulesFolder(): string | undefined {
	const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
	const custom = config.get<string>('rules_folder')?.trim();
	return custom ? path.resolve(custom) : undefined;
}

/**
 * Returns standard Paradox Interactive user data / mod / logs directories across platforms.
 */
export function getParadoxUserDataRoots(
	platform: NodeJS.Platform = process.platform,
	homeDir: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env
): string[] {
	const candidates: string[] = [];

	if (platform === 'linux') {
		candidates.push(path.join(homeDir, '.local', 'share', 'Paradox Interactive'));
		candidates.push(path.join(homeDir, '.paradoxinteractive'));
	} else if (platform === 'darwin') {
		candidates.push(path.join(homeDir, 'Documents', 'Paradox Interactive'));
		candidates.push(path.join(homeDir, 'Library', 'Application Support', 'Paradox Interactive'));
	} else {
		// win32 and default
		candidates.push(path.join(homeDir, 'Documents', 'Paradox Interactive'));
		const userProfile = env.USERPROFILE;
		if (userProfile && userProfile.toLowerCase() !== homeDir.toLowerCase()) {
			candidates.push(path.join(userProfile, 'Documents', 'Paradox Interactive'));
		}
		const oneDrive = env.OneDrive || env.ONEDRIVE || env.OneDriveConsumer || env.OneDriveCommercial;
		if (oneDrive) {
			candidates.push(path.join(oneDrive, 'Documents', 'Paradox Interactive'));
		}
		candidates.push(path.join(homeDir, 'OneDrive', 'Documents', 'Paradox Interactive'));
		if (userProfile && userProfile.toLowerCase() !== homeDir.toLowerCase()) {
			candidates.push(path.join(userProfile, 'OneDrive', 'Documents', 'Paradox Interactive'));
		}
	}

	const unique: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate?.trim()) continue;
		const resolved = path.resolve(candidate);
		const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(resolved);
		}
	}
	return unique;
}

export function getAuxiliaryReadableRoots(): string[] {
	const roots = new Set<string>();
	const add = (candidate: string | undefined) => {
		if (!candidate?.trim()) return;
		const resolved = path.resolve(candidate);
		const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
		if (![...roots].some(existing => (process.platform === 'win32' ? existing.toLowerCase() : existing) === key)) {
			roots.add(resolved);
		}
	};

	if (configuredGlobalStoragePath) {
		add(configuredGlobalStoragePath);
	}
	if (configuredExtensionPath) {
		add(configuredExtensionPath);
	} else {
		const ext = vscode.extensions?.getExtension?.('ForeverSkywalker.foreverskywalker-stellaris-cwtools')
			?? vscode.extensions?.getExtension?.('foreverskywalker.foreverskywalker-stellaris-cwtools');
		if (ext?.extensionPath) {
			add(ext.extensionPath);
		}
	}

	const customRules = getConfiguredCustomRulesFolder();
	if (customRules) {
		add(customRules);
	}

	for (const root of configuredAdditionalReadableRoots) {
		add(root);
	}

	for (const paradoxRoot of getParadoxUserDataRoots()) {
		add(paradoxRoot);
	}

	return [...roots].sort((a, b) => a.localeCompare(b));
}

/** Game data roots explicitly selected by the user in extension settings. */
export function getConfiguredGameRoots(): ConfiguredGameRoot[] {
	const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
	const roots = new Map<string, ConfiguredGameRoot>();
	for (const profile of getAllProfiles()) {
		const configured = config.get<string>(getCacheSettingKey(profile.id), '')?.trim();
		if (!configured) continue;
		const root = path.resolve(configured);
		const key = process.platform === 'win32' ? root.toLowerCase() : root;
		if (!roots.has(key)) roots.set(key, { gameId: profile.id, root });
	}
	return [...roots.values()].sort((a, b) => a.root.localeCompare(b.root));
}

