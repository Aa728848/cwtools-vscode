/**
 * MiniMax Code（编程订阅）线路的静态事实。
 *
 * 与 `minimax` / `minimax-token-plan`（平台 API Key，按量计费）是两套互不通用的系统：
 * 订阅的模型接口是 Anthropic Messages，凭据只来自订阅 OAuth 或桌面端登录态。
 *
 * 两条承重结论：
 * - **只用 `authorization: Bearer`**：实测 `x-api-key` 一律返回 401
 *   `{"code":401,"message":"token is required"}`，所以本线路**没有** x-api-key 回退分支
 *   （回退只会在每次请求上白花一个往返）；
 * - **模型目录硬编码**：`GET /v1/models` 对订阅流量未开放（503
 *   `direct_route_not_configured`），任何「实时目录」都只是一个必然失败的请求。
 */

/** 区域。 */
export type MinimaxCodeRegion = 'cn' | 'global';

export const MINIMAX_CODE_PROVIDER_ID = 'minimax-code';
export const MINIMAX_CODE_PROVIDER_NAME = 'MiniMax Code (编程订阅)';

export const MINIMAX_CODE_CLIENT_ID = 'mcode-public';
export const MINIMAX_CODE_SCOPE = 'agent.default';
export const MINIMAX_CODE_AUDIENCE = 'agent-backend';

/** 区域主机对。 */
export const MINIMAX_CODE_REGION_HOSTS: Record<MinimaxCodeRegion, { account: string; agent: string }> = {
    cn: { account: 'https://account.minimax.cn', agent: 'https://agent.minimax.cn' },
    global: { account: 'https://account.minimax.io', agent: 'https://agent.minimax.io' },
};

/** 设备授权端点（RFC 8628 §3.1）。 */
export const MINIMAX_CODE_DEVICE_CODE_PATH = '/oauth2/device/code';
/** 令牌端点，设备码授权与刷新共用。 */
export const MINIMAX_CODE_OAUTH_TOKEN_PATH = '/oauth2/token';
/** 撤销端点。 */
export const MINIMAX_CODE_OAUTH_REVOKE_PATH = '/oauth2/revoke';
export const MINIMAX_CODE_DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** 设备授权声明的 PKCE 方法。 */
export const MINIMAX_CODE_PKCE_CHALLENGE_METHOD = 'S256';

/**
 * 受管 agent API 前缀。
 *
 * Messages 端点是 `<agentBase><prefix>/messages`；前缀自带 `/v1`，所以文档里的基址写成
 * 「.../llm/v1」，**不能**再补一个 `/v1`。
 */
export const MINIMAX_CODE_AGENT_LLM_PREFIX = '/mavis/api/v1/llm/v1';
export const MINIMAX_CODE_MESSAGES_PATH = '/messages';
export const MINIMAX_CODE_ANTHROPIC_VERSION = '2023-06-01';

/**
 * 本线路自己请求体上限（64 MB）。
 *
 * **不是** Kimi 线路的 2 MB：`total message size N exceeds limit 2097152` 是 Kimi Code 自己
 * 文档里的网关上限，MiniMax 没有任何文档这样规定。MiniMax 的模型表允许单图 10 MB 原始
 * 字节（base64 约 13.3 MB），2 MB 的整包上限与「单图 10 MB」根本不能共存。
 *
 * 这个数字高到不会本地拒绝任何合法会话，同时仍是真实边界：失控请求（例如每轮追加数 MB
 * 工具结果的死循环）在花掉连接之前就被拦下。
 */
export const MINIMAX_CODE_DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * 单次请求允许携带的 base64 图片总量。
 *
 * 同样**不是**借用别的线路的数字：Kimi 的 1,500,000 是为塞进它自己的 2 MB 请求体而定
 * 的，用在这里会把 MiniMax 接受的图片静默替换成占位文本（一张普通截图就超标近 9 倍）。
 * 本值是模型表单图 10 MB 上限的两倍余量，且远在 64 MB 请求体上限之内。
 */
export const MINIMAX_CODE_DEFAULT_MAX_REQUEST_IMAGE_BYTES = 16 * 1024 * 1024;

export const MINIMAX_CODE_DEVICE_INTERVAL_FALLBACK_SECONDS = 5;
export const MINIMAX_CODE_DEVICE_EXPIRES_FALLBACK_SECONDS = 600;
export const MINIMAX_CODE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const MINIMAX_CODE_OAUTH_TIMEOUT_MS = 30_000;
/** access token 实测约 1 小时；提前 5 分钟续期，避开服务端开始拒收的时刻。 */
export const MINIMAX_CODE_PRE_EXPIRY_REFRESH_MS = 5 * 60 * 1000;
export const MINIMAX_CODE_REJECTED_COOLDOWN_MS = 300_000;

/**
 * 一个模型的思考形态。
 *
 * - `always-on`：思考恒定开启且没有档位（不发送任何字段）；
 * - `toggle`：开关二态（`{type:'enabled'|'disabled'}`）；
 * - `forced-effort`：强制开启并可指定档位（`{type:'enabled',effort:...}`）。
 */
export type MinimaxCodeThinkingMode = 'always-on' | 'toggle' | 'forced-effort';

/** 目录里的一个模型。 */
export interface MinimaxCodeModelEntry {
    id: string;
    name: string;
    /** 账号默认拥有的上下文窗口。 */
    contextWindow: number;
    /** 模型可达到的更大窗口（作为可选项提供时）。 */
    optionalContextWindow: number | null;
    maxTokens: number;
    /**
     * 模型接受的输入模态。
     *
     * **只声明本线路真的能编码的东西**：DSH 的能力闸门、模型选择器与子代理委派都会
     * 当它成立，所以列出一个映射器做不到的能力等于给出一个必然被打破的承诺。本扩展
     * 没有视频字节读取器，因此这里只声明 text 与 image。
     */
    inputModalities: Array<'text' | 'image'>;
    thinking: MinimaxCodeThinkingMode;
    /** 模型接受的档位，按递增顺序。`default` 表示「调用方没选」。 */
    reasoningEfforts: string[];
    defaultReasoningEffort: string;
    /** 单张图片的最大字节数；未声明为 null。 */
    maxImageBytes: number | null;
    description: string;
}

