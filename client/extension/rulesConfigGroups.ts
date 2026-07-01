import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';

export interface RulesConfigGroupOptions {
	languageId: string;
	cacheDir: string;
	bundledRulesPath: string;
	defaultRemoteRulesUrl: string;
	remoteRulesUrl: string;
}

export interface RuleGroup {
	id: 'manual' | 'remote' | 'fallback';
	label: string;
	path?: string;
	detail?: string;
	fileCount: number;
	active: boolean;
}

function isChineseLocale(): boolean {
	return vs.env.language.toLowerCase().startsWith('zh');
}

function localize(en: string, zh: string): string {
	return isChineseLocale() ? zh : en;
}

function countRuleFiles(folder?: string): number {
	if (!folder || !fs.existsSync(folder)) return 0;
	if (folder.toLowerCase().endsWith('.zip')) return 1;

	let count = 0;
	const stack = [folder];
	while (stack.length > 0 && count < 10000) {
		const current = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith('.cwt')) count++;
		}
	}
	return count;
}

function configTarget(): vs.ConfigurationTarget {
	return vs.workspace.workspaceFolders?.length ? vs.ConfigurationTarget.Workspace : vs.ConfigurationTarget.Global;
}

export function getRuleGroups(options: RulesConfigGroupOptions): RuleGroup[] {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	const rulesVersion = config.get<string>('rules_version', 'latest');
	const manualRulesFolder = config.get<string>('rules_folder', '')?.trim();
	const manualCount = countRuleFiles(manualRulesFolder);
	const cachePath = path.join(options.cacheDir, options.languageId);
	const cacheCount = countRuleFiles(cachePath);
	const bundledCount = countRuleFiles(options.bundledRulesPath);
	const useLocalRules = rulesVersion === 'manual';
	const groups: RuleGroup[] = [
		{
			id: 'manual',
			label: localize('Local specified rules folder', '本地指定规则目录'),
			path: manualRulesFolder || undefined,
			detail: manualRulesFolder || localize('No local folder selected', '未选择本地目录'),
			fileCount: manualCount,
			active: useLocalRules,
		},
		{
			id: 'remote',
			label: localize('Remote rules cache', '远程规则缓存'),
			path: cachePath,
			detail: `${options.remoteRulesUrl || options.defaultRemoteRulesUrl}\n${cachePath}`,
			fileCount: cacheCount,
			active: !useLocalRules && cacheCount > 0,
		},
		{
			id: 'fallback',
			label: localize('Bundled fallback rules', '内置备用规则'),
			path: options.bundledRulesPath,
			detail: localize(
				`Used only when remote update fails and bundled rules are newer than the cache.\n${options.bundledRulesPath}`,
				`仅在远程更新失败且内置规则比缓存更新时使用。\n${options.bundledRulesPath}`
			),
			fileCount: bundledCount,
			active: false,
		},
	];
	return groups;
}

async function openPath(folderPath?: string): Promise<void> {
	if (!folderPath) return;
	await fs.promises.mkdir(folderPath, { recursive: true }).catch(() => undefined);
	await vs.commands.executeCommand('revealFileInOS', vs.Uri.file(folderPath));
}

async function promptReload(): Promise<void> {
	const choice = await vs.window.showInformationMessage(
		localize('Rules settings changed. Reload the window to restart the language server now?', '规则设置已更改。现在重载窗口以重启语言服务吗？'),
		localize('Reload', '重载'),
		localize('Later', '稍后'),
	);
	if (choice === localize('Reload', '重载')) {
		await vs.commands.executeCommand('workbench.action.reloadWindow');
	}
}

async function setManualRulesFolder(): Promise<void> {
	const picked = await vs.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: localize('Use Rules Folder', '使用规则目录'),
		title: localize('Select a local CWT rules folder', '选择本地 CWT 规则目录'),
	});
	if (!picked?.[0]) return;
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	await config.update('rules_folder', picked[0].fsPath, configTarget());
	await config.update('rules_version', 'manual', configTarget());
	await promptReload();
}

async function setRemoteRulesUrl(options: RulesConfigGroupOptions): Promise<void> {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	const currentCustomUrl = config.get<string>('rules_remote_url', '')?.trim();
	const value = await vs.window.showInputBox({
		prompt: localize(
			'Enter a Git repository URL for remote CWTools rules. Leave empty to use the default rules repository.',
			'输入远程 CWTools 规则 Git 仓库链接。留空则使用我们提供的默认规则仓库。'
		),
		value: currentCustomUrl || options.defaultRemoteRulesUrl,
		placeHolder: options.defaultRemoteRulesUrl,
	});
	if (value === undefined) return;
	const normalized = value.trim();
	await config.update('rules_remote_url', normalized === options.defaultRemoteRulesUrl ? '' : normalized, configTarget());
	await config.update('rules_version', 'latest', configTarget());
	await promptReload();
}

async function useDefaultRemoteRules(): Promise<void> {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	await config.update('rules_remote_url', '', configTarget());
	await config.update('rules_version', 'latest', configTarget());
	await promptReload();
}

async function clearManualRules(): Promise<void> {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	await config.update('rules_folder', '', configTarget());
	await config.update('rules_version', 'latest', configTarget());
	await promptReload();
}

export function registerRulesConfigGroupCommands(
	context: vs.ExtensionContext,
	getOptions: () => RulesConfigGroupOptions,
): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.rules.manageConfigGroups', async () => {
			const options = getOptions();
			const groups = getRuleGroups(options);
			const active = groups.find(group => group.active);
			const items: Array<vs.QuickPickItem & { action: () => Promise<void> }> = [
				{
					label: localize('Set Remote Rules URL...', '设置远程规则链接...'),
					description: options.remoteRulesUrl || options.defaultRemoteRulesUrl,
					action: () => setRemoteRulesUrl(options),
				},
				{
					label: localize('Use Default Remote Rules URL', '使用默认远程规则链接'),
					description: options.defaultRemoteRulesUrl,
					action: useDefaultRemoteRules,
				},
				{
					label: localize('Set Manual Rules Folder...', '设置手动规则目录...'),
					description: localize('Use an explicit local CWT config directory only in manual mode', '仅在 manual 模式使用指定的本地 CWT 配置目录'),
					action: setManualRulesFolder,
				},
				{
					label: localize('Clear Manual Rules Override', '清除手动规则覆盖'),
					description: localize(
						'Return to remote rules; bundled fallback is used only after failed stale-cache updates',
						'回到远程规则；内置备用仅在缓存落后且远程更新失败时使用'
					),
					action: clearManualRules,
				},
				{
					label: localize('Open Active Rules Folder', '打开当前规则目录'),
					description: active?.path ?? localize('No active rules folder', '没有活动的规则目录'),
					action: () => openPath(active?.path),
				},
				{
					label: localize('Open Settings', '打开设置'),
					description: 'stellarisLanguageServices.rules_version / rules_remote_url / rules_folder',
					action: () => vs.commands.executeCommand('workbench.action.openSettings', 'stellarisLanguageServices rules') as Promise<void>,
				},
				...groups.map(group => ({
					label: `${group.active ? '$(check) ' : ''}${group.label}`,
					description: localize(`${group.fileCount} CWT files`, `${group.fileCount} 个 CWT 文件`),
					detail: group.detail ?? group.path,
					action: () => openPath(group.path),
				})),
			];
			const picked = await vs.window.showQuickPick(items, {
				placeHolder: localize(
					'Rules sources: remote cache, local specified, bundled fallback',
					'规则来源：远程缓存、本地指定、内置备用'
				),
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (picked) await picked.action();
		}),
	);
}
