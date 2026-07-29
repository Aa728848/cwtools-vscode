import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';

export interface RulesConfigGroupOptions {
	languageId: string;
	cacheDir: string;
	bundledRulesPath: string;
	defaultRemoteRulesUrl: string;
	remoteRulesUrl: string;
	refreshRules?: () => Promise<void>;
}

export interface RulesRuntimeStatus {
	source?: 'manual' | 'remote' | 'bundled' | 'missing' | 'checking';
	updateStatus?: string;
	lastCompletedAt?: number;
	error?: string;
}

export interface RuleGroup {
	id: 'manual' | 'remote' | 'fallback';
	label: string;
	path?: string;
	detail?: string;
	fileCount: number;
	unit: 'files' | 'package';
	active: boolean;
	available: boolean;
}

interface RuleInventory {
	count: number;
	unit: RuleGroup['unit'];
}

interface RulesQuickPickItem extends vs.QuickPickItem {
	action?: () => Promise<void>;
}

function isChineseLocale(): boolean {
	return vs.env.language.toLowerCase().startsWith('zh');
}

function localize(en: string, zh: string): string {
	return isChineseLocale() ? zh : en;
}

function inspectRuleSource(sourcePath?: string): RuleInventory {
	if (!sourcePath || !fs.existsSync(sourcePath)) return { count: 0, unit: 'files' };
	if (sourcePath.toLowerCase().endsWith('.zip')) return { count: 1, unit: 'package' };

	let count = 0;
	const stack = [sourcePath];
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
	return { count, unit: 'files' };
}

function configTarget(): vs.ConfigurationTarget {
	return vs.workspace.workspaceFolders?.length ? vs.ConfigurationTarget.Workspace : vs.ConfigurationTarget.Global;
}

export function parseRulesRuntimeStatus(value: unknown): RulesRuntimeStatus | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const loading = (value as { loading?: unknown }).loading;
	if (!loading || typeof loading !== 'object') return undefined;
	const raw = loading as Record<string, unknown>;
	const source = raw.lastRulesSource;
	const normalizedSource = source === 'manual' || source === 'remote' || source === 'bundled' || source === 'missing' || source === 'checking'
		? source
		: undefined;
	return {
		source: normalizedSource,
		updateStatus: typeof raw.lastRulesStatus === 'string' ? raw.lastRulesStatus : undefined,
		lastCompletedAt: typeof raw.lastCompletedAtUnixMs === 'number' && raw.lastCompletedAtUnixMs > 0
			? raw.lastCompletedAtUnixMs
			: undefined,
		error: typeof raw.lastError === 'string' && raw.lastError.trim() ? raw.lastError : undefined,
	};
}

async function getRuntimeRulesStatus(): Promise<RulesRuntimeStatus | undefined> {
	try {
		const value = await vs.commands.executeCommand<unknown>('cwtools.ai.getValidationStatus');
		return parseRulesRuntimeStatus(value);
	} catch {
		return undefined;
	}
}

export function getRuleGroups(options: RulesConfigGroupOptions, runtime?: RulesRuntimeStatus): RuleGroup[] {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	const rulesVersion = config.get<string>('rules_version', 'latest');
	const manualRulesFolder = config.get<string>('rules_folder', '')?.trim();
	const manual = inspectRuleSource(manualRulesFolder);
	const cachePath = path.join(options.cacheDir, options.languageId);
	const remote = inspectRuleSource(cachePath);
	const bundled = inspectRuleSource(options.bundledRulesPath);
	const useLocalRules = rulesVersion === 'manual';
	const runtimeSource = runtime?.source;
	const hasEffectiveRuntimeSource = runtimeSource === 'manual' || runtimeSource === 'remote' || runtimeSource === 'bundled' || runtimeSource === 'missing';
	const isActive = (source: Exclude<RulesRuntimeStatus['source'], undefined | 'checking'>, fallback: boolean) =>
		hasEffectiveRuntimeSource ? runtimeSource === source : fallback;

	return [
		{
			id: 'manual',
			label: localize('Local rules folder', '本地规则目录'),
			path: manualRulesFolder || undefined,
			detail: manualRulesFolder || localize('No local folder selected', '未选择本地目录'),
			fileCount: manual.count,
			unit: manual.unit,
			active: isActive('manual', useLocalRules && manual.count > 0),
			available: manual.count > 0,
		},
		{
			id: 'remote',
			label: localize('Remote rules cache', '远程规则缓存'),
			path: cachePath,
			detail: `${options.remoteRulesUrl || options.defaultRemoteRulesUrl}\n${cachePath}`,
			fileCount: remote.count,
			unit: remote.unit,
			active: isActive('remote', !useLocalRules && remote.count > 0),
			available: remote.count > 0,
		},
		{
			id: 'fallback',
			label: localize('Bundled fallback rules', '内置备用规则'),
			path: options.bundledRulesPath,
			detail: localize(
				`Automatically used whenever a remote update fails. Existing cached rules are kept only if the bundled package is unavailable.\n${options.bundledRulesPath}`,
				`远程更新失败时自动启用；仅当内置规则包不可用时才继续使用现有缓存。\n${options.bundledRulesPath}`
			),
			fileCount: bundled.count,
			unit: bundled.unit,
			active: isActive('bundled', false),
			available: bundled.count > 0,
		},
	];
}

