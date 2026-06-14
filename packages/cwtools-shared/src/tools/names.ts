export const MCP_TOOL_NAMES = [
  'query_types',
  'query_rules',
  'query_scope',
  'get_diagnostics',
  'analyze_diagnostic_error',
  'query_project_profile',
  'query_workspace_index',
  'query_localisation_index',
  'get_pdx_block',
  'get_completion_at',
  'document_symbols',
  'workspace_symbols',
  'query_definition',
  'query_definition_by_name',
  'query_references',
  'write_localisation',
  'edit_pdx_block',
] as const;

export type McpToolName = typeof MCP_TOOL_NAMES[number];

export const MCP_WRITE_TOOL_NAMES = [
  'write_localisation',
  'edit_pdx_block',
] as const satisfies readonly McpToolName[];

export const MCP_READONLY_TOOL_NAMES = MCP_TOOL_NAMES.filter(
  (name): name is Exclude<McpToolName, typeof MCP_WRITE_TOOL_NAMES[number]> =>
    !(MCP_WRITE_TOOL_NAMES as readonly string[]).includes(name),
);

export function isMcpToolName(value: string): value is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(value);
}

export function isMcpWriteToolName(value: string): value is typeof MCP_WRITE_TOOL_NAMES[number] {
  return (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(value);
}
