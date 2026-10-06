/**
 * Anthropic Claude 订阅线路的静态事实与模型目录。
 *
 * ⚠️ **风险须知**：Anthropic 现行条款明确写明**不允许第三方应用提供 Claude.ai 登录、也不
 * 允许代用户经 Free / Pro / Max 凭据转发请求**，并保留不经预告的执法权；已有账号因此被
 * 限制的公开报告。本线路**未获 Anthropic 任何授权或认可**，使用风险由使用者自行承担。
 *
 * 订阅（Pro/Max，即 Claude Code 使用的凭据）与按量计费的 Console API 是**两个产品**。
 * 它们由同一主机服务，但订阅凭据是 **Bearer OAuth access token** 而不是 `x-api-key`，且
 * 订阅路由位于 API Key 线路从不发送的 beta 之后。
 *
 * **这不是「抄一个 token 就能用」**：订阅令牌要求请求**完整模仿 Claude Code 的身份**，
 * 否则会被服务端拒绝或分类判别。这些约束都在代码里显式实现并有测试锁定。
 */

export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = 'claude-subscription';
export const CLAUDE_SUBSCRIPTION_PROVIDER_NAME = 'Claude（订阅）';

/** 同时服务 Messages API 与订阅自身 OAuth 路由的主机。 */
export const CLAUDE_API_BASE = 'https://api.anthropic.com';
/**
 * Messages API 的路径。
 *
 * `?beta=true` 是订阅契约的一部分而不是缓存破坏参数：那是 beta 路由，不是普通路由的别名。
 */
export const CLAUDE_MESSAGES_PATH = '/v1/messages?beta=true';
/** 模型清单。它是「这个账号实际能调什么」的权威。 */
export const CLAUDE_MODELS_PATH = '/v1/models';
/** 订阅用量计量（5 小时与 7 天窗口）。 */
export const CLAUDE_USAGE_PATH = '/api/oauth/usage';

/** 订阅流程的浏览器授权端点（claude.ai 属性，这正是令牌成为订阅凭据的原因）。 */
export const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
/** 授权码授予与刷新的令牌端点。 */
export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** 手动粘贴流程的 redirect URI。 */
export const CLAUDE_OAUTH_MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
/** 公开 OAuth 客户端 id（不是密钥；PKCE 才是保护兑换的东西）。 */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/**
 * 订阅流程申请的 scope，按端点要求以空格分隔。
 *
 * `user:inference` 是让令牌可用于 `/v1/messages` 的那个；`user:profile` 是用量端点所
 * 依据的。更窄的集合会得到一个能通过认证、但在本 Provider 存在的路由上被拒的令牌。
 */
export const CLAUDE_OAUTH_SCOPES =
    'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** 任何以订阅 OAuth 令牌认证的请求都必须携带。 */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** 与 Claude Code 系统提示词及版本头配对的身份 beta。 */
export const CLAUDE_CODE_BETA = 'claude-code-20250219';
/** 让思考块与工具使用在多轮循环中交错。 */
export const CLAUDE_INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
/**
 * 授权一小时提示缓存 TTL 的 beta。
 *
 * `cache_control: { type: 'ephemeral', ttl: '1h' }` 缺它不会被接受：一小时档是单独的许可
 * 能力，请求了却没有该标记就会被拒（与 `block_binding` 同理）。
 */
export const CLAUDE_EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11';
/**
 * 授权请求体里 `thinking.block_binding` 的 beta。
 *
 * 该字段**不是可选的**：官方文档写明带 `block_binding` 却没有这个 beta 的请求是 400，
 * 正文以 `block_binding: Extra inputs are not permitted` 结尾——每一次请求、每一轮都是。
 */
export const CLAUDE_THINKING_BINDING_CONTROLS_BETA = 'thinking-binding-controls-2026-08-01';

/** Anthropic 协议版本，作为 `anthropic-version` 发送。 */
export const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';

