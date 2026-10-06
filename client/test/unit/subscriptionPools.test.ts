import { expect } from 'chai';
import {
    claudePoolCredentials,
    claudePoolIdentityKey,
    codexPoolCredentials,
    codexPoolIdentityKey,
    commandCodePoolCredentials,
    commandCodePoolIdentityKey,
    kimiPoolCredentials,
    kimiPoolIdentityKey,
    minimaxCodePoolCredentials,
    minimaxCodePoolIdentityKey,
    subscriptionRefreshFailureStatus,
    workBuddyPoolCredentials,
    workBuddyPoolIdentityKey,
} from '../../extension/ai/pool/subscriptionPools';
import { SubscriptionPoolRegistry } from '../../extension/ai/pool/poolRegistry';
import { OAuthAccountPool, oauthRefreshFailureStatus, parseOAuthPoolData,
    type OAuthPoolSpec, type PooledOAuthCredentials } from '../../extension/ai/pool/oauthAccountPool';

interface TestCred extends PooledOAuthCredentials { email?: string }

/** A minimal line used to exercise the shared factory and the registry. */
function testSpec(
    refresh?: (credentials: TestCred) => Promise<TestCred>,
    extra: Partial<OAuthPoolSpec<TestCred>> = {},
): OAuthPoolSpec<TestCred> {
    return {
        displayName: 'Test',
        parseCredentials: value => {
            if (typeof value !== 'object' || value === null) return undefined;
            const record = value as Record<string, unknown>;
            if (typeof record.accessToken !== 'string' || typeof record.refreshToken !== 'string') return undefined;
            return {
                accessToken: record.accessToken,
                refreshToken: record.refreshToken,
                ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}),
                ...(typeof record.email === 'string' ? { email: record.email } : {}),
            };
        },
        identityKey: credentials => credentials.email,
        defaultAlias: (credentials, position) => credentials.email ?? ('Account ' + position),
        ...(refresh === undefined ? {} : { refresh }),
        ...extra,
    };
}

function memoryStore() {
    const box: { value?: unknown; store: { read(): Promise<unknown>; write(v: unknown): Promise<void> } } = {
        value: undefined,
        store: {
            async read() { return box.value; },
            async write(v: unknown) { box.value = v; },
        },
    };
    return box;
}

const cred = (over: Partial<TestCred> = {}): TestCred => ({
    accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...over,
});

