import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import type { SharedToolResult } from '../tools/schema';

export type AgentMode =
  | 'build'
  | 'plan'
  | 'explore'
  | 'general'
  | 'utility'
  | 'review'
  | 'gui_expert'
  | 'script_reviewer'
  | 'loc_translator'
  | 'loc_writer'
  | 'orchestrator'
  | 'script';

export interface QueryProjectProfileArgs {
  section?: 'summary' | 'routing' | 'directories' | 'localisation' | 'identifiers' | 'validation' | 'promptCards' | 'all';
  mode?: AgentMode | 'asset';
}

export interface ProjectProfile {
  schemaVersion: 1;
  generatedAt: string;
  workspaceRoot: string;
  workspaceKind: string;
  projectName: string;
  game: {
    id: string;
    displayName: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: string[];
  };
  keyDirectories: Array<{
    key: string;
    path: string;
    exists: boolean;
    fileCount?: number;
  }>;
  localisation: {
    roots: string[];
    languages: string[];
    encoding: string;
    sampleFiles: string[];
  };
  identifiers: Record<string, unknown>;
  routing: Record<string, unknown>;
  validation: Record<string, unknown>;
  promptCards: Partial<Record<AgentMode | 'asset', string>>;
  efficiencyHints: string[];
  [key: string]: unknown;
}

export const PROJECT_PROFILE_RELATIVE_PATH = path.join('.cwtools', 'project', 'profile.json');

export function getProjectProfilePath(workspaceRoot: string): string {
  try {
    const fs = require('fs');
    const primary = path.join(workspaceRoot, '.cwtools', 'project', 'profile.json');
    if (fs.existsSync(primary)) return primary;
    const legacy = path.join(workspaceRoot, '.cwtools-ai', 'project', 'profile.json');
    if (fs.existsSync(legacy)) return legacy;
    return primary;
  } catch {
    return path.join(workspaceRoot, PROJECT_PROFILE_RELATIVE_PATH);
  }
}

export function isProjectProfile(value: unknown): value is ProjectProfile {
  return !!value
    && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 1
    && typeof (value as { projectName?: unknown }).projectName === 'string';
}

export function buildProfileSummary(profile: ProjectProfile): string {
  const dirs = profile.keyDirectories.filter(dir => dir.exists).map(dir => dir.path).slice(0, 8).join(', ') || 'none';
  const namespaces = Array.isArray(profile.identifiers.namespaces)
    ? profile.identifiers.namespaces.slice(0, 8).join(', ') || 'none'
    : 'none';
  const languages = profile.localisation.languages.join(', ') || 'unknown';
  return [
    `Project: ${profile.projectName}`,
    `Kind: ${profile.workspaceKind}`,
    `Game: ${profile.game.displayName}`,
    `Key dirs: ${dirs}`,
    `Namespaces: ${namespaces}`,
    `Localisation: ${languages} (${profile.localisation.encoding})`,
  ].join('\n');
}

export function getPromptCardForMode(profile: ProjectProfile, mode?: AgentMode | 'asset'): string | undefined {
  if (!mode) return undefined;
  if (mode === 'loc_translator' || mode === 'loc_writer') return profile.promptCards.loc_writer ?? profile.promptCards.build;
  if (mode === 'gui_expert') return profile.promptCards.asset ?? profile.promptCards.build;
  if (mode === 'script_reviewer') return profile.promptCards.review;
  return profile.promptCards[mode] ?? profile.promptCards.build;
}

export function selectProfileSection(profile: ProjectProfile, section: NonNullable<QueryProjectProfileArgs['section']>): unknown {
  switch (section) {
    case 'routing': return profile.routing;
    case 'directories': return profile.keyDirectories;
    case 'localisation': return profile.localisation;
    case 'identifiers': return profile.identifiers;
    case 'validation': return profile.validation;
    case 'promptCards': return profile.promptCards;
    case 'all': return profile;
    case 'summary':
    default:
      return {
        workspaceKind: profile.workspaceKind,
        projectName: profile.projectName,
        game: profile.game,
        generatedAt: profile.generatedAt,
        efficiencyHints: profile.efficiencyHints,
      };
  }
}

export async function queryProjectProfileWithHost(
  host: HostServices,
  args: QueryProjectProfileArgs = {},
): Promise<SharedToolResult> {
  const profilePath = getProjectProfilePath(host.workspaceRoot);
  try {
    const read = await host.filesystem.readTextFile(profilePath);
    if (!read.exists) {
      return {
        ok: false,
        status: 'unavailable',
        source: 'cwtools-shared',
        error: {
          code: 'profile_missing',
          message: 'Project profile is missing.',
        },
        data: {
          status: 'missing',
          profilePath,
          _hint: 'Run /init in the VS Code extension or create .cwtools/project/profile.json, then retry.',
        },
      };
    }

    const parsed = JSON.parse(read.content) as unknown;
    if (!isProjectProfile(parsed)) {
      return {
        ok: false,
        status: 'error',
        source: 'cwtools-shared',
        error: {
          code: 'invalid_profile',
          message: 'Project profile exists but is not schemaVersion 1.',
        },
      };
    }

    const section = args.section ?? 'summary';
    return {
      ok: true,
      status: 'ready',
      source: 'cwtools-shared',
      data: {
        status: 'ready',
        profilePath,
        generatedAt: parsed.generatedAt,
        section,
        profile: section === 'all' ? parsed : undefined,
        summary: buildProfileSummary(parsed),
        data: selectProfileSection(parsed, section),
        promptCard: getPromptCardForMode(parsed, args.mode),
        _hint: 'Use section="routing", "localisation", "identifiers", or a mode-specific promptCard for targeted context.',
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      source: 'cwtools-shared',
      error: {
        code: 'profile_error',
        message: error instanceof Error ? error.message : String(error),
      },
      data: {
        status: 'error',
        profilePath,
      },
    };
  }
}
