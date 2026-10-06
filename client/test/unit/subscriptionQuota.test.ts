import { expect } from 'chai';
import {
    parseWorkBuddyBilling,
    parseWorkBuddyCycleTime,
    workBuddyBillingMeters,
} from '../../extension/ai/workbuddy/quota';
import { commandCodeQuotaFromStatus } from '../../extension/ai/commandcode/quota';
import { parseSubscriptionAccountQuota } from '../../shared/subscriptionQuota';
describe('WorkBuddy billing quota', () => {
    // The real payload nests as data.Response.Data.Accounts[]; reading only the outer
    // object would silently report no allowance.
    it('reads the nested account list', () => {
        const billing = parseWorkBuddyBilling({
            code: 0,
            data: {
                Response: {
                    Data: {
                        Accounts: [{
                            PackageName: 'Free Plan Subscription',
                            CapacitySize: 1000,
                            CapacityRemain: 250,
                            CycleCapacityUsed: 100,
                            CycleCapacitySize: 400,
                            CycleStartTime: '2026-09-01 00:00:00',
                            CycleEndTime: '2026-10-01 00:00:00',
                        }],
                    },
                },
            },
        });
        expect(billing.packageName).to.equal('Free Plan Subscription');
        expect(billing.totalCredits).to.equal(1000);
        expect(billing.remainingCredits).to.equal(250);
        expect(billing.cycleUsedCredits).to.equal(100);
        expect(billing.cycleCredits).to.equal(400);
        expect(billing.cycleEndsAt).to.equal(Date.parse('2026-10-01T00:00:00'));
    });

    // A user can hold several packages at once, so capacities are summed rather than
    // taken from the first entry.
    it('sums the capacities of several packages', () => {
        const billing = parseWorkBuddyBilling({
            data: { Response: { Data: { Accounts: [
                { CapacitySize: 100, CapacityRemain: 40 },
                { CapacitySize: 300, CapacityRemain: 60 },
            ] } } },
        });
        expect(billing.totalCredits).to.equal(400);
        expect(billing.remainingCredits).to.equal(100);
    });

    // Capacity and cycle counters are independent facts: a payload with only one of
    // them still has a drawable meter.
    it('builds one meter per available fact', () => {
        const both = workBuddyBillingMeters({
            packageName: 'Plan', totalCredits: 100, remainingCredits: 25,
            cycleUsedCredits: 30, cycleCredits: 60, cycleStartsAt: null, cycleEndsAt: null,
        });
        expect(both.map(meter => meter.id)).to.deep.equal(['cycle', 'package']);
        expect(both[0]!.usedPercent).to.equal(0.5);
        expect(both[1]!.usedPercent).to.equal(0.75);

        const capacityOnly = workBuddyBillingMeters({
            packageName: null, totalCredits: 100, remainingCredits: 100,
            cycleUsedCredits: null, cycleCredits: null, cycleStartsAt: null, cycleEndsAt: null,
        });
        expect(capacityOnly.map(meter => meter.id)).to.deep.equal(['package']);

        const cycleOnly = workBuddyBillingMeters({
            packageName: null, totalCredits: null, remainingCredits: null,
            cycleUsedCredits: 10, cycleCredits: 40, cycleStartsAt: null, cycleEndsAt: null,
        });
        expect(cycleOnly.map(meter => meter.id)).to.deep.equal(['cycle']);
    });

    // The service sends zone-less local-time strings; Date.parse reads them as local
    // time, which is what the IDE's own panel does.
    it('parses zone-less cycle times as local time', () => {
        expect(parseWorkBuddyCycleTime('2026-09-01 00:00:00')).to.equal(Date.parse('2026-09-01T00:00:00'));
        expect(parseWorkBuddyCycleTime(1_700_000_000)).to.equal(1_700_000_000_000);
        expect(parseWorkBuddyCycleTime(1_700_000_000_000)).to.equal(1_700_000_000_000);
        expect(parseWorkBuddyCycleTime('')).to.equal(null);
        expect(parseWorkBuddyCycleTime(undefined)).to.equal(null);
    });

    it('reports no meters for a payload with no accounts', () => {
        const billing = parseWorkBuddyBilling({ data: { Response: { Data: { Accounts: [] } } } });
        expect(workBuddyBillingMeters(billing)).to.deep.equal([]);
    });
});

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
