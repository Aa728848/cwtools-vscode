import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    MINIMAX_CODE_AGENT_LLM_PREFIX,
    MINIMAX_CODE_DEFAULT_MAX_BODY_BYTES,
    MINIMAX_CODE_DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    MINIMAX_CODE_DEVICE_CODE_PATH,
    MINIMAX_CODE_MODELS,
    MINIMAX_CODE_OAUTH_TOKEN_PATH,
    MINIMAX_CODE_REGION_HOSTS,
    isMinimaxCodeModelId,
    minimaxCodeContextWindows,
    minimaxCodeModelDef,
    minimaxCodeOutputConfig,
} from '../../extension/ai/minimaxcode/types';
import {
    MINIMAX_CODE_SECRET_KEY,
    MinimaxCodeCredentialStore,
    isMinimaxCodeCredentialFresh,
    minimaxCodeDesktopCredentialPaths,
    parseMinimaxCodeCredentials,
    scanMinimaxCodeDesktopCredentials,
    writeBackMinimaxCodeDesktopCredential,
} from '../../extension/ai/minimaxcode/credentials';
import {
    MinimaxCodeOAuthService,
    generateMinimaxCodePkce,
    minimaxCodeMessagesUrl,
    minimaxCodeNeedsRefresh,
    pollMinimaxCodeDeviceToken,
    refreshMinimaxCodeCredentials,
    requestMinimaxCodeDeviceAuthorization,
} from '../../extension/ai/minimaxcode/oauthService';

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('Expected the promise to reject.');
}

