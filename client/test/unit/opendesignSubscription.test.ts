import { expect } from 'chai';
import {
    OPENDESIGN_PROVIDER_ID,
    isOpenDesignDeepSeekModel,
    isOpenDesignUnsupportedMaxTokensError,
    openDesignWantsCompletionTokens,
    withoutMaxTokensUseCompletionTokens,
} from '../../extension/ai/opendesign/types';
import {
    OpenDesignCredentialStore,
    describeOpenDesignCredential,
    openDesignCredentialsIdentity,
    openDesignRuntimeKey,
    openDesignControlKey,
    parseOpenDesignCredentials,
    type OpenDesignCredentials,
} from '../../extension/ai/opendesign/credentials';
import { OpenDesignOAuthService, OpenDesignOAuthError } from '../../extension/ai/opendesign/oauth';
import { fetchOpenDesignAccountQuota } from '../../extension/ai/opendesign/quota';
import {
    clearOpenDesignCatalogCache,
    fetchOpenDesignCatalog,
    resolveOpenDesignModelInfo,
} from '../../extension/ai/opendesign/catalog';
import { classifyOpenDesignFailure } from '../../extension/ai/opendesign/errors';

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('OpenDesign subscription OAuth device flow', () => {
    it('requests device authorization, opens HTTPS activation URL only, and polls until authorized', async () => {
        const openedUrls: string[] = [];
        const saved: OpenDesignCredentials[] = [];
        let pollCalls = 0;

        const fetchMock: typeof fetch = async (input) => {
            const url = String(input);
            if (url.endsWith('/cli/device-authorizations')) {
                return jsonResponse(200, {
                    deviceId: 'dev-123',
                    userCode: 'ABCD-1234',
                    activationUrl: 'https://open-design.ai/activate?code=ABCD-1234',
                    deviceSecret: 'secret-xyz',
                    expiresIn: 120,
                    pollIntervalSeconds: 1,
                });
            }
            if (url.endsWith('/cli/device-authorizations/dev-123/token')) {
                pollCalls += 1;
                if (pollCalls === 1) {
                    return jsonResponse(200, { status: 'pending' });
                }
                return jsonResponse(200, {
                    controlKey: 'vela_ctrl_secret_1',
                    runtimeKey: 'sk-amr-secret-1',
                    user: { id: 'usr-42', email: 'builder@example.com', name: 'Builder', plan: 'pro' },
                });
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        };

        const service = new OpenDesignOAuthService({
            fetchFn: fetchMock,
            pollIntervalMs: 1,
            openBrowser: url => { openedUrls.push(url); },
            saveCredentials: async creds => { saved.push(creds); },
        });

        const login = await service.startLogin();
        expect(login.authorization.userCode).to.equal('ABCD-1234');
        expect(openedUrls).to.deep.equal(['https://open-design.ai/activate?code=ABCD-1234']);

        const result = await login.completion;
        expect(pollCalls).to.equal(2);
        expect(result.controlKey).to.equal('vela_ctrl_secret_1');
        expect(result.runtimeKey).to.equal('sk-amr-secret-1');
        expect(result.user?.email).to.equal('builder@example.com');
        expect(saved).to.have.length(1);
    });

    it('refuses to open non-HTTPS activation URLs and rejects expired/cancelled sessions', async () => {
        const openedUrls: string[] = [];
        let rejectNextPoll = true;
        const service = new OpenDesignOAuthService({
            fetchFn: async (input) => {
                const url = String(input);
                if (url.endsWith('/cli/device-authorizations')) {
                    return jsonResponse(200, {
                        deviceId: 'dev-insecure',
                        userCode: 'CODE-1',
                        activationUrl: 'http://insecure.example/activate',
                        deviceSecret: 'sec',
                        expiresIn: 60,
                    });
                }
                if (rejectNextPoll) {
                    return jsonResponse(200, { status: 'expired' });
                }
                return jsonResponse(200, { status: 'pending' });
            },
            pollIntervalMs: 5,
            openBrowser: url => { openedUrls.push(url); },
            saveCredentials: async () => undefined,
        });

        const expiredLogin = await service.startLogin();
        expect(openedUrls).to.deep.equal([]);
        let captured: unknown;
        try {
            await expiredLogin.completion;
        } catch (error) {
            captured = error;
        }
        expect(captured).to.be.instanceOf(OpenDesignOAuthError);
        expect((captured as OpenDesignOAuthError).code).to.equal('expired');

        rejectNextPoll = false;
        const cancellable = await service.startLogin();
        cancellable.cancel();
        let cancelErr: unknown;
        try {
            await cancellable.completion;
        } catch (error) {
            cancelErr = error;
        }
        expect(cancelErr).to.be.instanceOf(Error);
        expect(String(cancelErr)).to.include('cancelled');
        service.dispose();
    });
});

describe('OpenDesign credentials, storage, and redaction', () => {
    it('supports both OAuth and static API key stores without leaking raw secrets in descriptions or keys', async () => {
        const box = new Map<string, string>();
        const store = new OpenDesignCredentialStore({
            get: async k => box.get(k),
            store: async (k, v) => { box.set(k, v); },
            delete: async k => { box.delete(k); },
        });

        const oauth = parseOpenDesignCredentials({
            kind: 'oauth',
            controlKey: 'vela_ctrl_PRIVATE_999',
            runtimeKey: 'sk-amr-PRIVATE_888',
            user: { id: 'u-99', email: 'Alice@Example.com', name: 'Alice' },
        })!;
        const staticKey = parseOpenDesignCredentials({
            kind: 'api-key',
            apiKey: 'sk-static-PRIVATE_777',
            addedAt: 1000,
        })!;

        expect(openDesignRuntimeKey(oauth)).to.equal('sk-amr-PRIVATE_888');
        expect(openDesignControlKey(oauth)).to.equal('vela_ctrl_PRIVATE_999');
        expect(openDesignRuntimeKey(staticKey)).to.equal('sk-static-PRIVATE_777');
        expect(openDesignControlKey(staticKey)).to.equal(undefined);

        expect(openDesignCredentialsIdentity(oauth)).to.equal('amr-user:u-99');
        const keyIdentity = openDesignCredentialsIdentity(staticKey);
        expect(keyIdentity).to.match(/^key:[0-9a-f]{64}$/);
        expect(keyIdentity).to.not.contain('PRIVATE_777');

        expect(describeOpenDesignCredential(oauth)).to.equal('Alice');
        const staticLabel = describeOpenDesignCredential(staticKey);
        expect(staticLabel).to.match(/^API Key #[0-9a-f]{6}$/);
        expect(staticLabel).to.not.contain('PRIVATE_777');

        await store.add(oauth);
        await store.add(staticKey);
        expect(await store.read()).to.have.length(2);

        // Adding the same OAuth user again deduplicates in place
        await store.add({ ...oauth, addedAt: 9999 } as OpenDesignCredentials);
        expect(await store.read()).to.have.length(2);

        await store.remove(keyIdentity);
        expect(await store.read()).to.have.length(1);
    });
});

describe('OpenDesign quota and catalog merging', () => {
    beforeEach(() => clearOpenDesignCatalogCache());

    it('returns undefined quota for static API keys and parses rolling windows + balance for OAuth', async () => {
        const staticCreds = parseOpenDesignCredentials({ kind: 'api-key', apiKey: 'sk-only', addedAt: 1 })!;
        expect(await fetchOpenDesignAccountQuota(staticCreds)).to.equal(undefined);

        const oauthCreds = parseOpenDesignCredentials({
            kind: 'oauth',
            controlKey: 'vela_ctrl_1',
            runtimeKey: 'sk-amr-1',
            addedAt: 1,
        })!;

        const quota = await fetchOpenDesignAccountQuota(oauthCreds, {
            fetchFn: async (input) => {
                const url = String(input);
                if (url.endsWith('/workspaces/current')) {
                    return jsonResponse(200, { activeWorkspaceId: 'ws-1' });
                }
                if (url.endsWith('/workspaces/ws-1/billing/coding-plan-usage')) {
                    return jsonResponse(200, {
                        tier: 'pro',
                        windows: [
                            { policyId: '5h', durationSeconds: 18000, remainingCredits: 750, limitCredits: 1000, resetsAt: '2026-11-14T20:00:00Z' },
                            { policyId: '7d', durationSeconds: 604800, remainingCredits: 4000, limitCredits: 10000 },
                        ],
                    });
                }
                if (url.endsWith('/billing/summary')) {
                    return jsonResponse(200, { membershipTier: 'pro', totalAvailableCreditsUsd: '12.50' });
                }
                if (url.endsWith('/wallet/balance')) {
                    return jsonResponse(200, { balanceUsd: '18.25' });
                }
                throw new Error(`Unexpected URL: ${url}`);
            },
        });

        expect(quota).to.not.equal(undefined);
        expect(quota!.meters.map(m => m.id)).to.deep.equal(['cycle', 'package', 'wallet_usd']);
        expect(quota!.meters[0]!.usedPercent).to.be.closeTo(0.25, 1e-6);
        expect(quota!.meters[0]!.used).to.equal('250');
        expect(quota!.meters[0]!.limit).to.equal('1000');
        expect(quota!.meters[1]!.usedPercent).to.be.closeTo(0.6, 1e-6);
        expect(quota!.meters[2]!.used).to.equal('$18.25');
    });

    it('merges control plane and gateway catalogs and preserves reasoning capabilities', async () => {
        const models = await fetchOpenDesignCatalog({
            runtimeKey: 'sk-amr-1',
            controlKey: 'vela_ctrl_1',
            identity: 'test-id',
            forceRefresh: true,
            fetchFn: async (input) => {
                const url = String(input);
                if (url.startsWith('https://amr-link.open-design.ai')) {
                    return jsonResponse(200, {
                        data: [
                            { id: 'vela/claude-sonnet-5.5', max_output_tokens: 65536 },
                            { id: 'deepseek-v4.1-flash' },
                            { id: 'custom-new-model', contextWindow: 512000, efforts: ['low', 'high'], reasoning: true, supportsVision: true },
                        ],
                    });
                }
                return jsonResponse(200, {
                    data: [
                        { id: 'public_model_claude-sonnet-5.5', contextLength: 1000000 },
                    ],
                });
            },
        });

        expect(models.map(m => m.id)).to.deep.equal(['claude-sonnet-5.5', 'deepseek-v4.1-flash', 'custom-new-model']);
        const sonnet = resolveOpenDesignModelInfo('claude-sonnet-5.5', models);
        expect(sonnet.contextWindow).to.equal(1_000_000);
        expect(sonnet.maxTokens).to.equal(64_000);
        expect(sonnet.efforts).to.include.members(['low', 'medium', 'high', 'xhigh', 'max']);

        const custom = resolveOpenDesignModelInfo('custom-new-model', models);
        expect(custom.contextWindow).to.equal(512_000);
        expect(custom.input).to.deep.equal(['text', 'image']);
        expect(custom.efforts).to.deep.equal(['low', 'high']);
    });
});

describe('OpenDesign failure classification and request compatibility', () => {
    it('keeps tier entitlement 403 distinct from revoked credentials and handles 401/402/429', () => {
        expect(OPENDESIGN_PROVIDER_ID).to.equal('opendesign');
        expect(classifyOpenDesignFailure(403, '{"error":{"code":"tier_pro_not_entitled"}}')).to.equal('entitlement_denied');
        expect(classifyOpenDesignFailure(403, 'You are not entitled to use this model')).to.equal('entitlement_denied');
        expect(classifyOpenDesignFailure(401, 'unauthorized')).to.equal('invalid_credential');
        expect(classifyOpenDesignFailure(403, 'invalid_api_key')).to.equal('invalid_credential');
        expect(classifyOpenDesignFailure(402, 'insufficient credits')).to.equal('account_quota_exhausted');
        expect(classifyOpenDesignFailure(429, 'rate limit exceeded')).to.equal('rate_limit');
        expect(classifyOpenDesignFailure(400, 'maximum context length exceeded')).to.equal('context_overflow');
    });

    it('detects max_completion_tokens fallback and DeepSeek-only none disabling', () => {
        expect(openDesignWantsCompletionTokens('gpt-6-astra')).to.equal(false);
        expect(openDesignWantsCompletionTokens('gpt-5.6-sol')).to.equal(true);
        expect(openDesignWantsCompletionTokens('o3-mini')).to.equal(true);
        expect(isOpenDesignDeepSeekModel('vela/deepseek-v4.1-flash')).to.equal(true);
        expect(isOpenDesignDeepSeekModel('claude-sonnet-5.5')).to.equal(false);

        expect(isOpenDesignUnsupportedMaxTokensError("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'.")).to.equal(true);
        const migrated = withoutMaxTokensUseCompletionTokens({ model: 'gpt-5', max_tokens: 4096, stream: true });
        expect(migrated).to.deep.equal({ model: 'gpt-5', max_completion_tokens: 4096, stream: true });
    });
});
