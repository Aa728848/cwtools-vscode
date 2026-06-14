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
  vanillaCache?: VanillaCacheStatus;
  projectSupported?: boolean;
  projectSupportReason?: string;
  now(): number;
  log(level: HostLogLevel, message: string, data?: unknown): void;
  dispose?(): void;
}
