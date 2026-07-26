export interface BackgroundFeatureCancellation {
	readonly isCancellationRequested: boolean;
}

type Now = () => number;
type Wait = (milliseconds: number) => Promise<void>;

/**
 * Keeps opportunistic editor features behind latency-sensitive completion.
 * The gate runs before the language-client middleware sends the LSP request,
 * so waiting never occupies a server thread or the shared game-state lock.
 */
export class LspFeaturePriorityGate {
	private completionPriorityUntil = 0;
	private readonly activeBackgroundCancellations = new Set<() => void>();

	constructor(
		private readonly now: Now = Date.now,
		private readonly wait: Wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
	) {}

	prioritiseCompletion(delayMilliseconds: number): void {
		const delay = Math.max(0, delayMilliseconds);
		this.completionPriorityUntil = Math.max(this.completionPriorityUntil, this.now() + delay);
		for (const cancel of Array.from(this.activeBackgroundCancellations)) cancel();
	}

	trackBackgroundCancellation(cancel: () => void): () => void {
		this.activeBackgroundCancellations.add(cancel);
		return () => this.activeBackgroundCancellations.delete(cancel);
	}

	async waitForBackgroundSlot(
		delayMilliseconds: number,
		cancellation: BackgroundFeatureCancellation,
	): Promise<boolean> {
		let readyAt = this.now() + Math.max(0, delayMilliseconds);

		while (!cancellation.isCancellationRequested) {
			readyAt = Math.max(readyAt, this.completionPriorityUntil);
			const remaining = readyAt - this.now();
			if (remaining <= 0) return true;
			await this.wait(Math.min(remaining, 50));
		}

		return false;
	}
}
