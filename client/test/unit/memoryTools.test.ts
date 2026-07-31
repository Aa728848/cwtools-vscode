import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Blackboard } from '../../extension/ai/orchestrator/blackboard';
import type { AgentToolContext } from '../../extension/ai/types';

function loadMemoryTools() {
    const moduleLoader = require('module') as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: unknown, ...args: unknown[]) {
        if (request === 'vscode') {
            return { workspace: { workspaceFolders: [] }, window: {} };
        }
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/tools/memoryTools') as typeof import('../../extension/ai/tools/memoryTools');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('MemoryToolHandler file reference safety', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-memory-tools-'));
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('round-trips generated large payloads inside the current topic storage', async () => {
        const { MemoryToolHandler } = loadMemoryTools();
        const blackboard = new Blackboard();
        const handler = new MemoryToolHandler({ workspaceRoot, blackboard });
        const context = {
            runnerOptions: { mode: 'build', domain: 'paradox', topicId: 'safe-topic' },
        } as AgentToolContext;

        await handler.setMemory({ key: 'large', value: 'v'.repeat(700) }, context);
        const result = await handler.getMemory({ key: 'large' }, context) as Record<string, unknown>;

        expect(result.found).to.equal(true);
        expect(result.value).to.equal('v'.repeat(700));
    });

    it('rejects legacy file references outside the current topic blackboard', async () => {
        const { MemoryToolHandler, blackboardDomainPrefix } = loadMemoryTools();
        const blackboard = new Blackboard();
        const handler = new MemoryToolHandler({ workspaceRoot, blackboard });
        const context = {
            runnerOptions: { mode: 'build', domain: 'paradox', topicId: 'safe-topic' },
        } as AgentToolContext;
        const outsidePath = path.join(workspaceRoot, 'outside-secret.txt');
        fs.writeFileSync(outsidePath, 'DO_NOT_EXPOSE', 'utf8');
        blackboard.legacySet(`${blackboardDomainPrefix(context)}secret`, `file://${outsidePath}`);

        const result = await handler.getMemory({ key: 'secret' }, context) as Record<string, unknown>;

        expect(result.found).to.equal(false);
        expect(String(result.error)).to.include('outside the current topic blackboard');
        expect(JSON.stringify(result)).to.not.include('DO_NOT_EXPOSE');
    });
});
