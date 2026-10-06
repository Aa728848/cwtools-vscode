import { expect } from 'chai';
import { AccountPoolCore } from '../../extension/ai/pool/accountPool';
import { OAuthAccountPool, type OAuthPoolSpec, type PooledOAuthCredentials } from '../../extension/ai/pool/oauthAccountPool';

interface Cred extends PooledOAuthCredentials { region: string }

const spec = (): OAuthPoolSpec<Cred> => ({
    displayName: 'Line',
    parseCredentials: value => {
        if (typeof value !== 'object' || value === null) return undefined;
        const record = value as Record<string, unknown>;
        if (typeof record.accessToken !== 'string' || typeof record.refreshToken !== 'string') return undefined;
        return { accessToken: record.accessToken, refreshToken: record.refreshToken, region: String(record.region ?? 'cn') };
    },
    identityKey: c => 'managed:' + c.region,
    defaultAlias: (_c, position) => 'Account ' + position,
});

function store(initial?: unknown) {
    const box: { value: unknown } = { value: initial };
    return {
        async read() { return box.value; },
        async write(value: unknown) { box.value = value; },
        peek() { return box.value; },
    };
}

describe('Account pool holds one row per account', () => {
    // A document written before the identity key existed carries two rows for the
    // same single account. Reading must collapse them, otherwise the user keeps
    // seeing a duplicate they never created.
    it('collapses rows that share an identity key', async () => {
        const pool = new OAuthAccountPool<Cred>(spec(), {
            store: store({
                version: 1, rotationStrategy: 'sequential',
                accounts: [
                    { id: 'a1', alias: 'Account 1', credentials: { accessToken: 't1', refreshToken: 'r', region: 'cn' }, addedAt: 1, isPrimary: true },
                    { id: 'a2', alias: 'Account 2', credentials: { accessToken: 't2', refreshToken: 'r', region: 'cn' }, addedAt: 2 },
                ],
            }),
        });
        const accounts = await pool.listAccounts();
        expect(accounts).to.have.length(1);
        // The surviving row keeps the primary marker rather than losing it.
        expect(accounts[0]!.isPrimary).to.equal(true);
    });

    // Two genuinely different accounts must both survive.
    it('keeps distinct accounts apart', async () => {
        const pool = new OAuthAccountPool<Cred>(spec(), {
            store: store({
                version: 1, rotationStrategy: 'sequential',
                accounts: [
                    { id: 'a1', alias: 'CN', credentials: { accessToken: 't1', refreshToken: 'r', region: 'cn' }, addedAt: 1 },
                    { id: 'a2', alias: 'Global', credentials: { accessToken: 't2', refreshToken: 'r', region: 'global' }, addedAt: 2 },
                ],
            }),
        });
        expect(await pool.listAccounts()).to.have.length(2);
    });

    // The repair has to reach storage, otherwise it reappears on the next reload.
    it('persists the collapsed document', async () => {
        const backing = store({
            version: 1, rotationStrategy: 'sequential',
            accounts: [
                { id: 'a1', alias: 'A', credentials: { accessToken: 't1', refreshToken: 'r', region: 'cn' }, addedAt: 1 },
                { id: 'a2', alias: 'B', credentials: { accessToken: 't2', refreshToken: 'r', region: 'cn' }, addedAt: 2 },
            ],
        });
        const pool = new OAuthAccountPool<Cred>(spec(), { store: backing });
        await pool.setStrategy('sticky');
        const written = backing.peek() as { accounts: unknown[] };
        expect(written.accounts).to.have.length(1);
    });

    // Sticky routing remembers the last account; losing it would silently reset
    // the strategy's choice.
    it('drops a sticky pointer to a collapsed row', async () => {
        const backing = store({
            version: 1, rotationStrategy: 'sticky', activeAccountId: 'a2',
            accounts: [
                { id: 'a1', alias: 'A', credentials: { accessToken: 't1', refreshToken: 'r', region: 'cn' }, addedAt: 1 },
                { id: 'a2', alias: 'B', credentials: { accessToken: 't2', refreshToken: 'r', region: 'cn' }, addedAt: 2 },
            ],
        });
        const pool = new OAuthAccountPool<Cred>(spec(), { store: backing });
        await pool.recordUsage('a2');
        const written = backing.peek() as { activeAccountId?: string; accounts: unknown[] };
        expect(written.accounts).to.have.length(1);
        expect(written.activeAccountId).to.equal(undefined);
    });

    // A row with no identity key cannot be proven to be a duplicate; dropping it
    // would cost the user an account that is still valid.
    it('never drops a row that has no identity key', async () => {
        const core = new AccountPoolCore<any, any>(store({ any: 'document' }) as never, {
            providerId: 'p', displayName: 'p',
            parsePoolData: () => ({
                version: 1 as const, rotationStrategy: 'sequential' as const,
                accounts: [
                    { id: 'x1', alias: 'X', credentials: { accessToken: 'a' }, addedAt: 1 },
                    { id: 'x2', alias: 'Y', credentials: { accessToken: 'b' }, addedAt: 2 },
                ],
            }),
            createAccount: (i: any) => ({ id: i.id, alias: i.alias, credentials: i.credentials, addedAt: i.addedAt, isPrimary: i.isPrimary }),
            defaultAlias: (_c: any, position: number) => 'Account ' + position,
        } as never);
        expect((await core.read()).accounts).to.have.length(2);
    });
});
