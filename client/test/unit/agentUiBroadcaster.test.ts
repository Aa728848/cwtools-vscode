import { expect } from 'chai';
import type { HostMessage } from '../../extension/ai/types';
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

    it('can send restore messages to a single registered surface', () => {
        const broadcaster = new AgentUiBroadcaster();
        const receivedChat: HostMessage[] = [];
        const receivedManager: HostMessage[] = [];

        const chatWebview = {
            postMessage: (msg: HostMessage) => {
                receivedChat.push(msg);
                return Promise.resolve(true);
            },
        } as any;
        const managerWebview = {
            postMessage: (msg: HostMessage) => {
                receivedManager.push(msg);
                return Promise.resolve(true);
            },
        } as any;

        broadcaster.register(chatWebview, 'chat');
        broadcaster.register(managerWebview, 'manager');

        const payload: HostMessage = { type: 'replaySteps', steps: [], isGenerating: true };
        broadcaster.postMessageToSurface('chat', payload);

        expect(receivedChat).to.deep.equal([payload]);
        expect(receivedManager).to.deep.equal([]);
    });
});
