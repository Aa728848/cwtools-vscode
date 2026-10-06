/**
 * Kimi Code 订阅凭据的持久化与续期。
 *
 * 凭据存进 VS Code SecretStorage（与手动粘贴的 API Key 分开一个槽位，两者互不覆盖）：
 * 设备码登录写的是 `{accessToken, refreshToken, expiresAt, expiresIn}`，因为 access token
 * 会过期，必须能续期；手填的 API Key 不会过期，继续留在原来的槽位里。
 *
 * 三条纪律：
 * - **续期窗口按官方客户端**：`max(300s, expires_in × 0.5)`，短命令牌也留足提前量；
 * - **同进程单飞**：到期瞬间的一批请求共用一次刷新，否则除第一个之外全部拿到
 *   `invalid_grant`；
 * - **被拒的 refresh token 进入冷却**：同一个令牌不该被反复送去撞墙，卡片据此提示
 *   重新登录。
 */

import type * as vscode from 'vscode';
import { isRecord } from '../../../shared/protocolValidation';

/** SecretStorage 槽位；与 `cwtools.ai.apiKey.kimi-code-plan` 分开，两种来源互不覆盖。 */
export const KIMI_CODE_CREDENTIAL_KEY = 'cwtools.ai.kimiCode.oauth.v1';

export const KIMI_OAUTH_TOKEN_PATH = '/api/oauth/token';
export const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
/** 续期窗口下限与比例，抄自官方客户端。 */
export const KIMI_MIN_REFRESH_THRESHOLD_SECONDS = 300;
export const KIMI_REFRESH_THRESHOLD_RATIO = 0.5;
/** 被拒的 refresh token 记多久。 */
export const KIMI_REJECTED_COOLDOWN_MS = 300_000;
/** 一次刷新最多尝试几次（只重试瞬时失败）。 */
export const KIMI_REFRESH_MAX_RETRIES = 3;
export const KIMI_REFRESH_BACKOFF_BASE_MS = 1_000;

/** 可重试的刷新状态：与令牌本身无关的临时失败。 */
const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface KimiCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    expiresIn: number;
}

/** refresh token 被服务端拒绝（终局，需要重新登录）。 */
export class KimiUnauthorizedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KimiUnauthorizedError';
    }
}

function parseCredentials(raw: string | undefined): KimiCredentials | undefined {
    if (!raw) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return undefined; }
    if (!isRecord(value)) return undefined;
    const { accessToken, refreshToken, expiresAt, expiresIn } = value;
    if (typeof accessToken !== 'string' || accessToken === '') return undefined;
    if (typeof refreshToken !== 'string' || refreshToken === '') return undefined;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined;
    return {
        accessToken,
        refreshToken,
        expiresAt,
        expiresIn: typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    };
}

/** 令牌到期前必须替换的时长，由令牌自己的寿命决定。 */
export function kimiRefreshThresholdMs(expiresIn: number): number {
    return Math.max(KIMI_MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * KIMI_REFRESH_THRESHOLD_RATIO) * 1000;
}

export class KimiCodeTokenStore {
    private refreshPromise?: Promise<KimiCredentials>;
    /** 进程级的「刚被拒」墓碑：同一枚 refresh token 不该被反复送去撞墙。 */
    private rejected = new Map<string, number>();

    constructor(
        private readonly secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>,
        private readonly fetchFn: typeof fetch = fetch,
        private readonly identityHeaders: (extra?: Record<string, string>) => Promise<Record<string, string>>,
        private readonly oauthHost: string,
    ) {}

    async read(): Promise<KimiCredentials | undefined> {
        return parseCredentials(await this.secrets.get(KIMI_CODE_CREDENTIAL_KEY));
    }

    async save(credentials: KimiCredentials): Promise<void> {
        await this.secrets.store(KIMI_CODE_CREDENTIAL_KEY, JSON.stringify(credentials));
        this.rejected.delete(credentials.refreshToken);
    }

    async clear(): Promise<void> {
        await this.secrets.delete(KIMI_CODE_CREDENTIAL_KEY);
    }

    /** 该 refresh token 是否刚被服务端拒绝（卡片据此提示重新登录）。 */
    isRejected(refreshToken: string): boolean {
        const until = this.rejected.get(refreshToken);
        if (until === undefined) return false;
        if (until <= Date.now()) {
            this.rejected.delete(refreshToken);
            return false;
        }
        return true;
    }