describe('Shared OAuth pool factory', () => {
    it('parses a stored document text and skips malformed rows', () => {
        const parsed = parseOAuthPoolData({
            version: 1, rotationStrategy: 'round-robin',
            accounts: [
                { id: 'a1', alias: 'A', addedAt: 1, credentials: { accessToken: 't', refreshToken: 'r' } },
                { id: 'a2', alias: 'B', addedAt: 2, credentials: { accessToken: 't' } },
            ],
        }, testSpec());
        expect(parsed.rotationStrategy).to.equal('round-robin');
        expect(parsed.accounts.map(a => a.id)).to.deep.equal(['a1']);
    });

    // A stored string must be parsed: SecretStorage only holds strings, and a
    // parser that rejected one would make the pool read as permanently empty.
    it('accepts the JSON text SecretStorage actually stores', () => {
        const parsed = parseOAuthPoolData(JSON.stringify({
            rotationStrategy: 'sticky',
            accounts: [{ id: 'x', alias: 'X', addedAt: 1, credentials: { accessToken: 't', refreshToken: 'r' } }],
        }), testSpec());
        expect(parsed.accounts).to.have.length(1);
    });

    // A static key has no refresh function, so the kernel must never try to
    // rotate it; rotation, cooldown and parking still apply.
    it('never refreshes a credential whose line declares no refresh', async () => {
        const pool = new OAuthAccountPool(testSpec(undefined, {
            // A refresh is deliberately absent; needsRefresh must therefore be false.
        }), { store: memoryStore().store });
        await pool.addAccount({ accessToken: 'static', refreshToken: '', expiresAt: 1 });
        const selected = await pool.getEffectiveAccount();
        expect(selected.credentials.accessToken).to.equal('static');
    });

    it('rotates a stale credential and keeps the account row', async () => {
        const box = memoryStore();
        const pool = new OAuthAccountPool(testSpec(async credentials => ({
            ...credentials, accessToken: 'fresh', expiresAt: Date.now() + 3600_000,
        })), { store: box.store });
        await pool.addAccount(cred({ email: 'a@x', accessToken: 'stale', expiresAt: Date.now() - 1 }));
        expect((await pool.getEffectiveAccount()).credentials.accessToken).to.equal('fresh');
        expect(await pool.listAccounts()).to.have.length(1);
    });

    // Upstream retires a rotated token, so concurrent callers must share one
    // rotation or all but the first would be spending a dead token.
    it('single-flights concurrent rotations of one account', async () => {
        let refreshes = 0;
        const pool = new OAuthAccountPool(testSpec(async credentials => {
            refreshes += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { ...credentials, accessToken: 'fresh', expiresAt: Date.now() + 3600_000 };
        }), { store: memoryStore().store });
        await pool.addAccount(cred({ email: 'a@x', expiresAt: Date.now() - 1 }));
        const results = await Promise.all([
            pool.getEffectiveAccount(), pool.getEffectiveAccount(), pool.getEffectiveAccount(),
        ]);
        expect(refreshes).to.equal(1);
        expect(results.map(r => r.credentials.accessToken)).to.deep.equal(['fresh', 'fresh', 'fresh']);
    });

    // A line that states an expiry in the past by epoch 0 means EXPIRED, not
    // "never expires"; reading it the other way keeps a dead token in service.
    it('treats a stated expiry as absolute, including epoch zero', async () => {
        let refreshes = 0;
        const pool = new OAuthAccountPool(testSpec(async credentials => {
            refreshes += 1;
            return { ...credentials, accessToken: 'fresh', expiresAt: Date.now() + 3600_000 };
        }), { store: memoryStore().store });
        await pool.addAccount(cred({ email: 'a@x', expiresAt: 0 }));
        await pool.getEffectiveAccount();
        expect(refreshes).to.equal(1);
    });

    it('projects the legacy single credential as the primary account', async () => {
        const pool = new OAuthAccountPool(testSpec(), {
            store: memoryStore().store,
            legacy: {
                read: async () => cred({ accessToken: 'legacy', email: 'old@x' }),
                write: async () => undefined,
            },
        });
        const accounts = await pool.listAccounts();
        expect(accounts).to.have.length(1);
        expect(accounts[0]!.isPrimary).to.equal(true);
    });
});

