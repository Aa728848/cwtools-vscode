/**
 * 订阅线路的号池注册表。
 *
 * 把「哪条线路用哪个号池」这件事收在一处，`aiService` 只为它提供存储与续期函数。这样
 * 每条线路的凭据解析都走**同一套**账号选择、冷却与失效保留规则，而不是各写一份。
 *
 * 两类线路的差别通过 `seed` 表达：
 * - **自带桌面账号的线路**（MiniMax Code、WorkBuddy）每次选择前把扫描到的桌面凭据并入
 *   号池，因此桌面账号与插件账号在同一池里参与调度；
 * - **纯登录线路**（Codex、Kimi、Claude 订阅、Command Code）不需要 seed。
 *
 * seed 的合并是幂等的：身份键相同即原地更新，不会每次选择都长出新行。
 */

import type { SubscriptionAccountQuota } from '../../../shared/subscriptionQuota';
import { ErrorReporter } from '../errorReporter';
import { SOURCE } from '../messages';
import {
    DEFAULT_COOLDOWN_MS,
    type AccountAuthStatus,
    type AccountRotationStrategy,
    type PoolAccountSummary,
} from './accountPool';
import {
    OAuthAccountPool,
    type OAuthPoolPorts,
    type OAuthPoolSpec,
    type PooledOAuthCredentials,
} from './oauthAccountPool';

/** 一条线路的凭据来源与号池。 */
export interface SubscriptionPoolEntry<TCredentials extends PooledOAuthCredentials> {
    spec: OAuthPoolSpec<TCredentials>;
    ports: OAuthPoolPorts<TCredentials>;
    /**
     * 把线路自己的账号来源并入号池（例如桌面端扫描结果）。
     *
     * 必须在**账号选择之前**执行：桌面账号与插件账号是同一个池里的成员，先选后并会让
     * 刚扫描到的账号这一轮用不上。
     */
    seed?(): Promise<TCredentials[]>;
    /**
     * 共用一个池的规范 id。
     *
     * 两个 provider id 指向同一份凭据时（Command Code 的两条线路共用一把 Key），各自建池会
     * 得到两个内存队列写同一个存储，一次并发写入就会丢账号。都归到同一个池实例即可。
     */
    poolId?: string;
}

/** 一次账号选择的上下文，供请求路径做重试换号。 */
export interface SelectedSubscriptionAccount<TCredentials extends PooledOAuthCredentials> {
    accountId: string;
    credentials: TCredentials;
}

/**
 * 一个 provider id 一个号池。
 *
 * 池子是**懒创建**的：只有真正用过某条线路才会为它建池，避免启动时为六条线路各读一次
 * 安全存储。
 */
export class SubscriptionPoolRegistry {
    private readonly pools = new Map<string, OAuthAccountPool<PooledOAuthCredentials>>();
    /** 每个池子是否已经 seed 过；seed 是幂等的，但没必要每次选择都重扫磁盘。 */
    private readonly seeded = new Set<string>();
    private readonly seeding = new Map<string, Promise<void>>();

    constructor(
        /** 按 provider id 惰性构造线路的池子；返回 undefined 表示该线路还没有池。 */
        private readonly resolve: (providerId: string) => SubscriptionPoolEntry<PooledOAuthCredentials> | undefined,
        /**
         * 本注册表覆盖的全部 provider id。
         *
         * 设置页要在**一次**数据推送里带上所有线路的池：用户在未保存的表单里切换 provider
         * 时，只有已保存 provider 的池会被渲染，号池区就会停留在上一个线路。
         */
        private readonly providerIdList: readonly string[] = [],
    ) {}

    /** 本注册表覆盖的全部 provider id。 */
    providerIds(): readonly string[] {
        return this.providerIdList;
    }

    /** 该 provider 是否已经配置号池。 */
    has(providerId: string): boolean {
        return this.resolve(providerId) !== undefined;
    }

    private entry(providerId: string): SubscriptionPoolEntry<PooledOAuthCredentials> | undefined {
        return this.resolve(providerId);
    }

    /**
     * 把 provider id 归一到它共用的池 id。
     *
     * 别名 id（Command Code 的两条线路）必须落到同一个 OAuthAccountPool 实例上，否则两个实例
     * 各自持有一份内存文档与写队列却写同一个存储槽位，后一次写入会覆盖掉前一次新增的账号。
     */
    private canonical(providerId: string): string {
        return this.entry(providerId)?.poolId ?? providerId;
    }

    /** 取（或建）一条线路的号池。 */
    pool(providerId: string): OAuthAccountPool<PooledOAuthCredentials> | undefined {
        const id = this.canonical(providerId);
        const existing = this.pools.get(id);
        if (existing !== undefined) return existing;
        const entry = this.entry(providerId) ?? this.entry(id);
        if (entry === undefined) return undefined;
        const created = new OAuthAccountPool(entry.spec, entry.ports);
        this.pools.set(id, created);
        return created;
    }

