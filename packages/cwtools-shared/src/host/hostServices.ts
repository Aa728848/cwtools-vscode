import type { DiagnosticsHost } from './diagnostics';
import type { FilesystemHost } from './filesystem';
import type { IndexHost } from './indexing';
import type { LspHost } from './lsp';
import type { VanillaCacheStatus } from './vanillaCache';

export type HostLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ProjectProfileHost {
  readProfile(): Promise<unknown | null>;
}

export interface GameKnowledgeHost {
  queryProfile?(args?: unknown): Promise<unknown>;
  queryHints?(args?: unknown): Promise<unknown>;
  queryDiagnosticKnowledge?(args?: unknown): Promise<unknown>;
}

export interface CompletionHost {
  getCompletionContext(args: unknown): Promise<unknown>;
}

export interface HostServices {
  workspaceRoot: string;
  readonlyMode: boolean;
  writesEnabled: boolean;
  allowedWriteTools?: ReadonlySet<string>;
  lsp: LspHost;
  diagnostics: DiagnosticsHost;
  filesystem: FilesystemHost;
  indexing?: IndexHost;
  projectProfile?: ProjectProfileHost;
  knowledge?: GameKnowledgeHost;
  completion?: CompletionHost;
  // Vanilla game-cache availability; consumed by the MCP adapter to annotate
  // vanilla-dependent tool results. Undefined hosts skip the annotation.
  vanillaCache?: VanillaCacheStatus;
  now(): number;
  log(level: HostLogLevel, message: string, data?: unknown): void;
}
