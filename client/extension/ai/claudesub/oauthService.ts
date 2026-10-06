/**
 * Claude 订阅 OAuth：PKCE 登录、令牌兑换与续期，以及订阅请求头。
 *
 * ⚠️ 风险须知：Anthropic 条款不允许第三方应用以订阅凭据转发请求；本模块未获其授权。
 *
 * **这不是「抄一个 token 就能用」**：订阅令牌要求请求完整模仿 Claude Code 的身份，否则会被
 * 服务端拒绝或分类判别。身份约束集中在 `claudeSubscriptionHeaders`，并有测试锁定。
 */

import { createHash, randomBytes } from 'crypto';
import * as http from 'http';
import { isRecord } from '../../../shared/protocolValidation';
import { aiText } from '../messages';
import {
    CLAUDE_ANTHROPIC_VERSION,
    CLAUDE_API_BASE,
    CLAUDE_CALLBACK_PATH,
    CLAUDE_CALLBACK_PORT_ATTEMPTS,
    CLAUDE_CODE_BETA,
    CLAUDE_DEFAULT_CALLBACK_PORT,
    CLAUDE_DEFAULT_CACHE_TTL,
    CLAUDE_EXTENDED_CACHE_TTL_BETA,
    CLAUDE_FINAL_GRANT_CODES,
    CLAUDE_INTERLEAVED_THINKING_BETA,
    CLAUDE_LOGIN_TIMEOUT_MS,
    CLAUDE_OAUTH_MANUAL_REDIRECT_URI,
    CLAUDE_OAUTH_AUTHORIZE_URL,
    CLAUDE_OAUTH_BETA,
    CLAUDE_OAUTH_CLIENT_ID,
    CLAUDE_OAUTH_SCOPES,
    CLAUDE_OAUTH_TOKEN_URL,
    CLAUDE_REFRESH_BACKOFF_BASE_MS,
    CLAUDE_REFRESH_MARGIN_MS,
    CLAUDE_REFRESH_MAX_ATTEMPTS,
    CLAUDE_RETRYABLE_TOKEN_STATUSES,
    CLAUDE_THINKING_BINDING_CONTROLS_BETA,
    CLAUDE_USAGE_PATH,
    claudeCliVersion,
    type ClaudeCacheTtl,
} from './types';
import {
    ClaudeSubscriptionUnauthorizedError,
    parseClaudeScopes,
    type ClaudeSubscriptionCredentials,
} from './credentials';

const OAUTH_TIMEOUT_MS = 30_000;

export interface ClaudePkceMaterial {
    verifier: string;
    challenge: string;
    state: string;
}

/**
 * 生成一对 PKCE 取值。
 *
 * verifier 是 32 字节随机数——RFC 7636 的熵上限——以 base64url 编码，challenge 是它的
 * SHA-256 同编码。**state 是另一次独立的 24 字节抽样**。从 verifier 派生它、或像参照实现
 * 那样把 verifier 当作 state，会把两个本应分开的秘密合成一个，并把 verifier 写进 URL。
 */
export function generateClaudePkce(): ClaudePkceMaterial {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    return { verifier, challenge, state };
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    return undefined;
}

function isHaikuModel(modelId: string): boolean {
    return modelId.toLowerCase().includes('haiku');
}

/**
 * 一次请求的 `anthropic-beta` 集合，顺序稳定。
 *
 * 顺序不可观测（服务端把它当集合解析），所以下面的顺序是为了日志可读而不是为了对齐参照。
 */
