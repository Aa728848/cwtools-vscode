/**
 * WorkBuddy / CodeBuddy 订阅 HTTP 客户端、请求清洗、防风控协议适配、凭据续期与浏览器登录。
 *
 * 合并自参照仓库 `workbuddy/client.ts`、`workbuddy/mapper.ts`、`workbuddy/oauth.ts` 及 `workbuddy/adapter.ts`：
 * - 对话通道启用 WorkBuddy 5.9.3 桌面出站身份、5 个会话头（种子含 `accountKey`）、遥测/追踪头；
 * - OpenAI Chat Completions（`/v2/chat/completions`）强制 `stream: true`、`stream_options: { include_usage: true }`、
 *   `cache_retention: 'long'`、首条 system 兜底、`gpt-*` `max_tokens >= 16`、并发拆散 `tool_calls` 合并、缺失 tool
 *   结果补全及请求体 gzip 压缩；
 * - 国区 `claude-*` 模型走 `/v1/messages`（Anthropic Messages 明文 JSON + `anthropic-version: 2023-06-01` + Bearer）；
 * - 精准识别 `11140` 永久禁用、`11159` thinking signature 拒收、`11128` 渠道拦截/system 移位自愈、
 *   `6004`/`14003`/429 带精确重置时刻冷却与 `401/403` 防误杀分类。
 */

import * as zlib from 'node:zlib';
import { isRecord } from '../../../shared/protocolValidation';
import { aiText } from '../messages';
import type { WorkBuddyCredentials } from './credentials';
import {
    WORKBUDDY_ACCOUNT_PATH,
    WORKBUDDY_ANTHROPIC_VERSION,
    WORKBUDDY_CLIENT_PRODUCT,
    WORKBUDDY_CLIENT_USER_AGENT,
    WORKBUDDY_DISCOVERY_TIMEOUT_MS,
    WORKBUDDY_ERROR_CODE,
    WORKBUDDY_HEADER_DOMAIN,
    WORKBUDDY_HEADER_ENTERPRISE_ID,
    WORKBUDDY_HEADER_IDE_NAME,
    WORKBUDDY_HEADER_PRODUCT,
    WORKBUDDY_HEADER_REFRESH_SOURCE,
    WORKBUDDY_HEADER_REFRESH_TOKEN,
    WORKBUDDY_HEADER_REQUESTED_WITH,
    WORKBUDDY_HEADER_TENANT_ID,
    WORKBUDDY_HEADER_USER_ID,
    WORKBUDDY_LOGIN_PENDING_CODE,
    WORKBUDDY_LOGIN_PLATFORM,
    WORKBUDDY_LOGIN_POLL_INTERVAL_MS,
    WORKBUDDY_LOGIN_STATE_PATH,
    WORKBUDDY_LOGIN_TIMEOUT_MS,
    WORKBUDDY_LOGIN_TOKEN_PATH,
    WORKBUDDY_PROVIDER_NAME,
    WORKBUDDY_REFRESH_PATH,
    workBuddyBackendForDomain,
    workBuddyDomainForRegion,
    workBuddyRefreshSourceForDomain,
    workBuddyRegionForDomain,
    type WorkBuddyRegion,
} from './types';
import { withResolvedIdentity, type WorkBuddyTokenIdentity } from './identity';
import {
    type WorkBuddyOutboundProduct,
    buildWorkBuddyConversationHeaders,
    buildWorkBuddyTelemetryHeaders,
    resolveWorkBuddyChatUserAgent,
    sanitizeWorkBuddyText,
} from './outboundIdentity';

export interface WorkBuddyRequestOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
}

export interface WorkBuddyHeaderOptions {
    /** 标记为聊天请求（`/v2/chat/completions` 或 `/v1/messages`），将启用桌面 UA 与会话/链路头。 */
    chat?: boolean;
    /** 标记为 Anthropic `/v1/messages` 通道（附加 `anthropic-version`，不声明 `content-encoding: gzip`）。 */
    messages?: boolean;
    /** 是否附上 `content-encoding: gzip`（仅对非 Anthropic `/v2/chat/completions` 且开启 gzip 生效）。 */
    gzipBody?: boolean;
    /** 当前账号稳定身份键；开启对话防风控头时强烈建议传入以避免跨账号会话 ID 碰撞。 */
    accountKey?: string;
    /** 当前会话标识（相同对话可复现同组 conversationId）。 */
    sessionId?: string;
    /** 当前用户轮次键（由末条非工具 user 消息计算），使多轮工具步复用同一 requestId。 */
    turnKey?: string;
    /** 出站身份形态；默认 `'workbuddy'`。 */
    product?: WorkBuddyOutboundProduct;
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timer = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timer]) : timer;
}

