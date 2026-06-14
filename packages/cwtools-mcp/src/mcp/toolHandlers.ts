import {
  defaultSharedToolDispatcher,
  type HostServices,
  type SharedToolDispatcher,
  type SharedToolResult,
} from 'cwtools-shared';

export function createToolCallHandler(
  host: HostServices,
  dispatcher: SharedToolDispatcher = defaultSharedToolDispatcher,
): (name: string, args?: Record<string, unknown>) => Promise<SharedToolResult> {
  return async (name, args = {}) => dispatcher(host, name, args);
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
