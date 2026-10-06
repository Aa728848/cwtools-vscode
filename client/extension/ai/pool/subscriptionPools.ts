/**
 * 各订阅线路的号池规格与工厂。
 *
 * `pool/oauthAccountPool.ts` 提供机制；这里提供**每条线路的差异**：身份键、别名、续期与
 * 失败分类。集中放一处，是为了让「六条线路的号池行为一致」这件事可以被读出来，而不是
 * 分散在六个文件里靠比对确认。
 *
 * 共同的取舍：
 * - **身份键不是令牌**：令牌每次轮换都会变，用令牌做键会在每次续期后把同一账号看成新
 *   账号。凡是凭据里有稳定账号标识（uid/email/uuid）就用它；没有时回落到线路自己的
 *   记录槽身份，仍不可用则返回 undefined（此时每次登录视为独立账号，是诚实的降级）；
 * - **失败分类只认认证类 4xx**：5xx 与传输失败必须让账号留在原地；
 * - **刷新失败不影响其它账号**：由内核负责换号。
 */

import {
    OAuthAccountPool,
    oauthRefreshFailureStatus,
    type OAuthPoolPorts,
    type OAuthPoolSpec,
    type PooledOAuthCredentials,
} from './oauthAccountPool';

/** 所有线路共享的失败分类：只有认证类 4xx 才是对凭据的判定。 */
export const subscriptionRefreshFailureStatus = oauthRefreshFailureStatus;

function nonempty(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

function firstNonempty(...values: unknown[]): string | undefined {
    for (const value of values) if (nonempty(value)) return value.trim();
    return undefined;
}

// ─── Claude 订阅 ─────────────────────────────────────────────────────────────

export interface ClaudePoolCredentials extends PooledOAuthCredentials {
    scopes: string[];
    accountUuid?: string;
    accountEmail?: string;
}

/**
 * Claude 订阅的号池原型。
 *
 * 身份优先 uuid（账号的唯一标识），其次 email；两者都没有时才回落。scope 一并保留，因为
 * `user:inference` 是「这是不是订阅凭据」的判据，号池不能把它丢掉。
 */
export function claudePoolCredentials(value: unknown): ClaudePoolCredentials | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const accessToken = firstNonempty(record.accessToken);
    const refreshToken = firstNonempty(record.refreshToken);
    if (accessToken === undefined || refreshToken === undefined) return undefined;
    const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt : 0;
    const scopes = Array.isArray(record.scopes)
        ? record.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [];
    const accountUuid = firstNonempty(record.accountUuid);
    const accountEmail = firstNonempty(record.accountEmail);
    return {
        accessToken, refreshToken, expiresAt, scopes,
        ...(accountUuid === undefined ? {} : { accountUuid }),
        ...(accountEmail === undefined ? {} : { accountEmail }),
    };
}

/** Claude 订阅的身份键：uuid 优先，其次 email。 */
export function claudePoolIdentityKey(credentials: ClaudePoolCredentials): string | undefined {
    if (nonempty(credentials.accountUuid)) return 'uuid:' + credentials.accountUuid.trim();
    if (nonempty(credentials.accountEmail)) return 'email:' + credentials.accountEmail.trim().toLowerCase();
    return undefined;
}

// ─── MiniMax Code 订阅 ───────────────────────────────────────────────────────

export interface MinimaxCodePoolCredentials extends PooledOAuthCredentials {
    region: 'cn' | 'global';
    /** 桌面端来源文件；托管凭据为空。 */
    sourceFile?: string;
    /** 桌面端记录槽身份：同一槽每次轮换都是同一账号。 */
    recordKey?: string;
}

/**
 * MiniMax Code 的号池原型。
 *
 * 区域是**凭据属性**，因此必须随凭据一起进池：一个账号的模型清单与端点都由区域决定。
 */
