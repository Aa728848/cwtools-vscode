import { expect } from 'chai';
import * as crypto from 'crypto';
import {
    ANTIGRAVITY_SECRET_KEY, ANTIGRAVITY_TOKEN_URL, AntigravityOAuthService,
    parseAntigravityModels, parseAntigravityQuota,
} from '../../extension/ai/antigravity/oauthService';
import { ANTIGRAVITY_ENDPOINTS, antigravityRuntimeModel } from '../../extension/ai/antigravity/models';
import { buildAntigravityRequest, callAntigravity, consumeAntigravityResponse } from '../../extension/ai/antigravity/completion';
import { buildAntigravityAccountHtml, isAntigravityAccountStatus } from '../../webview/chat/antigravityAccount';
import { cloneChatMessage } from '../../extension/ai/runner/contextTranscript';
import { estimateChatMessageTokens } from '../../extension/ai/runner/tokenEstimation';
import { parseWebviewMessage } from '../../extension/ai/chat/webviewProtocol';
import { parseHostMessage } from '../../webview/chat/hostProtocol';

class Secrets {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

function credentials(secrets: Secrets, expiresAt = Date.now() + 3600_000) {
    secrets.values.set(ANTIGRAVITY_SECRET_KEY, JSON.stringify({ accessToken: 'access-test', refreshToken: 'refresh-test', expiresAt }));
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function rejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    const outcome = await promise.then(() => undefined, error => error);
    expect(outcome).to.be.instanceOf(Error);
    expect(String(outcome)).to.match(pattern);
}

function sse(events: unknown[], split = false): Response {
    const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            if (split) for (let offset = 0; offset < bytes.length; offset += 11) controller.enqueue(bytes.slice(offset, offset + 11));
            else controller.enqueue(bytes);
            controller.close();
        },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Antigravity OAuth and account boundary', () => {
    it('keeps PKCE/state validation on loopback and persists only completed credentials', async () => {
        const secrets = new Secrets();
        const requests: RequestInit[] = [];
        const service = new AntigravityOAuthService(secrets, async (input, init) => {
            expect(String(input)).to.equal(ANTIGRAVITY_TOKEN_URL);
            requests.push(init ?? {});
            return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
        }, 0);
        const login = await service.startLogin();
        const completion = login.completion;
        try {
            const auth = new URL(login.authUrl);
            expect(auth.origin).to.equal('https://accounts.google.com');
            expect(auth.searchParams.get('code_challenge_method')).to.equal('S256');
            expect(auth.searchParams.get('access_type')).to.equal('offline');
            const callback = new URL(auth.searchParams.get('redirect_uri') ?? '');
            callback.hostname = '127.0.0.1';
            callback.searchParams.set('state', 'wrong');
            callback.searchParams.set('code', 'test-code');
            expect((await fetch(callback)).status).to.equal(400);
            expect(secrets.values.size).to.equal(0);
            callback.searchParams.set('state', auth.searchParams.get('state') ?? '');
            expect((await fetch(callback)).status).to.equal(200);
            await completion;
            const params = new URLSearchParams(String(requests[0]?.body));
            expect(params.get('code')).to.equal('test-code');
            expect(crypto.createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url'))
                .to.equal(auth.searchParams.get('code_challenge'));
            expect(requests[0]?.redirect).to.equal('error');
            expect(await secrets.get(ANTIGRAVITY_SECRET_KEY)).to.contain('new-refresh');
        } finally { service.dispose(); }
    });

    it('deduplicates token refresh and project discovery for concurrent calls', async () => {
        const secrets = new Secrets();
        credentials(secrets, 0);
        let refreshes = 0;
        let projects = 0;
        const service = new AntigravityOAuthService(secrets, async (input, init) => {
            expect(init?.redirect).to.equal('error');
            if (String(input) === ANTIGRAVITY_TOKEN_URL) {
                refreshes++;
                return json({ access_token: 'rotated', expires_in: 3600 });
            }
            projects++;
            return json({ cloudaicompanionProject: { id: 'project-test' } });
        });
        const contexts = await Promise.all([service.getRequestContext(new AbortController().signal), service.getRequestContext(new AbortController().signal)]);
        expect(contexts).to.deep.equal([{ token: 'rotated', projectId: 'project-test' }, { token: 'rotated', projectId: 'project-test' }]);
        expect(refreshes).to.equal(1);
        expect(projects).to.equal(1);
        expect(await secrets.get(ANTIGRAVITY_SECRET_KEY)).to.contain('refresh-test');
        service.dispose();
    });

    it('honors cancellation before authentication and rejects malformed refresh responses', async () => {
        const secrets = new Secrets(); credentials(secrets, 0);
        let calls = 0;
        const service = new AntigravityOAuthService(secrets, async () => { calls++; return json({ access_token: {}, expires_in: 3600 }); });
        const controller = new AbortController(); controller.abort(new Error('cancelled'));
        await rejected(service.getRequestContext(controller.signal), /cancelled/);
        expect(calls).to.equal(0);
        await rejected(service.getRequestContext(new AbortController().signal), /invalid OAuth/);
        expect(await secrets.get(ANTIGRAVITY_SECRET_KEY)).to.contain('access-test');
        service.dispose();
    });

    it('does not persist an OAuth exchange completed after login cancellation', async () => {
        const secrets = new Secrets();
        let release: (response: Response) => void = () => {};
        let started: () => void = () => {};
        const waiting = new Promise<void>(resolve => { started = resolve; });
        const service = new AntigravityOAuthService(secrets, async () => {
            started(); return new Promise<Response>(resolve => { release = resolve; });
        }, 0);
        const login = await service.startLogin();
        const outcome = rejected(login.completion, /cancelled/);
        const auth = new URL(login.authUrl);
        const callback = new URL(auth.searchParams.get('redirect_uri') ?? '');
        callback.hostname = '127.0.0.1';
        callback.searchParams.set('state', auth.searchParams.get('state') ?? '');
        callback.searchParams.set('code', 'test-code');
        const response = fetch(callback);
        await waiting;
        login.cancel();
        release(json({ access_token: 'late', refresh_token: 'late-refresh' }));
        expect((await response).status).to.equal(400);
        await outcome;
        expect(await secrets.get(ANTIGRAVITY_SECRET_KEY)).to.equal(undefined);
        service.dispose();
    });

    it('does not restore credentials when a pending refresh finishes after logout', async () => {
        const secrets = new Secrets();
        credentials(secrets, 0);
        await secrets.store('unrelated', 'keep');
        let release: (response: Response) => void = () => {};
        let started: () => void = () => {};
        const waiting = new Promise<void>(resolve => { started = resolve; });
        const service = new AntigravityOAuthService(secrets, async () => {
            started();
            return new Promise<Response>(resolve => { release = resolve; });
        });
        const request = service.getRequestContext(new AbortController().signal);
        const outcome = rejected(request, /abort|session/i);
        await waiting;
        await service.logout();
        release(json({ access_token: 'late', refresh_token: 'late-refresh' }));
        await outcome;
        expect(await secrets.get(ANTIGRAVITY_SECRET_KEY)).to.equal(undefined);
        expect(await secrets.get('unrelated')).to.equal('keep');
        service.dispose();
    });

    it('reports account models and quota without exposing credentials', async () => {
        const secrets = new Secrets(); credentials(secrets);
        const service = new AntigravityOAuthService(secrets, async input => {
            const url = String(input);
            if (url.includes('loadCodeAssist')) return json({ cloudaicompanionProject: 'project-test' });
            if (url.includes('fetchAvailableModels')) return json({ models: { 'gemini-3.8-flash-tiered': {}, internal: { isInternal: true } } });
            if (url.includes('retrieveUserQuotaSummary')) return json({ groups: [{ buckets: [{ displayName: 'Daily', remainingFraction: 0.42 }] }] });
            return json({ email: 'test@example.com' });
        });
        const account = await service.getAccountStatus();
        expect(account).to.include({ signedIn: true, email: 'test@example.com', projectId: 'project-test' });
        expect(account.models).to.deep.equal(['gemini-3.8-flash-tiered']);
        expect(account.quota[0]?.remainingPercent).to.equal(42);
        expect(JSON.stringify(account)).not.to.match(/access-test|refresh-test/);
        expect(isAntigravityAccountStatus(account)).to.equal(true);
        service.dispose();
    });

    it('rejects malformed credentials and does not invent a project', async () => {
        const secrets = new Secrets();
        await secrets.store(ANTIGRAVITY_SECRET_KEY, '{"accessToken":42,"refreshToken":{},"expiresAt":0}');
        let calls = 0;
        const service = new AntigravityOAuthService(secrets, async () => { calls++; return json({}); });
        expect((await service.getAccountStatus()).hasCredentials).to.equal(false);
        expect(calls).to.equal(0);
        credentials(secrets);
        await rejected(service.getRequestContext(new AbortController().signal), /project/i);
        expect(calls).to.equal(2);
        service.dispose();
    });

    it('validates quota values and escapes account details in both languages', () => {
        expect(parseAntigravityModels({ models: { z: {}, a: {}, chat_hidden: {}, internal: { isInternal: true }, invalid: null } })).to.deep.equal(['a', 'z']);
        expect(parseAntigravityQuota({ groups: [{ buckets: [{ remainingFraction: null }, { remainingFraction: NaN }, { remainingFraction: 2 }] }] }))
            .to.deep.equal([{ name: 'Antigravity', remainingPercent: 100 }]);
        const account = { signedIn: true, hasCredentials: true, email: '<script>x</script>', models: [], quota: [] };
        expect(buildAntigravityAccountHtml(account, false)).to.contain('&lt;script&gt;');
        expect(buildAntigravityAccountHtml(account, true)).to.contain('已登录');
        expect(isAntigravityAccountStatus({ ...account, quota: [{ name: 'bad', remainingPercent: '20' }] })).to.equal(false);
        for (const type of ['antigravityLogin', 'antigravityRefreshAccount', 'antigravityLogout']) expect(parseWebviewMessage({ type })).not.to.equal(null);
        expect(parseHostMessage({ type: 'settingsData', providers: [], current: {}, antigravityAccount: account })).not.to.equal(null);
        expect(parseHostMessage({ type: 'settingsData', providers: [], current: {}, antigravityAccount: { signedIn: 'true' } })).to.equal(null);
    });
});

