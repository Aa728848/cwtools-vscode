import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { WorktreeManager, repairMovedAgentWorktrees } from '../../extension/ai/orchestrator/worktreeManager';

const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

function gitAvailable(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

describe('worktreeManager', function () {
    this.timeout(60_000);
    if (!gitAvailable()) {
        it.skip('requires git CLI', () => undefined);
        return;
    }

    let repo: string;
    let manager: WorktreeManager;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        repo = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-worktree-'));
        git(repo, 'init');
        git(repo, 'config', 'user.email', 'test@test.local');
        git(repo, 'config', 'user.name', 'Test');
        git(repo, 'config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(repo, 'events.txt'), 'country_event = {\n\tid = base.1\n}\n', 'utf8');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-m', 'base');
        manager = new WorktreeManager(repo);
    });

    afterEach(() => {
        try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('detects git workspaces', async () => {
        expect(await manager.isGitWorkspace()).to.equal(true);
        // Negative case must live outside this repo's own git tree.
        const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-plain-'));
        try {
            expect(await new WorktreeManager(plainDir).isGitWorkspace()).to.equal(false);
        } finally {
            fs.rmSync(plainDir, { recursive: true, force: true });
        }
    });

    it('creates a detached worktree, collects a diff, and applies it to the main workspace', async () => {
        const info = await manager.create('run1', 'agent-a');
        expect(fs.existsSync(info.worktreePath)).to.equal(true);

        // Edit + create inside the worktree only.
        fs.writeFileSync(path.join(info.worktreePath, 'events.txt'), 'country_event = {\n\tid = changed.1\n}\n', 'utf8');
        fs.mkdirSync(path.join(info.worktreePath, 'common'), { recursive: true });
        fs.writeFileSync(path.join(info.worktreePath, 'common', 'new.txt'), 'new_block = { x = 1 }\n', 'utf8');

        const diff = await manager.collectDiff(info);
        expect(diff.changedFiles).to.have.members(['events.txt', 'common/new.txt']);

        // Main workspace untouched until apply.
        expect(fs.readFileSync(path.join(repo, 'events.txt'), 'utf8')).to.include('base.1');

        const result = await manager.applyDiff(diff);
        expect(result.applied).to.equal(true);
        expect(fs.readFileSync(path.join(repo, 'events.txt'), 'utf8')).to.include('changed.1');
        expect(fs.readFileSync(path.join(repo, 'common', 'new.txt'), 'utf8')).to.include('new_block');

        await manager.remove(info);
        expect(fs.existsSync(info.worktreePath)).to.equal(false);
    });

    it('returns an empty diff when nothing changed', async () => {
        const info = await manager.create('run2', 'agent-b');
        const diff = await manager.collectDiff(info);
        expect(diff.patch).to.equal('');
        expect(diff.changedFiles).to.deep.equal([]);
        const result = await manager.applyDiff(diff);
        expect(result.applied).to.equal(true);
        await manager.remove(info);
    });

    it('preserves BOM bytes through the binary diff round-trip', async () => {
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const info = await manager.create('run3', 'agent-c');
        const ymlRel = path.join('localisation', 'test_l_english.yml');
        fs.mkdirSync(path.join(info.worktreePath, 'localisation'), { recursive: true });
        fs.writeFileSync(
            path.join(info.worktreePath, ymlRel),
            Buffer.concat([bom, Buffer.from('l_english:\n key:0 "Value"\n', 'utf8')])
        );

        const diff = await manager.collectDiff(info);
        const result = await manager.applyDiff(diff);
        expect(result.applied).to.equal(true);

        const written = fs.readFileSync(path.join(repo, ymlRel));
        expect(written.subarray(0, 3).equals(bom)).to.equal(true);
        await manager.remove(info);
    });

    it('lists and prunes stale worktrees by retention limit', async () => {
        const a = await manager.create('run4', 'agent-1');
        const b = await manager.create('run4', 'agent-2');
        expect(await manager.list()).to.have.length(2);

        const removed = await manager.cleanupStale(1);
        expect(removed).to.equal(1);
        expect(await manager.list()).to.have.length(1);

        // Cleanup remaining.
        for (const info of [a, b]) {
            try { await manager.remove(info); } catch { /* already pruned */ }
        }
    });

    it('repairs linked worktrees after the legacy storage root is moved', async () => {
        const legacyPath = path.join(repo, '.cwtools-ai', 'worktrees', 'run-legacy', 'agent-legacy');
        const currentPath = path.join(repo, '.cwtools', 'worktrees', 'run-legacy', 'agent-legacy');
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
        git(repo, 'worktree', 'add', '--detach', legacyPath, 'HEAD');
        fs.renameSync(path.join(repo, '.cwtools-ai'), path.join(repo, '.cwtools'));

        expect(await repairMovedAgentWorktrees(repo)).to.equal(1);
        git(currentPath, 'status', '--short');
        const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: repo,
            encoding: 'utf8',
            windowsHide: true,
        });
        expect(registered.replace(/\\/g, '/')).to.include(currentPath.replace(/\\/g, '/'));
        expect(registered.replace(/\\/g, '/')).to.not.include(legacyPath.replace(/\\/g, '/'));

        git(repo, 'worktree', 'remove', '--force', currentPath);
    });

    it('rejects conflicting patches without corrupting the main workspace', async () => {
        const info = await manager.create('run5', 'agent-d');
        fs.writeFileSync(path.join(info.worktreePath, 'events.txt'), 'country_event = {\n\tid = wt.1\n}\n', 'utf8');
        const diff = await manager.collectDiff(info);

        // Main workspace diverges before apply → patch no longer applies cleanly.
        fs.writeFileSync(path.join(repo, 'events.txt'), 'country_event = {\n\tid = diverged.1\n}\n', 'utf8');
        const result = await manager.applyDiff(diff);
        expect(result.applied).to.equal(false);
        expect(fs.readFileSync(path.join(repo, 'events.txt'), 'utf8')).to.include('diverged.1');
        await manager.remove(info);
    });
});
