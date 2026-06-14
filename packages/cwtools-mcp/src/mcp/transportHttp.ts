import * as http from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface HttpTransportOptions {
  host: string;
  port: number;
  path?: string;
}

export async function runHttpTransport(
  createServer: () => Server,
  options: HttpTransportOptions,
): Promise<void> {
  const endpointPath = options.path ?? '/mcp';

  const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${options.host}:${options.port}`}`);
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, name: 'cwtools-mcp' }));
      return;
    }
    if (url.pathname !== endpointPath) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const requestServer = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await requestServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
      }
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
        id: null,
      }));
    } finally {
      response.once('close', () => {
        transport.close().catch(() => undefined);
        requestServer.close();
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', reject);
      console.error(`[cwtools-mcp] Streamable HTTP listening at http://${options.host}:${options.port}${endpointPath}`);
      resolve();
    });
  });

  await new Promise<void>(resolve => {
    const shutdown = async () => {
      httpServer.close(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
