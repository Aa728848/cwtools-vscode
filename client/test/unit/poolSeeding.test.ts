import { expect } from 'chai';
import { SubscriptionPoolRegistry } from '../../extension/ai/pool/poolRegistry';
import {
    type OAuthPoolSpec,
    type PooledOAuthCredentials,
} from '../../extension/ai/pool/oauthAccountPool';

interface Cred extends PooledOAuthCredentials { email?: string; source?: string }

function spec(): OAuthPoolSpec<Cred> {
    return {
        displayName: 'Test',
        parseCredentials: value => {
            if (typeof value !== 'object' || value === null) return undefined;
            const record = value as Record<string, unknown>;
            if (typeof record.accessToken !== 'string' || typeof record.refreshToken !== 'string') return undefined;
            return {
                accessToken: record.accessToken,
                refreshToken: record.refreshToken,
                ...(typeof record.email === 'string' ? { email: record.email } : {}),
            };
        },
        identityKey: credentials => credentials.email,
        defaultAlias: (credentials, position) => credentials.email ?? ('Account ' + position),
    };
}

/** A store that really persists; a no-op write would make every pool read empty. */
function memoryStore() {
    const box: { value?: unknown } = {};
    return {
        async read() { return box.value; },
        async write(value: unknown) { box.value = value; },
    };
}
describe('Pool seeding covers every credential source', () => {
    // A pool seeded only from desktop files leaves a plugin-managed sign-in out
    // entirely: the card shows the account while the pool reads empty, so the
    // account is never scheduled and the pool section hides itself.
    it('schedules an account that only the managed store holds', async () => {
        const managedOnly: Cred = { accessToken: 'managed-token', refreshToken: 'r', email: 'me@example.test' };
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: spec(),
            ports: { store: memoryStore() },
            // The managed store is the only source here; the desktop scan finds nothing.
            seed: async () => [managedOnly],
        }));
        const selected = await registry.select('line-a');
        expect(selected).to.not.equal(undefined);
        expect(selected!.credentials.accessToken).to.equal('managed-token');
        // The card's view is non-empty, which is what makes the section render.
        const accounts = await registry.listAccounts('line-a');
        expect(accounts).to.have.length(1);
        expect(accounts[0]!.alias).to.equal('me@example.test');
    });

    it('merges desktop and managed sources into one pool without duplicates', async () => {
        const both: Cred[] = [
            { accessToken: 'desktop', refreshToken: 'r', email: 'desk@example.test' },
            { accessToken: 'managed', refreshToken: 'r', email: 'mine@example.test' },
        ];
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: spec(),
            ports: { store: memoryStore() },
            seed: async () => both,
        }));
        await registry.select('line-a');
        await registry.select('line-a');
        const accounts = await registry.listAccounts('line-a');
        expect(accounts).to.have.length(2);
        // Seeding twice must not duplicate rows.
        expect(new Set(accounts.map(a => a.alias)).size).to.equal(2);
    });

    // A repeat sign-in of the same account is a re-authorization, not a new row.
    it('updates a seeded account in place when the same identity signs in again', async () => {
        let current: Cred = { accessToken: 'first', refreshToken: 'r', email: 'me@example.test' };
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: spec(),
            ports: { store: memoryStore() },
            seed: async () => [current],
        }));
        await registry.select('line-a');
        current = { accessToken: 'second', refreshToken: 'r2', email: 'me@example.test' };
        await registry.addAccount('line-a', current);
        const accounts = await registry.listAccounts('line-a');
        expect(accounts).to.have.length(1);
        expect(accounts[0]!.alias).to.equal('me@example.test');
    });
});