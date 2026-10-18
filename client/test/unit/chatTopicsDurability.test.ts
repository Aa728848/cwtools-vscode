import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSchedulingState } from '../../extension/ai/types';

const vscodeStub = {
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue }),
    },
    window: { activeTextEditor: undefined, createOutputChannel: () => ({ appendLine: () => undefined }) },
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

const SCHEDULING_STATE: AgentSchedulingState = {
    profileName: 'paradox-agent',
    domainProfile: 'paradox',
    authorization: 'workspace_write',
    phase: 'execute',
    dispatch: 'single',
    overlays: [],
    routeConfidence: 1,
    routeEvidence: [],
    phaseReason: 'unit test',
    revision: 1,
} as AgentSchedulingState;

function storedTopic(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        title: `topic ${id}`,
        createdAt: 1,
        updatedAt: 2,
        messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
        schedulingState: SCHEDULING_STATE,
        ...overrides,
    };
}

describe('chat topic store durability', () => {
    let storageRoot: string;
    let storePath: string;

    beforeEach(() => {
        storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-topic-store-'));
        storePath = path.join(storageRoot, 'ai-chat-topics.json');
    });

    afterEach(() => {
        fs.rmSync(storageRoot, { recursive: true, force: true });
    });

    function openManager(persistence: 'off' | 'metadata' | 'full' = 'full') {
        const { ChatTopicManager } = loadChatTopics();
        return new ChatTopicManager({ fsPath: storageRoot } as never, () => undefined, persistence);
    }

    function writeRawStore(contents: string): void {
        fs.writeFileSync(storePath, contents, 'utf-8');
    }

    it('never overwrites a store it could not parse', () => {
        // Exactly what an interrupted host leaves behind: a half-written array.
        const truncated = '[{"id":"topic_regulator","title":"StellarRegulator Array","createdAt":1,';
        writeRawStore(truncated);

        const manager = openManager();
        expect(manager.topics).to.have.lengthOf(0);

        // Any ordinary action triggers a save; the damaged bytes must survive
        // it so the user still has something to recover from.
        manager.saveTopics();
        expect(fs.readFileSync(storePath, 'utf-8')).to.equal(truncated);
        expect(fs.existsSync(`${storePath}.bak`)).to.equal(false);
    });

    it('recovers the previous generation when the current file is damaged', () => {
        const manager = openManager();
        manager.createNewTopic('stable topic', SCHEDULING_STATE);
        manager.saveTopics();
        // A second generation keeps the first one as the backup.
        manager.saveTopics();
        expect(fs.existsSync(`${storePath}.bak`)).to.equal(true);

        writeRawStore('[{"id":"topic_half"');

        const restored = openManager();
        expect(restored.topics.length).to.be.greaterThan(0);
        expect(restored.topics[0]?.title).to.equal('stable topic');
    });

    it('skips a single unreadable topic without deleting it from disk', () => {
        writeRawStore(JSON.stringify([
            storedTopic('topic_ok'),
            storedTopic('topic_broken', { schedulingState: { domainProfile: 'paradox' } }),
            storedTopic('topic_ok_2'),
        ]));

        const manager = openManager();
        // The readable topics still load: one damaged entry no longer costs
        // the user the rest of the list.
        expect(manager.topics.map(topic => topic.id)).to.deep.equal(['topic_ok', 'topic_ok_2']);

        manager.saveTopics();
        const written = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
        expect(written.map((entry: { id: string }) => entry.id)).to.include('topic_broken');
        expect(written).to.have.lengthOf(3);
        // Preserved verbatim, not "repaired" into something the next load drops.
        expect(written[2].schedulingState).to.deep.equal({ domainProfile: 'paradox' });
    });

    it('keeps an archived topic archived across a restart', () => {
        const manager = openManager();
        manager.createNewTopic('archive me', SCHEDULING_STATE);
        const topicId = manager.currentTopic?.id;
        if (!topicId) throw new Error('Expected a topic to be created.');
        manager.saveTopics();

        // Archiving clears the current topic; the flag has to be on disk
        // already, because the panel is reopened from the store.
        expect(manager.archiveTopic(topicId)).to.equal(true);
        expect(manager.currentTopic).to.equal(null);

        const restored = openManager();
        expect(restored.topics).to.have.lengthOf(1);
        expect(restored.topics[0]?.archived).to.equal(true);
    });

    it('writes every generation atomically and keeps the previous one as a backup', () => {
        const manager = openManager();
        manager.createNewTopic('first', SCHEDULING_STATE);
        manager.saveTopics();
        const firstGeneration = fs.readFileSync(storePath, 'utf-8');

        manager.createNewTopic('second', SCHEDULING_STATE);
        manager.saveTopics();

        expect(fs.readFileSync(`${storePath}.bak`, 'utf-8')).to.equal(firstGeneration);
        // No half-written temp files survive a completed save.
        expect(fs.readdirSync(storageRoot).filter(name => name.endsWith('.tmp'))).to.deep.equal([]);
    });

    it('does not write anything when persistence is off', () => {
        writeRawStore(JSON.stringify([storedTopic('topic_off')]));
        const manager = openManager('off');
        expect(manager.topics).to.have.lengthOf(0);
        manager.saveTopics();
        expect(JSON.parse(fs.readFileSync(storePath, 'utf-8'))).to.have.lengthOf(1);
    });
});