function formatInventory(group: Pick<RuleGroup, 'fileCount' | 'unit'>): string {
	if (group.unit === 'package') {
		return localize(`${group.fileCount} rules package`, `${group.fileCount} 个规则包`);
	}
	return localize(`${group.fileCount} CWT files`, `${group.fileCount} 个 CWT 文件`);
}

function formatRuntimeStatus(status?: string): string | undefined {
	switch (status) {
		case 'updated': return localize('Updated', '已更新');
		case 'up_to_date': return localize('Up to date', '已是最新');
		case 'fallback': return localize('Remote update failed; fallback selected', '远程更新失败，已选择备用来源');
		case 'missing': return localize('Rules missing', '规则缺失');
		case 'checking':
		case 'updating': return localize('Updating', '正在更新');
		case 'error': return localize('Update failed', '更新失败');
		case 'skipped': return localize('Local rules loaded', '已加载本地规则');
		default: return undefined;
	}
}

function formatTimestamp(timestamp?: number): string | undefined {
	if (!timestamp) return undefined;
	try {
		return new Date(timestamp).toLocaleString(isChineseLocale() ? 'zh-CN' : 'en-US');
	} catch {
		return undefined;
	}
}

async function openPath(sourcePath?: string): Promise<void> {
	if (!sourcePath || !fs.existsSync(sourcePath)) {
		await vs.window.showWarningMessage(localize('The rules path is not available yet.', '规则路径当前不可用。'));
		return;
	}
	await vs.commands.executeCommand('revealFileInOS', vs.Uri.file(sourcePath));
}

async function refreshRules(options: RulesConfigGroupOptions): Promise<boolean> {
	try {
		await vs.window.withProgress(
			{
				location: vs.ProgressLocation.Notification,
				title: localize('Updating CWTools rules...', '正在更新 CWTools 规则...'),
				cancellable: false,
			},
			async () => {
				if (options.refreshRules) await options.refreshRules();
				else await vs.commands.executeCommand('cwtools.reloadExtension');
			},
		);
		await vs.window.showInformationMessage(localize('CWTools rules were reloaded.', 'CWTools 规则已重新加载。'));
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await vs.window.showErrorMessage(localize(`Failed to reload CWTools rules: ${message}`, `重新加载 CWTools 规则失败：${message}`));
		return false;
	}
}

async function promptApplyRules(options: RulesConfigGroupOptions): Promise<void> {
	const restart = localize('Restart Language Server', '重启语言服务');
	const later = localize('Later', '稍后');
	const choice = await vs.window.showInformationMessage(
		localize('Rules settings changed. Restart the language server to apply them now?', '规则设置已更改。现在重启语言服务以应用吗？'),
		restart,
		later,
	);
	if (choice === restart) await refreshRules(options);
}

function isValidRemoteRulesUrl(value: string): boolean {
	if (!value) return true;
	if (/^git@[\w.-]+:.+/i.test(value)) return true;
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'ssh:' || parsed.protocol === 'git:';
	} catch {
		return false;
	}
}

