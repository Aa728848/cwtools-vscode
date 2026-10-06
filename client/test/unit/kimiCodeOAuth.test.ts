import { expect } from 'chai';
import {
    KIMI_CODE_CLIENT_ID,
    KIMI_DEVICE_AUTHORIZATION_PATH,
    KimiCodeOAuthService,
    kimiDeviceModel,
    kimiIdentityHeaders,
    pollKimiDeviceToken,
    requestKimiDeviceAuthorization,
} from '../../extension/ai/kimi/oauthService';
import {
    KIMI_CODE_CREDENTIAL_KEY,
    KIMI_REJECTED_COOLDOWN_MS,
    KimiCodeTokenStore,
    KimiUnauthorizedError,
    kimiRefreshThresholdMs,
} from '../../extension/ai/kimi/tokenStore';

const DEVICE_ID = 'device-1';

class Secrets {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Capture the request body of one POST as a URLSearchParams. */
function bodyOf(init: RequestInit | undefined): URLSearchParams {
    return new URLSearchParams(String(init?.body ?? ''));
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('Expected the promise to reject.');
}

describe('Kimi Code device authorization', () => {
    it('sends only the client id and reads the RFC 8628 fields', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const authorization = await requestKimiDeviceAuthorization({
            deviceId: DEVICE_ID,
            host: 'https://auth.example.test',
            fetchFn: async (input, init) => {
                requests.push({ url: String(input), init });
                return json({
                    user_code: 'ABCD-1234',
                    device_code: 'device-code-1',
                    verification_uri: 'https://www.kimi.com/code/authorize',
                    verification_uri_complete: 'https://www.kimi.com/code/authorize?code=ABCD-1234',
                    expires_in: 600,
                    interval: 5,
                });
            },
        });

        expect(requests[0]!.url).to.equal(`https://auth.example.test${KIMI_DEVICE_AUTHORIZATION_PATH}`);
        expect(bodyOf(requests[0]!.init).get('client_id')).to.equal(KIMI_CODE_CLIENT_ID);
        // A public client sends no scope and no PKCE.
        expect([...bodyOf(requests[0]!.init).keys()]).to.deep.equal(['client_id']);
        expect(authorization).to.deep.include({
            userCode: 'ABCD-1234',
            deviceCode: 'device-code-1',
            expiresIn: 600,
            interval: 5,
        });
    });

    it('falls back to the documented polling defaults and rejects an incomplete answer', async () => {
        const authorization = await requestKimiDeviceAuthorization({
            deviceId: DEVICE_ID,
            fetchFn: async () => json({
                user_code: 'A', device_code: 'B', verification_uri_complete: 'https://example.test',
            }),
        });
        expect(authorization.expiresIn).to.equal(600);
        expect(authorization.interval).to.equal(5);

        expect(await rejectionOf(requestKimiDeviceAuthorization({
            deviceId: DEVICE_ID,
            fetchFn: async () => json({ user_code: 'A' }),
        }))).to.match(/device code/);
    });

    // The managed service recognizes this vocabulary; without it the subscription
    // endpoints do not answer the way they do for the official CLI.
    it('identifies as the official client with a stable device id', () => {
        const headers = kimiIdentityHeaders(DEVICE_ID, { accept: 'application/json' });
        expect(headers['x-msh-platform']).to.equal('kimi_code_cli');
        expect(headers['x-msh-device-id']).to.equal(DEVICE_ID);
        expect(headers['accept']).to.equal('application/json');
        expect(kimiDeviceModel()).to.be.a('string').and.not.equal('');
    });

    it('strips non-printable characters from identity headers', () => {
        const headers = kimiIdentityHeaders(DEVICE_ID);
        for (const value of Object.values(headers)) {
            expect(value).to.match(/^[\x20-\x7E]+$/);
        }
    });
});

describe('Kimi Code device token polling', () => {
    const authorization = {
        userCode: 'A', deviceCode: 'device-1', verificationUri: '', verificationUriComplete: 'https://example.test',
        expiresIn: 600, interval: 5, host: 'https://auth.example.test',
    };
    const poll = (fetchFn: typeof fetch) => pollKimiDeviceToken(authorization, { fetchFn, deviceId: DEVICE_ID });

    it('returns the token pair a renewable session needs', async () => {
        const outcome = await poll(async () => json({
            access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600,
        }));
        expect(outcome).to.deep.include({ kind: 'success' });
        if (outcome.kind !== 'success') throw new Error('expected success');
        expect(outcome.token.accessToken).to.equal('access-1');
        expect(outcome.token.refreshToken).to.equal('refresh-1');
        expect(outcome.token.expiresIn).to.equal(3600);
    });

    // Without a refresh token the credential dies in an hour; that is not a
    // usable subscription login, so it is refused rather than stored.
    it('refuses a token response with no refresh token', async () => {
        expect(await rejectionOf(poll(async () => json({ access_token: 'access-1', expires_in: 3600 }))))
            .to.match(/refresh token/);
    });

    it('classifies pending, slow_down, and expired answers', async () => {
        expect(await poll(async () => json({ error: 'authorization_pending' })))
            .to.deep.equal({ kind: 'pending', slowDown: false });
        expect(await poll(async () => json({ error: 'slow_down' })))
            .to.deep.equal({ kind: 'pending', slowDown: true });
        expect(await poll(async () => json({ error: 'expired_token' })))
            .to.deep.equal({ kind: 'expired' });
    });

    it('unwraps a nested error envelope', async () => {
        expect(await poll(async () => json({ error: { code: 'slow_down' } })))
            .to.deep.equal({ kind: 'pending', slowDown: true });
        expect(await rejectionOf(poll(async () => json({ error: { code: 'access_denied', message: 'denied' } }))))
            .to.equal('denied');
    });

    // A 5xx says nothing about the device code; treating it as pending would spin
    // against a broken endpoint until the code expired.
    it('raises a server error instead of reading it as pending', async () => {
        expect(await rejectionOf(poll(async () => new Response('nope', { status: 503 }))))
            .to.match(/server error/);
    });
});

