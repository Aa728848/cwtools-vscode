import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const localRequire = createRequire(__filename);
type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleLoader = localRequire('module') as { _load: ModuleLoad };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return { window: { createOutputChannel: () => ({ appendLine() {} }) }, workspace: {}, env: {}, Uri: {}, commands: {}, languages: {}, extensions: {} };
    }
    return originalLoad(request, parent, isMain);
};
interface TestServerOptions {
    context: unknown;
    toolExecutor: unknown;
    workspaceRoot: string;
    detectProject: () => unknown;
    isActive: () => boolean;
    readyAtMs: () => number;
    executeCommand: (command: string, args: unknown[]) => Promise<unknown>;
    lspRequest: (method: string, params: unknown) => Promise<unknown>;
}
const { McpBridgeServer } = localRequire('../../../release/bin/client/extension/ai/mcpBridgeServer.js') as {
    McpBridgeServer: new (options: TestServerOptions) => { start(): Promise<void>; stop(): Promise<void> };
};
moduleLoader._load = originalLoad;

interface TestManifest {
    token: string;
    cwtoolsNativeRpcUrl: string;
    cwtoolsNativeHealthUrl: string;
    rpcUrl: string;
}

describe('McpBridgeServer native CWTools API', () => {
    it('serves native health/RPC while preserving the MCP endpoint', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-native-server-'));
        const server = new McpBridgeServer({
            context: {
                globalStorageUri: { fsPath: root },
                extensionPath: root,
                extension: { id: 'cwtools.test' },
            } as never,
            toolExecutor: {} as never,
            workspaceRoot: 'C:/mod',
            detectProject: () => ({ kind: 'mod', strength: 'composite', evidence: ['fixture'], reason: 'fixture' }),
            isActive: () => true,
            readyAtMs: () => 123,
            executeCommand: async (command, args) => ({ command, args }),
            lspRequest: async (method, params) => ({ method, params }),
        });
        try {
            await server.start();
            const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mcp', 'bridge-manifest.json'), 'utf8')) as TestManifest;
            expect(manifest.cwtoolsNativeRpcUrl).to.include('/cwtools/rpc');
            expect(manifest.cwtoolsNativeHealthUrl).to.include('/cwtools/healthz');

            const health = await (await fetch(manifest.cwtoolsNativeHealthUrl)).json() as Record<string, unknown>;
            expect(health.active).to.equal(true);
            expect(health.readyAtMs).to.equal(123);
            expect(health.protocolVersion).to.equal(1);

            const response = await fetch(manifest.cwtoolsNativeRpcUrl, {
                method: 'POST',
                headers: { authorization: `Bearer ${manifest.token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cwtools/executeCommand', params: {
                    command: 'cwtools.ai.getHostCapabilities', args: [],
                } }),
            });
            const payload = await response.json() as { result?: { command: string } };
            expect(payload.result?.command).to.equal('cwtools.ai.getHostCapabilities');

            const denied = await fetch(manifest.cwtoolsNativeRpcUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'cwtools/executeCommand', params: {
                    command: 'cwtools.ai.getHostCapabilities', args: [],
                } }),
            });
            expect(denied.status).to.equal(401);

            const mcp = await fetch(manifest.rpcUrl, {
                method: 'POST',
                headers: { authorization: `Bearer ${manifest.token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
            });
            expect(mcp.status).to.equal(200);
        } finally {
            await server.stop();
        }
    });
});
