import { expect } from 'chai';
import {
    CLAUDE_ANTHROPIC_VERSION,
    CLAUDE_CLI_VERSION,
    CLAUDE_CODE_BETA,
    CLAUDE_CODE_IDENTITY_TEXT,
    CLAUDE_DEFAULT_CALLBACK_PORT,
    CLAUDE_EXTENDED_CACHE_TTL_BETA,
    CLAUDE_INTERLEAVED_THINKING_BETA,
    CLAUDE_MODELS,
    CLAUDE_OAUTH_BETA,
    CLAUDE_OAUTH_CLIENT_ID,
    CLAUDE_THINKING_BINDING_CONTROLS_BETA,
    claudeCacheControlFor,
    claudeCliVersion,
    claudeThinkingFor,
    compareDottedVersions,
    isClaudeCacheTtl,
    meetsClaudeVersionFloor,
    resolveClaudeModel,
} from '../../extension/ai/claudesub/types';
import {
    CLAUDE_SUBSCRIPTION_SECRET_KEY,
    ClaudeSubscriptionCredentialStore,
    ClaudeSubscriptionUnauthorizedError,
    isClaudeSubscriptionCredential,
    isClaudeSubscriptionCredentialFresh,
    parseClaudeScopes,
    parseClaudeSubscriptionCredentials,
} from '../../extension/ai/claudesub/credentials';
import {
    buildClaudeAuthorizeUrl,
    claudeBetas,
    claudeSubscriptionHeaders,
    claudeUserAgent,
    exchangeClaudeAuthorizationCode,
    generateClaudePkce,
    refreshClaudeAccessToken,
    resolveClaudeCallbackPort,
} from '../../extension/ai/claudesub/oauthService';

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

describe('Claude subscription model catalog', () => {
    it('ships the subscription models with their thinking forms', () => {
        expect(CLAUDE_MODELS.map(model => model.id)).to.include.members([
            'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-haiku-4-5',
        ]);
        expect(resolveClaudeModel('claude-opus-5-5').thinkingMode).to.equal('adaptive');
        expect(resolveClaudeModel('claude-sonnet-5-5').thinkingMode).to.equal('mid-convo');
        expect(resolveClaudeModel('claude-fable-5-1').thinkingMode).to.equal('mid-convo');
        expect(resolveClaudeModel('claude-opus-5').thinkingMode).to.equal('mid-convo');
        expect(resolveClaudeModel('claude-haiku-4-5').thinkingMode).to.equal('budget');
    });

    // 'mid-convo' forces effort=high when the caller names none, so it is only
    // correct for models whose documented default IS high.
    it('keeps Opus 5.5 adaptive rather than mid-convo', () => {
        const entry = resolveClaudeModel('claude-opus-5-5');
        expect(entry.thinkingMode).to.equal('adaptive');
        const thinking = claudeThinkingFor(entry, undefined, undefined);
        expect(thinking.outputConfig).to.equal(undefined);
        // Opus 5.5 binds thinking to the prefix, so the adaptive form carries
        // block_binding too: the service validates the prefix a replayed thinking block
        // depends on, and compaction / a tool-list change / an image offload all edit
        // it. Without this the model answers 400 on every retry afterwards.
        expect(thinking.thinking).to.deep.equal({
            type: 'adaptive',
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
        });
    });

    // The identity block and block_binding are both mandatory on mid-convo.
    it('sends block_binding and a forced effort for a mid-convo model', () => {
        const thinking = claudeThinkingFor(resolveClaudeModel('claude-sonnet-5-5'), undefined, undefined);
        expect(thinking.thinking).to.deep.equal({
            type: 'adaptive',
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
        });
        expect(thinking.outputConfig).to.deep.equal({ effort: 'high' });
        expect(claudeThinkingFor(resolveClaudeModel('claude-sonnet-5-5'), 'low', undefined).outputConfig)
            .to.deep.equal({ effort: 'low' });
    });

    // An unknown id must claim as little as possible: overstating a capability
    // is the error that fails hard.
    it('treats an unknown model conservatively', () => {
        const entry = resolveClaudeModel('claude-unreleased-9');
        expect(entry.supportsImage).to.equal(false);
        expect(entry.thinkingMode).to.equal('none');
        expect(entry.reasoningEfforts).to.deep.equal([]);
        expect(entry.contextWindow).to.equal(200_000);
        expect(claudeThinkingFor(entry, 'high', undefined)).to.deep.equal({});
    });

    // The floor is a number upstream stated; a request below it is a hard stop,
    // so it is refused locally instead of as an opaque upstream 400.
    it('records the observed client-version floor and keeps the reported version above it', () => {
        const floors = CLAUDE_MODELS
            .map(model => model.minCliVersion)
            .filter((value): value is string => value !== undefined);
        expect(floors).to.deep.equal(['2.1.280']);
        for (const floor of floors) {
            expect(meetsClaudeVersionFloor(claudeCliVersion(), floor)).to.equal(true);
        }
    });

    it('compares dotted versions totally rather than throwing', () => {
        expect(compareDottedVersions('2.1.285', '2.1.280')).to.be.greaterThan(0);
        expect(compareDottedVersions('2.1', '2.1.0')).to.equal(0);
        // Malformed input compares as zero rather than NaN, so it can never crash.
        expect(compareDottedVersions('abc', '0.0.0')).to.equal(0);
        expect(meetsClaudeVersionFloor('2.1.279', '2.1.280')).to.equal(false);
        // An absent floor never blocks, but a malformed claim does.
        expect(meetsClaudeVersionFloor('2.1.279', undefined)).to.equal(true);
        expect(meetsClaudeVersionFloor('not-a-version', '2.1.280')).to.equal(false);
    });

    it('builds the documented cache markers', () => {
        expect(claudeCacheControlFor('1h')).to.deep.equal({ type: 'ephemeral', ttl: '1h' });
        expect(claudeCacheControlFor('5m')).to.deep.equal({ type: 'ephemeral', ttl: '5m' });
        expect(isClaudeCacheTtl('1h')).to.equal(true);
        expect(isClaudeCacheTtl('2h')).to.equal(false);
    });
});