/**
 * 构建 WorkBuddy 网关请求头。
 *
 * - 控制面请求（`/v3/config`、`/v2/plugin/*`、`/billing/meter/*`）发送 `CLI/2.63.2` + `CodeBuddyIDE`；
 * - 对话请求（`options.chat || options.messages`）发送桌面产品身份 UA、5 个会话识别头、
 *   WorkBuddy 遥测头及追踪头；`/v1/messages` 额外附带 `anthropic-version: 2023-06-01`。
 */
export function workBuddyHeaders(
    credentials: Pick<
        WorkBuddyCredentials,
        'accessToken' | 'domain' | 'region' | 'uid' | 'uin' | 'enterpriseId' | 'nickname'
    >,
    options: WorkBuddyHeaderOptions = {},
): Record<string, string> {
    const isChatRoute = options.chat === true || options.messages === true;
    const isMessagesRoute = options.messages === true;
    const domain = credentials.domain;
    const enterpriseId = credentials.enterpriseId ?? '';
    const identitySeed = credentials.uid || credentials.uin || credentials.nickname || domain;
    const accountKey = options.accountKey ?? `${credentials.region}:${identitySeed}`;

    const base: Record<string, string> = {
        authorization: `Bearer ${credentials.accessToken}`,
        'content-type': 'application/json',
        'user-agent': isChatRoute
            ? resolveWorkBuddyChatUserAgent(credentials.region, options.product ?? 'workbuddy')
            : WORKBUDDY_CLIENT_USER_AGENT,
        [WORKBUDDY_HEADER_DOMAIN]: domain,
        [WORKBUDDY_HEADER_PRODUCT]: WORKBUDDY_CLIENT_PRODUCT,
        [WORKBUDDY_HEADER_IDE_NAME]: isChatRoute ? 'WorkBuddy' : 'CodeBuddyIDE',
        [WORKBUDDY_HEADER_REQUESTED_WITH]: 'XMLHttpRequest',
        [WORKBUDDY_HEADER_USER_ID]: credentials.uid ?? '',
        [WORKBUDDY_HEADER_ENTERPRISE_ID]: enterpriseId,
        [WORKBUDDY_HEADER_TENANT_ID]: enterpriseId,
    };

    if (!isChatRoute) {
        return base;
    }

    const conversationHeaders = buildWorkBuddyConversationHeaders({
        accountKey,
        sessionId: options.sessionId,
        turnKey: options.turnKey,
    });
    const telemetryHeaders = buildWorkBuddyTelemetryHeaders(identitySeed);

    const out: Record<string, string> = {
        ...base,
        ...conversationHeaders,
        ...telemetryHeaders,
    };

    if (isMessagesRoute) {
        out['anthropic-version'] = WORKBUDDY_ANTHROPIC_VERSION;
        out.accept = 'text/event-stream';
    } else if (options.gzipBody === true) {
        out['content-encoding'] = 'gzip';
        out.accept = 'text/event-stream';
    }

    return out;
}

/** 将 JSON 文本压缩为 gzip 负载，对应 `/v2/chat/completions` 的 `content-encoding: gzip`。 */
export function gzipWorkBuddyBody(jsonText: string): Buffer {
    return zlib.gzipSync(Buffer.from(jsonText, 'utf8'));
}

// ---------------------------------------------------------------------------
// 消息清洗、历史修复与 11128 自愈
// ---------------------------------------------------------------------------

const WORKBUDDY_DEFAULT_SYSTEM_TEXT = 'You are a helpful assistant.';
const WORKBUDDY_INSTRUCTIONS_OPEN = '<INSTRUCTIONS>\n';
const WORKBUDDY_INSTRUCTIONS_CLOSE = '\n</INSTRUCTIONS>';
const WORKBUDDY_NO_TOOL_RESULT_TEXT = '[no result: the tool call did not complete]';
const WORKBUDDY_CHANNEL_REFUSAL_RE = /unapproved channel|illegal api invocation/i;

function sanitizeUnknownContent(content: unknown): unknown {
    if (typeof content === 'string') return sanitizeWorkBuddyText(content);
    if (!Array.isArray(content)) return content;
    return content.map(part => {
        if (!isRecord(part)) return part;
        if (part.type === 'text' && typeof part.text === 'string') {
            return { ...part, text: sanitizeWorkBuddyText(part.text) };
        }
        return part;
    });
}

function assistantTextOf(msg: Record<string, unknown>): string | undefined {
    if (msg.role !== 'assistant') return undefined;
    return typeof msg.content === 'string' ? msg.content : undefined;
}

function toolCallsOf(msg: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(msg.tool_calls)
        ? msg.tool_calls.filter((item): item is Record<string, unknown> => isRecord(item))
        : [];
}

function appendAssistantText(base: string, extra: string): string {
    if (extra === '') return base;
    if (base === '') return extra;
    if (/\s$/.test(base) || /^\s/.test(extra) || /[\u3000-\u9fff\uff00-\uff9f]/.test(base + extra)) {
        return base + extra;
    }
    return `${base} ${extra}`;
}