/**
 * 本线路在订阅网关上**声称**的客户端版本。
 *
 * 上游对订阅路径按模型强制一个**最低上报客户端版本**：版本经 `user-agent` 传递，低于
 * 下限的声称会以 HTTP 400 与 `claude_code_version_too_old` 被拒。这是整个请求的硬停，
 * 而不是单次请求的失败；拒绝文案里回显的是**我们自己声称的那个数字**，所以用户只被告知
 * 「你的客户端太旧」，却不知道是哪个模型要求的——这正是它误导人们重新登录的方式。
 *
 * **这条不变式**：它必须不低于 `CLAUDE_MODELS` 中任何已发布模型声明的 `minCliVersion`。
 * 默认值低于某个已发布模型的下限，就是一个本包在自己的选择器里展示、却根本调不动的模型。
 *
 * 该值是**真实发布过的** `@anthropic-ai/claude-code` 版本，而不是仅为了越过下限而挑的数字：
 * 声称一个不存在的版本，只是把一个清晰的拒绝换成不可预测的拒绝。
 */
export const CLAUDE_CLI_VERSION = '2.1.285';

/**
 * 回环回调端口默认值。
 *
 * 端口不是随意的：它是 redirect URI 的一部分，而授权主机只接受为该客户端注册过的
 * redirect URI，所以这个默认值就是已知被接受的那个。
 */
export const CLAUDE_DEFAULT_CALLBACK_PORT = 53692;
/**
 * 一次探测覆盖的连续端口数。
 *
 * Windows（Hyper-V/WinNAT）会动态保留 TCP 端口段且每次重启都变。固定回调端口可能落在
 * 保留段里，`listen` 以 `EACCES` 失败，浏览器授权永远无法完成。保留段以最多 100 个端口
 * 为块，所以比它窄的探测可能停在块中间而仍然失败；128 覆盖默认端口可能落入的任一块。
 */
export const CLAUDE_CALLBACK_PORT_ATTEMPTS = 128;
/** 浏览器被重定向到的回环回调路径。 */
export const CLAUDE_CALLBACK_PATH = '/callback';

export const CLAUDE_DISCOVERY_TIMEOUT_MS = 20_000;
export const CLAUDE_LOGIN_TIMEOUT_MS = 600_000;
/** 续期提前量：令牌被当作提前 5 分钟过期。 */
export const CLAUDE_REFRESH_MARGIN_MS = 300_000;
export const CLAUDE_REFRESH_MAX_ATTEMPTS = 3;
export const CLAUDE_REFRESH_BACKOFF_BASE_MS = 1_000;
/** 可重试的令牌端点状态。 */
export const CLAUDE_RETRYABLE_TOKEN_STATUSES = [408, 425, 429, 500, 502, 503, 504, 529] as const;
/** 终局的授予错误码：凭据已死，重试永远不可能成功。 */
export const CLAUDE_FINAL_GRANT_CODES = [
    'invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope',
] as const;

export const CLAUDE_DEFAULT_MAX_TOKENS = 32_768;
/**
 * 目录未描述某个模型时假定的上下文窗口。
 *
 * 200K 是每个非 1M Claude 模型都有的窗口，因此它对最少的 id 是错的。危险的方向是窗口
 * **过大**——请求会被直接拒绝；而过小只会比必要的更早压缩。
 */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;

/** 提示缓存档位。 */
export type ClaudeCacheTtl = '5m' | '1h';
/**
 * 本线路请求的提示缓存 TTL。
 *
 * Anthropic 提供两档。官方文档写明**订阅**的主对话在计入套餐额度时使用一小时档，套餐
 * 耗尽、改按用量计费后降回五分钟。本线路以订阅令牌认证，所以订阅档才是与官方客户端行为
 * 一致的那个——把本插件与官方 CLI 对比的用户应当看到相同的缓存寿命，而不是一半。
 *
 * 一小时写入是五分钟写入的 1.25 倍价，所以从不重读前缀的短会话会更贵。那是官方的取舍，
 * 用户可以覆盖。
 */
export const CLAUDE_SUBSCRIPTION_CACHE_TTL: ClaudeCacheTtl = '1h';
export const CLAUDE_DEFAULT_CACHE_TTL: ClaudeCacheTtl = '5m';

