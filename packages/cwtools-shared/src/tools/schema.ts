import type { ToolRegistryMetadata } from './registry';

export type JsonObject = Record<string, unknown>;

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface GeneratedMcpTool {
  tool: McpToolSchema;
  registry: ToolRegistryMetadata;
}

export interface SharedToolError {
  code: string;
  message: string;
}

export interface SharedToolResult<T = unknown> {
  ok: boolean;
  status: 'ready' | 'partial' | 'success' | 'denied' | 'loading' | 'stale' | 'unavailable' | 'error';
  source: string;
  data?: T;
  error?: SharedToolError;
  warnings?: string[];
  nextSteps?: string[];
  // Vanilla game-cache provenance attached by the MCP adapter for
  // vanilla-dependent tools (see host/vanillaCache.ts). Optional and additive.
  vanillaCache?: import('../host/vanillaCache').VanillaCacheStatus;
  // Live load-readiness attached by the MCP adapter for load-dependent tools
  // (see host/readiness.ts). Optional and additive.
  readiness?: import('../host/readiness').LspReadiness;
}

export function toolUnavailable(tool: string, message: string, nextSteps: string[] = []): SharedToolResult {
  return {
    ok: false,
    status: 'unavailable',
    source: 'cwtools-shared',
    error: { code: 'unavailable', message },
    nextSteps,
  };
}

export function toolDenied(code: string, message: string): SharedToolResult {
  return {
    ok: false,
    status: 'denied',
    source: 'cwtools-shared',
    error: { code, message },
  };
}
