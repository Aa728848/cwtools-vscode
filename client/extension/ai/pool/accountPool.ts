/**
 * 订阅线路共用的多账号号池内核。
 *
 * 存储、序列化、可调度性、轮转与冷却规则都在这里；各线路只提供少数钩子（去重键、别名、续期、
 * 失败分类）。这是有意的：顺序耗尽 / 轮询 / 粘性、429 冷却换号、账号级失效保留这几条规则一旦
 * 各写一遍就会各自漂移，而它们是**路由正确性**而不是展示细节。
 *
 * 四条承重语义：
 * - **调度策略只从「已经可调度」的集合里挑**：正在冷却的账号不会被策略选中，因为策略描述的
 *   是偏好而不是越权；
 * - **粘性保护上游前缀缓存**：多轮对话默认落在同一个账号上，否则每一轮都可能换号并让整段
 *   前缀缓存失效；
 * - **凭据失效保留账号行**：401/403 让该账号退出轮转但**不删除**，重新登录即可原地恢复；
 * - **冷却过期即视为不存在**：对外汇报时已过期的冷却不会被报成「仍在冷却」。
 */

import { isRecord } from '../../../shared/protocolValidation';

/** 一个号池最多容纳的账号数。 */
export const DEFAULT_MAX_POOL_ACCOUNTS = 20;
/** 冷却时长下限，避免一次抖动就把账号永久排除。 */
export const MIN_COOLDOWN_MS = 10_000;
/** 兜底冷却时长，用于上游没有给出 Retry-After 的情形。 */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** 账号凭据的可用状态；ok 或缺省都表示可用。 */
export type AccountAuthStatus = 'ok' | 'invalid_credential' | 'rate_limited';

/** 调度策略。 */
export type AccountRotationStrategy = 'sequential' | 'round-robin' | 'sticky';

/** 归一到受支持的策略；无法识别时回落到顺序耗尽。 */
export function normalizeRotationStrategy(value: unknown): AccountRotationStrategy {
    return value === 'round-robin' || value === 'sticky' ? value : 'sequential';
}

/** 所有线路都认同的账号字段。 */
export interface PoolAccountShape<TCredentials> {
    id: string;
    alias: string;
    credentials: TCredentials;
    addedAt: number;
    lastUsedAt?: number;
    isPrimary?: boolean;
    cooldownUntil?: number;
    cooldownReason?: string;
    authStatus?: AccountAuthStatus;
    authFailedReason?: string;
}

/** 一条线路的整个号池文档。 */
export interface PoolData<TAccount> {
    version: 1;
    activeAccountId?: string;
    rotationStrategy: AccountRotationStrategy;
    accounts: TAccount[];
}

/** 内核交给线路钩子用于铸造账号记录的一切。 */
export interface PoolAccountInput<TCredentials, TAccount> {
    id: string;
    alias: string;
    credentials: TCredentials;
    addedAt: number;
    isPrimary: boolean;
    /** 去重键已存在时，本记录替换掉的旧账号。 */
    existing?: TAccount;
}

/** 一条线路在号池里的可变行为。 */
export interface AccountPoolHooks<
    TCredentials,
    TAccount extends PoolAccountShape<TCredentials>,
