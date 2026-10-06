import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    WORKBUDDY_CN_BACKEND,
    WORKBUDDY_DEFAULT_DOMAIN,
    WORKBUDDY_LOGIN_PENDING_CODE,
    WORKBUDDY_STANDARD_EFFORTS,
    convergeWorkBuddyEffort,
    isWorkBuddyIntlDomain,
    workBuddyBackendForDomain,
    workBuddyDomainForRegion,
    workBuddyRegionForDomain,
    workBuddyRefreshSourceForDomain,
} from '../../extension/ai/workbuddy/types';
import {
    WORKBUDDY_SECRET_KEY,
    WorkBuddyCredentialStore,
    isWorkBuddyCredentialFresh,
    mergeWorkBuddyAccounts,
    parseWorkBuddyCredentials,
    scanWorkBuddyDesktopCredentials,
    workBuddyAccountKey,
    writeBackWorkBuddyDesktopCredential,
} from '../../extension/ai/workbuddy/credentials';
import {
    clearCachedWorkBuddyCatalog,
    loadWorkBuddyCatalog,
    parseWorkBuddyConfigModels,
    workBuddyContextWindows,
    workBuddyEffortsFor,
} from '../../extension/ai/workbuddy/modelCatalog';
import {
    WorkBuddyOAuthService,
    parseWorkBuddyLoginCredential,
    refreshWorkBuddyCredentials,
    workBuddyHeaders,
} from '../../extension/ai/workbuddy/client';
import { summarizeWorkBuddyAccounts } from '../../extension/ai/workbuddy/accountStatus';

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

describe('WorkBuddy region and domain rules', () => {
    // The region is a credential property, not a request property.
    it('decides the backend from the auth domain', () => {
        expect(isWorkBuddyIntlDomain('www.workbuddy.ai')).to.equal(true);
        expect(isWorkBuddyIntlDomain('www.codebuddy.ai')).to.equal(true);
        expect(isWorkBuddyIntlDomain('www.codebuddy.cn')).to.equal(false);
        expect(workBuddyRegionForDomain('www.workbuddy.ai')).to.equal('intl');
        expect(workBuddyRegionForDomain('www.codebuddy.cn')).to.equal('cn');
        expect(workBuddyBackendForDomain('www.workbuddy.ai')).to.equal('https://www.workbuddy.ai');
        expect(workBuddyBackendForDomain('www.codebuddy.ai')).to.equal('https://www.codebuddy.ai');
        expect(workBuddyBackendForDomain('www.codebuddy.cn')).to.equal(WORKBUDDY_CN_BACKEND);
        expect(workBuddyDomainForRegion('intl')).to.equal('www.workbuddy.ai');
        expect(workBuddyDomainForRegion('cn')).to.equal('copilot.tencent.com');
    });

    it('marks the refresh source the token endpoint expects', () => {
        expect(workBuddyRefreshSourceForDomain('www.workbuddy.ai')).to.equal('workbuddy');
        expect(workBuddyRefreshSourceForDomain('www.codebuddy.ai')).to.equal('plugin');
        expect(workBuddyRefreshSourceForDomain('www.codebuddy.cn')).to.equal('plugin');
    });

    // A default the ladder does not contain must converge, or the request loses
    // its reasoning field entirely and the model answers with no thinking.
    it('converges a default effort onto the nearest rung', () => {
        // Ties resolve upward, which is the mapping the sibling Kimi line documents.
        expect(convergeWorkBuddyEffort('medium', ['low', 'high', 'max'])).to.equal('high');
        expect(convergeWorkBuddyEffort('high', ['low', 'high', 'max'])).to.equal('high');
        expect(convergeWorkBuddyEffort('xhigh', ['low', 'high', 'max'])).to.equal('max');
        // An unrecognised level ranks at the middle rung, never at an extreme.
        expect(convergeWorkBuddyEffort('nonsense', ['low', 'high'])).to.equal('high');
        expect(convergeWorkBuddyEffort('high', [])).to.equal(null);
    });
});