async function setRemoteRulesUrl(options: RulesConfigGroupOptions): Promise<void> {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	const currentCustomUrl = config.get<string>('rules_remote_url', '')?.trim();
	const value = await vs.window.showInputBox({
		prompt: localize(
			'Enter a Git repository URL for remote CWTools rules. Leave empty to use the default repository.',
			'输入远程 CWTools 规则 Git 仓库链接。留空则使用默认仓库。'
		),
		value: currentCustomUrl || options.defaultRemoteRulesUrl,
		placeHolder: options.defaultRemoteRulesUrl,
		validateInput: input => isValidRemoteRulesUrl(input.trim())
			? undefined
			: localize('Enter an HTTP(S), SSH, git://, or git@ repository URL.', '请输入 HTTP(S)、SSH、git:// 或 git@ 仓库链接。'),
	});
	if (value === undefined) return;
	const normalized = value.trim();
	const currentChannel = config.get<string>('rules_version', 'latest');
	await config.update('rules_remote_url', normalized === options.defaultRemoteRulesUrl ? '' : normalized, configTarget());
	await config.update('rules_version', currentChannel === 'stable' ? 'stable' : 'latest', configTarget());
	await promptApplyRules(options);
}

async function useDefaultRemoteRules(options: RulesConfigGroupOptions): Promise<void> {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	const currentChannel = config.get<string>('rules_version', 'latest');
	await config.update('rules_remote_url', '', configTarget());
	await config.update('rules_version', currentChannel === 'stable' ? 'stable' : 'latest', configTarget());
	await promptApplyRules(options);
}

async function setRemoteChannel(channel: 'latest' | 'stable', options: RulesConfigGroupOptions): Promise<void> {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	await config.update('rules_version', channel, configTarget());
	await promptApplyRules(options);
}

async function showRemoteSourcePicker(options: RulesConfigGroupOptions): Promise<void> {
	const config = vs.workspace.getConfiguration('stellarisLanguageServices');
	const configuredVersion = config.get<string>('rules_version', 'latest');
	const channel = configuredVersion === 'stable' ? 'stable' : 'latest';
	const customUrl = config.get<string>('rules_remote_url', '')?.trim();
	const items: RulesQuickPickItem[] = [
		{ kind: vs.QuickPickItemKind.Separator, label: localize('Update channel', '更新通道') },
		{
			label: `${channel === 'latest' ? '$(check) ' : ''}${localize('Latest', 'Latest（最新）')}`,
			description: localize('Recommended for the current game version', '推荐用于当前游戏版本'),
			action: () => setRemoteChannel('latest', options),
		},
		{
			label: `${channel === 'stable' ? '$(check) ' : ''}${localize('Stable', 'Stable（稳定）')}`,
			description: localize('More conservative rule updates', '更新更保守'),
			action: () => setRemoteChannel('stable', options),
		},
		{ kind: vs.QuickPickItemKind.Separator, label: localize('Repository', '规则仓库') },
		{
			label: `${!customUrl ? '$(check) ' : ''}${localize('Default repository', '默认仓库')}`,
			description: options.defaultRemoteRulesUrl,
			action: () => useDefaultRemoteRules(options),
		},
		{
			label: `${customUrl ? '$(check) ' : ''}${localize('Custom repository...', '自定义仓库...')}`,
			description: customUrl || localize('Not configured', '未配置'),
			action: () => setRemoteRulesUrl(options),
		},
	];
	const picked = await vs.window.showQuickPick(items, {
		title: localize('Automatic Remote Rules', '自动远程规则'),
		placeHolder: localize('Choose an update channel or repository', '选择更新通道或规则仓库'),
		matchOnDescription: true,
	});
	if (picked?.action) await picked.action();
}

async function setManualRulesFolder(options: RulesConfigGroupOptions): Promise<void> {
	while (true) {
		const picked = await vs.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: localize('Use Rules Folder', '使用规则目录'),
			title: localize('Select a local CWT rules folder', '选择本地 CWT 规则目录'),
		});
		if (!picked?.[0]) return;
		const selectedPath = picked[0].fsPath;
		const inventory = inspectRuleSource(selectedPath);
		if (inventory.count === 0) {
			const chooseAnother = localize('Choose Another Folder', '重新选择目录');
			const useAnyway = localize('Use Anyway', '仍然使用');
			const choice = await vs.window.showWarningMessage(
				localize(
					'No .cwt files were found in this folder or its subfolders.',
					'该目录及其子目录中未找到 .cwt 文件。'
				),
				chooseAnother,
				useAnyway,
			);
			if (choice === chooseAnother) continue;
			if (choice !== useAnyway) return;
		}
		const config = vs.workspace.getConfiguration('stellarisLanguageServices');
		await config.update('rules_folder', selectedPath, configTarget());
		await config.update('rules_version', 'manual', configTarget());
		await promptApplyRules(options);
		return;
	}
}