> {
    /** 用于存储描述与诊断的 provider id。 */
    providerId: string;
    /** 消息里使用的可读名。 */
    displayName: string;
    /** 校验并归一化整份号池文档。 */
    parsePoolData(value: unknown): PoolData<TAccount>;
    /** 铸造账号记录；内核只决定 id、别名与主账号标记。 */
    createAccount(input: PoolAccountInput<TCredentials, TAccount>): TAccount;
    /** 两个凭据指向同一上游账号时的身份键。 */
    dedupeKey?(credentials: TCredentials): string | undefined;
    /** 凭据未指出任何用户可识别信息时的别名。 */
    defaultAlias(credentials: TCredentials, position: number): string;
    /** access token 的过期时刻（Unix 毫秒）；不会过期的 Key 返回 undefined。 */
    expiresAt?(credentials: TCredentials): number | undefined;
    /** 凭据是否必须在下一个请求前续期。 */
    needsRefresh?(credentials: TCredentials, now: number): boolean;
    /** 续期一份凭据，返回要写回号池的值。 */
    refresh?(credentials: TCredentials, fetchFn: typeof fetch): Promise<TCredentials>;
    /**
     * 分类一次续期失败。
     *
     * 返回状态会把该账号移出轮转（**保留**，重新登录即恢复），并让下一个可调度账号接手；
     * 返回 undefined 则让续期错误继续上抛——一次临时失败不该让账号丢掉位置。
     */
    refreshFailureStatus?(error: unknown): AccountAuthStatus | undefined;
    /** 存储的凭据已知不可用的原因（例如被拒的 refresh token）。只读上报，不写任何东西。 */
    authRejectedReason?(credentials: TCredentials): string | undefined;
    /** 凭据提交后的本地存储同步；失败被吞掉，因为已提交的号池才是权威。 */
    credentialsCommitted?(account: TAccount): Promise<void>;
    /** 号池建立前的单凭据，读取时投影为主账号。 */
    legacyAccount?(): Promise<TAccount | null>;
    /** 把主账号镜像进单凭据存储；null 表示清空。 */
    mirrorPrimary?(credentials: TCredentials | null): Promise<void>;
    /** 全部账号不可用时的错误文案。 */
    allUnavailableMessage?(count: number, waitMinutes: number): string;
}

/** 号池的持久化端口；read 返回原始文档（可为 undefined）。 */
export interface AccountPoolStore {
    read(): Thenable<unknown>;
    write(value: unknown): Thenable<void>;
}

/** 一个账号对外汇报的摘要，绝不包含凭据。 */
export interface PoolAccountSummary {
    id: string;
    alias: string;
    isPrimary: boolean;
    authStatus?: AccountAuthStatus;
    authFailedReason?: string;
    lastUsedAt?: number;
    cooldownUntil?: number;
    cooldownReason?: string;
    expiresAt?: number;
}

function emptyPool<TAccount>(): PoolData<TAccount> {
    return { version: 1, rotationStrategy: 'sequential', accounts: [] };
}

