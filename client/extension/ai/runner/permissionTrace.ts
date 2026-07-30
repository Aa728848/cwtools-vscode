export type PermissionTraceDecision = 'requested' | 'auto_approved' | 'auto_denied' | 'accepted' | 'declined' | 'cancelled';

export interface PermissionTraceEntry {
    id: string;
    topicId: string;
    threadId: string;
    runId?: string;
    tool: string;
    decision: PermissionTraceDecision;
    source: 'policy' | 'auto_review' | 'user' | 'full_access';
    reason?: string;
    timestamp: number;
}

export class PermissionTraceStore {
    private readonly entries: PermissionTraceEntry[] = [];

    record(entry: Omit<PermissionTraceEntry, 'timestamp'> & { timestamp?: number }): PermissionTraceEntry {
        const value = { ...entry, timestamp: entry.timestamp ?? Date.now() };
        this.entries.push(value);
        if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
        return { ...value };
    }

    list(topicId?: string, threadId?: string): PermissionTraceEntry[] {
        return this.entries
            .filter(entry => !topicId || entry.topicId === topicId)
            .filter(entry => !threadId || entry.threadId === threadId)
            .map(entry => ({ ...entry }));
    }

    restore(entries: readonly PermissionTraceEntry[]): void {
        const existing = new Set(this.entries.map(entry => entry.id));
        for (const entry of entries) {
            if (!existing.has(entry.id)) {
                this.entries.push({ ...entry });
                existing.add(entry.id);
            }
        }
        this.entries.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
        if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
    }
}
