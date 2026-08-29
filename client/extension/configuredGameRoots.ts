import * as path from 'path';
import * as vscode from 'vscode';
import { getAllProfiles, getCacheSettingKey } from './gameProfiles';

export interface ConfiguredGameRoot {
	gameId: string;
	root: string;
}

let configuredGlobalStoragePath = '';
let configuredExtensionPath = '';

export function configureSandboxStorage(options: { globalStoragePath?: string; extensionPath?: string }): void {
	if (options.globalStoragePath !== undefined) {
		configuredGlobalStoragePath = options.globalStoragePath ? path.resolve(options.globalStoragePath) : '';
	}
	if (options.extensionPath !== undefined) {
		configuredExtensionPath = options.extensionPath ? path.resolve(options.extensionPath) : '';
	}
}

export function resetSandboxStorageForTesting(): void {
	configuredGlobalStoragePath = '';
	configuredExtensionPath = '';
}

export function getConfiguredCustomRulesFolder(): string | undefined {
	const config = vscode.workspace.getConfiguration('stellarisLanguageServices');
	const custom = config.get<string>('rules_folder')?.trim();
	return custom ? path.resolve(custom) : undefined;
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

