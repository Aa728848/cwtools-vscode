/**
 * WorkBuddy / CodeBuddy 订阅线路的静态事实。
 *
 * WorkBuddy 是腾讯 CodeBuddy IDE 的订阅。它的模型后端是一个普通 OpenAI 兼容的
 * `/chat/completions` 端点，官方 IDE 直接调用；本线路说同一套线协议，而不是走一个
 * 转换进程。
 *
 * 这里断言的一切都来自参照实现（\`dsh-chatgpt-subscription\`）对真实订阅的实测：
 * 最意外的两条约束是**只接受流式**，以及**国际区要求首条消息是 system**。
 *
 * 该 ID 特意与用户常用的自定义 OpenAI 兼容线路 `workbuddy` 分开：安装本扩展不得
 * 覆盖或隐藏用户自己配置的 API。
 */

/** 区域：凭据属性，不是请求属性。 */
export type WorkBuddyRegion = 'cn' | 'intl';

export const WORKBUDDY_PROVIDER_ID = 'workbuddy-subscription';
export const WORKBUDDY_PROVIDER_NAME = 'WorkBuddy (CodeBuddy Subscription)';

/** 国区网关。 */
export const WORKBUDDY_CN_BACKEND = 'https://copilot.tencent.com';

/** 国际区账号所在域的域名后缀；其余走国区部署。 */
export const WORKBUDDY_INTL_DOMAIN_SUFFIXES = ['.workbuddy.ai', '.codebuddy.ai'] as const;

/** 凭据未记录域时的默认域。 */
export const WORKBUDDY_DEFAULT_DOMAIN = 'www.codebuddy.cn';

/** 对话面，拼在区域后端之后。 */
export const WORKBUDDY_CHAT_PATH = '/v2/chat/completions';
/**
 * 网关配置/目录面。
 *
 * 真正的模型清单在这里：对话主机对 `/v1/models` 答 404，而 `/v3/config` 返回每个
 * 模型的上下文窗口、输出上限、图片支持与可用的思考档位。官方 CLI 启动时读的就是它。
 */
export const WORKBUDDY_CONFIG_PATH = '/v3/config';
/** 令牌续期面；官方 IDE 把 refresh token 发到这里。 */
export const WORKBUDDY_REFRESH_PATH = '/v2/plugin/auth/token/refresh';
/** 账单/额度面。 */
export const WORKBUDDY_BILLING_PATH = '/billing/meter/get-user-resource';
/** 当前账号面：浏览器授权只回 auth 块，uid/昵称/UIN 要从这里读。 */
export const WORKBUDDY_ACCOUNT_PATH = '/v2/plugin/account';
/** 浏览器授权状态与凭据轮询面。 */
export const WORKBUDDY_LOGIN_STATE_PATH = '/v2/plugin/auth/state';
export const WORKBUDDY_LOGIN_TOKEN_PATH = '/v2/plugin/auth/token';
export const WORKBUDDY_LOGIN_PLATFORM = 'cli';
/** 轮询仍处于「等待授权」状态时的业务码。 */
export const WORKBUDDY_LOGIN_PENDING_CODE = 11217;
export const WORKBUDDY_LOGIN_POLL_INTERVAL_MS = 1_500;
export const WORKBUDDY_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 每个请求携带的 User-Agent。
 *
 * 实测：`CodeBuddyIDE` 能被对话端点接受，但被 `/v3/config` 以 400 `code 12403`
 * 拒绝，国际区对话端点更是直接 401。CLI 身份在两个区的三个面上都被接受，因此本线路
 * 只用这一个身份，而不是逐端点切换。
 */
export const WORKBUDDY_CLIENT_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2';

/** 网关据此门控的客户端身份头。 */
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

/**
 * 目录未逐模型给出时的输出上限。
 *
 * 订阅模型由多个上游厂商服务，各自公布的输出上限不同；这是请求构造器在没有任何更
 * 具体信息时使用的保守上限。
 */
export const WORKBUDDY_FALLBACK_MAX_TOKENS = 32_768;

/**
 * 网关公布的思考档位标准表。
 *
 * 目录里的单个 `effort` 字段是**默认值**，既不是完整档位表也不是「只此一档」：实测
 * 这类模型接受 `low`/`high`/`max`（其余取值被上游收敛到最近档）。
 */
export const WORKBUDDY_STANDARD_EFFORTS = ['low', 'high', 'max'] as const;

/** 订阅后端错误码，均为实测。 */
export const WORKBUDDY_ERROR_CODE = {
    /** 请求参数被拒（图片负载错误、不支持的字段）。 */
    BAD_REQUEST: 11101,
    /** 模型不在本区服务——发错区了。 */
    MODEL_UNAVAILABLE: 11102,
    /** 消息历史形状不合法（缺少开头的 system 提示）。 */
    SECURITY_BLOCKED: 11128,
    /** 上游厂商拒绝了参数，例如该模型不支持的图片。 */
    PROVIDER_REJECTED: 11133,
    /** 上游厂商错误。 */
    UPSTREAM_ERROR: 11134,
    /** 图片无法解码或格式不被接受。 */
    INVALID_IMAGE: 11135,
    /** 不支持的思考档位取值。 */
    INVALID_REASONING: 11150,
    /** 用量超过频率限制；正文带重置时刻。 */
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
 * 一个 auth 域对应的后端基址。
 *
 * 国际区账号由与其 auth 域同一个 apex 服务（`www.workbuddy.ai`、`www.codebuddy.ai`）；
 * 其余走国区网关。
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

/** 某个区域对应的登录域。 */
export function workBuddyDomainForRegion(region: WorkBuddyRegion): string {
    return region === 'intl' ? 'www.workbuddy.ai' : 'copilot.tencent.com';
}

/**
 * 把目录声明的档位收敛到最近的标准档。
 *
 * 目录给出的**默认档也可能落在档位表之外**（实测：只声明 `effort` 的模型暴露
 * `low`/`high`/`max` 却默认 `medium`）。原样发送会让卡片无法显示请求实际携带的档位，
 * 所以收敛到最近档——与上游对这种取值所做的路由一致。
 */
export function convergeWorkBuddyEffort(effort: string, efforts: readonly string[]): string | null {
    if (efforts.length === 0) return null;
    // Every level this route can name, in escalating order (the rank scale).
    const scale = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const rank = (value: string): number => {
        const index = scale.indexOf(value.trim().toLowerCase());
        // An unrecognised level is placed at the middle rung rather than at an
        // extreme, so it can never silently pick the cheapest or the costliest.
        return index === -1 ? scale.indexOf('high') : index;
    };
    const target = rank(effort);
    let best = efforts[0]!;
    for (const candidate of efforts) {
        const distance = Math.abs(rank(candidate) - target);
        const bestDistance = Math.abs(rank(best) - target);
        // Ties resolve **upward**, which is the mapping the sibling Kimi line
        // documents for `medium`: snapping it down to `low` would change the
        // thinking depth the gateway itself would have chosen.
        if (distance < bestDistance || (distance === bestDistance && rank(candidate) > rank(best))) {
            best = candidate;
        }
    }
    return best;
}
