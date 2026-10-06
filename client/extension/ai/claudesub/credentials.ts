/**
 * Claude 订阅 OAuth 凭据存储。
 *
 * ⚠️ 风险须知：Anthropic 条款不允许第三方应用以订阅凭据转发请求。使用风险自担。
 *
 * 凭据存进 VS Code SecretStorage，与手动粘贴的 API Key 槽位分开（`claude` 线路继续只支持
 * API Key，两者互不覆盖）。
 */

import { isRecord } from '../../../shared/protocolValidation';
import { CLAUDE_REFRESH_MARGIN_MS } from './types';

export const CLAUDE_SUBSCRIPTION_SECRET_KEY = 'cwtools.ai.claudeSubscription.oauth.v1';

export interface ClaudeSubscriptionCredentials {
    accessToken: string;
    refreshToken: string;
    /** 已把续期提前量算进去的到期时刻。 */
    expiresAt: number;
    scopes: string[];
    accountUuid?: string;
    accountEmail?: string;
}

/** refresh token 被服务端拒绝（终局，需要重新登录）。 */
export class ClaudeSubscriptionUnauthorizedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ClaudeSubscriptionUnauthorizedError';
    }
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    return undefined;
}

/**
 * 把 scope 值拆成存储记录的列表。
 *
 * 两种形状都接受：RFC 6749 把 `scope` 定为一个空格分隔的字符串，而某个 SDK 包装可能回
 * 一个数组。归一化在**线协议边界**完成，因此本模块写下的凭据永远是列表形式——留下字符串
 * 会在下游解析成零个 scope，并把一份完全可用的凭据当成「不是订阅凭据」拒绝。
 */
export function parseClaudeScopes(value: unknown): string[] {
    const entries = typeof value === 'string' ? value.split(/\s+/) : Array.isArray(value) ? value : [];
    const scopes: string[] = [];
    for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        const scope = entry.trim();
        if (scope !== '') scopes.push(scope);
    }
    return scopes;
}

/** 从存储读回凭据；形状不合法时返回 undefined。 */
export function parseClaudeSubscriptionCredentials(raw: string | undefined): ClaudeSubscriptionCredentials | undefined {
    if (!raw) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return undefined; }
    if (!isRecord(value)) return undefined;
    const accessToken = asString(value.accessToken);
    const refreshToken = asString(value.refreshToken);
    if (accessToken === undefined || refreshToken === undefined) return undefined;
    const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
        ? value.expiresAt
        : 0;
    return {
        accessToken,
        refreshToken,
        expiresAt,
        scopes: parseClaudeScopes(value.scopes),
        ...(asString(value.accountUuid) ? { accountUuid: asString(value.accountUuid) } : {}),
        ...(asString(value.accountEmail) ? { accountEmail: asString(value.accountEmail) } : {}),
    };
}

/**
 * 一份凭据是否**是**订阅凭据。
 *
 * 判据是 `user:inference`：它才是让令牌可用于 `/v1/messages` 的那个 scope。缺它的令牌能
 * 通过认证，但在本 Provider 存在的路由上被拒；fail-closed 地拒绝它比发出一个必然失败的
 * 请求更有用。
 */
export function isClaudeSubscriptionCredential(credentials: ClaudeSubscriptionCredentials): boolean {
    return credentials.scopes.includes('user:inference');
}

/** 凭据是否仍在有效期内（到期时刻已含续期提前量）。 */
export function isClaudeSubscriptionCredentialFresh(
    credentials: ClaudeSubscriptionCredentials,
    marginMs = 60_000,
): boolean {
    if (credentials.expiresAt <= 0) return true;
    return credentials.expiresAt - Date.now() > marginMs;
}

/** 续期窗口的剩余时间（负值表示已进入窗口）。 */
export function claudeSubscriptionRefreshIn(credentials: ClaudeSubscriptionCredentials): number {
    return credentials.expiresAt - Date.now();
}

/** 续期提前量，供测试与卡片展示。 */
export const CLAUDE_SUBSCRIPTION_REFRESH_MARGIN_MS = CLAUDE_REFRESH_MARGIN_MS;

/** 托管凭据的持久化端口；方法返回 Thenable 以匹配 VS Code 的 SecretStorage。 */
export interface ClaudeSubscriptionSecretPort {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

export class ClaudeSubscriptionCredentialStore {
    /** 进行中的续期，按它们所属的 refresh token 归类。 */
    private readonly refreshPromises = new Map<string, Promise<ClaudeSubscriptionCredentials>>();
    /** 进程级的「刚被拒」墓碑：同一枚 refresh token 不该被反复送去撞墙。 */
    private readonly rejected = new Set<string>();

    constructor(private readonly secrets: ClaudeSubscriptionSecretPort) {}

    async read(): Promise<ClaudeSubscriptionCredentials | undefined> {
        return parseClaudeSubscriptionCredentials(await this.secrets.get(CLAUDE_SUBSCRIPTION_SECRET_KEY));
    }

    async save(credentials: ClaudeSubscriptionCredentials): Promise<void> {
        await this.secrets.store(CLAUDE_SUBSCRIPTION_SECRET_KEY, JSON.stringify(credentials));
        this.rejected.delete(credentials.refreshToken);
    }

    async clear(): Promise<void> {
        await this.secrets.delete(CLAUDE_SUBSCRIPTION_SECRET_KEY);
    }

    /** 该 refresh token 是否刚被服务端拒绝。 */
    isRejected(refreshToken: string): boolean {
        return this.rejected.has(refreshToken);
    }

    markRejected(refreshToken: string): void {
        this.rejected.add(refreshToken);
    }

    /**
     * 取一份可用的凭据，必要时续期。
     *
     * **刷新是单飞的**：并发请求共享同一次刷新。否则到期瞬间的一批请求会各自轮换刷新
     * 令牌，除第一个之外全部作废（上游会给出终局判定）。
     */
    async ensure(
        refresh: (credentials: ClaudeSubscriptionCredentials) => Promise<ClaudeSubscriptionCredentials>,
        options: { force?: boolean } = {},
    ): Promise<ClaudeSubscriptionCredentials | undefined> {
        const credentials = await this.read();
        if (credentials === undefined) return undefined;
        if (options.force !== true && isClaudeSubscriptionCredentialFresh(credentials)) return credentials;
        if (this.isRejected(credentials.refreshToken)) {
            throw new ClaudeSubscriptionUnauthorizedError(
                'Claude rejected the stored refresh token. Sign in again.',
            );
        }
        // 按 refresh token 单飞：号池里可能有多个账号，一个全局槽位会把账号 A 的续期结果
        // 交给账号 B。
        const key = credentials.refreshToken;
        const inFlight = this.refreshPromises.get(key);
        if (inFlight !== undefined) return inFlight;
        const task = refresh(credentials)
            .then(async next => {
                // 轮换后先落盘再返回：否则并发的第二个调用者会读到旧令牌。
                // 只有本凭据仍占着单凭据槽位时才写回，避免覆盖别的账号。
                const stored = await this.read();
                if (stored === undefined || stored.refreshToken === credentials.refreshToken) {
                    await this.save(next);
                }
                return next;
            })
            .catch((error: unknown) => {
                if (error instanceof ClaudeSubscriptionUnauthorizedError) {
                    this.markRejected(credentials.refreshToken);
                }
                throw error;
            })
            .finally(() => {
                if (this.refreshPromises.get(key) === task) this.refreshPromises.delete(key);
            });
        this.refreshPromises.set(key, task);
        return task;
    }
}
