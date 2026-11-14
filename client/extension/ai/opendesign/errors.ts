/**
 * OpenDesign HTTP 拒绝语义分类。
 *
 * 与上游约定严密对齐的关键区分：
 * - `403 tier_*not_entitled` / `not entitled to use this model` / `membership tier` / `upgrade_required`
 *   属于「当前账号的套餐不包含该模型」，**绝不是凭据失效**！不得调用 `noteAuthFailure`，只在当前请求内
 *   加入 `excludeIds` 换更高套餐账号重试；
 * - `401` 或明确写明 invalid/revoked API key 的载荷属于 `invalid_credential`，触发 `noteAuthFailure`；
 * - `402` 或余额/信用点耗尽属于 `account_quota_exhausted`，`429` 属于 `rate_limit`，均触发号池冷却与换号；
 * - 上下文溢出交回调用方压缩路径，不浪费号池额度。
 */

export type OpenDesignFailureKind =
    | 'entitlement_denied'
    | 'invalid_credential'
    | 'account_quota_exhausted'
    | 'rate_limit'
    | 'context_overflow'
    | 'invalid_request'
    | 'server'
    | 'provider_error';

const MODEL_ENTITLEMENT_DENIAL_RE =
    /tier_[a-z_]*not_entitled|not\s+entitled\s+to\s+use\s+this\s+model|membership\s+tier|upgrade_required|plan\s+does\s+not\s+include/i;

const AUTH_ERROR_RE =
    /missing_api_key|invalid_api_key|unauthenticated|unauthorized|invalid\s*(?:api\s*key|token)|api key not found|(?:revoked|expired)_key|key\s+(?:was\s+)?(?:revoked|expired)|token\s+expired/i;

const QUOTA_EXHAUSTED_RE =
    /(?:insufficient|out of|exhaust\w*|deplet\w*|spent|used up|run out)[\s\S]{0,60}?(?:credit|balance|quota)|(?:credit|balance|quota)[\s\S]{0,60}?(?:insufficient|exhaust\w*|deplet\w*|spent|used up|run(?:ning)? out)/i;

const CONTEXT_OVERFLOW_RE =
    /context(?:_| )length|context window|maximum context|too many tokens|exceeded model token limit|prompt is too long/i;

export function isOpenDesignModelEntitlementDenial(detail: string, status?: number): boolean {
    if (status !== undefined && status !== 403 && status !== 402 && status !== 400) return false;
    return MODEL_ENTITLEMENT_DENIAL_RE.test(detail);
}

export function isOpenDesignAuthenticationError(detail: string, status?: number): boolean {
    if (status === 401) return true;
    return AUTH_ERROR_RE.test(detail);
}

export function classifyOpenDesignFailure(status: number, detail: string): OpenDesignFailureKind {
    if (status === 402 || QUOTA_EXHAUSTED_RE.test(detail)) return 'account_quota_exhausted';
    // 先识别套餐级别对单一模型的拒绝，避免把它当成 AUTH 停用原本健康的账号。
    if (isOpenDesignModelEntitlementDenial(detail, status)) return 'entitlement_denied';
    if (isOpenDesignAuthenticationError(detail, status)) return 'invalid_credential';
    if (status === 429 || /\b429\b|rate limit|rate-?limited/i.test(detail)) return 'rate_limit';
    if (CONTEXT_OVERFLOW_RE.test(detail)) return 'context_overflow';
    if (status === 400) return 'invalid_request';
    if (status >= 500) return 'server';
    return 'provider_error';
}
