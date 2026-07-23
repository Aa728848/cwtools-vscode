import { getKnownProfileByLanguageId } from './gameProfiles';

export interface VanillaCacheGeneratedParams {
	gameId: string;
	message: string;
}

export interface VanillaCacheGeneratedDependencies {
	refreshVanillaSymbols(gameIds: readonly string[]): Promise<void>;
	showInformationMessage(message: string): PromiseLike<unknown> | unknown;
	reloadWindow(): PromiseLike<unknown> | unknown;
	debug(message: string): void;
	warn(message: string, error?: unknown): void;
}

export type VanillaCacheGeneratedResult = 'invalid' | 'refreshed' | 'refresh-failed';

/** Validate the LSP notification before using it to select a persistent cache. */
export function parseVanillaCacheGeneratedParams(value: unknown): VanillaCacheGeneratedParams | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.gameId !== 'string' || typeof record.message !== 'string') return undefined;
	const gameId = record.gameId.trim().toLowerCase();
	const message = record.message.trim();
	if (!gameId || !message || !getKnownProfileByLanguageId(gameId)) return undefined;
	return { gameId, message };
}

/** Rebuild the matching vanilla symbol database before honoring the LSP reload request. */
export async function handleVanillaCacheGenerated(
	value: unknown,
	dependencies: VanillaCacheGeneratedDependencies,
): Promise<VanillaCacheGeneratedResult> {
	const params = parseVanillaCacheGeneratedParams(value);
	if (!params) {
		dependencies.warn('Ignored invalid vanillaCacheGenerated notification payload');
		return 'invalid';
	}

	let result: VanillaCacheGeneratedResult = 'refreshed';
	try {
		await dependencies.refreshVanillaSymbols([params.gameId]);
		dependencies.debug(`Rebuilt vanilla symbol cache for ${params.gameId}`);
	} catch (error) {
		result = 'refresh-failed';
		dependencies.warn(`Failed to rebuild vanilla symbol cache for ${params.gameId}`, error);
	}

	void Promise.resolve(dependencies.showInformationMessage(params.message)).catch(error => {
		dependencies.warn('Failed to show the vanilla cache completion message', error);
	});
	await dependencies.reloadWindow();
	return result;
}
