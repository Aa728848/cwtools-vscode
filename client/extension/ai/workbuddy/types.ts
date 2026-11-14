/**
 * WorkBuddy / CodeBuddy 订阅线路的静态事实、错误码、区域路由与倍率工具。
 *
 * 与参照仓库（`dsh-chatgpt-subscription`）保持协议对齐：
 * - 对话端点仅接受流式（`stream: true`），`stream: false` 会答 `400 code 11101`；
 * - 国区 `claude-*` 模型需经 `/v1/messages`（Anthropic Messages 协议，明文 JSON 无 gzip，
 *   Bearer 鉴权），其余模型及所有国际区账号经 `/v2/chat/completions`（OpenAI 兼容，gzip 请求体）；
 * - 聊天出站需桌面产品身份头（`WorkBuddy/5.9.3`）、5 个会话头、出站指纹/链路头与对话身份脱敏；
 * - 网关发现/续期/账单面（`/v3/config`、`/v2/plugin/*`、`/billing/meter/*`）仍保留 `CLI/2.63.2`。
 *
 * `workbuddy-subscription` ID 刻意与用户自定义的 OpenAI 兼容线路分开，不会覆盖手工配置。
 */

/** 区域：凭据属性，不是请求属性。 */
export type WorkBuddyRegion = 'cn' | 'intl';

/** 各区积分倍率声明（裸数值字符串，如 `'0.79'`，不带 `x` 或 `credits` 后缀）。 */
export type WorkBuddyModelCredits = Partial<Record<WorkBuddyRegion, string>>;

/** 目录里的一个 WorkBuddy 模型条目。 */
export interface WorkBuddyModelEntry {
    id: string;
    name: string;
    /** 网关默认服务窗口（压缩与上下文溢出判断基准）。 */
    contextWindow: number;
    /** 模型支持的最大上下文窗口。 */
    maxContextWindow: number;
    maxTokens: number;
    /** 实际提供该模型的区域，跨区请求会答 400 code 11102。 */
    regions: readonly WorkBuddyRegion[];
    /** 按区域发布的积分消耗倍率；未声明时省略该字段而非猜 `'0'`。 */
    credits?: WorkBuddyModelCredits;
    supportsImage: boolean;
    reasoningEfforts: readonly string[];
    defaultReasoningEffort: string | null;
    canDisableThinking: boolean;
    description: string;
}

/** WorkBuddy 模型对话路由协议。 */
export type WorkBuddyModelRoute = 'openai-chat-completions' | 'anthropic-messages';

export const WORKBUDDY_PROVIDER_ID = 'workbuddy-subscription';
export const WORKBUDDY_PROVIDER_NAME = 'WorkBuddy (CodeBuddy Subscription)';

/** 国区网关。 */
export const WORKBUDDY_CN_BACKEND = 'https://copilot.tencent.com';

/** 国际区账号所在域的域名后缀；其余走国区部署。 */
export const WORKBUDDY_INTL_DOMAIN_SUFFIXES = ['.workbuddy.ai', '.codebuddy.ai'] as const;

/** 凭据未记录域时的默认域。 */
export const WORKBUDDY_DEFAULT_DOMAIN = 'www.codebuddy.cn';

