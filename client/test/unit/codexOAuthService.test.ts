import { expect } from 'chai';
import {
    CHATGPT_OAUTH_ISSUER,
    ChatGptOAuthService,
    CODEX_CHATGPT_USAGE_URL,
    mapCodexUsage,
} from '../../extension/ai/codex/oauthService';

const SECRET_KEY = 'cwtools.ai.codexChatgpt.oauth.v1';

describe('ChatGptOAuthService', () => {
    it('maps subscription and code-review usage windows', () => {
        const limits = mapCodexUsage({
            plan_type: 'plus',
            rate_limit: {
                primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2000 },
                secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 3000 },
            },
            code_review_rate_limit: {
                primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 4000 },
            },
        });

        expect(limits).to.have.length(2);
        expect(limits[0]).to.deep.include({ limitId: 'codex', limitName: 'Codex', planType: 'plus' });
        expect(limits[0]!.primary).to.deep.equal({ usedPercent: 25, windowDurationMins: 300, resetsAt: 2000 });
        expect(limits[0]!.secondary).to.deep.equal({ usedPercent: 40, windowDurationMins: 10080, resetsAt: 3000 });
        expect(limits[1]!.primary).to.deep.equal({ usedPercent: 10, windowDurationMins: 10080, resetsAt: 4000 });
    });

    it('reports account claims and quota without exposing stored tokens', async () => {
        const secrets = new FakeSecrets();
        const accessToken = jwt({
            email: 'plus@example.com',
            'https://api.openai.com/auth': {
                chatgpt_account_id: 'acct-1',
                chatgpt_plan_type: 'plus',
            },
        });
        await secrets.store(SECRET_KEY, JSON.stringify({
            accessToken,
            refreshToken: 'refresh-1',
            expiresAt: Date.now() + 3600_000,
            accountId: 'acct-1',
        }));
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const service = new ChatGptOAuthService(secrets as any, async (input, init) => {
            requests.push({ url: String(input), init });
            return fakeResponse(200, {
                plan_type: 'plus',
                rate_limit: {
                    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 5000 },
                },
            });
        }, '2.8.27');

        const status = await service.getAccountStatus(true);
        expect(status).to.include({ available: true, signedIn: true, email: 'plus@example.com', planType: 'plus' });
        expect(status.models).to.include('gpt-5.6-sol');
        expect(status.rateLimits[0]!.primary?.usedPercent).to.equal(12);
        expect(requests[0]!.url).to.equal(CODEX_CHATGPT_USAGE_URL);
        expect(new Headers(requests[0]!.init?.headers).get('ChatGPT-Account-Id')).to.equal('acct-1');
        expect(JSON.stringify(status)).not.to.contain('refresh-1');
        expect(JSON.stringify(status)).not.to.contain(accessToken);
    });

    it('refreshes expired credentials once and preserves a rotated-optional refresh token', async () => {
        const secrets = new FakeSecrets();
        const refreshedAccess = jwt({
            email: 'renewed@example.com',
            chatgpt_account_id: 'acct-renewed',
        });
        await secrets.store(SECRET_KEY, JSON.stringify({
            accessToken: jwt({ email: 'old@example.com' }),
            refreshToken: 'refresh-old',
            expiresAt: Date.now() - 1000,
        }));
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const service = new ChatGptOAuthService(secrets as any, async (input, init) => {
            requests.push({ url: String(input), init });
            return fakeResponse(200, { access_token: refreshedAccess, expires_in: 3600 });
        });

        const headers = await service.getRequestHeaders();
        expect(headers.Authorization).to.equal(`Bearer ${refreshedAccess}`);
        expect(headers['ChatGPT-Account-Id']).to.equal('acct-renewed');
        expect(headers.originator).to.equal('opencode');
        expect(requests).to.have.length(1);
        expect(requests[0]!.url).to.equal(`${CHATGPT_OAUTH_ISSUER}/oauth/token`);
        expect(String(requests[0]!.init?.body)).to.contain('grant_type=refresh_token');
        const stored = JSON.parse((await secrets.get(SECRET_KEY))!);
        expect(stored.refreshToken).to.equal('refresh-old');
        expect(stored.accessToken).to.equal(refreshedAccess);
    });

    it('deletes only this extension OAuth secret on logout', async () => {
        const secrets = new FakeSecrets();
        await secrets.store(SECRET_KEY, JSON.stringify({
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 1000,
        }));
        await secrets.store('unrelated', 'keep');
        const service = new ChatGptOAuthService(secrets as any, async () => fakeResponse(500, {}));

        await service.logout();

        expect(await secrets.get(SECRET_KEY)).to.equal(undefined);
        expect(await secrets.get('unrelated')).to.equal('keep');
    });
});

function jwt(payload: Record<string, unknown>): string {
    return [
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify(payload)).toString('base64url'),
        'signature',
    ].join('.');
}

function fakeResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

class FakeSecrets {
    private readonly values = new Map<string, string>();

    get(key: string): Promise<string | undefined> {
        return Promise.resolve(this.values.get(key));
    }

    store(key: string, value: string): Promise<void> {
        this.values.set(key, value);
        return Promise.resolve();
    }

    delete(key: string): Promise<void> {
        this.values.delete(key);
        return Promise.resolve();
    }
}

