/**
 * OpenDesign 订阅线路静态事实与官方模型目录。
 *
 * 网关为 OpenAI 兼容端点（默认 `https://amr-link.open-design.ai/v1`），控制面位于 AMR API
 * （`https://amr-api.open-design.ai/api/v1`）：
 * - 静态 API Key 账号仅持有一把网关 key（无控制面权限，不读额度面板）；
 * - 设备码 OAuth 账号同时持有 `controlKey`（`vela_ctrl_…`，查余额/账单/5h·7d 额度/全量模型目录）
 *   与 `runtimeKey`（`sk-amr-…`，对话与网关 `/models`）。
 */

export const OPENDESIGN_PROVIDER_ID = 'opendesign';
export const OPENDESIGN_PROVIDER_NAME = 'OpenDesign';

export const OPENDESIGN_DEFAULT_BASE_URL = 'https://amr-link.open-design.ai/v1';
export const OPENDESIGN_AMR_API_BASE = 'https://amr-api.open-design.ai/api/v1';

export const OPENDESIGN_DEVICE_AUTHORIZATIONS_PATH = '/cli/device-authorizations';
export const OPENDESIGN_WALLET_BALANCE_PATH = '/wallet/balance';
export const OPENDESIGN_BILLING_SUMMARY_PATH = '/billing/summary';
export const OPENDESIGN_CURRENT_WORKSPACE_PATH = '/workspaces/current';
export const OPENDESIGN_WORKSPACES_PATH = '/workspaces';
export const OPENDESIGN_CODING_PLAN_USAGE_SUFFIX = '/billing/coding-plan-usage';

export const OPENDESIGN_DEVICE_CLIENT_PROFILE = 'prod';
export const OPENDESIGN_DEVICE_CLIENT_NAME = 'cwtools-vscode';

export const OPENDESIGN_DEFAULT_CONTEXT_WINDOW = 128_000;
export const OPENDESIGN_DEFAULT_MAX_TOKENS = 64_000;
export const OPENDESIGN_POOL_COOLDOWN_MS = 15 * 60_000;
export const OPENDESIGN_DISCOVERY_TIMEOUT_MS = 20_000;
export const OPENDESIGN_OAUTH_TIMEOUT_MS = 30_000;
export const OPENDESIGN_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const OPENDESIGN_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

export interface OpenDesignModelMeta {
    name: string;
    /** 公开定价页标明的 USD / 1M tokens；仅用于参考展示。 */
    pricing?: { input: number; output: number };
    contextWindow?: number;
    maxTokens?: number;
    /** 允许选择的推理档位，从低到高；空数组表示不开放该旋钮，缺省沿用线路默认三档。 */
    efforts?: readonly string[];
    defaultEffort?: string;
    reasoning?: boolean;
    input: readonly string[];
}

