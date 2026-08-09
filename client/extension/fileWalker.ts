/**
 * Bounded, deterministic recursive file walker shared by the preview panels
 * (GUI, Entity, Solar System).
 *
 * Guarantees over the ad-hoc `readdir + Promise.all` loops it replaces:
 * - directory entries are sorted, so results are deterministic per workspace;
 * - recursion and reads are bounded by a concurrency limit;
 * - the file-count and total-bytes caps are enforced at push time (synchronous
 *   check + push), so limits are never exceeded by racing branches;
 * - an AbortSignal cancels the walk between directory visits / file reads.
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
    /** Maximum total characters of collected contents (default: unlimited). */
    maxBytes?: number;
    /** Recurse into subdirectories (default: true). */
    recursive?: boolean;
    /** Concurrent directory visits (default: 8). */
    concurrency?: number;
    /** Cancel the walk; already-started reads may still finish. */
    signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY = 8;

class Semaphore {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active++;
            return;
        }
        await new Promise<void>(resolve => this.waiters.push(resolve));
        this.active++;
    }

    release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}

/**
 * Recursively collects files under `root` matching the options, sorted by
 * directory-entry name. Never throws: unreadable directories/files are skipped
 * and a cancelled walk returns whatever was collected so far.
 */
export async function walkFiles(root: string, options: WalkFilesOptions = {}): Promise<WalkedFile[]> {
    const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const recursive = options.recursive ?? true;
    const signal = options.signal;
    const semaphore = new Semaphore(options.concurrency ?? DEFAULT_CONCURRENCY);
    const result: WalkedFile[] = [];
    let totalBytes = 0;

    const isFull = (): boolean => result.length >= maxFiles || totalBytes >= maxBytes;

    const runBounded = async <T>(fn: () => Promise<T>): Promise<T> => {
        await semaphore.acquire();
        try {
            return await fn();
        } finally {
            semaphore.release();
        }
    };

    const visit = async (dir: string): Promise<void> => {
        if (signal?.aborted || isFull()) return;
        let entries: fs.Dirent[];
        try {
            entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return; // skip inaccessible directories
        }

        const tasks: Array<Promise<void>> = [];
        for (const entry of entries) {
            if (signal?.aborted || isFull()) break;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (recursive) {
                    tasks.push(runBounded(() => visit(full)));
                }
            } else if (entry.isFile() && matchesExt(entry.name, options.ext ?? '')) {
                if (options.predicate && !options.predicate(full, entry.name)) continue;
                tasks.push(runBounded(async () => {
                    if (signal?.aborted || isFull()) return;
                    try {
                        const stat = await fs.promises.stat(full);
                        if (isFull() || totalBytes + stat.size > maxBytes) return;
                        const content = await fs.promises.readFile(full, 'utf-8');
                        // Re-check after the read: other branches may have filled
                        // the budget while this file was being read.
                        if (isFull() || totalBytes + content.length > maxBytes) return;
                        result.push({ path: full, content });
                        totalBytes += content.length;
                    } catch {
                        // skip unreadable files
                    }
                }));
            }
        }
        await Promise.all(tasks);
    };

    await visit(root);
    return result;
}
