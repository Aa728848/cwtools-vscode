import { expect } from 'chai';
import {
    CommandCodeAccountService,
    getCommandCodeAccountStatus,
    parseCommandCodeWhoami,
    parseCommandCodeUsageSummary,
    parseCommandCodeCredits,
    parseCommandCodeWindowLimit,
    parseCommandCodeSubscription,
} from '../../extension/ai/commandcode/accountService';
import {
    buildCommandCodeQuotaHtml,
    type CommandCodeQuotaLabels,
} from '../../webview/chat/commandcodeQuota';

const mockLabels: CommandCodeQuotaLabels = {
    used: 'used',
    remaining: 'remaining',
    resets: 'Resets',
    unknownReset: 'unknown reset time',
    unavailable: 'Quota details are unavailable for this account.',
    fiveHourLimit: '5-hour limit',
    weeklyLimit: 'Weekly limit',
    plan: 'Plan',
    monthlyCredits: 'Monthly credits',
    purchasedCredits: 'Purchased credits',
    freeCredits: 'Free credits',
};

describe('Command Code Account & Quota Service', () => {
    it('parses normal payloads across all endpoints including windowLimits', async () => {
        const mockFetch: typeof fetch = async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/alpha/whoami')) {
                return new Response(JSON.stringify({
                    user: { id: 'user_123', name: 'Alice Developer', userName: 'alice' },
                    org: { id: 'org_456' },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.endsWith('/alpha/usage/summary')) {
                return new Response(JSON.stringify({
                    totalCount: 42,
                    totalCost: 1.25,
                    successRate: 0.98,
                    completedCount: 41,
                    failedCount: 1,
                    totalTokensIn: 50000,
                    totalTokensOut: 12000,
                    totalCredits: 150,
                    periodBasis: 'monthly',
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.endsWith('/alpha/billing/credits')) {
                return new Response(JSON.stringify({
                    credits: {
                        monthlyCredits: 1000,
                        purchasedCredits: 200,
                        freeCredits: 50,
                        planId: 'developer-tier',
                    },
                    windowLimits: {
                        fiveHour: { used: 30, cap: 100, exceeded: false, resetAt: 1720000000000 },
                        weekly: { used: 750, cap: 1000, exceeded: false, resetAt: 1720500000000 },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (url.includes('/alpha/billing/subscriptions')) {
                expect(url).to.include('orgId=org_456');
                return new Response(JSON.stringify({
                    data: {
                        planId: 'team-pro',
                        status: 'active',
                        currentPeriodEnd: 1730000000000,
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('Not Found', { status: 404 });
        };

        const service = new CommandCodeAccountService(mockFetch);
        const status = await service.getAccountStatus('test-key');

        expect(status.available).to.be.true;
        expect(status.hasKey).to.be.true;
        expect(status.user?.name).to.equal('Alice Developer');
        expect(status.orgId).to.equal('org_456');
        expect(status.planId).to.equal('team-pro');
        expect(status.subscription?.status).to.equal('active');
        expect(status.credits?.monthlyCredits).to.equal(1000);
        expect(status.credits?.purchasedCredits).to.equal(200);
        expect(status.credits?.freeCredits).to.equal(50);
        expect(status.windowLimits?.fiveHour?.used).to.equal(30);
        expect(status.windowLimits?.fiveHour?.cap).to.equal(100);
        expect(status.windowLimits?.weekly?.used).to.equal(750);
        expect(status.windowLimits?.weekly?.cap).to.equal(1000);
    });

    it('does not draw 0 when windowLimits are missing or omitted', () => {
        // Test parsing with missing fiveHour window
        const creditsData = parseCommandCodeCredits({
            credits: { monthlyCredits: 500 },
            windowLimits: {
                weekly: { used: 10, cap: 100, resetAt: 1720000000000 },
                // fiveHour is completely omitted
            },
        });

        expect(creditsData?.windowLimits?.fiveHour).to.be.undefined;
        expect(creditsData?.windowLimits?.weekly).to.not.be.undefined;

        // Render HTML
        const html = buildCommandCodeQuotaHtml({
            available: true,
            hasKey: true,
            credits: creditsData?.credits,
            windowLimits: creditsData?.windowLimits,
        }, mockLabels);

        // fiveHourLimit progress bar must NOT be rendered
        expect(html).to.not.include('5-hour limit');
        expect(html).to.not.include('>0% used<');
        // Weekly limit progress bar MUST be rendered
        expect(html).to.include('Weekly limit');
        expect(html).to.include('10% used');

        // Test completely empty windowLimits
        const emptyWindowLimitsHtml = buildCommandCodeQuotaHtml({
            available: true,
            hasKey: true,
            credits: { monthlyCredits: 200 },
            windowLimits: {},
        }, mockLabels);

        expect(emptyWindowLimitsHtml).to.not.include('role="progressbar"');
        expect(emptyWindowLimitsHtml).to.include('Monthly credits: 200');
    });

    it('handles 401 unauthorized and network error with fail-open degradation', async () => {
        // 1. Network error
        const failingFetch: typeof fetch = async () => {
            throw new Error('Connection refused or DNS resolution failed');
        };
        const netService = new CommandCodeAccountService(failingFetch);
        const netStatus = await netService.getAccountStatus('test-key');

        expect(netStatus.available).to.be.false;
        expect(netStatus.hasKey).to.be.true;
        expect(netStatus.error).to.include('unavailable');

        const netHtml = buildCommandCodeQuotaHtml(netStatus, mockLabels);
        expect(netHtml).to.equal(mockLabels.unavailable);

        // 2. 401 Unauthorized
        const authFetch: typeof fetch = async () => {
            return new Response('Unauthorized', { status: 401 });
        };
        const authService = new CommandCodeAccountService(authFetch);
        const authStatus = await authService.getAccountStatus('invalid-key');

        expect(authStatus.available).to.be.false;
        expect(authStatus.hasKey).to.be.true;
        expect(authStatus.error).to.include('401');

        const authHtml = buildCommandCodeQuotaHtml(authStatus, mockLabels);
        expect(authHtml).to.equal(mockLabels.unavailable);

        // 3. No API key provided
        const emptyKeyStatus = await authService.getAccountStatus('');
        expect(emptyKeyStatus.available).to.be.false;
        expect(emptyKeyStatus.hasKey).to.be.false;
        expect(buildCommandCodeQuotaHtml(emptyKeyStatus, mockLabels)).to.equal(mockLabels.unavailable);
    });

    it('partially fails open when some endpoints fail but others succeed', async () => {
        const partialFetch: typeof fetch = async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/alpha/billing/credits')) {
                return new Response(JSON.stringify({
                    credits: { freeCredits: 50 },
                    windowLimits: {
                        fiveHour: { used: 15, cap: 100, resetAt: 1720000000000 },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            // other endpoints return 500 or fail
            return new Response('Internal Server Error', { status: 500 });
        };

        const service = new CommandCodeAccountService(partialFetch);
        const status = await service.getAccountStatus('test-key');

        expect(status.available).to.be.true;
        expect(status.credits?.freeCredits).to.equal(50);
        expect(status.windowLimits?.fiveHour?.used).to.equal(15);
        expect(status.user).to.be.undefined;

        const html = buildCommandCodeQuotaHtml(status, mockLabels);
        expect(html).to.include('5-hour limit');
        expect(html).to.include('15% used');
        expect(html).to.include('Free credits: 50');
    });

    it('calculates percentages, tones, and escapes HTML correctly', () => {
        // Normal tone (<70%)
        const normalHtml = buildCommandCodeQuotaHtml({
            available: true,
            hasKey: true,
            windowLimits: {
                fiveHour: { used: 25, cap: 100, resetAt: 1720000000000 },
            },
        }, mockLabels);
        expect(normalHtml).to.include('25% used');
        expect(normalHtml).to.include('75% remaining');
        expect(normalHtml).to.include('codex-quota-fill-normal');

        // Warning tone (>=70% and <90%)
        const warningHtml = buildCommandCodeQuotaHtml({
            available: true,
            hasKey: true,
            windowLimits: {
                fiveHour: { used: 75, cap: 100, resetAt: 1720000000000 },
            },
        }, mockLabels);
        expect(warningHtml).to.include('75% used');
        expect(warningHtml).to.include('25% remaining');
        expect(warningHtml).to.include('codex-quota-fill-warning');

        // Critical tone (>=90%)
        const criticalHtml = buildCommandCodeQuotaHtml({
            available: true,
            hasKey: true,
            windowLimits: {
                fiveHour: { used: 95, cap: 100, resetAt: 1720000000000 },
            },
        }, mockLabels);
        expect(criticalHtml).to.include('95% used');
        expect(criticalHtml).to.include('5% remaining');
        expect(criticalHtml).to.include('codex-quota-fill-critical');

        // Exceeded flag forces critical tone even if percentage is lower
        const exceededHtml = buildCommandCodeQuotaHtml({
            available: true,
            hasKey: true,
            windowLimits: {
                fiveHour: { used: 50, cap: 100, exceeded: true, resetAt: 1720000000000 },
            },
        }, mockLabels);
        expect(exceededHtml).to.include('codex-quota-fill-critical');

        // HTML escaping: test injection in planId, status, etc.
        const maliciousHtml = buildCommandCodeQuotaHtml({
            available: true,
            hasKey: true,
            planId: '<script>alert("xss")</script>',
            subscription: {
                status: 'active & "verified"',
            },
            credits: {
                monthlyCredits: 100,
            },
        }, mockLabels);

        expect(maliciousHtml).to.not.include('<script>');
        expect(maliciousHtml).to.include('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        expect(maliciousHtml).to.include('active &amp; &quot;verified&quot;');
        expect(maliciousHtml).to.include('Monthly credits: 100');
    });
});
