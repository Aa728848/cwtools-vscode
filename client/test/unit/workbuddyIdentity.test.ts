import { expect } from 'chai';
import {
    decodeAccessTokenClaims,
    identityFromClaims,
    withResolvedIdentity,
} from '../../extension/ai/workbuddy/identity';
import type { WorkBuddyCredentials } from '../../extension/ai/workbuddy/credentials';

/** An UNSIGNED token: this module only reads claims, it never grants anything. */
function token(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return 'header.' + payload + '.signature';
}

function credential(overrides: Partial<WorkBuddyCredentials> = {}): WorkBuddyCredentials {
    return {
        accessToken: token({ sub: 'uid-from-token' }),
        refreshToken: 'r',
        expiresAt: 0,
        domain: 'copilot.tencent.com',
        backend: 'https://copilot.tencent.com',
        region: 'cn',
        source: 'managed',
        sourceFile: '',
        sourceMtimeMs: 0,
        ...overrides,
    };
}

describe('WorkBuddy identity from the access token', () => {
    // The account endpoint is a best-effort request; when it fails the credential has
    // no uid and the key falls back to a display name, so the same account gets stored
    // twice. The token always names it.
    it('takes the uid from the token sub claim', () => {
        const claims = decodeAccessTokenClaims(token({ sub: 'abc-123' }));
        expect(identityFromClaims(claims!).uid).to.equal('abc-123');
        expect(withResolvedIdentity(credential({ accessToken: token({ sub: 'abc-123' }) })).uid)
            .to.equal('abc-123');
    });

    // The international deployment omits `nickname` and states the account in
    // `preferred_username`, which is what the IDE records as the file's nickname.
    it('reads the nickname in the order the two deployments fill it', () => {
        expect(identityFromClaims({ preferred_username: 'intl-name' }).nickname).to.equal('intl-name');
        expect(identityFromClaims({ nickname: 'cn-name' }).nickname).to.equal('cn-name');
        expect(identityFromClaims({ nickname: 'cn', preferred_username: 'intl' }).nickname).to.equal('cn');
    });

    // A stored uid that disagrees with the token can only have come from the login path
    // that promoted a display name; the displaced value is kept so the row still reads
    // as something a person recognises.
    it('heals a stored uid that disagrees with the token', () => {
        const healed = withResolvedIdentity(credential({ uid: 'stale-name' }));
        expect(healed.uid).to.equal('uid-from-token');
        expect(healed.nickname).to.equal('stale-name');
    });

    // What the IDE file or the login response already recorded is not second-guessed.
    it('never overwrites an identity the credential already states', () => {
        const kept = withResolvedIdentity(credential({
            accessToken: token({ sub: 'token-uid' }),
            nickname: 'file-name',
            uin: '10001',
        }));
        expect(kept.nickname).to.equal('file-name');
        expect(kept.uin).to.equal('10001');
    });

    // A non-JWT access token is a legitimate shape on this route, so it must not throw.
    it('accepts an opaque token without failing', () => {
        expect(decodeAccessTokenClaims('opaque-token')).to.equal(null);
        expect(withResolvedIdentity(credential({ accessToken: 'opaque-token' })).uid).to.equal(undefined);
    });
});