/**
 * 合并相邻拆散的 assistant tool_call 轮次。
 * WorkBuddy 上游把连续两段包含 tool_calls 的 assistant 视为单批调用拆裂，若不合并后续轮次会报错。
 */
export function mergeSplitWorkBuddyToolCallBatches(
    messages: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
    const repaired: Record<string, unknown>[] = [];
    for (const raw of messages) {
        const msg: Record<string, unknown> = { ...raw };
        if (Array.isArray(msg.tool_calls)) {
            msg.tool_calls = msg.tool_calls.map(tc => {
                if (!isRecord(tc)) return tc;
                const fn = isRecord(tc.function) ? tc.function : undefined;
                if (!fn) return tc;
                return {
                    ...tc,
                    function: {
                        ...fn,
                        ...(typeof fn.arguments === 'string'
                            ? { arguments: sanitizeWorkBuddyText(fn.arguments) }
                            : {}),
                    },
                };
            });
        }
        const text = assistantTextOf(msg);
        const calls = toolCallsOf(msg);
        const previous = repaired.length > 0 ? repaired[repaired.length - 1] : undefined;
        const previousText = previous ? assistantTextOf(previous) : undefined;
        if (
            text !== undefined
            && previous !== undefined
            && previousText !== undefined
            && (calls.length > 0 || toolCallsOf(previous).length > 0)
        ) {
            repaired[repaired.length - 1] = {
                ...previous,
                content: appendAssistantText(previousText, text),
                tool_calls: [...toolCallsOf(previous), ...calls],
            };
            continue;
        }
        repaired.push(msg);
    }
    return repaired;
}

/**
 * 为未收到对应 `role: "tool"` 应答的 tool_call 补入固定占位答复，防止网关整轮拒绝。
 */
export function fillMissingWorkBuddyToolResults(
    messages: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
    const repaired: Record<string, unknown>[] = [];
    let index = 0;
    while (index < messages.length) {
        const msg = messages[index]!;
        repaired.push(msg);
        index += 1;
        if (msg.role !== 'assistant') continue;
        const calls = toolCallsOf(msg);
        if (calls.length === 0) continue;

        const answered = new Set<string>();
        const results: Record<string, unknown>[] = [];
        while (index < messages.length && messages[index]!.role !== 'assistant') {
            const nextMsg = messages[index]!;
            if (nextMsg.role === 'tool' && typeof nextMsg.tool_call_id === 'string') {
                answered.add(nextMsg.tool_call_id);
            }
            results.push(nextMsg);
            index += 1;
        }

        const invented: Record<string, unknown>[] = [];
        for (const call of calls) {
            const id = typeof call.id === 'string' ? call.id : '';
            if (id === '' || answered.has(id)) continue;
            invented.push({ role: 'tool', tool_call_id: id, content: WORKBUDDY_NO_TOOL_RESULT_TEXT });
        }

        let insertAt = results.length;
        while (insertAt > 0 && results[insertAt - 1]!.role === 'user') {
            insertAt -= 1;
        }
        repaired.push(...results.slice(0, insertAt), ...invented, ...results.slice(insertAt));
    }
    return repaired;
}

function plainTextOfContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const part of content) {
        if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
    }
    return parts.join('\n');
}

/** 从 Chat Completions 或 Claude Messages 消息配列计算当前用户提问轮次键。 */
export function extractWorkBuddyUserTurnKey(messages: unknown): string {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (!isRecord(msg) || msg.role !== 'user') continue;
        if (Array.isArray(msg.content) && msg.content.every(b => isRecord(b) && b.type === 'tool_result')) {
            continue;
        }
        const text = plainTextOfContent(msg.content).trim();
        if (text !== '') return `${i}:${text}`;
    }
    return '';
}

/**
 * 预处理发送给 WorkBuddy `/v2/chat/completions` 的请求体：
 * 1. 清洗消息中的客户端指纹与 NUL 字符；
 * 2. 确保首条消息为 `system`（缺少时补入中性默认 `'You are a helpful assistant.'`）；
 * 3. 合并连续拆散 `tool_calls`、补齐悬空 `tool_call`；
 * 4. 强制 `stream: true`、`stream_options: { include_usage: true }` 与 `cache_retention: 'long'`；
 * 5. 为 `gpt-*` 模型钳位 `max_tokens >= 16`。
 */