/** 某一档的缓存标记。缺 `ttl` 即五分钟默认档。 */
export function claudeCacheControlFor(ttl: ClaudeCacheTtl): { type: 'ephemeral'; ttl: ClaudeCacheTtl } {
    return { type: 'ephemeral', ttl };
}

/** 某个取值是否是本线路能发送的缓存档位。 */
export function isClaudeCacheTtl(value: unknown): value is ClaudeCacheTtl {
    return value === '5m' || value === '1h';
}

/**
 * Claude Code 身份块的确切文本。
 *
 * 系统数组的**第一条**必须是这一行，逐字。这不是装饰、也不是偏好：缺它的订阅请求会被
 * 拒绝。
 */
export const CLAUDE_CODE_IDENTITY_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";

/** 本线路分类的 Anthropic 错误类型。 */
export const CLAUDE_ERROR_TYPE = {
    AUTHENTICATION: 'authentication_error',
    PERMISSION: 'permission_error',
    INVALID_REQUEST: 'invalid_request_error',
    RATE_LIMIT: 'rate_limit_error',
    OVERLOADED: 'overloaded_error',
    NOT_FOUND: 'not_found_error',
    API: 'api_error',
    REQUEST_TOO_LARGE: 'request_too_large',
} as const;

/** 服务端在被告知的客户端版本过旧时报告的错误码。 */
export const CLAUDE_ERROR_CODE_CLIENT_VERSION_TOO_OLD = 'claude_code_version_too_old';

/**
 * 一个模型的思考形态。
 *
 * - `mid-convo`：模型在「对话中途努力」下被管理。请求**必须**发送
 *   `{ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }` 与
 *   `output_config.effort`；该形态在调用方未指定时**强制** `high`；
 * - `adaptive`：发送 `{ type: 'adaptive' }`（官方称与省略该字段等价）；
 * - `budget`：发送 `{ type: 'enabled', budget_tokens }`（预算计入 `max_tokens`，**必须**
 *   为回答留出至少 1024 token）；
 * - `none`：不发送思考字段。
 */
export type ClaudeThinkingMode = 'mid-convo' | 'adaptive' | 'budget' | 'none';

/** 目录里的一个模型。 */
export interface ClaudeModelEntry {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    supportsImage: boolean;
    /** 该模型是否接受 `temperature`。 */
    supportsTemperature: boolean;
    thinkingMode: ClaudeThinkingMode;
    reasoningEfforts: string[];
    /** 能否被明确要求关闭思考。 */
    canDisableThinking: boolean;
    /**
     * 上游为该模型强制的最低上报客户端版本。
     *
     * 缺省表示「没有已知下限」而不是「没有下限」，因此它从不阻止请求：因为没人记录过
     * 数字就拒绝一个模型，是本线路在发明一条上游从未声明的限制。
     */
    minCliVersion?: string;
    /** 该模型是否运行「保留思考前缀检查」（即需要 `block_binding`）。 */
    bindsThinkingToPrefix?: boolean;
}

/**
 * 订阅当前服务的模型表。
 *
 * **只证明抄录忠实，不证明服务端提供这些模型**：服务端自己的 `GET /v1/models` 才是权威，
 * 且它只覆盖上下文窗口，能力字段不被改写。
 */