describe('Kimi Code device sign-in service', () => {
    it('saves the token pair and completes', async () => {
        const saved: Array<{ accessToken: string; refreshToken: string }> = [];
        let opened = '';
        let polls = 0;
        const service = new KimiCodeOAuthService({
            storageDir: require('os').tmpdir(),
            fetchFn: async input => {
                const url = String(input);
                if (url.includes(KIMI_DEVICE_AUTHORIZATION_PATH)) {
                    return json({
                        user_code: 'ABCD-1234', device_code: 'device-1',
                        verification_uri_complete: 'https://www.kimi.com/code/authorize?code=ABCD-1234',
                        expires_in: 600, interval: 1,
                    });
                }
                polls += 1;
                // One pending answer first, so the polling path is exercised.
                if (polls === 1) return json({ error: 'authorization_pending' });
                return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
            },
            saveToken: async token => { saved.push(token); },
            openBrowser: url => { opened = url; },
        });

        const login = await service.startLogin();
        expect(login.authorization.userCode).to.equal('ABCD-1234');
        expect(opened).to.contain('ABCD-1234');
        await login.completion;
        expect(saved).to.have.length(1);
        expect(saved[0]!.accessToken).to.equal('access-1');
        expect(saved[0]!.refreshToken).to.equal('refresh-1');
    });

    it('reports the user code so the card can render it without a browser', async () => {
        const shown: string[] = [];
        const service = new KimiCodeOAuthService({
            storageDir: require('os').tmpdir(),
            fetchFn: async input => String(input).includes(KIMI_DEVICE_AUTHORIZATION_PATH)
                ? json({
                    user_code: 'WXYZ-9876', device_code: 'device-2',
                    verification_uri: 'https://www.kimi.com/code/authorize',
                    verification_uri_complete: 'https://www.kimi.com/code/authorize?code=WXYZ-9876',
                    expires_in: 600, interval: 30,
                })
                : json({ error: 'authorization_pending' }),
            saveToken: async () => undefined,
            openBrowser: () => undefined,
            onUserCode: authorization => { shown.push(authorization.userCode); },
        });
        const login = await service.startLogin();
        expect(shown).to.deep.equal(['WXYZ-9876']);
        login.cancel();
        expect(await rejectionOf(login.completion)).to.match(/cancelled/);
    });

    it('cancels a previous attempt when a newer one starts', async () => {
        const service = new KimiCodeOAuthService({
            storageDir: require('os').tmpdir(),
            fetchFn: async input => String(input).includes(KIMI_DEVICE_AUTHORIZATION_PATH)
                ? json({
                    user_code: 'A', device_code: 'd',
                    verification_uri_complete: 'https://example.test',
                    expires_in: 600, interval: 30,
                })
                : json({ error: 'authorization_pending' }),
            saveToken: async () => undefined,
            openBrowser: () => undefined,
        });
        const first = await service.startLogin();
        const second = await service.startLogin();
        expect(await rejectionOf(first.completion)).to.match(/newer Kimi Code sign-in/);
        second.cancel();
        expect(await rejectionOf(second.completion)).to.match(/cancelled/);
    });
});

