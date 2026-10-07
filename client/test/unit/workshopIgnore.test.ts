import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Workshop upload content staging.
 *
 * workshopIgnore.ts pulls in ErrorReporter, which needs vscode; the stub below
 * satisfies that import without an Extension Host, following the loader
 * pattern already used by the anchor-guard suite.
 */

const vscodeStub = {
    window: {
        createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
        showErrorMessage: () => undefined,
        showWarningMessage: () => undefined,
    },
};

const moduleLoader = require('module') as { _load: (...args: any[]) => any };

/**
 * Loads the module under test with `vscode` stubbed, then restores the real
 * loader. The hook must not outlive this call: other suites in the same mocha
 * process rely on resolving the real module or on their own stub, and a hook
 * left in place makes those suites fail with a confusing module error.
 */
function loadWithStubbedVscode<T>(load: () => T): T {
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return load();
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const {
    ALWAYS_EXCLUDED,
    STAGING_PARENT_NAME,
    StagingCancelled,
    hasIgnoreFiles,
    removeStagingRoot,
    stageUploadContent,
} = loadWithStubbedVscode(
    () => require('../../extension/workshopIgnore') as typeof import('../../extension/workshopIgnore')
);

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-workshop-ignore-tests');

function makeModRoot(): string {
    fs.mkdirSync(TEMP_BASE, { recursive: true });
    return fs.mkdtempSync(path.join(TEMP_BASE, 'mod-'));
}

function makeStagingParent(): string {
    fs.mkdirSync(TEMP_BASE, { recursive: true });
    return fs.mkdtempSync(path.join(TEMP_BASE, 'staging-'));
}

function write(root: string, relativePath: string, content: string): void {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
}

/** Every file inside a staged tree, as sorted relative POSIX paths. */
function listStaged(stagingRoot: string): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
                continue;
            }
            found.push(path.relative(stagingRoot, absolute).split(path.sep).join('/'));
        }
    };
    walk(stagingRoot);
    return found.sort();
}
describe('workshop upload content staging', () => {
    const roots: string[] = [];

    const newModRoot = (): string => {
        const root = makeModRoot();
        roots.push(root);
        return root;
    };

    afterEach(() => {
        for (const root of roots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    describe('stageUploadContent', () => {
        it('returns undefined when nothing has to be excluded', () => {
            const modRoot = newModRoot();
            write(modRoot, 'descriptor.mod', 'name="M"');
            write(modRoot, 'common/script.txt', 'x = 1');

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            expect(staged).to.equal(undefined);
        });

        it('excludes files matched by .gitignore and copies the rest', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', '*.log\nbuild/\n');
            write(modRoot, 'descriptor.mod', 'name="M"');
            write(modRoot, 'common/script.txt', 'x = 1');
            write(modRoot, 'noise.log', 'chatty');
            write(modRoot, 'build/out.txt', 'artifact');

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            expect(staged).to.not.equal(undefined);
            expect(listStaged(staged!.contentPath)).to.deep.equal(['common/script.txt', 'descriptor.mod']);
            expect(fs.readFileSync(path.join(staged!.contentPath, 'common/script.txt'), 'utf8')).to.equal('x = 1');
            // noise.log, the build/ directory, and the .gitignore file itself.
            expect(staged!.excludedCount).to.equal(3);
        });

        it('preserves nested directory structure', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', 'secret/\n');
            write(modRoot, 'a/b/c/deep.txt', 'deep');
            write(modRoot, 'secret/key.txt', 'nope');

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            expect(listStaged(staged!.contentPath)).to.deep.equal(['a/b/c/deep.txt']);
        });

        it('always excludes VCS and editor metadata even without ignore files', () => {
            const modRoot = newModRoot();
            write(modRoot, 'descriptor.mod', 'name="M"');
            write(modRoot, '.git/config', '[core]');
            write(modRoot, '.git/objects/ab/cdef', 'binary');
            write(modRoot, '.github/workflows/ci.yml', 'on: push');
            write(modRoot, '.vscode/settings.json', '{}');

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            expect(listStaged(staged!.contentPath)).to.deep.equal(['descriptor.mod']);
        });

        it('applies .steamignore on top of .gitignore', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', '*.tmp\n');
            write(modRoot, '.steamignore', 'docs/\n');
            write(modRoot, 'descriptor.mod', 'name="M"');
            write(modRoot, 'scratch.tmp', 'temp');
            write(modRoot, 'docs/readme.md', '# docs');

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            expect(listStaged(staged!.contentPath)).to.deep.equal(['descriptor.mod']);
        });

        it('excludes build output through the extra patterns setting', () => {
            const modRoot = newModRoot();
            write(modRoot, 'descriptor.mod', 'name="M"');
            write(modRoot, 'dist/bundle.js', 'bundle');

            const staged = stageUploadContent(modRoot, {
                stagingParent: makeStagingParent(),
                extraPatterns: ['dist/'],
            });

            expect(listStaged(staged!.contentPath)).to.deep.equal(['descriptor.mod']);
        });

        it('scopes a nested .steamignore to its own directory', () => {
            const modRoot = newModRoot();
            write(modRoot, 'descriptor.mod', 'name="M"');
            write(modRoot, 'outer/.steamignore', 'draft.txt\n');
            write(modRoot, 'outer/keep.txt', 'keep');
            write(modRoot, 'outer/draft.txt', 'drop');
            write(modRoot, 'other/draft.txt', 'keep too');

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            expect(listStaged(staged!.contentPath)).to.deep.equal([
                'descriptor.mod',
                'other/draft.txt',
                'outer/keep.txt',
            ]);
        });

        it('honours a negation that re-includes an ignored file', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', '*.log\n!keep.log\n');
            write(modRoot, 'descriptor.mod', 'name="M"');
            write(modRoot, 'drop.log', 'no');
            write(modRoot, 'keep.log', 'yes');

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            expect(listStaged(staged!.contentPath)).to.deep.equal(['descriptor.mod', 'keep.log']);
        });
        it('creates a uniquely named staging directory under the configured parent', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', 'x.txt\n');
            write(modRoot, 'x.txt', 'x');
            write(modRoot, 'y.txt', 'y');
            const stagingParent = makeStagingParent();

            const first = stageUploadContent(modRoot, { stagingParent });
            const second = stageUploadContent(modRoot, { stagingParent });

            expect(first).to.not.equal(undefined);
            expect(second).to.not.equal(undefined);
            expect(first!.stagingRoot).to.not.equal(second!.stagingRoot);
            expect(path.basename(path.dirname(first!.stagingRoot))).to.equal(STAGING_PARENT_NAME);
            // Compared through realpath because the OS temp dir is a symlink on
            // macOS. The staging parent is the grandparent of the staged copy.
            expect(fs.realpathSync(stagingParent)).to.equal(
                fs.realpathSync(path.dirname(path.dirname(first!.stagingRoot)))
            );
        });

        it('fails and cleans up when the staged size exceeds the limit', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', 'x.txt\n');
            write(modRoot, 'x.txt', 'excluded');
            write(modRoot, 'big.txt', 'y'.repeat(4096));
            const stagingParent = makeStagingParent();

            expect(() => stageUploadContent(modRoot, { stagingParent, maxBytes: 10 })).to.throw(/exceeds/);

            const leftover = fs.readdirSync(path.join(stagingParent, STAGING_PARENT_NAME));
            expect(leftover).to.deep.equal([]);
        });

        it('cancels and cleans up when the caller cancels', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', 'x.txt\n');
            write(modRoot, 'x.txt', 'excluded');
            write(modRoot, 'a.txt', 'a');
            write(modRoot, 'b.txt', 'b');
            const stagingParent = makeStagingParent();

            expect(() =>
                stageUploadContent(modRoot, { stagingParent, shouldCancel: () => true })
            ).to.throw(StagingCancelled);

            const leftover = fs.readdirSync(path.join(stagingParent, STAGING_PARENT_NAME));
            expect(leftover).to.deep.equal([]);
        });

        it('reports symlinks instead of copying them as broken files', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', 'ignored.txt\n');
            write(modRoot, 'ignored.txt', 'gone');
            write(modRoot, 'descriptor.mod', 'name="M"');
            try {
                fs.symlinkSync(path.join(modRoot, 'descriptor.mod'), path.join(modRoot, 'link.mod'));
            } catch {
                // Creating symlinks can require elevation on Windows; the
                // remaining assertions still describe the copied content.
            }

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            expect(staged).to.not.equal(undefined);
            expect(listStaged(staged!.contentPath)).to.not.include('link.mod');
            const skipped = staged!.skipped.find(entry => entry.relativePath === 'link.mod');
            expect(skipped?.reason).to.equal('symlink');
        });

        it('never copies the ignore files themselves', () => {
            const modRoot = newModRoot();
            write(modRoot, 'descriptor.mod', 'name="M"');
            write(modRoot, '.gitignore', 'nothing.txt\n');
            write(modRoot, '.steamignore', 'nothing2.txt\n');
            write(modRoot, '.gitattributes', '* text=auto');

            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            const list = listStaged(staged!.contentPath);
            expect(list).to.deep.equal(['descriptor.mod']);
            for (const rule of ALWAYS_EXCLUDED) {
                expect(list).to.not.include(rule);
            }
        });
    });

    describe('hasIgnoreFiles', () => {
        it('reports whether the mod root declares any ignore file', () => {
            const modRoot = newModRoot();
            expect(hasIgnoreFiles(modRoot)).to.equal(false);
            write(modRoot, '.gitignore', '*.log\n');
            expect(hasIgnoreFiles(modRoot)).to.equal(true);
        });
    });

    describe('removeStagingRoot', () => {
        it('removes a staging directory this module created', () => {
            const modRoot = newModRoot();
            write(modRoot, '.gitignore', 'x.txt\n');
            write(modRoot, 'x.txt', 'x');
            write(modRoot, 'y.txt', 'y');
            const staged = stageUploadContent(modRoot, { stagingParent: makeStagingParent() });

            removeStagingRoot(staged!.stagingRoot);

            expect(fs.existsSync(staged!.stagingRoot)).to.equal(false);
        });

        it('refuses to remove a path outside its own staging parent', () => {
            const modRoot = newModRoot();
            write(modRoot, 'descriptor.mod', 'name="M"');

            removeStagingRoot(modRoot);

            expect(fs.existsSync(modRoot)).to.equal(true);
        });

        it('does nothing when given undefined', () => {
            expect(() => removeStagingRoot(undefined)).to.not.throw();
        });
    });
});
