import type { SharedToolResult } from '../tools/schema';

// Availability of the vanilla game cache (the serialized `.cwb` produced from a
// vanilla install). Without it, LSP results reflect mod files only: vanilla IDs
// are missing and mod references to vanilla definitions surface as false errors.
export interface VanillaCacheStatus {
  available: boolean;
  // mod_plus_vanilla: vanilla cache loaded; mod_only: no vanilla data.
  source: 'mod_plus_vanilla' | 'mod_only';
  // Resolved `.cwb` path the host probed (present whether or not it exists yet).
  cacheFile?: string;
  // Game data dir that can build the cache when no `.cwb` exists yet.
  gamePath?: string;
  reason?: string;
}

// Game id -> `.cwb` prefix, mirroring GameLoader.fs getCachedFiles / Program.fs
// checkOrSetGameCache. Keep in sync with the F# side.
const GAME_CACHE_PREFIX: Record<string, string> = {
  stellaris: 'stl',
  hoi4: 'hoi4',
  eu4: 'eu4',
  eu5: 'eu5',
  ck2: 'ck2',
  ck3: 'ck3',
  imperator: 'ir',
  vic2: 'vic2',
  vic3: 'vic3',
};

export function vanillaCacheFileName(game: string | undefined): string | undefined {
  const prefix = GAME_CACHE_PREFIX[(game ?? 'stellaris').toLowerCase()];
  return prefix ? `${prefix}.cwb` : undefined;
}

// Read-only tools whose results are only complete when vanilla data is loaded.
// query_rules is excluded: it resolves from bundled CWT rules, not vanilla data.
export const VANILLA_DEPENDENT_TOOLS: ReadonlySet<string> = new Set([
  'query_types',
  'get_completion_at',
  'query_scope',
  'query_definition',
  'query_definition_by_name',
  'explore_pdx_project',
  'query_project_knowledge',
  'query_references',
  'get_diagnostics',
  'query_scripted_effects',
  'query_scripted_triggers',
  'query_enums',
  'query_static_modifiers',
  'query_variables',
  'get_entity_info',
]);

export const VANILLA_UNAVAILABLE_WARNING =
  'Vanilla game cache is not loaded; results reflect mod files only. Vanilla IDs will not appear and mod references to vanilla definitions may be reported as undefined. Pass --cache <dir> (a built .cwb cache dir) or --game-path <dir> (a vanilla install to build from).';

// Attach vanilla-cache provenance to a vanilla-dependent tool result so external
// agents never mistake a mod-only answer for a complete one. Pure; no IO.
export function annotateVanillaCache(
  toolName: string,
  result: SharedToolResult,
  status: VanillaCacheStatus | undefined,
): SharedToolResult {
  if (!status || !VANILLA_DEPENDENT_TOOLS.has(toolName)) return result;
  const annotated: SharedToolResult & { vanillaCache?: VanillaCacheStatus } = {
    ...result,
    vanillaCache: status,
  };
  if (!status.available) {
    annotated.warnings = [...(result.warnings ?? []), VANILLA_UNAVAILABLE_WARNING];
  }
  return annotated;
}
