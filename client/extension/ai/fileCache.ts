/**
 * AI Tool File Read Cache
 *
 * Content-aware cache keyed by filePath + mtimeMs.
 * Serves full-file reads within a single agent execution loop (30s TTL).
 * Automatically invalidates when the file is modified on disk.
 */

import * as fs from 'fs';

interface CacheEntry {
    content: string;
    mtimeMs: number;
    timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;
const MAX_ENTRIES = 200;

export function getCachedFile(filePath: string): string | null {
    const entry = cache.get(filePath);
    if (!entry) return null;

    // TTL expiry
    if (Date.now() - entry.timestamp > TTL_MS) {
        cache.delete(filePath);
        return null;
    }

    // mtime check: if file changed on disk, invalidate
    try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs !== entry.mtimeMs) {
            cache.delete(filePath);
            return null;
        }
    } catch {
        cache.delete(filePath);
        return null;
    }

    return entry.content;
}

export function setCachedFile(filePath: string, content: string, mtimeMs: number): void {
    cache.set(filePath, { content, mtimeMs, timestamp: Date.now() });
    // LRU eviction: drop oldest when over limit
    if (cache.size > MAX_ENTRIES) {
        cache.delete(cache.keys().next().value!);
    }
}

/** Invalidate cache for a file after write (called by write/edit tools). */
export function invalidateCachedFile(filePath: string): void {
    cache.delete(filePath);
}

export function clearFileCache(): void {
    cache.clear();
}