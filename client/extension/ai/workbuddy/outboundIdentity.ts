/**
 * WorkBuddy / CodeBuddy 订阅出站桌面客户端身份、对话防风控头、链路追踪头及客户端指纹脱敏。
 *
 * 与参照仓库（`dsh-chatgpt-subscription` `outbound-identity.ts` / `client.ts`）对齐：
 * - 对话端点要求桌面客户端身份组合：`WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0`（国区）或
 *   `WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0`（国际区），并附带 `X-Agent-*`、`X-IDE-*`、
 *   `X-Stainless-*`、`X-Machine-ID`、`X-Root-Request-ID` 与 traceparent / B3 追踪头；
 * - 网关渠道风控校验要求成组发送 5 个会话标识头（`x-conversation-id`、`x-conversation-request-id`、
 *   `acp-connection-id`、`x-conversation-message-id`、`x-request-id`），且生成种子必须混入当前账号标识，
 *   保证号池切号时不发生跨账号 conversation-id 碰撞（否则会触发 `code 11128`）；
 * - 指纹脱敏重写 `IDENTITY_FINGERPRINT_REWRITES` 清除/替换可能触发渠道拒绝的宿主机标志与 NUL 字符。
 */

import { createHash } from 'node:crypto';
import type { WorkBuddyRegion } from './types';

export type WorkBuddyOutboundProduct = 'workbuddy' | 'cli';

export const WORKBUDDY_DESKTOP_VERSION = '5.9.3';
export const WORKBUDDY_CLI_VERSION = '2.165.0';
export const WORKBUDDY_STAINLESS_PACKAGE_VERSION = '6.25.0';
export const WORKBUDDY_STAINLESS_RUNTIME_VERSION = 'v22.21.1';
export const WORKBUDDY_STAINLESS_TIMEOUT = '1200';

/**
 * 按区域生成桌面聊天请求 User-Agent；当产品模式回退为 `cli` 时返回传统 CLI User-Agent。
 */
export function resolveWorkBuddyChatUserAgent(
    region: WorkBuddyRegion,
    product: WorkBuddyOutboundProduct = 'workbuddy',
): string {
    if (product === 'cli') return 'CLI/2.63.2 CodeBuddy/2.63.2';
    return region === 'intl'
        ? `WorkBuddy/${WORKBUDDY_DESKTOP_VERSION} workbuddy-ai/${WORKBUDDY_DESKTOP_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`
        : `WorkBuddy/${WORKBUDDY_DESKTOP_VERSION} WorkBuddy/${WORKBUDDY_DESKTOP_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`;
}

