/**
 * Command Code 浏览器登录。
 *
 * 复刻官方 CLI 的回环回调契约：打开 Studio 的 `/studio/auth/cli` 页面，页面把
 * 刚签发的 API Key 通过 **跨域 POST** 回送到 `127.0.0.1` 上的 `/callback`，
 * 然后把标签页重定向到完成页。
 *
 * 三个必须照抄的细节，少一个浏览器就会把凭据卡住：
 * - 回调必须应答 **CORS 预检**，包括 Chrome 的
 *   `Access-Control-Request-Private-Network`（公网页面请求本机回环端口会被判为
 *   私有网络访问）；
 * - 端口从 CLI 自己的默认值 5959 起顺延探测，因为端口会随回调 URL 交给 Studio；
 * - 凭据落地后要**等标签页跳转到完成页**再结算，否则导航会被一个已经关闭的服务
 *   器打断（CLI 同款 10 秒宽限）。
 *
 * 凭据只有在 `/alpha/whoami` 验证通过后才保存：一个连不上账户 API 的 Key
 * 永远不落盘。
 */

import { randomBytes } from 'crypto';
import * as http from 'http';
import { isRecord } from '../../../shared/protocolValidation';
import { aiText } from '../messages';

/** 浏览器登录页；与官方 CLI 打开的是同一页。 */
export const COMMANDCODE_STUDIO_ORIGIN = 'https://commandcode.ai';
export const COMMANDCODE_STUDIO_PATH = '/studio/auth/cli';
/** 承载回环回调地址的查询参数名。 */
export const COMMANDCODE_CALLBACK_PARAM = 'callback';
export const COMMANDCODE_DEFAULT_CALLBACK_PORT = 5959;
/** 默认端口被占用时顺延探测的次数；与官方 CLI 一致。 */
export const COMMANDCODE_CALLBACK_PORT_ATTEMPTS = 10;
export const COMMANDCODE_CALLBACK_PATH = '/callback';
/** Studio 的标签页在 POST 成功后被重定向到的完成页。 */
export const COMMANDCODE_CALLBACK_COMPLETE_PATH = '/callback/complete';
/** 凭据落地后等待浏览器标签页到达的宽限时长。 */
export const COMMANDCODE_CALLBACK_LANDING_GRACE_MS = 10_000;
/** 官方回调服务强制的请求体上限。 */
export const COMMANDCODE_CALLBACK_MAX_BYTES = 10_000;
export const COMMANDCODE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Studio 发起登录的来源；用于回应浏览器的 CORS 校验。 */
export const COMMANDCODE_CALLBACK_ALLOWED_ORIGINS = [
    'https://commandcode.ai',
    'https://staging.commandcode.ai',
    'http://localhost:3000',
] as const;

export interface CommandCodeLogin {
    authUrl: string;
    /** 凭据已通过验证并保存后结算。 */
    completion: Promise<void>;
    cancel(): void;
}

/** Studio 回送的回调负载。 */
export interface CommandCodeCallbackCredentials {
    apiKey: string;
    state: string;
    userId: string;
    userName: string;
    keyName: string;
}

export interface CommandCodeOAuthOptions {
    /** 用 `/alpha/whoami` 验证 Key；抛错即视为无效。 */
    verifyKey: (apiKey: string) => Promise<void>;
    /** 验证通过后保存 Key。 */
    saveKey: (apiKey: string) => Promise<void>;
    openBrowser: (url: string) => void;
    port?: number;
    timeoutMs?: number;
    landingGraceMs?: number;
}

/** State 令牌：32 字节随机数，base64url。 */
export function generateCommandCodeState(): string {
    return randomBytes(32).toString('base64url');
}

