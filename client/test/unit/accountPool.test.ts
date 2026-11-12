import { expect } from 'chai';
import {
    AccountPoolCore,
    DEFAULT_MAX_POOL_ACCOUNTS,
    MIN_COOLDOWN_MS,
    normalizeRotationStrategy,
    type AccountPoolStore,
    type PoolAccountShape,
} from '../../extension/ai/pool/accountPool';

/** In-memory pool storage for the kernel-level tests. */
function memoryStore(): AccountPoolStore & { value?: unknown } {
    const box: AccountPoolStore & { value?: unknown } = {
        value: undefined,
        // Both methods return a Thenable, matching VS Code's SecretStorage: the
        // pool's port is deliberately wider than Promise so the real store fits.
        async read() { return box.value; },
        async write(next: unknown) { box.value = next; },
    };
    return box;
}

interface TestCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    email?: string;
}

interface TestAccount extends PoolAccountShape<TestCredentials> { tag?: string }

function testPool(store: AccountPoolStore, extra: {
    refresh?: (credentials: TestCredentials) => Promise<TestCredentials>;
    refreshFailureStatus?: (error: unknown) => 'invalid_credential' | 'rate_limited' | undefined;
    legacy?: () => Promise<TestCredentials | null>;
    maxAccounts?: number;
} = {}) {
    return new AccountPoolCore<TestCredentials, TestAccount>(store, {
        providerId: 'test',
        displayName: 'Test',
        parsePoolData: value => {
            const raw = typeof value === 'string' ? JSON.parse(value) : value;
            const record = raw as Record<string, unknown>;
            return {
                version: 1 as const,
                rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
                accounts: (Array.isArray(record.accounts) ? record.accounts : []) as TestAccount[],
                ...(typeof record.activeAccountId === 'string' ? { activeAccountId: record.activeAccountId } : {}),
            };
        },
        createAccount: input => ({
            id: input.id, alias: input.alias, credentials: input.credentials,
            addedAt: input.addedAt, isPrimary: input.isPrimary,
        }),
        dedupeKey: credentials => credentials.email,
        defaultAlias: (credentials, position) => credentials.email ?? ('Account ' + position),
        expiresAt: credentials => credentials.expiresAt,
        needsRefresh: (credentials, now) => credentials.expiresAt <= now,
        ...(extra.refresh === undefined ? {} : { refresh: credentials => extra.refresh!(credentials) }),
        ...(extra.refreshFailureStatus === undefined ? {} : { refreshFailureStatus: extra.refreshFailureStatus }),
        // The kernel's hook returns an account, not bare credentials; a provider
        // an adapter wraps them for a concrete provider.
        ...(extra.legacy === undefined ? {} : {
            legacyAccount: async () => {
                const credentials = await extra.legacy!();
                if (credentials === null) return null;
                return {
                    id: 'legacy-primary', alias: credentials.email ?? 'Account 1',
                    credentials, addedAt: Date.now(), isPrimary: true,
                };
            },
        }),
    }, { maxAccounts: extra.maxAccounts ?? DEFAULT_MAX_POOL_ACCOUNTS });
}

const cred = (over: Partial<TestCredentials> = {}): TestCredentials => ({
    accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...over,
});

describe('Account pool: identity and storage', () => {
    // A repeat sign-in re-authorizes the same row; producing a second one is how
    // a pool ends up with ghost accounts.
    it('updates an existing account in place when its dedupe key repeats', async () => {
        const store = memoryStore();
        const pool = testPool(store);
        const first = await pool.addAccount(cred({ email: 'me@example.test', accessToken: 'one' }));
        const again = await pool.addAccount(cred({ email: 'me@example.test', accessToken: 'two' }));
        expect(again.id).to.equal(first.id);
        const accounts = await pool.listAccounts();
        expect(accounts).to.have.length(1);
        expect((await pool.read()).accounts[0]!.credentials.accessToken).to.equal('two');
    });

    it('makes the first account primary and refuses to exceed the cap', async () => {
        const store = memoryStore();
        const pool = testPool(store, { maxAccounts: 2 });
        expect((await pool.addAccount(cred({ email: 'a@x' }))).isPrimary).to.equal(true);
        expect((await pool.addAccount(cred({ email: 'b@x' }))).isPrimary).to.equal(false);
        let failed = false;
        try { await pool.addAccount(cred({ email: 'c@x' })); } catch { failed = true; }
        expect(failed).to.equal(true);
        expect(await pool.listAccounts()).to.have.length(2);
    });

    it('promotes a new primary when the primary is removed', async () => {
        const store = memoryStore();
        const pool = testPool(store);
        const primary = await pool.addAccount(cred({ email: 'a@x' }));
        await pool.addAccount(cred({ email: 'b@x' }));
        await pool.removeAccount(primary.id);
        const accounts = await pool.listAccounts();
        expect(accounts).to.have.length(1);
        expect(accounts[0]!.isPrimary).to.equal(true);
    });

    it('treats a corrupt document as an empty pool rather than throwing', async () => {
        const store = memoryStore();
        store.value = '{not json';
        const pool = testPool(store);
        expect(await pool.listAccounts()).to.deep.equal([]);
    });

    // An upgrade must not look like "everything is gone": the pre-pool single
    // credential is projected as the primary account on read.
    it('projects the legacy single credential as the primary account', async () => {
        const pool = testPool(memoryStore(), { legacy: async () => cred({ accessToken: 'legacy' }) });
        const accounts = await pool.listAccounts();
        expect(accounts).to.have.length(1);
        expect(accounts[0]!.isPrimary).to.equal(true);
        expect((await pool.read()).accounts[0]!.credentials.accessToken).to.equal('legacy');
    });
});

