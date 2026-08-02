import * as crypto from 'crypto';
import type * as http from 'http';
import { isRecord } from '../../shared/protocolValidation';

export const MAX_MCP_BRIDGE_REQUEST_BYTES = 1024 * 1024;

export const MCP_BRIDGE_METHODS = [
    'tools/list',
    'tools/call',
    'resources/list',
    'resources/read',
    'bridge/metadata',
] as const;

export type McpBridgeMethod = typeof MCP_BRIDGE_METHODS[number];

export interface BridgeJsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}

export type BridgeJsonRpcParseResult =
    | { ok: true; request: BridgeJsonRpcRequest }
    | { ok: false; id: string | number | null; code: -32700 | -32600; message: string };

export class McpBridgeRequestTooLargeError extends Error {
    constructor() {
        super('CWTools MCP bridge request is too large.');
        this.name = 'McpBridgeRequestTooLargeError';
    }
}

function isValidId(value: unknown): value is string | number | null {
    return value === null
        || typeof value === 'string'
        || (typeof value === 'number' && Number.isFinite(value));
}

export function parseBridgeJsonRpcPayload(payload: string): BridgeJsonRpcParseResult {
    let input: unknown;
    try {
        input = JSON.parse(payload);
    } catch {
        return { ok: false, id: null, code: -32700, message: 'Invalid JSON payload.' };
    }
    if (!isRecord(input)) {
        return { ok: false, id: null, code: -32600, message: 'JSON-RPC request must be an object.' };
    }
    const id = isValidId(input.id) ? input.id : null;
    if (input.jsonrpc !== '2.0') {
        return { ok: false, id, code: -32600, message: "JSON-RPC version must be '2.0'." };
    }
    if (input.id !== undefined && !isValidId(input.id)) {
        return { ok: false, id: null, code: -32600, message: 'JSON-RPC id must be a string, finite number, or null.' };
    }
    if (typeof input.method !== 'string' || input.method.length === 0) {
        return { ok: false, id, code: -32600, message: 'JSON-RPC method must be a non-empty string.' };
    }
    if (input.params !== undefined && !isRecord(input.params)) {
        return { ok: false, id, code: -32600, message: 'JSON-RPC params must be an object when present.' };
    }
    return {
        ok: true,
        request: {
            jsonrpc: '2.0',
            id: input.id as string | number | null | undefined,
            method: input.method,
            params: input.params,
        },
    };
}

export function isMcpBridgeMethod(method: string): method is McpBridgeMethod {
    return (MCP_BRIDGE_METHODS as readonly string[]).includes(method);
}

function tokenEquals(actual: string | undefined, expected: string): boolean {
    if (actual === undefined) return false;
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isAuthorizedBridgeRequest(headers: http.IncomingHttpHeaders, token: string): boolean {
    const authorization = headers.authorization;
    if (typeof authorization === 'string' && tokenEquals(authorization, `Bearer ${token}`)) return true;
    const header = headers['x-cwtools-mcp-token'];
    return typeof header === 'string' && tokenEquals(header, token);
}

export async function readMcpBridgeRequestBody(
    request: Pick<http.IncomingMessage, 'on' | 'destroy'>,
    maxBytes = MAX_MCP_BRIDGE_REQUEST_BYTES,
): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    return new Promise<string>((resolve, reject) => {
        request.on('data', chunk => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBytes) {
                settled = true;
                reject(new McpBridgeRequestTooLargeError());
                request.destroy();
                return;
            }
            chunks.push(buffer);
        });
        request.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        request.on('error', error => {
            if (settled) return;
            settled = true;
            reject(error);
        });
    });
}