export function minimaxCodePoolCredentials(value: unknown): MinimaxCodePoolCredentials | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const accessToken = firstNonempty(record.accessToken);
    const refreshToken = firstNonempty(record.refreshToken);
    if (accessToken === undefined || refreshToken === undefined) return undefined;
    const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt : 0;
    const region = record.region === 'global' ? 'global' : 'cn';
    const sourceFile = firstNonempty(record.sourceFile);
    const recordKey = firstNonempty(record.recordKey);
    return {
        accessToken, refreshToken, expiresAt, region,
        ...(sourceFile === undefined ? {} : { sourceFile }),
        ...(recordKey === undefined ? {} : { recordKey }),
    };
}

/** MiniMax Code 的身份键：桌面记录槽优先，其次托管登录的 epoch。 */
export function minimaxCodePoolIdentityKey(credentials: MinimaxCodePoolCredentials): string | undefined {
    if (nonempty(credentials.recordKey)) return 'record:' + credentials.recordKey.trim();
    if (nonempty(credentials.sourceFile)) return 'file:' + credentials.sourceFile.trim();
    return undefined;
}

// ─── Kimi Code 订阅 ──────────────────────────────────────────────────────────

export interface KimiPoolCredentials extends PooledOAuthCredentials {
    expiresIn: number;
    /** 令牌里的账号标识（Kimi 没有账号资料端点，身份只存在于令牌里）。 */
    userId?: string;
    email?: string;
}

/** Kimi Code 的号池原型。 */
export function kimiPoolCredentials(value: unknown): KimiPoolCredentials | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const accessToken = firstNonempty(record.accessToken);
    const refreshToken = firstNonempty(record.refreshToken);
    if (accessToken === undefined || refreshToken === undefined) return undefined;
    const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt : 0;
    const expiresIn = typeof record.expiresIn === 'number' && Number.isFinite(record.expiresIn) && record.expiresIn > 0
        ? record.expiresIn : 3600;
    const userId = firstNonempty(record.userId);
    const email = firstNonempty(record.email);
    return {
        accessToken, refreshToken, expiresAt, expiresIn,
        ...(userId === undefined ? {} : { userId }),
        ...(email === undefined ? {} : { email }),
    };
}

/** Kimi 的身份键：令牌里的 userId 优先，其次 email。 */
export function kimiPoolIdentityKey(credentials: KimiPoolCredentials): string | undefined {
    if (nonempty(credentials.userId)) return 'user:' + credentials.userId.trim();
    if (nonempty(credentials.email)) return 'email:' + credentials.email.trim().toLowerCase();
    return undefined;
}

// ─── WorkBuddy 订阅 ──────────────────────────────────────────────────────────

export interface WorkBuddyPoolCredentials extends PooledOAuthCredentials {
    domain: string;
    backend: string;
    region: 'cn' | 'intl';
    uid?: string;
    nickname?: string;
    uin?: string;
    enterpriseId?: string;
    source: 'desktop' | 'managed';
    sourceFile: string;
} 

/**
 * WorkBuddy 的号池原型。
 *
 * 域、后端与区域都是**凭据属性**（区域由域决定，模型清单跟着区域走），因此必须随凭据进池。
 */
export function workBuddyPoolCredentials(value: unknown): WorkBuddyPoolCredentials | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const accessToken = firstNonempty(record.accessToken);
    const refreshToken = firstNonempty(record.refreshToken);
    const domain = firstNonempty(record.domain);
    if (accessToken === undefined || refreshToken === undefined || domain === undefined) return undefined;
    const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt : 0;
    const backend = firstNonempty(record.backend) ?? '';
    const region = record.region === 'intl' ? 'intl' : 'cn';
    const uid = firstNonempty(record.uid);
    const nickname = firstNonempty(record.nickname);
    const uin = firstNonempty(record.uin);
    const enterpriseId = firstNonempty(record.enterpriseId);
    return {
        accessToken, refreshToken, expiresAt, domain, backend, region,
        ...(uid === undefined ? {} : { uid }),
        ...(nickname === undefined ? {} : { nickname }),
        ...(uin === undefined ? {} : { uin }),
        ...(enterpriseId === undefined ? {} : { enterpriseId }),
        source: record.source === 'desktop' ? 'desktop' : 'managed',
        sourceFile: firstNonempty(record.sourceFile) ?? '',
    };
}

