export type ToolEffect =
  | 'none'
  | 'memory'
  | 'workspace_read'
  | 'workspace_write'
  | 'network'
  | 'shell'
  | 'git'
  | 'media'
  | 'mcp';

export type ToolConcurrencyClass =
  | 'parallel'
  | 'lsp-limited'
  | 'network-limited'
  | 'per-file-write'
  | 'global-exclusive'
  | 'interactive';

export interface ToolRegistryMetadata {
  name: string;
  isWrite: boolean;
  isReadOnly: boolean;
  effect: ToolEffect;
  riskLevel: 0 | 1 | 2 | 3;
  concurrencyClass: ToolConcurrencyClass;
}
