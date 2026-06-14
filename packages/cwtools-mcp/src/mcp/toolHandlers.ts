import {
  annotateReadiness,
  annotateVanillaCache,
  defaultSharedToolDispatcher,
  LOAD_DEPENDENT_TOOLS,
  parseReadiness,
  type HostServices,
  type LspReadiness,
  type SharedToolDispatcher,
  type SharedToolResult,
} from 'cwtools-shared';

export function createToolCallHandler(
  host: HostServices,
  dispatcher: SharedToolDispatcher = defaultSharedToolDispatcher,
): (name: string, args?: Record<string, unknown>) => Promise<SharedToolResult> {
  // The game stays loaded once ready, so probe readiness only until it flips true.
  let ready = false;
  const probeReadiness = async (): Promise<LspReadiness | undefined> => {
    if (ready) return { ready: true };
    try {
      const status = await host.lsp.executeCommand('cwtools.ai.getValidationStatus', [], { timeoutMs: 8000 });
      const verdict = parseReadiness(status);
      if (verdict.ready) ready = true;
      return verdict;
    } catch {
      return { ready: false, reason: 'lsp_unavailable' };
    }
  };

  return async (name, args = {}) => {
    const result = await dispatcher(host, name, args);
    // Tag vanilla-dependent results with cache provenance so clients never read a
    // mod-only answer as complete.
    const withVanilla = annotateVanillaCache(name, result, host.vanillaCache);
    // For load-dependent tools, mark results produced before the game is ready as
    // `loading` so clients retry instead of trusting an empty answer.
    if (!LOAD_DEPENDENT_TOOLS.has(name)) return withVanilla;
    return annotateReadiness(name, withVanilla, await probeReadiness());
  };
}

export function toMcpCallToolResult(result: SharedToolResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: 'text',
        text: `${JSON.stringify(result, null, 2)}\n`,
      },
    ],
    isError: !result.ok,
  };
}