/** 2026-11 公开价目表与上下文/推理档位元数据（42 个对话模型）。 */
export const OPENDESIGN_MODEL_CATALOG: Readonly<Record<string, OpenDesignModelMeta>> = Object.freeze({
    'claude-fable-5': { name: 'Claude Fable 5', pricing: { input: 10, output: 50 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'claude-fable-5.1': { name: 'Claude Fable 5.1', pricing: { input: 10, output: 50 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'claude-fable-5.2': { name: 'Claude Fable 5.2', pricing: { input: 8, output: 40 }, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'claude-haiku-5.5': { name: 'Claude Haiku 5.5', pricing: { input: 0.1, output: 0.5 }, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'claude-opus-4.8': { name: 'Claude Opus 4.8', pricing: { input: 5, output: 25 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'claude-opus-5': { name: 'Claude Opus 5', pricing: { input: 5, output: 25 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'claude-opus-5.5': { name: 'Claude Opus 5.5', pricing: { input: 4, output: 20 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'claude-sonnet-5': { name: 'Claude Sonnet 5', pricing: { input: 2, output: 10 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'claude-sonnet-5.5': { name: 'Claude Sonnet 5.5', pricing: { input: 2, output: 10 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', pricing: { input: 0.3, output: 1.2 }, contextWindow: 1_000_000, maxTokens: 384_000, input: ['text', 'image'], efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high' },
    'deepseek-v4.1-flash-eco': { name: 'DeepSeek V4.1 Flash Eco', pricing: { input: 0.3, output: 1.2 }, contextWindow: 1_000_000, maxTokens: 384_000, input: ['text', 'image'], efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high' },
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', pricing: { input: 0.44, output: 1.32 }, contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'], efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'high' },
    'deepseek-v4-flash-vision-exp': { name: 'DeepSeek V4 Flash Vision Exp', pricing: { input: 0.44, output: 1.32 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['none', 'high', 'max'], defaultEffort: 'high' },
    'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', pricing: { input: 1.32, output: 3.96 }, contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'], efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high' },
    'gemini-3.7-flash': { name: 'Gemini 3.7 Flash', pricing: { input: 0.75, output: 3.75 }, contextWindow: 1_048_576, input: ['text', 'image'], efforts: ['low', 'medium', 'high'] },
    'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', pricing: { input: 0.75, output: 3.75 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high'] },
    'gemini-4-argon': { name: 'Gemini 4 Argon', pricing: { input: 2, output: 10 }, contextWindow: 1_048_576, maxTokens: 65_536, input: ['text', 'image'], efforts: ['low', 'medium', 'high'] },
    'glm-5.2': { name: 'GLM-5.2', pricing: { input: 1.4, output: 4.4 }, contextWindow: 1_000_000, maxTokens: 131_072, input: ['text'], efforts: ['none', 'high', 'max'] },
    'glm-5.3-flash': { name: 'GLM-5.3 Flash', pricing: { input: 0.075, output: 0.25 }, contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'] },
    'glm-5.3-flashx': { name: 'GLM-5.3 Flash-X', pricing: { input: 0.37, output: 1.25 }, contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'] },
    'gpt-5.6-luna': { name: 'GPT-5.6 Luna', pricing: { input: 0.2, output: 1.2 }, contextWindow: 1_050_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'gpt-5.6-sol': { name: 'GPT-5.6 Sol', pricing: { input: 4, output: 20 }, contextWindow: 1_050_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'gpt-5.6-terra': { name: 'GPT-5.6 Terra', pricing: { input: 2, output: 12 }, contextWindow: 1_050_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'gpt-6.1-sol': { name: 'GPT-6.1 Sol', pricing: { input: 2, output: 10 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'gpt-6.1-terra': { name: 'GPT-6.1 Terra', pricing: { input: 1, output: 5 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'gpt-6-astra': { name: 'GPT-6 Astra', pricing: { input: 10, output: 50 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'gpt-6-luna': { name: 'GPT-6 Luna', pricing: { input: 0.1, output: 0.5 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'gpt-6-sol': { name: 'GPT-6 Sol', pricing: { input: 2, output: 10 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'grok-4.5': { name: 'Grok 4.5', pricing: { input: 2, output: 6 }, contextWindow: 500_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high'] },
    'grok-4.6': { name: 'Grok 4.6', pricing: { input: 2, output: 6 }, contextWindow: 500_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh'] },
    'grok-4.7': { name: 'Grok 4.7', pricing: { input: 2, output: 6 }, contextWindow: 500_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh'] },
    'hy4': { name: 'Hunyuan H4', pricing: { input: 0.417, output: 1.2505 }, contextWindow: 1_048_576, input: ['text'], efforts: ['low', 'medium', 'high'] },
    'hy4-preview': { name: 'Hunyuan H4 Preview', pricing: { input: 0.834, output: 2.501 }, contextWindow: 1_048_576, input: ['text'], efforts: ['low', 'medium', 'high'] },
    'kimi-k2.7-code': { name: 'Kimi K2.7 Code', pricing: { input: 0.95, output: 4 }, contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: ['none', 'low', 'medium', 'high'] },
    'kimi-k3': { name: 'Kimi K3', pricing: { input: 3, output: 15 }, contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'] },
    'kimi-k3.1-pro': { name: 'Kimi K3.1 Pro', pricing: { input: 2, output: 10 }, contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'] },
    'mimo-v2.6-flash': { name: 'MiMo V2.6 Flash', pricing: { input: 0.14, output: 0.28 }, contextWindow: 1_048_576, input: ['text', 'image'] },
    'mimo-v2.6-pro': { name: 'MiMo V2.6 Pro', pricing: { input: 0.435, output: 0.87 }, contextWindow: 1_048_576, input: ['text', 'image'] },
    'minimax-m3.1-flash': { name: 'MiniMax M3.1 Flash', pricing: { input: 0.15, output: 0.6 }, reasoning: true, input: ['text'] },
    'muse-spark-1.3': { name: 'Muse Spark 1.3', pricing: { input: 1.25, output: 4.25 }, contextWindow: 1_048_576, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'muse-wonder': { name: 'Muse Wonder', pricing: { input: 4, output: 20 }, reasoning: true, input: ['text'] },
    'qwen3.7-max': { name: 'Qwen3.7 Max', pricing: { input: 2.5, output: 7.5 }, contextWindow: 1_000_000, maxTokens: 65_536, input: ['text'] },
});

export const OPENDESIGN_DEFAULT_MODELS: readonly string[] = Object.freeze(Object.keys(OPENDESIGN_MODEL_CATALOG));
export const OPENDESIGN_DEFAULT_EFFORTS: readonly string[] = Object.freeze(['low', 'medium', 'high']);

export function openDesignCatalogEntry(model: string): OpenDesignModelMeta | undefined {
    return OPENDESIGN_MODEL_CATALOG[model];
}

export interface OpenDesignDiscoveredModel {
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: string[];
    reasoning?: boolean;
    efforts?: string[];
}

export interface OpenDesignCatalogModel extends OpenDesignDiscoveredModel {
    id: string;
}

export interface OpenDesignModelInfo {
    id: string;
    displayName: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    efforts: readonly string[];
    defaultEffort?: string;
    input: readonly string[];
    pricing?: { input: number; output: number };
}

/** 去前缀后判断是否为 DeepSeek 模型，只有它接受 `thinking: { type: 'disabled' }` 来关闭思考。 */
export function isOpenDesignDeepSeekModel(model: string): boolean {
    const id = String(model ?? '').trim().toLowerCase();
    const bare = id.slice(Math.max(id.lastIndexOf('/'), id.lastIndexOf(':')) + 1);
    return bare.startsWith('deepseek');
}

/** 网关对 `gpt-5*` / `o1*` / `o3*` / `o4*` 要求使用 `max_completion_tokens`。 */
export function openDesignWantsCompletionTokens(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    return /^gpt-5(?:[.-]|$)/.test(normalized)
        || /^o1(?:[.-]|$)/.test(normalized)
        || /^o3(?:[.-]|$)/.test(normalized)
        || /^o4(?:[.-]|$)/.test(normalized);
}

/** 网关明确拒绝 `max_tokens` 并要求改用 `max_completion_tokens` 的 400 文案判定。 */
export function isOpenDesignUnsupportedMaxTokensError(detail: string): boolean {
    const normalized = detail.toLowerCase();
    return normalized.includes('unsupported parameter')
        && normalized.includes('max_tokens')
        && normalized.includes('max_completion_tokens');
}

/** 将请求体中的 `max_tokens` 原地迁移为 `max_completion_tokens`（单次降级重放用）。 */
export function withoutMaxTokensUseCompletionTokens<T extends Record<string, unknown>>(body: T): T {
    if (body.max_tokens === undefined) return body;
    const { max_tokens: maxTokens, ...rest } = body;
    return { ...rest, max_completion_tokens: maxTokens } as unknown as T;
}
