import { expect } from 'chai';
import { commandCodeQuotaFromStatus } from '../../extension/ai/commandcode/quota';
import { parseSubscriptionAccountQuota } from '../../shared/subscriptionQuota';
describe('Subscription quota view crosses the Webview boundary', () => {
    // External payloads are narrowed before use, like every other host message.
    it('drops meters with no name and no known key', () => {
        const quota = parseSubscriptionAccountQuota({
            fetchedAt: 1_700_000_000_000,
            meters: [
                { id: 'good', label: 'Plan', usedPercent: 0.5 },
                { id: 'named-by-key', labelKey: 'cycle', remainingPercent: 0.25 },
                { id: 'unlabelled', usedPercent: 0.5 },
            ],
        });
        expect(quota?.meters.map(meter => meter.id)).to.deep.equal(['good', 'named-by-key']);
    });

    it('clamps fractions and requires a timestamp', () => {
        const quota = parseSubscriptionAccountQuota({
            fetchedAt: 1,
            meters: [{ id: 'a', label: 'A', usedPercent: 4 }, { id: 'b', label: 'B', remainingPercent: -2 }],
        });
        expect(quota?.meters[0]!.usedPercent).to.equal(1);
        expect(quota?.meters[1]!.remainingPercent).to.equal(0);
        // Without a timestamp there is nothing to reason about freshness with.
        expect(parseSubscriptionAccountQuota({ meters: [] })).to.equal(undefined);
    });

    it('keeps an empty-but-valid snapshot', () => {
        const quota = parseSubscriptionAccountQuota({ fetchedAt: 1_700_000_000_000, meters: [] });
        expect(quota?.meters).to.deep.equal([]);
    });
});
describe('Command Code per-key quota', () => {
    // The allowance is booked per key, and each key reads its own status.
    it('draws the reported windows', () => {
        const quota = commandCodeQuotaFromStatus({
            available: true, hasKey: true,
            windowLimits: { fiveHour: { used: 10, cap: 100 }, weekly: { used: 900, cap: 1000 } },
        });
        expect(quota.meters.map(meter => meter.id)).to.deep.equal(['five-hour', 'weekly']);
        expect(quota.meters[0]!.usedPercent).to.equal(0.1);
    });

    // A key with no window figures still has a meaningful balance; dropping it would
    // show nothing at all for a plan that only reports credits.
    it('keeps a bare credit balance as a stated value', () => {
        const quota = commandCodeQuotaFromStatus({ available: true, hasKey: true, credits: { monthlyCredits: 42 } });
        expect(quota.meters).to.have.length(1);
        expect(quota.meters[0]!.id).to.equal('credits');
        expect(quota.meters[0]!.used).to.equal('42');
        // No denominator was reported, so no fraction is invented.
        expect(quota.meters[0]!.usedPercent).to.equal(undefined);
    });

    // A window the service did not report must not become a full bar.
    it('omits windows the service did not report', () => {
        const quota = commandCodeQuotaFromStatus({ available: true, hasKey: true });
        expect(quota.meters).to.deep.equal([]);
    });
});