/** OpenAI 兼容对话面（非国区 Claude 模型与所有国际区账号）。 */
export const WORKBUDDY_CHAT_PATH = '/v2/chat/completions';
/** Anthropic Messages 对话面（仅国区 `claude-*` 模型）。 */
export const WORKBUDDY_MESSAGES_PATH = '/v1/messages';
/** Anthropic Messages 版本头。 */
export const WORKBUDDY_ANTHROPIC_VERSION = '2023-06-01';
/** 网关配置/模型目录面：返回每个模型的上下文窗口、输出上限、视觉支持、倍率与思考档位。 */
export const WORKBUDDY_CONFIG_PATH = '/v3/config';
/** 令牌续期面；官方 IDE 把 refresh token 发到这里。 */
export const WORKBUDDY_REFRESH_PATH = '/v2/plugin/auth/token/refresh';
/** 账单/额度面。 */
export const WORKBUDDY_BILLING_PATH = '/billing/meter/get-user-resource';
/** 国区每日签到活动状态面。 */
export const WORKBUDDY_CHECKIN_STATUS_PATH = '/billing/meter/checkin-activity-status';
/** 国区每日签到领取面。 */
export const WORKBUDDY_CHECKIN_PATH = '/billing/meter/daily-checkin';
/** 当前账号信息面：浏览器授权回调不含 uid/nickname，需二次查询补全。 */
export const WORKBUDDY_ACCOUNT_PATH = '/v2/plugin/account';
/** 浏览器授权状态与凭据轮询面。 */
export const WORKBUDDY_LOGIN_STATE_PATH = '/v2/plugin/auth/state';
export const WORKBUDDY_LOGIN_TOKEN_PATH = '/v2/plugin/auth/token';
export const WORKBUDDY_LOGIN_PLATFORM = 'cli';
/** 轮询仍处于「等待授权」状态时的业务码。 */
export const WORKBUDDY_LOGIN_PENDING_CODE = 11217;
export const WORKBUDDY_LOGIN_POLL_INTERVAL_MS = 1_500;
export const WORKBUDDY_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** 控制面请求（`/v3/config`、`/v2/plugin/*`、`/billing/meter/*`）使用的 CLI User-Agent。 */
export const WORKBUDDY_CLIENT_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2';

/** 网关身份与路由头。 */
export const WORKBUDDY_HEADER_USER_ID = 'x-user-id';
export const WORKBUDDY_HEADER_ENTERPRISE_ID = 'x-enterprise-id';
export const WORKBUDDY_HEADER_TENANT_ID = 'x-tenant-id';
export const WORKBUDDY_HEADER_DOMAIN = 'x-domain';
export const WORKBUDDY_HEADER_PRODUCT = 'x-product';
export const WORKBUDDY_HEADER_IDE_NAME = 'x-ide-name';
export const WORKBUDDY_HEADER_REQUESTED_WITH = 'x-requested-with';
export const WORKBUDDY_CLIENT_PRODUCT = 'SaaS';
/** 续期端点读取的 refresh token 头。 */
export const WORKBUDDY_HEADER_REFRESH_TOKEN = 'x-refresh-token';
/** 续期来源标记；`.workbuddy.ai` 为 workbuddy，其余为 plugin。 */
export const WORKBUDDY_HEADER_REFRESH_SOURCE = 'x-auth-refresh-source';

/** 超时与缓存时长。 */
export const WORKBUDDY_DISCOVERY_TIMEOUT_MS = 20_000;
export const WORKBUDDY_QUOTA_CACHE_TTL_MS = 2 * 60 * 1000;
export const WORKBUDDY_CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;

export const WORKBUDDY_DEFAULT_MAX_TOKENS = 32_768;
export const WORKBUDDY_DEFAULT_CONTEXT_WINDOW = 128_000;
export const WORKBUDDY_FALLBACK_MAX_TOKENS = 32_768;

/**
 * 网关公布的思考档位标准表。
 *
 * 目录里单个 `effort` 字段仅为默认值而非全集；实测此类模型接受 `low`/`high`/`max`。
 */
export const WORKBUDDY_STANDARD_EFFORTS = ['low', 'high', 'max'] as const;

/** 订阅后端错误码。 */
export const WORKBUDDY_ERROR_CODE = {
    /** 请求参数被拒（图片负载错误、不支持的字段或流式开关关闭）。 */
    BAD_REQUEST: 11101,
    /** 模型不在本区服务或当前套餐无权访问。 */
    MODEL_UNAVAILABLE: 11102,
    /** 渠道校验或消息历史形状不合法（如缺少首条 system 或未获批渠道拦截）。 */
    SECURITY_BLOCKED: 11128,
    /** 上游厂商拒绝了参数，例如图片不受支持。 */
    PROVIDER_REJECTED: 11133,
    /** 上游厂商服务器错误。 */
    UPSTREAM_ERROR: 11134,
    /** 图片无法解码或格式不被接受。 */
    INVALID_IMAGE: 11135,
    /** 账号被封控禁用（account-scoped），需停用该账号。 */
    ACCOUNT_RESTRICTED: 11140,
    /** 不支持的思考档位取值。 */
    INVALID_REASONING: 11150,
    /** 思考块签名校验失败：绝不可当作 11128 走 system 移位。 */
    THINKING_SIGNATURE_INVALID: 11159,
    /** 用量超过频率限制；正文通常带有重置时刻。 */
    RATE_LIMITED: 6004,
    /** 与 429 一同出现的通用用量上限信号。 */
    USAGE_LIMIT: 14003,
} as const;