export function prepareWorkBuddyChatPayload(body: Record<string, unknown>): Record<string, unknown> {
    const rawMessages = Array.isArray(body.messages)
        ? body.messages.filter((m): m is Record<string, unknown> => isRecord(m))
        : [];
    const sanitizedMessages = rawMessages.map(m => ({
        ...m,
        content: sanitizeUnknownContent(m.content),
    }));
    const merged = mergeSplitWorkBuddyToolCallBatches(sanitizedMessages);
    const repaired = fillMissingWorkBuddyToolResults(merged);

    if (repaired.length === 0 || repaired[0]!.role !== 'system') {
        repaired.unshift({ role: 'system', content: WORKBUDDY_DEFAULT_SYSTEM_TEXT });
    } else if (typeof repaired[0]!.content === 'string' && repaired[0]!.content.trim() === '') {
        repaired[0] = { ...repaired[0]!, content: WORKBUDDY_DEFAULT_SYSTEM_TEXT };
    }

    const out: Record<string, unknown> = {
        ...body,
        messages: repaired,
        stream: true,
        stream_options: { include_usage: true },
        cache_retention: 'long',
    };

    const modelId = typeof body.model === 'string' ? body.model.trim() : '';
    if (/^gpt-/i.test(modelId) && typeof out.max_tokens === 'number' && out.max_tokens < 16) {
        out.max_tokens = 16;
    }
    return out;
}

/** 预处理发送给 WorkBuddy 国区 `/v1/messages`（Anthropic Messages）的请求体。 */
export function prepareWorkBuddyMessagesPayload(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...body, stream: true };
    if (typeof body.system === 'string') {
        out.system = sanitizeWorkBuddyText(body.system);
    } else if (Array.isArray(body.system)) {
        out.system = sanitizeUnknownContent(body.system);
    }
    if (Array.isArray(body.messages)) {
        out.messages = body.messages.map(m => {
            if (!isRecord(m)) return m;
            return { ...m, content: sanitizeUnknownContent(m.content) };
        });
    }
    return out;
}

/** 判断 11128 拒绝正文是否为可用 `<INSTRUCTIONS>` 移位自愈的渠道拒绝。 */
export function isWorkBuddyChannelRefusal11128(detail: string): boolean {
    return WORKBUDDY_CHANNEL_REFUSAL_RE.test(detail);
}

/** 计算当前请求中所有 system 文本合并后的主键；只有默认中性提示时返回空串。 */
export function workBuddyChatSystemKey(body: unknown): string {
    if (!isRecord(body) || !Array.isArray(body.messages)) return '';
    const joined = body.messages
        .filter((m): m is Record<string, unknown> => isRecord(m) && m.role === 'system')
        .map(m => plainTextOfContent(m.content))
        .join('\n')
        .trim();
    return joined === WORKBUDDY_DEFAULT_SYSTEM_TEXT ? '' : joined;
}

/**
 * 在遭遇 11128 渠道拒绝时，将前导自定义 `system` 内容搬进首条 `user` 消息的
 * `<INSTRUCTIONS>` 标签，并将开首 `system` 重设为中性提示；若无可搬移内容则返回 `null`。
 */
export function relocateWorkBuddySystemToInstructions(body: Record<string, unknown>): Record<string, unknown> | null {
    const messages = Array.isArray(body.messages)
        ? body.messages.filter((m): m is Record<string, unknown> => isRecord(m))
        : [];

    let lead = 0;
    const leading: string[] = [];
    for (; lead < messages.length && messages[lead]!.role === 'system'; lead += 1) {
        leading.push(plainTextOfContent(messages[lead]!.content));
    }
    const said = leading.join('\n\n').trim();
    const rest = messages.slice(lead).map(m => (m.role === 'system' ? { ...m, role: 'user' } : m));
    const moved = said !== '' && said !== WORKBUDDY_DEFAULT_SYSTEM_TEXT;
    const retyped = rest.some((m, idx) => m !== messages[lead + idx]);
    if (!moved && !retyped) return null;

    if (moved) {
        const wrapped = `${WORKBUDDY_INSTRUCTIONS_OPEN}${said}${WORKBUDDY_INSTRUCTIONS_CLOSE}`;
        const firstUserIndex = rest.findIndex(m => m.role === 'user');
        if (firstUserIndex < 0) {
            rest.unshift({ role: 'user', content: wrapped });
        } else {
            const target = rest[firstUserIndex]!;
            const content = target.content;
            if (typeof content === 'string') {
                rest[firstUserIndex] = { ...target, content: `${wrapped}\n\n${content}` };
            } else if (Array.isArray(content)) {
                rest[firstUserIndex] = { ...target, content: [{ type: 'text', text: wrapped }, ...content] };
            } else {
                rest[firstUserIndex] = { ...target, content: wrapped };
            }
        }
    }

    return {
        ...body,
        messages: [{ role: 'system', content: WORKBUDDY_DEFAULT_SYSTEM_TEXT }, ...rest],
    };
}

// ---------------------------------------------------------------------------
// 错误码解析与号池分类
// ---------------------------------------------------------------------------

/** 从 WorkBuddy 响应正文读取数字业务错误码（如 `11140`、`11159`、`11128`、`6004`、`14003`）。 */
export function readWorkBuddyErrorCode(detail: string): number | null {
    const matched = /"code"\s*:\s*(\d+)/.exec(detail);
    if (matched === null) return null;
    const parsed = Number(matched[1]);
    return Number.isFinite(parsed) ? parsed : null;
}