describe('Claude subscription request identity', () => {
    // A subscription token requires the request to look like Claude Code.
    it('sends the identity headers and never x-api-key', () => {
        const headers = claudeSubscriptionHeaders('token-1', { model: 'claude-opus-5-5' });
        expect(headers.authorization).to.equal('Bearer token-1');
        expect(headers['user-agent']).to.match(/^claude-cli\//);
        expect(headers['x-app']).to.equal('cli');
        expect(headers['anthropic-version']).to.equal(CLAUDE_ANTHROPIC_VERSION);
        expect(headers).to.not.have.property('x-api-key');
    });

    it('includes the required betas and the ones the body needs', () => {
        const base = claudeBetas({ model: 'claude-opus-5-5' });
        expect(base).to.include(CLAUDE_OAUTH_BETA);
        expect(base).to.include(CLAUDE_CODE_BETA);
        // The identity beta is excluded for a haiku model.
        expect(claudeBetas({ model: 'claude-haiku-4-5' })).to.not.include(CLAUDE_CODE_BETA);
        expect(claudeBetas({ thinking: true })).to.include(CLAUDE_INTERLEAVED_THINKING_BETA);
        expect(claudeBetas({ thinkingBinding: true })).to.include(CLAUDE_THINKING_BINDING_CONTROLS_BETA);
        expect(claudeBetas({ cacheTtl: '1h' })).to.include(CLAUDE_EXTENDED_CACHE_TTL_BETA);
        expect(claudeBetas({ cacheTtl: '5m' })).to.not.include(CLAUDE_EXTENDED_CACHE_TTL_BETA);
    });

    // block_binding without its beta is a 400 on every request, so the header is
    // derived from the body that actually carries it.
    it('licenses block_binding exactly when the body carries it', () => {
        const headers = claudeSubscriptionHeaders('t', { thinkingBinding: true });
        expect(headers['anthropic-beta']).to.contain(CLAUDE_THINKING_BINDING_CONTROLS_BETA);
    });

    it('drops an x-api-key a caller tries to add', () => {
        const headers = claudeSubscriptionHeaders('t', { extra: { 'x-api-key': 'sneaky' } });
        expect(headers).to.not.have.property('x-api-key');
    });

    it('reports the cli and code identities', () => {
        expect(claudeUserAgent('cli')).to.equal('claude-cli/' + claudeCliVersion() + ' (external, cli)');
        expect(claudeUserAgent('code')).to.equal('claude-code/' + claudeCliVersion());
    });
});

describe('Claude subscription PKCE and login', () => {
    // Deriving state from the verifier would make the two one secret and put the
    // verifier in the URL.
    it('draws state independently of the verifier', () => {
        const pkce = generateClaudePkce();
        expect(pkce.state).to.not.equal(pkce.verifier);
        expect(pkce.challenge).to.not.equal(pkce.verifier);
        for (const value of [pkce.verifier, pkce.challenge, pkce.state]) {
            expect(value).to.match(/^[A-Za-z0-9_-]+$$/);
        }
        expect(generateClaudePkce().verifier).to.not.equal(pkce.verifier);
    });

    it('never puts the verifier in the authorize URL', () => {
        const pkce = generateClaudePkce();
        const url = new URL(buildClaudeAuthorizeUrl({
            redirectUri: 'http://127.0.0.1:53692/callback',
            state: pkce.state,
            challenge: pkce.challenge,
        }));
        expect(url.searchParams.get('client_id')).to.equal(CLAUDE_OAUTH_CLIENT_ID);
        expect(url.searchParams.get('code_challenge_method')).to.equal('S256');
        expect(url.searchParams.get('code_challenge')).to.equal(pkce.challenge);
        expect(url.searchParams.get('state')).to.equal(pkce.state);
        expect(url.toString()).to.not.contain(pkce.verifier);
    });

    it('probes forward from the registered callback port', async () => {
        const port = await resolveClaudeCallbackPort(CLAUDE_DEFAULT_CALLBACK_PORT, 4);
        expect(port).to.be.at.least(CLAUDE_DEFAULT_CALLBACK_PORT);
        expect(port).to.be.lessThan(CLAUDE_DEFAULT_CALLBACK_PORT + 4);
    });
});

describe('Claude subscription credentials', () => {
    it('normalizes a space-delimited scope string into a list', () => {
        expect(parseClaudeScopes('user:inference user:profile')).to.deep.equal(['user:inference', 'user:profile']);
        expect(parseClaudeScopes(['user:inference'])).to.deep.equal(['user:inference']);
        expect(parseClaudeScopes(undefined)).to.deep.equal([]);
    });

    // user:inference is what makes the token usable against /v1/messages.
    it('requires user:inference to treat a credential as a subscription one', () => {
        const base = { accessToken: 'a', refreshToken: 'r', expiresAt: 0 };
        expect(isClaudeSubscriptionCredential({ ...base, scopes: ['user:inference'] })).to.equal(true);
        expect(isClaudeSubscriptionCredential({ ...base, scopes: ['user:profile'] })).to.equal(false);
    });

    it('reads back only a complete credential', () => {
        expect(parseClaudeSubscriptionCredentials(undefined)).to.equal(undefined);
        expect(parseClaudeSubscriptionCredentials('{}')).to.equal(undefined);
        expect(parseClaudeSubscriptionCredentials('{not json')).to.equal(undefined);
        const parsed = parseClaudeSubscriptionCredentials(JSON.stringify({
            accessToken: 'a', refreshToken: 'r', expiresAt: 123, scopes: 'user:inference',
            accountUuid: 'uuid-1', accountEmail: 'a@example.test',
        }));
        expect(parsed).to.deep.include({ accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
        expect(parsed!.scopes).to.deep.equal(['user:inference']);
        expect(parsed!.accountEmail).to.equal('a@example.test');
    });

    it('treats an unset expiry as fresh and a near one as stale', () => {
        expect(isClaudeSubscriptionCredentialFresh({ expiresAt: 0 } as any)).to.equal(true);
        expect(isClaudeSubscriptionCredentialFresh({ expiresAt: Date.now() + 3600_000 } as any)).to.equal(true);
        expect(isClaudeSubscriptionCredentialFresh({ expiresAt: Date.now() + 1000 } as any)).to.equal(false);
    });

    // Concurrent requests must share one rotation: a burst at expiry would
    // otherwise each rotate the same refresh token and all but the first fail.
    it('single-flights a refresh and persists the rotation', async () => {
        const secrets = new Secrets();
        const store = new ClaudeSubscriptionCredentialStore(secrets as any);
        await store.save({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 1000, scopes: ['user:inference'] });
        let refreshes = 0;
        const refresh = async () => {
            refreshes += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] };
        };
        const results = await Promise.all([
            store.ensure(refresh),
            store.ensure(refresh),
            store.ensure(refresh),
        ]);
        expect(refreshes).to.equal(1);
        expect(results.every(entry => entry!.accessToken === 'new')).to.equal(true);
        expect((await store.read())!.refreshToken).to.equal('r2');
    });

    it('answers a remembered rejection without hitting the service again', async () => {
        const secrets = new Secrets();
        const store = new ClaudeSubscriptionCredentialStore(secrets as any);
        await store.save({ accessToken: 'old', refreshToken: 'dead', expiresAt: Date.now() + 1000, scopes: ['user:inference'] });
        let calls = 0;
        const reject = async () => {
            calls += 1;
            throw new ClaudeSubscriptionUnauthorizedError('dead token');
        };
        expect(await rejectionOf(store.ensure(reject))).to.match(/dead token/);
        expect(store.isRejected('dead')).to.equal(true);
        expect(await rejectionOf(store.ensure(reject))).to.match(/Sign in again/);
        expect(calls).to.equal(1);
        expect(secrets.values.has(CLAUDE_SUBSCRIPTION_SECRET_KEY)).to.equal(true);
    });

    it('clears the credential on sign-out', async () => {
        const secrets = new Secrets();
        const store = new ClaudeSubscriptionCredentialStore(secrets as any);
        await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 0, scopes: ['user:inference'] });
        await store.clear();
        expect(await store.read()).to.equal(undefined);
    });
});

