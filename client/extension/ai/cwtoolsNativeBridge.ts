import type { BridgeJsonRpcRequest } from './mcpBridgeProtocol';
import { REQUIRED_BACKEND_COMMANDS } from 'cwtools-shared';

export const NATIVE_PROTOCOL_VERSION = 1;
export const NATIVE_HEALTH_PATH = '/cwtools/healthz';
export const NATIVE_RPC_PATH = '/cwtools/rpc';

const ALLOWED_COMMANDS = new Set([
    ...REQUIRED_BACKEND_COMMANDS,
    'cwtools.ai.getHostCapabilities',
]);
const ALLOWED_LSP_METHODS = new Set([
    'textDocument/completion',
    'textDocument/documentSymbol',
    'workspace/symbol',
    'textDocument/definition',
    'textDocument/references',
]);

export interface NativeCwtoolsCallbacks {
    executeCommand(command: string, args: unknown[]): Promise<unknown>;
    lspRequest(method: string, params: unknown): Promise<unknown>;
}

export class NativeBridgeProtocolError extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
        this.name = 'NativeBridgeProtocolError';
    }
}

function paramsOf(request: BridgeJsonRpcRequest): Record<string, unknown> {
    return request.params ?? {};
}

/** Dispatch the small, explicitly whitelisted native CWTools API, never arbitrary LSP writes. */
export async function dispatchNativeCwtoolsRequest(
    request: BridgeJsonRpcRequest,
    callbacks: NativeCwtoolsCallbacks,
): Promise<unknown> {
    const params = paramsOf(request);
    switch (request.method) {
        case 'cwtools/executeCommand': {
            const command = params.command;
            const args = params.args ?? params.arguments ?? [];
            if (typeof command !== 'string' || !ALLOWED_COMMANDS.has(command)) {
                throw new NativeBridgeProtocolError(-32601, 'CWTools command is not allowed: ' + String(command));
            }
            if (!Array.isArray(args)) {
                throw new NativeBridgeProtocolError(-32602, 'CWTools command args must be an array.');
            }
            return callbacks.executeCommand(command, args);
        }
        case 'cwtools/lspRequest': {
            const method = params.method;
            if (typeof method !== 'string' || !ALLOWED_LSP_METHODS.has(method)) {
                throw new NativeBridgeProtocolError(-32601, 'CWTools LSP method is not allowed: ' + String(method));
            }
            return callbacks.lspRequest(method, params.params ?? {});
        }
        default:
            throw new NativeBridgeProtocolError(-32601, 'Unknown CWTools native method: ' + request.method);
    }
}
