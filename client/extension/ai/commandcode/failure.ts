/**
 * Command Code 失败分类。
 *
 * 这个服务用同一批状态码表达两类完全不同的拒绝，**顺序有意义**：
 *
 * 1. **权益拒绝**（套餐不含该模型 / 团队未开通）：这把 key 本身是好的，只是这个模型不可用。
 *    停用它等于为一个模型放弃一整个仍然有效的套餐。
 * 2. **凭据拒绝**：这把 key 真的废了，账号应当退出轮转，别的账号接手。
 *
 * 权益判据必须**先**答：一个被拒的套餐在很多部署上也答 403，先判凭据会误停一个可用账号。
 */

import { isRecord } from '../../../shared/protocolValidation';

function textOf(detail: string): string {
    return detail.toLowerCase();
}

/** 正文是否在说「这个套餐没有这个模型」。 */
export function isCommandCodeModelAccessDenied(detail: string): boolean {
    const text = textOf(detail);
    return text.includes('model_not_available')
        || text.includes('model not available')
        || /no (?:access|subscription) (?:to|for) (?:this )?model/.test(text)
        || /model .* not (?:included|in) (?:your|the) plan/.test(text)
        || /requires? (?:a )?(?:higher|another) plan/.test(text)
        || text.includes('insufficient permissions for model')
        || /模型.{0,8}(?:未开通|不可用|无权限)/.test(text);
}

/** 正文是否在说「这把 key 废了」。 */
export function isCommandCodeCredentialInvalid(detail: string): boolean {
    const text = textOf(detail);
    return text.includes('invalid api key')
        || text.includes('invalid_api_key')
        || text.includes('unauthorized')
        || text.includes('api key has been revoked')
        || /key (?:is )?(?:expired|revoked|disabled)/.test(text);
}

export type CommandCodeFailureKind = 'model_access_denied' | 'invalid_credential' | 'other';

/**
 * 分类一次 Command Code 失败。
 *
 * 只回答「这是什么性质的失败」；是否重试、是否换号由调用点决定。
 */
export function classifyCommandCodeFailure(status: number, detail: string): CommandCodeFailureKind {
    if (isCommandCodeModelAccessDenied(detail)) return 'model_access_denied';
    if (isCommandCodeCredentialInvalid(detail) || status === 401) return 'invalid_credential';
    return 'other';
}

/** 错误对象里的机器可读字段，便于按码而非按文案判定。 */
export function commandCodeErrorCode(detail: string): string | undefined {
    const start = detail.indexOf('{');
    if (start < 0) return undefined;
    try {
        const parsed: unknown = JSON.parse(detail.slice(start));
        if (!isRecord(parsed)) return undefined;
        const code = parsed.code ?? parsed.error;
        return typeof code === 'string' ? code : undefined;
    } catch {
        return undefined;
    }
}
