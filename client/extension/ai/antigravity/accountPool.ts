/**
 * Antigravity 的多账号号池。
 *
 * 复用 provider 无关的通用工厂（`pool/oauthAccountPool.ts`），只声明 Antigravity 自己的
 * 身份键与失败分类；存储、迁移、镜像、轮转与冷却都来自共享实现。
 *
 * **身份键不是令牌**：Google 的 access/refresh token 每次轮换都会变，用令牌做键会在每次
 * 续期后把同一账号看成新账号并产生幽灵行。身份取凭据里的 email（同一个人重登即同一
 * 账号），没有 email 时回落到 `recordKey`（同一次登录会话的稳定标识）。
 */

import {
    OAuthAccountPool,
    oauthRefreshFailureStatus,
    parseOAuthPoolData as parseOAuthPoolDataShared,
    type OAuthPoolPorts,
    type OAuthPoolSpec,
} from '../pool/oauthAccountPool';

/** 号池槽位；与单凭据槽位并列，迁移时读旧写新。 */
export const ANTIGRAVITY_POOL_KEY = 'cwtools.ai.antigravity.pool.v1';

/** 续期前多久开始轮换（与单凭据路径一致）。 */
export const ANTIGRAVITY_REFRESH_MARGIN_MS = 60_000;

export interface AntigravityPoolCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    email?: string;
    /**
     * 同一次登录会话的稳定标识。
     *
     * 凭据里没有 email 时用它做身份键：一个槽位每次轮换都是同一账号，因此池里原地更新，
     * 而不是每次续期都长出一行。
     */
    recordKey?: string;
}

function nonempty(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

/** 一个凭据的身份键：优先 email，其次登录会话标识。 */
export function antigravityAccountKey(credentials: AntigravityPoolCredentials): string | undefined {
    const email = nonempty(credentials.email) ? credentials.email.trim() : undefined;
    if (email !== undefined) return 'email:' + email.toLowerCase();
    const record = nonempty(credentials.recordKey) ? credentials.recordKey.trim() : undefined;
    return record === undefined ? undefined : 'record:' + record;
}

/** 解析一份池内凭据；形状不合法时返回 undefined。 */
export function parseAntigravityPoolCredentials(value: unknown): AntigravityPoolCredentials | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const accessToken = nonempty(record.accessToken) ? record.accessToken : undefined;
    const refreshToken = nonempty(record.refreshToken) ? record.refreshToken : undefined;
    const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt : undefined;
    if (accessToken === undefined || refreshToken === undefined || expiresAt === undefined) return undefined;
    const email = nonempty(record.email) ? record.email : undefined;
    const recordKey = nonempty(record.recordKey) ? record.recordKey : undefined;
    return {
        accessToken, refreshToken, expiresAt,
        ...(email === undefined ? {} : { email }),
        ...(recordKey === undefined ? {} : { recordKey }),
    };
}

/** 由内核交给线路的凭据续期接口。 */
export interface AntigravityPoolOptions {
    store: OAuthPoolPorts<AntigravityPoolCredentials>['store'];
    /** 续期一份凭据；失败时抛错（带 `status`）供分类。 */
    refresh(credentials: AntigravityPoolCredentials, fetchFn: typeof fetch): Promise<AntigravityPoolCredentials>;
    /** 号池建立前的单凭据，读取时投影为主账号。 */
    legacy?: OAuthPoolPorts<AntigravityPoolCredentials>['legacy'];
    maxAccounts?: number;
    /** 冷却与失效账号是否视为不可调度（默认 true；测试可关）。 */
    fetchFn?: typeof fetch;
}

/**
 * 分类一次续期失败。
 *
 * 只有 4xx 的认证类失败才让账号退出轮转；网络抖动与 5xx 必须让账号留在原地。
 */
export const antigravityRefreshFailureStatus = oauthRefreshFailureStatus;

/** 该号池的规格；导出以便测试直接断言。 */
export function antigravityPoolSpec(
    refresh: AntigravityPoolOptions['refresh'],
): OAuthPoolSpec<AntigravityPoolCredentials> {
    return {
        displayName: 'Antigravity',
        parseCredentials: parseAntigravityPoolCredentials,
        identityKey: antigravityAccountKey,
        defaultAlias: (credentials, position) => credentials.email ?? ('Account ' + position),
        refreshMarginMs: ANTIGRAVITY_REFRESH_MARGIN_MS,
        refresh,
        refreshFailureStatus: oauthRefreshFailureStatus,
    };
}

export class AntigravityAccountPool {
    private readonly pool: OAuthAccountPool<AntigravityPoolCredentials>;

    constructor(options: AntigravityPoolOptions) {
        this.pool = new OAuthAccountPool(antigravityPoolSpec(options.refresh), {
            store: options.store,
            ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
            ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
            ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
        });
    }

    read() { return this.pool.read(); }
    listAccounts(now = Date.now()) { return this.pool.listAccounts(now); }
    strategy() { return this.pool.strategy(); }
    setStrategy(strategy: Parameters<OAuthAccountPool<AntigravityPoolCredentials>['setStrategy']>[0]) {
        return this.pool.setStrategy(strategy);
    }
    hasAccounts() { return this.pool.hasAccounts(); }
    setPrimary(accountId: string) { return this.pool.setPrimary(accountId); }
    removeAccount(accountId: string) { return this.pool.removeAccount(accountId); }
    clearCooldown(accountId: string) { return this.pool.clearCooldown(accountId); }
    clearAuthFailure(accountId: string) { return this.pool.clearAuthFailure(accountId); }
    addAccount(credentials: AntigravityPoolCredentials, alias?: string) {
        return this.pool.addAccount(credentials, alias);
    }
    getEffectiveAccount(excludeIds?: ReadonlySet<string>, forceRefresh = false) {
        return this.pool.getEffectiveAccount(excludeIds, forceRefresh);
    }
    recordUsage(accountId: string, now = Date.now()) { return this.pool.recordUsage(accountId, now); }
    markCooldown(accountId: string, durationMs: number, reason: string) {
        return this.pool.markCooldown(accountId, durationMs, reason);
    }
    noteAuthFailure(accountId: string, status: 'invalid_credential' | 'rate_limited', reason: string) {
        return this.pool.noteAuthFailure(accountId, status, reason);
    }
}

/**
 * 解析整份号池文档。
 *
 * 保留这个导出是为了让既有测试与调用方继续可用；实现委托给共享工厂，因此所有线路的
 * 存储形状与容错行为完全一致。
 */
export function parseAntigravityPoolData(value: unknown) {
    return parseOAuthPoolDataShared(value, {
        parseCredentials: parseAntigravityPoolCredentials,
        emptyStrategy: 'sequential',
        defaultAlias: (credentials: AntigravityPoolCredentials) => credentials.email ?? 'Account',
    });
}
