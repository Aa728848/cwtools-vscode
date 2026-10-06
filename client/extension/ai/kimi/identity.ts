/**
 * 从 Kimi 令牌读账号身份。
 *
 * Kimi 在这条 API 上**没有账号资料端点**：身份只存在于 JWT claim 里，而号池的身份键与
 * 别名都从它取值。不读的话，每次重新登录都是一个新账号行，显示名只能是「Account N」。
 *
 * **这里不做任何安全判断**：claim 只用来分辨两个凭据是不是同一个账号。令牌仍由服务端在
 * 每个请求上校验，最坏只能把两个账号看成同一个——而那会被请求路径自己拒掉。
 */

import { isRecord } from '../../../shared/protocolValidation';

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 解出 JWT 载荷，形状不合法或不透明时返回 null 而不是抛错。 */
export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
    if (token === undefined) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1] ?? '';
    if (payload === '') return null;
    try {
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
        return isRecord(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export interface KimiTokenIdentity {
    userId?: string;
    email?: string;
}

/**
 * 一枚令牌说明的账号身份。
 *
 * `user_id` 优先于 `sub`：两个令牌（access 与 id）都用 `sub`，而订阅账号的稳定标识是
 * `user_id`。
 */
export function identityFromKimiToken(token: string | undefined): KimiTokenIdentity {
    const claims = decodeJwtPayload(token);
    if (claims === null) return {};
    const userId = nonEmptyString(claims.user_id) ?? nonEmptyString(claims.userId);
    const email = nonEmptyString(claims.email);
    return {
        ...(userId === undefined ? {} : { userId }),
        ...(email === undefined ? {} : { email }),
    };
}