describe('Kimi Code token store', () => {
    const identityHeaders = async () => ({ 'content-type': 'application/x-www-form-urlencoded' });

    it('reads back only a complete credential', async () => {
        const secrets = new Secrets();
        const store = new KimiCodeTokenStore(secrets as any, async () => json({}), identityHeaders, 'https://auth.example.test');
        expect(await store.read()).to.equal(undefined);
        await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, expiresIn: 3600 });
        expect((await store.read())!.accessToken).to.equal('a');
        await secrets.store(KIMI_CODE_CREDENTIAL_KEY, JSON.stringify({ accessToken: 'a' }));
        expect(await store.read()).to.equal(undefined);
    });

    it('returns the stored token while it is comfortably valid', async () => {
        const secrets = new Secrets();
        let requests = 0;
        const store = new KimiCodeTokenStore(secrets as any, async () => {
            requests += 1;
            return json({});
        }, identityHeaders, 'https://auth.example.test');
        await store.save({ accessToken: 'fresh', refreshToken: 'r', expiresAt: Date.now() + 3600_000, expiresIn: 3600 });
        expect(await store.ensureAccessToken()).to.equal('fresh');
        expect(requests).to.equal(0);
    });

    // The official client refreshes within max(300s, expires_in * 0.5).
    it('refreshes inside the official window and keeps a rotated refresh token', async () => {
        const secrets = new Secrets();
        const requests: RequestInit[] = [];
        const store = new KimiCodeTokenStore(secrets as any, async (_input, init) => {
            requests.push(init ?? {});
            return json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 });
        }, identityHeaders, 'https://auth.example.test');
        await store.save({ accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() + 1000, expiresIn: 3600 });

        expect(await store.ensureAccessToken()).to.equal('renewed');
        expect(requests).to.have.length(1);
        expect(bodyOf(requests[0]).get('grant_type')).to.equal('refresh_token');
        expect(bodyOf(requests[0]).get('refresh_token')).to.equal('r1');
        expect((await store.read())!.refreshToken).to.equal('rotated');
    });

    it('keeps the old refresh token when the service does not rotate it', async () => {
        const secrets = new Secrets();
        const store = new KimiCodeTokenStore(secrets as any, async () => json({ access_token: 'renewed', expires_in: 3600 }),
            identityHeaders, 'https://auth.example.test');
        await store.save({ accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() + 1000, expiresIn: 3600 });
        await store.ensureAccessToken();
        expect((await store.read())!.refreshToken).to.equal('r1');
    });

    // Concurrent callers share one refresh: a burst at expiry would otherwise
    // each rotate the same refresh token and all but the first would fail.
    it('single-flights concurrent refreshes', async () => {
        const secrets = new Secrets();
        let requests = 0;
        const store = new KimiCodeTokenStore(secrets as any, async () => {
            requests += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            return json({ access_token: 'renewed', expires_in: 3600 });
        }, identityHeaders, 'https://auth.example.test');
        await store.save({ accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() + 1000, expiresIn: 3600 });

        const tokens = await Promise.all([
            store.ensureAccessToken(),
            store.ensureAccessToken(),
            store.ensureAccessToken(),
        ]);
        expect(tokens).to.deep.equal(['renewed', 'renewed', 'renewed']);
        expect(requests).to.equal(1);
    });

    it('treats a rejected refresh token as final and remembers it', async () => {
        const secrets = new Secrets();
        const store = new KimiCodeTokenStore(secrets as any, async () => json({ error: 'invalid_grant' }, 401),
            identityHeaders, 'https://auth.example.test');
        await store.save({ accessToken: 'stale', refreshToken: 'dead', expiresAt: Date.now() + 1000, expiresIn: 3600 });

        expect(await rejectionOf(store.ensureAccessToken())).to.match(/Sign in again/);
        expect(store.isRejected('dead')).to.equal(true);
        // A remembered rejection is answered locally instead of hammering the service.
        expect(await rejectionOf(store.ensureAccessToken())).to.match(/rejected the stored refresh token/);
    });

    it('retries a transient refresh failure and then succeeds', async () => {
        const secrets = new Secrets();
        let attempts = 0;
        const store = new KimiCodeTokenStore(secrets as any, async () => {
            attempts += 1;
            return attempts === 1
                ? new Response('busy', { status: 503 })
                : json({ access_token: 'renewed', expires_in: 3600 });
        }, identityHeaders, 'https://auth.example.test');
        await store.save({ accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() + 1000, expiresIn: 3600 });
        expect(await store.ensureAccessToken()).to.equal('renewed');
        expect(attempts).to.equal(2);
    });

    it('computes the official refresh window', () => {
        expect(kimiRefreshThresholdMs(3600)).to.equal(1800_000);
        // A short-lived token still gets the 300s floor.
        expect(kimiRefreshThresholdMs(60)).to.equal(300_000);
    });

    it('exposes a rejection cooldown long enough to stop hammering', () => {
        expect(KIMI_REJECTED_COOLDOWN_MS).to.equal(300_000);
    });

    it('clears the stored credential on sign-out', async () => {
        const secrets = new Secrets();
        const store = new KimiCodeTokenStore(secrets as any, async () => json({}), identityHeaders, 'https://auth.example.test');
        await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, expiresIn: 3600 });
        await store.clear();
        expect(await store.read()).to.equal(undefined);
    });

    it('throws the dedicated unauthorized error type for a dead token', async () => {
        const secrets = new Secrets();
        const store = new KimiCodeTokenStore(secrets as any, async () => json({}, 403), identityHeaders, 'https://auth.example.test');
        await store.save({ accessToken: 'stale', refreshToken: 'dead', expiresAt: Date.now() + 1000, expiresIn: 3600 });
        try {
            await store.ensureAccessToken();
            throw new Error('expected a rejection');
        } catch (error) {
            expect(error).to.be.instanceOf(KimiUnauthorizedError);
        }
    });
});