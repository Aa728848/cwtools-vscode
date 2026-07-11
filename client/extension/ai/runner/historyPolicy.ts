import * as fs from 'fs';
import * as path from 'path';
import { ErrorReporter } from '../errorReporter';

export type HistoryPersistenceMode = 'off' | 'metadata' | 'full';

export interface HistoryPolicy {
    persistence: HistoryPersistenceMode;
    maxAgeDays: number;
    maxBytes: number;
    redactLocalPaths: boolean;
}

let policy: HistoryPolicy = {
    persistence: 'full',
    maxAgeDays: 30,
    maxBytes: 256 * 1024 * 1024,
    redactLocalPaths: true,
};

export function configureHistoryPolicy(next: Partial<HistoryPolicy>): void {
    policy = {
        persistence: next.persistence ?? policy.persistence,
        maxAgeDays: Math.max(0, next.maxAgeDays ?? policy.maxAgeDays),
        maxBytes: Math.max(0, next.maxBytes ?? policy.maxBytes),
        redactLocalPaths: next.redactLocalPaths ?? policy.redactLocalPaths,
    };
}

export function getHistoryPolicy(): Readonly<HistoryPolicy> {
    return policy;
}

interface StoredFile { filePath: string; mtimeMs: number; size: number }

/** Enforce age and total-size bounds for extension-private Agent history. */
export async function enforceHistoryRetention(privateRoot: string): Promise<{ deletedFiles: number; reclaimedBytes: number }> {
    const result = { deletedFiles: 0, reclaimedBytes: 0 };
    if (!privateRoot || !fs.existsSync(privateRoot)) return result;
    if (policy.persistence === 'off') {
        await fs.promises.rm(path.join(privateRoot, 'topics'), { recursive: true, force: true });
        return result;
    }

    const files: StoredFile[] = [];
    const walk = async (dir: string): Promise<void> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const filePath = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(filePath);
            else if (entry.isFile()) {
                const stat = await fs.promises.stat(filePath).catch(() => undefined);
                if (stat) files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
            }
        }
    };
    await walk(privateRoot);

    const cutoff = policy.maxAgeDays > 0
        ? Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1000
        : Number.NEGATIVE_INFINITY;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let retainedBytes = 0;
    for (const file of files) {
        const overAge = file.mtimeMs < cutoff;
        const overSize = policy.maxBytes > 0 && retainedBytes + file.size > policy.maxBytes;
        if (overAge || overSize) {
            try {
                await fs.promises.unlink(file.filePath);
                result.deletedFiles++;
                result.reclaimedBytes += file.size;
            } catch (error) {
                ErrorReporter.debug('HistoryPolicy', `Failed to remove expired Agent history ${file.filePath}`, error);
            }
        } else {
            retainedBytes += file.size;
        }
    }
    return result;
}
