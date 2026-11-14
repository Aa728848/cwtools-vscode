/**
 * WorkBuddy JWT 负载内的账号身份解析。
 *
 * 官方桌面端的 auth 文件会在 `account` 块里写入 `uid`，而浏览器扫码授权回调只返
 * 回访问令牌与昵称。两者的令牌均以 JWT `sub` 声明真实 `uid`，必须在计算账号
 * 主键前先回填该字段，防止同一个账号拆分成两条冲突的号池记录。
 */

import { isRecord } from '../../../shared/protocolValidation';

export interface WorkBuddyTokenIdentity {
    uid?: string;
    uin?: string;
    enterpriseId?: string;
    nickname?: string;
    accountType?: string;
}

function nonEmptyString(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

/**
 * 读取 JWT 负载中的非密身份声明（不验签：签名校验归网关）。
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
    if (!token || token.trim() === '') return null;
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    try {
        const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
        const parsed = JSON.parse(decoded) as unknown;
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** 从 access token 中提取非密身份字段。 */
export function extractIdentityFromToken(token: string): WorkBuddyTokenIdentity {
    const claims = decodeJwtClaims(token);
    if (claims === null) return {};
    const identity: WorkBuddyTokenIdentity = {};
    const sub = nonEmptyString(claims.sub);
    if (sub !== undefined) identity.uid = sub;
    const enterpriseId = nonEmptyString(claims.enterpriseId);
    if (enterpriseId !== undefined) identity.enterpriseId = enterpriseId;
    const uin = nonEmptyString(claims.uin);
    if (uin !== undefined) identity.uin = uin;
    return identity;
}

/**
 * 用令牌声明补齐缺失的身份字段；显式身份（如 `/v2/plugin/account` 返回）始终优先。
 */
export function withResolvedIdentity<T extends WorkBuddyTokenIdentity & { accessToken: string }>(credentials: T): T {
    const claims = extractIdentityFromToken(credentials.accessToken);
    return {
        ...credentials,
        uid: nonEmptyString(credentials.uid) ?? claims.uid,
        uin: nonEmptyString(credentials.uin) ?? claims.uin,
        enterpriseId: nonEmptyString(credentials.enterpriseId) ?? claims.enterpriseId,
    };
}
