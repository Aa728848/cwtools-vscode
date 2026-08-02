export interface TranscriptStreamBatch {
    text: string;
    offset: number;
    ordinal: number;
    initialize: boolean;
}

interface PendingTranscriptStream {
    text: string;
    ordinal: number;
}

/**
 * Coalesces provider-sized text deltas before they reach the durable journal.
 * Without this buffer, long streamed answers enqueue thousands of serialized
 * filesystem appends and can keep the turn alive after its final text appears.
 */
export class TranscriptStreamBuffer {
    private readonly pending = new Map<string, PendingTranscriptStream>();
    private readonly queuedLengths = new Map<string, number>();
    private readonly completeText = new Map<string, string>();
    private readonly firstOrdinals = new Map<string, number>();
    private readonly seen = new Set<string>();

    constructor(private readonly flushChars = 2_048) {
        if (!Number.isSafeInteger(flushChars) || flushChars <= 0) {
            throw new Error('Transcript stream flush size must be a positive integer.');
        }
    }

    append(turnId: string, text: string, ordinal: number): boolean {
        this.seen.add(turnId);
        if (!this.firstOrdinals.has(turnId)) this.firstOrdinals.set(turnId, ordinal);
        this.completeText.set(turnId, (this.completeText.get(turnId) ?? '') + text);
        const current = this.pending.get(turnId);
        this.pending.set(turnId, {
            text: (current?.text ?? '') + text,
            ordinal: current?.ordinal ?? ordinal,
        });
        return (current?.text.length ?? 0) + text.length >= this.flushChars;
    }

    take(turnId: string): TranscriptStreamBatch | undefined {
        const current = this.pending.get(turnId);
        if (!current || current.text.length === 0) return undefined;
        this.pending.delete(turnId);
        const initialize = !this.queuedLengths.has(turnId);
        const offset = this.queuedLengths.get(turnId) ?? 0;
        this.queuedLengths.set(turnId, offset + current.text.length);
        return { ...current, offset, initialize };
    }

    pendingTurnIds(): string[] {
        return [...this.pending.keys()];
    }

    hasStream(turnId: string): boolean {
        return this.seen.has(turnId);
    }

    text(turnId: string): string {
        return this.completeText.get(turnId) ?? '';
    }

    ordinal(turnId: string): number | undefined {
        return this.firstOrdinals.get(turnId);
    }

    clear(turnId: string): void {
        this.pending.delete(turnId);
        this.queuedLengths.delete(turnId);
        this.completeText.delete(turnId);
        this.firstOrdinals.delete(turnId);
        this.seen.delete(turnId);
    }
}
