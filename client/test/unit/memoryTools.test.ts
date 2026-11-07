import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentToolContext } from '../../extension/ai/types';
import { PARADOX_WRITE } from './schedulingFixtures';

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

describe('MemoryToolHandler storage safety', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-memory-tools-'));
    });

    afterEach(() => {
        for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
            const p = path.join(workspaceRoot, entry.name);
            if (!entry.isDirectory()) fs.unlinkSync(p);
        }
    });

    it('stores small and large payloads inside the current topic storage', async () => {
        const { MemoryToolHandler } = loadMemoryTools();
        const handler = new MemoryToolHandler({ workspaceRoot });
        const context = {
            runnerOptions: { schedulingState: PARADOX_WRITE, topicId: 'safe-topic' },
        } as AgentToolContext;

        const small = await handler.setMemory({ key: 'small', value: 'short' }, context) as any;
        expect(small.success).to.equal(true);

        const large = await handler.setMemory({ key: 'large', value: 'v'.repeat(700) }, context) as any;
        expect(large.success).to.equal(true);
        expect(String(large.message)).to.include('700 chars');
    });
});
