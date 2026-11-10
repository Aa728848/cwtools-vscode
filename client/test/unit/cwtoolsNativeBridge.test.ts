import { expect } from 'chai';
import { dispatchNativeCwtoolsRequest } from '../../extension/ai/cwtoolsNativeBridge';

describe('cwtoolsNativeBridge protocol', () => {
    it('forwards only whitelisted commands and LSP methods', async () => {
        const calls: unknown[] = [];
        const executeCommand = async (command: string, args: unknown[]) => {
            calls.push({ command, args });
            return { ok: true };
        };
        const lspRequest = async (method: string, params: unknown) => {
            calls.push({ method, params });
            return [];
        };
        expect(await dispatchNativeCwtoolsRequest({ jsonrpc: '2.0', id: 1, method: 'cwtools/executeCommand', params: {
            command: 'cwtools.ai.getHostCapabilities', args: [],
        } }, { executeCommand, lspRequest })).to.deep.equal({ ok: true });
        expect(await dispatchNativeCwtoolsRequest({ jsonrpc: '2.0', id: 2, method: 'cwtools/lspRequest', params: {
            method: 'textDocument/definition', params: { textDocument: { uri: 'file:///mod/a.txt' } },
        } }, { executeCommand, lspRequest })).to.deep.equal([]);
        expect(calls).to.have.length(2);
    });

    it('rejects non-whitelisted work and malformed arguments', async () => {
        const callbacks = {
            executeCommand: async () => { throw new Error('must not be called'); },
            lspRequest: async () => { throw new Error('must not be called'); },
        };
        for (const request of [
            { jsonrpc: '2.0', method: 'cwtools/executeCommand', params: { command: 'cwtools.ai.exportProjectKnowledge', args: [] } },
            { jsonrpc: '2.0', method: 'cwtools/lspRequest', params: { method: 'workspace/applyEdit', params: {} } },
            { jsonrpc: '2.0', method: 'cwtools/executeCommand', params: { command: 'cwtools.ai.queryTypes', args: {} } },
            { jsonrpc: '2.0', method: 'tools/call', params: {} },
        ] as const) {
            let error: unknown;
            try {
                await dispatchNativeCwtoolsRequest(request, callbacks);
            } catch (caught) {
                error = caught;
            }
            expect(error, JSON.stringify(request)).to.have.property('name', 'NativeBridgeProtocolError');
        }
    });
});