describe('Antigravity completion transport', () => {
    it('routes the reference model aliases and caps output without adding Anthropic thinking fields', () => {
        expect(antigravityRuntimeModel('gemini-3.6-flash', 'medium')).to.equal('gemini-3.6-flash-medium');
        expect(antigravityRuntimeModel('gemini-3.1-pro', 'high')).to.equal('gemini-pro-agent');
        expect(antigravityRuntimeModel('claude-opus-4-6', 'high')).to.equal('claude-opus-4-6-thinking');
        const body = buildAntigravityRequest({ model: 'gemini-3.8-flash', messages: [], max_tokens: 100_000 }, { contents: [] }, 'project', 'high');
        expect(body.model).to.equal('gemini-3.8-flash-tiered');
        expect(body.request).to.deep.include({ generationConfig: { maxOutputTokens: 65_536, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } } });
        const limited = buildAntigravityRequest({ model: 'gemini-2.5-pro', messages: [], max_tokens: 2048 }, { contents: [] }, 'project', 'high');
        expect(limited.request).to.deep.include({ generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 2047, includeThoughts: true } } });
    });

    it('parses split wrapped SSE, preserves signed tool turns, and counts thinking/cache usage', async () => {
        const deltas: string[] = [];
        const response = await consumeAntigravityResponse(sse([
            { response: { candidates: [{ content: { parts: [{ text: '分析', thought: true, thoughtSignature: 'signed-thought' }] } }] } },
            { response: { candidates: [{ content: { parts: [{ functionCall: { id: 'call_one', name: 'read_file', args: { path: 'test.txt' } }, thoughtSignature: 'signed-call' }] }, finishReason: 'STOP' }] } },
            { response: { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5, cachedContentTokenCount: 40 } } },
        ], true), 'claude-opus-4-6', new AbortController().signal, { onThinking: delta => deltas.push(delta) });
        const message = response.choices[0]?.message;
        expect(deltas.join('')).to.equal('分析');
        expect(message?.tool_calls?.[0]).to.include({ id: 'call_one', thoughtSignature: 'signed-call' });
        expect(response.choices[0]?.finish_reason).to.equal('tool_calls');
        expect(response.usage).to.include({ prompt_tokens: 100, completion_tokens: 15, total_tokens: 115, cached_tokens: 40 });
        if (!message) throw new Error('Missing assistant message');
        const cloned = cloneChatMessage(message);
        expect(cloned.antigravity_content).to.deep.equal(message.antigravity_content);
        expect(cloned.antigravity_content?.parts).not.to.equal(message.antigravity_content?.parts);
        expect(estimateChatMessageTokens(message)).to.be.greaterThan(20);
    });

    it('uses the second fixed endpoint after 429 and refreshes OAuth exactly once after 401', async () => {
        const urls: string[] = [];
        const refreshes: boolean[] = [];
        const result = await callAntigravity({ getRequestContext: async (_signal, force = false) => {
            refreshes.push(force); return { token: force ? 'renewed' : 'expired', projectId: 'p' };
        } }, { model: 'gemini-3.8-flash', messages: [] }, { contents: [] }, 'high', new AbortController().signal, {}, async (input, init) => {
            urls.push(String(input));
            expect(init?.redirect).to.equal('error');
            if (urls.length === 1) return json({}, 401);
            if (urls.length === 2) return json({}, 429);
            expect(new Headers(init?.headers).get('Authorization')).to.equal('Bearer renewed');
            return sse([{ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }]);
        });
        expect(result.choices[0]?.message.content).to.equal('ok');
        expect(refreshes).to.deep.equal([false, true]);
        expect(urls.map(url => new URL(url).origin)).to.deep.equal([ANTIGRAVITY_ENDPOINTS[0], ANTIGRAVITY_ENDPOINTS[0], ANTIGRAVITY_ENDPOINTS[1]]);
    });

    it('rejects error events, truncated streams and malformed tool arguments', async () => {
        for (const events of [
            [{ error: { message: 'upstream failed' } }],
            [{ response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] } }],
            [{ response: { candidates: [{ content: { parts: [{ functionCall: { name: 'tool', args: 'bad-json' } }] }, finishReason: 'STOP' }] } }],
        ]) await rejected(consumeAntigravityResponse(sse(events), 'gemini-3.8-flash', new AbortController().signal), /Antigravity/);
    });

    it('cancels a stalled stream and releases its reader', async () => {
        let cancelled = false;
        const controller = new AbortController();
        const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
        const pending = consumeAntigravityResponse(response, 'gemini-3.8-flash', controller.signal);
        const outcome = rejected(pending, /cancelled/);
        controller.abort(new Error('cancelled'));
        await outcome;
        expect(cancelled).to.equal(true);
        expect(response.body?.locked).to.equal(false);
    });
});