export const CLAUDE_MODELS: readonly ClaudeModelEntry[] = [
    {
        id: 'claude-fable-5', name: 'Claude Fable 5',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: true,
        thinkingMode: 'adaptive', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: false,
    },
    {
        id: 'claude-fable-5-1', name: 'Claude Fable 5.1',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: true,
        thinkingMode: 'mid-convo', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: false,
    },
    {
        id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)',
        contextWindow: 200_000, maxTokens: 64_000,
        supportsImage: true, supportsTemperature: true,
        thinkingMode: 'budget', reasoningEfforts: ['low', 'medium', 'high'],
        canDisableThinking: true,
    },
    {
        id: 'claude-opus-4-5', name: 'Claude Opus 4.5 (latest)',
        contextWindow: 200_000, maxTokens: 64_000,
        supportsImage: true, supportsTemperature: true,
        thinkingMode: 'budget', reasoningEfforts: ['low', 'medium', 'high'],
        canDisableThinking: true,
    },
    {
        id: 'claude-opus-4-6', name: 'Claude Opus 4.6',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: true,
        thinkingMode: 'adaptive', reasoningEfforts: ['low', 'medium', 'high', 'max'],
        canDisableThinking: true,
    },
    {
        id: 'claude-opus-4-7', name: 'Claude Opus 4.7',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: false,
        thinkingMode: 'adaptive', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: true,
    },
    {
        id: 'claude-opus-4-8', name: 'Claude Opus 4.8',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: false,
        thinkingMode: 'adaptive', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: true,
    },
    {
        id: 'claude-opus-5', name: 'Claude Opus 5',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: false,
        thinkingMode: 'mid-convo', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: false,
    },
    {
        id: 'claude-opus-5-5', name: 'Claude Opus 5.5',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: false,
        // 'adaptive'，**不是** 'mid-convo'，而差别不是装饰：'mid-convo' 在调用方未指定时
        // 强制 effort=high，而该模型的文档默认是 medium；那会让每次请求都比用户要求的
        // 想得更狠、也计费更贵。
        thinkingMode: 'adaptive', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: false,
        // 观测值而非推断：该模型被以 claude_code_version_too_old 拒绝，文案点名要求
        // 「2.1.280 或更新」。记录该下限后，过低的版本会在请求发出**之前**被本地拒绝。
        minCliVersion: '2.1.280',
        bindsThinkingToPrefix: true,
    },
    {
        id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (latest)',
        contextWindow: 1_000_000, maxTokens: 64_000,
        supportsImage: true, supportsTemperature: true,
        thinkingMode: 'budget', reasoningEfforts: ['low', 'medium', 'high'],
        canDisableThinking: true,
    },
    {
        id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: true,
        thinkingMode: 'adaptive', reasoningEfforts: ['low', 'medium', 'high', 'max'],
        canDisableThinking: true,
    },
    {
        id: 'claude-sonnet-5', name: 'Claude Sonnet 5',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: true,
        thinkingMode: 'adaptive', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: true,
    },
    {
        id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5',
        contextWindow: 1_000_000, maxTokens: 128_000,
        supportsImage: true, supportsTemperature: false,
        // 文档默认 effort 是 high，所以该形态在调用方未指定时的强制 high 正是模型自己的
        // 默认；且其思考块绑定对话前缀，前缀被编辑后重放需要 block_binding。
        thinkingMode: 'mid-convo', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: false,
        bindsThinkingToPrefix: true,
    },
];

const CLAUDE_BY_ID = new Map(CLAUDE_MODELS.map(model => [model.id, model]));

/**
 * 查一个模型；未知 id 得到一个**不声明任何能力**的桩。
 *
 * 未知 id 按保守而非乐观处理，理由是**不对称的**：错误的「支持图片」会把图片字节发给一个
 * 拒绝整个请求的端点，而错误的「不支持图片」只是让 DSH 显示一个用户可纠正的占位。同样的
 * 不对称选择最弱的思考形态与更小的默认窗口——高估服务端授予的窗口是那个会硬失败的错误。
 */
export function resolveClaudeModel(modelId: string): ClaudeModelEntry {
    const known = CLAUDE_BY_ID.get(modelId.trim());
    if (known !== undefined) return known;
    return {
        id: modelId,
        name: modelId,
        contextWindow: CLAUDE_DEFAULT_CONTEXT_WINDOW,
        maxTokens: CLAUDE_DEFAULT_MAX_TOKENS,
        supportsImage: false,
        supportsTemperature: true,
        // 没有该 id 会推理的证据。声明一个思考形态就是猜测，而空的档位表已经意味着不会
        // 有思考字段上线；'none' 是说出这一点的标签，而不是给一个无人支持的形态起名。
        thinkingMode: 'none',
        reasoningEfforts: [],
        canDisableThinking: false,
    };
}