/** 把任意长度 SHA-256 摘要字节映射成 UUIDv4 形态字符串。 */
function formatUuidV4(bytes: Buffer): string {
    const out = Buffer.from(bytes.subarray(0, 16));
    out[6] = (out[6]! & 0x0f) | 0x40;
    out[8] = (out[8]! & 0x3f) | 0x80;
    const hex = out.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sha256Uuid(seed: string): string {
    return formatUuidV4(createHash('sha256').update(seed).digest());
}

/** 基于账号 uid（或稳定备用标识）派生固定且不随进程漂移的 `X-Machine-ID`。 */
export function deriveWorkBuddyMachineId(identitySeed: string): string {
    const digest = createHash('md5').update(`machine:${identitySeed || 'default'}`).digest();
    return formatUuidV4(digest);
}

function stainlessOs(): string {
    switch (process.platform) {
        case 'win32': return 'Windows';
        case 'darwin': return 'MacOS';
        case 'linux': return 'Linux';
        default: return process.platform;
    }
}

function stainlessArch(): string {
    switch (process.arch) {
        case 'x64': return 'x64';
        case 'arm64': return 'arm64';
        case 'ia32': return 'x86';
        default: return process.arch;
    }
}

export interface WorkBuddyConversationHeaderOptions {
    /** 当前选用账号的唯一主键，必须混入种子以防止切号时复用同名会话触发 11128。 */
    accountKey: string;
    /** 当前会话 / 轮次稳定标识；不传则按请求随机盐化避免碰撞。 */
    sessionId?: string;
    /** 当前用户发言轮次键（由末条非工具 user 消息位置与文本派生），同一工具循环中保持一致。 */
    turnKey?: string;
}

/**
 * 生成同组发送的 5 个会话追踪头及对应的 `X-Root-Request-ID`。
 */
export function buildWorkBuddyConversationHeaders(options: WorkBuddyConversationHeaderOptions): Record<string, string> {
    const sessionSeed = options.sessionId?.trim() || `${options.accountKey}:${Date.now()}:${Math.random()}`;
    const convSeed = `${options.accountKey}|${sessionSeed}`;
    const conversationId = sha256Uuid(`conv:${convSeed}`);
    const connectionId = sha256Uuid(`conn:${convSeed}`);

    const turnSeed = options.turnKey?.trim()
        ? `${convSeed}|${options.turnKey.trim()}`
        : `${convSeed}|oneshot:${Date.now()}:${Math.random()}`;
    const requestId = sha256Uuid(`req:${turnSeed}`);
    const messageId = sha256Uuid(`msg:${turnSeed}`);

    return {
        'x-conversation-id': conversationId,
        'x-conversation-request-id': requestId,
        'acp-connection-id': connectionId,
        'x-conversation-message-id': messageId,
        'x-request-id': requestId,
        'X-Root-Request-ID': requestId,
    };
}

/** 构建 WorkBuddy 桌面 Agent 遥测与 Stainless Runtime 请求头。 */
export function buildWorkBuddyTelemetryHeaders(identitySeed: string): Record<string, string> {
    const traceId = createHash('sha256')
        .update(`trace:${identitySeed}:${Date.now()}:${Math.random()}`)
        .digest('hex')
        .slice(0, 32);
    const spanId = traceId.slice(16, 32);
    const shortSpan = traceId.slice(0, 16);

    return {
        'X-Agent-Intent': 'craft',
        'X-Agent-Purpose': 'conversation',
        'X-Agent-Type': 'main',
        'X-Agent-Runtime': 'local-agent',
        'X-IDE-Name': 'WorkBuddy',
        'X-IDE-Type': 'WorkBuddy',
        'X-IDE-Version': WORKBUDDY_DESKTOP_VERSION,
        'X-Private-Data': 'true',
        'X-Machine-ID': deriveWorkBuddyMachineId(identitySeed),
        'X-Stainless-Lang': 'js',
        'X-Stainless-Package-Version': WORKBUDDY_STAINLESS_PACKAGE_VERSION,
        'X-Stainless-Runtime': 'node',
        'X-Stainless-Runtime-Version': WORKBUDDY_STAINLESS_RUNTIME_VERSION,
        'X-Stainless-Retry-Count': '0',
        'X-Stainless-Timeout': WORKBUDDY_STAINLESS_TIMEOUT,
        'X-Stainless-OS': stainlessOs(),
        'X-Stainless-Arch': stainlessArch(),
        'X-Trace-ID': traceId,
        traceparent: `00-${traceId}-${spanId}-01`,
        b3: `${traceId}-${spanId}-1`,
        'X-B3-TraceId': traceId,
        'X-B3-SpanId': shortSpan,
        'X-B3-Sampled': '1',
    };
}

/**
 * 易触发上游渠道识别拦截的第三方 Harness/CLI 身份指纹改写规则表。
 */
export const WORKBUDDY_IDENTITY_FINGERPRINT_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
    [/^\s*x-anthropic-billing-header:[^\r\n]*[\r\n]*/gim, ''],
    [/You are an AI agent powered by DeepSeek Harness\./gi, 'You are an AI assistant.'],
    [/powered by DeepSeek Harness/gi, 'as an AI assistant'],
    [/DeepSeek Harness/gi, 'assistant workspace'],
    [/You are Claude Code, Anthropic's official CLI for Claude\./gi, 'You are an AI coding assistant.'],
    [/You are Codex, based on GPT-[^\r\n.]*\./gi, 'You are an AI coding assistant.'],
    [/\bOhMyOpenCode\b/gi, 'coding-assistant'],
];

/** 对发送往 WorkBuddy 网关的文本移除 NUL 字符并清洗第三方客户端指纹。 */
export function sanitizeWorkBuddyText(text: string): string {
    if (!text) return '';
    let sanitized = text.replace(/\0/g, '');
    for (const [pattern, replacement] of WORKBUDDY_IDENTITY_FINGERPRINT_REWRITES) {
        sanitized = sanitized.replace(pattern, replacement);
    }
    return sanitized;
}
