export interface LspCommandOptions {
  timeoutMs?: number;
}

export interface LspHost {
  executeCommand<T = unknown>(
    command: string,
    args?: unknown[],
    options?: LspCommandOptions,
  ): Promise<T>;
  request?<T = unknown>(
    method: string,
    params?: unknown,
    options?: LspCommandOptions,
  ): Promise<T>;
}

export function createUnavailableLspHost(message = 'CWTools LSP is not connected.'): LspHost {
  return {
    async executeCommand<T = unknown>() {
      return {
        ok: false,
        status: 'unavailable',
        error: {
          code: 'lsp_unavailable',
          message,
        },
      } as T;
    },
    async request<T = unknown>() {
      return {
        ok: false,
        status: 'unavailable',
        error: {
          code: 'lsp_unavailable',
          message,
        },
      } as T;
    },
  };
}