export function isClaudeSubscriptionModelId(value: unknown): boolean {
    return typeof value === 'string' && CLAUDE_BY_ID.has(value.trim());
}

// ─── 版本比较 ────────────────────────────────────────────────────────────────

function versionSegments(value: string): number[] {
    return value.trim().replace(/^v/i, '').split('.').map(segment => {
        const parsed = Number(segment);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
    });
}

function isDottedVersion(value: string): boolean {
    return /^\d+(\.\d+)*$/.test(value.trim().replace(/^v/i, ''));
}

/**
 * 比较两个点分数字版本，例如 '2.1.283' 与 '2.1.280'。
 *
 * 比较是刻意**小巧且全域**的，而不是 SemVer 解析器：它只会看到本线路自己上报的版本与
 * 目录里记录的下限，且不得对其中任何一个抛错——会抛错的比较会把一个配置错误变成崩溃，
 * 而不是它被加进来要产生的那个精确的预检拒绝。
 *
 * 全域意味着：缺失的段按 0 比较（'2.1' 等于 '2.1.0'），非十进制数字的段按 0 比较而不是
 * NaN（'abc' 等于 '0.0.0'，'' 也是）。
 */
export function compareDottedVersions(left: string, right: string): number {
    const a = versionSegments(left);
    const b = versionSegments(right);
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

/**
 * 一个上报版本是否越过下限。
 *
 * 缺省的下限（undefined）意味着「没有已知下限」而不是「没有下限」，所以它从不阻止请求。
 * 任一侧的**畸形**版本则被拒绝——那是保守的方向，因为这个检查的存在就是为了阻止一个未知
 * 声称到达一个已经拒绝过它的服务端。
 */
export function meetsClaudeVersionFloor(version: string, floor?: string): boolean {
    if (floor === undefined || floor.trim() === '') return true;
    if (!isDottedVersion(version)) return false;
    return compareDottedVersions(version, floor) >= 0;
}

/** 本线路在网关上声称的版本；支持环境变量覆盖以便不重启地越过新的下限。 */
export function claudeCliVersion(): string {
    const configured = (process.env.DSH_CLAUDE_CLI_VERSION ?? '').trim();
    return configured === '' ? CLAUDE_CLI_VERSION : configured;
}

/**
 * 本线路为某个模型发送的思考控制。
 *
 * 形态由**模型表**而不是模型名推断决定。
 */
export function claudeThinkingFor(
    model: ClaudeModelEntry,
    requestedEffort: string | undefined,
    thinkingBudget: number | undefined,
): { thinking?: Record<string, unknown>; outputConfig?: Record<string, unknown> } {
    if (model.thinkingMode === 'none') return {};
    if (model.thinkingMode === 'mid-convo') {
        // block_binding 不是可选的：前缀被编辑后重放思考块需要它，而缺它时整个请求是 400。
        return {
            thinking: {
                type: 'adaptive',
                block_binding: { prefix_mismatch_behavior: 'drop_block' },
            },
            outputConfig: { effort: requestedEffort ?? 'high' },
        };
    }
    if (model.thinkingMode === 'adaptive') {
        // 一个把思考绑定到前缀的模型同样需要 block_binding：它会校验重放思考块所依赖的
        // 前缀，而压缩、工具列表变化或图片降级都会编辑那个前缀。没有它，这类模型在
        // 任何一次前缀编辑之后都会对每一轮重试都答 400。
        return {
            thinking: {
                type: 'adaptive',
                ...(model.bindsThinkingToPrefix
                    ? { block_binding: { prefix_mismatch_behavior: 'drop_block' } }
                    : {}),
            },
        };
    }
    // budget：思考预算计入 max_tokens，所以必须为回答留出至少 1024 token。
    if (requestedEffort === 'none' && model.canDisableThinking) {
        return { thinking: { type: 'disabled' } };
    }
    const budget = typeof thinkingBudget === 'number' && thinkingBudget >= 1024 ? thinkingBudget : 8192;
    return { thinking: { type: 'enabled', budget_tokens: budget } };
}