const MAX_RESET_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_STAMP_RE = /(?:resets?\s+at|reset\s+at|将在)\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;
const RESET_TZ_RE = /UTC([+-])(\d{1,2})(?::?(\d{2}))?/;

/** 从 429 / 6004 响应文本中提取精确额度重置延迟（毫秒）。 */
export function readWorkBuddyRateLimitReset(detail: string, now = Date.now()): number | undefined {
    const stamp = RESET_STAMP_RE.exec(detail);
    if (stamp === null) return undefined;
    const [, date, clock] = stamp;
    const parts = `${date} ${clock}`.split(/[- :]/).map(Number);
    const [year, month, day, hour, minute, second] = parts;
    if (parts.length !== 6 || parts.some(part => !Number.isFinite(part))) return undefined;

    const zone = RESET_TZ_RE.exec(detail);
    let offsetMs = 0;
    if (zone !== null) {
        const hours = Number(zone[2] ?? '0');
        const minutes = Number(zone[3] ?? '0');
        const sign = zone[1] === '-' ? -1 : 1;
        offsetMs = sign * (hours * 60 + minutes) * 60_000;
    }

    const at = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0) - offsetMs;
    if (!Number.isFinite(at)) return undefined;
    const delay = at - now;
    if (delay <= 0 || delay > MAX_RESET_HORIZON_MS) return undefined;
    return delay;
}

function namesRejectedCredential(detail: string): boolean {
    return /invalid_grant|invalid_token|invalid credential/i.test(detail);
}

/** 正向证明 403 来自中间件/策略拦截而非凭据失活。 */
function refusalIsNotCredential(detail: string): boolean {
    const text = detail.trim();
    if (!text.startsWith('{')) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return false; }
    if (!isRecord(parsed)) return false;
    const inner = isRecord(parsed.error) ? parsed.error : parsed;
    if (typeof inner.code === 'number' || typeof parsed.code === 'number') return false;
    if (typeof inner.code === 'string' && inner.code !== '') return true;
    const retryable = inner.retryable ?? parsed.retryable;
    const hasMessage = typeof inner.message === 'string' || typeof parsed.message === 'string';
    if (retryable === false && hasMessage) return true;
    const type = inner.type ?? parsed.type;
    return type === 'server_error' && hasMessage;
}

export type WorkBuddyFailureClassification =
    | { kind: 'account_restricted'; code: number; detail: string; permanent: true }
    | { kind: 'auth_failed'; detail: string; permanent: boolean }
    | { kind: 'rate_limited'; retryAfterMs?: number; detail: string }
    | { kind: 'model_unavailable'; detail: string }
    | { kind: 'thinking_signature_refused'; detail: string }
    | { kind: 'channel_refusal_11128'; canRelocateSystem: boolean; detail: string }
    | { kind: 'transient'; detail: string }
    | { kind: 'provider_error'; detail: string };

/**
 * 解析 HTTP Retry-After 响应头。
 */
export function parseRetryAfterMs(headers?: { get?(name: string): string | null }): number | undefined {
    const raw = headers?.get?.('retry-after');
    if (!raw) return undefined;
    const trimmed = raw.trim();
    const secs = Number(trimmed);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const ts = Date.parse(trimmed);
    if (Number.isFinite(ts)) {
        const diff = ts - Date.now();
        return diff > 0 ? diff : undefined;
    }
    return undefined;
}

/** 对 WorkBuddy 对话端点的失败响应进行精细分级，避免把链路/中间件拦截误伤为全池凭据死亡。 */
export function classifyWorkBuddyFailure(
    status: number,
    detail: string,
    headers?: { get?(name: string): string | null },
    now = Date.now(),
): WorkBuddyFailureClassification {
    const code = readWorkBuddyErrorCode(detail);

    if (code === WORKBUDDY_ERROR_CODE.ACCOUNT_RESTRICTED) {
        return { kind: 'account_restricted', code, detail, permanent: true };
    }
    if (code === WORKBUDDY_ERROR_CODE.THINKING_SIGNATURE_INVALID) {
        return { kind: 'thinking_signature_refused', detail };
    }
    if (code === WORKBUDDY_ERROR_CODE.SECURITY_BLOCKED) {
        return {
            kind: 'channel_refusal_11128',
            canRelocateSystem: isWorkBuddyChannelRefusal11128(detail),
            detail,
        };
    }
    if (status === 429 || code === WORKBUDDY_ERROR_CODE.RATE_LIMITED || code === WORKBUDDY_ERROR_CODE.USAGE_LIMIT) {
        const retryAfterMs = parseRetryAfterMs(headers) ?? readWorkBuddyRateLimitReset(detail, now);
        return { kind: 'rate_limited', retryAfterMs, detail };
    }
    if (code === WORKBUDDY_ERROR_CODE.MODEL_UNAVAILABLE) {
        return { kind: 'model_unavailable', detail };
    }
    if (status === 401) {
        return namesRejectedCredential(detail)
            ? { kind: 'auth_failed', detail, permanent: false }
            : { kind: 'provider_error', detail };
    }
    if (status === 403) {
        return refusalIsNotCredential(detail)
            ? { kind: 'provider_error', detail }
            : { kind: 'auth_failed', detail, permanent: false };
    }
    if (status >= 500 || status === 408 || code === WORKBUDDY_ERROR_CODE.UPSTREAM_ERROR) {
        return { kind: 'transient', detail };
    }
    return { kind: 'provider_error', detail };
}

