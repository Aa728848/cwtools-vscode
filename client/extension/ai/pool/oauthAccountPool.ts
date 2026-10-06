/**
 * 订阅线路共用的「OAuth 凭据号池」。
 *
 * 六条线路的凭据形状是同构的——一个可过期的 access token、一个 refresh token、以及某种
 * 账号身份——差异只在**身份键**、**别名**、**续期方式**与**失败分类**。因此这里把
 * `AccountPoolCore` 的那套钩子收敛成一个工厂：各线路只交一份规格，而不是各自重写一遍
 * 存储、迁移、镜像与账号生命周期。
 *
 * 工厂替各线路统一处理三件容易写错的事：
 * - **旧单凭据迁移**：号池建立前的那个凭据被投影为主账号，升级不再是「什么都没了」；
 * - **主账号镜像**：主账号同步回单凭据槽位，让仍读旧槽位的路径继续工作；
 * - **登出**：只清本插件自己那份，绝不触碰别处（桌面端登录态）。
 */

import { isRecord } from '../../../shared/protocolValidation';
import {
    AccountPoolCore,
    finitePositive,
    nonemptyString,
    normalizeRotationStrategy,
    type AccountAuthStatus,
    type AccountPoolStore,
    type AccountRotationStrategy,
    type PoolAccountInput,
    type PoolAccountShape,
    type PoolAccountSummary,
    type PoolData,
} from './accountPool';

/** 号池里的一份凭据：各线路只需满足这个最小形状。 */
export interface PooledOAuthCredentials {
    accessToken: string;
    refreshToken: string;
    /** Unix 毫秒；0 或不设表示不会过期（例如静态 API Key）。 */
    expiresAt?: number;
}

/**
 * 号池里的一个账号。
 *
 * 就是共享的账号形状：各线路的凭据差异体现在 `TCredentials` 上，账号记账字段则完全一致。
 */
export type PooledOAuthAccount<TCredentials extends PooledOAuthCredentials> =
    PoolAccountShape<TCredentials>;

/** 一条线路交给工厂的规格。 */
export interface OAuthPoolSpec<TCredentials extends PooledOAuthCredentials> {
    /** 诊断与消息里用的可读名。 */
    displayName: string;
    /** 解析一份凭据；形状不合法返回 undefined。 */
    parseCredentials(value: unknown): TCredentials | undefined;
    /** 账号身份键；没有可识别身份时返回 undefined（此时每次登录视为独立账号）。 */
    identityKey(credentials: TCredentials): string | undefined;
    /** 身份不可用时的兜底别名。 */
    defaultAlias(credentials: TCredentials, position: number): string;
    /** 续期前多久开始轮换；不设表示到期即续（`expiresAt <= now`）。 */
    refreshMarginMs?: number;
    /** 续期一份凭据；不设表示该线路凭据不会过期（静态 Key）。 */
    refresh?(credentials: TCredentials, fetchFn: typeof fetch): Promise<TCredentials>;
    /**
     * 分类一次续期失败。
     *
     * 返回状态会把该账号移出轮转（**保留**，重新登录即恢复）；返回 undefined 让错误
     * 原样上抛——一次临时失败不该让账号丢掉位置。
     */
    refreshFailureStatus?(error: unknown): AccountAuthStatus | undefined;
    /** 凭据已知不可用的原因（只读上报，不写任何东西）。 */
    rejectedReason?(credentials: TCredentials): string | undefined;
    /** 号池文档损坏或首次运行时的兜底文档。 */
    emptyStrategy?: AccountRotationStrategy;
}

/** 由内核交给线路的凭据解析端口。 */
export interface OAuthPoolPorts<TCredentials extends PooledOAuthCredentials> {
    /** 号池文档的持久化端口。 */
    store: AccountPoolStore;
    /** 号池建立前的单凭据槽位：读取用于迁移，写入用于镜像主账号。 */
    legacy?: {
        read(): Thenable<TCredentials | null>;
        write(credentials: TCredentials | null): Thenable<void>;
    };
    fetchFn?: typeof fetch;
    maxAccounts?: number;
}

