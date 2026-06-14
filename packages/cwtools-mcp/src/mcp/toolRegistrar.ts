import { listMcpToolSchemas, type McpToolSchema } from 'cwtools-shared';

export function listRegisteredTools(): McpToolSchema[] {
  return listMcpToolSchemas();
}
