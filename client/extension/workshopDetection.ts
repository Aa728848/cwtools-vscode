/**
 * Steam Workshop workspace detection.
 *
 * Workshop mods live under `steamapps/workshop/content/<appId>/<itemId>`.
 * The App ID in the path is the most reliable game-identification signal
 * available — far better than text/marker scoring — so it is used both to
 * correct misdetection and to gate activation behind explicit user consent.
 *
 * This module deliberately avoids importing `vscode` so unit tests can load
 * it directly without stubs.
 */

import { getAllProfiles } from './gameProfiles';

/**
 * Extracts the Steam App ID from a workshop content path.
 * Matches a `workshop` segment immediately followed by `content` and a
 * purely numeric segment, case-insensitively and across path separators.
 */
export function parseWorkshopContentAppId(rootPath: string): string | undefined {
	const segments = rootPath.split(/[\\/]+/).filter(Boolean);
	for (let i = 0; i < segments.length - 2; i++) {
		if (segments[i]!.toLowerCase() === 'workshop' && segments[i + 1]!.toLowerCase() === 'content') {
			const appId = segments[i + 2]!;
			if (/^\d+$/.test(appId)) {
				return appId;
			}
		}
	}
	return undefined;
}

/**
 * Maps a Steam App ID to a registered game language ID.
 * Placeholder App IDs ('0', e.g. EU5 until the real one is known) never match.
 */
export function getGameIdForWorkshopAppId(appId: string): string | undefined {
	if (!/^\d+$/.test(appId) || appId === '0') {
		return undefined;
	}
	for (const profile of getAllProfiles()) {
		if (profile.install.steamAppId === appId) {
			return profile.id;
		}
	}
	return undefined;
}
