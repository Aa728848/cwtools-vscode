import { GENERATED_MCP_TOOLS } from '../generated/mcpTools';
import type { GeneratedMcpTool, McpToolSchema } from './schema';

export function getGeneratedMcpTools(): readonly GeneratedMcpTool[] {
  return GENERATED_MCP_TOOLS;
}

export function listMcpToolSchemas(): McpToolSchema[] {
  return GENERATED_MCP_TOOLS.map(entry => ({ ...entry.tool }));
}

export function getMcpToolSchema(name: string): McpToolSchema | undefined {
  return GENERATED_MCP_TOOLS.find(entry => entry.tool.name === name)?.tool;
}

export function getMcpToolRegistryMetadata(name: string): GeneratedMcpTool['registry'] | undefined {
  return GENERATED_MCP_TOOLS.find(entry => entry.registry.name === name)?.registry;
}