/** 该域是否属于国际区部署。 */
export function isWorkBuddyIntlDomain(domain: string): boolean {
    const value = domain.trim().toLowerCase();
    return value !== '' && WORKBUDDY_INTL_DOMAIN_SUFFIXES.some(suffix => value.endsWith(suffix));
}

/** 凭据所属区域，由其 auth 域决定。 */
export function workBuddyRegionForDomain(domain: string): WorkBuddyRegion {
    return isWorkBuddyIntlDomain(domain) ? 'intl' : 'cn';
}

/**
 * Auth 域对应的后端基址。
 *
 * 国际区账号由同 apex 主机服务（`www.workbuddy.ai` / `www.codebuddy.ai`）；其余走国区网关。
 */
export function workBuddyBackendForDomain(domain: string): string {
    const value = domain.trim().toLowerCase();
    if (!isWorkBuddyIntlDomain(value)) return WORKBUDDY_CN_BACKEND;
    const apex = value.split('.').slice(-2).join('.');
    return `https://www.${apex}`;
}

/** 某个域对应的续期来源标记。 */
export function workBuddyRefreshSourceForDomain(domain: string): string {
    return domain.trim().toLowerCase().endsWith('.workbuddy.ai') ? 'workbuddy' : 'plugin';
}

/** 某个区域对应的默认登录域。 */
export function workBuddyDomainForRegion(region: WorkBuddyRegion): string {
    return region === 'intl' ? 'www.workbuddy.ai' : 'copilot.tencent.com';
}

/** 判断指定账号区域的模型应走 `/v1/messages`（国区 Claude）还是 `/v2/chat/completions`。 */
export function workBuddyModelRoute(modelId: string, region: WorkBuddyRegion): WorkBuddyModelRoute {
    return region === 'cn' && /^claude-/i.test(modelId.trim())
        ? 'anthropic-messages'
        : 'openai-chat-completions';
}

/**
 * 解析 `/v3/config` 中的积分消耗倍率（如 `'x0.79 credits'`、`'x6.67'`、`'0.00'`）。
 *
 * `default-model` 等占位条目会发布空字符串或未定价标记；这些必须返回 `null`
 * 而不是强行置 `'0'`，否则 UI 会误标为「0 积分免费模型」。
 */
export function parseWorkBuddyCreditMultiplier(raw: unknown): string | null {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) && raw >= 0 ? String(raw) : null;
    }
    if (typeof raw !== 'string') return null;
    const stripped = raw.replace(/\s*credits\s*$/i, '').trim().replace(/^[x×]/i, '').trim();
    if (stripped === '') return null;
    const value = Number(stripped);
    if (!Number.isFinite(value) || value < 0) return null;
    return stripped;
}

/**
 * 把目录声明的档位收敛到最近的标准档，平局向上取高档。
 */
export function convergeWorkBuddyEffort(effort: string, efforts: readonly string[]): string | null {
    if (efforts.length === 0) return null;
    const scale = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const rank = (value: string): number => {
        const index = scale.indexOf(value.trim().toLowerCase());
        return index === -1 ? scale.indexOf('high') : index;
    };
    const target = rank(effort);
    let best = efforts[0]!;
    for (const candidate of efforts) {
        const distance = Math.abs(rank(candidate) - target);
        const bestDistance = Math.abs(rank(best) - target);
        if (distance < bestDistance || (distance === bestDistance && rank(candidate) > rank(best))) {
            best = candidate;
        }
    }
    return best;
}
