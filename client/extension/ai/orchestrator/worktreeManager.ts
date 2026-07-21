/**
 * Git worktree isolation for writing sub-agents (plan Phase 4).
 * Opt-in, git-backed workspaces only. Diffs use --binary so localisation
 * BOM/encoding survive apply byte-for-byte.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

const WORKTREE_ROOT = '.cwtools/worktrees';

export interface WorktreeInfo {
    runId: string;
    agentId: string;
    worktreePath: string;
    createdAt: number;
}

export interface WorktreeDiff {
    patch: string;
    changedFiles: string[];
}

function runGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            if (err) reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
            else resolve({ stdout, stderr });
        });
    });
}

/** Repair Git metadata after legacy Agent worktrees move with the storage root. */
export async function repairMovedAgentWorktrees(workspaceRoot: string): Promise<number> {
    const worktreeRoot = path.join(workspaceRoot, WORKTREE_ROOT);
    if (!fs.existsSync(worktreeRoot)) return 0;
    const worktreePaths: string[] = [];
    const runDirectories = fs.readdirSync(worktreeRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const runDirectory of runDirectories) {
        const runPath = path.join(worktreeRoot, runDirectory.name);
        const agentDirectories = fs.readdirSync(runPath, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const agentDirectory of agentDirectories) {
            const candidate = path.join(runPath, agentDirectory.name);
            if (fs.existsSync(path.join(candidate, '.git'))) worktreePaths.push(candidate);
        }
    }
    if (worktreePaths.length === 0) return 0;
    await runGit(['worktree', 'repair', ...worktreePaths], workspaceRoot, 60_000);
    return worktreePaths.length;
}

export class WorktreeManager {
    constructor(private readonly workspaceRoot: string) {}

    async isGitWorkspace(): Promise<boolean> {
        try {
            const { stdout } = await runGit(['rev-parse', '--is-inside-work-tree'], this.workspaceRoot);
            return stdout.trim() === 'true';
        } catch {
            return false;
        }
    }

    worktreePathFor(runId: string, agentId: string): string {
        const safe = (v: string) => v.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return path.join(this.workspaceRoot, WORKTREE_ROOT, safe(runId), safe(agentId));
    }

    /** Detached worktree from current HEAD — no branch to clean up. */
    async create(runId: string, agentId: string): Promise<WorktreeInfo> {
        const worktreePath = this.worktreePathFor(runId, agentId);
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
        await runGit(['worktree', 'add', '--detach', worktreePath, 'HEAD'], this.workspaceRoot, 60_000);
        return { runId, agentId, worktreePath, createdAt: Date.now() };
    }

    /** Stage everything (incl. untracked) in the worktree's own index, then diff against HEAD. */
    async collectDiff(info: WorktreeInfo): Promise<WorktreeDiff> {
        await runGit(['add', '-A', '--', '.'], info.worktreePath, 60_000);
        const { stdout: names } = await runGit(['diff', '--name-only', '--cached', 'HEAD'], info.worktreePath, 60_000);
        const changedFiles = names.split('\n').map(s => s.trim()).filter(Boolean);
        if (changedFiles.length === 0) return { patch: '', changedFiles: [] };
        const { stdout: patch } = await runGit(['diff', '--binary', '--cached', 'HEAD'], info.worktreePath, 60_000);
        return { patch, changedFiles };
    }

    /** Apply a collected patch onto the main workspace. */
    async applyDiff(diff: WorktreeDiff): Promise<{ applied: boolean; error?: string }> {
        if (!diff.patch) return { applied: true };
        const patchFile = path.join(this.workspaceRoot, WORKTREE_ROOT, `apply_${Date.now()}.patch`);
        try {
            fs.mkdirSync(path.dirname(patchFile), { recursive: true });
            fs.writeFileSync(patchFile, diff.patch, 'utf8');
            await runGit(['apply', '--whitespace=nowarn', '--', patchFile], this.workspaceRoot, 60_000);
            return { applied: true };
        } catch (e) {
            return { applied: false, error: e instanceof Error ? e.message : String(e) };
        } finally {
            try { fs.unlinkSync(patchFile); } catch { /* ignore */ }
        }
    }

    async remove(info: WorktreeInfo): Promise<void> {
        await runGit(['worktree', 'remove', '--force', '--', info.worktreePath], this.workspaceRoot, 60_000);
    }

    /** Registered agent worktrees of this repo. */
    async list(): Promise<string[]> {
        const { stdout } = await runGit(['worktree', 'list', '--porcelain'], this.workspaceRoot);
        const marker = path.join(this.workspaceRoot, WORKTREE_ROOT).replace(/\\/g, '/').toLowerCase();
        const legacyMarker = path.join(this.workspaceRoot, '.cwtools-ai/worktrees').replace(/\\/g, '/').toLowerCase();
        return stdout.split('\n')
            .filter(line => line.startsWith('worktree '))
            .map(line => line.slice('worktree '.length).trim())
            .filter(p => {
                const normalized = p.replace(/\\/g, '/').toLowerCase();
                return normalized.startsWith(marker) || normalized.startsWith(legacyMarker);
            });
    }

    /** Retention: keep the newest `keep` worktrees, prune the rest. */
    async cleanupStale(keep = 4): Promise<number> {
        const paths = await this.list();
        const withTimes = paths.map(p => {
            let mtime = 0;
            try { mtime = fs.statSync(p).mtimeMs; } catch { /* gone */ }
            return { p, mtime };
        }).sort((a, b) => b.mtime - a.mtime);
        let removed = 0;
        for (const entry of withTimes.slice(Math.max(0, keep))) {
            try {
                await runGit(['worktree', 'remove', '--force', '--', entry.p], this.workspaceRoot, 60_000);
                removed++;
            } catch { /* keep going */ }
        }
        if (removed > 0) {
            try { await runGit(['worktree', 'prune'], this.workspaceRoot); } catch { /* ignore */ }
        }
        return removed;
    }
}
