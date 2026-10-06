import { expect } from 'chai';
import { SubscriptionPoolRegistry } from '../../extension/ai/pool/poolRegistry';
import {
    type OAuthPoolSpec,
    type PooledOAuthCredentials,
} from '../../extension/ai/pool/oauthAccountPool';

interface Cred extends PooledOAuthCredentials { email?: string }

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

/** One shared slot, the way two provider ids over one credential key really behave. */
function sharedSlot() {
    const box: { value?: unknown } = {};
    return {
        async read() { return box.value; },
        async write(value: unknown) { box.value = value; },
    };
}

describe('Subscription pool registry multiplexes provider ids', () => {
    // Two provider ids that read and write ONE credential slot must share the pool
    // instance. Two instances each hold a private copy of the document, so the
    // later write silently drops the account the other line just added.
    it('shares a single pool between aliased provider ids over one store', async () => {
        const slot = sharedSlot();
        const registry = new SubscriptionPoolRegistry(providerId => ({
            spec: spec(),
            poolId: 'canonical-line',
            ports: { store: slot },
            // Both ids resolve to the same entry; the alias is only a label.
            ...(providerId === 'canonical-line' ? {} : {}),
        }), ['line-a', 'line-b', 'canonical-line']);

        await registry.addAccount('line-a', { accessToken: 'a', refreshToken: 'r' });
        await registry.addAccount('line-b', { accessToken: 'b', refreshToken: 'r' });

        // Each line sees both accounts, because there is only one pool.
        const fromA = await registry.listAccounts('line-a');
        const fromB = await registry.listAccounts('line-b');
        expect(fromA).to.have.length(2);
        expect(fromB).to.have.length(2);
        expect(registry.pool('line-a')).to.equal(registry.pool('line-b'));
    });

    // Lines that do NOT declare a shared id keep separate pools: a WorkBuddy
    // account must never be selectable for MiniMax Code.
    it('keeps unrelated lines in separate pools', async () => {
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: spec(),
            ports: { store: sharedSlot() },
        }), ['line-a', 'line-b']);

        await registry.addAccount('line-a', { accessToken: 'a', refreshToken: 'r' });
        expect(await registry.listAccounts('line-a')).to.have.length(1);
        expect(await registry.listAccounts('line-b')).to.have.length(0);
        expect(registry.pool('line-a')).to.not.equal(registry.pool('line-b'));
    });

    // The settings page builds one view per line from this list, so it must
    // enumerate exactly the lines that own a pool.
    it('enumerates the provider ids it covers', () => {
        const registry = new SubscriptionPoolRegistry(() => undefined, ['a', 'b']);
        expect([...registry.providerIds()]).to.deep.equal(['a', 'b']);
    });

    // Seeding is recorded per canonical pool, so an aliased id does not re-run the
    // desktop scan a second time and duplicate rows.
    it('seeds an aliased line only once', async () => {
        const slot = sharedSlot();
        let scans = 0;
        const registry = new SubscriptionPoolRegistry(() => ({
            spec: spec(),
            poolId: 'canonical-line',
            ports: { store: slot },
            seed: async () => {
                scans += 1;
                return [{ accessToken: 't' + scans, refreshToken: 'r', email: 'me@example.test' }];
            },
        }), ['line-a', 'line-b']);

        await registry.listAccounts('line-a');
        await registry.listAccounts('line-b');
        expect(scans).to.equal(1);
        expect(await registry.listAccounts('line-b')).to.have.length(1);
    });
});