/** 解析整份号池文档；`parseCredentials` 交给线路。 */
export function parseOAuthPoolData<TCredentials extends PooledOAuthCredentials>(
    value: unknown,
    spec: Pick<OAuthPoolSpec<TCredentials>, 'parseCredentials' | 'emptyStrategy' | 'defaultAlias'>,
): PoolData<PooledOAuthAccount<TCredentials>> {
    // 号池存在 SecretStorage 里，那里只有字符串；不在边界解开 JSON 的话号池会永远读成空。
    const raw = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (!isRecord(raw)) throw new Error('The stored account pool is not an object.');
    const accounts: Array<PooledOAuthAccount<TCredentials>> = [];
    const list = Array.isArray(raw.accounts) ? raw.accounts : [];
    for (const entry of list) {
        if (!isRecord(entry)) continue;
        const id = nonemptyString(entry.id);
        const alias = nonemptyString(entry.alias);
        const addedAt = finitePositive(entry.addedAt);
        const credentials = spec.parseCredentials(entry.credentials);
        // 坏行被跳过而不是让整份文档作废：用户宁可少一行，也不想丢掉整池账号。
        if (id === undefined || alias === undefined || addedAt === undefined || credentials === undefined) continue;
        const authStatus = entry.authStatus;
        const cooldownUntil = finitePositive(entry.cooldownUntil);
        const authFailedReason = nonemptyString(entry.authFailedReason);
        const cooldownReason = nonemptyString(entry.cooldownReason);
        const lastUsedAt = finitePositive(entry.lastUsedAt);
        accounts.push({
            id, alias, credentials, addedAt,
            ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
            ...(entry.isPrimary === true ? { isPrimary: true } : {}),
            ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
            ...(cooldownReason === undefined ? {} : { cooldownReason }),
            ...(authStatus === 'ok' || authStatus === 'invalid_credential' || authStatus === 'rate_limited'
                ? { authStatus } : {}),
            ...(authFailedReason === undefined ? {} : { authFailedReason }),
        });
    }
    const activeAccountId = nonemptyString(raw.activeAccountId);
    return {
        version: 1,
        rotationStrategy: normalizeRotationStrategy(raw.rotationStrategy ?? spec.emptyStrategy),
        accounts,
        ...(activeAccountId === undefined ? {} : { activeAccountId }),
    };
}

/**
 * 一条线路的 OAuth 凭据号池。
 *
 * 构造时就把内核的钩子装配好，因此线路侧只需要 `addAccount` / `getEffectiveAccount` 这类
 * 语义化调用，不必了解内核的记账字段。
 */
export class OAuthAccountPool<TCredentials extends PooledOAuthCredentials> {
    private readonly core: AccountPoolCore<TCredentials, PooledOAuthAccount<TCredentials>>;

    constructor(
        spec: OAuthPoolSpec<TCredentials>,
        private readonly ports: OAuthPoolPorts<TCredentials>,
    ) {
        const parse = (value: unknown) => parseOAuthPoolData(value, spec);
        this.core = new AccountPoolCore<TCredentials, PooledOAuthAccount<TCredentials>>(
            ports.store,
            {
                providerId: spec.displayName,
                displayName: spec.displayName,
                parsePoolData: parse,
                createAccount: (input: PoolAccountInput<TCredentials, PooledOAuthAccount<TCredentials>>) => ({
                    id: input.id,
                    alias: input.alias,
                    credentials: input.credentials,
                    addedAt: input.addedAt,
                    isPrimary: input.isPrimary,
                }),
                dedupeKey: spec.identityKey,
                defaultAlias: spec.defaultAlias,
                expiresAt: credentials => credentials.expiresAt,
                // A credential with no refresh function cannot be refreshed (a
                // static API key), and one that states no expiry has nothing to
                // compare against. An expiry that IS stated is compared as an
                // absolute instant: epoch 0 is in the past, so it means expired —
                // reading it as "never expires" silently keeps a dead token.
                needsRefresh: (credentials, now) => {
                    if (spec.refresh === undefined) return false;
                    const expiresAt = credentials.expiresAt;
                    if (expiresAt === undefined) return false;
                    return expiresAt <= now + (spec.refreshMarginMs ?? 0);
                },
                ...(spec.refresh === undefined ? {} : { refresh: spec.refresh }),
                ...(spec.refreshFailureStatus === undefined ? {} : { refreshFailureStatus: spec.refreshFailureStatus }),
                ...(spec.rejectedReason === undefined ? {} : { authRejectedReason: spec.rejectedReason }),
                ...(ports.legacy === undefined ? {} : {
                    legacyAccount: async () => {
                        const legacy = await ports.legacy!.read();
                        if (legacy === null) return null;
                        return {
                            id: 'legacy-primary',
                            alias: spec.defaultAlias(legacy, 1),
                            credentials: legacy,
                            addedAt: Date.now(),
                            isPrimary: true,
                        };
                    },
                    // 主账号镜像回单凭据槽位，让仍读旧槽位的路径继续工作。
                    credentialsCommitted: async account => {
                        if (account.isPrimary === true) await ports.legacy!.write(account.credentials);
                    },
                }),
            },
            { maxAccounts: ports.maxAccounts ?? 10 },
        );
    }