class Secrets {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

describe('MiniMax Code catalog and thinking shape', () => {
    it('ships the four subscription models with their transcribed windows', () => {
        expect(MINIMAX_CODE_MODELS.map(model => model.id)).to.deep.equal([
            'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3', 'MiniMax-M3.1-Flash-Preview',
        ]);
        expect(minimaxCodeModelDef('MiniMax-M3')!.contextWindow).to.equal(512_000);
        expect(minimaxCodeModelDef('MiniMax-M3')!.optionalContextWindow).to.equal(1_000_000);
        expect(minimaxCodeModelDef('MiniMax-M3.1-Flash-Preview')!.contextWindow).to.equal(1_000_000);
        expect(isMinimaxCodeModelId('MiniMax-M3')).to.equal(true);
        expect(isMinimaxCodeModelId('MiniMax-M9')).to.equal(false);
        expect(minimaxCodeContextWindows()['MiniMax-M3']).to.equal(512_000);
    });

    it('declares only the modalities this route can actually encode', () => {
        for (const model of MINIMAX_CODE_MODELS) {
            expect(model.inputModalities).to.not.include('video' as never);
        }
        expect(minimaxCodeModelDef('MiniMax-M3')!.inputModalities).to.deep.equal(['text', 'image']);
        expect(minimaxCodeModelDef('MiniMax-M2.7')!.inputModalities).to.deep.equal(['text']);
    });

    it('never emits a thinking object and never sends the local default', () => {
        expect(minimaxCodeOutputConfig('MiniMax-M2.7', 'high')).to.equal(undefined);
        expect(minimaxCodeOutputConfig('MiniMax-M3', null)).to.equal(undefined);
        expect(minimaxCodeOutputConfig('MiniMax-M3', 'none')).to.deep.equal({ effort: 'none' });
        expect(minimaxCodeOutputConfig('MiniMax-M3', 'high')).to.equal(undefined);
        expect(minimaxCodeOutputConfig('MiniMax-M3.1-Flash-Preview', 'default')).to.equal(undefined);
        expect(minimaxCodeOutputConfig('MiniMax-M3.1-Flash-Preview', null)).to.equal(undefined);
        expect(minimaxCodeOutputConfig('MiniMax-M3.1-Flash-Preview', 'low')).to.deep.equal({ effort: 'low' });
        expect(minimaxCodeOutputConfig('MiniMax-M3.1-Flash-Preview', 'nonsense')).to.equal(undefined);
        expect(minimaxCodeOutputConfig('MiniMax-M9', 'high')).to.equal(undefined);
    });

    it('uses this route own body and image budgets', () => {
        expect(MINIMAX_CODE_DEFAULT_MAX_BODY_BYTES).to.equal(64 * 1024 * 1024);
        expect(MINIMAX_CODE_DEFAULT_MAX_REQUEST_IMAGE_BYTES).to.equal(16 * 1024 * 1024);
        expect(MINIMAX_CODE_DEFAULT_MAX_REQUEST_IMAGE_BYTES).to.be.greaterThan(10 * 1024 * 1024);
        expect(MINIMAX_CODE_DEFAULT_MAX_REQUEST_IMAGE_BYTES).to.be.lessThan(MINIMAX_CODE_DEFAULT_MAX_BODY_BYTES);
    });
});

describe('MiniMax Code endpoint shape', () => {
    it('builds the Messages URL per region without a doubled /v1', () => {
        const cn = minimaxCodeMessagesUrl('cn');
        expect(cn).to.equal(MINIMAX_CODE_REGION_HOSTS.cn.agent + MINIMAX_CODE_AGENT_LLM_PREFIX + '/messages');
        expect(cn).to.equal('https://agent.minimax.cn/mavis/api/v1/llm/v1/messages');
        expect(minimaxCodeMessagesUrl('global')).to.equal('https://agent.minimax.io/mavis/api/v1/llm/v1/messages');
        expect(cn).to.not.contain('/v1/v1');
    });
});

describe('MiniMax Code credentials', () => {
    it('parses a desktop auth file and keeps its recorded region', () => {
        const credentials = parseMinimaxCodeCredentials({
            auth: { accessToken: 'a1', refreshToken: 'r1', expiresIn: 3600 },
        }, 'desktop', 'global', '/tmp/auth.json', 'prod/global/mcode-public');
        expect(credentials).to.deep.include({
            accessToken: 'a1', refreshToken: 'r1', region: 'global', source: 'desktop',
            sourceFile: '/tmp/auth.json', recordKey: 'prod/global/mcode-public',
        });
    });

    it('rejects a credential with no access token', () => {
        expect(parseMinimaxCodeCredentials({ auth: {} }, 'managed', 'cn')).to.equal(undefined);
    });

    it('probes both regions for desktop credentials', () => {
        const paths = minimaxCodeDesktopCredentialPaths('/home/tester');
        expect(paths.some(entry => entry.region === 'cn')).to.equal(true);
        expect(paths.some(entry => entry.region === 'global')).to.equal(true);
        expect(paths.every(entry => entry.file.includes('mcode-public'))).to.equal(true);
    });

    it('scans only existing auth.json files and skips malformed ones', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-scan-'));
        const dir = path.join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth: { accessToken: 'ok', refreshToken: 'r' } }));
        const broken = path.join(home, '.minimax', 'auth', 'prod', 'global', 'mcode-public');
        fs.mkdirSync(broken, { recursive: true });
        fs.writeFileSync(path.join(broken, 'auth.json'), '{nope');
        try {
            const found = scanMinimaxCodeDesktopCredentials(home);
            expect(found).to.have.length(1);
            expect(found[0]!.accessToken).to.equal('ok');
            expect(found[0]!.region).to.equal('cn');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('writes a rotated token back atomically, preserving other fields', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-write-'));
        const dir = path.join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'auth.json');
        fs.writeFileSync(file, JSON.stringify({ auth: { accessToken: 'old', refreshToken: 'old-r' }, other: 'keep' }));
        try {
            const [credentials] = scanMinimaxCodeDesktopCredentials(home);
            writeBackMinimaxCodeDesktopCredential({ ...credentials!, accessToken: 'new', refreshToken: 'new-r', expiresAt: 4242 });
            const written = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(written.auth).to.deep.include({ accessToken: 'new', refreshToken: 'new-r', expiresAt: 4242 });
            expect(written.other).to.equal('keep');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('does nothing for a managed credential', () => {
        expect(() => writeBackMinimaxCodeDesktopCredential({ source: 'managed', sourceFile: '' } as any)).to.not.throw();
    });

    it('uses a five-minute pre-expiry window', () => {
        expect(isMinimaxCodeCredentialFresh({ expiresAt: Date.now() + 10 * 60_000 } as any)).to.equal(true);
        expect(isMinimaxCodeCredentialFresh({ expiresAt: Date.now() + 60_000 } as any)).to.equal(false);
        expect(minimaxCodeNeedsRefresh({ expiresAt: Date.now() + 60_000 } as any)).to.equal(true);
        expect(minimaxCodeNeedsRefresh({ expiresAt: Date.now() + 10 * 60_000 } as any)).to.equal(false);
        expect(minimaxCodeNeedsRefresh({ expiresAt: 0 } as any)).to.equal(false);
    });

    it('round-trips the managed credential through its store', async () => {
        const secrets = new Secrets();
        const store = new MinimaxCodeCredentialStore(secrets as any);
        expect(await store.readManaged()).to.equal(undefined);
        await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 123, region: 'global', source: 'managed', sourceFile: '', recordKey: 'managed' });
        const read = await store.readManaged();
        expect(read).to.deep.include({ accessToken: 'a', refreshToken: 'r', expiresAt: 123, region: 'global' });
        await store.clear();
        expect(await store.readManaged()).to.equal(undefined);
        expect(secrets.values.has(MINIMAX_CODE_SECRET_KEY)).to.equal(false);
    });
});

