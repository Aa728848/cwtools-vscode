/**
 * 订阅线路的失败分类。
 *
 * 上游用同一个 HTTP 状态表达**性质完全不同**的拒绝：额度用尽、账号级限额、凭据失效、
 * 服务端故障。混为一谈时，号池要么在墙上空转（该换号却不换），要么把一个仍然可用的账号
 * 停用（不该停却停了）。分类放在一处，是因为这些判据在每条线路上是同一套形状，而每条
 * 线路各自写一遍必然漂移。
 *
 * **顺序有意义**：先问「凭据是不是死了」，再问「是不是这个账号的额度/限额」，最后才落到
 * 通用类别。凭据判据在前面，是因为一个被吊销的令牌在很多部署上也答 403。
 */

import { isRecord } from '../../shared/protocolValidation';

export type SubscriptionFailureKind =
    | 'invalid_credential'
    | 'account_quota_exhausted'
    | 'account_limit'
    | 'rate_limit'
    | 'server'
    | 'context_overflow'
    | 'provider_error';

/** 读出正文里可能出现的业务错误码（各线路实测值）。 */
function errorCodes(detail: string): number[] {
    const codes: number[] = [];
    const pattern = /(?:^|[^0-9])(\d{4,6})(?:[^0-9]|$)/g;
    for (const match of detail.matchAll(pattern)) {
        const value = Number(match[1]);
        if (Number.isInteger(value)) codes.push(value);
    }
    return codes;
}

/** 这段正文是否在说「凭据没了」。 */
function saysCredentialDead(detail: string): boolean {
    return /invalid[_ ]?(?:credential|token|grant)|token (?:is )?(?:expired|revoked|invalid)|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(detail);
}

/** 这段正文是否在说「这个账号的额度用完了」。 */
function saysQuotaExhausted(detail: string): boolean {
    return /quota (?:exhausted|used up)|insufficient (?:quota|balance|credits)|exceeded your current quota|out of credits|no (?:remaining )?credits|额度.{0,4}(?:用尽|不足|已用完)/i.test(detail);
}

/** 这段正文是否在说「这是账号级限额，不是全局限流」。 */
function saysAccountLimit(detail: string): boolean {
    return /account (?:limit|quota|suspended)|too many requests for this account|organization (?:limit|quota)|per[- ]account|账号.{0,6}(?:限额|配额)/i.test(detail);
}

/** 这段正文是否在说「上下文窗口满了」。 */
function saysContextOverflow(detail: string): boolean {
    return /context(?:_| )length|context window|maximum context|too many tokens|exceeded model token limit|上下文.{0,6}(?:超|过)长/i.test(detail);
}

export interface ClassifiedSubscriptionFailure {
    kind: SubscriptionFailureKind;
    /** 账号级限额时的冷却时长（毫秒）。 */
    cooldownMs?: number;
    /** 业务错误码，诊断用。 */
    code?: number;
}

export interface ClassifiedResponse {
    detail: string;
    failure: ClassifiedSubscriptionFailure;
}

/**
 * 分类一次失败。
 *
 * 只读状态码与正文；不产生任何副作用，也不决定重试——那是调用点的事，这里只回答
 * 「这是什么性质的失败」。
 */
export function classifySubscriptionFailure(status: number, detail: string): ClassifiedSubscriptionFailure {
    const code = errorCodes(detail)[0];
    const result = (kind: SubscriptionFailureKind, cooldownMs?: number): ClassifiedSubscriptionFailure =>
        ({ kind, ...(cooldownMs === undefined ? {} : { cooldownMs }), ...(code === undefined ? {} : { code }) });

    // 1. 凭据：必须先答。一个被吊销的令牌在很多部署上也答 403，先判限额会把它
    //    误判成一个「只是冷却、仍然可用」的账号。
    if (status === 401 || (status === 403 && saysCredentialDead(detail))) return result('invalid_credential');
    // 2. 账号级限额：换号有用，冷却也要**很久**，因为它按账单周期而不是秒级背压。
    if (saysAccountLimit(detail)) return result('account_limit', 5 * 60 * 60 * 1000);
    // 3. 额度用尽：这是账号的事实而不是瞬时背压，重试同一个账号毫无意义。
    if (status === 429 && saysQuotaExhausted(detail)) return result('account_quota_exhausted', 60 * 60 * 1000);
    // 4. 上下文溢出：交给压缩路径，不是路由问题。
    if (saysContextOverflow(detail)) return result('context_overflow');
    if (status === 429) return result('rate_limit');
    if (status >= 500) return result('server');
    return result('provider_error');
}

/** 读出正文并分类，一次完成。 */
export async function classifyFailedResponse(response: Response): Promise<ClassifiedResponse> {
    let detail = '';
    try { detail = await response.text(); } catch { detail = ''; }
    return { detail, failure: classifySubscriptionFailure(response.status, detail) };
}

/** 这个失败是否值得换一个账号。 */
export function shouldRotateAccount(kind: SubscriptionFailureKind): boolean {
    return kind === 'invalid_credential' || kind === 'account_quota_exhausted' || kind === 'account_limit';
}

/** 这个失败是否值得原地重试同一个账号。 */
export function shouldRetrySameAccount(kind: SubscriptionFailureKind): boolean {
    return kind === 'server' || kind === 'rate_limit';
}

/** 正文里是否含一个可识别的 JSON 错误对象（诊断用）。 */
export function errorObjectOf(detail: string): Record<string, unknown> | undefined {
    const start = detail.indexOf('{');
    if (start < 0) return undefined;
    try {
        const parsed: unknown = JSON.parse(detail.slice(start));
        return isRecord(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}
