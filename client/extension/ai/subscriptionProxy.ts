import { execFile } from 'child_process';
import { Agent, ProxyAgent, buildConnector, type Dispatcher } from 'undici';
import { SocksClient } from 'socks';
import type { SecretStorage } from 'vscode';
import { isRecord } from '../../shared/protocolValidation';
import { isSubscriptionProxyMode, type SubscriptionProxyMode, type SubscriptionProxySource, type SubscriptionProxyStatus } from '../../shared/subscriptionProxy';
import { aiText } from './messages';

export const SUBSCRIPTION_PROXY_SECRET_KEY = 'cwtools.ai.subscriptionProxy.url.v1';
const DETECTION_TTL_MS = 5000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RETIRING_AGENTS = 3;

function invalidProxy(): Error {
    return new Error(aiText(
        'Invalid proxy address. Use http://host:port, https://host:port or socks5://host:port (optional username:password).',
        '代理地址无效。请使用 http://主机:端口、https://主机:端口 或 socks5://主机:端口（可选用户名和密码）。',
    ));
}

export function normalizeSubscriptionProxyUrl(value: string): string {
    try {
        const raw = value.trim();
        if (!raw || raw.length > 2048 || /[\s\\]/.test(raw)) throw invalidProxy();
        const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
        if (url.protocol === 'socks:' || url.protocol === 'socks5h:') url.protocol = 'socks5:';
        if (!['http:', 'https:', 'socks5:'].includes(url.protocol)
            || !url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash
            || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) throw invalidProxy();
        // Decode before creating a dispatcher, so malformed credentials cannot leak through its errors.
        const username = decodeURIComponent(url.username);
        const password = decodeURIComponent(url.password);
        if (url.protocol === 'socks5:' && (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255)) throw invalidProxy();
        return url.href;
    } catch {
        throw invalidProxy();
    }
}

export function redactSubscriptionProxyUrl(value: string): string {
    const url = new URL(normalizeSubscriptionProxyUrl(value));
    url.username = '';
    url.password = '';
    return url.href;
}

export function environmentProxy(env: NodeJS.ProcessEnv): string | undefined {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
        const value = env[key]?.trim();
        if (value) return value;
    }
    return undefined;
}

export function windowsSystemProxy(output: string): string | undefined {
    if (!/ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(output)) return undefined;
    const server = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim();
    if (!server || !server.includes('=')) return server || undefined;
    const entries = new Map(server.split(';').map(entry => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim()];
    }));
    const selected = entries.get('https') || entries.get('http');
    if (selected) return selected;
    const socks = entries.get('socks');
    return socks ? (socks.includes('://') ? socks : `socks5://${socks}`) : undefined;
}

export function macSystemProxy(output: string): string | undefined {
    const field = (name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm').exec(output)?.[1];
    for (const prefix of ['HTTPS', 'HTTP', 'SOCKS']) {
        if (field(`${prefix}Enable`) !== '1') continue;
        const host = field(`${prefix}Proxy`);
        const port = field(`${prefix}Port`);
        if (host && port) return `${prefix === 'SOCKS' ? 'socks5' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${port}`;
    }
    return undefined;
}

async function detectSystemProxy(): Promise<string | undefined> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return undefined;
    const windows = process.platform === 'win32';
    return new Promise((resolve, reject) => {
        execFile(windows ? 'reg.exe' : '/usr/sbin/scutil', windows
            ? ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']
            : ['--proxy'], { timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
            if (error) {
                // Missing registry keys / utilities mean there is no manual system proxy to detect.
                if (error.code === 'ENOENT' || (windows && error.code === 1)) resolve(undefined);
                else reject(new Error(aiText('System proxy detection failed. Refresh detection or choose a custom proxy / direct mode.', '系统代理检测失败。请刷新检测，或选择自定义代理 / 直连模式。')));
                return;
            }
            resolve(windows ? windowsSystemProxy(stdout) : macSystemProxy(stdout));
        });
    });
}

