/**
 * MiniMax Code 设备码登录（RFC 8628 + PKCE S256）与凭据续期。
 *
 * 两个必须照抄官方客户端的细节：
 * - 设备码流程无需回调端口，因此无浏览器环境也能手工完成；
 * - `slow_down` 按 RFC **永久**加宽轮询间隔，而不是只跳过一轮。
 *
 * 凭据只有能回答一次令牌请求之后才落盘：一个换不来令牌的 refresh token 存下来只会让
 * 用户看到一个看起来已登录、实际每次调用都失败的账号。
 */

import { createHash, randomBytes } from 'crypto';
import { isRecord } from '../../../shared/protocolValidation';
import { aiText } from '../messages';
import {
    MINIMAX_CODE_AGENT_LLM_PREFIX,
    MINIMAX_CODE_AUDIENCE,
    MINIMAX_CODE_CLIENT_ID,
    MINIMAX_CODE_DEVICE_CODE_GRANT_TYPE,
    MINIMAX_CODE_DEVICE_CODE_PATH,
    MINIMAX_CODE_DEVICE_EXPIRES_FALLBACK_SECONDS,
    MINIMAX_CODE_DEVICE_INTERVAL_FALLBACK_SECONDS,
    MINIMAX_CODE_LOGIN_TIMEOUT_MS,
    MINIMAX_CODE_MESSAGES_PATH,
    MINIMAX_CODE_OAUTH_TIMEOUT_MS,
    MINIMAX_CODE_OAUTH_TOKEN_PATH,
    MINIMAX_CODE_PKCE_CHALLENGE_METHOD,
    MINIMAX_CODE_PRE_EXPIRY_REFRESH_MS,
    MINIMAX_CODE_PROVIDER_NAME,
    MINIMAX_CODE_REGION_HOSTS,
    MINIMAX_CODE_SCOPE,
    type MinimaxCodeRegion,
} from './types';
import {
    writeBackMinimaxCodeDesktopCredential,
    type MinimaxCodeCredentials,
} from './credentials';

export interface MinimaxCodeDeviceAuthorization {
    userCode: string;
    deviceCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
    /** PKCE verifier 必须留到兑换时使用，绝不进入授权 URL。 */
    codeVerifier: string;
    region: MinimaxCodeRegion;
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

function oauthErrorFields(payload: unknown): { code: string; description: string } {
    const root = isRecord(payload) ? payload : {};
    const nested = isRecord(root.error) ? root.error : undefined;
    if (nested !== undefined) {
        return {
            code: asString(nested.code) ?? '',
            description: String(nested.message ?? nested.error_description ?? nested.detail ?? nested.type ?? ''),
        };
    }
    return {
        code: asString(root.error) ?? '',
        description: String(root.error_description ?? root.error_message ?? ''),
    };
}

/** PKCE S256：verifier 的 SHA-256 以 base64url 编码。 */
export function minimaxCodePkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

/** 生成一对 PKCE 取值。 */
export function generateMinimaxCodePkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(48).toString('base64url');
    return { verifier, challenge: minimaxCodePkceChallenge(verifier) };
}

/** 启动设备授权（RFC 8628 §3.1 + PKCE S256）。 */
export async function requestMinimaxCodeDeviceAuthorization(options: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    region?: MinimaxCodeRegion;
} = {}): Promise<MinimaxCodeDeviceAuthorization> {
    const fetchFn = options.fetchFn ?? fetch;
    const region = options.region ?? 'cn';
    const host = MINIMAX_CODE_REGION_HOSTS[region].account;
    const { verifier, challenge } = generateMinimaxCodePkce();
    const response = await fetchFn(host + MINIMAX_CODE_DEVICE_CODE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
            client_id: MINIMAX_CODE_CLIENT_ID,
            scope: MINIMAX_CODE_SCOPE,
            audience: MINIMAX_CODE_AUDIENCE,
            code_challenge: challenge,
            code_challenge_method: MINIMAX_CODE_PKCE_CHALLENGE_METHOD,
        }).toString(),
        signal: timeoutSignal(options.signal, MINIMAX_CODE_OAUTH_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
        const { description } = oauthErrorFields(payload);
        throw new Error(MINIMAX_CODE_PROVIDER_NAME + ' device authorization failed (' + response.status + ')'
            + (description ? ': ' + description : ''));
    }
    const record = isRecord(payload) ? payload : {};
    const userCode = asString(record.user_code);
    const deviceCode = asString(record.device_code);
    const complete = asString(record.verification_uri_complete) ?? asString(record.verification_uri);
    if (!userCode || !deviceCode || !complete) {
        throw new Error(MINIMAX_CODE_PROVIDER_NAME + ' device authorization did not return a device code and verification URL.');
    }
    const expiresIn = asNumber(record.expires_in);
    const interval = asNumber(record.interval);
    return {
        userCode,
        deviceCode,
        verificationUri: asString(record.verification_uri) ?? '',
        verificationUriComplete: complete,
        expiresIn: expiresIn !== undefined && expiresIn > 0 ? expiresIn : MINIMAX_CODE_DEVICE_EXPIRES_FALLBACK_SECONDS,
        interval: interval !== undefined && interval > 0 ? interval : MINIMAX_CODE_DEVICE_INTERVAL_FALLBACK_SECONDS,
        codeVerifier: verifier,
        region,
    };
}