describe('WorkBuddy credential parsing', () => {
    it('reads the auth block and derives the region', () => {
        const credentials = parseWorkBuddyCredentials({
            auth: {
                accessToken: 'access-1',
                refreshToken: 'refresh-1',
                expiresIn: 3600,
                domain: 'www.workbuddy.ai',
            },
            account: { uid: 'u1', nickname: 'tester', uin: '10001', enterpriseId: 'e1' },
        }, 'desktop', '/tmp/x.info', 123);
        expect(credentials).to.deep.include({
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            domain: 'www.workbuddy.ai',
            region: 'intl',
            backend: 'https://www.workbuddy.ai',
            uid: 'u1',
            nickname: 'tester',
            uin: '10001',
            enterpriseId: 'e1',
            source: 'desktop',
            sourceFile: '/tmp/x.info',
            sourceMtimeMs: 123,
        });
    });

    it('rejects a credential without an access token and defaults the domain', () => {
        expect(parseWorkBuddyCredentials({ auth: {} }, 'managed')).to.equal(undefined);
        const credentials = parseWorkBuddyCredentials({ accessToken: 'a' }, 'managed')!;
        expect(credentials.domain).to.equal(WORKBUDDY_DEFAULT_DOMAIN);
        expect(credentials.region).to.equal('cn');
    });

    // Identity keys are the account boundary: the same account signing in again
    // must merge rather than produce a second row.
    it('keys an account by uid before uin before name', () => {
        expect(workBuddyAccountKey({ uid: 'u1', uin: 'n1', nickname: 'x', domain: 'd' })).to.equal('uid:u1');
        expect(workBuddyAccountKey({ uin: 'n1', nickname: 'x', domain: 'd' })).to.equal('uin:n1');
        expect(workBuddyAccountKey({ nickname: 'x', domain: 'd' })).to.equal('name:d:x');
    });

    it('treats an unset expiry as fresh and a past one as stale', () => {
        expect(isWorkBuddyCredentialFresh({ expiresAt: 0 } as any)).to.equal(true);
        expect(isWorkBuddyCredentialFresh({ expiresAt: Date.now() + 3600_000 } as any)).to.equal(true);
        expect(isWorkBuddyCredentialFresh({ expiresAt: Date.now() + 1000 } as any)).to.equal(false);
    });
});

describe('WorkBuddy managed credential store', () => {
    it('merges a repeat sign-in of the same account instead of duplicating it', async () => {
        const secrets = new Secrets();
        const store = new WorkBuddyCredentialStore(secrets as any);
        await store.addManaged({ accessToken: 'a1', refreshToken: 'r', expiresAt: 0, domain: 'www.codebuddy.cn', backend: WORKBUDDY_CN_BACKEND, region: 'cn', uid: 'u1', source: 'managed', sourceFile: '', sourceMtimeMs: 0 } as any);
        await store.addManaged({ accessToken: 'a2', refreshToken: 'r2', expiresAt: 0, domain: 'www.codebuddy.cn', backend: WORKBUDDY_CN_BACKEND, region: 'cn', uid: 'u1', source: 'managed', sourceFile: '', sourceMtimeMs: 0 } as any);
        const stored = await store.readManaged();
        expect(stored).to.have.length(1);
        expect(stored[0]!.accessToken).to.equal('a2');
    });

    it('removes only the named account and tolerates corrupt storage', async () => {
        const secrets = new Secrets();
        const store = new WorkBuddyCredentialStore(secrets as any);
        await store.addManaged({ accessToken: 'a1', refreshToken: 'r', expiresAt: 0, domain: 'www.codebuddy.cn', backend: WORKBUDDY_CN_BACKEND, region: 'cn', uid: 'u1', source: 'managed', sourceFile: '', sourceMtimeMs: 0 } as any);
        await store.addManaged({ accessToken: 'a2', refreshToken: 'r', expiresAt: 0, domain: 'www.codebuddy.cn', backend: WORKBUDDY_CN_BACKEND, region: 'cn', uid: 'u2', source: 'managed', sourceFile: '', sourceMtimeMs: 0 } as any);
        await store.removeManaged('uid:u1');
        expect((await store.readManaged()).map(entry => entry.uid)).to.deep.equal(['u2']);
        await secrets.store(WORKBUDDY_SECRET_KEY, '{not json');
        expect(await store.readManaged()).to.deep.equal([]);
    });

    it('lets an explicitly added account win over a scanned desktop one', () => {
        const desktop = [{ uid: 'u1', accessToken: 'desktop', source: 'desktop' }] as any;
        const managed = [{ uid: 'u1', accessToken: 'managed', source: 'managed' }] as any;
        const merged = mergeWorkBuddyAccounts(desktop, managed);
        expect(merged).to.have.length(1);
        expect(merged[0]!.accessToken).to.equal('managed');
    });
});

