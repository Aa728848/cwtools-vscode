import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let workspaceFolders: Array<{ uri: { fsPath: string } }> = [];

const vscodeStub = {
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
    let legacyRoot: string;

    beforeEach(() => {
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-workspace-paths-'));
        legacyRoot = path.join(projectRoot, '.cwtools-ai');
        fs.mkdirSync(legacyRoot, { recursive: true });
        workspaceFolders = [{ uri: { fsPath: legacyRoot } }];
    });

    afterEach(() => {
        workspaceFolders = [];
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    it('maps a standalone legacy storage workspace to the sibling .cwtools root', () => {
        const workspacePaths = loadWorkspacePaths();
        const primaryRoot = path.join(projectRoot, '.cwtools');

        expect(workspacePaths.getAiStorageRoot(legacyRoot)).to.equal(primaryRoot);
        expect(workspacePaths.getAiStorageRootCandidates(legacyRoot)).to.deep.equal([
            primaryRoot,
            legacyRoot,
        ]);
    });

    it('keeps the legacy fallback candidate when VS Code has no workspace folders', () => {
        workspaceFolders = [];
        const workspacePaths = loadWorkspacePaths();
        const primaryRoot = path.join(projectRoot, '.cwtools');

        expect(workspacePaths.getAiStorageRoot(legacyRoot)).to.equal(primaryRoot);
        expect(workspacePaths.getAiStorageRootCandidates(legacyRoot)).to.deep.equal([
            primaryRoot,
            legacyRoot,
        ]);
    });

    it('renames a legacy storage root when .cwtools does not exist', () => {
        const workspacePaths = loadWorkspacePaths();
        const primaryRoot = path.join(projectRoot, '.cwtools');
        fs.writeFileSync(path.join(legacyRoot, 'legacy.txt'), 'legacy-only', 'utf8');

        const result = workspacePaths.migrateLegacyAiStorageRoot(legacyRoot);

        expect(result.migrated).to.equal(true);
        expect(fs.readFileSync(path.join(primaryRoot, 'legacy.txt'), 'utf8')).to.equal('legacy-only');
        expect(fs.existsSync(legacyRoot)).to.equal(false);
    });

    it('merges two storage roots, keeps current conflicts, and removes .cwtools-ai', () => {
        const workspacePaths = loadWorkspacePaths();
        const primaryRoot = path.join(projectRoot, '.cwtools');
        fs.mkdirSync(path.join(primaryRoot, 'project'), { recursive: true });
        fs.mkdirSync(path.join(legacyRoot, 'project'), { recursive: true });
        fs.writeFileSync(path.join(primaryRoot, 'project', 'conflict.json'), 'current', 'utf8');
        fs.writeFileSync(path.join(legacyRoot, 'project', 'conflict.json'), 'legacy', 'utf8');
        fs.writeFileSync(path.join(legacyRoot, 'project', 'legacy-only.json'), 'move-me', 'utf8');

        const result = workspacePaths.migrateLegacyAiStorageRoot(legacyRoot);

        expect(result.migrated).to.equal(true);
        expect(result.resolvedConflicts).to.equal(1);
        expect(fs.readFileSync(path.join(primaryRoot, 'project', 'conflict.json'), 'utf8')).to.equal('current');
        expect(fs.readFileSync(path.join(primaryRoot, 'project', 'legacy-only.json'), 'utf8')).to.equal('move-me');
        expect(fs.readFileSync(path.join(primaryRoot, 'migration-conflicts', 'cwtools-ai', 'project', 'conflict.json'), 'utf8')).to.equal('legacy');
        expect(fs.existsSync(legacyRoot)).to.equal(false);
    });

    it('is a no-op when no legacy storage root exists', () => {
        const workspacePaths = loadWorkspacePaths();
        fs.rmSync(legacyRoot, { recursive: true, force: true });

        const result = workspacePaths.migrateLegacyAiStorageRoot(legacyRoot);

        expect(result.migrated).to.equal(false);
        expect(fs.existsSync(path.join(projectRoot, '.cwtools-ai'))).to.equal(false);
    });
});
