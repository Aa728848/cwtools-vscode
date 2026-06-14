import {
  annotateVanillaCache,
  defaultSharedToolDispatcher,
  type HostServices,
  type SharedToolDispatcher,
  type SharedToolResult,
} from 'cwtools-shared';

export function createToolCallHandler(
  host: HostServices,
  dispatcher: SharedToolDispatcher = defaultSharedToolDispatcher,
): (name: string, args?: Record<string, unknown>) => Promise<SharedToolResult> {
  return async (name, args = {}) => {
    const result = await dispatcher(host, name, args);
    // Tag vanilla-dependent results with cache provenance so clients never read a
    // mod-only answer as complete.
    return annotateVanillaCache(name, result, host.vanillaCache);
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