    /** 把线路自己的账号来源并入号池；失败只记日志，不该让一次选择失败。 */
    private async seedOnce(providerId: string): Promise<void> {
        const id = this.canonical(providerId);
        if (this.seeded.has(id)) return;
        const inflight = this.seeding.get(id);
        if (inflight !== undefined) { await inflight; return; }
        const entry = this.entry(providerId);
        // 别名 id 与规范 id 共用同一个池；种子只跑一次，记录在规范 id 上。
        const pool = this.pool(providerId);
        if (entry?.seed === undefined || pool === undefined) {
            this.seeded.add(id);
            return;
        }
        const task = (async () => {
            try {
                for (const credentials of await entry.seed!()) {
                    await pool.addAccount(credentials);
                }
                this.seeded.add(id);
            } catch (error) {
                // 扫描失败只让这一轮少几个账号；下一次选择会重试。
                ErrorReporter.debug(SOURCE.AI_SERVICE, 'Failed to seed the subscription account pool.', error);
            }
        })();
        this.seeding.set(id, task);
        try { await task; } finally { this.seeding.delete(id); }
    }

    /**
     * 为下一个请求挑一个账号。
     *
     * @param excludeIds 本次请求已尝试过的账号，让重试落到另一个账号上。
     * @param forceRefresh 强制续期一次（401 之后的第一步）。
     */
    async select(
        providerId: string,
        excludeIds?: ReadonlySet<string>,
        forceRefresh = false,
    ): Promise<SelectedSubscriptionAccount<PooledOAuthCredentials> | undefined> {
        const pool = this.pool(providerId);
        if (pool === undefined) return undefined;
        await this.seedOnce(providerId);
        const selected = await pool.getEffectiveAccount(excludeIds, forceRefresh);
        return { accountId: selected.account.id, credentials: selected.credentials };
    }

    /** 记录一次成功使用，供轮询与粘性策略使用。 */
    async recordUsage(providerId: string, accountId: string): Promise<void> {
        await this.pool(providerId)?.recordUsage(accountId);
    }

    /** 上游 429 之后冷却该账号并换一个。 */
    async noteRateLimited(providerId: string, accountId: string, retryAfterMs?: number): Promise<void> {
        await this.pool(providerId)?.markCooldown(accountId, retryAfterMs ?? DEFAULT_COOLDOWN_MS, '429');
    }

    /** 凭据失效后停用该账号，但保留它的行以便重新登录恢复。 */
    async noteAuthFailure(providerId: string, accountId: string, reason: string): Promise<void> {
        await this.pool(providerId)?.noteAuthFailure(accountId, 'invalid_credential', reason);
    }

    /** 列出某条线路的账号摘要。 */
    async listAccounts(providerId: string): Promise<PoolAccountSummary[]> {
        const pool = this.pool(providerId);
        if (pool === undefined) return [];
        await this.seedOnce(providerId);
        return pool.listAccounts();
    }

    /**
     * 读取一个账号的额度；线路未接额度面时返回 undefined。
     *
     * 按需调用而不是随账号摘要一起取：额度要打上游请求，而账号摘要在设置页刷新得很频繁。
     */
    async accountQuota(providerId: string, accountId: string): Promise<SubscriptionAccountQuota | undefined> {
        return await this.pool(providerId)?.quotaFor(accountId);
    }

    async strategy(providerId: string): Promise<AccountRotationStrategy | undefined> {
        return this.pool(providerId)?.strategy();
    }

    async setStrategy(providerId: string, strategy: AccountRotationStrategy): Promise<void> {
        await this.pool(providerId)?.setStrategy(strategy);
    }

    async setPrimary(providerId: string, accountId: string): Promise<void> {
        await this.pool(providerId)?.setPrimary(accountId);
    }

    async clearCooldown(providerId: string, accountId: string): Promise<void> {
        await this.pool(providerId)?.clearCooldown(accountId);
    }

    async noteStatus(providerId: string, accountId: string, status: AccountAuthStatus, reason: string): Promise<void> {
        await this.pool(providerId)?.noteAuthFailure(accountId, status, reason);
    }

    /**
     * 从号池里移除一个账号。
     *
     * 只删号池自己那一行：来自其他应用的账号（桌面端登录态）不归本扩展所有，因此不提供删除。
     */
    async removeAccount(providerId: string, accountId: string): Promise<void> {
        await this.pool(providerId)?.removeAccount(accountId);
    }

    /** 登录/重新授权之后把账号并入池子。 */
    async addAccount(
        providerId: string,
        credentials: PooledOAuthCredentials,
        alias?: string,
    ): Promise<void> {
        await this.pool(providerId)?.addAccount(credentials, alias);
    }
}
