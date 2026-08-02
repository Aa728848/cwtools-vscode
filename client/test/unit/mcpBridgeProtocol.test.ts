import { EventEmitter } from 'events';
import { expect } from 'chai';
import type * as http from 'http';
import {
    isAuthorizedBridgeRequest,
    isMcpBridgeMethod,
    McpBridgeRequestTooLargeError,
    parseBridgeJsonRpcPayload,
    readMcpBridgeRequestBody,
} from '../../extension/ai/mcpBridgeProtocol';

class MockIncomingRequest extends EventEmitter {
    destroyed = false;

    destroy(): this {
        this.destroyed = true;
        return this;
    }
}

describe('MCP bridge protocol boundary', () => {
    it('parses a valid JSON-RPC request', () => {
        const parsed = parseBridgeJsonRpcPayload(JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'query_types', arguments: {} },
        }));
        expect(parsed.ok).to.equal(true);
        if (parsed.ok) {
            expect(parsed.request.method).to.equal('tools/call');
            expect(parsed.request.id).to.equal(7);
        }
    });

    it('returns JSON-RPC parse and envelope errors', () => {
        expect(parseBridgeJsonRpcPayload('{').ok).to.equal(false);
        expect(parseBridgeJsonRpcPayload('[]')).to.deep.include({ ok: false, code: -32600 });
        expect(parseBridgeJsonRpcPayload(JSON.stringify({ jsonrpc: '1.0', method: 'tools/list' })))
            .to.deep.include({ ok: false, code: -32600 });
        expect(parseBridgeJsonRpcPayload(JSON.stringify({ jsonrpc: '2.0', method: '', params: [] })))
            .to.deep.include({ ok: false, code: -32600 });
        expect(parseBridgeJsonRpcPayload(JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'tools/list' })))
            .to.deep.include({ ok: false, code: -32600, id: null });
    });

    it('recognizes only supported bridge methods', () => {
        expect(isMcpBridgeMethod('tools/list')).to.equal(true);
        expect(isMcpBridgeMethod('resources/read')).to.equal(true);
        expect(isMcpBridgeMethod('workspace/write')).to.equal(false);
    });

    it('accepts bearer and explicit token authentication', () => {
        const token = 'secret-token';
        expect(isAuthorizedBridgeRequest({ authorization: `Bearer ${token}` }, token)).to.equal(true);
        expect(isAuthorizedBridgeRequest({ 'x-cwtools-mcp-token': token }, token)).to.equal(true);
        expect(isAuthorizedBridgeRequest({ authorization: 'Bearer wrong' }, token)).to.equal(false);
        expect(isAuthorizedBridgeRequest({}, token)).to.equal(false);
    });

    it('reads bounded request bodies', async () => {
        const request = new MockIncomingRequest();
        const bodyPromise = readMcpBridgeRequestBody(request as unknown as Pick<http.IncomingMessage, 'on' | 'destroy'>, 16);
        request.emit('data', Buffer.from('hello '));
        request.emit('data', Buffer.from('world'));
        request.emit('end');
        expect(await bodyPromise).to.equal('hello world');
        expect(request.destroyed).to.equal(false);
    });

    it('rejects and destroys oversized requests', async () => {
        const request = new MockIncomingRequest();
        const bodyPromise = readMcpBridgeRequestBody(request as unknown as Pick<http.IncomingMessage, 'on' | 'destroy'>, 4);
        request.emit('data', Buffer.from('12345'));
        let failure: unknown;
        try {
            await bodyPromise;
        } catch (error) {
            failure = error;
        }
        expect(failure).to.be.instanceOf(McpBridgeRequestTooLargeError);
        expect(request.destroyed).to.equal(true);
    });
});