describe('MiniMax Code device authorization', () => {
    it('sends PKCE S256 and never puts the verifier in the authorize body', async () => {
        let body: URLSearchParams | undefined;
        const authorization = await requestMinimaxCodeDeviceAuthorization({
            region: 'cn',
            fetchFn: async (input, init) => {
                expect(String(input)).to.equal(MINIMAX_CODE_REGION_HOSTS.cn.account + MINIMAX_CODE_DEVICE_CODE_PATH);
                body = new URLSearchParams(String(init?.body));
                return json({
                    user_code: 'ABCD', device_code: 'd1',
                    verification_uri_complete: 'https://example.test/verify',
                    expires_in: 600, interval: 5,
                });
            },
        });
        expect(body!.get('client_id')).to.equal('mcode-public');
        expect(body!.get('code_challenge_method')).to.equal('S256');
        expect(body!.has('code_verifier')).to.equal(false);
        expect(authorization.codeVerifier).to.not.equal(body!.get('code_challenge'));
        expect(authorization).to.deep.include({ userCode: 'ABCD', deviceCode: 'd1', interval: 5, region: 'cn' });
    });

    it('derives a PKCE challenge as the base64url SHA-256 of the verifier', () => {
        const { verifier, challenge } = generateMinimaxCodePkce();
        expect(challenge).to.not.equal(verifier);
        expect(verifier).to.match(/^[A-Za-z0-9_-]+$/);
        expect(challenge).to.match(/^[A-Za-z0-9_-]+$/);
    });

    it('classifies pending, slow_down, and expired answers', async () => {
        const authorization = {
            userCode: 'A', deviceCode: 'd', verificationUri: '', verificationUriComplete: 'x',
            expiresIn: 600, interval: 5, codeVerifier: 'v', region: 'cn' as const,
        };
        const poll = (fetchFn: typeof fetch) => pollMinimaxCodeDeviceToken(authorization, { fetchFn });
        expect(await poll(async () => json({ error: 'authorization_pending' })))
            .to.deep.equal({ kind: 'pending', slowDown: false });
        expect(await poll(async () => json({ error: 'slow_down' })))
            .to.deep.equal({ kind: 'pending', slowDown: true });
        expect(await poll(async () => json({ error: 'expired_token' })))
            .to.deep.equal({ kind: 'expired' });
        expect(await rejectionOf(poll(async () => new Response('nope', { status: 503 }))))
            .to.match(/server error/);
    });

    it('sends the verifier when exchanging the device code', async () => {
        let body: URLSearchParams | undefined;
        const authorization = {
            userCode: 'A', deviceCode: 'd', verificationUri: '', verificationUriComplete: 'x',
            expiresIn: 600, interval: 5, codeVerifier: 'the-verifier', region: 'cn' as const,
        };
        const outcome = await pollMinimaxCodeDeviceToken(authorization, {
            fetchFn: async (input, init) => {
                expect(String(input)).to.equal(MINIMAX_CODE_REGION_HOSTS.cn.account + MINIMAX_CODE_OAUTH_TOKEN_PATH);
                body = new URLSearchParams(String(init?.body));
                return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
            },
        });
        expect(body!.get('code_verifier')).to.equal('the-verifier');
        expect(outcome.kind).to.equal('success');
        if (outcome.kind !== 'success') throw new Error('expected success');
        expect(outcome.credentials.refreshToken).to.equal('r');
        expect(outcome.credentials.region).to.equal('cn');
    });

    it('refuses a device grant with no refresh token', async () => {
        const saved: any[] = [];
        const service = new MinimaxCodeOAuthService({
            pollIntervalMs: 1,
            fetchFn: async input => String(input).includes(MINIMAX_CODE_DEVICE_CODE_PATH)
                ? json({ user_code: 'A', device_code: 'd', verification_uri_complete: 'https://example.test', expires_in: 600, interval: 1 })
                : json({ access_token: 'a', expires_in: 3600 }),
            saveCredentials: async credentials => { saved.push(credentials); },
            openBrowser: () => undefined,
        });
        const login = await service.startLogin();
        expect(await rejectionOf(login.completion)).to.match(/refresh token/);
        expect(saved).to.deep.equal([]);
    });

    it('saves a complete device credential and reports the user code', async () => {
        const saved: any[] = [];
        const shown: string[] = [];
        const service = new MinimaxCodeOAuthService({
            pollIntervalMs: 1,
            fetchFn: async input => String(input).includes(MINIMAX_CODE_DEVICE_CODE_PATH)
                ? json({ user_code: 'WXYZ', device_code: 'd', verification_uri_complete: 'https://example.test', expires_in: 600, interval: 1 })
                : json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
            saveCredentials: async credentials => { saved.push(credentials); },
            openBrowser: () => undefined,
            onUserCode: authorization => { shown.push(authorization.userCode); },
        });
        const login = await service.startLogin();
        await login.completion;
        expect(shown).to.deep.equal(['WXYZ']);
        expect(saved).to.have.length(1);
        expect(saved[0]).to.deep.include({ accessToken: 'a', refreshToken: 'r' });
    });

    it('cancels a previous attempt when a newer one starts', async () => {
        const service = new MinimaxCodeOAuthService({
            pollIntervalMs: 30,
            fetchFn: async input => String(input).includes(MINIMAX_CODE_DEVICE_CODE_PATH)
                ? json({ user_code: 'A', device_code: 'd', verification_uri_complete: 'https://example.test', expires_in: 600, interval: 30 })
                : json({ error: 'authorization_pending' }),
            saveCredentials: async () => undefined,
            openBrowser: () => undefined,
        });
        const first = await service.startLogin();
        const second = await service.startLogin();
        expect(await rejectionOf(first.completion)).to.match(/newer MiniMax Code sign-in/);
        second.cancel();
        expect(await rejectionOf(second.completion)).to.match(/cancelled/);
    });
});

describe('MiniMax Code token refresh', () => {
    const credentials = {
        accessToken: 'old', refreshToken: 'r1', expiresAt: 0, region: 'cn' as const,
        source: 'managed' as const, sourceFile: '', recordKey: 'managed',
    };

    it('rotates the token and keeps the old refresh token when none is returned', async () => {
        const refreshed = await refreshMinimaxCodeCredentials(credentials, {
            fetchFn: async () => json({ access_token: 'new', expires_in: 3600 }),
        });
        expect(refreshed.accessToken).to.equal('new');
        expect(refreshed.refreshToken).to.equal('r1');
        expect(refreshed.expiresAt).to.be.greaterThan(Date.now());
    });

    it('treats a rejected refresh token as final', async () => {
        expect(await rejectionOf(refreshMinimaxCodeCredentials(credentials, {
            fetchFn: async () => json({}, 401),
        }))).to.match(/Sign in again/);
        expect(await rejectionOf(refreshMinimaxCodeCredentials(credentials, {
            fetchFn: async () => json({}, 500),
        }))).to.match(/token refresh failed \(500\)/);
    });
});