function createProxyDispatcher(address: string): Dispatcher {
    const url = new URL(address);
    if (url.protocol !== 'socks5:') return new ProxyAgent({
        uri: address, connectTimeout: CONNECT_TIMEOUT_MS,
        token: url.username || url.password ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : undefined,
    });
    const tlsConnect = buildConnector({ timeout: CONNECT_TIMEOUT_MS });
    return new Agent({
        connect(options, callback) {
            void SocksClient.createConnection({
                command: 'connect',
                proxy: {
                    host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 1080), type: 5,
                    userId: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
                },
                destination: { host: options.hostname.replace(/^\[|\]$/g, ''), port: Number(options.port || (options.protocol === 'https:' ? 443 : 80)) },
                timeout: CONNECT_TIMEOUT_MS,
            }).then(({ socket }) => {
                try {
                    if (options.protocol === 'https:') tlsConnect({ ...options, httpSocket: socket }, callback);
                    else callback(null, socket);
                } catch {
                    socket.destroy();
                    callback(new Error('SOCKS5 proxy TLS connection failed'), null);
                }
            }, () => callback(new Error('SOCKS5 proxy connection failed'), null));
        },
    });
}

interface ProxyRoute { url?: string; source?: SubscriptionProxySource }
interface SubscriptionProxyOptions {
    secrets: Pick<SecretStorage, 'get' | 'store' | 'delete'>;
    readMode(): unknown;
    writeMode(mode: SubscriptionProxyMode): PromiseLike<void>;
    readVsCodeProxy(): unknown;
    reportError(message: string): void;
    env?: NodeJS.ProcessEnv;
    systemProxy?: () => Promise<string | undefined>;
    fetchFn?: typeof fetch;
}

/** One shared transport for subscription OAuth; never changes the process-wide fetch dispatcher. */
export class SubscriptionProxyService {
    private readonly directAgent = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
    private current?: { url: string; agent: Dispatcher };
    private readonly retiring = new Set<Dispatcher>();
    private systemCache?: { value: string | undefined; expires: number };
    private systemPending?: Promise<string | undefined>;
    private saveQueue: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(private readonly options: SubscriptionProxyOptions) {}

    private mode(): SubscriptionProxyMode {
        const mode = this.options.readMode();
        if (!isSubscriptionProxyMode(mode)) throw new Error(aiText('Invalid subscription proxy mode.', '订阅渠道代理模式无效。'));
        return mode;
    }

    private async systemProxy(): Promise<string | undefined> {
        if (this.systemCache && this.systemCache.expires > Date.now()) return this.systemCache.value;
        if (!this.systemPending) {
            this.systemPending = (this.options.systemProxy ?? detectSystemProxy)().then(value => {
                this.systemCache = { value, expires: Date.now() + DETECTION_TTL_MS };
                return value;
            }).finally(() => { this.systemPending = undefined; });
        }
        return this.systemPending;
    }

    private async route(mode: SubscriptionProxyMode): Promise<ProxyRoute> {
        if (mode === 'direct') return {};
        if (mode === 'custom') {
            const saved = await this.options.secrets.get(SUBSCRIPTION_PROXY_SECRET_KEY);
            if (!saved) throw new Error(aiText('Save a custom subscription proxy address first.', '请先保存订阅渠道的自定义代理地址。'));
            return { url: normalizeSubscriptionProxyUrl(saved), source: 'custom' };
        }
        const vscodeProxy = this.options.readVsCodeProxy();
        if (typeof vscodeProxy === 'string' && vscodeProxy.trim()) return { url: normalizeSubscriptionProxyUrl(vscodeProxy), source: 'vscode' };
        const envProxy = environmentProxy(this.options.env ?? process.env);
        if (envProxy) return { url: normalizeSubscriptionProxyUrl(envProxy), source: 'environment' };
        const system = await this.systemProxy();
        return system ? { url: normalizeSubscriptionProxyUrl(system), source: 'system' } : {};
    }

    private retireCurrent(): void {
        if (!this.current) return;
        const { agent } = this.current;
        this.current = undefined;
        this.retiring.add(agent);
        void agent.close().catch(() => {
            this.options.reportError(aiText('Failed to close a retired subscription proxy connection pool.', '关闭旧订阅代理连接池失败。'));
            return agent.destroy().catch(() => {
                this.options.reportError(aiText('Failed to dispose a retired subscription proxy connection pool.', '释放旧订阅代理连接池失败。'));
            });
        }).finally(() => { this.retiring.delete(agent); });
    }

    private dispatcher(route: ProxyRoute): Dispatcher {
        if (this.disposed) throw new Error(aiText('Subscription proxy service is disposed.', '订阅渠道代理服务已关闭。'));
        if (this.current && this.current.url === route.url) return this.current.agent;
        if (this.current && this.retiring.size >= MAX_RETIRING_AGENTS) {
            throw new Error(aiText('Too many proxy changes with active requests. Wait for them to finish and retry.', '仍有请求使用旧代理，请等待这些请求结束后重试切换。'));
        }
        const agent = route.url ? createProxyDispatcher(route.url) : this.directAgent;
        this.retireCurrent();
        if (route.url) this.current = { url: route.url, agent };
        return agent;
    }

