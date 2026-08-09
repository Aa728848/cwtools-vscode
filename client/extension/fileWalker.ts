/**
 * Bounded, deterministic recursive file walker shared by the preview panels
 * (GUI, Entity, Solar System).
 *
 * Guarantees over the ad-hoc `readdir + Promise.all` loops it replaces:
 * - results are deterministic: the discovery pass walks directories in sorted
 *   entry order, and file contents are placed back in discovery order;
 * - file reads are bounded by a fixed worker pool (concurrency limit);
 * - the file-count and total-bytes caps are enforced during discovery, before
 *   any read starts, so the limits are never exceeded by racing branches;
 * - an AbortSignal cancels both passes.
 *
 * Directory recursion is deliberately sequential (not parallel): `readdir` is
 * cheap, and a slotted parallel recursion chain could exhaust the concurrency
 * limit while every `visit` waits on queued leaf tasks — a deadlock.
 */
import * as fs from 'fs';
import * as path from 'path';
import { matchesExt } from './fileExtensions';

export interface WalkedFile {
    path: string;
    content: string;
}

export interface WalkFilesOptions {
    /** Extension filter, e.g. `.gfx` (case-insensitive). */
    ext?: string;
    /** Optional extra predicate on the resolved file path. */
    predicate?: (filePath: string, entryName: string) => boolean;
    /** Maximum number of files collected (default: unlimited). */
    maxFiles?: number;
    /** Maximum total bytes of collected file sizes (default: unlimited). */
    maxBytes?: number;
    /** Recurse into subdirectories (default: true). */
    recursive?: boolean;
    /** Concurrent file reads (default: 8). */
    concurrency?: number;
    /** Cancel the walk; already-started reads may still finish. */
    signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY = 8;

/**
 * Recursively collects files under `root` matching the options. Never throws:
 * unreadable directories/files are skipped and a cancelled walk returns
 * whatever was discovered so far.
 */
export async function walkFiles(root: string, options: WalkFilesOptions = {}): Promise<WalkedFile[]> {
    const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const recursive = options.recursive ?? true;
    const signal = options.signal;

    // ── Discovery pass: deterministic, no file reads ──────────────────────────
    // Walks directories in sorted entry order, recording matching files in
    // order. Sequential recursion keeps the result order stable and avoids
    // the slotted-recursion deadlock.
    const discovered: Array<{ full: string }> = [];
    let totalBytes = 0;

    const visit = async (dir: string): Promise<void> => {
        if (signal?.aborted || discovered.length >= maxFiles || totalBytes >= maxBytes) return;
        let entries: fs.Dirent[];
        try {
            entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return; // skip inaccessible directories
        }

        for (const entry of entries) {
            if (signal?.aborted || discovered.length >= maxFiles || totalBytes >= maxBytes) break;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (recursive) {
                    await visit(full);
                }
            } else if (entry.isFile() && matchesExt(entry.name, options.ext ?? '')) {
                if (options.predicate && !options.predicate(full, entry.name)) continue;
                try {
                    const size = (await fs.promises.stat(full)).size;
                    if (totalBytes + size > maxBytes) continue;
                    discovered.push({ full });
                    totalBytes += size;
                } catch {
                    // skip unreadable files
                }
            }
        }
    };

    await visit(root);

    // ── Read pass: bounded concurrency, results in discovery order ───────────
    const results = new Array<WalkedFile | undefined>(discovered.length);
    const workerCount = Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, discovered.length);
    let nextIndex = 0;

    const reader = async (): Promise<void> => {
        for (;;) {
            if (signal?.aborted) return;
            const index = nextIndex++;
            if (index >= discovered.length) return;
            const full = discovered[index]!.full;
            try {
                const content = await fs.promises.readFile(full, 'utf-8');
                results[index] = { path: full, content };
            } catch {
                // skip unreadable files
            }
        }
    };

    const workers = Array.from({ length: workerCount }, () => reader());
    await Promise.all(workers);
    return results.filter((file): file is WalkedFile => file !== undefined);
}
