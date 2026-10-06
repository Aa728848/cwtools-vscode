import { expect } from 'chai';
import {
    minimaxCodePoolCredentials,
    minimaxCodePoolIdentityKey,
} from '../../extension/ai/pool/subscriptionPools';

describe('MiniMax Code pool identity', () => {
    // The exact shape MinimaxCodeCredentialStore.save() persists. It carries no
    // recordKey, so before the fix it had NO identity key at all: addAccount could
    // not match it against its own seeded row, and one sign-in produced two accounts.
    it('gives a plugin-managed credential a stable identity', () => {
        const saved = { accessToken: 'm', refreshToken: 'r', expiresAt: 0, region: 'cn' };
        const parsed = minimaxCodePoolCredentials(saved);
        const key = minimaxCodePoolIdentityKey(parsed!);
        expect(key).to.equal('managed:cn');
        // Same account re-signed in: the key must not move.
        expect(minimaxCodePoolIdentityKey(minimaxCodePoolCredentials({ ...saved, accessToken: 'm2' })!))
            .to.equal(key);
    });

    // The same record slot in two regions is two different accounts.
    it('separates regions', () => {
        const cn = minimaxCodePoolIdentityKey(minimaxCodePoolCredentials({ accessToken: 'a', refreshToken: 'r', region: 'cn' })!);
        const global = minimaxCodePoolIdentityKey(minimaxCodePoolCredentials({ accessToken: 'a', refreshToken: 'r', region: 'global' })!);
        expect(cn).to.not.equal(global);
    });

    // A desktop credential keeps its record-slot identity, which is what merges
    // repeated desktop logins in place.
    it('prefers the desktop record slot', () => {
        const key = minimaxCodePoolIdentityKey(minimaxCodePoolCredentials({
            accessToken: 'd', refreshToken: 'r', region: 'cn', recordKey: 'prod/cn/mcode-public',
        })!);
        expect(key).to.equal('record:prod/cn/mcode-public');
    });
});