/**
 * 订阅当前服务的四个模型 id。
 *
 * 每个数字都逐字转录自官方客户端随包的模型表，**不从不存在的接口推断**。
 * `MiniMax-M3` 是持久默认：它是实测请求使用的旗舰，也是线协议行为唯一有直接证据的模型。
 */
export const MINIMAX_CODE_MODELS: readonly MinimaxCodeModelEntry[] = [
    {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        contextWindow: 200_000,
        optionalContextWindow: null,
        maxTokens: 128_000,
        inputModalities: ['text'],
        thinking: 'always-on',
        reasoningEfforts: ['default'],
        defaultReasoningEffort: 'default',
        maxImageBytes: null,
        description: '思考恒定开启且没有档位。仅接受文本输入。',
    },
    {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax M2.7 HighSpeed',
        contextWindow: 200_000,
        optionalContextWindow: null,
        maxTokens: 128_000,
        inputModalities: ['text'],
        thinking: 'always-on',
        reasoningEfforts: ['default'],
        defaultReasoningEffort: 'default',
        maxImageBytes: null,
        description: '高速版 M2.7。思考恒定开启且没有档位。仅接受文本输入。',
    },
    {
        id: 'MiniMax-M3',
        name: 'MiniMax M3',
        contextWindow: 512_000,
        optionalContextWindow: 1_000_000,
        maxTokens: 128_000,
        inputModalities: ['text', 'image'],
        thinking: 'toggle',
        // 该模型的思考是二态开关而非梯度：模型表写的是「无思考 / 思考，默认思考」。
        // 把它投影成 DSH 的档位列表时，一个「默认」项才是诚实的（列表里没有 off 成员）。
        reasoningEfforts: ['default'],
        defaultReasoningEffort: 'default',
        maxImageBytes: 10 * 1024 * 1024,
        description: '旗舰订阅模型。思考默认开启且可关闭。接受文本与图片，单图上限 10MB。',
    },
    {
        id: 'MiniMax-M3.1-Flash-Preview',
        name: 'MiniMax M3.1 Flash Preview',
        contextWindow: 1_000_000,
        optionalContextWindow: null,
        maxTokens: 128_000,
        inputModalities: ['text', 'image'],
        thinking: 'forced-effort',
        // 文档里的深度档位。`default` 刻意**不是**线上取值：文档说省略 effort 即 max，
        // 所以它只是「调用方没选」的本地写法，发送前会被丢弃。
        reasoningEfforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'default',
        maxImageBytes: 10 * 1024 * 1024,
        description: '1M 上下文的预览版 Flash。思考强制开启并可指定档位。',
    },
];

const MINIMAX_CODE_BY_ID = new Map(MINIMAX_CODE_MODELS.map(model => [model.id, model]));

/** 某个模型 id 的目录条目；未知 id 返回 undefined。 */
export function minimaxCodeModelDef(modelId: string): MinimaxCodeModelEntry | undefined {
    return MINIMAX_CODE_BY_ID.get(modelId.trim());
}

/** 某个模型 id 是否已知。 */
export function isMinimaxCodeModelId(value: unknown): boolean {
    return typeof value === 'string' && MINIMAX_CODE_BY_ID.has(value.trim());
}

/**
 * 本线路的思考控制，按官方文档实现。
 *
 * 官方「模型调用」页把形状说清了，而且**不是** `thinking` 对象：
 *
 * > 思考默认开启且无需配置。
 * > Anthropic 兼容：思考深度字段是 `output_config.effort`。
 *
 * 三条后果：
 * 1. **从不发送 `thinking` 键**——该字段是推断出来的、从未被文档化；
 * 2. 深度档位属于顶层 `output_config.effort`，放在 `thinking` 里服务端根本不读；
 * 3. `effort` 接受 low/medium/high/xhigh/max，**没有 `default` 成员**：省略即 max，
 *    所以 `default` 不能上线，显式 `max` 同理（省略已经等于它）。
 *
 * @returns `output_config` 的取值，或 undefined 表示请求不带任何思考控制。
 */
export function minimaxCodeOutputConfig(
    modelId: string,
    requestedEffort: string | undefined | null,
): Record<string, unknown> | undefined {
    const model = minimaxCodeModelDef(modelId);
    if (model === undefined) return undefined;
    // always-on：没有可选项、也无法关闭，且模型默认思考，所以诚实的请求是什么都不说。
    if (model.thinking === 'always-on') return undefined;
    // toggle：什么都不说已经是开启态，只有关闭态值得发一个字段。
    if (model.thinking === 'toggle') {
        return requestedEffort === 'none' ? { effort: 'none' } : undefined;
    }
    // forced-effort：档位是唯一的控制。`none` 在这里不是档位（M3.1 关闭思考返回 400），
    // 所以要求关闭的请求拿不到档位，也就落到服务端默认。
    const effort = requestedEffort ?? model.defaultReasoningEffort;
    if (effort === 'default' || effort === 'none') return undefined;
    return model.reasoningEfforts.includes(effort) ? { effort } : undefined;
}

/** 从目录提取「模型 id → 上下文窗口」，供 DSH 的压缩与溢出判断使用。 */
export function minimaxCodeContextWindows(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const model of MINIMAX_CODE_MODELS) result[model.id] = model.contextWindow;
    return result;
}
