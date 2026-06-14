#!/usr/bin/env node

import { parseCliArgs } from './config';
import { createNodeHostServices } from './hosts/nodeHostServices';
import { runHttpTransport } from './mcp/transportHttp';
import { runStdioTransport } from './mcp/transportStdio';
import { createCwtoolsMcpServer } from './server';

async function main(): Promise<void> {
  const config = parseCliArgs(process.argv.slice(2));
  const host = createNodeHostServices(config);
  if (config.http) {
    await runHttpTransport(() => createCwtoolsMcpServer(host), { host: config.host, port: config.port });
  } else if (config.stdio) {
    const server = createCwtoolsMcpServer(host);
    await runStdioTransport(server);
  } else {
    throw new Error('No MCP transport selected. Use --stdio or --http.');
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
