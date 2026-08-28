import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let workspaceFolders: Array<{ name?: string; uri: { fsPath: string } }> = [];

const vscodeStub = {
    window: { activeTextEditor: undefined as { document: { uri: { fsPath: string } } } | undefined },
    workspace: {
        get workspaceFolders() { return workspaceFolders; },
        getConfiguration: () => ({ get: () => undefined }),
    },
};

function loadWorkspacePaths() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    const modulePath = require.resolve('../../extension/ai/workspacePaths');
    delete require.cache[modulePath];
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/workspacePaths') as typeof import('../../extension/ai/workspacePaths');
    } finally {
        moduleLoader._load = originalLoad;
        delete require.cache[modulePath];
    }
}

describe('workspace AI storage paths', () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-workspace-paths-'));
        workspaceFolders = [{ uri: { fsPath: projectRoot } }];
    });

    afterEach(() => {
        workspaceFolders = [];
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('uses one canonical .cwtools project root', () => {
        const workspacePaths = loadWorkspacePaths();
        const expected = path.join(projectRoot, '.cwtools');
        expect(workspacePaths.getAiStorageRoot(projectRoot)).to.equal(expected);
        expect(workspacePaths.getAiStorageRootCandidates(projectRoot)).to.deep.equal([expected]);
    });

    it('recognizes a directly opened .cwtools folder as the canonical storage root', () => {
        const workspacePaths = loadWorkspacePaths();
        const aiRoot = path.join(projectRoot, '.cwtools');
        workspaceFolders = [{ uri: { fsPath: aiRoot } }];
        expect(workspacePaths.getAiStorageRoot(aiRoot)).to.equal(aiRoot);
    });

    it('resolves explicitly qualified paths in a multi-root workspace', () => {
        const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-second-root-'));
        workspaceFolders = [
            { name: 'first', uri: { fsPath: projectRoot } },
            { name: 'second', uri: { fsPath: secondRoot } },
        ];
        try {
            const workspacePaths = loadWorkspacePaths();
            expect(workspacePaths.getProjectWorkspaceRoots()).to.deep.equal([projectRoot, secondRoot]);
            expect(workspacePaths.resolveProjectWorkspacePath('second/src/index.ts'))
                .to.equal(path.join(secondRoot, 'src', 'index.ts'));
            expect(workspacePaths.resolveProjectWorkspacePath('../escape.ts')).to.equal(undefined);
        } finally {
            fs.rmSync(secondRoot, { recursive: true, force: true });
        }
    });

    it('uses the configured workspace cache root and otherwise uses .cwtools', () => {
        const workspacePaths = loadWorkspacePaths();
        const configuredRoot = path.join(projectRoot, 'extension-storage');
        expect(workspacePaths.getWorkspaceCacheRoot(projectRoot)).to.equal(path.join(projectRoot, '.cwtools'));
        workspacePaths.configureWorkspaceCacheStorage(configuredRoot);
        expect(workspacePaths.getWorkspaceCacheRoot(projectRoot)).to.equal(path.resolve(configuredRoot));
        workspacePaths.configureWorkspaceCacheStorage(undefined);
    });

    it('uses only the configured private topic root when private storage is active', () => {
        const workspacePaths = loadWorkspacePaths();
        const privateRoot = path.join(projectRoot, 'private-storage');
        workspacePaths.configurePrivateAgentStorage(privateRoot);
        try {
            const expected = path.join(privateRoot, 'topics', 'topic_1', 'task.md');
            expect(workspacePaths.getPrivateTopicFileCandidates('topic_1', 'task.md', projectRoot)).to.deep.equal([expected]);
            expect(workspacePaths.getPrivateTopicScratchDir('topic_1', projectRoot))
                .to.equal(path.join(privateRoot, 'topics', 'topic_1', 'scratch'));
        } finally {
            workspacePaths.configurePrivateAgentStorage(undefined);
        }
    });
});
