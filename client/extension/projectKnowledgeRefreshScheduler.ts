export const PROJECT_KNOWLEDGE_REFRESH_DEBOUNCE_MS = 1500;
export const PROJECT_KNOWLEDGE_REFRESH_MAX_WAIT_MS = 10000;
const MAX_REMEMBERED_FINGERPRINTS = 1000;

export type ProjectKnowledgeRefresh = (full: boolean, changedFiles: string[]) => Promise<boolean>;

/** Coalesces file events and persists fingerprints only after a successful export. */
export class ProjectKnowledgeRefreshScheduler {
    private trailingTimer: ReturnType<typeof setTimeout> | undefined;
    private maximumTimer: ReturnType<typeof setTimeout> | undefined;
    private running = false;
    private disposed = false;
    private fullRequested = false;
    private readonly changedFiles = new Set<string>();
    private readonly pendingFingerprints = new Map<string, string | null>();
    private readonly publishedFingerprints = new Map<string, string | null>();

    constructor(
        private readonly refresh: ProjectKnowledgeRefresh,
        private readonly debounceMs = PROJECT_KNOWLEDGE_REFRESH_DEBOUNCE_MS,
        private readonly maximumWaitMs = PROJECT_KNOWLEDGE_REFRESH_MAX_WAIT_MS
    ) {}

    private rememberPublishedFingerprint(file: string, fingerprint: string | null): void {
        this.publishedFingerprints.delete(file);
        if (this.publishedFingerprints.size >= MAX_REMEMBERED_FINGERPRINTS) {
            const oldest = this.publishedFingerprints.keys().next().value as string | undefined;
            if (oldest !== undefined) this.publishedFingerprints.delete(oldest);
        }
        this.publishedFingerprints.set(file, fingerprint);
    }

    scheduleFile(file: string, fingerprint: string | null): void {
        if (this.disposed) return;
        if (!this.changedFiles.has(file)
            && this.publishedFingerprints.has(file)
            && this.publishedFingerprints.get(file) === fingerprint) return;
        if (!this.changedFiles.has(file) && this.changedFiles.size >= 500) {
            this.changedFiles.clear();
            this.pendingFingerprints.clear();
            this.fullRequested = true;
            this.armTimers();
            return;
        }
        this.changedFiles.add(file);
        this.pendingFingerprints.set(file, fingerprint);
        this.armTimers();
    }

    scheduleFull(): void {
        if (this.disposed) return;
        this.fullRequested = true;
        this.armTimers();
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimers();
        this.changedFiles.clear();
        this.pendingFingerprints.clear();
        this.publishedFingerprints.clear();
    }

    private armTimers(): void {
        if (this.trailingTimer) clearTimeout(this.trailingTimer);
        this.trailingTimer = setTimeout(() => void this.runRefresh(), this.debounceMs);
        if (!this.maximumTimer) {
            this.maximumTimer = setTimeout(() => void this.runRefresh(), this.maximumWaitMs);
        }
    }

    private clearTimers(): void {
        if (this.trailingTimer) clearTimeout(this.trailingTimer);
        if (this.maximumTimer) clearTimeout(this.maximumTimer);
        this.trailingTimer = undefined;
        this.maximumTimer = undefined;
    }

    private async runRefresh(): Promise<void> {
        this.clearTimers();
        if (this.disposed || this.running || (this.changedFiles.size === 0 && !this.fullRequested)) return;
        this.running = true;
        const full = this.fullRequested;
        this.fullRequested = false;
        const files = [...this.changedFiles].sort();
        const fingerprints = new Map<string, string | null>();
        for (const file of files) {
            this.changedFiles.delete(file);
            fingerprints.set(file, this.pendingFingerprints.get(file) ?? null);
        }
        let succeeded = false;
        try {
            succeeded = await this.refresh(full, files);
            if (succeeded) {
                for (const [file, fingerprint] of fingerprints) {
                    this.rememberPublishedFingerprint(file, fingerprint);
                    if (!this.changedFiles.has(file)) this.pendingFingerprints.delete(file);
                }
            } else {
                for (const file of files) this.publishedFingerprints.delete(file);
            }
        } catch {
            for (const file of files) this.publishedFingerprints.delete(file);
        } finally {
            this.running = false;
            if (!this.disposed && (this.changedFiles.size > 0 || this.fullRequested)) this.armTimers();
        }
        if (!succeeded && !this.disposed) {
            // Keep the batch pending, but wait for another event instead of retrying forever.
            for (const file of files) this.changedFiles.add(file);
            if (full) this.fullRequested = true;
        }
    }
}