    readonly fetch: typeof fetch = async (input, init) => {
        if (this.disposed) throw new Error(aiText('Subscription proxy service is disposed.', '订阅渠道代理服务已关闭。'));
        const signal = init?.signal !== undefined ? init.signal : (input instanceof Request ? input.signal : undefined);
        signal?.throwIfAborted();
        let abort: (() => void) | undefined;
        const route = await Promise.race([
            this.route(this.mode()),
            new Promise<never>((_, reject) => {
                if (!signal) return;
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
            }),
        ]).finally(() => { if (abort) signal?.removeEventListener('abort', abort); });
        signal?.throwIfAborted();
        const requestInit: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher: this.dispatcher(route) };
        try {
            // Keep the native Response / streaming / AbortSignal contract, including in VS Code's Node runtime.
            return await (this.options.fetchFn ?? fetch)(input, requestInit);
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (!route.url) throw error;
            const cause = isRecord(error) ? error.cause : undefined;
            const code = isRecord(cause) && typeof cause.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(cause.code) ? cause.code : undefined;
            // Do not forward dispatcher errors that may embed an authenticated proxy URL.
            throw Object.assign(new Error(aiText('Subscription proxy fetch failed. Check the proxy address and connection.', '订阅渠道代理请求失败，请检查代理地址和连接。') + (code ? ` (${code})` : '')), { code });
        }
    };

    async getStatus(force = false): Promise<SubscriptionProxyStatus> {
        if (force) this.systemCache = undefined;
        let mode: SubscriptionProxyMode = 'auto';
        try {
            mode = this.mode();
            const saved = await this.options.secrets.get(SUBSCRIPTION_PROXY_SECRET_KEY);
            const route = await this.route(mode);
            return {
                mode, source: route.source,
                customProxyUrl: saved ? redactSubscriptionProxyUrl(saved) : undefined,
                activeProxyUrl: route.url ? redactSubscriptionProxyUrl(route.url) : undefined,
            };
        } catch (error) {
            return { mode, error: error instanceof Error ? error.message : aiText('Could not read subscription proxy settings.', '无法读取订阅渠道代理设置。') };
        }
    }

    save(mode: SubscriptionProxyMode, address?: string): Promise<void> {
        const action = this.saveQueue.then(async () => {
            if (this.disposed) throw new Error(aiText('Subscription proxy service is disposed.', '订阅渠道代理服务已关闭。'));
            if (!isSubscriptionProxyMode(mode)) throw new Error(aiText('Invalid subscription proxy mode.', '订阅渠道代理模式无效。'));
            const value = address === undefined ? undefined : address.trim() ? normalizeSubscriptionProxyUrl(address) : '';
            const previous = await this.options.secrets.get(SUBSCRIPTION_PROXY_SECRET_KEY);
            if (mode === 'custom' && !(value ?? previous)) {
                throw new Error(aiText('Enter a custom proxy address.', '请输入自定义代理地址。'));
            }
            if (value !== undefined) {
                if (value) await this.options.secrets.store(SUBSCRIPTION_PROXY_SECRET_KEY, value);
                else await this.options.secrets.delete(SUBSCRIPTION_PROXY_SECRET_KEY);
            }
            try {
                await this.options.writeMode(mode);
            } catch (error) {
                if (value !== undefined) {
                    try {
                        if (previous) await this.options.secrets.store(SUBSCRIPTION_PROXY_SECRET_KEY, previous);
                        else await this.options.secrets.delete(SUBSCRIPTION_PROXY_SECRET_KEY);
                    } catch {
                        this.options.reportError(aiText('Could not restore the saved proxy after a settings write failed.', '代理设置写入失败，且无法恢复原代理地址。'));
                    }
                }
                throw error;
            }
            this.systemCache = undefined;
        });
        this.saveQueue = action.catch(() => { /* The returned action reports the failure to the settings caller. */ });
        return action;
    }

    dispose(): void {
        this.disposed = true;
        const agents = [this.directAgent, ...this.retiring, ...(this.current ? [this.current.agent] : [])];
        this.current = undefined;
        this.retiring.clear();
        for (const agent of agents) void agent.destroy().catch(() => {
            this.options.reportError(aiText('Failed to dispose a subscription proxy connection pool.', '释放订阅代理连接池失败。'));
        });
    }
}
