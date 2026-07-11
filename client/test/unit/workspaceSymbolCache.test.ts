import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceSymbolSqliteCache } from '../../extension/indexing/workspaceSymbolCache';

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
});