export function claudeBetas(options: {
    model?: string;
    thinking?: boolean;
    thinkingBinding?: boolean;
    cacheTtl?: ClaudeCacheTtl;
} = {}): string[] {
    const betas: string[] = [];
    // haiku 排除是参照实现自己的规则：haiku id 不带 claude-code 身份 beta。
    if (options.model === undefined || !isHaikuModel(options.model)) betas.push(CLAUDE_CODE_BETA);
    betas.push(CLAUDE_OAUTH_BETA);
    if (options.thinking === true) betas.push(CLAUDE_INTERLEAVED_THINKING_BETA);
    // 头跟着**请求体**走：block_binding 与一小时缓存档都是需要许可的能力，缺标记会被拒。
    if (options.thinkingBinding === true) betas.push(CLAUDE_THINKING_BINDING_CONTROLS_BETA);
    if (options.cacheTtl === '1h') betas.push(CLAUDE_EXTENDED_CACHE_TTL_BETA);
    return betas;
}

/** 本线路为某个面上报的 User-Agent。 */
export function claudeUserAgent(kind: 'cli' | 'code' = 'cli'): string {
    const version = claudeCliVersion();
    return kind === 'code' ? 'claude-code/' + version : 'claude-cli/' + version + ' (external, cli)';
}

/**
 * 构建一次订阅请求的头。
 *
 * 身份约束在这里集中实现，它们**都不是装饰**：
 * - `authorization: Bearer` 且 **`x-api-key` 必须缺省**（同时携带两者是文档化的 401 成因）；
 * - `user-agent: claude-cli/<版本>` 与 `x-app: cli`；
 * - `anthropic-beta` 至少含 `oauth-2025-04-20` 与 `claude-code-20250219`。
 */
export function claudeSubscriptionHeaders(
    accessToken: string,
    options: {
        model?: string;
        thinking?: boolean;
        thinkingBinding?: boolean;
        cacheTtl?: ClaudeCacheTtl;
        method?: string;
        userAgentKind?: 'cli' | 'code';
        extra?: Record<string, string>;
    } = {},
): Record<string, string> {
    const headers: Record<string, string> = {
        authorization: 'Bearer ' + accessToken,
        'user-agent': claudeUserAgent(options.userAgentKind ?? 'cli'),
        'x-app': 'cli',
        'anthropic-version': CLAUDE_ANTHROPIC_VERSION,
        'anthropic-beta': claudeBetas(options).join(','),
    };
    if ((options.method ?? 'POST').toUpperCase() !== 'GET') headers['content-type'] = 'application/json';
    for (const [key, value] of Object.entries(options.extra ?? {})) {
        // x-api-key 被无条件丢弃：本线路用 bearer 认证，两者并存是文档化的 401 成因。
        if (key.toLowerCase() === 'x-api-key') continue;
        headers[key.toLowerCase()] = value;
    }
    return headers;
}

function accountFromToken(record: Record<string, unknown>): { accountUuid?: string; accountEmail?: string } {
    const account = isRecord(record.account) ? record.account : undefined;
    if (account === undefined) return {};
    const uuid = asString(account.uuid);
    const email = asString(account.email_address);
    return {
        ...(uuid ? { accountUuid: uuid } : {}),
        ...(email ? { accountEmail: email } : {}),
    };
}

/**
 * 防御式解析令牌响应。
 *
 * 每个字段都被校验而不是假定。缺 access token 永远是错误；**兑换**时缺 refresh token 也是
 * ——一份没有它的订阅凭据永远无法续期，存下它只会得到一个看起来已登录、在第一次到期时
 * 就死掉且除了重新登录无路可走的账号。**续期**时该字段按设计是可选的，调用方保留旧值。
 */