    read(): Promise<PoolData<PooledOAuthAccount<TCredentials>>> { return this.core.read(); }
    listAccounts(now = Date.now()): Promise<PoolAccountSummary[]> { return this.core.listAccounts(now); }
    strategy(): Promise<AccountRotationStrategy> { return this.core.strategy(); }
    setStrategy(strategy: AccountRotationStrategy): Promise<void> { return this.core.setStrategy(strategy); }
    setPrimary(accountId: string): Promise<void> { return this.core.setPrimary(accountId); }
    removeAccount(accountId: string): Promise<void> { return this.core.removeAccount(accountId); }
    clearCooldown(accountId: string): Promise<void> { return this.core.clearCooldown(accountId); }
    clearAuthFailure(accountId: string): Promise<void> { return this.core.clearAuthFailure(accountId); }
    hasAccounts(): Promise<boolean> { return this.core.hasAccounts(); }

    /** 登录/重新授权：同一身份原地更新，不产生第二行。 */
    addAccount(credentials: TCredentials, alias?: string): Promise<PooledOAuthAccount<TCredentials>> {
        return this.core.addAccount(credentials, alias);
    }

    /**
     * 为下一个请求挑账号并在必要时续期。
     *
     * @param excludeIds 本次请求已尝试过的账号，让重试落到**另一个**账号上。
     */
    getEffectiveAccount(excludeIds?: ReadonlySet<string>, forceRefresh = false) {
        return this.core.getEffectiveAccount(excludeIds, this.ports.fetchFn ?? fetch, forceRefresh);
    }

    recordUsage(accountId: string, now = Date.now()): Promise<void> {
        return this.core.recordUsage(accountId, now);
    }

    /** 上游 429 之后冷却该账号（冷却是路由概念，不动凭据）。 */
    markCooldown(accountId: string, durationMs: number, reason: string): Promise<void> {
        return this.core.markCooldown(accountId, durationMs, reason);
    }

    /** 凭据失效后停用该账号，但**保留**它的行以便重新登录恢复。 */
    noteAuthFailure(accountId: string, status: AccountAuthStatus, reason: string): Promise<void> {
        return this.core.noteAuthFailure(accountId, status, reason);
    }
}

/**
 * 分类一次 OAuth 失败：只有 4xx 的认证类状态才是对凭据的判定。
 *
 * 5xx 与传输失败必须让账号留在原地，否则一次临时故障就会让用户以为需要重新登录。
 */
export function oauthRefreshFailureStatus(error: unknown): AccountAuthStatus | undefined {
    // A line's refresh implementation attaches the HTTP status to the error; a
    // few wrap it as `cause`, so both spellings are read.
    const direct = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
    const cause = isRecord(error) && isRecord(error.cause) ? error.cause : undefined;
    const nested = cause !== undefined && typeof cause.status === 'number' ? cause.status : undefined;
    const status = direct ?? nested;
    if (status === 400 || status === 401 || status === 403) return 'invalid_credential';
    return undefined;
}