describe('Account pool: rotation strategies', () => {
    async function threeAccountPool() {
        const pool = testPool(memoryStore());
        const a = await pool.addAccount(cred({ email: 'a@x' }), 'A');
        const b = await pool.addAccount(cred({ email: 'b@x' }), 'B');
        const c = await pool.addAccount(cred({ email: 'c@x' }), 'C');
        return { pool, a, b, c };
    }

    it('sequential preferers the primary account', async () => {
        const { pool, a } = await threeAccountPool();
        expect((await pool.getEffectiveAccount()).account.id).to.equal(a.id);
    });

    // Least recently used first, so a burst spreads over the whole pool.
    it('round-robin hands out the least recently used account', async () => {
        const { pool, a, b, c } = await threeAccountPool();
        await pool.setStrategy('round-robin');
        const first = (await pool.getEffectiveAccount()).account.id;
        await pool.recordUsage(first, 1000);
        const second = (await pool.getEffectiveAccount()).account.id;
        expect(second).to.not.equal(first);
        await pool.recordUsage(second, 2000);
        const third = (await pool.getEffectiveAccount()).account.id;
        expect([a.id, b.id, c.id]).to.include(third);
        expect(new Set([first, second, third]).size).to.equal(3);
    });

    // Sticky keeps the account that served the previous request: changing it
    // every turn would invalidate the upstream prefix cache.
    it('sticky keeps the last used account while it is eligible', async () => {
        const { pool, b } = await threeAccountPool();
        await pool.setStrategy('sticky');
        await pool.recordUsage(b.id);
        expect((await pool.getEffectiveAccount()).account.id).to.equal(b.id);
        expect((await pool.getEffectiveAccount()).account.id).to.equal(b.id);
    });

    // A cooling account must never be chosen: the strategy expresses a
    // preference, not a licence to bypass eligibility.
    it('never selects a cooling account', async () => {
        const { pool, a, b } = await threeAccountPool();
        await pool.markCooldown(a.id, MIN_COOLDOWN_MS, '429');
        expect((await pool.getEffectiveAccount()).account.id).to.equal(b.id);
    });

    it('excludes accounts a caller has already tried', async () => {
        const { pool, a, b } = await threeAccountPool();
        const tried = new Set([a.id]);
        expect((await pool.getEffectiveAccount(tried)).account.id).to.equal(b.id);
    });
});

describe('Account pool: cooldown and credential failure', () => {
    it('reports an expired cooldown as absent', async () => {
        const pool = testPool(memoryStore());
        const account = await pool.addAccount(cred({ email: 'a@x' }));
        await pool.markCooldown(account.id, MIN_COOLDOWN_MS, '429');
        expect((await pool.listAccounts())[0]!.cooldownUntil).to.be.a('number');
        // A cooldown that has already lifted is not reported as active.
        const later = Date.now() + MIN_COOLDOWN_MS + 1000;
        expect((await pool.listAccounts(later))[0]!.cooldownUntil).to.equal(undefined);
    });

    it('clamps a cooldown to the minimum duration', async () => {
        const pool = testPool(memoryStore());
        const account = await pool.addAccount(cred({ email: 'a@x' }));
        await pool.markCooldown(account.id, 1, '429');
        const until = (await pool.listAccounts())[0]!.cooldownUntil!;
        expect(until - Date.now()).to.be.greaterThan(MIN_COOLDOWN_MS - 5000);
    });

    // A 429 failover must not remove the account: the cooldown lifts.
    it('keeps a cooled account in the pool', async () => {
        const pool = testPool(memoryStore());
        const account = await pool.addAccount(cred({ email: 'a@x' }));
        await pool.markCooldown(account.id, MIN_COOLDOWN_MS, '429');
        expect(await pool.listAccounts()).to.have.length(1);
        await pool.clearCooldown(account.id);
        await pool.getEffectiveAccount();
    });

    // A revoked credential parks the row instead of deleting it: re-signing in
    // restores it, and deleting would cost the user a still-valid plan.
    it('parks an account after an auth failure but keeps its row', async () => {
        const store = memoryStore();
        const pool = testPool(store);
        const first = await pool.addAccount(cred({ email: 'a@x' }));
        const second = await pool.addAccount(cred({ email: 'b@x' }));
        await pool.noteAuthFailure(first.id, 'invalid_credential', 'revoked');
        expect(await pool.listAccounts()).to.have.length(2);
        expect((await pool.getEffectiveAccount()).account.id).to.equal(second.id);
        await pool.clearAuthFailure(first.id);
        // Clearing restores it, and the primary is preferred again.
        expect((await pool.getEffectiveAccount()).account.id).to.equal(first.id);
    });

    it('raises a rate-limit error naming the shortest wait', async () => {
        const pool = testPool(memoryStore());
        const account = await pool.addAccount(cred({ email: 'a@x' }));
        await pool.markCooldown(account.id, 120_000, '429');
        try {
            await pool.getEffectiveAccount();
            throw new Error('expected a rejection');
        } catch (error) {
            expect((error as { status?: number }).status).to.equal(429);
            expect((error as Error).message).to.match(/cooling down|rate limited/i);
        }
    });
});

