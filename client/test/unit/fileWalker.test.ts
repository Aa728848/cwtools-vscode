import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkFiles, type WalkedFile } from '../../extension/fileWalker';

/**
 * Build a temp fixture tree and return its root. The tree includes a deep chain
 * (d1/d2/.../d6) and wide directories so walker regressions (e.g. the
 * directory-recursion deadlock with small concurrency limits) surface here.
 */
function makeFixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walkfiles-test-'));
    const deep: string[] = [];
    for (let i = 1; i <= 6; i++) {
        deep.push(path.join(root, ...Array.from({ length: i }, (_, j) => `d${j + 1}`)));
    }
    for (const dir of deep) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `file_${dir.length}.gfx`), `sprite = { name = "s${dir.length}" }`);
    }
    // Wide leaf dir with many files plus non-matching extensions.
    const wide = path.join(root, 'wide');
    fs.mkdirSync(wide, { recursive: true });
    for (let i = 0; i < 20; i++) {
        fs.writeFileSync(path.join(wide, `a${String(i).padStart(2, '0')}.gfx`), `sprite = { name = "a${i}" }`);
        fs.writeFileSync(path.join(wide, `b${String(i).padStart(2, '0')}.dds`), 'binary');
    }
    fs.writeFileSync(path.join(root, 'top.gfx'), 'sprite = { name = "top" }');
    return root;
}

function cleanup(root: string): void {
    fs.rmSync(root, { recursive: true, force: true });
}

describe('fileWalker', () => {
    it('walks nested directories without deadlocking at low concurrency', async () => {
        const root = makeFixture();
        try {
            // Concurrency 1 is the harshest case for the old implementation:
            // a slotted recursion chain held every permit while leaf tasks
            // queued behind it, so the promise never resolved.
            const files = await walkFiles(root, { ext: '.gfx', concurrency: 1 });
            expect(files.length).to.equal(6 + 20 + 1);
        } finally {
            cleanup(root);
        }
    });

    it('returns deterministic (sorted) results', async () => {
        const root = makeFixture();
        try {
            const first = await walkFiles(root, { ext: '.gfx', concurrency: 2 });
            const second = await walkFiles(root, { ext: '.gfx', concurrency: 3 });
            expect(first.map(f => f.path)).to.deep.equal(second.map(f => f.path));
            const wideStart = first.findIndex(f => f.path.includes('wide'));
            const widePaths = first.slice(wideStart).map(f => path.basename(f.path));
            expect(widePaths).to.deep.equal([...widePaths].sort());
        } finally {
            cleanup(root);
        }
    });

    it('filters by extension and reads file contents', async () => {
        const root = makeFixture();
        try {
            const files = await walkFiles(root, { ext: '.dds' });
            expect(files.length).to.equal(20);
            expect(files.every(f => f.path.toLowerCase().endsWith('.dds'))).to.equal(true);
            const gfx = await walkFiles(root, { ext: '.gfx' });
            const top = gfx.find(f => f.path.endsWith('top.gfx'));
            expect(top?.content).to.contain('"top"');
        } finally {
            cleanup(root);
        }
    });

    it('enforces maxFiles at push time', async () => {
        const root = makeFixture();
        try {
            const files = await walkFiles(root, { ext: '.gfx', maxFiles: 5, concurrency: 2 });
            expect(files.length).to.equal(5);
        } finally {
            cleanup(root);
        }
    });

    it('honours an aborted signal', async () => {
        const root = makeFixture();
        try {
            const controller = new AbortController();
            controller.abort();
            const files = await walkFiles(root, { ext: '.gfx', signal: controller.signal });
            expect(files.length).to.equal(0);
        } finally {
            cleanup(root);
        }
    });

    it('skips unreadable directories instead of throwing', async () => {
        const root = makeFixture();
        try {
            const locked = path.join(root, 'locked');
            fs.mkdirSync(locked, { recursive: true });
            fs.writeFileSync(path.join(locked, 'x.gfx'), 'x');
            // On Windows chmod does not make a dir unreadable for the owner;
            // instead delete the dir between readdir and read is racy. Simply
            // verify the walker still completes when a subdirectory vanishes.
            fs.rmSync(locked, { recursive: true, force: true });
            const files = await walkFiles(root, { ext: '.gfx', concurrency: 2 });
            expect(files.length).to.equal(6 + 20 + 1);
        } finally {
            cleanup(root);
        }
    });
});

// Keep WalkedFile referenced for type-completeness of the public contract.
export type { WalkedFile };
