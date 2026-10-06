import { expect } from 'chai';
import {
    COMMANDCODE_CALLBACK_ALLOWED_ORIGINS,
    COMMANDCODE_CALLBACK_COMPLETE_PATH,
    COMMANDCODE_CALLBACK_PARAM,
    COMMANDCODE_DEFAULT_CALLBACK_PORT,
    COMMANDCODE_STUDIO_ORIGIN,
    COMMANDCODE_STUDIO_PATH,
    CommandCodeOAuthService,
    buildCommandCodeAuthUrl,
    createCommandCodeAuthServer,
    findCommandCodeCallbackPort,
    generateCommandCodeState,
} from '../../extension/ai/commandcode/oauthService';
import {
    clearCachedCommandCodeCatalog,
    commandCodeContextWindows,
    loadCommandCodeCatalog,
    parseCommandCodeCatalog,
} from '../../extension/ai/commandcode/modelCatalog';

/** Resolve a rejection's message; fails the test when the promise resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('Expected the promise to reject.');
}

describe('Command Code browser sign-in contract', () => {
    it('builds the studio URL the official CLI opens', () => {
        const url = new URL(buildCommandCodeAuthUrl({ port: 5959, state: 'state-1' }));
        expect(url.origin).to.equal(COMMANDCODE_STUDIO_ORIGIN);
        expect(url.pathname).to.equal(COMMANDCODE_STUDIO_PATH);
        expect(url.searchParams.get(COMMANDCODE_CALLBACK_PARAM)).to.equal('http://127.0.0.1:5959/callback');
        expect(url.searchParams.get('state')).to.equal('state-1');
        expect(url.searchParams.get('mode')).to.equal('redirect');
    });

    it('generates an unguessable state token', () => {
        const first = generateCommandCodeState();
        const second = generateCommandCodeState();
        expect(first).to.not.equal(second);
        // 32 random bytes base64url encode to 43 characters.
        expect(first).to.have.length(43);
        expect(first).to.match(/^[A-Za-z0-9_-]+$/);
    });

    // The port is handed to the studio inside the callback URL, so the probe
    // only has to find something free; starting at the CLI's default keeps the
    // shape identical on a host that ever adds a server-side allowlist.
    it('probes forward from the CLI default port', async () => {
        const port = await findCommandCodeCallbackPort(COMMANDCODE_DEFAULT_CALLBACK_PORT, 3);
        expect(port).to.be.at.least(COMMANDCODE_DEFAULT_CALLBACK_PORT);
        expect(port).to.be.lessThan(COMMANDCODE_DEFAULT_CALLBACK_PORT + 3);
    });
});

describe('Command Code loopback callback server', () => {
    async function post(port: number, body: unknown, contentType = 'application/json'): Promise<Response> {
        return fetch(`http://127.0.0.1:${port}/callback`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: contentType === 'application/json' ? JSON.stringify(body) : String(body),
            redirect: 'manual',
        });
    }

    it('answers the CORS preflight the studio page needs', async () => {
        const port = await findCommandCodeCallbackPort();
        const handle = await createCommandCodeAuthServer(port, 'state-1', 50);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/callback`, {
                method: 'OPTIONS',
                headers: {
                    origin: COMMANDCODE_CALLBACK_ALLOWED_ORIGINS[0],
                    'access-control-request-method': 'POST',
                    // Chrome sends this for a public page reaching loopback.
                    'access-control-request-private-network': 'true',
                },
            });
            expect(response.status).to.equal(204);
            expect(response.headers.get('access-control-allow-origin')).to.equal(COMMANDCODE_CALLBACK_ALLOWED_ORIGINS[0]);
            expect(response.headers.get('access-control-allow-private-network')).to.equal('true');
        } finally {
            handle.close();
        }
    });

    // An unknown origin must not be echoed back: the browser would then allow a
    // page the callback was never meant to answer.
    it('echoes only a known studio origin', async () => {
        const port = await findCommandCodeCallbackPort();
        const handle = await createCommandCodeAuthServer(port, 'state-1', 50);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/callback`, {
                method: 'OPTIONS',
                headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
            });
            expect(response.headers.get('access-control-allow-origin')).to.equal(COMMANDCODE_CALLBACK_ALLOWED_ORIGINS[0]);
        } finally {
            handle.close();
        }
    });

    it('accepts the credential, redirects the tab, and completes on the landing page', async () => {
        const port = await findCommandCodeCallbackPort();
        const handle = await createCommandCodeAuthServer(port, 'state-1', 20);
        try {
            const response = await post(port, { apiKey: 'cc-key', state: 'state-1', userId: 'u1', userName: 'n1', keyName: 'k1' });
            expect(response.status).to.equal(303);
            expect(response.headers.get('location')).to.equal(`${COMMANDCODE_CALLBACK_COMPLETE_PATH}?state=state-1`);

            const landing = await fetch(`http://127.0.0.1:${port}${COMMANDCODE_CALLBACK_COMPLETE_PATH}?state=state-1`);
            expect(landing.status).to.equal(200);
            const credential = await handle.waitForCredentials();
            expect(credential).to.deep.equal({
                apiKey: 'cc-key',
                state: 'state-1',
                userId: 'u1',
                userName: 'n1',
                keyName: 'k1',
            });
        } finally {
            handle.close();
        }
    });

    it('accepts a form-encoded credential', async () => {
        const port = await findCommandCodeCallbackPort();
        const handle = await createCommandCodeAuthServer(port, 'state-1', 20);
        try {
            const response = await post(port, new URLSearchParams({ apiKey: 'cc-key', state: 'state-1' }).toString(), 'application/x-www-form-urlencoded');
            expect(response.status).to.equal(303);
            expect((await handle.waitForCredentials()).apiKey).to.equal('cc-key');
        } finally {
            handle.close();
        }
    });

    // A POST from anywhere other than the attempt we started must be refused
    // without reading the credential it carries.
    it('refuses a mismatched state token without settling the flow', async () => {
        const port = await findCommandCodeCallbackPort();
        const handle = await createCommandCodeAuthServer(port, 'state-1', 20);
        try {
            const rejected = await post(port, { apiKey: 'attacker-key', state: 'state-2' });
            expect(rejected.status).to.equal(403);
            const accepted = await post(port, { apiKey: 'cc-key', state: 'state-1' });
            expect(accepted.status).to.equal(303);
            expect((await handle.waitForCredentials()).apiKey).to.equal('cc-key');
        } finally {
            handle.close();
        }
    });

    it('rejects an oversized body before reading it', async () => {
        const port = await findCommandCodeCallbackPort();
        const handle = await createCommandCodeAuthServer(port, 'state-1', 20);
        try {
            const response = await post(port, { apiKey: 'x'.repeat(20_000), state: 'state-1' });
            expect(response.status).to.equal(413);
        } finally {
            handle.close();
        }
    });

    it('settles the waiter when the attempt is abandoned', async () => {
        const port = await findCommandCodeCallbackPort();
        const handle = await createCommandCodeAuthServer(port, 'state-1', 20);
        const waiting = handle.waitForCredentials();
        handle.close();
        expect(await rejectionOf(waiting)).to.match(/cancelled or timed out/);
    });

    it('reports a denial instead of storing a credential', async () => {
        const port = await findCommandCodeCallbackPort();
        const handle = await createCommandCodeAuthServer(port, 'state-1', 20);
        const waiting = handle.waitForCredentials();
        try {
            const response = await post(port, { error: 'access_denied', error_description: 'User denied', state: 'state-1' });
            expect(response.status).to.equal(200);
            expect(await rejectionOf(waiting)).to.equal('User denied');
        } finally {
            handle.close();
        }
    });
});

describe('Command Code browser sign-in service', () => {
    it('stores the key only after the account API accepts it', async () => {
        const verified: string[] = [];
        const saved: string[] = [];
        let authUrl = '';
        const service = new CommandCodeOAuthService({
            verifyKey: async key => { verified.push(key); },
            saveKey: async key => { saved.push(key); },
            openBrowser: url => { authUrl = url; },
        });
        const login = await service.startLogin();
        expect(authUrl).to.equal(login.authUrl);
        const port = Number(new URL(new URL(authUrl).searchParams.get(COMMANDCODE_CALLBACK_PARAM)!).port);
        const state = new URL(authUrl).searchParams.get('state')!;

        await fetch(`http://127.0.0.1:${port}/callback`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: 'cc-key', state }),
        });
        await login.completion;
        expect(verified).to.deep.equal(['cc-key']);
        expect(saved).to.deep.equal(['cc-key']);
    });

    // A key the account API refuses must never replace a working one.
    it('does not store a key the account API rejects', async () => {
        const saved: string[] = [];
        const service = new CommandCodeOAuthService({
            verifyKey: async () => { throw new Error('rejected by /alpha/whoami'); },
            saveKey: async key => { saved.push(key); },
            openBrowser: () => undefined,
        });
        const login = await service.startLogin();
        const port = Number(new URL(new URL(login.authUrl).searchParams.get(COMMANDCODE_CALLBACK_PARAM)!).port);
        const state = new URL(login.authUrl).searchParams.get('state')!;
        await fetch(`http://127.0.0.1:${port}/callback`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: 'bad-key', state }),
        });
        expect(await rejectionOf(login.completion)).to.match(/rejected/);
        expect(saved).to.deep.equal([]);
    });

    it('cancels a previous attempt when a newer one starts', async () => {
        const service = new CommandCodeOAuthService({
            verifyKey: async () => undefined,
            saveKey: async () => undefined,
            openBrowser: () => undefined,
        });
        const first = await service.startLogin();
        const second = await service.startLogin();
        // Starting a newer attempt must release the earlier waiter, or a
        // cancelled sign-in would block every later one.
        expect(await rejectionOf(first.completion)).to.match(/newer Command Code sign-in/);
        second.cancel();
        expect(await rejectionOf(second.completion)).to.match(/cancelled/);
    });
});

describe('Command Code model catalog', () => {
    afterEach(() => clearCachedCommandCodeCatalog());

    it('reads context_length and the endpoints a model answers on', () => {
        const models = parseCommandCodeCatalog({
            data: [
                { id: 'claude-sonnet-5', displayName: 'Sonnet 5', context_length: 1_000_000, supported_endpoints: ['messages'] },
                { id: 'deepseek/deepseek-v4-flash', context_length: 262_144 },
                { name: 'name-only' },
                { displayName: 'no id' },
            ],
        });
        expect(models).to.have.length(3);
        expect(models[0]).to.deep.equal({
            id: 'claude-sonnet-5',
            name: 'Sonnet 5',
            contextWindow: 1_000_000,
            supportedEndpoints: ['messages'],
        });
        expect(models[1]!.contextWindow).to.equal(262_144);
        expect(models[2]!.id).to.equal('name-only');
        expect(models[2]).to.not.have.property('contextWindow');
    });

    it('accepts a bare array and rejects non-positive windows', () => {
        expect(parseCommandCodeCatalog([{ id: 'a', context_length: 0 }])[0]).to.not.have.property('contextWindow');
        expect(parseCommandCodeCatalog([{ id: 'a' }])).to.have.length(1);
        expect(parseCommandCodeCatalog('nope')).to.deep.equal([]);
    });

    it('maps the listing to the context windows DSH uses for compaction', () => {
        expect(commandCodeContextWindows([
            { id: 'a', name: 'a', contextWindow: 100 },
            { id: 'b', name: 'b' },
        ])).to.deep.equal({ a: 100 });
    });

    it('serves a live listing and keeps the previous one after a failure', async () => {
        const live = await loadCommandCodeCatalog({
            baseUrl: 'https://api.commandcode.ai',
            fetchFn: async () => new Response(JSON.stringify({ data: [{ id: 'a', context_length: 1234 }] })),
        });
        expect(live).to.have.length(1);

        const failed = await loadCommandCodeCatalog({
            baseUrl: 'https://api.commandcode.ai',
            force: true,
            fetchFn: async () => new Response('nope', { status: 500 }),
        });
        // The catalog only fills defaults, so a failure keeps what we had rather
        // than throwing the settings page away.
        expect(failed.map(model => model.id)).to.deep.equal(['a']);
    });
});
