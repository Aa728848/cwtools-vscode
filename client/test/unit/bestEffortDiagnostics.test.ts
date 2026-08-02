import { expect } from 'chai';
import { createBestEffortReporter } from '../../extension/ai/runner/bestEffortDiagnostics';

describe('best-effort diagnostics', () => {
    it('emits structured, deterministic context', () => {
        const entries: Array<{ message: string; error: unknown }> = [];
        const report = createBestEffortReporter((message, error) => entries.push({ message, error }));
        const failure = new Error('disk full');
        report('checkpoint.save', { topicId: 'topic-1', iteration: 3 }, failure);
        expect(entries).to.have.length(1);
        expect(entries[0]!.message).to.equal('checkpoint.save failed (iteration=3 topicId=topic-1)');
        expect(entries[0]!.error).to.equal(failure);
    });

    it('rate-limits repeated failures and keeps the key cache bounded', () => {
        let now = 100;
        const messages: string[] = [];
        const report = createBestEffortReporter(message => messages.push(message), {
            cooldownMs: 10,
            maxKeys: 2,
            now: () => now,
        });
        report('ledger.append', { runId: 'one' }, new Error('first'));
        report('ledger.append', { runId: 'one' }, new Error('duplicate'));
        expect(messages).to.have.length(1);

        now += 10;
        report('ledger.append', { runId: 'one' }, new Error('retry'));
        report('ledger.append', { runId: 'two' }, new Error('second key'));
        report('ledger.append', { runId: 'three' }, new Error('third key'));
        expect(messages).to.have.length(4);
    });
});
