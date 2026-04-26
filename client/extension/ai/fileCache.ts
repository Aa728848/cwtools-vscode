/**
 * AI Tool File Read Cache
 *
 * Short-lived cache for file reads within a single agent execution loop.
 * Prevents repeated file I/O when multiple tools read the same file.
 */

const fileCache = new Map<string, { content: string; timestamp: number }>();
const TTL_MS = 30_000; // 30 seconds covers one full agent loop

export function getCachedFile(filePath: string): string | null {
    const entry = fileCache.get(filePath);
    if (entry && Date.now() - entry.timestamp < TTL_MS) return entry.content;
    return null;
}

export function setCachedFile(filePath: string, content: string): void {
    fileCache.set(filePath, { content, timestamp: Date.now() });
    if (fileCache.size > 100) {
        fileCache.delete(fileCache.keys().next().value!);
    }
}

export function clearFileCache(): void {
    fileCache.clear();
}
