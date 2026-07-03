export const STELLARIS_DARK_MODERN_THEME_NAME = 'Stellaris Dark Modern';
export const DARK_2026_THEME_PROMPT_KEY = 'stellarisLanguageServices.themePrompt.dark2026';

interface ConfigurationLike {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown, target: unknown): Thenable<void> | Promise<void> | void;
}

interface GlobalStateLike {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

export interface ThemePromptServices {
	envLanguage: string;
	configurationTargetGlobal: unknown;
	globalState: GlobalStateLike;
	getConfiguration(section: string): ConfigurationLike;
	showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined> | Promise<string | undefined>;
	warn(message: string, error?: unknown): void;
}

function themePromptLocalize(envLanguage: string, en: string, zh: string): string {
	return envLanguage.toLowerCase().startsWith('zh') ? zh : en;
}

export function isDark2026ColorTheme(themeName: string | undefined | null): boolean {
	const normalized = (themeName ?? '').trim().toLowerCase();
	if (!normalized || normalized === STELLARIS_DARK_MODERN_THEME_NAME.toLowerCase()) {
		return false;
	}

	return normalized.includes('2026')
		&& (normalized.includes('dark') || normalized.includes('深色'));
}

export async function maybePromptForStellarisDarkModernTheme(services: ThemePromptServices): Promise<void> {
	const config = services.getConfiguration('workbench');
	const currentTheme = config.get<string>('colorTheme', '');
	if (!isDark2026ColorTheme(currentTheme)) {
		return;
	}

	if (services.globalState.get<boolean>(DARK_2026_THEME_PROMPT_KEY)) {
		return;
	}

	await services.globalState.update(DARK_2026_THEME_PROMPT_KEY, true);

	const switchTheme = themePromptLocalize(services.envLanguage, 'Switch Theme', '切换主题');
	const later = themePromptLocalize(services.envLanguage, 'Later', '稍后');
	const choice = await services.showInformationMessage(
		themePromptLocalize(
			services.envLanguage,
			'The current 2026 Dark theme may make Paradox script highlighting hard to read. Switch to Stellaris Dark Modern?',
			'当前 2026 深色主题可能导致 Paradox 脚本高亮不够清晰。是否切换到 Stellaris 现代深色？'
		),
		switchTheme,
		later
	);

	if (choice !== switchTheme) {
		return;
	}

	try {
		await config.update('colorTheme', STELLARIS_DARK_MODERN_THEME_NAME, services.configurationTargetGlobal);
	} catch (error) {
		services.warn('Failed to switch to the bundled Stellaris Dark Modern theme', error);
	}
}
