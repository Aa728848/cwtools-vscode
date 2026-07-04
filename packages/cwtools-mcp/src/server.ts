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

// Server-level guidance surfaced to the model at connect time (MCP `instructions`).
// Tells a Paradox coding agent to ground every claim in these tools.
const SERVER_INSTRUCTIONS = [
  'CWTools is a read-only semantic service for Paradox mods. Ground every',
  'claim about the mod in these tools instead of memory — PDX identifiers and syntax',
  'are routinely hallucinated.',
  '',
  'Use it whenever working in a Paradox mod (common/, events/, localisation/, gfx/, …):',
  '- Before using ANY game ID, verify it exists: query_types for typed entities;',
  '  query_scripted_effects / query_scripted_triggers / query_static_modifiers /',
  '  query_enums / query_variables for those kinds.',
  '- Check trigger/effect/scope-change/modifier syntax with query_rules; check the scope',
  '  valid at a position with query_scope.',
  '- Before declaring code correct, review get_diagnostics (whole project). Honor the',
  '  readiness/freshness fields: if readiness.ready is false the project is still loading —',
  '  retry; an empty result then is not authoritative.',
  '- Navigate with query_definition / query_definition_by_name / query_references /',
  '  document_symbols / workspace_symbols; read structured blocks with get_pdx_block',
  '  instead of reading whole files. get_entity_info gives a file\'s referenced types/vars.',
  '- Results carry vanillaCache metadata: if available is false, vanilla IDs are missing',
  '  and references to them may show as false errors.',
  '',
  'This server never writes files — perform edits with your own environment, then',
  're-check with get_diagnostics.',
].join('\n');

export function createCwtoolsMcpServer(
  host: HostServices,
  options: { dispatcher?: SharedToolDispatcher } = {},
): Server {
  // Undefined => treat as supported (e.g. the in-extension host never sets it).
  const supported = host.projectSupported !== false;
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
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  const callTool = createToolCallHandler(host, options.dispatcher);

  // Tools stay listed even on unsupported workspaces so the model can always see
  // CWTools exists (instead of falling back to hunting for a CLI). The heavy work
  // is gated at call time below, not by hiding the toolset.
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
    // On an unsupported workspace, reject before dispatch so the language server
    // is never spawned (memory). The message is actionable: the resolved
    // workspace is almost always the cause when this fires on a real mod.
    if (!supported) {
      return toMcpCallToolResult({
        ok: false,
        status: 'denied',
        source: 'cwtools-mcp',
        error: {
          code: 'project_not_supported',
          message:
            `CWTools is disabled for this workspace (${host.workspaceRoot}): ${host.projectSupportReason ?? 'not a Paradox mod.'} ` +
            'If this IS a mod, point the server at the mod root — set the working directory (or pass --workspace <mod>) — or pass --force-start to override.',
        },
      });
    }
    const args = request.params.arguments && typeof request.params.arguments === 'object'
      ? request.params.arguments as Record<string, unknown>
      : {};
    const result = await callTool(request.params.name, args);
    return toMcpCallToolResult(result);
  });

  return server;
}
