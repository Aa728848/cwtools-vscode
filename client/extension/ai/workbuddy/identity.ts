/**
 * 从访问令牌解析账号身份。
 *
 * WorkBuddy 的凭据**不自带账号资料**：`/v2/plugin/account` 是唯一的资料面，而它是一次
 * best-effort 请求。失败时（或从桌面端 `*.info` 采纳、文件里没有 account 块时）账号身份就
 * 只剩下显示名，于是身份键退到 `name:<域>:<昵称>`；之后某次登录成功读到了 uid，同一个账号
 * 又以 `uid:<uuid>` 存成一行——**同一个账号出现两次**。
 *
 * 令牌里的 `sub` 就是账号的 uid，两个部署都填它，所以这里把它作为权威来源。
 *
 * **这里不做任何安全判断**：这些 claim 只用来分辨两个凭据是不是同一个账号。令牌仍然由
 * 网关在每个请求上校验，未验证的 claim 换不到任何权限——最坏只能把两个账号看成同一个，
 * 而那会被请求路径自己拒掉。解析失败返回空对象而不是抛错：这条线路必须继续接受非 JWT 的
 * 访问令牌。
 */

import type { WorkBuddyCredentials } from './credentials';

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 解出 JWT 载荷，**不做校验**。
 *
 * 形状不合法或不透明时返回 null 而不是抛错：非 JWT 的访问令牌是这条线路必须接受的合法形状。
 */
export function decodeAccessTokenClaims(accessToken: string): Record<string, unknown> | null {
    const parts = accessToken.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1] ?? '';
    if (payload === '') return null;
    try {
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown;
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

/** 一组 claim 说明的账号事实。 */
export interface WorkBuddyTokenIdentity {
    uid?: string;
    nickname?: string;
    uin?: string;
    enterpriseId?: string;
}

/** 从一组 claim 里读账号事实。 */
export function identityFromClaims(claims: Record<string, unknown>): WorkBuddyTokenIdentity {
    const identity: WorkBuddyTokenIdentity = {};
    const uid = nonEmptyString(claims.sub);
    if (uid !== undefined) identity.uid = uid;
    // 显示名按两个部署实际的填写顺序读：国区填 `nickname`；国际区不填它，而用
    // `preferred_username`（社交登录再用 `name`）说明账号。IDE 记录的
    // `account.nickname` 正是 `preferred_username`，所以优先读它让两条读取路径保持一致。
    const nickname = nonEmptyString(claims.nickname)
        ?? nonEmptyString(claims.preferred_username)
        ?? nonEmptyString(claims.name);
    if (nickname !== undefined) identity.nickname = nickname;
    const uin = nonEmptyString(claims.uin);
    if (uin !== undefined) identity.uin = uin;
    const enterpriseId = nonEmptyString(claims.enterprise_id)
        ?? nonEmptyString(claims.enterpriseId)
        ?? nonEmptyString(claims.tenant_id);
    if (enterpriseId !== undefined) identity.enterpriseId = enterpriseId;
    return identity;
}

/** 访问令牌说明的身份；它什么也没说时返回空对象。 */
export function identityFromAccessToken(accessToken: string): WorkBuddyTokenIdentity {
    const claims = decodeAccessTokenClaims(accessToken);
    return claims === null ? {} : identityFromClaims(claims);
}

/**
 * 用令牌里的身份回填凭据。
 *
 * `sub` 是账号的 uid，因此它**胜过**一个与它不一致的已存值：那个已存值只可能来自「把显示名
 * 提升成 uid」的登录路径，而这正是本函数要修复的那条记录。被挤掉的值在没有别的名字时保留为
 * 昵称，这样修复后的那一行仍然显示一个人能认出的东西，而不是一串不透明的 uuid。
 *
 * 其余字段只在凭据**没有**声明时才填：IDE 文件或登录响应已经记下的内容不从令牌二次猜测。
 */
export function withResolvedIdentity(credentials: WorkBuddyCredentials): WorkBuddyCredentials {
    const identity = identityFromAccessToken(credentials.accessToken);
    const next: WorkBuddyCredentials = { ...credentials };
    let changed = false;
    if (identity.uid !== undefined && identity.uid !== next.uid) {
        const displaced = nonEmptyString(next.uid);
        if (displaced !== undefined && nonEmptyString(next.nickname) === undefined) {
            next.nickname = displaced;
        }
        next.uid = identity.uid;
        changed = true;
    }
    if (nonEmptyString(next.nickname) === undefined && identity.nickname !== undefined) {
        next.nickname = identity.nickname;
        changed = true;
    }
    if (nonEmptyString(next.uin) === undefined && identity.uin !== undefined) {
        next.uin = identity.uin;
        changed = true;
    }
    if (nonEmptyString(next.enterpriseId) === undefined && identity.enterpriseId !== undefined) {
        next.enterpriseId = identity.enterpriseId;
        changed = true;
    }
    return changed ? next : credentials;
}

/**
 * 这个凭据是否说出了自己的账号。
 *
 * 身份键会回落到 auth 域，而那是**部署**的属性而不是账号的：同一部署上的两个账号会共享它。
 * 因此一个既没有 uid、UIN 也没有显示名的凭据没有可推导的身份。
 */
export function hasStableIdentity(credentials: Pick<WorkBuddyCredentials, 'uid' | 'uin' | 'nickname'>): boolean {
    return nonEmptyString(credentials.uid) !== undefined
        || nonEmptyString(credentials.uin) !== undefined
        || nonEmptyString(credentials.nickname) !== undefined;
}
