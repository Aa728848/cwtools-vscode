import type { SharedToolResult } from '../tools/schema';

// Whether the CWTools game/types/rules are fully loaded. Unlike VanillaCacheStatus
// (static at startup) this is live: during the initial load (or a reload) semantic
// queries return empty, which must not be mistaken for "nothing found".
export interface LspReadiness {
  ready: boolean;
  phase?: string;
  inProgress?: boolean;
  reason?: string;
}

// Semantic tools that need the game fully loaded to return trustworthy results.
// get_pdx_block is excluded: it is plain in-workspace text extraction.
export const LOAD_DEPENDENT_TOOLS: ReadonlySet<string> = new Set([
  'query_types',
  'query_rules',
  'search_rule_capabilities',
  'explain_scope',
  'parse_pdx_fragment',
  'query_scope',
  'get_completion_at',
  'query_definition',
  'query_definition_by_name',
  'query_references',
  'get_diagnostics',
  'query_scripted_effects',
  'query_scripted_triggers',
  'query_enums',
  'query_static_modifiers',
  'query_variables',
  'get_entity_info',
]);

export const READINESS_LOADING_WARNING =
  'CWTools is still loading the project (parsing vanilla + building types/rules); this result is not yet authoritative. Retry after loading completes.';

// Parse cwtools.ai.getValidationStatus into a readiness verdict. Pure; no IO.
export function parseReadiness(validationStatus: unknown): LspReadiness {
  const rec = validationStatus && typeof validationStatus === 'object'
    ? validationStatus as Record<string, unknown>
    : {};
  if (rec.ok === false || rec.status === 'unavailable') {
    return { ready: false, reason: 'lsp_unavailable' };
  }
  const loading = rec.loading && typeof rec.loading === 'object'
    ? rec.loading as Record<string, unknown>
    : {};
  const inProgress = loading.inProgress === true;
  const phase = typeof loading.phase === 'string' ? loading.phase : undefined;
  const everLoaded = phase !== undefined && phase !== 'not_started';
  const ready = !inProgress && everLoaded;
  return {
    ready,
    phase,
    inProgress,
    reason: ready ? undefined : inProgress ? `loading:${phase ?? 'unknown'}` : 'not_started',
  };
}

// Mark a load-dependent result as `loading` (not a trustworthy empty answer) when
// the game is not ready yet, so clients retry instead of trusting the result. Pure.
export function annotateReadiness(
  toolName: string,
  result: SharedToolResult,
  readiness: LspReadiness | undefined,
): SharedToolResult {
  if (!readiness || !LOAD_DEPENDENT_TOOLS.has(toolName)) return result;
  if (readiness.ready) {
    return { ...result, readiness } as SharedToolResult & { readiness?: LspReadiness };
  }
  return {
    ...result,
    ok: true,
    status: 'loading',
    readiness,
    warnings: [...(result.warnings ?? []), READINESS_LOADING_WARNING],
    nextSteps: [
      ...(result.nextSteps ?? []),
      'Retry after the project finishes loading (poll get_diagnostics until freshness is fresh).',
    ],
  } as SharedToolResult & { readiness?: LspReadiness };
}