    /**
     * 取一个可用的 access token，必要时续期并落盘。
     *
     * 并发调用共用一次刷新：订阅线路有速率限制，到期瞬间的一批工具调用否则会各自
     * 轮换同一枚 refresh token。
     */
    async ensureAccessToken(options: { force?: boolean } = {}): Promise<string | undefined> {
        const credentials = await this.read();
        if (credentials === undefined) return undefined;
        const threshold = kimiRefreshThresholdMs(credentials.expiresIn);
        if (options.force !== true && credentials.expiresAt - Date.now() > threshold) {
            return credentials.accessToken;
        }
        if (this.isRejected(credentials.refreshToken)) {
            throw new KimiUnauthorizedError('Kimi Code rejected the stored refresh token. Sign in again.');
        }
        if (this.refreshPromise !== undefined) return (await this.refreshPromise).accessToken;
        this.refreshPromise = this.refresh(credentials).finally(() => { this.refreshPromise = undefined; });
        return (await this.refreshPromise).accessToken;
    }

    /**
     * Rotate one stored credential and persist it.
     *
     * Exposed for the account pool, which owns rotation bookkeeping now: it calls
     * this for the account it selected, and the single-flight below still keeps
     * concurrent callers from spending the same refresh token twice.
     */
    async refreshStored(credentials: KimiCredentials): Promise<KimiCredentials> {
        if (this.refreshPromise !== undefined) return this.refreshPromise;
        const task = this.refresh(credentials).finally(() => { this.refreshPromise = undefined; });
        this.refreshPromise = task;
        return task;
    }

    private async refresh(credentials: KimiCredentials): Promise<KimiCredentials> {
        let lastError: unknown;
        for (let attempt = 0; attempt < KIMI_REFRESH_MAX_RETRIES; attempt += 1) {
            try {
                const response = await this.fetchFn(`${this.oauthHost}${KIMI_OAUTH_TOKEN_PATH}`, {
                    method: 'POST',
                    headers: await this.identityHeaders({
                        'content-type': 'application/x-www-form-urlencoded',
                        accept: 'application/json',
                    }),
                    body: new URLSearchParams({
                        client_id: KIMI_CODE_CLIENT_ID,
                        grant_type: 'refresh_token',
                        refresh_token: credentials.refreshToken,
                    }).toString(),
                    signal: AbortSignal.timeout(30_000),
                });
                const payload: unknown = await response.json().catch(() => undefined);
                const record = isRecord(payload) ? payload : {};
                const code = isRecord(record.error)
                    ? (typeof record.error.code === 'string' ? record.error.code : '')
                    : (typeof record.error === 'string' ? record.error : '');
                // 401/403 或 invalid_grant 是对令牌本身的判定，重试永远不可能成功。
                if (response.status === 401 || response.status === 403 || code === 'invalid_grant') {
                    this.rejected.set(credentials.refreshToken, Date.now() + KIMI_REJECTED_COOLDOWN_MS);
                    throw new KimiUnauthorizedError('Kimi Code rejected the stored refresh token. Sign in again.');
                }
                if (response.ok) {
                    const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
                    if (accessToken === '') throw new Error('Kimi Code refresh returned no access token.');
                    const expiresIn = Number(record.expires_in);
                    const next: KimiCredentials = {
                        accessToken,
                        // 未返回新 refresh token 时沿用旧值，而不是当作失败。
                        refreshToken: typeof record.refresh_token === 'string' && record.refresh_token !== ''
                            ? record.refresh_token
                            : credentials.refreshToken,
                        expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
                        expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
                    };
                    await this.save(next);
                    return next;
                }
                if (!RETRYABLE_REFRESH_STATUSES.has(response.status)) {
                    throw new Error(`Kimi Code token refresh failed (HTTP ${response.status}).`);
                }
                lastError = new Error(`Kimi Code token refresh failed (HTTP ${response.status}).`);
            } catch (error) {
                if (error instanceof KimiUnauthorizedError) throw error;
                lastError = error;
            }
            if (attempt < KIMI_REFRESH_MAX_RETRIES - 1) {
                await new Promise(resolve => setTimeout(resolve, KIMI_REFRESH_BACKOFF_BASE_MS * 2 ** attempt));
            }
        }
        throw new Error(`Kimi Code token refresh failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
}
