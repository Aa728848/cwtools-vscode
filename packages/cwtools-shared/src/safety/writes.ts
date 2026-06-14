import type { HostServices } from '../host/hostServices';
import { toolDenied, type SharedToolResult } from '../tools/schema';
import { isMcpWriteToolName } from '../tools/names';

export function ensureToolWriteAllowed(host: HostServices, toolName: string): SharedToolResult | null {
  if (!isMcpWriteToolName(toolName)) return null;

  if (host.readonlyMode) {
    return toolDenied('read_only', `${toolName} is disabled because the MCP server is running in read-only mode.`);
  }
  if (!host.writesEnabled) {
    return toolDenied('writes_disabled', `${toolName} requires --enable-writes.`);
  }
  if (host.allowedWriteTools && !host.allowedWriteTools.has(toolName)) {
    return toolDenied('tool_not_allowed', `${toolName} is not in the configured write-tool allowlist.`);
  }
  return null;
}
