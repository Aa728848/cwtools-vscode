import { expect } from 'chai';
import { LspFeaturePriorityGate } from '../../extension/lspFeaturePriority';

describe('LSP editor feature priority gate', () => {
	it('delays background work and extends the quiet window for a completion', async () => {
		let now = 0;
		let waits = 0;
		const gate = new LspFeaturePriorityGate(
			() => now,
			async milliseconds => {
				now += milliseconds;
				waits += 1;
				if (waits === 1) gate.prioritiseCompletion(200);
			},
		);

		const admitted = await gate.waitForBackgroundSlot(100, { isCancellationRequested: false });

		expect(admitted).to.equal(true);
		expect(now).to.equal(250);
	});

	it('does not dispatch cancelled background work', async () => {
		let now = 0;
		const cancellation = { isCancellationRequested: false };
		const gate = new LspFeaturePriorityGate(
			() => now,
			async milliseconds => {
				now += milliseconds;
				cancellation.isCancellationRequested = true;
			},
		);

		const admitted = await gate.waitForBackgroundSlot(100, cancellation);

		expect(admitted).to.equal(false);
	});

	it('cancels running background work when completion starts', () => {
		const gate = new LspFeaturePriorityGate(() => 100, async () => undefined);
		let cancellations = 0;
		const stopTracking = gate.trackBackgroundCancellation(() => cancellations++);

		gate.prioritiseCompletion(250);
		expect(cancellations).to.equal(1);

		stopTracking();
		gate.prioritiseCompletion(250);
		expect(cancellations).to.equal(1);
	});
});
