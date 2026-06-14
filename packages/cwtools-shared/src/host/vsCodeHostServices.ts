import type { HostServices } from './hostServices';

export interface VsCodeHostServicesPorts {
  workspaceRoot: string;
  readonlyMode: boolean;
  writesEnabled: boolean;
  executeLspCommand<T = unknown>(command: string, args?: unknown[], timeoutMs?: number): Promise<T>;
  getDiagnostics(args?: unknown): Promise<unknown>;
  readTextFile(path: string): Promise<{ content: string; hasBom: boolean; exists: boolean }>;
  writeTextFile(path: string, content: string): Promise<void>;
  list(path: string): Promise<Array<{ name: string; type: 'file' | 'directory'; size?: number }>>;
  glob(pattern: string, options?: { limit?: number }): Promise<string[]>;
  queryWorkspaceIndex?(args: unknown): Promise<unknown>;
  queryLocalisationIndex?(args: unknown): Promise<unknown>;
  now?(): number;
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

export function createVsCodeHostServicesSkeleton(ports: VsCodeHostServicesPorts): HostServices {
  return {
    workspaceRoot: ports.workspaceRoot,
    readonlyMode: ports.readonlyMode,
    writesEnabled: ports.writesEnabled,
    lsp: {
      executeCommand: (command, args, options) => ports.executeLspCommand(command, args, options?.timeoutMs),
    },
    diagnostics: {
      getDiagnostics: async args => ports.getDiagnostics(args) as never,
    },
    filesystem: {
      readTextFile: path => ports.readTextFile(path),
      writeTextFile: (path, content) => ports.writeTextFile(path, content),
      list: path => ports.list(path),
      glob: (pattern, options) => ports.glob(pattern, options),
    },
    indexing: ports.queryWorkspaceIndex && ports.queryLocalisationIndex
      ? {
          queryWorkspace: async query => ports.queryWorkspaceIndex!(query) as never,
          queryLocalisation: async query => ports.queryLocalisationIndex!(query) as never,
        }
      : undefined,
    now: ports.now ?? (() => Date.now()),
    log: ports.log ?? (() => undefined),
  };
}
