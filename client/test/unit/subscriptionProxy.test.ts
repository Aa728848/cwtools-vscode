import { expect } from 'chai';
import * as http from 'http';
import * as net from 'net';
import { Agent } from 'undici';
import {
    SubscriptionProxyService, SUBSCRIPTION_PROXY_SECRET_KEY,
    normalizeSubscriptionProxyUrl, redactSubscriptionProxyUrl,
    environmentProxy, windowsSystemProxy, macSystemProxy,
} from '../../extension/ai/subscriptionProxy';
import type { SubscriptionProxyMode } from '../../shared/subscriptionProxy';
import { parseWebviewMessage } from '../../extension/ai/chat/webviewProtocol';
import { parseHostMessage } from '../../webview/chat/hostProtocol';

class Secrets {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

function fixture(options: {
    mode?: SubscriptionProxyMode; env?: NodeJS.ProcessEnv; vscode?: string;
    systemProxy?: () => Promise<string | undefined>; fetchFn?: typeof fetch;
} = {}) {
    let mode = options.mode ?? 'auto';
    const secrets = new Secrets();
    const errors: string[] = [];
    const service = new SubscriptionProxyService({
        secrets, readMode: () => mode, writeMode: async value => { mode = value; },
        readVsCodeProxy: () => options.vscode ?? '', reportError: message => errors.push(message),
        env: options.env ?? {}, systemProxy: options.systemProxy ?? (async () => undefined), fetchFn: options.fetchFn,
    });
    return { service, secrets, errors };
}

describe('subscription proxy settings', () => {
    it('normalizes supported addresses and redacts encoded credentials', () => {
        expect(normalizeSubscriptionProxyUrl(' 127.0.0.1:7890 ')).to.equal('http://127.0.0.1:7890/');
        expect(normalizeSubscriptionProxyUrl('socks://127.0.0.1:1080')).to.equal('socks5://127.0.0.1:1080');
        expect(normalizeSubscriptionProxyUrl('socks5h://[::1]:1080')).to.equal('socks5://[::1]:1080');
        expect(redactSubscriptionProxyUrl('https://alice:p%40ss@proxy.test:443')).to.equal('https://proxy.test/');
    });

    it('rejects malformed addresses without including their credentials in errors', () => {
        for (const value of ['', 'ftp://alice:secret@proxy.test', 'http://proxy.test:0', 'http://proxy.test:65536',
            'http://alice:secret@proxy.test/path', 'http://proxy.test/?password=secret', 'http://proxy.test/#secret',
            'http://alice:%zz@proxy.test', 'http://proxy.test\\evil', 'x'.repeat(2049)]) {
            expect(() => normalizeSubscriptionProxyUrl(value)).to.throw('Invalid proxy address');
            expect(() => normalizeSubscriptionProxyUrl(value)).not.to.throw('secret');
        }
    });

    it('parses environment and Windows/macOS manual proxy priorities', () => {
        expect(environmentProxy({ HTTPS_PROXY: ' a:1 ', https_proxy: 'b:2', ALL_PROXY: 'c:3' })).to.equal('a:1');
        expect(environmentProxy({ all_proxy: 'socks5://c:3' })).to.equal('socks5://c:3');
        expect(windowsSystemProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=a:1;https=b:2;socks=c:3')).to.equal('b:2');
        expect(windowsSystemProxy('ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ a:1')).to.equal(undefined);
        expect(windowsSystemProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ socks=c:3')).to.equal('socks5://c:3');
        expect(macSystemProxy(' HTTPEnable : 1\n HTTPProxy : a\n HTTPPort : 1\n HTTPSEnable : 1\n HTTPSProxy : b\n HTTPSPort : 2')).to.equal('http://b:2');
        expect(macSystemProxy(' SOCKSEnable : 1\n SOCKSProxy : ::1\n SOCKSPort : 1080')).to.equal('socks5://[::1]:1080');
    });

    it('uses VS Code before environment before system, with a bounded detection cache', async () => {
        let detections = 0;
        const { service } = fixture({ vscode: 'vscode.test:1', env: { HTTPS_PROXY: 'env.test:2' }, systemProxy: async () => {
            detections++;
            return 'system.test:3';
        } });
        const env = fixture({ env: { HTTPS_PROXY: 'env.test:2' } });
        const system = fixture({ systemProxy: async () => { detections++; return 'system.test:3'; } });
        try {
            expect(await service.getStatus()).to.include({ source: 'vscode', activeProxyUrl: 'http://vscode.test:1/' });
            expect(detections).to.equal(0);
            expect(await env.service.getStatus()).to.include({ source: 'environment', activeProxyUrl: 'http://env.test:2/' });
            await Promise.all([system.service.getStatus(), system.service.getStatus()]);
            expect(detections).to.equal(1);
            expect(await system.service.getStatus(true)).to.include({ source: 'system' });
            expect(detections).to.equal(2);
        } finally { service.dispose(); env.service.dispose(); system.service.dispose(); }
    });

    it('keeps credentials in SecretStorage and preserves the saved address when omitted', async () => {
        const { service, secrets } = fixture();
        try {
            await service.save('custom', 'http://alice:secret@proxy.test:7890');
            expect(secrets.values.get(SUBSCRIPTION_PROXY_SECRET_KEY)).to.equal('http://alice:secret@proxy.test:7890/');
            const status = await service.getStatus();
            expect(status).to.include({ mode: 'custom', customProxyUrl: 'http://proxy.test:7890/', activeProxyUrl: 'http://proxy.test:7890/' });
            expect(JSON.stringify(status)).not.to.match(/alice|secret/);
            await service.save('direct');
            expect(await service.getStatus()).to.include({ mode: 'direct', activeProxyUrl: undefined });
            await service.save('custom');
            expect((await service.getStatus()).activeProxyUrl).to.equal('http://proxy.test:7890/');
            await service.save('direct', '');
            expect(secrets.values.size).to.equal(0);
        } finally { service.dispose(); }
    });

    it('fails closed for missing or invalid proxies and never calls fetch', async () => {
        let calls = 0;
        const fetchFn: typeof fetch = async () => { calls++; return new Response('unexpected'); };
        const missing = fixture({ mode: 'custom', fetchFn });
        const invalid = fixture({ env: { HTTPS_PROXY: 'ftp://alice:secret@proxy.test' }, fetchFn });
        try {
            await assertRejected(missing.service.fetch('https://example.test'), /Save a custom/);
            await assertRejected(invalid.service.fetch('https://example.test'), /Invalid proxy/);
            await assertRejected(missing.service.save('custom', ''), /Enter a custom/);
            expect(calls).to.equal(0);
            expect(JSON.stringify(await invalid.service.getStatus())).not.to.contain('secret');
        } finally { missing.service.dispose(); invalid.service.dispose(); }
    });

    it('provides an explicit direct dispatcher and keeps the original fetch request contract', async () => {
        const signal = new AbortController().signal;
        const response = new Response('ok');
        const { service } = fixture({ mode: 'direct', env: { HTTPS_PROXY: 'bad://proxy' }, fetchFn: async (url, init) => {
            expect(url).to.equal('https://example.test');
            expect(init).to.include({ method: 'POST', body: 'body', signal, redirect: 'error' });
            expect(init).to.have.property('dispatcher').instanceOf(Agent);
            return response;
        } });
        try {
            expect(await service.fetch('https://example.test', { method: 'POST', body: 'body', signal, redirect: 'error' })).to.equal(response);
        } finally { service.dispose(); }
    });

    it('cancels while detecting a proxy and rejects requests after disposal', async () => {
        const controller = new AbortController();
        let resolveDetection: (value: string | undefined) => void = () => {};
        const { service } = fixture({ systemProxy: () => new Promise(resolve => { resolveDetection = resolve; }) });
        const request = service.fetch('https://example.test', { signal: controller.signal });
        controller.abort(new Error('cancel detection'));
        await assertRejected(request, /cancel detection/);
        resolveDetection(undefined);
        service.dispose();
        await assertRejected(service.fetch('https://example.test'), /disposed/);
    });

    it('validates proxy Webview requests and status messages at both boundaries', () => {
        expect(parseWebviewMessage({ type: 'saveSubscriptionProxy', mode: 'custom', url: '127.0.0.1:7890' })).not.to.equal(null);
        expect(parseWebviewMessage({ type: 'saveSubscriptionProxy', mode: 'invalid' })).to.equal(null);
        expect(parseWebviewMessage({ type: 'saveSubscriptionProxy', mode: 'auto', url: 42 })).to.equal(null);
        expect(parseWebviewMessage({ type: 'saveSubscriptionProxy', mode: 'auto', url: 'a'.repeat(2049) })).to.equal(null);
        expect(parseHostMessage({ type: 'subscriptionProxyStatus', status: { mode: 'auto' }, saved: true, targetSurface: 'manager' })).not.to.equal(null);
        expect(parseHostMessage({ type: 'subscriptionProxyStatus', status: { mode: 'auto', source: {} } })).to.equal(null);
        expect(parseHostMessage({ type: 'settingsData', providers: [], current: {}, subscriptionProxy: { mode: 'custom', activeProxyUrl: 42 } })).to.equal(null);
    });
});

async function assertRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    const error: unknown = await promise.then(() => undefined, reason => reason);
    expect(error).to.be.instanceOf(Error);
    expect(String(error)).to.match(pattern);
}

describe('subscription proxy network transport', function () {
    this.timeout(8000);
    const sockets = new Set<net.Socket>();
    const servers: net.Server[] = [];
    const services: SubscriptionProxyService[] = [];

    async function listen(server: net.Server): Promise<number> {
        servers.push(server);
        server.on('connection', socket => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('error', () => { /* Fixture teardown closes both tunnel ends. */ });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture port');
        return address.port;
    }

    async function transport(address: string): Promise<SubscriptionProxyService> {
        const { service } = fixture();
        services.push(service);
        await service.save('custom', address);
        return service;
    }

    afterEach(async () => {
        services.splice(0).forEach(service => service.dispose());
        sockets.forEach(socket => socket.destroy());
        await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    });

    async function httpProxy(onConnect: (request: http.IncomingMessage) => void = () => {}): Promise<number> {
        const proxy = http.createServer();
        proxy.on('connect', (request, client, head) => {
            onConnect(request);
            const destination = new URL(`http://${request.url}`);
            const upstream = net.connect(Number(destination.port), '127.0.0.1');
            sockets.add(upstream);
            upstream.on('error', () => client.destroy());
            upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
            client.on('close', () => upstream.destroy());
            upstream.on('connect', () => {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream.write(head);
                client.pipe(upstream).pipe(client);
            });
        });
        return listen(proxy);
    }

    it('tunnels POST traffic, sends proxy authentication only to the proxy and reuses its pool', async () => {
        const auth: Array<string | undefined> = [];
        const port = await listen(http.createServer((request, response) => {
            expect(request.headers['proxy-authorization']).to.equal(undefined);
            expect(request.headers.authorization).to.equal('Bearer upstream-token');
            let body = '';
            request.on('data', chunk => { body += String(chunk); });
            request.on('end', () => response.end(body));
        }));
        const proxyPort = await httpProxy(request => auth.push(request.headers['proxy-authorization']));
        const service = await transport(`http://alice:p%40ss@127.0.0.1:${proxyPort}`);
        for (let i = 0; i < 2; i++) {
            const response = await service.fetch(`http://remote.invalid:${port}/token`, { method: 'POST', headers: { Authorization: 'Bearer upstream-token' }, body: 'grant_type=refresh_token' });
            expect(await response.text()).to.equal('grant_type=refresh_token');
        }
        expect(auth.length).to.be.within(1, 2);
        expect(auth.every(value => value === `Basic ${Buffer.from('alice:p@ss').toString('base64')}`)).to.equal(true);
    });

    it('applies proxy changes to new requests while allowing an existing stream to finish', async () => {
        let oldStream: http.ServerResponse | undefined;
        let tunnels = 0;
        const port = await listen(http.createServer((request, response) => {
            if (request.url === '/stream') { oldStream = response; response.write('first'); }
            else response.end('direct');
        }));
        const proxyPort = await httpProxy(() => { tunnels++; });
        const service = await transport(`http://127.0.0.1:${proxyPort}`);
        const response = await service.fetch(`http://remote.invalid:${port}/stream`);
        const reader = response.body?.getReader();
        expect(new TextDecoder().decode((await reader?.read())?.value)).to.equal('first');
        await service.save('direct');
        expect(await (await service.fetch(`http://127.0.0.1:${port}/next`)).text()).to.equal('direct');
        expect(tunnels).to.equal(1);
        oldStream?.end('last');
        expect(new TextDecoder().decode((await reader?.read())?.value)).to.equal('last');
        expect((await reader?.read())?.done).to.equal(true);
    });

    it('preserves AbortSignal cancellation while consuming a proxied stream', async () => {
        const port = await listen(http.createServer((_request, response) => response.write('first')));
        const service = await transport(`http://127.0.0.1:${await httpProxy()}`);
        const controller = new AbortController();
        const response = await service.fetch(`http://remote.invalid:${port}`, { signal: controller.signal });
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Missing stream');
        await reader.read();
        controller.abort();
        await assertRejected(reader.read(), /abort/i);
    });

    it('reports proxy failure without falling back to the reachable destination or exposing credentials', async () => {
        let directCalls = 0;
        const port = await listen(http.createServer((_request, response) => { directCalls++; response.end('direct'); }));
        const proxyPort = await new Promise<number>((resolve, reject) => {
            const probe = net.createServer();
            probe.listen(0, '127.0.0.1', () => {
                const address = probe.address();
                if (!address || typeof address === 'string') return reject(new Error('Missing fixture port'));
                const assigned = address.port;
                probe.close(error => error ? reject(error) : resolve(assigned));
            });
        });
        const service = await transport(`http://alice:secret@127.0.0.1:${proxyPort}`);
        const error: unknown = await service.fetch(`http://127.0.0.1:${port}`).catch(reason => reason);
        expect(error).to.be.instanceOf(Error);
        expect(String(error)).to.match(/Subscription proxy fetch failed/).and.not.to.match(/alice|secret/);
        expect(directCalls).to.equal(0);
    });

    it('uses SOCKS5 remote DNS and keeps connections to different target origins separate', async () => {
        const targets: string[] = [];
        const proxyPort = await listen(net.createServer(client => {
            let buffer = Buffer.alloc(0);
            let greeting = true;
            const parse = (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                if (greeting) {
                    if (buffer.length < 2 || buffer.length < 2 + (buffer[1] ?? 0)) return;
                    buffer = buffer.subarray(2 + (buffer[1] ?? 0));
                    greeting = false;
                    client.write(Buffer.from([5, 0]));
                }
                if (buffer.length < 5) return;
                expect(buffer[3]).to.equal(3);
                const length = buffer[4] ?? 0;
                if (buffer.length < 7 + length) return;
                const host = buffer.subarray(5, 5 + length).toString();
                const port = buffer.readUInt16BE(5 + length);
                targets.push(`${host}:${port}`);
                client.removeListener('data', parse);
                const upstream = net.connect(port, '127.0.0.1');
                sockets.add(upstream);
                upstream.on('error', () => client.destroy());
                upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
                client.on('close', () => upstream.destroy());
                upstream.on('connect', () => {
                    client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    client.pipe(upstream).pipe(client);
                });
            };
            client.on('data', parse);
        }));
        const firstPort = await listen(http.createServer((_request, response) => response.end('first')));
        const secondPort = await listen(http.createServer((_request, response) => response.end('second')));
        const service = await transport(`socks5://127.0.0.1:${proxyPort}`);
        expect(await (await service.fetch(`http://first.invalid:${firstPort}`)).text()).to.equal('first');
        expect(await (await service.fetch(`http://second.invalid:${secondPort}`)).text()).to.equal('second');
        expect(targets).to.deep.equal([`first.invalid:${firstPort}`, `second.invalid:${secondPort}`]);
    });
});