describe('Per-line pool specifications', () => {
    it('keys Claude accounts by uuid then email', () => {
        expect(claudePoolIdentityKey(claudePoolCredentials({
            accessToken: 'a', refreshToken: 'r', accountUuid: 'u1', accountEmail: 'x@y', scopes: [],
        })!)).to.equal('uuid:u1');
        expect(claudePoolIdentityKey(claudePoolCredentials({
            accessToken: 'a', refreshToken: 'r', accountEmail: 'X@Y', scopes: [],
        })!)).to.equal('email:x@y');
    });

    it('keeps the Claude subscription scope so the credential stays usable', () => {
        const parsed = claudePoolCredentials({ accessToken: 'a', refreshToken: 'r', scopes: ['user:inference'] })!;
        expect(parsed.scopes).to.deep.equal(['user:inference']);
    });

    it('keeps the MiniMax region and record slot with the credential', () => {
        const parsed = minimaxCodePoolCredentials({
            accessToken: 'a', refreshToken: 'r', region: 'global', recordKey: 'prod/global/mcode-public',
        })!;
        expect(parsed.region).to.equal('global');
        expect(minimaxCodePoolIdentityKey(parsed)).to.equal('record:prod/global/mcode-public');
    });

    it('keys WorkBuddy accounts by uid then uin then name', () => {
        const base = { accessToken: 'a', refreshToken: 'r', domain: 'd', backend: 'b', region: 'cn' as const, source: 'managed' as const, sourceFile: '' };
        expect(workBuddyPoolIdentityKey(workBuddyPoolCredentials({ ...base, uid: 'u1' })!)).to.equal('uid:u1');
        expect(workBuddyPoolIdentityKey(workBuddyPoolCredentials({ ...base, uin: 'n1' })!)).to.equal('uin:n1');
        expect(workBuddyPoolIdentityKey(workBuddyPoolCredentials({ ...base, nickname: 'me' })!))
            .to.equal('name:d:me');
    });

    // The region is a credential property: a model asked of the wrong region is a 400.
    it('requires a WorkBuddy domain with the credential', () => {
        expect(workBuddyPoolCredentials({ accessToken: 'a', refreshToken: 'r' })).to.equal(undefined);
        expect(workBuddyPoolCredentials({ accessToken: 'a', refreshToken: 'r', domain: 'www.codebuddy.cn' })!.region)
            .to.equal('cn');
    });

    it('keys Kimi accounts by the token claims', () => {
        expect(kimiPoolIdentityKey(kimiPoolCredentials({
            accessToken: 'a', refreshToken: 'r', expiresIn: 3600, userId: 'u1',
        })!)).to.equal('user:u1');
        expect(kimiPoolIdentityKey(kimiPoolCredentials({
            accessToken: 'a', refreshToken: 'r', expiresIn: 3600, email: 'A@B',
        })!)).to.equal('email:a@b');
    });

    it('keys Codex accounts by the account id the claims name', () => {
        expect(codexPoolIdentityKey(codexPoolCredentials({
            accessToken: 'a', refreshToken: 'r', accountId: 'acct-1',
        })!)).to.equal('account:acct-1');
        // Without an account id there is nothing stable to key on.
        expect(codexPoolIdentityKey(codexPoolCredentials({ accessToken: 'a', refreshToken: 'r' })!))
            .to.equal(undefined);
    });

    // Command Code uses a static API key: it must parse, have no expiry, and
    // still carry identity so several keys can coexist.
    it('parses a static Command Code key without inventing an expiry', () => {
        const parsed = commandCodePoolCredentials({ apiKey: 'sk-1', userId: 'u1', userName: 'me' })!;
        expect(parsed.accessToken).to.equal('sk-1');
        expect(parsed.expiresAt).to.equal(undefined);
        expect(commandCodePoolIdentityKey(parsed)).to.equal('user:u1');
        expect(commandCodePoolCredentials({})).to.equal(undefined);
    });

    // 5xx and transport failures say nothing about the credential, so they must
    // not cost an account its place in the pool.
    it('classifies only authentication failures as a credential verdict', () => {
        for (const status of [400, 401, 403]) {
            expect(subscriptionRefreshFailureStatus(Object.assign(new Error('x'), { status })))
                .to.equal('invalid_credential');
        }
        for (const status of [500, 502, 503, 429]) {
            expect(subscriptionRefreshFailureStatus(Object.assign(new Error('x'), { status }))).to.equal(undefined);
        }
        expect(subscriptionRefreshFailureStatus(new Error('fetch failed'))).to.equal(undefined);
        // A wrapped status is read too.
        expect(oauthRefreshFailureStatus({ cause: { status: 401 } })).to.equal('invalid_credential');
    });
});

