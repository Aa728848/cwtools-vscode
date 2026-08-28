import * as path from 'path';
import * as vscode from 'vscode';
import { getAllProfiles, getCacheSettingKey } from './gameProfiles';

export interface ConfiguredGameRoot {
	gameId: string;
	root: string;
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