export function parseClaudeTokenResponse(
    record: Record<string, unknown>,
    options: { requireRefreshToken: boolean },
): ClaudeSubscriptionCredentials {
    const accessToken = asString(record.access_token);
    if (accessToken === undefined) throw new Error('The Claude token endpoint did not return an access token.');
    const refreshToken = asString(record.refresh_token) ?? '';
    if (options.requireRefreshToken && refreshToken === '') {
        throw new Error('The Claude token endpoint did not return a refresh token.');
    }
    const rawExpiresIn = Number(record.expires_in);
    if (!Number.isFinite(rawExpiresIn) || rawExpiresIn <= 0) {
        throw new Error('The Claude token endpoint returned an invalid token lifetime.');
    }
    const expiresIn = Math.min(Math.max(Math.round(rawExpiresIn), 300), 31_536_000);
    return {
        accessToken,
        refreshToken,
        // 5 分钟提前量就在这条算术里：凭据被当作提前过期，因此恰好在边界前开始的请求
        // 永远不会携带一个已死的令牌。
        expiresAt: Date.now() + expiresIn * 1000 - CLAUDE_REFRESH_MARGIN_MS,
        // 永远是列表形式；缺省 scope 得到**空**列表而不是本线路申请的集合——声称服务端
        // 没有报告的已授予 scope 就是伪造权益。
        scopes: parseClaudeScopes(record.scope),
        ...accountFromToken(record),
    };
}

/** 一个授权流程。 */
export interface ClaudeLogin {
    authUrl: string;
    redirectUri: string;
    state: string;
    /** 浏览器回调完成后结算（凭据已落盘）。 */
    completion: Promise<void>;
    cancel(): void;
}

export interface ClaudeSubscriptionOAuthOptions {
    saveCredentials: (credentials: ClaudeSubscriptionCredentials) => Promise<void>;
    openBrowser: (url: string) => void;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    /** 回调端口；默认从注册端口起顺延探测。 */
    port?: number;
}

function successPage(): string {
    return '<!doctype html><meta charset="utf-8"><title>CWTools</title><h1>Claude sign-in completed / Claude 登录完成</h1><p>You can close this window. / 可以关闭此窗口。</p>';
}

function errorPage(): string {
    return '<!doctype html><meta charset="utf-8"><title>CWTools</title><h1>Claude sign-in failed / Claude 登录失败</h1><p>Return to VS Code for details. / 请返回 VS Code 查看详情。</p>';
}

/**
 * 探测一个可用的回环回调端口。
 *
 * Windows 的动态保留端口段会让固定端口 `listen` 失败，因此从注册端口起顺延探测。
 */
export async function resolveClaudeCallbackPort(
    start = CLAUDE_DEFAULT_CALLBACK_PORT,
    attempts = CLAUDE_CALLBACK_PORT_ATTEMPTS,
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
        `No free local port for the Claude sign-in callback (tried ${attempts} ports from ${start}).`,
        `无法为 Claude 登录回调找到空闲的本地端口（已从 ${start} 起尝试 ${attempts} 个）。`,
    ));
}