export type MinimaxCodePollOutcome =
    | { kind: 'success'; credentials: MinimaxCodeCredentials }
    | { kind: 'pending'; slowDown: boolean }
    | { kind: 'expired' };

/** 轮询一次设备令牌（RFC 8628 §3.4）。 */
export async function pollMinimaxCodeDeviceToken(
    authorization: MinimaxCodeDeviceAuthorization,
    options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<MinimaxCodePollOutcome> {
    const fetchFn = options.fetchFn ?? fetch;
    const host = MINIMAX_CODE_REGION_HOSTS[authorization.region].account;
    const response = await fetchFn(host + MINIMAX_CODE_OAUTH_TOKEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
            client_id: MINIMAX_CODE_CLIENT_ID,
            device_code: authorization.deviceCode,
            grant_type: MINIMAX_CODE_DEVICE_CODE_GRANT_TYPE,
            code_verifier: authorization.codeVerifier,
        }).toString(),
        signal: timeoutSignal(options.signal, MINIMAX_CODE_OAUTH_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    const record = isRecord(payload) ? payload : {};
    if (response.status === 200 && typeof record.access_token === 'string' && record.access_token !== '') {
        const expiresIn = asNumber(record.expires_in);
        const lifetime = expiresIn !== undefined && expiresIn > 0 ? expiresIn : 3600;
        return {
            kind: 'success',
            credentials: {
                accessToken: record.access_token,
                refreshToken: asString(record.refresh_token) ?? '',
                expiresAt: Date.now() + lifetime * 1000,
                region: authorization.region,
                source: 'managed',
                sourceFile: '',
                recordKey: 'managed',
            },
        };
    }
    // 5xx 是传输类失败而不是对设备码的判定，抛给调用方的退避循环，而不是读作「仍在等待」。
    if (response.status >= 500) {
        throw new Error(MINIMAX_CODE_PROVIDER_NAME + ' token polling server error: ' + response.status + '.');
    }
    const { code, description } = oauthErrorFields(payload);
    if (code === 'authorization_pending') return { kind: 'pending', slowDown: false };
    if (code === 'slow_down') return { kind: 'pending', slowDown: true };
    if (code === 'expired_token') return { kind: 'expired' };
    if (code === 'access_denied') {
        throw new Error(description || aiText('The MiniMax Code authorization request was denied.', 'MiniMax Code 授权请求被拒绝。'));
    }
    throw new Error(description || MINIMAX_CODE_PROVIDER_NAME + ' token polling failed (' + response.status + ').');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('aborted'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export interface MinimaxCodeLogin {
    authorization: MinimaxCodeDeviceAuthorization;
    completion: Promise<void>;
    cancel(): void;
}

export interface MinimaxCodeOAuthOptions {
    saveCredentials: (credentials: MinimaxCodeCredentials) => Promise<void>;
    openBrowser: (url: string) => void;
    fetchFn?: typeof fetch;
    region?: MinimaxCodeRegion;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onUserCode?: (authorization: MinimaxCodeDeviceAuthorization) => void;
}

/** 拥有 MiniMax Code 设备码登录流程的会话。 */
export class MinimaxCodeOAuthService {
    private activeCancel?: (reason?: Error) => void;

    constructor(private readonly options: MinimaxCodeOAuthOptions) {}

    async startLogin(region?: MinimaxCodeRegion): Promise<MinimaxCodeLogin> {
        this.activeCancel?.(new Error(aiText(
            'A newer MiniMax Code sign-in was started.',
            '已开始新的 MiniMax Code 登录。',
        )));
        const fetchFn = this.options.fetchFn ?? fetch;
        const resolvedRegion = region ?? this.options.region ?? 'cn';
        const authorization = await requestMinimaxCodeDeviceAuthorization({
            fetchFn,
            region: resolvedRegion,
        });
        this.options.onUserCode?.(authorization);
        try { this.options.openBrowser(authorization.verificationUriComplete); } catch { /* 卡片始终渲染链接 */ }

        const controller = new AbortController();
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
            this.activeCancel = undefined;
            if (error) rejectCompletion(error);
            else resolveCompletion();
        };
        const cancel = (reason?: Error): void => {
            const failure = reason ?? new Error(aiText('MiniMax Code sign-in was cancelled.', 'MiniMax Code 登录已取消。'));
            controller.abort(failure);
            finish(failure);
        };
        this.activeCancel = cancel;

        const deadline = Date.now() + (this.options.timeoutMs ?? MINIMAX_CODE_LOGIN_TIMEOUT_MS);
        const baseInterval = this.options.pollIntervalMs ?? 0;
        void (async () => {
            try {
                let current = authorization;
                let interval = baseInterval > 0 ? baseInterval / 1000 : Math.max(current.interval, 1);
                while (true) {
                    if (controller.signal.aborted) return;
                    if (Date.now() > deadline) {
                        finish(new Error(aiText('MiniMax Code sign-in timed out.', 'MiniMax Code 登录超时。')));
                        return;
                    }
                    const outcome = await pollMinimaxCodeDeviceToken(current, { fetchFn, signal: controller.signal });
                    if (outcome.kind === 'success') {
                        // refresh token 单次使用：缺它的话凭据一小时后必然失效并再次要求登录。
                        if (!outcome.credentials.refreshToken) {
                            throw new Error(aiText(
                                'MiniMax Code returned no refresh token, so the session could not be renewed.',
                                'MiniMax Code 未返回 refresh token，会话无法续期。',
                            ));
                        }
                        await this.options.saveCredentials(outcome.credentials);
                        finish();
                        return;
                    }
                    if (outcome.kind === 'expired') {
                        // 不是终局：用一份新的设备码重新开始，让动作慢的用户仍能登录。
                        current = await requestMinimaxCodeDeviceAuthorization({ fetchFn, region: resolvedRegion });
                        this.options.onUserCode?.(current);
                        interval = baseInterval > 0 ? baseInterval / 1000 : Math.max(current.interval, 1);
                        continue;
                    }
                    // RFC 8628：slow_down 永久加宽轮询间隔。
                    if (outcome.slowDown) interval += 5;
                    await sleep(interval * 1000, controller.signal);
                }
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        })();

        return { authorization, completion, cancel: () => cancel() };
    }

    dispose(): void {
        this.activeCancel?.();
        this.activeCancel = undefined;
    }
}

/** 本线路的 Anthropic Messages 端点。 */
export function minimaxCodeMessagesUrl(region: MinimaxCodeRegion): string {
    return MINIMAX_CODE_REGION_HOSTS[region].agent + MINIMAX_CODE_AGENT_LLM_PREFIX + MINIMAX_CODE_MESSAGES_PATH;
}

/**
 * 续期 access token。
 *
 * 刷新令牌是**单次使用**的，因此这里做两件事：
 * - 轮换按凭据单飞（同进程并发调用共用一次），否则除第一个之外全部拿到 `invalid_grant`；
 * - 桌面端凭据轮换后原子写回原文件，桌面端不会手里剩一个已作废的 token。
 */
export async function refreshMinimaxCodeCredentials(
    credentials: MinimaxCodeCredentials,
    options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<MinimaxCodeCredentials> {
    const fetchFn = options.fetchFn ?? fetch;
    const host = MINIMAX_CODE_REGION_HOSTS[credentials.region].account;
    const response = await fetchFn(host + MINIMAX_CODE_OAUTH_TOKEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
            client_id: MINIMAX_CODE_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: credentials.refreshToken,
        }).toString(),
        signal: timeoutSignal(options.signal, MINIMAX_CODE_OAUTH_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    const record = isRecord(payload) ? payload : {};
    if (response.status === 401 || response.status === 403) {
        // The status travels with the error: the pool reads it to decide this credential
        // is DEAD. Without it a rejected refresh is treated as a transient failure, the
        // account keeps its place, and every later turn 401s against the same token.
        throw Object.assign(
            new Error(aiText(
                'MiniMax Code rejected the stored refresh token. Sign in again.',
                'MiniMax Code 拒绝了已保存的 refresh token，请重新登录。',
            )),
            { status: response.status },
        );
    }
    if (!response.ok) {
        const { description } = oauthErrorFields(payload);
        throw new Error(MINIMAX_CODE_PROVIDER_NAME + ' token refresh failed (' + response.status + ')'
            + (description ? ': ' + description : ''));
    }
    const accessToken = asString(record.access_token);
    if (!accessToken) throw new Error(MINIMAX_CODE_PROVIDER_NAME + ' token refresh returned no access token.');
    const expiresIn = asNumber(record.expires_in);
    const lifetime = expiresIn !== undefined && expiresIn > 0 ? expiresIn : 3600;
    const next: MinimaxCodeCredentials = {
        ...credentials,
        accessToken,
        // 未返回新 refresh token 时沿用旧值，而不是当作失败。
        refreshToken: asString(record.refresh_token) ?? credentials.refreshToken,
        expiresAt: Date.now() + lifetime * 1000,
    };
    writeBackMinimaxCodeDesktopCredential(next);
    return next;
}

/** 续期窗口：提前 5 分钟，避开服务端开始拒收的时刻。 */
export function minimaxCodeNeedsRefresh(credentials: MinimaxCodeCredentials): boolean {
    if (credentials.expiresAt <= 0) return false;
    return credentials.expiresAt - Date.now() < MINIMAX_CODE_PRE_EXPIRY_REFRESH_MS;
}
