import { expect } from 'chai';
import {
	DARK_2026_THEME_PROMPT_KEY,
	DEFAULT_DARK_MODERN_THEME_NAME,
	isDark2026ColorTheme,
	maybePromptForDefaultDarkModernTheme,
	type ThemePromptServices,
} from '../../extension/themePrompt';

function createServices(currentTheme: string, choice?: string): ThemePromptServices & {
	prompts: string[];
	updates: Array<{ key: string; value: unknown; target: unknown }>;
	state: Map<string, unknown>;
} {
	const state = new Map<string, unknown>();
	const prompts: string[] = [];
	const updates: Array<{ key: string; value: unknown; target: unknown }> = [];
	const globalTarget = Symbol('global');

	return {
		envLanguage: 'en',
		configurationTargetGlobal: globalTarget,
		state,
		prompts,
		updates,
		globalState: {
			get: <T>(key: string) => state.get(key) as T | undefined,
			update: async (key: string, value: unknown) => {
				state.set(key, value);
			},
		},
		getConfiguration: () => ({
			get: <T>(key: string, defaultValue: T) => key === 'colorTheme' ? currentTheme as T : defaultValue,
			update: async (key: string, value: unknown, target: unknown) => {
				updates.push({ key, value, target });
			},
		}),
		showInformationMessage: async (message: string) => {
			prompts.push(message);
			return choice;
		},
		warn: () => undefined,
	};
}

describe('themePrompt', () => {
	it('detects only 2026 dark themes', () => {
		expect(isDark2026ColorTheme('2026 Dark')).to.equal(true);
		expect(isDark2026ColorTheme('2026 深色')).to.equal(true);
		expect(isDark2026ColorTheme('Default Dark Modern')).to.equal(false);
		expect(isDark2026ColorTheme(DEFAULT_DARK_MODERN_THEME_NAME)).to.equal(false);
		expect(isDark2026ColorTheme('2026 Light')).to.equal(false);
	});

	it('prompts once and switches to the Default Dark Modern theme when accepted', async () => {
		const services = createServices('2026 Dark', 'Switch Theme');

		await maybePromptForDefaultDarkModernTheme(services);
		await maybePromptForDefaultDarkModernTheme(services);

		expect(services.prompts).to.have.lengthOf(1);
		expect(services.state.get(DARK_2026_THEME_PROMPT_KEY)).to.equal(true);
		expect(services.updates).to.deep.equal([
			{
				key: 'colorTheme',
				value: DEFAULT_DARK_MODERN_THEME_NAME,
				target: services.configurationTargetGlobal,
			},
		]);
	});

	it('does not prompt for non-2026 themes', async () => {
		const services = createServices('Default Dark Modern', 'Switch Theme');

		await maybePromptForDefaultDarkModernTheme(services);

		expect(services.prompts).to.have.lengthOf(0);
		expect(services.updates).to.have.lengthOf(0);
	});
});