/** 构建授权 URL。 */
export function buildClaudeAuthorizeUrl(input: {
    redirectUri: string;
    state: string;
    challenge: string;
}): string {
    const params = new URLSearchParams({
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        response_type: 'code',
        redirect_uri: input.redirectUri,
        scope: CLAUDE_OAUTH_SCOPES,
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: 'S256',
    });
    return `${CLAUDE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenRequestResult {
    ok: boolean;
    status: number;
    record?: Record<string, unknown>;
    detail?: string;
}

/**
 * 向令牌端点 POST 一次授予并分类答案。
 *
 * 分类是重点：401/403 或正文点名一个终局授予错误码是**终局**——凭据已死、重试永远不可能
 * 成功；408/425/429 或 5xx 是**临时**的，抛给调用方的退避循环。
 */
async function postClaudeToken(
    body: URLSearchParams,
    options: { fetchFn: typeof fetch; signal?: AbortSignal },
): Promise<TokenRequestResult> {
    const response = await options.fetchFn(CLAUDE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        signal: timeoutSignal(options.signal, OAUTH_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    let record: Record<string, unknown> | undefined;
    try {
        const parsed: unknown = JSON.parse(text);
        record = isRecord(parsed) ? parsed : undefined;
    } catch { record = undefined; }
    if (response.ok) return { ok: true, status: response.status, ...(record ? { record } : {}) };
    const code = record !== undefined && typeof record.error === 'string' ? record.error : '';
    const final = response.status === 401 || response.status === 403
        || (CLAUDE_FINAL_GRANT_CODES as readonly string[]).includes(code);
    return {
        ok: false,
        status: response.status,
        ...(record ? { record } : {}),
        detail: (final ? 'final:' : 'transient:') + (code || text.slice(0, 160)),
    };
}

function isFinalTokenFailure(result: TokenRequestResult): boolean {
    return result.detail?.startsWith('final:') ?? false;
}

function tokenFailureMessage(result: TokenRequestResult): string {
    const detail = result.detail?.replace(/^(final|transient):/, '') ?? '';
    return 'Claude token request failed (' + result.status + ')' + (detail ? ': ' + detail : '');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
        }
        const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** 用授权码兑换令牌。 */
export async function exchangeClaudeAuthorizationCode(
    input: { code: string; verifier: string; redirectUri: string; state?: string },
    options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ClaudeSubscriptionCredentials> {
    const fetchFn = options.fetchFn ?? fetch;
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        code_verifier: input.verifier,
        ...(input.state ? { state: input.state } : {}),
    });
    const result = await postClaudeToken(body, { fetchFn, ...(options.signal ? { signal: options.signal } : {}) });
    if (!result.ok || result.record === undefined) throw new Error(tokenFailureMessage(result));
    // 兑换时 refresh token 是必需的：没有它这份凭据永远无法续期。
    return parseClaudeTokenResponse(result.record, { requireRefreshToken: true });
}

/**
 * 续期 access token，带官方客户端的**有界重试**。
 *
 * 只有临时状态或传输失败会被重试；401/403（或 `invalid_grant` 正文）是对令牌本身的终局
 * 判定，立即停止——重试它永远不可能成功。
 */
export async function refreshClaudeAccessToken(
    refreshToken: string,
    options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ClaudeSubscriptionCredentials> {
    const fetchFn = options.fetchFn ?? fetch;
    let lastError: unknown;
    for (let attempt = 0; attempt < CLAUDE_REFRESH_MAX_ATTEMPTS; attempt += 1) {
        try {
            const body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLAUDE_OAUTH_CLIENT_ID,
            });
            const result = await postClaudeToken(body, { fetchFn, ...(options.signal ? { signal: options.signal } : {}) });
            if (result.ok && result.record !== undefined) {
                // 续期时 refresh token 是可选的：未轮换时调用方保留旧值。
                return parseClaudeTokenResponse(
                    { refresh_token: refreshToken, ...result.record },
                    { requireRefreshToken: false },
                );
            }
            if (isFinalTokenFailure(result)) {
                throw new ClaudeSubscriptionUnauthorizedError(tokenFailureMessage(result));
            }
            if (!(CLAUDE_RETRYABLE_TOKEN_STATUSES as readonly number[]).includes(result.status)) {
                throw new Error(tokenFailureMessage(result));
            }
            lastError = new Error(tokenFailureMessage(result));
        } catch (error) {
            if (error instanceof ClaudeSubscriptionUnauthorizedError) throw error;
            lastError = error;
        }
        if (attempt < CLAUDE_REFRESH_MAX_ATTEMPTS - 1) {
            await sleep(CLAUDE_REFRESH_BACKOFF_BASE_MS * 2 ** attempt, options.signal);
        }
    }
    throw new Error('Claude token refresh failed after retries: '
        + (lastError instanceof Error ? lastError.message : String(lastError)));
}

/**
 * 拥有 Claude 订阅登录流程的会话。
 *
 * 回调服务只绑回环、只应答 `/callback`，并在收到授权码后**一次**兑换：浏览器回调与手动
 * 粘贴可能同时到达，用 compare-and-set 保证只有一方发起兑换。
 */
export class ClaudeSubscriptionOAuthService {
    private activeCancel?: (reason?: Error) => void;

    constructor(private readonly options: ClaudeSubscriptionOAuthOptions) {}

    async startLogin(): Promise<ClaudeLogin> {
        this.activeCancel?.(new Error(aiText(
            'A newer Claude sign-in was started.',
            '已开始新的 Claude 登录。',
        )));
        const fetchFn = this.options.fetchFn ?? fetch;
        const pkce = generateClaudePkce();
        const port = this.options.port ?? await resolveClaudeCallbackPort();
        const redirectUri = `http://127.0.0.1:${port}${CLAUDE_CALLBACK_PATH}`;
        const authUrl = buildClaudeAuthorizeUrl({ redirectUri, state: pkce.state, challenge: pkce.challenge });

        let settled = false;
        let resolveCompletion!: () => void;
        let rejectCompletion!: (error: Error) => void;
        const completion = new Promise<void>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        completion.catch(() => undefined);

        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            if (timer.current) clearTimeout(timer.current);
            this.activeCancel = undefined;
            server.close();
            if (error) rejectCompletion(error);
            else resolveCompletion();
        };
        const cancel = (reason?: Error): void => {
            finish(reason ?? new Error(aiText('Claude sign-in was cancelled.', 'Claude 登录已取消。')));
        };
        this.activeCancel = cancel;
        const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined };

        const server = http.createServer((request, response) => {
            void (async () => {
                const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
                if (url.pathname !== CLAUDE_CALLBACK_PATH) {
                    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                    response.end('Not found');
                    return;
                }
                const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                // 错误的 state **只拒绝那一个请求**，不会终止正在进行的合法登录。
                if (error || !code || state !== pkce.state) {
                    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
                    response.end(errorPage());
                    return;
                }
                if (settled) {
                    // 已经结算的流程不做任何兑换。
                    response.writeHead(410, { 'content-type': 'text/html; charset=utf-8' });
                    response.end(errorPage());
                    return;
                }
                settled = true;
                try {
                    const credentials = await exchangeClaudeAuthorizationCode(
                        { code, verifier: pkce.verifier, redirectUri, state },
                        { fetchFn },
                    );
                    await this.options.saveCredentials(credentials);
                    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                    response.end(successPage());
                    this.activeCancel = undefined;
                    if (timer.current) clearTimeout(timer.current);
                    server.close();
                    resolveCompletion();
                } catch (exchangeError) {
                    response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
                    response.end(errorPage());
                    this.activeCancel = undefined;
                    if (timer.current) clearTimeout(timer.current);
                    server.close();
                    rejectCompletion(exchangeError instanceof Error ? exchangeError : new Error(String(exchangeError)));
                }
            })();
        });

        await new Promise<void>((resolve, reject) => {
            const onError = (failure: Error) => reject(failure);
            server.once('error', onError);
            server.listen(port, '127.0.0.1', () => {
                server.off('error', onError);
                resolve();
            });
        }).catch((failure: unknown) => {
            server.close();
            throw new Error(aiText(
                `Could not start the Claude OAuth callback on port ${port}: ${failure instanceof Error ? failure.message : String(failure)}`,
                `无法在端口 ${port} 启动 Claude OAuth 回调：${failure instanceof Error ? failure.message : String(failure)}`,
            ));
        });

        timer.current = setTimeout(() => cancel(new Error(aiText(
            'Timed out waiting for Claude sign-in.',
            '等待 Claude 登录超时。',
        ))), this.options.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS);
        try { this.options.openBrowser(authUrl); } catch { /* 卡片始终渲染链接 */ }

        return { authUrl, redirectUri, state: pkce.state, completion, cancel: () => cancel() };
    }

    dispose(): void {
        this.activeCancel?.();
        this.activeCancel = undefined;
    }
}

/** 订阅用量 URL。 */
export function claudeUsageUrl(): string {
    return CLAUDE_API_BASE + CLAUDE_USAGE_PATH;
}

/** 默认缓存档位（导出以便调用方与测试对齐）。 */
export const CLAUDE_DEFAULT_CACHE_TTL_VALUE = CLAUDE_DEFAULT_CACHE_TTL;

export { CLAUDE_OAUTH_MANUAL_REDIRECT_URI };