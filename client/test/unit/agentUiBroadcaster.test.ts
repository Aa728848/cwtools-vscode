import { expect } from 'chai';
import type { HostMessage } from '../../extension/ai/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentUiBroadcaster } = require('../../extension/ai/agentUiBroadcaster');

describe('AgentUiBroadcaster', () => {
    it('broadcasts messages to all registered webviews', () => {
        const broadcaster = new AgentUiBroadcaster();
        const receivedA: HostMessage[] = [];
        const receivedB: HostMessage[] = [];

        const webviewA = {
            postMessage: (msg: HostMessage) => {
                receivedA.push(msg);
                return Promise.resolve(true);
            },
        } as any;
        const webviewB = {
            postMessage: (msg: HostMessage) => {
                receivedB.push(msg);
                return Promise.resolve(true);
            },
        } as any;

        broadcaster.register(webviewA);
        broadcaster.register(webviewB);

        const payload: HostMessage = { type: 'setMode', mode: 'build' };
        broadcaster.postMessage(payload);

        expect(receivedA).to.deep.equal([payload]);
        expect(receivedB).to.deep.equal([payload]);
    });

    it('stops sending to disposed listeners', () => {
        const broadcaster = new AgentUiBroadcaster();
        const receivedA: HostMessage[] = [];
        const receivedB: HostMessage[] = [];

        const webviewA = {
            postMessage: (msg: HostMessage) => {
                receivedA.push(msg);
                return Promise.resolve(true);
            },
        } as any;
        const webviewB = {
            postMessage: (msg: HostMessage) => {
                receivedB.push(msg);
                return Promise.resolve(true);
            },
        } as any;

        const disposeA = broadcaster.register(webviewA);
        broadcaster.register(webviewB);

        disposeA.dispose();
        const payload: HostMessage = { type: 'setMode', mode: 'plan' };
        broadcaster.postMessage(payload);

        expect(receivedA).to.deep.equal([]);
        expect(receivedB).to.deep.equal([payload]);
    });
});