// ---------------------------------------------------------------------------
// 刷新与身份补充
// ---------------------------------------------------------------------------

/** 使用保存的 `refreshToken` 刷新访问令牌，保留非空的原身份声明。 */
export async function refreshWorkBuddyCredentials(
    credentials: WorkBuddyCredentials,
    options: WorkBuddyRequestOptions = {},
): Promise<WorkBuddyCredentials> {
    if (!credentials.refreshToken) {
        throw new Error(`${WORKBUDDY_PROVIDER_NAME}：当前凭据没有 refresh token，请重新登录。`);
    }
    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(`${credentials.backend}${WORKBUDDY_REFRESH_PATH}`, {
        method: 'POST',
        headers: {
            ...workBuddyHeaders(credentials),
            [WORKBUDDY_HEADER_REFRESH_TOKEN]: credentials.refreshToken,
            [WORKBUDDY_HEADER_REFRESH_SOURCE]: workBuddyRefreshSourceForDomain(credentials.domain),
        },
        signal: timeoutSignal(options.signal, WORKBUDDY_DISCOVERY_TIMEOUT_MS),
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
        throw new Error(`${WORKBUDDY_PROVIDER_NAME} token refresh failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const payload = isRecord(parsed) ? parsed : undefined;
    const data = isRecord(payload?.data) ? payload.data : undefined;
    if (payload === undefined || payload.code !== 0 || data === undefined) {
        throw new Error(`${WORKBUDDY_PROVIDER_NAME} token refresh was rejected: ${asString(payload?.msg) ?? 'no detail'}`);
    }

    const accessToken = asString(data.accessToken);
    if (accessToken === undefined) {
        throw new Error(`${WORKBUDDY_PROVIDER_NAME} token refresh returned no access token`);
    }

    const expiresIn = asNumber(data.expiresIn);
    const expiresAt = asNumber(data.expiresAt)
        ?? (expiresIn === undefined ? credentials.expiresAt : Date.now() + expiresIn * 1000);
    const domain = asString(data.domain) ?? credentials.domain;

    return withResolvedIdentity({
        ...credentials,
        accessToken,
        refreshToken: asString(data.refreshToken) ?? credentials.refreshToken,
        expiresAt,
        domain,
        region: workBuddyRegionForDomain(domain),
        backend: workBuddyBackendForDomain(domain),
    });
}

/** 从 `/v2/plugin/account` 补全浏览器登录回调缺失的 `uid`/`nickname`/`uin`/`enterpriseId`。失败不阻断登录。 */
export async function fetchWorkBuddyIdentity(
    credentials: WorkBuddyCredentials,
    options: WorkBuddyRequestOptions = {},
): Promise<WorkBuddyTokenIdentity | null> {
    const fetchFn = options.fetchFn ?? fetch;
    try {
        const response = await fetchFn(`${credentials.backend}${WORKBUDDY_ACCOUNT_PATH}`, {
            headers: workBuddyHeaders(credentials),
            signal: timeoutSignal(options.signal, WORKBUDDY_DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const parsed = JSON.parse(await response.text()) as unknown;
        if (!isRecord(parsed) || parsed.code !== 0 || !isRecord(parsed.data)) return null;
        const account = parsed.data;
        const identity: WorkBuddyTokenIdentity = {};
        const uid = asString(account.uid);
        if (uid !== undefined) identity.uid = uid;
        const nickname = asString(account.nickname);
        if (nickname !== undefined) identity.nickname = nickname;
        const uin = asString(account.uin);
        if (uin !== undefined) identity.uin = uin;
        const enterpriseId = asString(account.enterpriseId);
        if (enterpriseId !== undefined) identity.enterpriseId = enterpriseId;
        const accountType = asString(account.type) ?? asString(account.accountType);
        if (accountType !== undefined) identity.accountType = accountType;
        return identity;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// 官方浏览器授权登录（OAuth Service）
// ---------------------------------------------------------------------------

export interface WorkBuddyLoginAttempt {
    state: string;
    authUrl: string;
    region: WorkBuddyRegion;
    domain: string;
}

function loginHeaders(domain: string): Record<string, string> {
    const backend = workBuddyBackendForDomain(domain);
    const intl = workBuddyRegionForDomain(domain) === 'intl';
    return {
        'content-type': 'application/json',
        accept: 'application/json',
        [WORKBUDDY_HEADER_DOMAIN]: domain,
        [WORKBUDDY_HEADER_PRODUCT]: WORKBUDDY_CLIENT_PRODUCT,
        [WORKBUDDY_HEADER_IDE_NAME]: 'CodeBuddyIDE',
        [WORKBUDDY_HEADER_REQUESTED_WITH]: 'XMLHttpRequest',
        'user-agent': WORKBUDDY_CLIENT_USER_AGENT,
        ...(intl ? { origin: backend, referer: `${backend}/` } : {}),
    };
}

/** 申请一条 WorkBuddy 浏览器登录会话。 */
export async function requestWorkBuddyLoginState(
    region: WorkBuddyRegion,
    fetchFn: typeof fetch = fetch,
    signal?: AbortSignal,
): Promise<WorkBuddyLoginAttempt> {
    const domain = workBuddyDomainForRegion(region);
    const backend = workBuddyBackendForDomain(domain);
    const response = await fetchFn(`${backend}${WORKBUDDY_LOGIN_STATE_PATH}?platform=${WORKBUDDY_LOGIN_PLATFORM}`, {
        method: 'POST',
        headers: loginHeaders(domain),
        body: '{}',
        signal: timeoutSignal(signal, WORKBUDDY_DISCOVERY_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    let root: Record<string, unknown> | undefined;
    try {
        const parsed = JSON.parse(text) as unknown;
        root = isRecord(parsed) ? parsed : undefined;
    } catch {
        root = undefined;
    }
    if (!response.ok || root?.code !== 0 || !isRecord(root.data)) {
        const detail = asString(root?.msg) ?? text.slice(0, 160);
        throw new Error(aiText(
            `WorkBuddy login init failed (${response.status})${detail ? `: ${detail}` : ''}`,
            `WorkBuddy 发起登录失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
        ));
    }
    const state = asString(root.data.state);
    const authUrl = asString(root.data.authUrl);
    if (!state || !authUrl) {
        throw new Error(aiText(
            'WorkBuddy login init returned incomplete state or authUrl.',
            'WorkBuddy 登录初始化响应缺少 state 或授权地址。',
        ));
    }
    return { state, authUrl, region, domain };
}

