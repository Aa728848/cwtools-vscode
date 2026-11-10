import { getAllProfiles } from './gameProfiles';
import type { WorkspaceDetectionProfile } from './workspaceGameDetection';

/** Minimal profile shape needed by workspace detection; no UI or preview data. */
export function getWorkspaceDetectionProfiles(): WorkspaceDetectionProfile[] {
	return getAllProfiles().map(profile => ({
		id: profile.id,
		displayName: profile.displayName,
		steamFolderName: profile.install.steamFolderName,
		exeName: profile.install.exeName,
		alternativeFolderNames: [...profile.install.alternativeFolderNames],
		steamAppId: profile.install.steamAppId,
	}));
}