/** 从任意值里读出一个有限正数；否则返回 undefined。 */
export function finitePositive(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 从任意值里读出一个非空字符串；否则返回 undefined。 */
export function nonemptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 一个值是否是可当作号池文档的对象。 */
export function isPoolDocument(value: unknown): value is Record<string, unknown> {
    return isRecord(value);
}

/** 生成一个新的账号 id。 */
function newAccountId(): string {
    return 'acct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 一个线路的号池。
 *
 * 并发安全靠一条写队列：所有变更都在队列里串行读改写，因此两个同时到达的登录不会各自通过一个
 * 对方已经作废的检查（容量、去重、主账号判定都基于**实时**文档）。
 */
export class AccountPoolCore<
    TCredentials,
    TAccount extends PoolAccountShape<TCredentials>,
> {
    private writeQueue: Promise<void> = Promise.resolve();
    /**
     * One in-flight refresh per account id.
     *
     * Concurrent callers must share a rotation rather than each spending the
     * same refresh token: upstream retires a rotated token, so all but the first
     * would be rejected and the account would look revoked after a single burst.
     */
    private readonly refreshInFlight = new Map<string, Promise<TCredentials>>();
    private readonly maxAccounts: number;

    constructor(
        private readonly store: AccountPoolStore,
        private readonly hooks: AccountPoolHooks<TCredentials, TAccount>,
        options: { maxAccounts?: number } = {},
    ) {
        this.maxAccounts = options.maxAccounts ?? DEFAULT_MAX_POOL_ACCOUNTS;
    }

    /** 在写队列里串行执行一次读改写。 */
    private updatePool<T>(mutate: (data: PoolData<TAccount>) => T): Promise<T> {
        const task = this.writeQueue.then(async () => {
            const data = await this.read();
            const result = mutate(data);
            await Promise.resolve(this.store.write(data));
            return result;
        });
        // 队列本身必须保持可用：调用方拥有错误上报。
        this.writeQueue = task.then(() => undefined, () => undefined);
        return task;
    }

    /** 读取并归一化号池；损坏的存储按空池处理而不是抛错。 */
    async read(): Promise<PoolData<TAccount>> {
        let raw: unknown;
        try { raw = await this.store.read(); } catch { return emptyPool<TAccount>(); }
        if (raw === undefined || raw === null) {
            // 号池建立前的单凭据被投影为主账号，让升级不再是「什么都没了」。
            const legacy = await this.hooks.legacyAccount?.().catch(() => null) ?? null;
            if (legacy === null) return emptyPool<TAccount>();
            return { version: 1, rotationStrategy: 'sequential', accounts: [legacy] };
        }
        try {
            const parsed = this.hooks.parsePoolData(raw);
            return { ...parsed, rotationStrategy: normalizeRotationStrategy(parsed.rotationStrategy) };
        } catch {
            return emptyPool<TAccount>();
        }
    }

    /** 对外摘要；已过期的冷却按「不存在」汇报。 */
    async listAccounts(now = Date.now()): Promise<PoolAccountSummary[]> {
        const data = await this.read();
        return data.accounts.map(account => this.summarize(account, now));
    }

    summarize(account: TAccount, now = Date.now()): PoolAccountSummary {
        const expires = this.hooks.expiresAt?.(account.credentials);
        const cooling = account.cooldownUntil !== undefined && account.cooldownUntil > now;
        const failed = account.authStatus !== undefined && account.authStatus !== 'ok';
        return {
            id: account.id,
            alias: account.alias,
            isPrimary: account.isPrimary === true,
            ...(failed ? { authStatus: account.authStatus } : {}),
            ...(failed && account.authFailedReason !== undefined ? { authFailedReason: account.authFailedReason } : {}),
            ...(account.lastUsedAt === undefined ? {} : { lastUsedAt: account.lastUsedAt }),
            ...(cooling
                ? {
                    cooldownUntil: account.cooldownUntil,
                    ...(account.cooldownReason === undefined ? {} : { cooldownReason: account.cooldownReason }),
                }
                : {}),
            ...(expires === undefined ? {} : { expiresAt: expires }),
        };
    }

    /** 当前策略。 */
    async strategy(): Promise<AccountRotationStrategy> {
        return (await this.read()).rotationStrategy;
    }

    async setStrategy(strategy: AccountRotationStrategy): Promise<void> {
        await this.updatePool(data => { data.rotationStrategy = normalizeRotationStrategy(strategy); });
    }

    /**
     * 新增或重新授权一个账号。
     *
     * 去重键已存在时**原地更新**而不是产生第二行：同一账号再次登录是一次重新授权。
     */
    async addAccount(credentials: TCredentials, alias?: string): Promise<TAccount> {
        return this.updatePool(data => this.addAccountToPool(data, credentials, alias));
    }

    /** 在已有事务里新增账号；容量、去重与主账号判定都基于实时文档。 */
    protected addAccountToPool(data: PoolData<TAccount>, credentials: TCredentials, alias?: string): TAccount {
        const key = this.hooks.dedupeKey?.(credentials);
        const existing = key === undefined
            ? undefined
            : data.accounts.find(account => this.hooks.dedupeKey?.(account.credentials) === key);
        if (existing === undefined && data.accounts.length >= this.maxAccounts) {
            throw new Error(this.hooks.displayName + ': the account pool is full (' + this.maxAccounts + ').');
        }
        const isPrimary = existing?.isPrimary === true || data.accounts.length === 0;
        const position = existing === undefined ? data.accounts.length + 1 : data.accounts.indexOf(existing) + 1;
        const account = this.hooks.createAccount({
            id: existing?.id ?? newAccountId(),
            alias: alias ?? existing?.alias ?? this.hooks.defaultAlias(credentials, position),
            credentials,
            addedAt: existing?.addedAt ?? Date.now(),
            isPrimary,
            ...(existing === undefined ? {} : { existing }),
        });
        if (existing === undefined) data.accounts.push(account);
        else data.accounts[data.accounts.indexOf(existing)] = account;
        return account;
    }

    async removeAccount(accountId: string): Promise<void> {
        await this.updatePool(data => {
            const index = data.accounts.findIndex(account => account.id === accountId);
            if (index < 0) return;
            const [removed] = data.accounts.splice(index, 1);
            if (data.activeAccountId === accountId) data.activeAccountId = undefined;
            // 删掉主账号时必须补一个，否则「顺序耗尽」会失去首选。
            if (removed?.isPrimary === true && data.accounts.length > 0) {
                data.accounts[0]!.isPrimary = true;
            }
        });
    }

    async setPrimary(accountId: string): Promise<void> {
        await this.updatePool(data => {
            for (const account of data.accounts) {
                if (account.id === accountId) account.isPrimary = true;
                else delete account.isPrimary;
            }
        });
    }

    /** 记录一次成功使用，供轮询策略按「最久未用」排序。 */
    async recordUsage(accountId: string, now = Date.now()): Promise<void> {
        await this.updatePool(data => {
            const account = data.accounts.find(entry => entry.id === accountId);
            if (account === undefined) return;
            account.lastUsedAt = now;
            data.activeAccountId = accountId;
        });
    }

    /** 上游 429 之后冷却一个账号。 */
    async markCooldown(accountId: string, durationMs: number, reason: string): Promise<void> {
        await this.updatePool(data => {
            const account = data.accounts.find(entry => entry.id === accountId);
            if (account === undefined) return;
            account.cooldownUntil = Date.now() + Math.max(MIN_COOLDOWN_MS, durationMs);
            account.cooldownReason = reason;
        });
    }

    async clearCooldown(accountId: string): Promise<void> {
        await this.updatePool(data => {
            const account = data.accounts.find(entry => entry.id === accountId);
            if (account === undefined) return;
            account.cooldownUntil = undefined;
            account.cooldownReason = undefined;
        });
    }

    /**
     * 记录一个账号已无法认证。
     *
     * 账号**保留**在池里：重新登录会原地恢复它，而删掉会让用户丢掉一个仍然有效的套餐。
     */
    async noteAuthFailure(accountId: string, status: AccountAuthStatus, reason: string): Promise<void> {
        await this.updatePool(data => {
            const account = data.accounts.find(entry => entry.id === accountId);
            if (account === undefined) return;
            account.authStatus = status;
            account.authFailedReason = reason;
        });
    }

    async clearAuthFailure(accountId: string): Promise<void> {
        await this.updatePool(data => {
            const account = data.accounts.find(entry => entry.id === accountId);
            if (account === undefined) return;
            account.authStatus = undefined;
            account.authFailedReason = undefined;
        });
    }

    /** 凭据本身是否可用（不含轮转记账：冷却描述的是路由，不是凭据）。 */
    isCredentialUsable(account: TAccount): boolean {
        if (account.authStatus !== undefined && account.authStatus !== 'ok') return false;
        if (this.hooks.authRejectedReason?.(account.credentials) !== undefined) return false;
        return true;
    }

    private isEligible(account: TAccount, now: number): boolean {
        if (account.cooldownUntil !== undefined && account.cooldownUntil > now) return false;
        return this.isCredentialUsable(account);
    }

    /** 轮转策略从「已经可调度」的集合里挑出的那个账号。 */
    private selectAccount(eligible: TAccount[], data: PoolData<TAccount>): TAccount {
        if (data.rotationStrategy === 'round-robin') {
            // 最久未用优先，让一阵突发流量摊到整个池上。
            return [...eligible].sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0))[0]!;
        }
        if (data.rotationStrategy === 'sticky') {
            // 保持服务上一个请求的账号：这是跨轮保护上游前缀缓存的东西。
            return eligible.find(account => account.id === data.activeAccountId)
                ?? eligible.find(account => account.isPrimary)
                ?? eligible[0]!;
        }
        // 顺序耗尽：优先主账号，其次第一个可调度账号。
        return eligible.find(account => account.isPrimary) ?? eligible[0]!;
    }

    /** 全部账号不可用时抛出的错误，附上最短等待时间。 */
    private allUnavailableError(data: PoolData<TAccount>, now: number): Error {
        let shortest = Number.POSITIVE_INFINITY;
        for (const account of data.accounts) {
            if (account.cooldownUntil !== undefined && account.cooldownUntil > now) {
                shortest = Math.min(shortest, account.cooldownUntil - now);
            }
        }
        const waitMinutes = Number.isFinite(shortest) ? Math.ceil(shortest / 60_000) : 15;
        const message = this.hooks.allUnavailableMessage?.(data.accounts.length, waitMinutes)
            ?? ('All ' + data.accounts.length + ' ' + this.hooks.displayName
                + ' accounts are rate limited or cooling down. The shortest cooldown lifts in about '
                + waitMinutes + ' minute(s).');
        return Object.assign(new Error(message), { status: 429 });
    }

    /**
     * 为下一个请求挑账号，并在凭据即将过期时续期。
     *
     * @param excludeIds - 本次请求已尝试过的账号，让重试落到**另一个**账号上。
     */
    async getEffectiveAccount(
        excludeIds?: ReadonlySet<string>,
        fetchFn: typeof fetch = fetch,
        forceRefresh = false,
    ): Promise<{ account: TAccount; credentials: TCredentials }> {
        const data = await this.read();
        if (data.accounts.length === 0) {
            throw new Error(this.hooks.displayName + ': no account is signed in.');
        }
        const now = Date.now();
        const eligible = data.accounts.filter(account => this.isEligible(account, now)
            && (excludeIds === undefined || !excludeIds.has(account.id)));
        if (eligible.length === 0) throw this.allUnavailableError(data, now);

        const selected = this.selectAccount(eligible, data);
        const needsRefresh = forceRefresh
            || this.hooks.needsRefresh?.(selected.credentials, now) === true;
        if (!needsRefresh) return { account: selected, credentials: selected.credentials };

        // 没有续期钩子的线路（不会过期的 Key）直接原样使用。
        if (this.hooks.refresh === undefined) return { account: selected, credentials: selected.credentials };
        try {
            const refreshed = await this.refreshOnce(selected.id, selected.credentials, fetchFn);
            // A concurrent caller may already have committed this rotation, in
            // which case the account row is current and needs no second write.
            const current = (await this.read()).accounts.find(entry => entry.id === selected.id);
            if (current !== undefined && current.credentials === refreshed) {
                return { account: current, credentials: current.credentials };
            }
            const stored = await this.commitCredentials(selected.id, refreshed);
            return { account: stored, credentials: stored.credentials };
        } catch (error) {
            const status = this.hooks.refreshFailureStatus?.(error);
            // 只有「凭据已死」才让账号退出轮转；临时失败必须让它留在原地。
            if (status === undefined) throw error;
            await this.noteAuthFailure(selected.id, status,
                error instanceof Error ? error.message : String(error));
            const remaining = data.accounts.filter(account => this.isEligible(account, now)
                && account.id !== selected.id
                && (excludeIds === undefined || !excludeIds.has(account.id)));
            if (remaining.length === 0) throw this.allUnavailableError(data, now);
            const next = this.selectAccount(remaining, data);
            return { account: next, credentials: next.credentials };
        }
    }

    /** One rotation per account, shared by every concurrent caller. */
    private refreshOnce(
        accountId: string,
        credentials: TCredentials,
        fetchFn: typeof fetch,
    ): Promise<TCredentials> {
        const existing = this.refreshInFlight.get(accountId);
        if (existing !== undefined) return existing;
        const task = this.hooks.refresh!(credentials, fetchFn)
            .finally(() => {
                if (this.refreshInFlight.get(accountId) === task) this.refreshInFlight.delete(accountId);
            });
        this.refreshInFlight.set(accountId, task);
        return task;
    }

    /** 在写队列里把续期后的凭据写回对应账号，并同步线路自己的镜像存储。 */
    private commitCredentials(accountId: string, credentials: TCredentials): Promise<TAccount> {
        return this.updatePool(data => {
            const account = data.accounts.find(entry => entry.id === accountId);
            if (account === undefined) {
                throw new Error(this.hooks.displayName + ': account disappeared during refresh.');
            }
            account.credentials = credentials;
            account.authStatus = undefined;
            account.authFailedReason = undefined;
            return account;
        }).then(async account => {
            // 镜像同步只在号池写入成功后运行，因此镜像永远不会跑在号池前面。
            if (this.hooks.credentialsCommitted !== undefined) {
                await this.hooks.credentialsCommitted(account).catch(() => undefined);
            }
            return account;
        });
    }

    /** 号池文档里是否已经有任何账号。 */
    async hasAccounts(): Promise<boolean> {
        return (await this.read()).accounts.length > 0;
    }
}
