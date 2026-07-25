import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
        getConfiguration: () => ({ get: () => undefined }),
    },
};

type CacheModule = typeof import('../../extension/indexing/workspaceSymbolCache');
type WorkspacePathsModule = typeof import('../../extension/ai/workspacePaths');

function loadModules(): { cache: CacheModule; workspacePaths: WorkspacePathsModule } {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    const cacheModulePath = require.resolve('../../extension/indexing/workspaceSymbolCache');
    const workspacePathsModulePath = require.resolve('../../extension/ai/workspacePaths');
    delete require.cache[cacheModulePath];
    delete require.cache[workspacePathsModulePath];
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        const workspacePaths = require('../../extension/ai/workspacePaths') as WorkspacePathsModule;
        const cache = require('../../extension/indexing/workspaceSymbolCache') as CacheModule;
        return { cache, workspacePaths };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const SAMPLE_FILE = 'events/legacy.txt';

function sampleChangedFile(root: string) {
    return [{
        path: path.join(root, SAMPLE_FILE),
        size: 12,
        mtimeMs: 100,
        origin: 'workspace' as const,
        fileVersion: 1,
        entries: [{
            name: 'legacy.1',
            kind: 'event',
            file: path.join(root, SAMPLE_FILE),
            line: 1,
            source: 'script' as const,
            origin: 'workspace' as const,
        }],
    }];
}

describe('WorkspaceSymbolSqliteCache', () => {
    let tempDir: string;
    let databasePath: string;
    const wasmDirectory = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist');

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-symbol-cache-'));
        databasePath = path.join(tempDir, 'symbols.sqlite');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('persists symbols and applies changed/deleted files incrementally', async () => {
        const { cache } = loadModules();
        const { WorkspaceSymbolSqliteCache } = cache;
        const first = new WorkspaceSymbolSqliteCache(databasePath, wasmDirectory, tempDir, 'cwb-v1');
        await first.open();
        first.update([{
            path: path.join(tempDir, 'events', 'a.txt'),
            size: 10,
            mtimeMs: 100,
            origin: 'workspace',
            fileVersion: 1,
            entries: [{
                name: 'example.1',
                kind: 'event',
                file: path.join(tempDir, 'events', 'a.txt'),
                line: 2,
                source: 'script',
                origin: 'workspace',
                updatedAt: 100,
                fileVersion: 1,
            }],
        }], []);
        await first.save();
        first.close();

        const second = new WorkspaceSymbolSqliteCache(databasePath, wasmDirectory, tempDir, 'cwb-v1');
        await second.open();
        expect(second.load().entries.map(entry => entry.name)).to.deep.equal(['example.1']);
        second.update([], [path.join(tempDir, 'events', 'a.txt')]);
        await second.save();
        second.close();

        const third = new WorkspaceSymbolSqliteCache(databasePath, wasmDirectory, tempDir, 'cwb-v1');
        await third.open();
        expect(third.load().entries).to.deep.equal([]);
        expect(third.load().files.size).to.equal(0);
        third.close();
    });

    it('invalidates the database when the external vanilla cache fingerprint changes', async () => {
        const { cache } = loadModules();
        const { WorkspaceSymbolSqliteCache } = cache;
        const first = new WorkspaceSymbolSqliteCache(databasePath, wasmDirectory, tempDir, 'cwb-v1');
        await first.open();
        first.update([{
            path: path.join(tempDir, 'common', 'technology.txt'),
            size: 20,
            mtimeMs: 200,
            origin: 'vanilla',
            fileVersion: 1,
            entries: [{ name: 'tech_example', kind: 'technology', file: path.join(tempDir, 'common', 'technology.txt'), line: 1, source: 'script', origin: 'vanilla' }],
        }], []);
        await first.save();
        first.close();

        const changed = new WorkspaceSymbolSqliteCache(databasePath, wasmDirectory, tempDir, 'cwb-v2');
        await changed.open();
        expect(changed.load().entries).to.deep.equal([]);
        expect(changed.load().files.size).to.equal(0);
        changed.close();
    });

    it('moves a legacy workspace cache under .cwtools after loading it', async () => {
        const { cache } = loadModules();
        const { WorkspaceSymbolSqliteCache, getLegacyWorkspaceSymbolCachePath, getWorkspaceSymbolCachePath } = cache;
        const legacyPath = getLegacyWorkspaceSymbolCachePath(tempDir);
        const primaryPath = getWorkspaceSymbolCachePath(tempDir);
        const legacy = new WorkspaceSymbolSqliteCache(legacyPath, wasmDirectory, tempDir, 'cwb-v1');
        await legacy.open();
        legacy.update(sampleChangedFile(tempDir), []);
        await legacy.save();
        legacy.close();
        const migrated = new WorkspaceSymbolSqliteCache(primaryPath, wasmDirectory, tempDir, 'cwb-v1', [legacyPath]);
        await migrated.open();

        expect(migrated.load().entries.map(entry => entry.name)).to.deep.equal(['legacy.1']);
        expect(fs.existsSync(primaryPath)).to.equal(true);
        expect(fs.existsSync(legacyPath)).to.equal(false);
        expect(fs.existsSync(path.join(tempDir, '.cwtools-ai'))).to.equal(false);
        migrated.close();
    });

    it('moves the in-project .cwtools cache into configured extension storage', async () => {
        const { cache, workspacePaths } = loadModules();
        const { WorkspaceSymbolSqliteCache, getProjectWorkspaceSymbolCachePath, getWorkspaceSymbolCachePath } = cache;
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-symbol-project-'));
        const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-symbol-storage-'));
        try {
            workspacePaths.configureWorkspaceCacheStorage(cacheRoot);
            const projectPath = getProjectWorkspaceSymbolCachePath(projectRoot);
            const primaryPath = getWorkspaceSymbolCachePath(projectRoot);
            expect(primaryPath).to.equal(path.join(cacheRoot, 'index', 'workspace-symbols.sqlite'));

            // Seed the previous in-project cache plus unrelated .cwtools content.
            const legacy = new WorkspaceSymbolSqliteCache(projectPath, wasmDirectory, projectRoot, 'cwb-v1');
            await legacy.open();
            legacy.update(sampleChangedFile(projectRoot), []);
            await legacy.save();
            legacy.close();
            const sharedArtifact = path.join(projectRoot, '.cwtools', 'project', 'profile.json');
            fs.mkdirSync(path.dirname(sharedArtifact), { recursive: true });
            fs.writeFileSync(sharedArtifact, '{}', 'utf8');

            const migrated = new WorkspaceSymbolSqliteCache(primaryPath, wasmDirectory, projectRoot, 'cwb-v1', [projectPath]);
            await migrated.open();

            expect(migrated.load().entries.map(entry => entry.name)).to.deep.equal(['legacy.1']);
            expect(fs.existsSync(primaryPath)).to.equal(true);
            expect(fs.existsSync(projectPath)).to.equal(false);
            expect(fs.existsSync(path.join(projectRoot, '.cwtools', 'index'))).to.equal(false);
            expect(fs.existsSync(sharedArtifact)).to.equal(true);
            migrated.close();
        } finally {
            workspacePaths.configureWorkspaceCacheStorage(undefined);
            fs.rmSync(projectRoot, { recursive: true, force: true });
            fs.rmSync(cacheRoot, { recursive: true, force: true });
        }
    });
});
