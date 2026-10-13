import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatTopic } from '../../extension/ai/types';

const vscodeStub = {
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue }),
    },
    window: { activeTextEditor: undefined },
    env: { language: 'en' },
    Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file', path: fsPath }) },
};

/** Load chatTopics with a stubbed `vscode`, the way the Extension Host does. */
function loadChatTopics(): typeof import('../../extension/ai/chatTopics') {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/chatTopics') as typeof import('../../extension/ai/chatTopics');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

function legacySchedulingState() {
    return {
        profileName: 'paradox-agent',
        domainProfile: 'paradox',
        authorization: 'workspace_write',
        phase: 'execute',
        dispatch: 'single',
        overlays: [],
        routeConfidence: 1,
        routeEvidence: [],
        phaseReason: 'AI workflow diagnostic-fix active',
        routingSource: 'workflow',
        revision: 7,
    };
}

describe('legacy AI Workflow topic data', () => {
    let storageRoot: string;

    beforeEach(() => {
        storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-legacy-topics-'));
    });

    afterEach(() => {
        fs.rmSync(storageRoot, { recursive: true, force: true });
    });

    function writeTopicsFile(topics: unknown[]): void {
        fs.writeFileSync(
            path.join(storageRoot, 'ai-chat-topics.json'),
            JSON.stringify(topics, null, 2),
            'utf-8',
        );
    }

    it('reads a persisted topic that still carries workflowId and routingSource:workflow', () => {
        writeTopicsFile([{
            id: 'topic_legacy',
            title: 'Workflow era topic',
            createdAt: 1,
            updatedAt: 2,
            messages: [{ role: 'user', content: 'fix it', timestamp: 1 }],
            schedulingState: legacySchedulingState(),
            modeOverride: 'plan',
            workflowId: 'diagnostic-fix',
            workflowReturnSchedulingState: {
                ...legacySchedulingState(),
                routingSource: 'workflow',
            },
        }]);

        const { ChatTopicManager } = loadChatTopics();
        const manager = new ChatTopicManager({ fsPath: storageRoot } as never, () => undefined);

        expect(manager.topics).to.have.lengthOf(1);
        const topic = manager.topics[0] as ChatTopic & { workflowId?: string };
        // The conversation survives; only the removed concept is dropped.
        expect(topic.id).to.equal('topic_legacy');
        expect(topic.messages).to.have.lengthOf(1);
        expect(topic.modeOverride).to.equal('plan');
        expect(topic).to.not.have.property('workflowId');
        expect(topic).to.not.have.property('workflowReturnSchedulingState');
        // The legacy routing origin degrades instead of poisoning the state.
        expect(topic.schedulingState.routingSource).to.equal(undefined);
        expect(topic.schedulingState.revision).to.equal(7);
    });

    it('ignores a legacy topic whose return-state was lost rather than dropping it', () => {
        // Old files could survive with workflowId set but a corrupted return
        // state. That must not cost the user the whole conversation.
        writeTopicsFile([{
            id: 'topic_partial',
            title: 'Half-migrated topic',
            createdAt: 1,
            updatedAt: 2,
            messages: [{ role: 'user', content: 'still here', timestamp: 1 }],
            schedulingState: legacySchedulingState(),
            workflowId: 'loc-generation',
        }]);

        const { ChatTopicManager } = loadChatTopics();
        const manager = new ChatTopicManager({ fsPath: storageRoot } as never, () => undefined);

        expect(manager.topics).to.have.lengthOf(1);
        expect(manager.topics[0]!.id).to.equal('topic_partial');
        expect(manager.topics[0]).to.not.have.property('workflowId');
    });

    it('still rejects a topic whose canonical scheduling state itself is unusable', () => {
        writeTopicsFile([{
            id: 'topic_broken',
            title: 'Broken scheduling state',
            createdAt: 1,
            updatedAt: 2,
            messages: [],
            schedulingState: { domainProfile: 'paradox' },
            workflowId: 'diagnostic-fix',
        }]);

        const { ChatTopicManager } = loadChatTopics();
        const manager = new ChatTopicManager({ fsPath: storageRoot } as never, () => undefined);

        expect(manager.topics).to.have.lengthOf(0);
    });
});
