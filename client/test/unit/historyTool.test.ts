import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function loadHistoryModules() {
    const loader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = loader._load;
    const historyPath = require.resolve('../../extension/ai/tools/historyTool');
    const workspacePath = require.resolve('../../extension/ai/workspacePaths');
    const cachedHistory = require.cache[historyPath];
    const cachedWorkspace = require.cache[workspacePath];
    delete require.cache[historyPath];
    delete require.cache[workspacePath];
    loader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return { workspace: { workspaceFolders: [] } };
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            history: require('../../extension/ai/tools/historyTool') as typeof import('../../extension/ai/tools/historyTool'),
            workspace: require('../../extension/ai/workspacePaths') as typeof import('../../extension/ai/workspacePaths'),
            policy: require('../../extension/ai/runner/historyPolicy') as typeof import('../../extension/ai/runner/historyPolicy'),
        };
    } finally {
        loader._load = originalLoad;
        delete require.cache[historyPath];
        delete require.cache[workspacePath];
        if (cachedHistory) require.cache[historyPath] = cachedHistory;
        if (cachedWorkspace) require.cache[workspacePath] = cachedWorkspace;
    }
}

describe('history tool', () => {
    it('searches bounded transcripts, excludes tool output, and redacts local paths', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-history-'));
        const { history, workspace, policy } = loadHistoryModules();
        workspace.configurePrivateAgentStorage(root);
        policy.configureHistoryPolicy({ persistence: 'full' });
        try {
            const runDir = path.join(root, 'topics', 'topic-a', 'runs', 'run-1');
            fs.mkdirSync(runDir, { recursive: true });
            fs.writeFileSync(path.join(runDir, 'resume_transcript.json'), JSON.stringify([
                { role: 'user', content: `Decision: use a bounded history index under ${root}` },
                { role: 'tool', content: 'SECRET_TOOL_ONLY history index' },
                { role: 'assistant', content: 'The bounded history index avoids unbounded scans.' },
            ]), 'utf-8');

            const result = history.searchAgentHistory(root, { query: 'bounded history index', scope: 'workspace' });
            expect(result.available).to.equal(true);
            expect(result.results).to.have.length.greaterThan(0);
            expect(JSON.stringify(result.results)).to.not.include('SECRET_TOOL_ONLY');
            expect(JSON.stringify(result.results)).to.not.include(root);
            expect(JSON.stringify(result.results)).to.include('<workspace>');
            expect(result.warning).to.include('untrusted background');
        } finally {
            workspace.configurePrivateAgentStorage(undefined);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('honors topic scope and disabled persistence', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-history-'));
        const { history, workspace, policy } = loadHistoryModules();
        workspace.configurePrivateAgentStorage(root);
        try {
            for (const topic of ['topic-a', 'topic-b']) {
                const runDir = path.join(root, 'topics', topic, 'runs', 'run-1');
                fs.mkdirSync(runDir, { recursive: true });
                fs.writeFileSync(path.join(runDir, 'resume_transcript.json'), JSON.stringify([
                    { role: 'user', content: `unique retrieval marker ${topic}` },
                ]), 'utf-8');
            }
            policy.configureHistoryPolicy({ persistence: 'full' });
            const scoped = history.searchAgentHistory(root, { query: 'retrieval marker', scope: 'topic' }, { topicId: 'topic-b' });
            expect(scoped.results.every(result => result.topicId === 'topic-b')).to.equal(true);

            policy.configureHistoryPolicy({ persistence: 'off' });
            expect(history.searchAgentHistory(root, { query: 'marker' }).available).to.equal(false);
        } finally {
            policy.configureHistoryPolicy({ persistence: 'full' });
            workspace.configurePrivateAgentStorage(undefined);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
