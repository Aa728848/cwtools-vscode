// WriteQueue: serializes write operations to prevent race conditions on AST/file state.
// Each AgentRunner owns one; sub-agents get their own instance for isolated tracking.
export class WriteQueue {
    private queue: Promise<void> = Promise.resolve();
    /** Incremented on every enqueue; used by PartitionedWriteQueue to detect idle queues. */
    lastUsedSeq = 0;

    enqueue<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue = this.queue
                .then(() => fn().then(resolve, reject))
                .catch(() => { /* keep queue alive; caller already receives the rejection */ });
        });
    }

    afterCurrent<T>(fn: () => Promise<T>): Promise<T> {
        return this.queue.then(fn);
    }
}

// PartitionedWriteQueue: per-file-path write serialization.
// Replaces the global single WriteQueue to allow parallel writes to different files
// while preserving per-file ordering. Multi-file operations acquire all path locks
// in sorted order (lexicographic) to prevent AB/BA deadlocks.
// Idle queues are cleaned up after 30s of inactivity to prevent unbounded Map growth.
export class PartitionedWriteQueue {
    private queues = new Map<string, WriteQueue>();
    private static readonly IDLE_CLEANUP_MS = 30_000;

    enqueue<T>(
        files: string[],
        fn: () => Promise<T>,
        options?: { waitTimeoutMs?: number; timeoutMessage?: string }
    ): Promise<T> {
        const sorted = [...new Set(files)].sort();
        const seq = Date.now();
        let started = false;
        let cancelledBeforeStart = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        // Mark all involved queues as active
        for (const f of sorted) this.getQueue(f).lastUsedSeq = seq;
        const acquire = (idx: number): Promise<T> => {
            if (idx >= sorted.length) {
                if (cancelledBeforeStart) return Promise.resolve(undefined as T);
                started = true;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                return fn(); // all locks held, execute write
            }
            return this.getQueue(sorted[idx]!).enqueue(() => acquire(idx + 1));
        };
        const result = acquire(0);
        // After all writes complete, schedule cleanup check for each path
        void result.then(() => {
            for (const f of sorted) this.scheduleCleanup(f, seq);
        });
        const waitTimeoutMs = options?.waitTimeoutMs;
        if (!waitTimeoutMs || waitTimeoutMs <= 0) {
            return result;
        }

        return new Promise<T>((resolve, reject) => {
            timeoutId = setTimeout(() => {
                if (started) return;
                cancelledBeforeStart = true;
                reject(new Error(options?.timeoutMessage ?? `Write queue wait timed out after ${waitTimeoutMs}ms.`));
            }, waitTimeoutMs);

            result.then(resolve, reject).finally(() => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
            });
        });
    }

    async afterCurrentWrites<T>(files: string[], fn: () => Promise<T>): Promise<T> {
        const sorted = [...new Set(files)].sort();
        for (const f of sorted) {
            const q = this.queues.get(f);
            if (q) {
                await q.afterCurrent(async () => undefined);
            }
        }
        return fn();
    }

    private getQueue(filePath: string): WriteQueue {
        let q = this.queues.get(filePath);
        if (!q) {
            q = new WriteQueue();
            this.queues.set(filePath, q);
        }
        return q;
    }

    private scheduleCleanup(filePath: string, seqAtEnqueue: number): void {
        const timer = setTimeout(() => {
            const q = this.queues.get(filePath);
            // Only remove if the queue hasn't been used since we enqueued
            if (q && q.lastUsedSeq === seqAtEnqueue) {
                this.queues.delete(filePath);
            }
        }, PartitionedWriteQueue.IDLE_CLEANUP_MS);
        if (typeof (timer as any).unref === 'function') {
            (timer as any).unref();
        }
    }
}

export const globalPartitionedWriteQueue = new PartitionedWriteQueue();