describe('Account pool: refresh behaviour', () => {
    it('refreshes a credential that is about to expire and persists it', async () => {
        const store = memoryStore();
        const pool = testPool(store, { refresh: async credentials => ({ ...credentials, accessToken: 'fresh' }) });
        await pool.addAccount(cred({ email: 'a@x', accessToken: 'stale', expiresAt: Date.now() - 1 }));
        expect((await pool.getEffectiveAccount()).credentials.accessToken).to.equal('fresh');
        expect((await pool.read()).accounts[0]!.credentials.accessToken).to.equal('fresh');
    });

    // Upstream retires a rotated token, so concurrent callers must share one
    // rotation; otherwise all but the first are rejected and the account looks
    // revoked after a single burst.
    it('single-flights concurrent refreshes of the same account', async () => {
        const store = memoryStore();
        let refreshes = 0;
        const pool = testPool(store, {
            refresh: async credentials => {
                refreshes += 1;
                await new Promise(resolve => setTimeout(resolve, 5));
                return { ...credentials, accessToken: 'fresh', expiresAt: Date.now() + 3600_000 };
            },
        });
        await pool.addAccount(cred({ email: 'a@x', expiresAt: Date.now() - 1 }));
        const results = await Promise.all([
            pool.getEffectiveAccount(), pool.getEffectiveAccount(), pool.getEffectiveAccount(),
        ]);
        expect(refreshes).to.equal(1);
        expect(results.map(entry => entry.credentials.accessToken)).to.deep.equal(['fresh', 'fresh', 'fresh']);
    });

    it('does not refresh a credential that is comfortably valid', async () => {
        let refreshes = 0;
        const pool = testPool(memoryStore(), {
            refresh: async credentials => { refreshes += 1; return credentials; },
        });
        await pool.addAccount(cred({ email: 'a@x' }));
        await pool.getEffectiveAccount();
        expect(refreshes).to.equal(0);
    });

    // A transient failure must not cost the account its place; only a classified
    // credential failure parks it.
    it('lets a transient refresh failure surface unchanged', async () => {
        const pool = testPool(memoryStore(), {
            refresh: async () => { throw new Error('network down'); },
            // No classifier: the error is not a verdict on the credential.
        });
        await pool.addAccount(cred({ email: 'a@x', expiresAt: Date.now() - 1 }));
        let message = '';
        try { await pool.getEffectiveAccount(); } catch (error) { message = (error as Error).message; }
        expect(message).to.contain('network down');
        expect((await pool.listAccounts())[0]!.authStatus).to.equal(undefined);
    });

    it('parks the account when the classifier calls the credential dead', async () => {
        const pool = testPool(memoryStore(), {
            refresh: async () => { throw new Error('revoked'); },
            // A classifier turns the failure into a verdict on the credential.
            refreshFailureStatus: () => 'invalid_credential',
        });
        await pool.addAccount(cred({ email: 'a@x', expiresAt: Date.now() - 1 }));
        let message = '';
        try { await pool.getEffectiveAccount(); } catch (error) { message = (error as Error).message; }
        expect(message).to.match(/cooling down|no account|rate limited/i);
        const summary = (await pool.listAccounts())[0]!;
        expect(summary.authStatus).to.equal('invalid_credential');
    });
});

describe('Account pool: summary safety', () => {
    // The card must never be able to leak a credential.
    it('never puts credential material in a summary', async () => {
        const pool = testPool(memoryStore());
        await pool.addAccount(cred({ email: 'me@example.test', accessToken: 'SECRET-TOKEN', refreshToken: 'SECRET-REFRESH' }));
        const summary = JSON.stringify(await pool.listAccounts());
        expect(summary).to.not.contain('SECRET-TOKEN');
        expect(summary).to.not.contain('SECRET-REFRESH');
    });
});