/** 解析令牌轮询响应；若仍在等待授权返回 `null`，失败抛出明确异常。 */
export function parseWorkBuddyLoginCredential(
    payload: unknown,
    attempt: WorkBuddyLoginAttempt,
): WorkBuddyCredentials | null {
    if (!isRecord(payload)) {
        throw new Error(aiText(
            'WorkBuddy login poll returned invalid JSON object.',
            'WorkBuddy 登录轮询响应格式无效。',
        ));
    }
    const code = asNumber(payload.code);
    if (code === WORKBUDDY_LOGIN_PENDING_CODE) return null;
    if (code !== 0) {
        const msg = asString(payload.msg) ?? `code ${String(code)}`;
        throw new Error(aiText(
            `WorkBuddy login failed: ${msg}`,
            `WorkBuddy 登录失败：${msg}`,
        ));
    }
    const data = isRecord(payload.data) ? payload.data : payload;
    const auth = isRecord(data.auth) ? data.auth : data;
    const account = isRecord(data.account) ? data.account
        : isRecord(auth.account) ? auth.account
            : isRecord(data.user) ? data.user
                : isRecord(auth.user) ? auth.user
                    : {};
    const accessToken = asString(auth.accessToken) ?? asString(auth.access_token) ?? asString(data.token);
    if (!accessToken) {
        throw new Error(aiText(
            'WorkBuddy login succeeded but response contained no access token.',
            'WorkBuddy 登录完成但未返回访问令牌。',
        ));
    }
    const domain = asString(auth.domain) ?? attempt.domain;
    const expiresIn = asNumber(auth.expiresIn) ?? asNumber(auth.expires_in);
    const expiresAt = asNumber(auth.expiresAt) ?? asNumber(auth.expires_at)
        ?? (expiresIn === undefined ? Date.now() + 3600_000 : Date.now() + expiresIn * 1000);

    return withResolvedIdentity({
        accessToken,
        refreshToken: asString(auth.refreshToken) ?? asString(auth.refresh_token)
            ?? asString(data.refreshToken) ?? asString(data.refresh_token) ?? '',
        expiresAt,
        region: workBuddyRegionForDomain(domain),
        domain,
        backend: workBuddyBackendForDomain(domain),
        ...(asString(account.uid) ?? asString(data.uid) ? { uid: asString(account.uid) ?? asString(data.uid) } : {}),
        ...(asString(account.nickname) ?? asString(account.name) ?? asString(data.nickname)
            ? { nickname: asString(account.nickname) ?? asString(account.name) ?? asString(data.nickname) } : {}),
        ...(asString(account.uin) ?? asString(data.uin) ? { uin: asString(account.uin) ?? asString(data.uin) } : {}),
        ...(asString(account.type) ?? asString(data.accountType)
            ? { accountType: asString(account.type) ?? asString(data.accountType) } : {}),
        ...(asString(account.enterpriseId) ?? asString(data.enterpriseId)
            ? { enterpriseId: asString(account.enterpriseId) ?? asString(data.enterpriseId) } : {}),
        sourceFile: '',
        sourceMtimeMs: 0,
        source: 'managed' as const,
    });
}