describe('WorkBuddy desktop credential handling', () => {
    it('scans only *.info files and skips malformed ones', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-scan-'));
        const root = path.join(home, '.codebuddy');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'a.info'), JSON.stringify({ auth: { accessToken: 'ok', domain: 'www.codebuddy.cn' } }));
        fs.writeFileSync(path.join(root, 'broken.info'), '{nope');
        fs.writeFileSync(path.join(root, 'ignore.json'), JSON.stringify({ auth: { accessToken: 'nope' } }));
        try {
            const found = scanWorkBuddyDesktopCredentials(home);
            expect(found).to.have.length(1);
            expect(found[0]!.accessToken).to.equal('ok');
            expect(found[0]!.source).to.equal('desktop');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    // A desktop account's refresh token rotates; writing it back is what keeps
    // the IDE from being left with one the service has already retired.
    it('writes a rotated token back into the auth block atomically', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-write-'));
        const root = path.join(home, '.codebuddy');
        fs.mkdirSync(root, { recursive: true });
        const file = path.join(root, 'a.info');
        fs.writeFileSync(file, JSON.stringify({ auth: { accessToken: 'old', refreshToken: 'old-r', domain: 'www.codebuddy.cn' }, other: 'keep' }));
        try {
            const [credentials] = scanWorkBuddyDesktopCredentials(home);
            writeBackWorkBuddyDesktopCredential({ ...credentials!, accessToken: 'new', refreshToken: 'new-r', expiresAt: 4242 });
            const written = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(written.auth).to.deep.include({ accessToken: 'new', refreshToken: 'new-r', expiresAt: 4242 });
            // Fields outside the auth block must survive untouched.
            expect(written.other).to.equal('keep');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('does nothing for a managed credential', () => {
        expect(() => writeBackWorkBuddyDesktopCredential({ source: 'managed', sourceFile: '' } as any)).to.not.throw();
    });
});

describe('WorkBuddy gateway headers', () => {
    it('carries the account identity and CLI identity the gateway gates on', () => {
        const headers = workBuddyHeaders({
            accessToken: 'access-1',
            domain: 'www.codebuddy.cn',
            uid: 'u1',
            enterpriseId: 'e1',
            backend: WORKBUDDY_CN_BACKEND,
        });
        expect(headers.authorization).to.equal('Bearer access-1');
        expect(headers['x-user-id']).to.equal('u1');
        expect(headers['x-enterprise-id']).to.equal('e1');
        expect(headers['x-domain']).to.equal('www.codebuddy.cn');
        expect(headers['user-agent']).to.contain('CodeBuddy');
        // The domestic deployment does not validate a browser origin.
        expect(headers).to.not.have.property('origin');
    });

    it('sends the browser origin the international backend validates', () => {
        const headers = workBuddyHeaders({
            accessToken: 'a', domain: 'www.workbuddy.ai', backend: 'https://www.workbuddy.ai',
        });
        expect(headers.origin).to.equal('https://www.workbuddy.ai');
        expect(headers.referer).to.equal('https://www.workbuddy.ai/');
    });
});

describe('WorkBuddy token refresh', () => {
    const credentials = {
        accessToken: 'old', refreshToken: 'r1', expiresAt: 0,
        domain: 'www.codebuddy.cn', backend: WORKBUDDY_CN_BACKEND, region: 'cn' as const,
        source: 'managed' as const, sourceFile: '', sourceMtimeMs: 0,
    };

    it('merges the new auth block over the current credential', async () => {
        const refreshed = await refreshWorkBuddyCredentials(credentials, {
            fetchFn: async (_input, init) => {
                const headers = new Headers(init?.headers);
                expect(headers.get('x-refresh-token')).to.equal('r1');
                expect(headers.get('x-auth-refresh-source')).to.equal('plugin');
                return json({ code: 0, data: { accessToken: 'new', refreshToken: 'r2', expiresIn: 3600 } });
            },
        });
        expect(refreshed.accessToken).to.equal('new');
        expect(refreshed.refreshToken).to.equal('r2');
        expect(refreshed.expiresAt).to.be.greaterThan(Date.now());
        // The domain the endpoint omitted must survive, or the next refresh
        // would lose its target.
        expect(refreshed.domain).to.equal('www.codebuddy.cn');
    });

    it('keeps the old refresh token when the service does not rotate it', async () => {
        const refreshed = await refreshWorkBuddyCredentials(credentials, {
            fetchFn: async () => json({ code: 0, data: { accessToken: 'new', expiresIn: 60 } }),
        });
        expect(refreshed.refreshToken).to.equal('r1');
    });

    it('rejects a refused refresh and a non-zero business code', async () => {
        expect(await rejectionOf(refreshWorkBuddyCredentials(credentials, {
            fetchFn: async () => json({}, 401),
        }))).to.match(/token refresh failed \(401\)/);
        expect(await rejectionOf(refreshWorkBuddyCredentials(credentials, {
            fetchFn: async () => json({ code: 40001, msg: 'nope' }),
        }))).to.match(/nope/);
    });
});

describe('WorkBuddy login flow', () => {
    const attempt = { state: 's1', authUrl: 'https://example.test/auth', region: 'cn' as const, domain: 'www.codebuddy.cn' };

    it('treats the pending code as still waiting rather than as a failure', () => {
        expect(parseWorkBuddyLoginCredential({ code: WORKBUDDY_LOGIN_PENDING_CODE }, attempt)).to.equal(null);
    });

    it('reads the credential out of the two observed wrappers', () => {
        const credentials = parseWorkBuddyLoginCredential({
            code: 0,
            data: { auth: { accessToken: 'a', refreshToken: 'r', domain: 'www.workbuddy.ai' }, account: { uid: 'u1', nickname: 'n' } },
        }, attempt);
        expect(credentials).to.deep.include({
            accessToken: 'a', refreshToken: 'r', domain: 'www.workbuddy.ai', region: 'intl', uid: 'u1', nickname: 'n',
        });
    });

    it('reports a non-zero code and a missing token', () => {
        expect(() => parseWorkBuddyLoginCredential({ code: 40001, msg: 'denied' }, attempt)).to.throw(/denied/);
        expect(() => parseWorkBuddyLoginCredential({ code: 0, data: {} }, attempt)).to.throw(/access token/);
    });

    // The browser authorization only returns the auth block, so the account must
    // be resolved before it is stored.
    it('resolves the account identity before saving', async () => {
        const saved: any[] = [];
        let polls = 0;
        const service = new WorkBuddyOAuthService({
            pollIntervalMs: 1,
            fetchFn: async input => {
                const url = String(input);
                if (url.includes('/v2/plugin/auth/state')) {
                    return json({ code: 0, data: { state: 's1', authUrl: 'https://example.test/auth' } });
                }
                if (url.includes('/v2/plugin/auth/token')) {
                    polls += 1;
                    if (polls === 1) return json({ code: WORKBUDDY_LOGIN_PENDING_CODE });
                    return json({ code: 0, data: { auth: { accessToken: 'a', refreshToken: 'r' } } });
                }
                if (url.includes('/v2/plugin/account')) return json({ code: 0, data: { uid: 'u1', nickname: 'n1' } });
                throw new Error('Unexpected route: ' + url);
            },
            saveCredentials: async credentials => { saved.push(credentials); },
            openBrowser: () => undefined,
        });
        const login = await service.startLogin('cn');
        expect(login.authUrl).to.equal('https://example.test/auth');
        await login.completion;
        expect(saved).to.have.length(1);
        expect(saved[0]).to.deep.include({ accessToken: 'a', uid: 'u1', nickname: 'n1', region: 'cn' });
    });

    it('cancels a previous attempt when a newer one starts', async () => {
        const service = new WorkBuddyOAuthService({
            pollIntervalMs: 30,
            fetchFn: async input => String(input).includes('/v2/plugin/auth/state')
                ? json({ code: 0, data: { state: 's', authUrl: 'https://example.test/auth' } })
                : json({ code: WORKBUDDY_LOGIN_PENDING_CODE }),
            saveCredentials: async () => undefined,
            openBrowser: () => undefined,
        });
        const first = await service.startLogin('cn');
        const second = await service.startLogin('cn');
        expect(await rejectionOf(first.completion)).to.match(/newer WorkBuddy sign-in/);
        second.cancel();
        expect(await rejectionOf(second.completion)).to.match(/cancelled/);
    });
});

describe('WorkBuddy model catalog', () => {
    afterEach(() => clearCachedWorkBuddyCatalog());

    it('reads the window, image support, and reasoning ladder per model', () => {
        const models = parseWorkBuddyConfigModels({
            data: {
                models: [
                    {
                        id: 'deepseek-v4.1-flash',
                        name: 'DeepSeek V4.1 Flash',
                        maxAllowedSize: 1_000_000,
                        maxOutputTokens: 65_536,
                        supportsImages: true,
                        contextWindow: { defaultLength: 300_000 },
                        reasoning: { effort: 'high' },
                    },
                    { id: 'text-to-image', tags: ['text-to-image'], maxAllowedSize: 1 },
                    { id: 'no-window' },
                ],
            },
        }, 'cn');
        expect(models).to.have.length(1);
        // The served default is what DSH's overflow decisions must use, not the
        // model ceiling: this route sends no explicit length.
        expect(models[0]!.contextWindow).to.equal(300_000);
        expect(models[0]!.maxContextWindow).to.equal(1_000_000);
        expect(models[0]!.supportsImage).to.equal(true);
        // An effort-only entry is not a one-rung ladder.
        expect(models[0]!.reasoningEfforts).to.deep.equal([...WORKBUDDY_STANDARD_EFFORTS]);
        expect(models[0]!.defaultReasoningEffort).to.equal('high');
    });

    it('converges a default that the declared ladder does not contain', () => {
        const [model] = parseWorkBuddyConfigModels({
            data: { models: [{ id: 'm', maxAllowedSize: 1000, reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'medium' } }] },
        }, 'cn');
        expect(model!.defaultReasoningEffort).to.equal('high');
    });

    it('maps the listing to the context windows DSH uses for compaction', () => {
        expect(workBuddyContextWindows([
            { id: 'a', name: 'a', contextWindow: 100, maxContextWindow: 200, maxTokens: 1, supportsImage: false, reasoningEfforts: [], defaultReasoningEffort: null, canDisableThinking: false, description: '' },
        ])).to.deep.equal({ a: 100 });
    });

    it('keeps one region catalog from answering the other', async () => {
        await loadWorkBuddyCatalog({
            backend: 'https://www.codebuddy.cn', region: 'cn', headers: {},
            fetchFn: async () => json({ data: { models: [{ id: 'cn-model', maxAllowedSize: 1000 }] } }),
        });
        const intl = await loadWorkBuddyCatalog({
            backend: 'https://www.workbuddy.ai', region: 'intl', headers: {},
            fetchFn: async () => json({ data: { models: [{ id: 'intl-model', maxAllowedSize: 2000 }] } }),
        });
        expect(intl.map(model => model.id)).to.deep.equal(['intl-model']);
        expect(workBuddyEffortsFor('intl-model')).to.deep.equal([]);
    });

    it('keeps the previous snapshot when a refresh fails', async () => {
        await loadWorkBuddyCatalog({
            backend: 'https://www.codebuddy.cn', region: 'cn', headers: {},
            fetchFn: async () => json({ data: { models: [{ id: 'a', maxAllowedSize: 1000 }] } }),
        });
        const failed = await loadWorkBuddyCatalog({
            backend: 'https://www.codebuddy.cn', region: 'cn', headers: {}, force: true,
            fetchFn: async () => new Response('nope', { status: 500 }),
        });
        expect(failed.map(model => model.id)).to.deep.equal(['a']);
    });
});

describe('WorkBuddy account card summary', () => {
    it('marks desktop accounts as non-removable and reports availability', () => {
        const status = summarizeWorkBuddyAccounts([
            { uid: 'u1', nickname: 'desk', domain: 'www.codebuddy.cn', region: 'cn', source: 'desktop', expiresAt: 0, accessToken: 'a', refreshToken: 'r', backend: WORKBUDDY_CN_BACKEND, sourceFile: '/x', sourceMtimeMs: 0 } as any,
            { uid: 'u2', nickname: 'mine', domain: 'www.workbuddy.ai', region: 'intl', source: 'managed', expiresAt: 0, accessToken: 'a', refreshToken: 'r', backend: 'https://www.workbuddy.ai', sourceFile: '', sourceMtimeMs: 0 } as any,
        ], key => key === 'uid:u2');
        expect(status.accounts).to.have.length(2);
        expect(status.accounts[0]!.removable).to.equal(false);
        expect(status.accounts[1]!.removable).to.equal(true);
        expect(status.accounts[1]!.hidden).to.equal(true);
        expect(status.accounts[0]!.label).to.contain('国区');
        expect(status.accounts[1]!.label).to.contain('国际区');
        // Only the unhidden, still-valid account counts as available.
        expect(status.available).to.equal(true);
    });

    it('reports nothing available when every account is hidden', () => {
        const status = summarizeWorkBuddyAccounts([
            { uid: 'u1', domain: 'www.codebuddy.cn', region: 'cn', source: 'desktop', expiresAt: 0, accessToken: 'a', refreshToken: 'r', backend: WORKBUDDY_CN_BACKEND, sourceFile: '/x', sourceMtimeMs: 0 } as any,
        ], () => true);
        expect(status.available).to.equal(false);
    });
});
