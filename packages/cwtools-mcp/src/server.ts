import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HostServices, SharedToolDispatcher } from 'cwtools-shared';
import { listRegisteredTools } from './mcp/toolRegistrar';
import { createToolCallHandler, toMcpCallToolResult } from './mcp/toolHandlers';
import { listResources, readResource } from './mcp/resources';

export function createCwtoolsMcpServer(
  host: HostServices,
  options: { dispatcher?: SharedToolDispatcher } = {},
): Server {
  const server = new Server(
    {
      name: 'cwtools-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );
  const callTool = createToolCallHandler(host, options.dispatcher);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listRegisteredTools(),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async request =>
    readResource(host, request.params.uri),
  );

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments && typeof request.params.arguments === 'object'
      ? request.params.arguments as Record<string, unknown>
      : {};
    const result = await callTool(request.params.name, args);
    return toMcpCallToolResult(result);
  });

  return server;
}