/** 轮询一次登录状态。 */
export async function pollWorkBuddyLogin(
    attempt: WorkBuddyLoginAttempt,
    fetchFn: typeof fetch = fetch,
    signal?: AbortSignal,
): Promise<WorkBuddyCredentials | null> {
    const backend = workBuddyBackendForDomain(attempt.domain);
    const url = `${backend}${WORKBUDDY_LOGIN_TOKEN_PATH}?platform=${WORKBUDDY_LOGIN_PLATFORM}&state=${encodeURIComponent(attempt.state)}`;
    const response = await fetchFn(url, {
        headers: loginHeaders(attempt.domain),
        signal: timeoutSignal(signal, WORKBUDDY_DISCOVERY_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
        throw new Error(aiText(
            `WorkBuddy login poll failed (${response.status})${text ? `: ${text.slice(0, 160)}` : ''}`,
            `WorkBuddy 登录状态轮询失败（HTTP ${response.status}）${text ? `：${text.slice(0, 160)}` : ''}`,
        ));
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch {
        throw new Error(aiText(
            'WorkBuddy login poll returned invalid JSON.',
            'WorkBuddy 登录状态响应不是合法 JSON。',
        ));
    }
    return parseWorkBuddyLoginCredential(payload, attempt);
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export interface WorkBuddyLogin {
    region: WorkBuddyRegion;
    authUrl: string;
    completion: Promise<WorkBuddyCredentials>;
    cancel: () => void;
}

export interface WorkBuddyOAuthOptions {
    fetchFn?: typeof fetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
    resolveIdentity?: (credentials: WorkBuddyCredentials) => Promise<WorkBuddyTokenIdentity | null>;
}

/** 管理 WorkBuddy 浏览器授权登录流（单并发取消前一次登录，完成后补全账号 uid/昵称）。 */
export class WorkBuddyOAuthService {
    private activeCancel: (() => void) | undefined;

    constructor(private readonly options: WorkBuddyOAuthOptions = {}) {}

    async startLogin(region: WorkBuddyRegion = 'cn'): Promise<WorkBuddyLogin> {
        this.cancelActive();
        const fetchFn = this.options.fetchFn ?? fetch;
        const controller = new AbortController();
        this.activeCancel = () => controller.abort();
        try {
            const attempt = await requestWorkBuddyLoginState(region, fetchFn, controller.signal);
            const completion = this.waitForAuthorization(attempt, controller);
            return {
                region,
                authUrl: attempt.authUrl,
                completion,
                cancel: () => controller.abort(),
            };
        } catch (error) {
            this.activeCancel = undefined;
            throw error;
        }
    }

    cancelActive(): void {
        if (!this.activeCancel) return;
        const cancel = this.activeCancel;
        this.activeCancel = undefined;
        cancel();
    }

    private async waitForAuthorization(
        attempt: WorkBuddyLoginAttempt,
        controller: AbortController,
    ): Promise<WorkBuddyCredentials> {
        const fetchFn = this.options.fetchFn ?? fetch;
        const pollMs = this.options.pollIntervalMs ?? WORKBUDDY_LOGIN_POLL_INTERVAL_MS;
        const deadline = Date.now() + (this.options.timeoutMs ?? WORKBUDDY_LOGIN_TIMEOUT_MS);
        const resolveIdentity = this.options.resolveIdentity
            ?? (creds => fetchWorkBuddyIdentity(creds, { fetchFn, signal: controller.signal }));
        try {
            while (!controller.signal.aborted) {
                const creds = await pollWorkBuddyLogin(attempt, fetchFn, controller.signal);
                if (creds) {
                    const identity = await resolveIdentity(creds).catch(() => null);
                    if (identity === null) return creds;
                    return {
                        ...creds,
                        ...(identity.uid ? { uid: identity.uid } : {}),
                        ...(identity.nickname ? { nickname: identity.nickname } : {}),
                        ...(identity.uin ? { uin: identity.uin } : {}),
                        ...(identity.enterpriseId ? { enterpriseId: identity.enterpriseId } : {}),
                        ...(identity.accountType ? { accountType: identity.accountType } : {}),
                    };
                }
                if (Date.now() >= deadline) {
                    throw new Error(aiText(
                        'WorkBuddy login timed out. Start a fresh browser sign-in.',
                        'WorkBuddy 登录已超时，请重新发起浏览器登录。',
                    ));
                }
                await waitWithSignal(pollMs, controller.signal);
            }
            throw new Error(aiText('WorkBuddy login was cancelled.', 'WorkBuddy 登录已取消。'));
        } finally {
            if (this.activeCancel) this.activeCancel = undefined;
        }
    }
}