/** 浏览器登录地址；与官方 CLI 的形状一致。 */
export function buildCommandCodeAuthUrl(input: { port: number; state: string }): string {
    const callback = `http://127.0.0.1:${input.port}${COMMANDCODE_CALLBACK_PATH}`;
    const params = new URLSearchParams({
        [COMMANDCODE_CALLBACK_PARAM]: callback,
        state: input.state,
        mode: 'redirect',
    });
    return `${COMMANDCODE_STUDIO_ORIGIN}${COMMANDCODE_STUDIO_PATH}?${params.toString()}`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function page(title: string, message: string): string {
    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + `<title>${escapeHtml(title)}</title></head>`
        + '<body style="font-family:system-ui;padding:40px;text-align:center;">'
        + `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function allowedOrigin(request: http.IncomingMessage): string {
    const origin = request.headers.origin;
    return typeof origin === 'string'
        && (COMMANDCODE_CALLBACK_ALLOWED_ORIGINS as readonly string[]).includes(origin)
        ? origin
        : COMMANDCODE_CALLBACK_ALLOWED_ORIGINS[0];
}

function applyCors(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin(request));
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Read a bounded request body.
 *
 * An over-limit body resolves to null **without destroying the socket**: the
 * caller still has to deliver a 413, and tearing the connection down first turns
 * that into an unobservable network error. The remaining bytes are drained
 * instead, which is what lets the rejection reach the studio page.
 */
function readBody(request: http.IncomingMessage, limit: number): Promise<string | null> {
    return new Promise(resolve => {
        const chunks: Buffer[] = [];
        let size = 0;
        let over = false;
        let settled = false;
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            over = true;
            settled = true;
            resolve(null);
            request.resume();
            return;
        }
        request.on('data', (chunk: Buffer) => {
            if (over) return;
            size += chunk.length;
            if (size > limit) {
                over = true;
                if (!settled) { settled = true; resolve(null); }
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (!over && !settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); }
        });
        request.on('error', () => {
            if (!settled) { settled = true; resolve(null); }
        });
    });
}

function fieldsFromPayload(raw: string, contentType: string): Record<string, string> {
    if (contentType === 'application/x-www-form-urlencoded') {
        return Object.fromEntries(new URLSearchParams(raw).entries());
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('invalid callback payload'); }
    if (!isRecord(parsed)) throw new Error('invalid callback payload');
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') fields[key] = value;
    }
    return fields;
}

/** 一个可用的回环端口；从 CLI 的默认端口起顺延探测。 */
export async function findCommandCodeCallbackPort(
    start = COMMANDCODE_DEFAULT_CALLBACK_PORT,
    attempts = COMMANDCODE_CALLBACK_PORT_ATTEMPTS,
): Promise<number> {
    for (let offset = 0; offset < attempts; offset += 1) {
        const port = start + offset;
        const free = await new Promise<boolean>(resolve => {
            const probe = http.createServer();
            probe.once('error', () => resolve(false));
            probe.once('listening', () => probe.close(() => resolve(true)));
            probe.listen(port, '127.0.0.1');
        });
        if (free) return port;
    }
    throw new Error(aiText(
        `No free local port for the Command Code sign-in callback (tried ${attempts} ports from ${start}).`,
        `无法为 Command Code 登录回调找到空闲的本地端口（已从 ${start} 起尝试 ${attempts} 个）。`,
    ));
}

interface AuthServerHandle {
    waitForCredentials: () => Promise<CommandCodeCallbackCredentials>;
    close: () => void;
}

/**
 * 一次性的回环回调服务。
 *
 * 契约就是官方 CLI 的契约——Studio 页面是同一个客户端——所以它必须应答跨域
 * 预检、把凭据等待到标签页跳转完成，并在被放弃时让等待者结算（否则流程会一直
 * 停在 pending，挡住之后每一次登录）。
 */
export function createCommandCodeAuthServer(
    port: number,
    expectedState: string,
    landingGraceMs: number,
): Promise<AuthServerHandle> {
    return new Promise((resolve, reject) => {
        let settleCredentials!: (value: CommandCodeCallbackCredentials) => void;
        let failCredentials!: (error: Error) => void;
        const credentialPromise = new Promise<CommandCodeCallbackCredentials>((res, rej) => {
            settleCredentials = res;
            failCredentials = rej;
        });
        credentialPromise.catch(() => undefined);

        let landed: CommandCodeCallbackCredentials | null = null;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        let closed = false;
        let settled = false;

        const server = http.createServer((request, response) => { void handle(request, response); });

        const shutdown = (): void => {
            if (graceTimer !== null) { clearTimeout(graceTimer); graceTimer = null; }
            if (closed) return;
            closed = true;
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
            server.close();
        };

        const publish = (): void => {
            if (landed === null) return;
            const value = landed;
            landed = null;
            settled = true;
            settleCredentials(value);
            shutdown();
        };

        const deny = (error: Error): void => {
            if (settled) return;
            settled = true;
            failCredentials(error);
            shutdown();
        };

        async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
            let url: URL;
            try {
                url = new URL(request.url ?? '/', 'http://127.0.0.1');
            } catch {
                response.writeHead(400, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ success: false, error: 'Bad request' }));
                return;
            }
            applyCors(request, response);

            if (request.method === 'OPTIONS') {
                // A public origin reaching a loopback port is a private-network
                // request to Chrome, and the studio's fetch fails without this.
                if (request.headers['access-control-request-private-network'] === 'true') {
                    response.setHeader('Access-Control-Allow-Private-Network', 'true');
                }
                response.writeHead(204);
                response.end();
                return;
            }

            if (request.method === 'GET' && url.pathname === COMMANDCODE_CALLBACK_COMPLETE_PATH) {
                if (url.searchParams.get('state') !== expectedState) {
                    response.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                    response.end(page(
                        aiText('Invalid state token', '状态令牌无效'),
                        aiText('The state token did not match this sign-in attempt. Return to VS Code and restart sign-in.', '状态令牌与本次登录不匹配。请返回 VS Code 重新发起登录。'),
                    ));
                    return;
                }
                if (landed === null) {
                    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                    response.end(page(
                        aiText('Return to VS Code', '请返回 VS Code'),
                        aiText('This page completes sign-in automatically. Restart sign-in from VS Code if you reached it directly.', '此页面会自动完成登录。如果你是直接访问到这里，请从 VS Code 重新发起登录。'),
                    ));
                    return;
                }
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
                response.end(
                    page(aiText('Sign in successful', '登录成功'), aiText('You can close this window and return to VS Code.', '可以关闭此窗口并返回 VS Code。')),
                    () => publish(),
                );
                return;
            }

            if (url.pathname !== COMMANDCODE_CALLBACK_PATH) {
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ success: false, error: 'Not found' }));
                return;
            }

            if (request.method !== 'POST') {
                response.writeHead(405, {
                    Allow: 'POST, OPTIONS',
                    'content-type': 'text/html; charset=utf-8',
                    'cache-control': 'no-store',
                });
                response.end(page(
                    aiText('Return to VS Code', '请返回 VS Code'),
                    aiText('This page completes sign-in automatically. Restart sign-in from VS Code if you reached it directly.', '此页面会自动完成登录。如果你是直接访问到这里，请从 VS Code 重新发起登录。'),
                ));
                return;
            }

            const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
            if (contentType !== 'application/json' && contentType !== 'application/x-www-form-urlencoded') {
                response.writeHead(415, { connection: 'close', 'content-type': 'application/json' });
                response.end(JSON.stringify({ success: false, error: 'Unsupported content type' }));
                return;
            }

            const raw = await readBody(request, COMMANDCODE_CALLBACK_MAX_BYTES);
            if (raw === null) {
                response.writeHead(413, { connection: 'close', 'content-type': 'application/json' });
                response.end(JSON.stringify({ success: false, error: 'Payload too large' }));
                return;
            }

            let fields: Record<string, string>;
            try {
                fields = fieldsFromPayload(raw, contentType);
            } catch {
                response.writeHead(400, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ success: false, error: 'Invalid payload' }));
                return;
            }

            if (fields.error) {
                if (fields.state !== expectedState) {
                    response.writeHead(403, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ success: false, error: 'Invalid state token' }));
                    return;
                }
                const message = fields.error_description || fields.error;
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                response.end(
                    page(
                        fields.error === 'access_denied' ? aiText('Authorization denied', '授权被拒绝') : aiText('Sign-in failed', '登录失败'),
                        message,
                    ),
                    () => deny(new Error(message)),
                );
                return;
            }

            if (!fields.apiKey) {
                response.writeHead(400, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ success: false, error: 'Missing required fields' }));
                return;
            }
            // An unverified state means the POST came from somewhere other than
            // the attempt we started, so the credential is refused unread.
            if (fields.state !== expectedState) {
                response.writeHead(403, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ success: false, error: 'Invalid state token' }));
                return;
            }

            landed = {
                apiKey: fields.apiKey,
                state: fields.state,
                userId: fields.userId ?? '',
                userName: fields.userName ?? '',
                keyName: fields.keyName ?? '',
            };
            // The tab is redirected to the completion page, so the credential
            // waits a moment instead of racing that navigation to a closed server.
            graceTimer = setTimeout(publish, landingGraceMs);
            graceTimer.unref?.();
            response.writeHead(303, {
                Location: `${COMMANDCODE_CALLBACK_COMPLETE_PATH}?state=${encodeURIComponent(expectedState)}`,
                'cache-control': 'no-store',
                'content-length': '0',
                connection: 'close',
            });
            response.end();
        }

        server.on('error', error => reject(error));
        server.keepAliveTimeout = 1;
        server.headersTimeout = 5_000;
        server.listen(port, '127.0.0.1', () => {
            resolve({
                waitForCredentials: () => credentialPromise,
                close: () => {
                    if (!settled) deny(new Error(aiText(
                        'Command Code sign-in was cancelled or timed out.',
                        'Command Code 登录已取消或超时。',
                    )));
                    shutdown();
                },
            });
        });
    });
}

/**
 * 拥有 Command Code 浏览器登录流程的会话。
 *
 * 凭据落盘交给调用方（`saveKey`），验证也交给调用方（`verifyKey`），因此本类
 * 只负责回环回调契约本身；`/alpha/whoami` 的 HTTP 细节留在账户服务里。
 */
export class CommandCodeOAuthService {
    private activeCancel?: (reason?: Error) => void;

    constructor(private readonly options: CommandCodeOAuthOptions) {}

    async startLogin(): Promise<CommandCodeLogin> {
        this.activeCancel?.(new Error(aiText(
            'A newer Command Code sign-in was started.',
            '已开始新的 Command Code 登录。',
        )));

        const state = generateCommandCodeState();
        const port = await findCommandCodeCallbackPort(this.options.port);
        const handle = await createCommandCodeAuthServer(
            port,
            state,
            this.options.landingGraceMs ?? COMMANDCODE_CALLBACK_LANDING_GRACE_MS,
        );
        const authUrl = buildCommandCodeAuthUrl({ port, state });

        let settled = false;
        const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined };
        let resolveCompletion!: () => void;
        let rejectCompletion!: (error: Error) => void;
        const completion = new Promise<void>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        // A cancelled attempt can reject before the caller attaches its handler
        // (a newer sign-in replaces it). The guard keeps that from surfacing as
        // an unhandled rejection; the returned promise still rejects for callers.
        completion.catch(() => undefined);

        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            if (timer.current) clearTimeout(timer.current);
            this.activeCancel = undefined;
            handle.close();
            if (error) rejectCompletion(error);
            else resolveCompletion();
        };

        const cancel = (reason = new Error(aiText(
            'Command Code sign-in was cancelled.',
            'Command Code 登录已取消。',
        ))) => finish(reason);
        this.activeCancel = cancel;
        timer.current = setTimeout(() => cancel(new Error(aiText(
            'Timed out waiting for Command Code sign-in.',
            '等待 Command Code 登录超时。',
        ))), this.options.timeoutMs ?? COMMANDCODE_LOGIN_TIMEOUT_MS);

        void (async () => {
            try {
                const credential = await handle.waitForCredentials();
                if (credential.state !== state) throw new Error(aiText(
                    'Command Code sign-in state mismatch.',
                    'Command Code 登录状态不匹配。',
                ));
                // A key that cannot authenticate is never stored.
                await this.options.verifyKey(credential.apiKey);
                await this.options.saveKey(credential.apiKey);
                finish();
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        })();

        try {
            this.options.openBrowser(authUrl);
        } catch {
            // The settings card always renders the URL, so a failed launch is recoverable.
        }

        return { authUrl, completion, cancel: () => cancel() };
    }

    dispose(): void {
        this.activeCancel?.();
        this.activeCancel = undefined;
    }
}