describe('Subscription pool registry', () => {
    it('reports no pool for a line that declares none', async () => {
        const registry = new SubscriptionPoolRegistry(() => undefined);
        expect(registry.has('openai')).to.equal(false);
        expect(registry.pool('openai')).to.equal(undefined);
        expect(await registry.select('openai')).to.equal(undefined);
        expect(await registry.listAccounts('openai')).to.deep.equal([]);
    });

    it('creates one pool per provider lazily and reuses it', () => {
        let built = 0;
        const registry = new SubscriptionPoolRegistry(providerId => {
            if (providerId !== 'line-a') return undefined;
            return { spec: testSpec(), ports: { store: memoryStore().store } };
        });
        built += registry.pool('line-a') === undefined ? 0 : 1;
        const first = registry.pool('line-a');
        const second = registry.pool('line-a');
        expect(built).to.equal(1);
        expect(first).to.equal(second);
    });

    // A second account must actually be reachable, or the pool is decoration.
    it('selects a different account when the first is excluded', async () => {
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: testSpec(),
            ports: { store: memoryStore().store },
        }));
        const pool = registry.pool('line-a')!;
        await pool.addAccount(cred({ email: 'a@x', accessToken: 'A' }));
        await pool.addAccount(cred({ email: 'b@x', accessToken: 'B' }));
        const first = await registry.select('line-a');
        expect(first).to.not.equal(undefined);
        const second = await registry.select('line-a', new Set([first!.accountId]));
        expect(second!.accountId).to.not.equal(first!.accountId);
    });

    // A 429 cools the answering account, and the next selection avoids it.
    it('cools a rate-limited account and routes around it', async () => {
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: testSpec(),
            ports: { store: memoryStore().store },
        }));
        const pool = registry.pool('line-a')!;
        const first = await pool.addAccount(cred({ email: 'a@x' }));
        await pool.addAccount(cred({ email: 'b@x' }));
        await registry.noteRateLimited('line-a', first.id);
        const next = await registry.select('line-a');
        expect(next!.accountId).to.not.equal(first.id);
    });

    it('parks an account after an auth failure but keeps its row', async () => {
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: testSpec(),
            ports: { store: memoryStore().store },
        }));
        const pool = registry.pool('line-a')!;
        const first = await pool.addAccount(cred({ email: 'a@x' }));
        await pool.addAccount(cred({ email: 'b@x' }));
        await registry.noteAuthFailure('line-a', first.id, 'revoked');
        const accounts = await registry.listAccounts('line-a');
        expect(accounts).to.have.length(2);
        expect(accounts.find(a => a.id === first.id)!.authStatus).to.equal('invalid_credential');
        expect((await registry.select('line-a'))!.accountId).to.not.equal(first.id);
    });

    // Seeding is how a desktop sign-in joins scheduling; it must be idempotent
    // or every selection would add another copy of the same account.
    it('seeds a line own accounts once and idempotently', async () => {
        let seeds = 0;
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: testSpec(),
            ports: { store: memoryStore().store },
            seed: async () => {
                seeds += 1;
                return [cred({ email: 'desk@x', accessToken: 'DESK' })];
            },
        }));
        await registry.select('line-a');
        await registry.select('line-a');
        const accounts = await registry.listAccounts('line-a');
        expect(accounts).to.have.length(1);
        expect(accounts[0]!.alias).to.equal('desk@x');
    });

    it('switches strategy and primary through the registry', async () => {
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: testSpec(),
            ports: { store: memoryStore().store },
        }));
        const pool = registry.pool('line-a')!;
        await pool.addAccount(cred({ email: 'a@x' }));
        const second = await pool.addAccount(cred({ email: 'b@x' }));
        await registry.setStrategy('line-a', 'sticky');
        expect(await registry.strategy('line-a')).to.equal('sticky');
        await registry.setPrimary('line-a', second.id);
        const primary = (await registry.listAccounts('line-a')).find(a => a.isPrimary);
        expect(primary!.id).to.equal(second.id);
    });

    it('never exposes credential material in a pool summary', async () => {
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: testSpec(),
            ports: { store: memoryStore().store },
        }));
        const pool = registry.pool('line-a')!;
        await pool.addAccount(cred({ email: 'a@x', accessToken: 'SECRET-TOKEN', refreshToken: 'SECRET-REFRESH' }));
        const summary = JSON.stringify(await registry.listAccounts('line-a'));
        expect(summary).to.not.contain('SECRET-TOKEN');
        expect(summary).to.not.contain('SECRET-REFRESH');
    });
});