function separator(label: string): RulesQuickPickItem {
	return { kind: vs.QuickPickItemKind.Separator, label };
}

export function registerRulesConfigGroupCommands(
	context: vs.ExtensionContext,
	getOptions: () => RulesConfigGroupOptions,
): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.rules.manageConfigGroups', async () => {
			const options = getOptions();
			const runtime = await getRuntimeRulesStatus();
			const groups = getRuleGroups(options, runtime);
			const config = vs.workspace.getConfiguration('stellarisLanguageServices');
			const rulesVersion = config.get<string>('rules_version', 'latest');
			const customUrl = config.get<string>('rules_remote_url', '')?.trim();
			const configuredManual = rulesVersion === 'manual';
			const channel = rulesVersion === 'stable' ? 'Stable' : 'Latest';
			const active = groups.find(group => group.active);
			const fallback = groups.find(group => group.id === 'fallback')!;
			const runtimeText = formatRuntimeStatus(runtime?.updateStatus);
			const updatedAt = formatTimestamp(runtime?.lastCompletedAt);
			const currentDetail = [active?.path, updatedAt ? localize(`Last rules check: ${updatedAt}`, `上次规则检查：${updatedAt}`) : undefined, runtime?.error]
				.filter(Boolean)
				.join('\n');

			const items: RulesQuickPickItem[] = [
				separator(localize('Current status', '当前状态')),
				{
					label: active
						? `$(check) ${active.label}`
						: localize('$(warning) No active rules source', '$(warning) 没有可用的规则来源'),
					description: [active ? formatInventory(active) : undefined, runtimeText].filter(Boolean).join(' · '),
					detail: currentDetail || localize('Restart the language server after configuring a source.', '配置来源后请重启语言服务。'),
					action: () => openPath(active?.path),
				},
				separator(localize('Choose source', '选择来源')),
				{
					label: `${!configuredManual ? '$(check) ' : ''}${localize('Automatic remote (recommended)', '自动远程（推荐）')}`,
					description: `${channel} · ${customUrl ? localize('Custom repository', '自定义仓库') : localize('Default repository', '默认仓库')}`,
					detail: customUrl || options.defaultRemoteRulesUrl,
					action: () => showRemoteSourcePicker(options),
				},
				{
					label: `${configuredManual ? '$(check) ' : ''}${localize('Local rules folder...', '本地规则目录...')}`,
					description: groups.find(group => group.id === 'manual')!.available
						? formatInventory(groups.find(group => group.id === 'manual')!)
						: localize('No valid folder selected', '尚未选择有效目录'),
					detail: groups.find(group => group.id === 'manual')!.path,
					action: () => setManualRulesFolder(options),
				},
				separator(localize('Automatic fallback', '自动备用')),
				{
					label: `${fallback.active ? '$(warning) ' : '$(shield) '}${fallback.label}`,
					description: `${formatInventory(fallback)} · ${fallback.active ? localize('Currently active', '当前正在使用') : localize('Automatic only', '仅自动启用')}`,
					detail: fallback.detail,
					action: () => openPath(fallback.path),
				},
				separator(localize('Actions', '操作')),
				{
					label: configuredManual ? localize('$(refresh) Reload Local Rules', '$(refresh) 重新加载本地规则') : localize('$(sync) Check for Rules Updates', '$(sync) 检查规则更新'),
					description: localize('Restart only the CWTools language server', '仅重启 CWTools 语言服务'),
					action: async () => { await refreshRules(options); },
				},
				{
					label: localize('$(folder-opened) Open Active Rules Folder', '$(folder-opened) 打开当前规则目录'),
					description: active?.path ?? localize('No active rules folder', '没有活动的规则目录'),
					action: () => openPath(active?.path),
				},
				{
					label: localize('$(settings-gear) Advanced Settings', '$(settings-gear) 高级设置'),
					description: 'rules_version / rules_remote_url / rules_folder',
					action: () => vs.commands.executeCommand('workbench.action.openSettings', 'stellarisLanguageServices rules') as Promise<void>,
				},
			];
			const picked = await vs.window.showQuickPick(items, {
				title: localize('Manage Rules Sources', '管理规则来源'),
				placeHolder: localize('Review the effective source, choose a mode, or run an action', '查看当前来源、选择模式或执行操作'),
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (picked?.action) await picked.action();
		}),
	);
}