/** WorkBuddy 的身份键：uid → uin → 域+昵称（与既有实现一致）。 */
export function workBuddyPoolIdentityKey(credentials: WorkBuddyPoolCredentials): string | undefined {
    if (nonempty(credentials.uid)) return 'uid:' + credentials.uid.trim();
    if (nonempty(credentials.uin)) return 'uin:' + credentials.uin.trim();
    if (nonempty(credentials.nickname)) {
        return 'name:' + (credentials.domain || 'default') + ':' + credentials.nickname.trim();
    }
    return undefined;
}

// ─── ChatGPT / Codex 订阅 ────────────────────────────────────────────────────

export interface CodexPoolCredentials extends PooledOAuthCredentials {
    idToken?: string;
    accountId?: string;
}

/** Codex 的号池原型；accountId 是由令牌 claim 派生的账号标识。 */
export function codexPoolCredentials(value: unknown): CodexPoolCredentials | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const accessToken = firstNonempty(record.accessToken);
    const refreshToken = firstNonempty(record.refreshToken);
    if (accessToken === undefined || refreshToken === undefined) return undefined;
    const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt : 0;
    const idToken = firstNonempty(record.idToken);
    const accountId = firstNonempty(record.accountId);
    return {
        accessToken, refreshToken, expiresAt,
        ...(idToken === undefined ? {} : { idToken }),
        ...(accountId === undefined ? {} : { accountId }),
    };
}

/** Codex 的身份键：accountId（套餐/工作区边界）优先。 */
export function codexPoolIdentityKey(credentials: CodexPoolCredentials): string | undefined {
    if (nonempty(credentials.accountId)) return 'account:' + credentials.accountId.trim();
    return undefined;
}

// ─── Command Code（静态 API Key）─────────────────────────────────────────────

export interface CommandCodePoolCredentials extends PooledOAuthCredentials {
    /** 账号事实，用于身份与展示。 */
    userId?: string;
    userName?: string;
    keyName?: string;
    email?: string;
}

/**
 * Command Code 的号池原型。
 *
 * 这条线路用的是**不会过期的静态 API Key**，因此 `expiresAt` 缺失、也没有续期函数：
 * 内核据此永不触发续期，但轮转、冷却与失效停用仍然生效（对一个被吊销的 Key 同样有用）。
 */
export function commandCodePoolCredentials(value: unknown): CommandCodePoolCredentials | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const accessToken = firstNonempty(record.accessToken) ?? firstNonempty(record.apiKey);
    if (accessToken === undefined) return undefined;
    const userId = firstNonempty(record.userId);
    const userName = firstNonempty(record.userName);
    const keyName = firstNonempty(record.keyName);
    const email = firstNonempty(record.email);
    return {
        accessToken,
        // 静态 Key 没有 refresh token：留空是关键，内核不会为它尝试续期。
        refreshToken: firstNonempty(record.refreshToken) ?? '',
        ...(userId === undefined ? {} : { userId }),
        ...(userName === undefined ? {} : { userName }),
        ...(keyName === undefined ? {} : { keyName }),
        ...(email === undefined ? {} : { email }),
    };
}

/** Command Code 的身份键：userId 优先，其次 email，最后 key 名。 */
export function commandCodePoolIdentityKey(credentials: CommandCodePoolCredentials): string | undefined {
    if (nonempty(credentials.userId)) return 'user:' + credentials.userId.trim();
    if (nonempty(credentials.email)) return 'email:' + credentials.email.trim().toLowerCase();
    if (nonempty(credentials.keyName)) return 'key:' + credentials.keyName.trim();
    return undefined;
}

/** 一条线路的号池规格集合，供 aiService 按 provider 取用。 */
export interface SubscriptionPoolRegistration<TCredentials extends PooledOAuthCredentials> {
    spec: OAuthPoolSpec<TCredentials>;
    ports: OAuthPoolPorts<TCredentials>;
}
