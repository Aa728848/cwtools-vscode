#!/usr/bin/env node

import type { HostServices } from 'cwtools-shared';
import { parseCliArgs } from './config';
import { createNodeHostServices } from './hosts/nodeHostServices';
import { runHttpTransport } from './mcp/transportHttp';
import { runStdioTransport } from './mcp/transportStdio';
import { createCwtoolsMcpServer } from './server';

// Tear down host-owned resources (the spawned CWTools Server child) exactly
// once, then exit. MCP clients like Codex disconnect by closing the stdio pipe
// rather than asking us to shut down; without this the LSP child's pipes keep
// the event loop alive and orphan a multi-GB server process. host.dispose()
// only kills the child THIS process spawned, never any other instance.
function installLifecycle(host: HostServices, stdio: boolean): void {
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      host.dispose?.();
    } catch {
      // best-effort cleanup
    }
  };
  const shutdown = (): void => {
    dispose();
    process.exit(0);
  };
  // Synchronous safety net for any other exit path.
  process.once('exit', dispose);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.platform !== 'win32') process.once('SIGHUP', shutdown);
  // In stdio mode the client closing the pipe (EOF on our stdin) is the
  // disconnect signal — shut down instead of lingering.
  if (stdio) {
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
  }
}

async function main(): Promise<void> {
  const config = parseCliArgs(process.argv.slice(2));
  const host = createNodeHostServices(config);
  installLifecycle(host, !!config.stdio && !config.http);
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