describe('Claude subscription token endpoint', () => {
    // A credential without a refresh token can never be renewed, so storing one
    // would produce an account that dies at the first expiry.
    it('requires a refresh token on the exchange but not on a refresh', async () => {
        expect(await rejectionOf(exchangeClaudeAuthorizationCode(
            { code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1/callback' },
            { fetchFn: async () => json({ access_token: 'a', expires_in: 3600 }) },
        ))).to.match(/refresh token/);

        const refreshed = await refreshClaudeAccessToken('r1', {
            fetchFn: async () => json({ access_token: 'a2', expires_in: 3600 }),
        });
        expect(refreshed.accessToken).to.equal('a2');
        expect(refreshed.refreshToken).to.equal('r1');
    });

    it('applies the five-minute expiry margin', async () => {
        const credentials = await exchangeClaudeAuthorizationCode(
            { code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1/callback' },
            { fetchFn: async () => json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'user:inference' }) },
        );
        // ~55 minutes, not 60: the margin is expressed in this arithmetic.
        expect(credentials.expiresAt - Date.now()).to.be.lessThan(3600_000 - 200_000);
        expect(credentials.scopes).to.deep.equal(['user:inference']);
    });

    it('sends the code verifier when exchanging', async () => {
        let body: URLSearchParams | undefined;
        await exchangeClaudeAuthorizationCode(
            { code: 'the-code', verifier: 'the-verifier', redirectUri: 'http://127.0.0.1/callback', state: 's1' },
            { fetchFn: async (_input, init) => {
                body = new URLSearchParams(String(init?.body));
                return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
            } },
        );
        expect(body!.get('grant_type')).to.equal('authorization_code');
        expect(body!.get('code')).to.equal('the-code');
        expect(body!.get('code_verifier')).to.equal('the-verifier');
        expect(body!.get('client_id')).to.equal(CLAUDE_OAUTH_CLIENT_ID);
    });

    // A 401 or invalid_grant is a verdict on the token itself, not a transient
    // condition, so it must stop immediately instead of retrying.
    it('classifies a rejected refresh token as final and does not retry', async () => {
        let calls = 0;
        expect(await rejectionOf(refreshClaudeAccessToken('dead', {
            fetchFn: async () => { calls += 1; return json({ error: 'invalid_grant' }, 400); },
        }))).to.match(/invalid_grant/);
        expect(calls).to.equal(1);
    });

    it('retries a transient refresh failure and then succeeds', async () => {
        let attempts = 0;
        const refreshed = await refreshClaudeAccessToken('r1', {
            fetchFn: async () => {
                attempts += 1;
                return attempts === 1
                    ? json({ error: 'overloaded_error' }, 529)
                    : json({ access_token: 'a2', expires_in: 3600 });
            },
        });
        expect(attempts).to.equal(2);
        expect(refreshed.accessToken).to.equal('a2');
    });

    it('rejects an invalid lifetime and a missing access token', async () => {
        expect(await rejectionOf(exchangeClaudeAuthorizationCode(
            { code: 'c', verifier: 'v', redirectUri: 'r' },
            { fetchFn: async () => json({ access_token: 'a', refresh_token: 'r', expires_in: 0 }) },
        ))).to.match(/invalid token lifetime/);
        expect(await rejectionOf(exchangeClaudeAuthorizationCode(
            { code: 'c', verifier: 'v', redirectUri: 'r' },
            { fetchFn: async () => json({ refresh_token: 'r', expires_in: 3600 }) },
        ))).to.match(/access token/);
    });
});

describe('Claude Code identity text', () => {
    // The system array must open with this line verbatim; it is not cosmetic.
    it('is the exact line the subscription requires', () => {
        expect(CLAUDE_CODE_IDENTITY_TEXT).to.equal(
            "You are Claude Code, Anthropic's official CLI for Claude.",
        );
    });
});
